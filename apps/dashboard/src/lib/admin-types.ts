import type { TenantPlan, TenantStatus } from "@quickdrop/shared";

// ═══════════════════════════════════════════════════════════════════════════
// عقد /api/admin/* (مسارات platform بلا tenantSlug — §10.2) الذي يستهلكه كونسول
// المشرف. المسارات المتوقَّعة:
//
//   GET  /api/admin/tenants                       → AdminTenantsResponse
//   POST /api/admin/tenants                        {name,nameAr,slug,timezone} → CreateTenantResponse
//   GET  /api/admin/tenants/:id                    → AdminTenantDetailResponse
//   POST /api/admin/tenants/:id/status             {status:'active'|'suspended', reason?} → { tenant }
//   POST /api/admin/tenants/:id/extend-trial       {days:number} → { tenant }
//   POST /api/admin/tenants/:id/payments           {amount:string, note?} → { payment }
//
// D5 — كل مال يعبر الـ JSON سلسلة نصية. الحقول العددية/الزمنية اختيارية دفاعياً:
// العقد قيد التوسعة عند فريق الـ API، والواجهة تعرض "—" عند غيابها ولا تنكسر.
// ═══════════════════════════════════════════════════════════════════════════

export interface AdminTenantRow {
  id: string;
  slug: string;
  name: string;
  nameAr: string;
  plan: TenantPlan;
  status: TenantStatus;
  trialEndsAt?: string | null; // §14 — نهاية التجربة (14 يوماً) لعرض المتبقّي
  lastOrderAt?: string | null; // §14 صحة: آخر طلب (منذ متى)
  ordersToday?: number; // طلبات اليوم (يوم المستأجر tenantDay خادمياً — الفخ 8)
  driverCount?: number; // عدد السائقين (الباقة تُفرض على السعة §14)
  createdAt?: string;
}

export interface AdminTenantsResponse {
  tenants: AdminTenantRow[];
}

// §14 — سجل التحصيل اليدوي (tenant_payments): مبلغ سلسلة (D5) + ملاحظة اختيارية
export interface AdminPaymentRow {
  id: string;
  amount: string;
  note?: string | null;
  createdAt: string;
}

// §14 — سجل تحوّلات الحالة (إن توفّر audit_log/سجل حالات؛ الواجهة تعرض المتاح فقط)
export interface AdminStatusLogRow {
  id: string;
  from?: TenantStatus | null;
  to: TenantStatus;
  reason?: string | null;
  at: string;
}

export interface AdminTenantDetail extends AdminTenantRow {
  timezone?: string;
  suspendedReason?: string | null;
}

export interface AdminTenantDetailResponse {
  tenant: AdminTenantDetail;
  payments: AdminPaymentRow[];
  statusLog?: AdminStatusLogRow[];
}

// POST /api/admin/tenants — إنشاء مستأجر بلا بوت (الربط لاحقاً بسكربت tenant:provision §14)
export interface CreateTenantRequest {
  name: string;
  nameAr: string;
  slug: string;
  timezone: string;
}

export interface CreateTenantResponse {
  tenant: {
    id: string;
    slug: string;
    name: string;
    nameAr: string;
    status: TenantStatus;
    plan: TenantPlan;
  };
}
