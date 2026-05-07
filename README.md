# mcp-channel-mattermost

A [Claude Code channel](https://code.claude.com/docs/en/channels-reference) that
bridges a Mattermost bot into your Claude Code session. DMs to the bot, mentions
of the bot in channels, and posts in watched channels are forwarded to Claude as
`<channel source="mattermost" …>` events; Claude can post back through a `reply`
tool, and tool-use approvals can be relayed to Mattermost so you can approve or
deny them from your phone.

Tested against Mattermost **10.12.4** (Team Edition).

## Features

- Forward inbound posts to Claude:
  - DMs to the bot
  - `@bot` mentions in any channel the bot is a member of
  - Every post in channels listed via `MATTERMOST_LISTEN_CHANNELS` (alerts, ops rooms)
- Two-way: `reply` MCP tool posts back to a channel/DM, optional `root_id` for threading
- Permission relay: tool-use prompts (`Bash`, `Write`, `Edit`, …) are DMed to allowed users; reply `yes <id>` / `no <id>` to approve or deny
- Sender gating with two paths:
  - Static allowlist via `MATTERMOST_ALLOWED_USERS` (usernames or 26-char IDs)
  - Pairing fallback: an unknown DMer gets a 6-char code; the operator pastes it into Claude Code, Claude calls `confirm_pairing`, the user is added to a persisted allowlist
- Auto-reconnecting WebSocket consumer with exponential backoff

## Requirements

- A Mattermost server (this repo includes a docker-compose for 10.12.4)
- A bot account with a personal access token (see [Set up the bot](#set-up-the-bot))
- Claude Code **v2.1.81+** for permission relay; v2.1.80+ otherwise
- One of:
  - [Bun](https://bun.sh) ≥ 1.1 (matches the official channel examples)
  - Node.js ≥ 18 with [`tsx`](https://www.npmjs.com/package/tsx)

## Install as a plugin

This repo doubles as a Claude Code plugin — `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`, and `.mcp.json` are in place. Add the
marketplace once, then install:

```text
/plugin marketplace add henkvanmaanen/mcp-channel-mattermost
/plugin install mattermost@mcp-channel-mattermost
```

(Or, for local development, point the marketplace at a clone:
`/plugin marketplace add /path/to/mcp-channel-mattermost`.)

After install, configure the plugin:

```text
/mattermost:configure
```

The `mattermost:configure` skill walks you through creating the bot, generating
a token, picking an allowlist, and exporting the env vars Claude Code will
read at startup. Then enable the channel:

```sh
# during the research preview, custom channels need the development flag:
claude --dangerously-load-development-channels plugin:mattermost@mcp-channel-mattermost
```

Once published to the official marketplace, you can drop the dev flag and
just enable it with `--channels plugin:mattermost@mcp-channel-mattermost`.

## Quick start (against a real Mattermost)

### 1. Set up the bot

In Mattermost as a system admin:

1. **System Console → Integrations → Bot Accounts → Enable Bot Account Creation: true**
2. **System Console → Integrations → Personal Access Tokens → Enable: true**
3. **Integrations → Bot Accounts → Add Bot Account**, give it a username (e.g. `claude`)
4. After creation, save the bot's user ID and personal access token
5. Add the bot to the team and to any channels you want it to listen in (`MATTERMOST_LISTEN_CHANNELS` channels and any channel where users will `@claude`)

### 2. Install

```sh
git clone https://github.com/henkvanmaanen/mcp-channel-mattermost
cd mcp-channel-mattermost
bun install     # or: npm install
```

### 3. Configure

Copy `.env.example` to `.env` and fill it in, or set the variables in your shell.
Whichever you do, the channel server reads them from its own process env (which
Claude Code passes through from the `env` block of your `.mcp.json`).

| Variable | Required | Description |
| --- | --- | --- |
| `MATTERMOST_URL` | yes | Base URL, no trailing `/api/v4` |
| `MATTERMOST_TOKEN` | yes | Bot personal access token |
| `MATTERMOST_TEAM` | when using channel names | Team name (URL slug) |
| `MATTERMOST_ALLOWED_USERS` | recommended | Comma-separated usernames or 26-char user IDs |
| `MATTERMOST_LISTEN_CHANNELS` | optional | Comma-separated channel names or IDs to forward every post from |
| `MATTERMOST_STATE_FILE` | optional | Where to persist the pairing-allowlist (default `~/.mcp-channel-mattermost/state.json`) |

### 4. Register with Claude Code

Project-level (`.mcp.json` in your project root) — see `.mcp.json.example`:

```json
{
  "mcpServers": {
    "mattermost": {
      "command": "bun",
      "args": ["./mattermost.ts"],
      "env": {
        "MATTERMOST_URL": "https://mattermost.example.com",
        "MATTERMOST_TOKEN": "…",
        "MATTERMOST_TEAM": "myteam",
        "MATTERMOST_ALLOWED_USERS": "alice,bob",
        "MATTERMOST_LISTEN_CHANNELS": "ops-alerts"
      }
    }
  }
}
```

To run on Node instead of Bun, use `"command": "npx", "args": ["tsx", "./mattermost.ts"]`.

### 5. Run

Channels are gated by an Anthropic-curated allowlist during the research preview,
so use the development flag while testing your own:

```sh
claude --dangerously-load-development-channels server:mattermost
```

DM the bot from an allowlisted user — the message lands in your Claude Code
session as `<channel source="mattermost" …>`.

## Local development with docker-compose

A fully scripted Mattermost 10.12.4 setup is included.

```sh
npm install
npm run mm:up        # start postgres + Mattermost on http://localhost:8065
npm run mm:setup     # creates admin, team, bot, alice; writes .env.local
npm run smoke        # end-to-end integration test (no claude required)
npm run cli-test     # spawns the real claude CLI; verifies registration + reply
```

The setup script is idempotent. It writes a `.env.local` that the smoke test
consumes; you can also point Claude Code at the same Mattermost by reusing the
generated `MATTERMOST_TOKEN` in your `.mcp.json`.

To tear down:

```sh
npm run mm:down      # stops containers and deletes volumes
```

## Test against the real claude CLI

Three scripts exercise the channel against the actual `claude` CLI:

```sh
npm run cli-test         # headless: registration + outbound reply tool (4/4)
npm run cli-test:tmux    # interactive (via tmux): full inbound bridge (✓)
npm run cli-test:inbound # diagnostic: documents the --print limitation
```

### Headless mode (`--print`)

`cli-test` runs claude with `--print --input-format stream-json` and verifies
the headless contract:

1. claude registers `mattermost` as a connected MCP server
2. claude advertises `mcp__mattermost__reply` and `mcp__mattermost__confirm_pairing`
3. when alice posts in `#ops-alerts`, the channel server emits `notifications/claude/channel`
4. claude can call the reply tool and the message lands back in Mattermost

What `--print` mode does NOT do: surface the inbound `<channel source="mattermost" …>`
tag to the model. You can prove this with `cli-test:inbound`, which asks claude
to dump every channel tag from its context to a file. The channel server's debug
log shows it emitted the notification, but claude's dump file says
`NO_CHANNEL_TAGS_FOUND`. Channel notifications are interactive-mode-only in
the current Claude Code (v2.1.132).

### Interactive mode (real chat-bridge)

`cli-test:tmux` boots claude inside its own tmux session (using a dedicated
tmux socket so it can never affect your other sessions), sends keystrokes
through the trust + dev-channels prompts, posts a Mattermost message, and
asserts the bot's reply lands back in the channel — proving the full
production flow:

```
alice posts → channel server WS → notifications/claude/channel
              → Claude sees <channel> tag → reply tool → Mattermost
```

Manual interactive test (no script):

```sh
# project root with .mcp.json pointing at this server
claude --dangerously-load-development-channels server:mattermost
```

DM the bot from an allowlisted user, or post in an allowlisted channel.
Claude prints the inbound `<channel>` tag and responds via the reply tool.

## Notification format

Every forwarded post arrives in Claude's context as:

```
<channel
  source="mattermost"
  channel_id="..."          26-char Mattermost channel ID
  channel_type="D|O|P|G"    D=direct, O=public, P=private, G=group DM
  channel_name="..."        slug (or "" for DMs)
  post_id="..."             this post's ID
  root_id="..."             thread root (= post_id if not in a thread)
  user_id="..."             sender's 26-char user ID
  username="..."            sender's username (no @)
>
…message body…
</channel>
```

Tag attribute keys must be identifiers — letters, digits, underscores. Hyphens
are stripped by the Claude Code framework, so this server avoids them.

## Tools

### `reply`

```ts
reply({ channel_id, message, root_id? })
```

Posts a message back to Mattermost. To reply in-thread, pass `root_id` (use
`root_id` from the inbound tag if non-empty, otherwise `post_id`).

### `confirm_pairing`

```ts
confirm_pairing({ code })
```

Adds the user behind a pending pairing code to the persisted allowlist. The
operator types the 6-char code into Claude Code (e.g. `pair ABC123`), Claude
sees the pattern in its instructions and calls this tool. Codes expire after
10 minutes.

## Permission relay

When you start a session with this channel registered, Claude Code forwards
tool-use approval prompts (`Bash`, `Write`, `Edit`, …) to your server. The
server DMs every approved user a message like:

> Claude wants to use **Bash**: list files in the current directory
>
> ```
> {"command":"ls"}
> ```
>
> Reply `yes abcde` or `no abcde`.

Reply with `yes <id>` or `no <id>` and the tool call proceeds or is rejected.
The local terminal dialog stays open in parallel — whichever side answers
first wins.

Project trust and MCP-server consent dialogs are NOT relayed; only tool-use
approvals.

## Pairing flow

1. An unknown user DMs the bot.
2. The bot DMs them back: `Your pairing code is XYZ123. Share it with the operator.`
3. The user shares the code with whoever runs Claude Code.
4. The operator pastes `pair XYZ123` into their Claude Code session.
5. Claude reads its instructions, sees the pattern, calls `confirm_pairing({code})`.
6. The user's `user_id` is appended to `~/.mcp-channel-mattermost/state.json` and they're DMed a confirmation.

The persisted allowlist is additive to `MATTERMOST_ALLOWED_USERS`. To revoke
an ad-hoc paired user, edit (or delete) the state file and restart the channel.

## Security notes

- Use a **bot account**, not a personal token. Bots have a clear audit trail.
- Always set `MATTERMOST_ALLOWED_USERS` (or rely on pairing). An ungated channel is a prompt-injection vector — anyone who can DM the bot would be able to put text in front of Claude.
- The pairing TTL is 10 minutes and codes are single-use.
- Watched-channel forwarding and `@mention` forwarding are still gated by the sender allowlist — if someone in `ops-alerts` isn't allowlisted, their posts are dropped.
- The state file is written to `$HOME/.mcp-channel-mattermost/` by default. Override with `MATTERMOST_STATE_FILE` if you run multiple sessions or need a system path.

## Troubleshooting

- **`/mcp` shows the channel as "Failed to connect"**: the server crashed. Check `~/.claude/debug/<session-id>.txt` for the stderr trace; common causes are missing env vars or an unreachable `MATTERMOST_URL`.
- **No events arrive when posting in a channel**: the bot must be a member of that channel. WebSocket events for posts are only delivered to channel members.
- **Bot doesn't respond to DMs**: make sure DMs are enabled (`System Console → Site Configuration → Posts → Enable Direct Messages: Anyone on the server`) and that the bot is in the same team as the sender.
- **Permission DMs never arrive**: Claude Code v2.1.81+ is required for relay; older versions silently ignore the `claude/channel/permission` capability.
- **`bot create failed: api.bot.create_disabled`**: enable bot account creation (`MM_SERVICESETTINGS_ENABLEBOTACCOUNTCREATION=true` or via the System Console).

## How it works

```
                   stdio (MCP)
Claude Code <─────────────────────> mattermost.ts
                                           │
                                           │ REST  (POST /api/v4/posts, …)
                                           │ WS    (/api/v4/websocket)
                                           ▼
                                      Mattermost
```

`mattermost.ts` is a single-file MCP server. On startup it:

1. Authenticates to Mattermost via the bot personal access token
2. Resolves the configured allowlist usernames and watched channel names to IDs
3. Loads the persisted pairing allowlist from `MATTERMOST_STATE_FILE`
4. Registers two MCP tools (`reply`, `confirm_pairing`) and one notification handler (`notifications/claude/channel/permission_request`)
5. Connects to `/api/v4/websocket` and authenticates with the same token
6. Subscribes implicitly to `posted` events, parses each post, and:
   - drops posts the bot itself sent
   - drops posts the bot wasn't @mentioned in (unless DM or watched-channel)
   - drops senders not in either allowlist (DMing them a pairing code if they DMed the bot)
   - parses `yes/no <id>` verdicts and forwards them as `notifications/claude/channel/permission`
   - forwards the rest as `notifications/claude/channel`

## Project layout

```
.
├── .claude-plugin/
│   ├── plugin.json                  # plugin manifest (name, version, keywords)
│   └── marketplace.json             # single-plugin marketplace pointing at this repo
├── .mcp.json                        # plugin runtime: spawns mattermost.ts via ${CLAUDE_PLUGIN_ROOT}
├── mattermost.ts                    # the channel server (single file)
├── package.json                     # bin: mattermost.ts; start: bun install && bun mattermost.ts
├── tsconfig.json
├── skills/
│   └── configure/SKILL.md           # /mattermost:configure helper
├── docker-compose.dev.yml           # local Mattermost 10.12.4 + postgres
├── scripts/
│   ├── setup-mattermost.sh          # bootstrap admin/team/bot/user via API
│   ├── smoke-test.ts                # MCP stdio client driving the server end-to-end
│   ├── cli-test.sh                  # spawns real claude CLI (headless); registration + reply
│   ├── cli-test-tmux.sh             # spawns real claude CLI (interactive via tmux); full bridge
│   └── cli-test-inbound.sh          # diagnostic for the --print inbound limitation
├── .env.example
└── .mcp.json.example                # standalone install template (when not using as a plugin)
```

## License

MIT
