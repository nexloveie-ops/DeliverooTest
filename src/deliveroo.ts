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

type OAuthTokenResponse = {
  access_token: string;
  expires_in: number;
};

type SiteBrandResponse = {
  id: string;
  brand_id?: string[] | string;
};

type UploadSiteOptions = {
  siteId?: string;
  siteDrnId?: string;
};

type SiteContext = {
  siteId: string;
  brandId: string;
};

const accessTokenCache: { token: string; expiresAtMs: number } = {
  token: "",
  expiresAtMs: 0
};

const brandIdCache: { value: string } = {
  value: ""
};

const getAccessToken = async (): Promise<string> => {
  if (Date.now() < accessTokenCache.expiresAtMs && accessTokenCache.token) {
    return accessTokenCache.token;
  }
  if (!config.deliverooClientId || !config.deliverooClientSecret) {
    throw new Error("DELIVEROO_CLIENT_ID or DELIVEROO_CLIENT_SECRET is missing");
  }

  const tokenUrl = `${config.deliverooAuthBaseUrl}/oauth2/token`;
  const body = new URLSearchParams({
    client_id: config.deliverooClientId,
    client_secret: config.deliverooClientSecret,
    grant_type: "client_credentials"
  });

  const response = await axios.post<OAuthTokenResponse>(tokenUrl, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
    timeout: 10000
  });

  const token = response.data.access_token;
  const expiresIn = response.data.expires_in ?? 300;
  accessTokenCache.token = token;
  accessTokenCache.expiresAtMs = Date.now() + Math.max(30, expiresIn - 30) * 1000;
  return token;
};

const resolveSiteId = (siteIdOverride?: string): string => {
  const siteId = siteIdOverride || config.deliverooSiteId || config.deliverooLocationId;
  if (!siteId) {
    throw new Error("DELIVEROO_SITE_ID (or DELIVEROO_LOCATION_ID) is missing");
  }
  return siteId;
};

const resolveBrandId = async (token: string, siteId: string): Promise<string> => {
  if (config.deliverooBrandId) return config.deliverooBrandId;
  if (brandIdCache.value) return brandIdCache.value;

  const url = `${config.deliverooBaseUrl}/site/v1/restaurant_locations/${siteId}`;
  const response = await axios.get<SiteBrandResponse>(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    },
    timeout: 10000
  });

  const rawBrand = response.data.brand_id;
  const brandId = Array.isArray(rawBrand) ? rawBrand[0] : rawBrand;
  if (!brandId || typeof brandId !== "string") {
    throw new Error("Could not resolve brand_id from restaurant location");
  }

  brandIdCache.value = brandId;
  return brandId;
};

const resolveMenuId = (siteId: string): string => {
  return config.deliverooMenuId || `test-menu-${siteId}`;
};

const resolveSiteContext = async (
  token: string,
  options?: UploadSiteOptions
): Promise<SiteContext> => {
  const initialSiteId = resolveSiteId(options?.siteId);
  if (!options?.siteDrnId) {
    return {
      siteId: initialSiteId,
      brandId: await resolveBrandId(token, initialSiteId)
    };
  }

  // Try direct lookup first, in case site DRN is accepted as restaurant location id.
  try {
    const directUrl = `${config.deliverooBaseUrl}/site/v1/restaurant_locations/${options.siteDrnId}`;
    const directResponse = await axios.get<SiteBrandResponse>(directUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 10000
    });
    const directSiteId = directResponse.data.id;
    if (directSiteId) {
      return {
        siteId: directSiteId,
        brandId: await resolveBrandId(token, directSiteId)
      };
    }
  } catch {
    // Fall back to brand sites listing below.
  }

  const brandId = await resolveBrandId(token, initialSiteId);
  const sitesUrl = `${config.deliverooBaseUrl}/site/v1/brands/${brandId}/sites`;
  const sitesResponse = await axios.get(sitesUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    timeout: 10000
  });
  const root = toRecord(sitesResponse.data);
  const list = Array.isArray(root.sites) ? root.sites : Array.isArray(sitesResponse.data) ? sitesResponse.data : [];

  const matched = list.find((site) => {
    const node = toRecord(site);
    const drn =
      asString(node.drn_id) ??
      asString(node.site_drn_id) ??
      asString(node.drn) ??
      asString(node.restaurant_drn) ??
      asString(node.restaurant_location_drn);
    const id =
      asString(node.id) ??
      asString(node.site_id) ??
      asString(node.restaurant_location_id) ??
      asString(node.location_id);
    return drn === options.siteDrnId || id === options.siteDrnId;
  });

  const matchedNode = toRecord(matched);
  const resolvedSiteId =
    asString(matchedNode.id) ??
    asString(matchedNode.site_id) ??
    asString(matchedNode.restaurant_location_id) ??
    asString(matchedNode.location_id);

  // If scenario DRN cannot be resolved from the sites listing, continue with configured/default site.
  // This prevents hard-fail before Upload Menu call and still allows scenario-aligned calls when mapping exists.
  const fallbackSiteId = initialSiteId;

  return { siteId: resolvedSiteId ?? fallbackSiteId, brandId };
};

type UploadMenuOptions = {
  menuId?: string;
  siteId?: string;
  siteDrnId?: string;
  payload?: unknown;
};

export const uploadDeliverooMenu = async (options?: UploadMenuOptions): Promise<unknown> => {
  const token = await getAccessToken();
  const context = await resolveSiteContext(token, {
    siteId: options?.siteId,
    siteDrnId: options?.siteDrnId
  });
  const siteId = context.siteId;
  const brandId = context.brandId;
  const menuId = options?.menuId ?? resolveMenuId(siteId);

  const defaultPayload = {
    name: menuId,
    site_ids: [siteId],
    menu: {
      categories: [
        {
          id: "cat-main",
          name: { en: "Main" },
          item_ids: ["item-burger", "item-wrap"]
        },
        {
          id: "cat-special",
          name: { en: "Specials" },
          item_ids: ["item-burger"]
        }
      ],
      items: [
        {
          id: "item-burger",
          type: "ITEM",
          name: { en: "Test Burger" },
          description: { en: "Sandbox test item" },
          price_info: { price: 1000 },
          tax_rate: "13.5",
          plu: "TB001",
          modifier_ids: ["mod-spice", "mod-extra"],
          diets: ["vegetarian"],
          allergies: [],
          classifications: [],
          contains_alcohol: false,
          highlights: [],
          external_data: "",
          barcodes: [],
          image: {},
          nutritional_info: {},
          is_eligible_as_replacement: true,
          is_eligible_for_substitution: true,
          is_meal_card_not_eligible: false,
          max_quantity: null,
          operational_name: "test-burger"
        },
        {
          id: "item-wrap",
          type: "ITEM",
          name: { en: "Test Wrap" },
          description: { en: "Second menu item for scenario validation" },
          price_info: { price: 900 },
          tax_rate: "13.5",
          plu: "TW001",
          modifier_ids: ["mod-extra"],
          diets: ["vegan"],
          allergies: [],
          classifications: [],
          contains_alcohol: false,
          highlights: [],
          external_data: "",
          barcodes: [],
          image: {},
          nutritional_info: {},
          is_eligible_as_replacement: true,
          is_eligible_for_substitution: true,
          is_meal_card_not_eligible: false,
          max_quantity: null,
          operational_name: "test-wrap"
        },
        {
          id: "opt-mild",
          type: "CHOICE",
          name: { en: "Mild" },
          description: { en: "Mild spice level" },
          price_info: { price: 0 },
          tax_rate: "13.5",
          plu: "SP001",
          modifier_ids: [],
          diets: [],
          allergies: [],
          classifications: [],
          contains_alcohol: false,
          highlights: [],
          external_data: "",
          barcodes: [],
          image: {},
          nutritional_info: {},
          is_eligible_as_replacement: false,
          is_eligible_for_substitution: true,
          is_meal_card_not_eligible: false,
          max_quantity: 1,
          operational_name: "mild"
        },
        {
          id: "opt-spicy",
          type: "CHOICE",
          name: { en: "Spicy" },
          description: { en: "Hot spice level" },
          price_info: { price: 0 },
          tax_rate: "13.5",
          plu: "SP002",
          modifier_ids: [],
          diets: [],
          allergies: [],
          classifications: [],
          contains_alcohol: false,
          highlights: [],
          external_data: "",
          barcodes: [],
          image: {},
          nutritional_info: {},
          is_eligible_as_replacement: false,
          is_eligible_for_substitution: true,
          is_meal_card_not_eligible: false,
          max_quantity: 1,
          operational_name: "spicy"
        },
        {
          id: "opt-cheese",
          type: "CHOICE",
          name: { en: "Extra Cheese" },
          description: { en: "Add extra cheese" },
          price_info: { price: 100 },
          tax_rate: "13.5",
          plu: "EX001",
          modifier_ids: [],
          diets: ["vegetarian"],
          allergies: [],
          classifications: [],
          contains_alcohol: false,
          highlights: [],
          external_data: "",
          barcodes: [],
          image: {},
          nutritional_info: {},
          is_eligible_as_replacement: false,
          is_eligible_for_substitution: true,
          is_meal_card_not_eligible: false,
          max_quantity: 2,
          operational_name: "extra-cheese"
        },
        {
          id: "opt-bacon",
          type: "CHOICE",
          name: { en: "Extra Bacon" },
          description: { en: "Add extra bacon" },
          price_info: { price: 150 },
          tax_rate: "13.5",
          plu: "EX002",
          modifier_ids: [],
          diets: [],
          allergies: [],
          classifications: [],
          contains_alcohol: false,
          highlights: [],
          external_data: "",
          barcodes: [],
          image: {},
          nutritional_info: {},
          is_eligible_as_replacement: false,
          is_eligible_for_substitution: true,
          is_meal_card_not_eligible: false,
          max_quantity: 2,
          operational_name: "extra-bacon"
        }
      ],
      modifiers: [
        {
          id: "mod-spice",
          name: { en: "Spice Level" },
          description: { en: "Choose one spice level" },
          type: "cooking-instruction",
          min_selection: 1,
          max_selection: 1,
          item_ids: ["opt-mild", "opt-spicy"]
        },
        {
          id: "mod-extra",
          name: { en: "Add Extras" },
          description: { en: "Choose your extras" },
          type: "add-ingredient",
          min_selection: 0,
          max_selection: 2,
          item_ids: ["opt-cheese", "opt-bacon"]
        }
      ],
      mealtimes: [
        {
          id: "all-day",
          name: { en: "All Day" },
          description: { en: "All day menu" },
          category_ids: ["cat-main"],
          image: { url: "https://images.unsplash.com/photo-1550547660-d9450f859349" },
          schedule: [
            { day_of_week: 0, time_periods: [{ start: "00:00:00", end: "23:59:00" }] },
            { day_of_week: 1, time_periods: [{ start: "00:00:00", end: "23:59:00" }] },
            { day_of_week: 2, time_periods: [{ start: "00:00:00", end: "23:59:00" }] },
            { day_of_week: 3, time_periods: [{ start: "00:00:00", end: "23:59:00" }] },
            { day_of_week: 4, time_periods: [{ start: "00:00:00", end: "23:59:00" }] },
            { day_of_week: 5, time_periods: [{ start: "00:00:00", end: "23:59:00" }] },
            { day_of_week: 6, time_periods: [{ start: "00:00:00", end: "23:59:00" }] }
          ]
        }
      ]
    }
  };

  const url = `${config.deliverooBaseUrl}/menu/v1/brands/${brandId}/menus/${menuId}`;
  const response = await axios.put(url, options?.payload ?? defaultPayload, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    timeout: 20000
  });
  return response.data;
};

export const fetchDeliverooMenu = async (): Promise<NormalizedMenuItem[]> => {
  const token = await getAccessToken();
  const siteId = resolveSiteId();
  const brandId = await resolveBrandId(token, siteId);

  const url = `${config.deliverooBaseUrl}/menu/v2/brands/${brandId}/sites/${siteId}/menu`;
  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    },
    timeout: 15000
  });

  const root = toRecord(response.data);
  const menu = toRecord(root.menu);
  const rawItems = Array.isArray(menu.items) ? menu.items : [];
  return rawItems.map((raw): NormalizedMenuItem => {
    const node = toRecord(raw);
    return {
      channel: "deliveroo",
      siteId,
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
