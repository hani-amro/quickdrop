import { defineConfig, devices } from "@playwright/test";

// E2E harness for the QuickDrop dashboard (http://localhost:3001) + API
// (http://localhost:3000). The live stack is expected to be ALREADY RUNNING
// externally — this config intentionally does NOT define a `webServer`.
//
// Only unauthenticated, deterministic flows are covered. The authenticated
// dashboard is TOTP-gated (demo owner) and out of scope; see README.md.

export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3001";
export const API_URL = process.env.E2E_API_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests",
  reporter: "list",
  retries: 0,
  // Reasonable ceilings against a local, already-warm stack.
  timeout: 15_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  use: {
    baseURL: BASE_URL,
    trace: "off",
    // Fail fast on slow navigations/actions rather than hanging to the suite timeout.
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
