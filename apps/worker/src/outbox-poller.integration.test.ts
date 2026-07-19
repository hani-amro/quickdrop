import { createDb, outbox, tenants, withTenant, writeOutbox, type DbHandle } from "@quickdrop/db";
import type { NotificationJob } from "@quickdrop/shared";
import type { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OUTBOX_MAX_ATTEMPTS, pollOnce, type OutboxPollerDeps } from "./outbox-poller.js";

// §12 / MERGE_PLAN R-16 — اختبار انحدار الصف السام (مطلب المالك صراحة):
// قبل الإصلاح، صف outbox يفشل التقاطه دوماً كان يُعاد كل ثانية للأبد بلا محاسبة.
// نثبت على قاعدة حية أن: (1) الفشل يُحاسَب attempts+backoff، (2) الـ backoff يُحترم
// فلا حلقة ساخنة، (3) بعد السقف يتحول failed ويُبلَّغ onPoisoned مرة واحدة ثم لا
// يُلتقط أبداً، (4) الصف السليم بنفس الدفعة لا يتأثر إطلاقاً.

const APP_URL = process.env["DATABASE_URL"];
const WORKER_URL = process.env["DATABASE_URL_WORKER"];
const hasDb = Boolean(APP_URL && WORKER_URL);

const POISON_TOPIC = "test.poison";
const HEALTHY_TOPIC = "test.healthy";

describe.skipIf(!hasDb)("R-16 — الصف السام بالـ outbox (تكامل، قاعدة حية)", () => {
  let app: DbHandle;
  let scan: DbHandle;
  let tenantId: string;
  let poisonId: string;
  let healthyId: string;
  const poisonedEvents: { outboxId: string; tenantId: string }[] = [];
  const delivered: NotificationJob[] = [];

  // طابور مزيف: موضوع السم يرمي (يحاكي فشل نقلٍ دائم)، الباقي ينجح. pollOnce مسح **عام**
  // عبر المستأجرين، فقد يلتقط صفوف outbox معلّقة من ملفات اختبار أخرى تشارك القاعدة —
  // نحصر التأثيرات (العدّ + محاكاة الفشل) بمستأجر هذا الاختبار كي تبقى التوكيدات محكمة؛
  // صفّ مستأجر آخر (بقايا) نبتلعه بنجاح (يُعلَّم sent) فلا يُعاد التقاطه ولا يلوّث العدّ.
  const queue = {
    add: async (_name: string, job: NotificationJob): Promise<void> => {
      if (job.tenantId !== tenantId) return; // بقايا مستأجر آخر — تجاهل بلا عدّ
      if (job.topic === POISON_TOPIC) throw new Error("simulated permanent transport failure");
      delivered.push(job);
    },
  } as unknown as Queue<NotificationJob>;

  const deps = (): OutboxPollerDeps => ({
    scanDb: scan.db,
    appDb: app.db,
    queue,
    onPoisoned: (info) => poisonedEvents.push(info),
  });

  async function readRow(id: string): Promise<{ status: string; attempts: number; nextAttemptAt: Date | null }> {
    // القراءة عبر scanDb (سياسة worker_scan على outbox — قراءة عابرة بلا سياق)
    const rows = await scan.db
      .select({ status: outbox.status, attempts: outbox.attempts, nextAttemptAt: outbox.nextAttemptAt })
      .from(outbox)
      .where(eq(outbox.id, id))
      .limit(1);
    if (!rows[0]) throw new Error(`outbox row ${id} disappeared`);
    return rows[0];
  }

  beforeAll(async () => {
    app = createDb(APP_URL!);
    scan = createDb(WORKER_URL!);
    const inserted = await app.db
      .insert(tenants)
      .values({ slug: `ob-poison-${Date.now().toString(36)}`, name: "Outbox Poison QA", nameAr: "سم" })
      .returning({ id: tenants.id });
    tenantId = inserted[0]!.id;
    const ids = await withTenant(app.db, tenantId, async (tx) => {
      const p = await writeOutbox(tx, tenantId, POISON_TOPIC, { boom: true });
      const h = await writeOutbox(tx, tenantId, HEALTHY_TOPIC, { ok: true });
      return { p: p.id, h: h.id };
    });
    poisonId = ids.p;
    healthyId = ids.h;
  });

  afterAll(async () => {
    await withTenant(app.db, tenantId, async (tx) => {
      await tx.delete(outbox).where(eq(outbox.tenantId, tenantId));
    });
    await app.db.delete(tenants).where(eq(tenants.id, tenantId));
    await app.close();
    await scan.close();
  });

  it("دورة أولى: السليم يُرسَل sent والسام يُحاسَب (attempts=1، backoff مستقبلي، يبقى pending)", async () => {
    await pollOnce(deps(), () => false);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.topic).toBe(HEALTHY_TOPIC);
    expect((await readRow(healthyId)).status).toBe("sent");

    const poison = await readRow(poisonId);
    expect(poison.status).toBe("pending"); // لم يُسمَّم بعد — إعادة محاولة مؤجلة
    expect(poison.attempts).toBe(1);
    expect(poison.nextAttemptAt).not.toBeNull();
    expect(poison.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("الدورة الفورية التالية تتخطى السام — الـ backoff يُحترم فلا حلقة ساخنة", async () => {
    await pollOnce(deps(), () => false);
    const poison = await readRow(poisonId);
    expect(poison.attempts).toBe(1); // لم يُلتقط ثانيةً قبل موعده
    expect(delivered).toHaveLength(1); // ولا إرسال مكرر للسليم (صار sent)
  });

  it("بعد بلوغ السقف يتحول failed ويُبلَّغ onPoisoned مرة واحدة ثم لا يُلتقط أبداً", async () => {
    // تسريع الزمن: قرّب الموعد وارفع العداد إلى السقف-1 (المسار نفسه، بلا انتظار حقيقي)
    await withTenant(app.db, tenantId, async (tx) => {
      await tx
        .update(outbox)
        .set({ attempts: OUTBOX_MAX_ATTEMPTS - 1, nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(outbox.id, poisonId));
    });

    await pollOnce(deps(), () => false);

    const poison = await readRow(poisonId);
    expect(poison.status).toBe("failed"); // DLQ منطقي — المقياس METRIC_OUTBOX_FAILED يلتقطه (§13)
    expect(poison.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(poisonedEvents).toEqual([{ outboxId: poisonId, tenantId }]);

    // حتى لو صار موعده مستحقاً: failed لا يُلتقط (المسح pending حصراً)
    await withTenant(app.db, tenantId, async (tx) => {
      await tx.update(outbox).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(outbox.id, poisonId));
    });
    await pollOnce(deps(), () => false);
    expect((await readRow(poisonId)).attempts).toBe(OUTBOX_MAX_ATTEMPTS); // لا محاولات إضافية
    expect(poisonedEvents).toHaveLength(1); // ولا تبليغ مكرر
  });
});
