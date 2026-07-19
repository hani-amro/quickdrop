import { afterEach, describe, expect, it, vi } from "vitest";
import { journeys } from "./journeys";

// §24/§11 — عزل: عميل الرحلات كله عبر /api/proxy النسبي (يحقن البروكسي المستأجر+التوكن)؛
// CRUD يستخدم POST/PATCH/DELETE — وكلها لا تمرّر tenantSlug من الواجهة.

function mockFetch() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ journeys: [], journey: {}, deleted: true }), { status: 200 });
  });
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("journeys client — CRUD عبر البروكسي (عزل §11)", () => {
  it("list=GET, create=POST, update=PATCH, remove=DELETE — نسبية وبلا tenantSlug من الواجهة", async () => {
    const calls = mockFetch();
    await journeys.list();
    await journeys.create({ name: "win", trigger: "crm.lifecycle_changed", steps: [{ type: "wait", delayHours: 1 }] });
    await journeys.update("j1", { isActive: true });
    await journeys.remove("j1");

    expect(calls[0]).toMatchObject({ url: "/api/proxy/journeys", method: "GET" });
    expect(calls[1]).toMatchObject({ url: "/api/proxy/journeys", method: "POST" });
    expect(calls[2]).toMatchObject({ url: "/api/proxy/journeys/j1", method: "PATCH" });
    expect(calls[3]).toMatchObject({ url: "/api/proxy/journeys/j1", method: "DELETE" });

    for (const c of calls) {
      expect(c.url.startsWith("/api/proxy/")).toBe(true); // نسبي — لا مضيف خارجي
      expect(c.url).not.toContain("tenantSlug"); // ⛔ الواجهة لا تختار المستأجر
      expect(JSON.stringify(c.body ?? {})).not.toContain("tenantSlug"); // ولا بالجسم
    }
    // الإنشاء يلفّ المدخل بـ journey (عقد الـ API) كما هو — بلا حقول تحقنها الواجهة
    expect(calls[1]!.body).toEqual({ journey: { name: "win", trigger: "crm.lifecycle_changed", steps: [{ type: "wait", delayHours: 1 }] } });
  });
});
