import { afterEach, describe, expect, it, vi } from "vitest";
import { campaigns } from "./campaigns";

// §24/§11 — عزل: عميل الحملات كله عبر /api/proxy النسبي (البروكسي يحقن المستأجر+التوكن)؛
// والـ API يحصر البث بدور owner/dispatcher. الواجهة لا تمرّر tenantSlug ولا سعراً.

function mockFetch() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ broadcasts: [], broadcast: {}, enqueued: true, count: 7 }), { status: 200 });
  });
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("campaigns client — بث موجّه عبر البروكسي (عزل §11)", () => {
  it("list/create/audienceCount نسبية بلا tenantSlug من الواجهة؛ لا سعر بالجسم", async () => {
    const calls = mockFetch();
    await campaigns.list();
    await campaigns.create({ body: "عرض اليوم", audienceFilter: { minRfm: 50, lifecycleStage: ["loyal"] } });
    const { count } = await campaigns.audienceCount({ minRfm: 50 });

    expect(count).toBe(7);
    expect(calls[0]).toMatchObject({ url: "/api/proxy/broadcasts", method: "GET" });
    expect(calls[1]).toMatchObject({ url: "/api/proxy/broadcasts", method: "POST" });
    expect(calls[2]).toMatchObject({ url: "/api/proxy/broadcasts/audience-count", method: "POST" });

    for (const c of calls) {
      expect(c.url.startsWith("/api/proxy/")).toBe(true);
      expect(c.url).not.toContain("tenantSlug");
      const bodyStr = JSON.stringify(c.body ?? {});
      expect(bodyStr).not.toContain("tenantSlug"); // ⛔ الواجهة لا تختار المستأجر
      expect(bodyStr).not.toMatch(/price|amount|cod/i); // نص فقط — لا سعر (D11 روحاً)
    }
    // فلتر الجمهور يُمرَّر كما هو (شريحة، لا سعر)
    expect(calls[1]!.body).toEqual({ body: "عرض اليوم", audienceFilter: { minRfm: 50, lifecycleStage: ["loyal"] } });
  });
});
