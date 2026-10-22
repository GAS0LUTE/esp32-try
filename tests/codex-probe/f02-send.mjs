#!/usr/bin/env node
// F02-S 发送入口：目标守卫 + 剪贴板全文校验 + 动态发送按钮 + 送达/回复确认。
// 默认 dry-run（只预演，不点击/不粘贴）；加 --send 才执行一次发送。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSendGuard } from "../../server/codex-probe/lib/send-target.mjs";
import { runSendFlow, SEND_STATE } from "../../server/codex-probe/lib/send-flow.mjs";
import { parseRolloutEvents } from "../../server/codex-probe/lib/rollout-events.mjs";
import { classifyReadback } from "../../server/codex-probe/lib/text-input.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PREFLIGHT = path.join(ROOT, "tests/codex-probe/f02-preflight.mjs");
const UI = "/tmp/codex-probe-ui";
const FINDBTN = "/tmp/codex-probe-findbtn";
const CLIP = "/tmp/codex-probe-clip";
const WINLIST = "/tmp/codex-probe-winlist";

const argv = process.argv.slice(2);
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const EXPECT = arg("--expect-thread");
const TEXT = arg("--text");
const WAIT_S = Number(arg("--wait") ?? 600);
const SEND = argv.includes("--send");
const CONFIRM_FOCUS = argv.includes("--confirm-focus");

const LOG_DIR = path.join(ROOT, "tests/codex-probe/logs");
const logPath = path.join(LOG_DIR, `F02-send-${Date.now()}-${process.pid}.jsonl`);
const stream = fs.createWriteStream(logPath, { flags: "w" });
const log = (o) => stream.write(JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!EXPECT) {
  console.error("missing --expect-thread");
  process.exit(64);
}

function frontBundle() {
  try {
    const asn = execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
    const out = execFileSync("lsappinfo", ["info", "-only", "bundleID", asn], { encoding: "utf8" });
    const m = out.match(/"([^"]*)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function windows() {
  const out = execFileSync(WINLIST, ["ChatGPT"], { encoding: "utf8" });
  return out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function threadsByTitle() {
  const map = new Map();
  for (const line of fs.readFileSync(path.join(process.env.HOME, ".codex/session_index.jsonl"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.thread_name && r.id) map.set(r.thread_name, [...(map.get(r.thread_name) ?? []), r.id]);
  }
  return map;
}

function sampler() {
  const byTitle = threadsByTitle();
  const wins = windows();
  return {
    capturedAt: Date.now(),
    frontBundleId: frontBundle(),
    windows: wins.map((w) => ({ windowNumber: w.number, threadIds: byTitle.get(w.title) ?? [], bounds: w.bounds })),
  };
}

function preflight() {
  const out = execFileSync(process.execPath, [PREFLIGHT], { encoding: "utf8", timeout: 60000 });
  const end = out.indexOf("\nlog:");
  return JSON.parse(out.slice(0, end > 0 ? end : out).trim());
}

function locateButton(win) {
  const shot = "/tmp/f02-send-window.png";
  execFileSync("screencapture", ["-R", `${win.bounds.X},${win.bounds.Y},${win.bounds.Width},${win.bounds.Height}`, "-x", shot], { timeout: 15000 });
  const raw = execFileSync(FINDBTN, [shot], { encoding: "utf8", timeout: 20000 }).trim();
  const r = JSON.parse(raw || "{}");
  if (!r.count || r.count < 50 || r.y < 0.6) return null;
  return {
    x: Math.round(win.bounds.X + r.x * win.bounds.Width),
    y: Math.round(win.bounds.Y + r.y * win.bounds.Height),
    count: r.count,
  };
}

const clipRead = () => execFileSync(CLIP, ["read"], { encoding: "utf8" }).trim();
const clipWrite = (b64) => execFileSync(CLIP, ["write"], { input: b64, encoding: "utf8" });
const clipDump = () => execFileSync(CLIP, ["dump"], { encoding: "utf8" }).trim();
const clipRestore = (json) => execFileSync(CLIP, ["restore"], { input: json, encoding: "utf8" });
const clipTypes = () => execFileSync(CLIP, ["types"], { encoding: "utf8" }).split("\n").filter(Boolean);
const clipChangeCount = () => Number(execFileSync(CLIP, ["change-count"], { encoding: "utf8" }).trim());

function rolloutFor(threadId) {
  const root = path.join(process.env.HOME, ".codex/sessions");
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

function readAppended(file, baseline) {
  const size = fs.statSync(file).size;
  if (size <= baseline) return [];
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(size - baseline);
  fs.readSync(fd, buf, 0, buf.length, baseline);
  fs.closeSync(fd);
  return parseRolloutEvents(buf.toString("utf8").split("\n"));
}

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  log({ kind: "start", expect: EXPECT, text: TEXT, send: SEND });

  const deadline = Date.now() + WAIT_S * 1000;
  while (Date.now() < deadline && frontBundle() !== "com.openai.codex") await sleep(1000);
  if (frontBundle() !== "com.openai.codex") {
    log({ kind: "result", status: "blocked", reason: "not-front" });
    console.log(JSON.stringify({ status: "blocked", reason: "not-front" }));
    return;
  }

  const p = preflight();
  log({ kind: "preflight", status: p.status, blockedBy: p.blockedBy, thread: p.tracker?.boundThread, window: p.window?.number });
  if (p.status !== "proceed-for-review") {
    log({ kind: "result", status: "blocked", reason: "preflight", blockedBy: p.blockedBy });
    console.log(JSON.stringify({ status: "blocked", reason: "preflight", blockedBy: p.blockedBy }));
    return;
  }
  if (p.tracker?.boundThread !== EXPECT) {
    log({ kind: "result", status: "blocked", reason: "wrong-target", actual: p.tracker?.boundThread });
    console.log(JSON.stringify({ status: "blocked", reason: "wrong-target" }));
    return;
  }

  const win = p.window;
  const composer = p.candidateScreenPoint;
  const guard = createSendGuard({ threadId: EXPECT, windowNumber: win.number, bounds: win.bounds });

  if (!SEND) {
    const button = locateButton(win);
    const plan = {
      status: button ? "dry-run-ready" : "dry-run-no-button",
      target: { threadId: EXPECT, window: win.number, bounds: win.bounds },
      composer,
      button,
      text: TEXT,
      note: "dry-run：未点击、未粘贴、未发送；加 --send 才执行。",
    };
    log({ kind: "dry-run", ...plan });
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (!TEXT) {
    log({ kind: "result", status: "blocked", reason: "missing-text" });
    console.log(JSON.stringify({ status: "blocked", reason: "missing-text" }));
    return;
  }
  // 完整快照（所有 item/类型）保存在内存，结束后原样恢复；无法快照则阻止。
  let originalClip = null;
  try {
    originalClip = clipDump();
  } catch {
    log({ kind: "result", status: "blocked", reason: "clipboard-snapshot-failed" });
    console.log(JSON.stringify({ status: "blocked", reason: "clipboard-snapshot-failed" }));
    return;
  }
  const file = rolloutFor(EXPECT);
  const baseline = file ? fs.statSync(file).size : 0;

  const assertTarget = () => {
    guard.observe(sampler());
    const r = guard.check();
    if (!r.ok) throw Object.assign(new Error("blocked"), { blocked: r });
  };

  const actions = {
    // 输入框焦点只能由用户人工确认；未确认时流程停在读回前。
    checkFocus: () => CONFIRM_FOCUS,
    clickComposer: () => {
      log({ kind: "action", name: "click-composer", point: composer });
      execFileSync(UI, ["click", String(composer.x), String(composer.y)]);
    },
    pasteText: (text) => {
      assertTarget();
      log({ kind: "action", name: "paste", length: text.length });
      clipWrite(Buffer.from(text, "utf8").toString("base64"));
      assertTarget();
      execFileSync(UI, ["paste"]);
    },
    readInput: () => {
      try {
        assertTarget();
        const sentinel = `INT001-READBACK-${Date.now()}`;
        clipWrite(Buffer.from(sentinel, "utf8").toString("base64"));
        const before = clipChangeCount();
        assertTarget();
        execFileSync(UI, ["select-all"]);
        assertTarget();
        execFileSync(UI, ["copy"]);
        const after = clipChangeCount();
        const types = clipTypes();
        const b64 = clipRead();
        const text = b64 == null ? null : Buffer.from(b64, "base64").toString("utf8");
        const cls = classifyReadback({ sentinel, beforeCount: before, afterCount: after, types, text });
        log({ kind: "action", name: "read-input", status: cls.status, length: cls.text?.length ?? 0 });
        if (cls.status === "text") return cls.text;
        if (cls.status === "empty") return "";
        return null;
      } catch {
        return null;
      }
    },
    locateSendButton: () => {
      const b = locateButton(win);
      log({ kind: "action", name: "locate-send", button: b });
      return b;
    },
    clickSend: (b) => {
      log({ kind: "action", name: "click-send", button: b });
      execFileSync(UI, ["click", String(b.x), String(b.y)]);
    },
    readEvents: () => (file ? readAppended(file, baseline) : []),
  };

  try {
    const result = await runSendFlow({
      text: TEXT,
      guard,
      sample: sampler,
      actions,
      timeoutMs: 120000,
      intervalMs: 2000,
      onState: (s) => log({ kind: "state", ...s }),
    });
    log({ kind: "result", ...result });
    fs.writeFileSync(logPath.replace(/\.jsonl$/, "-summary.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (originalClip != null) clipRestore(originalClip); // 完整恢复剪贴板（仅内存保存，不落盘）
  }
}

try {
  await main();
  stream.end();
} catch (e) {
  log({ kind: "error", message: String(e).slice(0, 300) });
  stream.end();
  console.error(String(e));
  process.exit(1);
}
