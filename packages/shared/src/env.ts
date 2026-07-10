import type { z } from "zod";

// كل تطبيق يعرّف zod schema لبيئته ويمرّرها هنا عند الإقلاع.
// الفشل صاخب ويسمّي الحقول الناقصة — بلا طباعة أي قيمة (أسرار).
export function parseEnv<T extends z.ZodTypeAny>(schema: T): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${fields}`);
  }
  return result.data as z.infer<T>;
}
