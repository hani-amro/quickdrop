import { parseEnv } from "@quickdrop/shared";
import { z } from "zod";

// كل env vars تمر بـ Zod عند الإقلاع (§1) — الفشل صاخب وقبل فتح أي منفذ.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  // MASTER_KEY: 32 بايت hex (§4.2) — openssl rand -hex 32
  MASTER_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "MASTER_KEY must be 64 hex chars (32 bytes)"),
});

export type ApiEnv = z.infer<typeof envSchema>;

export function loadEnv(): ApiEnv {
  return parseEnv(envSchema);
}
