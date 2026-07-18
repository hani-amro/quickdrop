import {
  createDb,
  customerProfiles,
  loyaltyAccounts,
  outbox,
  tenants,
  users,
  withTenant,
  type DbHandle,
} from "@quickdrop/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recomputeCustomerBrain } from "./recompute.js";

// دمج WaFlow §3.3 — تكامل حي لإعادة حساب الدماغ: بذر طلبات مُسلَّمة + أصناف مباشرةً
// (نختبر الدماغ لا إنشاء الطلب)، ثم recompute والتحقق من customer_profiles +
// loyalty_accounts.tier + حدث crm.lifecycle_changed عند تغيّر المرحلة.

const APP_URL = process.env["DATABASE_URL"];
const hasDb = Boolean(APP_URL);

// نقطة WKT ثابتة (geography NOT NULL على orders حتى Phase 3)
const PT = sql`ST_GeogFromText('SRID=4326;POINT(36.2765 33.5138)')`;

describe.skipIf(!hasDb)("recomputeCustomerBrain (تكامل، قاعدة حية)", () => {
  let app: DbHandle;
  let tenantId: string;
  let userId: string;
  let seq = 0;

  async function seedDeliveredOrder(goods: bigint, delivery: bigint, deliveredDaysAgo: number, items: { catId: string; qty: number }[]): Promise<void> {
    seq += 1;
    await withTenant(app.db, tenantId, async (tx) => {
      const code = `B${Date.now().toString(36)}${seq}`;
      // price_base = price_total كي تصحّ معادلة orders_price_equation_ck (base+..−discount)
      const inserted = await tx.execute(sql`
        INSERT INTO orders (id, tenant_id, public_code, service, status, customer_id,
          pickup_point, dropoff_point, price_base, price_total, goods_amount, delivered_at, created_at, updated_at)
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${code}, 'food', 'delivered', ${userId}::uuid,
          ${PT}, ${PT}, ${delivery}, ${delivery}, ${goods}, now() - (${deliveredDaysAgo} || ' days')::interval, now(), now())
        RETURNING id`);
      const orderId = (inserted.rows[0] as { id: string }).id;
      for (const it of items) {
        // catalog_item_id هنا معرّف حر (لا FK حي على order_items.catalog_item_id)
        await tx.execute(sql`
          INSERT INTO order_items (id, tenant_id, order_id, catalog_item_id, name_snapshot, qty, unit_price_snapshot, created_at, updated_at)
          VALUES (gen_random_uuid(), ${tenantId}::uuid, ${orderId}::uuid, ${it.catId}::uuid, 'صنف', ${it.qty}, 1000, now(), now())`);
      }
    });
  }

  beforeAll(async () => {
    app = createDb(APP_URL!);
    const t = await app.db.insert(tenants).values({ slug: `brain-${Date.now().toString(36)}`, name: "Brain QA", nameAr: "دماغ" }).returning({ id: tenants.id });
    tenantId = t[0]!.id;
    userId = await withTenant(app.db, tenantId, async (tx) => {
      const u = await tx.insert(users).values({ tenantId, role: "customer", phoneE164: "+60111111111" }).returning({ id: users.id });
      return u[0]!.id;
    });
  });

  afterAll(async () => {
    await withTenant(app.db, tenantId, async (tx) => {
      await tx.execute(sql`DELETE FROM order_items WHERE tenant_id = ${tenantId}::uuid`);
      await tx.execute(sql`DELETE FROM orders WHERE tenant_id = ${tenantId}::uuid`);
      await tx.delete(outbox).where(eq(outbox.tenantId, tenantId));
      await tx.delete(customerProfiles).where(eq(customerProfiles.tenantId, tenantId));
      await tx.delete(loyaltyAccounts).where(eq(loyaltyAccounts.tenantId, tenantId));
      await tx.delete(users).where(eq(users.tenantId, tenantId));
    });
    await app.db.delete(tenants).where(eq(tenants.id, tenantId));
    await app.close();
  });

  const catA = "00000000-0000-4000-8000-0000000000a1";
  const catB = "00000000-0000-4000-8000-0000000000b2";

  it("زبون بطلبات حديثة: profile محسوب، loyalty tier، ومفضّلات بالمعرّف", async () => {
    // 6 طلبات، إجمالي بضاعة+توصيل عالٍ، آخرها اليوم → loyal + rfm عالٍ
    for (let i = 0; i < 6; i += 1) {
      await seedDeliveredOrder(20_000n, 4_000n, i, [
        { catId: catA, qty: 2 },
        { catId: catB, qty: 1 },
      ]);
    }
    const result = await withTenant(app.db, tenantId, (tx) => recomputeCustomerBrain(tx, tenantId, userId));

    expect(result.orderCount).toBe(6);
    expect(result.totalSpent).toBe(6n * 24_000n); // (بضاعة 20000 + توصيل 4000) × 6
    expect(result.stage).toBe("loyal"); // ≥5 طلبات حديثة
    expect(result.stageChanged).toBe(true); // من new → loyal
    expect(result.tier).toBe("gold"); // إنفاق 144000 ≥ عتبة الذهب 100000

    const profile = await withTenant(app.db, tenantId, async (tx) => {
      const rows = await tx.select().from(customerProfiles).where(and(eq(customerProfiles.tenantId, tenantId), eq(customerProfiles.userId, userId)));
      return rows[0]!;
    });
    expect(profile.orderCount).toBe(6);
    expect(profile.totalSpent).toBe(144_000n);
    expect(profile.avgOrderAmount).toBe(24_000n); // 144000 / 6
    expect(profile.lifecycleStage).toBe("loyal");
    // المفضّلات بالمعرّف: catA أكثر (2×6=12) من catB (1×6=6)
    const favs = profile.favoriteItems as { catalogItemId: string; count: number }[];
    expect(favs[0]).toEqual({ catalogItemId: catA, count: 12 });
    expect(favs[1]).toEqual({ catalogItemId: catB, count: 6 });

    // المستوى كُتب على loyalty_accounts (الدماغ المالك الوحيد)
    const acct = await withTenant(app.db, tenantId, async (tx) => {
      const rows = await tx.select().from(loyaltyAccounts).where(and(eq(loyaltyAccounts.tenantId, tenantId), eq(loyaltyAccounts.userId, userId)));
      return rows[0]!;
    });
    expect(acct.tier).toBe("gold");

    // حدث الـ spine على المرحلة
    const events = await withTenant(app.db, tenantId, async (tx) => {
      const rows = await tx.select({ topic: outbox.topic, payload: outbox.payload }).from(outbox).where(eq(outbox.tenantId, tenantId));
      return rows;
    });
    const lifecycle = events.find((e) => e.topic === "crm.lifecycle_changed");
    expect(lifecycle).toBeDefined();
    expect((lifecycle!.payload as { to: string }).to).toBe("loyal");
  });

  it("إعادة الحساب بلا تغيّر مرحلة → لا حدث spine جديد (idempotent على الحدث)", async () => {
    const before = await withTenant(app.db, tenantId, async (tx) => {
      const rows = await tx.select({ n: sql<number>`count(*)::int` }).from(outbox).where(and(eq(outbox.tenantId, tenantId), eq(outbox.topic, "crm.lifecycle_changed")));
      return rows[0]!.n;
    });
    const result = await withTenant(app.db, tenantId, (tx) => recomputeCustomerBrain(tx, tenantId, userId));
    expect(result.stageChanged).toBe(false); // loyal → loyal
    const after = await withTenant(app.db, tenantId, async (tx) => {
      const rows = await tx.select({ n: sql<number>`count(*)::int` }).from(outbox).where(and(eq(outbox.tenantId, tenantId), eq(outbox.topic, "crm.lifecycle_changed")));
      return rows[0]!.n;
    });
    expect(after).toBe(before); // لا حدث مكرر
  });
});
