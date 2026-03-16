import { randomUUID } from "crypto";
import { logger } from "../../../agents/telemetry/logger.js";

export async function sendEphemeralStatus(channelId: string, message: string): Promise<string> {
  const statusId = randomUUID();
  logger.info({ event: "ephemeral_status_sent", channelId, statusId, message });
  return statusId;
}

export async function clearEphemeralStatus(channelId: string, statusId: string): Promise<void> {
  logger.info({ event: "ephemeral_status_cleared", channelId, statusId });
}
