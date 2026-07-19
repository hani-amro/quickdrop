// §7 — لقطة وعد التسليم (promised_at): دالة نقية مشتركة بين طبقة الـ API (تأكيد الطاقم)
// وطبقة القاعدة (ختم المفصل لمسارات الطعام — مراجعة Phase 3 F3). مصدر واحد يمنع الانحراف.
// المعادلة: now + route_duration_s × (eta_correction_bp / 10000) + هامش ثابت.

/** §7 — هامش الوعد فوق الـ ETA المصحَّح: 10 دقائق (يصير عمود إعدادات لاحقاً). */
export const PROMISE_MARGIN_MINUTES = 10;

/**
 * دالة نقية (بلا Date.now ولا قاعدة) — قابلة لاختبار الوحدات مباشرة.
 * مدخل خارج النطاق = باغ مستدعٍ → RangeError صاخب (§16.12)، لا وعد افتراضي صامت.
 */
export function computePromisedAt(
  now: Date,
  routeDurationS: number,
  etaCorrectionBp: number,
  marginMinutes: number,
): Date {
  if (!Number.isFinite(routeDurationS) || routeDurationS < 0) {
    throw new RangeError(`computePromisedAt: routeDurationS must be a non-negative finite number, got ${routeDurationS}`);
  }
  if (!Number.isInteger(etaCorrectionBp) || etaCorrectionBp <= 0) {
    throw new RangeError(`computePromisedAt: etaCorrectionBp must be a positive integer, got ${etaCorrectionBp}`);
  }
  if (!Number.isFinite(marginMinutes) || marginMinutes < 0) {
    throw new RangeError(`computePromisedAt: marginMinutes must be a non-negative finite number, got ${marginMinutes}`);
  }
  // ثواني مصحَّحة → ميلي ثانية مقرَّبة (لا bigint هنا — هذا وقت لا مال؛ النطاقات آمنة لـ Number)
  const correctedMs = Math.round((routeDurationS * etaCorrectionBp * 1000) / 10_000);
  return new Date(now.getTime() + correctedMs + marginMinutes * 60_000);
}
