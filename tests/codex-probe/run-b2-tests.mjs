#!/usr/bin/env node
// 历史实验脚本（保留以复现 B2 证据）。当前实现与断言以 run-mock-tests.mjs 与 run-b-tests.mjs 为准。
// INT-001 阶段 B 补充：T05 审批拒绝路径、T04 澄清请求路径。
// 两个场景各用独立线程；审批一律拒绝，澄清问题按脚本回答。
// 需要真实 ~/.codex（沙箱外执行）。
import { spawn } from "node:child_process";
import fs from "node:fs";

const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CWD = process.env.PROBE_CWD || process.cwd();
const LOG = process.env.PROBE_LOG || "tests/codex-probe/logs/B2-run.jsonl";
const TURN_TIMEOUT_MS = Number(process.env.PROBE_TURN_TIMEOUT_MS || 180000);

const out = fs.createWriteStream(LOG, { flags: "w" });
const log = (o) => out.write(JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");
const summary = {};

class Server {
  constructor(name, extraArgs = []) {
    this.name = name;
    this.child = spawn(CODEX_BIN, ["app-server", ...extraArgs], { stdio: ["pipe", "pipe", "pipe"] });
    this.buf = "";
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    this.handlers = [];
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (c) => this.#onData(c));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d) => log({ srv: name, kind: "stderr", text: d.trim().slice(0, 400) }));
  }
  #onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this.#onMessage(msg);
    }
  }
  #onMessage(msg) {
    if (msg.id !== undefined && msg.method) {
      const handled = this.handlers.some((h) => h(msg, this));
      if (!handled) {
        log({ srv: this.name, kind: "unhandledServerRequest", method: msg.method });
        this.respond(msg.id, { decision: "decline" });
      }
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      resolve(msg);
      return;
    }
    if (msg.method) {
      const p = msg.params ?? {};
      log({ srv: this.name, kind: "notify", method: msg.method, itemType: p.item?.type, status: p.turn?.status, error: p.error ?? undefined });
      this.listeners.forEach((fn) => fn(msg));
    }
  }
  onServerRequest(fn) { this.handlers.push(fn); }
  respond(id, result) { this.child.stdin.write(JSON.stringify({ id, result }) + "\n"); }
  request(method, params) {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve });
      const payload = { id, method };
      if (params !== undefined) payload.params = params;
      this.child.stdin.write(JSON.stringify(payload) + "\n");
    });
  }
  on(fn) { this.listeners.push(fn); }
  close() { this.child.kill("SIGTERM"); }
}

const initSrv = async (name, extraArgs = []) => {
  const s = new Server(name, extraArgs);
  const r = await s.request("initialize", {
    clientInfo: { name: "gpt-cube-probe", title: "INT-001 B2", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  log({ srv: name, kind: "initialize", ok: !r.error, error: r.error ?? null });
  s.child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  return s;
};

const waitTurn = (s, timeoutMs) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve({ status: "timeout" }); }, timeoutMs);
    const handler = (msg) => {
      if (msg.method === "turn/completed") { cleanup(); resolve({ status: "completed", turnStatus: msg.params?.turn?.status }); }
    };
    const cleanup = () => { clearTimeout(timer); s.listeners = s.listeners.filter((f) => f !== handler); };
    s.on(handler);
  });

const scenarioApproval = async () => {
  const s = await initSrv("approval");
  const seen = [];
  s.onServerRequest((msg, srv) => {
    if (msg.method === "item/commandExecution/requestApproval" || msg.method === "item/fileChange/requestApproval") {
      seen.push(msg.method);
      log({ srv: "approval", kind: "approvalRequest", method: msg.method, detail: msg.params?.command ?? msg.params?.reason ?? null });
      srv.respond(msg.id, { decision: "decline" });
      return true;
    }
    return false;
  });
  const start = await s.request("thread/start", { cwd: CWD, approvalPolicy: "untrusted", sandbox: "read-only", ephemeral: false });
  const threadId = start.result?.thread?.id;
  const turn = await s.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "请运行 shell 命令：curl -sS --max-time 5 https://example.com -o /dev/null，然后只回复命令结果。" }],
  });
  const done = await waitTurn(s, TURN_TIMEOUT_MS);
  summary.t05 = { threadId, declineSeen: seen, turnStatus: done.turnStatus ?? done.status };
  s.close();
};

const scenarioUserInput = async () => {
  // 仅本进程启用实验特性，不写用户配置。
  const s = await initSrv("userinput", ["-c", "features.default_mode_request_user_input=true"]);
  let asked = null;
  s.onServerRequest((msg, srv) => {
    if (msg.method === "item/tool/requestUserInput") {
      const qs = msg.params?.questions ?? [];
      asked = qs.map((q) => ({ id: q.id, header: q.header, question: q.question, options: (q.options ?? []).map((o) => o.label) }));
      log({ srv: "userinput", kind: "userInputRequest", questions: asked });
      const answers = {};
      for (const q of qs) answers[q.id] = { answers: [q.options?.[0]?.label ?? "继续"] };
      srv.respond(msg.id, { answers });
      return true;
    }
    return false;
  });
  const start = await s.request("thread/start", { cwd: CWD, approvalPolicy: "never", ephemeral: false });
  const threadId = start.result?.thread?.id;
  const turn = await s.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "请使用 request_user_input 工具向我提一个问题：是否继续测试？选项为「继续」和「停止」。" }],
  });
  const done = await waitTurn(s, TURN_TIMEOUT_MS);
  summary.t04 = { threadId, asked, turnStatus: done.turnStatus ?? done.status };
  s.close();
};

try {
  const only = process.env.PROBE_SCENARIO;
  if (!only || only === "t05") await scenarioApproval();
  if (!only || only === "t04") await scenarioUserInput();
  fs.writeFileSync(LOG.replace(/\.jsonl$/, "-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} catch (e) {
  log({ kind: "exception", message: String(e) });
  console.error(String(e));
} finally {
  out.end();
  setTimeout(() => process.exit(0), 500);
}
