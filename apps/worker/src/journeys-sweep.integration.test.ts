import { createDb, journeyRuns, journeys, tenants, users, withTenant, type DbHandle } from "@quickdrop/db";
import type { JourneyStepJob } from "@quickdrop/shared";
import type { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startJourneysRescan } from "./journeys-sweep.js";

// §3.4/§12 — شبكة أمان الرحلات (إصلاح مراجعة Phase 2، HIGH): run نشط مستحقّ بلا مهمة
// مجدولة (فشل جدولة post-commit) يجب أن يستردّه الكنس الدوري — وإلا خطوة لا تُنفَّذ أبداً.
// نثبت على قاعدة حية: (1) run مستحقّ → مهمة jrs-{run}-{step} بحمولة step صحيحة،
// (2) run بموعد مستقبلي → لا يُلمس (لا churn).

const APP_URL = process.env["DATABASE_URL"];
const WORKER_URL = process.env["DATABASE_URL_WORKER"];
const hasDb = Boolean(APP_URL && WORKER_URL);

interface RecordedAdd {
  name: string;
  data: JourneyStepJob;
  opts: { jobId?: string };
}

describe.skipIf(!hasDb)("journeys-sweep (تكامل، قاعدة حية) — استرداد run يتيم", () => {
  let app: DbHandle;
  let scan: DbHandle;
  let tenantId: string;
  let userId: string;
  let journeyId: string;
  let dueRunId: string;
  let futureRunId: string;
  const adds: RecordedAdd[] = [];
  const removed: string[] = [];

  // طابور مزيف — يسجّل add/remove فقط (لا Redis؛ نختبر منطق الكنس لا BullMQ)
  const fakeQueue = {
    add: (name: string, data: JourneyStepJob, opts: { jobId?: string }) => {
      adds.push({ name, data, opts });
      return Promise.resolve({ id: opts.jobId });
    },
    remove: (jobId: string) => {
      removed.push(jobId);
      return Promise.resolve(1);
    },
  } as unknown as Queue<JourneyStepJob>;

  beforeAll(async () => {
    app = createDb(APP_URL!);
    scan = createDb(WORKER_URL!);
    const t = await app.db.insert(tenants).values({ slug: `jsw-${Date.now().toString(36)}`, name: "Sweep QA", nameAr: "كنس" }).returning({ id: tenants.id });
    tenantId = t[0]!.id;
    await withTenant(app.db, tenantId, async (tx) => {
      const u = await tx.insert(users).values({ tenantId, role: "customer", telegramUserId: 55501, firstName: "Sw" }).returning({ id: users.id });
      userId = u[0]!.id;
      const j = await tx
        .insert(journeys)
        .values({ tenantId, name: "sweep", trigger: "crm.lifecycle_changed", isActive: true, steps: [{ type: "send_message", delayHours: 0, template: "hi" }] })
        .returning({ id: journeys.id });
      journeyId = j[0]!.id;
      // run مستحقّ (next_run_at بالماضي) — يُحاكي يتيماً فقد مهمته
      const due = await tx
        .insert(journeyRuns)
        .values({ tenantId, journeyId, userId, currentStep: 0, status: "active", nextRunAt: new Date(Date.now() - 60_000) })
        .returning({ id: journeyRuns.id });
      dueRunId = due[0]!.id;
    });
    // run آخر بموعد مستقبلي — مستأجر ثانٍ كي لا يصطدم بقيد (tenant, journey, user) الفريد
    const t2 = await app.db.insert(tenants).values({ slug: `jsw2-${Date.now().toString(36)}`, name: "Sweep QA2", nameAr: "كنس٢" }).returning({ id: tenants.id });
    const tenant2 = t2[0]!.id;
    await withTenant(app.db, tenant2, async (tx) => {
      const u = await tx.insert(users).values({ tenantId: tenant2, role: "customer", telegramUserId: 55502, firstName: "Fu" }).returning({ id: users.id });
      const j = await tx.insert(journeys).values({ tenantId: tenant2, name: "future", trigger: "crm.lifecycle_changed", isActive: true, steps: [{ type: "send_message", delayHours: 24, template: "later" }] }).returning({ id: journeys.id });
      const fut = await tx
        .insert(journeyRuns)
        .values({ tenantId: tenant2, journeyId: j[0]!.id, userId: u[0]!.id, currentStep: 0, status: "active", nextRunAt: new Date(Date.now() + 24 * 3_600_000) })
        .returning({ id: journeyRuns.id });
      futureRunId = fut[0]!.id;
    });
    (globalThis as { __sweepTenant2?: string }).__sweepTenant2 = tenant2;
  });

  afterAll(async () => {
    const tenant2 = (globalThis as { __sweepTenant2?: string }).__sweepTenant2!;
    for (const t of [tenantId, tenant2]) {
      await withTenant(app.db, t, async (tx) => {
        await tx.delete(journeyRuns).where(eq(journeyRuns.tenantId, t));
        await tx.delete(journeys).where(eq(journeys.tenantId, t));
        await tx.delete(users).where(eq(users.tenantId, t));
      });
      await app.db.delete(tenants).where(eq(tenants.id, t));
    }
    await app.close();
    await scan.close();
  });

  it("الكنس يجدول المستحقّ بمعرّف حتمي + حمولة step، ولا يلمس المستقبلي", async () => {
    const sweep = startJourneysRescan({ scanDb: scan.db, journeysQueue: fakeQueue, intervalMs: 3_600_000 });
    const n = await sweep.runOnce();
    await sweep.stop();

    // المستحقّ فقط جُدول (المستقبلي غير مستحقّ) — قد توجد runs مستحقّة أخرى من تشغيلات سابقة،
    // فنبحث عن معرّفنا تحديداً بدل مساواة العدّ.
    const mine = adds.find((a) => a.data.runId === dueRunId);
    expect(mine).toBeDefined();
    expect(mine!.name).toBe("journey-step");
    expect(mine!.data).toEqual({ tenantId, runId: dueRunId, step: 0 });
    expect(mine!.opts.jobId).toBe(`jrs-${dueRunId}-0`);
    expect(removed).toContain(`jrs-${dueRunId}-0`); // remove-then-add

    // المستقبلي لم يُجدوَل إطلاقاً
    expect(adds.some((a) => a.data.runId === futureRunId)).toBe(false);
    expect(n).toBeGreaterThanOrEqual(1);
  });
});
