import crypto from "node:crypto";
import express from "express";
import { config } from "./config.js";
import { fetchDeliverooMenu, uploadDeliverooMenu } from "./deliveroo.js";
import { forwardToOwnSystem } from "./forwarder.js";
import type { NormalizedMenuEvent, NormalizedOrderEvent } from "./types.js";
import {
  getHeaderValue,
  isMenuWebhookRequest,
  verifyDeliverooWebhookHmac
} from "./webhookVerify.js";

const app = express();

app.use("/webhooks/deliveroo", express.raw({ type: "*/*", limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));

const idempotencyCache = new Map<string, number>();
const IDEMPOTENCY_TTL_MS = 1000 * 60 * 60 * 6;

const pruneCache = (): void => {
  const now = Date.now();
  for (const [key, timestamp] of idempotencyCache.entries()) {
    if (now - timestamp > IDEMPOTENCY_TTL_MS) {
      idempotencyCache.delete(key);
    }
  }
};

setInterval(pruneCache, 1000 * 60 * 10).unref();

const rememberOnce = (key: string): boolean => {
  if (idempotencyCache.has(key)) return false;
  idempotencyCache.set(key, Date.now());
  return true;
};

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const isLegacyPosOrderWebhook = (parsed: Record<string, unknown>): boolean => {
  const eventType = String(parsed.event_type ?? parsed.type ?? "");
  return eventType === "new_order" || eventType === "cancel_order";
};

const isMenuUploadResultEvent = (
  parsed: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>
): boolean => {
  if (isMenuWebhookRequest(headers)) return true;
  return String(parsed.event ?? "") === "menu.upload_result";
};

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "deliveroo-test-connector" });
});

app.post("/deliveroo/menu/sync", async (_req, res) => {
  try {
    const items = await fetchDeliverooMenu();
    await forwardToOwnSystem({ items, syncedAt: new Date().toISOString() }, "menu");
    res.json({ ok: true, count: items.length, items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(500).json({ ok: false, error: message });
  }
});

const handleMenuUpload = async (
  input: {
    menuId?: string;
    siteId?: string;
    siteDrnId?: string;
    payload?: unknown;
  },
  res: express.Response
): Promise<void> => {
  try {
    const put = await uploadDeliverooMenu(input);
    res.json({
      ok: true,
      put,
      hint:
        "Per Deliveroo docs: trigger scenario Start first, then call this within ~30s using API Suite sandbox credentials. PUT must match menu_id in the portal."
    });
  } catch (error) {
    const axiosDetail =
      typeof error === "object" &&
      error !== null &&
      "response" in error &&
      typeof (error as { response?: { data?: unknown } }).response?.data !== "undefined"
        ? (error as { response: { data: unknown } }).response.data
        : undefined;
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(500).json({ ok: false, error: message, detail: axiosDetail });
  }
};

const readUploadParams = (
  query: express.Request["query"],
  body?: Record<string, unknown>
): { menuId?: string; siteId?: string; siteDrnId?: string; payload?: unknown } => {
  const q = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const menuId =
    q("menuId") ??
    q("menu_id") ??
    (typeof body?.menuId === "string" ? body.menuId : undefined) ??
    (typeof body?.menu_id === "string" ? body.menu_id : undefined);
  const siteId =
    q("siteId") ??
    q("site_id") ??
    (typeof body?.siteId === "string" ? body.siteId : undefined) ??
    (typeof body?.site_id === "string" ? body.site_id : undefined);
  const siteDrnId =
    q("siteDrnId") ??
    q("site_drn_id") ??
    (typeof body?.siteDrnId === "string" ? body.siteDrnId : undefined) ??
    (typeof body?.site_drn_id === "string" ? body.site_drn_id : undefined);
  const payload =
    body && typeof body === "object" && "payload" in body ? body.payload : menuId ? undefined : body;

  return { menuId, siteId, siteDrnId, payload };
};

app.get("/deliveroo/menu/upload", async (req, res) => {
  await handleMenuUpload(readUploadParams(req.query), res);
});

app.post("/deliveroo/menu/upload", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  await handleMenuUpload(readUploadParams(req.query, body), res);
});

app.post("/webhooks/deliveroo", async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const headers = req.headers;
    const sequenceGuid = getHeaderValue(headers["x-deliveroo-sequence-guid"]);
    const hmacSha256 = getHeaderValue(headers["x-deliveroo-hmac-sha256"]);

    const parsed = JSON.parse(rawBody.toString("utf-8")) as Record<string, unknown>;

    if (isMenuUploadResultEvent(parsed, headers)) {
      const webhookVersion = getHeaderValue(headers["x-deliveroo-webhook-version"]);
      if (webhookVersion && webhookVersion !== "1") {
        res.status(400).json({ ok: false, error: "unsupported webhook version" });
        return;
      }

      if (!verifyDeliverooWebhookHmac(rawBody, sequenceGuid, hmacSha256, false)) {
        res.status(401).json({ ok: false, error: "invalid menu webhook signature" });
        return;
      }

      const idempotencyKey = sequenceGuid || crypto.randomUUID();
      if (!rememberOnce(`menu:${idempotencyKey}`)) {
        res.status(200).json({ ok: true, duplicate: true, kind: "menu_event" });
        return;
      }

      const bodyNode = toRecord(parsed.body);
      const uploadResult = toRecord(bodyNode.menu_upload_result);
      const siteIds = Array.isArray(uploadResult.site_ids)
        ? uploadResult.site_ids.filter((id): id is string => typeof id === "string")
        : undefined;

      const normalized: NormalizedMenuEvent = {
        channel: "deliveroo",
        eventId: idempotencyKey,
        eventType: "menu.upload_result",
        menuId: typeof uploadResult.menu_id === "string" ? uploadResult.menu_id : undefined,
        brandId: typeof uploadResult.brand_id === "string" ? uploadResult.brand_id : undefined,
        siteIds,
        httpStatus:
          typeof uploadResult.http_status === "number" ? uploadResult.http_status : undefined,
        occurredAt: new Date().toISOString(),
        payload: parsed
      };

      console.log(
        JSON.stringify({
          msg: "deliveroo.webhook.menu.upload_result",
          menuId: normalized.menuId,
          brandId: normalized.brandId,
          httpStatus: normalized.httpStatus
        })
      );

      await forwardToOwnSystem(normalized, "menu_event");
      res.status(200).json({
        ok: true,
        kind: "menu_event",
        eventId: normalized.eventId,
        menuId: normalized.menuId
      });
      return;
    }

    // Order / rider events (and legacy POS order webhooks)
    const legacyPos = isLegacyPosOrderWebhook(parsed);
    if (!verifyDeliverooWebhookHmac(rawBody, sequenceGuid, hmacSha256, legacyPos)) {
      res.status(401).json({ ok: false, error: "invalid webhook signature" });
      return;
    }

    const eventId = sequenceGuid || String(parsed.event_id ?? parsed.id ?? crypto.randomUUID());
    const orderId = String(parsed.order_id ?? "unknown");
    const eventType = String(parsed.event_type ?? parsed.type ?? "unknown");
    const idempotencyKey = `${eventId}:${orderId}:${eventType}`;

    if (!rememberOnce(`order:${idempotencyKey}`)) {
      res.status(200).json({ ok: true, duplicate: true, kind: "order_event" });
      return;
    }

    const normalized: NormalizedOrderEvent = {
      channel: "deliveroo",
      eventId,
      eventType,
      orderId,
      siteId: typeof parsed.site_id === "string" ? parsed.site_id : undefined,
      occurredAt: typeof parsed.occurred_at === "string" ? parsed.occurred_at : new Date().toISOString(),
      payload: parsed
    };

    await forwardToOwnSystem(normalized, "order_event");
    res.status(200).json({ ok: true, kind: "order_event", eventId, orderId, eventType });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(500).json({ ok: false, error: message });
  }
});

app.listen(config.port, () => {
  console.log(`deliveroo-test-connector listening on :${config.port}`);
});
