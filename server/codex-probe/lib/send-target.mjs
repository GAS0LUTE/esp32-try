// 发送目标守卫：每个动作前用新鲜采样核对指定会话、窗口、bounds 与前台。
// 缺目标、换会话、换窗口、窗口移动、采样过期都返回不可发送。
const CODEX_BUNDLE = "com.openai.codex";

export function createSendGuard({ threadId, windowNumber, bounds, maxAgeMs = 1500, now = () => Date.now() } = {}) {
  if (!threadId) throw new Error("threadId required");
  let sample = null;
  let sampledAt = 0;
  let lastCapturedAt = 0;
  const expectedBounds = bounds ? { ...bounds } : null;

  const sameBounds = (a, b) =>
    Boolean(a && b && a.X === b.X && a.Y === b.Y && a.Width === b.Width && a.Height === b.Height);

  const guard = {
    observe(next) {
      const capturedAt = next?.capturedAt;
      if (typeof capturedAt !== "number" || !Number.isFinite(capturedAt)) {
        sample = null; // 缺失采集时间：不可用
        sampledAt = 0;
        return;
      }
      if (capturedAt <= lastCapturedAt) {
        sample = null; // 旧或重复采集时间不能当作新结果
        sampledAt = 0;
        return;
      }
      lastCapturedAt = capturedAt;
      sample = next;
      sampledAt = capturedAt; // 与 now() 同一时钟域（毫秒时间戳）
    },
    check() {
      if (!sample) return { ok: false, reason: "no-sample" };
      const age = now() - sampledAt;
      if (!Number.isFinite(age) || age < 0) return { ok: false, reason: "invalid-sample-time", ageMs: age };
      if (age > maxAgeMs) return { ok: false, reason: "stale-sample", ageMs: age };
      if (sample.frontBundleId !== CODEX_BUNDLE) return { ok: false, reason: "non-front" };
      const wins = sample.windows ?? [];
      if (wins.length !== 1) return { ok: false, reason: "window-count", count: wins.length };
      const w = wins[0];
      if (windowNumber !== undefined && w.windowNumber !== windowNumber) return { ok: false, reason: "window-changed" };
      if (!(w.threadIds ?? []).includes(threadId)) return { ok: false, reason: "session-changed" };
      if ((w.threadIds ?? []).length !== 1) return { ok: false, reason: "ambiguous-session" };
      if (expectedBounds && !sameBounds(w.bounds, expectedBounds)) return { ok: false, reason: "bounds-changed" };
      return { ok: true, windowNumber: w.windowNumber, threadId, ageMs: age };
    },
    expected: { threadId, windowNumber, bounds: expectedBounds },
  };
  return guard;
}
