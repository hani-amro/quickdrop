import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./format";

export type ResourceStatus = "loading" | "ready" | "error";

export interface Resource<T> {
  status: ResourceStatus;
  data: T | null;
  error: string;
  reload: () => void;
}

// جلب بيانات مع إلغاء (AbortController) وإعادة تحميل. المتصل يمرّر fetcher مستقراً (useCallback).
export function useResource<T>(fetcher: (signal: AbortSignal) => Promise<T>): Resource<T> {
  const [status, setStatus] = useState<ResourceStatus>("loading");
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string>("");
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setStatus("loading");
    setError("");
    fetcher(ac.signal)
      .then((res) => {
        if (ac.signal.aborted) return;
        setData(res);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setError(errorMessage(err));
        setStatus("error");
      });
    return () => ac.abort();
  }, [fetcher, nonce]);

  const reload = useCallback((): void => setNonce((n) => n + 1), []);
  return { status, data, error, reload };
}
