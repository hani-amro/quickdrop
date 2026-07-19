import {
  createDb,
  createDriver,
  createMerchant,
  createOrder,
  orders,
  pricingRules,
  tenants,
  transition,
  upsertCatalogItem,
  users,
  waAccounts,
  withTenant,
  type DbHandle,
} from "@quickdrop/db";
import { encryptSecret, makePoint, type DispatchJob, type NotificationJob } from "@quickdrop/shared";
import type { Queue } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNotificationsProcessor, type NotificationsConsumerDeps } from "./notifications-consumer.js";

// خطوة 20 (§4.2.5 / adversary #18) — مستهلك payment.paid:
// (1) pickup معلّق → confirmed آلياً (فاعل system)؛ التسليم المزدوج idempotent
//     (InvalidTransitionError = نجاح، لا رمي).
// (2) بوابة البشر: طلب **توصيل** معلّق مدفوع يبقى pending — الدفع لا يحرّك سائقاً.
// (3) إشعار زبون واتساب عبر Graph (fetch محقون — بلا شبكة).

const APP_URL = process.env["DATABASE_URL"];
const WORKER_URL = process.env["DATABASE_URL_WORKER"];
const hasDb = Boolean(APP_URL && WORKER_URL);

const POINT = makePoint(33.5138, 36.2765);
const DROP = makePoint(33.5588, 36.2765);

describe.skipIf(!hasDb)("مستهلك الدفع (تكامل، قاعدة حية)", () => {
  let app: DbHandle;
  let scan: DbHandle;
  let tenantId: string;
  let customerId: string;
  let merchantId: string;
  let itemId: string;
  const waSends: { url: string; body: string }[] = [];

  const waFetch = ((url: string, init: RequestInit) => {
    waSends.push({ url: String(url), body: String(init.body) });
    return Promise.resolve(new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), { status: 200 }));
  }) as unknown as typeof fetch;

  const fakeDispatchQueue = { add: () => Promise.resolve({}) } as unknown as Queue<DispatchJob>;
  const fakeRt = { publish: () => Promise.resolve(1) };
  const fakeConvRedis = { get: () => Promise.resolve(null), set: () => Promise.resolve("OK"), del: () => Promise.resolve(1) };
  const MASTER_KEY = Buffer.alloc(32, 7);

  function deps(): NotificationsConsumerDeps {
    return {
      appDb: app.db,
      scanDb: scan.db,
      redis: fakeConvRedis as never,
      masterKey: MASTER_KEY,
      dispatchQueue: fakeDispatchQueue,
      rtRedis: fakeRt as never,
      waFetch,
    };
  }

  beforeAll(async () => {
    app = createDb(APP_URL!);
    scan = createDb(WORKER_URL!);
    const t = await app.db
      .insert(tenants)
      .values({ slug: `payc-${Date.now().toString(36)}`, name: "Pay QA", nameAr: "دفع", plan: "growth" })
      .returning({ id: tenants.id });
    tenantId = t[0]!.id;
    await withTenant(app.db, tenantId, async (tx) => {
      // زبون واتساب فقط (بلا تيليغرام) — يجبر مسار WA transport
      const u = await tx.insert(users).values({ tenantId, role: "customer", waId: "60111222333", firstName: "Aina" }).returning({ id: users.id });
      customerId = u[0]!.id;
      // حساب WA مهيأ بتوكن مشفّر (fetch مزيف — لا شبكة)
      await tx.insert(waAccounts).values({
        tenantId,
        phoneNumberId: `pnid-${Date.now().toString(36)}`,
        accessTokenEnc: encryptSecret("wa-token-test", MASTER_KEY),
      });
      // تسعير food (لطلب التوصيل بالاختبار 2)
      await tx.insert(pricingRules).values({ tenantId, service: "food", base: 5_000n, perKm: 1_000n, perKg: 0n, minTotal: 0n, surgeMultiplierBp: 10_000, priority: 0 });
    });
    const m = await createMerchant(app.db, tenantId, { name: "مطعم الدفع", point: POINT, category: "restaurant" });
    merchantId = m.id;
    const item = await upsertCatalogItem(app.db, tenantId, { merchantId, nameAr: "برغر", price: 25_000n });
    itemId = item.id;
  });

  afterAll(async () => {
    // لا حذف: order_events append-only (DELETE مُلغى عن app_user)، فحذف orders يخرق FK.
    // العالم بمستأجر مستقل معزول (RLS) — سويت db يبدأ بـ resetDb (TRUNCATE CASCADE
    // عبر migrator) فيجرف البقايا. نفس نمط seam.integration بحزمة db.
    await app.close();
    await scan.close();
  });

  async function orderStatus(orderId: string): Promise<string> {
    return withTenant(app.db, tenantId, async (tx) => {
      const r = await tx.select({ s: orders.status }).from(orders).where(eq(orders.id, orderId));
      return r[0]!.s;
    });
  }

  it("pickup معلّق + payment.paid → confirmed آلياً؛ التسليم المزدوج لا يرمي (InvalidTransition=نجاح)", async () => {
    const created = await createOrder(app.db, tenantId, {
      service: "food",
      customerId,
      merchantId,
      items: [{ catalogItemId: itemId, qty: 1 }],
      fulfillment: "pickup",
      pickup: POINT,
      createdBy: { type: "staff" },
    });
    const orderId = created.order.id;
    expect(await orderStatus(orderId)).toBe("pending");

    const process = createNotificationsProcessor(deps());
    const job: NotificationJob = { outboxId: "ob-p1", tenantId, topic: "payment.paid", payload: { orderId, paymentRef: "bill_T1" } };
    await process(job);
    expect(await orderStatus(orderId)).toBe("confirmed"); // §4.2.5 — تأكيد pickup آلي

    // إعادة تسليم at-least-once: confirmed→confirmed غير موجود بالآلة — يُلتقط كنجاح، لا DLQ
    await process(job);
    expect(await orderStatus(orderId)).toBe("confirmed");

    // إشعار الزبون ذهب عبر واتساب (زبون WA-only) وسُجّل بالمخزن الموحّد
    expect(waSends.length).toBeGreaterThanOrEqual(1);
    expect(waSends[0]!.body).toContain("60111222333");
  });

  it("بوابة البشر: طلب **توصيل** معلّق + payment.paid → يبقى pending (الدفع لا يحرّك سائقاً)", async () => {
    const created = await createOrder(app.db, tenantId, {
      service: "food",
      customerId,
      merchantId,
      items: [{ catalogItemId: itemId, qty: 1 }],
      pickup: POINT,
      dropoff: DROP,
      createdBy: { type: "staff" },
    });
    const orderId = created.order.id;

    const process = createNotificationsProcessor(deps());
    await process({ outboxId: "ob-p2", tenantId, topic: "payment.paid", payload: { orderId, paymentRef: "bill_T2" } });
    expect(await orderStatus(orderId)).toBe("pending"); // التأكيد للبشر (موظف/تاجر) حصراً
  });

  it("money-F2: طلب توصيل مُسنَد دُفع إلكترونياً → مسار تنبيه السائق (سائق تلفون: تخطٍّ نظيف) والزبون يُشعَر", async () => {
    const created = await createOrder(app.db, tenantId, {
      service: "food",
      customerId,
      merchantId,
      items: [{ catalogItemId: itemId, qty: 1 }],
      pickup: POINT,
      dropoff: DROP,
      createdBy: { type: "staff" },
    });
    const orderId = created.order.id;
    // سائق تلفون (بلا تيليغرام) — يثبت أن مسار notifyDriverPaidOnline يتخطّى بلا رمي
    const drv = await createDriver(app.db, tenantId, { vehicle: "motorbike", phone: "+60199990000", name: "Phone Rider" });
    if (drv.outcome !== "created") throw new Error("driver seed failed");
    await withTenant(app.db, tenantId, async (tx) => {
      await transition(tx, { orderId, to: "confirmed", actor: { type: "staff" } });
      await transition(tx, { orderId, to: "assigned", actor: { type: "staff" }, driverId: drv.driver.id });
    });
    const before = waSends.length;
    const process = createNotificationsProcessor(deps());
    // لا رمي رغم استدعاء مسار السائق؛ والزبون (WA) يُشعَر
    await process({ outboxId: "ob-f2", tenantId, topic: "payment.paid", payload: { orderId, paymentRef: "bill_F2" } });
    expect(waSends.length).toBe(before + 1); // إشعار الزبون
    expect(await orderStatus(orderId)).toBe("assigned"); // التوصيل لا يتأثر بالدفع (بوابة البشر)
  });

  it("payment.link → رسالة الرابط للزبون عبر واتساب", async () => {
    const created = await createOrder(app.db, tenantId, {
      service: "food",
      customerId,
      merchantId,
      items: [{ catalogItemId: itemId, qty: 1 }],
      pickup: POINT,
      dropoff: DROP,
      createdBy: { type: "staff" },
    });
    const before = waSends.length;
    const process = createNotificationsProcessor(deps());
    await process({
      outboxId: "ob-p3",
      tenantId,
      topic: "payment.link",
      payload: { orderId: created.order.id, userId: customerId, url: "https://billplz.test/bills/bill_T3" },
    });
    expect(waSends.length).toBe(before + 1);
    expect(waSends[waSends.length - 1]!.body).toContain("billplz.test");
  });
});
