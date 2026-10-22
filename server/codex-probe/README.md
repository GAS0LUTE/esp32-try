# INT-001 探针与验证库

用途：验证本机 Codex app-server 的接入能力，供 `设计/INT-001-电脑接入验证任务.md` 使用。
作者：DS。日期：2026-10-19。本目录不含产品逻辑。

## 目录

| 路径 | 内容 |
|---|---|
| `probe-stdio.mjs` | stdio 握手 + 单次只读调用 |
| `probe-socket.mjs` | 裸 Unix socket 握手（对照用） |
| `probe-ws-unix.mjs` | WebSocket over Unix socket 握手（手工实现 Upgrade 与帧） |
| `../tests/codex-probe/probe-front-target.mjs` | 前台应用、ChatGPT 窗口标题与线程索引的只读映射 |
| `../tests/codex-probe/tools/winlist.swift` | CoreGraphics 窗口枚举辅助程序 |
| `../tests/codex-probe/f02-preflight.mjs` | F02-P 预演：截图 + OCR 锚点 + 9 项检查，不发送事件 |
| `lib/preflight-geometry.mjs` | 数值坐标换算与 sendChecks 评估（无截图可测） |
| `lib/rpc-client.mjs` | JSON-RPC 客户端：请求超时、子进程退出拒绝、进程组回收 |
| `lib/turn-observer.mjs` | 回合观察：先注册监听、按 threadId/turnId 过滤、早到通知缓冲 |
| `lib/server-request-router.mjs` | server request 分派：代次/线程/回合绑定、resolved、未实现类型 |
| `lib/input-state.mjs` | 输入状态机与发送门禁：未发送/待确认/处理中/已完成/结果未知 |
| `lib/target-tracker.mjs` | 前台目标绑定：稳定计数、显式确认、变化停发 |
| `lib/version-check.mjs` | 二进制版本与 schema 摘要一致性检查 |
| `lib/log.mjs` | 字段白名单 + 本机信息脱敏日志 |
| `schema/`、`schema-0.163/` | 两个版本的协议定义（各带 `manifest.json`） |

## 环境事实（实测）

| 项 | 值 | 来源 |
|---|---|---|
| 系统 CLI | `codex-cli 0.147.0`（`/opt/homebrew/bin/codex`） | `codex --version` |
| 桌面内置 CLI | `codex-cli 0.163.0-alpha.10.2` | ChatGPT.app 内置二进制 |
| 桌面应用 | ChatGPT 26.1013.40934，pid 37209 | Info.plist、lsof |
| 桌面内部实例 | `codex app-server --listen stdio://`，pid 37289，父进程为桌面 | pgrep/lsof，2026-10-19 |
| 系统 | macOS 27.0.0 arm64 | initialize 响应 |
| 协议 | JSON-RPC 2.0，线上省略 `"jsonrpc"` 头，JSONL | 官方文档 + 实测 |

## 支持的传输

- `stdio://`（默认）：newline-delimited JSON。
- `ws://IP:PORT`：实验性，文档注明不用于生产。
- `unix://` / `unix://PATH`：**WebSocket over Unix socket**，需要 HTTP Upgrade，不是裸 JSONL。
- `off`：不开放本地传输。

官方文档：https://learn.chatgpt.com/docs/app-server
上游 README（已读，commit 8fe5066b）：https://github.com/openai/codex/blob/8fe5066b/codex-rs/app-server/README.md

实测：自建 `--listen unix://PATH` 后，`probe-ws-unix.mjs` 得到 `101 Switching Protocols`，initialize 与 `thread/loaded/list` 均成功；同一路径用裸 JSONL 连接会被立即关闭。

桌面 `~/.codex/ipc/ipc.sock`：裸 JSONL（带/不带 `jsonrpc` 头）与 WebSocket Upgrade 三种尝试都被立即关闭，且无 HTTP 响应，不是 app-server 入口。

## 运行

```bash
# 隔离 home（不碰真实状态）
CODEX_HOME="$(mktemp -d)" node server/codex-probe/probe-stdio.mjs --call thread/loaded/list

# 真实 home（需沙箱外；只用只读调用）
node server/codex-probe/probe-stdio.mjs --call thread/loaded/list

# 模拟夹具（无需真实会话）
node tests/codex-probe/run-mock-tests.mjs

# 真实会话断言（版本门禁 + 专用测试会话）
node tests/codex-probe/run-b-tests.mjs

# 证据日志脱敏
node tests/codex-probe/check-logs.mjs --sanitize
```

schema 生成（与二进制版本严格对应）：

```bash
codex app-server generate-json-schema --out server/codex-probe/schema
/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex \
  app-server generate-json-schema --out server/codex-probe/schema-0.163
```

## 版本门禁

`lib/version-check.mjs` 读取 schema 目录的 `manifest.json`，比较二进制的 `--version` 与 `ClientRequest.json`、`ServerRequest.json`、`ServerNotification.json`、`v1/InitializeParams.json` 的 SHA-256。不一致时 `run-b-tests.mjs` 在发送任何真实输入前退出。

原因：0.147.0 读取桌面 0.163 写出的 models cache 失败（`missing field supports_parallel_tool_calls`），回合直接 failed。

## 实测结论

1. 隔离 home 与真实 home 的 `initialize` 均成功；真实 home 需要沙箱外执行（本工作区文件沙箱拒绝写 `~/.codex`）。
2. `thread/loaded/list`、`thread/list` 可调用；隔离 home 返回空列表。
3. `thread/read` 对未加载线程返回 `-32600 thread not loaded`，读取历史需先加载/恢复。
4. 桌面实时会话没有对外入口：`ipc.sock` 不是 app-server 协议；受管 daemon 的 control socket 当前不存在。
5. 外部可达路径是自建实例（stdio 或本地 unix），共享 `~/.codex` 持久化线程；桌面并发订阅行为未验证。
6. 真实会话（0.163）：ACK 往返、第二实例恢复、澄清请求与答复、命令审批拒绝均通过，且收到 `serverRequest/resolved`。
7. 模拟夹具：74 项断言通过，2 项标注未验证；覆盖立即完成、其他回合、子进程退出、超时、审批、澄清、未实现类型、多请求、重复回答、忙碌、输入状态与版本门禁。
8. C01：目标回合无文本时返回空，其他回合的 delta 不混入。
9. C02：过期回合、已关闭请求、缺标识、重连后同 ID 分别有断言；resolved 后不再响应。
10. C03：忙碌保留、断线标记结果未知、重连核对前阻塞、显式补发与显式重发。
11. R01：首次 ACK 前只发送一次；核对前、处理中、重发后再次调用均不发送；完成后不得按未知重发。
12. R02：thread/turn 未绑定时不产生业务答复；缺标识、目标不匹配分别拒绝。

## 日志与脱敏

- 新日志只写白名单字段，并自动脱敏本机路径、主机名、邮箱和密钥样式字符串。
- 旧日志（2026-10-19 17:21–17:28）含本机路径与主机名，脱敏副本在 `tests/codex-probe/logs/redacted/`；原日志不用于公开分享。
- 测试线程 ID 属于必要关联标识，可随证据提供；其中不含用户其他会话内容。

## 版本差异（方法集合对比）

- 仅 0.163 有：`thread/attachment/*`、`thread/items/list`、`thread/turns/list`、`thread/revert`、`plugin/reconcile`、`account/gatewayOAuth/*`。
- 仅 0.147 有：`thread/rollback`。
- 通知：0.163 多 15 个（实时事件细分、队列/预测状态等）。
