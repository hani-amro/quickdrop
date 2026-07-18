import "reflect-metadata";
import type { Server as HttpServer } from "node:http";
import { NestFactory } from "@nestjs/core";
import { installConsoleRedactor, RT_BOARD_NAMESPACE } from "@quickdrop/shared";
import { AppModule } from "./app.module.js";
import { loadEnv } from "./env.js";
import { initSentry } from "./observability/sentry.js";
import { createRealtimeServer } from "./realtime/realtime.js";

async function bootstrap(): Promise<void> {
  installConsoleRedactor(); // §11 — كل console.* يمرّ بالمنقّح (أسرار/هواتف) قبل الطباعة
  const env = loadEnv(); // يفشل بصوت عالٍ قبل فتح أي منفذ
  initSentry(env.SENTRY_DSN, env.NODE_ENV); // §13 — قبل أي شيء، ليلتقط أخطاء الإقلاع
  // rawBody: تحقق توقيع Meta (X-Hub-Signature-256) يتم على الجسم الخام حرفياً —
  // إعادة serialize للـ JSON المفكوك تكسر التوقيع (المفاتيح/المسافات تتغير). §3.1
  const app = await NestFactory.create(AppModule, { rawBody: true });
  await app.listen(env.PORT);

  // §1/§10.1 — الوقت الحقيقي: Socket.IO فوق نفس خادم HTTP (namespace /board مع
  // redis adapter — جاهز للتوسع الأفقي). المصادقة بتذكرة (RealtimeController) لا slug.
  const httpServer: HttpServer = app.getHttpServer();
  const realtime = await createRealtimeServer(httpServer, {
    redisUrl: env.REDIS_URL,
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
