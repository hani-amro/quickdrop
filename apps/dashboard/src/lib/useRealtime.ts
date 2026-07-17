"use client";

import { useEffect, useRef, useState } from "react";
// الاستيراد من المسار الفرعي الآمن للمتصفح حصراً — برميل "@quickdrop/shared" يجر
// crypto/env (node:crypto) فيكسر حزمة العميل؛ realtime وحده خالٍ من واجهات Node.
import {
  driverLocationEventSchema,
  orderChangedEventSchema,
  RT_BOARD_NAMESPACE,
  RT_EVENTS,
  type DriverLocationEvent,
  type OrderChangedEvent,
} from "@quickdrop/shared/realtime";
import { io } from "socket.io-client";

// §10.1 — قناة WS حية فوق polling الاحتياطي (usePolling يبقى يعمل): عند وصول
// حدث تنفّذ الشاشة refetch فورياً بدل انتظار دورة الـ 3 ثوانٍ. المؤشر بثلاث حالات:
// أخضر = WS حي، أصفر = polling فقط (WS منقطع/غير مهيأ)، أحمر = فشل الجلب نفسه.
//
// §10.1/§11 — المصادقة بتذكرة: قبل كل محاولة اتصال نجلب تذكرة لمرة واحدة عبر الـ proxy
// المصادَق (كوكي الجلسة) من POST /api/proxy/realtime/ticket، ونمرّرها بالـ handshake.
// الخادم يشتق المستأجر من التذكرة حصراً — فلا يشترك مَن يعرف slug عاماً ببث مستأجر آخر.

export interface RealtimeHandlers {
  /** طلب تغيّرت حالته — الاستخدام المعتاد: refetch فوري (mutate) للوحة. */
  onOrderChanged?: (event: OrderChangedEvent) => void;
  /** نقطة سائق غير مشبوهة — لشاشة الخريطة/مؤشرات السائقين. */
  onDriverLocation?: (event: DriverLocationEvent) => void;
}

export interface RealtimeState {
  /** true = قناة WS حية الآن؛ false = اعمل على polling فقط (مؤشر أصفر §10.1). */
  wsAlive: boolean;
}

export function useRealtime(handlers: RealtimeHandlers): RealtimeState {
  const [wsAlive, setWsAlive] = useState(false);
  // المعالجات بمرجع حي: تتبدل كل render بلا إعادة إنشاء الاتصال
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    // NEXT_PUBLIC_* تُضمَّن نصياً بحزمة المتصفح وقت البناء — قيم عامة فقط (§11)
    const apiUrl = process.env.NEXT_PUBLIC_API_URL;
    if (apiUrl === undefined || apiUrl === "") {
      // غير مهيأ = الشاشة تبقى على polling (أصفر) — تدهور مرئي، لا كسر ولا صمت (§16.12)
      console.warn(JSON.stringify({ action: "rt_disabled", reason: "missing NEXT_PUBLIC_API_URL" }));
      return;
    }

    // §10.1 — auth callback: Socket.IO يناديه قبل كل محاولة (re)connect، فنجدّد التذكرة
    // (لمرة واحدة) عبر الـ proxy المصادَق. فشل الجلب → {} → الخادم يرفض → أصفر (polling يغطي).
    const fetchTicketAuth = (cb: (data: Record<string, unknown>) => void): void => {
      fetch("/api/proxy/realtime/ticket", { method: "POST" })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then((data: { ticket?: unknown }) => {
          cb(typeof data.ticket === "string" ? { ticket: data.ticket } : {});
        })
        .catch(() => cb({}));
    };

    // socket.io-client يعيد الاتصال تلقائياً (backoff مدمج) — الأصفر يظهر بين المحاولات
    const socket = io(`${apiUrl}${RT_BOARD_NAMESPACE}`, { auth: fetchTicketAuth });

    socket.on("connect", () => setWsAlive(true));
    socket.on("disconnect", () => setWsAlive(false));
    socket.on("connect_error", () => setWsAlive(false));

    // §11 — حد نظام حتى من خادمنا: تحقق Zod عند الاستهلاك؛ المشوّه يُسقط (polling يغطي)
    socket.on(RT_EVENTS.orderChanged, (raw: unknown) => {
      const parsed = orderChangedEventSchema.safeParse(raw);
      if (parsed.success) handlersRef.current.onOrderChanged?.(parsed.data);
    });
    socket.on(RT_EVENTS.driverLocation, (raw: unknown) => {
      const parsed = driverLocationEventSchema.safeParse(raw);
      if (parsed.success) handlersRef.current.onDriverLocation?.(parsed.data);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  return { wsAlive };
}
