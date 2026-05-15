#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

BASE_URL="${BASE_URL:-http://${HOST:-127.0.0.1}:${PORT:-8787}}"

TOKEN="${ASSISTANT_TOKEN:-${ASSISTANT_PASSWORD:-}}"
if [[ -z "$TOKEN" ]]; then
  echo "FAIL: ASSISTANT_TOKEN or ASSISTANT_PASSWORD is required" >&2
  exit 1
fi

post_chat() {
  local message="$1"
  curl -fsS \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$(node -e 'process.stdout.write(JSON.stringify({message: process.argv[1]}))' "$message")" \
    "$BASE_URL/api/chat"
}

expect_contains() {
  local name="$1"
  local output="$2"
  local needle="$3"
  if [[ "$output" == *"$needle"* ]]; then
    echo "PASS: $name"
  else
    echo "FAIL: $name" >&2
    echo "Expected output to contain: $needle" >&2
    echo "Actual: $output" >&2
    exit 1
  fi
}

echo "Checking health at $BASE_URL"
health="$(curl -fsS "$BASE_URL/health")"
expect_contains "health reports ok" "$health" '"ok":true'
expect_contains "auth configured" "$health" '"authConfigured":true'

hello="$(post_chat 'hello')"
expect_contains 'hello responds via chat path' "$hello" '"type":"result"'
expect_contains 'hello has reply' "$hello" '"reply"'

what="$(post_chat 'what can you do?')"
expect_contains 'general chat responds via Flue/fallback path' "$what" '"type":"result"'
expect_contains 'general chat has reply' "$what" '"reply"'

health_check="$(post_chat 'check assistant health')"
expect_contains 'local health inspection responds' "$health_check" '"type":"result"'
expect_contains 'local health inspection has reply' "$health_check" '"reply"'

approval="$(post_chat 'edit server.ts')"
expect_contains 'risky edit creates approval' "$approval" '"type":"approval"'
expect_contains 'approval has id' "$approval" '"approval"'

cat <<'EOF'
PASS: manual API checks complete

Manual iPhone Safari check:
1. Open the Tailscale URL/IP for the assistant.
2. Log in with ASSISTANT_TOKEN.
3. Send: hello
4. Send: what can you do?
5. Send: check assistant health
6. Send: edit server.ts
Expected: simple chat bubbles only; the edit request says approval is needed.
EOF
