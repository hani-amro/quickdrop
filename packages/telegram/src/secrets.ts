import { randomBytes } from "node:crypto";

// §4.1 — سر الـ webhook لكل مستأجر، يُرسَل بهيدر X-Telegram-Bot-Api-Secret-Token.
// حد تيليغرام: 1-256 محرفاً من [A-Za-z0-9_-].
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

// §16.24 — حارس بيئة/بوت: بوتات dev تنتهي بـ _dev_bot حصراً، والإنتاج عكسها.
export function assertBotMatchesEnvironment(botUsername: string, nodeEnv: string): void {
  const isDevBot = botUsername.toLowerCase().endsWith("_dev_bot");
  if (nodeEnv === "production" && isDevBot) {
    throw new Error(`refusing: dev bot @${botUsername} cannot be linked in production`);
  }
  if (nodeEnv !== "production" && !isDevBot) {
    throw new Error(
      `refusing: @${botUsername} is not a _dev_bot — linking a production bot outside production sends test messages to real customers (trap 24)`,
    );
  }
}
