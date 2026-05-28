import {
  buildScenario13LargeMenuPayload,
  SCENARIO13_CATEGORY_COUNT,
  SCENARIO13_ITEM_COUNT
} from "./menuPayloads.js";

type UnknownRecord = Record<string, unknown>;

const toRecord = (value: unknown): UnknownRecord =>
  value && typeof value === "object" ? (value as UnknownRecord) : {};

export type Scenario13PayloadDiagnose = {
  itemCount: number;
  categoryCount: number;
  bodyBytes: number;
  menuFields: {
    currency_code?: string;
    is_pos_integrated?: unknown;
  };
  mealtime: {
    count: number;
    hasCoverUrl: boolean;
    scheduleLength: number;
  };
  itemStats: {
    missingFeesArray: number;
    emptyImageObject: number;
  };
  categoryStats: {
    missingDescription: number;
  };
  warnings: string[];
  ok: boolean;
};

/** Local checks before upload — does not call Deliveroo. */
export const diagnoseScenario13Payload = (
  payload: Record<string, unknown>
): Scenario13PayloadDiagnose => {
  const bodyJson = JSON.stringify(payload);
  const menu = toRecord(payload.menu);
  const items = Array.isArray(menu.items) ? menu.items : [];
  const categories = Array.isArray(menu.categories) ? menu.categories : [];
  const mealtimes = Array.isArray(menu.mealtimes) ? menu.mealtimes : [];

  let missingFeesArray = 0;
  let emptyImageObject = 0;
  for (const raw of items) {
    const item = toRecord(raw);
    if (item.type !== "ITEM") continue;
    const priceInfo = toRecord(item.price_info);
    if (!Array.isArray(priceInfo.fees)) missingFeesArray += 1;
    const image = item.image;
    if (image && typeof image === "object" && Object.keys(toRecord(image)).length === 0) {
      emptyImageObject += 1;
    }
  }

  let missingDescription = 0;
  for (const raw of categories) {
    const cat = toRecord(raw);
    const desc = toRecord(cat.description);
    const en = desc.en;
    if (typeof en !== "string" || en.length < 3) missingDescription += 1;
  }

  const warnings: string[] = [];
  const itemCount = items.filter((raw) => toRecord(raw).type === "ITEM").length;

  if (itemCount < SCENARIO13_ITEM_COUNT) {
    warnings.push(
      `itemCount ${itemCount} < ${SCENARIO13_ITEM_COUNT} (Portal needs ≥100; use ?itemCount=100 or omit for A/B only)`
    );
  }
  if (!menu.currency_code) warnings.push("menu.currency_code missing");
  if (menu.is_pos_integrated === undefined) warnings.push("menu.is_pos_integrated missing");
  if (missingFeesArray > 0) {
    warnings.push(`${missingFeesArray} items missing price_info.fees[] (Deliveroo examples include fees)`);
  }
  if (missingDescription > 0) {
    warnings.push(`${missingDescription} categories missing description.en (≥3 chars per guidelines)`);
  }

  const meal = mealtimes[0] ? toRecord(mealtimes[0]) : {};
  const mealImage = toRecord(meal.image);
  const hasCoverUrl = typeof mealImage.url === "string" && mealImage.url.length > 0;
  if (!hasCoverUrl) warnings.push("mealtime cover image url missing (API may return 400)");

  return {
    itemCount,
    categoryCount: categories.length,
    bodyBytes: Buffer.byteLength(bodyJson, "utf8"),
    menuFields: {
      currency_code:
        typeof menu.currency_code === "string" ? menu.currency_code : undefined,
      is_pos_integrated: menu.is_pos_integrated
    },
    mealtime: {
      count: mealtimes.length,
      hasCoverUrl,
      scheduleLength: Array.isArray(meal.schedule) ? meal.schedule.length : 0
    },
    itemStats: { missingFeesArray, emptyImageObject },
    categoryStats: { missingDescription },
    warnings,
    ok: warnings.length === 0 || warnings.every((w) => w.includes("itemCount"))
  };
};

export const buildScenario13PayloadForDiagnose = (
  menuId: string,
  siteId: string,
  itemCount?: number
): { payload: Record<string, unknown>; diagnose: Scenario13PayloadDiagnose } => {
  const payload = buildScenario13LargeMenuPayload(menuId, siteId, String(Date.now()), {
    itemCount
  });
  return { payload, diagnose: diagnoseScenario13Payload(payload) };
};
