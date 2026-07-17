import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Map as MapLibreMap, Marker, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Point } from "../lib/types";

// §10.3 روحية اللوحة — MapLibre GL يُحمَّل ديناميكياً (await import) داخل المكوّن، وهذا
// المكوّن نفسه يُحمَّل عبر React.lazy: لا حزمة الخريطة ولا CSS الخريطة يدخلان الحزمة الأولية.
// الفخ 6 — MapLibre يتكلم (lng, lat)؛ التحويل من/إلى Point{lat,lng} هنا حصراً.
// البلاطات raster OSM بلا مفاتيح (لا مفتاح API مدفوع مضمّن).

const DAMASCUS_CENTER: Point = { lat: 33.5138, lng: 36.2765 };
const INITIAL_ZOOM = 12;
const PIN_ZOOM = 15;

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

export default function MapPicker({ value, onPick }: { value: Point | null; onPick: (p: Point) => void }): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  // maplibre-gl v5: أنواع الحزمة namespace بلا default؛ الـ runtime (CJS interop) على .default
  const libRef = useRef<typeof import("maplibre-gl") | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  // نقرة الخريطة تُسجَّل مرة واحدة؛ أحدث onPick بمرجع. selfSet يمنع إعادة التوسيط بعد نقرة المستخدم.
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const selfSetRef = useRef(false);

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
          selfSetRef.current = true;
          onPickRef.current({ lat: e.lngLat.lat, lng: e.lngLat.lng });
        });
        mapRef.current = map;
        setReady(true);
      } catch {
        // §16.12 — فشل تحميل المكتبة/WebGL يظهر للمستخدم؛ الإدخال اليدوي/الموقع يبقى متاحاً بالأعلى
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  // مزامنة الدبوس مع القيمة + توسيط عند تغيّرها من الخارج (زر "استخدم موقعي")
  useEffect(() => {
    if (!ready) return;
    const lib = libRef.current;
    const map = mapRef.current;
    if (lib === null || map === null) return;

    if (value === null) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    const lngLat: [number, number] = [value.lng, value.lat]; // الفخ 6: (lng, lat)
    if (markerRef.current === null) {
      markerRef.current = new lib.Marker({ color: "#dc2626" }).setLngLat(lngLat).addTo(map);
    } else {
      markerRef.current.setLngLat(lngLat);
    }
    if (!selfSetRef.current) {
      map.easeTo({ center: lngLat, zoom: Math.max(map.getZoom(), PIN_ZOOM) });
    }
    selfSetRef.current = false;
  }, [ready, value]);

  if (loadFailed) {
    return (
      <div className="map-box">
        <div className="map-overlay error-text">
          تعذّر تحميل الخريطة — استخدم زر «استخدم موقعي» أو أدخل العنوان يدوياً بالأسفل
        </div>
      </div>
    );
  }

  return (
    <div className="map-box">
      {/* dir="ltr" داخلياً: أدوات MapLibre مصمّمة LTR؛ الإطار الخارجي يبقى RTL */}
      <div ref={containerRef} dir="ltr" className="map-canvas" />
      {!ready ? <div className="map-overlay skeleton">جارٍ تحميل الخريطة…</div> : null}
    </div>
  );
}
