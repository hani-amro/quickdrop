import { test, expect } from "@playwright/test";
import { API_URL } from "../playwright.config";

// API-only tests — these use Playwright's `request` fixture (Node HTTP), so they
// never launch a browser and MUST pass even if the chromium download failed.
// They assert the API's public/guard contract against the live stack on API_URL.

test.describe("API (unauthenticated contract)", () => {
  test("GET /health → 200 and reports ok", async ({ request }) => {
    const res = await request.get(`${API_URL}/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Body shape: { status: "ok", db: "up", redis: "up" }
    expect(body.status).toBe("ok");
  });

  test("GET /api/miniapp/restaurants (no auth) → 401", async ({ request }) => {
    const res = await request.get(`${API_URL}/api/miniapp/restaurants`);
    expect(res.status()).toBe(401);
  });

  test("POST /api/miniapp/auth with garbage initData → 401", async ({ request }) => {
    const res = await request.post(`${API_URL}/api/miniapp/auth`, {
      data: { tenantSlug: "demo", initData: "garbage" },
    });
    // Invalid Telegram initData must be rejected as unauthorized, not accepted.
    expect(res.status()).toBe(401);
  });

  test("GET /api/orders (no auth / no session) → 401", async ({ request }) => {
    const res = await request.get(`${API_URL}/api/orders`);
    // Staff guard: no session cookie ⇒ unauthorized.
    expect(res.status()).toBe(401);
  });
});
