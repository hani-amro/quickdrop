import { customerProfiles, tenants, withTenant, type Db } from "@quickdrop/db";
import { recomputeCustomerBrain } from "@quickdrop/brain";
import { and, asc, eq, gt } from "drizzle-orm";

// دمج WaFlow (MERGE_PLAN §3.3) — الكنس الليلي للدماغ: يعالج باغ WaFlow المعروف
// (تدهور المرحلة active→at_risk→churned لا يتحقّق إلا عند الحدث التالي للزبون، فتبقى
// المرحلة قديمة للزبائن الخاملين). نعيد حساب دماغ كل زبون له ملف، لكل مستأجر، مرة
// يومياً — كل زبون بترانزاكشن مستقلة (لا قفل جدول طويل §16.25). يحلّ محل recalc-tiers
// (الدماغ صار مالك المستوى أيضاً — critic #24). حدث crm.lifecycle_changed يُنشَر عند
// تغيّر المرحلة (§3.4 journeys تتفاعل معه لاحقاً).

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // يومياً
const PROFILE_PAGE = 500;

export interface BrainSweepHandle {
  stop: () => Promise<void>;
  /** تشغيل جولة واحدة يدوياً (للاختبار) — يرجّع عدد الملفات المعاد حسابها. */
  runOnce: () => Promise<number>;
}

async function sweepOnce(deps: { scanDb: Db; appDb: Db; now: () => Date }, isStopped: () => boolean): Promise<number> {
  // tenants استثناء RLS مسمّى (§2.3) — يُقرأ بلا سياق
  const tenantRows = await deps.scanDb.select({ id: tenants.id }).from(tenants);
  let recomputed = 0;
  for (const tenant of tenantRows) {
    if (isStopped()) break;
    // ترقيم مفتاح (keyset) على user_id — لا OFFSET (يتدهور)، ولا تحميل الكل بالذاكرة
    let afterUser: string | null = null;
    for (;;) {
      if (isStopped()) break;
      const cursorAfter = afterUser;
      const page: { userId: string }[] = await withTenant(deps.appDb, tenant.id, (tx) =>
        tx
          .select({ userId: customerProfiles.userId })
          .from(customerProfiles)
          .where(
            cursorAfter
              ? and(eq(customerProfiles.tenantId, tenant.id), gt(customerProfiles.userId, cursorAfter))
              : eq(customerProfiles.tenantId, tenant.id),
          )
          .orderBy(asc(customerProfiles.userId))
          .limit(PROFILE_PAGE),
      );
      if (page.length === 0) break;
      for (const { userId } of page) {
        if (isStopped()) break;
        // كل زبون بترانزاكشن مستقلة — recompute idempotent، وينشر حدثاً عند تغيّر المرحلة
        await withTenant(deps.appDb, tenant.id, (tx) =>
          recomputeCustomerBrain(tx, tenant.id, userId, { now: deps.now() }),
        );
        recomputed += 1;
      }
      afterUser = page[page.length - 1]!.userId;
      if (page.length < PROFILE_PAGE) break;
    }
  }
  if (recomputed > 0) {
    console.log(JSON.stringify({ action: "brain_sweep", recomputed }));
  }
  return recomputed;
}

export function startBrainSweep(deps: {
  scanDb: Db;
  appDb: Db;
  intervalMs?: number;
  now?: () => Date;
}): BrainSweepHandle {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = deps.now ?? ((): Date => new Date());
  let stopped = false;
  let running = false;
  let current: Promise<unknown> | null = null;

  const run = async (): Promise<number> => {
    if (running || stopped) return 0;
    running = true;
    try {
      return await sweepOnce({ scanDb: deps.scanDb, appDb: deps.appDb, now }, () => stopped);
    } catch (error) {
      // §16.12 — لا ابتلاع صامت: سجّل واستمر (الحلقة لا تموت بخطأ دورة)
      console.error(JSON.stringify({ action: "brain_sweep", outcome: "error", message: error instanceof Error ? error.message : String(error) }));
      return 0;
    } finally {
      running = false;
    }
  };

  // لا جولة فورية عند الإقلاع (ثقيلة) — أول جولة بعد intervalMs
  const timer = setInterval(() => {
    current = run();
  }, intervalMs);

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      if (current) await current; // §12 — انتظر الدورة الجارية
    },
    runOnce: run,
  };
}
