#!/usr/bin/env node
// INT-001 真实会话验证（断言式）：版本门禁 → 创建线程 → 往返 → 恢复读取。
// 失败退出非零；日志文件名唯一；结束时清理子进程。
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../../server/codex-probe/lib/rpc-client.mjs";
import { createTurnObserver } from "../../server/codex-probe/lib/turn-observer.mjs";
import { createServerRequestRouter } from "../../server/codex-probe/lib/server-request-router.mjs";
import { createLogger, DEFAULT_FIELDS, scrub } from "../../server/codex-probe/lib/log.mjs";
import { checkBinaryAgainstSchema } from "../../server/codex-probe/lib/version-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = process.env.CODEX_BIN || "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const SCHEMA = path.join(ROOT, "server/codex-probe/schema-0.163");
const results = [];
const clients = [];

const check = (name, cond, detail = "") => {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` — ${detail}`}`);
};

const logPath = path.join(ROOT, "tests/codex-probe/logs", `B-real-${Date.now()}-${process.pid}.jsonl`);
const log = createLogger(logPath, { allowedFields: DEFAULT_FIELDS });

const open = async () => {
  const client = new RpcClient({ bin: BIN, args: ["app-server"], requestTimeoutMs: 20000, name: "real" });
  clients.push(client);
  client.on("stderr", (d) => log.log({ step: "stderr", text: d.trim().slice(0, 300) }));
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
  await client.request("initialize", {
    clientInfo: { name: "gpt-cube-probe", title: "INT-001 real", version: "0.2.0" },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized", {});
  return { client, router, setThread: (id) => { threadId = id; }, setTurn: (id) => { boundTurn = id; } };
};

const main = async () => {
  const version = checkBinaryAgainstSchema(BIN, SCHEMA);
  check("T10 版本门禁：二进制与 schema 一致", version.ok, version.issues.join("; "));
  if (!version.ok) throw new Error("version gate failed");

  const env = await open();
  const start = await env.client.request("thread/start", { cwd: ROOT, approvalPolicy: "never" });
  env.setThread(start.thread.id);
  log.log({ step: "thread/start", threadId: start.thread.id });
  check("T03 创建测试线程", Boolean(start.thread?.id), start.thread?.id ?? "no thread");

  const observer = createTurnObserver(env.client, { threadId: start.thread.id, timeoutMs: 180000 });
  const turn = await env.client.request("turn/start", {
    threadId: start.thread.id,
    input: [{ type: "text", text: "INT-001 自动化测试消息，请只回复：ACK" }],
  });
  env.setTurn(turn.turn?.id);
  observer.bindTurn(turn.turn?.id);
  const result = await observer.result;
  log.log({ step: "turnResult", status: result.status, turnStatus: result.turnStatus, text: result.text.slice(0, 80) });

  check("T03 回合完成", result.status === "completed", result.status);
  check("T03 回合状态 completed", result.turnStatus === "completed", String(result.turnStatus));
  check("T03 回复内容 ACK", result.text.trim() === "ACK", result.text.slice(0, 80));

  await env.client.close();
  await log.close();

  const env2 = await open();
  const resume = await env2.client.request("thread/resume", { threadId: start.thread.id });
  check("T08 第二实例恢复线程", resume.thread?.id === start.thread.id, resume.thread?.id ?? "no thread");
  const read = await env2.client.request("thread/read", { threadId: start.thread.id, includeTurns: true });
  const turns = read.thread?.turns ?? [];
  check("T08 读回历史回合", turns.length >= 1, String(turns.length));
  await env2.client.close();

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(logPath.replace(/\.jsonl$/, "-summary.json"), JSON.stringify(scrub({ results, threadId: start.thread.id }), null, 2));
  console.log(`\nSUMMARY pass=${results.length - failed.length} fail=${failed.length}`);
  process.exit(failed.length ? 1 : 0);
};

main().catch(async (e) => {
  console.error("FATAL", e.message);
  for (const c of clients) await c.close({ timeoutMs: 1000 });
  process.exit(2);
});
