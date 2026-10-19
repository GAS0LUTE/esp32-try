#!/usr/bin/env node
// INT-001 探针：连接 Unix socket，发送一次 initialize 握手，记录返回。
// 只读；不发送 turn、不修改状态。用法: node probe-socket.mjs --sock /path/to.sock
import net from "node:net";

const args = process.argv.slice(2);
let sockPath = "";
for (let i = 0; i < args.length; i++) if (args[i] === "--sock") sockPath = args[++i];
if (!sockPath) {
  console.error("missing --sock");
  process.exit(64);
}

const ts = () => new Date().toISOString();
const log = (o) => console.log(JSON.stringify({ t: ts(), ...o }));

const sock = net.connect(sockPath);
let buf = "";
sock.setEncoding("utf8");

sock.on("connect", () => {
  log({ kind: "connected", sockPath });
  const msg = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "gpt-cube-probe", title: "INT-001 probe", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    },
  };
  log({ kind: "out", method: msg.method, id: msg.id });
  sock.write(JSON.stringify(msg) + "\n");
});

sock.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      log({ kind: "in", id: m.id, method: m.method, resultKeys: m.result ? Object.keys(m.result) : undefined, error: m.error ?? undefined });
    } catch {
      log({ kind: "in_raw", text: line.slice(0, 500) });
    }
  }
});

sock.on("error", (e) => log({ kind: "error", message: e.message }));
sock.on("close", () => {
  log({ kind: "closed" });
  process.exit(0);
});

setTimeout(() => {
  log({ kind: "timeout", bufferedRaw: buf.slice(0, 500) });
  sock.destroy();
  process.exit(3);
}, 4000);
