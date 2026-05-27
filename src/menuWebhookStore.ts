import type { NormalizedMenuEvent } from "./types.js";

export type MenuWebhookRecord = {
  menuId: string;
  eventId: string;
  brandId?: string;
  httpStatus?: number;
  occurredAt: string;
  processingError?: string;
  imageErrors?: Array<{ url?: string; message?: string }>;
};

export type WebhookInboundLog = {
  at: string;
  method: string;
  path: string;
  responseStatus: number;
  payloadType?: string;
  event?: string;
  menuId?: string;
  menuHttpStatus?: number;
  processingError?: string;
  imageErrors?: Array<{ url?: string; message?: string }>;
  hmacPresent: boolean;
  sequenceGuidPresent: boolean;
  hmacVerified: boolean;
  secretConfigured: boolean;
  error?: string;
  duplicate?: boolean;
};

const byMenuId = new Map<string, MenuWebhookRecord[]>();
const recentInbound: WebhookInboundLog[] = [];
const MAX_PER_MENU = 20;
const MAX_INBOUND = 50;

export const recordMenuWebhook = (event: NormalizedMenuEvent): void => {
  if (!event.menuId) return;
  const list = byMenuId.get(event.menuId) ?? [];
  list.unshift({
    menuId: event.menuId,
    eventId: event.eventId,
    brandId: event.brandId,
    httpStatus: event.httpStatus,
    occurredAt: event.occurredAt,
    processingError: event.processingError,
    imageErrors: event.imageErrors
  });
  byMenuId.set(event.menuId, list.slice(0, MAX_PER_MENU));
};

export const getMenuWebhookStatus = (
  menuId: string
): { received: boolean; count: number; events: MenuWebhookRecord[] } => {
  const events = byMenuId.get(menuId) ?? [];
  return { received: events.length > 0, count: events.length, events };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Poll in-memory webhook store until menu.upload_result (Scenario 13 / 6). */
export const waitForMenuUploadWebhook = async (
  menuId: string,
  options?: { timeoutMs?: number; pollMs?: number; requireHttp200?: boolean }
): Promise<{
  received: boolean;
  events: MenuWebhookRecord[];
  waitedMs: number;
  latestHttpStatus?: number;
}> => {
  const timeoutMs = options?.timeoutMs ?? 90_000;
  const pollMs = options?.pollMs ?? 2_000;
  const requireHttp200 = options?.requireHttp200 ?? true;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const { events } = getMenuWebhookStatus(menuId);
    const latest = events[0];
    if (latest) {
      const ok = !requireHttp200 || latest.httpStatus === 200 || latest.httpStatus === undefined;
      if (ok) {
        return {
          received: true,
          events,
          waitedMs: Date.now() - start,
          latestHttpStatus: latest.httpStatus
        };
      }
    }
    await sleep(pollMs);
  }

  const { events } = getMenuWebhookStatus(menuId);
  return {
    received: false,
    events,
    waitedMs: Date.now() - start,
    latestHttpStatus: events[0]?.httpStatus
  };
};

export const appendWebhookInbound = (entry: WebhookInboundLog): void => {
  recentInbound.unshift(entry);
  if (recentInbound.length > MAX_INBOUND) {
    recentInbound.length = MAX_INBOUND;
  }
};

export const getRecentWebhookInbound = (): WebhookInboundLog[] => [...recentInbound];
