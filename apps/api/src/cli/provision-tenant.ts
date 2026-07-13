import { parseArgs } from "node:util";
import { createDb, tenants } from "@quickdrop/db";
import { encryptSecret, parseEnv } from "@quickdrop/shared";
import {
  assertBotMatchesEnvironment,
  generateWebhookSecret,
  getBotInfo,
  registerWebhook,
} from "@quickdrop/telegram";
import { z } from "zod";

// §14 — ربط مستأجر ببوته (يدوي بالمرحلة 0؛ معالج الكونسول بالمرحلة 5):
//   pnpm tenant:provision --slug office-a --name "Office A" --name-ar "مكتب أ" \
//     --token <BOT_TOKEN> [--skip-webhook]
// التدفق: getMe ✅ ← حارس الفخ 24 ← توليد سر ← تشفير التوكن ← upsert ← setWebhook.
// التوكن لا يُطبع أبداً — لا عند النجاح ولا بالأخطاء (§4.2).

const env = parseEnv(
  z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().url(),
    MASTER_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "MASTER_KEY must be 64 hex chars (32 bytes)"),
    PUBLIC_URL: z.string().url().optional(),
  }),
);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      name: { type: "string" },
      "name-ar": { type: "string" },
      token: { type: "string" },
      timezone: { type: "string", default: "Asia/Damascus" },
      "skip-webhook": { type: "boolean", default: false },
      // تجاوز صريح لحارس الفخ 24 (اسم البوت لا ينتهي بـ _dev_bot): للتجربة المحلية
      // المتعمّدة ببوت حقيقي على long polling. ممنوع بالإنتاج (الحارس يبقى صارماً هناك).
      "allow-nonstandard-bot": { type: "boolean", default: false },
    },
  });

  const slug = values.slug;
  const name = values.name;
  const nameAr = values["name-ar"];
  const token = values.token;
  if (!slug || !name || !nameAr || !token) {
    console.error("usage: provision-tenant --slug <slug> --name <name> --name-ar <name> --token <token> [--skip-webhook]");
    process.exitCode = 1;
    return;
  }
  if (!/^[a-z0-9-]{2,32}$/.test(slug)) {
    console.error("slug must be 2-32 chars of [a-z0-9-] — it becomes part of the webhook URL");
    process.exitCode = 1;
    return;
  }

  const bot = await getBotInfo(token); // يتحقق أن التوكن حي
  // الفخ 24 — يبقى صارماً بالإنتاج دائماً؛ خارج الإنتاج فقط يسمح --allow-nonstandard-bot
  // بتجاوز اشتراط _dev_bot (للتجربة المحلية المتعمّدة). التجاوز يُطبع بصوت عالٍ.
  if (values["allow-nonstandard-bot"] && env.NODE_ENV !== "production") {
    console.warn(`⚠️  تجاوز الفخ 24: ربط @${bot.username} (ليس _dev_bot) خارج الإنتاج بطلب صريح.`);
  } else {
    assertBotMatchesEnvironment(bot.username, env.NODE_ENV);
  }

  const webhookSecret = generateWebhookSecret();
  const encryptedToken = encryptSecret(token, Buffer.from(env.MASTER_KEY, "hex"));

  const handle = createDb(env.DATABASE_URL);
  try {
    await handle.db
      .insert(tenants)
      .values({
        slug,
        name,
        nameAr,
        timezone: values.timezone,
        botTokenEncrypted: encryptedToken,
        botUsername: bot.username,
        botWebhookSecret: webhookSecret,
      })
      .onConflictDoUpdate({
        // إعادة الربط (§4.2): نفس الـ slug = تدوير توكن/سر، لا مستأجر جديد
        target: tenants.slug,
        set: {
          botTokenEncrypted: encryptedToken,
          botUsername: bot.username,
          botWebhookSecret: webhookSecret,
          updatedAt: new Date(),
        },
      });

    let webhookUrl: string | null = null;
    if (!values["skip-webhook"]) {
      if (!env.PUBLIC_URL) {
        throw new Error("PUBLIC_URL env is required to register the webhook (or pass --skip-webhook for dev long-polling)");
      }
      webhookUrl = `${env.PUBLIC_URL.replace(/\/$/, "")}/tg/${slug}`;
      await registerWebhook(token, webhookUrl, webhookSecret);
    }

    console.log(
      JSON.stringify(
        {
          action: "tenant_provisioned",
          slug,
          botUsername: bot.username,
          webhook: webhookUrl ?? "skipped (dev long-polling)",
        },
        null,
        2,
      ),
    );
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  // رسالة الخطأ فقط — أي stack قد يحمل قيماً حساسة من مكتبات خارجية
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
