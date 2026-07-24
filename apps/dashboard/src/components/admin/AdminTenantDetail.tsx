"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { ConnectionBadge } from "@/components/ConnectionBadge";
import { Modal } from "@/components/Modal";
import { useAdminTenantActions } from "@/lib/admin-actions";
import { adminApi } from "@/lib/admin-api";
import { TENANT_PLAN_LABELS, TENANT_STATUS_LABELS, trialDaysLeft } from "@/lib/admin-format";
import { agoLabel, formatMoney } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { usePolling } from "@/lib/use-polling";
import { AdminPaymentModal } from "./AdminPaymentModal";
import { TenantStatusBadge } from "./TenantStatusBadge";

// §10.2/§14 — تفصيل مستأجر: الصحة + سجل المدفوعات + سجل تحوّلات الحالة (إن توفّر)،
// وأفعال دورة الحياة نفسها (تعليق/تفعيل/تمديد/دفعة). كل النصوص متاحة فقط عند وجودها.
export function AdminTenantDetail({ id }: { id: string }) {
  const fetcher = useCallback(() => adminApi.getTenant(id), [id]);
  const { data, failed, lastUpdated, refresh } = usePolling(fetcher, 10000);
  const actions = useAdminTenantActions(refresh);
  const t = useT();

  const [suspending, setSuspending] = useState(false);
  const [suspendReason, setSuspendReason] = useState("");
  const [paying, setPaying] = useState(false);

  const tenant = data?.tenant ?? null;
  const payments = data?.payments ?? [];
  const statusLog = data?.statusLog ?? [];
  const label = tenant === null ? "" : tenant.nameAr.trim() !== "" ? tenant.nameAr : tenant.name;
  const busy = tenant !== null && actions.pendingId === tenant.id;
  const daysLeft = tenant?.status === "trial" ? trialDaysLeft(tenant.trialEndsAt) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Link href="/admin" className="text-sm text-slate-500 hover:text-orange-700">
            المستأجرون
          </Link>
          <span className="text-slate-300">/</span>
          <h1 className="text-lg font-bold text-slate-900">
            <bdi>{label !== "" ? label : "…"}</bdi>
          </h1>
          {tenant !== null && <TenantStatusBadge status={tenant.status} />}
        </div>
        <ConnectionBadge failed={failed} lastUpdated={lastUpdated} onRefresh={() => void refresh()} />
      </div>

      {tenant === null && !failed && <p className="text-sm text-slate-400">جارٍ التحميل…</p>}
      {tenant === null && failed && (
        <p className="text-sm text-red-600">تعذّر تحميل بيانات المكتب — جرّب التحديث.</p>
      )}

      {tenant !== null && (
        <>
          {/* ── الصحة والأفعال ── */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-slate-500">المعرّف</dt>
                <dd className="font-semibold text-slate-900">
                  <bdi dir="ltr">{tenant.slug}</bdi>
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">الباقة</dt>
                <dd className="font-semibold text-slate-900">{TENANT_PLAN_LABELS[tenant.plan]}</dd>
              </div>
              <div>
                <dt className="text-slate-500">الحالة</dt>
                <dd className="font-semibold text-slate-900">
                  {TENANT_STATUS_LABELS[tenant.status]}
                  {daysLeft !== null && (
                    <span className="ms-1 text-xs font-normal text-slate-500 tabular-nums">
                      ({daysLeft >= 0 ? `متبقٍ ${daysLeft} يوم` : `انتهت منذ ${-daysLeft} يوم`})
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">آخر طلب</dt>
                <dd className="font-semibold text-slate-900">{agoLabel(t, tenant.lastOrderAt)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">طلبات اليوم</dt>
                <dd className="font-semibold text-slate-900 tabular-nums">{tenant.ordersToday ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-500">السائقون</dt>
                <dd className="font-semibold text-slate-900 tabular-nums">{tenant.driverCount ?? "—"}</dd>
              </div>
              {tenant.timezone !== undefined && (
                <div>
                  <dt className="text-slate-500">المنطقة الزمنية</dt>
                  <dd className="font-semibold text-slate-900">
                    <bdi dir="ltr">{tenant.timezone}</bdi>
                  </dd>
                </div>
              )}
              {tenant.status === "suspended" &&
                tenant.suspendedReason !== undefined &&
                tenant.suspendedReason !== null && (
                  <div className="col-span-2 sm:col-span-3">
                    <dt className="text-slate-500">سبب التعليق</dt>
                    <dd className="font-semibold text-red-700">
                      <bdi>{tenant.suspendedReason}</bdi>
                    </dd>
                  </div>
                )}
            </dl>

            <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
              {tenant.status === "suspended" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void actions.activate(tenant.id)}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  تفعيل
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setSuspendReason("");
                    setSuspending(true);
                  }}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                >
                  تعليق
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void actions.extendTrial(tenant.id)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                تمديد تجربة +١٤
              </button>
              <button
                type="button"
                onClick={() => setPaying(true)}
                className="rounded-lg border border-orange-300 bg-orange-50 px-3 py-1.5 text-sm font-semibold text-orange-700 hover:bg-orange-100"
              >
                تسجيل دفعة
              </button>
            </div>
          </section>

          {/* ── سجل المدفوعات ── */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <h2 className="mb-3 text-base font-bold text-slate-900">سجل المدفوعات</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
                    <th className="p-2.5 text-start font-semibold">التاريخ</th>
                    <th className="p-2.5 text-start font-semibold">المبلغ</th>
                    <th className="p-2.5 text-start font-semibold">ملاحظة</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id} className="border-b border-slate-100 last:border-b-0">
                      <td className="p-2.5 text-slate-600">{agoLabel(t, p.createdAt)}</td>
                      <td className="p-2.5 font-semibold text-slate-900 tabular-nums">
                        {formatMoney(p.amount)}
                      </td>
                      <td className="p-2.5 text-slate-600">
                        <bdi>{p.note ?? "—"}</bdi>
                      </td>
                    </tr>
                  ))}
                  {payments.length === 0 && (
                    <tr>
                      <td colSpan={3} className="p-4 text-center text-slate-400">
                        لا مدفوعات مسجّلة بعد
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── سجل الحالات (إن توفّر من الـ API) ── */}
          {statusLog.length > 0 && (
            <section className="rounded-2xl border border-slate-200 bg-white p-5">
              <h2 className="mb-3 text-base font-bold text-slate-900">سجل الحالات</h2>
              <ul className="flex flex-col gap-2 text-sm">
                {statusLog.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-2 last:border-b-0">
                    <span className="text-slate-600">{agoLabel(t, s.at)}</span>
                    <span className="text-slate-400">—</span>
                    {s.from !== undefined && s.from !== null && (
                      <span className="text-slate-500">{TENANT_STATUS_LABELS[s.from]} ←</span>
                    )}
                    <span className="font-semibold text-slate-900">{TENANT_STATUS_LABELS[s.to]}</span>
                    {s.reason !== undefined && s.reason !== null && s.reason !== "" && (
                      <span className="text-slate-500">
                        (<bdi>{s.reason}</bdi>)
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {suspending && (
            <Modal title={`تعليق ${label}`} onClose={() => setSuspending(false)}>
              <div className="flex flex-col gap-3 text-sm">
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
                    onClick={() => setSuspending(false)}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-700 hover:bg-slate-50"
                  >
                    تراجع
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setSuspending(false);
                      void actions.suspend(tenant.id, suspendReason);
                    }}
                    className="rounded-lg bg-red-600 px-3 py-1.5 font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    تأكيد التعليق
                  </button>
                </div>
              </div>
            </Modal>
          )}

          {paying && (
            <AdminPaymentModal
              tenant={{ id: tenant.id, label }}
              onClose={() => setPaying(false)}
              onDone={refresh}
            />
          )}
        </>
      )}
    </div>
  );
}
