// 从 rollout 行中解析消息与回合归属，并按“完整用户消息 + 同回合回复”确认送达。
export function parseRolloutEvents(lines) {
  const events = [];
  let currentTurn = null;
  let lastUserIndex = -1;

  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "turn_context") {
      const turnId = o.payload?.turn_id ?? null;
      if (turnId) {
        currentTurn = turnId;
        for (let i = lastUserIndex >= 0 ? lastUserIndex : 0; i < events.length; i++) {
          if (events[i].turnId === null) events[i].turnId = turnId;
        }
      }
      continue;
    }
    if (o.type === "response_item" && o.payload?.type === "message") {
      const role = o.payload.role;
      const text = (o.payload.content ?? []).map((c) => c.text ?? "").join("");
      // 新用户消息不继承上一回合；等明确的 turn_context / event_msg 关联。
      const turnId = role === "user" ? null : currentTurn;
      events.push({ role, text, rawText: text, ts: o.timestamp ?? null, turnId, final: false });
      if (role === "user") lastUserIndex = events.length - 1;
      continue;
    }
    if (o.type === "event_msg") {
      const turnId = o.payload?.turn_id ?? null;
      if (turnId) {
        currentTurn = turnId;
        // 本回合的用户消息与已出现的回复都归到这个回合。
        for (let i = lastUserIndex >= 0 ? lastUserIndex : 0; i < events.length; i++) {
          if (events[i].turnId === null) events[i].turnId = turnId;
        }
        const kind = o.payload?.type;
        const finalText = o.payload?.last_agent_message;
        if (kind === "task_complete" && typeof finalText === "string" && finalText.trim()) {
          events.push({ role: "assistant", text: finalText, rawText: finalText, ts: o.timestamp ?? null, turnId, final: true });
        }
        if (["task_failed", "turn_failed", "task_aborted", "turn_aborted"].includes(kind)) {
          events.push({ role: "assistant", text: "", rawText: "", ts: o.timestamp ?? null, turnId, final: true, failed: true });
        }
      }
    }
  }
  return events;
}

// 传输层可能补一个行尾换行；只规范化换行符与末尾换行，其余逐字比较。
export function canonicalText(s) {
  return String(s ?? "").replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

export function textMatches(expected, actual) {
  return canonicalText(expected) === canonicalText(actual);
}

// 只认完整且精确的用户消息；回复必须落在同一回合、且在下一条用户消息之前。
export function findDelivery(events, expectedText, { sinceTs = null } = {}) {
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.role !== "user" || !textMatches(expectedText, e.text)) continue;
    if (sinceTs && e.ts && e.ts < sinceTs) continue;
    const nextUser = events.findIndex((x, j) => j > i && x.role === "user");
    const slice = events.slice(i + 1, nextUser < 0 ? events.length : nextUser);
    // 只有明确的同回合终态回复才算 replied；未知回合不匹配任何回复。
    const reply =
      e.turnId == null
        ? null
        : slice.find((x) => x.role === "assistant" && x.final === true && x.turnId === e.turnId) ?? null;
    return { found: true, user: e, turnId: e.turnId ?? null, reply, failed: Boolean(reply?.failed) };
  }
  return { found: false, user: null, turnId: null, reply: null };
}
