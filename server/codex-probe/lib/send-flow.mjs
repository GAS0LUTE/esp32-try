// 发送流程状态机：动作与确认分离；每个动作前用新鲜采样过守卫；输入全文一致才提交。
import { findDelivery } from "./rollout-events.mjs";

export const SEND_STATE = Object.freeze({
  BLOCKED: "blocked",
  ATTEMPTED_PENDING: "attempted-pending",
  DELIVERED: "delivered",
  DELIVERED_NO_REPLY: "delivered-no-reply",
  REPLIED: "replied",
  UNKNOWN: "unknown",
});

export async function runSendFlow({
  text,
  guard,
  sample,
  actions,
  timeoutMs = 120000,
  intervalMs = 2000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onState,
}) {
  const emit = (state) => onState?.(state);

  if (!text) return { status: SEND_STATE.BLOCKED, reason: "empty-text", clicks: 0 };

  const guardCheck = (stage) => {
    guard.observe(sample());
    const r = guard.check();
    return r.ok ? null : { status: SEND_STATE.BLOCKED, reason: r.reason, stage, clicks: 0 };
  };
  const focusCheck = (stage) => {
    if (typeof actions.checkFocus !== "function") return null;
    const ok = actions.checkFocus();
    return ok === true ? null : { status: SEND_STATE.BLOCKED, reason: "input-focus-unknown", stage, clicks: 0 };
  };
  const runAction = (fn, stage) => {
    try {
      fn();
      return null;
    } catch (e) {
      if (e?.blocked) return { status: SEND_STATE.BLOCKED, ...e.blocked, stage, clicks: 0 };
      throw e;
    }
  };
  const runValue = (fn, stage) => {
    try {
      return { ok: true, value: fn() };
    } catch (e) {
      if (e?.blocked) return { ok: false, blocked: { status: SEND_STATE.BLOCKED, ...e.blocked, stage, clicks: 0 } };
      throw e;
    }
  };

  let blocked = guardCheck("precheck");
  if (blocked) return blocked;

  blocked = runAction(() => actions.clickComposer(), "click");
  if (blocked) return blocked;
  blocked = guardCheck("after-click");
  if (blocked) return blocked;

  // 粘贴前先读回输入框：读不到 → 人工核对；已有内容 → 保留现场，不粘贴。
  blocked = guardCheck("before-read");
  if (blocked) return blocked;
  blocked = focusCheck("before-read");
  if (blocked) return blocked;
  const existingRead = runValue(() => actions.readInput(), "read");
  if (!existingRead.ok) return existingRead.blocked;
  const existing = existingRead.value;
  if (existing == null) return { status: SEND_STATE.BLOCKED, reason: "input-unreadable-before-paste", clicks: 0 };
  if (existing !== "") return { status: SEND_STATE.BLOCKED, reason: "existing-draft", input: existing, clicks: 0 };

  blocked = guardCheck("before-paste");
  if (blocked) return blocked;
  blocked = focusCheck("before-paste");
  if (blocked) return blocked;
  blocked = runAction(() => actions.pasteText(text), "paste");
  if (blocked) return blocked;

  blocked = guardCheck("before-readback");
  if (blocked) return blocked;
  blocked = focusCheck("before-readback");
  if (blocked) return blocked;
  const readback = runValue(() => actions.readInput(), "readback");
  if (!readback.ok) return readback.blocked;
  const input = readback.value;
  if (input == null) return { status: SEND_STATE.BLOCKED, reason: "input-unreadable", clicks: 0 };
  if (input !== text) {
    return { status: SEND_STATE.BLOCKED, reason: "input-mismatch", input, expected: text, clicks: 0 };
  }

  blocked = guardCheck("before-send");
  if (blocked) return blocked;

  blocked = guardCheck("before-locate");
  if (blocked) return blocked;
  const button = actions.locateSendButton();
  if (!button) return { status: SEND_STATE.BLOCKED, reason: "send-control-not-found", clicks: 0 };

  blocked = guardCheck("before-submit");
  if (blocked) return blocked;

  actions.clickSend(button);
  const attemptedAt = now();
  emit({ status: SEND_STATE.ATTEMPTED_PENDING, at: attemptedAt });

  const deadline = attemptedAt + timeoutMs;
  let delivered = null;
  while (now() < deadline) {
    const events = actions.readEvents(attemptedAt) ?? [];
    const delivery = findDelivery(events, text);
    if (delivery.found) {
      delivered = delivery;
      if (delivery.reply) {
        return { status: SEND_STATE.REPLIED, clicks: 1, delivery };
      }
    }
    await sleep(intervalMs);
  }
  if (delivered) {
    return { status: SEND_STATE.DELIVERED_NO_REPLY, reason: "timeout-no-reply", clicks: 1, delivery: delivered };
  }
  return { status: SEND_STATE.UNKNOWN, reason: "timeout-no-confirmation", clicks: 1 };
}
