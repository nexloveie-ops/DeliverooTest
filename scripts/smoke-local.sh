#!/usr/bin/env bash
# Run while `npm run dev` is up. Fails fast if upload does not return ok:true.
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8090}"
MENU_ID="${MENU_ID:-test-menu-local}"
SITE_DRN_ID="${SITE_DRN_ID:-}"
SCENARIO="${SCENARIO:-mealtimes}"

if [ "$SCENARIO" = "webhook" ] && [ -z "${MENU_ID_SET:-}" ]; then
  MENU_ID="test-webhook-$(date +%s)"
  export MENU_ID
  echo "==> generated MENU_ID for Scenario 6: ${MENU_ID}"
fi

echo "==> healthz"
curl -fsS "${BASE_URL}/healthz" | grep -q '"ok":true'

BODY=$(printf '{"menuId":"%s","scenario":"%s"' "$MENU_ID" "$SCENARIO")
if [ -n "$SITE_DRN_ID" ]; then
  BODY+=$(printf ',"site_drn_id":"%s"' "$SITE_DRN_ID")
fi
BODY+="}"

if [ "$SCENARIO" = "nochange" ]; then
  echo "==> menu upload nochange double (${MENU_ID})"
  DOUBLE_BODY=$(printf '{"menuId":"%s","scenario":"nochange","double":true' "$MENU_ID")
  if [ -n "$SITE_DRN_ID" ]; then
    DOUBLE_BODY+=$(printf ',"site_drn_id":"%s"' "$SITE_DRN_ID")
  fi
  DOUBLE_BODY+="}"
  RESP=$(curl -fsS -X POST "${BASE_URL}/deliveroo/menu/upload" \
    -H "Content-Type: application/json" \
    --data "$DOUBLE_BODY")
else
  echo "==> menu upload (${MENU_ID})"
  RESP=$(curl -fsS -X POST "${BASE_URL}/deliveroo/menu/upload" \
    -H "Content-Type: application/json" \
    --data "$BODY")
fi

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

if [ "$SCENARIO" = "bundles" ]; then
  echo "$RESP" | grep -q '"bundlesCount":2' || {
    echo "FAIL: bundles scenario should include 2 bundles"
    echo "$RESP"
    exit 1
  }
fi

if [ "$SCENARIO" = "webhook" ]; then
  echo "$RESP" | grep -q '"matchExistingMenu":false' || {
    echo "FAIL: webhook scenario must not return MATCH_EXISTING_MENU (use a new menu_id)"
    echo "$RESP"
    exit 1
  }
  echo "==> webhook-status poll (up to 90s; needs Deliveroo → your public webhook URL)"
  RECEIVED=false
  for _ in $(seq 1 18); do
    STATUS=$(curl -fsS "${BASE_URL}/deliveroo/menu/webhook-status?menuId=${MENU_ID}" || echo '{}')
    if echo "$STATUS" | grep -q '"received":true'; then
      RECEIVED=true
      echo "OK: menu.upload_result webhook received"
      echo "$STATUS"
      break
    fi
    sleep 5
  done
  if [ "$RECEIVED" != "true" ]; then
    echo "WARN: no webhook yet (expected on localhost unless tunnel/Cloud Run URL is configured in Portal)"
  fi
fi

if [ "$SCENARIO" = "nochange" ]; then
  echo "$RESP" | grep -q '"doubleUpload":true' || {
    echo "FAIL: nochange smoke expects doubleUpload:true"
    echo "$RESP"
    exit 1
  }
  if echo "$RESP" | grep -q '"matchExistingMenu":true'; then
    echo "OK: second PUT returned MATCH_EXISTING_MENU"
  else
    echo "WARN: second PUT did not report MATCH_EXISTING_MENU yet (sandbox may return empty body)."
  fi
fi

echo "PASS: local smoke test"
echo "$RESP"
