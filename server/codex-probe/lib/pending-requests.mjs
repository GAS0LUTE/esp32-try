// F03-P 生产只读日志观察器（仅日志来源）：
// - 永远返回 unknown；候选 answerable=false；
// - 新用户消息开启新的归属区间，不继承上一回合；
// - 无明确回合时按区间隔离，同 callId 不跨区间去重；
// - 不提供 currentValidity / closureProtocol 等升级入口。
const REQUEST_NAMES = new Set(["request_user_input", "request_user_input_async"]);
const APPROVAL_HINT = /approval|permission|request_permissions|elicitation/i;

function parseQuestions(argumentsText) {
  let args;
  try {
    args = typeof argumentsText === "string" ? JSON.parse(argumentsText) : argumentsText;
  } catch {
    return { questions: [], parseError: true };
  }
  const raw = Array.isArray(args?.questions) ? args.questions : [];
  const questions = raw.map((q) => ({
    id: q?.id ?? null,
    header: q?.header ?? null,
    question: q?.question ?? q?.title ?? null,
    options: Array.isArray(q?.options)
      ? q.options.map((o) => (typeof o === "string" ? o : o?.label ?? null)).filter((x) => typeof x === "string")
      : [],
  }));
  return { questions, parseError: false };
}

export function parsePendingRequests(lines, { threadId = null, complete = true, lag = false } = {}) {
  if (!complete || lag) return { status: "unknown", reason: "incomplete-read", entries: [], source: "rollout" };
  if (!threadId) return { status: "unknown", reason: "no-bound-target", entries: [], source: "rollout" };

  let sessionMetaId = null;
  let parseErrors = 0;
  let currentTurn = null;
  let interval = 0;
  const calls = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { parseErrors += 1; continue; }
    const p = o.payload ?? {};

    if (o.type === "session_meta") {
      sessionMetaId = p.id ?? p.session_id ?? sessionMetaId;
      continue;
    }
    // 新用户消息开启新归属区间；在明确回合证据出现前，不继承上一回合。
    if (o.type === "response_item" && p.type === "message" && p.role === "user") {
      interval += 1;
      currentTurn = null;
      continue;
    }
    // 只有明确的“新回合”证据才能归属：turn_context 或 task_started。
    // 旧回合的 task_complete/item_completed/token_count 等不得回填新用户之后的候选。
    const isNewTurn =
      (o.type === "turn_context" && p.turn_id) ||
      (o.type === "event_msg" && p.type === "task_started" && p.turn_id);
    if (isNewTurn) {
      currentTurn = p.turn_id;
      for (const c of calls) {
        if (c.interval === interval && c.turnId == null) c.turnId = p.turn_id;
      }
      continue;
    }
    if (o.type === "response_item" && p.type === "function_call") {
      const name = String(p.name ?? "");
      if (REQUEST_NAMES.has(name)) {
        const parsed = parseQuestions(p.arguments);
        calls.push({
          i,
          callId: p.call_id ?? null,
          itemId: p.id ?? null,
          turnId: currentTurn,
          interval,
          questions: parsed.questions,
          parseError: parsed.parseError,
          kind: "clarification",
        });
      } else if (APPROVAL_HINT.test(name)) {
        calls.push({ i, callId: p.call_id ?? null, itemId: p.id ?? null, turnId: currentTurn, interval, questions: [], parseError: false, kind: "unsupported" });
      }
    }
  }

  if (sessionMetaId && sessionMetaId !== threadId) {
    return { status: "unknown", reason: "session-mismatch", entries: [], source: "rollout", sessionMetaId };
  }
  if (!sessionMetaId) return { status: "unknown", reason: "no-session-meta", entries: [], source: "rollout" };
  if (parseErrors > 0) return { status: "unknown", reason: "parse-error", entries: [], source: "rollout", parseErrors };

  const entries = [];
  const seen = new Set();
  let duplicates = 0;
  for (const c of calls) {
    // 无明确回合时按区间隔离；同 callId 跨区间不得合并。
    const key = c.turnId
      ? `${c.turnId}:${c.callId ?? `i${c.i}`}`
      : `interval:${c.interval}:${c.callId ?? `i${c.i}`}`;
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);

    const questionTextOk =
      c.questions.length > 0 && c.questions.every((q) => typeof q.question === "string" && q.question.trim().length > 0);
    entries.push({
      callId: c.callId,
      itemId: c.itemId,
      turnId: c.turnId,
      kind: c.kind,
      questions: c.questions,
      answerable: false, // 日志来源永远不可回答
      reason: !c.callId
        ? "missing-call-id"
        : !c.turnId
          ? "missing-turn-id"
          : c.parseError
            ? "unparseable-arguments"
            : !questionTextOk
              ? "missing-question-content"
              : null,
    });
  }

  return {
    status: "unknown",
    reason: "no-current-validity",
    entries,
    source: "rollout",
    threadId,
    candidates: entries.length > 0,
    promptCheckOnComputer: true,
    duplicates,
  };
}
