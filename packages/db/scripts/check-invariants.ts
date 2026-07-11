import pg from "pg";

// 8.3-2 — فاتورة المراقبة: كل طلب delivered له قيود دفتره (D13). يفحص آخر 7 أيام:
//   - cod_received > 0 بلا قيد cod_collected (الفخ 18: التحصيل يُسجَّل بالمستلَم الفعلي)
//   - price_total > 0 بلا قيد delivery_fee_earned (قيد الأجرة يُحذف فقط عندما تكون
//     حصة السائق صفراً — CHECK الإشارة يطلب سالباً؛ طلب مجاني بالكامل لا يُعلَّم خرقاً)
//   - goods_amount > 0 بلا قيد goods_paid_by_driver (D13: السائق دفع البضاعة من جيبته)
// أي خرق = exit 1 — نفس نمط check-rls: حارس CI، لا مراجعة بشرية.
// soft delete (D10) لا يُستثنى عمداً: المال حدث فعلاً وقيوده لا تُمحى بالإخفاء.

// migrator بلا BYPASSRLS (§2.3) والجداول FORCE RLS — الفحص يمر داخل سياق كل مستأجر
// عبر set_config('app.tenant_id')؛ جدول tenants استثناء RLS مسمّى فيُقرأ مباشرة.
const VIOLATIONS_SQL = `
  SELECT v.id, v.public_code, v.delivered_at, v.missing_cod, v.missing_fee, v.missing_goods
    FROM (
      SELECT o.id,
             o.public_code,
             o.delivered_at,
             (o.cod_received > 0 AND NOT EXISTS (
                SELECT 1 FROM ledger_entries le
                 WHERE le.tenant_id = o.tenant_id AND le.order_id = o.id
                   AND le.entry_type = 'cod_collected')) AS missing_cod,
             (o.price_total > 0 AND NOT EXISTS (
                SELECT 1 FROM ledger_entries le
                 WHERE le.tenant_id = o.tenant_id AND le.order_id = o.id
                   AND le.entry_type = 'delivery_fee_earned')) AS missing_fee,
             (o.goods_amount > 0 AND NOT EXISTS (
                SELECT 1 FROM ledger_entries le
                 WHERE le.tenant_id = o.tenant_id AND le.order_id = o.id
                   AND le.entry_type = 'goods_paid_by_driver')) AS missing_goods
        FROM orders o
       WHERE o.status = 'delivered'
         AND o.delivered_at >= now() - interval '7 days'
    ) v
   WHERE v.missing_cod OR v.missing_fee OR v.missing_goods
   ORDER BY v.delivered_at`;

interface ViolationRow {
  id: string;
  public_code: string;
  delivered_at: Date;
  missing_cod: boolean;
  missing_fee: boolean;
  missing_goods: boolean;
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL_MIGRATOR"];
  if (!url) throw new Error("DATABASE_URL_MIGRATOR is required");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const failures: string[] = [];
  const client = await pool.connect();
  try {
    const tenantRows = await client.query<{ id: string; slug: string }>(
      "SELECT id, slug FROM tenants ORDER BY slug",
    );
    for (const tenant of tenantRows.rows) {
      // set_config على مستوى الجلسة (is_local=false): اتصال واحد مخصص، لا pool مشترك —
      // الفخ 3 لا ينطبق هنا، والقيمة تُستبدل بالكامل لكل مستأجر بالدورة.
      await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenant.id]);
      const violations = await client.query<ViolationRow>(VIOLATIONS_SQL);
      for (const row of violations.rows) {
        const missing: string[] = [];
        if (row.missing_cod) missing.push("cod_collected (cod_received > 0)");
        if (row.missing_fee) missing.push("delivery_fee_earned (price_total > 0)");
        if (row.missing_goods) missing.push("goods_paid_by_driver (goods_amount > 0)");
        failures.push(
          `[${tenant.slug}] order ${row.public_code} (${row.id}) delivered ${row.delivered_at.toISOString()} is missing: ${missing.join(", ")}`,
        );
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  if (failures.length > 0) {
    console.error("Ledger invariants check FAILED (8.3-2):");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("Ledger invariants check passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
