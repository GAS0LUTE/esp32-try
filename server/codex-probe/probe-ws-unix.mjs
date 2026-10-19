#!/usr/bin/env node
// 最小 WebSocket-over-Unix 客户端：用于区分“裸 JSONL”与“WebSocket 升级”两种连接结果。
// 用法: node probe-ws-unix.mjs --sock /path/to.sock [--method thread/loaded/list]
import net from "node:net";
import crypto from "node:crypto";

const args = process.argv.slice(2);
let sockPath = "";
let method = "thread/loaded/list";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--sock") sockPath = args[++i];
  if (args[i] === "--method") method = args[++i];
}
if (!sockPath) {
  console.error("missing --sock");
  process.exit(64);
}

const ts = () => new Date().toISOString();
const log = (o) => console.log(JSON.stringify({ t: ts(), ...o }));
const key = crypto.randomBytes(16).toString("base64");

const sock = net.connect(sockPath);
let raw = Buffer.alloc(0);
let upgraded = false;
let frameBuf = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();

const maskedFrame = (text) => {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
};

const sendJson = (obj) => {
  sock.write(maskedFrame(JSON.stringify(obj)));
  log({ kind: "out", id: obj.id, method: obj.method });
};

const onFrame = (opcode, payload) => {
  if (opcode === 0x1) {
    const text = payload.toString("utf8");
    let msg;
    try { msg = JSON.parse(text); } catch { log({ kind: "in_raw", text: text.slice(0, 300) }); return; }
    log({ kind: "in", id: msg.id, method: msg.method, resultKeys: msg.result ? Object.keys(msg.result) : undefined, error: msg.error ?? undefined });
    if (msg.id !== undefined && pending.has(msg.id)) {
      const r = pending.get(msg.id);
      pending.delete(msg.id);
      r(msg);
    }
  } else if (opcode === 0x8) {
    log({ kind: "close_frame" });
    sock.destroy();
    process.exit(0);
  } else if (opcode === 0x9) {
    // pong
    const mask = crypto.randomBytes(4);
    const p = Buffer.from(payload);
    for (let i = 0; i < p.length; i++) p[i] ^= mask[i % 4];
    sock.write(Buffer.concat([Buffer.from([0x8a, 0x80 | p.length]), mask, p]));
    log({ kind: "ping_received" });
  }
};

const parseFrames = () => {
  while (frameBuf.length >= 2) {
    const b0 = frameBuf[0];
    const b1 = frameBuf[1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (frameBuf.length < 4) return;
      len = frameBuf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (frameBuf.length < 10) return;
      len = Number(frameBuf.readBigUInt64BE(2));
      offset = 10;
    }
    let maskKey = null;
    if (masked) {
      if (frameBuf.length < offset + 4) return;
      maskKey = frameBuf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (frameBuf.length < offset + len) return;
    let payload = frameBuf.subarray(offset, offset + len);
    if (maskKey) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    frameBuf = frameBuf.subarray(offset + len);
    onFrame(opcode, payload);
  }
};

const request = (m, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    sendJson({ id, method: m, params });
  });

sock.on("connect", () => {
  log({ kind: "connected", sockPath });
  sock.write(
    `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
  );
});

sock.on("data", (chunk) => {
  if (!upgraded) {
    raw = Buffer.concat([raw, chunk]);
    const idx = raw.indexOf("\r\n\r\n");
    if (idx < 0) return;
    const head = raw.subarray(0, idx).toString("utf8");
    const statusLine = head.split("\r\n")[0];
    log({ kind: "http_response", statusLine, headers: head.split("\r\n").slice(1, 6) });
    if (!/101/.test(statusLine)) {
      log({ kind: "result", upgraded: false, statusLine });
      sock.destroy();
      process.exit(4);
    }
    upgraded = true;
    frameBuf = raw.subarray(idx + 4);
    raw = Buffer.alloc(0);
    (async () => {
      const init = await request("initialize", {
        clientInfo: { name: "gpt-cube-ws-probe", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      log({ kind: "result", step: "initialize", ok: !init.error, error: init.error ?? null, userAgent: init.result?.userAgent });
      sendJson({ method: "initialized", params: {} });
      const res = await request(method, {});
      log({ kind: "result", step: method, ok: !res.error, error: res.error ?? null });
      sock.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]));
      setTimeout(() => process.exit(0), 200);
    })();
    parseFrames();
    return;
  }
  frameBuf = Buffer.concat([frameBuf, chunk]);
  parseFrames();
});

sock.on("error", (e) => {
  log({ kind: "error", message: e.message });
  process.exit(3);
});
sock.on("close", () => {
  log({ kind: "closed", upgraded });
  process.exit(0);
});

setTimeout(() => {
  log({ kind: "timeout", upgraded });
  sock.destroy();
  process.exit(5);
}, 8000);
