import { test, expect } from "@playwright/test";

test.describe("Public tracking page", () => {
  test("invalid token degrades gracefully (no crash / white-screen)", async ({ page }) => {
    // Capture uncaught exceptions — the page must never throw to the top level.
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto("/t/invalid-token-abc");

    // The route is public (no auth) and renders a self-contained card. Depending
    // on the public API's response it lands in one of three graceful states,
    // never a Next.js error boundary / blank page:
    //   • "انتهت صلاحية رابط التتبع"       — 404 from /public/track (expired/absent)
    //   • "تعذر تحميل بيانات التتبع"        — fetch failed, auto-retry
    //   • "جارٍ تحميل بيانات التتبع"        — initial load
    const graceful = page.getByText(
      /انتهت صلاحية رابط التتبع|تعذر تحميل بيانات التتبع|جارٍ تحميل بيانات التتبع/,
    );
    await expect(graceful).toBeVisible();

    // Not a white-screen: the document body has rendered visible content.
    await expect(page.locator("body")).not.toBeEmpty();

    // No unhandled runtime error surfaced from the tracking component.
    expect(pageErrors, `Unexpected page errors:\n${pageErrors.join("\n")}`).toEqual([]);
  });
});
