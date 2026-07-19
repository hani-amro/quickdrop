import { Module } from "@nestjs/common";
import { CoreModule } from "../core.module.js";
import { PaymentsPublicController, PaymentsStaffController } from "./payments.controller.js";
import { PaymentsService } from "./payments.service.js";

// دمج WaFlow (MERGE_PLAN §7 خطوة 20) — وحدة الدفع: بوابة Billplz (عامة، التوقيع مصادقة)
// + إرسال رابط الدفع (موظف). نمط CrmModule (CoreModule لرموز DI المشتركة).
@Module({
  imports: [CoreModule],
  controllers: [PaymentsPublicController, PaymentsStaffController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
