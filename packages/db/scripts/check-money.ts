import pg from "pg";

// D5/D11 — حارس المال على مستوى القاعدة (حاجب بالـ CI، يعمل بعد الترحيل) — هذا هو
// الحارس الدائم لـ D5: عمود المال لا يمكن أن يكون float في القاعدة مهما فعل الكود.
// يفحص عبر pg_attribute (لا information_schema) كي يشمل الجداول العادية والمقسّمة
// **والمُجسَّدة (matviews)** — مراجعة Phase 1: matview بعمود float كان يتهرّب لأن
// information_schema.columns لا يُدرج المُجسَّدة أصلاً.
// (1) لا عمود float/NUMERIC/real/money-type إلا الاستثناءين المسمّيين (rating_avg،
//     speed_kmh — قياسات لا مال).
// (2) أي عمود اسمه مالي (price/amount/total/…) لازم يكون BIGINT، إلا معدلات الـ
//     basis points (لاحقة _bp) فهي **integer حصراً** (رقم أساس نقطة لا مبلغ مطلق —
//     منع خدعة عمود _bp من نوع bigint يحمل وحدات صغرى).
// أي إضافة للاستثناءات = قرار معماري يُكتب بالوثيقة أولاً.

const FLOAT_ALLOWLIST = new Set(["drivers.rating_avg", "driver_locations.speed_kmh"]);
const SYSTEM_TABLES = ["spatial_ref_sys"]; // PostGIS — ليس جدول أعمال
const BUSINESS_RELKINDS = ["r", "p", "m"]; // عادي، مقسّم، مُجسَّد

// أنواع pg الداخلية: numeric، float4(real)، float8(double precision)، money
const FLOAT_TYPES = ["numeric", "float4", "float8", "money"];
// مطابقة على حدود مقاطع snake_case — "cod" مقطعاً كاملاً لا جزءاً من public_code
const MONEY_NAME_RE = "(^|_)(price|amount|total|fee|cost|balance|wallet|spent|revenue|cod|goods|subtotal|tax)(_|$)";

interface Col {
  rel: string;
  col: string;
  typ: string;
}

// كل أعمدة جداول الأعمال (r/p/m) بأنواعها الداخلية — مصدر واحد للفحوص الثلاثة.
const COLS_SQL = `
  SELECT c.relname AS rel, a.attname AS col, t.typname AS typ
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN pg_type t ON t.oid = a.atttypid
   WHERE c.relkind = ANY($1::"char"[])
     AND a.attnum > 0 AND NOT a.attisdropped
     AND c.relname <> ALL($2::text[])
   ORDER BY c.relname, a.attname`;

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL_MIGRATOR"];
  if (!url) throw new Error("DATABASE_URL_MIGRATOR is required");
  const pool = new pg.Pool({ connectionString: url });
  const failures: string[] = [];
  const moneyNameRe = new RegExp(MONEY_NAME_RE);
  try {
    const { rows } = await pool.query<Col>(COLS_SQL, [BUSINESS_RELKINDS, SYSTEM_TABLES]);
    for (const { rel, col, typ } of rows) {
      const key = `${rel}.${col}`;
      // (1) نوع عائم ممنوع أينما وُجد
      if (FLOAT_TYPES.includes(typ) && !FLOAT_ALLOWLIST.has(key)) {
        failures.push(`column ${key} is ${typ} — floats/NUMERIC/money are banned (D5); money = BIGINT (int8)`);
      }
      // (2) اسم مالي يجب أن يكون bigint (int8)، إلا لاحقة _bp
      if (moneyNameRe.test(col) && !/_bp$/.test(col) && typ !== "int8") {
        failures.push(`money-named column ${key} is ${typ}, not bigint (D5; bp rates must end in _bp)`);
      }
      // (2b) عمود _bp يجب أن يكون integer (int4) — bigint متنكّر كمعدّل = تجاوز محتمل
      if (/_bp$/.test(col) && typ !== "int4") {
        failures.push(`*_bp column ${key} is ${typ}, not integer — a non-integer _bp may be an absolute-amount bypass (D5)`);
      }
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
