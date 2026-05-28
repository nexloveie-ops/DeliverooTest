import crypto from "node:crypto";
import express from "express";
import { config } from "./config.js";
import {
  fetchDeliverooMenu,
  getItemUnavailabilities,
  parseItemUnavailabilityUpdates,
  parseReplaceAllUnavailabilities,
  replaceAllItemUnavailabilities,
  runScenario8Unavailabilities,
  runScenario9Unavailabilities,
  runScenario10Unavailabilities,
  runScenario11Unavailabilities,
  runScenario12Unavailabilities,
  generateMenuV3S3UploadUrl,
  runScenario13MenuAndUnavailabilities,
  runScenario15MenuV3Async,
  fetchScenario16MenuV3JobStatus,
  fetchScenario17MenuV3Async,
  SCENARIO13_UNAVAILABILITY_POST,
  updateItemUnavailabilities,
  uploadDeliverooMenu
} from "./deliveroo.js";
import { SCENARIO13_ITEM_COUNT } from "./menuPayloads.js";
import { buildScenario13PayloadForDiagnose } from "./scenario13Diagnose.js";
import { forwardToOwnSystem } from "./forwarder.js";
import type { NormalizedMenuEvent, NormalizedOrderEvent } from "./types.js";
import {
  appendWebhookInbound,
  getMenuWebhookStatus,
  getRecentWebhookInbound,
  recordMenuWebhook,
  type WebhookInboundLog
} from "./menuWebhookStore.js";
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

const deliverooAxiosDetail = (error: unknown): unknown => {
  if (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof (error as { response?: { data?: unknown } }).response?.data !== "undefined"
  ) {
    return (error as { response: { data: unknown } }).response.data;
  }
  return undefined;
};

const readUnavailabilitySiteParams = (
  query: express.Request["query"],
  body?: Record<string, unknown>
): { siteId?: string; siteDrnId?: string; menuId?: string; apiVersion?: "v1" | "v2" } => {
  const q = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const apiRaw = q("apiVersion") ?? q("api_version");
  const apiVersion =
    apiRaw === "v1" || apiRaw === "v2" ? apiRaw : undefined;
  return {
    siteId:
      q("siteId") ??
      q("site_id") ??
      (typeof body?.siteId === "string" ? body.siteId : undefined) ??
      (typeof body?.site_id === "string" ? body.site_id : undefined),
    siteDrnId:
      q("siteDrnId") ??
      q("site_drn_id") ??
      (typeof body?.siteDrnId === "string" ? body.siteDrnId : undefined) ??
      (typeof body?.site_drn_id === "string" ? body.site_drn_id : undefined),
    menuId:
      q("menuId") ??
      q("menu_id") ??
      (typeof body?.menuId === "string" ? body.menuId : undefined) ??
      (typeof body?.menu_id === "string" ? body.menu_id : undefined),
    apiVersion
  };
};

const parseScenario8Step = (
  query: express.Request["query"],
  body?: Record<string, unknown>
): "1" | "2" | "both" => {
  const raw =
    (typeof query.step === "string" ? query.step : undefined) ??
    (typeof body?.step === "string" ? body.step : undefined) ??
    (typeof body?.step === "number" ? String(body.step) : undefined);
  if (raw === "1" || raw === "2") return raw;
  return "both";
};

const parseScenarioGetPutStep = (
  query: express.Request["query"],
  body?: Record<string, unknown>
): "get" | "put" | "both" => {
  const raw =
    (typeof query.step === "string" ? query.step : undefined) ??
    (typeof body?.step === "string" ? body.step : undefined);
  if (raw === "get" || raw === "put") return raw;
  return "both";
};

const parseScenario11Step = (
  query: express.Request["query"],
  body?: Record<string, unknown>
): "post" | "get" | "both" => {
  const raw =
    (typeof query.step === "string" ? query.step : undefined) ??
    (typeof body?.step === "string" ? body.step : undefined);
  if (raw === "post" || raw === "get") return raw;
  return "post";
};

const readReplaceAllBody = (body: Record<string, unknown>): ReturnType<typeof parseReplaceAllUnavailabilities> | undefined => {
  if ("unavailable_ids" in body || "hidden_ids" in body) {
    return parseReplaceAllUnavailabilities(body);
  }
  if (body.payload && typeof body.payload === "object") {
    return parseReplaceAllUnavailabilities(body.payload);
  }
  return undefined;
};

const parseMenuUploadErrors = (
  uploadResult: Record<string, unknown>
): {
  processingError?: string;
  imageErrors?: Array<{ url?: string; message?: string }>;
  barcodeErrors?: Array<{ barcode?: string; message?: string }>;
} => {
  const errors = toRecord(uploadResult.errors);
  const processing =
    typeof errors.processing === "string" && errors.processing.length > 0
      ? errors.processing
      : undefined;
  const imageErrors: Array<{ url?: string; message?: string }> = [];
  if (Array.isArray(errors.images)) {
    for (const raw of errors.images) {
      const node = toRecord(raw);
      const url = typeof node.url === "string" ? node.url : undefined;
      const message = typeof node.message === "string" ? node.message : undefined;
      if (url || message) imageErrors.push({ url, message });
    }
  }
  const barcodeErrors: Array<{ barcode?: string; message?: string }> = [];
  if (Array.isArray(errors.barcodes)) {
    for (const raw of errors.barcodes) {
      const node = toRecord(raw);
      const barcode =
        typeof node.barcode === "string"
          ? node.barcode
          : typeof node.value === "string"
            ? node.value
            : undefined;
      const message = typeof node.message === "string" ? node.message : undefined;
      if (barcode || message) barcodeErrors.push({ barcode, message });
    }
  }
  return {
    processingError: processing,
    imageErrors: imageErrors.length > 0 ? imageErrors : undefined,
    barcodeErrors: barcodeErrors.length > 0 ? barcodeErrors : undefined
  };
};

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

const parseScenario = (
  value: string | undefined
): "default" | "mealtimes" | "bundles" | "nochange" | "webhook" | "imagecache" | "scenario13" => {
  if (
    value === "bundles" ||
    value === "mealtimes" ||
    value === "default" ||
    value === "nochange" ||
    value === "webhook" ||
    value === "imagecache" ||
    value === "scenario13"
  ) {
    return value;
  }
  return "mealtimes";
};

const parseScenario13Step = (
  query: Record<string, unknown>,
  body?: Record<string, unknown>
): "upload" | "wait" | "post" | "all" => {
  const raw =
    (typeof query.step === "string" ? query.step : undefined) ??
    (typeof body?.step === "string" ? body.step : undefined);
  if (raw === "upload" || raw === "wait" || raw === "post" || raw === "all") {
    return raw;
  }
  return "all";
};

const parseScenario15Step = (
  query: Record<string, unknown>,
  body?: Record<string, unknown>
): "upload" | "wait" | "all" => {
  const raw =
    (typeof query.step === "string" ? query.step : undefined) ??
    (typeof body?.step === "string" ? body.step : undefined);
  if (raw === "upload" || raw === "wait" || raw === "all") {
    return raw;
  }
  return "all";
};

const parseDoubleUpload = (body?: Record<string, unknown>): boolean => {
  if (body?.double === true || body?.doubleUpload === true) return true;
  return false;
};

const handleMenuUpload = async (
  input: {
    menuId?: string;
    siteId?: string;
    siteDrnId?: string;
    scenario?: "default" | "mealtimes" | "bundles" | "nochange" | "webhook" | "imagecache" | "scenario13";
    payload?: unknown;
    doubleUpload?: boolean;
    delayMs?: number;
    generateMenuId?: boolean;
    webhookBodyStrategy?: "template" | "mutate" | "auto";
    scenario13PreferTemplate?: boolean;
    scenario13PreferGet?: boolean;
    uploadApi?: "v1" | "v3";
    pollV3Job?: boolean;
    jobPollTimeoutMs?: number;
    scenario13ItemCount?: number;
    scenario13OmitCover?: boolean;
  },
  res: express.Response
): Promise<void> => {
  try {
    const put = await uploadDeliverooMenu(input);
    res.json({
      ok: true,
      matchExistingMenu: put.matchExistingMenu,
      payloadDiffersFromStored: put.payloadDiffersFromStored,
      payloadDiagnose: put.payloadDiagnose,
      put,
      hint:
        put.scenario === "webhook"
          ? put.matchExistingMenu
            ? "Scenario 6: Deliveroo returned MATCH_EXISTING_MENU — click Start in the Portal, then upload again within 30s (or omit menuId to generate a new one)."
            : put.payloadDiffersFromStored === false
              ? "Scenario 6: PUT body matched the stored menu — retry upload after Start."
              : "Scenario 6: Start → upload within 30s (same menu_id as Portal). Default uses minimal template; pass webhookBodyStrategy=mutate only if needed. Use create=true for fresh menu_id. Poll webhook-status until httpStatus is 200."
          : put.scenario === "nochange"
            ? put.doubleUpload
              ? "Scenario 5: two identical PUTs using GET menu JSON (Deliveroo canonical form). Call only ONCE per Start with double:true."
              : "Scenario 5: use scenario=nochange (same JSON as mealtimes). Prefer double:true once per Start."
            : put.scenario === "imagecache"
              ? "Scenario 7: payload includes ITEM image URL with cache headers support (HEAD should return ETag or Last-Modified)."
              : put.scenario === "scenario13"
                ? put.uploadPath === "v3"
                  ? put.v3?.jobStatus === "failed"
                    ? "Scenario 13 (V3): publish job failed — check put.v3 and Cloud Run logs; retry with fresh menu_id after Start."
                    : `Scenario 13 (Menu V3): ${SCENARIO13_ITEM_COUNT} items via S3 + publish job (jobId=${put.v3?.jobId ?? "n/a"}). Wait for menu.upload_result webhook (httpStatus 200), then POST unavailabilities. Use ?uploadApi=v1 to force legacy PUT.`
                  : put.matchExistingMenu
                    ? "Scenario 13: MATCH_EXISTING_MENU — upload a differing body or use a fresh menu_id after Start."
                    : `Scenario 13 (v1 PUT): uploaded ${SCENARIO13_ITEM_COUNT} items. Wait for menu.upload_result webhook, then POST unavailabilities. Prefer default V3 (omit uploadApi) for large menus.`
            : "Per Deliveroo docs: trigger scenario Start first, then call this within ~30s using API Suite sandbox credentials. PUT must match menu_id in the portal."
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
    res.status(500).json({
      ok: false,
      error: message,
      detail: axiosDetail ?? (message.includes("upload_url") ? message : undefined)
    });
  }
};

const readUploadParams = (
  query: express.Request["query"],
  body?: Record<string, unknown>
): {
  menuId?: string;
  siteId?: string;
  siteDrnId?: string;
  scenario?: "default" | "mealtimes" | "bundles" | "nochange" | "webhook" | "imagecache" | "scenario13";
  payload?: unknown;
  doubleUpload?: boolean;
  delayMs?: number;
  generateMenuId?: boolean;
  webhookBodyStrategy?: "template" | "mutate" | "auto";
  scenario13PreferTemplate?: boolean;
  scenario13PreferGet?: boolean;
  uploadApi?: "v1" | "v3";
  pollV3Job?: boolean;
  jobPollTimeoutMs?: number;
  scenario13ItemCount?: number;
  scenario13OmitCover?: boolean;
} => {
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
  const scenarioRaw =
    q("scenario") ??
    (typeof body?.scenario === "string" ? body.scenario : undefined);
  const scenario = parseScenario(scenarioRaw);
  const payload =
    body && typeof body === "object" && "payload" in body ? body.payload : menuId ? undefined : body;
  const doubleUpload =
    q("double") === "true" ||
    q("doubleUpload") === "true" ||
    parseDoubleUpload(body);
  const delayRaw =
    q("delayMs") ??
    (typeof body?.delayMs === "number" ? String(body.delayMs) : undefined);
  const delayMs = delayRaw ? Number(delayRaw) : undefined;
  const generateMenuId =
    q("generateMenuId") === "true" ||
    q("create") === "true" ||
    body?.generateMenuId === true ||
    body?.create === true;
  const strategyRaw =
    q("webhookBodyStrategy") ??
    (typeof body?.webhookBodyStrategy === "string" ? body.webhookBodyStrategy : undefined);
  const webhookBodyStrategy =
    strategyRaw === "template" || strategyRaw === "mutate" || strategyRaw === "auto"
      ? strategyRaw
      : undefined;
  const scenario13PreferTemplate =
    q("scenario13PreferTemplate") === "true" ||
    q("preferTemplate") === "true" ||
    body?.scenario13PreferTemplate === true;
  const scenario13PreferGet =
    q("scenario13PreferGet") === "true" ||
    q("preferGet") === "true" ||
    body?.scenario13PreferGet === true;
  const uploadApiRaw =
    q("uploadApi") ??
    (typeof body?.uploadApi === "string" ? body.uploadApi : undefined);
  const uploadApi =
    uploadApiRaw === "v1" || uploadApiRaw === "v3" ? uploadApiRaw : undefined;
  const pollV3Job =
    q("pollV3Job") === "false" || body?.pollV3Job === false ? false : undefined;
  const jobPollTimeoutRaw =
    q("jobPollTimeoutMs") ??
    (typeof body?.jobPollTimeoutMs === "number" ? String(body.jobPollTimeoutMs) : undefined);
  const jobPollTimeoutMs = jobPollTimeoutRaw ? Number(jobPollTimeoutRaw) : undefined;
  const itemCountRaw =
    q("itemCount") ??
    (typeof body?.itemCount === "number" ? String(body.itemCount) : undefined);
  const scenario13ItemCount =
    itemCountRaw && Number.isFinite(Number(itemCountRaw)) ? Number(itemCountRaw) : undefined;
  const scenario13OmitCover =
    q("omitCover") === "true" || body?.omitCover === true || body?.scenario13OmitCover === true;

  return {
    menuId,
    siteId,
    siteDrnId,
    scenario,
    payload,
    doubleUpload,
    delayMs,
    generateMenuId,
    webhookBodyStrategy,
    scenario13PreferTemplate,
    scenario13PreferGet,
    uploadApi,
    pollV3Job,
    jobPollTimeoutMs,
    scenario13ItemCount,
    scenario13OmitCover
  };
};

const handleScenario14S3UploadUrl = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const menuId =
    (typeof req.query.menuId === "string" ? req.query.menuId : undefined) ??
    (typeof req.query.menu_id === "string" ? req.query.menu_id : undefined) ??
    (typeof body.menuId === "string" ? body.menuId : undefined) ??
    (typeof body.menu_id === "string" ? body.menu_id : undefined);
  const siteId =
    (typeof req.query.siteId === "string" ? req.query.siteId : undefined) ??
    (typeof body.siteId === "string" ? body.siteId : undefined);
  const siteDrnId =
    (typeof req.query.siteDrnId === "string" ? req.query.siteDrnId : undefined) ??
    (typeof req.query.site_drn_id === "string" ? req.query.site_drn_id : undefined) ??
    (typeof body.siteDrnId === "string" ? body.siteDrnId : undefined) ??
    (typeof body.site_drn_id === "string" ? body.site_drn_id : undefined);

  if (!menuId) {
    res.status(400).json({
      ok: false,
      error: "menuId is required for Scenario 14 (same menu_id as Portal Start)"
    });
    return;
  }

  try {
    const result = await generateMenuV3S3UploadUrl({ menuId, siteId, siteDrnId });
    res.json({
      ok: true,
      scenario: 14,
      ...result,
      hint:
        "Scenario 14 only requires this PUT (presigned S3 URL). Reuse the same menu_id for later [MENU V3 APIs] scenarios. Full upload: POST /deliveroo/menu/upload?scenario=scenario13."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(500).json({ ok: false, error: message, detail: deliverooAxiosDetail(error) });
  }
};

/** Scenario 14: Menu V3 Generate S3 upload URL (PUT only). */
app.put("/deliveroo/menu/scenario14", handleScenario14S3UploadUrl);
app.post("/deliveroo/menu/scenario14", handleScenario14S3UploadUrl);

app.post("/deliveroo/menu/scenario15", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const siteParams = readUnavailabilitySiteParams(req.query, body);
  const step = parseScenario15Step(req.query as Record<string, unknown>, body);
  const webhookTimeoutMs =
    typeof req.query.webhookTimeoutMs === "string"
      ? Number(req.query.webhookTimeoutMs)
      : typeof body.webhookTimeoutMs === "number"
        ? body.webhookTimeoutMs
        : undefined;
  const pollV3Job =
    req.query.pollV3Job === "false" || body.pollV3Job === false ? false : undefined;
  const jobPollTimeoutMs =
    typeof req.query.jobPollTimeoutMs === "string"
      ? Number(req.query.jobPollTimeoutMs)
      : typeof body.jobPollTimeoutMs === "number"
        ? body.jobPollTimeoutMs
        : undefined;

  if (!siteParams.menuId) {
    res.status(400).json({
      ok: false,
      error: "menuId is required for Scenario 15 (same menu_id as Portal; complete Scenario 14 first)"
    });
    return;
  }

  try {
    const result = await runScenario15MenuV3Async({
      menuId: siteParams.menuId,
      siteId: siteParams.siteId,
      siteDrnId: siteParams.siteDrnId,
      step,
      webhookTimeoutMs: Number.isFinite(webhookTimeoutMs) ? webhookTimeoutMs : undefined,
      pollV3Job,
      jobPollTimeoutMs: Number.isFinite(jobPollTimeoutMs) ? jobPollTimeoutMs : undefined
    });
    const webhookOk = result.webhookWait?.received === true;
    const ok = step === "upload" ? true : step === "wait" ? webhookOk : webhookOk && !result.error;
    res.status(ok ? 200 : step === "all" && result.webhookWait && !webhookOk ? 504 : 500).json({
      ok,
      scenario: 15,
      step,
      menuId: siteParams.menuId,
      ...result,
      hint:
        step === "upload"
          ? "Scenario 15: presign + S3 PUT + publish job done. Poll webhook-status or step=wait for menu.upload_result (httpStatus 200)."
          : step === "wait"
            ? "Scenario 15: waiting for menu.upload_result on this Cloud Run instance."
            : "Scenario 15: full async flow (S3 within seconds of presign, then POST publish job). Portal needs webhook http_status 200."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(500).json({ ok: false, error: message, detail: deliverooAxiosDetail(error) });
  }
});

const readScenario16Params = (
  query: express.Request["query"],
  body?: Record<string, unknown>
): { jobId?: string; brandId?: string; siteId?: string; siteDrnId?: string } => {
  const pick = (key: string, alt?: string): string | undefined => {
    const q = query[key];
    if (typeof q === "string" && q.length > 0) return q;
    if (alt) {
      const qa = query[alt];
      if (typeof qa === "string" && qa.length > 0) return qa;
    }
    const b = body?.[key];
    if (typeof b === "string" && b.length > 0) return b;
    if (alt) {
      const ba = body?.[alt];
      if (typeof ba === "string" && ba.length > 0) return ba;
    }
    return undefined;
  };
  return {
    jobId: pick("jobId", "job_id"),
    brandId: pick("brandId", "brand_id"),
    siteId: pick("siteId", "site_id"),
    siteDrnId: pick("siteDrnId", "site_drn_id")
  };
};

const handleScenario16JobStatus = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const params = readScenario16Params(req.query, body);

  if (!params.jobId) {
    res.status(400).json({
      ok: false,
      error:
        "jobId is required for Scenario 16 (use job_id from Scenario 15 upload.upload.jobId or Portal)"
    });
    return;
  }

  try {
    const result = await fetchScenario16MenuV3JobStatus(params);
    res.json({
      ok: true,
      scenario: 16,
      ...result,
      hint:
        "Scenario 16 validates GET job status. jobId from Scenario 15: upload.jobId (e.g. after POST scenario15?step=upload)."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(500).json({ ok: false, error: message, detail: deliverooAxiosDetail(error) });
  }
};

app.get("/deliveroo/menu/scenario16", handleScenario16JobStatus);
app.post("/deliveroo/menu/scenario16", handleScenario16JobStatus);

const handleScenario17FetchMenu = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const menuId =
    (typeof req.query.menuId === "string" ? req.query.menuId : undefined) ??
    (typeof req.query.menu_id === "string" ? req.query.menu_id : undefined) ??
    (typeof body.menuId === "string" ? body.menuId : undefined) ??
    (typeof body.menu_id === "string" ? body.menu_id : undefined);
  const siteId =
    (typeof req.query.siteId === "string" ? req.query.siteId : undefined) ??
    (typeof body.siteId === "string" ? body.siteId : undefined);
  const siteDrnId =
    (typeof req.query.siteDrnId === "string" ? req.query.siteDrnId : undefined) ??
    (typeof req.query.site_drn_id === "string" ? req.query.site_drn_id : undefined) ??
    (typeof body.siteDrnId === "string" ? body.siteDrnId : undefined) ??
    (typeof body.site_drn_id === "string" ? body.site_drn_id : undefined);
  const brandId =
    (typeof req.query.brandId === "string" ? req.query.brandId : undefined) ??
    (typeof req.query.brand_id === "string" ? req.query.brand_id : undefined) ??
    (typeof body.brandId === "string" ? body.brandId : undefined) ??
    (typeof body.brand_id === "string" ? body.brand_id : undefined);

  if (!menuId) {
    res.status(400).json({
      ok: false,
      error: "menuId is required for Scenario 17 (same menu_id as Scenarios 14–15)"
    });
    return;
  }

  try {
    const result = await fetchScenario17MenuV3Async({
      menuId,
      siteId,
      siteDrnId,
      brandId
    });
    res.json({
      ok: true,
      scenario: 17,
      ...result,
      hint:
        "Scenario 17 validates GET menu V3. Use same menu_id as prior [MENU V3 APIs] scenarios; download JSON from s3Url if present."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(500).json({ ok: false, error: message, detail: deliverooAxiosDetail(error) });
  }
};

app.get("/deliveroo/menu/scenario17", handleScenario17FetchMenu);
app.post("/deliveroo/menu/scenario17", handleScenario17FetchMenu);

/** Scenario 13: inspect template payload without calling Deliveroo. */
app.get("/deliveroo/menu/scenario13/diagnose", (req, res) => {
  const menuId =
    typeof req.query.menuId === "string" && req.query.menuId.length > 0
      ? req.query.menuId
      : "preview-menu-id";
  const siteId =
    typeof req.query.siteId === "string" && req.query.siteId.length > 0
      ? req.query.siteId
      : config.deliverooLocationId;
  const itemCountRaw =
    typeof req.query.itemCount === "string" ? Number(req.query.itemCount) : undefined;
  const itemCount = Number.isFinite(itemCountRaw) ? itemCountRaw : SCENARIO13_ITEM_COUNT;
  const { payload, diagnose } = buildScenario13PayloadForDiagnose(menuId, siteId, itemCount);
  res.json({
    ok: true,
    menuId,
    siteId,
    itemCountRequested: itemCount,
    diagnose,
    payloadSample: {
      name: payload.name,
      site_ids: payload.site_ids,
      menu: {
        currency_code: (payload.menu as Record<string, unknown>)?.currency_code,
        is_pos_integrated: (payload.menu as Record<string, unknown>)?.is_pos_integrated,
        mealtimes: (payload.menu as Record<string, unknown>)?.mealtimes,
        categoriesCount: Array.isArray((payload.menu as Record<string, unknown>)?.categories)
          ? ((payload.menu as Record<string, unknown>).categories as unknown[]).length
          : 0,
        itemsCount: Array.isArray((payload.menu as Record<string, unknown>)?.items)
          ? ((payload.menu as Record<string, unknown>).items as unknown[]).length
          : 0
      }
    },
    hint:
      "Fix warnings before upload. A/B: upload with ?itemCount=20 to see if 500 is scale-related; ?omitCover=true to test without mealtime image."
  });
});

app.get("/deliveroo/menu/webhook-status", (req, res) => {
  const menuId =
    typeof req.query.menuId === "string"
      ? req.query.menuId
      : typeof req.query.menu_id === "string"
        ? req.query.menu_id
        : undefined;
  if (!menuId) {
    res.status(400).json({ ok: false, error: "menuId query parameter is required" });
    return;
  }
  const status = getMenuWebhookStatus(menuId);
  const includeAll = req.query.all === "true";
  res.json({
    ok: true,
    menuId,
    ...status,
    recentInbound: includeAll ? getRecentWebhookInbound() : getRecentWebhookInbound().slice(0, 10)
  });
});

app.get("/deliveroo/menu/webhook-inbound", (_req, res) => {
  res.json({ ok: true, count: getRecentWebhookInbound().length, recent: getRecentWebhookInbound() });
});

app.get("/deliveroo/menu/upload", async (req, res) => {
  await handleMenuUpload(readUploadParams(req.query), res);
});

app.post("/deliveroo/menu/upload", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  await handleMenuUpload(readUploadParams(req.query, body), res);
});

app.get("/deliveroo/menu/item-unavailabilities", async (req, res) => {
  try {
    const result = await getItemUnavailabilities(readUnavailabilitySiteParams(req.query));
    res.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(500).json({ ok: false, error: message, detail: deliverooAxiosDetail(error) });
  }
});

app.post("/deliveroo/menu/item-unavailabilities", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const updates =
    parseItemUnavailabilityUpdates(body.item_unavailabilities) ??
    parseItemUnavailabilityUpdates(body.itemUnavailabilities);
  if (!updates) {
    res.status(400).json({
      ok: false,
      error:
        "item_unavailabilities array required (objects with item_id and status: available|unavailable|hidden)"
    });
    return;
  }
  try {
    const result = await updateItemUnavailabilities(
      updates,
      readUnavailabilitySiteParams(req.query, body)
    );
    res.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(500).json({ ok: false, error: message, detail: deliverooAxiosDetail(error) });
  }
});

app.put("/deliveroo/menu/item-unavailabilities", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const replaceBody = readReplaceAllBody(body);
  if (!replaceBody) {
    res.status(400).json({
      ok: false,
      error: "Body must include unavailable_ids and hidden_ids arrays (v1 PUT replace-all)"
    });
    return;
  }
  const siteParams = readUnavailabilitySiteParams(req.query, body);
  if (!siteParams.menuId) {
    res.status(400).json({ ok: false, error: "menuId is required for PUT replace-all (v1)" });
    return;
  }
  try {
    const result = await replaceAllItemUnavailabilities(replaceBody, {
      ...siteParams,
      apiVersion: "v1"
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(500).json({ ok: false, error: message, detail: deliverooAxiosDetail(error) });
  }
});

app.post("/deliveroo/menu/scenario8", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const siteParams = readUnavailabilitySiteParams(req.query, body);
  const step = parseScenario8Step(req.query, body);
  try {
    const result = await runScenario8Unavailabilities({ ...siteParams, step });
    res.json({
      ok: true,
      step,
      expectedFinalState: {
        orange_juice: "available",
        granola: "unavailable",
        whole_milk: "unavailable"
      },
      ...result,
      hint:
        step === "both"
          ? "Scenario 8: v1 POST with Portal menu_id. Step 1+2 ran with 900ms gap. Re-Start if Portal still validating."
          : step === "1"
            ? "Scenario 8 step 1 done (v1). Wait ≥1s, then step=2 with same menuId."
            : "Scenario 8 step 2 done (v1). Final: orange_juice available, granola unavailable, whole_milk unavailable."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(500).json({ ok: false, error: message, detail: deliverooAxiosDetail(error) });
  }
});

app.post("/deliveroo/menu/scenario9", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const siteParams = readUnavailabilitySiteParams(req.query, body);
  const step = parseScenarioGetPutStep(req.query, body);
  if (!siteParams.menuId) {
    res.status(400).json({
      ok: false,
      error: "menuId is required for Scenario 9 (same menu_id as Portal)"
    });
    return;
  }
  try {
    const result = await runScenario9Unavailabilities({ ...siteParams, step });
    res.json({
      ok: true,
      step,
      menuId: siteParams.menuId,
      expectedAfterPut: {
        orange_juice: "unavailable (preserved from GET / tablet)",
        granola: "hidden (preserved from GET / tablet)",
        whole_milk: "unavailable (appended on PUT)"
      },
      getWarnings: result.getWarnings,
      diagnose: result.diagnose,
      ...result,
      hint:
        result.tabletFallbackUsed
          ? "Scenario 9: sandbox GET returned null; PUT used Portal tablet defaults + whole_milk (expected by scenario spec)."
          : step === "get"
            ? "Scenario 9: GET polls up to ~16s. If warnings remain, step=put still sends correct PUT body when menu items exist."
            : step === "put"
              ? "Scenario 9 PUT: unavailable_ids includes orange_juice + whole_milk; hidden_ids includes granola."
              : "Scenario 9: GET (with retries) then PUT after Start."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(500).json({ ok: false, error: message, detail: deliverooAxiosDetail(error) });
  }
});

app.post("/deliveroo/menu/scenario10", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const siteParams = readUnavailabilitySiteParams(req.query, body);
  const step = parseScenarioGetPutStep(req.query, body);
  if (!siteParams.menuId) {
    res.status(400).json({
      ok: false,
      error: "menuId is required for Scenario 10 (same menu_id as Portal)"
    });
    return;
  }
  try {
    const result = await runScenario10Unavailabilities({ ...siteParams, step });
    res.json({
      ok: true,
      step,
      menuId: siteParams.menuId,
      expectedAfterPut: {
        orange_juice: "available",
        granola: "available",
        whole_milk: "available"
      },
      getWarnings: result.getWarnings,
      diagnose: result.diagnose,
      ...result,
      hint:
        step === "get"
          ? "Scenario 10: confirm orange_juice unavailable + granola hidden, then step=put with empty unavailable_ids (≥1s later)."
          : step === "put"
            ? "Scenario 10 PUT: empty unavailable_ids + hidden_ids — all items available."
            : "Scenario 10: GET then PUT reset after Portal Start."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(500).json({ ok: false, error: message, detail: deliverooAxiosDetail(error) });
  }
});

app.post("/deliveroo/menu/scenario11", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const siteParams = readUnavailabilitySiteParams(req.query, body);
  const step = parseScenario11Step(req.query, body);
  if (!siteParams.menuId) {
    res.status(400).json({
      ok: false,
      error: "menuId is required for Scenario 11 (same menu_id as Portal)"
    });
    return;
  }
  try {
    const result = await runScenario11Unavailabilities({ ...siteParams, step });
    res.json({
      ok: true,
      step,
      menuId: siteParams.menuId,
      initialPost: [
        { item_id: "granola", status: "unavailable" },
        { item_id: "orange_juice", status: "hidden" }
      ],
      expectedAfterMorningReset: {
        orange_juice: "hidden (unchanged)",
        granola: "available (was unavailable, reset)",
        whole_milk: "available"
      },
      getWarnings: result.getWarnings,
      diagnose: result.diagnose,
      ...result,
      hint:
        step === "post"
          ? "Scenario 11: POST initial stock after Start (before midnight sim). Portal then runs morning reset when site opens."
          : step === "get"
            ? "Scenario 11 GET: verify granola available, orange_juice still hidden after morning reset."
            : "Scenario 11: POST initial state then GET (optional check)."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(500).json({ ok: false, error: message, detail: deliverooAxiosDetail(error) });
  }
});

app.post("/deliveroo/menu/scenario12", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const siteParams = readUnavailabilitySiteParams(req.query, body);
  const step = parseScenario11Step(req.query, body);
  if (!siteParams.menuId) {
    res.status(400).json({
      ok: false,
      error: "menuId is required for Scenario 12 (same menu_id as Portal)"
    });
    return;
  }
  try {
    const result = await runScenario12Unavailabilities({ ...siteParams, step });
    res.json({
      ok: true,
      step,
      menuId: siteParams.menuId,
      portalInitialState: {
        orange_juice: "unavailable (set by Portal on Start)"
      },
      partnerPost: [{ item_id: "whole_milk", status: "unavailable" }],
      expectedAfterSiteOpen: {
        orange_juice: "unavailable (unchanged — no morning reset)",
        whole_milk: "unavailable (unchanged)",
        granola: "available"
      },
      getWarnings: result.getWarnings,
      diagnose: result.diagnose,
      ...result,
      hint:
        step === "post"
          ? "Scenario 12: POST whole_milk unavailable after Start (after-midnight sim). Morning reset skipped; stock unchanged when site opens."
          : step === "get"
            ? "Scenario 12 GET: verify orange_juice + whole_milk still unavailable, granola available."
            : "Scenario 12: POST whole_milk then optional GET."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(500).json({ ok: false, error: message, detail: deliverooAxiosDetail(error) });
  }
});

app.post("/deliveroo/menu/scenario13", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const siteParams = readUnavailabilitySiteParams(req.query, body);
  const step = parseScenario13Step(req.query as Record<string, unknown>, body);
  const webhookTimeoutMs =
    typeof req.query.webhookTimeoutMs === "string"
      ? Number(req.query.webhookTimeoutMs)
      : typeof body.webhookTimeoutMs === "number"
        ? body.webhookTimeoutMs
        : undefined;

  if (!siteParams.menuId) {
    res.status(400).json({
      ok: false,
      error: "menuId is required for Scenario 13 (same menu_id as Portal)"
    });
    return;
  }

  const uploadParams = readUploadParams(req.query, body);

  try {
    const result = await runScenario13MenuAndUnavailabilities({
      menuId: siteParams.menuId,
      siteId: siteParams.siteId,
      siteDrnId: siteParams.siteDrnId,
      step,
      webhookTimeoutMs: Number.isFinite(webhookTimeoutMs) ? webhookTimeoutMs : undefined,
      uploadApi: uploadParams.uploadApi,
      scenario13PreferTemplate: uploadParams.scenario13PreferTemplate,
      scenario13PreferGet: uploadParams.scenario13PreferGet,
      pollV3Job: uploadParams.pollV3Job,
      jobPollTimeoutMs: Number.isFinite(uploadParams.jobPollTimeoutMs)
        ? uploadParams.jobPollTimeoutMs
        : undefined,
      scenario13ItemCount: uploadParams.scenario13ItemCount,
      scenario13OmitCover: uploadParams.scenario13OmitCover
    });
    const ok = step !== "all" || (!result.error && Boolean(result.post));
    res.status(ok ? 200 : 504).json({
      ok,
      step,
      menuId: siteParams.menuId,
      itemCount: SCENARIO13_ITEM_COUNT,
      unavailabilityPost: SCENARIO13_UNAVAILABILITY_POST,
      ...result,
      hint:
        step === "upload"
          ? "Scenario 13: PUT ≥100 items after Start. Poll webhook-status until received, then step=post."
          : step === "wait"
            ? "Scenario 13: waiting for menu.upload_result on this instance (up to 90s)."
            : step === "post"
              ? "Scenario 13: POST unavailabilities only — call after menu.upload_result webhook."
              : "Scenario 13: upload → wait for webhook → POST first item unavailable. Split steps if multi-instance Cloud Run."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(500).json({ ok: false, error: message, detail: deliverooAxiosDetail(error) });
  }
});

/** Portal / browser URL checks use GET; Deliveroo callbacks are POST only. */
const webhookProbe = (_req: express.Request, res: express.Response): void => {
  res.status(200).json({
    ok: true,
    endpoint: "/webhooks/deliveroo",
    methods: ["POST"],
    note: "Configure Menu Events in Developer Portal to POST here. GET only confirms the URL is reachable."
  });
};

app.get("/webhooks/deliveroo", webhookProbe);
app.head("/webhooks/deliveroo", (_req, res) => {
  res.status(200).end();
});

app.post("/webhooks/deliveroo", async (req, res) => {
  const inboundBase = (): Omit<WebhookInboundLog, "at" | "responseStatus"> => ({
    method: req.method,
    path: req.path,
    payloadType: getHeaderValue(req.headers["x-deliveroo-payload-type"]),
    hmacPresent: Boolean(getHeaderValue(req.headers["x-deliveroo-hmac-sha256"])),
    sequenceGuidPresent: Boolean(getHeaderValue(req.headers["x-deliveroo-sequence-guid"])),
    hmacVerified: false,
    secretConfigured: Boolean(config.deliverooWebhookSecret)
  });

  const finishInbound = (entry: WebhookInboundLog): void => {
    appendWebhookInbound(entry);
    console.log(JSON.stringify({ msg: "deliveroo.webhook.inbound", ...entry }));
  };

  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const headers = req.headers;
    const sequenceGuid = getHeaderValue(headers["x-deliveroo-sequence-guid"]);
    const hmacSha256 = getHeaderValue(headers["x-deliveroo-hmac-sha256"]);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody.toString("utf-8")) as Record<string, unknown>;
    } catch {
      finishInbound({
        ...inboundBase(),
        at: new Date().toISOString(),
        responseStatus: 400,
        error: "invalid json body"
      });
      res.status(400).json({ ok: false, error: "invalid json body" });
      return;
    }

    if (isMenuUploadResultEvent(parsed, headers)) {
      const webhookVersion = getHeaderValue(headers["x-deliveroo-webhook-version"]);
      if (webhookVersion && webhookVersion !== "1") {
        finishInbound({
          ...inboundBase(),
          at: new Date().toISOString(),
          responseStatus: 400,
          event: String(parsed.event ?? ""),
          error: "unsupported webhook version"
        });
        res.status(400).json({ ok: false, error: "unsupported webhook version" });
        return;
      }

      const hmacOk = verifyDeliverooWebhookHmac(rawBody, sequenceGuid, hmacSha256, false);
      if (!hmacOk) {
        finishInbound({
          ...inboundBase(),
          at: new Date().toISOString(),
          responseStatus: 401,
          event: String(parsed.event ?? ""),
          hmacVerified: false,
          error: "invalid menu webhook signature"
        });
        res.status(401).json({ ok: false, error: "invalid menu webhook signature" });
        return;
      }

      const idempotencyKey = sequenceGuid || crypto.randomUUID();
      if (!rememberOnce(`menu:${idempotencyKey}`)) {
        finishInbound({
          ...inboundBase(),
          at: new Date().toISOString(),
          responseStatus: 200,
          event: String(parsed.event ?? ""),
          hmacVerified: true,
          duplicate: true
        });
        res.status(200).json({ ok: true, duplicate: true, kind: "menu_event" });
        return;
      }

      const bodyNode = toRecord(parsed.body);
      const uploadResult = toRecord(bodyNode.menu_upload_result);
      const siteIds = Array.isArray(uploadResult.site_ids)
        ? uploadResult.site_ids.filter((id): id is string => typeof id === "string")
        : undefined;
      const { processingError, imageErrors, barcodeErrors } = parseMenuUploadErrors(uploadResult);

      const normalized: NormalizedMenuEvent = {
        channel: "deliveroo",
        eventId: idempotencyKey,
        eventType: "menu.upload_result",
        menuId: typeof uploadResult.menu_id === "string" ? uploadResult.menu_id : undefined,
        brandId: typeof uploadResult.brand_id === "string" ? uploadResult.brand_id : undefined,
        siteIds,
        httpStatus:
          typeof uploadResult.http_status === "number" ? uploadResult.http_status : undefined,
        processingError,
        imageErrors,
        barcodeErrors,
        occurredAt: new Date().toISOString(),
        payload: parsed
      };

      console.log(
        JSON.stringify({
          msg: "deliveroo.webhook.menu.upload_result",
          menuId: normalized.menuId,
          brandId: normalized.brandId,
          httpStatus: normalized.httpStatus,
          processingError: normalized.processingError,
          imageErrors: normalized.imageErrors
        })
      );

      recordMenuWebhook(normalized);

      finishInbound({
        ...inboundBase(),
        at: normalized.occurredAt,
        responseStatus: 200,
        event: normalized.eventType,
        menuId: normalized.menuId,
        menuHttpStatus: normalized.httpStatus,
        processingError: normalized.processingError,
        imageErrors: normalized.imageErrors,
        barcodeErrors: normalized.barcodeErrors,
        hmacVerified: true
      });

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
    const orderHmacOk = verifyDeliverooWebhookHmac(rawBody, sequenceGuid, hmacSha256, legacyPos);
    if (!orderHmacOk) {
      finishInbound({
        ...inboundBase(),
        at: new Date().toISOString(),
        responseStatus: 401,
        event: String(parsed.event_type ?? parsed.type ?? ""),
        error: "invalid webhook signature"
      });
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

    finishInbound({
      ...inboundBase(),
      at: new Date().toISOString(),
      responseStatus: 200,
      event: eventType,
      hmacVerified: orderHmacOk
    });

    await forwardToOwnSystem(normalized, "order_event");
    res.status(200).json({ ok: true, kind: "order_event", eventId, orderId, eventType });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    finishInbound({
      ...inboundBase(),
      at: new Date().toISOString(),
      responseStatus: 500,
      error: message
    });
    res.status(500).json({ ok: false, error: message });
  }
});

app.listen(config.port, () => {
  console.log(`deliveroo-test-connector listening on :${config.port}`);
});
