#!/usr/bin/env node
// F01 前台目标识别探针：只读窗口标题、前台应用、线程索引，输出候选映射。
// 不激活窗口、不注入输入、不读取会话正文。
// 用法:
//   node probe-front-target.mjs            # 快照
//   node probe-front-target.mjs --watch 30 # 采样 30 秒，记录切换
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS = path.join(ROOT, "tests/codex-probe/tools");
const BIN = "/tmp/codex-probe-winlist";
const LOG_DIR = path.join(ROOT, "tests/codex-probe/logs");
const HOME = process.env.HOME;

const args = process.argv.slice(2);
const watchIndex = args.indexOf("--watch");
const watchSeconds = watchIndex >= 0 ? Number(args[watchIndex + 1] || 30) : 0;

const hash = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const logPath = path.join(LOG_DIR, `F01-front-${Date.now()}-${process.pid}.jsonl`);
const stream = fs.createWriteStream(logPath, { flags: "w" });
const log = (o) => stream.write(JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");

function ensureBinary() {
  if (fs.existsSync(BIN)) return;
  const src = path.join(TOOLS, "winlist.swift");
  fs.mkdirSync("/tmp/codex-modcache", { recursive: true });
  execFileSync("swiftc", ["-module-cache-path", "/tmp/codex-modcache", src, "-o", BIN], { stdio: "pipe", timeout: 120000 });
}

function windows(filter = "ChatGPT") {
  const out = execFileSync(BIN, [filter], { encoding: "utf8", timeout: 10000 });
  return out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function frontApp() {
  try {
    const asn = execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
    const read = (key) => {
      const out = execFileSync("lsappinfo", ["info", "-only", key, asn], { encoding: "utf8" });
      const m = out.match(/"([^"]*)"/);
      return m ? m[1] : null;
    };
    return { name: read("name"), bundleId: read("bundleID") };
  } catch {
    return { name: null, bundleId: null };
  }
}

function loadThreads() {
  const index = path.join(HOME, ".codex/session_index.jsonl");
  const byName = new Map();
  const lines = fs.readFileSync(index, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec.thread_name || !rec.id) continue;
    const list = byName.get(rec.thread_name) ?? [];
    if (!list.includes(rec.id)) list.push(rec.id);
    byName.set(rec.thread_name, list);
  }
  const state = JSON.parse(fs.readFileSync(path.join(HOME, ".codex/.codex-global-state.json"), "utf8"));
  const activity = state["electron-persisted-atom-state"]?.["thread-user-activity-times-v1"] ?? {};
  return { byName, activity };
}

function snapshot() {
  const front = frontApp();
  const wins = windows("ChatGPT");
  const { byName, activity } = loadThreads();
  const rows = wins.map((w) => {
    const ids = byName.get(w.title) ?? [];
    const recent = ids
      .map((id) => activity[`["local","${id}"]`])
      .filter(Boolean)
      .sort((a, b) => b - a)[0];
    return {
      windowNumber: w.number,
      titleHash: hash(w.title),
      titleLength: w.title.length,
      bounds: w.bounds,
      exactMatches: ids.length,
      threadIds: ids.slice(0, 3),
      lastUserActivity: recent ? new Date(recent).toISOString() : null,
    };
  });
  let status = "目标未确认";
  let reason = "";
  const isChatGPT = front.bundleId === "com.openai.codex";
  if (!isChatGPT) {
    reason = `前台应用是 ${front.name ?? "未知"}（${front.bundleId ?? "无 bundleID"}），不是 ChatGPT`;
  } else if (rows.length === 0) {
    reason = "ChatGPT 在前台但没有可见窗口";
  } else if (rows.length > 1) {
    reason = `ChatGPT 有 ${rows.length} 个可见窗口，需要用户指定`;
  } else if (rows[0].exactMatches === 0) {
    reason = "窗口标题在线程索引中无精确匹配";
  } else if (rows[0].exactMatches > 1) {
    reason = `窗口标题对应 ${rows[0].exactMatches} 个线程，标题不足以唯一识别`;
  } else {
    status = "候选目标（标题唯一匹配，需人工确认）";
    reason = "前台为 ChatGPT，窗口标题精确对应唯一线程";
  }
  return { front, status, reason, windows: rows };
}

async function main() {
  ensureBinary();
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (!watchSeconds) {
    const snap = snapshot();
    log({ kind: "snapshot", ...snap });
    console.log(JSON.stringify(snap, null, 2));
    return;
  }
  const deadline = Date.now() + watchSeconds * 1000;
  let previous = null;
  log({ kind: "watch_start", seconds: watchSeconds });
  while (Date.now() < deadline) {
    const snap = snapshot();
    const key = JSON.stringify({
      front: snap.front,
      windows: snap.windows.map((w) => [w.windowNumber, w.titleHash, w.threadIds]),
    });
    if (key !== previous) {
      log({ kind: "change", ...snap });
      console.log(JSON.stringify({ t: new Date().toISOString(), ...snap }));
      previous = key;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  log({ kind: "watch_end" });
}

try {
  await main();
  stream.end();
  console.log(`\nlog: ${logPath}`);
} catch (e) {
  log({ kind: "error", message: String(e).slice(0, 300) });
  stream.end();
  console.error(String(e));
  process.exit(1);
}
