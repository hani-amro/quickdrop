import { JOURNEY_RUN_STATUSES } from "@quickdrop/shared";
import { boolean, foreignKey, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, idPk, tenantId, timestamptz, updatedAt } from "./_common.js";
import { users } from "./users.js";

// دمج WaFlow (MERGE_PLAN §3.4) — Journeys: **محرك الأتمتة الوحيد** (sequences/campaigns×2/
// proactive تُقتَل وتُوحَّد هنا). رحلة = مُطلِق (حدث spine) → جمهور → خطوات مرتّبة.
// التنفيذ بمهام BullMQ مؤجّلة + rescan عند الإقلاع (القاعدة مصدر الحقيقة §12) — لا poll.

export const journeys = pgTable(
  "journeys",
  {
    id: idPk(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    description: text("description"),
    /** مُطلِّق = موضوع spine (order.delivered، payment.paid، crm.lifecycle_changed:at_risk…). */
    trigger: text("trigger").notNull(),
    /** فلتر الجمهور: { lifecycleStage?: string[], minRfm?: number, tags?: string[] } */
    audienceFilter: jsonb("audience_filter"),
    /** خطوات مرتّبة: [{ type, delayHours, ...}] — يُتحقّق منها Zod عند الحدود (§11). */
    steps: jsonb("steps").notNull(),
    isActive: boolean("is_active").notNull().default(false),
    enrolledCount: integer("enrolled_count").notNull().default(0),
    completedCount: integer("completed_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("journeys_tenant_id_id_uq").on(t.tenantId, t.id), // أب لمفاتيح مركّبة
    index("journeys_tenant_trigger_active_idx").on(t.tenantId, t.trigger, t.isActive),
  ],
);

export const journeyRuns = pgTable(
  "journey_runs",
  {
    id: idPk(),
    tenantId: tenantId(),
    journeyId: uuid("journey_id").notNull(),
    userId: uuid("user_id").notNull(), // الزبون المُسجَّل (WaFlow contactId)
    currentStep: integer("current_step").notNull().default(0),
    status: text("status", { enum: JOURNEY_RUN_STATUSES }).notNull().default("active"),
    nextRunAt: timestamptz("next_run_at"),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("journey_runs_tenant_id_id_uq").on(t.tenantId, t.id),
    // تسجيل مرة واحدة لكل (رحلة، زبون) — يمنع الازدواج تحت السباق (§12)
    uniqueIndex("journey_runs_tenant_journey_user_uq").on(t.tenantId, t.journeyId, t.userId),
    index("journey_runs_tenant_status_next_idx").on(t.tenantId, t.status, t.nextRunAt), // rescan
    foreignKey({ columns: [t.tenantId, t.journeyId], foreignColumns: [journeys.tenantId, journeys.id], name: "journey_runs_journey_fk" }),
    foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id], name: "journey_runs_user_fk" }),
  ],
);

export type Journey = typeof journeys.$inferSelect;
export type NewJourney = typeof journeys.$inferInsert;
export type JourneyRun = typeof journeyRuns.$inferSelect;
export type NewJourneyRun = typeof journeyRuns.$inferInsert;
