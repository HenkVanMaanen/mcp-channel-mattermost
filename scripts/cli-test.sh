#!/usr/bin/env bash
# Verify the channel server when loaded by the real `claude` CLI.
#
# Caveat: Claude Code v2.1.132 does NOT surface `notifications/claude/channel`
# events to the model in `--print` (headless) mode. Channels are intended for
# interactive TTY sessions. So this test verifies the headless contract — the
# pieces that DON'T require the model to see the inbound tag:
#
#   1. claude registers the server (mcp_servers status=connected)
#   2. claude advertises mcp__mattermost__reply and mcp__mattermost__confirm_pairing
#   3. when alice posts in #ops-alerts, the channel server forwards a
#      notifications/claude/channel to claude (proved via the server's debug log)
#   4. claude can call the reply tool via the model and the message lands in
#      Mattermost (proves the outbound stdio + REST round-trip)
#
# For the full inbound chat-bridge experience, see "Test interactively with
# claude" in the README.
set -euo pipefail
cd "$(dirname "$0")/.."

source .env.local
TAG="cli-test-$$-$(date +%s)"

MCP_CFG="$(mktemp -t mcp.cli-test.XXXX.json)"
LOG="$(mktemp -t claude-cli-test.XXXX.log)"
FIFO="$(mktemp -u -t claude-stdin.XXXX)"
DBG_LOG="$(pwd)/.cli-test-channel.log"
mkfifo "$FIFO"
: > "$DBG_LOG"

cleanup() {
  [ -n "${FEEDER_PID:-}" ] && kill "$FEEDER_PID" 2>/dev/null || true
  [ -n "${CLAUDE_PID:-}" ] && kill "$CLAUDE_PID" 2>/dev/null || true
  rm -f "$MCP_CFG" "$FIFO" .cli-test-state.json
}
trap cleanup EXIT

cat > "$MCP_CFG" <<EOF
{
  "mcpServers": {
    "mattermost": {
      "command": "npx",
      "args": ["tsx", "$(pwd)/mattermost.ts"],
      "env": {
        "MATTERMOST_URL": "$MATTERMOST_URL",
        "MATTERMOST_TOKEN": "$MATTERMOST_TOKEN",
        "MATTERMOST_TEAM": "$MATTERMOST_TEAM",
        "MATTERMOST_ALLOWED_USERS": "$MATTERMOST_ALLOWED_USERS",
        "MATTERMOST_LISTEN_CHANNELS": "$MATTERMOST_LISTEN_CHANNELS",
        "MATTERMOST_STATE_FILE": "$(pwd)/.cli-test-state.json",
        "MATTERMOST_DEBUG_LOG": "$DBG_LOG"
      }
    }
  }
}
EOF

PROMPT="Call the mcp__mattermost__reply tool exactly once with these arguments: channel_id='$TEST_CHANNEL_ID' and message='cli-tool-ack: $TAG'. Then stop."

passes=0
fails=0
ok()  { printf '\033[32m✓\033[0m %s\n' "$1"; passes=$((passes+1)); }
bad() { printf '\033[31m✗\033[0m %s\n  %s\n' "$1" "$2"; fails=$((fails+1)); }

echo "tag: $TAG"
echo ">> spawning claude (logging to $LOG)"

INITIAL_MSG="$(jq -nc --arg p "$PROMPT" '
  {type:"user", message:{role:"user", content:[{type:"text", text:$p}]}}
')"
(
  printf '%s\n' "$INITIAL_MSG"
  sleep 240
) > "$FIFO" &
FEEDER_PID=$!

claude --print \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --mcp-config "$MCP_CFG" \
  --strict-mcp-config \
  --dangerously-load-development-channels "server:mattermost" \
  --permission-mode bypassPermissions \
  --max-budget-usd 1 \
  < "$FIFO" > "$LOG" 2>&1 &
CLAUDE_PID=$!

# (1) wait for the channel server to register
echo ">> waiting for channel to come up …"
for i in $(seq 1 30); do
  if grep -q '"name":"mattermost","status":"connected"' "$LOG" 2>/dev/null; then
    ok "channel server registers with claude (after ${i}s)"
    break
  fi
  sleep 1
done
if ! grep -q '"name":"mattermost","status":"connected"' "$LOG" 2>/dev/null; then
  bad "channel server registers with claude" "did not appear in init event"
  tail -50 "$LOG" >&2; exit 1
fi

# (2) tools advertised
if grep -q '"mcp__mattermost__reply"' "$LOG" && grep -q '"mcp__mattermost__confirm_pairing"' "$LOG"; then
  ok "claude advertises reply + confirm_pairing tools"
else
  bad "claude advertises reply + confirm_pairing tools" "missing in tools list"
fi

# (3) post a Mattermost message and verify the channel server forwards a notification
echo ">> posting Mattermost message as alice"
curl -sS -X POST \
  -H "Authorization: Bearer $TEST_USER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "$(jq -nc --arg c "$TEST_CHANNEL_ID" --arg m "$TAG" '{channel_id:$c, message:$m}')" \
  "$MATTERMOST_URL/api/v4/posts" >/dev/null

for i in $(seq 1 15); do
  if grep -q "$TAG" "$DBG_LOG" 2>/dev/null; then break; fi
  sleep 1
done
if grep -q "forwarding to claude.*$TAG" "$DBG_LOG" 2>/dev/null; then
  ok "channel server forwards inbound post to claude"
else
  bad "channel server forwards inbound post to claude" "no entry in $DBG_LOG"
fi

# (4) wait for claude to call the reply tool
echo ">> waiting for claude to call reply tool (max 60s)"
for i in $(seq 1 60); do
  if grep -q '"name":"mcp__mattermost__reply"' "$LOG" 2>/dev/null; then break; fi
  if ! kill -0 "$CLAUDE_PID" 2>/dev/null; then break; fi
  sleep 1
done

# Let claude finish its turn so the reply tool actually fires.
sleep 3
kill "$FEEDER_PID" 2>/dev/null || true
for i in $(seq 1 15); do
  if ! kill -0 "$CLAUDE_PID" 2>/dev/null; then break; fi
  sleep 1
done
kill "$CLAUDE_PID" 2>/dev/null || true

# Check Mattermost for the bot's reply.
POSTS=$(curl -sS -H "Authorization: Bearer $TEST_USER_TOKEN" \
  "$MATTERMOST_URL/api/v4/channels/$TEST_CHANNEL_ID/posts?per_page=30")

if echo "$POSTS" | jq -e --arg t "$TAG" --arg bot "$TEST_BOT_ID" '
  .posts | to_entries | map(.value)
  | map(select(.user_id == $bot and (.message | test("cli-tool-ack:.*" + $t))))
  | length >= 1
' >/dev/null; then
  ok "claude → reply tool → Mattermost round-trip"
  echo "$POSTS" | jq --arg t "$TAG" --arg bot "$TEST_BOT_ID" '
    .posts | to_entries | map(.value)
    | map(select(.user_id == $bot and (.message | test("cli-tool-ack:.*" + $t))))
    | .[0] | {message, create_at}'
else
  bad "claude → reply tool → Mattermost round-trip" "no matching post by bot"
fi

echo
if [ "$fails" -eq 0 ]; then
  printf '\033[32mall %d checks passed\033[0m\n' "$passes"
  echo
  echo "Note: full inbound channel-tag → reply flow requires an interactive session."
  echo "See the 'Test interactively with claude' section of README.md."
  exit 0
else
  printf '\033[31m%d failed, %d passed\033[0m\n' "$fails" "$passes" >&2
  echo
  echo "==== last 80 lines of claude log ====" >&2
  tail -n 80 "$LOG" >&2
  exit 1
fi
