import { test, expect } from "@playwright/test";
import { collectConsoleErrors } from "./helpers";

// Known-benign console noise that must not fail the "renders clean" assertion.
const BENIGN = [/favicon\.ico/i];

test.describe("Login page", () => {
  test("renders an RTL Arabic staff login form with no console errors", async ({ page }) => {
    const errors = collectConsoleErrors(page, BENIGN);

    const res = await page.goto("/login");
    // Page loaded successfully.
    expect(res?.ok()).toBeTruthy();
    await expect(page).toHaveURL(/\/login$/);

    // RTL Arabic document (D12/§10.1).
    const html = page.locator("html");
    await expect(html).toHaveAttribute("dir", "rtl");
    await expect(html).toHaveAttribute("lang", "ar");

    // Login form: email + password inputs and a submit button.
    const email = page.locator("#email");
    const password = page.locator("#password");
    const submit = page.locator('button[type="submit"]');

    await expect(email).toBeVisible();
    await expect(email).toHaveAttribute("type", "email");
    await expect(password).toBeVisible();
    await expect(password).toHaveAttribute("type", "password");
    await expect(submit).toBeVisible();
    // Arabic submit label ("دخول").
    await expect(submit).toHaveText(/دخول/);

    // No console errors of severity "error" (and no uncaught page exceptions).
    expect(errors, `Unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("invalid credentials show an error and stay on /login (no dashboard access)", async ({ page }) => {
    await page.goto("/login");

    await page.locator("#email").fill("nobody@example.com");
    await page.locator("#password").fill("wrongpass");
    await page.locator('button[type="submit"]').click();

    // A generic error alert appears (the component never reveals the reason, §11):
    // either "بيانات الدخول غير صحيحة" (rejected) or "تعذّر الاتصال بالخادم" (unreachable).
    // The component renders it as <p role="alert">; scope to that so we don't collide
    // with Next.js's own aria-live route announcer (also role="alert").
    const alert = page.locator('p[role="alert"]');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText(/بيانات الدخول غير صحيحة|تعذّر الاتصال بالخادم/);

    // Still on /login — no redirect into the authenticated dashboard.
    await expect(page).toHaveURL(/\/login$/);
  });
});
