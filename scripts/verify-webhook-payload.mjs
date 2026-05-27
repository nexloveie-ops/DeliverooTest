#!/usr/bin/env node
/**
 * Pre-push checks for Scenario 6 webhook payloads.
 * Run: npm run verify:webhook
 */
import { execSync } from "node:child_process";
import {
  buildWebhookUploadBody,
  WEBHOOK_MEALTIME_COVER_DAY_URL,
  WEBHOOK_MEALTIME_COVER_EVENING_URL
} from "../dist/menuPayloads.js";

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

const ok = (message) => console.log(`OK: ${message}`);

const sampleGetMenu = {
  name: "123156468",
  site_ids: ["100121"],
  menu: {
    categories: [{ id: "cat-main", name: { en: "Main" }, item_ids: ["item-burger"] }],
    items: [
      {
        id: "item-burger",
        type: "ITEM",
        name: { en: "Test Burger" },
        description: { en: "Old" },
        operational_name: "test-burger",
        plu: "TB001",
        price_info: { price: 1000, overrides: [] },
        modifier_ids: []
      }
    ],
    modifiers: [],
    mealtimes: [
      {
        id: "daytime-menu",
        name: { en: "Daytime Menu" },
        description: { en: "Old" },
        category_ids: ["cat-main"],
        image: { url: "https://images.unsplash.com/photo-1533089860892-a7c6f0a986b6" },
        schedule: [{ day_of_week: 0, time_periods: [{ start: "00:00:00", end: "23:59:00" }] }]
      }
    ]
  }
};

const revision = String(Date.now());
const currentJson = JSON.stringify(sampleGetMenu);
const bodyJson = buildWebhookUploadBody("123156468", "100121", revision, currentJson, "mutate");
const body = JSON.parse(bodyJson);

if (!Array.isArray(body.site_ids) || body.site_ids.length === 0) {
  fail("mutated body missing site_ids");
}
ok("mutated body has site_ids");

const mealtimes = body.menu?.mealtimes ?? [];
if (mealtimes.length === 0) {
  fail("mutated body missing mealtimes");
}

const urls = mealtimes.map((m) => m?.image?.url).filter(Boolean);
if (urls.some((u) => u.includes("unsplash.com"))) {
  fail("mutated body still contains unsplash image URLs");
}
ok("no unsplash URLs in mutated payload");

const allowedHosts = ["upload.wikimedia.org", "picsum.photos"];
for (const url of urls) {
  const host = new URL(url.split("?")[0]).hostname;
  if (!allowedHosts.includes(host)) {
    fail(`unexpected image host: ${host}`);
  }
}

const checkHttp = (url) => {
  const code = execSync(
    `curl -sS -o /dev/null -w "%{http_code}" -L -A "DeliverooMenuTest/1.0" "${url.split("?")[0]}"`,
    { encoding: "utf8" }
  ).trim();
  if (code !== "200") {
    fail(`image URL not reachable (${code}): ${url}`);
  }
};

checkHttp(WEBHOOK_MEALTIME_COVER_DAY_URL);
checkHttp(WEBHOOK_MEALTIME_COVER_EVENING_URL);
for (const url of urls) {
  checkHttp(url);
}
ok("all mealtime cover URLs return HTTP 200");

if (bodyJson === currentJson) {
  fail("mutated body is byte-identical to GET menu");
}
ok("mutated body differs from GET menu");

console.log("verify:webhook passed");
