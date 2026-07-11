import type { Metadata } from "next";
import { TrackingView } from "@/components/TrackingView";

export const metadata: Metadata = { title: "تتبع الطلب — QuickDrop" };

// §7 — رابط التتبع العام /t/{token}: صفحة عامة لزائر مجهول (الزبون/المستلم — الفخ 16)
// بلا تنقّل الداشبورد (NavBar يخفي نفسه على /t/*) وبلا أي API آخر: كل البيانات من
// GET /public/track/{token} مباشرة من المتصفح (endpoint عام بلا auth — لا proxy ولا أسرار).
export default async function TrackingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params; // Next 15: params وعد
  return <TrackingView token={token} />;
}
