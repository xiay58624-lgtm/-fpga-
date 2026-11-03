"use strict";

const net = require("net");

const ACTIONS = Object.freeze({
  left: "P2",
  straight: "P1",
  right: "P3",
  stop: "K",
  lane_left: "P4",
  lane_right: "P5",
  uturn: "P6",
  alarm: "H",
});

function validPrivateIpv4(value) {
  const host = String(value || "").trim();
  if (net.isIP(host) !== 4) return "";
  const [a, b] = host.split(".").map(Number);
  const privateAddress = a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a === 127
    || (a === 169 && b === 254);
  return privateAddress ? host : "";
}

function bridgeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class WifiCarBridge {
  constructor({ host = "192.168.4.1", port = 8888, reconnectMs = 3000, ackTimeoutMs = 2500, handshakeTimeoutMs = 5000, allowPortOverride = false } = {}) {
    const safeHost = validPrivateIpv4(host);
    this.host = safeHost || "192.168.4.1";
    this.port = Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65535 ? Number(port) : 8888;
    this.reconnectMs = reconnectMs;
    this.ackTimeoutMs = ackTimeoutMs;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.allowPortOverride = allowPortOverride;
    this.state = "idle";
    this.ready = false;
    this.desired = false;
    this.socket = null;
    this.lineBuffer = "";
    this.pending = null;
    this.reconnectTimer = null;
    this.handshakeTimer = null;
    this.lastSeenAtMs = null;
    this.lastResponse = "";
    this.lastCommand = "";
    this.lastCommandAtMs = null;
    this.lastError = "";
  }

  getStatus() {
    return {
      device: "WifiCar ESP32",
      ssid: "8266WifiCar",
      host: this.host,
      port: this.port,
      state: this.state,
      online: this.ready && Boolean(this.socket && !this.socket.destroyed),
      ready: this.ready,
      desired: this.desired,
      last_seen_at_ms: this.lastSeenAtMs,
      last_response: this.lastResponse,
      last_command: this.lastCommand,
      last_command_at_ms: this.lastCommandAtMs,
      command_busy: Boolean(this.pending),
      last_error: this.lastError,
      supported_actions: Object.keys(ACTIONS),
      unsupported_actions: [],
    };
  }

  connect({ host = this.host, port = 8888 } = {}) {
    const safeHost = validPrivateIpv4(host);
    if (!safeHost) throw bridgeError("bad_host", "请输入 ESP32 热点的私有 IPv4 地址，例如 192.168.4.1");
    const safePort = Number(port);
    if (!Number.isInteger(safePort) || safePort < 1 || safePort > 65535 || (!this.allowPortOverride && safePort !== 8888)) {
      throw bridgeError("bad_port", "WifiCar 固件 TCP 控制端口固定为 8888");
    }

    this.host = safeHost;
    this.port = safePort;
    this.desired = true;
    this.lastError = "";
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.#dropSocket();
    this.state = "connecting";
    this.#openSocket();
    return this.getStatus();
  }

  async disconnect() {
    if (this.getStatus().online) {
      try { await this.sendAction("stop"); } catch {}
    }
    this.desired = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.#dropSocket();
    this.state = "idle";
    this.ready = false;
    this.lastError = "";
    return this.getStatus();
  }

  close() {
    this.desired = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    const socket = this.socket;
    const wasReady = this.ready;
    this.socket = null;
    this.ready = false;
    this.lineBuffer = "";
    this.#failPending(bridgeError("connection_closed", "后端关闭 WifiCar TCP 连接"));
    this.state = "idle";
    if (socket && !socket.destroyed) {
      if (wasReady) socket.end("K\r\n");
      else socket.destroy();
    }
  }

  async sendAction(action) {
    const key = String(action || "").trim().toLowerCase();
    const command = ACTIONS[key];
    if (!command) {
      throw bridgeError("unsupported_action", "不支持的 WifiCar 动作");
    }
    if (!this.getStatus().online) throw bridgeError("wifi_car_offline", "ESP32 尚未完成 TCP 握手，请先连接小车热点和控制端口");
    if (this.pending && key !== "stop" && key !== "alarm") throw bridgeError("command_busy", "上一条小车命令仍在等待 ESP32 确认");
    if (this.pending && (key === "stop" || key === "alarm")) {
      const previous = this.pending;
      this.pending = null;
      clearTimeout(previous.timer);
      previous.reject(bridgeError("command_preempted", "收到停车 / 报警优先指令，上一条命令已被安全指令中断"));
    }

    return new Promise((resolve, reject) => {
      const pending = { action: key, command, resolve, reject, timer: null };
      pending.timer = setTimeout(() => {
        if (this.pending !== pending) return;
        this.pending = null;
        this.lastError = "ESP32 命令确认超时";
        this.socket?.destroy();
        reject(bridgeError("command_timeout", this.lastError));
      }, this.ackTimeoutMs);
      pending.timer.unref?.();
      this.pending = pending;
      this.socket.write(`${command}\r\n`, (error) => {
        if (!error || this.pending !== pending) return;
        clearTimeout(pending.timer);
        this.pending = null;
        this.lastError = String(error.message || error);
        reject(bridgeError("command_write_failed", this.lastError));
      });
    });
  }

  #dropSocket() {
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.lineBuffer = "";
    this.#failPending(bridgeError("connection_closed", "ESP32 TCP 连接已关闭"));
    if (socket && !socket.destroyed) socket.destroy();
  }

  #failPending(error) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  #scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    if (!this.desired) return;
    this.state = "connecting";
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#openSocket();
    }, this.reconnectMs);
    this.reconnectTimer.unref?.();
  }

  #openSocket() {
    if (!this.desired || this.socket) return;
    this.state = "connecting";
    this.ready = false;
    this.lineBuffer = "";
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("connect", () => {
      if (this.socket !== socket) return;
      this.state = "handshaking";
      this.handshakeTimer = setTimeout(() => {
        if (this.socket === socket && !this.ready) {
          this.lastError = "TCP 已连接，但未收到 WIFICAR READY 握手";
          socket.destroy();
        }
      }, this.handshakeTimeoutMs);
      this.handshakeTimer.unref?.();
    });
    socket.on("data", (chunk) => {
      if (this.socket !== socket) return;
      this.lineBuffer += chunk.toString("utf8");
      const lines = this.lineBuffer.split(/\r?\n/);
      this.lineBuffer = lines.pop() || "";
      for (const rawLine of lines) this.#consumeLine(rawLine.trim());
    });
    socket.on("error", (error) => {
      if (this.socket !== socket) return;
      this.lastError = String(error?.message || error || "TCP 连接失败");
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      this.#failPending(bridgeError("connection_closed", "ESP32 TCP 连接中断"));
      if (this.desired) this.#scheduleReconnect();
      else this.state = "idle";
    });
  }

  #consumeLine(line) {
    if (!line) return;
    this.lastSeenAtMs = Date.now();
    this.lastResponse = line.slice(0, 160);
    if (line === "WIFICAR READY") {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      this.ready = true;
      this.state = "online";
      this.lastError = "";
      return;
    }
    if (!this.pending) return;
    if (line === `TCP OK: ${this.pending.command}`) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      this.lastCommand = pending.action;
      this.lastCommandAtMs = Date.now();
      this.lastError = "";
      pending.resolve({ ok: true, action: pending.action, command: pending.command, response: line, status: this.getStatus() });
      return;
    }
    if (line.startsWith("TCP ERROR:")) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      this.lastError = line.slice("TCP ERROR:".length).trim() || "ESP32 拒绝了命令";
      pending.reject(bridgeError("command_rejected", this.lastError));
    }
  }
}

module.exports = { WifiCarBridge, ACTIONS, validPrivateIpv4 };
