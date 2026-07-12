import "reflect-metadata";
import type { Server as HttpServer } from "node:http";
import { NestFactory } from "@nestjs/core";
import type { DbHandle } from "@quickdrop/db";
import { RT_BOARD_NAMESPACE } from "@quickdrop/shared";
import { AppModule } from "./app.module.js";
import { loadEnv } from "./env.js";
import { initSentry } from "./observability/sentry.js";
import { createRealtimeServer } from "./realtime/realtime.js";
import { DB } from "./tokens.js";

async function bootstrap(): Promise<void> {
  const env = loadEnv(); // يفشل بصوت عالٍ قبل فتح أي منفذ
  initSentry(env.SENTRY_DSN, env.NODE_ENV); // §13 — قبل أي شيء، ليلتقط أخطاء الإقلاع
  const app = await NestFactory.create(AppModule);
  await app.listen(env.PORT);

  // §1/§10.1 — الوقت الحقيقي: Socket.IO فوق نفس خادم HTTP (namespace /board مع
  // redis adapter — جاهز للتوسع الأفقي). حلّ slug→tenantId بنفس DbHandle من DI.
  const dbHandle = app.get<DbHandle>(DB);
  const httpServer: HttpServer = app.getHttpServer();
  const realtime = await createRealtimeServer(httpServer, {
    redisUrl: env.REDIS_URL,
    staffToken: env.STAFF_API_TOKEN,
    db: dbHandle.db,
  });

  // §12 — إغلاق نظيف بالترتيب بدل enableShutdownHooks: خادم الوقت الحقيقي يعيش
  // خارج DI فلا يصله hook؛ نمسك الإشارات صراحةً (نفس نمط الـ worker): WS أولاً
  // (يغلق أيضاً خادم HTTP المرفق) ثم app.close() — يشغّل onApplicationShutdown
  // بالموديول (DB/Redis/الطوابير) ويتسامح مع خادم HTTP مغلق سلفاً.
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await realtime.close();
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  console.log(JSON.stringify({ action: "api_started", port: env.PORT, realtime: RT_BOARD_NAMESPACE }));
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
