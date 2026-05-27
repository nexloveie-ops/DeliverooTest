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
| POST | `/webhooks/deliveroo` | Order events + `menu.upload_result` |

### Menu upload (`/deliveroo/menu/upload`)

Calls official v1 endpoint:

`PUT {DELIVEROO_BASE_URL}/menu/v1/brands/{brandId}/menus/{menuId}`

Query/body parameters:

- `menuId` / `menu_id` — **must match** the ID entered in the Developer Portal scenario
- `siteId` / `site_id` — optional (defaults to `DELIVEROO_LOCATION_ID`, e.g. `100121`)
- `siteDrnId` / `site_drn_id` — optional scenario parameter; resolved to `site_id` when possible

Response includes audit block `put`: `{ method, url, brandId, siteId, menuId, siteIds, mealtimesCount }`.

Default payload includes **2 mealtimes** with cover image, name, description, and non-overlapping schedules covering 7×24h (required by Deliveroo validation).

### Webhooks (`/webhooks/deliveroo`)

Configure in Developer Portal:

- **Order events** → same URL
- **Menu events** → same URL

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
npm run smoke:local

# Match a scenario run exactly:
MENU_ID=123156468 SITE_DRN_ID=607326a3-ef2d-4b8b-b013-a91c52c3954f npm run smoke:local
```

Must see `PASS` and a `put.url` pointing at `api-sandbox.../menu/v1/brands/.../menus/...`.

## Developer Portal scenarios

1. Fill **menu_id** (and site) → click **Start**
2. Within **~30 seconds**, trigger upload (browser or curl):

```bash
curl -X POST "https://<cloud-run-url>/deliveroo/menu/upload" \
  -H "Content-Type: application/json" \
  -d '{"menuId":"<same as portal>","site_drn_id":"<from scenario parameters>"}'
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
