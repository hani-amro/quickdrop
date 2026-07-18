import type { Db } from "@quickdrop/db";
import type { NotificationJob } from "@quickdrop/shared";
import type { Queue } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OUTBOX_BACKOFF_MAX_MS, outboxBackoffMs, startOutboxPoller, type OutboxPollerDeps } from "./outbox-poller.js";

// اختبار منطق الحلقة بلا اتصال حقيقي (لا Postgres ولا Redis):
// - نستبدل @quickdrop/db بجدول drizzle حقيقي (لبناء الاستعلامات فقط) وwithTenant تمريري
//   يستدعي transaction مباشرة — كي لا يعتمد الاختبار على dist حزمة db ولا على قاعدة حية.
// - scanDb/appDb/queue كلها vi.fn تحاكي سلاسل drizzle الـ thenable.
vi.mock("@quickdrop/db", async () => {
  const { integer, jsonb, pgTable, text, timestamp, uuid } = await import("drizzle-orm/pg-core");
  const outbox = pgTable("outbox", {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    topic: text("topic").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull(), // R-16 — يقرؤه recordDispatchFailure
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }),
  });
  type TxLike = unknown;
  const withTenant = async <T>(
    db: { transaction: (fn: (tx: TxLike) => Promise<T>) => Promise<T> },
    _tenantId: string,
    fn: (tx: TxLike) => Promise<T>,
  ): Promise<T> => db.transaction(fn);
  return { outbox, withTenant };
});

interface ScanRow {
  id: string;
  tenantId: string;
}

/** يحاكي scanDb: select().from().where().limit() — كل استدعاء select يستهلك دفعة. */
function makeScanDb(batches: Array<ScanRow[] | Error>) {
  let call = 0;
  const select = vi.fn(() => {
    const batch = batches[Math.min(call, batches.length - 1)] ?? [];
    call += 1;
    const result = batch instanceof Error ? Promise.reject(batch) : Promise.resolve(batch);
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => result),
    };
    return builder;
  });
  return { db: { select } as unknown as Db, select };
}

interface ClaimRow {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
}

/** يحاكي appDb داخل withTenant: قفل SKIP LOCKED ثم UPDATE sent. */
function makeAppDb(claimRows: ClaimRow[]) {
  const forFn = vi.fn(() => Promise.resolve(claimRows));
  const claimBuilder = {
    from: vi.fn(() => claimBuilder),
    where: vi.fn(() => claimBuilder),
    limit: vi.fn(() => claimBuilder),
    for: forFn,
  };
  const updateWhere = vi.fn(() => Promise.resolve());
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const tx = { select: vi.fn(() => claimBuilder), update };
  const transaction = vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx));
  return { db: { transaction } as unknown as Db, transaction, forFn, update, updateSet, updateWhere };
}

function makeQueue() {
  const add = vi.fn(() => Promise.resolve());
  return { queue: { add } as unknown as Queue<NotificationJob>, add };
}

function deps(parts: { scanDb: Db; appDb: Db; queue: Queue<NotificationJob>; intervalMs?: number }): OutboxPollerDeps {
  return parts;
}

/** يفرغ طابور الـ microtasks — يدع الدورة الفورية تكتمل قبل stop (وإلا أجهضها فحص التوقف داخل الدفعة). */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startOutboxPoller", () => {
  it("صف معلق: قفل داخل سياق المستأجر → دفع للطابور بمفتاح outboxId → تعليم sent", async () => {
    const scan = makeScanDb([[{ id: "ob-1", tenantId: "11111111-1111-4111-8111-111111111111" }], []]);
    const app = makeAppDb([{ id: "ob-1", topic: "order.created", payload: { orderId: "o-1" } }]);
    const q = makeQueue();

    // intervalMs كبير: تُنفَّذ الدورة الفورية عند الإقلاع فقط
    const poller = startOutboxPoller(deps({ scanDb: scan.db, appDb: app.db, queue: q.queue, intervalMs: 60_000 }));
    await flush();
    await poller.stop();

    expect(app.transaction).toHaveBeenCalledTimes(1);
    expect(app.forFn).toHaveBeenCalledWith("update", { skipLocked: true }); // §2.3 v1.1
    expect(q.add).toHaveBeenCalledTimes(1);
    expect(q.add).toHaveBeenCalledWith(
      "deliver",
      {
        outboxId: "ob-1",
        tenantId: "11111111-1111-4111-8111-111111111111",
        topic: "order.created",
        payload: { orderId: "o-1" },
      },
      expect.objectContaining({
        jobId: "ob-1", // مفتاح إزالة التكرار = outbox.id (§12)
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: { count: 1000 },
      }),
    );
    expect(app.updateSet).toHaveBeenCalledWith({ status: "sent" });
  });

  it("SKIP LOCKED يرجع فارغاً (التقطه عامل آخر): لا دفع ولا تحديث", async () => {
    const scan = makeScanDb([[{ id: "ob-2", tenantId: "22222222-2222-4222-8222-222222222222" }], []]);
    const app = makeAppDb([]); // القفل لم يُنَل / الصف لم يعد pending
    const q = makeQueue();

    const poller = startOutboxPoller(deps({ scanDb: scan.db, appDb: app.db, queue: q.queue, intervalMs: 60_000 }));
    await flush();
    await poller.stop();

    expect(app.transaction).toHaveBeenCalledTimes(1);
    expect(q.add).not.toHaveBeenCalled();
    expect(app.update).not.toHaveBeenCalled();
  });

  it("stop() توقف الحلقة: لا مسح جديد بعد التوقف", async () => {
    vi.useFakeTimers();
    const scan = makeScanDb([[]]);
    const app = makeAppDb([]);
    const q = makeQueue();

    const poller = startOutboxPoller(deps({ scanDb: scan.db, appDb: app.db, queue: q.queue, intervalMs: 1000 }));
    await vi.advanceTimersByTimeAsync(3000); // §12 — حلقة كل ثانية
    expect(scan.select.mock.calls.length).toBeGreaterThanOrEqual(3);

    await poller.stop();
    const callsAtStop = scan.select.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(scan.select.mock.calls.length).toBe(callsAtStop); // لا دورات بعد stop
    expect(q.add).not.toHaveBeenCalled();
  });

  it("خطأ بالمسح: يُسجَّل JSON ولا يوقف الحلقة — الدورة التالية تعمل (§16.12)", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scan = makeScanDb([new Error("connection refused"), []]);
    const app = makeAppDb([]);
    const q = makeQueue();

    const poller = startOutboxPoller(deps({ scanDb: scan.db, appDb: app.db, queue: q.queue, intervalMs: 1000 }));
    await vi.advanceTimersByTimeAsync(0); // الدورة الفورية (الفاشلة) تكتمل
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({ action: "outbox_poll_error", message: "connection refused" }),
    );

    await vi.advanceTimersByTimeAsync(2500); // الحلقة استمرت رغم الخطأ
    expect(scan.select.mock.calls.length).toBeGreaterThanOrEqual(2);
    await poller.stop();
  });

  it("خطأ بصف واحد: يُحاسَب (attempts+1 وbackoff، بلا تسميم قبل السقف) ويُكمل بقية الدفعة", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scan = makeScanDb([
      [
        { id: "ob-bad", tenantId: "33333333-3333-4333-8333-333333333333" },
        { id: "ob-ok", tenantId: "33333333-3333-4333-8333-333333333333" },
      ],
      [],
    ]);
    const q = makeQueue();
    const onPoisoned = vi.fn();

    // ثلاث ترانزاكشنات بالترتيب: التقاط ob-bad (يفشل) → محاسبته (R-16) → التقاط ob-ok
    const accountingSet = vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) }));
    const makeTx = (kind: "acct" | "ok"): unknown => {
      const rows = kind === "acct" ? [{ attempts: 0 }] : [{ id: "ob-ok", topic: "t", payload: {} }];
      const builder = {
        from: (): unknown => builder,
        where: (): unknown => builder,
        limit: (): unknown => builder,
        for: (): Promise<unknown[]> => Promise.resolve(rows),
      };
      const okSet = vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) }));
      return { select: (): unknown => builder, update: vi.fn(() => ({ set: kind === "acct" ? accountingSet : okSet })) };
    };
    let txCall = 0;
    const appDb = {
      transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => {
        txCall += 1;
        if (txCall === 1) throw new Error("deadlock");
        if (txCall === 2) return fn(makeTx("acct"));
        return fn(makeTx("ok"));
      }),
    } as unknown as Db;

    const poller = startOutboxPoller({ scanDb: scan.db, appDb, queue: q.queue, intervalMs: 60_000, onPoisoned });
    await flush();
    await poller.stop();

    // R-16 — المحاسبة: attempts=1، موعد مؤجل بالمستقبل، status لم يتغير (لم يبلغ السقف)
    expect(accountingSet).toHaveBeenCalledTimes(1);
    const setArg = accountingSet.mock.calls[0]![0] as { attempts: number; nextAttemptAt: Date; status?: string };
    expect(setArg.attempts).toBe(1);
    expect(setArg.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() - 1);
    expect(setArg.status).toBeUndefined();
    expect(onPoisoned).not.toHaveBeenCalled();

    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({
        action: "outbox_dispatch_error",
        outboxId: "ob-bad",
        tenantId: "33333333-3333-4333-8333-333333333333",
        outcome: "backoff",
        message: "deadlock",
      }),
    );
    expect(q.add).toHaveBeenCalledTimes(1); // الصف السليم وصل الطابور رغم فشل جاره
  });
});

describe("outboxBackoffMs (R-16 — دالة نقية)", () => {
  it("أسّي: 1s ثم 2s ثم 4s…", () => {
    expect(outboxBackoffMs(1)).toBe(1_000);
    expect(outboxBackoffMs(2)).toBe(2_000);
    expect(outboxBackoffMs(3)).toBe(4_000);
    expect(outboxBackoffMs(5)).toBe(16_000);
  });

  it("بسقف 5 دقائق مهما كبر العداد (بلا overflow)", () => {
    expect(outboxBackoffMs(10)).toBe(OUTBOX_BACKOFF_MAX_MS);
    expect(outboxBackoffMs(1000)).toBe(OUTBOX_BACKOFF_MAX_MS);
  });

  it("قيم شاذة (0/سالب) تعامَل كأول محاولة", () => {
    expect(outboxBackoffMs(0)).toBe(1_000);
    expect(outboxBackoffMs(-5)).toBe(1_000);
  });
});
