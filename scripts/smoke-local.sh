#!/usr/bin/env bash
# Run while `npm run dev` is up. Fails fast if upload does not return ok:true.
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8090}"
MENU_ID="${MENU_ID:-test-menu-local}"
SITE_DRN_ID="${SITE_DRN_ID:-}"
SCENARIO="${SCENARIO:-mealtimes}"

echo "==> healthz"
curl -fsS "${BASE_URL}/healthz" | grep -q '"ok":true'

BODY=$(printf '{"menuId":"%s","scenario":"%s"' "$MENU_ID" "$SCENARIO")
if [ -n "$SITE_DRN_ID" ]; then
  BODY+=$(printf ',"site_drn_id":"%s"' "$SITE_DRN_ID")
fi
BODY+="}"

if [ "$SCENARIO" = "nochange" ]; then
  echo "==> seed menu (mealtimes) for MATCH_EXISTING_MENU"
  SEED_BODY=$(printf '{"menuId":"%s","scenario":"mealtimes"' "$MENU_ID")
  if [ -n "$SITE_DRN_ID" ]; then
    SEED_BODY+=$(printf ',"site_drn_id":"%s"' "$SITE_DRN_ID")
  fi
  SEED_BODY+="}"
  curl -fsS -X POST "${BASE_URL}/deliveroo/menu/upload" \
    -H "Content-Type: application/json" \
    --data "$SEED_BODY" >/dev/null

  echo "==> menu upload nochange (${MENU_ID})"
  RESP=$(curl -fsS -X POST "${BASE_URL}/deliveroo/menu/upload" \
    -H "Content-Type: application/json" \
    --data "$BODY")
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

if [ "$SCENARIO" = "nochange" ]; then
  if echo "$RESP" | grep -q '"matchExistingMenu":true'; then
    echo "OK: Deliveroo returned MATCH_EXISTING_MENU"
  else
    echo "WARN: sandbox returned empty body (no result yet). Portal Scenario 5 still needs"
    echo "      matchExistingMenu:true — use a menu_id already live from Scenario 3 (mealtimes),"
    echo "      not overwritten by bundles. Re-run nochange after menu is published."
  fi
fi

echo "PASS: local smoke test"
echo "$RESP"
