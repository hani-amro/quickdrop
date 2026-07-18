import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client.js";
import { tenants } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";
import { APP_URL, hasDb } from "./test-helpers.js";

// MERGE_PLAN R-01 — المجس المولَّد: يقرأ كل جداول tenant_id من information_schema
// (لا قائمة يدوية) ويثبت لكل جدول: (1) استعلام بلا سياق مستأجر يفشل بصوت عالٍ،
// (2) داخل سياق المستأجر A لا يظهر أي صف لغيره (USING). جدول جديد بلا RLS أو بسياسة
// ناقصة يفشل هنا تلقائياً — لا يعتمد على تذكّر المطوّر إضافة اختبار يدوي.
// (فحص ENABLE+FORCE نفسه عند scripts/check-rls.ts؛ هذا يثبت الأثر السلوكي.)

const RLS_EXCEPTIONS = new Set(["tenants", "admin_users", "tracking_tokens", "spatial_ref_sys"]);

describe.skipIf(!hasDb)("R-01 — مجس عزل مولَّد لكل جداول tenant_id", () => {
  let app: DbHandle;
  let tenantA: string;
  let tenantTables: string[] = [];

  beforeAll(async () => {
    app = createDb(APP_URL!);
    const inserted = await app.db
      .insert(tenants)
      .values({ slug: `rls-probe-${Date.now().toString(36)}`, name: "RLS Probe", nameAr: "مجس" })
      .returning({ id: tenants.id });
    tenantA = inserted[0]!.id;

    const rows = await app.db.execute(sql`
      SELECT c.table_name
        FROM information_schema.columns c
        JOIN pg_class pc ON pc.relname = c.table_name
        JOIN pg_namespace n ON n.oid = pc.relnamespace AND n.nspname = 'public'
       WHERE c.table_schema = 'public' AND pc.relkind = 'r' AND c.column_name = 'tenant_id'
       ORDER BY c.table_name`);
    tenantTables = (rows.rows as { table_name: string }[])
      .map((r) => r.table_name)
      .filter((t) => !RLS_EXCEPTIONS.has(t));
  });

  afterAll(async () => {
    await app.db.execute(sql`DELETE FROM tenants WHERE id = ${tenantA}::uuid`);
    await app.close();
  });

  it("توجد جداول أعمال للفحص (سلامة المجس نفسه)", () => {
    expect(tenantTables.length).toBeGreaterThanOrEqual(25);
  });

  it("كل جدول: استعلام بلا سياق = فشل صاخب (strict current_setting)، لا صفر صفوف صامت", async () => {
    const leaked: string[] = [];
    for (const table of tenantTables) {
      try {
        await app.db.execute(sql.raw(`SELECT count(*) FROM "${table}"`));
        leaked.push(table); // نجح بلا سياق — سياسة مفقودة أو غير صارمة
      } catch {
        // المتوقع
      }
    }
    expect(leaked, `tables readable WITHOUT tenant context: ${leaked.join(", ")}`).toEqual([]);
  });

  it("كل جدول: داخل سياق A لا يظهر صف لمستأجر آخر (USING يفلتر فعلاً)", async () => {
    const leaked: string[] = [];
    for (const table of tenantTables) {
      const rows = await withTenant(app.db, tenantA, (tx) =>
        tx.execute(sql.raw(`SELECT count(*)::int AS n FROM "${table}" WHERE tenant_id <> '${tenantA}'`)),
      );
      const n = (rows.rows[0] as { n: number }).n;
      if (n > 0) leaked.push(`${table}(${n})`);
    }
    expect(leaked, `cross-tenant rows visible from tenant A: ${leaked.join(", ")}`).toEqual([]);
  });
});
