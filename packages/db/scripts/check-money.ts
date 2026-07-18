import pg from "pg";

// D5/D11 — حارس المال على مستوى القاعدة (حاجب بالـ CI، يعمل بعد الترحيل):
// (1) لا عمود float/NUMERIC/real/money-type في public إلا الاستثناءين المسمّيين
//     (rating_avg, speed_kmh — قياسات لا مال).
// (2) أي عمود اسمه مالي (price/amount/total/…) لازم يكون BIGINT — إلا معدلات
//     الـ basis points (لاحقة _bp) فهي integer قصداً.
// أي إضافة للاستثناءات قرار معماري يُكتب بالوثيقة أولاً.

const FLOAT_ALLOWLIST = new Set(["drivers.rating_avg", "driver_locations.speed_kmh"]);
const SYSTEM_TABLES = ["spatial_ref_sys"]; // PostGIS — ليس جدول أعمال

// مطابقة على حدود مقاطع snake_case — "cod" مقطعاً كاملاً لا جزءاً من public_code
const MONEY_NAME_RE = "(^|_)(price|amount|total|fee|cost|balance|wallet|spent|revenue|cod|goods|subtotal|tax)(_|$)";

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL_MIGRATOR"];
  if (!url) throw new Error("DATABASE_URL_MIGRATOR is required");
  const pool = new pg.Pool({ connectionString: url });
  const failures: string[] = [];
  try {
    const floatCols = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT c.table_name, c.column_name, c.data_type
         FROM information_schema.columns c
         JOIN pg_class pc ON pc.relname = c.table_name
         JOIN pg_namespace n ON n.oid = pc.relnamespace AND n.nspname = 'public'
        WHERE c.table_schema = 'public'
          AND pc.relkind = 'r'
          AND c.table_name <> ALL($1::text[])
          AND c.data_type IN ('numeric', 'real', 'double precision', 'money')
        ORDER BY c.table_name, c.column_name`,
      [SYSTEM_TABLES],
    );
    for (const row of floatCols.rows) {
      const key = `${row.table_name}.${row.column_name}`;
      if (!FLOAT_ALLOWLIST.has(key)) {
        failures.push(`column ${key} is ${row.data_type} — floats/NUMERIC are banned (D5); money = BIGINT`);
      }
    }

    const moneyNamedNonBigint = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT c.table_name, c.column_name, c.data_type
         FROM information_schema.columns c
         JOIN pg_class pc ON pc.relname = c.table_name
         JOIN pg_namespace n ON n.oid = pc.relnamespace AND n.nspname = 'public'
        WHERE c.table_schema = 'public'
          AND pc.relkind = 'r'
          AND c.table_name <> ALL($1::text[])
          AND c.column_name ~ $2
          AND c.column_name !~ '_bp$'
          AND c.data_type <> 'bigint'
        ORDER BY c.table_name, c.column_name`,
      [SYSTEM_TABLES, MONEY_NAME_RE],
    );
    for (const row of moneyNamedNonBigint.rows) {
      failures.push(
        `money-named column ${row.table_name}.${row.column_name} is ${row.data_type}, not bigint (D5; bp rates must end in _bp)`,
      );
    }
  } finally {
    await pool.end();
  }

  if (failures.length > 0) {
    console.error("Money guard (schema) FAILED:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("Money guard (schema) passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
