// 回合观察器：先注册监听，再发 turn/start；按 threadId/turnId 过滤事件。
// 文本只归属到具体回合：目标回合无文本时返回空，不从其他回合或无归属缓存补值。
export function createTurnObserver(client, { threadId, timeoutMs = 180000 } = {}) {
  if (!threadId) throw new Error("threadId required");

  let turnId = null;
  let done = false;
  let text = "";
  const earlyCompletions = [];
  const textByTurn = new Map();
  const events = [];
  let resolveFn;

  const result = new Promise((resolve) => {
    resolveFn = resolve;
  });

  const textFor = (completion) => {
    if (turnId && textByTurn.has(turnId)) return textByTurn.get(turnId);
    const items = completion?.turn?.items ?? [];
    const msg = items.find((it) => it.type === "agentMessage");
    return msg?.text ?? "";
  };

  const finish = (r) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    client.off("notification", onNotification);
    client.off("exit", onExit);
    resolveFn({ ...r, threadId, turnId, text, events });
  };

  const onNotification = (msg) => {
    const p = msg.params ?? {};
    if (p.threadId && p.threadId !== threadId) {
      events.push({ method: msg.method, ignored: "other-thread" });
      return;
    }
    if (msg.method === "item/agentMessage/delta") {
      const delta = p.delta ?? "";
      if (!p.turnId) {
        // 无回合归属的增量不参与文本拼接。
        events.push({ method: msg.method, ignored: "no-turn" });
        return;
      }
      textByTurn.set(p.turnId, (textByTurn.get(p.turnId) ?? "") + delta);
      events.push({ method: msg.method, turnId: p.turnId, len: delta.length });
      return;
    }
    if (msg.method === "item/started" || msg.method === "item/completed") {
      events.push({ method: msg.method, itemType: p.item?.type, turnId: p.turnId });
      return;
    }
    if (msg.method === "turn/completed") {
      if (!turnId) {
        earlyCompletions.push(p);
        return;
      }
      if (p.turn?.id === turnId) {
        text = textFor(p);
        finish({ status: "completed", turnStatus: p.turn?.status, turnError: p.turn?.error ?? null });
      } else {
        events.push({ method: msg.method, ignored: "other-turn", otherTurnId: p.turn?.id });
      }
    }
  };

  const onExit = ({ code, signal }) => {
    finish({ status: "exit", exitCode: code, signal });
  };

  client.on("notification", onNotification);
  client.on("exit", onExit);

  const timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);

  return {
    result,
    get turnId() {
      return turnId;
    },
    bindTurn(id) {
      if (!id) return;
      turnId = id;
      for (const p of earlyCompletions) {
        if (p.turn?.id !== turnId) events.push({ method: "turn/completed", ignored: "other-turn", otherTurnId: p.turn?.id });
      }
      const hit = earlyCompletions.find((p) => p.turn?.id === turnId);
      if (hit) {
        text = textFor(hit);
        finish({ status: "completed", turnStatus: hit.turn?.status, turnError: hit.turn?.error ?? null, early: true });
      }
    },
    cancel() {
      finish({ status: "cancelled" });
    },
  };
}
