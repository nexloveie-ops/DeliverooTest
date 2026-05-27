#!/usr/bin/env bash
# Run while `npm run dev` is up. Fails fast if upload does not return ok:true.
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8090}"
MENU_ID="${MENU_ID:-test-menu-local}"
SITE_DRN_ID="${SITE_DRN_ID:-}"

echo "==> healthz"
curl -fsS "${BASE_URL}/healthz" | grep -q '"ok":true'

BODY=$(printf '{"menuId":"%s"' "$MENU_ID")
if [ -n "$SITE_DRN_ID" ]; then
  BODY+=$(printf ',"site_drn_id":"%s"' "$SITE_DRN_ID")
fi
BODY+="}"

echo "==> menu upload (${MENU_ID})"
RESP=$(curl -fsS -X POST "${BASE_URL}/deliveroo/menu/upload" \
  -H "Content-Type: application/json" \
  --data "$BODY")

echo "$RESP" | grep -q '"ok":true' || {
  echo "FAIL: menu upload did not succeed"
  echo "$RESP"
  exit 1
}

echo "$RESP" | grep -q '"method":"PUT"' || {
  echo "FAIL: response missing PUT audit metadata"
  echo "$RESP"
  exit 1
}

echo "PASS: local smoke test"
echo "$RESP"
