"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, Marker, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Point } from "@/lib/types";

// D15 — نقطتا الاستلام والتسليم بنقرة على الخريطة. MapLibre GL يُحمَّل ديناميكياً
// داخل useEffect (client-only + lazy — روحية §10.3: الخريطة لا تدخل الحزمة الأولية)،
// والبلاطات raster OSM بلا مفاتيح.
// الفخ 6 — MapLibre يتكلم (lng, lat)؛ التحويل من/إلى Point{lat,lng} هنا حصراً.

const DAMASCUS_CENTER: Point = { lat: 33.5138, lng: 36.2765 }; // مركز مبدئي: دمشق
const INITIAL_ZOOM = 12;

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

export type PickTarget = "pickup" | "dropoff";

// لونا الدبوسين: استلام أخضر، تسليم أحمر — ثابتان بكل الشاشة (مفتاح بصري)
const PIN_COLORS: Record<PickTarget, string> = { pickup: "#059669", dropoff: "#dc2626" };

export default function MapPicker({
  pickup,
  dropoff,
  target,
  onPick,
}: {
  pickup: Point | null;
  dropoff: Point | null;
  target: PickTarget;
  onPick: (target: PickTarget, point: Point) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  // maplibre-gl v5: أنواع الحزمة namespace بلا عضو default — النوع هو الوحدة نفسها،
  // بينما الـ runtime (CJS interop مع dynamic import) يضع الكائن على .default
  const libRef = useRef<typeof import("maplibre-gl") | null>(null);
  const markersRef = useRef<Record<PickTarget, Marker | null>>({ pickup: null, dropoff: null });
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  // آخر هدف/معالج بمرجع — معالج نقر الخريطة يُسجَّل مرة واحدة فقط
  const targetRef = useRef(target);
  targetRef.current = target;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mod = await import("maplibre-gl");
        const maplibregl = (mod as unknown as { default?: typeof import("maplibre-gl") }).default ?? mod;
        if (cancelled || containerRef.current === null || mapRef.current !== null) return;
        libRef.current = maplibregl;
        const map = new maplibregl.Map({
          container: containerRef.current,
          style: OSM_RASTER_STYLE,
          center: [DAMASCUS_CENTER.lng, DAMASCUS_CENTER.lat], // الفخ 6: (lng, lat)
          zoom: INITIAL_ZOOM,
          attributionControl: { compact: true },
        });
        map.on("click", (e) => {
          onPickRef.current(targetRef.current, { lat: e.lngLat.lat, lng: e.lngLat.lng });
        });
        mapRef.current = map;
        setReady(true);
      } catch {
        // §16.12 — لا فشل صامت: فشل تحميل المكتبة/WebGL يظهر للمستخدم
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markersRef.current = { pickup: null, dropoff: null };
    };
  }, []);

  // مزامنة الدبوسين مع الحالة (إنشاء/تحريك/إزالة)
  useEffect(() => {
    if (!ready) return;
    const lib = libRef.current;
    const map = mapRef.current;
    if (lib === null || map === null) return;

    const sync = (key: PickTarget, point: Point | null): void => {
      const existing = markersRef.current[key];
      if (point === null) {
        existing?.remove();
        markersRef.current[key] = null;
        return;
      }
      if (existing === null) {
        markersRef.current[key] = new lib.Marker({ color: PIN_COLORS[key] })
          .setLngLat([point.lng, point.lat]) // الفخ 6: (lng, lat)
          .addTo(map);
      } else {
        existing.setLngLat([point.lng, point.lat]);
      }
    };
    sync("pickup", pickup);
    sync("dropoff", dropoff);
  }, [ready, pickup, dropoff]);

  if (loadFailed) {
    return (
      <div className="flex h-80 items-center justify-center rounded-xl border border-red-200 bg-red-50 text-sm text-red-700">
        تعذر تحميل الخريطة — تحقق من الاتصال ثم أعد تحميل الصفحة
      </div>
    );
  }

  return (
    <div className="relative">
      {/* dir="ltr" داخلياً: أدوات MapLibre مصممة LTR؛ الإطار الخارجي يبقى RTL */}
      <div ref={containerRef} dir="ltr" className="h-80 w-full rounded-xl border border-slate-300" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-slate-100 text-sm text-slate-500">
          جارٍ تحميل الخريطة…
        </div>
      )}
    </div>
  );
}
