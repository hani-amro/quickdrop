import pg from "pg";

// §2.3 — حارس الـ CI: يفشل إذا وُجد جدول أعمال بلا RLS مفعّل ومُجبَر،
// أو مفتاح أجنبي بين جداول أعمال غير مركّب بـ tenant_id.

// الاستثناءات المسمّاة فقط — أي إضافة هنا قرار معماري يُكتب بالوثيقة أولاً.
// spatial_ref_sys جدول تُنشئه إضافة PostGIS في public (بيانات مرجعية للأنظمة
// الإحداثية، مشتركة للقراءة) — ليس جدول أعمال، فيُستثنى من فرض RLS (§2.3).
// tenant_payments خرج من الاستثناءات بترحيل 0012 — تحت FORCE RLS كغيره (MERGE_PLAN R-02).
const RLS_EXCEPTIONS = ["tenants", "admin_users", "tracking_tokens", "spatial_ref_sys"];

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL_MIGRATOR"];
  if (!url) throw new Error("DATABASE_URL_MIGRATOR is required");
  const pool = new pg.Pool({ connectionString: url });
  const failures: string[] = [];
  try {
    const missingRls = await pool.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname <> ALL($1::text[])
          AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
        ORDER BY c.relname`,
      [RLS_EXCEPTIONS],
    );
    for (const row of missingRls.rows) {
      failures.push(`table "${row.relname}" is missing ENABLE+FORCE ROW LEVEL SECURITY`);
    }

    const missingPolicy = await pool.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname <> ALL($1::text[])
          AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
        ORDER BY c.relname`,
      [RLS_EXCEPTIONS],
    );
    for (const row of missingPolicy.rows) {
      failures.push(`table "${row.relname}" has RLS enabled but no policy`);
    }

    // §2.3: FK بين جدولي أعمال لازم يتضمن tenant_id (فحص الـ FK يتجاوز RLS)
    const nonCompositeFks = await pool.query<{ conname: string; src: string; dst: string }>(
      `SELECT con.conname, src.relname AS src, dst.relname AS dst
         FROM pg_constraint con
         JOIN pg_class src ON src.oid = con.conrelid
         JOIN pg_class dst ON dst.oid = con.confrelid
         JOIN pg_namespace n ON n.oid = src.relnamespace
        WHERE con.contype = 'f'
          AND n.nspname = 'public'
          AND src.relname <> ALL($1::text[])
          AND dst.relname <> ALL($1::text[])
          AND NOT EXISTS (
            SELECT 1
              FROM unnest(con.conkey) AS colnum
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = colnum
             WHERE a.attname = 'tenant_id'
          )
        ORDER BY con.conname`,
      [RLS_EXCEPTIONS],
    );
    for (const row of nonCompositeFks.rows) {
      failures.push(`FK "${row.conname}" (${row.src} → ${row.dst}) does not include tenant_id`);
    }
  } finally {
    await pool.end();
  }

  if (failures.length > 0) {
    console.error("RLS check FAILED:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("RLS check passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
