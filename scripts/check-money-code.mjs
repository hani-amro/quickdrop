#!/usr/bin/env node
// D5/D11 — حارس المال الستاتيكي (حاجب بالـ CI): يمنع float/parseFloat/تنسيق كسري على
// المال بالكود المصدري. المال = BIGINT بأصغر وحدة حصراً، والتسعير من محرك التسعير
// الخادمي فقط. أي استثناء جديد = قرار معماري يُكتب بالوثيقة، أو سطر بتعليق
// `money-guard-ignore` مرئي بالمراجعة.
//
// حدود معروفة (قُوّيت بعد مراجعة Phase 1 العدائية): الفحص نصّي (regex)، فيتهرّب منه
// **التسمية الوسيطة** (`const x = order.total; Number(x)`) لأنها تتطلب تحليل أنواع.
// الحارس الحقيقي الدائم لـ D5 هو حارس السكيما (packages/db/scripts/check-money.ts):
// عمود المال لا يمكن أن يكون float **في القاعدة** مهما فعل الكود. هذا الحارس دفاعٌ
// بالعمق ضد حساب float **أثناء النقل**، لا بديلٌ عن حارس السكيما.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".turbo", "coverage", "migrations"]);
const SOURCE_RE = /\.(ts|tsx|mts|cts)$/;
const TEST_RE = /\.(test|spec)\.(ts|tsx)$/;

// أسماء الحقول المالية — مفرد وجمع صريحان (الجمع أُضيف بعد مراجعة Phase 1: 'fees'
// و'prices' و'orderTotals' كانت تتهرّب). الأطول أولاً كي تفوز alternation. 'cod'
// مفرد فقط عمداً (تجنّب 'codes'/'public_code'). المطابقة على حدود المقاطع:
// 'codAmount'/'price_total'/'orderTotals' تُمسك؛ 'publicCode'/'trackingCode' لا.
const MONEY_TERMS = [
  "prices", "price", "amounts", "amount", "subtotals", "subtotal", "totals", "total",
  "fees", "fee", "costs", "cost", "goods", "wallets", "wallet", "spent",
  "revenues", "revenue", "balances", "balance", "taxes", "tax", "cod",
].join("|");
const cap = (terms) => terms.replace(/(^|\|)([a-z])/g, (_, sep, ch) => `${sep}${ch.toUpperCase()}`);
// فرعان: مصطلح بحدّ يسار غير-حرف (snake_case/بداية)، أو مصطلح مكبّر أول حرف (camelCase suffix)
const MONEY_ID = `(?:(?<![A-Za-z])(?:${MONEY_TERMS})|(?:${cap(MONEY_TERMS)}))(?![a-z])`;

const RULES = [
  {
    name: "parseFloat is banned everywhere (use integer parsing / toMinor)",
    re: /\bparseFloat\s*\(/,
    perLine: true,
  },
  {
    // بعد المعرّف المالي أي شيء ثم .toFixed — يمسك '(total / 100).toFixed(2)' وليس فقط 'total.toFixed'
    name: "fractional formatting of money (.toFixed after a money identifier)",
    re: new RegExp(`${MONEY_ID}[^;]*?\\.toFixed\\s*\\(`),
    perLine: true,
  },
  {
    // تنسيق العملة بـ toLocaleString على المال (نفس خطيئة toFixed — كسور عائمة للعرض)
    name: "fractional formatting of money (.toLocaleString after a money identifier)",
    re: new RegExp(`${MONEY_ID}[^;]*?\\.toLocaleString\\s*\\(`),
    perLine: true,
  },
  {
    // Number(...money...) — يُفحص على كامل الملف كي يمسك lf داخل الأقواس (Prettier wrap)
    name: "Number() coercion of a money identifier (Decimal/BigInt → float drift)",
    re: new RegExp(`\\bNumber\\s*\\([^;{}]*?${MONEY_ID}`),
    wholeFile: true,
  },
  {
    // + أحادي (coercion) مباشرة على معرّف مالي بعد فاصل/مُشغّل — يماثل Number()
    name: "unary + coercion of a money identifier",
    re: new RegExp(`(?:[=,([:?]|=>|&&|\\|\\||return)\\s*\\+\\s*[A-Za-z0-9_.$\\[\\]]*${MONEY_ID}`),
    wholeFile: true,
  },
  {
    name: "float column type in Drizzle schema (money must be money()/bigint; rates = *_bp integers)",
    re: /\b(numeric|decimal|real)\s*\(/,
    perLine: true,
    files: (file) => file.includes(join("packages", "db", "src", "schema")),
  },
  {
    name: "doublePrecision outside the named non-money allowlist (rating_avg, speed_kmh)",
    re: /\bdoublePrecision\s*\(\s*"(?!rating_avg"|speed_kmh")/,
    perLine: true,
    files: (file) => file.includes(join("packages", "db", "src", "schema")),
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

/** رقم السطر لموضع char داخل نص كامل. */
function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") n += 1;
  return n;
}

const failures = [];
for (const scanRoot of SCAN_ROOTS) {
  for (const file of walk(join(ROOT, scanRoot))) {
    const rel = relative(ROOT, file);
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);

    for (const rule of RULES) {
      if (rule.files && !rule.files(file)) continue;

      if (rule.perLine) {
        lines.forEach((line, i) => {
          if (line.includes("money-guard-ignore")) return;
          if (rule.re.test(line)) failures.push(`${rel}:${i + 1} — ${rule.name}\n    ${line.trim()}`);
        });
      } else if (rule.wholeFile) {
        // fresh regex بعلم g كي نمرّ على كل التطابقات ونحدّد أسطرها
        const g = new RegExp(rule.re.source, "g");
        let m;
        while ((m = g.exec(text)) !== null) {
          const ln = lineOf(text, m.index);
          if (lines[ln - 1]?.includes("money-guard-ignore")) continue;
          failures.push(`${rel}:${ln} — ${rule.name}\n    ${(lines[ln - 1] ?? "").trim()}`);
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`Money guard FAILED (${failures.length} violation${failures.length > 1 ? "s" : ""}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("Money guard (static) passed");
