import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client.js";
import { tenants, webhookUpdates } from "./schema/index.js";
import { pgError } from "./test-helpers.js";
import { withTenant } from "./with-tenant.js";

// §15 — أهم اختبار بالمشروع: عزل المستأجرين. يعمل بكل CI.
// يتطلب قاعدة حية بعد الترحيلات: DATABASE_URL (app_user)،
// DATABASE_URL_MIGRATOR (تهيئة/تنظيف)، DATABASE_URL_WORKER (فحص مسح الـ worker).

const APP_URL = process.env["DATABASE_URL"];
const MIGRATOR_URL = process.env["DATABASE_URL_MIGRATOR"];
const WORKER_URL = process.env["DATABASE_URL_WORKER"];
const hasDb = Boolean(APP_URL && MIGRATOR_URL);

describe.skipIf(!hasDb)("tenant isolation (RLS)", () => {
  let app: DbHandle;
  let migrator: DbHandle;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    app = createDb(APP_URL!);
    migrator = createDb(MIGRATOR_URL!);
    await migrator.db.execute(sql`TRUNCATE webhook_updates, tenants CASCADE`);

    const inserted = await app.db
      .insert(tenants)
      .values([
        { slug: "office-a", name: "Office A", nameAr: "مكتب أ" },
        { slug: "office-b", name: "Office B", nameAr: "مكتب ب" },
      ])
      .returning({ id: tenants.id, slug: tenants.slug });
    tenantA = inserted.find((t) => t.slug === "office-a")!.id;
    tenantB = inserted.find((t) => t.slug === "office-b")!.id;

    await withTenant(app.db, tenantA, async (tx) => {
      await tx.insert(webhookUpdates).values({ tenantId: tenantA, updateId: 1, payload: { from: "a" } });
    });
    await withTenant(app.db, tenantB, async (tx) => {
      await tx.insert(webhookUpdates).values({ tenantId: tenantB, updateId: 1, payload: { from: "b" } });
    });
  });

  afterAll(async () => {
    await migrator.db.execute(sql`TRUNCATE webhook_updates, tenants CASCADE`);
    await app.close();
    await migrator.close();
  });

  it("a tenant context sees only its own rows", async () => {
    const rows = await withTenant(app.db, tenantA, (tx) => tx.select().from(webhookUpdates));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(tenantA);
  });

  it("a query without tenant context fails loudly — not zero rows silently", async () => {
    await expect(app.db.select().from(webhookUpdates)).rejects.toThrow();
  });

  it("inserting a row for another tenant is rejected by WITH CHECK", async () => {
    // drizzle 0.45 يلفّ خطأ pg بـ DrizzleQueryError — نفحص عبر pgError (سلسلة cause) لا نص الغلاف
    const info = await withTenant(app.db, tenantA, (tx) =>
      tx.insert(webhookUpdates).values({ tenantId: tenantB, updateId: 99, payload: {} }),
    ).then(
      () => null,
      (e: unknown) => pgError(e),
    );
    expect(info).not.toBeNull();
    expect(info!.code).toBe("42501"); // new row violates row-level security policy
    expect(info!.message).toMatch(/row-level security/);
  });

  it("updates scoped to tenant A cannot touch tenant B rows", async () => {
    await withTenant(app.db, tenantA, async (tx) => {
      await tx.update(webhookUpdates).set({ status: "processed" });
    });
    const bRows = await withTenant(app.db, tenantB, (tx) => tx.select().from(webhookUpdates));
    expect(bRows[0]!.status).toBe("received");
  });

  it("duplicate update_id for the same tenant conflicts (inbox key)", async () => {
    const info = await withTenant(app.db, tenantA, (tx) =>
      tx.insert(webhookUpdates).values({ tenantId: tenantA, updateId: 1, payload: {} }),
    ).then(
      () => null,
      (e: unknown) => pgError(e),
    );
    expect(info).not.toBeNull();
    expect(info!.code).toBe("23505"); // unique_violation — مفتاح الـ inbox (tenant_id, update_id)
  });

  it.skipIf(!WORKER_URL)("app_worker can scan across tenants (pickup policy, read-only)", async () => {
    const worker = createDb(WORKER_URL!);
    try {
      const rows = await worker.db.select().from(webhookUpdates);
      const tenantIds = new Set(rows.map((r) => r.tenantId));
      expect(tenantIds.has(tenantA)).toBe(true);
      expect(tenantIds.has(tenantB)).toBe(true);
      // الكتابة خارج withTenant ممنوعة حتى للـ worker
      await expect(
        worker.db.update(webhookUpdates).set({ status: "processed" }),
      ).rejects.toThrow();
    } finally {
      await worker.close();
    }
  });
});
