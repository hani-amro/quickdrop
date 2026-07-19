import type { StaffRole } from "@quickdrop/shared";

// دمج WaFlow (MERGE_PLAN §23/R-09) — خريطة أدوار WaFlow → أدوار طاقم QuickDrop. دالة نقية
// يستهلكها استيراد الطاقم (Phase 5، اختياري — WaFlow prod تجريبي). المصادقة نفسها موحّدة
// الآن (هاش bcrypt يُتحقّق ويُرقّى argon2id كسولاً عند الدخول — apps/api/auth/hashing).
//
// WaFlow UserRole: owner | admin | agent (schema.prisma). QuickDrop STAFF_ROLES:
// owner | dispatcher | accountant | support. الخريطة (الأضيق أماناً عند الشك):
//   owner → owner (المالك)؛ admin → dispatcher (مدير عمليات)؛ agent → support (خدمة
//   الزبائن، القناة الأساسية بـ WaFlow)؛ مجهول → support (أقل صلاحية، لا accountant/owner).

export function mapWaflowRole(waflowRole: string): StaffRole {
  switch (waflowRole) {
    case "owner":
      return "owner";
    case "admin":
      return "dispatcher";
    case "agent":
      return "support";
    default:
      return "support"; // مجهول → أقل صلاحية (لا يُمنح accountant/owner بالخطأ)
  }
}
