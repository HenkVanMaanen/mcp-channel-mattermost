/**
 * End-to-end smoke test for the Mattermost channel server.
 *
 * Drives ../mattermost.ts the same way Claude Code would: spawns it as an
 * MCP stdio subprocess, registers a notification handler for
 * notifications/claude/channel, and sends real REST/WebSocket traffic
 * through the live Mattermost from docker-compose.
 *
 * Requirements:
 *   - `docker compose -f docker-compose.dev.yml -p mmtest up -d`
 *   - `bash scripts/setup-mattermost.sh` (writes .env.local)
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'

// --- Load .env.local --------------------------------------------------------
const envPath = resolve(import.meta.dirname, '..', '.env.local')
const env: Record<string, string> = {}
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m && m[1] && m[2] !== undefined) env[m[1]] = m[2]
}
const required = [
  'MATTERMOST_URL', 'MATTERMOST_TOKEN', 'MATTERMOST_TEAM',
  'MATTERMOST_ALLOWED_USERS', 'MATTERMOST_LISTEN_CHANNELS',
  'TEST_USER_TOKEN', 'TEST_USER_ID', 'TEST_BOT_ID',
  'TEST_TEAM_ID', 'TEST_CHANNEL_ID',
  'TEST_BOT_USERNAME', 'TEST_MENTIONS_CHANNEL_ID',
]
for (const k of required) {
  if (!env[k]) throw new Error(`missing ${k} in ${envPath} — re-run scripts/setup-mattermost.sh`)
}

const URL_BASE = env.MATTERMOST_URL!
const ADMIN_USER = process.env.ADMIN_USER ?? 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS ?? 'admin12345'

// --- Test helpers -----------------------------------------------------------

const passes: string[] = []
const fails: string[] = []
function pass(name: string) { passes.push(name); console.log(`[32m✓[0m ${name}`) }
function fail(name: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  fails.push(`${name}: ${msg}`)
  console.log(`[31m✗[0m ${name}\n  ${msg}`)
}
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try { const r = await fn(); pass(name); return r }
  catch (e) { fail(name, e); return undefined }
}

async function mmAs(token: string, method: string, path: string, body?: any) {
  const r = await fetch(`${URL_BASE}/api/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}

async function loginToken(user: string, pass: string): Promise<string> {
  const r = await fetch(`${URL_BASE}/api/v4/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login_id: user, password: pass }),
  })
  if (!r.ok) throw new Error(`login ${user}: ${r.status} ${await r.text()}`)
  const tok = r.headers.get('token')
  if (!tok) throw new Error(`no Token header for ${user}`)
  return tok
}

async function waitFor<T>(
  getter: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await getter()
    if (v !== undefined) return v
    await delay(150)
  }
  throw new Error(`timeout: ${label}`)
}

// --- Notification handler schemas ------------------------------------------

const ChannelNotification = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({
    content: z.string(),
    meta: z.record(z.string()).optional(),
  }),
})
type ChannelNotification = z.infer<typeof ChannelNotification>
const PermissionVerdict = z.object({
  method: z.literal('notifications/claude/channel/permission'),
  params: z.object({
    request_id: z.string(),
    behavior: z.enum(['allow', 'deny']),
  }),
})
type PermissionVerdict = z.infer<typeof PermissionVerdict>

// --- Spawn the channel server ----------------------------------------------

const inbox: ChannelNotification['params'][] = []
const verdicts: PermissionVerdict['params'][] = []

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', resolve(import.meta.dirname, '..', 'mattermost.ts')],
  env: {
    ...process.env,
    MATTERMOST_URL: env.MATTERMOST_URL!,
    MATTERMOST_TOKEN: env.MATTERMOST_TOKEN!,
    MATTERMOST_TEAM: env.MATTERMOST_TEAM!,
    MATTERMOST_ALLOWED_USERS: env.MATTERMOST_ALLOWED_USERS!,
    MATTERMOST_LISTEN_CHANNELS: env.MATTERMOST_LISTEN_CHANNELS!,
    // Use a temp state file so pairing tests don't pollute the user's home dir.
    MATTERMOST_STATE_FILE: resolve(import.meta.dirname, '..', '.smoke-state.json'),
  },
  stderr: 'pipe',
})

// Mirror server stderr so we can see ws / api errors live during the run.
transport.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[server] ${chunk}`))

let client = new Client(
  { name: 'smoke-test', version: '0.0.0' },
  { capabilities: {} },
)
client.setNotificationHandler(ChannelNotification, async n => {
  inbox.push(n.params)
})
client.setNotificationHandler(PermissionVerdict, async n => {
  verdicts.push(n.params)
})

let serverProc: ChildProcess | undefined

async function main() {
  await client.connect(transport)
  console.log('connected to channel server\n')

  // 1. ListTools — server exposes the four tools
  await step('lists reply, confirm_pairing, read_thread, clear_thread_state', async () => {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name).sort()
    const expected = ['clear_thread_state', 'confirm_pairing', 'read_thread', 'reply']
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
      throw new Error(`unexpected tools: ${names.join(', ')}`)
    }
  })

  // Allow the server time to authenticate the websocket and resolve allowlist.
  await delay(2500)

  // 2. Watched-channel forwarding: alice posts in #ops-alerts, expect a notification.
  const watchedTag = `smoke-watched-${Date.now()}`
  await step('forwards posts in a watched channel', async () => {
    inbox.length = 0
    await mmAs(env.TEST_USER_TOKEN!, 'POST', '/posts', {
      channel_id: env.TEST_CHANNEL_ID!,
      message: watchedTag,
    })
    const got = await waitFor(() => inbox.find(n => n.content === watchedTag), 8000, 'watched-channel forward')
    if (got.meta?.channel_id !== env.TEST_CHANNEL_ID) throw new Error(`channel_id mismatch: ${got.meta?.channel_id}`)
    if (got.meta?.user_id !== env.TEST_USER_ID) throw new Error(`user_id mismatch: ${got.meta?.user_id}`)
    if (got.meta?.username !== 'alice') throw new Error(`username mismatch: ${got.meta?.username}`)
    if (got.meta?.channel_type !== 'O') throw new Error(`channel_type mismatch: ${got.meta?.channel_type}`)
  })

  // 3. DM forwarding: alice DMs the bot, expect a forwarded notification.
  const dmTag = `smoke-dm-${Date.now()}`
  let dmChannelId = ''
  await step('forwards a DM to the bot', async () => {
    inbox.length = 0
    const dm = await mmAs(env.TEST_USER_TOKEN!, 'POST', '/channels/direct',
      [env.TEST_USER_ID, env.TEST_BOT_ID])
    dmChannelId = dm.id
    await mmAs(env.TEST_USER_TOKEN!, 'POST', '/posts', { channel_id: dmChannelId, message: dmTag })
    const got = await waitFor(() => inbox.find(n => n.content === dmTag), 8000, 'DM forward')
    if (got.meta?.channel_type !== 'D') throw new Error(`channel_type mismatch: ${got.meta?.channel_type}`)
  })

  // 4. Reply tool: post back to the watched channel via the MCP tool.
  const replyText = `smoke-reply-${Date.now()}`
  await step('reply tool posts back to Mattermost', async () => {
    const r = await client.callTool({
      name: 'reply',
      arguments: { channel_id: env.TEST_CHANNEL_ID!, message: replyText },
    })
    if (r.isError) throw new Error('reply tool returned isError')
    // Verify the post is visible from another account.
    const adminToken = await loginToken(ADMIN_USER, ADMIN_PASS)
    const posts = await mmAs(adminToken, 'GET',
      `/channels/${env.TEST_CHANNEL_ID}/posts?per_page=10`)
    const found = Object.values<any>(posts.posts).some(p => p.message === replyText)
    if (!found) throw new Error('reply post not visible in channel')
  })

  // 5. Reply with threading.
  const threadParent = `smoke-thread-parent-${Date.now()}`
  const threadChild = `smoke-thread-child-${Date.now()}`
  await step('reply tool threads under root_id', async () => {
    inbox.length = 0
    await mmAs(env.TEST_USER_TOKEN!, 'POST', '/posts', {
      channel_id: env.TEST_CHANNEL_ID!, message: threadParent,
    })
    const parentNote = await waitFor(() => inbox.find(n => n.content === threadParent), 8000, 'thread parent forward')
    const root_id = parentNote.meta?.root_id ?? parentNote.meta?.post_id
    await client.callTool({
      name: 'reply',
      arguments: { channel_id: env.TEST_CHANNEL_ID!, message: threadChild, root_id },
    })
    const adminToken = await loginToken(ADMIN_USER, ADMIN_PASS)
    const posts = await mmAs(adminToken, 'GET',
      `/channels/${env.TEST_CHANNEL_ID}/posts?per_page=20`)
    const child = Object.values<any>(posts.posts).find(p => p.message === threadChild)
    if (!child) throw new Error('threaded reply not posted')
    if (child.root_id !== root_id) throw new Error(`thread root mismatch: ${child.root_id} vs ${root_id}`)
  })

  // 6. Permission relay: simulate Claude Code asking for an approval.
  await step('permission_request relays a DM to allowed users', async () => {
    const requestId = 'abcde'
    const adminToken = await loginToken(ADMIN_USER, ADMIN_PASS)
    const beforePosts: any = await mmAs(adminToken, 'GET',
      `/channels/${dmChannelId}/posts?per_page=5`)
    const beforeIds = new Set(Object.keys(beforePosts.posts ?? {}))

    await client.notification({
      method: 'notifications/claude/channel/permission_request',
      params: {
        request_id: requestId,
        tool_name: 'Bash',
        description: 'list files in the current directory',
        input_preview: '{"command":"ls"}',
      },
    })

    const newPost = await waitFor<{ message: string }>(async () => {
      const after = await mmAs(adminToken, 'GET',
        `/channels/${dmChannelId}/posts?per_page=5`)
      return Object.values<any>(after.posts ?? {}).find(p =>
        !beforeIds.has(p.id) && p.message.includes(requestId)
      )
    }, 8000, 'permission relay DM')
    if (!newPost.message.includes('Bash')) {
      throw new Error('permission DM missing tool name')
    }
  })

  // 7. Permission verdict round-trip: alice replies "yes <id>".
  await step('inbound "yes <id>" emits permission verdict', async () => {
    verdicts.length = 0
    await mmAs(env.TEST_USER_TOKEN!, 'POST', '/posts', {
      channel_id: dmChannelId, message: 'yes abcde',
    })
    const v = await waitFor(() => verdicts.find(x => x.request_id === 'abcde'), 8000, 'verdict notification')
    if (v.behavior !== 'allow') throw new Error(`expected allow, got ${v.behavior}`)
  })

  // 8. Pairing: a non-allowed user gets a code; confirm_pairing approves them.
  await step('pairing flow authorizes a new user', async () => {
    const adminToken = await loginToken(ADMIN_USER, ADMIN_PASS)
    let bob: any
    try {
      bob = await mmAs(adminToken, 'GET', '/users/username/bob')
    } catch {
      bob = await mmAs(adminToken, 'POST', '/users',
        { username: 'bob', email: 'bob@example.com', password: 'bob12345' })
    }
    if (!bob?.id) throw new Error('could not provision bob')
    await mmAs(adminToken, 'POST', `/teams/${env.TEST_TEAM_ID}/members`,
      { team_id: env.TEST_TEAM_ID, user_id: bob.id }).catch(() => {})

    const bobToken = await loginToken('bob', 'bob12345')
    const bobDm: any = await mmAs(bobToken, 'POST', '/channels/direct',
      [bob.id, env.TEST_BOT_ID])
    const bobBefore: any = await mmAs(adminToken, 'GET',
      `/channels/${bobDm.id}/posts?per_page=5`)
    const bobBeforeIds = new Set(Object.keys(bobBefore.posts ?? {}))

    inbox.length = 0
    await mmAs(bobToken, 'POST', '/posts',
      { channel_id: bobDm.id, message: 'hi from bob' })

    // Bob isn't allowed: should NOT show up in the inbox …
    const leaked = await Promise.race([
      delay(2500).then(() => false),
      waitFor(() => inbox.find(n => n.content === 'hi from bob'), 2000, 'leaked').then(() => true).catch(() => false),
    ])
    if (leaked) throw new Error('non-allowed user message was forwarded to Claude')

    // … and the bot should have DMed bob a pairing code.
    const codeMsg = await waitFor<{ message: string }>(async () => {
      const after = await mmAs(adminToken, 'GET',
        `/channels/${bobDm.id}/posts?per_page=5`)
      return Object.values<any>(after.posts ?? {}).find(p =>
        !bobBeforeIds.has(p.id) && /pair [A-Z0-9]{6}/.test(p.message)
      )
    }, 8000, 'pairing code DM')
    const m = (codeMsg.message as string).match(/pair ([A-Z0-9]{6})/)
    if (!m) throw new Error('no pairing code in message')
    const code = m[1]

    const r: any = await client.callTool({
      name: 'confirm_pairing', arguments: { code },
    })
    if (r.isError) throw new Error(`confirm_pairing error: ${JSON.stringify(r.content)}`)

    // Now bob's messages should forward.
    inbox.length = 0
    await mmAs(bobToken, 'POST', '/posts',
      { channel_id: bobDm.id, message: 'hi again from bob' })
    await waitFor(() => inbox.find(n => n.content === 'hi again from bob'), 8000,
      'post-pairing forward')
  })

  // 9. Thread follow-up in a channel that is NOT in MATTERMOST_LISTEN_CHANNELS
  //    and where the user does NOT @mention the bot in the follow-up.
  await step('thread follow-up forwards without re-mention', async () => {
    const mentionsChan = env.TEST_MENTIONS_CHANNEL_ID!
    const botName = env.TEST_BOT_USERNAME!

    // a) bare post (no mention) should NOT forward
    inbox.length = 0
    const baseTag = `smoke-bare-${Date.now()}`
    await mmAs(env.TEST_USER_TOKEN!, 'POST', '/posts',
      { channel_id: mentionsChan, message: baseTag })
    const leaked = await Promise.race([
      delay(2500).then(() => false),
      waitFor(() => inbox.find(n => n.content === baseTag), 2000, 'leak').then(() => true).catch(() => false),
    ])
    if (leaked) throw new Error('non-mentioned, non-watched post was forwarded')

    // b) @mention starts the conversation
    inbox.length = 0
    const mentionTag = `smoke-mention-${Date.now()}`
    await mmAs(env.TEST_USER_TOKEN!, 'POST', '/posts',
      { channel_id: mentionsChan, message: `@${botName} ${mentionTag}` })
    const mentionNote = await waitFor(
      () => inbox.find(n => n.content.includes(mentionTag)),
      8000, 'mention forward')
    const rootId = mentionNote.meta?.post_id
    if (!rootId) throw new Error('mention note missing post_id')

    // c) bot replies in the thread via the reply tool
    const botReply = `bot-reply-${Date.now()}`
    await client.callTool({
      name: 'reply',
      arguments: { channel_id: mentionsChan, message: botReply, root_id: rootId },
    })
    // wait for the bot's post to come back over WS so the server tracks the thread
    await delay(1500)

    // d) user follows up in the same thread WITHOUT mentioning the bot
    inbox.length = 0
    const followupTag = `smoke-followup-${Date.now()}`
    await mmAs(env.TEST_USER_TOKEN!, 'POST', '/posts', {
      channel_id: mentionsChan, message: followupTag, root_id: rootId,
    })
    const followNote = await waitFor(
      () => inbox.find(n => n.content === followupTag), 8000,
      'thread follow-up forward')
    if (followNote.meta?.root_id !== rootId) {
      throw new Error(`follow-up root_id mismatch: ${followNote.meta?.root_id} vs ${rootId}`)
    }
  })

  // 10. read_thread returns thread history rendered as text
  await step('read_thread returns thread history', async () => {
    const mentionsChan = env.TEST_MENTIONS_CHANNEL_ID!
    const root = await mmAs(env.TEST_USER_TOKEN!, 'POST', '/posts',
      { channel_id: mentionsChan, message: 'parent post for read_thread' })
    await mmAs(env.TEST_USER_TOKEN!, 'POST', '/posts',
      { channel_id: mentionsChan, message: 'first reply', root_id: root.id })
    await mmAs(env.TEST_USER_TOKEN!, 'POST', '/posts',
      { channel_id: mentionsChan, message: 'second reply', root_id: root.id })

    const r = await client.callTool({
      name: 'read_thread', arguments: { root_id: root.id },
    }) as { content: { text?: string }[]; isError?: boolean }
    if (r.isError) throw new Error('read_thread returned isError')
    const body = r.content[0]?.text ?? ''
    for (const needle of ['parent post for read_thread', 'first reply', 'second reply', '@alice']) {
      if (!body.includes(needle)) throw new Error(`read_thread output missing "${needle}":\n${body}`)
    }
  })

  // 11. clear_thread_state removes a thread from the tracked set
  await step('clear_thread_state stops auto-forwarding for that thread', async () => {
    const mentionsChan = env.TEST_MENTIONS_CHANNEL_ID!
    const botName = env.TEST_BOT_USERNAME!

    inbox.length = 0
    const tag = `smoke-clear-${Date.now()}`
    await mmAs(env.TEST_USER_TOKEN!, 'POST', '/posts',
      { channel_id: mentionsChan, message: `@${botName} ${tag}` })
    const note = await waitFor(() => inbox.find(n => n.content.includes(tag)), 8000, 'mention forward')
    const rootId = note.meta?.post_id!
    await client.callTool({
      name: 'reply',
      arguments: { channel_id: mentionsChan, message: `bot reply to ${tag}`, root_id: rootId },
    })
    await delay(1500)

    // Verify it would forward without the clear:
    inbox.length = 0
    await mmAs(env.TEST_USER_TOKEN!, 'POST', '/posts',
      { channel_id: mentionsChan, message: `pre-clear ${tag}`, root_id: rootId })
    await waitFor(() => inbox.find(n => n.content === `pre-clear ${tag}`), 8000, 'pre-clear forward')

    // Now clear:
    const r = await client.callTool({
      name: 'clear_thread_state', arguments: { root_id: rootId },
    }) as { content: { text?: string }[]; isError?: boolean }
    if (r.isError) throw new Error('clear_thread_state returned isError')
    if (!String(r.content[0]?.text ?? '').startsWith('cleared')) {
      throw new Error(`clear_thread_state unexpected output: ${r.content[0]?.text}`)
    }

    // Follow-up should now NOT forward (no mention, thread no longer tracked):
    inbox.length = 0
    await mmAs(env.TEST_USER_TOKEN!, 'POST', '/posts',
      { channel_id: mentionsChan, message: `post-clear ${tag}`, root_id: rootId })
    const leaked = await Promise.race([
      delay(2500).then(() => false),
      waitFor(() => inbox.find(n => n.content === `post-clear ${tag}`), 2000, 'leaked').then(() => true).catch(() => false),
    ])
    if (leaked) throw new Error('post-clear follow-up was forwarded — clear_thread_state did not stick')
  })

  // 12. Thread tracking persists across server restart. (Must run last; it
  // closes the original client/transport and spawns a new one.)
  await step('bot-thread tracking survives a server restart', async () => {
    const mentionsChan = env.TEST_MENTIONS_CHANNEL_ID!
    const botName = env.TEST_BOT_USERNAME!

    // Establish a thread the bot is part of, in this run.
    inbox.length = 0
    const tag = `smoke-restart-${Date.now()}`
    await mmAs(env.TEST_USER_TOKEN!, 'POST', '/posts',
      { channel_id: mentionsChan, message: `@${botName} ${tag}` })
    const note = await waitFor(() => inbox.find(n => n.content.includes(tag)), 8000, 'restart-mention')
    const rootId = note.meta?.post_id!
    await client.callTool({
      name: 'reply',
      arguments: { channel_id: mentionsChan, message: `bot-reply-${tag}`, root_id: rootId },
    })
    await delay(1500)  // let the bot's post echo back over WS

    // Restart the channel server: close the old client/transport, spin up a new pair.
    await client.close()
    const newTransport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', resolve(import.meta.dirname, '..', 'mattermost.ts')],
      env: {
        ...process.env,
        MATTERMOST_URL: env.MATTERMOST_URL!,
        MATTERMOST_TOKEN: env.MATTERMOST_TOKEN!,
        MATTERMOST_TEAM: env.MATTERMOST_TEAM!,
        MATTERMOST_ALLOWED_USERS: env.MATTERMOST_ALLOWED_USERS!,
        MATTERMOST_LISTEN_CHANNELS: env.MATTERMOST_LISTEN_CHANNELS!,
        MATTERMOST_STATE_FILE: resolve(import.meta.dirname, '..', '.smoke-state.json'),
      },
      stderr: 'pipe',
    })
    newTransport.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[server2] ${chunk}`))
    const newClient = new Client({ name: 'smoke-test', version: '0.0.0' }, { capabilities: {} })
    const inbox2: ChannelNotification['params'][] = []
    newClient.setNotificationHandler(ChannelNotification, async n => { inbox2.push(n.params) })
    await newClient.connect(newTransport)
    await delay(2500)  // ws auth + allowlist resolution

    // User replies in the SAME thread (no mention) — fresh process, fresh
    // memory, but state file should have remembered the thread root_id.
    const tagAfter = `smoke-restart-after-${Date.now()}`
    await mmAs(env.TEST_USER_TOKEN!, 'POST', '/posts', {
      channel_id: mentionsChan, message: tagAfter, root_id: rootId,
    })
    await waitFor(() => inbox2.find(n => n.content === tagAfter), 8000,
      'thread follow-up forwards after restart')

    // Reattach `client` so the .finally() cleanup closes the right one.
    client = newClient
  })
}

main().catch(e => {
  fail('fatal', e)
}).finally(async () => {
  try { await client.close() } catch {}
  try { serverProc?.kill() } catch {}
  console.log()
  if (fails.length) {
    console.log(`[31m${fails.length} failed, ${passes.length} passed[0m`)
    process.exit(1)
  } else {
    console.log(`[32mall ${passes.length} checks passed[0m`)
    process.exit(0)
  }
})
