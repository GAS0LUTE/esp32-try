#!/usr/bin/env node
// F02-P 只读预演：前台/窗口/绑定采样 → 精确截图 → OCR 锚点 → 草稿与焦点检查 → 明确放行/阻止。
// 不激活窗口、不点击、不粘贴、不回车、不清空任何草稿。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { toContentBox, candidateFromAnchor, evaluatePreflight, round4, classifyDraft, PLACEHOLDERS } from "../../server/codex-probe/lib/preflight-geometry.mjs";
import { createTargetTracker } from "../../server/codex-probe/lib/target-tracker.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS = path.join(ROOT, "tests/codex-probe/tools");
const WINLIST = "/tmp/codex-probe-winlist";
const OCR = "/tmp/codex-probe-ocr";
const AXSTATE = "/tmp/codex-probe-axstate";
const LOG_DIR = path.join(ROOT, "tests/codex-probe/logs");
const SHOT = "/tmp/f02-preflight-window.png";
const HOME = process.env.HOME;

const logPath = path.join(LOG_DIR, `F02-preflight-${Date.now()}-${process.pid}.jsonl`);
const stream = fs.createWriteStream(logPath, { flags: "w" });
const log = (o) => stream.write(JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

function compile(src, out) {
  if (fs.existsSync(out)) return;
  fs.mkdirSync("/tmp/codex-modcache", { recursive: true });
  execFileSync("swiftc", ["-module-cache-path", "/tmp/codex-modcache", src, "-o", out], { stdio: "pipe", timeout: 120000 });
}

function frontApp() {
  const asn = execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
  const read = (key) => {
    const out = execFileSync("lsappinfo", ["info", "-only", key, asn], { encoding: "utf8" });
    const m = out.match(/"([^"]*)"/);
    return m ? m[1] : null;
  };
  return { name: read("name"), bundleId: read("bundleID") };
}

function windows() {
  const out = execFileSync(WINLIST, ["ChatGPT"], { encoding: "utf8", timeout: 10000 });
  return out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function threadsByTitle() {
  const map = new Map();
  for (const line of fs.readFileSync(path.join(HOME, ".codex/session_index.jsonl"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r.thread_name || !r.id) continue;
    map.set(r.thread_name, [...(map.get(r.thread_name) ?? []), r.id]);
  }
  return map;
}

function ocr(imagePath) {
  try {
    const out = execFileSync(OCR, [imagePath], { encoding: "utf8", timeout: 30000 });
    return out.split("\n").filter(Boolean).map((line) => {
      const [text, box] = line.split("\t");
      const [x, y, w, h] = (box ?? "").split(",").map(Number);
      return { text, x, y, w, h };
    }).filter((o) => Number.isFinite(o.x));
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roundBox = (b) => ({ x: round4(b.x), y: round4(b.y), w: round4(b.w), h: round4(b.h) });

function axState(pid) {
  try {
    const out = execFileSync(AXSTATE, [String(pid)], { encoding: "utf8", timeout: 10000 }).trim();
    const f = out.match(/focused=(true|false)/);
    const m = out.match(/main=(true|false)/);
    return { focused: f ? f[1] === "true" : null, main: m ? m[1] === "true" : null };
  } catch {
    return { focused: null, main: null };
  }
}

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  compile(path.join(TOOLS, "winlist.swift"), WINLIST);
  compile(path.join(TOOLS, "ocr.swift"), OCR);
  compile(path.join(TOOLS, "axstate.swift"), AXSTATE);

  const sourceHash = hash(
    fs.readFileSync(path.join(ROOT, "server/codex-probe/lib/preflight-geometry.mjs"), "utf8") +
    fs.readFileSync(fileURLToPath(import.meta.url), "utf8")
  );

  // 3 次采样形成稳定阈值；过程中窗口变化会重置计数。
  const tracker = createTargetTracker({ stableSamples: 3 });
  let lastSample = null;
  let lastWins = [];
  for (let i = 0; i < 3; i++) {
    const wins = windows();
    const front = frontApp();
    const byTitle = threadsByTitle();
    lastSample = {
      frontBundleId: front.bundleId,
      windows: wins.map((w) => ({
        windowNumber: w.number,
        threadIds: byTitle.get(w.title) ?? [],
        bounds: w.bounds,
      })),
    };
    lastWins = wins;
    tracker.observe(lastSample);
    log({ kind: "sample", i, front: front.bundleId, windows: wins.length, bounds: wins[0]?.bounds ?? null, state: tracker.snapshot().state });
    if (i < 2) await sleep(400);
  }

  if (lastSample.frontBundleId !== "com.openai.codex" || lastWins.length !== 1) {
    const r = {
      status: "blocked",
      sourceHash,
      reason: "前台不是唯一的 ChatGPT 窗口",
      checks: [
        { id: "front-codex", ok: lastSample.frontBundleId === "com.openai.codex", detail: String(lastSample.frontBundleId) },
        { id: "single-window", ok: lastWins.length === 1, detail: `windows=${lastWins.length}` },
      ],
    };
    log({ kind: "result", ...r });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  const pre = tracker.snapshot();
  if (pre.state === "candidate") tracker.confirm(); // 只读预演在稳定候选上做本地绑定，不发送
  const snap = tracker.snapshot();

  const w = lastWins[0];
  const content = w.bounds;
  const boundsBefore = { ...content };
  execFileSync("screencapture", ["-R", `${content.X},${content.Y},${content.Width},${content.Height}`, "-x", SHOT], { timeout: 15000 });
  const img = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", SHOT], { encoding: "utf8" });
  const pw = Number((img.match(/pixelWidth: (\d+)/) ?? [])[1]);
  const ph = Number((img.match(/pixelHeight: (\d+)/) ?? [])[1]);
  const geom = { imageWidth: pw, imageHeight: ph, content, scale: pw / content.Width, marginX: 0, marginY: 0 };

  const rows = ocr(SHOT);
  const normalize = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
  const composer = rows.filter((r) => PLACEHOLDERS.includes(normalize(r.text))).sort((a, b) => a.y - b.y)[0] ?? null;
  const anchorBox = composer ? toContentBox(composer, geom) : null;
  const point = anchorBox
    ? candidateFromAnchor(anchorBox, { contentHeight: content.Height, anchorText: composer.text })
    : null;

  // 草稿检测：只取锚点附近输入行；占位符=空，其他文字=有草稿，识别不到=未知（阻止）。
  let draft = "unknown";
  let draftRows = [];
  if (anchorBox) {
    // 只取占位符所在输入行，避免把下方工具栏当成草稿。
    const y0 = Math.max(0, anchorBox.y - 0.03);
    const h = Math.min(1 - y0, 0.05);
    const sx = content.X + Math.round(0.05 * content.Width);
    const sy = content.Y + Math.round(y0 * content.Height);
    const sw = Math.round(0.9 * content.Width);
    const sh = Math.max(20, Math.round(h * content.Height));
    const band = "/tmp/f02-draft-band.png";
    try {
      execFileSync("screencapture", ["-R", `${sx},${sy},${sw},${sh}`, "-x", band], { timeout: 15000 });
      draftRows = ocr(band);
      draft = classifyDraft(draftRows);
      log({ kind: "draft", state: draft, rows: draftRows.map((r) => r.text.slice(0, 20)) });
    } catch {
      draft = "unknown";
    }
  }

  // 截图与 OCR 完成后重新采集前台、完整窗口集合、标题映射与 bounds；不使用绑定目标反推。
  const afterWins = windows();
  const afterFront = frontApp();
  const afterByTitle = threadsByTitle();
  const afterSample = {
    frontBundleId: afterFront.bundleId,
    windows: afterWins.map((x) => ({
      windowNumber: x.number,
      threadIds: afterByTitle.get(x.title) ?? [],
      bounds: x.bounds,
    })),
  };
  tracker.observe(afterSample);
  const postSnap = tracker.snapshot();
  const afterWindow = afterWins.find((x) => x.number === w.number) ?? null;
  const ax = axState(afterWindow?.pid ?? w.pid);

  const verdict = evaluatePreflight({
    before: lastSample,
    after: afterSample,
    windowFocused: ax.focused,
    windowMain: ax.main,
    bound: postSnap.boundThread ? { threadId: postSnap.boundThread, windowNumber: postSnap.boundWindow } : null,
    anchor: composer ? { text: composer.text } : null,
    draft,
    point,
  });

  const result = {
    status: verdict.status,
    sourceHash,
    checks: verdict.checks,
    blockedBy: verdict.blockedBy,
    observations: verdict.observations,
    window: { number: w.number, titleHash: hash(w.title), bounds: content, ax },
    tracker: { state: postSnap.state, boundThread: postSnap.boundThread, boundWindow: postSnap.boundWindow, generation: postSnap.bindingGeneration, streak: postSnap.streak },
    anchor: composer ? { text: composer.text.slice(0, 24), box: roundBox(anchorBox) } : null,
    candidatePoint: point ? { x: round4(point.x), y: round4(point.y), basis: point.basis } : null,
    candidateScreenPoint: point ? {
      x: Math.round(content.X + point.x * content.Width),
      y: Math.round(content.Y + point.y * content.Height),
    } : null,
    draft,
    cancelPath: [
      "任一检查失败：不点击、不粘贴、不回车，保留现场并提示人工核对",
      "发现已有草稿：不点击、不粘贴、不清空，交由用户处理",
      "粘贴后内容不一致或焦点变化：不回车、不盲删，停止并提示人工核对",
      "当前实验不提供自动回退；确需回退须另证目标与本次插入内容",
    ],
    note: "本预演不发送任何事件；只有 status=proceed-for-review 才进入 Codex 复核。",
  };
  log({ kind: "result", ...result });
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nlog: ${logPath}\nsourceHash: ${sourceHash}\nlocal screenshot: ${SHOT}`);
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
