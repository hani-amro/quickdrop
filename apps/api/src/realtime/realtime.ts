import type { Server as HttpServer } from "node:http";
import {
  realtimeTicketKey,
  roomForTenant,
  RT_BOARD_NAMESPACE,
  RT_EVENTS,
  RT_REDIS_CHANNEL,
  rtMessageSchema,
  type DriverLocationEvent,
  type OrderChangedEvent,
} from "@quickdrop/shared";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { Server, type Namespace } from "socket.io";
import { z } from "zod";

// §1/§10.1 — الوقت الحقيقي: Socket.IO فوق خادم HTTP القائم مع Redis adapter —
// جاهز للتوسع الأفقي من البداية. مسار الحدث: worker ينشر {tenantId, event, payload}
// على قناة RT_REDIS_CHANNEL ← كل عقدة api مشترِكة تتحقق Zod (§11) وتعيد البث
// **محلياً** لغرفة المستأجر. البث محلي عمداً: كل العقد مشترِكة بالقناة أصلاً،
// والبث عبر الـ adapter كان سيوصل الحدث لكل عميل بعدد العقد؛ الـ adapter يبقى
// للتوسع الأفقي (أي بث مستقبلي يصدر من عقدة واحدة — من الـ api نفسه — يعبر به).
//
// §10.1/§11 — المصادقة بتذكرة: الـ handshake يتطلب auth.ticket صالحة (يصدرها الـ api
// لجلسة موثّقة عبر POST /api/realtime/ticket، مربوطة بمستأجرها). سابقاً كان يقبل اتصالاً
// بلا سرّ فأي مَن يعرف slug المستأجر العام يشترك ببث GPS السائقين (تسرّب عابر للمستأجرين).
// التذكرة تُستهلك لمرة واحدة وتحدّد المستأجر مباشرة (لا اختيار slug من العميل).

export interface RealtimeDeps {
  /** عملاء Redis (pub/sub للـ adapter + مشترك قناة الـ worker + فحص التذاكر) يُنشأون منه. */
  redisUrl: string;
}

// ثوابت محلية مسماة للأسماء المحسوبة أدناه — النوع مربوط بمصدر الحقيقة (shared):
// أي انحراف عن RT_EVENTS يفشل التحويل البرمجي، لا يعمل بصمت باسم مختلف.
const RT_EVENTS_ORDER_CHANGED: typeof RT_EVENTS.orderChanged = RT_EVENTS.orderChanged;
const RT_EVENTS_DRIVER_LOCATION: typeof RT_EVENTS.driverLocation = RT_EVENTS.driverLocation;

// أحداث الخادم → العميل (typed emits — لا 'any' عبر العقد)
interface BoardServerEvents {
  [RT_EVENTS_ORDER_CHANGED]: (payload: OrderChangedEvent) => void;
  [RT_EVENTS_DRIVER_LOCATION]: (payload: DriverLocationEvent) => void;
}

interface BoardSocketData {
  tenantId: string;
}

type BoardNamespace = Namespace<Record<string, never>, BoardServerEvents, Record<string, never>, BoardSocketData>;
export type BoardServer = Server<Record<string, never>, BoardServerEvents, Record<string, never>, BoardSocketData>;

export interface RealtimeHandle {
  io: BoardServer;
  /** إغلاق نظيف (§12): عملاء WS ثم عملاء Redis الثلاثة — يُستدعى قبل app.close(). */
  close(): Promise<void>;
}

// §11 — حدود النظام تمر بـ Zod: حمولة handshake من متصفح غير موثوق. التذكرة hex 128-bit.
const handshakeAuthSchema = z.object({
  ticket: z.string().regex(/^[0-9a-f]{32}$/),
});

/**
 * §10.1/§11 — غرفة الاتصال من التذكرة (تُستهلك لمرة واحدة): GET+DEL ذرّي لمفتاحها بـ Redis
 * يعيد tenantId المربوطة به عند الإصدار (لجلسة موثّقة). null = رفض عام (السبب باللوغ).
 * لا اختيار مستأجر من العميل — المستأجر مشتق من التذكرة حصراً.
 */
async function resolveBoardRoom(
  ticketRedis: Redis,
  auth: Record<string, unknown>,
): Promise<{ room: string; tenantId: string } | null> {
  const parsed = handshakeAuthSchema.safeParse(auth);
  if (!parsed.success) {
    console.warn(JSON.stringify({ action: "rt_handshake_rejected", reason: "malformed_auth" }));
    return null;
  }
  // GETDEL ذرّي: التذكرة لمرة واحدة (لا يعاد استخدامها من نافذة، ولا سباق يشترك مرتين)
  const key = realtimeTicketKey(parsed.data.ticket);
  const tenantId = await ticketRedis.getdel(key);
  if (tenantId === null) {
    console.warn(JSON.stringify({ action: "rt_handshake_rejected", reason: "bad_or_used_ticket" })); // لا تُسجَّل التذكرة
    return null;
  }
  return { room: roomForTenant(tenantId), tenantId };
}

/** إعادة بث رسالة قناة الـ worker لغرفة مستأجرها — محلياً (تعليق رأس الملف). */
function rebroadcast(board: BoardNamespace, raw: string): void {
  // §1/§11 — الرسالة عبرت حد عملية (worker → Redis): تحقق Zod عند الاستهلاك.
  // §16.12 — معالجة صريحة لا ابتلاع: المشوّهة تُسجَّل وتُسقط (لا retry داخل pub/sub —
  // القناة fire-and-forget وpolling الداشبورد هو الاحتياط المضمون §10.1).
  let parsed: ReturnType<typeof rtMessageSchema.safeParse>;
  try {
    parsed = rtMessageSchema.safeParse(JSON.parse(raw));
  } catch {
    console.warn(JSON.stringify({ action: "rt_message_invalid", reason: "not_json" }));
    return;
  }
  if (!parsed.success) {
    console.warn(JSON.stringify({ action: "rt_message_invalid", reason: "schema" }));
    return;
  }
  const message = parsed.data;
  const local = board.local.to(roomForTenant(message.tenantId));
  // فرعان صريحان بدل emit ديناميكي: يربط TS اسم الحدث بنوع حمولته (لا 'any')
  if (message.event === RT_EVENTS_ORDER_CHANGED) {
    local.emit(RT_EVENTS_ORDER_CHANGED, message.payload);
  } else {
    local.emit(RT_EVENTS_DRIVER_LOCATION, message.payload);
  }
}

/**
 * §1/§10.1 — إنشاء خادم الوقت الحقيقي فوق خادم HTTP القائم (يُستدعى من main.ts
 * بعد app.listen). ثلاثة عملاء Redis: pub/sub للـ redis-adapter + ثالث مشترك
 * بقناة الـ worker (عميل subscriber لا يصلح لغير الاشتراك — لا مشاركة).
 */
export async function createRealtimeServer(httpServer: HttpServer, deps: RealtimeDeps): Promise<RealtimeHandle> {
  const pubClient = new Redis(deps.redisUrl, { maxRetriesPerRequest: null });
  const subClient = pubClient.duplicate();
  const workerSubClient = pubClient.duplicate();

  const io: BoardServer = new Server(httpServer, {
    adapter: createAdapter(pubClient, subClient),
    serveClient: false,
    // مؤقت §10.2 — handshake الـ polling الأولي cross-origin (الداشبورد أصل آخر):
    // origin منعكس بلا credentials — يتشدد لقائمة أصول مع جلسات §10.2 (cookie).
    cors: { origin: true, credentials: false },
  });

  // الـ namespace الافتراضي '/' لا يخدم شيئاً — ارفض اتصالاته كي لا تبقى معلّقة بلا غرف
  io.use((_socket, next) => {
    next(new Error("unauthorized")); // §11 — رسالة عامة
  });

  const board: BoardNamespace = io.of(RT_BOARD_NAMESPACE);

  board.use((socket, next) => {
    // pubClient عميل عادي (ليس subscriber) — صالح لـ GETDEL التذكرة
    resolveBoardRoom(pubClient, socket.handshake.auth)
      .then(async (resolved) => {
        if (resolved === null) {
          next(new Error("unauthorized")); // §11 — رسالة عامة؛ السبب باللوغ أعلاه
          return;
        }
        socket.data.tenantId = resolved.tenantId;
        await socket.join(resolved.room); // الغرفة الوحيدة — عزل §2 بالغرف
        next();
      })
      .catch((error: unknown) => {
        // §16.12 — فشل بنيوي (قاعدة مثلاً): لوغ صريح ورفض عام، لا ابتلاع
        console.error(
          JSON.stringify({
            action: "rt_handshake_error",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        next(new Error("unauthorized"));
      });
  });

  board.on("connection", (socket) => {
    // §13 — لوغ منظّم بحقول ثابتة (لا توكنات ولا PII)
    console.log(JSON.stringify({ action: "rt_connected", tenantId: socket.data.tenantId, socketId: socket.id }));
  });

  await workerSubClient.subscribe(RT_REDIS_CHANNEL);
  workerSubClient.on("message", (channel: string, raw: string) => {
    if (channel !== RT_REDIS_CHANNEL) return;
    rebroadcast(board, raw);
  });

  return {
    io,
    close: async (): Promise<void> => {
      // io.close يفصل العملاء ويغلق المحرك (ويغلق خادم HTTP المرفق — لذلك يُستدعى
      // قبل app.close الذي يتسامح مع خادم مغلق سلفاً). ثم عملاء Redis الثلاثة.
      await new Promise<void>((resolve) => {
        void io.close(() => resolve());
      });
      pubClient.disconnect();
      subClient.disconnect();
      workerSubClient.disconnect();
    },
  };
}
