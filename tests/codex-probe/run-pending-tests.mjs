#!/usr/bin/env node
// F03-P 收口断言：生产观察器永远 unknown；归属区间独立；模拟关闭另测。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePendingRequests } from "../../server/codex-probe/lib/pending-requests.mjs";
import { applySimulatedClosures } from "../../server/codex-probe/lib/pending-sim.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOG = path.join(ROOT, "tests/codex-probe/logs", `F03P-${Date.now()}-${process.pid}.jsonl`);
const stream = fs.createWriteStream(LOG, { flags: "w" });
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: Boolean(cond) });
  stream.write(JSON.stringify({ t: new Date().toISOString(), kind: "assert", name, ok: Boolean(cond), detail }) + "\n");
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` — ${detail}`}`);
};

const T = "thread-1";
const line = (o) => JSON.stringify(o);
const meta = (id = T) => line({ type: "session_meta", payload: { id } });
const turn = (id) => line({ type: "turn_context", payload: { turn_id: id } });
const user = (text) => line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const call = (callId, questions, name = "request_user_input_async") =>
  line({ type: "response_item", payload: { type: "function_call", name, call_id: callId, id: `item-${callId}`, arguments: JSON.stringify({ questions }) } });
const output = (callId, text) => line({ type: "response_item", payload: { type: "function_call_output", call_id: callId, output: text } });
const q1 = [{ title: "是否继续？", options: ["继续", "停止"] }];
const run = (lines, opts = {}) => parsePendingRequests(lines, { threadId: T, ...opts });

const main = () => {
  // Q06：生产接口没有升级入口，任何参数都不能得到 pending/none/answerable
  {
    const base = [meta(), turn("A"), user("hi"), call("c1", q1)];
    for (const [label, opts] of [
      ["默认", {}],
      ["currentValidity=true", { currentValidity: true }],
      ["closureProtocol=任意", { closureProtocol: "anything" }],
      ["两者同时", { currentValidity: true, closureProtocol: "serverRequest/resolved:v1" }],
    ]) {
      const r = run(base, opts);
      check(`Q06 ${label}：仍 unknown`, r.status === "unknown" && r.entries.every((e) => e.answerable === false), JSON.stringify(r));
    }
    const empty = run([meta()], { currentValidity: true });
    check("Q06 空日志 + 升级参数：仍 unknown", empty.status === "unknown" && empty.reason === "no-current-validity", JSON.stringify(empty));
  }

  // Q07：新用户区间不继承上一回合；同 callId 不被合并
  {
    const r = run([meta(), turn("A"), call("same", q1), user("first"), call("same", q1)]);
    check("Q07 跨用户同号：保留两条", r.entries.length === 2 && r.duplicates === 0, JSON.stringify(r));
    check("Q07 第二条归属未知", r.entries[1].turnId === null && r.entries[1].reason === "missing-turn-id", JSON.stringify(r.entries[1]));
    check("Q07 第一条归属 A（事件在区间内）", r.entries[0].turnId === "A", JSON.stringify(r.entries[0]));
  }
  {
    const r = run([meta(), turn("A"), call("same", q1), user("second"), call("same", q1), turn("B")]);
    check("Q07 明确 B 后绑定 B", r.entries.length === 2 && r.entries[1].turnId === "B", JSON.stringify(r));
  }
  // Q07：旧回合完成事件延迟到达，不得回填新用户后的候选
  {
    const r = run([
      meta(), turn("A"), call("same", q1), user("new topic"), call("same", q1),
      line({ type: "event_msg", payload: { type: "task_complete", turn_id: "A", last_agent_message: "done" } }),
    ]);
    check("Q07 延迟完成：保留两条候选", r.entries.length === 2 && r.duplicates === 0, JSON.stringify(r));
    check("Q07 延迟完成：第一条 A", r.entries[0].turnId === "A", JSON.stringify(r.entries[0]));
    check("Q07 延迟完成：第二条归属未知", r.entries[1].turnId === null && r.entries[1].reason === "missing-turn-id", JSON.stringify(r.entries[1]));
    check("Q07 延迟完成：整体 unknown 且不可回答", r.status === "unknown" && r.entries.every((e) => e.answerable === false));
  }
  // Q07：延迟完成后出现明确 B，才把新候选归 B
  {
    const r = run([
      meta(), turn("A"), call("same", q1), user("new topic"), call("same", q1),
      line({ type: "event_msg", payload: { type: "task_complete", turn_id: "A", last_agent_message: "done" } }),
      turn("B"),
    ]);
    check("Q07 明确 B：保留两条并绑定 B", r.entries.length === 2 && r.entries[0].turnId === "A" && r.entries[1].turnId === "B", JSON.stringify(r));
  }
  // Q07：task_started 也可作为明确新回合证据
  {
    const r = run([
      meta(), turn("A"), call("same", q1), user("new topic"), call("same", q1),
      line({ type: "event_msg", payload: { type: "task_started", turn_id: "B" } }),
    ]);
    check("Q07 task_started：绑定 B", r.entries.length === 2 && r.entries[1].turnId === "B", JSON.stringify(r));
  }

  // Q07：同区间真实重复合并
  {
    const r = run([meta(), turn("A"), user("hi"), call("c1", q1), call("c1", q1)]);
    check("Q07 同区间重复：合并一项", r.entries.length === 1 && r.duplicates === 1, JSON.stringify(r));
  }
  // Q07：缺回合独立候选
  {
    const r = run([meta(), user("hi"), call("c1", q1)]);
    check("Q07 缺回合：独立候选且不可回答", r.entries.length === 1 && r.entries[0].turnId === null && r.entries[0].answerable === false, JSON.stringify(r));
  }

  // Q05：输出文本不影响候选
  {
    const r = run([meta(), turn("A"), user("hi"), call("c1", q1), output("c1", '{"answered":false}')]);
    check("Q05 answered:false 不关闭", r.entries.length === 1, JSON.stringify(r));
    const r2 = run([meta(), turn("A"), user("hi"), call("c1", q1), output("c1", "User answered: 继续")]);
    check("Q05 正文回答不关闭（无协议）", r2.entries.length === 1, JSON.stringify(r2));
  }

  // Q08：身份/标识/正文
  {
    const r = run([meta("OTHER"), turn("A"), user("hi"), call("c1", q1)]);
    check("Q08 会话不一致：unknown", r.status === "unknown" && r.reason === "session-mismatch");
    const noCall = run([meta(), turn("A"), line({ type: "response_item", payload: { type: "function_call", name: "request_user_input_async", arguments: JSON.stringify({ questions: q1 }) } })]);
    check("Q08 缺 callId：不可回答", noCall.entries[0].answerable === false && noCall.entries[0].reason === "missing-call-id");
    const emptyQ = run([meta(), turn("A"), call("c2", [{}])]);
    check("Q08 questions=[{}]：不可回答", emptyQ.entries[0].answerable === false && emptyQ.entries[0].reason === "missing-question-content");
  }
  // Q06：未知审批
  {
    const r = run([meta(), turn("A"), user("hi"), call("a1", [], "exec_approval")]);
    check("Q06 未知审批：不可回答 + 电脑核对", r.entries[0].kind === "unsupported" && r.entries[0].answerable === false && r.promptCheckOnComputer === true);
  }

  // —— 以下为模拟状态机，不代表真实协议 ——
  {
    const entries = [
      { callId: "same", turnId: "A", answerable: false },
      { callId: "same", turnId: "B", answerable: false },
    ];
    const kept = applySimulatedClosures(entries, [{ requestId: "same", turnId: "B", threadId: T }], { threadId: T });
    check("Q07 模拟关闭：只关闭 B", kept.length === 1 && kept[0].turnId === "A", JSON.stringify(kept));
    const noTurn = applySimulatedClosures(entries, [{ requestId: "same", threadId: T }], { threadId: T });
    check("Q07 模拟关闭缺回合：不关闭", noTurn.length === 2, JSON.stringify(noTurn));
    const otherThread = applySimulatedClosures(entries, [{ requestId: "same", turnId: "A", threadId: "other" }], { threadId: T });
    check("Q07 模拟关闭跨线程：不关闭", otherThread.length === 2, JSON.stringify(otherThread));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY pass=${results.length - failed.length} fail=${failed.length}\nlog: ${LOG}`);
  stream.end(() => process.exit(failed.length ? 1 : 0));
};

main();
