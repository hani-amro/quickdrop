"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { DRIVER_STATUS_LABELS, agoLabel } from "@/lib/format";
import type { DriverRow, OrderRow } from "@/lib/types";
import { Modal } from "./Modal";

// §10.1 — الإسناد اليدوي: قائمة السائقين من GET /api/drivers مع سعتهم (D14)،
// المتاح فقط قابل للنقر. القرار النهائي عند الخادم بأقفال الصفوف (D16) —
// هذا الترشيح بصري فقط وقد يرفضه الخادم (سباق) فيتراجع الفعل المتفائل.
export function AssignDriverModal({
  order,
  onAssign,
  onClose,
}: {
  order: OrderRow;
  onAssign: (driver: DriverRow) => void;
  onClose: () => void;
}) {
  const [drivers, setDrivers] = useState<DriverRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .listDrivers()
      .then((res) => {
        if (alive) setDrivers(res.drivers);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Modal title={`إسناد الطلب ${order.publicCode}`} onClose={onClose}>
      {failed && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">تعذر جلب قائمة السائقين — أغلق وأعد المحاولة</p>}
      {!failed && drivers === null && <p className="p-3 text-sm text-slate-500">جارٍ جلب السائقين…</p>}
      {drivers !== null && drivers.length === 0 && (
        <p className="p-3 text-sm text-slate-500">لا سائقين مسجّلين بعد</p>
      )}
      {drivers !== null && drivers.length > 0 && (
        <ul className="flex flex-col gap-2">
          {drivers.map((driver) => {
            const capacityKnown = driver.activeOrders !== undefined && driver.maxConcurrentOrders !== undefined;
            // D14 — المتاح: متصل + طلباته النشطة دون سقفه (سعة مجهولة = نعتمد الحالة فقط)
            const available =
              driver.status === "online" &&
              (driver.activeOrders === undefined ||
                driver.maxConcurrentOrders === undefined ||
                driver.activeOrders < driver.maxConcurrentOrders);
            return (
              <li key={driver.id}>
                <button
                  type="button"
                  disabled={!available}
                  onClick={() => onAssign(driver)}
                  className={`flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-start text-sm ${
                    available
                      ? "border-sky-200 bg-sky-50/50 hover:border-sky-400 hover:bg-sky-50"
                      : "cursor-not-allowed border-slate-200 bg-slate-50 opacity-50"
                  }`}
                >
                  <span className="font-semibold text-slate-900">
                    <bdi>{driver.name}</bdi>
                  </span>
                  <span className="flex items-center gap-3 text-xs text-slate-600">
                    <span className={driver.status === "online" ? "text-emerald-700" : "text-slate-500"}>
                      {DRIVER_STATUS_LABELS[driver.status]}
                    </span>
                    <span>
                      نشِطة{" "}
                      {capacityKnown ? `${driver.activeOrders}/${driver.maxConcurrentOrders}` : "؟/؟"}
                    </span>
                    <span>آخر موقع {agoLabel(driver.lastPointAt)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
