#!/usr/bin/env node
// F03-P 只读待确认查询：读取指定会话的 rollout，输出 pending / none / unknown。
// 不操作 UI、不写会话、不回答任何请求。
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parsePendingRequests } from "../../server/codex-probe/lib/pending-requests.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WINLIST = "/tmp/codex-probe-winlist";
const argv = process.argv.slice(2);
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const THREAD = arg("--thread");
if (!THREAD) {
  console.error("usage: f03-pending.mjs --thread <threadId>");
  process.exit(64);
}

const LOG_DIR = path.join(ROOT, "tests/codex-probe/logs");
const logPath = path.join(LOG_DIR, `F03-pending-${Date.now()}-${process.pid}.jsonl`);
const stream = fs.createWriteStream(logPath, { flags: "w" });
const log = (o) => stream.write(JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

function rolloutFor(threadId) {
  const root = path.join(process.env.HOME, ".codex/sessions");
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (name.includes(threadId) && name.endsWith(".jsonl")) return full;
    }
  }
  return null;
}

function frontBinding(threadId) {
  try {
    const asn = execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
    const info = execFileSync("lsappinfo", ["info", "-only", "bundleID", asn], { encoding: "utf8" });
    const bundle = (info.match(/"([^"]*)"/) ?? [])[1] ?? null;
    if (bundle !== "com.openai.codex") return { state: "not-front", bundle };
    const wins = execFileSync(WINLIST, ["ChatGPT"], { encoding: "utf8" }).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    if (wins.length !== 1) return { state: wins.length ? "multi-window" : "no-window" };
    const byTitle = new Map();
    for (const l of fs.readFileSync(path.join(process.env.HOME, ".codex/session_index.jsonl"), "utf8").split("\n")) {
      if (!l.trim()) continue;
      let r;
      try { r = JSON.parse(l); } catch { continue; }
      if (r.thread_name && r.id) byTitle.set(r.thread_name, [...(byTitle.get(r.thread_name) ?? []), r.id]);
    }
    const ids = byTitle.get(wins[0].title) ?? [];
    if (ids.length === 1 && ids[0] === threadId) return { state: "front-match" };
    return { state: "front-mismatch", matched: ids.length };
  } catch {
    return { state: "unknown" };
  }
}

function readStable(file) {
  const before = fs.statSync(file);
  const text = fs.readFileSync(file, "utf8");
  const after = fs.statSync(file);
  const lines = text.split("\n");
  const last = lines[lines.length - 1];
  let partial = false;
  if (last && last.trim()) {
    try { JSON.parse(last); } catch { partial = true; }
  }
  const stable = before.size === after.size && before.mtimeMs === after.mtimeMs;
  return { lines, complete: stable && !partial, lag: !stable || partial, size: after.size };
}

function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = rolloutFor(THREAD);
  if (!file) {
    log({ kind: "result", status: "unknown", reason: "rollout-not-found", thread: THREAD });
    console.log(JSON.stringify({ status: "unknown", reason: "rollout-not-found", thread: THREAD }, null, 2));
    return;
  }
  const bindingBefore = frontBinding(THREAD);
  const read = readStable(file);
  const binding = frontBinding(THREAD);
  const bindingChanged = bindingBefore.state !== binding.state;
  // 当前没有实时来源，也没有可证实的关闭协议：只做历史候选展示。
  // 生产观察器只有日志来源，没有实时/关闭协议入口。
  const parsed = parsePendingRequests(read.lines, { threadId: THREAD, complete: read.complete, lag: read.lag });
  // 目标身份未由前台窗口核实时，整体降级为 unknown，但保留日志中发现的条目供查看。
  const result = binding.state === "front-match" && !bindingChanged
    ? parsed
    : {
        ...parsed,
        status: "unknown",
        reason: bindingChanged ? "target-changed" : `target-${binding.state}`,
        binding,
        bindingBefore,
        promptCheckOnComputer: true,
      };

  const label = result.status === "pending" ? "有待确认" : result.status === "none" ? "没有待确认" : "无法判断";
  console.log(`目标: ${THREAD}`);
  console.log(`状态: ${label}`);
  console.log(`来源: rollout 只读（${path.basename(file)}）`);
  console.log(`目标身份: ${binding.state === "front-match" ? "前台窗口匹配" : `未确认（${binding.state}）`}`);
  console.log(`实时性: 日志观察，非实时同步`);
  if (result.reason) console.log(`原因: ${result.reason}`);
  if (result.entries?.length) {
    console.log(`\n历史候选: ${result.entries.length} 项（当前有效性未知，均不可回答）`);
    result.entries.forEach((e, i) => {
      const kind = e.kind === "unsupported" ? "工具审批/未知类型（需电脑处理）" : "普通澄清";
      console.log(`\n[${i + 1}] ${kind}（历史候选，需电脑核对）`);
      e.questions.forEach((q, j) => {
        console.log(`  问题 ${j + 1}: ${q.question ?? "（无正文）"}`);
        if (q.options.length) console.log(`    选项: ${q.options.join(" / ")}`);
      });
      if (!e.questions.length) console.log("  问题正文不可用");
      console.log(`  关联: turn=${e.turnId ?? "未知"} call=${e.callId ?? "缺失"}${e.reason ? ` 原因=${e.reason}` : ""}`);
    });
    console.log("\n请到电脑上核对当前会话；本工具不宣称这些候选仍然有效。");
  }
  if (result.duplicates) console.log(`重复记录已合并: ${result.duplicates} 条`);

  log({
    kind: "result",
    status: result.status,
    reason: result.reason ?? null,
    entryCount: result.entries.length,
    duplicates: result.duplicates ?? 0,
    candidates: Boolean(result.entries?.length),
    kinds: result.entries.map((e) => e.kind),
    answerable: result.entries.map((e) => e.answerable),
    questionHashes: result.entries.map((e) => e.questions.map((q) => hash(q.question ?? ""))),
    thread: THREAD,
    binding: binding.state,
    freshness: "log-only",
    bindingChanged,
    file: path.basename(file),
    bytes: read.size,
  });
  stream.end();
}

try {
  main();
} catch (e) {
  log({ kind: "error", message: String(e).slice(0, 200) });
  stream.end();
  console.error(String(e));
  process.exit(1);
}
