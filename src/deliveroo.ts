import axios from "axios";
import { config } from "./config.js";
import {
  buildMenuPayload,
  countBundlesInPayload,
  serializeScenario5MenuBody,
  type MenuScenario
} from "./menuPayloads.js";
import type { MenuUploadAttempt, NormalizedMenuItem, UploadMenuResult } from "./types.js";

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

const parseMenuUploadResult = (
  data: unknown
): { matchExistingMenu: boolean; result?: string } => {
  const result = asString(toRecord(data).result);
  return {
    matchExistingMenu: result === "MATCH_EXISTING_MENU",
    result
  };
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
  scenario?: MenuScenario;
  payload?: unknown;
  /** Scenario 5: two PUTs with the same JSON bytes (first + second identical upload). */
  doubleUpload?: boolean;
};

const putMenuJson = async (
  url: string,
  token: string,
  bodyJson: string
): Promise<unknown> => {
  const response = await axios.put(url, bodyJson, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    timeout: 20000,
    transformRequest: [(data) => data]
  });
  return response.data;
};

const toUploadAttempt = (uploadIndex: number, deliveroo: unknown): MenuUploadAttempt => {
  const parsed = parseMenuUploadResult(deliveroo);
  return {
    uploadIndex,
    matchExistingMenu: parsed.matchExistingMenu,
    result: parsed.result,
    deliveroo
  };
};

const buildUploadResultBase = (
  url: string,
  brandId: string,
  siteId: string,
  menuId: string,
  scenario: MenuScenario,
  menuBody: Record<string, unknown>
): Omit<UploadMenuResult, "matchExistingMenu" | "result" | "deliveroo"> => {
  const menuSection = toRecord(menuBody.menu);
  const mealtimesCount = Array.isArray(menuSection.mealtimes) ? menuSection.mealtimes.length : 0;
  const bundlesCount = countBundlesInPayload(menuBody);
  const siteIds = Array.isArray(menuBody.site_ids)
    ? menuBody.site_ids.filter((id): id is string => typeof id === "string")
    : [siteId];

  return {
    method: "PUT",
    url,
    brandId,
    siteId,
    menuId,
    siteIds,
    scenario,
    mealtimesCount,
    bundlesCount
  };
};

export const uploadDeliverooMenu = async (options?: UploadMenuOptions): Promise<UploadMenuResult> => {
  const token = await getAccessToken();
  const context = await resolveSiteContext(token, {
    siteId: options?.siteId,
    siteDrnId: options?.siteDrnId
  });
  const siteId = options?.siteId ?? context.siteId ?? config.deliverooLocationId;
  const brandId = context.brandId;
  const menuId = options?.menuId ?? resolveMenuId(siteId);
  const scenario: MenuScenario = options?.scenario ?? "mealtimes";
  const url = `${config.deliverooBaseUrl}/menu/v1/brands/${brandId}/menus/${menuId}`;

  if (scenario === "nochange" && options?.doubleUpload) {
    const bodyJson = serializeScenario5MenuBody(menuId, siteId);
    const menuBody = JSON.parse(bodyJson) as Record<string, unknown>;
    const base = buildUploadResultBase(url, brandId, siteId, menuId, scenario, menuBody);

    const firstDeliveroo = await putMenuJson(url, token, bodyJson);
    const secondDeliveroo = await putMenuJson(url, token, bodyJson);
    const firstPut = toUploadAttempt(1, firstDeliveroo);
    const secondPut = toUploadAttempt(2, secondDeliveroo);

    const result: UploadMenuResult = {
      ...base,
      matchExistingMenu: secondPut.matchExistingMenu,
      result: secondPut.result,
      deliveroo: secondDeliveroo,
      doubleUpload: true,
      firstPut,
      secondPut
    };

    console.log(
      JSON.stringify({
        msg: "deliveroo.menu.upload.double",
        url: result.url,
        menuId: result.menuId,
        siteId: result.siteId,
        firstResult: firstPut.result,
        secondResult: secondPut.result,
        matchExistingMenu: result.matchExistingMenu
      })
    );

    return result;
  }

  const body =
    options?.payload ??
    (scenario === "nochange"
      ? (JSON.parse(serializeScenario5MenuBody(menuId, siteId)) as Record<string, unknown>)
      : buildMenuPayload(menuId, siteId, scenario));
  const menuBody = toRecord(body);
  const base = buildUploadResultBase(url, brandId, siteId, menuId, scenario, menuBody);
  const bodyJson = scenario === "nochange" ? serializeScenario5MenuBody(menuId, siteId) : JSON.stringify(body);
  const deliveroo =
    scenario === "nochange"
      ? await putMenuJson(url, token, bodyJson)
      : (
          await axios.put(url, body, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              "Content-Type": "application/json"
            },
            timeout: 20000
          })
        ).data;

  const uploadResult = parseMenuUploadResult(deliveroo);
  const result: UploadMenuResult = {
    ...base,
    matchExistingMenu: uploadResult.matchExistingMenu,
    result: uploadResult.result,
    deliveroo
  };

  console.log(
    JSON.stringify({
      msg: "deliveroo.menu.upload",
      method: result.method,
      url: result.url,
      brandId: result.brandId,
      siteId: result.siteId,
      menuId: result.menuId,
      siteIds: result.siteIds,
      scenario: result.scenario,
      mealtimesCount: result.mealtimesCount,
      bundlesCount: result.bundlesCount,
      matchExistingMenu: result.matchExistingMenu,
      result: result.result
    })
  );

  return result;
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
