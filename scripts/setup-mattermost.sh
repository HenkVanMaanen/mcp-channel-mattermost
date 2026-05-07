#!/usr/bin/env bash
# Bootstraps a fresh Mattermost instance for local development:
#   - creates a sysadmin (first user is auto-promoted)
#   - creates a team
#   - creates a bot account + personal access token
#   - creates a regular test user
#   - adds both to the team and a test channel
#   - writes .env.local with everything the channel server needs
#
# Idempotent: safe to re-run; it skips work that's already done.

set -euo pipefail

URL="${MATTERMOST_URL:-http://localhost:8065}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASS="${ADMIN_PASS:-admin12345}"
TEAM_NAME="${TEAM_NAME:-test}"
TEAM_DISPLAY="${TEAM_DISPLAY:-Test Team}"
BOT_USER="${BOT_USER:-claude}"
BOT_DISPLAY="${BOT_DISPLAY:-Claude}"
TEST_USER="${TEST_USER:-alice}"
TEST_EMAIL="${TEST_EMAIL:-alice@example.com}"
TEST_PASS="${TEST_PASS:-alice12345}"
TEST_CHANNEL="${TEST_CHANNEL:-ops-alerts}"
MENTIONS_CHANNEL="${MENTIONS_CHANNEL:-mentions-only}"

api() {
  local method="$1" path="$2" body="${3:-}" auth="${4:-}"
  local args=(-sS -X "$method" -H 'Content-Type: application/json')
  [ -n "$auth" ] && args+=(-H "Authorization: Bearer $auth")
  [ -n "$body" ] && args+=(--data "$body")
  curl "${args[@]}" "$URL/api/v4$path"
}

note() { printf '\033[36m> %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m  %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  %s\033[0m\n' "$*"; }

note "Waiting for $URL …"
until curl -sf "$URL/api/v4/system/ping" >/dev/null; do sleep 1; done

# Returns the Token header from a /users/login response, or empty string.
login_token() {
  local user="$1" pass="$2"
  curl -sS -D - -o /dev/null -X POST -H 'Content-Type: application/json' \
    --data "$(jq -nc --arg u "$user" --arg p "$pass" '{login_id:$u, password:$p}')" \
    "$URL/api/v4/users/login" \
    | awk 'BEGIN{IGNORECASE=1} /^token:/{print $2}' | tr -d '\r\n'
}

note "Ensuring admin user $ADMIN_USER"
ADMIN_TOKEN=$(login_token "$ADMIN_USER" "$ADMIN_PASS")
if [ -z "$ADMIN_TOKEN" ]; then
  CREATED=$(api POST /users \
    "$(jq -nc --arg u "$ADMIN_USER" --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASS" \
       '{username:$u, email:$e, password:$p}')")
  if ! echo "$CREATED" | jq -e '.username' >/dev/null 2>&1; then
    echo "Failed to create admin: $CREATED" >&2; exit 1
  fi
  ok "created admin"
  ADMIN_TOKEN=$(login_token "$ADMIN_USER" "$ADMIN_PASS")
else
  ok "admin already exists"
fi
if [ -z "$ADMIN_TOKEN" ]; then echo "admin login failed" >&2; exit 1; fi
ok "admin logged in"

note "Ensuring team $TEAM_NAME"
TEAM=$(api GET "/teams/name/$TEAM_NAME" "" "$ADMIN_TOKEN")
if ! echo "$TEAM" | jq -e '.name' >/dev/null 2>&1; then
  TEAM=$(api POST /teams \
    "$(jq -nc --arg n "$TEAM_NAME" --arg d "$TEAM_DISPLAY" '{name:$n, display_name:$d, type:"O"}')" \
    "$ADMIN_TOKEN")
fi
TEAM_ID=$(echo "$TEAM" | jq -r '.id // empty')
if [ -z "$TEAM_ID" ]; then echo "team setup failed: $TEAM" >&2; exit 1; fi
ok "team_id=$TEAM_ID"

note "Ensuring bot $BOT_USER"
BOT=$(api GET "/users/username/$BOT_USER" "" "$ADMIN_TOKEN")
BOT_ID=$(echo "$BOT" | jq -r 'select(.username) | .id // empty')
if [ -z "$BOT_ID" ]; then
  CREATED=$(api POST /bots \
    "$(jq -nc --arg u "$BOT_USER" --arg d "$BOT_DISPLAY" '{username:$u, display_name:$d, description:"Claude Code channel bot"}')" \
    "$ADMIN_TOKEN")
  BOT_ID=$(echo "$CREATED" | jq -r '.user_id // empty')
  if [ -z "$BOT_ID" ]; then echo "bot create failed: $CREATED" >&2; exit 1; fi
fi
ok "bot user_id=$BOT_ID"

note "Adding bot to team"
api POST "/teams/$TEAM_ID/members" \
  "$(jq -nc --arg t "$TEAM_ID" --arg u "$BOT_ID" '{team_id:$t, user_id:$u}')" \
  "$ADMIN_TOKEN" >/dev/null || true

note "Creating bot personal access token"
TOKEN=$(api POST "/users/$BOT_ID/tokens" \
  "$(jq -nc '{description:"channel server"}')" "$ADMIN_TOKEN")
BOT_TOKEN=$(echo "$TOKEN" | jq -r '.token // empty')
if [ -z "$BOT_TOKEN" ]; then echo "token create failed: $TOKEN" >&2; exit 1; fi
ok "got bot token"

note "Ensuring test user $TEST_USER"
USER=$(api GET "/users/username/$TEST_USER" "" "$ADMIN_TOKEN")
USER_ID=$(echo "$USER" | jq -r 'select(.username) | .id // empty')
if [ -z "$USER_ID" ]; then
  CREATED=$(api POST /users \
    "$(jq -nc --arg u "$TEST_USER" --arg e "$TEST_EMAIL" --arg p "$TEST_PASS" \
       '{username:$u, email:$e, password:$p}')" "$ADMIN_TOKEN")
  USER_ID=$(echo "$CREATED" | jq -r '.id // empty')
  if [ -z "$USER_ID" ]; then echo "user create failed: $CREATED" >&2; exit 1; fi
fi
ok "test user user_id=$USER_ID"

note "Adding test user to team"
api POST "/teams/$TEAM_ID/members" \
  "$(jq -nc --arg t "$TEAM_ID" --arg u "$USER_ID" '{team_id:$t, user_id:$u}')" \
  "$ADMIN_TOKEN" >/dev/null || true

note "Ensuring channel $TEST_CHANNEL"
CHAN=$(api GET "/teams/$TEAM_ID/channels/name/$TEST_CHANNEL" "" "$ADMIN_TOKEN")
CHAN_ID=$(echo "$CHAN" | jq -r 'select(.name) | .id // empty')
if [ -z "$CHAN_ID" ]; then
  CREATED=$(api POST /channels \
    "$(jq -nc --arg t "$TEAM_ID" --arg n "$TEST_CHANNEL" \
       '{team_id:$t, name:$n, display_name:"Ops Alerts", type:"O"}')" "$ADMIN_TOKEN")
  CHAN_ID=$(echo "$CREATED" | jq -r '.id // empty')
  if [ -z "$CHAN_ID" ]; then echo "channel create failed: $CREATED" >&2; exit 1; fi
fi
ok "channel_id=$CHAN_ID"

note "Adding bot + test user to $TEST_CHANNEL"
for u in "$BOT_ID" "$USER_ID"; do
  api POST "/channels/$CHAN_ID/members" \
    "$(jq -nc --arg u "$u" '{user_id:$u}')" "$ADMIN_TOKEN" >/dev/null || true
done

note "Ensuring channel $MENTIONS_CHANNEL (not in MATTERMOST_LISTEN_CHANNELS — for mention/thread-tracking tests)"
MCHAN=$(api GET "/teams/$TEAM_ID/channels/name/$MENTIONS_CHANNEL" "" "$ADMIN_TOKEN")
MCHAN_ID=$(echo "$MCHAN" | jq -r 'select(.name) | .id // empty')
if [ -z "$MCHAN_ID" ]; then
  CREATED=$(api POST /channels \
    "$(jq -nc --arg t "$TEAM_ID" --arg n "$MENTIONS_CHANNEL" \
       '{team_id:$t, name:$n, display_name:"Mentions Only", type:"O"}')" "$ADMIN_TOKEN")
  MCHAN_ID=$(echo "$CREATED" | jq -r '.id // empty')
  if [ -z "$MCHAN_ID" ]; then echo "mentions channel create failed: $CREATED" >&2; exit 1; fi
fi
ok "mentions_channel_id=$MCHAN_ID"

for u in "$BOT_ID" "$USER_ID"; do
  api POST "/channels/$MCHAN_ID/members" \
    "$(jq -nc --arg u "$u" '{user_id:$u}')" "$ADMIN_TOKEN" >/dev/null || true
done

note "Login token for test user"
TEST_TOKEN=$(login_token "$TEST_USER" "$TEST_PASS")
if [ -z "$TEST_TOKEN" ]; then echo "test user login failed" >&2; exit 1; fi
ok "test user session token captured"

ENV_PATH="${ENV_PATH:-$(dirname "$0")/../.env.local}"
cat > "$ENV_PATH" <<EOF
# Generated by scripts/setup-mattermost.sh
MATTERMOST_URL=$URL
MATTERMOST_TOKEN=$BOT_TOKEN
MATTERMOST_TEAM=$TEAM_NAME
MATTERMOST_ALLOWED_USERS=$TEST_USER
MATTERMOST_LISTEN_CHANNELS=$TEST_CHANNEL

# For tests only — not used by the channel server itself
TEST_USER_TOKEN=$TEST_TOKEN
TEST_USER_ID=$USER_ID
TEST_BOT_ID=$BOT_ID
TEST_TEAM_ID=$TEAM_ID
TEST_CHANNEL_ID=$CHAN_ID
TEST_BOT_USERNAME=$BOT_USER
TEST_MENTIONS_CHANNEL_ID=$MCHAN_ID
EOF
ok "wrote $ENV_PATH"

cat <<EOF

Done. Web UI:  $URL  (login: $ADMIN_USER / $ADMIN_PASS)

Next:
  npm install
  npm run smoke   # end-to-end test against this Mattermost
EOF
