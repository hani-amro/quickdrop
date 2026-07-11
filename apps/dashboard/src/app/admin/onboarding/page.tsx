import type { Metadata } from "next";
import { OnboardingWizard } from "@/components/admin/OnboardingWizard";

export const metadata: Metadata = { title: "إضافة مستأجر — كونسول المشرف" };

// §14 — معالج onboarding ذاتي الخدمة: بيانات المكتب → ربط البوت → تأكيد.
export default function OnboardingPage() {
  return <OnboardingWizard />;
}
