import { describe, expect, it } from "vitest";
import {
  buildCallbackData,
  CB_OFFER_ACCEPT_PREFIX,
  CB_OFFER_REJECT_PREFIX,
  CB_ORDER_ARRIVE_PREFIX,
  CB_ORDER_DELIVER_PREFIX,
  CB_ORDER_GO_PREFIX,
  CB_ORDER_PICKUP_PREFIX,
  computeIsSuspect,
  offerAcceptCb,
  offerKeyboard,
  offerRejectCb,
  SUSPECT_JUMP_METERS,
  SUSPECT_SPEED_KMH,
  taskKeyboard,
  UUID_CAPTURE,
  type LocationSample,
} from "./driver-logic.js";
import { offerCard, taskCard } from "./html.js";

// §15 — اختبارات منطق صافٍ بلا أي اتصالات (كنمط flow.test.ts): بطاقات وكيبوردات
// بوت السائق + فحص is_suspect. لا استيراد من driver-flow.ts (يسحب @quickdrop/db).

const OFFER_ID = "0197c5e8-1111-7000-8000-00000000aaaa";
const ORDER_ID = "0197c5e8-2222-7000-8000-00000000bbbb";

/** أول callback_data بالكيبورد — يتحقق النوع لأن أزرار url/web_app بلا callback_data. */
function firstCallbackData(keyboard: { inline_keyboard: { text: string; callback_data?: string }[][] }): string | undefined {
  return keyboard.inline_keyboard[0]?.[0]?.callback_data;
}

describe("callback_data (§4.4: حد 64 بايت)", () => {
  it("builds prefix:uuid and stays within Telegram's 64-byte limit for every prefix", () => {
    const prefixes = [
      CB_OFFER_ACCEPT_PREFIX,
      CB_OFFER_REJECT_PREFIX,
      CB_ORDER_PICKUP_PREFIX,
      CB_ORDER_GO_PREFIX,
      CB_ORDER_ARRIVE_PREFIX,
      CB_ORDER_DELIVER_PREFIX,
    ];
    for (const prefix of prefixes) {
      const data = buildCallbackData(prefix, ORDER_ID);
      expect(data).toBe(`${prefix}:${ORDER_ID}`);
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
    }
  });

  it("throws RangeError instead of letting Telegram truncate silently", () => {
    expect(() => buildCallbackData(CB_OFFER_ACCEPT_PREFIX, "x".repeat(64))).toThrow(RangeError);
  });

  it("round-trips through the UUID_CAPTURE pattern used by the handlers", () => {
    const re = new RegExp(`^${CB_OFFER_ACCEPT_PREFIX}:${UUID_CAPTURE}$`);
    const match = offerAcceptCb(OFFER_ID).match(re);
    expect(match?.[1]).toBe(OFFER_ID);
  });
});

describe("offerKeyboard / taskKeyboard (§6.2/§5)", () => {
  it("offer keyboard carries accept and reject callbacks for the same offer", () => {
    const kb = offerKeyboard(OFFER_ID);
    const row = kb.inline_keyboard[0];
    expect(row).toHaveLength(2);
    expect(row?.[0] && "callback_data" in row[0] ? row[0].callback_data : undefined).toBe(offerAcceptCb(OFFER_ID));
    expect(row?.[1] && "callback_data" in row[1] ? row[1].callback_data : undefined).toBe(offerRejectCb(OFFER_ID));
  });

  it("shows only the next-stage button per status (§5: أزرار متدرجة)", () => {
    expect(firstCallbackData(taskKeyboard("assigned", ORDER_ID)!)).toBe(`${CB_ORDER_PICKUP_PREFIX}:${ORDER_ID}`);
    expect(firstCallbackData(taskKeyboard("picked_up", ORDER_ID)!)).toBe(`${CB_ORDER_GO_PREFIX}:${ORDER_ID}`);
    expect(firstCallbackData(taskKeyboard("in_transit", ORDER_ID)!)).toBe(`${CB_ORDER_ARRIVE_PREFIX}:${ORDER_ID}`);
    expect(firstCallbackData(taskKeyboard("arrived", ORDER_ID)!)).toBe(`${CB_ORDER_DELIVER_PREFIX}:${ORDER_ID}`);
  });

  it("has no driver buttons on terminal or pre-assignment statuses", () => {
    for (const status of ["delivered", "failed", "returned", "pending", "confirmed"] as const) {
      expect(taskKeyboard(status, ORDER_ID)).toBeNull();
    }
  });
});

describe("computeIsSuspect (§3: يُحسَب عند الإدخال)", () => {
  const at = (iso: string): Date => new Date(iso);
  const sample = (lat: number, lng: number, iso: string): LocationSample => ({ lat, lng, recordedAt: at(iso) });

  it("first point has no reference — never suspect, no speed", () => {
    expect(computeIsSuspect(null, sample(33.51, 36.29, "2026-07-10T10:00:00Z"))).toEqual({
      isSuspect: false,
      speedKmh: null,
    });
  });

  it("normal urban movement (~110م بـ 30 ثانية ≈ 13 كم/س) is clean", () => {
    const prev = sample(33.51, 36.29, "2026-07-10T10:00:00Z");
    const next = sample(33.511, 36.29, "2026-07-10T10:00:30Z");
    const result = computeIsSuspect(prev, next);
    expect(result.isSuspect).toBe(false);
    expect(result.speedKmh).toBeGreaterThan(5);
    expect(result.speedKmh).toBeLessThan(30);
  });

  it("speed above 150 km/h is suspect (~1كم بـ 20 ثانية = 180 كم/س)", () => {
    const prev = sample(33.51, 36.29, "2026-07-10T10:00:00Z");
    const next = sample(33.519, 36.29, "2026-07-10T10:00:20Z");
    const result = computeIsSuspect(prev, next);
    expect(result.isSuspect).toBe(true);
    expect(result.speedKmh).toBeGreaterThan(SUSPECT_SPEED_KMH);
  });

  it("fast but legal (~1كم بـ 30 ثانية = 120 كم/س) is not suspect", () => {
    const prev = sample(33.51, 36.29, "2026-07-10T10:00:00Z");
    const next = sample(33.519, 36.29, "2026-07-10T10:00:30Z");
    expect(computeIsSuspect(prev, next).isSuspect).toBe(false);
  });

  it("a >2km jump over minutes (سرعة معقولة) is not suspect — الفخ: قاعدة القفزة مقيدة بـ 10 ثوان", () => {
    const prev = sample(33.51, 36.29, "2026-07-10T10:00:00Z");
    const next = sample(33.537, 36.29, "2026-07-10T10:02:00Z"); // ~3كم بدقيقتين = ~90 كم/س
    expect(computeIsSuspect(prev, next).isSuspect).toBe(false);
  });

  it("out-of-order timestamp with a small move is stored clean with no speed", () => {
    const prev = sample(33.51, 36.29, "2026-07-10T10:00:10Z");
    const next = sample(33.5101, 36.29, "2026-07-10T10:00:10Z"); // نفس اللحظة
    expect(computeIsSuspect(prev, next)).toEqual({ isSuspect: false, speedKmh: null });
  });

  it("a >2km teleport with zero/negative time delta is suspect", () => {
    const prev = sample(33.51, 36.29, "2026-07-10T10:00:10Z");
    const next = sample(33.537, 36.29, "2026-07-10T10:00:05Z"); // ~3كم للوراء زمنياً
    const result = computeIsSuspect(prev, next);
    expect(result.isSuspect).toBe(true);
    expect(result.speedKmh).toBeNull();
    expect(SUSPECT_JUMP_METERS).toBe(2000);
  });
});

describe("offerCard (§6.2: بطاقة العرض من صفوف القاعدة)", () => {
  const base = {
    publicCode: "1042",
    pickupText: "مطعم الشام — باب توما",
    dropoffText: "المزة، خلف البنك",
    distanceM: 4210,
    priceTotal: 15000n,
    goodsAmount: 120000n,
    codAmount: 135000n,
    currency: "SYP",
    expiresAt: new Date("2026-07-10T10:00:45Z"),
    now: new Date("2026-07-10T10:00:00Z"),
  };

  it("renders code, addresses, money lines and the countdown", () => {
    const card = offerCard(base);
    expect(card).toContain("#1042");
    expect(card).toContain("مطعم الشام");
    expect(card).toContain("تدفع للتاجر عند الاستلام"); // D13
    expect(card).toContain("تحصّل من الزبون عند التسليم");
    expect(card).toContain("45");
    expect(card).toContain("4.2 كم");
    expect(card).toMatchSnapshot();
  });

  it("hides goods/cod lines when zero and clamps an expired countdown to 0", () => {
    const card = offerCard({
      ...base,
      goodsAmount: 0n,
      codAmount: 0n,
      distanceM: null,
      pickupText: null,
      dropoffText: null,
      now: new Date("2026-07-10T10:01:00Z"), // بعد expires_at
    });
    expect(card).not.toContain("تدفع للتاجر");
    expect(card).not.toContain("تحصّل من الزبون");
    expect(card).not.toContain("كم\n");
    expect(card).toContain("نقطة على الخريطة");
    expect(card).toContain("⁦0⁩ ثانية");
  });

  it("escapes hostile user-entered address text (§4.3)", () => {
    const card = offerCard({ ...base, pickupText: 'شارع <b onload="x">' });
    expect(card).not.toContain('<b onload="x">');
    expect(card).toContain("&lt;b onload=&quot;x&quot;&gt;");
  });
});

describe("taskCard (§5: بطاقة المهمة بعد القبول وكل انتقال)", () => {
  const base = {
    publicCode: "1042",
    status: "assigned" as const,
    pickupText: "مطعم الشام — باب توما",
    dropoffText: "المزة، خلف البنك",
    goodsAmount: 120000n,
    codAmount: 135000n,
    currency: "SYP",
  };

  it("renders the Arabic status label and collection amounts", () => {
    const card = taskCard(base);
    expect(card).toContain("مُسند لسائق");
    expect(card).toContain("#1042");
    expect(card).toContain("تحصّل من الزبون عند التسليم");
    expect(card).toMatchSnapshot();
  });

  it("thanks the driver on delivered and drops zero amounts", () => {
    const card = taskCard({ ...base, status: "delivered", goodsAmount: 0n, codAmount: 0n });
    expect(card).toContain("تم التسليم");
    expect(card).toContain("شكراً");
    expect(card).not.toContain("تدفع للتاجر");
    expect(card).not.toContain("تحصّل من الزبون");
  });

  it("escapes a hostile public code instead of breaking the message", () => {
    const card = taskCard({ ...base, publicCode: "<img>" });
    expect(card).not.toContain("<img>");
    expect(card).toContain("&lt;img&gt;");
  });
});
