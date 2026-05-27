import crypto from "node:crypto";
import axios from "axios";
import { config } from "./config.js";
import {
  buildMenuPayload,
  buildWebhookScenarioPayload,
  buildWebhookUploadBody,
  countBundlesInPayload,
  serializeNoChangeMenuBody,
  type MenuScenario,
  type WebhookUploadBodyStrategy
} from "./menuPayloads.js";
import type {
  ItemAvailabilityStatus,
  ItemUnavailabilityUpdate,
  ItemUnavailabilitiesResult,
  MenuUploadAttempt,
  NormalizedMenuItem,
  Scenario8StepResult,
  UploadMenuResult
} from "./types.js";

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
  /** Milliseconds to wait between first and second PUT (default 10000). */
  delayMs?: number;
  /** Scenario 6: allocate a fresh menu id when the portal omits menuId. */
  generateMenuId?: boolean;
  /** Scenario 6: `template` (default), `mutate` (GET+revision), or `auto`. */
  webhookBodyStrategy?: WebhookUploadBodyStrategy;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const fetchMenuForReplay = async (
  brandId: string,
  menuId: string,
  token: string
): Promise<string> => {
  const getUrl = `${config.deliverooBaseUrl}/menu/v1/brands/${brandId}/menus/${menuId}`;
  const response = await axios.get(getUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    timeout: 20000
  });
  return JSON.stringify(response.data);
};

/** Deliveroo canonical menu JSON (GET) — required for MATCH_EXISTING_MENU on repeat PUT. */
const resolveCanonicalMenuBodyJson = async (
  brandId: string,
  menuId: string,
  siteId: string,
  token: string
): Promise<{ bodyJson: string; source: "get" | "template" }> => {
  try {
    const bodyJson = await fetchMenuForReplay(brandId, menuId, token);
    JSON.parse(bodyJson);
    return { bodyJson, source: "get" };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return {
        bodyJson: serializeNoChangeMenuBody(menuId, siteId),
        source: "template"
      };
    }
    throw error;
  }
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
  const scenario: MenuScenario = options?.scenario ?? "mealtimes";
  let menuId = options?.menuId ?? resolveMenuId(siteId);
  if ((scenario === "webhook" || options?.generateMenuId) && !options?.menuId) {
    menuId = `menu-${Date.now()}`;
  }
  const url = `${config.deliverooBaseUrl}/menu/v1/brands/${brandId}/menus/${menuId}`;
  const menuRevision = scenario === "webhook" ? String(Date.now()) : undefined;

  if (scenario === "nochange" && options?.doubleUpload) {
    const delayMs = options.delayMs ?? 10_000;
    let { bodyJson, source } = await resolveCanonicalMenuBodyJson(brandId, menuId, siteId, token);

    if (source === "template") {
      await putMenuJson(url, token, bodyJson);
      await sleep(delayMs);
      bodyJson = await fetchMenuForReplay(brandId, menuId, token);
      source = "get";
    }

    const menuBody = JSON.parse(bodyJson) as Record<string, unknown>;
    const base = buildUploadResultBase(url, brandId, siteId, menuId, scenario, menuBody);
    const bodySha256 = crypto.createHash("sha256").update(bodyJson).digest("hex");

    const firstDeliveroo = await putMenuJson(url, token, bodyJson);
    await sleep(delayMs);
    const secondDeliveroo = await putMenuJson(url, token, bodyJson);
    const firstPut = toUploadAttempt(1, firstDeliveroo);
    const secondPut = toUploadAttempt(2, secondDeliveroo);

    const result: UploadMenuResult = {
      ...base,
      matchExistingMenu: secondPut.matchExistingMenu,
      result: secondPut.result,
      deliveroo: secondDeliveroo,
      doubleUpload: true,
      bodySource: source,
      firstPut,
      secondPut
    };

    console.log(
      JSON.stringify({
        msg: "deliveroo.menu.upload.double",
        url: result.url,
        menuId: result.menuId,
        siteId: result.siteId,
        bodySource: source,
        delayMs,
        bodySha256,
        firstResult: firstPut.result,
        secondResult: secondPut.result,
        matchExistingMenu: result.matchExistingMenu
      })
    );

    return result;
  }

  let bodySource: "get" | "template" | undefined;
  let deliveroo: unknown;
  let menuBody: Record<string, unknown>;

  if (scenario === "nochange" && !options?.payload) {
    const resolved = await resolveCanonicalMenuBodyJson(brandId, menuId, siteId, token);
    bodySource = resolved.source;
    menuBody = JSON.parse(resolved.bodyJson) as Record<string, unknown>;
    deliveroo = await putMenuJson(url, token, resolved.bodyJson);
  } else if (scenario === "webhook" && !options?.payload) {
    const webhookStrategy = options?.webhookBodyStrategy ?? "template";
    let revision = menuRevision ?? String(Date.now());
    let currentMenuJson: string | undefined;
    let storedMenuSha256: string | undefined;

    try {
      currentMenuJson = await fetchMenuForReplay(brandId, menuId, token);
      storedMenuSha256 = crypto.createHash("sha256").update(currentMenuJson).digest("hex");
    } catch (error) {
      if (!axios.isAxiosError(error) || error.response?.status !== 404) {
        throw error;
      }
    }

    bodySource = currentMenuJson ? "get" : "template";
    let bodyJson = buildWebhookUploadBody(
      menuId,
      siteId,
      revision,
      currentMenuJson,
      webhookStrategy
    );
    if (
      currentMenuJson &&
      bodyJson !== JSON.stringify(buildWebhookScenarioPayload(menuId, siteId, revision))
    ) {
      bodySource = "get";
    } else if (!currentMenuJson) {
      bodySource = "template";
    }

    let uploadBodySha256 = crypto.createHash("sha256").update(bodyJson).digest("hex");
    let payloadDiffersFromStored =
      !storedMenuSha256 || uploadBodySha256 !== storedMenuSha256;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      deliveroo = await putMenuJson(url, token, bodyJson);
      const parsed = parseMenuUploadResult(deliveroo);
      if (!parsed.matchExistingMenu) break;
      revision = String(Date.now() + attempt + 1);
      bodyJson = buildWebhookUploadBody(
        menuId,
        siteId,
        revision,
        currentMenuJson,
        webhookStrategy
      );
      bodySource = currentMenuJson && webhookStrategy === "mutate" ? "get" : "template";
      uploadBodySha256 = crypto.createHash("sha256").update(bodyJson).digest("hex");
      payloadDiffersFromStored = true;
    }

    menuBody = JSON.parse(bodyJson) as Record<string, unknown>;
    const base = buildUploadResultBase(url, brandId, siteId, menuId, scenario, menuBody);
    const uploadResult = parseMenuUploadResult(deliveroo);
    const result: UploadMenuResult = {
      ...base,
      matchExistingMenu: uploadResult.matchExistingMenu,
      result: uploadResult.result,
      deliveroo,
      bodySource,
      menuRevision: revision,
      storedMenuSha256,
      uploadBodySha256,
      payloadDiffersFromStored,
      webhookPayloadShape: currentMenuJson && webhookStrategy === "mutate" ? "mutate" : "minimal-template"
    };

    console.log(
      JSON.stringify({
        msg: "deliveroo.menu.upload",
        method: result.method,
        url: result.url,
        brandId: result.brandId,
        siteId: result.siteId,
        menuId: result.menuId,
        scenario: result.scenario,
        bodySource: result.bodySource,
        matchExistingMenu: result.matchExistingMenu,
        result: result.result,
        payloadDiffersFromStored: result.payloadDiffersFromStored,
        menuRevision: result.menuRevision
      })
    );

    return result;
  } else {
    const body =
      options?.payload ?? buildMenuPayload(menuId, siteId, scenario, menuRevision);
    menuBody = toRecord(body);
    deliveroo = (
      await axios.put(url, body, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        timeout: 20000
      })
    ).data;
  }

  const base = buildUploadResultBase(url, brandId, siteId, menuId, scenario, menuBody);
  const uploadResult = parseMenuUploadResult(deliveroo);
  const result: UploadMenuResult = {
    ...base,
    matchExistingMenu: uploadResult.matchExistingMenu,
    result: uploadResult.result,
    deliveroo,
    bodySource,
    menuRevision
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

/** Scenario 8 portal menu item IDs (auto-created when the scenario starts). */
export const SCENARIO8_ITEM_IDS = ["orange_juice", "granola", "whole_milk"] as const;

export const SCENARIO8_STEP1: ItemUnavailabilityUpdate[] = [
  { item_id: "orange_juice", status: "unavailable" },
  { item_id: "granola", status: "unavailable" }
];

export const SCENARIO8_STEP2: ItemUnavailabilityUpdate[] = [
  { item_id: "orange_juice", status: "available" },
  { item_id: "whole_milk", status: "unavailable" }
];

const isItemAvailabilityStatus = (value: unknown): value is ItemAvailabilityStatus =>
  value === "available" || value === "unavailable" || value === "hidden";

export const parseItemUnavailabilityUpdates = (
  value: unknown
): ItemUnavailabilityUpdate[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const updates: ItemUnavailabilityUpdate[] = [];
  for (const raw of value) {
    const node = toRecord(raw);
    const itemId = asString(node.item_id);
    const status = node.status;
    if (!itemId || !isItemAvailabilityStatus(status)) return undefined;
    updates.push({ item_id: itemId, status });
  }
  return updates.length > 0 ? updates : undefined;
};

type UnavailabilitySiteOptions = {
  siteId?: string;
  siteDrnId?: string;
  /** Portal Scenario 8 menu id — required for v1 (recommended for scenario validation). */
  menuId?: string;
  apiVersion?: "v1" | "v2";
};

const SCENARIO8_RATE_LIMIT_MS = 900;

const itemUnavailabilitiesV2Url = (brandId: string, siteId: string): string =>
  `${config.deliverooBaseUrl}/menu/v2/brands/${brandId}/sites/${siteId}/menu/item_unavailabilities`;

const itemUnavailabilitiesV1Url = (brandId: string, menuId: string, siteId: string): string =>
  `${config.deliverooBaseUrl}/menu/v1/brands/${brandId}/menus/${menuId}/item_unavailabilities/${siteId}`;

const resolveUnavailabilityTarget = async (
  token: string,
  options?: UnavailabilitySiteOptions
): Promise<{ siteId: string; brandId: string; menuId?: string; apiVersion: "v1" | "v2"; url: string }> => {
  const { siteId, brandId } = await resolveSiteContext(token, options);
  const menuId = options?.menuId?.trim();
  const apiVersion = options?.apiVersion ?? (menuId ? "v1" : "v2");
  if (apiVersion === "v1") {
    if (!menuId) {
      throw new Error("menuId is required for v1 item unavailabilities (use Portal Scenario 8 menu_id)");
    }
    return {
      siteId,
      brandId,
      menuId,
      apiVersion: "v1",
      url: itemUnavailabilitiesV1Url(brandId, menuId, siteId)
    };
  }
  return {
    siteId,
    brandId,
    apiVersion: "v2",
    url: itemUnavailabilitiesV2Url(brandId, siteId)
  };
};

export const getItemUnavailabilities = async (
  options?: UnavailabilitySiteOptions
): Promise<ItemUnavailabilitiesResult> => {
  const token = await getAccessToken();
  const target = await resolveUnavailabilityTarget(token, options);
  const response = await axios.get(target.url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    timeout: 15000
  });
  return {
    method: "GET",
    url: target.url,
    brandId: target.brandId,
    siteId: target.siteId,
    menuId: target.menuId,
    apiVersion: target.apiVersion,
    deliveroo: response.data
  };
};

export const updateItemUnavailabilities = async (
  itemUnavailabilities: ItemUnavailabilityUpdate[],
  options?: UnavailabilitySiteOptions
): Promise<ItemUnavailabilitiesResult> => {
  if (itemUnavailabilities.length === 0) {
    throw new Error("item_unavailabilities must contain at least one item");
  }
  const token = await getAccessToken();
  const target = await resolveUnavailabilityTarget(token, options);
  const response = await axios.post(
    target.url,
    { item_unavailabilities: itemUnavailabilities },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      timeout: 15000
    }
  );

  console.log(
    JSON.stringify({
      msg: "deliveroo.menu.item_unavailabilities",
      method: "POST",
      url: target.url,
      apiVersion: target.apiVersion,
      brandId: target.brandId,
      siteId: target.siteId,
      menuId: target.menuId,
      itemIds: itemUnavailabilities.map((item) => item.item_id)
    })
  );

  return {
    method: "POST",
    url: target.url,
    brandId: target.brandId,
    siteId: target.siteId,
    menuId: target.menuId,
    apiVersion: target.apiVersion,
    itemCount: itemUnavailabilities.length,
    deliveroo: response.data
  };
};

export const runScenario8Unavailabilities = async (
  options?: UnavailabilitySiteOptions & { step?: "1" | "2" | "both" }
): Promise<{ step1?: Scenario8StepResult; step2?: Scenario8StepResult }> => {
  const step = options?.step ?? "both";
  if (!options?.menuId?.trim()) {
    throw new Error(
      "menuId is required for Scenario 8 (same menu_id as Portal; uses v1 POST .../menus/{menuId}/item_unavailabilities/{siteId})"
    );
  }
  const siteOpts: UnavailabilitySiteOptions = {
    siteId: options.siteId,
    siteDrnId: options.siteDrnId,
    menuId: options.menuId,
    apiVersion: "v1"
  };
  const out: { step1?: Scenario8StepResult; step2?: Scenario8StepResult } = {};

  if (step === "1" || step === "both") {
    const result = await updateItemUnavailabilities(SCENARIO8_STEP1, siteOpts);
    out.step1 = { ...result, step: 1, itemUnavailabilities: SCENARIO8_STEP1 };
  }

  if (step === "both") {
    await sleep(SCENARIO8_RATE_LIMIT_MS);
  }

  if (step === "2" || step === "both") {
    const result = await updateItemUnavailabilities(SCENARIO8_STEP2, siteOpts);
    out.step2 = { ...result, step: 2, itemUnavailabilities: SCENARIO8_STEP2 };
  }

  return out;
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
