import { createDb, tenants, type DbHandle } from "@quickdrop/db";
import type { DispatchJob, NotificationJob } from "@quickdrop/shared";
import type { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchOrderJobId } from "./dispatch-worker.js";
import { createNotificationsProcessor, type NotificationsConsumerDeps } from "./notifications-consumer.js";

// المرحلة 3 — قائمة §4.2 الحاجبة (مستوى المستهلك): (1) order.ready_for_dispatch هو
// **مُنتِج الإسناد الوحيد** — يُدرج dispatch-order بمعرّف حتمي؛ (2) المحفّز القديم حُذف:
// to='confirmed' لا يُدرج شيئاً (adversary #2 — كان يُرسل سائقاً لطلبات pickup)؛
// (3) تسليم الحدث مرتين ⇒ نفس jobId (طابور BullMQ يزيل الثاني — جولة واحدة).

const APP_URL = process.env["DATABASE_URL"];
const WORKER_URL = process.env["DATABASE_URL_WORKER"];
const hasDb = Boolean(APP_URL && WORKER_URL);

const ORDER_ID = "0198c2e6-4444-7abc-8def-123456789abc";

describe.skipIf(!hasDb)("مستهلك المفصل (§4.2) — تكامل بقاعدة حية وطابور مسجّل", () => {
  let app: DbHandle;
  let scan: DbHandle;
  let tenantId: string;
  const dispatchAdds: { data: DispatchJob; jobId: string | undefined }[] = [];

  const fakeDispatchQueue = {
    add: (_name: string, data: DispatchJob, opts?: { jobId?: string }) => {
      dispatchAdds.push({ data, jobId: opts?.jobId });
      return Promise.resolve({});
    },
  } as unknown as Queue<DispatchJob>;

  // rt/redis/بوتات لا تلزم مسارات هذا الاختبار — بدائل بنيوية دنيا
  const fakeRt = { publish: () => Promise.resolve(1) };
  const fakeConvRedis = {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve("OK"),
    del: () => Promise.resolve(1),
  };

  function deps(): NotificationsConsumerDeps {
    return {
      appDb: app.db,
      scanDb: scan.db,
      redis: fakeConvRedis as never,
      masterKey: Buffer.alloc(32),
      dispatchQueue: fakeDispatchQueue,
      rtRedis: fakeRt as never,
    };
  }

  function jobFor(topic: string, payload: Record<string, unknown>): NotificationJob {
    return { outboxId: "ob-1", tenantId, topic, payload };
  }

  beforeAll(async () => {
    app = createDb(APP_URL!);
    scan = createDb(WORKER_URL!);
    const t = await app.db
      .insert(tenants)
      .values({ slug: `seamc-${Date.now().toString(36)}`, name: "Seam Consumer QA", nameAr: "مفصل" })
      .returning({ id: tenants.id });
    tenantId = t[0]!.id;
  });

  afterAll(async () => {
    await app.db.delete(tenants).where(eq(tenants.id, tenantId));
    await app.close();
    await scan.close();
  });

  it("order.ready_for_dispatch → dispatch-order round 1 بمعرّف حتمي؛ التسليم المزدوج ⇒ نفس المعرّف", async () => {
    const process = createNotificationsProcessor(deps());
    dispatchAdds.length = 0;

    await process(jobFor("order.ready_for_dispatch", { orderId: ORDER_ID }));
    expect(dispatchAdds).toHaveLength(1);
    expect(dispatchAdds[0]!.data).toEqual({ kind: "dispatch-order", tenantId, orderId: ORDER_ID, round: 1 });
    expect(dispatchAdds[0]!.jobId).toBe(dispatchOrderJobId(ORDER_ID, 1));

    // at-least-once: نفس الحدث يصل ثانيةً — نفس jobId حرفياً (BullMQ يُسقط الإدراج الثاني)
    await process(jobFor("order.ready_for_dispatch", { orderId: ORDER_ID }));
    expect(dispatchAdds).toHaveLength(2);
    expect(dispatchAdds[1]!.jobId).toBe(dispatchAdds[0]!.jobId);
  });

  it("حمولة فاسدة للموضوع → رمي (DLQ عبر backoff) لا تجاهل صامت", async () => {
    const process = createNotificationsProcessor(deps());
    await expect(process(jobFor("order.ready_for_dispatch", { bogus: true }))).rejects.toThrow(/invalid payload/);
  });

  it("المحفّز القديم حُذف: order.status_changed[to=confirmed] لا يُدرج أي مهمة إسناد", async () => {
    const process = createNotificationsProcessor(deps());
    dispatchAdds.length = 0;
    // طلب غير موجود بالقاعدة: المعالج يمضي لمساره (لوحة/بطاقات) لكن **لا** إدراج إسناد —
    // القرار كان يحدث قبل أي قراءة قاعدة، فغيابه يثبت حذف المحفّز لا فشل لاحق.
    await process(jobFor("order.status_changed", { orderId: ORDER_ID, from: "pending", to: "confirmed" })).catch(() => undefined);
    expect(dispatchAdds).toHaveLength(0);
  });
});
