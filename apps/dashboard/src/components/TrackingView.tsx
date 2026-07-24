"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, Marker, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { OrderStatus } from "@quickdrop/shared";
import { statusLabel, type Translate } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { PublicTrackingResponse } from "@/lib/types";

// §7 — صفحة التتبع العام /t/{token}: زائر مجهول (زبون/مستلم — الفخ 16) يرى الحالة
// بالعربي + خريطة عرض فقط (دبوس تسليم ثابت + دبوس سائق يتحدث) — لا أسماء ولا أرقام.
// الجلب مباشر من المتصفح إلى NEXT_PUBLIC_API_URL (endpoint عام بلا auth — لا proxy:
// لا توكن staff بهذه الصفحة أصلاً)، polling كل 10 ثوانٍ.
// الفخ 19 — النقطة القديمة لا تتنكر بهيئة موقع حي: "آخر موقع معروف قبل X".

const POLL_INTERVAL_MS = 10_000;
/** نقطة أقدم من هذا = "آخر موقع معروف قبل X" بدل "مباشر" (الفخ 19). */
const STALE_POINT_S = 90;
const INITIAL_ZOOM = 14;

// نفس نمط MapPicker: بلاطات raster OSM بلا مفاتيح — نسخة عرض فقط
const OSM_RASTER_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

// نفس مفتاح MapPicker البصري: التسليم أحمر؛ السائق أزرق (متحرك)
const DROPOFF_PIN_COLOR = "#dc2626";
const DRIVER_PIN_COLOR = "#0284c7";

/** عمر النقطة بالثواني → نص عربي قصير: "قبل لحظات" / "قبل X د" / "قبل X س Y د". */
export function pointAgeLabel(t: Translate, ageS: number): string {
  if (ageS < 60) return t("tracking.ageMoments");
  const m = Math.floor(ageS / 60);
  if (m < 60) return t("tracking.ageMinutes", { m });
  const h = Math.floor(m / 60);
  return t("tracking.ageHours", { h, m: m % 60 });
}

// ألوان شارة الحالة — عرض فقط (القاموس نفسه STATUS_LABELS من format.ts)
function statusBadgeClass(status: OrderStatus): string {
  switch (status) {
    case "delivered":
      return "bg-emerald-100 text-emerald-800";
    case "failed":
    case "returned":
    case "cancelled_by_customer":
    case "cancelled_by_office":
      return "bg-red-100 text-red-700";
    case "in_transit":
    case "arrived":
    case "picked_up":
      return "bg-sky-100 text-sky-800";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

type Phase = "loading" | "live" | "expired";

export function TrackingView({ token }: { token: string }) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("loading");
  const [data, setData] = useState<PublicTrackingResponse | null>(null);
  // فشل شبكي/خادمي عابر: مؤشر صريح مع بقاء آخر بيانات ناجحة — لا فشل صامت (§16.12)
  const [failed, setFailed] = useState(false);

  const dataRef = useRef<PublicTrackingResponse | null>(null);
  dataRef.current = data;

  // —— polling كل 10 ثوانٍ — fetch مباشر (endpoint عام؛ 404 = انتهى الرابط ويوقف الدورة) ——
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = (): void => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };

    // NEXT_PUBLIC_* يُحقن وقت البناء؛ غيابه خطأ إعداد يظهر كفشل جلب صريح، لا انهيار
    const base = process.env.NEXT_PUBLIC_API_URL;
    if (base === undefined || base === "") {
      setFailed(true);
      return;
    }
    const url = `${base.replace(/\/$/, "")}/public/track/${encodeURIComponent(token)}`;

    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!alive) return;
        if (res.status === 404) {
          // §7: غائب أو منتهٍ — رسالة واحدة عامة، وأوقف الدورة (لن يعود للحياة)
          setPhase("expired");
          stop();
          return;
        }
        if (!res.ok) {
          setFailed(true);
          return;
        }
        const next = (await res.json()) as PublicTrackingResponse;
        if (!alive) return;
        setData(next);
        setPhase("live");
        setFailed(false);
      } catch {
        // فشل شبكة — مؤشر مرئي وإعادة محاولة بالدورة القادمة، لا رمي داخل interval
        if (alive) setFailed(true);
      }
    };

    void poll();
    timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      alive = false;
      stop();
    };
  }, [token]);

  // —— خريطة MapLibre عرض فقط (نمط MapPicker read-only) ——
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  // maplibre-gl v5: أنواع الحزمة namespace بلا عضو default — النوع هو الوحدة نفسها،
  // بينما الـ runtime (CJS interop مع dynamic import) يضع الكائن على .default
  const libRef = useRef<typeof import("maplibre-gl") | null>(null);
  const dropoffMarkerRef = useRef<Marker | null>(null);
  const driverMarkerRef = useRef<Marker | null>(null);
  const didFitRef = useRef(false);
  const [mapReady, setMapReady] = useState(false);
  const [mapLoadFailed, setMapLoadFailed] = useState(false);

  // التحميل الكسول بعد أول بيانات (المركز = نقطة التسليم) — client-only، خارج الحزمة الأولية
  useEffect(() => {
    if (phase !== "live" || mapRef.current !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const mod = await import("maplibre-gl");
        const maplibregl = (mod as unknown as { default?: typeof import("maplibre-gl") }).default ?? mod;
        const dropoff = dataRef.current?.dropoff;
        if (cancelled || containerRef.current === null || mapRef.current !== null || dropoff === undefined) return;
        libRef.current = maplibregl;
        const map = new maplibregl.Map({
          container: containerRef.current,
          style: OSM_RASTER_STYLE,
          center: [dropoff.lng, dropoff.lat], // الفخ 6: MapLibre يتكلم (lng, lat)
          zoom: INITIAL_ZOOM,
          attributionControl: { compact: true },
        });
        mapRef.current = map;
        setMapReady(true);
      } catch {
        // §16.12 — لا فشل صامت: فشل تحميل المكتبة/WebGL يظهر للمستخدم
        if (!cancelled) setMapLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase]);

  // تفكيك الخريطة عند مغادرة الصفحة فقط
  useEffect(
    () => () => {
      mapRef.current?.remove();
      mapRef.current = null;
      dropoffMarkerRef.current = null;
      driverMarkerRef.current = null;
    },
    [],
  );

  // مزامنة الدبوسين: التسليم ثابت (يُنشأ مرة)، السائق يُنشأ/يتحرك/يُزال مع كل poll
  useEffect(() => {
    if (!mapReady || data === null) return;
    const lib = libRef.current;
    const map = mapRef.current;
    if (lib === null || map === null) return;

    if (dropoffMarkerRef.current === null) {
      dropoffMarkerRef.current = new lib.Marker({ color: DROPOFF_PIN_COLOR })
        .setLngLat([data.dropoff.lng, data.dropoff.lat]) // الفخ 6: (lng, lat)
        .addTo(map);
    }

    if (data.driver === null) {
      driverMarkerRef.current?.remove();
      driverMarkerRef.current = null;
      return;
    }
    if (driverMarkerRef.current === null) {
      driverMarkerRef.current = new lib.Marker({ color: DRIVER_PIN_COLOR })
        .setLngLat([data.driver.lng, data.driver.lat])
        .addTo(map);
    } else {
      driverMarkerRef.current.setLngLat([data.driver.lng, data.driver.lat]);
    }

    // ضبط الإطار مرة واحدة عند أول ظهور للسائق — لا خطف للخريطة مع كل poll
    if (!didFitRef.current) {
      didFitRef.current = true;
      map.fitBounds(
        [
          [Math.min(data.dropoff.lng, data.driver.lng), Math.min(data.dropoff.lat, data.driver.lat)],
          [Math.max(data.dropoff.lng, data.driver.lng), Math.max(data.dropoff.lat, data.driver.lat)],
        ],
        { padding: 64, maxZoom: 15 },
      );
    }
  }, [mapReady, data]);

  // —— العرض ——

  if (phase === "expired") {
    return (
      <div className="mx-auto flex min-h-[60dvh] max-w-md items-center justify-center">
        <div className="w-full rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <p className="text-4xl">⌛</p>
          <h1 className="mt-3 text-lg font-bold text-slate-800">{t("tracking.expiredTitle")}</h1>
          <p className="mt-2 text-sm text-slate-500">{t("tracking.expiredHint")}</p>
        </div>
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <div className="mx-auto flex min-h-[60dvh] max-w-md items-center justify-center">
        <div className="w-full rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          {failed ? (
            <>
              <h1 className="text-lg font-bold text-slate-800">{t("tracking.loadFailedTitle")}</h1>
              <p className="mt-2 text-sm text-slate-500">{t("tracking.retryingAuto")}</p>
            </>
          ) : (
            <p className="text-sm text-slate-500">{t("tracking.loading")}</p>
          )}
        </div>
      </div>
    );
  }

  // phase === "live" — data موجودة حكماً
  if (data === null) return null;
  const driver = data.driver;
  const stale = driver !== null && driver.lastPointAgeS >= STALE_POINT_S;

  return (
    <div className="mx-auto max-w-xl">
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 p-4">
          <div>
            <h1 className="text-base font-bold text-slate-800">{t("tracking.title")}</h1>
            {/* §10.1 — كود الطلب بالتفاف bidi: أرقام/لاتيني داخل نص عربي */}
            <p className="mt-0.5 text-sm text-slate-500">
              {t("tracking.orderNumber")} <bdi className="font-semibold text-slate-700">#{data.publicCode}</bdi>
            </p>
          </div>
          <span className={`rounded-full px-3 py-1 text-sm font-semibold ${statusBadgeClass(data.status)}`}>
            {statusLabel(t, data.status)}
          </span>
        </div>

        <div className="p-4">
          {mapLoadFailed ? (
            <div className="flex h-80 items-center justify-center rounded-xl border border-red-200 bg-red-50 text-sm text-red-700">
              {t("tracking.mapLoadFailed")}
            </div>
          ) : (
            <div className="relative">
              {/* dir="ltr" داخلياً: أدوات MapLibre مصممة LTR؛ الإطار الخارجي يبقى RTL */}
              <div ref={containerRef} dir="ltr" className="h-80 w-full rounded-xl border border-slate-300" />
              {!mapReady && (
                <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-slate-100 text-sm text-slate-500">
                  {t("tracking.mapLoading")}
                </div>
              )}
            </div>
          )}

          {/* الفخ 19 — عمر آخر نقطة معلَن دائماً؛ القديمة لا تتنكر بهيئة "مباشر" */}
          {driver !== null ? (
            stale ? (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {t("tracking.driverLastKnown", { age: pointAgeLabel(t, driver.lastPointAgeS) })}
              </p>
            ) : (
              <p className="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-800">
                {t("tracking.driverLive", { age: pointAgeLabel(t, driver.lastPointAgeS) })}
              </p>
            )
          ) : (
            <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">
              {t("tracking.noDriverLocation")}
            </p>
          )}

          {failed && (
            <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              {t("tracking.updateFailed")}
            </p>
          )}
        </div>
      </div>

      <p className="mt-4 text-center text-xs text-slate-400">QuickDrop — {t("tracking.pollNote")}</p>
    </div>
  );
}
