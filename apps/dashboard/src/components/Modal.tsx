"use client";

import { useEffect, type ReactNode } from "react";
import { useT } from "@/lib/i18n";

// غلاف modal بسيط بلا مكتبات: خلفية معتمة + Esc يغلق (§10.1 اختصارات) + نقر خارجي يغلق.
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-base font-bold text-slate-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("modal.close")}
            className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
