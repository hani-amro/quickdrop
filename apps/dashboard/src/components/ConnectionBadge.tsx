"use client";

import { timeLabel } from "@/lib/format";

// §10.1 — مؤشر اتصال صريح: أخضر "محدَّث HH:MM:SS"، أحمر مع زر تحديث عند فشل
// الجلب — الموزّع لازم يعرف فوراً إذا اللي قدامه قديم.
export function ConnectionBadge({
  failed,
  lastUpdated,
  onRefresh,
}: {
  failed: boolean;
  lastUpdated: Date | null;
  onRefresh: () => void;
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
  return (
    <div className="flex items-center gap-2 rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-sm text-emerald-700">
      <span className="size-2.5 rounded-full bg-emerald-500" aria-hidden="true" />
      <span>
        محدَّث {lastUpdated !== null ? <bdi>{timeLabel(lastUpdated)}</bdi> : "…"}
      </span>
    </div>
  );
}
