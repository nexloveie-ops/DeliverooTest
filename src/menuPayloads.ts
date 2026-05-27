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

export type MenuScenario = "default" | "mealtimes" | "bundles" | "nochange" | "webhook";

const revisionPriceBump = (revision: string): number => {
  const numeric = Number(revision);
  if (Number.isFinite(numeric) && numeric > 0) {
    return (numeric % 400) + 17;
  }
  return (parseInt(revision.slice(-6), 36) % 400) + 17;
};

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

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
    if (item.type !== "ITEM") continue;

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

  const mealtimes = Array.isArray(menu.mealtimes) ? menu.mealtimes : [];
  for (const raw of mealtimes) {
    const mealtime = toRecord(raw);
    const description = toRecord(mealtime.description);
    description.en = `Menu sync ${revision}`;
    const image = toRecord(mealtime.image);
    if (typeof image.url === "string") {
      const baseUrl = image.url.split("?")[0];
      image.url = `${baseUrl}?webhook_rev=${revision}`;
    }
  }

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
  return buildMealtimesScenarioPayload(menuId, siteId);
};

/**
 * Scenario 6: mealtimes-shaped menu with a unique revision so PUT triggers async processing
 * (not MATCH_EXISTING_MENU). Use a new menu_id in the Portal or rely on revision bump.
 */
export const buildWebhookScenarioPayload = (
  menuId: string,
  siteId: string,
  revision: string = String(Date.now())
): Record<string, unknown> => buildMealtimesScenarioPayload(menuId, siteId, revision);

/** Build PUT body for Scenario 6 from live menu when possible. */
export const buildWebhookUploadBody = (
  menuId: string,
  siteId: string,
  revision: string,
  currentMenuJson?: string
): string => {
  if (currentMenuJson) {
    try {
      const current = JSON.parse(currentMenuJson) as Record<string, unknown>;
      const mutated = applyWebhookRevision(current, revision);
      const mutatedJson = JSON.stringify(mutated);
      if (mutatedJson !== currentMenuJson) {
        return mutatedJson;
      }
    } catch {
      // fall through to template
    }
  }
  return JSON.stringify(buildWebhookScenarioPayload(menuId, siteId, revision));
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
        modifier_ids: ["mod-spice", "mod-extra"]
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
        image: { url: "https://images.unsplash.com/photo-1533089860892-a7c6f0a986b6" },
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
        image: { url: "https://images.unsplash.com/photo-1565299624946-b28f40a0ae38" },
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
          image: { url: "https://images.unsplash.com/photo-1533089860892-a7c6f0a986b6" },
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
