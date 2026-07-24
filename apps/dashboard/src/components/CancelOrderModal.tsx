"use client";

import { useState } from "react";
import type { OrderRow } from "@/lib/types";
import { useT } from "@/lib/i18n";
import { Modal } from "./Modal";

// الفخ 23 — لا حذف من السجل: الإلغاء بسبب مسمّى دائماً، والانتقال خادمياً عبر
// transition() إلى cancelled_by_office (D8).
export function CancelOrderModal({
  order,
  onCancel,
  onClose,
}: {
  order: OrderRow;
  onCancel: (reason: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  const valid = trimmed.length >= 2 && trimmed.length <= 500;

  return (
    <Modal title={t("cancelOrder.title", { code: order.publicCode })} onClose={onClose}>
      <label className="block text-sm text-slate-700">
        {t("cancelOrder.reasonLabel")} <span className="text-red-600">*</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={500}
          autoFocus
          placeholder={t("cancelOrder.reasonPlaceholder")}
          className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm focus:border-sky-500 focus:outline-none"
        />
      </label>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
        >
          {t("cancelOrder.back")}
        </button>
        <button
          type="button"
          disabled={!valid}
          onClick={() => onCancel(trimmed)}
          className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("cancelOrder.confirm")}
        </button>
      </div>
    </Modal>
  );
}
