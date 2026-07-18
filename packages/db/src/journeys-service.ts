import { JOURNEY_TRIGGERS, type LifecycleStage } from "@quickdrop/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { audienceFilterSchema, matchesAudience, type AudienceFilter, type AudienceProfile } from "./audience.js";
import type { Db } from "./client.js";
import { getOrCreateConversation, recordOutboundMessage } from "./conversations-service.js";
import { writeOutbox } from "./outbox.js";
import { conversations, customerProfiles, journeyRuns, journeys, users, type Journey } from "./schema/index.js";
import { withTenant, type Tx } from "./with-tenant.js";

// دمج WaFlow (MERGE_PLAN §3.4) — Journeys: منطق المحرك الوحيد. الخطوات/الجمهور بـ Zod
// (§11). التنفيذ داخل ترانزاكشن مستأجر؛ الإرسال عبر outbox (D9، لا نداء شبكي هنا).
// فلتر الجمهور مصدره الموحّد audience.ts (تشاركه الحملات) — يُستورد لا يُعرَّف هنا.

export const journeyStepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("send_message"), delayHours: z.number().min(0).max(8760), template: z.string().min(1).max(2000) }),
  z.object({ type: z.literal("ai_handoff"), delayHours: z.number().min(0).max(8760) }),
  z.object({ type: z.literal("add_tag"), delayHours: z.number().min(0).max(8760), tag: z.string().min(1).max(60) }),
  z.object({ type: z.literal("wait"), delayHours: z.number().min(0).max(8760) }),
]);
export const journeyStepsSchema = z.array(journeyStepSchema).min(1).max(20);
export type JourneyStep = z.infer<typeof journeyStepSchema>;

// —— Zod: CRUD تعريف الرحلة (حدود API §11) ——
export const createJourneySchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).nullable().optional(),
    trigger: z.enum(JOURNEY_TRIGGERS), // مُطلِّق خارج المخرَّط = رحلة ميتة → يُرفض
    audienceFilter: audienceFilterSchema.nullable().optional(),
    steps: journeyStepsSchema,
    isActive: z.boolean().optional(),
  })
  .strict();
export type CreateJourneyInput = z.infer<typeof createJourneySchema>;

// تحديث جزئي — كل الحقول اختيارية؛ المُطلِّق **غير قابل للتغيير** (تسجيلات قائمة عليه).
export const updateJourneySchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).nullable().optional(),
    audienceFilter: audienceFilterSchema.nullable().optional(),
    steps: journeyStepsSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "empty update" });
export type UpdateJourneyInput = z.infer<typeof updateJourneySchema>;

const HOUR_MS = 3_600_000;

/**
 * §3.4 — تسجيل زبون في كل الرحلات النشطة المطابقة للمُطلِّق وجمهوره: صف journey_run
 * لكل رحلة (فريد (tenant, journey, user) → تسجيل مرة واحدة، السباق يحسمه القيد)،
 * وnext_run_at = الآن + delayHours لأول خطوة. يعيد عدد التسجيلات الجديدة.
 */
export interface EnrolledRun {
  runId: string;
  currentStep: number;
  nextRunAt: Date;
}

export async function enrollInJourneys(tx: Tx, tenantId: string, userId: string, trigger: string, now = new Date()): Promise<EnrolledRun[]> {
  const active = await tx
    .select({ id: journeys.id, audienceFilter: journeys.audienceFilter, steps: journeys.steps })
    .from(journeys)
    .where(and(eq(journeys.tenantId, tenantId), eq(journeys.trigger, trigger), eq(journeys.isActive, true)));
  if (active.length === 0) return [];

  const prof = await tx
    .select({ lifecycleStage: customerProfiles.lifecycleStage, rfmScore: customerProfiles.rfmScore, tags: customerProfiles.tags })
    .from(customerProfiles)
    .where(and(eq(customerProfiles.tenantId, tenantId), eq(customerProfiles.userId, userId)))
    .limit(1);
  const profile: AudienceProfile = {
    lifecycleStage: (prof[0]?.lifecycleStage as LifecycleStage | undefined) ?? null,
    rfmScore: prof[0]?.rfmScore ?? null,
    tags: prof[0]?.tags ?? [],
  };

  const enrolled: EnrolledRun[] = [];
  for (const j of active) {
    const filter = j.audienceFilter ? audienceFilterSchema.safeParse(j.audienceFilter) : null;
    const audience = filter && filter.success ? filter.data : null;
    if (!matchesAudience(profile, audience)) continue;
    const steps = journeyStepsSchema.safeParse(j.steps);
    if (!steps.success) continue; // رحلة بخطوات فاسدة — تُتجاهل (لا تسجيل)
    const firstDelay = steps.data[0]!.delayHours;
    const nextRunAt = new Date(now.getTime() + firstDelay * HOUR_MS);

    const inserted = await tx
      .insert(journeyRuns)
      .values({ tenantId, journeyId: j.id, userId, currentStep: 0, status: "active", nextRunAt })
      .onConflictDoNothing({ target: [journeyRuns.tenantId, journeyRuns.journeyId, journeyRuns.userId] })
      .returning({ id: journeyRuns.id });
    if (inserted[0]) {
      await tx.update(journeys).set({ enrolledCount: sql`${journeys.enrolledCount} + 1`, updatedAt: now }).where(eq(journeys.id, j.id));
      enrolled.push({ runId: inserted[0].id, currentStep: 0, nextRunAt });
    }
  }
  return enrolled;
}

/** استبدال المتغيّرات بالقالب — {name}, {business_name} (نمط WaFlow). */
function renderTemplate(template: string, vars: { name: string; businessName: string }): string {
  return template.replace(/\{name\}/g, vars.name).replace(/\{business_name\}/g, vars.businessName);
}

export type StepResult =
  | { outcome: "advanced"; nextStep: number; nextRunAt: Date }
  | { outcome: "completed" }
  | { outcome: "gone" };

/**
 * §3.4 — تنفيذ الخطوة الحالية لتسجيل ثم تقديمه: send_message (رسالة صادرة + outbox
 * 'journey.message')، ai_handoff (ai_enabled=true)، add_tag (وسم على الملف)، wait (لا شيء).
 * كله idempotent-ish: الخطوة الحالية تُنفّذ مرة (currentStep يتقدّم بنفس الترانزاكشن).
 * يقفل صف الـ run FOR UPDATE؛ run غير active/موجود → gone.
 */
export async function executeJourneyStep(tx: Tx, tenantId: string, runId: string, businessName: string, now = new Date()): Promise<StepResult> {
  const runRows = await tx
    .select({ id: journeyRuns.id, journeyId: journeyRuns.journeyId, userId: journeyRuns.userId, currentStep: journeyRuns.currentStep, status: journeyRuns.status })
    .from(journeyRuns)
    .where(and(eq(journeyRuns.tenantId, tenantId), eq(journeyRuns.id, runId)))
    .for("update");
  const run = runRows[0];
  if (!run || run.status !== "active") return { outcome: "gone" };

  const jRows = await tx.select({ steps: journeys.steps }).from(journeys).where(and(eq(journeys.tenantId, tenantId), eq(journeys.id, run.journeyId))).limit(1);
  const parsedSteps = journeyStepsSchema.safeParse(jRows[0]?.steps);
  if (!parsedSteps.success) {
    // رحلة اختفت/فسدت — أنهِ التسجيل بهدوء
    await tx.update(journeyRuns).set({ status: "cancelled", nextRunAt: null, updatedAt: now }).where(eq(journeyRuns.id, runId));
    return { outcome: "gone" };
  }
  const steps = parsedSteps.data;
  const step = steps[run.currentStep];
  if (!step) {
    await completeRun(tx, tenantId, runId, run.journeyId, now);
    return { outcome: "completed" };
  }

  if (step.type === "send_message") {
    const uRows = await tx.select({ name: users.firstName, telegramUserId: users.telegramUserId, waId: users.waId }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.id, run.userId))).limit(1);
    const u = uRows[0];
    if (u) {
      const channel = u.telegramUserId !== null ? ("telegram" as const) : ("whatsapp" as const);
      const text = renderTemplate(step.template, { name: u.name ?? "", businessName });
      const { id: conversationId } = await getOrCreateConversation(tx, tenantId, run.userId);
      await recordOutboundMessage(tx, { tenantId, conversationId, channel, type: "text", content: text, metadata: { journey: true } });
      await writeOutbox(tx, tenantId, "journey.message", { userId: run.userId, conversationId, text });
    }
  } else if (step.type === "ai_handoff") {
    await tx.update(conversations).set({ aiEnabled: true, updatedAt: now }).where(and(eq(conversations.tenantId, tenantId), eq(conversations.userId, run.userId)));
  } else if (step.type === "add_tag") {
    // وسم على ملف الزبون بلا تكرار (array_append مشروط)
    await tx
      .update(customerProfiles)
      .set({ tags: sql`CASE WHEN ${customerProfiles.tags} @> ARRAY[${step.tag}]::text[] THEN ${customerProfiles.tags} ELSE array_append(${customerProfiles.tags}, ${step.tag}) END`, updatedAt: now })
      .where(and(eq(customerProfiles.tenantId, tenantId), eq(customerProfiles.userId, run.userId)));
  }
  // wait: لا فعل — فقط تقدّم

  const nextStep = run.currentStep + 1;
  if (nextStep >= steps.length) {
    await completeRun(tx, tenantId, runId, run.journeyId, now);
    return { outcome: "completed" };
  }
  const nextRunAt = new Date(now.getTime() + steps[nextStep]!.delayHours * HOUR_MS);
  await tx.update(journeyRuns).set({ currentStep: nextStep, nextRunAt, updatedAt: now }).where(eq(journeyRuns.id, runId));
  return { outcome: "advanced", nextStep, nextRunAt };
}

async function completeRun(tx: Tx, tenantId: string, runId: string, journeyId: string, now: Date): Promise<void> {
  await tx.update(journeyRuns).set({ status: "completed", nextRunAt: null, updatedAt: now }).where(eq(journeyRuns.id, runId));
  await tx.update(journeys).set({ completedCount: sql`${journeys.completedCount} + 1`, updatedAt: now }).where(and(eq(journeys.tenantId, tenantId), eq(journeys.id, journeyId)));
}

/** §3.4 stop-on-reply — رد الزبون يلغي كل تسجيلاته النشطة (لا نطارد من تفاعل). */
export async function cancelActiveJourneyRuns(tx: Tx, tenantId: string, userId: string, now = new Date()): Promise<number> {
  const cancelled = await tx
    .update(journeyRuns)
    .set({ status: "cancelled", nextRunAt: null, updatedAt: now })
    .where(and(eq(journeyRuns.tenantId, tenantId), eq(journeyRuns.userId, userId), eq(journeyRuns.status, "active")))
    .returning({ id: journeyRuns.id });
  return cancelled.length;
}

/** rescan الإقلاع (§12) — تسجيلات active مستحقة (next_run_at <= now)، عبر scanDb.
 *  يعيد current_step كي يستخدم الـ rescan نفس jobId الحتمي (dedup مع مهمة مجدولة حية). */
export async function dueJourneyRuns(scanDb: Db, now = new Date(), limit = 500): Promise<{ id: string; tenantId: string; currentStep: number }[]> {
  return scanDb
    .select({ id: journeyRuns.id, tenantId: journeyRuns.tenantId, currentStep: journeyRuns.currentStep })
    .from(journeyRuns)
    .where(and(eq(journeyRuns.status, "active"), sql`${journeyRuns.nextRunAt} <= ${now.toISOString()}`))
    .limit(limit);
}

// ————————————————————————— CRUD تعريف الرحلة (§3.6 — الداشبورد) —————————————————————————
// كله داخل ترانزاكشن مستأجر (RLS يفرض العزل). الجمهور/الخطوات محقّقان بـ Zod عند الحدّ.

/** إنشاء رحلة. المُطلِّق محقّق (z.enum) والخطوة الأولى بلا تأخير مبدئي مقبول (delayHours ≥ 0). */
export async function createJourney(tx: Tx, tenantId: string, input: CreateJourneyInput): Promise<Journey> {
  const rows = await tx
    .insert(journeys)
    .values({
      tenantId,
      name: input.name,
      description: input.description ?? null,
      trigger: input.trigger,
      audienceFilter: input.audienceFilter ?? null,
      steps: input.steps,
      isActive: input.isActive ?? false,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("createJourney: INSERT ... RETURNING returned no row");
  return row;
}

/** قائمة رحلات المستأجر (الأحدث أولاً) — العدّادات (enrolled/completed) للعرض. */
export async function listJourneys(tx: Tx, tenantId: string): Promise<Journey[]> {
  return tx.select().from(journeys).where(eq(journeys.tenantId, tenantId)).orderBy(desc(journeys.createdAt));
}

export async function getJourney(tx: Tx, tenantId: string, id: string): Promise<Journey | null> {
  const rows = await tx.select().from(journeys).where(and(eq(journeys.tenantId, tenantId), eq(journeys.id, id))).limit(1);
  return rows[0] ?? null;
}

/**
 * تحديث جزئي (name/description/audienceFilter/steps/isActive). المُطلِّق غير قابل للتغيير
 * (تسجيلات active قائمة عليه). يعيد الصف المحدَّث أو null إن لم يوجد. لا يمسّ التسجيلات
 * الجارية — تعديل الخطوات يسري على من يُسجَّل لاحقاً؛ الجارون يكملون بنسختهم المخزّنة بالرحلة
 * (executeJourneyStep يقرأ الخطوات الحيّة، فالتعديل يؤثّر على الخطوة القادمة — مقبول ومقصود).
 */
export async function updateJourney(tx: Tx, tenantId: string, id: string, patch: UpdateJourneyInput, now = new Date()): Promise<Journey | null> {
  const set: Record<string, unknown> = { updatedAt: now };
  if (patch.name !== undefined) set["name"] = patch.name;
  if (patch.description !== undefined) set["description"] = patch.description;
  if (patch.audienceFilter !== undefined) set["audienceFilter"] = patch.audienceFilter;
  if (patch.steps !== undefined) set["steps"] = patch.steps;
  if (patch.isActive !== undefined) set["isActive"] = patch.isActive;
  const rows = await tx.update(journeys).set(set).where(and(eq(journeys.tenantId, tenantId), eq(journeys.id, id))).returning();
  return rows[0] ?? null;
}

/**
 * حذف رحلة: يلغي التسجيلات الجارية ثم يحذف صفوف journey_runs ثم الرحلة (FK بلا CASCADE).
 * مهام الخطوات المؤجّلة العالقة تصبح no-op (executeJourneyStep → gone عند غياب الـ run).
 * يعيد true إن وُجدت وحُذفت. عملية المالك الصريحة — تاريخ الإرسال محفوظ بالـ outbox/messages.
 */
export async function deleteJourney(tx: Tx, tenantId: string, id: string): Promise<boolean> {
  const exists = await tx.select({ id: journeys.id }).from(journeys).where(and(eq(journeys.tenantId, tenantId), eq(journeys.id, id))).limit(1);
  if (!exists[0]) return false;
  await tx.delete(journeyRuns).where(and(eq(journeyRuns.tenantId, tenantId), eq(journeyRuns.journeyId, id)));
  await tx.delete(journeys).where(and(eq(journeys.tenantId, tenantId), eq(journeys.id, id)));
  return true;
}
