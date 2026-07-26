import { parseArgs } from "node:util";
import { adminUsers, clearAdminTotpSecret, createDb } from "@quickdrop/db";
import { parseEnv } from "@quickdrop/shared";
import { z } from "zod";
import { hashPassword } from "../auth/hashing.js";

// §10.2 + E1 — إنشاء مشرف منصة (يدوي؛ لا تسجيل ذاتي — المشرف = أنت). admin_users جدول
// منصة بلا مستأجر (استثناء RLS §2.3):
//   pnpm create-admin -- --email you@quickdrop.app --password '••••'
//   pnpm create-admin -- --email you@quickdrop.app --reset-totp   (استرداد قفل 2FA)
// upsert على email = إعادة تعيين كلمة السر/إعادة تفعيل، لا مشرف مكرر. كلمة السر لا تُطبع (§11).
// --reset-totp يصفّر سرّ TOTP → يفرض إعادة التفعيل عند الدخول التالي (جهاز مفقود = لا قفل دائم).

const env = parseEnv(
  z.object({
    DATABASE_URL: z.string().url(),
  }),
);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      password: { type: "string" },
      "reset-totp": { type: "boolean" },
    },
  });

  const email = values.email?.trim().toLowerCase();
  const resetTotp = values["reset-totp"] === true;
  const password = values.password;

  if (!email) {
    console.error("usage: create-admin --email <email> (--password <pw> | --reset-totp)");
    process.exitCode = 1;
    return;
  }

  // E1 — استرداد قفل 2FA: يصفّر سرّ TOTP فقط (بلا كلمة سر)، يفرض إعادة التفعيل
  if (resetTotp) {
    const handle = createDb(env.DATABASE_URL);
    try {
      const ok = await clearAdminTotpSecret(handle.db, email);
      if (!ok) {
        console.error(`no admin found for ${email}`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ action: "admin_totp_reset", email }, null, 2));
    } finally {
      await handle.close();
    }
    return;
  }

  if (!password) {
    console.error("usage: create-admin --email <email> --password <pw>");
    process.exitCode = 1;
    return;
  }
  if (password.length < 8) {
    console.error("password must be at least 8 characters");
    process.exitCode = 1;
    return;
  }

  const handle = createDb(env.DATABASE_URL);
  try {
    const passwordHash = await hashPassword(password);
    await handle.db
      .insert(adminUsers)
      .values({ email, passwordHash })
      .onConflictDoUpdate({
        target: adminUsers.email,
        set: { passwordHash, isActive: true },
      });

    console.log(JSON.stringify({ action: "admin_created", email }, null, 2));
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
