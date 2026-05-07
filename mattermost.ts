#!/usr/bin/env bun
/**
 * Claude Code MCP channel for Mattermost.
 *
 * Tested against Mattermost v10.12.x. Uses the v4 REST API and the
 * /api/v4/websocket event stream.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'

// --- Config ----------------------------------------------------------------

const MATTERMOST_URL = (process.env.MATTERMOST_URL ?? '').replace(/\/+$/, '')
const MATTERMOST_TOKEN = process.env.MATTERMOST_TOKEN ?? ''
const MATTERMOST_TEAM = process.env.MATTERMOST_TEAM ?? ''
const ALLOWED_USERS = parseList(process.env.MATTERMOST_ALLOWED_USERS)
const LISTEN_CHANNELS = parseList(process.env.MATTERMOST_LISTEN_CHANNELS)
const STATE_FILE =
  process.env.MATTERMOST_STATE_FILE ??
  `${homedir()}/.mcp-channel-mattermost/state.json`
const DEBUG_LOG = process.env.MATTERMOST_DEBUG_LOG

if (!MATTERMOST_URL || !MATTERMOST_TOKEN) {
  console.error('MATTERMOST_URL and MATTERMOST_TOKEN are required')
  process.exit(1)
}

function parseList(s: string | undefined): string[] {
  return (s ?? '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
}

import { appendFileSync } from 'node:fs'
function dbg(...args: unknown[]) {
  if (!DEBUG_LOG) return
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`
  try { appendFileSync(DEBUG_LOG, line) } catch {}
}

// --- Persistent state ------------------------------------------------------

type State = { approved_user_ids: string[] }

async function loadState(): Promise<State> {
  try {
    const raw = await readFile(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return { approved_user_ids: Array.isArray(parsed.approved_user_ids) ? parsed.approved_user_ids : [] }
  } catch {
    return { approved_user_ids: [] }
  }
}

async function saveState(s: State) {
  await mkdir(dirname(STATE_FILE), { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2))
}

// --- Mattermost REST helpers -----------------------------------------------

type MMUser = { id: string; username: string }
type MMChannel = { id: string; name: string; type: string; team_id: string }
type MMPost = {
  id: string
  user_id: string
  channel_id: string
  message: string
  root_id: string
  create_at: number
  type?: string
  props?: Record<string, unknown>
}

async function mm<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(`${MATTERMOST_URL}/api/v4${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${MATTERMOST_TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Mattermost ${opts.method ?? 'GET'} ${path}: ${r.status} ${body}`)
  }
  return r.json() as Promise<T>
}

const getMe = () => mm<MMUser>('/users/me')
const getUser = (id: string) => mm<MMUser>(`/users/${id}`)
const getUserByUsername = (name: string) => mm<MMUser>(`/users/username/${encodeURIComponent(name)}`)
const getChannel = (id: string) => mm<MMChannel>(`/channels/${id}`)
const getChannelByName = (team: string, name: string) =>
  mm<MMChannel>(`/teams/name/${encodeURIComponent(team)}/channels/name/${encodeURIComponent(name)}`)

async function postMessage(channel_id: string, message: string, root_id?: string): Promise<MMPost> {
  return mm<MMPost>('/posts', {
    method: 'POST',
    body: JSON.stringify({ channel_id, message, ...(root_id ? { root_id } : {}) }),
  })
}

async function openDirectChannel(otherUserId: string): Promise<MMChannel> {
  return mm<MMChannel>('/channels/direct', {
    method: 'POST',
    body: JSON.stringify([botId, otherUserId]),
  })
}

const MM_ID_RE = /^[a-z0-9]{26}$/

async function resolveUserId(usernameOrId: string): Promise<string | null> {
  if (MM_ID_RE.test(usernameOrId)) return usernameOrId
  try {
    const u = await getUserByUsername(usernameOrId.replace(/^@/, ''))
    return u.id
  } catch (e) {
    console.error(`could not resolve user "${usernameOrId}":`, (e as Error).message)
    return null
  }
}

async function resolveChannelId(nameOrId: string): Promise<string | null> {
  if (MM_ID_RE.test(nameOrId)) {
    try { await getChannel(nameOrId); return nameOrId } catch {}
  }
  if (!MATTERMOST_TEAM) {
    console.error(`MATTERMOST_TEAM not set; cannot resolve channel name "${nameOrId}"`)
    return null
  }
  try {
    const c = await getChannelByName(MATTERMOST_TEAM, nameOrId)
    return c.id
  } catch (e) {
    console.error(`could not resolve channel "${nameOrId}":`, (e as Error).message)
    return null
  }
}

// --- Bootstrap identity & allowlists ---------------------------------------

const me = await getMe()
const botId = me.id
const botUsername = me.username
console.error(`mattermost channel: authenticated as @${botUsername} (${botId}) at ${MATTERMOST_URL}`)

const persisted = await loadState()
const approvedIds = new Set<string>(persisted.approved_user_ids)
const staticAllowedIds = new Set<string>()
for (const v of ALLOWED_USERS) {
  const id = await resolveUserId(v)
  if (id) staticAllowedIds.add(id)
}

const listenChannelIds = new Set<string>()
for (const v of LISTEN_CHANNELS) {
  const id = await resolveChannelId(v)
  if (id) listenChannelIds.add(id)
}

function isApproved(userId: string): boolean {
  return staticAllowedIds.has(userId) || approvedIds.has(userId)
}

function allRecipients(): Set<string> {
  return new Set<string>([...staticAllowedIds, ...approvedIds])
}

// --- Pairing ---------------------------------------------------------------
//
// Why: pairing-fallback lets a new Mattermost user authorize themselves
// without editing env vars. They DM the bot, get a code, share it with the
// Claude Code operator who pastes it in their session; Claude calls
// confirm_pairing to add their user_id to the persisted allowlist.

const PAIRING_TTL_MS = 10 * 60 * 1000
const pendingPairings = new Map<string, { user_id: string; expires: number }>()
// Avoid 0/O/1/I; codes are spoken aloud or typed on phones.
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function generatePairingCode(): string {
  let s = ''
  for (let i = 0; i < 6; i++) {
    s += PAIRING_ALPHABET[Math.floor(Math.random() * PAIRING_ALPHABET.length)]
  }
  return s
}

function purgeExpiredPairings() {
  const now = Date.now()
  for (const [code, p] of pendingPairings) if (p.expires < now) pendingPairings.delete(code)
}

// --- MCP server ------------------------------------------------------------

const mcp = new Server(
  { name: 'mattermost', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions:
      'Mattermost messages arrive as <channel source="mattermost" channel_id="..." ' +
      'channel_type="D|O|P|G" channel_name="..." user_id="..." username="..." ' +
      'post_id="..." root_id="...">. ' +
      'Reply with the `reply` tool, passing channel_id from the tag. ' +
      'To keep the reply threaded, also pass root_id (use the inbound root_id if non-empty, otherwise post_id). ' +
      'channel_type "D" is a direct message, "O" public channel, "P" private, "G" group DM. ' +
      'If the operator types a 6-character pairing code (e.g. "pair ABC123"), call ' +
      'confirm_pairing with that code to authorize a new Mattermost user.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Send a message back to a Mattermost channel or DM. ' +
        'Pass channel_id from the inbound <channel> tag. ' +
        'To thread the reply, pass root_id (the inbound root_id if non-empty, otherwise post_id).',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Mattermost channel ID from the inbound <channel> tag' },
          message: { type: 'string', description: 'Message body (Markdown supported)' },
          root_id: { type: 'string', description: 'Optional thread root post ID' },
        },
        required: ['channel_id', 'message'],
      },
    },
    {
      name: 'confirm_pairing',
      description:
        'Authorize a Mattermost user who DMed the bot. Pass the 6-character code they shared. ' +
        'After authorization, their user_id is added to the persisted allowlist and they can ' +
        'send messages that this channel forwards to Claude.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '6-character pairing code provided by the user' },
        },
        required: ['code'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const name = req.params.name
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  if (name === 'reply') {
    const channel_id = String(args.channel_id ?? '')
    const message = String(args.message ?? '')
    const root_id = args.root_id ? String(args.root_id) : undefined
    if (!channel_id || !message) {
      return { content: [{ type: 'text', text: 'channel_id and message are required' }], isError: true }
    }
    try {
      const post = await postMessage(channel_id, message, root_id)
      return { content: [{ type: 'text', text: `posted ${post.id}` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `post failed: ${(e as Error).message}` }], isError: true }
    }
  }

  if (name === 'confirm_pairing') {
    purgeExpiredPairings()
    const code = String(args.code ?? '').trim().toUpperCase()
    const pending = pendingPairings.get(code)
    if (!pending) {
      return { content: [{ type: 'text', text: 'invalid or expired pairing code' }], isError: true }
    }
    pendingPairings.delete(code)
    approvedIds.add(pending.user_id)
    await saveState({ approved_user_ids: [...approvedIds] })

    let label = pending.user_id
    try {
      const u = await getUser(pending.user_id)
      label = `@${u.username} (${u.id})`
      const dm = await openDirectChannel(pending.user_id)
      await postMessage(
        dm.id,
        "You're authorized. Messages you send here will be forwarded to the Claude Code session.",
      )
    } catch (e) {
      console.error('post-pairing notification failed:', (e as Error).message)
    }
    return { content: [{ type: 'text', text: `authorized ${label}` }] }
  }

  throw new Error(`unknown tool: ${name}`)
})

// --- Permission relay ------------------------------------------------------

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const text =
    `Claude wants to use **${params.tool_name}**: ${params.description}\n\n` +
    '```\n' +
    params.input_preview +
    '\n```\n' +
    `Reply \`yes ${params.request_id}\` or \`no ${params.request_id}\`.`

  const recipients = allRecipients()
  if (recipients.size === 0) {
    console.error('permission relay: no approved recipients yet, dropping prompt')
    return
  }
  for (const uid of recipients) {
    try {
      const dm = await openDirectChannel(uid)
      await postMessage(dm.id, text)
    } catch (e) {
      console.error(`permission relay to ${uid} failed:`, (e as Error).message)
    }
  }
})

// --- WebSocket consumer ----------------------------------------------------

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

await mcp.connect(new StdioServerTransport())

const wsUrl = MATTERMOST_URL.replace(/^http/i, 'ws') + '/api/v4/websocket'
let wsSeq = 1
let backoffMs = 1000
const MAX_BACKOFF_MS = 30_000

function connectWS() {
  const ws = new WebSocket(wsUrl)

  ws.addEventListener('open', () => {
    backoffMs = 1000
    ws.send(
      JSON.stringify({
        seq: wsSeq++,
        action: 'authentication_challenge',
        data: { token: MATTERMOST_TOKEN },
      }),
    )
    console.error('mattermost websocket connected')
  })

  ws.addEventListener('message', async ev => {
    const data = typeof ev.data === 'string' ? ev.data : (ev.data as ArrayBuffer | Uint8Array).toString()
    let msg: any
    try {
      msg = JSON.parse(data as string)
    } catch {
      return
    }
    if (msg.event === 'posted') {
      try {
        await handlePosted(msg)
      } catch (e) {
        console.error('handlePosted error:', (e as Error).message)
      }
    }
  })

  ws.addEventListener('close', ev => {
    console.error(`mattermost websocket closed (${ev.code}), reconnecting in ${backoffMs}ms`)
    setTimeout(connectWS, backoffMs)
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
  })

  ws.addEventListener('error', err => {
    console.error('mattermost websocket error:', (err as any)?.message ?? err)
  })
}

connectWS()

async function handlePosted(msg: any) {
  const d = msg.data ?? {}
  if (typeof d.post !== 'string') return
  const post = JSON.parse(d.post) as MMPost

  if (post.user_id === botId) return
  if (post.type && post.type !== '') return

  const channelType: string = d.channel_type ?? ''
  const channelName: string = d.channel_name ?? ''
  const senderName: string = (d.sender_name ?? '').replace(/^@/, '')

  const mentionedIds: string[] = (() => {
    try { return JSON.parse(d.mentions ?? '[]') } catch { return [] }
  })()
  const isDM = channelType === 'D'
  const mentionedExplicitly = mentionedIds.includes(botId)
  const isWatchedChannel = listenChannelIds.has(post.channel_id)

  if (!isDM && !mentionedExplicitly && !isWatchedChannel) return

  if (!isApproved(post.user_id)) {
    if (isDM) await offerPairing(post)
    return
  }

  const verdict = PERMISSION_REPLY_RE.exec(post.message.trim())
  if (verdict && verdict[1] && verdict[2]) {
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: {
        request_id: verdict[2].toLowerCase(),
        behavior: verdict[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
      },
    })
    return
  }

  let username = senderName
  if (!username) {
    try {
      const u = await getUser(post.user_id)
      username = u.username
    } catch {
      username = post.user_id
    }
  }

  dbg('forwarding to claude', { content: post.message, channel_id: post.channel_id, user_id: post.user_id, channel_type: channelType })
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: post.message,
      meta: {
        channel_id: post.channel_id,
        channel_type: channelType,
        channel_name: channelName,
        post_id: post.id,
        root_id: post.root_id || post.id,
        user_id: post.user_id,
        username,
      },
    },
  })
  dbg('forward complete')
}

async function offerPairing(post: MMPost) {
  purgeExpiredPairings()
  for (const [code, p] of pendingPairings) {
    if (p.user_id === post.user_id) {
      try {
        await postMessage(
          post.channel_id,
          `You already have a pending pairing code: \`${code}\`. Share it with the Claude Code operator.`,
        )
      } catch {}
      return
    }
  }
  const code = generatePairingCode()
  pendingPairings.set(code, { user_id: post.user_id, expires: Date.now() + PAIRING_TTL_MS })
  try {
    await postMessage(
      post.channel_id,
      `You're not authorized to message this Claude Code session yet.\n\n` +
        `Share this pairing code with the operator and ask them to paste it in their Claude Code terminal:\n\n` +
        `\`pair ${code}\`\n\n` +
        `(Code expires in 10 minutes.)`,
    )
  } catch (e) {
    console.error('failed to send pairing message:', (e as Error).message)
  }
}
