// §10.2 — كوكي الجلسة qd_session: دوال نقية (قابلة للاختبار بلا HTTP — انظر
// cookie.test.ts). HttpOnly = لا يقرؤه JS بالمتصفح، SameSite=Lax = يكسر CSRF
// عبر المواقع للأفعال POST (§11)، وSecure بالإنتاج حصراً (التطوير http محلي).

export const SESSION_COOKIE = "qd_session";

/** §10.2 — عمر الجلسة 8 ساعات (وردية مكتب): TTL بـ Redis وMax-Age بالكوكي معاً. */
export const SESSION_TTL_S = 8 * 60 * 60;

/** معرّف الجلسة الذي نصدره: 128-bit عشوائي = 32 hex — أي شكل آخر يُرفض قبل Redis. */
export const SESSION_ID_RE = /^[0-9a-f]{32}$/;

/**
 * ترويسة Cookie → أزواج {اسم: قيمة} خام (بلا فك ترميز — معرّفاتنا hex حصراً،
 * وفك % على مدخل عدائي مصدر أعطال). القسمة عند أول '=' فقط: القيم قد تحويه.
 * مدخل مشوّه (زوج بلا '=') يُتجاهل — حدّ نظام عام، لا رمي (§11).
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === "") continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

/** §10.2 — Set-Cookie للدخول: HttpOnly + SameSite=Lax + Path=/ (+ Secure بالإنتاج). */
export function buildSessionCookie(sessionId: string, secure: boolean): string {
  return (
    `${SESSION_COOKIE}=${sessionId}; Max-Age=${SESSION_TTL_S}; Path=/; HttpOnly; SameSite=Lax` +
    (secure ? "; Secure" : "")
  );
}

/** Set-Cookie للخروج: نفس السمات (شرط الاستبدال بالمتصفح) وMax-Age=0 يمحوه فوراً. */
export function buildClearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax` + (secure ? "; Secure" : "");
}
