"use strict";

const { ACTIONS } = require("./wifi-car-bridge");

class WifiCarWsBridge {
  constructor({ ackTimeoutMs = 2500, onTrace = () => {} } = {}) {
    this.ackTimeoutMs = ackTimeoutMs;
    this.onTrace = onTrace;
    this.traceSequence = 0;
    this.socket = null;
    this.ready = false;
    this.state = "waiting_for_device";
    this.pending = null;
    this.lastSeenAtMs = null;
    this.lastResponse = "";
    this.lastCommand = "";
    this.lastCommandAtMs = null;
    this.lastError = "";
    this.autoAction = "";
    this.autoGeneration = 0;
    this.autoOperation = null;
  }

  getStatus() {
    return {
      device: "WifiCar ESP32", transport: "wss", host: "adas.wmnnj.top", port: 443,
      state: this.state, online: this.ready && this.socket?.readyState === 1,
      ready: this.ready, desired: true, last_seen_at_ms: this.lastSeenAtMs,
      last_response: this.lastResponse, last_command: this.lastCommand,
      last_command_at_ms: this.lastCommandAtMs, command_busy: Boolean(this.pending),
      last_error: this.lastError, supported_actions: Object.keys(ACTIONS), unsupported_actions: [],
    };
  }

  attach(socket) {
    this.socket?.close(4001, "replaced by a newer device connection");
    this.socket = socket;
    this.ready = false;
    this.state = "handshaking";
    this.lastError = "";
    this.#trace({ channel: "system", status: "connected", summary: "ESP32 WSS 已连接，等待握手" });
    socket.on("message", (data) => {
      if (this.socket !== socket) return;
      const raw = String(data);
      const pending = this.pending;
      this.#trace({ channel: "car_rx", direction: "rx", payload: raw,
        status: raw.trim() === `TCP OK: ${pending?.command}` ? "acknowledged" : raw.trim().startsWith("TCP ERROR:") ? "error" : "received",
        summary: raw.trim() === "WIFICAR READY" ? "ESP32 握手就绪" : raw.trim().startsWith("TCP OK:") ? "ESP32 返回命令确认（非物理动作测量）" : "ESP32 原始回传",
        command: pending?.command || "", command_id: pending?.traceId || "",
        frame_sequence: pending?.context?.frame_sequence ?? null, action: pending?.action || "",
        elapsed_ms: pending ? Date.now() - pending.sentAt : null });
      this.#consume(raw.trim());
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      this.state = "waiting_for_device";
      this.#trace({ channel: "system", status: "disconnected", summary: "ESP32 WSS 连接断开" });
      this.#failPending(new Error("ESP32 WSS connection closed"));
    });
    socket.on("error", (error) => {
      if (this.socket !== socket) return;
      this.lastError = String(error?.message || error);
      this.#trace({ channel: "system", status: "error", summary: this.lastError });
    });
  }

  sendAction(action, context = {}) {
    const key = String(action || "").trim().toLowerCase();
    const command = ACTIONS[key];
    if (!command) return Promise.reject(Object.assign(new Error("不支持的 WifiCar 动作"), { code: "unsupported_action" }));
    if (!this.getStatus().online) return Promise.reject(Object.assign(new Error("ESP32 尚未连接云端 WSS"), { code: "wifi_car_offline" }));
    if (this.pending && key !== "stop" && key !== "alarm") return Promise.reject(Object.assign(new Error("上一条小车命令仍在等待确认"), { code: "command_busy" }));
    if (this.pending) {
      this.#trace({ channel: "system", status: "preempted", summary: "上一命令被停车 / 报警中断", command: this.pending.command, command_id: this.pending.traceId });
      clearTimeout(this.pending.timer);
      this.pending.reject(Object.assign(new Error("命令被停车/报警指令中断"), { code: "command_preempted" }));
      this.pending = null;
    }
    let pending;
    const promise = new Promise((resolve, reject) => {
      pending = { action: key, command, resolve, reject, context, sentAt: Date.now(), traceId: `car_${Date.now()}_${++this.traceSequence}` };
      pending.timer = setTimeout(() => {
        if (this.pending !== pending) return;
        this.pending = null;
        this.lastError = "ESP32 命令确认超时";
        this.#trace({ channel: "system", status: "timeout", summary: this.lastError, command, command_id: pending.traceId, elapsed_ms: Date.now() - pending.sentAt });
        reject(Object.assign(new Error(this.lastError), { code: "command_timeout" }));
      }, this.ackTimeoutMs);
      this.pending = pending;
      this.#trace({ channel: "car_tx", direction: "tx", status: "queued", payload: `${command}\r\n`, command,
        command_id: pending.traceId, frame_sequence: context.frame_sequence ?? null, action: key,
        summary: `${context.source === "rk_realtime_vision" ? "RK 决策" : context.source === "operator" ? "上位机操作" : "控制链路"} · 已提交 WSS 发送，等待 ESP32 回执` });
      this.socket.send(`${command}\r\n`, (error) => {
        if (error) this.#trace({ channel: "system", status: "error", summary: `发送失败：${error.message || error}`, command, command_id: pending.traceId });
        if (error && this.pending === pending) {
          clearTimeout(pending.timer);
          this.pending = null;
          reject(Object.assign(error, { code: "command_write_failed" }));
        }
      });
    });
    pending.promise = promise;
    return promise;
  }

  sendAutoAction(action, context = {}) {
    const key = String(action || "").trim().toLowerCase();
    if (!ACTIONS[key]) return Promise.reject(Object.assign(new Error("Unsupported automatic action"), {code:"unsupported_action"}));
    if (this.autoOperation?.action === key) return this.autoOperation.promise;
    const previous = this.autoAction;
    const generation = ++this.autoGeneration;
    this.autoAction = key;
    const promise = (async () => {
      if (key !== "stop" && key !== "alarm" && ((previous && previous !== key) || (this.pending && this.pending.action !== key))) {
        const stop = this.pending?.action === "stop" ? this.pending.promise : this.sendAction("stop", context);
        await stop;
      }
      if (generation !== this.autoGeneration) throw Object.assign(new Error("Automatic action replaced"), {code:"command_preempted"});
      if (this.pending?.action === key) return this.pending.promise;
      return this.sendAction(key, context);
    })();
    this.autoOperation = {action:key,generation,promise};
    promise.finally(() => {if(this.autoOperation?.generation===generation)this.autoOperation=null;}).catch(()=>{});
    return promise;
  }

  async disconnect() {
    if (this.getStatus().online) {
      try { await this.sendAction("stop"); } catch {}
    }
    return this.getStatus();
  }

  close() { this.socket?.close(1001, "server shutting down"); }

  #trace(event) {
    try { this.onTrace({ transport: "WSS", endpoint: "/device/wifi-car", ...event }); } catch {}
  }

  #consume(line) {
    if (!line) return;
    this.lastSeenAtMs = Date.now();
    this.lastResponse = line.slice(0, 160);
    if (line === "WIFICAR READY") {
      this.ready = true;
      this.state = "online";
      this.lastError = "";
      return;
    }
    const pending = this.pending;
    if (!pending) return;
    if (line === `TCP OK: ${pending.command}`) {
      this.pending = null;
      clearTimeout(pending.timer);
      this.lastCommand = pending.action;
      this.lastCommandAtMs = Date.now();
      pending.resolve({ ok: true, action: pending.action, command: pending.command, response: line, status: this.getStatus() });
    } else if (line.startsWith("TCP ERROR:")) {
      this.pending = null;
      clearTimeout(pending.timer);
      this.lastError = line.slice("TCP ERROR:".length).trim() || "ESP32 拒绝了命令";
      pending.reject(Object.assign(new Error(this.lastError), { code: "command_rejected" }));
    }
  }

  #failPending(error) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.#trace({ channel: "system", status: "error", summary: String(error.message || error), command: this.pending.command, command_id: this.pending.traceId });
    this.pending.reject(error);
    this.pending = null;
  }
}

module.exports = { WifiCarWsBridge };
