// §10.2 — كوكي جلسة المشرف qd_admin: منفصل تماماً عن qd_session للطاقم (نظام دخول
// مستقل، لا "أدوار مرتفعة"). دوال نقية قابلة للاختبار بلا HTTP. HttpOnly + SameSite=Lax
// (كسر CSRF) + Secure بالإنتاج. parseCookies يُعاد استخدامه من auth/cookie (مشترك).

export const ADMIN_SESSION_COOKIE = "qd_admin";

/** §10.2 — عمر جلسة المشرف 8 ساعات: TTL بـ Redis (asess:) وMax-Age بالكوكي معاً. */
export const ADMIN_SESSION_TTL_S = 8 * 60 * 60;

/** معرّف جلسة المشرف: 128-bit عشوائي = 32 hex — أي شكل آخر يُرفض قبل Redis. */
export const ADMIN_SESSION_ID_RE = /^[0-9a-f]{32}$/;

/** §10.2 — Set-Cookie لدخول المشرف: HttpOnly + SameSite=Lax + Path=/ (+ Secure بالإنتاج). */
export function buildAdminSessionCookie(sessionId: string, secure: boolean): string {
  return (
    `${ADMIN_SESSION_COOKIE}=${sessionId}; Max-Age=${ADMIN_SESSION_TTL_S}; Path=/; HttpOnly; SameSite=Lax` +
    (secure ? "; Secure" : "")
  );
}

/** Set-Cookie لخروج المشرف: نفس السمات (شرط الاستبدال) وMax-Age=0 يمحوه فوراً. */
export function buildClearAdminSessionCookie(secure: boolean): string {
  return `${ADMIN_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax` + (secure ? "; Secure" : "");
}
