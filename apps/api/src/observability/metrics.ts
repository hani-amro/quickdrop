import {
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  Header,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { handlerLabel, METRIC_HTTP_REQUEST_DURATION } from "@quickdrop/shared";
import type { Request, Response } from "express";
import { collectDefaultMetrics, Histogram, Registry } from "prom-client";
import { Observable, tap } from "rxjs";

// §13 — مقاييس Prometheus للـ API: default metrics + histogram زمن الاستجابة
// (p95 webhook < 500ms هدف §13). registry واحد للعملية، يُكشَط عبر GET /metrics
// (معفى من الحارسَين: /metrics ليس /api/* فـ SessionGuard يتجاوزه، ومستثنى من
// RateLimitGuard صراحةً — القسم classifyRoute).

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const httpDuration = new Histogram({
  name: METRIC_HTTP_REQUEST_DURATION,
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

// §13 — interceptor عام يقيس زمن كل طلب. المسار = قالب express (لا القيم الفعلية —
// كي لا ينفجر عدد الـ labels على المعرّفات). يُسجَّل كـ APP_INTERCEPTOR بالموديول.
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { route?: { path?: string } }>();
    const res = context.switchToHttp().getResponse<Response>();
    const end = httpDuration.startTimer();
    const route = req.route?.path ?? handlerLabel("unknown", req.path);
    return next.handle().pipe(
      tap({
        next: () => end({ method: req.method, route, status: String(res.statusCode) }),
        error: () => end({ method: req.method, route, status: String(res.statusCode || 500) }),
      }),
    );
  }
}

@Controller("metrics")
export class MetricsController {
  @Get()
  @Header("Content-Type", registry.contentType)
  async metrics(): Promise<string> {
    return registry.metrics();
  }
}
