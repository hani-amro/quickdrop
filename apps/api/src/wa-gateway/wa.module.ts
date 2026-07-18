import { Module } from "@nestjs/common";
import { CoreModule } from "../core.module.js";
import { WaGatewayController } from "./wa-gateway.controller.js";
import { WaGatewayService } from "./wa-gateway.service.js";

// MERGE_PLAN §3.6 — أول وحدة feature: قناة واتساب. النمط لوحدات Phase 2
// (CrmModule/AiModule/JourneysModule): استيراد CoreModule، لا تكديس بالموديول المسطّح.
@Module({
  imports: [CoreModule],
  controllers: [WaGatewayController],
  providers: [WaGatewayService],
})
export class WaModule {}
