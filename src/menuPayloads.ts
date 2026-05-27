/**
 * Sandbox menu payloads aligned with Deliveroo Developer Portal scenarios.
 * @see https://api-docs.deliveroo.com/docs/menu-api-guidelines (Bundles)
 * @see https://api-docs.deliveroo.com/docs/menu-api-overview
 */

const TAX_IE = "13.5";

const itemBase = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
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
  diets: [],
  tax_rate: TAX_IE,
  ...overrides
});

const bundleItemOverride = (bundleId: string, price: number): Record<string, unknown> => ({
  id: bundleId,
  price,
  type: "ITEM"
});

export type MenuScenario =
  | "default"
  | "mealtimes"
  | "bundles"
  | "nochange"
  | "webhook"
  | "imagecache"
  | "scenario13";

/** Scenario 13: minimum item count for large-menu upload + webhook gate. */
export const SCENARIO13_ITEM_COUNT = 100;

/** Split across categories — avoids single huge category + image pipeline overload. */
export const SCENARIO13_CATEGORY_COUNT = 10;

export const SCENARIO13_ITEM_ID_PREFIX = "s13-item-";

export const scenario13ItemId = (index: number): string =>
  `${SCENARIO13_ITEM_ID_PREFIX}${String(index).padStart(3, "0")}`;

const revisionPriceBump = (revision: string): number => {
  const numeric = Number(revision);
  if (Number.isFinite(numeric) && numeric > 0) {
    return (numeric % 400) + 17;
  }
  return (parseInt(revision.slice(-6), 36) % 400) + 17;
};

const SERVER_ONLY_MENU_KEYS = new Set([
  "drn_id",
  "currency_code",
  "is_pos_integrated",
  "ian",
  "repeatable"
]);

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** Remove GET-only fields before PUT so Deliveroo treats the body as a real update. */
export const stripServerFieldsFromMenu = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stripServerFieldsFromMenu);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(obj)) {
    if (SERVER_ONLY_MENU_KEYS.has(key)) continue;
    out[key] = stripServerFieldsFromMenu(nested);
  }
  return out;
};

/**
 * Mutate a GET menu (canonical shape) so PUT differs from the live menu — Scenario 6.
 */
export const applyWebhookRevision = (
  menuRoot: Record<string, unknown>,
  revision: string
): Record<string, unknown> => {
  const bump = revisionPriceBump(revision);
  const menu = toRecord(menuRoot.menu);
  const items = Array.isArray(menu.items) ? menu.items : [];

  for (const raw of items) {
    const item = toRecord(raw);
    const itemType = item.type;
    if (itemType !== "ITEM" && itemType !== "BUNDLE" && itemType !== "CHOICE") continue;

    const priceInfo = toRecord(item.price_info);
    const basePrice = typeof priceInfo.price === "number" ? priceInfo.price : 1000;
    item.price_info = { ...priceInfo, price: basePrice + bump };

    const name = toRecord(item.name);
    if (typeof name.en === "string" && !name.en.includes(revision.slice(-6))) {
      name.en = `${name.en} ·${revision.slice(-6)}`;
    }
    const description = toRecord(item.description);
    description.en = `Sandbox item updated at ${revision}`;

    item.external_data = `webhook-rev-${revision}`;
  }

  const categories = Array.isArray(menu.categories) ? menu.categories : [];
  for (const raw of categories) {
    const category = toRecord(raw);
    const name = toRecord(category.name);
    if (typeof name.en === "string") {
      name.en = `${name.en} (${revision.slice(-6)})`;
    }
  }

  const mealtimes = Array.isArray(menu.mealtimes) ? menu.mealtimes : [];
  mealtimes.forEach((raw, index) => {
    const mealtime = toRecord(raw);
    const description = toRecord(mealtime.description);
    description.en = `Menu sync ${revision}`;
    const image = toRecord(mealtime.image);
    image.url = mealtimeCoverForIndex(index);
  });

  return { ...menuRoot, menu };
};

export const buildMenuPayload = (
  menuId: string,
  siteId: string,
  scenario: MenuScenario = "default",
  revision?: string
): Record<string, unknown> => {
  if (scenario === "bundles") {
    return buildBundlesScenarioPayload(menuId, siteId);
  }
  if (scenario === "webhook") {
    return buildWebhookScenarioPayload(menuId, siteId, revision);
  }
  if (scenario === "nochange") {
    return buildMealtimesScenarioPayload(menuId, siteId);
  }
  if (scenario === "mealtimes") {
    return buildMealtimesScenarioPayload(menuId, siteId);
  }
  if (scenario === "imagecache") {
    return buildMealtimesScenarioPayload(menuId, siteId, revision);
  }
  if (scenario === "scenario13") {
    return buildScenario13LargeMenuPayload(menuId, siteId, revision);
  }
  return buildMealtimesScenarioPayload(menuId, siteId);
};

/**
 * Scenario 13: valid menu with ≥100 items (10×10 categories, no per-item images).
 * Per-item image URLs caused Deliveroo async processing http_status 500 in sandbox.
 */
export const buildScenario13LargeMenuPayload = (
  menuId: string,
  siteId: string,
  revision: string = String(Date.now())
): Record<string, unknown> => {
  const revSuffix = revision.slice(-6);
  const items: Record<string, unknown>[] = [];
  const categories: Record<string, unknown>[] = [];
  const categoryIds: string[] = [];
  const itemsPerCategory = SCENARIO13_ITEM_COUNT / SCENARIO13_CATEGORY_COUNT;

  for (let c = 0; c < SCENARIO13_CATEGORY_COUNT; c += 1) {
    const categoryId = `s13-cat-${String(c + 1).padStart(2, "0")}`;
    categoryIds.push(categoryId);
    const categoryItemIds: string[] = [];

    for (let j = 1; j <= itemsPerCategory; j += 1) {
      const i = c * itemsPerCategory + j;
      const id = scenario13ItemId(i);
      categoryItemIds.push(id);
      items.push(
        itemBase({
          id,
          type: "ITEM",
          name: { en: `S13 Item ${i}` },
          description: { en: `Item ${i} (rev ${revSuffix})` },
          operational_name: `s13-${i}`,
          plu: `S13${String(i).padStart(3, "0")}`,
          price_info: { price: 500 + i, overrides: [] },
          modifier_ids: []
        })
      );
    }

    categories.push({
      id: categoryId,
      name: { en: `Category ${c + 1}` },
      item_ids: categoryItemIds
    });
  }

  const mealtimeId = "s13-meal-all-day";

  return {
    name: menuId,
    site_ids: [siteId],
    menu: {
      categories,
      items,
      modifiers: [],
      mealtimes: [
        {
          id: mealtimeId,
          name: { en: "All Day Menu" },
          description: {
            en: `Scenario 13 (${SCENARIO13_ITEM_COUNT} items, rev ${revSuffix})`
          },
          category_ids: categoryIds,
          image: { url: WEBHOOK_MEALTIME_COVER_DAY_URL },
          schedule: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
            day_of_week: day,
            time_periods: [{ start: "00:00:00", end: "23:59:00" }]
          }))
        }
      ]
    }
  };
};

const countMenuItems = (menu: Record<string, unknown>): number => {
  const items = Array.isArray(menu.items) ? menu.items : [];
  return items.filter((raw) => toRecord(raw).type === "ITEM").length;
};

/** Remove mealtime image URLs — async processing often 500s on sandbox image fetch. */
const stripMealtimeImages = (menuRoot: Record<string, unknown>): void => {
  const menu = toRecord(menuRoot.menu);
  const mealtimes = Array.isArray(menu.mealtimes) ? menu.mealtimes : [];
  for (const raw of mealtimes) {
    const mealtime = toRecord(raw);
    mealtime.image = {};
  }
};

/**
 * When menu already has ≥100 ITEMs: mutate prices/names so PUT differs (avoids MATCH_EXISTING_MENU).
 */
export const applyScenario13Revision = (
  menuRoot: Record<string, unknown>,
  revision: string
): Record<string, unknown> => {
  const revised = applyWebhookRevision(menuRoot, revision);
  stripMealtimeImages(revised);
  return revised;
};

/**
 * Extend a GET menu (Portal Start) to ≥100 ITEM rows instead of replacing the whole menu.
 */
export const extendMenuToScenario13 = (
  currentMenuJson: string,
  menuId: string,
  siteId: string,
  revision: string
): Record<string, unknown> | undefined => {
  try {
    const stripped = stripServerFieldsFromMenu(JSON.parse(currentMenuJson)) as Record<string, unknown>;
    const menu = toRecord(stripped.menu);
    if (!menu.items || !menu.categories) return undefined;

    const revSuffix = revision.slice(-6);
    const items = Array.isArray(menu.items) ? [...menu.items] : [];
    const categories = Array.isArray(menu.categories) ? [...menu.categories] : [];
    const existingIds = new Set(
      items.map((raw) => toRecord(raw).id).filter((id): id is string => typeof id === "string")
    );
    const usedPlus = new Set(
      items
        .map((raw) => toRecord(raw).plu)
        .filter((plu): plu is string => typeof plu === "string")
    );

    let nextIndex = 1;
    while (countMenuItems({ items }) < SCENARIO13_ITEM_COUNT) {
      const id = scenario13ItemId(nextIndex);
      nextIndex += 1;
      if (existingIds.has(id)) continue;
      existingIds.add(id);
      let plu = `S13${revSuffix}${String(nextIndex).padStart(3, "0")}`;
      while (usedPlus.has(plu)) {
        plu = `S13${revSuffix}${String(nextIndex).padStart(3, "0")}x`;
      }
      usedPlus.add(plu);
      items.push(
        itemBase({
          id,
          type: "ITEM",
          name: { en: `S13 Item ${id}` },
          description: { en: `Added item (rev ${revSuffix})` },
          operational_name: `s13${String(nextIndex).padStart(3, "0")}`,
          plu,
          price_info: { price: 600 + nextIndex, overrides: [] },
          modifier_ids: []
        })
      );
    }

    const addCategoryId = "s13-cat-added";
    const newItemIds = items
      .map((raw) => toRecord(raw).id)
      .filter((id): id is string => typeof id === "string" && id.startsWith(SCENARIO13_ITEM_ID_PREFIX));

    let targetCategory = categories.find((raw) => toRecord(raw).id === addCategoryId);
    if (!targetCategory) {
      targetCategory = { id: addCategoryId, name: { en: "Scenario 13 Items" }, item_ids: [] };
      categories.push(targetCategory);
    }
    const cat = toRecord(targetCategory);
    const catItemIds = Array.isArray(cat.item_ids)
      ? [...cat.item_ids.filter((id): id is string => typeof id === "string")]
      : [];
    for (const id of newItemIds) {
      if (!catItemIds.includes(id)) catItemIds.push(id);
    }
    cat.item_ids = catItemIds;

    const mealtimes = Array.isArray(menu.mealtimes) ? [...menu.mealtimes] : [];
    for (let m = 0; m < mealtimes.length; m += 1) {
      const meal = toRecord(mealtimes[m]);
      const mealCatIds = Array.isArray(meal.category_ids)
        ? [...meal.category_ids.filter((id): id is string => typeof id === "string")]
        : [];
      if (!mealCatIds.includes(addCategoryId)) mealCatIds.push(addCategoryId);
      meal.category_ids = mealCatIds;
      meal.image = {};
      mealtimes[m] = meal;
    }

    const root = {
      ...stripped,
      name: menuId,
      site_ids: [siteId],
      menu: { ...menu, items, categories, mealtimes, modifiers: menu.modifiers ?? [] }
    };
    return applyScenario13Revision(root, revision);
  } catch {
    return undefined;
  }
};

export type Scenario13BodySource = "get-extended" | "get-revision" | "template";

export const buildScenario13MenuJson = (
  menuId: string,
  siteId: string,
  revision: string,
  currentMenuJson?: string,
  options?: { preferTemplate?: boolean }
): { bodyJson: string; source: Scenario13BodySource; itemCount: number } => {
  if (currentMenuJson && !options?.preferTemplate) {
    try {
      const stripped = stripServerFieldsFromMenu(
        JSON.parse(currentMenuJson)
      ) as Record<string, unknown>;
      const menu = toRecord(stripped.menu);
      const itemCount = countMenuItems(menu);

      if (itemCount >= SCENARIO13_ITEM_COUNT) {
        const revised = applyScenario13Revision(
          { ...stripped, name: menuId, site_ids: [siteId] },
          revision
        );
        const revisedMenu = toRecord(revised.menu);
        return {
          bodyJson: JSON.stringify(revised),
          source: "get-revision",
          itemCount: countMenuItems(revisedMenu)
        };
      }

      const extended = extendMenuToScenario13(currentMenuJson, menuId, siteId, revision);
      if (extended) {
        const extendedMenu = toRecord(extended.menu);
        return {
          bodyJson: JSON.stringify(extended),
          source: "get-extended",
          itemCount: countMenuItems(extendedMenu)
        };
      }
    } catch {
      // Fall through to full template.
    }
  }

  const payload = buildScenario13LargeMenuPayload(menuId, siteId, revision);
  const menu = toRecord(payload.menu);
  return {
    bodyJson: JSON.stringify(payload),
    source: "template",
    itemCount: countMenuItems(menu)
  };
};

/** Stable JPEG covers (curl-verified HTTP 200). Avoid Unsplash + Wikimedia /thumb/ paths. */
export const WEBHOOK_MEALTIME_COVER_DAY_URL =
  "https://placehold.co/800x600.jpg";

export const WEBHOOK_MEALTIME_COVER_EVENING_URL =
  "https://picsum.photos/seed/deliveroo-evening-menu/800/600.jpg";

/** Stable item image URL; HEAD returns ETag for Scenario 7 checks. */
export const ITEM_IMAGE_CACHEABLE_URL = "https://placehold.co/640x480.jpg";

const mealtimeCoverForIndex = (index: number): string =>
  index % 2 === 0 ? WEBHOOK_MEALTIME_COVER_DAY_URL : WEBHOOK_MEALTIME_COVER_EVENING_URL;

/**
 * Scenario 6 minimal menu — matches Portal checklist with no modifiers/bundles.
 * 1 mealtime (cover + name + description), 1 category, 1 item linked via category.item_ids.
 */
export const buildMinimalWebhookScenarioPayload = (
  menuId: string,
  siteId: string,
  revision: string
): Record<string, unknown> => {
  const bump = revisionPriceBump(revision);
  const revSuffix = revision.slice(-6);
  const itemId = "webhook-item-1";
  const categoryId = "webhook-cat-1";
  const mealtimeId = "webhook-meal-1";

  return {
    name: menuId,
    site_ids: [siteId],
    menu: {
      categories: [{ id: categoryId, name: { en: "Main" }, item_ids: [itemId] }],
      items: [
        itemBase({
          id: itemId,
          type: "ITEM",
          name: { en: "Webhook Test Item" },
          description: { en: `Scenario 6 sandbox item (rev ${revSuffix})` },
          operational_name: "webhook-test-item",
          plu: `WH${revSuffix}`,
          price_info: { price: 1000 + bump, overrides: [] },
          modifier_ids: [],
          image: { url: ITEM_IMAGE_CACHEABLE_URL }
        })
      ],
      modifiers: [],
      mealtimes: [
        {
          id: mealtimeId,
          name: { en: "All Day Menu" },
          description: { en: `Webhook scenario mealtime (rev ${revSuffix})` },
          category_ids: [categoryId],
          image: { url: WEBHOOK_MEALTIME_COVER_DAY_URL },
          schedule: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
            day_of_week: day,
            time_periods: [{ start: "00:00:00", end: "23:59:00" }]
          }))
        }
      ]
    }
  };
};

/**
 * Scenario 6 default path: strict minimal payload from portal checklist.
 */
export const buildWebhookScenarioPayload = (
  menuId: string,
  siteId: string,
  revision: string = String(Date.now())
): Record<string, unknown> => buildMinimalWebhookScenarioPayload(menuId, siteId, revision);

export type WebhookUploadBodyStrategy = "template" | "mutate" | "auto";

const buildMutatedMenuJson = (currentMenuJson: string, revision: string): string | undefined => {
  try {
    const current = JSON.parse(currentMenuJson) as Record<string, unknown>;
    const stripped = stripServerFieldsFromMenu(current) as Record<string, unknown>;
    const mutated = applyWebhookRevision(stripped, revision);
    if (!Array.isArray(mutated.site_ids) || mutated.site_ids.length === 0) {
      return undefined;
    }
    if (typeof mutated.name !== "string" || mutated.name.length === 0) {
      return undefined;
    }
    if (!mutated.menu || typeof mutated.menu !== "object") {
      return undefined;
    }
    const mutatedJson = JSON.stringify(mutated);
    const strippedStored = JSON.stringify(stripServerFieldsFromMenu(JSON.parse(currentMenuJson)));
    if (mutatedJson !== currentMenuJson && mutatedJson !== strippedStored) {
      return mutatedJson;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

/**
 * Scenario 6 PUT body.
 * - Default: minimal template (best fit for Portal validation).
 * - Optional mutate mode: only when explicitly requested.
 */
export const buildWebhookUploadBody = (
  menuId: string,
  siteId: string,
  revision: string,
  currentMenuJson?: string,
  strategy: WebhookUploadBodyStrategy = "auto"
): string => {
  const templateJson = JSON.stringify(buildWebhookScenarioPayload(menuId, siteId, revision));

  if (!currentMenuJson || strategy === "template" || strategy === "auto") {
    return templateJson;
  }
  if (strategy === "mutate") {
    const mutatedJson = buildMutatedMenuJson(currentMenuJson, revision);
    if (mutatedJson) {
      return mutatedJson;
    }
  }
  return templateJson;
};

/**
 * Scenario 5: must re-upload the same JSON as Scenario 3 (mealtimes), byte-for-byte.
 * @see https://api-docs.deliveroo.com/docs/menu-api-overview (MATCH_EXISTING_MENU)
 */
export const buildMatchExistingMenuPayload = (
  menuId: string,
  siteId: string
): Record<string, unknown> => buildMealtimesScenarioPayload(menuId, siteId);

/** Stable JSON bytes for two identical PUTs in the Portal scenario window. */
export const serializeMealtimesMenuBody = (menuId: string, siteId: string): string =>
  JSON.stringify(buildMealtimesScenarioPayload(menuId, siteId));

export const serializeNoChangeMenuBody = serializeMealtimesMenuBody;

/** @deprecated Use serializeNoChangeMenuBody */
export const serializeScenario5MenuBody = serializeNoChangeMenuBody;

/** Scenario 3: multiple mealtimes, 7d/24h non-overlapping schedules */
export const buildMealtimesScenarioPayload = (
  menuId: string,
  siteId: string,
  revision?: string
): Record<string, unknown> => {
  const rev = revision ?? "";
  const bump = rev ? revisionPriceBump(rev) : 0;
  const revLabel = rev ? rev.slice(0, 8) : "base";

  return {
  name: menuId,
  site_ids: [siteId],
  menu: {
    categories: [
      { id: "cat-breakfast", name: { en: "Breakfast" }, item_ids: ["item-wrap"] },
      { id: "cat-main", name: { en: "Main" }, item_ids: ["item-burger", "item-wrap"] },
      { id: "cat-special", name: { en: "Specials" }, item_ids: ["item-burger"] }
    ],
    items: [
      itemBase({
        id: "item-burger",
        type: "ITEM",
        name: { en: "Test Burger" },
        description: { en: `Sandbox test item (rev ${revLabel})` },
        operational_name: "test-burger",
        plu: "TB001",
        price_info: { price: 1000 + bump, overrides: [] },
        modifier_ids: ["mod-spice", "mod-extra"],
        image: { url: ITEM_IMAGE_CACHEABLE_URL }
      }),
      itemBase({
        id: "item-wrap",
        type: "ITEM",
        name: { en: "Test Wrap" },
        description: { en: `Second menu item (rev ${revLabel})` },
        operational_name: "test-wrap",
        plu: "TW001",
        price_info: { price: 900 + bump, overrides: [] },
        modifier_ids: ["mod-extra"],
        diets: ["vegan"]
      }),
      itemBase({
        id: "opt-mild",
        type: "CHOICE",
        name: { en: "Mild" },
        description: { en: "Mild spice" },
        operational_name: "mild",
        plu: "SP001",
        price_info: { price: 0, overrides: [] },
        modifier_ids: [],
        max_quantity: 1,
        is_eligible_as_replacement: false
      }),
      itemBase({
        id: "opt-spicy",
        type: "CHOICE",
        name: { en: "Spicy" },
        description: { en: "Spicy" },
        operational_name: "spicy",
        plu: "SP002",
        price_info: { price: 0, overrides: [] },
        modifier_ids: [],
        max_quantity: 1,
        is_eligible_as_replacement: false
      }),
      itemBase({
        id: "opt-cheese",
        type: "CHOICE",
        name: { en: "Extra Cheese" },
        description: { en: "Cheese" },
        operational_name: "extra-cheese",
        plu: "EX001",
        price_info: { price: 100, overrides: [] },
        modifier_ids: [],
        max_quantity: 2,
        is_eligible_as_replacement: false,
        diets: ["vegetarian"]
      }),
      itemBase({
        id: "opt-bacon",
        type: "CHOICE",
        name: { en: "Extra Bacon" },
        description: { en: "Bacon" },
        operational_name: "extra-bacon",
        plu: "EX002",
        price_info: { price: 150, overrides: [] },
        modifier_ids: [],
        max_quantity: 2,
        is_eligible_as_replacement: false
      })
    ],
    modifiers: [
      {
        id: "mod-spice",
        name: { en: "Spice Level" },
        description: { en: "Choose one" },
        type: "cooking-instruction",
        min_selection: 1,
        max_selection: 1,
        item_ids: ["opt-mild", "opt-spicy"]
      },
      {
        id: "mod-extra",
        name: { en: "Add Extras" },
        description: { en: "Extras" },
        type: "add-ingredient",
        min_selection: 0,
        max_selection: 2,
        item_ids: ["opt-cheese", "opt-bacon"]
      }
    ],
    mealtimes: [
      {
        id: "daytime-menu",
        name: { en: "Daytime Menu" },
        description: { en: rev ? `Daytime menu (rev ${revLabel}).` : "Daytime menu." },
        category_ids: ["cat-breakfast", "cat-main", "cat-special"],
        image: { url: WEBHOOK_MEALTIME_COVER_DAY_URL },
        schedule: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
          day_of_week: day,
          time_periods: [{ start: "00:00:00", end: "11:59:59" }]
        }))
      },
      {
        id: "evening-menu",
        name: { en: "Evening Menu" },
        description: { en: rev ? `Evening menu (rev ${revLabel}).` : "Evening menu." },
        category_ids: ["cat-main", "cat-special"],
        image: { url: WEBHOOK_MEALTIME_COVER_EVENING_URL },
        schedule: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
          day_of_week: day,
          time_periods: [{ start: "12:00:00", end: "23:59:00" }]
        }))
      }
    ]
  }
};
};

/**
 * Scenario 4: bundles per Menu API Guidelines.
 * - 2+ categories, 2+ BUNDLE items, 2+ standalone ITEMs
 * - bundle-item modifiers on bundles; other modifier types elsewhere
 * - bundle components sold standalone with non-zero price + ITEM overrides
 * - one bundle component adds extra cost; one bundle has party_size
 * - bundle price <= sum(cheapest component * min selection per section)
 */
export const buildBundlesScenarioPayload = (
  menuId: string,
  siteId: string
): Record<string, unknown> => {
  const bundleBreakfast = "bundle-breakfast";
  const bundleLunch = "bundle-lunch";

  return {
    name: menuId,
    site_ids: [siteId],
    menu: {
      categories: [
        {
          id: "cat-mains",
          name: { en: "Mains" },
          item_ids: ["item-burger", "item-wrap", "side-salad", "side-fries"]
        },
        {
          id: "cat-combos",
          name: { en: "Combo bundles" },
          item_ids: [bundleBreakfast, bundleLunch]
        }
      ],
      items: [
        // Standalone items (also bundle components)
        itemBase({
          id: "item-burger",
          type: "ITEM",
          name: { en: "Classic Burger" },
          description: { en: "Beef burger with lettuce and tomato." },
          operational_name: "classic-burger",
          plu: "BRG001",
          price_info: {
            price: 800,
            overrides: [
              bundleItemOverride(bundleBreakfast, 100),
              bundleItemOverride(bundleLunch, 0)
            ]
          },
          modifier_ids: ["mod-spice"]
        }),
        itemBase({
          id: "item-wrap",
          type: "ITEM",
          name: { en: "Chicken Wrap" },
          description: { en: "Grilled chicken wrap." },
          operational_name: "chicken-wrap",
          plu: "WRP001",
          price_info: {
            price: 700,
            overrides: [
              bundleItemOverride(bundleBreakfast, 0),
              bundleItemOverride(bundleLunch, 0)
            ]
          },
          modifier_ids: [],
          diets: ["halal"]
        }),
        itemBase({
          id: "side-salad",
          type: "ITEM",
          name: { en: "Side Salad" },
          description: { en: "Fresh mixed salad." },
          operational_name: "side-salad",
          plu: "SDS001",
          price_info: {
            price: 250,
            overrides: [
              bundleItemOverride(bundleBreakfast, 0),
              bundleItemOverride(bundleLunch, 0)
            ]
          },
          modifier_ids: ["mod-sides-pick"]
        }),
        itemBase({
          id: "side-fries",
          type: "ITEM",
          name: { en: "Loaded Fries" },
          description: { en: "Crispy fries with seasoning." },
          operational_name: "side-fries",
          plu: "FRZ001",
          price_info: {
            price: 300,
            overrides: [
              bundleItemOverride(bundleBreakfast, 0),
              bundleItemOverride(bundleLunch, 0)
            ]
          },
          modifier_ids: []
        }),
        // Bundles: cheapest main (700) + cheapest side (250) = 950 max base
        itemBase({
          id: bundleBreakfast,
          type: "BUNDLE",
          name: { en: "Breakfast Combo" },
          description: { en: "Pick a main and a side." },
          operational_name: "breakfast-combo",
          plu: "BDL-BRK",
          party_size: 2,
          price_info: { price: 900, overrides: [] },
          // cheapest standalone: wrap 700 + salad 250 = 950; burger upgrade +100 in bundle
          modifier_ids: ["bundle-breakfast-main", "bundle-breakfast-side"]
        }),
        itemBase({
          id: bundleLunch,
          type: "BUNDLE",
          name: { en: "Lunch Combo" },
          description: { en: "Lunch bundle for sharing." },
          operational_name: "lunch-combo",
          plu: "BDL-LCH",
          party_size: 4,
          price_info: { price: 950, overrides: [] },
          // cheapest: wrap 700 + salad 250 = 950
          modifier_ids: ["bundle-lunch-main", "bundle-lunch-side"]
        }),
        // Modifier choices (not restricted)
        itemBase({
          id: "opt-mild",
          type: "CHOICE",
          name: { en: "Mild" },
          description: { en: "Mild spice" },
          operational_name: "mild",
          plu: "SPM001",
          price_info: { price: 0, overrides: [] },
          modifier_ids: [],
          max_quantity: 1,
          is_eligible_as_replacement: false
        }),
        itemBase({
          id: "opt-spicy",
          type: "CHOICE",
          name: { en: "Spicy" },
          description: { en: "Hot spice" },
          operational_name: "spicy",
          plu: "SPS001",
          price_info: { price: 0, overrides: [] },
          modifier_ids: [],
          max_quantity: 1,
          is_eligible_as_replacement: false
        })
      ],
      modifiers: [
        {
          id: "bundle-breakfast-main",
          name: { en: "Choose your main" },
          description: { en: "Select one main dish" },
          type: "bundle-item",
          min_selection: 1,
          max_selection: 1,
          item_ids: ["item-burger", "item-wrap"]
        },
        {
          id: "bundle-breakfast-side",
          name: { en: "Choose your side" },
          description: { en: "Select one side" },
          type: "bundle-item",
          min_selection: 1,
          max_selection: 1,
          item_ids: ["side-salad", "side-fries"]
        },
        {
          id: "bundle-lunch-main",
          name: { en: "Choose your main" },
          description: { en: "Select one main dish" },
          type: "bundle-item",
          min_selection: 1,
          max_selection: 1,
          item_ids: ["item-burger", "item-wrap"]
        },
        {
          id: "bundle-lunch-side",
          name: { en: "Choose your side" },
          description: { en: "Select one side" },
          type: "bundle-item",
          min_selection: 1,
          max_selection: 1,
          item_ids: ["side-salad", "side-fries"]
        },
        {
          id: "mod-spice",
          name: { en: "Spice level" },
          description: { en: "On standalone burger only" },
          type: "cooking-instruction",
          min_selection: 1,
          max_selection: 1,
          item_ids: ["opt-mild", "opt-spicy"]
        },
        {
          id: "mod-sides-pick",
          name: { en: "Pair with a main" },
          description: { en: "Links burger and wrap menu items" },
          type: "add-ingredient",
          min_selection: 0,
          max_selection: 1,
          item_ids: ["item-burger", "item-wrap"]
        }
      ],
      mealtimes: [
        {
          id: "all-day-menu",
          name: { en: "All day" },
          description: { en: "Full menu including bundles." },
          category_ids: ["cat-mains", "cat-combos"],
          image: { url: WEBHOOK_MEALTIME_COVER_DAY_URL },
          schedule: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
            day_of_week: day,
            time_periods: [{ start: "00:00:00", end: "23:59:00" }]
          }))
        }
      ]
    }
  };
};

export const countBundlesInPayload = (payload: Record<string, unknown>): number => {
  const menu = payload.menu as Record<string, unknown> | undefined;
  const items = Array.isArray(menu?.items) ? menu.items : [];
  return items.filter((raw) => {
    const node = raw as Record<string, unknown>;
    return node.type === "BUNDLE";
  }).length;
};
