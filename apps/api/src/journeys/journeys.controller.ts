import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { Roles } from "../auth/roles.decorator.js";
import { JourneysService } from "./journeys.service.js";

// دمج WaFlow (MERGE_PLAN §3.6) — REST إدارة الرحلات للداشبورد. التحقق/التخويل بالخدمة
// (نمط crm/support). محروس بـ SessionGuard العام (/api/*).
// §10.2/§11 — الرحلة قناة رسائل جماهيرية (خطوة send_message تُخرِج للزبائن آلياً)، فتُقيَّد
// كالبث بدور owner/dispatcher (RolesGuard) — لا يُنشئها/يفعّلها دور support/accountant.
@Controller("api/journeys")
@Roles("owner", "dispatcher")
export class JourneysController {
  constructor(private readonly journeys: JourneysService) {}

  @Get()
  async list(
    @Headers("authorization") authorization: string | undefined,
    @Query() query: unknown,
  ): Promise<{ journeys: Record<string, unknown>[] }> {
    return this.journeys.list(authorization, query);
  }

  @Get(":id")
  async get(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
    @Query() query: unknown,
  ): Promise<Record<string, unknown>> {
    return this.journeys.get(authorization, id, query);
  }

  // إنشاء مورد دائم جديد → 201 (افتراضي Nest للـ POST)
  @Post()
  async create(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.journeys.create(authorization, body);
  }

  @Patch(":id")
  @HttpCode(200)
  async update(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.journeys.update(authorization, id, body);
  }

  // الحذف يمرّر tenantSlug عبر الاستعلام (جسم DELETE قد يُجرَّد عبر الوسطاء)
  @Delete(":id")
  @HttpCode(200)
  async remove(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
    @Query() query: unknown,
  ): Promise<{ deleted: boolean }> {
    return this.journeys.remove(authorization, id, query);
  }
}
