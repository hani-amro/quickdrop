"use client";

import { useCallback, useState } from "react";
import { useToast } from "@/components/Toast";
import { adminApi } from "./admin-api";
import { describeError } from "./api";

// §14 — أفعال دورة حياة المستأجر (تعليق/تفعيل/تمديد تجربة) مشتركة بين قائمة المستأجرين
// وصفحة التفصيل: كل فعل → توست نتيجة (§10.1 لا فشل صامت) ثم refresh لحقيقة الخادم.
// التعليق قرار يدوي (§14)؛ التسوية النهائية والحالة تُكتب خادمياً.

export interface TenantActions {
  pendingId: string | null;
  suspend: (id: string, reason: string) => Promise<void>;
  activate: (id: string) => Promise<void>;
  extendTrial: (id: string) => Promise<void>;
}

export function useAdminTenantActions(refresh: () => void | Promise<void>): TenantActions {
  const toast = useToast();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const run = useCallback(
    async (id: string, fn: () => Promise<unknown>, successMsg: string): Promise<void> => {
      setPendingId(id);
      try {
        await fn();
        toast.success(successMsg);
        await refresh(); // بعد النجاح: حقيقة الخادم لا تفاؤل الواجهة
      } catch (error) {
        toast.error(describeError(error)); // §10.1: لا فشل صامت — توست عام
      } finally {
        setPendingId(null);
      }
    },
    [toast, refresh],
  );

  return {
    pendingId,
    suspend: (id, reason) => run(id, () => adminApi.setStatus(id, "suspended", reason), "تم تعليق المكتب"),
    activate: (id) => run(id, () => adminApi.setStatus(id, "active"), "تم تفعيل المكتب"),
    extendTrial: (id) => run(id, () => adminApi.extendTrial(id, 14), "تُمدّدت التجربة ١٤ يوماً"),
  };
}
