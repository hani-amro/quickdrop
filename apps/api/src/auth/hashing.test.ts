import { hash as bcryptHash } from "@node-rs/bcrypt";
import { describe, expect, it } from "vitest";
import { hashPassword, isBcryptHash, needsRehash, remainingDelayMs, verifyPassword } from "./hashing.js";

// §23 (توحيد المصادقة) — التحقق الموحّد وإعادة الهاش الكسولة: bcrypt (طاقم WaFlow) وargon2id
// (طاقم QuickDrop) كلاهما يُتحقّق؛ bcrypt يُعلَّم للترقية.

describe("hashing — توحيد bcrypt/argon2 + إعادة هاش كسولة (§23)", () => {
  it("argon2id: هاش/تحقق يعمل، وليس بحاجة إعادة هاش", async () => {
    const h = await hashPassword("demo1234");
    expect(h.startsWith("$argon2")).toBe(true);
    expect(await verifyPassword(h, "demo1234")).toBe(true);
    expect(await verifyPassword(h, "wrong")).toBe(false);
    expect(needsRehash(h)).toBe(false);
    expect(isBcryptHash(h)).toBe(false);
  });

  it("bcrypt (طاقم WaFlow): يُتحقّق منه، ويُعلَّم needsRehash للترقية", async () => {
    const bh = await bcryptHash("s3cret-wa", 10);
    expect(isBcryptHash(bh)).toBe(true); // $2b$…
    expect(needsRehash(bh)).toBe(true);
    expect(await verifyPassword(bh, "s3cret-wa")).toBe(true);
    expect(await verifyPassword(bh, "nope")).toBe(false);
  });

  it("هاش مشوّه → رفض (لا رمي، لا ابتلاع صامت)", async () => {
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
    expect(await verifyPassword("$2b$broken", "x")).toBe(false);
  });
});

// §11/مراجعة Phase 4 (security) — توقيت فشل الدخول الثابت: توحيد المصادقة (§23) أدخل مسار
// bcrypt الأبطأ، فالتأخير الإضافي كان يترك فارقاً يكشف حساباً قديماً. الموعد النهائي يجعل
// إجمالي زمن كل مسارات الفشل واحداً — نُثبت الخاصية نقيّاً (بلا توقيت حقيقي).
describe("remainingDelayMs — توقيت فشل الدخول الثابت", () => {
  const DEADLINE = 700;
  it("الزمن الكلّي = الموعد مهما اختلف زمن الـ KDF (argon2 سريع vs bcrypt بطيء)", () => {
    // argon2: انقضى 50ms → ننام 650 → الإجمالي 700
    expect(50 + remainingDelayMs(DEADLINE, 1000, 1050)).toBe(700);
    // bcrypt: انقضى 250ms → ننام 450 → الإجمالي 700 (نفس argon2 — لا فارق يُكشَف)
    expect(250 + remainingDelayMs(DEADLINE, 1000, 1250)).toBe(700);
    // مسار «لا مستخدم» (dummy argon2): انقضى 55ms → الإجمالي 700 أيضاً
    expect(55 + remainingDelayMs(DEADLINE, 1000, 1055)).toBe(700);
  });
  it("تجاوز الموعد (خادم محمّل) → نوم 0 (لا سالب)", () => {
    expect(remainingDelayMs(DEADLINE, 1000, 1900)).toBe(0); // انقضى 900 > 700
    expect(remainingDelayMs(DEADLINE, 1000, 1700)).toBe(0); // انقضى 700 = الموعد
  });
});
