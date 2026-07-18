import { driverLocations, outbox, tenants, webhookUpdates, withTenant, type Db } from "@quickdrop/db";
import { and, eq, lt, sql } from "drizzle-orm";

// §3/§16.25 — تنظيف الجداول الساخنة: webhook_updates المعالَجة أقدم من 48 ساعة،
// وdriver_locations أقدم من 90 يوماً، وصفوف outbox المنتهية (sent بعد 7 أيام —
// كانت تتراكم للأبد R-16 — وfailed بعد 30 يوماً: تُبقى أطول للتشخيص بعد التنبيه §13).
// دفعات محدودة (لا نقفل الجدول وقت الذروة §16.25)، لكل مستأجر عبر withTenant (§2.3).

export const WEBHOOK_RETENTION_MS = 48 * 60 * 60 * 1000; // §4.1
export const LOCATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // §3
export const OUTBOX_SENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // §12/R-16
export const OUTBOX_FAILED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // §12/R-16
const BATCH = 5000;

/** حدّا القطع من لحظة التشغيل — دالة نقية (قابلة للاختبار بساعة محقونة). */
export function retentionCutoffs(now: Date): {
  webhooks: Date;
  locations: Date;
  outboxSent: Date;
  outboxFailed: Date;
} {
  return {
    webhooks: new Date(now.getTime() - WEBHOOK_RETENTION_MS),
    locations: new Date(now.getTime() - LOCATION_RETENTION_MS),
    outboxSent: new Date(now.getTime() - OUTBOX_SENT_RETENTION_MS),
    outboxFailed: new Date(now.getTime() - OUTBOX_FAILED_RETENTION_MS),
  };
}

async function deleteInBatches(
  appDb: Db,
  tenantId: string,
  run: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<number>,
): Promise<number> {
  let total = 0;
  // حلقة الدفعات: كل دفعة ترانزاكشن قصيرة (§16.25 — لا قفل طويل)
  for (;;) {
    const deleted = await withTenant(appDb, tenantId, run);
    total += deleted;
    if (deleted < BATCH) break;
  }
  return total;
}

async function sweepTenant(
  appDb: Db,
  tenantId: string,
  now: Date,
): Promise<{ webhooks: number; locations: number; outboxRows: number }> {
  const cutoff = retentionCutoffs(now);

  const webhooks = await deleteInBatches(appDb, tenantId, async (tx) => {
    const rows = await tx.execute(sql`
      DELETE FROM ${webhookUpdates}
      WHERE ctid IN (
        SELECT ctid FROM ${webhookUpdates}
        WHERE ${and(eq(webhookUpdates.status, "processed"), lt(webhookUpdates.receivedAt, cutoff.webhooks))}
        LIMIT ${BATCH}
      )`);
    return rows.rowCount ?? 0;
  });

  const locations = await deleteInBatches(appDb, tenantId, async (tx) => {
    const rows = await tx.execute(sql`
      DELETE FROM ${driverLocations}
      WHERE ctid IN (
        SELECT ctid FROM ${driverLocations}
        WHERE ${lt(driverLocations.recordedAt, cutoff.locations)}
        LIMIT ${BATCH}
      )`);
    return rows.rowCount ?? 0;
  });

  // R-16 — صفوف sent كانت لا تُحذف أبداً؛ failed تُبقى شهراً للتشخيص ثم تُطهَّر
  const outboxRows = await deleteInBatches(appDb, tenantId, async (tx) => {
    const rows = await tx.execute(sql`
      DELETE FROM ${outbox}
      WHERE ctid IN (
        SELECT ctid FROM ${outbox}
        WHERE ${and(eq(outbox.status, "sent"), lt(outbox.createdAt, cutoff.outboxSent))}
           OR ${and(eq(outbox.status, "failed"), lt(outbox.createdAt, cutoff.outboxFailed))}
        LIMIT ${BATCH}
      )`);
    return rows.rowCount ?? 0;
  });

  return { webhooks, locations, outboxRows };
}

export interface HousekeepingHandle {
  stop: () => Promise<void>;
}

export function startHousekeeping(deps: {
  scanDb: Db; // قراءة قائمة المستأجرين (bypass RLS عبر دور app_worker)
  appDb: Db; // الحذف داخل withTenant لكل مستأجر
  intervalMs?: number;
  now?: () => Date;
}): HousekeepingHandle {
  const intervalMs = deps.intervalMs ?? 60 * 60 * 1000;
  const now = deps.now ?? ((): Date => new Date());
  let running = false;
  let stopped = false;
  let current: Promise<void> | null = null;

  async function sweep(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const allTenants = await deps.scanDb.select({ id: tenants.id }).from(tenants);
      let webhooks = 0;
      let locations = 0;
      let outboxRows = 0;
      for (const t of allTenants) {
        if (stopped) break;
        const r = await sweepTenant(deps.appDb, t.id, now());
        webhooks += r.webhooks;
        locations += r.locations;
        outboxRows += r.outboxRows;
      }
      if (webhooks > 0 || locations > 0 || outboxRows > 0) {
        console.log(
          JSON.stringify({
            action: "housekeeping",
            deleted_webhooks: webhooks,
            deleted_locations: locations,
            deleted_outbox: outboxRows,
          }),
        );
      }
    } catch (error) {
      // §16.12 — لا ابتلاع صامت: سجّل واستمر (الحلقة لا تموت بخطأ دورة)
      console.error(
        JSON.stringify({ action: "housekeeping", outcome: "error", message: error instanceof Error ? error.message : String(error) }),
      );
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    current = sweep();
  }, intervalMs);

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      if (current) await current; // §12 — انتظر الدورة الجارية
    },
  };
}
