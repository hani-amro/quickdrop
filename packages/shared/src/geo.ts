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
