"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// §10.1 — polling كل 3 ثوانٍ (WebSocket لاحقاً) مع حالة اتصال صريحة:
// الموزّع لازم يعرف فوراً إذا اللي قدامه قديم. refresh() يصطف خلف أي جلب جارٍ
// (لا يُهمَل) كي يضمن الفعل المتفائل قراءة حقيقة الخادم بعد نجاحه — بلا وميض رجوع.

export interface PollingState<T> {
  data: T | null;
  failed: boolean;
  lastUpdated: Date | null;
  refresh: () => Promise<void>;
}

export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const aliveRef = useRef(true);
  const busyRef = useRef(false);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const doFetch = useCallback(async (): Promise<void> => {
    busyRef.current = true;
    try {
      const next = await fetcherRef.current();
      if (!aliveRef.current) return;
      setData(next);
      setFailed(false);
      setLastUpdated(new Date());
    } catch {
      // فشل الجلب = مؤشر أحمر — لا رمي داخل interval (§16.12: الحالة مرئية لا مبتلعة)
      if (aliveRef.current) setFailed(true);
    } finally {
      busyRef.current = false;
    }
  }, []);

  // جلب مُصطف: ينتظر الجاري ثم يجلب من جديد — يستخدمه زر التحديث والأفعال المتفائلة
  const refresh = useCallback((): Promise<void> => {
    const next = queueRef.current.then(doFetch);
    queueRef.current = next;
    return next;
  }, [doFetch]);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    const id = setInterval(() => {
      if (!busyRef.current) void refresh(); // لا تكديس نداءات خلف شبكة بطيئة
    }, intervalMs);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
    };
  }, [refresh, intervalMs]);

  return { data, failed, lastUpdated, refresh };
}
