#!/usr/bin/env node
// P01/P03-A/P03-B 断言：数值坐标、无锚点、草稿分类、截图前后重采样与阻止条件。无需截图。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  toContentBox,
  candidateFromAnchor,
  evaluatePreflight,
  classifyDraft,
  round4,
} from "../../server/codex-probe/lib/preflight-geometry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOG = path.join(ROOT, "tests/codex-probe/logs", `F02-geometry-${Date.now()}-${process.pid}.jsonl`);
const stream = fs.createWriteStream(LOG, { flags: "w" });
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: Boolean(cond) });
  stream.write(JSON.stringify({ t: new Date().toISOString(), kind: "assert", name, ok: Boolean(cond), detail }) + "\n");
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` — ${detail}`}`);
};

const geom = (content, imageWidth, imageHeight, scale = 2) => ({
  content, imageWidth, imageHeight, scale, marginX: 0, marginY: 0,
});
const row = (text, y, x = 0.4, w = 0.2, h = 0.02) => ({ text, x, y, w, h });

// P01：占位符锚点 → 数值坐标
{
  const g = geom({ X: 124, Y: 102, Width: 824, Height: 668 }, 1648, 1336, 2);
  const box = toContentBox(row("使用 ChatGPT Work", 0.851), g);
  check("P01 内容框坐标为数值", ["x", "y", "w", "h"].every((k) => typeof box[k] === "number" && Number.isFinite(box[k])), JSON.stringify(box));
  const point = candidateFromAnchor(box, { contentHeight: 668, anchorText: "使用 ChatGPT Work" });
  check("P01 占位符：候选点在下方且为数值", point && typeof point.y === "number" && point.y > box.y && point.basis === "below-placeholder-22pt", JSON.stringify({ box, point }));
  check("P01 展示值可单独格式化", typeof round4(point.y) === "number");
}

// P01：不同窗口尺寸与缩放
{
  for (const [w, h, scale] of [[1000, 700, 2], [640, 480, 1], [1512, 900, 2]]) {
    const g = geom({ X: 0, Y: 0, Width: w, Height: h }, w * scale, h * scale, scale);
    const box = toContentBox(row("使用 ChatGPT Work", 0.9), g);
    const point = candidateFromAnchor(box, { contentHeight: h, anchorText: "使用 ChatGPT Work" });
    check(`P01 尺寸 ${w}x${h}@${scale}x：坐标在 0..1`, point && point.x > 0 && point.x < 1 && point.y > 0 && point.y < 1, JSON.stringify({ box, point }));
    check(`P01 尺寸 ${w}x${h}@${scale}x：数值类型`, typeof point.y === "number" && Number.isFinite(point.y));
  }
}

// P01：工具栏锚点、无锚点、越界
{
  const g = geom({ X: 0, Y: 0, Width: 824, Height: 668 }, 1648, 1336, 2);
  const toolbar = toContentBox(row("工具栏按钮", 0.7), g);
  const p1 = candidateFromAnchor(toolbar, { contentHeight: 668, anchorText: "工具栏按钮" });
  check("P01 工具栏锚点向上偏移", p1 && p1.y < toolbar.y && p1.basis === "above-toolbar-22pt", JSON.stringify(p1));
  check("P01 无锚点不产生候选", candidateFromAnchor(null, { contentHeight: 668, anchorText: "" }) === null);
  const top = toContentBox(row("使用 ChatGPT Work", 0.0), g);
  check("P01 越界不产生候选", candidateFromAnchor(top, { contentHeight: 668, anchorText: "使用 ChatGPT Work" }) === null);
}

// P03-A：草稿分类
{
  check("P03-A 无文本：unknown", classifyDraft([]) === "unknown");
  check("P03-A 识别失败：unknown", classifyDraft(null) === "unknown");
  check("P03-A 完整占位符：empty", classifyDraft([{ text: "使用 ChatGPT Work" }]) === "empty");
  check("P03-A OCR 漏前缀仍为占位符", classifyDraft([{ text: "ChatGPT Work" }]) === "empty");
  check("P03-A 空白差异不误判", classifyDraft([{ text: "  发消息或创建任务，/ 调用指令，@ 文件或对话  " }]) === "empty");
  check("P03-A 含“使用”的草稿不判空", classifyDraft([{ text: "请使用我的已有草稿" }]) === "has-text");
  check("P03-A 含“发消息”的草稿不判空", classifyDraft([{ text: "不要发消息，这只是草稿" }]) === "has-text");
  check("P03-A 多行草稿不判空", classifyDraft([{ text: "第一行" }, { text: "第二行" }]) === "has-text");
  check("P03-A 占位符加草稿不判空", classifyDraft([{ text: "使用 ChatGPT Work" }, { text: "额外内容，这是用户的草稿" }]) === "has-text");
  check("P03-A 占位符被拆分：unknown 而非判空", classifyDraft([{ text: "5 iJiHt" }, { text: "ChatGPT Work" }]) === "unknown");
}

// P03-B：截图前后采样
const A = "A-thread";
const B = "B-thread";
const bounds = { X: 124, Y: 102, Width: 824, Height: 668 };
const win = (ids, number = 1509, b = bounds) => ({ windowNumber: number, threadIds: ids, bounds: b });
const sample = (bundle, windows) => ({ frontBundleId: bundle, windows });
const base = {
  before: sample("com.openai.codex", [win([A])]),
  after: sample("com.openai.codex", [win([A])]),
  windowFocused: false,
  windowMain: true,
  bound: { threadId: A, windowNumber: 1509 },
  anchor: { text: "使用 ChatGPT Work" },
  draft: "empty",
  point: { x: 0.5, y: 0.884 },
};
{
  const r = evaluatePreflight(base);
  check("P03-B 稳定同目标：可继续评审", r.status === "proceed-for-review" && r.checks.every((c) => c.ok === true), JSON.stringify(r));
  const unknownDraft = evaluatePreflight({ ...base, draft: "unknown" });
  check("P03-B 草稿未知：交由发送流程读回", unknownDraft.status === "proceed-for-review" && unknownDraft.checks.find((c) => c.id === "draft-empty")?.detail === "unknown-in-flow-verify", JSON.stringify(unknownDraft.blockedBy));
  check("P03-B 焦点只作观察值", r.observations.axFocused === false);
}
{
  const cases = [
    ["同窗口 A→B（bounds 不变）", { after: sample("com.openai.codex", [win([B])]) }, ["same-target", "target-bound"]],
    ["切到其他应用", { after: sample("com.deepseek.dsh", [win([A])]) }, ["front-codex"]],
    ["新开窗口", { after: sample("com.openai.codex", [win([A]), win([A], 1510)]) }, ["single-window"]],
    ["标题歧义", { after: sample("com.openai.codex", [win([A, B])]) }, ["unique-session"]],
    ["采样失败", { after: null }, ["front-codex", "single-window", "same-target", "unique-session", "target-bound", "bounds-stable"]],
    ["窗口移动", { after: sample("com.openai.codex", [win([A], 1509, { X: 0, Y: 0, Width: 824, Height: 668 })]) }, ["bounds-stable"]],
    ["无锚点", { anchor: null }, ["anchor-found"]],
    ["无候选点", { point: null }, ["point-computed"]],
    ["已有草稿", { draft: "has-text" }, ["draft-empty"]],
    ["主窗口未知", { windowMain: null }, ["main-window"]],
    ["未绑定", { bound: null }, ["target-bound"]],
  ];
  for (const [name, patch, ids] of cases) {
    const r = evaluatePreflight({ ...base, ...patch });
    check(`P03-B ${name}：阻止`, r.status === "blocked" && ids.every((id) => r.blockedBy.includes(id)), JSON.stringify(r.blockedBy));
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY pass=${results.length - failed.length} fail=${failed.length}\nlog: ${LOG}`);
stream.end(() => process.exit(failed.length ? 1 : 0));
