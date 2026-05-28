# Deliveroo Test Connector

Lightweight **Partner Platform** connector for sandbox testing: Menu API v1 upload, menu sync, and webhooks (orders + menu upload results).

Does **not** implement inventory/BOM/reporting (that belongs in your own system).

## Architecture (per Deliveroo docs)

| Step | What | Doc |
|------|------|-----|
| 1 | OAuth `client_credentials` → access token | [Authentication](https://api-docs.deliveroo.com/docs/authentication) |
| 2 | `PUT /menu/v1/brands/{brand_id}/menus/{menu_id}` with `name`, `site_ids`, `menu` | [Upload menu](https://api-docs.deliveroo.com/reference/put_v1-brands-brand-id-menus-id) |
| 3 | Deliveroo processes menu asynchronously | [Menu API Overview](https://api-docs.deliveroo.com/docs/menu-api-overview) |
| 4 | `menu.upload_result` webhook to your HTTPS endpoint | [Menu Webhook](https://api-docs.deliveroo.com/reference/menu-events-webhook) |
| 5 | Developer Portal **scenarios** verify API Suite calls in the scenario window | [Credential Types](https://api-docs.deliveroo.com/reference/credentials) |

**Sandbox hosts** ([API and Webhooks](https://api-docs.deliveroo.com/docs/api-and-webhooks)):

- API: `https://api-sandbox.developers.deliveroo.com`
- OAuth: `https://auth-sandbox.developers.deliveroo.com`

Use **API Suite** sandbox credentials in Cloud Run — not “Credentials for Scenarios API” only.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/healthz` | Health check |
| POST | `/deliveroo/menu/sync` | `GET` menu v2 by site, normalize items |
| GET/POST | `/deliveroo/menu/upload` | `PUT` menu v1 (scenario helper) |
| GET | `/deliveroo/menu/webhook-status` | Poll received `menu.upload_result` for a `menuId` |
| GET | `/deliveroo/menu/item-unavailabilities` | Get current item unavailabilities (v2, by site) |
| POST | `/deliveroo/menu/item-unavailabilities` | Update individual item unavailabilities (v2 POST) |
| POST | `/deliveroo/menu/scenario8` | Scenario 8: run step `1`, `2`, or `both` (default `both`) |
| PUT | `/deliveroo/menu/item-unavailabilities` | Replace all unavailabilities (v1 PUT; requires `menuId`) |
| POST | `/deliveroo/menu/scenario9` | Scenario 9: GET then PUT replace-all (`step=get`, `put`, or `both`) |
| POST | `/deliveroo/menu/scenario10` | Scenario 10: GET then PUT reset stock (`step=get`, `put`, or `both`) |
| POST | `/deliveroo/menu/scenario11` | Scenario 11: POST initial unavailabilities (`step=post`, default) |
| POST | `/deliveroo/menu/scenario12` | Scenario 12: POST whole_milk unavailable after Start (`step=post`) |
| POST | `/deliveroo/menu/scenario13` | Scenario 13: upload ≥100 items, wait webhook, POST unavailabilities (`step=all`) |
| PUT/POST | `/deliveroo/menu/scenario14` | Scenario 14: Menu V3 **Generate S3 upload URL** only (`PUT .../menu/v3/brands/{brand}/menus/{id}`) |
| POST | `/deliveroo/menu/scenario15` | Scenario 15: Menu V3 async upload (S3 + publish job + `menu.upload_result` webhook) |
| GET/POST | `/deliveroo/menu/scenario16` | Scenario 16: Menu V3 **GET job status** (`.../brands/{brand}/jobs/{job_id}`) |
| GET/POST | `/deliveroo/menu/scenario17` | Scenario 17: Menu V3 **GET menu** (`.../brands/{brand}/menus/{menu_id}`) |
| POST | `/webhooks/deliveroo` | Order events + `menu.upload_result` |

### Menu upload (`/deliveroo/menu/upload`)

Calls official v1 endpoint:

`PUT {DELIVEROO_BASE_URL}/menu/v1/brands/{brandId}/menus/{menuId}`

Query/body parameters:

- `menuId` / `menu_id` — **must match** the ID entered in the Developer Portal scenario
- `scenario` — `mealtimes` (default), `bundles` (4), `nochange` (5), `webhook` (6), `imagecache` (7), `scenario13` (13), or `default`
- `uploadApi` — for `scenario13`: `v3` (default, [Menu V3 large upload](https://api-docs.deliveroo.com/docs/menu-api-overview)) or `v1` (direct PUT)
- `pollV3Job` — set `false` to skip job status polling after V3 publish (webhook still required for Portal)
- `siteId` / `site_id` — optional (defaults to `DELIVEROO_LOCATION_ID`, e.g. `100121`)
- `siteDrnId` / `site_drn_id` — optional scenario parameter; resolved to `site_id` when possible

Response includes audit block `put`: `{ method, url, brandId, siteId, menuId, siteIds, scenario, mealtimesCount, bundlesCount }`.

| `scenario` | Portal test | Payload highlights |
|------------|-------------|-------------------|
| `mealtimes` | Menu upload with mealtimes | 2 mealtimes, 7×24h schedules |
| `bundles` | Menu upload with bundles | 2× `BUNDLE`, `bundle-item` modifiers, price overrides, `party_size` — per [Menu API Guidelines](https://api-docs.deliveroo.com/docs/menu-api-guidelines) |
| `nochange` | Update menu with no changes (Scenario 5) | **GET menu → PUT the same canonical JSON twice** (`double: true`). Template JSON ≠ stored menu and fails Portal comparison — [Menu API Overview](https://api-docs.deliveroo.com/docs/menu-api-overview) |
| `webhook` | Menu upload + `menu.upload_result` webhook (Scenario 6) | **Existing menu:** GET → mutate in place (differs, avoids template replace). **New menu:** mealtimes-lite template. Portal needs async `httpStatus` **200** on webhook (500 = menu processing failed). **Start** → upload within **30s** |
| `imagecache` | Image caching headers (Scenario 7) | Upload includes ITEM image URL (`https://placehold.co/640x480.jpg`) where `HEAD` returns `ETag`; suitable for Deliveroo cache-header validation |

Complete **Scenario 3** on the same `menu_id` first so GET returns a menu. `matchExistingMenu` on the second PUT should be `true`.

**Scenario 8:** Portal **Start** auto-creates a menu for the **menu_id you enter** with `orange_juice`, `granola`, `whole_milk`. Uses **v1** `POST .../menus/{menu_id}/item_unavailabilities/{site_id}` (Portal usually validates this path, not v2-only).

1. **Step 1** — mark `orange_juice` and `granola` unavailable  
2. **Step 2** — mark `orange_juice` available and `whole_milk` unavailable (wait **≥1s** after step 1 — rate limit ~1 req / 833ms)

`menuId` in curl **must match** Portal Scenario 8 `menu_id`.

```bash
# After Portal Start (within ~30s):
curl -X POST "https://<cloud-run-url>/deliveroo/menu/scenario8?step=1" \
  -H "Content-Type: application/json" \
  -d '{"menuId":"<portal-menu-id>","site_drn_id":"607326a3-ef2d-4b8b-b013-a91c52c3954f"}'

sleep 1

curl -X POST "https://<cloud-run-url>/deliveroo/menu/scenario8?step=2" \
  -H "Content-Type: application/json" \
  -d '{"menuId":"<portal-menu-id>","site_drn_id":"607326a3-ef2d-4b8b-b013-a91c52c3954f"}'
```

If stuck on **validating** with no error: confirm both POSTs used the same `menuId` as Portal, happened after **Start**, and check API Suite request logs in the Portal.

**Scenario 9:** Portal **Start** creates menu + simulates tablet stock (`orange_juice` unavailable, `granola` hidden). Then **GET** → **PUT** with same payload plus `whole_milk` in `unavailable_ids`. Requires **`menuId`** (v1).

```bash
# After Portal Start:
curl -X POST "https://<cloud-run-url>/deliveroo/menu/scenario9?step=get" \
  -H "Content-Type: application/json" \
  -d '{"menuId":"<portal-menu-id>","site_drn_id":"607326a3-ef2d-4b8b-b013-a91c52c3954f"}'

sleep 1

curl -X POST "https://<cloud-run-url>/deliveroo/menu/scenario9?step=put" \
  -H "Content-Type: application/json" \
  -d '{"menuId":"<portal-menu-id>","site_drn_id":"607326a3-ef2d-4b8b-b013-a91c52c3954f"}'
```

**Scenario 10:** Portal **Start** creates menu, sets `orange_juice` unavailable and `granola` hidden. Then **PUT** with **empty** `unavailable_ids` (and `hidden_ids`) to reset all items to **available**. Requires **`menuId`** (v1).

```bash
# After Portal Start:
curl -X POST "https://<cloud-run-url>/deliveroo/menu/scenario10?step=get" \
  -H "Content-Type: application/json" \
  -d '{"menuId":"<portal-menu-id>","site_drn_id":"607326a3-ef2d-4b8b-b013-a91c52c3954f"}'

sleep 1

curl -X POST "https://<cloud-run-url>/deliveroo/menu/scenario10?step=put" \
  -H "Content-Type: application/json" \
  -d '{"menuId":"<portal-menu-id>","site_drn_id":"607326a3-ef2d-4b8b-b013-a91c52c3954f"}'
```

PUT body sent: `{"unavailable_ids":[],"hidden_ids":[]}`.

**Scenario 11:** Portal **Start** → **POST** initial stock (treated as before midnight). Payload: `granola` **unavailable**, `orange_juice` **hidden**. Portal simulates **morning stock reset** on site open → `granola` and `whole_milk` become **available**; `orange_juice` stays **hidden**.

```bash
# After Portal Start (within ~30s) — required:
curl -X POST "https://<cloud-run-url>/deliveroo/menu/scenario11?step=post" \
  -H "Content-Type: application/json" \
  -d '{"menuId":"<portal-menu-id>","site_drn_id":"607326a3-ef2d-4b8b-b013-a91c52c3954f"}'

# Optional: after Portal finishes morning-reset simulation:
curl -X POST "https://<cloud-run-url>/deliveroo/menu/scenario11?step=get" \
  -H "Content-Type: application/json" \
  -d '{"menuId":"<portal-menu-id>","site_drn_id":"607326a3-ef2d-4b8b-b013-a91c52c3954f"}'
```

**Scenario 12:** Portal **Start** → system marks `orange_juice` unavailable. You **POST** `whole_milk` unavailable (treated as **after midnight**). Morning stock reset is **skipped**; when site opens, stock stays: `orange_juice` + `whole_milk` unavailable, `granola` available.

```bash
curl -X POST "https://<cloud-run-url>/deliveroo/menu/scenario12?step=post" \
  -H "Content-Type: application/json" \
  -d '{"menuId":"<portal-menu-id>","site_drn_id":"607326a3-ef2d-4b8b-b013-a91c52c3954f"}'
```

**Scenario 14 ([MENU V3 APIs]):** Portal validates **only** the presigned S3 URL step. **Start** → within ~30s call **PUT** (or POST) with the **same `menu_id`** you enter in the Portal (reuse for later V3 scenarios).

```bash
curl -X PUT "https://<cloud-run-url>/deliveroo/menu/scenario14" \
  -H "Content-Type: application/json" \
  -d '{"menuId":"<portal-menu-id>","site_drn_id":"607326a3-ef2d-4b8b-b013-a91c52c3954f"}'
```

Success: `ok: true`, `uploadUrl` (presigned S3 URL), `version`, `url` = Deliveroo PUT endpoint called.

Official endpoint: `PUT {DELIVEROO_BASE_URL}/menu/v3/brands/{brand_id}/menus/{menu_id}` ([Generate S3 URL](https://api-docs.deliveroo.com/reference/put_v3-brands-brand-id-menus-id)).

**Scenario 15 ([MENU V3 APIs]):** After Scenario 14, Portal checks the **full async** path: upload JSON to the presigned S3 URL (expires in **~5 seconds** — our handler does presign → S3 → publish in one request), then trigger processing via **POST** `.../menu/v3/brands/{brand_id}/jobs` (`publish_menu_to_live`; Portal labels this “PUT Menu Async”). Success = **`menu.upload_result`** webhook with **`http_status: 200`**.

Configure **Menu Events** webhook to `POST /webhooks/deliveroo` first. Use the **same `menu_id`** as Scenario 14.

```bash
# After Portal Start (within ~30s) — presign, S3, publish job, wait webhook up to 90s:
curl -X POST "https://<cloud-run-url>/deliveroo/menu/scenario15" \
  -H "Content-Type: application/json" \
  -d '{"menuId":"<portal-menu-id>","site_drn_id":"607326a3-ef2d-4b8b-b013-a91c52c3954f"}'

# Split steps (multi-instance Cloud Run):
curl -X POST ".../deliveroo/menu/scenario15?step=upload" -H "Content-Type: application/json" -d '{"menuId":"<id>","site_drn_id":"607326a3-ef2d-4b8b-b013-a91c52c3954f"}'
curl -X POST ".../deliveroo/menu/scenario15?step=wait" -H "Content-Type: application/json" -d '{"menuId":"<id>"}'
```

Payload includes 1 mealtime (cover + name + description), 1 category (name), 1 item (id, name, operational_name, PLU, description, linked via `category.item_ids`).

**Scenario 16 ([MENU V3 APIs]):** After Scenario 15 (or any V3 publish job), Portal checks **GET job status** with `brand_id` + `job_id`. Use `jobId` from Scenario 15 response (`upload.jobId`).

```bash
# job_id from Scenario 15 upload (example):
curl "https://<cloud-run-url>/deliveroo/menu/scenario16?jobId=8b7f99c9-12bc-40f1-a940-da5e9d1522f4&site_drn_id=607326a3-ef2d-4b8b-b013-a91c52c3954f"

curl -X POST "https://<cloud-run-url>/deliveroo/menu/scenario16" \
  -H "Content-Type: application/json" \
  -d '{"jobId":"<job-id>","site_drn_id":"607326a3-ef2d-4b8b-b013-a91c52c3954f"}'
```

Official endpoint: `GET {DELIVEROO_BASE_URL}/menu/v3/brands/{brand_id}/jobs/{job_id}` ([Fetch Job Status](https://api-docs.deliveroo.com/reference/get_v3-brands-brand-id-jobs-job-id)).

**Scenario 17 ([MENU V3 APIs]):** Portal checks **GET menu** with `brand_id` + `menu_id` (same `menu_id` as Scenarios 14–15). Returns menu metadata including S3 download URL and version.

```bash
curl "https://<cloud-run-url>/deliveroo/menu/scenario17?menuId=<portal-menu-id>&site_drn_id=607326a3-ef2d-4b8b-b013-a91c52c3954f"
```

Official endpoint: `GET {DELIVEROO_BASE_URL}/menu/v3/brands/{brand_id}/menus/{menu_id}` ([Fetch Menu](https://api-docs.deliveroo.com/reference/get_v3-brands-brand-id-menus-id)).

**Scenario 13:** Do **not** send unavailabilities until **`menu.upload_result`** webhook arrives (unless upload returned `MATCH_EXISTING_MENU`). Flow: **Start** → upload menu with **≥100 items** → wait for webhook (~1 min) → **POST** item unavailabilities.

By default Scenario 13 uses **Menu V3** (presigned S3 → publish job → same `menu.upload_result` webhook) and a **clean template** payload (`bodySource: template`). Use `?preferGet=true` only if you must extend the Portal GET menu; `?uploadApi=v1` forces legacy v1 PUT.

```bash
# All-in-one (blocks up to 90s waiting for webhook on this Cloud Run instance):
curl -X POST "https://<cloud-run-url>/deliveroo/menu/scenario13?step=all" \
  -H "Content-Type: application/json" \
  -d '{"menuId":"<portal-menu-id>","site_drn_id":"607326a3-ef2d-4b8b-b013-a91c52c3954f"}'

# Or split (recommended on multi-instance Cloud Run):
curl -X POST "https://<cloud-run-url>/deliveroo/menu/upload?scenario=scenario13" \
  -H "Content-Type: application/json" \
  -d '{"menuId":"<portal-menu-id>","site_drn_id":"607326a3-ef2d-4b8b-b013-a91c52c3954f"}'
curl "https://<cloud-run-url>/deliveroo/menu/webhook-status?menuId=<portal-menu-id>"
curl -X POST "https://<cloud-run-url>/deliveroo/menu/scenario13?step=post" \
  -H "Content-Type: application/json" \
  -d '{"menuId":"<portal-menu-id>","site_drn_id":"607326a3-ef2d-4b8b-b013-a91c52c3954f"}'
```

POST sets `s13-item-001` to **unavailable** after webhook.

**Scenario 13 troubleshooting:** Portal needs webhook `http_status` **200** (`400` = invalid menu, `500` = other processing error per [Menu Webhook](https://api-docs.deliveroo.com/reference/menu-events-webhook)). Payload: V3 + template, `currency_code: EUR`, `is_pos_integrated: false`, default mealtime (`schedule: []`), stable Wikimedia JPEG cover (not placehold.co), no per-item images. Use a **fresh** `menu_id` after Start; `put.uploadPath` should be `"v3"`.

**Scenario 6:** Portal `menu_id` can stay **`123156468`**. Flow: **Start** → within **30s** upload with `scenario=webhook` → wait **1–5 min** for Deliveroo `POST` to `/webhooks/deliveroo` (must return **200**).

Troubleshooting:

- `GET /deliveroo/menu/webhook-inbound` — recent Deliveroo `POST` attempts on this instance (status, HMAC, errors)
- Cloud Run logs: search `deliveroo.webhook.inbound` (not browser `GET` to the webhook URL)
- If `invalid menu webhook signature`: clear **`DELIVEROO_WEBHOOK_SECRET`** on Cloud Run or set it to the exact Portal webhook secret
- `webhook-status` is in-memory; use logs if multi-instance or after cold start

### Webhooks (`/webhooks/deliveroo`)

Configure in Developer Portal:

- **Order events** → same URL
- **Menu events** → same URL

`GET /webhooks/deliveroo` returns `200` (URL reachability only). **Deliveroo sends `POST`** with `menu.upload_result` after async menu processing — opening the URL in a browser is not a webhook delivery.

HMAC verification ([Securing Webhooks](https://api-docs.deliveroo.com/docs/securing-webhooks)):

- Headers: `X-Deliveroo-Sequence-Guid`, `X-Deliveroo-Hmac-Sha256`
- Signed payload: `sequenceGuid + " " + rawBody` (raw bytes, no JSON re-serialization)
- Set `DELIVEROO_WEBHOOK_SECRET` when Deliveroo provides a secret; leave empty to skip verification in test

Menu callbacks:

- `x-deliveroo-payload-type: webhook_menu`
- `event: menu.upload_result`
- Normalized and optionally forwarded as `kind: menu_event`

## Environment variables

Copy `.env.example` → `.env`:

| Variable | Required | Notes |
|----------|----------|-------|
| `DELIVEROO_CLIENT_ID` | Yes | API Suite sandbox |
| `DELIVEROO_CLIENT_SECRET` | Yes | API Suite sandbox |
| `DELIVEROO_BASE_URL` | Default sandbox API host | |
| `DELIVEROO_AUTH_BASE_URL` | Default sandbox OAuth host | |
| `DELIVEROO_LOCATION_ID` | Default `100121` | Maps to `site_ids` in PUT |
| `DELIVEROO_WEBHOOK_SECRET` | Optional | Menu + order webhook HMAC |
| `DELIVEROO_BRAND_ID` | Optional | Auto from location |
| `FORWARD_TARGET_URL` | Optional | Your core system |

## Local workflow (always do this before push)

**Terminal 1:**

```bash
npm install
cp .env.example .env   # fill client id/secret
npm run dev
```

**Terminal 2:**

```bash
npm run verify:webhook   # required before push/deploy for Scenario 6
npm run smoke:local

# Scenario 3 (mealtimes):
MENU_ID=123156468 SITE_DRN_ID=607326a3-ef2d-4b8b-b013-a91c52c3954f SCENARIO=mealtimes npm run smoke:local

# Scenario 4 (bundles):
MENU_ID=your-bundle-menu-id SCENARIO=bundles npm run smoke:local

# Scenario 5 (no change — seeds mealtimes then re-uploads):
MENU_ID=123156468 SCENARIO=nochange npm run smoke:local

# Scenario 6 (webhook — same menu_id as other scenarios):
MENU_ID=123156468 SCENARIO=webhook SITE_DRN_ID=607326a3-ef2d-4b8b-b013-a91c52c3954f npm run smoke:local
```

Must see `PASS` and a `put.url` pointing at `api-sandbox.../menu/v1/brands/.../menus/...`.

## Developer Portal scenarios

1. Fill **menu_id** (and site) → click **Start**
2. Within **~30 seconds**, trigger upload (browser or curl):

```bash
curl -X POST "https://<cloud-run-url>/deliveroo/menu/upload" \
  -H "Content-Type: application/json" \
  -d '{"menuId":"<same as portal>","scenario":"bundles","site_drn_id":"<from scenario parameters>"}'

# Scenario 5 (Start → within ~30s, two identical PUTs in one request):
curl -X POST "https://<cloud-run-url>/deliveroo/menu/upload" \
  -H "Content-Type: application/json" \
  -d '{"menuId":"123156468","scenario":"nochange","double":true,"delayMs":10000,"site_drn_id":"<from scenario parameters>"}'
```

If Scenario 5 failed with “second payload differs”: the connector was sending builder JSON while Deliveroo compares **canonical GET menu** bodies. Run Scenario 3 (`mealtimes`) on that `menu_id`, then Scenario 5 with **one** `double:true` call after Start.

```bash
# Scenario 6 (menu_id 123156468 in Portal):
curl -X POST "https://<cloud-run-url>/deliveroo/menu/upload" \
  -H "Content-Type: application/json" \
  -d '{"menuId":"123156468","scenario":"webhook","site_drn_id":"607326a3-ef2d-4b8b-b013-a91c52c3954f"}'

curl "https://<cloud-run-url>/deliveroo/menu/webhook-status?menuId=123156468"
```

Or browser:

`https://<cloud-run-url>/deliveroo/menu/upload?menuId=<id>&site_drn_id=<drn>`

3. Wait for scenario to finish; check **Menu Upload Status**
4. Optional: confirm `menu.upload_result` in Cloud Run logs after async processing

`Upload menu (PUT) endpoint was not called` means **no valid v1 PUT was recorded for that scenario run** — usually wrong timing, wrong credentials, or PUT returned 4xx.

## Deploy (Cloud Run + GitHub Actions)

See `.github/workflows/deploy-cloud-run.yml`.

After deploy, set the same env vars on the Cloud Run service as in `.env`.

## References

- [Menu API Overview](https://api-docs.deliveroo.com/docs/menu-api-overview)
- [Upload menu PUT](https://api-docs.deliveroo.com/reference/put_v1-brands-brand-id-menus-id)
- [Securing Webhooks](https://api-docs.deliveroo.com/docs/securing-webhooks)
- [Credential Types](https://api-docs.deliveroo.com/reference/credentials)
