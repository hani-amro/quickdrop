import { defineConfig } from "vitest/config";

// اختبارات التكامل الحيّة بهذه الحزمة (outbox-poller/wa-update/brain-*) تتشارك قاعدة
// Postgres واحدة، وبعضها يمسح عابر المستأجرين (pollOnce يقرأ outbox لكل المستأجرين).
// تشغيل الملفات بالتوازي (افتراضي vitest) يجعل صفوف outbox لملفٍ تظهر لمسح ملفٍ آخر
// (رأينا "طول 3 بدل 1"). لذلك الملفات تسلسلية — نفس نمط packages/db.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
