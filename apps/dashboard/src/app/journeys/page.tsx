import { JourneysManager } from "@/components/JourneysManager";

// دمج WaFlow (§24) — صفحة الرحلات: إدارة محرك الأتمتة (P2.5) عبر /api/journeys خلف
// البروكسي (لا DB بالواجهة). المُطلِّقات من allowlist الخادم.
export default function JourneysPage() {
  return <JourneysManager />;
}
