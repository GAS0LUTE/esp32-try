// 证据日志：字段白名单 + 本机信息脱敏。只输出可共享的测试事实。
import fs from "node:fs";
import os from "node:os";

const HOME = os.homedir();

const escapeRegExp = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SCRUB = [
  [new RegExp(escapeRegExp(HOME), "g"), "~"],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted-key]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]"],
];

export function scrub(value) {
  if (typeof value === "string") {
    let s = value;
    for (const [pattern, replacement] of SCRUB) s = s.replace(pattern, replacement);
    return s;
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v);
    return out;
  }
  return value;
}

export function createLogger(filePath, { allowedFields } = {}) {
  const stream = fs.createWriteStream(filePath, { flags: "w" });
  const allow = allowedFields ? new Set(allowedFields) : null;
  return {
    path: filePath,
    log(obj) {
      const picked = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === "t") continue;
        if (allow && !allow.has(k)) continue;
        if (v === undefined) continue;
        picked[k] = v;
      }
      const line = { t: new Date().toISOString(), ...scrub(picked) };
      stream.write(JSON.stringify(line) + "\n");
    },
    async close() {
      await new Promise((resolve) => stream.end(resolve));
    },
  };
}

export const DEFAULT_FIELDS = [
  "step", "kind", "method", "itemType", "status", "ok", "code", "error",
  "threadId", "turnId", "requestId", "text", "deltaLen", "count", "ids",
  "decision", "action", "scenario", "binary", "version", "note", "reason",
  "exitCode", "durationMs", "assertion", "result", "unparsed",
];
