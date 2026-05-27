import type { NormalizedMenuEvent } from "./types.js";

export type MenuWebhookRecord = {
  menuId: string;
  eventId: string;
  brandId?: string;
  httpStatus?: number;
  occurredAt: string;
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
    occurredAt: event.occurredAt
  });
  byMenuId.set(event.menuId, list.slice(0, MAX_PER_MENU));
};

export const getMenuWebhookStatus = (
  menuId: string
): { received: boolean; count: number; events: MenuWebhookRecord[] } => {
  const events = byMenuId.get(menuId) ?? [];
  return { received: events.length > 0, count: events.length, events };
};

export const appendWebhookInbound = (entry: WebhookInboundLog): void => {
  recentInbound.unshift(entry);
  if (recentInbound.length > MAX_INBOUND) {
    recentInbound.length = MAX_INBOUND;
  }
};

export const getRecentWebhookInbound = (): WebhookInboundLog[] => [...recentInbound];
