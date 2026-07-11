import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  TenantNotFoundError,
  extendTrial,
  listTenantsHealth,
  recordTenantPayment,
  setTenantStatus,
  type DbHandle,
} from "@quickdrop/db";
import { TENANT_STATUSES, type TenantPlan, type TenantStatus } from "@quickdrop/shared";
import { z } from "zod";
import { DB, ENV } from "../app.module.js";
import { assertAdminToken } from "../common/admin-http.js";
import { parseOr400, uuidSchema } from "../common/staff-http.js";
import type { ApiEnv } from "../env.js";

// §14/§10.2 — كونسول المشرف (منصة). مصادقة منفصلة تماماً (Bearer ADMIN_API_TOKEN)،
// والتحقق (Zod §11) بالخدمة — نفس انضباط مسارات الـ staff لكن بتوكن وهوية مستقلين.
// الفاعل (actorAdminId) ثابت من env ADMIN_ID مؤقتاً — دخول admin_users الكامل §10.2 لاحقاً.

// §5 — إلغاء بسبب مسمّى / إيقاف بسبب: نص حر قصير (يُخزَّن، لا يظهر باللوغ — §13)
const setStatusBodySchema = z.object({
  status: z.enum(TENANT_STATUSES),
  reason: z.string().trim().min(2).max(500).optional(),
});

const extendTrialBodySchema = z.object({
  days: z.number().int().positive().max(365), // سقف منطقي لتمديد واحد
});

// D5 — المال بالـ JSON سلسلة أرقام عشرية (bigint↔string عند الحافة)؛ الدفعة > 0
const moneyStringSchema = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform((s) => BigInt(s))
  .refine((v) => v > 0n, { message: "amount must be a positive integer" });

const recordPaymentBodySchema = z.object({
  amount: moneyStringSchema,
  periodNote: z.string().trim().min(1).max(200).optional(),
});

// —— أشكال الاستجابة (كل مال string — D5؛ كل وقت ISO 8601 — D6) ——

export interface TenantHealthView {
  id: string;
  slug: string;
  name: string;
  plan: TenantPlan;
  status: TenantStatus;
  trialEndsAt: string | null;
  driverCount: number;
  ordersToday: number;
  lastOrderAt: string | null;
}

export interface ListTenantsResponse {
  tenants: TenantHealthView[];
}

export interface TenantStatusResponse {
  tenant: { id: string; status: TenantStatus; suspendedReason: string | null };
}

export interface ExtendTrialResponse {
  tenant: { id: string; trialEndsAt: string | null };
}

export interface RecordPaymentResponse {
  payment: { id: string; amount: string; currency: string; periodNote: string | null; createdAt: string };
}

@Injectable()
export class AdminService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  // §14 — GET /api/admin/tenants: صحّة كل المستأجرين (نبض النشاط + الباقة/الحالة + السائقون).
  async listTenants(authorization: string | undefined): Promise<ListTenantsResponse> {
    this.assertAdminToken(authorization);
    const rows = await listTenantsHealth(this.handle.db);
    return {
      tenants: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        plan: r.plan,
        status: r.status,
        trialEndsAt: r.trialEndsAt?.toISOString() ?? null,
        driverCount: r.driverCount,
        ordersToday: r.ordersToday,
        lastOrderAt: r.lastOrderAt?.toISOString() ?? null,
      })),
    };
  }

  // §14 — POST /api/admin/tenants/:id/status: تغيير حالة المستأجر (يشمل suspended/churned).
  async setStatus(authorization: string | undefined, id: string, body: unknown): Promise<TenantStatusResponse> {
    this.assertAdminToken(authorization);
    const tenantId = parseOr400(uuidSchema, id, "admin_set_status_id");
    const input = parseOr400(setStatusBodySchema, body, "admin_set_status");
    try {
      const tenant = await setTenantStatus(this.handle.db, tenantId, input.status, {
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(this.env.ADMIN_ID !== undefined ? { byAdminId: this.env.ADMIN_ID } : {}),
      });
      return { tenant: { id: tenant.id, status: tenant.status, suspendedReason: tenant.suspendedReason } };
    } catch (error) {
      throw this.mapTenantError(error);
    }
  }

  // §14 — POST /api/admin/tenants/:id/extend-trial: تمديد الفترة التجريبية.
  async extendTrial(authorization: string | undefined, id: string, body: unknown): Promise<ExtendTrialResponse> {
    this.assertAdminToken(authorization);
    const tenantId = parseOr400(uuidSchema, id, "admin_extend_trial_id");
    const input = parseOr400(extendTrialBodySchema, body, "admin_extend_trial");
    try {
      const tenant = await extendTrial(this.handle.db, tenantId, input.days, this.env.ADMIN_ID);
      return { tenant: { id: tenant.id, trialEndsAt: tenant.trialEndsAt?.toISOString() ?? null } };
    } catch (error) {
      throw this.mapTenantError(error);
    }
  }

  // §14 — POST /api/admin/tenants/:id/payments: تسجيل تحصيل يدوي (جدول منصة — استثناء RLS).
  async recordPayment(authorization: string | undefined, id: string, body: unknown): Promise<RecordPaymentResponse> {
    this.assertAdminToken(authorization);
    const tenantId = parseOr400(uuidSchema, id, "admin_record_payment_id");
    const input = parseOr400(recordPaymentBodySchema, body, "admin_record_payment");
    try {
      const payment = await recordTenantPayment(this.handle.db, tenantId, {
        amount: input.amount,
        ...(input.periodNote !== undefined ? { periodNote: input.periodNote } : {}),
        // من استلم الدفعة: هوية المشرف الثابتة مؤقتاً (§10.2 لاحقاً)
        ...(this.env.ADMIN_ID !== undefined ? { receivedBy: this.env.ADMIN_ID } : {}),
      });
      return {
        payment: {
          id: payment.id,
          amount: String(payment.amount), // D5: bigint→string عند الحافة
          currency: payment.currency,
          periodNote: payment.periodNote,
          createdAt: payment.createdAt.toISOString(),
        },
      };
    } catch (error) {
      throw this.mapTenantError(error);
    }
  }

  private assertAdminToken(authorization: string | undefined): void {
    assertAdminToken(this.env.ADMIN_API_TOKEN, authorization);
  }

  // معرّف المستأجر من المستخدم: غير موجود = 404 حالة عمل، لا باغ. غيره يُعاد رميه — §16.12: لا ابتلاع.
  private mapTenantError(error: unknown): unknown {
    if (error instanceof TenantNotFoundError) {
      return new NotFoundException("not found");
    }
    return error;
  }
}
