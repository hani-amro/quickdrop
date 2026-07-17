import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { orders } from "./schema/index.js";
import { transition } from "./state-machine.js";
import { withTenant } from "./with-tenant.js";

// §6.3 — تشغيل الطلبات المجدولة: عند الموعد يطلق الـ worker الطلب scheduled→pending
// بفاعل system. القاعدة مصدر الحقيقة (§12): scheduled_at يبقى بعد ضياع Redis، والإطلاق
// يقفل الصف ويتحقق من الحالة (idempotent — مهمة api الأصلية وإعادة جدولة الإقلاع بنفس jobId).

/** نقي: تأخير مهمة الجدولة بالمللي ثانية — الفائت يُطلق فوراً (لا سالب). */
export function scheduledDelayMs(scheduledAt: Date, now: Date): number {
  return Math.max(0, scheduledAt.getTime() - now.getTime());
}

/**
 * §6.3 — يطلق طلباً مجدولاً واحداً: يقفل صفه FOR UPDATE، وإن كان لا يزال scheduled
 * ينقله إلى pending (يدخل مسار الإسناد). أي حالة أخرى (أُلغي، أُطلق سلفاً) → خروج
 * صامت idempotent — مهمتان بنفس jobId أو إعادة جدولة الإقلاع لا تُطلقانه مرتين.
 */
export async function fireScheduledOrder(db: Db, tenantId: string, orderId: string): Promise<{ fired: boolean }> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for("update");
    const order = rows[0];
    if (!order || order.status !== "scheduled") return { fired: false }; // أُلغي/أُطلق سلفاً — لا شيء
    await transition(tx, { orderId, to: "pending", actor: { type: "system" } });
    return { fired: true };
  });
}
