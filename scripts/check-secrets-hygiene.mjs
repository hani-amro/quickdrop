#!/usr/bin/env node
// §0 MERGE_PLAN — حارس نظافة الأسرار (حاجب بالـ CI وقابل للتشغيل محلياً):
// (1) شجرة WaFlow القديمة (WhatsApp_SASS/) فيها أسرار حية بنص صريح — ممنوع يدخل
//     منها أي ملف للفهرس، و.gitignore لازم يبقى مستثنيها.
// (2) لا ملفات أسرار معروفة الشكل متتبعة (.env غير example، نسخ قواعد، rdb dumps).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const failures = [];

// (1a) .gitignore لازم يحتوي سطر WhatsApp_SASS/
const gitignore = readFileSync(".gitignore", "utf8");
if (!/^WhatsApp_SASS\/$/m.test(gitignore)) {
  failures.push(".gitignore no longer excludes WhatsApp_SASS/ — the legacy tree contains live secrets");
}

// (1b) لا ملف متتبع تحت WhatsApp_SASS/
const trackedLegacy = git("ls-files", "WhatsApp_SASS");
if (trackedLegacy !== "") {
  failures.push(`tracked files under WhatsApp_SASS/ (must be zero):\n${trackedLegacy}`);
}

// (2) أنماط ملفات أسرار ممنوع تتبعها إطلاقاً
const tracked = git("ls-files").split("\n");
const FORBIDDEN = [
  { re: /(^|\/)\.env(\..+)?$/, allow: /\.example$/, why: "real .env file" },
  { re: /_db_backup.*\.sql$/, allow: null, why: "database backup dump" },
  { re: /\.rdb$/, allow: null, why: "Redis dump" },
  { re: /(^|\/)(id_rsa|id_ed25519)(\..+)?$/, allow: /\.pub$/, why: "private key" },
  { re: /\.(pem|p12|pfx)$/, allow: null, why: "key/cert material" },
];
for (const file of tracked) {
  for (const rule of FORBIDDEN) {
    if (rule.re.test(file) && !(rule.allow && rule.allow.test(file))) {
      failures.push(`tracked ${rule.why}: ${file}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Secrets hygiene FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("Secrets hygiene passed");
