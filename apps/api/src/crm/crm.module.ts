import { Module } from "@nestjs/common";
import { CoreModule } from "../core.module.js";
import { CrmController } from "./crm.controller.js";
import { CrmService } from "./crm.service.js";

// دمج WaFlow (MERGE_PLAN §3.6) — وحدة CRM: قراءة المحادثات/الرسائل + بطاقة الزبون 360.
// نمط WaModule: تستورد CoreModule (رموز DI المشتركة). الإرسال الصادر (agent send) عبر
// النقل الموحّد (R-11) يُوصَل بـPhase 3.
@Module({
  imports: [CoreModule],
  controllers: [CrmController],
  providers: [CrmService],
})
export class CrmModule {}
