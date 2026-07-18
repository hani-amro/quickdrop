import type { RawBodyRequest } from "@nestjs/common";
import { Body, Controller, Get, Headers, HttpCode, HttpException, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { WaGatewayService } from "./wa-gateway.service.js";

// MERGE_PLAN §3.1 — /wa/webhook: GET تحقق اشتراك Meta (hub.challenge)، POST استقبال
// durable قبل الرد (R-12). خارج /api/* فلا يمسه SessionGuard؛ التوقيع هو المصادقة.
@Controller("wa")
export class WaGatewayController {
  constructor(private readonly gateway: WaGatewayService) {}

  @Get("webhook")
  verify(
    @Query("hub.mode") mode: string | undefined,
    @Query("hub.verify_token") token: string | undefined,
    @Query("hub.challenge") challenge: string | undefined,
  ): string {
    const echoed = this.gateway.verifySubscription(mode, token, challenge);
    if (echoed === null) throw new HttpException("forbidden", 403);
    return echoed; // نص خام — Meta يقارن حرفياً
  }

  @Post("webhook")
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-hub-signature-256") signature: string | undefined,
    @Body() body: unknown,
  ): Promise<Record<string, never>> {
    const result = await this.gateway.ingest(req.rawBody, signature, body);
    if (result.outcome === "invalid_signature") {
      // توقيع فاسد = ليس Meta (يوقّع دائماً بشكل صحيح) — 401 ولا شيء يُحفظ (adversary R-13)
      throw new HttpException("unauthorized", 401);
    }
    return {};
  }
}
