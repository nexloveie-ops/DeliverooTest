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
  occurredAt: string;
  payload: unknown;
};

export type MenuUploadAttempt = {
  uploadIndex: number;
  matchExistingMenu: boolean;
  result?: string;
  deliveroo: unknown;
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
  firstPut?: MenuUploadAttempt;
  secondPut?: MenuUploadAttempt;
};
