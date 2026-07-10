import { Body, Controller, Headers, HttpCode, Param, Post } from "@nestjs/common";
import { TelegramGatewayService } from "./gateway.service.js";

// §4.1 — POST /tg/:tenantSlug — السر بالهيدر فقط (المسار يتسرب لـ access logs).
// الرد دائماً 200: لا نعطي أي إشارة، ولا نخلّي تيليغرام يعيد الإرسال للأبد.
@Controller("tg")
export class TelegramGatewayController {
  constructor(private readonly gateway: TelegramGatewayService) {}

  @Post(":tenantSlug")
  @HttpCode(200)
  async receive(
    @Param("tenantSlug") tenantSlug: string,
    @Headers("x-telegram-bot-api-secret-token") secretToken: string | undefined,
    @Body() body: unknown,
  ): Promise<Record<string, never>> {
    await this.gateway.ingest(tenantSlug, secretToken, body);
    return {};
  }
}
