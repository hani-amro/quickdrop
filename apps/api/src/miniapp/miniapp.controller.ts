import { Body, Controller, Get, Headers, HttpCode, Param, Post } from "@nestjs/common";
import {
  MiniappService,
  type MiniappAuthResponse,
  type MiniappCatalogResponse,
  type MiniappOrderResponse,
  type MiniappRestaurantsResponse,
} from "./miniapp.service.js";

// §10.3 — REST الـ Mini App. /auth عام (يتحقق من initData بنفسه)؛ بقية المسارات محروسة
// بتوكن Bearer المجهول (يُحلّ داخل الخدمة → tenant/user). لا اختيار مستأجر من العميل.
@Controller("api/miniapp")
export class MiniappController {
  constructor(private readonly miniapp: MiniappService) {}

  // تبادل initData بتوكن جلسة قصير — فعل يصدر سراً → 200 (ليس إنشاء مورد دائم)
  @Post("auth")
  @HttpCode(200)
  async auth(@Body() body: unknown): Promise<MiniappAuthResponse> {
    return this.miniapp.auth(body);
  }

  @Get("restaurants")
  async restaurants(@Headers("authorization") authorization: string | undefined): Promise<MiniappRestaurantsResponse> {
    return this.miniapp.restaurants(authorization);
  }

  @Get("restaurants/:id/catalog")
  async catalog(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
  ): Promise<MiniappCatalogResponse> {
    return this.miniapp.catalog(authorization, id);
  }

  @Post("orders")
  async createOrder(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<MiniappOrderResponse> {
    return this.miniapp.createOrder(authorization, body);
  }
}
