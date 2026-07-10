import type { Metadata } from "next";
import { DispatchBoard } from "@/components/DispatchBoard";

export const metadata: Metadata = { title: "الإرسال — QuickDrop" };

// §10.1 — الشاشة الافتراضية: الإرسال.
export default function DispatchPage() {
  return <DispatchBoard />;
}
