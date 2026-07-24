import type { Metadata } from "next";
import { NewOrderForm } from "@/components/NewOrderForm";
import { getServerT } from "@/lib/i18n/server-t";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getServerT();
  return { title: `${t("page.newOrderTitle")} — QuickDrop` };
}

// D15 — شاشة إنشاء طلب يدوي (زبون التلفون): مرحلة 1، ليست رفاهية (§10.1 v1.1).
export default async function NewOrderPage() {
  const t = await getServerT();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-bold text-slate-900">{t("page.newOrderHeading")}</h1>
      <NewOrderForm />
    </div>
  );
}
