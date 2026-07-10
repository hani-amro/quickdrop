import { newId, WEBHOOK_UPDATE_STATUSES } from "@quickdrop/shared";
import { bigint, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

// §4.1 — inbox لا مجرد dedup: الرد 200 بعد التزام الصف، والمعالجة تعلّمه processed.
// المفتاح (tenant_id, update_id) — لا bot_username (قابل للتغيير من BotFather).
export const webhookUpdates = pgTable(
  "webhook_updates",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    updateId: bigint("update_id", { mode: "number" }).notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status", { enum: WEBHOOK_UPDATE_STATUSES }).notNull().default("received"),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("webhook_updates_tenant_update_uq").on(table.tenantId, table.updateId)],
);

export type WebhookUpdate = typeof webhookUpdates.$inferSelect;
export type NewWebhookUpdate = typeof webhookUpdates.$inferInsert;
