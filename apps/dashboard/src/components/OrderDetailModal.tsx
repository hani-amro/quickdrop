"use client";

import { useEffect, useState } from "react";
import { api, describeError } from "@/lib/api";
import { serviceLabel, statusLabel, agoLabel, formatMoney } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { OrderDetail, OrderRow } from "@/lib/types";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

// §10.1 — لوحة تفاصيل الطلب الجانبية: تُجلب من GET /api/orders/:id عند الفتح.
// §3 v1 — لطلبات food غير المؤكّدة (merchant موجود + merchantConfirmedAt=null): زر
// "المطعم أكّد ✅" + رقم التاجر للاتصال. الفعل متفائل (§10.1): نعلّم التأكيد فوراً ←
// نداء ← نجاح: توست + تحديث اللوحة؛ فشل: تراجع صريح (عودة null) + توست بالسبب.
export function OrderDetailModal({
  order,
  onClose,
  onConfirmed,
}: {
  order: OrderRow;
  onClose: () => void;
  /** تحديث اللوحة بعد تأكيد التاجر (لا أثر بصري باللوحة الآن — اتساق مستقبلي). */
  onConfirmed: () => void;
}) {
  const toast = useToast();
  const t = useT();
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .orderDetail(order.id)
      .then((res) => {
        if (alive) setDetail(res.order);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [order.id]);

  // §3 v1 — التأكيد المتفائل: عمود عادي (لا حالة D8)؛ يُملأ مرة واحدة (الخادم IS NULL شرط)
  async function confirmMerchant(): Promise<void> {
    if (detail === null) return;
    const restore = detail;
    setBusy(true);
    setDetail({ ...detail, merchantConfirmedAt: new Date().toISOString() }); // تفاؤل
    try {
      await api.merchantConfirm(order.id);
      toast.success(t("orderDetail.merchantConfirmSuccess", { code: order.publicCode }));
      onConfirmed();
    } catch (error) {
      setDetail(restore); // §10.1 — تراجع صريح: عودة merchantConfirmedAt إلى null
      toast.error(t("orderDetail.merchantConfirmError", { error: describeError(error) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t("orderDetail.title", { code: order.publicCode })} onClose={onClose}>
      {failed && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {t("orderDetail.fetchFailed")}
        </p>
      )}
      {!failed && detail === null && <p className="p-3 text-sm text-slate-500">{t("orderDetail.loading")}</p>}

      {detail !== null && (
        <div className="flex flex-col gap-3 text-sm">
          {/* الخدمة + الحالة */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
              {serviceLabel(t, detail.service)}
            </span>
            <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-800">
              {statusLabel(t, detail.status)}
            </span>
            <span className="ms-auto font-semibold text-slate-800">
              <bdi>{formatMoney(detail.price.total)}</bdi>
            </span>
          </div>

          {/* §3 v1 — قسم التاجر: اسمه ورقمه + زر التأكيد (لطلبات food فقط) */}
          {detail.service === "food" && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs text-slate-500">{t("orderDetail.merchant")}</p>
                  <p className="font-semibold text-slate-900">
                    <bdi>{detail.merchant?.name ?? t("orderDetail.unspecified")}</bdi>
                  </p>
                </div>
                {detail.merchant?.phone != null && detail.merchant.phone !== "" && (
                  <a
                    href={`tel:${detail.merchant.phone}`}
                    className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                  >
                    {t("orderDetail.callMerchant")} <bdi dir="ltr">{detail.merchant.phone}</bdi>
                  </a>
                )}
              </div>

              {detail.merchantConfirmedAt === null ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void confirmMerchant()}
                  className="mt-3 w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? t("orderDetail.saving") : t("orderDetail.confirmMerchant")}
                </button>
              ) : (
                <p className="mt-3 rounded-lg bg-emerald-100 px-3 py-2 text-center text-sm font-semibold text-emerald-800">
                  {t("orderDetail.merchantConfirmed")} {agoLabel(t, detail.merchantConfirmedAt)}
                </p>
              )}
            </div>
          )}

          {/* الزبون + المستلم (إن اختلف) */}
          <DetailRow label={t("orderDetail.customer")}>
            <bdi>{detail.customer.name ?? "—"}</bdi>
            {detail.customer.phone != null && detail.customer.phone !== "" && (
              <>
                {" — "}
                <a href={`tel:${detail.customer.phone}`} className="text-sky-700 hover:underline">
                  <bdi dir="ltr">{detail.customer.phone}</bdi>
                </a>
              </>
            )}
          </DetailRow>
          {detail.recipientPhone != null && detail.recipientPhone !== "" && (
            <DetailRow label={t("orderDetail.recipient")}>
              <a href={`tel:${detail.recipientPhone}`} className="text-sky-700 hover:underline">
                <bdi dir="ltr">{detail.recipientPhone}</bdi>
              </a>
            </DetailRow>
          )}
          {detail.driver !== null && (
            <DetailRow label={t("orderDetail.driver")}>
              <bdi>{detail.driver.name ?? "—"}</bdi>
            </DetailRow>
          )}
          {detail.pickupText != null && detail.pickupText !== "" && (
            <DetailRow label={t("orderDetail.pickup")}>
              <bdi>{detail.pickupText}</bdi>
            </DetailRow>
          )}
          {detail.dropoffText != null && detail.dropoffText !== "" && (
            <DetailRow label={t("orderDetail.dropoff")}>
              <bdi>{detail.dropoffText}</bdi>
            </DetailRow>
          )}
          {detail.notes != null && detail.notes !== "" && (
            <DetailRow label={t("orderDetail.notes")}>
              <bdi>{detail.notes}</bdi>
            </DetailRow>
          )}
          <DetailRow label={t("orderDetail.createdAt")}>{agoLabel(t, detail.createdAt)}</DetailRow>
        </div>
      )}
    </Modal>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 border-b border-slate-100 pb-2 last:border-b-0">
      <span className="min-w-16 text-slate-500">{label}</span>
      <span className="font-medium text-slate-800">{children}</span>
    </div>
  );
}
