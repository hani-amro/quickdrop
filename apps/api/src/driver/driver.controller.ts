import { Body, Controller, Get, Headers, HttpCode, Param, Post } from "@nestjs/common";
import {
  DriverService,
  type DriverAuthResponse,
  type DriverMeResponse,
} from "./driver.service.js";

// P5.1 — REST قناة السائق (PWA). /auth عام (يتحقق من كود الربط)؛ بقية المسارات محروسة بتوكن
// Bearer جلسة السائق (يُحلّ داخل الخدمة → tenant/driver). /api/driver معفى من SessionGuard
// (نطاق ذاتي المصادقة كالـ miniapp). لا اختيار مستأجر من العميل.
@Controller("api/driver")
export class DriverController {
  constructor(private readonly driver: DriverService) {}

  @Post("auth")
  @HttpCode(200)
  async auth(@Body() body: unknown): Promise<DriverAuthResponse> {
    return this.driver.auth(body);
  }

  @Get("me")
  async me(@Headers("authorization") authorization: string | undefined): Promise<DriverMeResponse> {
    return this.driver.me(authorization);
  }

  @Post("shift")
  @HttpCode(200)
  async shift(@Headers("authorization") authorization: string | undefined, @Body() body: unknown): Promise<{ status: string }> {
    return this.driver.shift(authorization, body);
  }

  @Get("orders")
  async orders(@Headers("authorization") authorization: string | undefined): Promise<unknown> {
    return this.driver.orders(authorization);
  }

  @Get("offers")
  async offers(@Headers("authorization") authorization: string | undefined): Promise<unknown> {
    return this.driver.offers(authorization);
  }

  @Post("offers/:offerId/accept")
  @HttpCode(200)
  async accept(@Headers("authorization") authorization: string | undefined, @Param("offerId") offerId: string): Promise<unknown> {
    return this.driver.acceptOffer(authorization, offerId);
  }

  @Post("offers/:offerId/reject")
  @HttpCode(200)
  async reject(@Headers("authorization") authorization: string | undefined, @Param("offerId") offerId: string): Promise<unknown> {
    return this.driver.rejectOffer(authorization, offerId);
  }

  @Post("orders/:orderId/status")
  @HttpCode(200)
  async status(
    @Headers("authorization") authorization: string | undefined,
    @Param("orderId") orderId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.driver.status(authorization, orderId, body);
  }

  @Post("location")
  @HttpCode(200)
  async location(@Headers("authorization") authorization: string | undefined, @Body() body: unknown): Promise<unknown> {
    return this.driver.location(authorization, body);
  }

  @Post("pod")
  @HttpCode(200)
  async pod(@Headers("authorization") authorization: string | undefined, @Body() body: unknown): Promise<unknown> {
    return this.driver.pod(authorization, body);
  }
}
