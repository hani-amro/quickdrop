import { Body, Controller, Headers, HttpCode, Param, Post } from "@nestjs/common";
import { Roles } from "../auth/roles.decorator.js";
import { PaymentsService } from "./payments.service.js";

// دمج WaFlow (خطوة 20) — بوابة Billplz + إرسال رابط الدفع.

// البوابة العامة: خارج /api/* (لا SessionGuard)؛ **التوقيع هو المصادقة** (HMAC لكل
// مستأجر، ثابت الزمن بالخدمة). معفاة من حد المعدل كنمط /wa/ (موقَّعة + رتيبة idempotent).
@Controller("payments")
export class PaymentsPublicController {
  constructor(private readonly payments: PaymentsService) {}

  @Post("billplz/:tenantSlug/callback")
  @HttpCode(200)
  async billplzCallback(@Param("tenantSlug") tenantSlug: string, @Body() body: unknown): Promise<string> {
    return this.payments.billplzCallback(tenantSlug, body);
  }
}

// مسار الموظف: إنشاء/إعادة رابط دفع — مالي حسّاس فمحصور owner/dispatcher (كالبث).
@Controller("api/payments")
@Roles("owner", "dispatcher")
export class PaymentsStaffController {
  constructor(private readonly payments: PaymentsService) {}

  @Post("send-link")
  @HttpCode(200)
  async sendLink(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<{ url: string; billId: string; reused: boolean }> {
    return this.payments.sendLink(authorization, body);
  }
}
