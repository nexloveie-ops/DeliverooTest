import dotenv from "dotenv";

dotenv.config();

const parsePort = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: parsePort(process.env.PORT, 8080),
  nodeEnv: process.env.NODE_ENV ?? "development",
  deliverooBaseUrl: process.env.DELIVEROO_BASE_URL ?? "https://api-sandbox.developers.deliveroo.com",
  deliverooAuthBaseUrl: process.env.DELIVEROO_AUTH_BASE_URL ?? "https://auth-sandbox.developers.deliveroo.com",
  deliverooClientId: process.env.DELIVEROO_CLIENT_ID ?? "",
  deliverooClientSecret: process.env.DELIVEROO_CLIENT_SECRET ?? "",
  deliverooLocationId: process.env.DELIVEROO_LOCATION_ID ?? "100121",
  deliverooBrandId: process.env.DELIVEROO_BRAND_ID ?? "",
  deliverooSiteId: process.env.DELIVEROO_SITE_ID ?? "",
  deliverooMenuId: process.env.DELIVEROO_MENU_ID ?? "",
  deliverooWebhookSecret: process.env.DELIVEROO_WEBHOOK_SECRET ?? "",
  forwardTargetUrl: process.env.FORWARD_TARGET_URL ?? "",
  forwardAuthToken: process.env.FORWARD_AUTH_TOKEN ?? ""
};

export const isProd = config.nodeEnv === "production";
