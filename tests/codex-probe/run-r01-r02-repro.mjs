#!/usr/bin/env node
// R01/R02 复现输入：与 Codex 本轮实测序列一致，用于复验对照。
// 仅使用内存 sendTurn/respond 计数器，不连接真实会话。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInputController } from "../../server/codex-probe/lib/input-state.mjs";
import { createServerRequestRouter } from "../../server/codex-probe/lib/server-request-router.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const logPath = path.join(ROOT, "tests/codex-probe/logs", `R01-R02-repro-${Date.now()}-${process.pid}.jsonl`);
const stream = fs.createWriteStream(logPath, { flags: "w" });
const out = (o) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...o });
  stream.write(line + "\n");
  console.log(line);
};
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: Boolean(cond) });
  out({ kind: "assert", name, ok: Boolean(cond), detail });
};

// R01-1: submit(a) → submit(b)，不调用 ack
{
  const sent = [];
  const ctl = createInputController({ sendTurn: (m) => sent.push(m) });
  const a = ctl.submit("a");
  const b = ctl.submit("b");
  out({ kind: "R01-1", a: a.action, b: b.action, sent: sent.length, current: ctl.snapshot().current?.localId });
  check("R01-1 第二条保留，发送计数=1", b.action === "held" && sent.length === 1);
  check("R01-1 current 仍为第一条", ctl.snapshot().current?.localId === a.message.localId);
}

// R01-2: submit(a) → disconnect → reconnect → resendUnknown(a)
{
  const sent = [];
  const ctl = createInputController({ sendTurn: (m) => sent.push(m) });
  const a = ctl.submit("a");
  ctl.disconnect();
  ctl.reconnect();
  const r = ctl.resendUnknown(a.message.localId);
  out({ kind: "R01-2", resend: r.action, reason: r.reason, sent: sent.length });
  check("R01-2 核对前不发发送", r.action === "blocked" && sent.length === 1);
}

// R01-3: submit → disconnect → reconnect → confirm → resend → ack → resend
{
  const sent = [];
  const ctl = createInputController({ sendTurn: (m) => sent.push(m) });
  const a = ctl.submit("a");
  ctl.disconnect();
  ctl.reconnect();
  ctl.confirmReconnect();
  const first = ctl.resendUnknown(a.message.localId);
  ctl.ack(a.message.localId);
  const second = ctl.resendUnknown(a.message.localId);
  out({ kind: "R01-3", first: first.action, second: second.action, secondReason: second.reason, sent: sent.length });
  check("R01-3 处理中重发不发送", second.action === "blocked" && sent.length === 2);
}

// R01-4: 恢复后显式补发
{
  const sent = [];
  const ctl = createInputController({ sendTurn: (m) => sent.push(m) });
  ctl.disconnect();
  ctl.submit("offline");
  ctl.reconnect();
  const before = ctl.flush();
  ctl.confirmReconnect();
  const after = ctl.flush();
  out({ kind: "R01-4", beforeConfirm: before.action, afterConfirm: after.action, sent: sent.length });
  check("R01-4 核对前后", before.action === "blocked" && after.action === "sent" && sent.length === 1);
}

// R02: 目标未绑定
{
  const calls = { respond: 0, respondError: 0 };
  const fake = {
    respond: () => { calls.respond += 1; },
    respondError: () => { calls.respondError += 1; },
  };
  const router = createServerRequestRouter({
    client: fake, getThreadId: () => null, getTurnId: () => null, answers: { q1: "继续" },
  });
  const result = router({
    id: 1, method: "item/tool/requestUserInput",
    params: { threadId: "thread-A", turnId: "turn-A", questions: [{ id: "q1" }] },
  });
  out({ kind: "R02", result, respond: calls.respond, respondError: calls.respondError });
  check("R02 绑定前无业务答复", result === "rejected-unbound" && calls.respond === 0 && calls.respondError === 1);
}

const failed = results.filter((r) => !r.ok);
await new Promise((resolve) => stream.end(resolve));
console.log(`SUMMARY pass=${results.length - failed.length} fail=${failed.length}`);
process.exit(failed.length ? 1 : 0);
