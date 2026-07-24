"use client";

import { useState } from "react";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import { adminApi } from "@/lib/admin-api";
import { sanitizeMoneyInput } from "@/lib/admin-format";
import { describeError } from "@/lib/api";
import { formatMoney } from "@/lib/format";

// §14 — تسجيل دفعة يدوية من مستأجر (سوق كاش): مبلغ عدد صحيح (D5) + ملاحظة اختيارية.
// التحصيل يدوي والتعليق قرار منفصل — تسجيل الدفعة لا يغيّر الحالة تلقائياً.
export function AdminPaymentModal({
  tenant,
  onClose,
  onDone,
}: {
  tenant: { id: string; label: string };
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (amount === "" || BigInt(amount) <= 0n) {
      toast.error("أدخل مبلغاً صحيحاً أكبر من صفر");
      return;
    }
    setBusy(true);
    try {
      await adminApi.registerPayment(tenant.id, amount, note);
      // §16.12 — النتيجة تُقال بصوت عالٍ حتى بلحظة النجاح
      toast.success(`سُجّلت دفعة ${formatMoney(amount)}`);
      await onDone();
      onClose();
    } catch (error) {
      toast.error(describeError(error)); // §10.1: لا فشل صامت
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`تسجيل دفعة — ${tenant.label}`} onClose={onClose}>
      <div className="flex flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-slate-600">المبلغ</span>
          <input
            type="text"
            inputMode="numeric"
            dir="ltr"
            autoFocus
            value={amount}
            onChange={(e) => setAmount(sanitizeMoneyInput(e.target.value))}
            placeholder="0"
            className="w-full rounded-lg border border-slate-300 p-2 text-end tabular-nums focus:border-orange-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-slate-600">ملاحظة (اختياري)</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="رقم الوصل / طريقة الدفع…"
            maxLength={200}
            className="w-full rounded-lg border border-slate-300 p-2 focus:border-orange-500 focus:outline-none"
          />
        </label>
        {/* §14 — التسجيل محاسبي فقط؛ التعليق/التفعيل قرار يدوي منفصل بزر */}
        <p className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600">
          تسجيل الدفعة لا يغيّر حالة المكتب تلقائياً — التفعيل قرار منفصل بزر.
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-700 hover:bg-slate-50"
          >
            تراجع
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="rounded-lg bg-orange-600 px-3 py-1.5 font-semibold text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "جارٍ التسجيل…" : "تسجيل الدفعة"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
