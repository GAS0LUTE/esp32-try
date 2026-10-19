#!/usr/bin/env node
// INT-001 阶段 A 探针：以 stdio 启动 codex app-server，完成 initialize 握手，
// 执行只读查询。不创建会话、不发送输入、不改配置。
// 用法: node probe-stdio.mjs [--call thread/loaded/list]
import { spawn } from "node:child_process";

const CODEX_BIN = process.env.CODEX_BIN || "codex";
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 20000);

const args = process.argv.slice(2);
let call = "thread/loaded/list";
let params = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--call") call = args[++i];
  if (args[i] === "--params") params = JSON.parse(args[++i]);
}

const ts = () => new Date().toISOString();
const log = (obj) => console.log(JSON.stringify(obj));

const child = spawn(CODEX_BIN, ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, RUST_LOG: process.env.RUST_LOG || "error" },
});

let buf = "";
const pending = new Map();
let nextId = 1;

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log({ t: ts(), kind: "unparsed_line", line: line.slice(0, 400) });
      continue;
    }
    log({ t: ts(), kind: "in", id: msg.id, method: msg.method, resultKeys: msg.result ? Object.keys(msg.result) : undefined, error: msg.error ?? undefined });
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => log({ t: ts(), kind: "stderr", text: d.trim().slice(0, 800) }));

const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const payload = { jsonrpc: "2.0", id, method };
    if (params !== undefined) payload.params = params;
    log({ t: ts(), kind: "out", method, id });
    child.stdin.write(JSON.stringify(payload) + "\n");
  });

const notify = (method, params) => {
  const payload = { jsonrpc: "2.0", method };
  if (params !== undefined) payload.params = params;
  log({ t: ts(), kind: "out", msg: payload });
  child.stdin.write(JSON.stringify(payload) + "\n");
};

const timer = setTimeout(() => {
  log({ t: ts(), kind: "result", status: "timeout" });
  child.kill("SIGTERM");
  process.exit(2);
}, TIMEOUT_MS);

try {
  const init = await request("initialize", {
    clientInfo: { name: "gpt-cube-probe", title: "INT-001 probe", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  log({ t: ts(), kind: "result", step: "initialize", ok: !init.error, error: init.error ?? null });

  notify("initialized", {});

  const res = await request(call, params);
  log({ t: ts(), kind: "result", step: call, ok: !res.error, error: res.error ?? null });

  log({ t: ts(), kind: "result", status: "done" });
} catch (e) {
  log({ t: ts(), kind: "result", status: "exception", message: String(e) });
} finally {
  clearTimeout(timer);
  child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 300);
}
