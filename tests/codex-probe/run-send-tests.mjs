#!/usr/bin/env node
// F02-S 发送可靠性断言：S01 目标核对、S02 全文一致、S03 动作与确认分离。不连接界面。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSendGuard } from "../../server/codex-probe/lib/send-target.mjs";
import { runSendFlow, SEND_STATE } from "../../server/codex-probe/lib/send-flow.mjs";
import { parseRolloutEvents, findDelivery, textMatches } from "../../server/codex-probe/lib/rollout-events.mjs";
import { classifyReadback } from "../../server/codex-probe/lib/text-input.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOG = path.join(ROOT, "tests/codex-probe/logs", `F02S-${Date.now()}-${process.pid}.jsonl`);
const stream = fs.createWriteStream(LOG, { flags: "w" });
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: Boolean(cond) });
  stream.write(JSON.stringify({ t: new Date().toISOString(), kind: "assert", name, ok: Boolean(cond), detail }) + "\n");
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` — ${detail}`}`);
};

const A = "A-thread";
const B = "B-thread";
const BOUNDS = { X: 124, Y: 102, Width: 824, Height: 668 };
const CODEX = "com.openai.codex";
const win = (ids, number = 1509, bounds = BOUNDS) => ({ windowNumber: number, threadIds: ids, bounds });
let lastCapture = 0;
const nextCapturedAt = () => {
  let t = Date.now();
  while (t <= lastCapture) t = Date.now();
  lastCapture = t;
  return t;
};
const sample = (ids, { front = CODEX, number = 1509, bounds = BOUNDS } = {}) => ({
  capturedAt: nextCapturedAt(),
  frontBundleId: front,
  windows: [win(ids, number, bounds)],
});
const makeGuard = (threadId = A) => createSendGuard({ threadId, windowNumber: 1509, bounds: BOUNDS });
const seq = (actual) => { let n = 0; return () => (n++ === 0 ? "" : actual); };

function makeActions(overrides = {}) {
  const calls = { clickComposer: 0, pasteText: 0, readInput: 0, locateSendButton: 0, clickSend: 0, readEvents: 0 };
  let pasted = false;
  const actions = {
    clickComposer: () => { calls.clickComposer += 1; },
    pasteText: () => { pasted = true; calls.pasteText += 1; },
    readInput: () => { calls.readInput += 1; return pasted ? "TEXT" : ""; },
    locateSendButton: () => { calls.locateSendButton += 1; return { x: 906, y: 725 }; },
    clickSend: () => { calls.clickSend += 1; },
    readEvents: () => { calls.readEvents += 1; return []; },
    ...overrides,
  };
  return { actions, calls };
}

async function flow({ guard = makeGuard(), sampleFn = () => sample([A]), text = "TEXT", actions, timeoutMs = 30, intervalMs = 5 }) {
  return runSendFlow({ text, guard, sample: sampleFn, actions, timeoutMs, intervalMs });
}

const main = async () => {
  // S01：缺目标不启动
  {
    let threw = false;
    try { createSendGuard({ windowNumber: 1509, bounds: BOUNDS }); } catch { threw = true; }
    check("S01 缺期望会话 ID：拒绝创建守卫", threw);
  }

  // S01：非目标前台
  {
    const { actions, calls } = makeActions();
    const r = await flow({ sampleFn: () => sample([A], { front: "com.deepseek.dsh" }), actions });
    check("S01 非目标前台：阻止且不点击", r.status === SEND_STATE.BLOCKED && r.reason === "non-front" && calls.clickComposer === 0, JSON.stringify(r));
  }

  // S01：同应用内换会话（点击后）
  {
    let phase = 0;
    const { actions, calls } = makeActions();
    const r = await flow({
      guard: makeGuard(),
      sampleFn: () => sample(phase === 0 ? [A] : [B]),
      actions: { ...actions, clickComposer: () => { phase = 1; calls.clickComposer += 1; } },
    });
    check("S01 点击后换会话：阻止且不输入", r.status === SEND_STATE.BLOCKED && r.stage === "after-click" && r.reason === "session-changed" && calls.readInput === 0, JSON.stringify(r));
  }

  // S01：换窗口 / 窗口移动
  {
    const { actions } = makeActions();
    const r = await flow({ sampleFn: () => sample([A], { number: 1510 }), actions });
    check("S01 换窗口：阻止", r.status === SEND_STATE.BLOCKED && r.reason === "window-changed", JSON.stringify(r));

    const moved = { X: 0, Y: 0, Width: 824, Height: 668 };
    const r2 = await flow({ sampleFn: () => sample([A], { bounds: moved }), actions: makeActions().actions });
    check("S01 窗口移动：阻止", r2.status === SEND_STATE.BLOCKED && r2.reason === "bounds-changed", JSON.stringify(r2));
  }

  // S01：提交前再次核对目标（输入完成后换会话）
  {
    let phase = 0;
    const { actions, calls } = makeActions({
      clickComposer: () => { calls.clickComposer += 1; },
      pasteText: () => { phase = 1; calls.pasteText += 1; },
      readInput: (() => { let n = 0; return () => (n++ === 0 ? "" : "TEXT"); })(),
    });
    const r = await flow({
      guard: makeGuard(),
      sampleFn: () => sample(phase === 0 ? [A] : [B]),
      actions,
    });
    check("S01 提交前换会话：阻止且不提交", r.status === SEND_STATE.BLOCKED && ["before-readback", "before-send"].includes(r.stage) && calls.clickSend === 0, JSON.stringify(r));
  }

  // S01：采样过期
  {
    let t = 1000;
    const guard = createSendGuard({ threadId: A, windowNumber: 1509, bounds: BOUNDS, maxAgeMs: 100, now: () => t });
    guard.observe({ ...sample([A]), capturedAt: 1000 });
    t += 500;
    const r = guard.check();
    check("S01 采样过期：阻止", !r.ok && r.reason === "stale-sample");
  }

  // S02：Unicode 全文一致
  {
    const samples = [
      "你好，世界",
      "带 空格 和  双空格",
      "连字符 - 短横 — 破折",
      "标点：！？。，“”‘’（）",
      "第一行\n第二行\n第三行",
    ];
    for (const text of samples) {
      const { actions } = makeActions({
        readInput: seq(text),
        readEvents: () => [
          { role: "user", text, ts: new Date().toISOString(), turnId: "T1" },
          { role: "assistant", text: "OK", ts: new Date().toISOString(), turnId: "T1", final: true },
        ],
      });
      const r = await flow({ text, actions });
      check(`S02 全文一致：${text.slice(0, 8)}`, r.status === SEND_STATE.REPLIED, JSON.stringify(r));
    }
  }

  // S02：任何不一致都不提交
  {
    const cases = ["你好,世界", "你好，世界 ", "你好， 世界", "TEST MARKER", "TEXT"];
    for (const actual of cases) {
      const { actions, calls } = makeActions({ readInput: seq(actual) });
      const r = await flow({ text: "你好，世界", actions });
      check(`S02 不一致阻止：${JSON.stringify(actual)}`, r.status === SEND_STATE.BLOCKED && r.reason === "input-mismatch" && calls.clickSend === 0, JSON.stringify(r));
    }
    const { actions, calls } = makeActions({ readInput: () => null });
    const r = await flow({ text: "你好，世界", actions });
    check("S02 无法读取输入框：阻止并人工核对", r.status === SEND_STATE.BLOCKED && r.reason.startsWith("input-unreadable") && calls.clickSend === 0, JSON.stringify(r));

    const draft = makeActions({ readInput: () => "已有草稿" });
    const r2 = await flow({ text: "你好，世界", actions: draft.actions });
    check("S02 已有草稿：保留现场不粘贴", r2.status === SEND_STATE.BLOCKED && r2.reason === "existing-draft" && draft.calls.pasteText === 0 && draft.calls.clickSend === 0, JSON.stringify(r2));
  }

  // S05：读空输入框期间切换会话 → 不粘贴
  {
    let phase = 0;
    const { actions, calls } = makeActions({
      readInput: () => { if (phase === 0) { phase = 1; return ""; } return "TEXT"; },
    });
    const r = await flow({
      guard: makeGuard(),
      sampleFn: () => sample(phase === 0 ? [A] : [B]),
      actions,
    });
    check("S05 读空期间换会话：不粘贴", r.status === SEND_STATE.BLOCKED && r.stage === "before-paste" && calls.pasteText === 0, JSON.stringify(r));
  }

  // S05：读回全文期间切换会话 → 不提交
  {
    let phase = 0;
    let n = 0;
    const { actions, calls } = makeActions({
      readInput: () => { n += 1; if (n === 1) return ""; phase = 1; return "TEXT"; },
    });
    const r = await flow({
      guard: makeGuard(),
      sampleFn: () => sample(phase === 0 ? [A] : [B]),
      actions,
    });
    check("S05 读回期间换会话：不提交", r.status === SEND_STATE.BLOCKED && r.stage === "before-send" && calls.clickSend === 0, JSON.stringify(r));
  }

  // S05：采集时间与时效
  {
    let t = 10000;
    const guard = createSendGuard({ threadId: A, windowNumber: 1509, bounds: BOUNDS, now: () => t });
    guard.observe({ ...sample([A]), capturedAt: 1 });
    let r = guard.check();
    check("S05 旧采集时间：过期", !r.ok && r.reason === "stale-sample", JSON.stringify(r));

    const g2 = createSendGuard({ threadId: A, windowNumber: 1509, bounds: BOUNDS, now: () => t });
    const s1 = { ...sample([A]), capturedAt: 9000 };
    g2.observe(s1);
    g2.observe({ ...s1 });
    r = g2.check();
    check("S05 重复采集时间：不可用", !r.ok && r.reason === "no-sample", JSON.stringify(r));

    const g3 = createSendGuard({ threadId: A, windowNumber: 1509, bounds: BOUNDS, now: () => t });
    g3.observe({ ...sample([A]), capturedAt: 20000 });
    r = g3.check();
    check("S05 未来采集时间：拒绝", !r.ok && r.reason === "invalid-sample-time", JSON.stringify(r));

    const g4 = createSendGuard({ threadId: A, windowNumber: 1509, bounds: BOUNDS, now: () => t });
    const { capturedAt, ...noCapturedAt } = sample([A]);
    g4.observe(noCapturedAt);
    r = g4.check();
    check("S05 缺失采集时间：拒绝", !r.ok && r.reason === "no-sample", JSON.stringify(r));
  }

  // S06：延迟回复仍可确认
  {
    let calls = 0;
    const { actions } = makeActions({
      readEvents: () => {
        calls += 1;
        if (calls < 3) return [];
        return [
          { role: "user", text: "TEXT", ts: "t1", turnId: "T1" },
          { role: "assistant", text: "晚到回复", ts: "t2", turnId: "T1", final: true },
        ];
      },
    });
    const r = await flow({ timeoutMs: 400, intervalMs: 20, actions });
    check("S06 延迟回复：replied", r.status === SEND_STATE.REPLIED && r.delivery.reply.text === "晚到回复", JSON.stringify(r));
  }

  // S06：未知回合不匹配任意回复
  {
    const { actions } = makeActions({
      readEvents: () => [
        { role: "user", text: "TEXT", ts: "t1", turnId: null },
        { role: "assistant", text: "任意回复", ts: "t2", turnId: "OTHER", final: true },
      ],
    });
    const r = await flow({ timeoutMs: 60, intervalMs: 10, actions });
    check("S06 未知回合：不关联回复", r.status === SEND_STATE.DELIVERED_NO_REPLY && r.delivery.reply === null, JSON.stringify(r));
  }

  // S06：中间进度不算最终回复
  {
    const { actions } = makeActions({
      readEvents: () => [
        { role: "user", text: "TEXT", ts: "t1", turnId: "T1" },
        { role: "assistant", text: "进度", ts: "t2", turnId: "T1", final: false },
      ],
    });
    const r = await flow({ timeoutMs: 60, intervalMs: 10, actions });
    check("S06 中间进度不当作回复", r.status === SEND_STATE.DELIVERED_NO_REPLY && r.delivery.reply === null, JSON.stringify(r));
  }

  // S06：连续两个回合不串
  {
    const { actions } = makeActions({
      readEvents: () => [
        { role: "user", text: "TEXT", ts: "t1", turnId: "T1" },
        { role: "assistant", text: "别的回合", ts: "t2", turnId: "T2", final: true },
        { role: "user", text: "next", ts: "t3", turnId: "T2" },
        { role: "assistant", text: "下一回合", ts: "t4", turnId: "T2", final: true },
      ],
    });
    const r = await flow({ timeoutMs: 60, intervalMs: 10, actions });
    check("S06 连续回合：只认同回合", r.status === SEND_STATE.DELIVERED_NO_REPLY && r.delivery.reply === null, JSON.stringify(r));
  }

  // S03：发送动作未生效 → attempted-pending → unknown，且只点一次
  {
    const { actions, calls } = makeActions({ readEvents: () => [] });
    const r = await flow({ timeoutMs: 30, intervalMs: 5, actions });
    check("S03 动作未生效：unknown", r.status === SEND_STATE.UNKNOWN && r.clicks === 1, JSON.stringify(r));
    check("S03 不自动重试：只点击一次", calls.clickSend === 1);
  }

  // S03：送达但暂无回复
  {
    const { actions } = makeActions({
      readEvents: () => [{ role: "user", text: "TEXT", ts: new Date().toISOString(), turnId: "T1" }],
    });
    const r = await flow({ actions });
    check("S03 完整用户消息：delivered-no-reply", r.status === SEND_STATE.DELIVERED_NO_REPLY && r.delivery.turnId === "T1", JSON.stringify(r));
  }

  // S03：按回合关联回复，不取任意下一条 assistant
  {
    const { actions } = makeActions({
      readEvents: () => [
        { role: "assistant", text: "旧回复", ts: "t0", turnId: "T0", final: true },
        { role: "user", text: "TEXT", ts: "t1", turnId: "T1" },
        { role: "assistant", text: "别的回合", ts: "t2", turnId: "T2", final: true },
        { role: "assistant", text: "正确回复", ts: "t3", turnId: "T1", final: true },
      ],
    });
    const r = await flow({ actions });
    check("S03 只关联同回合回复", r.status === SEND_STATE.REPLIED && r.delivery.reply.text === "正确回复", JSON.stringify(r));
  }

  // S03：回复在下一用户消息之后 → 不关联
  {
    const events = [
      { role: "user", text: "TEXT", ts: "t1", turnId: "T1" },
      { role: "user", text: "next", ts: "t2", turnId: "T2" },
      { role: "assistant", text: "下一回合回复", ts: "t3", turnId: "T2", final: true },
    ];
    const d = findDelivery(events, "TEXT");
    check("S03 下一条用户后的回复不关联", d.found && d.reply === null, JSON.stringify(d));
  }

  // S04：读回必须证明复制发生且不是旧剪贴板内容
  {
    const base = { sentinel: "SENTINEL", beforeCount: 1, afterCount: 2, types: ["public.utf8-plain-text"], text: "正文" };
    check("S04 哨兵残留：复制失败", classifyReadback({ ...base, text: "SENTINEL" }).status === "copy-failed");
    check("S04 changeCount 不变：复制失败", classifyReadback({ ...base, afterCount: 1 }).status === "copy-failed");
    check("S04 非文本类型：不可读", classifyReadback({ ...base, types: ["public.png"], text: "" }).status === "unreadable");
    check("S04 无类型：不能判空", classifyReadback({ ...base, types: [], text: "" }).status === "unreadable");
    check("S04 空文本但有文本类型：空", classifyReadback({ ...base, text: "" }).status === "empty");
    check("S04 正文：可读", classifyReadback(base).status === "text");
    check("S04 无法读取：unreadable", classifyReadback({ ...base, text: null }).status === "unreadable");
  }

  // S02：行尾换行规范化，内容仍需逐字一致
  {
    check("S02 行尾换行可接受", textMatches("A\nB", "A\nB\n"));
    check("S02 CRLF 可接受", textMatches("A\nB", "A\r\nB"));
    check("S02 中间改动仍拒绝", !textMatches("A\nB", "A\n B"));
    check("S02 额外空格仍拒绝", !textMatches("A B", "A  B"));
    const d = findDelivery([{ role: "user", text: "A\nB\n", ts: "t", turnId: "T" }], "A\nB");
    check("S02 送达确认接受行尾换行", d.found && d.turnId === "T");
  }

  // S06：turn_context 在用户消息之后，第二个用户必须绑定新回合
  {
    const lines = [
      JSON.stringify({ type: "turn_context", payload: { turn_id: "A" } }),
      JSON.stringify({ type: "response_item", timestamp: "t1", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "A", last_agent_message: "A reply" } }),
      JSON.stringify({ type: "response_item", timestamp: "t2", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "second" }] } }),
      JSON.stringify({ type: "turn_context", payload: { turn_id: "B" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "B", last_agent_message: "B reply" } }),
    ];
    const events = parseRolloutEvents(lines);
    const second = events.find((e) => e.role === "user" && e.text === "second");
    check("S06 第二个用户不继承上一回合", second?.turnId === null || second?.turnId === "B", JSON.stringify(second));
    // turn_context(B) 之后应回填 B
    const d = findDelivery(events, "second");
    check("S06 第二回合回复正确关联", d.found && d.turnId === "B" && d.reply?.text === "B reply", JSON.stringify(d));
  }

  // S06：仅有 last_agent_message、但类型不是完成事件 → 不算最终回复
  {
    const lines = [
      JSON.stringify({ type: "response_item", timestamp: "t1", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "X" }] } }),
      JSON.stringify({ type: "event_msg", payload: { type: "item_completed", turn_id: "T", last_agent_message: "progress" } }),
    ];
    const events = parseRolloutEvents(lines);
    check("S06 非完成事件不算最终回复", findDelivery(events, "X").reply === null, JSON.stringify(events));
  }

  // S04/S05：焦点未知不执行选择/粘贴
  {
    const { actions, calls } = makeActions({ checkFocus: () => false });
    const r = await flow({ actions });
    check("S04 焦点未知：阻止选择", r.status === SEND_STATE.BLOCKED && r.reason === "input-focus-unknown" && calls.readInput === 0, JSON.stringify(r));
  }

  // S05：动作内部复核失败（模拟 select/copy 前切换）
  {
    const { actions, calls } = makeActions({
      readInput: () => { throw Object.assign(new Error("blocked"), { blocked: { reason: "session-changed" } }); },
    });
    const r = await flow({ actions });
    check("S05 动作内复核失败：不粘贴", r.status === SEND_STATE.BLOCKED && r.reason === "session-changed" && calls.pasteText === 0, JSON.stringify(r));
  }

  // 解析器：turn_id 归属
  {
    const lines = [
      JSON.stringify({ type: "response_item", timestamp: "t1", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "TEXT" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "t2", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "TURN-1", last_agent_message: "OK" } }),
    ];
    const events = parseRolloutEvents(lines);
    check("S03 解析器绑定回合 ID", events.every((e) => e.turnId === "TURN-1"), JSON.stringify(events));
    check("S03 解析器终态回复", findDelivery(events, "TEXT").reply?.text === "OK");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY pass=${results.length - failed.length} fail=${failed.length}\nlog: ${LOG}`);
  stream.end(() => process.exit(failed.length ? 1 : 0));
};

main().catch((e) => {
  console.error("FATAL", e);
  stream.end(() => process.exit(2));
});
