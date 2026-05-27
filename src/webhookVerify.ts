import crypto from "node:crypto";
import { config } from "./config.js";

/**
 * Deliveroo webhook HMAC (Securing Webhooks):
 * HMAC-SHA256(secret, sequenceGuid + " " + rawBody)
 * Legacy POS new_order/cancel_order uses sequenceGuid + " \n " + rawBody instead.
 */
export const verifyDeliverooWebhookHmac = (
  rawBody: Buffer,
  sequenceGuid: string,
  expectedHex: string,
  legacyPosWebhook = false
): boolean => {
  if (!config.deliverooWebhookSecret) {
    return true;
  }
  if (!sequenceGuid || !expectedHex) {
    return false;
  }

  const separator = legacyPosWebhook ? " \n " : " ";
  const signedPayload = Buffer.concat([
    Buffer.from(sequenceGuid, "utf8"),
    Buffer.from(separator, "utf8"),
    rawBody
  ]);

  const computed = crypto
    .createHmac("sha256", config.deliverooWebhookSecret)
    .update(signedPayload)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(computed, "utf8"), Buffer.from(expectedHex, "utf8"));
  } catch {
    return false;
  }
};

export const isMenuWebhookRequest = (headers: Record<string, string | string[] | undefined>): boolean => {
  const payloadType = getHeaderValue(headers["x-deliveroo-payload-type"]).toLowerCase();
  return payloadType === "webhook_menu";
};

export const getHeaderValue = (value: string | string[] | undefined): string => {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
};
