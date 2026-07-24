"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { OrderStatus } from "@quickdrop/shared";
import { api, describeError } from "@/lib/api";
import { statusLabel, isToday, minutesSince } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { DriverRow, OrderRow } from "@/lib/types";
import { usePolling } from "@/lib/use-polling";
import { useRealtime } from "@/lib/useRealtime";
import { AssignDriverModal } from "./AssignDriverModal";
import { CancelOrderModal } from "./CancelOrderModal";
import { ConnectionBadge } from "./ConnectionBadge";
import { OrderCard } from "./OrderCard";
import { OrderDetailModal } from "./OrderDetailModal";
import { useToast } from "./Toast";

// §10.1 — شاشة الإرسال: أعمدة بالحالة، polling كل 3 ثوانٍ (§16.10: نداء قائمة
// واحد — التوزيع على الأعمدة بالواجهة)، خرق SLA أحمر نابض >5 دقائق بلا إسناد،
// وأفعال optimistic بتراجع صريح + توست عند الفشل — لا فشل صامت.

const ONGOING_STATUSES: readonly OrderStatus[] = ["assigned", "picked_up", "in_transit", "arrived"];
const FINISHED_STATUSES: readonly OrderStatus[] = [
  "delivered",
  "cancelled_by_customer",
  "cancelled_by_office",
  "failed",
  "returned",
];

const SLA_MINUTES = 5; // §10.1: طلب بلا إسناد > 5 دقائق = صف أحمر نابض

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

export function DispatchBoard() {
  const t = useT();
  const toast = useToast();
  const { data, failed, lastUpdated, refresh } = usePolling(api.listOrders, 3000);

  // §10.1 — WS فوق الـ polling (الذي يبقى fallback): حدث order.changed → refetch
  // فوري مُصطف (refresh) بدل انتظار الـ 3 ثوانٍ. الحمولة معرّفات فقط — الحقيقة
  // تُجلب من الـ API المصادَق عبر الـ proxy (§11)، لا دمج حمولة WS باللوحة.
  const { wsAlive } = useRealtime({ onOrderChanged: () => void refresh() });

  // Optimistic UI (§10.1): patches محلية فوق حقيقة الخادم؛ الإزالة = تراجع صريح
  const [patches, setPatches] = useState<Record<string, Partial<OrderRow>>>({});
  const [busyIds, setBusyIds] = useState<Record<string, true>>({});
  const [cancelFor, setCancelFor] = useState<OrderRow | null>(null);
  const [assignFor, setAssignFor] = useState<OrderRow | null>(null);
  const [detailFor, setDetailFor] = useState<OrderRow | null>(null); // §3 v1 — تفاصيل + "المطعم أكّد"
  const [showFinished, setShowFinished] = useState(false);

  const rows = useMemo(() => {
    const list = data?.orders ?? [];
    return list.map((o) => {
      const patch = patches[o.id];
      return patch !== undefined ? { ...o, ...patch } : o;
    });
  }, [data, patches]);

  const columns = useMemo(
    () => ({
      pending: rows.filter((o) => o.status === "pending"),
      confirmed: rows.filter((o) => o.status === "confirmed"),
      ongoing: rows.filter((o) => ONGOING_STATUSES.includes(o.status)),
      finished: rows.filter((o) => FINISHED_STATUSES.includes(o.status) && isToday(o.createdAt)),
    }),
    [rows],
  );

  // الفعل المتفائل الموحّد: patch فوراً ← نداء ← نجاح: اقرأ حقيقة الخادم ثم أزل
  // الـ patch (بلا وميض) ← فشل: أزل الـ patch (عودة الحالة) + توست بالسبب.
  async function act(
    order: OrderRow,
    patch: Partial<OrderRow>,
    call: () => Promise<unknown>,
    okMsg: string,
    failMsg: string,
  ): Promise<void> {
    setBusyIds((b) => ({ ...b, [order.id]: true }));
    setPatches((p) => ({ ...p, [order.id]: patch }));
    try {
      await call();
      toast.success(okMsg);
      await refresh();
      setPatches((p) => withoutKey(p, order.id));
    } catch (error) {
      setPatches((p) => withoutKey(p, order.id)); // §10.1: تراجع صريح — عودة الحالة
      toast.error(t("board.actionReverted", { msg: failMsg, error: describeError(error) }));
    } finally {
      setBusyIds((b) => withoutKey(b, order.id));
    }
  }

  const confirmOrder = (order: OrderRow): Promise<void> =>
    act(
      order,
      { status: "confirmed" },
      () => api.confirmOrder(order.id),
      t("board.orderConfirmed", { code: order.publicCode }),
      t("board.orderConfirmFailed", { code: order.publicCode }),
    );

  const cancelOrder = (order: OrderRow, reason: string): Promise<void> =>
    act(
      order,
      { status: "cancelled_by_office" },
      () => api.cancelOrder(order.id, reason),
      t("board.orderCancelled", { code: order.publicCode }),
      t("board.orderCancelFailed", { code: order.publicCode }),
    );

  const assignOrder = (order: OrderRow, driver: DriverRow): Promise<void> =>
    act(
      order,
      { status: "assigned", driverName: driver.name },
      () => api.assignOrder(order.id, driver.id),
      t("board.orderAssigned", { code: order.publicCode, name: driver.name }),
      t("board.orderAssignFailed", { code: order.publicCode }),
    );

  const actionBtn =
    "rounded-lg px-2.5 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold text-slate-900">{t("board.title")}</h1>
        <ConnectionBadge failed={failed} lastUpdated={lastUpdated} wsAlive={wsAlive} onRefresh={() => void refresh()} />
      </div>

      <section className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-4">
        {/* 1 — بانتظار التأكيد (pending): تأكيد أو إلغاء بسبب */}
        <BoardColumn title={t("board.pending")} count={columns.pending.length} tone="bg-amber-100 text-amber-800">
          {columns.pending.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              onOpen={() => setDetailFor(order)}
              footer={
                <>
                  <button
                    type="button"
                    disabled={busyIds[order.id] === true}
                    onClick={() => void confirmOrder(order)}
                    className={`${actionBtn} bg-emerald-600 text-white hover:bg-emerald-700`}
                  >
                    {t("board.confirm")}
                  </button>
                  <button
                    type="button"
                    disabled={busyIds[order.id] === true}
                    onClick={() => setCancelFor(order)}
                    className={`${actionBtn} border border-red-300 text-red-700 hover:bg-red-50`}
                  >
                    {t("board.cancelWithReason")}
                  </button>
                </>
              }
            />
          ))}
          {columns.pending.length === 0 && <EmptyHint />}
        </BoardColumn>

        {/* 2 — بحاجة سائق (confirmed): SLA نابض + إسناد يدوي أو إلغاء */}
        <BoardColumn title={t("board.needsDriver")} count={columns.confirmed.length} tone="bg-red-100 text-red-800">
          {columns.confirmed.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              onOpen={() => setDetailFor(order)}
              // §10.1 — عمر "بلا إسناد" يُقاس من لحظة التأكيد إن توفرت، وإلا من الإنشاء
              slaBreached={minutesSince(order.confirmedAt ?? order.createdAt) > SLA_MINUTES}
              footer={
                <>
                  <button
                    type="button"
                    disabled={busyIds[order.id] === true}
                    onClick={() => setAssignFor(order)}
                    className={`${actionBtn} bg-sky-600 text-white hover:bg-sky-700`}
                  >
                    {t("board.manualAssign")}
                  </button>
                  <button
                    type="button"
                    disabled={busyIds[order.id] === true}
                    onClick={() => setCancelFor(order)}
                    className={`${actionBtn} border border-red-300 text-red-700 hover:bg-red-50`}
                  >
                    {t("board.cancelWithReason")}
                  </button>
                </>
              }
            />
          ))}
          {columns.confirmed.length === 0 && <EmptyHint />}
        </BoardColumn>

        {/* 3 — جارية (assigned..arrived): اسم السائق + الحالة بالعربي */}
        <BoardColumn title={t("board.ongoing")} count={columns.ongoing.length} tone="bg-sky-100 text-sky-800">
          {columns.ongoing.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              onOpen={() => setDetailFor(order)}
              meta={
                <p className="mt-1 text-xs text-slate-600">
                  <bdi>{order.driverName ?? t("board.unknownDriver")}</bdi> — {statusLabel(t, order.status)}
                </p>
              }
            />
          ))}
          {columns.ongoing.length === 0 && <EmptyHint />}
        </BoardColumn>

        {/* 4 — منتهية اليوم (delivered/cancelled/failed): مطوية افتراضياً */}
        <BoardColumn
          title={t("board.finishedToday")}
          count={columns.finished.length}
          tone="bg-slate-200 text-slate-700"
          headerExtra={
            <button
              type="button"
              onClick={() => setShowFinished((v) => !v)}
              className="rounded-md px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-200"
            >
              {showFinished ? t("board.collapse") : t("board.show")}
            </button>
          }
        >
          {showFinished &&
            columns.finished.map((order) => (
              <OrderCard
                key={order.id}
                order={order}
                onOpen={() => setDetailFor(order)}
                meta={<p className="mt-1 text-xs text-slate-500">{statusLabel(t, order.status)}</p>}
              />
            ))}
          {showFinished && columns.finished.length === 0 && <EmptyHint />}
        </BoardColumn>
      </section>

      {cancelFor !== null && (
        <CancelOrderModal
          order={cancelFor}
          onClose={() => setCancelFor(null)}
          onCancel={(reason) => {
            const order = cancelFor;
            setCancelFor(null);
            void cancelOrder(order, reason);
          }}
        />
      )}
      {assignFor !== null && (
        <AssignDriverModal
          order={assignFor}
          onClose={() => setAssignFor(null)}
          onAssign={(driver) => {
            const order = assignFor;
            setAssignFor(null);
            void assignOrder(order, driver);
          }}
        />
      )}
      {detailFor !== null && (
        <OrderDetailModal
          order={detailFor}
          onClose={() => setDetailFor(null)}
          onConfirmed={() => void refresh()}
        />
      )}
    </div>
  );
}

function BoardColumn({
  title,
  count,
  tone,
  headerExtra,
  children,
}: {
  title: string;
  count: number;
  tone: string;
  headerExtra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-slate-100/70 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-slate-700">{title}</h2>
        <div className="flex items-center gap-1">
          {headerExtra}
          <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${tone}`}>{count}</span>
        </div>
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function EmptyHint() {
  const t = useT();
  return <p className="rounded-xl border border-dashed border-slate-300 p-3 text-center text-xs text-slate-400">{t("board.noOrders")}</p>;
}
