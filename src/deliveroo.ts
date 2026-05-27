import axios from "axios";
import { config } from "./config.js";
import type { NormalizedMenuItem } from "./types.js";

type UnknownRecord = Record<string, unknown>;

const toRecord = (value: unknown): UnknownRecord => {
  if (value && typeof value === "object") {
    return value as UnknownRecord;
  }
  return {};
};

const asString = (value: unknown): string | undefined => {
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const asNumber = (value: unknown): number | undefined => {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const detectMenuItems = (payload: unknown): unknown[] => {
  if (Array.isArray(payload)) return payload;
  const top = toRecord(payload);
  const candidates = ["items", "menu_items", "products", "data"];
  for (const key of candidates) {
    const value = top[key];
    if (Array.isArray(value)) return value;
  }
  return [];
};

export const fetchDeliverooMenu = async (): Promise<NormalizedMenuItem[]> => {
  if (!config.deliverooApiToken) {
    throw new Error("DELIVEROO_API_TOKEN is missing");
  }
  if (!config.deliverooSiteId) {
    throw new Error("DELIVEROO_SITE_ID is missing");
  }

  const url = `${config.deliverooBaseUrl}/menu/v1/sites/${config.deliverooSiteId}`;
  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${config.deliverooApiToken}`,
      Accept: "application/json"
    },
    timeout: 15000
  });

  const rawItems = detectMenuItems(response.data);
  return rawItems.map((raw): NormalizedMenuItem => {
    const node = toRecord(raw);
    return {
      channel: "deliveroo",
      siteId: config.deliverooSiteId,
      itemId: asString(node.id) ?? asString(node.item_id) ?? "unknown",
      name: asString(node.name) ?? "unknown",
      description: asString(node.description),
      priceMinor: asNumber(node.price_minor) ?? asNumber(node.price),
      currency: asString(node.currency),
      active: typeof node.active === "boolean" ? node.active : undefined,
      raw
    };
  });
};
