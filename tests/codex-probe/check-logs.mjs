#!/usr/bin/env node
// D06：扫描证据日志中的本机信息，并可生成脱敏副本。
// 用法: node check-logs.mjs [--sanitize]
// 退出码：发现敏感项且未脱敏时为 1；干净或已生成副本时为 0。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOG_DIR = path.join(ROOT, "tests/codex-probe/logs");
const OUT_DIR = path.join(LOG_DIR, "redacted");
const sanitize = process.argv.includes("--sanitize");

const HOME = os.homedir();
const HOST = os.hostname();
const patterns = [
  { name: "home-path", re: new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), replace: "~" },
  { name: "macos-temp", re: /\/private\/var\/folders\/[^\s"]+/g, replace: "~tmp" },
  { name: "hostname", re: new RegExp(HOST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), replace: "[host]" },
  { name: "installation-id", re: /"installationId":"[^"]+"/g, replace: '"installationId":"[redacted]"' },
  { name: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replace: "[email]" },
  { name: "api-key", re: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replace: "[key]" },
  { name: "bearer", re: /Bearer\s+[A-Za-z0-9._-]{8,}/g, replace: "Bearer [redacted]" },
];

const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".jsonl") || f.endsWith(".json")).sort();
let totalHits = 0;
const flagged = [];

for (const file of files) {
  const full = path.join(LOG_DIR, file);
  const text = fs.readFileSync(full, "utf8");
  let out = text;
  const hits = [];
  for (const p of patterns) {
    const found = text.match(p.re);
    if (found?.length) {
      hits.push({ pattern: p.name, count: found.length });
      out = out.replace(p.re, p.replace);
    }
  }
  totalHits += hits.length;
  if (hits.length) {
    console.log(`${file}: ${hits.map((h) => `${h.pattern}×${h.count}`).join(", ")}`);
    if (sanitize) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, file), out);
    }
  }
}

if (sanitize) {
  console.log(`\n已生成脱敏副本: ${path.relative(ROOT, OUT_DIR)}/`);
  console.log("共享范围：脱敏副本可用于审查；原日志保留本机路径与主机名，不用于公开分享。");
  process.exit(0);
}

if (totalHits === 0) {
  console.log("未发现本机路径、主机名、凭证或邮箱。");
  process.exit(0);
}
const missing = flagged.filter((f) => !fs.existsSync(path.join(OUT_DIR, f)));
if (missing.length === 0) {
  console.log("\n发现本机信息，均已有脱敏副本；原日志不公开分享。");
  process.exit(0);
}
console.log(`\n以下文件缺少脱敏副本：${missing.join(", ")}`);
console.log("使用 --sanitize 生成脱敏副本。");
process.exit(1);
