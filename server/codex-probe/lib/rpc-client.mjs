// JSON-RPC 客户端：行分隔 JSON，带请求超时与子进程退出处理。
// 用于连接 codex app-server（真实）或 tests/codex-probe/mock-server.mjs（模拟）。
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export class RpcClient extends EventEmitter {
  constructor({ bin, args = [], env, requestTimeoutMs = 15000, name = "client" }) {
    super();
    this.name = name;
    this.bin = bin;
    this.args = args;
    this.env = env;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.buf = "";
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  start() {
    this.child = spawn(this.bin, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env ?? process.env,
      // 独立进程组：app-server 可能再启动子进程，关闭时按组终止，避免孤儿进程。
      detached: process.platform !== "win32",
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d) => this.emit("stderr", d));
    this.child.on("error", (err) => this.#failAll("SPAWN_ERROR", err.message));
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.#failAll("PROCESS_EXIT", `process exited code=${code} signal=${signal}`, { exitCode: code, signal });
      this.emit("exit", { code, signal });
    });
    return this;
  }

  #onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit("unparsed", line);
        continue;
      }
      this.#onMessage(msg);
    }
  }

  #onMessage(msg) {
    if (msg.method && msg.id !== undefined) {
      this.emit("serverRequest", msg);
      return;
    }
    if (msg.method) {
      this.emit("notification", msg);
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) {
      this.emit("orphanResponse", msg);
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(Object.assign(new Error(msg.error.message ?? "rpc error"), { code: msg.error.code, data: msg.error }));
    else entry.resolve(msg.result);
  }

  #failAll(code, message, extra = {}) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(Object.assign(new Error(message), { ...extra, code }));
    }
  }

  request(method, params, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.closed) return Promise.reject(Object.assign(new Error("client closed"), { code: "CLOSED" }));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`rpc timeout: ${method}`), { code: "TIMEOUT", method }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      const payload = { id, method };
      if (params !== undefined) payload.params = params;
      this.child.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  notify(method, params) {
    if (this.closed) return false;
    const payload = { method };
    if (params !== undefined) payload.params = params;
    this.child.stdin.write(JSON.stringify(payload) + "\n");
    return true;
  }

  respond(id, result) {
    if (this.closed) return false;
    this.child.stdin.write(JSON.stringify({ id, result }) + "\n");
    return true;
  }

  respondError(id, code, message) {
    if (this.closed) return false;
    this.child.stdin.write(JSON.stringify({ id, error: { code, message } }) + "\n");
    return true;
  }

  #killGroup(signal) {
    const pid = this.child?.pid;
    if (!pid) return;
    if (process.platform !== "win32") {
      try { process.kill(-pid, signal); } catch { /* 组已不存在 */ }
    }
    try { this.child.kill(signal); } catch { /* 已退出 */ }
  }

  async close({ timeoutMs = 2000 } = {}) {
    if (!this.child || this.closed) return;
    this.closed = true;
    this.#failAll("CLOSED", "client closed");
    this.#killGroup("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#killGroup("SIGKILL");
        resolve();
      }, timeoutMs);
      this.child?.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
