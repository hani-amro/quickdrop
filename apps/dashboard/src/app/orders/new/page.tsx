import type { Metadata } from "next";
import { NewOrderForm } from "@/components/NewOrderForm";

export const metadata: Metadata = { title: "طلب جديد — QuickDrop" };

// D15 — شاشة إنشاء طلب يدوي (زبون التلفون): مرحلة 1، ليست رفاهية (§10.1 v1.1).
export default function NewOrderPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-bold text-slate-900">إنشاء طلب يدوي</h1>
      <NewOrderForm />
    </div>
  );
}
