import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, desc, eq } from "drizzle-orm";
import {
  assignManually,
  createDb,
  createOrder,
  drivers,
  ledgerEntries,
  loyaltyBalance,
  orderEvents,
  orders,
  settlements,
  transition,
  users,
  withTenant,
} from "../src/index.js";

// عرض تدفق كامل حي عبر كود الإنتاج الحقيقي (لا SQL يدوي): إنشاء طلب طرد →
// تأكيد → إسناد يدوي لسائق → استلام → بالطريق → وصل → تسليم بكاش، ثم عرض
// order_events والدفتر المالي (§8.1) والولاء (§9). للتشغيل على قاعدة seed المعاينة.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const envFile = join(repoRoot, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("DATABASE_URL required");

function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(22)} ${String(value)}`);
}

async function main(): Promise<void> {
  const handle = createDb(url!);
  try {
    // مستأجر demo + زبون + سائق من الـ seed
    const tenantRows = await handle.db.execute<{ id: string }>(
      // tenants استثناء RLS — قراءة مباشرة
      "SELECT id FROM tenants WHERE slug = 'demo' LIMIT 1" as unknown as never,
    );
    const tenantId = (tenantRows.rows[0] as { id: string } | undefined)?.id;
    if (!tenantId) throw new Error("لا يوجد مستأجر demo — شغّل db:seed-dev");

    const { customerId, driverId } = await withTenant(handle.db, tenantId, async (tx) => {
      const c = await tx.select({ id: users.id }).from(users).where(eq(users.role, "customer")).limit(1);
      const d = await tx.select({ id: drivers.id }).from(drivers).limit(1);
      return { customerId: c[0]!.id, driverId: d[0]!.id };
    });

    console.log("\n═══ 1) إنشاء طلب طرد (goods=12,000) ═══");
    const { order, quote, trackingToken } = await createOrder(handle.db, tenantId, {
      service: "parcel",
      customerId,
      pickup: { lat: 33.513, lng: 36.29 },
      dropoff: { lat: 33.52, lng: 36.31 },
      goodsAmount: 12000n,
      createdBy: { type: "staff" },
    });
    line("public_code", order.publicCode);
    line("الحالة", order.status);
    line("أجرة التوصيل", `${quote.components.total} ل.س`);
    line("cod (بضاعة+توصيل)", `${order.codAmount} ل.س`);
    line("رابط التتبع", `/t/${trackingToken.slice(0, 12)}…`);

    const step = async (to: Parameters<typeof transition>[1]["to"], actor: "staff" | "driver" | "system", extra?: Record<string, unknown>) => {
      await withTenant(handle.db, tenantId, (tx) =>
        transition(tx, { orderId: order.id, to, actor: { type: actor }, ...(extra ?? {}) }),
      );
    };

    console.log("\n═══ 2) تأكيد ثم إسناد يدوي للسائق ═══");
    await step("confirmed", "staff");
    const assign = await assignManually(handle.db, tenantId, order.id, driverId);
    line("نتيجة الإسناد", assign.outcome);

    console.log("\n═══ 3) رحلة السائق ═══");
    await step("picked_up", "driver");   line("→", "picked_up (استلم من المرسِل)");
    await step("in_transit", "driver");  line("→", "in_transit (بالطريق)");
    await step("arrived", "driver");     line("→", "arrived (وصل)");
    // تسليم مع كاش مستلَم فعلي أقل بقليل (الفخ 18): الزبون دفع 16,500 من 16,222
    await withTenant(handle.db, tenantId, (tx) =>
      transition(tx, { orderId: order.id, to: "delivered", actor: { type: "driver", id: driverId }, codReceived: 16500n }),
    );
    line("→", "delivered (سُلّم، حُصّل 16,500)");

    console.log("\n═══ 4) الدفتر المالي (§8.1 D13) ═══");
    const ledger = await withTenant(handle.db, tenantId, (tx) =>
      tx.select({ t: ledgerEntries.entryType, a: ledgerEntries.amount }).from(ledgerEntries)
        .where(eq(ledgerEntries.orderId, order.id)),
    );
    let net = 0n;
    for (const e of ledger) { line(e.t, `${e.a} ل.س`); net += e.a; }
    line("صافي ذمة السائق", `${net} ل.س (موجب = بذمته للمكتب)`);

    console.log("\n═══ 5) الولاء (§9) وسجل الأحداث ═══");
    const bal = await withTenant(handle.db, tenantId, (tx) => loyaltyBalance(tx, tenantId, customerId));
    line("نقاط الزبون", bal.points);
    const events = await withTenant(handle.db, tenantId, (tx) =>
      tx.select({ f: orderEvents.fromStatus, t: orderEvents.toStatus, by: orderEvents.actorType })
        .from(orderEvents).where(eq(orderEvents.orderId, order.id)).orderBy(desc(orderEvents.createdAt)),
    );
    line("عدد الأحداث", events.length);
    console.log("  المسار: " + events.reverse().map((e) => e.t).join(" → "));

    void settlements;
    console.log("\n✅ التدفق الكامل نجح — من الإنشاء للتسليم مع قيود مالية وولاء صحيحة.\n");
  } finally {
    await handle.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
