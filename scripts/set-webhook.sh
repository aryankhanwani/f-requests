#!/usr/bin/env bash
# Point the Telegram bot at a deployment.
#
# Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from .env.local, so the
# secrets never appear in your shell history or in this file.
#
#   ./scripts/set-webhook.sh https://f-requests.vercel.app
#
# Re-run it after any change of deployment URL or webhook secret.
set -euo pipefail

URL="${1:-}"
if [[ -z "$URL" ]]; then
  echo "usage: $0 https://<deployment-host>" >&2
  exit 1
fi
URL="${URL%/}"

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env.local"
[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a

: "${TELEGRAM_BOT_TOKEN:?not set in .env.local}"
: "${TELEGRAM_WEBHOOK_SECRET:?not set in .env.local}"

API="https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN"

echo "==> registering $URL/api/telegram"
curl -sS -X POST "$API/setWebhook" \
  -H 'Content-Type: application/json' \
  --data @- <<JSON | python3 -m json.tool
{
  "url": "$URL/api/telegram",
  "secret_token": "$TELEGRAM_WEBHOOK_SECRET",
  "allowed_updates": ["message"],
  "drop_pending_updates": true
}
JSON

echo "==> verifying"
curl -sS "$API/getWebhookInfo" | python3 -c '
import json, sys
r = json.load(sys.stdin)["result"]
print("  url                 :", r.get("url") or "(none)")
print("  pending updates     :", r.get("pending_update_count"))
print("  custom cert         :", r.get("has_custom_certificate"))
print("  last error          :", r.get("last_error_message") or "none")
print("  max connections     :", r.get("max_connections"))
'
