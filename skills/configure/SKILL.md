---
name: mattermost:configure
description: Walk the user through configuring the Mattermost channel — creating a bot account, generating a personal access token, choosing an allowlist, and exporting the env vars Claude Code reads on startup. Invoke when the user runs `/mattermost:configure`, says "set up mattermost channel", "configure the mattermost plugin", or first installs this plugin and needs guidance.
---

# Configure the Mattermost channel

This plugin needs five things from a Mattermost server before it can bridge messages:

| env var | required | what it is |
| --- | --- | --- |
| `MATTERMOST_URL` | yes | Base URL of the server, e.g. `https://mattermost.example.com` (no trailing `/api/v4`) |
| `MATTERMOST_TOKEN` | yes | Personal access token of the bot account |
| `MATTERMOST_TEAM` | when using channel names | Team name slug — only needed if `MATTERMOST_LISTEN_CHANNELS` uses names rather than 26-char IDs |
| `MATTERMOST_ALLOWED_USERS` | strongly recommended | Comma-separated usernames or 26-char user IDs whose messages are forwarded to Claude |
| `MATTERMOST_LISTEN_CHANNELS` | optional | Comma-separated channel names or IDs to forward every post from |

## Walk the user through it

Ask each question in turn, then provide the final export commands.

1. **Server URL.** What's the Mattermost server URL? (Just the origin — e.g. `https://mattermost.example.com`.)

2. **Bot account.** Does the user have a bot account ready? If not, instruct them:
   - Sign in as a system admin
   - System Console → Integrations → Bot Accounts → **Enable Bot Account Creation: true**
   - System Console → Integrations → Personal Access Tokens → **Enable: true**
   - Integrations → Bot Accounts → **Add Bot Account**, give it a username (suggest `claude`)
   - Save the bot's user ID and personal access token shown on screen
   - Add the bot to the team and to any channel where it should listen for `@mentions` or every post

3. **Token.** Capture the personal access token (starts with random characters; shown once).

4. **Team.** Ask for the team URL slug. The user can find it as the path in the URL: `https://mattermost.example.com/<TEAM>/channels/town-square` — `<TEAM>` is the value.

5. **Allowlist.** Which Mattermost users should be allowed to message Claude through the bot? List usernames (without `@`) or 26-char user IDs, comma-separated. If they want pairing-only (no static allowlist), this can be empty — but tell them an empty allowlist plus zero pairings means the bot answers nobody.

6. **Watched channels (optional).** Which channels should forward EVERY post (e.g. an alerts channel)? Channel names need `MATTERMOST_TEAM` set; channel IDs work without.

## Final step — give the user the export block

Print these lines for the user to add to their shell rc or paste before launching `claude`:

```sh
export MATTERMOST_URL="https://…"
export MATTERMOST_TOKEN="…"
export MATTERMOST_TEAM="…"
export MATTERMOST_ALLOWED_USERS="alice,bob"
export MATTERMOST_LISTEN_CHANNELS="ops-alerts"
```

The MCP server inherits these from the parent shell when Claude Code spawns it. To verify everything wired up, ask the user to start a new `claude` session and look for `Listening for channel messages from: plugin:mattermost@…` in the welcome banner, then DM the bot from one of the allowlisted users.

## Notes worth flagging to the user

- **Pairing fallback.** If a non-allowlisted user DMs the bot, the bot replies with a 6-character pairing code. The user shares it with whoever runs `claude`; the operator pastes `pair ABC123` into their terminal and the channel calls `confirm_pairing`, persisting the new user_id to `~/.mcp-channel-mattermost/state.json`.
- **Permission relay.** Tool-use approvals (`Bash`, `Write`, `Edit`, …) are DMed to every allowlisted user. Reply `yes <id>` or `no <id>` to approve or deny remotely. The local terminal dialog stays open in parallel; first answer wins.
- **Sender gating is on the SENDER, not the room.** Even in a watched channel, only allowlisted senders are forwarded. Other users' posts are silently dropped.
