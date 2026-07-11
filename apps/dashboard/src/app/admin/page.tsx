import type { Metadata } from "next";
import { AdminTenantsTable } from "@/components/admin/AdminTenantsTable";

export const metadata: Metadata = { title: "المستأجرون — كونسول المشرف" };

// §10.2 — الشاشة الافتراضية للكونسول: قائمة المستأجرين مع الصحة والأفعال.
export default function AdminTenantsPage() {
  return <AdminTenantsTable />;
}
