import { test, expect } from "@playwright/test";

test.describe("Session guard", () => {
  test("root '/' redirects an unauthenticated visitor to /login", async ({ page }) => {
    // Middleware (§10.2) redirects any staff page without a qd_session cookie.
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);

    // And the login form is actually there after the redirect.
    await expect(page.locator("#email")).toBeVisible();
  });
});
