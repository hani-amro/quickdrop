#!/usr/bin/env node
// D5/D11 — حارس المال الستاتيكي (حاجب بالـ CI): يمنع أي float/parseFloat/تنسيق كسري
// على المال في الكود المصدري. المال = BIGINT بأصغر وحدة حصراً، والتسعير من محرك
// التسعير الخادمي فقط. أي استثناء جديد هنا قرار معماري يُكتب بالوثيقة أولاً.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".turbo", "coverage", "migrations"]);
const SOURCE_RE = /\.(ts|tsx|mts|cts)$/;
const TEST_RE = /\.(test|spec)\.(ts|tsx)$/;

// أسماء الحقول المالية — مطابقة على حدود مقاطع snake_case/camelCase:
// "cod" و"codAmount" و"price_total" تُمسك؛ "publicCode" و"trackingCode" لا.
const MONEY_TERMS = "price|amount|total|fee|cost|cod|goods|wallet|spent|revenue|balance|subtotal|tax";
const MONEY_TERMS_CAP = MONEY_TERMS.replace(/(^|\|)([a-z])/g, (_, sep, ch) => `${sep}${ch.toUpperCase()}`);
const MONEY_ID = `(?:(?<![A-Za-z])(?:${MONEY_TERMS})|(?:${MONEY_TERMS_CAP}))(?![a-z])`;

const RULES = [
  {
    name: "parseFloat is banned everywhere (money or not — use integer parsing or toMinor)",
    re: /\bparseFloat\s*\(/,
    appliesTo: () => true,
  },
  {
    name: "float formatting on a money identifier (.toFixed on price/amount/total/…)",
    re: new RegExp(`${MONEY_ID}[A-Za-z0-9_]*\\s*(\\)|\\])?\\s*\\.toFixed\\s*\\(`),
    appliesTo: () => true,
  },
  {
    name: "Number() coercion of a money identifier (Decimal→float drift)",
    re: new RegExp(`\\bNumber\\s*\\([^)]*${MONEY_ID}`),
    appliesTo: () => true,
  },
  {
    name: "float column type in Drizzle schema (money must be money()/bigint; rates must be *_bp integers)",
    re: /\b(numeric|decimal|real)\s*\(/,
    appliesTo: (file) => file.includes(join("packages", "db", "src", "schema")),
  },
  {
    name: "doublePrecision outside the named non-money allowlist (rating_avg, speed_kmh)",
    re: /\bdoublePrecision\s*\(\s*"(?!rating_avg"|speed_kmh")/,
    appliesTo: (file) => file.includes(join("packages", "db", "src", "schema")),
  },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (SOURCE_RE.test(entry) && !TEST_RE.test(entry)) yield full;
  }
}

const failures = [];
for (const scanRoot of SCAN_ROOTS) {
  for (const file of walk(join(ROOT, scanRoot))) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.includes("money-guard-ignore")) return; // استثناء صريح مرئي بالمراجعة
      for (const rule of RULES) {
        if (rule.appliesTo(file) && rule.re.test(line)) {
          failures.push(`${rel}:${i + 1} — ${rule.name}\n    ${line.trim()}`);
        }
      }
    });
  }
}

if (failures.length > 0) {
  console.error(`Money guard FAILED (${failures.length} violation${failures.length > 1 ? "s" : ""}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("Money guard (static) passed");
