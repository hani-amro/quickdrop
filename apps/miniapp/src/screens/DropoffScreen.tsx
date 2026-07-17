import { Suspense, lazy, useState } from "react";
import type { ReactNode } from "react";
import type { Point } from "../lib/types";

// الخريطة (maplibre-gl + CSS) في chunk كسول: تُحمَّل فقط عند بلوغ شاشة التسليم.
const MapPicker = lazy(() => import("../components/MapPicker"));

export interface DropoffValue {
  point: Point | null;
  text: string;
}

export function DropoffScreen({
  value,
  onChange,
  onContinue,
}: {
  value: DropoffValue;
  onChange: (next: DropoffValue) => void;
  onContinue: () => void;
}): ReactNode {
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoError, setGeoError] = useState("");

  const useMyLocation = (): void => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setGeoError("خدمة الموقع غير مدعومة على هذا الجهاز — حدّد الموقع على الخريطة");
      return;
    }
    setGeoBusy(true);
    setGeoError("");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoBusy(false);
        onChange({ point: { lat: pos.coords.latitude, lng: pos.coords.longitude }, text: value.text });
      },
      () => {
        setGeoBusy(false);
        setGeoError("تعذّر الحصول على موقعك — فعّل صلاحية الموقع أو حدّده على الخريطة");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  };

  const setPoint = (point: Point): void => onChange({ point, text: value.text });
  const setText = (text: string): void => onChange({ point: value.point, text });

  return (
    <>
      <div className="content">
        <div>
          <span className="label">موقع التسليم على الخريطة</span>
          <Suspense fallback={<div className="map-box"><div className="map-overlay skeleton">جارٍ تحميل الخريطة…</div></div>}>
            <MapPicker value={value.point} onPick={setPoint} />
          </Suspense>
          <p className="map-hint">اضغط على الخريطة لتحديد نقطة التسليم</p>
        </div>

        <button type="button" className="btn btn-secondary" onClick={useMyLocation} disabled={geoBusy}>
          {geoBusy ? "جارٍ تحديد موقعك…" : "📍 استخدم موقعي"}
        </button>
        {geoError.length > 0 ? <p className="error-text muted">{geoError}</p> : null}

        {value.point !== null ? (
          <p className="muted" dir="ltr" style={{ textAlign: "end" }}>
            الإحداثيات: {value.point.lat.toFixed(5)}, {value.point.lng.toFixed(5)}
          </p>
        ) : null}

        <div>
          <label className="label" htmlFor="addr">
            وصف العنوان (اختياري)
          </label>
          <input
            id="addr"
            className="field"
            type="text"
            placeholder="مثال: بناء رقم 5، الطابق الثاني، قرب الصيدلية"
            value={value.text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
      </div>

      <div className="cta">
        <button type="button" className="btn" disabled={value.point === null} onClick={onContinue}>
          {value.point === null ? "حدّد موقع التسليم أولاً" : "متابعة للتأكيد"}
        </button>
      </div>
    </>
  );
}
