import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  SettlementDayClosedError,
  SettlementDriverNotFoundError,
  closeDriverSettlement,
  getSettlementBoard,
  type DbHandle,
} from "@quickdrop/db";
import { tenantDay, type SettlementStatus } from "@quickdrop/shared";
import { z } from "zod";
import { DB, ENV } from "../app.module.js";
import { assertStaffToken, parseOr400, resolveActiveTenant, slugSchema, uuidSchema } from "../common/staff-http.js";
import type { ApiEnv } from "../env.js";

// §8.2 — REST شاشة التسوية اليومية (نمط orders نفسه: Bearer STAFF_API_TOKEN مؤقتاً،
// Zod على كل مدخل §11، وكل مال يعبر الـ JSON سلسلة نصية — D5).
// "اليوم" يُحسب بمنطقة المستأجر عبر tenantDay (الفخ 8) — لا new Date() تقويمي خام.

// D5 — المستلَم سلسلة أرقام عشرية ≥ 0؛ السالب/الكسري/الفارغ = 400 بالـ regex نفسه
const moneyStringSchema = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform((s) => BigInt(s));

// YYYY-MM-DD بمنطقة المستأجر — الشكل فقط هنا؛ القيمة الافتراضية tenantDay(اليوم)
const periodDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const boardQuerySchema = z.object({ tenantSlug: slugSchema });

const closeBodySchema = z.object({
  tenantSlug: slugSchema,
  driverId: uuidSchema,
  received: moneyStringSchema,
  periodDate: periodDateSchema.optional(),
});

// —— أشكال الاستجابة (كل مال string — D5) ——

export interface SettlementBoardRowView {
  driverId: string;
  name: string | null;
  expected: string; // §8.1: SUM(amount) للقيود غير المسوّاة
  entryCount: number;
  lastEntryAt: string;
}

export interface SettlementBoardResponse {
  periodDate: string; // اليوم بمنطقة المستأجر (tenantDay — الفخ 8)
  rows: SettlementBoardRowView[];
}

export interface CloseSettlementResponse {
  settlement: {
    id: string;
    driverId: string;
    periodDate: string;
    expected: string;
    received: string;
    diff: string; // §8.2: الفرق يظهر حسابياً ولا يُخفى
    status: SettlementStatus;
    closedAt: string | null;
  };
}

@Injectable()
export class SettlementsService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  // §8.2 — GET /api/settlements/board: صف لكل سائق عنده قيود غير مسوّاة
  // (استعلام واحد §16.10 داخل getSettlementBoard).
  async board(authorization: string | undefined, query: unknown): Promise<SettlementBoardResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const input = parseOr400(boardQuerySchema, query, "settlements_board");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);

    const rows = await getSettlementBoard(this.handle.db, tenant.id);
    return {
      periodDate: tenantDay(tenant.timezone, new Date()), // الفخ 8 — يوم المستأجر لا يوم الخادم
      rows: rows.map((r) => ({
        driverId: r.driverId,
        name: r.name,
        expected: String(r.expected), // D5: bigint→string عند الحافة
        entryCount: r.entryCount,
        lastEntryAt: r.lastEntryAt.toISOString(), // D6: ISO 8601
      })),
    };
  }

  // §8.2 — POST /api/settlements/close: إغلاق يوم سائق. الترانزاكشن والأقفال كلها
  // داخل closeDriverSettlement (packages/db) — هنا فقط الحدود والترجمة إلى HTTP.
  async close(authorization: string | undefined, body: unknown): Promise<CloseSettlementResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const input = parseOr400(closeBodySchema, body, "settlements_close");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);
    const periodDate = input.periodDate ?? tenantDay(tenant.timezone, new Date()); // الفخ 8

    try {
      const settlement = await closeDriverSettlement(this.handle.db, tenant.id, {
        driverId: input.driverId,
        periodDate,
        received: input.received,
        // أمان مؤقت: لا هوية موظف مع التوكن الثابت — staffId يُملأ مع staff auth §10.2
      });

      // §13: لوغ منظّم بحقول ثابتة — معرّفات فقط، لا مبالغ ولا PII
      console.log(
        JSON.stringify({
          action: "settlement_closed",
          tenant_id: tenant.id,
          driver_id: input.driverId,
          settlement_id: settlement.id,
          period_date: settlement.periodDate,
        }),
      );

      return {
        settlement: {
          id: settlement.id,
          driverId: settlement.driverId,
          periodDate: settlement.periodDate,
          expected: String(settlement.expected), // D5
          received: String(settlement.received),
          diff: String(settlement.diff),
          status: settlement.status,
          closedAt: settlement.closedAt?.toISOString() ?? null,
        },
      };
    } catch (error) {
      throw this.mapSettlementError(error);
    }
  }

  // §8.2 — اليوم مقفول لهذا السائق = تعارض حالة (409)؛ سائق غير موجود = 404.
  // الرسائل عامة (§11)؛ أي خطأ آخر يُعاد رميه كما هو — §16.12: لا ابتلاع.
  private mapSettlementError(error: unknown): unknown {
    if (error instanceof SettlementDayClosedError) {
      return new ConflictException("settlement day is already closed for this driver");
    }
    if (error instanceof SettlementDriverNotFoundError) {
      return new NotFoundException("not found");
    }
    return error;
  }
}
