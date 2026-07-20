import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { driverTransition, listDriverAssignedOrders, listDriverOffers } from "./driver-actions.js";
import { getOrCreateConversation, recordInboundMessage } from "./conversations-service.js";
import { attachPaymentRef, markOrderPaidByRef } from "./payments.js";
import { offers } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";
import {
  closeHarness,
  connectHarness,
  doTransition,
  hasDb,
  makeOrder,
  seedDriver,
  seedWorld,
  type TestHarness,
} from "./test-helpers.js";

// P5.3 — بوابة العزل الكاملة (توجيه المالك): مستأجران A/B ببيانات متوازية عبر كل السطح
// المدموج (طلبات، سائقون، عروض، محادثات، دفع، قناة السائق P5.1)؛ نُجري كل مسار قراءة
// بسياق A ونؤكد **صفر تسرّب** من B — تصفية الكود (withTenant) وRLS معاً. يشمل مجساً
// **مولَّداً** لكل جداول tenant_id: بسياق A، عدد صفوف tenant_id=B = 0 (والعكس).

const RLS_EXCEPTIONS = new Set(["tenants", "admin_users", "tracking_tokens", "spatial_ref_sys"]);

interface Party {
  tenantId: string;
  customerId: string;
  driverId: string;
  orderId: string;
  offerId: string;
  ref: string;
  conversationId: string;
}

describe.skipIf(!hasDb)("P5.3 — عزل مستأجرين كامل (كل مسار قراءة كـ A → صفر تسرّب من B)", () => {
  let h: TestHarness;
  let A: Party;
  let B: Party;
  let tenantTables: string[] = [];

  async function seedParty(): Promise<Party> {
    const { tenantId, customerId } = await seedWorld(h.app.db);
    const driverId = await seedDriver(h.app.db, tenantId);
    const { order } = await makeOrder(h.app.db, tenantId, { customerId }); // confirmed
    // أسند الطلب لهذا السائق (assigned) — يملأ orders.driver_id + order_events
    await doTransition(h.app.db, tenantId, { orderId: order.id, to: "assigned", actor: { type: "staff" }, driverId });
    // عرض معلّق (يملأ offers + يغذّي listDriverOffers)
    const offerId = await withTenant(h.app.db, tenantId, async (tx) => {
      const r = await tx
        .insert(offers)
        .values({ tenantId, orderId: order.id, driverId, status: "pending", expiresAt: new Date(Date.now() + 60_000), round: 1 })
        .returning({ id: offers.id });
      return r[0]!.id;
    });
    // مرجع دفع فريد عالمياً (معرّف المستأجر الكامل — uuidv7 يتشارك بادئة الوقت فيتصادم slice)
    const ref = `bill_${tenantId}`;
    await attachPaymentRef(h.app.db, tenantId, { orderId: order.id, paymentRef: ref });
    const conversationId = await withTenant(h.app.db, tenantId, async (tx) => {
      const { id } = await getOrCreateConversation(tx, tenantId, customerId);
      await recordInboundMessage(tx, { tenantId, conversationId: id, channel: "whatsapp", type: "text", content: "hi", externalId: `ext-${id}` });
      return id;
    });
    return { tenantId, customerId, driverId, orderId: order.id, offerId, ref, conversationId };
  }

  beforeAll(async () => {
    // لا resetDb: مستأجران معزولان (A/B) والمجسّات مقيّدة بمعرّفيهما — بيانات مستأجرين آخرين
    // لا تؤثر (RLS يقصيها من سياق A/B). فيبقى الاختبار مستقلاً عن ترتيب الملفات/التوازي.
    h = connectHarness();
    A = await seedParty();
    B = await seedParty();
    const rows = await h.app.db.execute(sql`
      SELECT c.table_name FROM information_schema.columns c
        JOIN pg_class pc ON pc.relname = c.table_name
        JOIN pg_namespace n ON n.oid = pc.relnamespace AND n.nspname = 'public'
       WHERE c.table_schema = 'public' AND pc.relkind = 'r' AND c.column_name = 'tenant_id'
       ORDER BY c.table_name`);
    tenantTables = (rows.rows as { table_name: string }[]).map((r) => r.table_name).filter((t) => !RLS_EXCEPTIONS.has(t));
  });

  afterAll(async () => {
    await closeHarness(h);
  });

  // ——— مسارات القراءة المدموجة: كل واحدة بسياق A ترى A فقط ———

  it("قناة السائق (P5.1): طلبات/عروض السائق تُرى ضمن مستأجرها فقط", async () => {
    const aOrders = await listDriverAssignedOrders(h.app.db, A.tenantId, A.driverId);
    expect(aOrders.map((o) => o.id)).toEqual([A.orderId]);
    // سائق B تحت سياق A → لا شيء (RLS يخفي صف سائق B، فلا طلبات)
    expect(await listDriverAssignedOrders(h.app.db, A.tenantId, B.driverId)).toEqual([]);

    const aOffers = await listDriverOffers(h.app.db, A.tenantId, A.driverId);
    expect(aOffers.map((o) => o.offerId)).toEqual([A.offerId]);
    expect(await listDriverOffers(h.app.db, A.tenantId, B.driverId)).toEqual([]);
  });

  it("قناة السائق: لا يمكن لسياق A تحريك حالة طلب B (not_yours)", async () => {
    // driverA بسياق A على طلب B: RLS يخفي صف طلب B → القفل لا يجد صفاً → not_yours
    const r = await driverTransition(h.app.db, A.tenantId, A.driverId, B.orderId, "picked_up");
    expect(r.ok).toBe(false);
  });

  it("الدفع: مرجع B لا يُدفَع بسياق A (not_found)، ولا يعلّم طلب B مدفوعاً", async () => {
    expect(await markOrderPaidByRef(h.app.db, A.tenantId, { paymentRef: B.ref })).toEqual({ outcome: "not_found" });
    expect(await markOrderPaidByRef(h.app.db, B.tenantId, { paymentRef: A.ref })).toEqual({ outcome: "not_found" });
  });

  it("العروض عبر القراءة الخام بسياق A: صفر صفوف تخص B", async () => {
    const bOfferUnderA = await withTenant(h.app.db, A.tenantId, (tx) =>
      tx.select({ id: offers.id }).from(offers).where(eq(offers.id, B.offerId)),
    );
    expect(bOfferUnderA).toEqual([]); // RLS يخفي عرض B رغم معرفتنا معرّفه
  });

  // ——— المجس المولَّد: لكل جدول tenant_id، بسياق A عدد صفوف B = 0 (والعكس) ———

  it("مجس مولَّد: بسياق كل مستأجر، صفر صفوف مرئية تخص المستأجر الآخر (كل جداول tenant_id)", async () => {
    expect(tenantTables.length).toBeGreaterThanOrEqual(25);
    const leaks: string[] = [];
    for (const table of tenantTables) {
      // بسياق A: كم صفاً tenant_id=B مرئي؟ (RLS يجب أن يخفيها كلها → 0)
      const underA = await withTenant(h.app.db, A.tenantId, (tx) =>
        tx.execute(sql.raw(`SELECT count(*)::int AS n FROM "${table}" WHERE tenant_id = '${B.tenantId}'`)),
      );
      const nA = (underA.rows[0] as { n: number }).n;
      if (nA !== 0) leaks.push(`${table}: A-context sees ${nA} of B's rows`);
      // بسياق B: كم صفاً tenant_id=A مرئي؟
      const underB = await withTenant(h.app.db, B.tenantId, (tx) =>
        tx.execute(sql.raw(`SELECT count(*)::int AS n FROM "${table}" WHERE tenant_id = '${A.tenantId}'`)),
      );
      const nB = (underB.rows[0] as { n: number }).n;
      if (nB !== 0) leaks.push(`${table}: B-context sees ${nB} of A's rows`);
    }
    expect(leaks, `cross-tenant leakage: ${leaks.join(" | ")}`).toEqual([]);
  });

  it("مجس مولَّد (إيجابي): كل مستأجر يرى صفوفه هو (المجس السلبي ليس فارغاً لأن لا بيانات)", async () => {
    // نثبت أن الطرفين مبذوران فعلاً في جداول مفتاحية — وإلا كان المجس السلبي يمرّ فارغاً
    for (const table of ["orders", "drivers", "offers", "conversations", "messages", "users"]) {
      const seenByA = await withTenant(h.app.db, A.tenantId, (tx) => tx.execute(sql.raw(`SELECT count(*)::int AS n FROM "${table}"`)));
      expect((seenByA.rows[0] as { n: number }).n, `${table} should have A rows`).toBeGreaterThan(0);
    }
  });
});
