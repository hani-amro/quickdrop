// D7 والفخ 6: نوع نقطة واحد بكل النظام، ومحوّلات مسمّاة — ممنوع تمرير أزواج أرقام عارية.
// PostGIS/WKT: (lng lat) — تيليغرام وGoogle: (lat, lng).
export interface Point {
  readonly lat: number;
  readonly lng: number;
}

export function makePoint(lat: number, lng: number): Point {
  if (lat < -90 || lat > 90) throw new RangeError(`invalid lat: ${lat}`);
  if (lng < -180 || lng > 180) throw new RangeError(`invalid lng: ${lng}`);
  return { lat, lng };
}

export function fromTelegram(location: { latitude: number; longitude: number }): Point {
  return makePoint(location.latitude, location.longitude);
}

/** WKT بترتيب PostGIS: lng ثم lat. */
export function toPostgisWkt(point: Point): string {
  return `POINT(${point.lng} ${point.lat})`;
}

// §7: OSRM بالمرحلة 2 — حتى ذلك الحين (وعند سقوطه لاحقاً): مسافة الطريق ≈ هافرساين × 1.4.
export const ROAD_DISTANCE_FALLBACK_FACTOR = 1.4;

/**
 * مسافة الدائرة العظمى بالأمتار (هافرساين).
 * الفخ 5: هافرساين للتقدير والفلترة الأولية فقط — ليس للترشيح النهائي للسائقين
 * ("أقرب سائق" جوّاً قد يكون خلف نهر)؛ التسعير يستخدمه ×ROAD_DISTANCE_FALLBACK_FACTOR
 * كتقريب مؤقت لمسافة الطريق حصراً.
 */
export function haversineMeters(a: Point, b: Point): number {
  const EARTH_RADIUS_M = 6371008.8; // متوسط نصف قطر الأرض (IUGG)
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
