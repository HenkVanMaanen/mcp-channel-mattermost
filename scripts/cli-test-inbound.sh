#!/usr/bin/env bash
# Diagnostic: does Claude --print actually see <channel> tags?
#
# We give Claude a 2-turn session. In turn 1, it just acknowledges.
# We then post a Mattermost message; the channel server forwards it.
# In turn 2, we ask Claude to dump every <channel> tag visible in its context
# to a file via the Write tool. We then read that file and check for our tag.
#
# This separates "did the notification reach Claude's context?" from
# "what does the model SAY about what it sees?"

set -euo pipefail
cd "$(dirname "$0")/.."

source .env.local
TAG="inbound-test-$$-$(date +%s)"
DUMP="$(pwd)/.cli-test-channel-dump.md"
rm -f "$DUMP"

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

PROMPT_INIT='Acknowledge with a single short sentence and wait. A second message will follow.'
PROMPT_DUMP="Use the Write tool to create the file '$DUMP' containing, verbatim and unedited, every <channel ...>...</channel> tag (and any text inside <function_calls>/tool_result blocks that mentions 'mattermost') currently visible in your conversation context. If you see no such tags, write 'NO_CHANNEL_TAGS_FOUND' as the file body. After writing the file, also use the Bash tool to run 'ls -la $DUMP' so the file size is captured."

echo "tag: $TAG"

INITIAL_MSG="$(jq -nc --arg p "$PROMPT_INIT" '
  {type:"user", message:{role:"user", content:[{type:"text", text:$p}]}}
')"
DUMP_MSG="$(jq -nc --arg p "$PROMPT_DUMP" '
  {type:"user", message:{role:"user", content:[{type:"text", text:$p}]}}
')"

POKE_TRIGGER="$(mktemp -u -t cli-test-poke.XXXX)"
END_TRIGGER="$(mktemp -u -t cli-test-end.XXXX)"
trap 'cleanup; rm -f "$POKE_TRIGGER" "$END_TRIGGER"' EXIT

(
  printf '%s\n' "$INITIAL_MSG"
  while [ ! -e "$POKE_TRIGGER" ] && [ ! -e "$END_TRIGGER" ]; do sleep 0.5; done
  [ -e "$POKE_TRIGGER" ] && printf '%s\n' "$DUMP_MSG"
  while [ ! -e "$END_TRIGGER" ]; do sleep 0.5; done
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

# wait for channel to come up
for i in $(seq 1 30); do
  grep -q '"name":"mattermost","status":"connected"' "$LOG" 2>/dev/null && break
  sleep 1
done

# wait for turn 1 to complete (so we know claude is idle and the channel server is up)
echo ">> waiting for turn 1 ack"
for i in $(seq 1 30); do
  if grep -q '"type":"result"' "$LOG" 2>/dev/null; then
    echo "   turn 1 done after ${i}s"
    break
  fi
  sleep 1
done

# post mattermost message
echo ">> posting message ($TAG) to #$MATTERMOST_LISTEN_CHANNELS"
curl -sS -X POST \
  -H "Authorization: Bearer $TEST_USER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "$(jq -nc --arg c "$TEST_CHANNEL_ID" --arg m "$TAG" '{channel_id:$c, message:$m}')" \
  "$MATTERMOST_URL/api/v4/posts" >/dev/null

# Wait until the channel server has actually emitted the notification.
for i in $(seq 1 15); do
  grep -q "forwarding to claude.*$TAG" "$DBG_LOG" 2>/dev/null && break
  sleep 1
done
if grep -q "forwarding to claude.*$TAG" "$DBG_LOG" 2>/dev/null; then
  echo "   channel server forwarded notification: yes"
else
  echo "   channel server forwarded notification: NO" >&2
fi

# Trigger turn 2 (asks claude to dump tags to file)
echo ">> sending dump prompt"
touch "$POKE_TRIGGER"

# wait for the dump file to appear
echo ">> waiting for $DUMP to be written"
for i in $(seq 1 60); do
  [ -s "$DUMP" ] && break
  if ! kill -0 "$CLAUDE_PID" 2>/dev/null; then break; fi
  sleep 1
done

touch "$END_TRIGGER"
sleep 2
kill "$FEEDER_PID" "$CLAUDE_PID" 2>/dev/null || true

echo
if [ -s "$DUMP" ]; then
  echo "==== Claude's dump file ===="
  cat "$DUMP"
  echo
  echo "============================="
  if grep -q "$TAG" "$DUMP"; then
    printf '\033[32m✓ Claude saw the channel tag in its context\033[0m\n'
    exit 0
  elif grep -q 'NO_CHANNEL_TAGS_FOUND' "$DUMP"; then
    printf '\033[31m✗ Claude reports NO channel tags in its context\033[0m\n'
    echo "  (channel server confirmed it forwarded the notification — see $DBG_LOG)"
    exit 1
  else
    printf '\033[33m? Claude wrote a dump but our tag is not in it\033[0m\n'
    exit 1
  fi
else
  printf '\033[31m✗ no dump file produced\033[0m\n' >&2
  echo "==== last 80 lines of claude log ====" >&2
  tail -n 80 "$LOG" >&2
  exit 1
fi
