import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client.js";
import { tenants } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";
import { APP_URL, hasDb } from "./test-helpers.js";

// MERGE_PLAN R-01 — المجس المولَّد: يقرأ كل جداول tenant_id من information_schema
// (لا قائمة يدوية) ويثبت لكل جدول: (1) استعلام بلا سياق مستأجر يفشل بصوت عالٍ،
// (2) تعبير سياسة tenant_isolation هو مساواة tenant_id الحرفية على USING وWITH CHECK.
// مراجعة Phase 1 (isolation): الفحص السلوكي القديم (عدّ صفوف مستأجر آخر) كان **فارغاً**
// على جدول فارغ — سياسة USING معطوبة تشير إلى current_setting بلا مساواة tenant_id
// (ترمي بلا سياق، فتجتاز الفحص 1) كانت تُرجع كل الصفوف بأي سياق وتفلت. الفحص البنيوي
// (2) يمسكها على جدول فارغ لكل الجداول. (ENABLE+FORCE + نفس البنية مفروضان أيضاً بـ
// scripts/check-rls.ts كحارس CI.)

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

  it("كل جدول: تعبير tenant_isolation هو مساواة tenant_id الحرفية (USING + WITH CHECK) — يمسك سياسة معطوبة على جدول فارغ", async () => {
    const CANONICAL = "(tenant_id = (current_setting('app.tenant_id'::text))::uuid)";
    const rows = await app.db.execute(sql`
      SELECT c.relname AS table_name,
             pg_get_expr(p.polqual, p.polrelid) AS using_expr,
             pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE p.polname = 'tenant_isolation'`);
    const policies = new Map<string, { u: string | null; c: string | null }>();
    for (const r of rows.rows as { table_name: string; using_expr: string | null; check_expr: string | null }[]) {
      policies.set(r.table_name, { u: r.using_expr, c: r.check_expr });
    }
    const bad: string[] = [];
    for (const table of tenantTables) {
      const pol = policies.get(table);
      if (!pol) {
        bad.push(`${table}(no tenant_isolation policy)`);
        continue;
      }
      if (pol.u !== CANONICAL) bad.push(`${table}(USING=${pol.u ?? "NULL"})`);
      if (pol.c !== CANONICAL) bad.push(`${table}(WITH CHECK=${pol.c ?? "NULL"})`);
    }
    expect(bad, `tables with a non-canonical tenant_isolation policy: ${bad.join(", ")}`).toEqual([]);
  });
});
