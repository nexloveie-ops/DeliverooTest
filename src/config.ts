import dotenv from "dotenv";

dotenv.config();

const parsePort = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: parsePort(process.env.PORT, 8080),
  nodeEnv: process.env.NODE_ENV ?? "development",
  deliverooBaseUrl: process.env.DELIVEROO_BASE_URL ?? "https://api-developers.deliveroo.com",
  deliverooApiToken: process.env.DELIVEROO_API_TOKEN ?? "",
  deliverooSiteId: process.env.DELIVEROO_SITE_ID ?? "",
  deliverooWebhookSecret: process.env.DELIVEROO_WEBHOOK_SECRET ?? "",
  forwardTargetUrl: process.env.FORWARD_TARGET_URL ?? "",
  forwardAuthToken: process.env.FORWARD_AUTH_TOKEN ?? ""
};

export const isProd = config.nodeEnv === "production";
