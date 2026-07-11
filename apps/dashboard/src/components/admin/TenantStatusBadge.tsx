import type { TenantStatus } from "@quickdrop/shared";
import { TENANT_STATUS_BADGE, TENANT_STATUS_LABELS } from "@/lib/admin-format";

// §14 — شارة حالة المستأجر ملوّنة (مصدر واحد للّون/التسمية) — مشتركة بين القائمة والتفصيل.
export function TenantStatusBadge({ status }: { status: TenantStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TENANT_STATUS_BADGE[status]}`}>
      {TENANT_STATUS_LABELS[status]}
    </span>
  );
}
