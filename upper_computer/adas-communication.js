(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const routes = { rk_rx: "RK → 云端上位机", car_tx: "云端上位机 → 小车", car_rx: "小车 → 云端上位机", system: "连接 / 控制状态" };
  const states = { received: "已接收", queued: "已提交 · 等待回执", acknowledged: "ESP32 已确认", error: "失败", timeout: "确认超时", connected: "连接建立", disconnected: "连接断开", preempted: "被安全指令中断", info: "信息" };
  let active = false, paused = false, pending = 0, instance = "", cursor = 0;
  let entries = [], totals = {}, lastAt = {}, clearedAt = 0;
  let source = null, retryTimer = null, pollTimer = null, carTimer = null, renderTimer = null;
  let generation = 0, polling = false, liveAt = 0;
  const opened = new Set();
  const time = (value) => value ? new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Shanghai", fractionalSecondDigits: 3 }) : "尚无记录";
  function base() { return ($("backendBase")?.value.trim() || location.origin).replace(/\/+$/, ""); }
  function notice(text) { $("commNotice").textContent = text; $("commNotice").hidden = !text; }
  function connection(text, state) { $("commConnection").textContent = text; $("commConnection").dataset.state = state; }
  function markLive() { liveAt = Date.now(); connection("实时推送已连接 · SSE", "live"); }
  function visibleEntries() {
    const channel = $("commChannel").value, search = $("commSearch").value.trim().toLowerCase();
    return entries.filter((entry) => entry.id > clearedAt && (channel === "all" || channel === entry.channel)
      && (!search || `${entry.summary} ${entry.payload} ${entry.command} ${entry.frame_sequence ?? ""} ${entry.command_id}`.toLowerCase().includes(search))).reverse();
  }
  function rawText(entry) {
    const text = entry.payload || "";
    if ($("commFormat").value === "hex") {
      return Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
    }
    if ($("commFormat").value === "json") { try { return JSON.stringify(JSON.parse(text), null, 2); } catch {} }
    return text.replace(/\r/g, "\\r").replace(/\n/g, "\\n\n").replace(/\t/g, "\\t");
  }
  function stats() {
    [["commRkCount", "commRkTime", "rk_rx"], ["commTxCount", "commTxTime", "car_tx"], ["commRxCount", "commRxTime", "car_rx"]].forEach(([count, stamp, key]) => {
      $(count).textContent = String(totals[key] || 0);
      $(stamp).textContent = lastAt[key] ? "最近 " + time(lastAt[key]) : "尚无记录";
    });
    $("commPending").textContent = paused ? `显示已暂停 · 新增 ${pending} 条（仍接收，最多保留 500 条）` : "";
  }
  function row(entry) {
    const article = document.createElement("article"); article.className = "comm-entry";
    article.dataset.id = entry.id; article.dataset.channel = entry.channel;
    article.dataset.error = String(["error", "timeout", "preempted"].includes(entry.status));
    const clock = document.createElement("div"), stamp = document.createElement("time"), sequence = document.createElement("span");
    stamp.textContent = time(entry.at_ms); stamp.dateTime = new Date(entry.at_ms).toISOString();
    sequence.className = "comm-seq"; sequence.textContent = `#${entry.id}${entry.frame_sequence !== null ? ` · 帧 ${entry.frame_sequence}` : ""}`;
    clock.append(stamp, sequence);
    const route = document.createElement("div"); route.className = "comm-route";
    const title = document.createElement("b"), transport = document.createElement("small"), status = document.createElement("span");
    title.textContent = routes[entry.channel] || entry.channel;
    transport.textContent = `${entry.transport || "系统"}${entry.byte_length ? ` · ${entry.byte_length} B` : ""}`;
    status.className = "comm-status"; status.textContent = states[entry.status] || entry.status;
    route.append(title, transport, status);
    const message = document.createElement("div"); message.className = "comm-message";
    const summary = document.createElement("p"); summary.textContent = entry.summary; message.append(summary);
    if (entry.payload) {
      const code = document.createElement("code"), formatted = rawText(entry);
      code.textContent = formatted.length > 260 ? formatted.slice(0, 260) + " …" : formatted;
      message.append(code);
      const details = document.createElement("details"), toggle = document.createElement("summary"), pre = document.createElement("pre");
      toggle.textContent = entry.truncated ? `查看已保留原文（${entry.stored_bytes} B / ${entry.byte_length} B，已截断）` : "展开原始报文";
      if (entry.redacted) toggle.textContent += " · 密钥已脱敏";
      details.open = opened.has(entry.id);
      if (details.open) pre.textContent = formatted;
      details.addEventListener("toggle", () => { if (details.open) { opened.add(entry.id); pre.textContent = formatted; } else opened.delete(entry.id); });
      details.append(toggle, pre); message.append(details);
    }
    const meta = document.createElement("small"); meta.className = "comm-meta";
    meta.textContent = [entry.endpoint, entry.command_id ? `关联 ${entry.command_id}` : "", entry.elapsed_ms !== null ? `回传间隔 ${entry.elapsed_ms} ms` : ""].filter(Boolean).join(" · ");
    message.append(meta); article.append(clock, route, message);
    return article;
  }
  function render() {
    renderTimer = null; stats();
    if (paused || !active) return;
    const log = $("commLog"), previous = log.scrollTop, items = visibleEntries();
    const fragment = document.createDocumentFragment();
    for (const entry of items.slice(0, 200)) fragment.append(row(entry));
    if (!items.length) { const empty = document.createElement("div"); empty.className = "comm-empty"; empty.textContent = "当前筛选暂无真实通信记录；设备有数据时会自动显示。"; fragment.append(empty); }
    log.replaceChildren(fragment); log.scrollTop = $("commAutoScroll").checked ? 0 : previous;
    $("commViewCount").textContent = `${items.length} 条${items.length > 200 ? " · 显示最新 200 条，导出包含全部筛选" : ""}`;
  }
  function schedule() { if (!renderTimer) renderTimer = setTimeout(render, 120); }
  function ingest(entry, count = true) {
    if (!entry || !Number.isSafeInteger(entry.id) || entry.instance_id !== instance || entry.id <= cursor) return;
    cursor = entry.id; entries.push(entry);
    if (entries.length > 500) { const removed = entries.splice(0, entries.length - 500); removed.forEach((entry) => opened.delete(entry.id)); }
    if (count) totals[entry.channel] = (totals[entry.channel] || 0) + 1;
    lastAt[entry.channel] = entry.at_ms;
    if (paused) pending++;
    schedule();
  }
  function snapshot(payload) {
    if (!payload || payload.ok !== true) throw new Error("Invalid communication snapshot");
    const changed = instance && instance !== payload.instance_id;
    if (changed) { entries = []; cursor = 0; clearedAt = 0; opened.clear(); pending = 0; notice("服务已重新启动，旧运行的日志已结束，正在显示本次运行的新记录。"); }
    instance = payload.instance_id;
    if (payload.gap) notice("断线期间的部分记录已超出服务端最近 500 条窗口，已从仍保留的数据继续；不代表链路已丢失控制命令。");
    for (const entry of payload.items || []) ingest(entry, false);
    cursor = Math.max(cursor, Number(payload.next_cursor) || 0);
    totals = payload.totals || totals; lastAt = payload.last_at_ms || lastAt; schedule();
  }
  function stop() {
    generation++; source?.close(); source = null;
    clearTimeout(retryTimer); clearInterval(pollTimer); clearInterval(carTimer);
    retryTimer = pollTimer = carTimer = null; polling = false;
  }
  async function poll(myGeneration) {
    if (polling || !active || myGeneration !== generation) return;
    polling = true;
    try {
      const query = new URLSearchParams({ limit: "500" });
      if (instance) { query.set("instance", instance); query.set("after", String(cursor)); }
      const response = await fetch(`${base()}/api/communication/history?${query}`, { cache: "no-store", signal: AbortSignal.timeout(4500) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (myGeneration !== generation || source?.readyState === 1) return;
      snapshot(payload); connection("实时轮询 · 约 1 秒", "live");
    } catch { if (myGeneration === generation && source?.readyState !== 1) connection("日志连接中断 · 自动重连", "retry"); }
    finally { if (myGeneration === generation) polling = false; }
  }
  async function carStatus(myGeneration) {
    try {
      const response = await fetch(`${base()}/api/wifi-car/status`, { cache: "no-store", signal: AbortSignal.timeout(3500) });
      if (!response.ok) throw new Error("Unavailable");
      const status = await response.json(); if (myGeneration !== generation) return;
      $("commCarOnline").textContent = status.online ? "WSS 在线" : "未连接";
      $("commCarOnline").dataset.online = String(status.online === true);
    } catch { if (myGeneration === generation) { $("commCarOnline").textContent = "状态未知"; $("commCarOnline").dataset.online = "false"; } }
  }
  function openStream(myGeneration) {
    if (!active || myGeneration !== generation || !window.EventSource) return;
    const query = new URLSearchParams();
    if (instance) { query.set("instance", instance); query.set("after", String(cursor)); }
    const stream = new EventSource(`${base()}/api/communication/events?${query}`); source = stream;
    const valid = () => active && generation === myGeneration && source === stream;
    stream.addEventListener("snapshot", (event) => {
      if (!valid()) return;
      try { snapshot(JSON.parse(event.data)); clearInterval(pollTimer); pollTimer = null; clearTimeout(retryTimer); markLive(); }
      catch { stream.close(); fallback(myGeneration); }
    });
    stream.addEventListener("entry", (event) => { if (!valid()) return; try { ingest(JSON.parse(event.data)); markLive(); } catch {} });
    stream.addEventListener("heartbeat", () => { if (valid()) markLive(); });
    stream.onerror = () => { if (!valid()) return; stream.close(); source = null; fallback(myGeneration); };
    // Recover from a proxy that buffers SSE without firing an error.
    const openedAt = Date.now();
    retryTimer = setTimeout(() => { if (valid() && liveAt < openedAt) { stream.close(); source = null; fallback(myGeneration); } }, 6000);
  }
  function fallback(myGeneration) {
    if (!active || myGeneration !== generation) return;
    connection("重连中 · 轮询补收", "retry");
    clearInterval(pollTimer); clearTimeout(retryTimer);
    poll(myGeneration); pollTimer = setInterval(() => poll(myGeneration), 1000);
    if (window.EventSource) retryTimer = setTimeout(() => openStream(myGeneration), 8000);
  }
  function start() {
    stop(); if (!active) return;
    const current = generation; connection("正在连接实时日志…", "retry");
    carStatus(current); carTimer = setInterval(() => carStatus(current), 5000);
    if (window.EventSource) openStream(current); else fallback(current);
    schedule();
  }
  function init() {
    if (!$("communicationPage")) return;
    window.addEventListener("adas-page-change", (event) => { active = event.detail === "communication"; if (active) start(); else stop(); });
    $("openCommunication")?.addEventListener("click", () => document.querySelector('[data-page="communication"]').click());
    $("commReconnect").addEventListener("click", () => start());
    ["commChannel", "commFormat", "commSearch"].forEach((id) => $(id).addEventListener(id === "commSearch" ? "input" : "change", schedule));
    $("commPause").addEventListener("click", () => {
      paused = !paused; if (!paused) pending = 0;
      $("commPause").textContent = paused ? "继续显示" : "暂停显示";
      $("commPause").classList.toggle("active", paused); schedule();
    });
    $("commClear").addEventListener("click", () => {
      clearedAt = cursor; opened.clear(); pending = 0;
      $("commLog").replaceChildren(); $("commViewCount").textContent = "0 条";
      notice("仅清空本页显示，未删除服务端记录，也未发送车辆指令。"); schedule();
    });
    $("commExport").addEventListener("click", () => {
      const items = visibleEntries().reverse();
      const blob = new Blob([items.map((entry) => JSON.stringify(entry)).join("\n") + (items.length ? "\n" : "")], { type: "application/x-ndjson;charset=utf-8" });
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = `adas-communication-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    $("backendBase")?.addEventListener("change", () => {
      entries = []; instance = ""; cursor = clearedAt = 0; totals = {}; lastAt = {}; opened.clear(); if (active) start();
    });
    window.addEventListener("pagehide", stop);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
