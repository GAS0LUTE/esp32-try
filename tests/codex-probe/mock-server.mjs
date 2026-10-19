#!/usr/bin/env node
// 模拟 app-server：按场景产生通知与 server request，用于事件路由与异常路径测试。
// 不自称 Codex；仅用于 tests/codex-probe/run-mock-tests.mjs。
const scenario = process.argv[2] ?? "immediate";
const THREAD = "mock-thread-1";

let buf = "";
let nextServerId = 900;
const pending = new Map();
let turnCounter = 0;
let activeTurn = null;
const history = [];

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const notify = (method, params) => send({ method, params });
const serverRequest = (method, params) =>
  new Promise((resolve) => {
    const id = nextServerId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });
const respondStart = async (msg, turnId, delay = 30) => {
  send({ id: msg.id, result: { turn: { id: turnId } } });
  await new Promise((resolve) => setTimeout(resolve, delay));
};

const complete = (turnId, status = "completed", text = "ACK") => {
  if (text) notify("item/agentMessage/delta", { threadId: THREAD, turnId, itemId: "item-1", delta: text });
  notify("turn/completed", {
    threadId: THREAD,
    turn: { id: turnId, status, items: [{ type: "agentMessage", id: "item-1", text }] },
  });
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

async function handle(msg) {
  if (msg.id !== undefined && !msg.method) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    if (resolve) resolve(msg);
    return;
  }
  switch (msg.method) {
    case "initialize":
      send({ id: msg.id, result: { userAgent: "mock-app-server/1.0 (test)", codexHome: "~/mock", platformFamily: "unix", platformOs: "macos" } });
      break;
    case "initialized":
      break;
    case "thread/start":
      send({ id: msg.id, result: { thread: { id: THREAD } } });
      break;
    case "thread/resume":
      send({ id: msg.id, result: { thread: { id: msg.params?.threadId ?? THREAD } } });
      break;
    case "thread/read":
      send({ id: msg.id, result: { thread: { id: msg.params?.threadId ?? THREAD, turns: history } } });
      break;
    case "thread/list":
      send({ id: msg.id, result: { data: [{ id: THREAD }], nextCursor: null } });
      break;
    case "turn/start": {
      if (scenario === "busy" && activeTurn) {
        send({ id: msg.id, error: { code: -32000, message: "turn already in progress" } });
        break;
      }
      const turnId = `mock-turn-${++turnCounter}`;
      activeTurn = turnId;
      if (scenario === "timeout-on-turn") break;
      if (scenario === "exit-on-turn") process.exit(7);
      if (scenario === "immediate-complete") {
        complete(turnId, "completed", "ACK");
        send({ id: msg.id, result: { turn: { id: turnId } } });
        history.push({ id: turnId, status: "completed", items: [{ type: "agentMessage", text: "ACK" }] });
        activeTurn = null;
        break;
      }
      if (scenario === "other-turn") {
        complete("mock-turn-other", "completed", "WRONG");
        complete(turnId, "completed", "ACK");
        send({ id: msg.id, result: { turn: { id: turnId } } });
        history.push({ id: turnId, status: "completed", items: [] });
        activeTurn = null;
        break;
      }
      if (scenario === "busy") {
        // 首个回合保持运行，不发完成通知；用于验证忙碌与“不重复提交”。
        send({ id: msg.id, result: { turn: { id: turnId } } });
        break;
      }
      if (scenario === "c01-empty-target") {
        // 同线程其他回合先到 delta；目标回合完成但无文本、items 为空。
        notify("item/agentMessage/delta", { threadId: THREAD, turnId: "mock-turn-other", itemId: "i0", delta: "OTHER" });
        notify("turn/completed", { threadId: THREAD, turn: { id: turnId, status: "completed", items: [] } });
        send({ id: msg.id, result: { turn: { id: turnId } } });
        activeTurn = null;
        break;
      }
      if (scenario === "stale-turn") {
        // 先确认当前回合，再发送属于旧回合的请求。
        await respondStart(msg, turnId);
        const res = await serverRequest("item/commandExecution/requestApproval", {
          threadId: THREAD, turnId: "mock-turn-old", itemId: "c0", startedAtMs: 0, command: "x",
        });
        complete(turnId, "completed", res?.error?.code === -32602 ? "REJECTED" : "UNEXPECTED");
        activeTurn = null;
        break;
      }
      if (scenario === "resolved-dup") {
        await respondStart(msg, turnId);
        const rid = 950;
        const waitFor = (id) => new Promise((resolve) => pending.set(id, resolve));
        const first = waitFor(rid);
        send({ id: rid, method: "item/commandExecution/requestApproval", params: { threadId: THREAD, turnId, itemId: "c1", startedAtMs: 0, command: "x" } });
        await first;
        notify("serverRequest/resolved", { requestId: rid, threadId: THREAD });
        const second = waitFor(rid);
        send({ id: rid, method: "item/commandExecution/requestApproval", params: { threadId: THREAD, turnId, itemId: "c1", startedAtMs: 0, command: "x" } });
        const timedOut = await Promise.race([second.then(() => false), new Promise((r) => setTimeout(() => r(true), 300))]);
        complete(turnId, "completed", timedOut ? "NO_DOUBLE" : "DOUBLE");
        activeTurn = null;
        break;
      }
      if (scenario === "approval") {
        await respondStart(msg, turnId);
        const res = await serverRequest("item/commandExecution/requestApproval", {
          threadId: THREAD, turnId, itemId: "exec-1", command: "curl example.com",
        });
        complete(turnId, "completed", res?.result?.decision === "decline" ? "DENIED" : "UNEXPECTED");
        activeTurn = null;
        break;
      }
      if (scenario === "file-approval") {
        await respondStart(msg, turnId);
        const res = await serverRequest("item/fileChange/requestApproval", {
          threadId: THREAD, turnId, itemId: "file-1", reason: "write test file",
        });
        complete(turnId, "completed", res?.result?.decision === "decline" ? "DENIED" : "UNEXPECTED");
        activeTurn = null;
        break;
      }
      if (scenario === "user-input") {
        await respondStart(msg, turnId);
        const res = await serverRequest("item/tool/requestUserInput", {
          threadId: THREAD, turnId, itemId: "ask-1", isBlocking: true,
          questions: [{
            id: "continue_testing", header: "测试确认", question: "是否继续测试？",
            options: [{ label: "继续", description: "继续" }, { label: "停止", description: "停止" }],
          }],
        });
        const answer = res?.result?.answers?.continue_testing?.answers?.[0];
        complete(turnId, "completed", answer === "继续" ? "ANSWERED" : "NO_ANSWER");
        activeTurn = null;
        break;
      }
      if (scenario === "request-coverage") {
        await respondStart(msg, turnId);
        const outcomes = [];
        const cmd = await serverRequest("item/commandExecution/requestApproval", { threadId: THREAD, turnId, itemId: "c1" });
        outcomes.push(`cmd:${cmd?.result?.decision ?? cmd?.error?.code}`);
        const file = await serverRequest("item/fileChange/requestApproval", { threadId: THREAD, turnId, itemId: "f1" });
        outcomes.push(`file:${file?.result?.decision ?? file?.error?.code}`);
        const ask = await serverRequest("item/tool/requestUserInput", {
          threadId: THREAD, turnId, itemId: "q1", isBlocking: true,
          questions: [{ id: "continue_testing", header: "确认", question: "继续？", options: [{ label: "继续" }] }],
        });
        outcomes.push(`ask:${ask?.result?.answers?.continue_testing?.answers?.[0] ?? ask?.error?.code}`);
        const elic = await serverRequest("mcpServer/elicitation/request", { threadId: THREAD, turnId, serverName: "mock" });
        outcomes.push(`elic:${elic?.result?.action ?? elic?.error?.code}`);
        const perm = await serverRequest("item/permissions/requestApproval", { threadId: THREAD, turnId, itemId: "p1" });
        outcomes.push(`perm:${perm?.result ? "answered" : perm?.error?.code}`);
        const tool = await serverRequest("item/tool/call", { threadId: THREAD, turnId, itemId: "t1", name: "x" });
        outcomes.push(`tool:${tool?.result ? "answered" : tool?.error?.code}`);
        const auth = await serverRequest("account/chatgptAuthTokens/refresh", { reason: "test" });
        outcomes.push(`auth:${auth?.result ? "answered" : auth?.error?.code}`);
        const att = await serverRequest("attestation/generate", {});
        outcomes.push(`att:${att?.result ? "answered" : att?.error?.code}`);
        const form = await serverRequest("openai/form", { threadId: THREAD });
        outcomes.push(`form:${form?.result ? "answered" : form?.error?.code}`);
        complete(turnId, "completed", outcomes.join(","));
        activeTurn = null;
        break;
      }
      if (scenario === "unknown-request") {
        await respondStart(msg, turnId);
        const res = await serverRequest("item/tool/call", { threadId: THREAD, turnId, itemId: "tool-1", name: "x" });
        complete(turnId, "completed", res?.error?.code === -32601 ? "UNSUPPORTED_OK" : "UNEXPECTED");
        activeTurn = null;
        break;
      }
      if (scenario === "file-approval-and-input") {
        await respondStart(msg, turnId);
        const a = await serverRequest("item/fileChange/requestApproval", { threadId: THREAD, turnId, itemId: "f1" });
        const b = await serverRequest("item/tool/requestUserInput", {
          threadId: THREAD, turnId, itemId: "q1", isBlocking: true,
          questions: [{ id: "continue_testing", header: "确认", question: "继续？", options: [{ label: "继续" }, { label: "停止" }] }],
        });
        const answer = b?.result?.answers?.continue_testing?.answers?.[0];
        complete(turnId, "completed", `${a?.result?.decision}/${answer}`);
        activeTurn = null;
        break;
      }
      // 默认：延迟 10ms 后正常完成
      setTimeout(() => {
        complete(turnId, "completed", "ACK");
        send({ id: msg.id, result: { turn: { id: turnId } } });
        activeTurn = null;
      }, 10);
      break;
    }
    case "turn/interrupt":
      send({ id: msg.id, result: {} });
      break;
    default:
      send({ id: msg.id, error: { code: -32601, message: `mock does not implement ${msg.method}` } });
      break;
  }
}

process.stdin.on("end", () => process.exit(0));
