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
import { startBrainSweep } from "./brain-sweep.js";

// دمج WaFlow §3.3 — يثبت أن الكنس الليلي يعالج **باغ WaFlow**: تدهور المرحلة بلا حدث
// جديد للزبون. زبون بطلب قديم (100 يوم) وملف عالق 'active' → الكنس → 'churned' + حدث.

const APP_URL = process.env["DATABASE_URL"];
const WORKER_URL = process.env["DATABASE_URL_WORKER"];
const hasDb = Boolean(APP_URL && WORKER_URL);
const PT = sql`ST_GeogFromText('SRID=4326;POINT(36.2765 33.5138)')`;

describe.skipIf(!hasDb)("startBrainSweep (تكامل، قاعدة حية)", () => {
  let app: DbHandle;
  let scan: DbHandle;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    app = createDb(APP_URL!);
    scan = createDb(WORKER_URL!);
    const t = await app.db.insert(tenants).values({ slug: `sweep-${Date.now().toString(36)}`, name: "Sweep QA", nameAr: "كنس" }).returning({ id: tenants.id });
    tenantId = t[0]!.id;
    userId = await withTenant(app.db, tenantId, async (tx) => {
      const u = await tx.insert(users).values({ tenantId, role: "customer", phoneE164: "+60122223333" }).returning({ id: users.id });
      const uid = u[0]!.id;
      // طلب مُسلَّم قبل 100 يوم
      await tx.execute(sql`
        INSERT INTO orders (id, tenant_id, public_code, service, status, customer_id, pickup_point, dropoff_point, price_base, price_total, goods_amount, delivered_at, created_at, updated_at)
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${"S" + Date.now().toString(36)}, 'food', 'delivered', ${uid}::uuid, ${PT}, ${PT}, 4000, 4000, 20000, now() - interval '100 days', now(), now())`);
      // ملف عالق على 'active' (نمط باغ WaFlow — لم يُعَد حسابه منذ نشاط الزبون)
      await tx.insert(customerProfiles).values({ tenantId, userId: uid, lifecycleStage: "active", orderCount: 1, totalSpent: 24000n });
      return uid;
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
    await scan.close();
  });

  it("الكنس يعيد حساب الملف العالق → المرحلة تتدهور إلى churned + حدث spine (باغ WaFlow محلول)", async () => {
    const sweep = startBrainSweep({ scanDb: scan.db, appDb: app.db, intervalMs: 60_000 });
    const count = await sweep.runOnce(); // جولة يدوية
    await sweep.stop();
    expect(count).toBeGreaterThanOrEqual(1);

    const profile = await withTenant(app.db, tenantId, async (tx) => {
      const rows = await tx.select({ stage: customerProfiles.lifecycleStage, brainAt: customerProfiles.brainComputedAt }).from(customerProfiles).where(and(eq(customerProfiles.tenantId, tenantId), eq(customerProfiles.userId, userId)));
      return rows[0]!;
    });
    expect(profile.stage).toBe("churned"); // آخر طلب 100 يوم > 90 → churned
    expect(profile.brainAt).not.toBeNull();

    const event = await withTenant(app.db, tenantId, async (tx) => {
      const rows = await tx.select({ payload: outbox.payload }).from(outbox).where(and(eq(outbox.tenantId, tenantId), eq(outbox.topic, "crm.lifecycle_changed")));
      return rows;
    });
    expect(event.length).toBe(1);
    expect((event[0]!.payload as { from: string; to: string })).toMatchObject({ from: "active", to: "churned" });
  });
});
