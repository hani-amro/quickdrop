import { describe, expect, it } from "vitest";
import { generateTotpSecret, otpauthUrl, totpToken, verifyTotp } from "./totp.js";

// اختبارات pure (§15) — متجهات RFC 6238 (SHA1) بمتجه زمن ثابت محقون (atTime)، بلا
// أي ساعة حقيقية أو Redis. السرّ = ASCII "12345678901234567890" (20 بايتاً) بترميز
// base32؛ قِيَم الرموز من الملحق B بالـ RFC (اقتُطعت لـ 6 خانات = آخر 6 أرقام).
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("verifyTotp — متجهات RFC 6238 بزمن ثابت", () => {
  // T (ثواني) → الرمز المتوقّع (6 خانات) عند تلك اللحظة تحديداً (window=0 = بلا تسامح)
  const vectors: ReadonlyArray<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ];
  for (const [seconds, code] of vectors) {
    it(`T=${seconds} → ${code}`, () => {
      expect(verifyTotp(RFC_SECRET, code, { atTime: seconds * 1000, window: 0 })).toBe(true);
    });
  }

  it("يرفض رمزاً خاطئاً عند نفس اللحظة", () => {
    expect(verifyTotp(RFC_SECRET, "000000", { atTime: 59_000, window: 0 })).toBe(false);
    expect(verifyTotp(RFC_SECRET, "287081", { atTime: 59_000, window: 0 })).toBe(false);
  });
});

describe("verifyTotp — نافذة التسامح ±خطوة", () => {
  it("يقبل رمز الخطوة السابقة/التالية ضمن window=1 (انحراف الساعة)", () => {
    // رمز T=59 (الخطوة 1) يبقى مقبولاً بعد 30 ثانية (الخطوة 2) بنافذة ±1
    expect(verifyTotp(RFC_SECRET, "287082", { atTime: 89_000, window: 1 })).toBe(true);
    // وبلا تسامح (window=0) يُرفض لأنه من خطوة سابقة
    expect(verifyTotp(RFC_SECRET, "287082", { atTime: 89_000, window: 0 })).toBe(false);
  });
});

describe("verifyTotp — مدخلات مشوّهة = رفض بلا رمي", () => {
  it("رمز غير رقمي أو بطول خاطئ", () => {
    expect(verifyTotp(RFC_SECRET, "abcdef", { atTime: 59_000 })).toBe(false);
    expect(verifyTotp(RFC_SECRET, "12345", { atTime: 59_000 })).toBe(false);
    expect(verifyTotp(RFC_SECRET, "1234567", { atTime: 59_000 })).toBe(false);
    expect(verifyTotp(RFC_SECRET, "", { atTime: 59_000 })).toBe(false);
  });
  it("سرّ base32 مشوّه", () => {
    expect(verifyTotp("not base32 @@@", "287082", { atTime: 59_000 })).toBe(false);
  });
  it("يقصّ الفراغات حول الرمز", () => {
    expect(verifyTotp(RFC_SECRET, "  287082  ", { atTime: 59_000, window: 0 })).toBe(true);
  });
});

describe("generateTotpSecret + otpauthUrl", () => {
  it("يولّد سرّاً base32 صالحاً (160-bit = 32 خانة) قابلاً للتحقق", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/u);
    // السرّ المولَّد قابل للاستخدام فعلياً: رمز محسوب لحظةً ما يتحقق عند تلك اللحظة،
    // ويُرفض عند لحظة بعيدة (خارج النافذة) — يثبت اتساق التوليد/التحقق.
    const code = totpToken(secret, { atTime: 59_000 });
    expect(verifyTotp(secret, code, { atTime: 59_000, window: 0 })).toBe(true);
    expect(verifyTotp(secret, code, { atTime: 5_000_000, window: 1 })).toBe(false);
  });

  it("otpauthUrl يحمل السرّ والمُصدِر والمعايير", () => {
    const url = otpauthUrl("ABCDEFGH", "acme:owner@demo.local", "QuickDrop");
    expect(url).toContain("otpauth://totp/QuickDrop:");
    expect(url).toContain("secret=ABCDEFGH");
    expect(url).toContain("issuer=QuickDrop");
    expect(url).toContain("algorithm=SHA1");
    expect(url).toContain("digits=6");
    expect(url).toContain("period=30");
  });
});
