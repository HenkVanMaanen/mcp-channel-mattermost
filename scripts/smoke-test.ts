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

const client = new Client(
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

  // 1. ListTools — server exposes reply + confirm_pairing
  await step('lists reply and confirm_pairing tools', async () => {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name).sort()
    if (JSON.stringify(names) !== JSON.stringify(['confirm_pairing', 'reply'])) {
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
