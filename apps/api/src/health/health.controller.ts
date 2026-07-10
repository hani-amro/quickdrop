import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import type { DbHandle } from "@quickdrop/db";
import { sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import { DB, REDIS } from "../app.module.js";

// §13 — يفحصه Uptime Kuma الخارجي: DB + Redis (وgetMe لبوت canary بالمرحلة 1).
@Controller("health")
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  async check(): Promise<{ status: "ok"; db: "up"; redis: "up" }> {
    try {
      await this.db.db.execute(sql`SELECT 1`);
      await this.redis.ping();
    } catch {
      // التفاصيل باللوغ فقط — الرد عام (§11)
      throw new ServiceUnavailableException("dependency check failed");
    }
    return { status: "ok", db: "up", redis: "up" };
  }
}
