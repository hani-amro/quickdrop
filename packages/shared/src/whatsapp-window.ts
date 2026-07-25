// Task A (D1) — نافذة خدمة واتساب: 24 ساعة من آخر رسالة زبون واردة عبر واتساب. Meta ترفض
// الرسائل الحرّة خارجها، فيجب قالب HSM معتمد. دالة نقيّة تُستدعى عند حدّ الإرسال (لا I/O،
// لا مال). المصدر (آخر وارد channel='whatsapp') يُحسب في packages/db على القراءة من `messages`.

/** طول نافذة خدمة واتساب بالميلي ثانية (24 ساعة). */
export const WA_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * هل نحن داخل نافذة الـ24 ساعة؟
 * @param lastInboundAt آخر رسالة زبون واردة عبر واتساب لهذا (المستأجر، الزبون)؛
 *   `null`/`undefined` = لم يراسل قطّ عبر واتساب → **خارج** النافذة (يلزم قالب).
 * @param now زمن اتخاذ القرار (يُمرَّر صراحةً — قرار حتمي وقابل للاختبار).
 * الحدّ حصري: عند مرور 24 ساعة بالضبط نُعتبَر **خارج** النافذة (لا نخاطر بإرسال حرّ عند الحافة).
 * طابع مستقبلي (انحراف ساعة نادر) يُعامَل خارج النافذة → قالب (الأكثر أماناً — يعمل داخل/خارج).
 */
export function isWithinServiceWindow(lastInboundAt: Date | null | undefined, now: Date): boolean {
  if (lastInboundAt === null || lastInboundAt === undefined) return false;
  const elapsed = now.getTime() - lastInboundAt.getTime();
  return elapsed >= 0 && elapsed < WA_SERVICE_WINDOW_MS;
}
