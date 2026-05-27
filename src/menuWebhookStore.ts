import type { NormalizedMenuEvent } from "./types.js";

export type MenuWebhookRecord = {
  menuId: string;
  eventId: string;
  brandId?: string;
  httpStatus?: number;
  occurredAt: string;
};

const byMenuId = new Map<string, MenuWebhookRecord[]>();
const MAX_PER_MENU = 20;

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
