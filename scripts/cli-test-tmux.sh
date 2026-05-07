#!/usr/bin/env bash
# Drive interactive `claude` via tmux on its OWN socket so this script
# cannot affect any other tmux server. NEVER call `tmux kill-server` on a
# shared socket — every invocation here passes `-L $TMUX_SOCKET`.
#
# Channel notifications are injected into the model's context only in
# interactive mode, so this is the closest we can automate to the
# documented chat-bridge UX.
set -euo pipefail
cd "$(dirname "$0")/.."

source .env.local
TAG="tmux-test-$$-$(date +%s)"

# Dedicated tmux socket; sharing nothing with the default server.
TMUX_SOCKET="mcpchanneltest-$$"
SESSION="claudemm"
T() { tmux -L "$TMUX_SOCKET" "$@"; }
pane() { T capture-pane -t "$SESSION" -pS -3000 2>/dev/null || true; }

PROJECT_DIR="$(mktemp -d -t claude-mm-test.XXXX)"
DBG_LOG="$PROJECT_DIR/.cli-test-channel.log"
PANE_DUMP="$PROJECT_DIR/pane.log"
: > "$DBG_LOG"

cleanup() {
  T kill-session -t "$SESSION" 2>/dev/null || true
  T kill-server 2>/dev/null || true       # safe — our isolated socket only
  rm -f "/tmp/tmux-1000/$TMUX_SOCKET" 2>/dev/null || true
  rm -rf "$PROJECT_DIR"
}
trap cleanup EXIT INT TERM

cat > "$PROJECT_DIR/.mcp.json" <<EOF
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
        "MATTERMOST_STATE_FILE": "$PROJECT_DIR/state.json",
        "MATTERMOST_DEBUG_LOG": "$DBG_LOG"
      }
    }
  }
}
EOF

# Pre-trust the workspace — claude stores trust in ~/.claude/projects-config.json.
mkdir -p "$PROJECT_DIR/.claude"
cat > "$PROJECT_DIR/.claude/settings.local.json" <<'EOF'
{ "trust": true }
EOF

echo "tag:        $TAG"
echo "project:    $PROJECT_DIR"
echo "tmux:       -L $TMUX_SOCKET / session $SESSION"

dump() {
  echo "==== pane @ $1 ====" >> "$PANE_DUMP"
  pane | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' >> "$PANE_DUMP"
  echo >> "$PANE_DUMP"
}

# Boot claude — fresh pty, no pipes.
T new-session -d -s "$SESSION" -x 220 -y 60 -c "$PROJECT_DIR" \
  "claude --dangerously-load-development-channels server:mattermost --permission-mode bypassPermissions --model haiku"
sleep 3
if ! T has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session died immediately" >&2; exit 1
fi
dump 'after-launch'

# Workspace trust dialog appears first on a fresh project dir.
echo ">> waiting for workspace-trust dialog …"
ok=0
for i in $(seq 1 30); do
  if pane | grep -q 'Yes, I trust this folder'; then ok=1; break; fi
  if pane | grep -q 'I am using this for local development'; then
    # Already past trust (e.g. on a re-run with cached trust)
    ok=2; break
  fi
  sleep 1
done
dump 'pre-trust'
if [ "$ok" = 1 ]; then
  T send-keys -t "$SESSION" Enter
  sleep 3
  echo "   trusted folder"
elif [ "$ok" = 2 ]; then
  echo "   trust already established"
else
  echo "no trust/dev-channels dialog appeared" >&2
  pane | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' | tail -n 60 >&2
  exit 1
fi

echo ">> waiting for dev-channels confirmation prompt …"
ok=0
for i in $(seq 1 30); do
  if pane | grep -q 'I am using this for local development'; then ok=1; break; fi
  sleep 1
done
dump 'before-devchannels-confirm'
if [ "$ok" -ne 1 ]; then
  echo "dev-channels prompt never appeared" >&2
  pane | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' | tail -n 60 >&2
  exit 1
fi
T send-keys -t "$SESSION" Enter
sleep 4
dump 'after-devchannels-confirm'
echo "   confirmed dev channels"

# Wait for claude's input prompt area. The example text rotates each run
# (Try "refactor <filepath>", Try "how do I…", etc) so match the stable
# footer ("bypass permissions on") and the channel-listening line.
echo ">> waiting for input prompt to be ready …"
ok=0
for i in $(seq 1 60); do
  p=$(pane)
  if echo "$p" | grep -q 'bypass permissions on' && \
     echo "$p" | grep -q 'Listening for channel messages from: server:mattermost'; then
    ok=1; break
  fi
  sleep 1
done
dump 'prompt-ready'
if [ "$ok" -ne 1 ]; then
  echo "claude input prompt never appeared" >&2
  pane | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' | tail -n 80 >&2
  exit 1
fi
echo "   prompt ready (after ${i}s)"

# Wait some more so the channel server has time to authenticate over WS.
sleep 6

# Send the bridging instruction.
PROMPT='When a <channel source="mattermost"> tag arrives, immediately call mcp__mattermost__reply with channel_id from the tag and message="ack: <body verbatim>". Acknowledge briefly.'
echo ">> typing setup prompt"
T send-keys -t "$SESSION" "$PROMPT"
sleep 1
T send-keys -t "$SESSION" Enter
sleep 8
dump 'after-setup'

echo ">> posting Mattermost message ($TAG)"
curl -sS -X POST \
  -H "Authorization: Bearer $TEST_USER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "$(jq -nc --arg c "$TEST_CHANNEL_ID" --arg m "$TAG" '{channel_id:$c, message:$m}')" \
  "$MATTERMOST_URL/api/v4/posts" >/dev/null

echo ">> waiting for channel server to forward …"
for i in $(seq 1 20); do
  grep -q "forwarding to claude.*$TAG" "$DBG_LOG" 2>/dev/null && break
  sleep 1
done
dump 'after-mm-post'
if grep -q "forwarding to claude.*$TAG" "$DBG_LOG" 2>/dev/null; then
  echo "   server forwarded notification ✓"
else
  echo "   server did NOT forward" >&2
  echo "   — channel server log:"
  cat "$DBG_LOG" >&2 || true
  echo "   — pane:"
  pane | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' | tail -n 60 >&2
  exit 1
fi

# Wait up to 90s for the bot's ack post in Mattermost.
echo ">> waiting up to 90s for bot ack in Mattermost"
ack_ok=0
for i in $(seq 1 90); do
  POSTS=$(curl -sS -H "Authorization: Bearer $TEST_USER_TOKEN" \
    "$MATTERMOST_URL/api/v4/channels/$TEST_CHANNEL_ID/posts?per_page=20")
  if echo "$POSTS" | jq -e --arg t "$TAG" --arg bot "$TEST_BOT_ID" '
    .posts | to_entries | map(.value)
    | map(select(.user_id == $bot and (.message | test("ack:.*" + $t))))
    | length >= 1
  ' >/dev/null; then
    echo "   ✓ bot reply observed (after ${i}s)"
    ack_ok=1
    break
  fi
  sleep 1
done
dump 'final'

# Politely close claude.
T send-keys -t "$SESSION" '/exit' Enter
sleep 2

echo
if [ "$ack_ok" -eq 1 ]; then
  printf '\033[32m✓ interactive claude received the channel tag and replied via the tool\033[0m\n'
  echo "$POSTS" | jq --arg t "$TAG" --arg bot "$TEST_BOT_ID" '
    .posts | to_entries | map(.value)
    | map(select(.user_id == $bot and (.message | test("ack:.*" + $t))))
    | .[0] | {message, create_at}'
  exit 0
else
  printf '\033[31m✗ no bot reply within 90s\033[0m\n' >&2
  echo
  echo "==== final pane (ANSI stripped) ====" >&2
  pane | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' | tail -n 100 >&2
  echo
  echo "==== pane history saved to: $PANE_DUMP" >&2
  cp "$PANE_DUMP" "/tmp/claude-tmux-pane-$$.log"
  echo "(also copied to /tmp/claude-tmux-pane-$$.log)" >&2
  exit 1
fi
