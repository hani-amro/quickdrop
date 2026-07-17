import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import {
  MerchantsService,
  type CatalogItemResponse,
  type CreateMerchantResponse,
  type ListCatalogResponse,
  type ListMerchantsResponse,
} from "./merchants.service.js";

// §3 — REST إدارة التجار وكتالوجهم بالداشبورد. التحقق (Zod §11) والتخويل المؤقت
// (Bearer STAFF_API_TOKEN / جلسة عبر الحارس §10.2) بالخدمة — نفس نمط orders/drivers.
@Controller("api/merchants")
export class MerchantsController {
  constructor(private readonly merchants: MerchantsService) {}

  @Get()
  async list(
    @Headers("authorization") authorization: string | undefined,
    @Query() query: unknown,
  ): Promise<ListMerchantsResponse> {
    return this.merchants.list(authorization, query);
  }

  @Post()
  async create(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<CreateMerchantResponse> {
    return this.merchants.create(authorization, body);
  }

  @Get(":id/catalog")
  async listCatalog(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
    @Query() query: unknown,
  ): Promise<ListCatalogResponse> {
    return this.merchants.listCatalog(authorization, id, query);
  }

  // إنشاء/تحديث صنف (upsert): 200 — الجسم قد يحمل id لتحديث موجود، لا إنشاء دائم
  @Post(":id/catalog")
  @HttpCode(200)
  async upsertCatalogItem(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<CatalogItemResponse> {
    return this.merchants.upsertCatalogItem(authorization, id, body);
  }

  // §3 — قلب توفّر صنف: فعل على مورد قائم، ليس إنشاء → 200
  @Post(":id/catalog/:itemId/availability")
  @HttpCode(200)
  async setItemAvailability(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
    @Param("itemId") itemId: string,
    @Body() body: unknown,
  ): Promise<CatalogItemResponse> {
    return this.merchants.setItemAvailability(authorization, id, itemId, body);
  }
}
