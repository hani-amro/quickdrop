import { describe, expect, it } from "vitest";
import type { CartLine } from "./conversation.js";
import {
  addToCart,
  cartItemCount,
  computeCartTotal,
  ITEM_CB_RE,
  itemCb,
  MERCHANT_CB_RE,
  merchantCb,
} from "./food.js";
import { foodConfirmCard, foodMenuCard } from "./html.js";

// §15 — اختبارات منطق صافٍ بلا أي اتصالات (كنمط flow.test.ts): بنّاؤو callback_data
// وحساب السلة وبطاقات الطعام. لا استيراد من customer-flow.ts (يسحب @quickdrop/db).

const MERCHANT_ID = "0197c5e8-1111-7000-8000-00000000aaaa";
const ITEM_A = "0197c5e8-2222-7000-8000-00000000bbbb";
const ITEM_B = "0197c5e8-3333-7000-8000-00000000cccc";

describe("food callback_data builders (§4.4: حد 64 بايت)", () => {
  it("builds 'm:{uuid}' and 'ci:{uuid}' round-tripping through the capture regex", () => {
    expect(merchantCb(MERCHANT_ID)).toBe(`m:${MERCHANT_ID}`);
    expect(itemCb(ITEM_A)).toBe(`ci:${ITEM_A}`);

    expect(MERCHANT_CB_RE.exec(merchantCb(MERCHANT_ID))?.[1]).toBe(MERCHANT_ID);
    expect(ITEM_CB_RE.exec(itemCb(ITEM_A))?.[1]).toBe(ITEM_A);
  });

  it("stays within Telegram's 64-byte callback_data limit", () => {
    expect(Buffer.byteLength(merchantCb(MERCHANT_ID), "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(itemCb(ITEM_A), "utf8")).toBeLessThanOrEqual(64);
  });

  it("does not cross-match: an item cb is not a merchant cb (disjoint prefixes)", () => {
    expect(MERCHANT_CB_RE.test(itemCb(ITEM_A))).toBe(false);
    expect(ITEM_CB_RE.test(merchantCb(MERCHANT_ID))).toBe(false);
  });

  it("rejects malformed ids (not a full UUID)", () => {
    expect(MERCHANT_CB_RE.test("m:not-a-uuid")).toBe(false);
    expect(ITEM_CB_RE.test("ci:123")).toBe(false);
  });
});

describe("addToCart (§3: ضغطة = +1، بلا طفر)", () => {
  it("appends a new line with qty 1 for an unseen item", () => {
    const cart = addToCart([], ITEM_A);
    expect(cart).toEqual([{ catalogItemId: ITEM_A, qty: 1 }]);
  });

  it("increments qty of an existing line, leaving others untouched", () => {
    const start: CartLine[] = [
      { catalogItemId: ITEM_A, qty: 2 },
      { catalogItemId: ITEM_B, qty: 1 },
    ];
    const next = addToCart(start, ITEM_A);
    expect(next).toEqual([
      { catalogItemId: ITEM_A, qty: 3 },
      { catalogItemId: ITEM_B, qty: 1 },
    ]);
  });

  it("does not mutate the input cart (state is stored as a fresh JSON snapshot)", () => {
    const start: CartLine[] = [{ catalogItemId: ITEM_A, qty: 1 }];
    addToCart(start, ITEM_A);
    expect(start).toEqual([{ catalogItemId: ITEM_A, qty: 1 }]);
  });
});

describe("cartItemCount", () => {
  it("sums quantities across lines", () => {
    expect(cartItemCount([])).toBe(0);
    expect(
      cartItemCount([
        { catalogItemId: ITEM_A, qty: 2 },
        { catalogItemId: ITEM_B, qty: 3 },
      ]),
    ).toBe(5);
  });
});

describe("computeCartTotal (D5: bigint حصراً)", () => {
  const prices = new Map<string, bigint>([
    [ITEM_A, 3000n],
    [ITEM_B, 5000n],
  ]);

  it("returns Σ price×qty as a bigint", () => {
    const total = computeCartTotal(
      [
        { catalogItemId: ITEM_A, qty: 2 }, // 6000
        { catalogItemId: ITEM_B, qty: 1 }, // 5000
      ],
      prices,
    );
    expect(total).toBe(11000n);
  });

  it("ignores a line whose item vanished from the price map (unavailable mid-flow)", () => {
    const total = computeCartTotal(
      [
        { catalogItemId: ITEM_A, qty: 1 },
        { catalogItemId: "0197c5e8-9999-7000-8000-00000000dddd", qty: 4 },
      ],
      prices,
    );
    expect(total).toBe(3000n);
  });

  it("is 0n for an empty cart", () => {
    expect(computeCartTotal([], prices)).toBe(0n);
  });
});

describe("food cards (§3/§4.4)", () => {
  const lines = [
    { nameAr: "شاورما", qty: 2, unitPrice: 3000n },
    { nameAr: "بطاطا", qty: 1, unitPrice: 2000n },
  ];

  it("foodMenuCard shows an empty-cart hint when nothing is picked", () => {
    const card = foodMenuCard({ merchantName: "مطعم الأصيل", lines: [], currency: "SYP" });
    expect(card).toContain("مطعم الأصيل");
    expect(card).toContain("سلتك فاضية");
  });

  it("foodMenuCard lists lines with quantities and the goods total", () => {
    const card = foodMenuCard({ merchantName: "مطعم الأصيل", lines, currency: "SYP" });
    expect(card).toContain("شاورما");
    expect(card).toContain("قيمة البضاعة");
    expect(card).toMatchSnapshot();
  });

  it("foodConfirmCard notes that delivery is added on confirm (§4.4: لا سعر مفاجئ)", () => {
    const card = foodConfirmCard({ merchantName: "مطعم الأصيل", lines, currency: "SYP" });
    expect(card).toContain("تأكيد طلب الطعام");
    expect(card).toContain("أجرة التوصيل");
    expect(card).toContain("قيمة البضاعة");
  });

  it("escapes a hostile merchant name instead of breaking the message (§4.3)", () => {
    const card = foodMenuCard({ merchantName: "<b>x", lines: [], currency: "SYP" });
    expect(card).not.toContain("<b>x");
    expect(card).toContain("&lt;b&gt;x");
  });
});
