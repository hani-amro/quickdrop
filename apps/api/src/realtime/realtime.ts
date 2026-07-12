import type { Server as HttpServer } from "node:http";
import { tenants, type Db } from "@quickdrop/db";
import {
  roomForTenant,
  RT_BOARD_NAMESPACE,
  RT_EVENTS,
  RT_REDIS_CHANNEL,
  rtMessageSchema,
  secretsEqual,
  type DriverLocationEvent,
  type OrderChangedEvent,
} from "@quickdrop/shared";
import { createAdapter } from "@socket.io/redis-adapter";
import { eq } from "drizzle-orm";
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
// ⚠️ قرار v1 مؤقت موثّق (§10.2): الـ handshake يقبل اتصالاً **بلا سر** —
// STAFF_API_TOKEN لا يصل المتصفح أبداً (§11) وWS لا يمر بالـ proxy الخادمي للداشبورد،
// فلا قناة سر متاحة قبل جلسات §10.2 (cookie HttpOnly + Redis). التخفيفات الملزمة:
// (1) الحمولات المبثوثة معرّفات وحالات وإحداثيات فقط — لا PII ولا مبالغ (عقد
// packages/shared/realtime.ts)؛ (2) الاتصال يُضم لغرفة الـ slug المعلن حصراً ولا
// يستطيع الانضمام لغرف أخرى؛ (3) إن قدّم العميل token يُتحقق بـ secretsEqual.
// جلسات §10.2 تستبدل هذا القرار بأول مرحلة مصادقة — لا تبنِ فوقه.

export interface RealtimeDeps {
  /** عملاء Redis الثلاثة (pub/sub للـ adapter + مشترك قناة الـ worker) يُنشأون منه. */
  redisUrl: string;
  /** مؤقت §10.2 — إن قدّم العميل auth.token يجب أن يطابقه (secretsEqual). */
  staffToken: string | undefined;
  /** حل slug → tenantId عند الـ handshake (قراءة tenants — استثناء RLS مسمّى §2.3). */
  db: Db;
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

// §11 — حدود النظام تمر بـ Zod: حمولة handshake من متصفح غير موثوق.
const handshakeAuthSchema = z.object({
  // نفس قيد slug عند provision-tenant
  tenantSlug: z.string().regex(/^[a-z0-9-]{2,32}$/),
  token: z.string().min(1).optional(),
});

/**
 * غرفة الاتصال من حمولة الـ handshake، أو null = رفض (السبب باللوغ فقط — §11:
 * العميل يرى "unauthorized" عامة دائماً، لا تفاصيل تفرّق slug مجهولاً عن معلّق).
 */
async function resolveBoardRoom(
  deps: RealtimeDeps,
  auth: Record<string, unknown>,
): Promise<{ room: string; tenantId: string } | null> {
  const parsed = handshakeAuthSchema.safeParse(auth);
  if (!parsed.success) {
    console.warn(JSON.stringify({ action: "rt_handshake_rejected", reason: "malformed_auth" }));
    return null;
  }

  // token اختياري v1 (التعليق أعلى الملف) — لكن المقدَّم يجب أن يصح: توكن خاطئ
  // صراحةً = رفض، وغياب STAFF_API_TOKEN = لا يمكن التحقق فيُرفض المقدَّم (لا فتح مفتوح).
  if (parsed.data.token !== undefined) {
    if (deps.staffToken === undefined || !secretsEqual(parsed.data.token, deps.staffToken)) {
      console.warn(JSON.stringify({ action: "rt_handshake_rejected", reason: "bad_token" })); // لا يُسجَّل التوكن (§11)
      return null;
    }
  }

  // قراءة جدول tenants بالـ slug — استثناء RLS مسمّى (§2.3، نفس بوابة الـ webhook)
  const rows = await deps.db
    .select({ id: tenants.id, status: tenants.status })
    .from(tenants)
    .where(eq(tenants.slug, parsed.data.tenantSlug))
    .limit(1);
  const tenant = rows[0];
  if (!tenant || tenant.status === "suspended" || tenant.status === "churned") {
    // §14 — المعلّق/المؤرشف لا يُبث له شيء؛ المجهول لا يكشف وجوده (نفس الرد العام)
    console.warn(
      JSON.stringify({ action: "rt_handshake_rejected", reason: "tenant_unavailable", tenantSlug: parsed.data.tenantSlug }),
    );
    return null;
  }
  return { room: roomForTenant(tenant.id), tenantId: tenant.id };
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
    resolveBoardRoom(deps, socket.handshake.auth)
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
