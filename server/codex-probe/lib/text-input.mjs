// 输入读回证据：哨兵值 + changeCount + 文本类型，区分“复制失败/空输入/正文/不可读”。
export function classifyReadback({ sentinel, beforeCount, afterCount, types = [], text = null }) {
  if (text == null) return { status: "unreadable", reason: "no-text" };
  if (text === sentinel) return { status: "copy-failed", reason: "sentinel-remained" };
  if (afterCount === beforeCount) return { status: "copy-failed", reason: "no-clipboard-change" };
  const hasText = types.includes("public.utf8-plain-text") || types.includes("NSStringPboardType");
  if (!hasText) {
    // 非文本类型（图片/HTML 等）或完全无类型：复制发生了，但不能证明输入框为空。
    return { status: "unreadable", reason: types.length ? "non-text-types" : "no-types" };
  }
  if (text === "") return { status: "empty" };
  return { status: "text", text };
}
