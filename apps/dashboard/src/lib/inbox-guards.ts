// §25/مراجعة Phase 4 (correctness) — قرارات نقيّة للوارد الموحّد. المراجعة المستقلة لقطت
// عيبين في شروط ضمنية بـ InboxView؛ استخراجها هنا مسمّاة + مُختبَرة يمنع انحدارها. (مكوّنات
// React تُغطّى سلوكياً بـ e2e؛ هذه دوال نقيّة تُغطّى بوحدات — نفس نمط الداشبورد.)

/**
 * هل نُظهر شاشة الخطأ الكاملة؟ فقط حين لا توجد قائمة محمّلة بعد (تحميل أولي فشل). قائمة
 * محمّلة (ولو فارغة) + خطأ عابر من poll/realtime خلفي = **لا** نهدم الواجهة (الاحتياط صامت
 * لا هادم — عيب MED). ملاحظة: [] قائمة محمّلة صالحة (وارد فارغ) فلا تُعامَل كتحميل أولي.
 */
export function shouldShowInboxError(items: readonly unknown[] | null, error: number | null): boolean {
  return error !== null && items === null;
}

/** هل نُسجّل الخطأ عند فشل الجلب؟ فقط على التحميل الأولي (لا قائمة بعد) — لا نهدم قائمة محمّلة. */
export function shouldRecordInboxError(items: readonly unknown[] | null): boolean {
  return items === null;
}

/**
 * هل نطبّق استجابة غير متزامنة (خيط/بطاقة) على الواجهة؟ فقط إن كان خيطها لا يزال المحدَّد —
 * يمنع سباق الترتيب: نقر A (استجابة بطيئة) ثم B (سريعة) كان يكتب A فوق B (عيب LOW).
 */
export function isResponseForSelected(currentSelectedId: string | null, responseThreadId: string): boolean {
  return currentSelectedId === responseThreadId;
}
