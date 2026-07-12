import { describe, expect, it } from "vitest";
import { podKey } from "./keys.js";

// §15 — اختبار صافٍ لاشتقاق المفتاح (بلا شبكة/قاعدة).
describe("podKey (§11: اشتقاق مفتاح كائن POD)", () => {
  const TENANT = "0197c5e8-1111-7000-8000-00000000aaaa";
  const ORDER = "0197c5e8-2222-7000-8000-00000000bbbb";

  it("derives a tenant-scoped, order-scoped key", () => {
    expect(podKey(TENANT, ORDER, "jpg")).toBe(`tenants/${TENANT}/orders/${ORDER}/pod.jpg`);
  });

  it("is deterministic — إعادة الإرسال تستبدل الكائن نفسه لا تكرّره", () => {
    expect(podKey(TENANT, ORDER, "jpg")).toBe(podKey(TENANT, ORDER, "jpg"));
  });

  it("strips a leading dot and lowercases the extension", () => {
    expect(podKey(TENANT, ORDER, ".JPG")).toBe(`tenants/${TENANT}/orders/${ORDER}/pod.jpg`);
  });

  it("keeps different tenants in disjoint key spaces (عزل التخزين موازٍ لـ RLS §2.3)", () => {
    const other = "0197c5e8-3333-7000-8000-00000000cccc";
    expect(podKey(TENANT, ORDER, "jpg")).not.toBe(podKey(other, ORDER, "jpg"));
  });

  it("keeps different orders of the same tenant separated", () => {
    const otherOrder = "0197c5e8-4444-7000-8000-00000000dddd";
    expect(podKey(TENANT, ORDER, "jpg")).not.toBe(podKey(TENANT, otherOrder, "jpg"));
  });
});
