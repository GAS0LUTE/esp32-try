#!/usr/bin/env node
// INT-001 模拟夹具：D01 事件路由与异常路径、D02 请求分派、T06/T07/T08/T09/T10。
// 输出 PASS/FAIL/UNVERIFIED，FAIL 时退出码非零。不连接真实 Codex。
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../../server/codex-probe/lib/rpc-client.mjs";
import { createTurnObserver } from "../../server/codex-probe/lib/turn-observer.mjs";
import { createServerRequestRouter } from "../../server/codex-probe/lib/server-request-router.mjs";
import { createLogger, DEFAULT_FIELDS } from "../../server/codex-probe/lib/log.mjs";
import { checkBinaryAgainstSchema } from "../../server/codex-probe/lib/version-check.mjs";
import { createInputController } from "../../server/codex-probe/lib/input-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MOCK = path.join(ROOT, "tests/codex-probe/mock-server.mjs");
const DESKTOP_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

const extractMethods = (root) => {
  const out = new Set();
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o.enum) && o.enum.some((v) => typeof v === "string" && v.includes("/"))) o.enum.forEach((v) => out.add(v));
    Object.values(o).forEach(walk);
  };
  walk(root);
  return out;
};

const results = [];
const check = (name, cond, detail = "") => {
  const ok = Boolean(cond);
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
};
const unverified = (name, reason) => {
  results.push({ name, ok: null, detail: reason });
  console.log(`UNVERIFIED ${name} — ${reason}`);
};

const clients = [];
const uniqueLog = (scenario) =>
  path.join(ROOT, "tests/codex-probe/logs", `mock-${scenario}-${Date.now()}-${process.pid}.jsonl`);

async function open(scenario, { requestTimeoutMs = 800 } = {}) {
  const log = createLogger(uniqueLog(scenario), { allowedFields: DEFAULT_FIELDS });
  const client = new RpcClient({
    bin: process.execPath,
    args: [MOCK, scenario],
    requestTimeoutMs,
    name: scenario,
  });
  clients.push(client);
  client.on("stderr", (d) => log.log({ step: "stderr", text: d }));
  client.on("notification", (msg) => log.log({ step: "notification", method: msg.method, threadId: msg.params?.threadId, turnId: msg.params?.turn?.id }));
  let threadId = null;
  let boundTurn = null;
  const router = createServerRequestRouter({
    client,
    log,
    getThreadId: () => threadId,
    getTurnId: () => boundTurn,
    answers: { continue_testing: "继续" },
  });
  client.on("notification", (msg) => router.onNotification(msg));
  client.on("serverRequest", (req) => {
    log.log({ step: "serverRequest", method: req.method, requestId: req.id });
    router(req);
  });
  client.start();
  await client.request("initialize", { clientInfo: { name: "gpt-cube-probe", version: "0.2.0" } });
  client.notify("initialized", {});
  const start = await client.request("thread/start", { cwd: ROOT, approvalPolicy: "never" });
  threadId = start.thread.id;
  return { client, log, router, threadId, setTurn: (id) => { boundTurn = id; }, logPath: log.path };
}

async function runTurn(env, { input = "test", timeoutMs = 2000 } = {}) {
  const server = env.client;
  const observer = createTurnObserver(server, { threadId: env.threadId, timeoutMs });
  let startResponse = null;
  let startError = null;
  try {
    startResponse = await server.request("turn/start", { threadId: env.threadId, input: [{ type: "text", text: input }] });
    env.setTurn?.(startResponse.turn?.id);
    observer.bindTurn(startResponse.turn?.id);
  } catch (e) {
    startError = e;
  }
  const result = await observer.result;
  env.log.log({ step: "turnResult", status: result.status, turnId: result.turnId, text: result.text });
  return { startResponse, startError, result, observer };
}

async function closeAll() {
  for (const c of clients) await c.close({ timeoutMs: 1000 });
}

const main = async () => {
  // 1. 通知先于响应：立即完成
  {
    const env = await open("immediate-complete");
    const { startResponse, result } = await runTurn(env);
    check("D01 立即完成：turn/start 有 turnId", startResponse?.turn?.id === "mock-turn-1");
    check("D01 立即完成：观察器得到 completed", result.status === "completed", result.status);
    check("D01 立即完成：回复内容 ACK", result.text === "ACK", result.text);
    check("D01 立即完成：回合状态 completed", result.turnStatus === "completed", String(result.turnStatus));
    await env.client.close();
  }

  // 2. 其他回合完成不应误判
  {
    const env = await open("other-turn");
    const { result } = await runTurn(env);
    check("D01 其他回合完成被忽略", result.status === "completed" && result.turnId === "mock-turn-1");
    check("D01 其他回合内容未混入", result.text === "ACK", result.text);
    check("D01 其他回合有忽略记录", result.events.some((e) => e.ignored === "other-turn"));
    await env.client.close();
  }

  // 3. 子进程退出：不挂起
  {
    const env = await open("exit-on-turn");
    const { startError, result } = await runTurn(env);
    check("D01 子进程退出：观察器退出状态", result.status === "exit" && result.exitCode === 7, JSON.stringify(result));
    check("D01 子进程退出：请求被拒绝", startError?.code === "PROCESS_EXIT", String(startError?.code));
    check("D01 子进程退出：无残留请求", env.client.pending.size === 0, String(env.client.pending.size));
    await env.client.close();
  }

  // 4. 超时：请求与观察器均超时
  {
    const env = await open("timeout-on-turn", { requestTimeoutMs: 300 });
    const { startError, result } = await runTurn(env, { timeoutMs: 700 });
    check("D01 超时：请求超时", startError?.code === "TIMEOUT", String(startError?.code));
    check("D01 超时：观察器超时", result.status === "timeout", result.status);
    await env.client.close();
  }

  // 5. 命令审批拒绝
  {
    const env = await open("approval");
    const { result } = await runTurn(env);
    check("D02 命令审批：拒绝并继续", result.text === "DENIED", result.text);
    check("D02 命令审批：分派记录 declined", env.router.handled.some((h) => h.result === "declined"));
    await env.client.close();
  }

  // 6. 文件审批拒绝（独立记录）
  {
    const env = await open("file-approval");
    const { result } = await runTurn(env);
    check("D02 文件审批：拒绝并继续", result.text === "DENIED", result.text);
    const h = env.router.handled.find((x) => x.method === "item/fileChange/requestApproval");
    check("D02 文件审批：类型独立", h?.result === "declined", JSON.stringify(h));
    await env.client.close();
  }

  // 7. 澄清请求
  {
    const env = await open("user-input");
    const { result } = await runTurn(env);
    check("D02 澄清：固定问题回答", result.text === "ANSWERED", result.text);
    check("D02 澄清：分派记录 answered", env.router.handled.some((h) => h.result === "answered"));
    await env.client.close();
  }

  // 8. 未实现类型：协议错误，不挂起
  {
    const env = await open("unknown-request");
    const { result } = await runTurn(env);
    check("D02 未实现类型：返回 -32601", result.text === "UNSUPPORTED_OK", result.text);
    check("D02 未实现类型：分派记录 unsupported", env.router.handled.some((h) => h.result === "unsupported"));
    await env.client.close();
  }

  // 8b. D02 全类型覆盖
  {
    const env = await open("request-coverage");
    const { result } = await runTurn(env);
    const expected = "cmd:decline,file:decline,ask:继续,elic:decline,perm:-32601,tool:-32601,auth:-32601,att:-32601,form:-32601";
    check("D02 请求覆盖：9 类分派结果", result.text === expected, result.text);
    check("D02 请求覆盖：handled 9 条", env.router.handled.length === 9, String(env.router.handled.length));
    const schemaMethods = extractMethods(JSON.parse(fs.readFileSync(path.join(ROOT, "server/codex-probe/schema/ServerRequest.json"), "utf8")));
    const handledMethods = env.router.handled.map((h) => h.method);
    check("C04 覆盖本机全部 ServerRequest 类型", schemaMethods.size === 9 && [...schemaMethods].every((m) => handledMethods.includes(m)), [...schemaMethods].join(","));
    await env.client.close();
  }

  // 9. T06：同一回合多请求逐项处理
  {
    const env = await open("file-approval-and-input");
    const { result } = await runTurn(env);
    check("T06 多请求：审批与澄清均处理", result.text === "decline/继续", result.text);
    check("T06 多请求：分派顺序", env.router.handled.map((h) => h.result).join(",") === "declined,answered");
    await env.client.close();
  }

  // 10. T06：错误目标不发送
  {
    const responses = [];
    const fake = {
      respond: (id, r) => responses.push({ id, result: r }),
      respondError: (id, code, message) => responses.push({ id, error: { code, message } }),
    };
    const router = createServerRequestRouter({ client: fake, getThreadId: () => "thread-A", getTurnId: () => "turn-A", answers: { q1: "继续" } });
    const action = router({ id: 1, method: "item/tool/requestUserInput", params: { threadId: "thread-B", turnId: "turn-A", questions: [{ id: "q1" }] } });
    check("T06 错误目标：拒绝且不答复", action === "rejected-thread" && responses.length === 1 && responses[0].error?.code === -32602, JSON.stringify(responses));
  }

  // 11. T07：重复回答不重复发送
  {
    const responses = [];
    const fake = {
      respond: (id, r) => responses.push({ id, result: r }),
      respondError: (id, code, message) => responses.push({ id, error: { code, message } }),
    };
    const router = createServerRequestRouter({ client: fake, getThreadId: () => "thread-A", getTurnId: () => "turn-A", answers: { q1: "继续" } });
    const req = { id: 7, method: "item/tool/requestUserInput", params: { threadId: "thread-A", turnId: "turn-A", questions: [{ id: "q1" }] } };
    const first = router(req);
    const second = router(req);
    check("T07 重复回答：第二次不再发送", first === "answered" && second === "duplicate-ignored" && responses.length === 1, `${first}/${second}/${responses.length}`);
    unverified("T07 上游 clientUserMessageId 幂等", "需真实会话重复发送实验，模拟不能代替");
  }

  // C01：目标回合无文本时不从其他回合补值
  {
    const env = await open("c01-empty-target");
    const { result } = await runTurn(env);
    check("C01 目标无文本：结果为空", result.text === "", JSON.stringify(result.text));
    check("C01 其他回合 delta 未混入", !result.text.includes("OTHER"));
    check("C01 其他回合 delta 有记录", result.events.some((e) => e.turnId === "mock-turn-other"));
    await env.client.close();
  }

  // C02：同线程过期回合不得被回答
  {
    const env = await open("stale-turn");
    const { result } = await runTurn(env);
    check("C02 过期回合：拒绝且不回答", result.text === "REJECTED", result.text);
    check("C02 过期回合：记录 rejected-turn", env.router.handled.some((h) => h.result === "rejected-turn"));
    await env.client.close();
  }

  // C02：resolved 之后重复请求不得再次响应
  {
    const env = await open("resolved-dup");
    const { result } = await runTurn(env);
    check("C02 resolved 后重复：不再响应", result.text === "NO_DOUBLE", result.text);
    check("C02 resolved 有记录", env.router.handled.some((h) => h.result === "resolved"));
    check("C02 关闭后可忽略", env.router.handled.some((h) => h.result === "closed-ignored"));
    await env.client.close();
  }

  // C02：缺必要标识不自动回答
  {
    const responses = [];
    const fake = {
      respond: (id, r) => responses.push({ id, result: r }),
      respondError: (id, code) => responses.push({ id, error: { code } }),
    };
    const router = createServerRequestRouter({ client: fake, getThreadId: () => "t", getTurnId: () => "u", answers: { q1: "继续" } });
    const action = router({ id: 11, method: "item/tool/requestUserInput", params: { threadId: "t", questions: [{ id: "q1" }] } });
    check("C02 缺 turnId：拒绝且不回答", action === "rejected-missing-identifier" && responses.length === 1 && responses[0].error?.code === -32602, JSON.stringify(responses));
  }

  // C02：新连接重建请求状态
  {
    const responses = [];
    const fake = {
      respond: (id, r) => responses.push({ id, result: r }),
      respondError: (id, code) => responses.push({ id, error: { code } }),
    };
    const router = createServerRequestRouter({ client: fake, getThreadId: () => "t", getTurnId: () => "u", answers: { q1: "继续" } });
    const req = { id: 21, method: "item/tool/requestUserInput", params: { threadId: "t", turnId: "u", questions: [{ id: "q1" }] } };
    const first = router(req);
    router.newConnection();
    const second = router(req);
    check("C02 重连后同 ID 可重新回答", first === "answered" && second === "answered" && responses.length === 2, `${first}/${second}/${responses.length}`);
  }

  // C03：忙碌保留、显式发送
  {
    const sent = [];
    const ctl = createInputController({ sendTurn: (m) => sent.push(m) });
    const a = ctl.submit("first");
    ctl.ack(a.message.localId);
    const b = ctl.submit("second");
    check("C03 空闲发送", a.action === "sent" && sent.length === 1);
    check("C03 忙碌保留未发送", b.action === "held" && sent.length === 1);
    ctl.turnCompleted(a.message.localId);
    check("C03 忙碌恢复不自动发送", sent.length === 1 && ctl.snapshot().held.length === 1);
    const f = ctl.flush();
    check("C03 显式发送触发", f.action === "sent" && sent.length === 2);
  }

  // C03：发送后未确认即断线，重连先核对、不自动重放
  {
    const sent = [];
    const ctl = createInputController({ sendTurn: (m) => sent.push(m) });
    const a = ctl.submit("pending");
    ctl.ack(a.message.localId);
    ctl.disconnect();
    check("C03 断线标记结果未知", ctl.find(a.message.localId)?.state === "unknown");
    ctl.reconnect();
    check("C03 重连进入核对", ctl.snapshot().ready === false);
    const blocked = ctl.flush();
    check("C03 核对前不自动发送", blocked.action === "blocked" && sent.length === 1);
    ctl.confirmReconnect();
    const resend = ctl.resendUnknown(a.message.localId);
    check("C03 用户显式重发未知消息", resend.action === "sent" && sent.length === 2);
  }

  // C03：断线期间输入保留，重连后显式补发
  {
    const sent = [];
    const ctl = createInputController({ sendTurn: (m) => sent.push(m) });
    ctl.disconnect();
    const b = ctl.submit("offline");
    check("C03 断线时保留", b.action === "held");
    ctl.reconnect();
    ctl.confirmReconnect();
    const f = ctl.flush();
    check("C03 重连后显式补发", f.action === "sent" && sent.length === 1);
  }

  // R01：首次 ACK 前只发送一次
  {
    const sent = [];
    const ctl = createInputController({ sendTurn: (m) => sent.push(m) });
    const a = ctl.submit("a");
    const b = ctl.submit("b");
    check("R01 首次 ACK 前只发送一次", b.action === "held" && sent.length === 1, `${b.action}/${sent.length}`);
    check("R01 第一条仍为 current", ctl.snapshot().current?.localId === a.message.localId);
    check("R01 后续输入保留", ctl.snapshot().held.length === 1);
    const f = ctl.flush();
    check("R01 发送中 flush 被阻止", f.action === "blocked" && f.reason === "busy" && sent.length === 1, `${f.action}/${f.reason}`);
  }

  // R01：核对前重发被阻止
  {
    const sent = [];
    const ctl = createInputController({ sendTurn: (m) => sent.push(m) });
    const a = ctl.submit("a");
    ctl.disconnect();
    ctl.reconnect();
    const r = ctl.resendUnknown(a.message.localId);
    check("R01 核对前重发不发送", r.action === "blocked" && r.reason === "checking" && sent.length === 1, `${r.action}/${r.reason}`);
  }

  // R01：处理中重发被阻止
  {
    const sent = [];
    const ctl = createInputController({ sendTurn: (m) => sent.push(m) });
    const a = ctl.submit("a");
    ctl.ack(a.message.localId);
    const r = ctl.resendUnknown(a.message.localId);
    check("R01 处理中重发不发送", r.action === "blocked" && r.reason === "busy" && sent.length === 1, `${r.action}/${r.reason}`);
  }

  // R01：一次显式重发后再次调用不重复发送；完成后不得当未知重发
  {
    const sent = [];
    const ctl = createInputController({ sendTurn: (m) => sent.push(m) });
    const a = ctl.submit("a");
    ctl.disconnect();
    ctl.reconnect();
    ctl.confirmReconnect();
    const first = ctl.resendUnknown(a.message.localId);
    const second = ctl.resendUnknown(a.message.localId);
    check("R01 显式重发一次", first.action === "sent" && sent.length === 2, `${first.action}/${sent.length}`);
    check("R01 重发后再次调用被阻止", second.action === "blocked" && (second.reason === "busy" || second.reason.startsWith("state:")) && sent.length === 2, second.reason);
    ctl.ack(a.message.localId);
    ctl.turnCompleted(a.message.localId);
    const third = ctl.resendUnknown(a.message.localId);
    check("R01 完成后不得按未知重发", third.action === "blocked" && third.reason === "state:completed" && sent.length === 2, third.reason);
  }

  // R01：恢复后显式补发的正常路径
  {
    const sent = [];
    const ctl = createInputController({ sendTurn: (m) => sent.push(m) });
    ctl.disconnect();
    const b = ctl.submit("offline");
    check("R01 恢复后补发前置：已保留", b.action === "held");
    ctl.reconnect();
    ctl.confirmReconnect();
    const f = ctl.flush();
    check("R01 恢复后显式补发", f.action === "sent" && sent.length === 1 && ctl.snapshot().current?.localId === b.message.localId);
  }

  // R02：目标未绑定时不产生业务答复
  {
    const makeRouter = (thread, turn) => {
      const calls = { respond: 0, respondError: 0, lastError: null };
      const fake = {
        respond: () => { calls.respond += 1; },
        respondError: (id, code) => { calls.respondError += 1; calls.lastError = code; },
      };
      const router = createServerRequestRouter({
        client: fake, getThreadId: () => thread, getTurnId: () => turn,
        answers: { q1: "继续" },
      });
      return { router, calls };
    };
    const question = { threadId: "thread-A", turnId: "turn-A", questions: [{ id: "q1" }] };
    const approval = { threadId: "thread-A", turnId: "turn-A", itemId: "c1", startedAtMs: 0 };

    const both = makeRouter(null, null);
    const r1 = both.router({ id: 31, method: "item/tool/requestUserInput", params: question });
    check("R02 thread/turn 均空：澄清不答复", r1 === "rejected-unbound" && both.calls.respond === 0, r1);
    const r2 = both.router({ id: 32, method: "item/commandExecution/requestApproval", params: approval });
    check("R02 thread/turn 均空：审批不答复", r2 === "rejected-unbound" && both.calls.respond === 0, r2);

    const threadOnly = makeRouter("thread-A", null);
    const r3 = threadOnly.router({ id: 33, method: "item/tool/requestUserInput", params: question });
    check("R02 仅 turn 空：不答复", r3 === "rejected-unbound" && threadOnly.calls.respond === 0, r3);
    const r3b = threadOnly.router({ id: 38, method: "item/commandExecution/requestApproval", params: approval });
    check("R02 仅 turn 空：审批不答复", r3b === "rejected-unbound" && threadOnly.calls.respond === 0, r3b);

    const turnOnly = makeRouter(null, "turn-A");
    const r4 = turnOnly.router({ id: 34, method: "item/tool/requestUserInput", params: question });
    check("R02 仅 thread 空：不答复", r4 === "rejected-unbound" && turnOnly.calls.respond === 0, r4);
    const r4b = turnOnly.router({ id: 39, method: "item/commandExecution/requestApproval", params: approval });
    check("R02 仅 thread 空：审批不答复", r4b === "rejected-unbound" && turnOnly.calls.respond === 0, r4b);

    const threadMismatch = makeRouter("thread-B", "turn-A");
    const r5 = threadMismatch.router({ id: 35, method: "item/tool/requestUserInput", params: question });
    check("R02 目标不匹配：不答复", r5 === "rejected-thread" && threadMismatch.calls.respond === 0, r5);

    const elicUnbound = makeRouter(null, null);
    const r6 = elicUnbound.router({ id: 36, method: "mcpServer/elicitation/request", params: { threadId: "thread-A", serverName: "mock" } });
    check("R02 thread-only 未绑定：不答复", r6 === "rejected-unbound" && elicUnbound.calls.respond === 0, r6);

    const bound = makeRouter("thread-A", "turn-A");
    const r7 = bound.router({ id: 37, method: "item/tool/requestUserInput", params: question });
    check("R02 绑定后正常答复", r7 === "answered" && bound.calls.respond === 1, r7);
  }

  // 12. T08：断线后重连（新实例恢复）
  {
    const env = await open("resume");
    env.log.log({ step: "reconnect" });
    const resume = await env.client.request("thread/resume", { threadId: env.threadId });
    const read = await env.client.request("thread/read", { threadId: env.threadId, includeTurns: true });
    check("T08 重连：恢复线程", resume.thread?.id === env.threadId, JSON.stringify(resume));
    check("T08 重连：读取线程", Array.isArray(read.thread?.turns), JSON.stringify(read));
    unverified("T08 真实中途断线", "本地不自动重放由 C03 覆盖；服务器侧中途断线未测");
    await env.client.close();
  }

  // 13. T09：忙碌
  {
    const env = await open("busy");
    const first = await env.client.request("turn/start", { threadId: env.threadId, input: [{ type: "text", text: "long" }] });
    check("T09 忙碌：首回合已接收", Boolean(first.turn?.id));
    let secondError = null;
    try {
      await env.client.request("turn/start", { threadId: env.threadId, input: [{ type: "text", text: "second" }] });
    } catch (e) {
      secondError = e;
    }
    check("T09 忙碌：第二输入被拒绝", secondError?.code === -32000, String(secondError?.code));
    await env.client.close();
  }

  // 14. T10：版本与 schema 一致性
  {
    const matched = checkBinaryAgainstSchema(DESKTOP_BIN, path.join(ROOT, "server/codex-probe/schema-0.163"));
    check("T10 版本匹配：0.163 与 schema 一致", matched.ok, matched.issues.join("; "));
    const mismatched = checkBinaryAgainstSchema("codex", path.join(ROOT, "server/codex-probe/schema-0.163"));
    check("T10 版本不匹配：阻止写入", !mismatched.ok && mismatched.issues.length > 0, mismatched.issues.join("; "));
    check("C04 版本门禁覆盖请求/通知 schema", matched.ok && matched.verified.includes("ServerRequest.json") && matched.verified.includes("ServerNotification.json"), JSON.stringify(matched.verified));
  }

  const failed = results.filter((r) => r.ok === false);
  const unverifiedCount = results.filter((r) => r.ok === null).length;
  console.log(`\nSUMMARY pass=${results.filter((r) => r.ok).length} fail=${failed.length} unverified=${unverifiedCount}`);
  fs.writeFileSync(
    path.join(ROOT, "tests/codex-probe/logs", `mock-summary-${Date.now()}.json`),
    JSON.stringify({ results, failed: failed.map((f) => f.name) }, null, 2)
  );
  await closeAll();
  process.exit(failed.length ? 1 : 0);
};

main().catch(async (e) => {
  console.error("FATAL", e);
  await closeAll();
  process.exit(2);
});
