import { afterEach, describe, expect, it, vi } from "vitest";
import { crm } from "./crm";

// §24/§11 — عزل المستأجر: عميل المتصفح لا يختار المستأجر ولا يحمل توكناً. كل نداء يمرّ
// عبر /api/proxy النسبي (يحقن البروكسي الخادمي tenantSlug + التوكن)، ولا يمرّر العميل
// tenantSlug أبداً. هذا الاختبار يحرس ذلك: أي URL خارجي أو tenantSlug من الواجهة = تسريب.

function mockFetch() {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ conversations: [], messages: [], conversation: {}, recentOrders: [], facts: [], tags: [] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("crm client — كل النداءات عبر /api/proxy النسبي (عزل §11)", () => {
  it("listConversations → /api/proxy/crm/conversations، بلا tenantSlug من الواجهة", async () => {
    const calls = mockFetch();
    await crm.listConversations({ status: "open", before: "2026-01-01T00:00:00Z", beforeId: "abc" });
    expect(calls).toHaveLength(1);
    const url = calls[0]!;
    expect(url.startsWith("/api/proxy/crm/conversations")).toBe(true); // نسبي — لا مضيف خارجي
    expect(url).not.toContain("http"); // لا URL مطلق
    expect(url).not.toContain("tenantSlug"); // ⛔ الواجهة لا تختار المستأجر (البروكسي يحقنه)
    expect(url).toContain("status=open");
    expect(url).toContain("beforeId=abc");
  });

  it("getConversation/getCustomer360/reply كلها نسبية عبر البروكسي", async () => {
    const calls = mockFetch();
    await crm.getConversation("c1");
    await crm.getCustomer360("u1");
    await crm.reply("c1", "hi");
    expect(calls.every((u) => u.startsWith("/api/proxy/"))).toBe(true);
    expect(calls.some((u) => u.includes("tenantSlug"))).toBe(false);
    expect(calls[0]).toBe("/api/proxy/crm/conversations/c1");
    expect(calls[1]).toBe("/api/proxy/crm/customers/u1");
    expect(calls[2]).toBe("/api/proxy/support/c1/reply"); // الرد عبر مسار الدعم الموحّد
  });
});
