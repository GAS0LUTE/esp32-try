#!/usr/bin/env node
// F04-A/B 目标绑定与发送门禁：稳定阈值按窗口+会话身份、确认需复核、发送前新鲜采样、旧输入不转投。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTargetTracker } from "../../server/codex-probe/lib/target-tracker.mjs";
import { createInputController } from "../../server/codex-probe/lib/input-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOG = path.join(ROOT, "tests/codex-probe/logs", `F04-tracker-${Date.now()}-${process.pid}.jsonl`);
const stream = fs.createWriteStream(LOG, { flags: "w" });
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: Boolean(cond) });
  stream.write(JSON.stringify({ t: new Date().toISOString(), kind: "assert", name, ok: Boolean(cond), detail }) + "\n");
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` — ${detail}`}`);
};

const A = "01a14d86-1892-7a81-900e-3ad15fe4f1ed";
const B = "01a11c07-ce44-7be3-9de2-27131f6ecba4";
const CODEX = "com.openai.codex";
const OTHER = "com.deepseek.dsh";
const win = (ids, number = 1509) => ({ windowNumber: number, threadIds: ids });
const sample = (bundle, windows) => ({ frontBundleId: bundle, windows });

// —— F04-A：稳定阈值与窗口身份 ——
const t = createTargetTracker({ stableSamples: 3 });
let s = t.observe(sample(OTHER, [win([A])]));
check("F04-A 非前台：未确认", s.state === "unconfirmed" && !s.sendAllowed);
s = t.observe(sample(CODEX, [win([A])]));
check("F04-A 首采样不构成候选", s.state === "unconfirmed" && s.candidateThread === null);
check("F04-A 未稳定时 confirm 被拒", t.confirm().ok === false);
s = t.observe(sample(CODEX, [win([A])]));
s = t.observe(sample(CODEX, [win([A])]));
check("F04-A 稳定 3 次成为候选", s.state === "candidate" && s.candidateThread === A);
const c1 = t.confirm();
check("F04-A 确认后绑定并生成代次", c1.ok === true && c1.generation === 1 && t.snapshot().boundWindow === 1509);
t.observe(sample(CODEX, [win([A])]));
check("F04-A 绑定后新鲜采样可发送", t.gate().allowed === true);

s = t.observe(sample(CODEX, [win([B])]));
const badConfirm = t.confirm();
check("F04-A 绑定 A 后仅采样 B 一次：confirm 不通过", badConfirm.ok === false && badConfirm.reason === "not-stable");
check("F04-A 切换后立即停发", s.state === "changed" && t.gate().allowed === false);
t.observe(sample(CODEX, [win([B])]));
t.observe(sample(CODEX, [win([B])]));
const c2 = t.confirm();
check("F04-A B 稳定后可确认", c2.ok === true && c2.generation === 2);

// 同线程出现在不同窗口：身份变化，必须重新稳定并确认
s = t.observe(sample(CODEX, [win([A], 1510)]));
check("F04-B 同线程换窗口：立即停发", s.state === "changed" && t.gate().allowed === false);
check("F04-B 换窗口后单次 confirm 被拒", t.confirm().ok === false);
t.observe(sample(CODEX, [win([A], 1510)]));
t.observe(sample(CODEX, [win([A], 1510)]));
const c3 = t.confirm();
check("F04-B 新窗口稳定后确认恢复", c3.ok === true && c3.generation === 3 && t.gate().allowed === true);

// 无匹配重置稳定计数：随后不同会话从 1 重新计数，不直接成为候选
t.observe(sample(CODEX, [win([])]));
s = t.observe(sample(CODEX, [win([B])]));
check("F04-A 无匹配后重新计数", s.streak === 1 && s.state === "changed" && s.candidateThread === null, JSON.stringify(s));

// 采样失败与过期不发送
{
  let clock = 1000;
  const t2 = createTargetTracker({ stableSamples: 1, maxSampleAgeMs: 100, now: () => clock });
  t2.observe(sample(CODEX, [win([A])]));
  t2.confirm();
  check("F04-B 新鲜采样可发送（单样本阈值）", t2.gate().allowed === true);
  clock += 500;
  check("F04-B 过期采样不发送", t2.gate().allowed === false && t2.gate().reason === "stale-sample");
  t2.observe(null);
  check("F04-B 采样失败不发送", t2.gate().allowed === false);
}

// —— F04-B：旧输入不转投新目标 ——
{
  const sent = [];
  const ctl = createInputController({ sendTurn: (m) => sent.push(m) });
  ctl.setTargetGeneration(1);
  ctl.disconnect();
  const held = ctl.submit("old-target");
  check("F04-B 切换前输入被保留", held.action === "held");
  ctl.setTargetGeneration(2);
  ctl.reconnect();
  ctl.confirmReconnect();
  const blocked = ctl.flush();
  check("F04-B 旧代次输入不发送", blocked.action === "blocked" && blocked.reason === "target-changed" && sent.length === 0);
  const fresh = ctl.submit("new-target");
  check("F04-B 新代次输入正常发送", fresh.action === "sent" && sent.length === 1 && fresh.message.targetGeneration === 2);
}

// 旧代次的未知消息不得重发到新目标
{
  const sent = [];
  const ctl = createInputController({ sendTurn: (m) => sent.push(m) });
  ctl.setTargetGeneration(1);
  const a = ctl.submit("pending");
  ctl.disconnect();
  ctl.setTargetGeneration(2);
  ctl.reconnect();
  ctl.confirmReconnect();
  const r = ctl.resendUnknown(a.message.localId);
  check("F04-B 旧代次未知消息不重发", r.action === "blocked" && r.reason === "target-changed" && sent.length === 1);
}

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY pass=${results.length - failed.length} fail=${failed.length}\nlog: ${LOG}`);
stream.end(() => process.exit(failed.length ? 1 : 0));
