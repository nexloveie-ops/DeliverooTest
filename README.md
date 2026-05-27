# Deliveroo Test Connector

This project is a lightweight Deliveroo connector for testing.

It is intentionally limited to channel-integration responsibilities:
- Pull menu data from Deliveroo and expose standardized items
- Receive Deliveroo webhook events and normalize them
- Optionally forward normalized payloads to your own system

It does **not** include inventory deduction, BOM rules, or reporting.

## Endpoints

- `GET /healthz`  
  Health check.

- `POST /deliveroo/menu/sync`  
  Fetches menu from Deliveroo API, normalizes records, returns JSON, and optionally forwards data.

- `POST /webhooks/deliveroo`  
  Receives Deliveroo webhook, validates signature (if configured), performs basic idempotency check, normalizes event, and optionally forwards.

## Environment variables

Copy `.env.example` to `.env` and fill values:

- `PORT`
- `DELIVEROO_BASE_URL`
- `DELIVEROO_API_TOKEN`
- `DELIVEROO_SITE_ID`
- `DELIVEROO_WEBHOOK_SECRET` (optional but recommended)
- `FORWARD_TARGET_URL` (optional)
- `FORWARD_AUTH_TOKEN` (optional)

## Local run

```bash
npm install
npm run dev
```

## Deploy to Google Cloud Run (via GitHub Actions)

Workflow file: `.github/workflows/deploy-cloud-run.yml`

Required GitHub secrets:
- `GCP_PROJECT_ID`
- `GCP_WIF_PROVIDER`
- `GCP_SERVICE_ACCOUNT`

After deployment:
1. Open Cloud Run service URL
2. Configure Deliveroo webhook URL as `<cloud-run-url>/webhooks/deliveroo`
3. Send a test event from Deliveroo and verify log + response

## Suggested next integration step

Connect your own system endpoint to `FORWARD_TARGET_URL` so your core platform receives:
- normalized menu snapshots (`kind: "menu"`)
- normalized order events (`kind: "order_event"`)
