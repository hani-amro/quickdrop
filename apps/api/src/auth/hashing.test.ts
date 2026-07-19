import { hash as bcryptHash } from "@node-rs/bcrypt";
import { describe, expect, it } from "vitest";
import { hashPassword, isBcryptHash, needsRehash, verifyPassword } from "./hashing.js";

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
