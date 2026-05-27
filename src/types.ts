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

export type ItemUnavailabilitiesResult = {
  method: "POST" | "GET";
  url: string;
  brandId: string;
  siteId: string;
  itemCount?: number;
  deliveroo: unknown;
};

export type Scenario8StepResult = ItemUnavailabilitiesResult & {
  step: 1 | 2;
  itemUnavailabilities: ItemUnavailabilityUpdate[];
};

export type UploadMenuResult = {
  method: "PUT";
  url: string;
  brandId: string;
  siteId: string;
  menuId: string;
  siteIds: string[];
  scenario: string;
  mealtimesCount: number;
  bundlesCount: number;
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
};
