import type { Page } from "@playwright/test";

/**
 * Attach console/page listeners and collect severity-"error" console messages
 * plus uncaught page exceptions. Call BEFORE navigation.
 *
 * `ignore` filters out known-benign noise (e.g. a missing favicon) so an
 * incidental 404 for a static asset doesn't fail a "page renders clean" test.
 */
export function collectConsoleErrors(page: Page, ignore: RegExp[] = []): string[] {
  const errors: string[] = [];
  const keep = (text: string): void => {
    if (!ignore.some((re) => re.test(text))) errors.push(text);
  };
  page.on("console", (msg) => {
    if (msg.type() === "error") keep(msg.text());
  });
  page.on("pageerror", (err) => keep(`pageerror: ${err.message}`));
  return errors;
}
