import { parseArgs } from "node:util";
import { adminUsers, createDb } from "@quickdrop/db";
import { parseEnv } from "@quickdrop/shared";
import { z } from "zod";
import { hashPassword } from "../auth/hashing.js";

// §10.2 — إنشاء مشرف منصة (يدوي؛ لا تسجيل ذاتي — المشرف = أنت). admin_users جدول
// منصة بلا مستأجر (استثناء RLS §2.3):
//   pnpm create-admin -- --email you@quickdrop.app --password '••••'
// upsert على email = إعادة تعيين كلمة السر/إعادة تفعيل، لا مشرف مكرر. كلمة السر لا تُطبع (§11).

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
    },
  });

  const email = values.email?.trim().toLowerCase();
  const password = values.password;
  if (!email || !password) {
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
