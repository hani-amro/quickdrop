import * as Sentry from "@sentry/node";

// §13 — Sentry بالتطبيقات الأربعة مع tenant_id كـ tag: "أول سؤال بأي عطل: مكتب
// واحد أم الكل؟". بلا SENTRY_DSN (التطوير) = no-op تام — لا تهيئة ولا التقاط.

let enabled = false;

export function initSentry(dsn: string | undefined, environment: string): void {
  if (!dsn) return; // dev/بلا DSN → صامت
  Sentry.init({ dsn, environment, tracesSampleRate: 0.1 });
  enabled = true;
}

/** §13 — التقاط استثناء مع وسم المستأجر (وطلب/فاعل اختياريين) — no-op إن لم يُهيَّأ. */
export function captureException(error: unknown, tags?: { tenantId?: string; orderId?: string; actor?: string }): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    if (tags?.tenantId) scope.setTag("tenant_id", tags.tenantId);
    if (tags?.orderId) scope.setTag("order_id", tags.orderId);
    if (tags?.actor) scope.setTag("actor", tags.actor);
    Sentry.captureException(error);
  });
}

export function isSentryEnabled(): boolean {
  return enabled;
}
