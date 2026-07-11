"use client";

import Link from "next/link";
import { useState } from "react";
import { ConnectionBadge } from "@/components/ConnectionBadge";
import { Modal } from "@/components/Modal";
import { useAdminTenantActions } from "@/lib/admin-actions";
import { adminApi } from "@/lib/admin-api";
import { TENANT_PLAN_LABELS, trialDaysLeft } from "@/lib/admin-format";
import type { AdminTenantRow } from "@/lib/admin-types";
import { agoLabel } from "@/lib/format";
import { usePolling } from "@/lib/use-polling";
import { AdminPaymentModal } from "./AdminPaymentModal";
import { TenantStatusBadge } from "./TenantStatusBadge";

// §10.2/§14 — قائمة المستأجرين: صحة (آخر طلب، طلبات اليوم، عدد السائقين) + أفعال دورة
// الحياة (تعليق/تفعيل، تمديد تجربة، تسجيل دفعة). refetch بعد كل فعل (حقيقة الخادم).
export function AdminTenantsTable() {
  const { data, failed, lastUpdated, refresh } = usePolling(adminApi.listTenants, 10000);
  const actions = useAdminTenantActions(refresh);

  // تعليق مكتب فعل مؤثّر (البوت يدخل وضع اعتذار §14) — تأكيد صريح بسبب اختياري
  const [suspending, setSuspending] = useState<AdminTenantRow | null>(null);
  const [suspendReason, setSuspendReason] = useState("");
  const [paying, setPaying] = useState<AdminTenantRow | null>(null);

  const tenants = data?.tenants ?? [];

  function labelOf(t: AdminTenantRow): string {
    return t.nameAr.trim() !== "" ? t.nameAr : t.name;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold text-slate-900">المستأجرون</h1>
        <div className="flex items-center gap-2">
          <ConnectionBadge failed={failed} lastUpdated={lastUpdated} onRefresh={() => void refresh()} />
          <Link
            href="/admin/onboarding"
            className="rounded-lg bg-orange-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-orange-700"
          >
            + إضافة مستأجر
          </Link>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="w-full min-w-[64rem] text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <th className="p-3 text-start font-semibold">المكتب</th>
              <th className="p-3 text-start font-semibold">الباقة</th>
              <th className="p-3 text-start font-semibold">الحالة</th>
              <th className="p-3 text-start font-semibold">آخر طلب</th>
              <th className="p-3 text-start font-semibold">طلبات اليوم</th>
              <th className="p-3 text-start font-semibold">السائقون</th>
              <th className="p-3 text-start font-semibold">إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((t) => {
              const busy = actions.pendingId === t.id;
              const daysLeft = t.status === "trial" ? trialDaysLeft(t.trialEndsAt) : null;
              return (
                <tr key={t.id} className="border-b border-slate-100 last:border-b-0 align-top">
                  <td className="p-3">
                    <Link href={`/admin/tenants/${t.id}`} className="font-semibold text-slate-900 hover:text-orange-700">
                      <bdi>{labelOf(t)}</bdi>
                    </Link>
                    <div className="text-xs text-slate-400">
                      <bdi dir="ltr">{t.slug}</bdi>
                    </div>
                  </td>
                  <td className="p-3 text-slate-700">{TENANT_PLAN_LABELS[t.plan]}</td>
                  <td className="p-3">
                    <TenantStatusBadge status={t.status} />
                    {daysLeft !== null && (
                      <div className="mt-1 text-xs text-slate-500 tabular-nums">
                        {daysLeft >= 0 ? `متبقٍ ${daysLeft} يوم` : `انتهت منذ ${-daysLeft} يوم`}
                      </div>
                    )}
                  </td>
                  <td className="p-3 text-slate-600">{agoLabel(t.lastOrderAt)}</td>
                  <td className="p-3 tabular-nums text-slate-700">{t.ordersToday ?? "—"}</td>
                  <td className="p-3 tabular-nums text-slate-700">{t.driverCount ?? "—"}</td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-1.5">
                      {t.status === "suspended" ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void actions.activate(t.id)}
                          className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          تفعيل
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setSuspendReason("");
                            setSuspending(t);
                          }}
                          className="rounded-lg bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          تعليق
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void actions.extendTrial(t.id)}
                        className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        تمديد تجربة +١٤
                      </button>
                      <button
                        type="button"
                        onClick={() => setPaying(t)}
                        className="rounded-lg border border-orange-300 bg-orange-50 px-2.5 py-1 text-xs font-semibold text-orange-700 hover:bg-orange-100"
                      >
                        تسجيل دفعة
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {data !== null && tenants.length === 0 && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-slate-400">
                  لا مستأجرين بعد — ابدأ بـ «إضافة مستأجر»
                </td>
              </tr>
            )}
            {data === null && !failed && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-slate-400">
                  جارٍ التحميل…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {suspending !== null && (
        <Modal title={`تعليق ${labelOf(suspending)}`} onClose={() => setSuspending(null)}>
          <div className="flex flex-col gap-3 text-sm">
            {/* §14 — التعليق: البوت يرد باعتذار مهذّب والبيانات محفوظة 90 يوماً */}
            <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
              بعد التعليق يرد بوت المكتب برسالة اعتذار مهذّبة وتتوقف الطلبات الجديدة — البيانات
              محفوظة. القرار يدوي وقابل للتراجع بالتفعيل.
            </p>
            <label className="flex flex-col gap-1">
              <span className="text-slate-600">السبب (اختياري)</span>
              <input
                type="text"
                value={suspendReason}
                onChange={(e) => setSuspendReason(e.target.value)}
                placeholder="تأخّر الدفع…"
                maxLength={200}
                className="w-full rounded-lg border border-slate-300 p-2 focus:border-orange-500 focus:outline-none"
              />
            </label>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setSuspending(null)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-700 hover:bg-slate-50"
              >
                تراجع
              </button>
              <button
                type="button"
                disabled={actions.pendingId === suspending.id}
                onClick={() => {
                  const target = suspending;
                  setSuspending(null);
                  void actions.suspend(target.id, suspendReason);
                }}
                className="rounded-lg bg-red-600 px-3 py-1.5 font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                تأكيد التعليق
              </button>
            </div>
          </div>
        </Modal>
      )}

      {paying !== null && (
        <AdminPaymentModal
          tenant={{ id: paying.id, label: labelOf(paying) }}
          onClose={() => setPaying(null)}
          onDone={refresh}
        />
      )}
    </div>
  );
}
