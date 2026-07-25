import { describe, expect, it } from "vitest";
import { isWithinServiceWindow, WA_SERVICE_WINDOW_MS } from "./whatsapp-window.js";

// Task A (D1) — نافذة واتساب 24 ساعة (دالة نقيّة، حدّ حصري عند 24 ساعة بالضبط).
describe("isWithinServiceWindow", () => {
  const now = new Date("2026-07-25T12:00:00.000Z");

  it("داخل النافذة: آخر وارد قبل ساعة → true", () => {
    expect(isWithinServiceWindow(new Date(now.getTime() - 60 * 60 * 1000), now)).toBe(true);
  });

  it("قبل الحافة بميلي ثانية (<24 ساعة) → true", () => {
    expect(isWithinServiceWindow(new Date(now.getTime() - (WA_SERVICE_WINDOW_MS - 1)), now)).toBe(true);
  });

  it("عند الحافة تماماً (24 ساعة) → false (حصري)", () => {
    expect(isWithinServiceWindow(new Date(now.getTime() - WA_SERVICE_WINDOW_MS), now)).toBe(false);
  });

  it("خارج النافذة (25 ساعة) → false", () => {
    expect(isWithinServiceWindow(new Date(now.getTime() - 25 * 60 * 60 * 1000), now)).toBe(false);
  });

  it("null/undefined (لم يراسل عبر واتساب قطّ) → false", () => {
    expect(isWithinServiceWindow(null, now)).toBe(false);
    expect(isWithinServiceWindow(undefined, now)).toBe(false);
  });

  it("طابع مستقبلي (انحراف ساعة) → false (يُعامَل خارج النافذة — الأكثر أماناً)", () => {
    expect(isWithinServiceWindow(new Date(now.getTime() + 5 * 60 * 1000), now)).toBe(false);
  });
});
