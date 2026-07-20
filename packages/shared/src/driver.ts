import { haversineMeters, makePoint } from "./geo.js";

// §3/§7 — منطق مواقع السائق الصافي (بلا قاعدة ولا شبكة): فحص is_suspect عند الإدخال.
// نُقل إلى @quickdrop/shared (كان في @quickdrop/telegram/driver-logic) كي يستهلكه packages/db
// أيضاً — قناة السائق الجديدة (PWA، P5.1) تسجّل المواقع عبر db، وdb لا يستورد telegram
// (telegram يعتمد db — استيراد معكوس دائري). driver-logic يُعيد التصدير للتوافق.

/** §3: سرعة > 150 كم/س بين نقطتين → مشبوهة. */
export const SUSPECT_SPEED_KMH = 150;
/** §3: قفزة > 2كم … → مشبوهة. */
export const SUSPECT_JUMP_METERS = 2000;
/** §3: … بأقل من 10 ثوان. */
export const SUSPECT_JUMP_WINDOW_S = 10;

export interface LocationSample {
  readonly lat: number;
  readonly lng: number;
  readonly recordedAt: Date;
}

/**
 * §3 v1.1 — يُحسَب عند الإدخال: سرعة > 150 كم/س بين نقطتين، أو قفزة > 2كم بأقل من
 * 10 ثوان مقارنةً بآخر نقطة. النقطة المشبوهة تُخزَّن وتُنبِّه فقط — لا تُغذّي الـ geofence
 * ولا drivers.last_point (§7). هافرساين هنا مشروع: فحص معقولية، لا ترشيح ولا تسعير (الفخ 5).
 */
export function computeIsSuspect(
  prev: LocationSample | null,
  next: LocationSample,
): { isSuspect: boolean; speedKmh: number | null } {
  if (prev === null) return { isSuspect: false, speedKmh: null }; // أول نقطة — لا مرجع للمقارنة

  const distanceM = haversineMeters(makePoint(prev.lat, prev.lng), makePoint(next.lat, next.lng));
  const deltaS = (next.recordedAt.getTime() - prev.recordedAt.getTime()) / 1000;

  if (deltaS <= 0) {
    // نقطة خارج الترتيب الزمني (§7) أو بنفس اللحظة — لا سرعة قابلة للحساب؛ قفزة كبيرة
    // بلا تقدم زمني أسوأ من «أقل من 10 ثوان»
    return { isSuspect: distanceM > SUSPECT_JUMP_METERS, speedKmh: null };
  }

  const speedKmh = (distanceM / deltaS) * 3.6;
  const isSuspect =
    speedKmh > SUSPECT_SPEED_KMH || (distanceM > SUSPECT_JUMP_METERS && deltaS < SUSPECT_JUMP_WINDOW_S);
  return { isSuspect, speedKmh };
}
