export type NormalizedMenuItem = {
  channel: "deliveroo";
  siteId: string;
  itemId: string;
  name: string;
  description?: string;
  priceMinor?: number;
  currency?: string;
  active?: boolean;
  raw: unknown;
};

export type NormalizedOrderEvent = {
  channel: "deliveroo";
  eventId: string;
  eventType: string;
  orderId: string;
  siteId?: string;
  occurredAt?: string;
  payload: unknown;
};

export type NormalizedMenuEvent = {
  channel: "deliveroo";
  eventId: string;
  eventType: "menu.upload_result";
  menuId?: string;
  brandId?: string;
  siteIds?: string[];
  httpStatus?: number;
  processingError?: string;
  imageErrors?: Array<{ url?: string; message?: string }>;
  barcodeErrors?: Array<{ barcode?: string; message?: string }>;
  occurredAt: string;
  payload: unknown;
};

export type MenuUploadAttempt = {
  uploadIndex: number;
  matchExistingMenu: boolean;
  result?: string;
  deliveroo: unknown;
};

export type ItemAvailabilityStatus = "available" | "unavailable" | "hidden";

export type ItemUnavailabilityUpdate = {
  item_id: string;
  status: ItemAvailabilityStatus;
};

export type ReplaceAllUnavailabilitiesPayload = {
  unavailable_ids: string[];
  hidden_ids: string[];
};

export type ItemUnavailabilitiesResult = {
  method: "POST" | "GET" | "PUT";
  url: string;
  brandId: string;
  siteId: string;
  menuId?: string;
  apiVersion: "v1" | "v2";
  itemCount?: number;
  deliveroo: unknown;
};

export type Scenario8StepResult = ItemUnavailabilitiesResult & {
  step: 1 | 2;
  itemUnavailabilities: ItemUnavailabilityUpdate[];
};

export type Scenario9Diagnose = {
  siteId: string;
  brandId: string;
  menuId: string;
  menuV1ItemIds: string[];
  scenarioItemsOnMenuV1: Record<string, boolean>;
  siteV2ScenarioItems: string[];
};

export type Scenario9GetResult = ItemUnavailabilitiesResult & {
  parsed: ReplaceAllUnavailabilitiesPayload;
  diagnose?: Scenario9Diagnose;
  getAttempts?: number;
  tabletFallbackUsed?: boolean;
};

export type Scenario9PutResult = ItemUnavailabilitiesResult & {
  putBody: ReplaceAllUnavailabilitiesPayload;
  basedOnGet: ReplaceAllUnavailabilitiesPayload;
  tabletFallbackUsed?: boolean;
  getAttempts?: number;
};

export type Scenario10GetResult = Scenario9GetResult;

export type Scenario10PutResult = ItemUnavailabilitiesResult & {
  putBody: ReplaceAllUnavailabilitiesPayload;
  /** Stock state before reset (from GET or tablet defaults). */
  stateBeforeReset: ReplaceAllUnavailabilitiesPayload;
  tabletFallbackUsed?: boolean;
  getAttempts?: number;
};

export type Scenario11PostResult = ItemUnavailabilitiesResult & {
  itemUnavailabilities: ItemUnavailabilityUpdate[];
};

export type Scenario11GetResult = ItemUnavailabilitiesResult & {
  parsed: ReplaceAllUnavailabilitiesPayload;
  expectedAfterMorningReset: ReplaceAllUnavailabilitiesPayload;
};

export type Scenario12PostResult = Scenario11PostResult;

export type Scenario12GetResult = ItemUnavailabilitiesResult & {
  parsed: ReplaceAllUnavailabilitiesPayload;
  expectedAfterSiteOpen: ReplaceAllUnavailabilitiesPayload;
};

export type Scenario13PostResult = Scenario11PostResult;

/** Scenario 14: Menu V3 PUT presign only (Generate S3 upload URL). */
export type Scenario14S3UploadUrlResult = {
  method: "PUT";
  url: string;
  brandId: string;
  siteId: string;
  menuId: string;
  /** Presigned URL from Deliveroo (`upload_url` or `s3_url`). */
  uploadUrl: string;
  version?: string;
  deliveroo: unknown;
};

export type MenuWebhookWaitSummary = {
  received: boolean;
  waitedMs: number;
  latestHttpStatus?: number;
  events: Array<{
    eventId: string;
    httpStatus?: number;
    occurredAt: string;
    processingError?: string;
  }>;
};

export type Scenario13RunResult = {
  upload?: UploadMenuResult;
  webhookWait?: MenuWebhookWaitSummary;
  post?: Scenario13PostResult;
  itemCount?: number;
  error?: string;
};

/** Scenario 17: GET /menu/v3/brands/{brand_id}/menus/{menu_id}. */
export type Scenario17FetchMenuResult = {
  method: "GET";
  url: string;
  brandId: string;
  siteId: string;
  menuId: string;
  s3Url?: string;
  version?: string;
  deliveroo: unknown;
};

/** Scenario 16: GET /menu/v3/brands/{brand_id}/jobs/{job_id}. */
export type Scenario16JobStatusResult = {
  method: "GET";
  url: string;
  brandId: string;
  jobId: string;
  status?: string;
  deliveroo: unknown;
};

/** Scenario 15: Menu V3 S3 upload + publish job + menu.upload_result webhook. */
export type Scenario15RunResult = {
  brandId?: string;
  siteId?: string;
  menuId?: string;
  upload?: {
    presignUrl: string;
    s3HttpStatus: number;
    version?: string;
    jobId?: string;
    jobStatus?: string;
    jobAttempts?: number;
    bodyJsonBytes: number;
  };
  webhookWait?: MenuWebhookWaitSummary;
  error?: string;
};

export type MenuV3UploadSummary = {
  s3Url?: string;
  version?: string;
  jobId?: string;
  jobStatus?: string;
  jobPollAttempts?: number;
  s3HttpStatus?: number;
  /** Last GET /v3/.../jobs/{id} body when polling. */
  jobDeliveroo?: unknown;
};

import type { Scenario13PayloadDiagnose } from "./scenario13Diagnose.js";

export type { Scenario13PayloadDiagnose };

export type UploadMenuResult = {
  method: "PUT" | "V3";
  /** `v1` direct PUT; `v3` S3 + publish job (large menus). */
  uploadPath?: "v1" | "v3";
  url: string;
  brandId: string;
  siteId: string;
  menuId: string;
  siteIds: string[];
  scenario: string;
  mealtimesCount: number;
  bundlesCount: number;
  /** Scenario 13: ITEM rows in PUT body. */
  itemCount?: number;
  /** True when Deliveroo returns `"result": "MATCH_EXISTING_MENU"` (Scenario 5). */
  matchExistingMenu: boolean;
  result?: string;
  deliveroo: unknown;
  /** Present when `doubleUpload` runs two byte-identical PUTs for Scenario 5. */
  doubleUpload?: boolean;
  /** `get` = mutated from GET menu; `template` = built mealtimes JSON (new menu only). */
  bodySource?: "get" | "template";
  firstPut?: MenuUploadAttempt;
  secondPut?: MenuUploadAttempt;
  /** Scenario 6: unique revision baked into item prices/descriptions. */
  menuRevision?: string;
  /** SHA-256 of GET menu before PUT (Scenario 6). */
  storedMenuSha256?: string;
  /** SHA-256 of PUT body bytes (Scenario 6). */
  uploadBodySha256?: string;
  /** False only when PUT body matched stored GET bytes (Portal will reject). */
  payloadDiffersFromStored?: boolean;
  /** Scenario 6: `minimal-template` (default) or `mutate` (explicit strategy). */
  webhookPayloadShape?: "mutate" | "minimal-template";
  /** Present when uploadPath is v3. */
  v3?: MenuV3UploadSummary;
  /** Scenario 13: pre-upload payload checks. */
  payloadDiagnose?: Scenario13PayloadDiagnose;
};
