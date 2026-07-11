import type { Metadata } from "next";
import { BroadcastsPanel } from "@/components/BroadcastsPanel";

export const metadata: Metadata = { title: "البث — QuickDrop" };

// §4.3/§14 — شاشة البث: نموذج إرسال + قائمة البثات السابقة بعدّاداتها.
export default function BroadcastsPage() {
  return <BroadcastsPanel />;
}
