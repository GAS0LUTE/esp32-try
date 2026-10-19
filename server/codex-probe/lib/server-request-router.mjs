// server request 分派：按本机 schema 分别响应。
// 绑定连接代次、threadId、turnId、requestId；resolved 后关闭待办；新连接重建状态。
// 未实现类型返回协议允许的 JSON-RPC 错误；自动回答仅限夹具声明的固定问题。
const DECLINE = { decision: "decline" };

const THREAD_TURN_METHODS = new Set([
  "item/tool/requestUserInput",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/call",
]);

const THREAD_ONLY_METHODS = new Set(["mcpServer/elicitation/request"]);

export function createServerRequestRouter({ client, log, getThreadId, getTurnId, answers = {}, generation = 1 }) {
  let connection = generation;
  const pending = new Map(); // `${connection}:${id}` -> { method, status, threadId, turnId }
  const closed = new Set(); // 已拒绝/已关闭的请求，避免重复响应
  const handled = [];

  const keyOf = (id) => `${connection}:${id}`;
  const record = (entry) => {
    handled.push({ ...entry, connection });
    log?.log?.({ step: "serverRequest", connection, ...entry });
  };
  const reject = (id, code, message, reason) => {
    client.respondError(id, code, message);
    closed.add(keyOf(id));
    record({ requestId: id, result: reason });
    return reason;
  };

  const onNotification = (msg) => {
    if (msg.method !== "serverRequest/resolved") return false;
    const id = msg.params?.requestId;
    if (id === undefined) return false;
    const entry = pending.get(keyOf(id));
    if (entry) {
      entry.status = "resolved";
      closed.add(keyOf(id));
      pending.delete(keyOf(id));
      record({ requestId: id, method: entry.method, result: "resolved" });
    }
    return true;
  };

  const newConnection = () => {
    connection += 1;
    pending.clear();
    closed.clear();
    record({ result: "new-connection", connection });
  };

  const router = (req) => {
    const { id, method, params = {} } = req;
    if (id === undefined) {
      record({ method, result: "missing-request-id" });
      return "missing-request-id";
    }

    if (closed.has(keyOf(id))) {
      record({ requestId: id, method, result: "closed-ignored" });
      return "closed-ignored";
    }
    if (pending.has(keyOf(id))) {
      record({ requestId: id, method, result: "duplicate-ignored" });
      return "duplicate-ignored";
    }

    const boundThread = getThreadId?.();
    const boundTurn = getTurnId?.();

    if (THREAD_TURN_METHODS.has(method)) {
      if (!params.threadId || !params.turnId) {
        return reject(id, -32602, `missing threadId/turnId for ${method}`, "rejected-missing-identifier");
      }
      if (!boundThread || !boundTurn) {
        return reject(id, -32602, `target not bound for ${method}`, "rejected-unbound");
      }
      if (params.threadId !== boundThread) {
        return reject(id, -32602, "unexpected thread", "rejected-thread");
      }
      if (params.turnId !== boundTurn) {
        return reject(id, -32602, "expired turn", "rejected-turn");
      }
    } else if (THREAD_ONLY_METHODS.has(method)) {
      if (!params.threadId) {
        return reject(id, -32602, `missing threadId for ${method}`, "rejected-missing-identifier");
      }
      if (!boundThread) {
        return reject(id, -32602, `target not bound for ${method}`, "rejected-unbound");
      }
      if (params.threadId !== boundThread) {
        return reject(id, -32602, "unexpected thread", "rejected-thread");
      }
    }

    pending.set(keyOf(id), {
      method,
      status: "open",
      threadId: params.threadId,
      turnId: params.turnId,
    });

    let result;
    switch (method) {
      case "item/tool/requestUserInput": {
        const questions = params.questions ?? [];
        const reply = {};
        let supported = questions.length > 0;
        for (const q of questions) {
          const label = answers[q.id];
          if (label === undefined) {
            supported = false;
            break;
          }
          reply[q.id] = { answers: [label] };
        }
        if (!supported) {
          client.respondError(id, -32602, "test fixture does not cover this question");
          result = "unsupported-question";
        } else {
          client.respond(id, { answers: reply });
          result = "answered";
        }
        break;
      }
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        client.respond(id, DECLINE);
        result = "declined";
        break;
      case "mcpServer/elicitation/request":
        client.respond(id, { action: "decline" });
        result = "declined";
        break;
      case "item/permissions/requestApproval":
      case "item/tool/call":
      case "account/chatgptAuthTokens/refresh":
      case "attestation/generate":
      case "openai/form":
      default:
        client.respondError(id, -32601, `unsupported server request: ${method}`);
        result = "unsupported";
        break;
    }
    if (result === "answered" || result === "declined") {
      pending.get(keyOf(id)).status = "answered";
    } else {
      pending.delete(keyOf(id));
      closed.add(keyOf(id));
    }
    record({ requestId: id, method, result });
    return result;
  };

  router.onNotification = onNotification;
  router.newConnection = newConnection;
  router.handled = handled;
  router.pendingCount = () => pending.size;
  router.connection = () => connection;
  return router;
}
