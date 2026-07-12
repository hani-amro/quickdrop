"use client";

import { timeLabel } from "@/lib/format";

// §10.1 — مؤشر اتصال صريح: الموزّع لازم يعرف فوراً إذا اللي قدامه قديم.
// أحمر: فشل الجلب نفسه (البيانات قديمة) + زر تحديث.
// أصفر: الجلب يعمل لكن قناة WS اللحظية منقطعة — polling كل 3 ثوانٍ فقط.
// أخضر: wsAlive=true → "حيّ" (WS + polling)؛ wsAlive غير ممرَّر (شاشات polling
// بطبيعتها كالتسويات/التحليلات) → "محدَّث HH:MM:SS" كما كان.
export function ConnectionBadge({
  failed,
  lastUpdated,
  onRefresh,
  wsAlive,
}: {
  failed: boolean;
  lastUpdated: Date | null;
  onRefresh: () => void;
  /** اختياري: حالة قناة WS من useRealtime — يُمرَّر بالشاشات اللحظية فقط. */
  wsAlive?: boolean;
}) {
  if (failed) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-red-300 bg-red-50 px-3 py-1 text-sm text-red-700">
        <span className="size-2.5 rounded-full bg-red-500" aria-hidden="true" />
        <span>انقطع الاتصال — البيانات قد تكون قديمة</span>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-md bg-red-600 px-2 py-0.5 text-xs font-semibold text-white hover:bg-red-700"
        >
          تحديث
        </button>
      </div>
    );
  }
  if (wsAlive === false) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-sm text-amber-800">
        <span className="size-2.5 rounded-full bg-amber-500" aria-hidden="true" />
        <span>
          إعادة اتصال لحظي… تحديث دوري {lastUpdated !== null ? <bdi>{timeLabel(lastUpdated)}</bdi> : "…"}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-sm text-emerald-700">
      <span className="size-2.5 rounded-full bg-emerald-500" aria-hidden="true" />
      <span>
        {wsAlive === true ? "حيّ — " : "محدَّث "}
        {lastUpdated !== null ? <bdi>{timeLabel(lastUpdated)}</bdi> : "…"}
      </span>
    </div>
  );
}
