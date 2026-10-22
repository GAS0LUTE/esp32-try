// 仅用于测试的模拟关闭状态机；生产观察器不导入本模块。
// 用来验证“结构化关闭按 thread/turn/request 归属”这一假设，不代表真实协议存在。
export function applySimulatedClosures(entries, resolutions, { threadId } = {}) {
  const closed = new Set();
  for (const r of resolutions ?? []) {
    if (!r.requestId || !r.turnId) continue; // 归属不明不关闭
    if (r.threadId && r.threadId !== threadId) continue;
    closed.add(`${r.turnId}:${r.requestId}`);
  }
  return entries.filter((e) => !(e.turnId && closed.has(`${e.turnId}:${e.callId}`)));
}
