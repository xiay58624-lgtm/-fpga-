"use strict";

const { randomUUID } = require("node:crypto");

// Read-only observation: this module never generates or forwards car commands.
class CommunicationLog {
  constructor({ capacity = 500, maxPayloadBytes = 32768, now = Date.now, instanceId = randomUUID() } = {}) {
    this.capacity = capacity;
    this.maxPayloadBytes = maxPayloadBytes;
    this.now = now;
    this.instanceId = instanceId;
    this.sequence = 0;
    this.entries = [];
    this.listeners = new Set();
    this.totals = { rk_rx: 0, car_tx: 0, car_rx: 0, system: 0 };
    this.lastAt = {};
  }

  append({ channel = "system", direction = "event", transport = "", status = "info", payload = "", summary = "", command = "", command_id = "", frame_sequence = null, action = "", endpoint = "", elapsed_ms = null } = {}) {
    const original = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
    // Headers are never captured; mask secrets if a device puts them in its body.
    const safe = original.replace(/("(?:password|passwd|token|authorization|api[_-]?key|secret|[^"\\]*[_-](?:token|password|secret))"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"');
    const bytes = Buffer.from(safe, "utf8");
    let text = safe;
    const truncated = bytes.length > this.maxPayloadBytes;
    if (truncated) {
      text = bytes.subarray(0, this.maxPayloadBytes).toString("utf8");
      if (text.endsWith("\ufffd")) text = text.slice(0, -1);
    }
    const entry = {
      id: ++this.sequence, instance_id: this.instanceId, at_ms: this.now(),
      channel: Object.hasOwn(this.totals, channel) ? channel : "system", direction, transport,
      status, summary: String(summary).slice(0, 500), payload: text,
      byte_length: Buffer.byteLength(original, "utf8"), stored_bytes: Buffer.byteLength(text, "utf8"),
      truncated, redacted: safe !== original, command, command_id, frame_sequence,
      action, endpoint, elapsed_ms,
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    this.totals[entry.channel]++;
    this.lastAt[entry.channel] = entry.at_ms;
    for (const listener of this.listeners) {
      try { listener(entry); } catch { /* Observability cannot interrupt control. */ }
    }
    return entry;
  }

  snapshot({ after = null, instance = "", limit = 100 } = {}) {
    const reset = Boolean(instance && instance !== this.instanceId);
    const cursor = Number.isSafeInteger(Number(after)) && Number(after) >= 0 && after !== null && after !== "" ? Number(after) : null;
    const first = this.entries[0]?.id || this.sequence + 1;
    const gap = !reset && cursor !== null && cursor < first - 1;
    const available = !reset && cursor !== null ? this.entries.filter((entry) => entry.id > cursor) : this.entries;
    const safeLimit = Math.max(1, Math.min(this.capacity, Number(limit) || 100));
    const items = cursor !== null && !reset ? available.slice(0, safeLimit) : available.slice(-safeLimit);
    return { ok: true, instance_id: this.instanceId, capacity: this.capacity, retained: this.entries.length,
      latest_id: this.sequence, first_id: first, reset, gap, server_at_ms: this.now(),
      next_cursor: items.at(-1)?.id ?? (reset ? this.sequence : cursor ?? this.sequence),
      has_more: available.length > items.length && cursor !== null && !reset,
      totals: { ...this.totals }, last_at_ms: { ...this.lastAt }, items };
  }

  stream(req, res, { after = null, instance = "" } = {}) {
    if (this.listeners.size >= 64) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "too_many_log_viewers" }));
      return;
    }
    const resume = String(req.headers["last-event-id"] || "");
    const match = resume.match(/^(.+):(\d+)$/);
    if (match) { instance = match[1]; after = Number(match[2]); }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive", "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    req.socket?.setTimeout(0);
    const write = (event, data, id) => {
      if (res.destroyed || res.writableEnded) return false;
      const frame = `${id ? `id: ${this.instanceId}:${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      // A false return from write() is normal socket backpressure, not failure.
      // Drop only a persistently slow reader; EventSource resumes by event ID.
      if (res.writableLength > 2_000_000) { res.end(); return false; }
      res.write(frame);
      return true;
    };
    res.write("retry: 1500\n\n");
    const snapshot = this.snapshot({ after, instance, limit: after === null ? 100 : this.capacity });
    write("snapshot", snapshot, snapshot.latest_id);
    const listener = (entry) => write("entry", entry, entry.id);
    if (!res.writableEnded) this.listeners.add(listener);
    const heartbeat = setInterval(() => write("heartbeat", { server_at_ms: this.now(), latest_id: this.sequence }), 10000);
    heartbeat.unref?.();
    const clean = () => { clearInterval(heartbeat); this.listeners.delete(listener); };
    res.once("close", clean);
    res.once("error", clean);
  }
}

module.exports = { CommunicationLog };
