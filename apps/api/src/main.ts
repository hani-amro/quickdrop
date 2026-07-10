import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { loadEnv } from "./env.js";

async function bootstrap(): Promise<void> {
  const env = loadEnv(); // يفشل بصوت عالٍ قبل فتح أي منفذ
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks(); // §12: SIGTERM → إغلاق نظيف
  await app.listen(env.PORT);
  console.log(JSON.stringify({ action: "api_started", port: env.PORT }));
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
