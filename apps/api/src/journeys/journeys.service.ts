import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  createJourney,
  createJourneySchema,
  deleteJourney,
  getJourney,
  listJourneys,
  updateJourney,
  updateJourneySchema,
  withTenant,
  type DbHandle,
  type Journey,
} from "@quickdrop/db";
import { z } from "zod";
import { assertStaffToken, parseOr400, resolveActiveTenant, slugSchema, uuidSchema } from "../common/staff-http.js";
import type { ApiEnv } from "../env.js";
import { DB, ENV } from "../tokens.js";

// دمج WaFlow (MERGE_PLAN §3.6/P2 step 10) — REST إدارة الرحلات للداشبورد:
//   GET    /api/journeys           : قائمة رحلات المستأجر (عدّادات enrolled/completed)
//   POST   /api/journeys           : إنشاء (name, trigger∈JOURNEY_TRIGGERS, steps, audience?)
//   GET    /api/journeys/:id        : تفاصيل رحلة
//   PATCH  /api/journeys/:id        : تحديث جزئي (المُطلِّق غير قابل للتغيير)
//   DELETE /api/journeys/:id        : حذف (يلغي التسجيلات الجارية ويحذف صفوفها)
// نفس التخويل (Bearer STAFF_API_TOKEN / جلسة عبر الحارس §10.2) وانضباط Zod (§11) وحلّ
// المستأجر بالـ slug — نمط crm/support حرفياً. كل الكتابات داخل withTenant (RLS §2.3).

const slugQuerySchema = z.object({ tenantSlug: slugSchema });
const createBodySchema = z.object({ tenantSlug: slugSchema, journey: createJourneySchema });
const updateBodySchema = z.object({ tenantSlug: slugSchema, patch: updateJourneySchema });

function serializeJourney(j: Journey): Record<string, unknown> {
  return {
    id: j.id,
    name: j.name,
    description: j.description,
    trigger: j.trigger,
    audienceFilter: j.audienceFilter,
    steps: j.steps,
    isActive: j.isActive,
    enrolledCount: j.enrolledCount,
    completedCount: j.completedCount,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
  };
}

@Injectable()
export class JourneysService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  async list(authorization: string | undefined, query: unknown): Promise<{ journeys: Record<string, unknown>[] }> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const input = parseOr400(slugQuerySchema, query, "journeys_list");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);
    const items = await withTenant(this.handle.db, tenant.id, (tx) => listJourneys(tx, tenant.id));
    return { journeys: items.map(serializeJourney) };
  }

  async get(authorization: string | undefined, id: string, query: unknown): Promise<Record<string, unknown>> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const journeyId = parseOr400(uuidSchema, id, "journeys_get_id");
    const input = parseOr400(slugQuerySchema, query, "journeys_get");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);
    const j = await withTenant(this.handle.db, tenant.id, (tx) => getJourney(tx, tenant.id, journeyId));
    if (!j) throw new NotFoundException("journey not found");
    return { journey: serializeJourney(j) };
  }

  async create(authorization: string | undefined, body: unknown): Promise<Record<string, unknown>> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const input = parseOr400(createBodySchema, body, "journeys_create");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);
    const created = await withTenant(this.handle.db, tenant.id, (tx) => createJourney(tx, tenant.id, input.journey));
    return { journey: serializeJourney(created) };
  }

  async update(authorization: string | undefined, id: string, body: unknown): Promise<Record<string, unknown>> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const journeyId = parseOr400(uuidSchema, id, "journeys_update_id");
    const input = parseOr400(updateBodySchema, body, "journeys_update");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);
    const updated = await withTenant(this.handle.db, tenant.id, (tx) => updateJourney(tx, tenant.id, journeyId, input.patch));
    if (!updated) throw new NotFoundException("journey not found");
    return { journey: serializeJourney(updated) };
  }

  async remove(authorization: string | undefined, id: string, body: unknown): Promise<{ deleted: boolean }> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const journeyId = parseOr400(uuidSchema, id, "journeys_delete_id");
    const input = parseOr400(slugQuerySchema, body, "journeys_delete");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);
    const deleted = await withTenant(this.handle.db, tenant.id, (tx) => deleteJourney(tx, tenant.id, journeyId));
    if (!deleted) throw new NotFoundException("journey not found");
    return { deleted: true };
  }
}
