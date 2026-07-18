import { Module } from "@nestjs/common";
import { CoreModule } from "../core.module.js";
import { JourneysController } from "./journeys.controller.js";
import { JourneysService } from "./journeys.service.js";

// دمج WaFlow (MERGE_PLAN §3.6) — وحدة الرحلات: CRUD تعريف الرحلة (المحرك بالـworker).
// نمط CrmModule: تستورد CoreModule (رموز DI المشتركة DB/ENV).
@Module({
  imports: [CoreModule],
  controllers: [JourneysController],
  providers: [JourneysService],
})
export class JourneysModule {}
