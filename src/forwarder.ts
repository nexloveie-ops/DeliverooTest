import axios from "axios";
import { config } from "./config.js";

export const forwardToOwnSystem = async (
  body: unknown,
  kind: "menu" | "order_event" | "menu_event"
): Promise<void> => {
  if (!config.forwardTargetUrl) {
    return;
  }

  await axios.post(
    config.forwardTargetUrl,
    { kind, data: body, source: "deliveroo-test" },
    {
      headers: {
        "Content-Type": "application/json",
        ...(config.forwardAuthToken ? { Authorization: `Bearer ${config.forwardAuthToken}` } : {})
      },
      timeout: 10000
    }
  );
};
