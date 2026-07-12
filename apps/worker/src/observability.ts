import { createServer, type Server } from "node:http";
import { METRIC_QUEUE_DEPTH, QUEUE_DEPTH_STATES } from "@quickdrop/shared";
import * as Sentry from "@sentry/node";
import type { Queue } from "bullmq";
import { collectDefaultMetrics, Gauge, Registry } from "prom-client";

// §13 — مراقبة الـ worker: Sentry (tenant_id tag) + مقاييس Prometheus عبر خادم HTTP
// صغير مستقل (الـ worker بلا منفذ HTTP أصلاً). أهم مقياس: عمق كل طابور (تنبيه §13:
// طابور > 500). بلا SENTRY_DSN = no-op.

let sentryEnabled = false;

export function initSentry(dsn: string | undefined, environment: string): void {
  if (!dsn) return;
  Sentry.init({ dsn, environment, tracesSampleRate: 0.1 });
  sentryEnabled = true;
}

export function captureException(error: unknown, tags?: { tenantId?: string; queue?: string }): void {
  if (!sentryEnabled) return;
  Sentry.withScope((scope) => {
    if (tags?.tenantId) scope.setTag("tenant_id", tags.tenantId);
    if (tags?.queue) scope.setTag("queue", tags.queue);
    Sentry.captureException(error);
  });
}

export interface MetricsServerHandle {
  stop: () => Promise<void>;
}

/**
 * §13 — خادم /metrics + جامع عمق الطوابير كل 15 ثانية (bullmq getJobCounts).
 * ذو منفذ خاص (METRICS_PORT، افتراضي 9100) على الشبكة الداخلية — لا يُكشَف للعالم.
 */
export function startMetricsServer(deps: { port: number; queues: Record<string, Queue> }): MetricsServerHandle {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const queueDepth = new Gauge({
    name: METRIC_QUEUE_DEPTH,
    help: "Number of jobs per queue by state",
    labelNames: ["queue", "state"],
    registers: [registry],
  });

  let stopped = false;
  const sample = async (): Promise<void> => {
    if (stopped) return;
    try {
      for (const [name, queue] of Object.entries(deps.queues)) {
        const counts = await queue.getJobCounts(...QUEUE_DEPTH_STATES);
        for (const state of QUEUE_DEPTH_STATES) {
          queueDepth.set({ queue: name, state }, counts[state] ?? 0);
        }
      }
    } catch (error) {
      // §16.12 — لا ابتلاع صامت: عيّنة فاشلة تُسجَّل والحلقة تستمر
      console.error(JSON.stringify({ action: "metrics_sample", outcome: "error", message: error instanceof Error ? error.message : String(error) }));
    }
  };
  const timer = setInterval(() => void sample(), 15_000);
  void sample(); // عيّنة فورية عند الإقلاع

  const server: Server = createServer((req, res) => {
    if (req.url === "/metrics") {
      void registry.metrics().then((body) => {
        res.writeHead(200, { "content-type": registry.contentType });
        res.end(body);
      });
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(deps.port);

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
