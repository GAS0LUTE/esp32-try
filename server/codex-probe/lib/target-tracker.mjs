// 前台目标绑定状态机：稳定唯一匹配才成为候选；绑定必须显式确认；变化即停发。
// 稳定计数以“窗口编号 + 会话 ID”为身份；发送前必须用新鲜采样过门禁。
const CODEX_BUNDLE = "com.openai.codex";

export function createTargetTracker({ stableSamples = 3, maxSampleAgeMs = 2000, now = () => Date.now() } = {}) {
  let bound = null; // { threadId, windowNumber }
  let candidate = null; // { threadId, windowNumber, identity }
  let streak = 0;
  let state = "unconfirmed";
  let reason = "no-sample";
  let seq = 0;
  let lastSample = null;
  let lastSampleAt = 0;
  let bindingGeneration = 0;
  const history = [];

  const resetCandidate = () => {
    candidate = null;
    streak = 0;
  };

  const makeResult = () => ({
    state,
    reason,
    candidateThread:
      state === "candidate" || (state === "changed" && streak >= stableSamples) ? candidate?.threadId ?? null : null,
    candidateWindow:
      state === "candidate" || (state === "changed" && streak >= stableSamples) ? candidate?.windowNumber ?? null : null,
    boundThread: bound?.threadId ?? null,
    boundWindow: bound?.windowNumber ?? null,
    bindingGeneration,
    streak,
    sampleSeq: seq,
    sampleAgeMs: lastSample ? now() - lastSampleAt : null,
    sendAllowed: gate().allowed,
  });

  const evaluate = (sample) => {
    seq += 1;
    lastSample = sample;
    lastSampleAt = now();
    if (!sample || sample.frontBundleId !== CODEX_BUNDLE) {
      resetCandidate();
      state = bound ? "changed" : "unconfirmed";
      reason = "non-front";
      return;
    }
    const windows = sample.windows ?? [];
    if (windows.length === 0) {
      resetCandidate();
      state = bound ? "changed" : "unconfirmed";
      reason = "no-window";
      return;
    }
    if (windows.length > 1) {
      resetCandidate();
      state = bound ? "changed" : "unconfirmed";
      reason = "multi-window";
      return;
    }
    const w = windows[0];
    const ids = w.threadIds ?? [];
    if (ids.length === 0) {
      resetCandidate();
      state = bound ? "changed" : "unconfirmed";
      reason = "no-match";
      return;
    }
    if (ids.length > 1) {
      resetCandidate();
      state = bound ? "changed" : "unconfirmed";
      reason = "ambiguous-title";
      return;
    }
    const threadId = ids[0];
    const windowNumber = w.windowNumber;
    if (bound && bound.threadId === threadId && bound.windowNumber === windowNumber) {
      candidate = { threadId, windowNumber, identity: `${windowNumber}:${threadId}` };
      streak += 1;
      state = "bound";
      reason = "bound-target-visible";
      return;
    }
    const identity = `${windowNumber}:${threadId}`;
    if (!candidate || candidate.identity !== identity) {
      candidate = { threadId, windowNumber, identity };
      streak = 1;
    } else {
      streak += 1;
    }
    if (streak >= stableSamples) {
      state = bound ? "changed" : "candidate";
      reason = "stable-candidate";
    } else {
      state = bound ? "changed" : "unconfirmed";
      reason = "stabilizing";
    }
  };

  const gate = () => {
    if (!lastSample) return { allowed: false, reason: "no-sample" };
    const age = now() - lastSampleAt;
    if (age > maxSampleAgeMs) return { allowed: false, reason: "stale-sample", ageMs: age };
    if (state !== "bound" || !bound) return { allowed: false, reason: state };
    if (lastSample.frontBundleId !== CODEX_BUNDLE) return { allowed: false, reason: "non-front" };
    const windows = lastSample.windows ?? [];
    if (windows.length !== 1) return { allowed: false, reason: "window-count" };
    const w = windows[0];
    if (w.windowNumber !== bound.windowNumber) return { allowed: false, reason: "window-changed" };
    if (!(w.threadIds ?? []).includes(bound.threadId)) return { allowed: false, reason: "thread-changed" };
    return {
      allowed: true,
      generation: bindingGeneration,
      threadId: bound.threadId,
      windowNumber: bound.windowNumber,
      ageMs: age,
    };
  };

  const tracker = {
    observe(sample) {
      evaluate(sample);
      const r = makeResult();
      history.push({ t: now(), ...r });
      return r;
    },
    confirm() {
      if (!candidate || streak < stableSamples || (state !== "candidate" && state !== "changed")) {
        return { ok: false, reason: streak < stableSamples ? "not-stable" : "no-candidate", streak };
      }
      bound = { threadId: candidate.threadId, windowNumber: candidate.windowNumber };
      bindingGeneration += 1;
      state = "bound";
      reason = "confirmed";
      const snap = makeResult();
      history.push({ t: now(), ...snap, event: "confirm" });
      return { ok: true, boundThread: bound.threadId, boundWindow: bound.windowNumber, generation: bindingGeneration };
    },
    clear() {
      bound = null;
      resetCandidate();
      bindingGeneration += 1;
      state = "unconfirmed";
      reason = "cleared";
      return { ok: true, generation: bindingGeneration };
    },
    // 发送前必须重新 observe()，再调用 gate()；不得复用缓存结果。
    gate,
    snapshot() {
      return makeResult();
    },
    history,
  };
  return tracker;
}
