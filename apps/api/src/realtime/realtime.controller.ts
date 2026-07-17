import { randomBytes } from "node:crypto";
import { Controller, Inject, Post, Req, UnauthorizedException } from "@nestjs/common";
import { REALTIME_TICKET_TTL_S, realtimeTicketKey } from "@quickdrop/shared";
import { Redis } from "ioredis";
import type { RequestWithSession } from "../auth/session.guard.js";
import { REDIS } from "../tokens.js";

// §10.1/§11 — إصدار تذكرة اتصال الوقت الحقيقي. المسار محروس بـ SessionGuard (تحت /api/،
// غير معفى) فيضبط request.staffSession؛ نربط التذكرة بمستأجر الجلسة حصراً، فلا يستطيع
// أحد الاشتراك ببث مستأجر آخر (يستبدل قبول handshake بلا سرّ). التذكرة لمرة واحدة قصيرة.
@Controller("api/realtime")
export class RealtimeController {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  @Post("ticket")
  async ticket(@Req() req: RequestWithSession): Promise<{ ticket: string; expiresInSeconds: number }> {
    const session = req.staffSession;
    if (session === undefined) {
      // مسار Bearer STAFF_API_TOKEN (آلة) لا يحتاج بثاً حياً بالمتصفح — رفض عام
      throw new UnauthorizedException();
    }
    const ticket = randomBytes(16).toString("hex"); // 128-bit مجهول
    await this.redis.set(realtimeTicketKey(ticket), session.tenantId, "EX", REALTIME_TICKET_TTL_S);
    return { ticket, expiresInSeconds: REALTIME_TICKET_TTL_S };
  }
}
