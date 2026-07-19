import { expect, test, type APIRequestContext } from "@playwright/test";
import { API_URL } from "../playwright.config";

// MERGE_PLAN §7 / قائمة §4.2 الحاجبة — عقد المفصل بين الدماغين على المكدّس الحي، عبر
// HTTP حصراً. الـ fixme أُزيل بعد تغطية المواقع الستة اختبارياً (Phase 3):
//   seam.integration (7) + seam-consumer (3) + payments-consumer (3) + Tier-1 DoD (6).
// هنا الطبقة الأخيرة: نفس العقد من فوق الـ API — إنشاء food عبر مسار الكتالوج، مطبخ
// الداشبورد (merchant-confirm→preparing، ready→ready)، ختم المفصل يظهر بالتفاصيل
// (write-once)، وpickup لا يُختم ولا يُسند أبداً.
//
// مصادقة: Bearer STAFF_API_TOKEN عبر E2E_STAFF_TOKEN. غيابه = تخطٍّ معلَن (نفس نمط
// بوابة hasDb بحزم vitest) — العقد يبقى مُثبتاً بسويتات vitest أعلاه (بوابة CI).

const STAFF_TOKEN = process.env.E2E_STAFF_TOKEN;
const TENANT = process.env.E2E_TENANT_SLUG ?? "demo";

const AUTH = { Authorization: `Bearer ${STAFF_TOKEN}` };
const PICKUP_POINT = { lat: 33.5138, lng: 36.2765 };
const DROPOFF_POINT = { lat: 33.5588, lng: 36.2765 };

interface MenuWorld {
  merchantId: string;
  itemId: string;
}

/** أول مطعم نشط وأول صنف متاح من كتالوج المستأجر الحي (بذرة seed-dev). */
async function findMenu(request: APIRequestContext): Promise<MenuWorld | null> {
  const mRes = await request.get(`${API_URL}/api/merchants?tenantSlug=${TENANT}`, { headers: AUTH });
  if (mRes.status() !== 200) return null;
  const merchants = (await mRes.json()).merchants as { id: string; isActive: boolean }[];
  const merchant = merchants.find((m) => m.isActive);
  if (!merchant) return null;
  const cRes = await request.get(`${API_URL}/api/merchants/${merchant.id}/catalog?tenantSlug=${TENANT}`, { headers: AUTH });
  if (cRes.status() !== 200) return null;
  const items = (await cRes.json()).items as { id: string; isAvailable: boolean }[];
  const item = items.find((i) => i.isAvailable);
  if (!item) return null;
  return { merchantId: merchant.id, itemId: item.id };
}

async function createFoodOrder(
  request: APIRequestContext,
  world: MenuWorld,
  fulfillment: "delivery" | "pickup",
): Promise<{ id: string }> {
  const res = await request.post(`${API_URL}/api/orders`, {
    headers: AUTH,
    data: {
      tenantSlug: TENANT,
      service: "food",
      customerPhone: "+601712345670",
      customerName: "E2E Seam",
      pickup: PICKUP_POINT,
      ...(fulfillment === "delivery" ? { dropoff: DROPOFF_POINT } : {}),
      merchantId: world.merchantId,
      items: [{ catalogItemId: world.itemId, qty: 1 }],
      fulfillment,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).order as { id: string };
}

async function orderDetail(request: APIRequestContext, id: string): Promise<Record<string, unknown>> {
  const res = await request.get(`${API_URL}/api/orders/${id}?tenantSlug=${TENANT}`, { headers: AUTH });
  expect(res.status()).toBe(200);
  return (await res.json()).order as Record<string, unknown>;
}

async function post(request: APIRequestContext, path: string): Promise<number> {
  const res = await request.post(`${API_URL}${path}`, { headers: AUTH, data: { tenantSlug: TENANT } });
  return res.status();
}

test.describe("العمود الفقري — order.ready_for_dispatch (§4.2، مكدّس حي)", () => {
  test.skip(!STAFF_TOKEN, "E2E_STAFF_TOKEN غير مضبوط — عقد المفصل مُثبت بسويتات vitest (بوابة CI)");

  test("food توصيل: مطبخ الداشبورد كاملاً → ختم المفصل يظهر مرة واحدة (write-once)", async ({ request }) => {
    const world = await findMenu(request);
    test.skip(!world, "لا مطعم/صنف مبذوراً بالمستأجر الحي");

    const order = await createFoodOrder(request, world!, "delivery");
    let d = await orderDetail(request, order.id);
    expect(d.status).toBe("pending");
    expect(d.dispatchRequestedAt).toBeNull(); // لا ختم قبل الجهوز (المُطلِق الافتراضي ready)

    expect(await post(request, `/api/orders/${order.id}/confirm`)).toBe(200);
    d = await orderDetail(request, order.id);
    expect(d.status).toBe("confirmed");
    expect(d.dispatchRequestedAt).toBeNull(); // food لا يُختم عند التأكيد (ready هو المُطلِق)

    // D-M6: زر «المطعم أكّد» = transition(confirmed→preparing) — نفس ترميز بوت التاجر
    expect(await post(request, `/api/orders/${order.id}/merchant-confirm`)).toBe(200);
    d = await orderDetail(request, order.id);
    expect(d.status).toBe("preparing");
    expect(d.merchantConfirmedAt).not.toBeNull();

    // «الطلب جاهز» → ready: يملأ ready_at ويختم المفصل (الحدث بنفس الترانزاكشن — D6)
    expect(await post(request, `/api/orders/${order.id}/ready`)).toBe(200);
    d = await orderDetail(request, order.id);
    expect(["ready", "assigned"]).toContain(d.status); // worker حي قد يُسند فوراً
    expect(d.readyAt).not.toBeNull();
    expect(d.dispatchRequestedAt).not.toBeNull(); // ⚡ الختم — المنتِج الشرعي الوحيد

    // ضغطة «جاهز» ثانية idempotent — والختم لا يتغيّر (write-once)
    const stamp = d.dispatchRequestedAt;
    expect(await post(request, `/api/orders/${order.id}/ready`)).toBe(200);
    d = await orderDetail(request, order.id);
    expect(d.dispatchRequestedAt).toBe(stamp);
  });

  test("F4 (قرار المالك): إنشاء طلب fulfillment=pickup مرفوض من الواجهة (v1 توصيل حصراً)", async ({ request }) => {
    const world = await findMenu(request);
    test.skip(!world, "لا مطعم/صنف مبذوراً بالمستأجر الحي");

    // pickup غير متاح v1 (لا مسار إتمام استلام ذاتي — بلا سائق، ولاء/كوبون) → 4xx لا 201
    const res = await request.post(`${API_URL}/api/orders`, {
      headers: AUTH,
      data: {
        tenantSlug: TENANT,
        service: "food",
        customerPhone: "+601712345671",
        pickup: PICKUP_POINT,
        merchantId: world!.merchantId,
        items: [{ catalogItemId: world!.itemId, qty: 1 }],
        fulfillment: "pickup",
      },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500); // خطأ عميل (مدخل مرفوض) لا خطأ خادم
  });
});
