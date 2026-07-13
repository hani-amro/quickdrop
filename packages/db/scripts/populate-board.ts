import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDb, createOrder, transition, users, withTenant } from "../src/index.js";

// يعبّي لوحة الإرسال بطلبات حيّة بحالات مختلفة للمعاينة: بعضها pending (بانتظار
// التأكيد)، وواحد confirmed (بحاجة سائق — يظهر بعمود "بحاجة سائق").

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const envFile = join(repoRoot, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const url = process.env["DATABASE_URL"];
if (!url) throw new Error("DATABASE_URL required");

const SPOTS: Array<{ lat: number; lng: number; text: string }> = [
  { lat: 33.514, lng: 36.278, text: "شارع الحمرا" },
  { lat: 33.522, lng: 36.305, text: "المزة فيلات" },
  { lat: 33.508, lng: 36.292, text: "باب توما" },
  { lat: 33.53, lng: 36.29, text: "المالكي" },
];

async function main(): Promise<void> {
  const handle = createDb(url!);
  try {
    const tRows = await handle.db.execute<{ id: string }>(
      "SELECT id FROM tenants WHERE slug='demo' LIMIT 1" as unknown as never,
    );
    const tenantId = (tRows.rows[0] as { id: string } | undefined)?.id;
    if (!tenantId) throw new Error("شغّل db:seed-dev أولاً");
    const customerId = await withTenant(handle.db, tenantId, async (tx) => {
      const c = await tx.select({ id: users.id }).from(users).where(eq(users.role, "customer")).limit(1);
      return c[0]!.id;
    });

    let confirmed = 0;
    for (let i = 0; i < SPOTS.length; i++) {
      const dropoff = SPOTS[i]!;
      const { order } = await createOrder(handle.db, tenantId, {
        service: i % 2 === 0 ? "p2p" : "parcel",
        customerId,
        pickup: { lat: 33.513, lng: 36.29 },
        dropoff: { lat: dropoff.lat, lng: dropoff.lng },
        dropoffText: dropoff.text,
        ...(i % 2 === 1 ? { goodsAmount: 8000n } : {}),
        createdBy: { type: "staff" },
      });
      // اترك أول اثنين pending؛ أكّد الباقي (يظهرون بعمود "بحاجة سائق")
      if (i >= 2) {
        await withTenant(handle.db, tenantId, (tx) =>
          transition(tx, { orderId: order.id, to: "confirmed", actor: { type: "staff" } }),
        );
        confirmed++;
      }
      console.log(`  #${order.publicCode} → ${i >= 2 ? "confirmed (بحاجة سائق)" : "pending"} — ${dropoff.text}`);
    }
    console.log(`\n✅ ${SPOTS.length} طلبات على اللوحة (${confirmed} بحاجة سائق، ${SPOTS.length - confirmed} بانتظار التأكيد).`);
  } finally {
    await handle.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
