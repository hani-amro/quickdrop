import type { Metadata } from "next";
import { AnalyticsDashboard } from "@/components/AnalyticsDashboard";

export const metadata: Metadata = { title: "التحليلات — QuickDrop" };

// §13/§10 — شاشة التحليلات: بطاقات KPI + رسم أعمدة الطلبات الأسبوعي.
export default function AnalyticsPage() {
  return <AnalyticsDashboard />;
}
