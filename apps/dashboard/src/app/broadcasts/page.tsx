import type { Metadata } from "next";
import { BroadcastsPanel } from "@/components/BroadcastsPanel";
import { getServerT } from "@/lib/i18n/server-t";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getServerT();
  return { title: `${t("page.broadcastsTitle")} — QuickDrop` };
}

// §4.3/§14 — شاشة البث: نموذج إرسال + قائمة البثات السابقة بعدّاداتها.
export default function BroadcastsPage() {
  return <BroadcastsPanel />;
}
