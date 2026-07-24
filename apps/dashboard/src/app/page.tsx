import type { Metadata } from "next";
import { DispatchBoard } from "@/components/DispatchBoard";
import { getServerT } from "@/lib/i18n/server-t";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getServerT();
  return { title: `${t("page.dispatchTitle")} — QuickDrop` };
}

// §10.1 — الشاشة الافتراضية: الإرسال.
export default function DispatchPage() {
  return <DispatchBoard />;
}
