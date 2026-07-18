import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client.js";
import { cancelActiveJourneyRuns, enrollInJourneys, executeJourneyStep } from "./journeys-service.js";
import { conversations, customerProfiles, journeyRuns, journeys, messages, outbox, tenants, users } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";
import { APP_URL, hasDb } from "./test-helpers.js";

// P2.5 — تكامل حي: تسجيل مطابق للجمهور → تنفيذ خطوات (رسالة + وسم) → اكتمال؛ stop-on-reply.

describe.skipIf(!hasDb)("journeys-service (تكامل، قاعدة حية)", () => {
  let app: DbHandle;
  let tenantId: string;
  let userId: string;
  let journeyId: string;

  beforeAll(async () => {
    app = createDb(APP_URL!);
    const t = await app.db.insert(tenants).values({ slug: `jrn-${Date.now().toString(36)}`, name: "Journey QA", nameAr: "رحلة" }).returning({ id: tenants.id });
    tenantId = t[0]!.id;
    await withTenant(app.db, tenantId, async (tx) => {
      const u = await tx.insert(users).values({ tenantId, role: "customer", telegramUserId: 88801, firstName: "Sami" }).returning({ id: users.id });
      userId = u[0]!.id;
      await tx.insert(customerProfiles).values({ tenantId, userId, lifecycleStage: "at_risk", rfmScore: 20, tags: [] });
      const j = await tx.insert(journeys).values({
        tenantId, name: "win-back", trigger: "crm.lifecycle_changed", isActive: true,
        audienceFilter: { lifecycleStage: ["at_risk"] },
        steps: [
          { type: "send_message", delayHours: 0, template: "اشتقنالك {name}!" },
          { type: "add_tag", delayHours: 0, tag: "winback_sent" },
        ],
      }).returning({ id: journeys.id });
      journeyId = j[0]!.id;
    });
  });

  afterAll(async () => {
    await withTenant(app.db, tenantId, async (tx) => {
      await tx.execute(sql`DELETE FROM messages WHERE tenant_id = ${tenantId}::uuid`);
      await tx.execute(sql`DELETE FROM conversations WHERE tenant_id = ${tenantId}::uuid`);
      await tx.execute(sql`DELETE FROM journey_runs WHERE tenant_id = ${tenantId}::uuid`);
      await tx.execute(sql`DELETE FROM journeys WHERE tenant_id = ${tenantId}::uuid`);
      await tx.delete(outbox).where(eq(outbox.tenantId, tenantId));
      await tx.delete(customerProfiles).where(eq(customerProfiles.tenantId, tenantId));
      await tx.delete(users).where(eq(users.tenantId, tenantId));
    });
    await app.db.delete(tenants).where(eq(tenants.id, tenantId));
    await app.close();
  });

  it("التسجيل يطابق الجمهور (at_risk) وينشئ run نشطاً بموعد فوري", async () => {
    const enrolled = await withTenant(app.db, tenantId, (tx) => enrollInJourneys(tx, tenantId, userId, "crm.lifecycle_changed"));
    expect(enrolled).toHaveLength(1);
    expect(enrolled[0]!.currentStep).toBe(0);
    const run = await withTenant(app.db, tenantId, async (tx) => {
      const rows = await tx.select().from(journeyRuns).where(and(eq(journeyRuns.tenantId, tenantId), eq(journeyRuns.userId, userId)));
      return rows[0]!;
    });
    expect(run.status).toBe("active");
    expect(run.currentStep).toBe(0);
  });

  it("تسجيل ثانٍ لنفس (رحلة، زبون) لا يضاعف (فريد once-ever)", async () => {
    const enrolled = await withTenant(app.db, tenantId, (tx) => enrollInJourneys(tx, tenantId, userId, "crm.lifecycle_changed"));
    expect(enrolled).toHaveLength(0);
  });

  it("تنفيذ الخطوة 0 (send_message): رسالة صادرة + outbox 'journey.message'، ثم يتقدّم للخطوة 1", async () => {
    const runId = await withTenant(app.db, tenantId, async (tx) => {
      const rows = await tx.select({ id: journeyRuns.id }).from(journeyRuns).where(eq(journeyRuns.tenantId, tenantId));
      return rows[0]!.id;
    });
    const outcome = await withTenant(app.db, tenantId, (tx) => executeJourneyStep(tx, tenantId, runId, "مطعمنا"));
    expect(outcome.outcome).toBe("advanced");

    const check = await withTenant(app.db, tenantId, async (tx) => {
      const msg = await tx.select({ content: messages.content, dir: messages.direction }).from(messages).where(and(eq(messages.tenantId, tenantId), eq(messages.direction, "out")));
      const ob = await tx.select({ topic: outbox.topic }).from(outbox).where(and(eq(outbox.tenantId, tenantId), eq(outbox.topic, "journey.message")));
      const run = await tx.select({ step: journeyRuns.currentStep }).from(journeyRuns).where(eq(journeyRuns.id, runId));
      return { msg: msg[0], ob: ob.length, step: run[0]!.step };
    });
    expect(check.msg!.content).toBe("اشتقنالك Sami!"); // {name} استُبدل
    expect(check.ob).toBe(1);
    expect(check.step).toBe(1);
  });

  it("تنفيذ الخطوة 1 (add_tag): يضيف الوسم ثم يكتمل الـ run", async () => {
    const runId = await withTenant(app.db, tenantId, async (tx) => {
      const rows = await tx.select({ id: journeyRuns.id }).from(journeyRuns).where(eq(journeyRuns.tenantId, tenantId));
      return rows[0]!.id;
    });
    const outcome = await withTenant(app.db, tenantId, (tx) => executeJourneyStep(tx, tenantId, runId, "مطعمنا"));
    expect(outcome.outcome).toBe("completed");
    const check = await withTenant(app.db, tenantId, async (tx) => {
      const p = await tx.select({ tags: customerProfiles.tags }).from(customerProfiles).where(and(eq(customerProfiles.tenantId, tenantId), eq(customerProfiles.userId, userId)));
      const run = await tx.select({ status: journeyRuns.status }).from(journeyRuns).where(eq(journeyRuns.id, runId));
      const j = await tx.select({ completed: journeys.completedCount }).from(journeys).where(eq(journeys.id, journeyId));
      return { tags: p[0]!.tags, status: run[0]!.status, completed: j[0]!.completed };
    });
    expect(check.tags).toContain("winback_sent");
    expect(check.status).toBe("completed");
    expect(check.completed).toBe(1);
  });

  it("stop-on-reply: cancelActiveJourneyRuns يلغي التسجيلات النشطة", async () => {
    // سجّل من جديد (الرحلة أُكملت؛ نلغي القيد لإعادة التسجيل ثم نختبر الإلغاء)
    await withTenant(app.db, tenantId, async (tx) => {
      await tx.delete(journeyRuns).where(eq(journeyRuns.tenantId, tenantId));
    });
    await withTenant(app.db, tenantId, (tx) => enrollInJourneys(tx, tenantId, userId, "crm.lifecycle_changed"));
    const cancelled = await withTenant(app.db, tenantId, (tx) => cancelActiveJourneyRuns(tx, tenantId, userId));
    expect(cancelled).toBe(1);
    const status = await withTenant(app.db, tenantId, async (tx) => {
      const rows = await tx.select({ status: journeyRuns.status }).from(journeyRuns).where(eq(journeyRuns.tenantId, tenantId));
      return rows[0]!.status;
    });
    expect(status).toBe("cancelled");
  });
});
