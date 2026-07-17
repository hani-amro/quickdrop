import { createDb, tenants } from "@quickdrop/db";
import { installConsoleRedactor, parseEnv } from "@quickdrop/shared";
import { decryptBotToken, getBotForTenant } from "@quickdrop/telegram";
import { createStorageClient, tryLoadStorageConfig } from "@quickdrop/storage";
import { isNotNull } from "drizzle-orm";
import { Redis } from "ioredis";
import { z } from "zod";
import { registerTenantFlows, type UpdateProcessorDeps } from "./update-processor.js";

// §4.4 — مشغّل التطوير بـ long polling (getUpdates) بدل webhook: تيليغرام لا يحتاج
// الوصول لجهازك (لا نفق/رابط عام). يشغّل نفس تدفقات الإنتاج حرفياً (registerTenantFlows)،
// ويكتب بنفس القاعدة والطوابير — الفرق الناقل فقط. للإنتاج: webhook حصراً (apps/api).
//
// تشغيل: pnpm --filter @quickdrop/worker bot-poll   (بعد tenant:provision --skip-webhook)
// **لا يعمل مع أي مستأجر مسجَّل بـ webhook** — تيليغرام لا يسمح بالاثنين معاً (409).

installConsoleRedactor(); // §11 — كل console.* يمرّ بالمنقّح (أسرار/هواتف) قبل الطباعة

const env = parseEnv(
  z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    MASTER_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "MASTER_KEY must be 64 hex chars (32 bytes)"),
  }),
);

// روح الفخ 24: long polling أداة تطوير — لا تعمل على بيئة إنتاج (البوت الحقيقي webhook).
if (env.NODE_ENV === "production") {
  console.error("bot-poll REFUSED: NODE_ENV=production — الإنتاج يستخدم webhook حصراً (روح الفخ 24)");
  process.exit(1);
}

const appDb = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const masterKey = Buffer.from(env.MASTER_KEY, "hex");
const storageConfig = tryLoadStorageConfig(process.env);
const storage = storageConfig !== null ? createStorageClient(storageConfig) : null;

const deps: UpdateProcessorDeps = {
  appDb: appDb.db,
  scanDb: appDb.db, // long polling لكل مستأجر على حدة داخل سياقه — لا مسح عابر هنا
  redis,
  masterKey,
  rtRedis: redis, // §10.1 — نشر driver.location للوحة (نفس العميل)
  storage,
};

type StartedBot = Awaited<ReturnType<typeof getBotForTenant>>;

async function main(): Promise<void> {
  // كل المستأجرين ذوي توكن بوت (tenants استثناء RLS — قراءة مباشرة)
  const rows = await appDb.db
    .select({ id: tenants.id, slug: tenants.slug, currency: tenants.currency, botTokenEncrypted: tenants.botTokenEncrypted, botUsername: tenants.botUsername })
    .from(tenants)
    .where(isNotNull(tenants.botTokenEncrypted));

  if (rows.length === 0) {
    console.error("لا يوجد مستأجر ببوت. شغّل: pnpm tenant:provision -- --slug demo ... --token <TOKEN> --skip-webhook");
    process.exit(1);
  }

  const bots: StartedBot[] = [];
  for (const t of rows) {
    if (!t.botTokenEncrypted) continue;
    const token = decryptBotToken(t.botTokenEncrypted, masterKey);
    const bot = await getBotForTenant({
      tenantId: t.id,
      token,
      onCreate: (created) => registerTenantFlows(created, deps, t.id, t.currency),
    });
    bots.push(bot);
    // grammy: start() يبدأ حلقة long polling (لا تنتظرها — تعمل بالخلفية)
    void bot.start({
      drop_pending_updates: true,
      onStart: (info) => console.log(JSON.stringify({ action: "bot_poll_started", slug: t.slug, bot: info.username })),
    });
    console.log(JSON.stringify({ action: "bot_poll_registered", slug: t.slug, bot: t.botUsername }));
  }

  // §12 — إغلاق نظيف: أوقف الحلقات ثم أغلق الموارد
  const shutdown = async (): Promise<void> => {
    await Promise.allSettled(bots.map((b) => b.stop()));
    redis.disconnect();
    await appDb.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  console.log(JSON.stringify({ action: "bot_poll_ready", tenants: rows.length }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
