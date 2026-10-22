// F02-P 几何与检查：全程数值，格式化只用于展示；无锚点不产生候选点。
// 草稿分类只认完整占位符；任何不确定都输出 unknown 并阻止。
const CODEX_BUNDLE = "com.openai.codex";

export const round4 = (n) => Number(n.toFixed(4));

// 已知输入框占位符（完整字符串）。OCR 可能漏掉前缀，因此保留稳定变体。
export const PLACEHOLDERS = [
  "使用 ChatGPT Work",
  "使用 ChatGPT",
  "ChatGPT Work",
  "发消息或创建任务，/ 调用指令，@ 文件或对话",
  "发消息或创建任务",
];

const normalize = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// 输入区域 OCR 行 → empty / has-text / unknown。
export function classifyDraft(rows) {
  const texts = (rows ?? []).map((r) => normalize(r.text)).filter(Boolean);
  if (texts.length === 0) return "unknown";
  const allPlaceholders = texts.every((t) => PLACEHOLDERS.includes(t));
  if (allPlaceholders) return "empty";
  // 占位符被 OCR 拆成碎片时无法可靠区分，交给发送流程读回全文再判定。
  const hasPlaceholder = texts.some((t) => PLACEHOLDERS.includes(t));
  const onlyFragments = texts.every((t) => PLACEHOLDERS.includes(t) || t.length <= 8);
  if (hasPlaceholder && onlyFragments) return "unknown";
  return "has-text";
}

// OCR 行（Vision 归一化坐标，原点在左下）→ 窗口内容相对坐标（数值）。
export function toContentBox(row, geom) {
  const { imageWidth, imageHeight, content, scale, marginX = 0, marginY = 0 } = geom;
  const x = ((row.x * imageWidth) / scale - marginX) / content.Width;
  const y = ((imageHeight - (row.y + row.h) * imageHeight) / scale - marginY) / content.Height;
  const w = ((row.w * imageWidth) / scale) / content.Width;
  const h = ((row.h * imageHeight) / scale) / content.Height;
  return { x, y, w, h };
}

// 占位符锚点 → 候选点：占位符在上，点击点在下方 22pt；工具栏锚点在上方。
export function candidateFromAnchor(box, { contentHeight, anchorText = "" }) {
  if (!box || !Number.isFinite(box.y) || !Number.isFinite(contentHeight) || contentHeight <= 0) return null;
  const below = /使用|ChatGPT Work|发消息|创建任务|调用指令/i.test(anchorText);
  const y = box.y + (below ? 22 : -22) / contentHeight;
  if (y <= 0 || y >= 1) return null;
  return { x: 0.5, y, basis: below ? "below-placeholder-22pt" : "above-toolbar-22pt" };
}

const windowOf = (sample) => (sample?.windows?.length === 1 ? sample.windows[0] : null);
const idsOf = (w) => w?.threadIds ?? [];

function sameBounds(a, b) {
  return Boolean(a && b && a.X === b.X && a.Y === b.Y && a.Width === b.Width && a.Height === b.Height);
}

// 截图前后的完整采样 + 观察值 → 布尔/未知检查；任何 false/未知都阻止。
export function evaluatePreflight(s) {
  const before = s.before ?? null;
  const after = s.after ?? null;
  const bw = windowOf(before);
  const aw = windowOf(after);
  const aIds = idsOf(aw);
  const bIds = idsOf(bw);

  const checks = [
    { id: "front-codex", ok: after?.frontBundleId === CODEX_BUNDLE, detail: after?.frontBundleId ?? "unknown" },
    { id: "single-window", ok: after?.windows?.length === 1, detail: `windows=${after?.windows?.length ?? "unknown"}` },
    { id: "main-window", ok: s.windowMain === true ? true : s.windowMain === false ? false : null, detail: String(s.windowMain) },
    {
      id: "same-target",
      ok: Boolean(bw && aw && bw.windowNumber === aw.windowNumber && bIds.length === 1 && aIds.length === 1 && bIds[0] === aIds[0]),
      detail: `${bIds.length}/${aIds.length}`,
    },
    { id: "unique-session", ok: aIds.length === 1, detail: `matches=${aIds.length}` },
    {
      id: "target-bound",
      ok: Boolean(s.bound && aw && aIds.length === 1 && s.bound.threadId === aIds[0] && s.bound.windowNumber === aw.windowNumber),
      detail: s.bound ? `${s.bound.threadId}@${s.bound.windowNumber}` : "no-bound",
    },
    {
      id: "bounds-stable",
      ok: sameBounds(bw?.bounds, aw?.bounds),
      detail: sameBounds(bw?.bounds, aw?.bounds) ? "same" : "changed",
    },
    { id: "anchor-found", ok: Boolean(s.anchor), detail: s.anchor?.text?.slice(0, 24) ?? "none" },
    { id: "draft-empty", ok: s.draft === "has-text" ? false : true, detail: s.draft === "unknown" ? "unknown-in-flow-verify" : s.draft },
    { id: "point-computed", ok: Boolean(s.point), detail: s.point ? `${round4(s.point.x)},${round4(s.point.y)}` : "none" },
  ];
  const blockedBy = checks.filter((c) => c.ok !== true).map((c) => c.id);
  return {
    status: blockedBy.length ? "blocked" : "proceed-for-review",
    checks,
    blockedBy,
    observations: { axFocused: s.windowFocused ?? null },
  };
}
