import crypto from "node:crypto";
import express from "express";
import { config } from "./config.js";
import { fetchDeliverooMenu, uploadDeliverooMenu } from "./deliveroo.js";
import { forwardToOwnSystem } from "./forwarder.js";
import type { NormalizedOrderEvent } from "./types.js";

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

const getHeader = (value: string | string[] | undefined): string => {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
};

const verifySignature = (rawBody: Buffer, signatureHeader: string): boolean => {
  if (!config.deliverooWebhookSecret) return true;
  if (!signatureHeader) return false;
  const computed = crypto
    .createHmac("sha256", config.deliverooWebhookSecret)
    .update(rawBody)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
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

app.post("/deliveroo/menu/upload", async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const menuId =
      typeof body?.menuId === "string"
        ? body.menuId
        : typeof body?.menu_id === "string"
          ? body.menu_id
          : undefined;
    const siteId =
      typeof body?.siteId === "string"
        ? body.siteId
        : typeof body?.site_id === "string"
          ? body.site_id
          : undefined;
    const siteDrnId =
      typeof body?.siteDrnId === "string"
        ? body.siteDrnId
        : typeof body?.site_drn_id === "string"
          ? body.site_drn_id
          : undefined;
    const payload =
      body && typeof body === "object" && "payload" in body
        ? body.payload
        : menuId
          ? undefined
          : req.body;
    const result = await uploadDeliverooMenu({ menuId, siteId, siteDrnId, payload });
    res.json({ ok: true, result });
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
});

app.post("/webhooks/deliveroo", async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const signature = getHeader(req.headers["x-deliveroo-signature"]);
    if (!verifySignature(rawBody, signature)) {
      res.status(401).json({ ok: false, error: "invalid signature" });
      return;
    }

    const parsed = JSON.parse(rawBody.toString("utf-8")) as Record<string, unknown>;
    const eventId = String(parsed.event_id ?? parsed.id ?? crypto.randomUUID());
    const orderId = String(parsed.order_id ?? "unknown");
    const eventType = String(parsed.event_type ?? parsed.type ?? "unknown");
    const idempotencyKey = `${eventId}:${orderId}:${eventType}`;

    if (idempotencyCache.has(idempotencyKey)) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    idempotencyCache.set(idempotencyKey, Date.now());

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
    res.status(200).json({ ok: true, eventId, orderId, eventType });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(500).json({ ok: false, error: message });
  }
});

app.listen(config.port, () => {
  console.log(`deliveroo-test-connector listening on :${config.port}`);
});
