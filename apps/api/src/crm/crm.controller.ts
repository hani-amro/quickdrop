import { Controller, Get, Headers, Param, Query } from "@nestjs/common";
import { CrmService } from "./crm.service.js";

// دمج WaFlow (MERGE_PLAN §3.6) — REST قراءة CRM للداشبورد. التحقق/التخويل بالخدمة
// (نمط support/orders). محروس بـ SessionGuard العام (/api/*).
@Controller("api/crm")
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  @Get("conversations")
  async listConversations(
    @Headers("authorization") authorization: string | undefined,
    @Query() query: unknown,
  ): Promise<{ conversations: Record<string, unknown>[] }> {
    return this.crm.listConversations(authorization, query);
  }

  @Get("conversations/:id")
  async getConversation(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
    @Query() query: unknown,
  ): Promise<Record<string, unknown>> {
    return this.crm.getConversation(authorization, id, query);
  }

  @Get("customers/:userId")
  async getCustomer360(
    @Headers("authorization") authorization: string | undefined,
    @Param("userId") userId: string,
    @Query() query: unknown,
  ): Promise<Record<string, unknown>> {
    return this.crm.getCustomer360(authorization, userId, query);
  }
}
