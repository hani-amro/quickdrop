import type { Point } from "@quickdrop/shared";

// §7 — عميل OSRM (self-hosted: route + table). كل دالة ترجع null عند أي فشل/خطأ/مهلة
// **بلا رمي** — المستدعي يسقط إلى هافرساين×1.4 ويسجّل تحذيراً (§7: "لا توقف استقبال
// الطلبات"). الإحداثيات بترتيب OSRM = lng,lat (D7 — عكس Google/تيليغرام).

export interface OsrmConfig {
  base: string; // مثل http://osrm:5000
}

/** §7 — OSRM مُهيّأ إن وُجد OSRM_URL؛ غيابه = معطّل → هافرساين. */
export function loadOsrmConfig(env: { OSRM_URL?: string | undefined }): OsrmConfig | null {
  const base = env.OSRM_URL?.trim();
  if (!base) return null;
  return { base: base.replace(/\/+$/, "") };
}

/** ترتيب OSRM: "lng,lat" (D7). دالة نقية للاختبار. */
export function coordPair(p: Point): string {
  return `${p.lng},${p.lat}`;
}

/** بناء URL مسار نقطتين (نقي، قابل للاختبار — يتحقق من ترتيب lng,lat). */
export function routeUrl(base: string, from: Point, to: Point): string {
  return `${base}/route/v1/driving/${coordPair(from)};${coordPair(to)}?overview=false&alternatives=false`;
}

/** بناء URL مصفوفة مسافات من عدة مصادر إلى وجهة واحدة (المصادر 0..n-1، الوجهة الأخيرة). */
export function tableUrl(base: string, sources: Point[], dest: Point): string {
  const coords = [...sources, dest].map(coordPair).join(";");
  const srcIdx = sources.map((_, i) => i).join(";");
  const destIdx = sources.length;
  return `${base}/table/v1/driving/${coords}?sources=${srcIdx}&destinations=${destIdx}&annotations=distance`;
}

const DEFAULT_TIMEOUT_MS = 1500; // §7 — بطء OSRM يجب ألّا يعلّق التسعير/الترشيح

async function fetchJson(url: string, timeoutMs: number): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // §7/§16.12 — لا رمي: أي فشل (شبكة/مهلة/تحليل) = null، والمستدعي يسقط لهافرساين ويسجّل
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** نقي: يستخرج {distanceM, durationS} من رد route، أو null إن كان الشكل غير متوقّع. */
export function parseRoute(json: unknown): { distanceM: number; durationS: number } | null {
  if (typeof json !== "object" || json === null) return null;
  const j = json as { code?: unknown; routes?: unknown };
  if (j.code !== "Ok" || !Array.isArray(j.routes) || j.routes.length === 0) return null;
  const r = j.routes[0] as { distance?: unknown; duration?: unknown };
  if (typeof r.distance !== "number" || typeof r.duration !== "number") return null;
  return { distanceM: Math.round(r.distance), durationS: Math.round(r.duration) };
}

/** نقي: يستخرج مصفوفة مسافات المصادر إلى الوجهة من رد table (العمود الوحيد). */
export function parseTable(json: unknown): number[] | null {
  if (typeof json !== "object" || json === null) return null;
  const j = json as { code?: unknown; distances?: unknown };
  if (j.code !== "Ok" || !Array.isArray(j.distances)) return null;
  const out: number[] = [];
  for (const row of j.distances) {
    if (!Array.isArray(row) || typeof row[0] !== "number") return null;
    out.push(row[0]);
  }
  return out;
}

/** §7 — مسافة/مدة الطريق الحقيقية بين نقطتين، أو null عند الفشل (المستدعي يسقط لهافرساين). */
export async function osrmRoute(
  base: string,
  from: Point,
  to: Point,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ distanceM: number; durationS: number } | null> {
  const json = await fetchJson(routeUrl(base, from, to), timeoutMs);
  return json === null ? null : parseRoute(json);
}

/** §6.1 — مسافة الطريق من كل مصدر إلى وجهة واحدة (طلب واحد لكل الدفعة، لا N طلبات). */
export async function osrmTable(
  base: string,
  sources: Point[],
  dest: Point,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<number[] | null> {
  if (sources.length === 0) return [];
  const json = await fetchJson(tableUrl(base, sources, dest), timeoutMs);
  return json === null ? null : parseTable(json);
}
