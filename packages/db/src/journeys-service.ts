import type { LifecycleStage } from "@quickdrop/shared";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./client.js";
import { getOrCreateConversation, recordOutboundMessage } from "./conversations-service.js";
import { writeOutbox } from "./outbox.js";
import { conversations, customerProfiles, journeyRuns, journeys, users } from "./schema/index.js";
import { withTenant, type Tx } from "./with-tenant.js";

// دمج WaFlow (MERGE_PLAN §3.4) — Journeys: منطق المحرك الوحيد. الخطوات/الجمهور بـ Zod
// (§11). التنفيذ داخل ترانزاكشن مستأجر؛ الإرسال عبر outbox (D9، لا نداء شبكي هنا).

// —— Zod: الجمهور والخطوات (حدود §11) ——
export const audienceFilterSchema = z
  .object({
    lifecycleStage: z.array(z.string()).optional(),
    minRfm: z.number().int().min(0).max(100).optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();
export type AudienceFilter = z.infer<typeof audienceFilterSchema>;

export const journeyStepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("send_message"), delayHours: z.number().min(0).max(8760), template: z.string().min(1).max(2000) }),
  z.object({ type: z.literal("ai_handoff"), delayHours: z.number().min(0).max(8760) }),
  z.object({ type: z.literal("add_tag"), delayHours: z.number().min(0).max(8760), tag: z.string().min(1).max(60) }),
  z.object({ type: z.literal("wait"), delayHours: z.number().min(0).max(8760) }),
]);
export const journeyStepsSchema = z.array(journeyStepSchema).min(1).max(20);
export type JourneyStep = z.infer<typeof journeyStepSchema>;

// —— مطابقة الجمهور (نقية، قابلة للاختبار) ——
export interface AudienceProfile {
  lifecycleStage: LifecycleStage | null;
  rfmScore: number | null;
  tags: string[];
}

export function matchesAudience(profile: AudienceProfile, filter: AudienceFilter | null): boolean {
  if (!filter) return true;
  if (filter.lifecycleStage && filter.lifecycleStage.length > 0) {
    if (profile.lifecycleStage === null || !filter.lifecycleStage.includes(profile.lifecycleStage)) return false;
  }
  if (filter.minRfm !== undefined && (profile.rfmScore ?? 0) < filter.minRfm) return false;
  if (filter.tags && filter.tags.length > 0) {
    if (!filter.tags.every((t) => profile.tags.includes(t))) return false;
  }
  return true;
}

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
