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
import { basename, dirname } from 'node:path'
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

type State = {
  approved_user_ids: string[]
  bot_thread_ids: string[]
}

async function loadState(): Promise<State> {
  try {
    const raw = await readFile(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      approved_user_ids: Array.isArray(parsed.approved_user_ids) ? parsed.approved_user_ids : [],
      bot_thread_ids: Array.isArray(parsed.bot_thread_ids) ? parsed.bot_thread_ids : [],
    }
  } catch {
    return { approved_user_ids: [], bot_thread_ids: [] }
  }
}

async function saveStateNow(s: State) {
  await mkdir(dirname(STATE_FILE), { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2))
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveStateNow({
      approved_user_ids: [...approvedIds],
      bot_thread_ids: [...botThreads],
    }).catch(e => console.error('saveState:', (e as Error).message))
  }, 500)
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

async function postMessage(
  channel_id: string,
  message: string,
  root_id?: string,
  file_ids?: string[],
): Promise<MMPost> {
  return mm<MMPost>('/posts', {
    method: 'POST',
    body: JSON.stringify({
      channel_id,
      message,
      ...(root_id ? { root_id } : {}),
      ...(file_ids && file_ids.length > 0 ? { file_ids } : {}),
    }),
  })
}

type MMFileInfo = { id: string; name: string }
type MMFileUploadResponse = { file_infos: MMFileInfo[] }

async function uploadFile(channel_id: string, path: string, filename?: string): Promise<MMFileInfo> {
  const bytes = await readFile(path)
  const name = filename ?? basename(path)
  const form = new FormData()
  form.append('channel_id', channel_id)
  form.append('files', new Blob([new Uint8Array(bytes)]), name)
  const r = await fetch(`${MATTERMOST_URL}/api/v4/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MATTERMOST_TOKEN}` },
    body: form,
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Mattermost POST /files: ${r.status} ${body}`)
  }
  const data = (await r.json()) as MMFileUploadResponse
  const info = data.file_infos?.[0]
  if (!info?.id) throw new Error(`upload of ${name} returned no file_infos`)
  return info
}

async function openDirectChannel(otherUserId: string): Promise<MMChannel> {
  return mm<MMChannel>('/channels/direct', {
    method: 'POST',
    body: JSON.stringify([botId, otherUserId]),
  })
}

type MMThread = { order: string[]; posts: Record<string, MMPost> }

async function getThread(rootId: string): Promise<MMThread> {
  return mm<MMThread>(`/posts/${rootId}/thread`)
}

async function getUsersByIds(ids: string[]): Promise<MMUser[]> {
  if (ids.length === 0) return []
  return mm<MMUser[]>('/users/ids', { method: 'POST', body: JSON.stringify(ids) })
}

async function renderThread(rootId: string): Promise<string> {
  const t = await getThread(rootId)
  const order = [...t.order].sort((a, b) => (t.posts[a]!.create_at ?? 0) - (t.posts[b]!.create_at ?? 0))
  const userIds = Array.from(new Set(order.map(id => t.posts[id]!.user_id)))
  const users = await getUsersByIds(userIds).catch(() => [] as MMUser[])
  const nameOf = new Map(users.map(u => [u.id, u.username]))
  const lines = order.map(id => {
    const p = t.posts[id]!
    const handle = nameOf.get(p.user_id) ?? p.user_id
    const ts = new Date(p.create_at).toISOString().slice(0, 19).replace('T', ' ')
    return `@${handle} (${ts}): ${p.message}`
  })
  return `Thread root=${rootId} (${order.length} message${order.length === 1 ? '' : 's'}):\n\n${lines.join('\n\n')}`
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
// Threads the bot has participated in (loaded from disk so restarts don't
// drop in-progress conversations). See `botThreads` usage in handlePosted.
const botThreads = new Set<string>(persisted.bot_thread_ids)
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
  { name: 'mattermost', version: '0.2.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions: [
      'Mattermost posts arrive as <channel source="mattermost" channel_id="..."',
      'channel_type="D|O|P|G" channel_name="..." user_id="..." username="..."',
      'post_id="..." root_id="...">. channel_type: D=direct, O=public, P=private, G=group DM.',
      '',
      'Long-running use — DELEGATE every inbound Mattermost message to a sub-agent',
      'via the Task tool so this main session\'s context stays bounded. Spawn:',
      '  subagent_type: general-purpose',
      '  description:    "answer mattermost message in #<channel_name or DM>"',
      '  prompt:         "You are answering a Mattermost message. channel_id=<from tag>,',
      '                   root_id=<inbound root_id if non-empty else post_id>.',
      '                   Call mcp__mattermost__read_thread first for full thread context,',
      '                   formulate your answer, then call mcp__mattermost__reply with',
      '                   that channel_id and root_id. Keep replies concise."',
      'After Task returns, do NOT re-analyze or restate the message in this session.',
      '',
      'Exceptions handled in this session (do not delegate):',
      ' - 6-character pairing codes ("pair ABC123") → call mcp__mattermost__confirm_pairing',
      ' - Permission-relay verdicts ("yes <id>" / "no <id>") → handled by the channel',
      '   server before they reach you, you will not see them as channel events',
      '',
      'To "close" a Mattermost conversation so future replies in that thread stop',
      'auto-forwarding, call mcp__mattermost__clear_thread_state with the root_id.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Send a message back to a Mattermost channel or DM. ' +
        'Pass channel_id from the inbound <channel> tag. ' +
        'To thread the reply, pass root_id (the inbound root_id if non-empty, otherwise post_id). ' +
        'Pass attachments to upload local files and attach them to the post (up to 10 per post, ' +
        'Mattermost server limit).',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Mattermost channel ID from the inbound <channel> tag' },
          message: { type: 'string', description: 'Message body (Markdown supported). May be empty when attachments are provided.' },
          root_id: { type: 'string', description: 'Optional thread root post ID' },
          attachments: {
            type: 'array',
            description: 'Local files to upload and attach to the post.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Absolute or working-dir-relative path to a local file the bot can read' },
                filename: { type: 'string', description: 'Optional filename to show in Mattermost (defaults to basename of path)' },
              },
              required: ['path'],
            },
          },
        },
        required: ['channel_id'],
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
    {
      name: 'read_thread',
      description:
        'Read the full message history of a Mattermost thread. Call this from a sub-agent ' +
        'BEFORE formulating a reply, so the agent has context for prior messages. Pass the ' +
        'root_id from the inbound <channel> tag (use inbound root_id if non-empty, otherwise post_id). ' +
        'Returns posts in chronological order, each prefixed with @username and an ISO timestamp.',
      inputSchema: {
        type: 'object',
        properties: {
          root_id: { type: 'string', description: 'Thread root post ID (26-char Mattermost ID)' },
        },
        required: ['root_id'],
      },
    },
    {
      name: 'clear_thread_state',
      description:
        'Forget that the bot has participated in this thread. After this, replies in the thread ' +
        'will only be forwarded to Claude if the user @mentions the bot again or the channel is ' +
        'in MATTERMOST_LISTEN_CHANNELS. Use to "close" a conversation that\'s no longer active.',
      inputSchema: {
        type: 'object',
        properties: {
          root_id: { type: 'string', description: '26-char Mattermost thread root post ID' },
        },
        required: ['root_id'],
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
    const rawAttachments = Array.isArray(args.attachments) ? args.attachments : []
    const attachments = rawAttachments
      .map(a => (a && typeof a === 'object' ? a as { path?: unknown; filename?: unknown } : null))
      .filter((a): a is { path?: unknown; filename?: unknown } => a !== null)
      .map(a => ({
        path: typeof a.path === 'string' ? a.path : '',
        filename: typeof a.filename === 'string' ? a.filename : undefined,
      }))
      .filter(a => a.path !== '')
    if (!channel_id) {
      return { content: [{ type: 'text', text: 'channel_id is required' }], isError: true }
    }
    if (!message && attachments.length === 0) {
      return { content: [{ type: 'text', text: 'message or attachments is required' }], isError: true }
    }
    try {
      const fileInfos = await Promise.all(
        attachments.map(a => uploadFile(channel_id, a.path, a.filename)),
      )
      const file_ids = fileInfos.map(f => f.id)
      const post = await postMessage(channel_id, message, root_id, file_ids)
      const suffix = file_ids.length > 0 ? ` with ${file_ids.length} attachment${file_ids.length === 1 ? '' : 's'}` : ''
      return { content: [{ type: 'text', text: `posted ${post.id}${suffix}` }] }
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
    scheduleSave()

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

  if (name === 'read_thread') {
    const root_id = String(args.root_id ?? '')
    if (!root_id) {
      return { content: [{ type: 'text', text: 'root_id is required' }], isError: true }
    }
    try {
      const text = await renderThread(root_id)
      return { content: [{ type: 'text', text }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `read_thread failed: ${(e as Error).message}` }], isError: true }
    }
  }

  if (name === 'clear_thread_state') {
    const root_id = String(args.root_id ?? '')
    if (!root_id) {
      return { content: [{ type: 'text', text: 'root_id is required' }], isError: true }
    }
    const had = botThreads.delete(root_id)
    if (had) scheduleSave()
    return { content: [{ type: 'text', text: had ? `cleared ${root_id}` : `${root_id} was not tracked` }] }
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

  if (post.user_id === botId) {
    // Bot's own post: track its thread so future replies in it are forwarded
    // (without requiring the user to @mention again). post.id is the implicit
    // thread root for top-level posts; post.root_id (if set) is the existing
    // thread we joined. Persisted via scheduleSave() so restarts don't drop
    // in-progress conversations.
    let changed = false
    if (!botThreads.has(post.id)) { botThreads.add(post.id); changed = true }
    if (post.root_id && !botThreads.has(post.root_id)) {
      botThreads.add(post.root_id); changed = true
    }
    if (changed) scheduleSave()
    return
  }
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
  const isBotThreadFollowUp = post.root_id !== '' && botThreads.has(post.root_id)

  if (!isDM && !mentionedExplicitly && !isWatchedChannel && !isBotThreadFollowUp) return

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
