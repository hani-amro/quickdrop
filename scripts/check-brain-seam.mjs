#!/usr/bin/env node
// D8/§4.2 (قائمة المالك الحاجبة، البند 2) — حارس المفصل الحدثي (حاجب بالـ CI):
// الدماغان يتكاملان **بالأحداث حصراً** — كود Brain A (المنقول من WaFlow: واتساب، وكيل
// الـ AI، الرحلات، الدماغ، الدفع، CRM) ممنوع أن يستدعي كود الإسناد (Brain B) مباشرة.
// الوصلة الوحيدة = صف outbox 'order.ready_for_dispatch' من ختم transition() (D-M1).
// أي استيراد/استدعاء مباشر جديد = فشل CI فوري — الحارس الذي يمنع «زحف النداءات» R-17.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

// ملفات/أشجار Brain A (تُوسَّع مع كل نقل جديد — أضف هنا لا تستثنِ)
const BRAIN_A_ROOTS = [
  "packages/ai/src",
  "packages/whatsapp/src",
  "packages/brain/src",
  "apps/api/src/wa-gateway",
  "apps/api/src/payments",
  "apps/api/src/crm",
  "apps/api/src/journeys",
];
const BRAIN_A_FILES = [
  "apps/worker/src/wa-update-processor.ts",
  "apps/worker/src/agent-invoker.ts",
  "apps/worker/src/journeys-consumer.ts",
  "apps/worker/src/journeys-sweep.ts",
  "apps/worker/src/brain-consumer.ts",
  "apps/worker/src/brain-sweep.ts",
  "packages/db/src/journeys-service.ts",
  "packages/db/src/conversations-service.ts",
  "packages/db/src/crm-read.ts",
  "packages/db/src/audience.ts",
  "packages/db/src/payments.ts",
  "packages/db/src/ai-budget.ts",
  "packages/db/src/support.ts",
];

// رموز/مسارات الإسناد المحظورة على Brain A — دوال المحرك، طابوره، ومعرّفات مهامه
const FORBIDDEN = [
  { name: "dispatch engine call", re: /\b(startRound|acceptOffer|assignManually|handleOfferTimeout|createDispatchProcessor|findCandidates)\s*\(/ },
  { name: "dispatch module import", re: /from\s+["'][^"']*\/dispatch(-worker)?\.js["']/ },
  { name: "dispatch queue access", re: /\bDISPATCH_QUEUE\b|\bdispatchOrderJobId\s*\(|\bofferTimeoutJobId\s*\(/ },
];

const TEST_RE = /\.(test|spec)\.(ts|tsx)$/;
const SOURCE_RE = /\.(ts|tsx|mts|cts)$/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (SOURCE_RE.test(entry) && !TEST_RE.test(entry)) yield full;
  }
}

const files = [];
for (const root of BRAIN_A_ROOTS) {
  const abs = join(ROOT, root);
  if (existsSync(abs)) files.push(...walk(abs));
}
for (const f of BRAIN_A_FILES) {
  const abs = join(ROOT, f);
  if (existsSync(abs)) files.push(abs);
}

const violations = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (const rule of FORBIDDEN) {
    lines.forEach((line, i) => {
      if (rule.re.test(line)) {
        violations.push(`${relative(ROOT, file)}:${i + 1} — ${rule.name}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error("Brain seam guard FAILED — Brain A must reach dispatch ONLY via the order.ready_for_dispatch event (D8/§4.2):");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`Brain seam guard passed (${files.length} Brain-A files, event-only integration)`);
