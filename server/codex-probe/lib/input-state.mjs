// 最小输入状态机：未发送 / 已发送待确认 / 处理中 / 已完成 / 结果未知。
// 所有发送入口共用同一门禁：连接可用、已核对、当前没有占用中的输入。
// 重发必须先完成连接核对，且没有进行中的发送；消息登记与当前状态保持一致。
export const INPUT_STATE = Object.freeze({
  UNSENT: "unsent",
  AWAITING_ACK: "awaiting-ack",
  IN_PROGRESS: "in-progress",
  COMPLETED: "completed",
  UNKNOWN: "unknown",
});

export function createInputController({ sendTurn, log, now = () => Date.now() } = {}) {
  let connected = true;
  let ready = true; // 重连后为 false，显式核对通过才恢复发送
  let current = null; // 从发送开始到确认/结束都占用
  let seq = 0;
  const held = [];
  const registered = new Map();
  const history = [];

  const snapshot = () => ({
    connected,
    ready,
    busy: Boolean(current),
    current: current ? { ...current } : null,
    held: held.map((m) => ({ ...m })),
  });

  const record = (entry) => {
    history.push({ t: now(), ...entry });
    log?.log?.({ step: "input", ...entry });
  };

  const canSend = () => connected && ready && !current;

  const dispatch = (msg) => {
    msg.state = INPUT_STATE.AWAITING_ACK;
    current = msg;
    record({ action: "sent", localId: msg.localId });
    sendTurn?.(msg);
    return { action: "sent", message: msg, snapshot: snapshot() };
  };

  const submit = (text, meta = {}) => {
    const msg = { localId: `local-${++seq}`, text, ...meta, state: INPUT_STATE.UNSENT, createdAt: now() };
    registered.set(msg.localId, msg);
    if (!canSend()) {
      const reason = !connected ? "disconnected" : !ready ? "checking" : "busy";
      held.push(msg);
      record({ action: "held", reason, localId: msg.localId });
      return { action: "held", reason, message: msg, snapshot: snapshot() };
    }
    return dispatch(msg);
  };

  const ack = (localId) => {
    if (!current || (localId && current.localId !== localId)) return false;
    current.state = INPUT_STATE.IN_PROGRESS;
    record({ action: "ack", localId: current.localId });
    return true;
  };

  const turnCompleted = (localId) => {
    if (!current || (localId && current.localId !== localId)) return false;
    current.state = INPUT_STATE.COMPLETED;
    record({ action: "completed", localId: current.localId });
    current = null;
    return true;
  };

  const turnFailed = (localId) => {
    if (!current || (localId && current.localId !== localId)) return false;
    current.state = INPUT_STATE.UNKNOWN;
    record({ action: "failed", localId: current.localId });
    current = null;
    return true;
  };

  const disconnect = () => {
    connected = false;
    ready = false;
    if (current && (current.state === INPUT_STATE.AWAITING_ACK || current.state === INPUT_STATE.IN_PROGRESS)) {
      current.state = INPUT_STATE.UNKNOWN;
      record({ action: "disconnect", markUnknown: current.localId });
      current = null;
    } else {
      record({ action: "disconnect" });
    }
  };

  const reconnect = () => {
    connected = true;
    ready = false; // 先核对，不自动重放
    record({ action: "reconnect", state: "checking" });
  };

  const confirmReconnect = () => {
    if (!connected) return false;
    ready = true;
    record({ action: "confirmed" });
    return true;
  };

  const flush = () => {
    if (!connected) return { action: "blocked", reason: "disconnected", snapshot: snapshot() };
    if (!ready) return { action: "blocked", reason: "checking", snapshot: snapshot() };
    if (current) return { action: "blocked", reason: "busy", snapshot: snapshot() };
    const msg = held.shift();
    if (!msg) return { action: "empty", snapshot: snapshot() };
    return dispatch(msg);
  };

  // 仅由用户明确要求重发“结果未知”消息时调用；不自动触发。
  const resendUnknown = (localId) => {
    if (!connected) return { action: "blocked", reason: "disconnected", snapshot: snapshot() };
    if (!ready) return { action: "blocked", reason: "checking", snapshot: snapshot() };
    if (current) return { action: "blocked", reason: "busy", snapshot: snapshot() };
    const msg = registered.get(localId);
    if (!msg) return { action: "blocked", reason: "not-found", snapshot: snapshot() };
    if (msg.state !== INPUT_STATE.UNKNOWN) {
      return { action: "blocked", reason: `state:${msg.state}`, snapshot: snapshot() };
    }
    return dispatch(msg);
  };

  return {
    state: INPUT_STATE,
    submit,
    ack,
    turnCompleted,
    turnFailed,
    disconnect,
    reconnect,
    confirmReconnect,
    flush,
    resendUnknown,
    find: (localId) => {
      const msg = registered.get(localId);
      return msg ? { ...msg } : null;
    },
    snapshot,
    history,
  };
}
