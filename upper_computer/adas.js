(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const form = $("controls");
  const webrtcPanel = document.querySelector(".webrtc-panel");
  const localRoadDefaults = {
    signal_left: "绿灯", signal_straight: "绿灯", signal_right: "绿灯",
    left_lane_marking: "虚线", right_lane_marking: "虚线",
  };
  const initialScenarioState = () => ({ ...window.AdasPolicy.defaults, ...localRoadDefaults });
  const state = initialScenarioState();
  const scenarioStates = {
    "single-test": initialScenarioState(),
    "sim-test": initialScenarioState(),
  };
  const scenarioModes = { "single-test": "local", "sim-test": "local" };
  const scenarioAutoExecute = { "single-test": false, "sim-test": false };
  let mode = "local";
  let autoExecuteEnabled = false;
  let lastAutoExecutionKey = "";
  let timer = null;
  let latestStatus = null;
  let latestReportedStatus = null;
  let latestRkPing = null;
  let latestWebRtcStatus = { connectionState: "new", message: "等待连接" };
  let rkCommandTimer = null;
  let latestRkCommandAt = 0;
  let latestRkCommandText = "";
  let seenRkCommandIds = new Set();
  let connectionGeneration = 0;
  let eventLog = [];
  let latestDecision = null;
  let cameraAnimation = 0;
  let cameraAnimationMode = "";
  let cameraRenderSequence = 0;
  let lastCameraVideoTime = -1;
  let commandBusy = false;
  let commandGeneration = 0;
  let currentPage = "performance";
  let activeScenario = "single-test";
  const performanceSamples = [];
  let latestPerformanceSample = null;
  let latestRkVision = null;
  let latestRkVisionFrameSequence = null;
  let performanceTimer = null;
  let performanceGeneration = 0;
  let terminalTimer = null;
  let terminalGeneration = 0;
  let requestedChange = "";
  const cameras = [...document.querySelectorAll(".camera")];
  const color = { ink: "#dceaf0", muted: "#8ba1ae", road: "#26343d", edge: "#a8b6ba", dash: "#a5b4b5", cyan: "#68d7df", red: "#fa737b", green: "#73d7a4", yellow: "#ecc57b" };
  const templates = ["前向道路示意", "后向道路示意", "左向道路示意", "右向道路示意"];
  const fusionController = window.AdasFusion?.createController({
    video: $("webrtcVideo"), canvas: $("fusionCanvas"), state: $("fusionState"), metrics: $("fusionMetrics"),
    start: $("fusionConnect"), stop: $("fusionDisconnect"), inputState: $("fusionInputState"), placeholder: drawFusionPlaceholder,
  });
  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function metric(value, suffix, digits = 1) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? `${value.toFixed(digits)}<em> ${suffix}</em>` : `—<em> ${suffix}</em>`;
  }

  function nowText() { return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date()).replaceAll("/", "-"); }
  function readForm() {
    const data = new FormData(form);
    const limitInput = String(data.get("speed_limit_kmh") || "").trim();
    const limit = limitInput ? Number(limitInput) : state.speed_limit_kmh;
    return {
      scene: $("sceneSelect").value || "路口信号灯",
      lane: data.get("lane"), signal: data.get("signal"), lane_marking: data.get("lane_marking"),
      maneuver: data.get("maneuver"), turn_signal: data.get("turn_signal"),
      speed_kmh: Number(data.get("speed_kmh")),
      speed_limit_kmh: Number.isFinite(limit) ? Math.min(180, Math.max(10, Math.round(limit))) : state.speed_limit_kmh,
      moving: data.has("moving"), forced_change: $("consoleForce").checked, obstacle: data.has("obstacle"),
      signal_left: $("localSignalLeft").value, signal_straight: $("localSignalStraight").value,
      signal_right: $("localSignalRight").value,
      left_lane_marking: $("localLineLeft").value, right_lane_marking: $("localLineRight").value,
    };
  }
  function requestedRoadDirection() {
    if (requestedChange === "左转向灯") return "left";
    if (requestedChange === "右转向灯") return "right";
    const lane = form.elements.namedItem("lane").value;
    return lane === "左车道" ? "left" : lane === "右车道" ? "right" : "straight";
  }
  function selectedLaneManeuver() {
    const lane = form.elements.namedItem("lane").value;
    return lane === "左车道" ? "左转" : lane === "右车道" ? "右转" : "直行";
  }
  function syncChangeSelection() {
    const selected = requestedChange || "关闭";
    document.querySelectorAll("[data-change]").forEach((button) => button.classList.toggle("selected", button.dataset.change === selected));
  }
  function localDecisionInput() {
    const direction = requestedRoadDirection();
    const signal = state[`signal_${direction}`] || "未知";
    const laneMarking = requestedChange === "左转向灯" ? state.left_lane_marking
      : requestedChange === "右转向灯" ? state.right_lane_marking
        : state.lane_marking;
    return { ...state, signal, lane_marking: laneMarking,
      left_lane_marking: state.left_lane_marking, right_lane_marking: state.right_lane_marking };
  }
  function updateLocal() {
    Object.assign(state, readForm());
    renderDecision(window.AdasPolicy.decide(localDecisionInput()), "手动场景联调");
    updateRoadRecognition(null);
    $("speedMetric").innerHTML = `${state.speed_kmh}<em> km/h</em>`;
    $("speedDetail").textContent = `道路限速 ${state.speed_limit_kmh} km/h`;
    $("sourceNote").textContent = "决策输入来自手动联调。道路画面为示意图；导入素材后仅回放，不在浏览器内执行识别。";
    $("decisionSource").textContent = "手动场景联调";
    $("footerStatus").textContent = "本地联调可离线使用；实测指标由板端提供";
    $("connection").innerHTML = "<i></i> 本地联调";
    $("connection").style.color = "";
    $("sourceDetail").textContent = "等待板端实测";
    $("sourceMetric").innerHTML = "—<em> / 4</em>"; $("fpsMetric").innerHTML = "—<em> FPS</em>"; $("latencyMetric").innerHTML = "—<em> ms</em>";
    $("perceptionSource").textContent = "等待板端结果";
    $("driveControlState").textContent = state.moving ? "联调状态：行驶" : "联调状态：停车";
    setPerception(null);
  }
  function setNodeState(id, stateName, label) {
    const node = $(id);
    node.className = "node-state " + stateName;
    node.textContent = label;
  }
  function setNodeInfo(id, rows) {
    const node = $(id);
    node.replaceChildren();
    for (const [label, value] of rows) {
      const line = document.createElement("span");
      line.textContent = label + "：" + (value ?? "—");
      node.appendChild(line);
    }
  }
  function updateTerminalNodes(status, backendReachable = true) {
    renderWebRtcNode();

    const car = status?.wifi_car || {};
    const carState = car.online === true ? ["online", "已连接"]
      : ["connecting", "handshaking"].includes(car.state) ? ["pending", "连接中"]
        : car.desired && car.last_error ? ["offline", "连接异常"]
          : car.desired ? ["pending", "等待设备"] : ["offline", "未连接"];
    setNodeState("nodeCarState", carState[0], carState[1]);
    $("nodeCarDetail").textContent = "云端 WSS · " + (car.online ? "ESP32 已接入" : "等待 ESP32 主动接入");
    setNodeInfo("nodeCarInfo", [
      ["WSS 状态", car.state || "waiting_for_device"],
      ["云端主机", car.host || "adas.wmnnj.top:443"],
      ["最近回包", car.last_response || "—"],
      ["最近命令", car.last_command || "—"],
      ["异常", car.last_error || "无"],
    ]);
    $("carTestConnection").textContent = car.online ? "WSS 已连接" : carState[1];
    $("wifiCarConnect").disabled = car.online;
    $("wifiCarConnect").textContent = car.online ? "已连接" : "刷新连接状态";
    $("wifiCarDisconnect").disabled = !car.desired && !car.online;
    document.querySelectorAll("[data-car-action]").forEach((button) => {
      const unsupported = Array.isArray(car.supported_actions) && !car.supported_actions.includes(button.dataset.carAction);
      button.disabled = unsupported || !car.online || (commandBusy && button.dataset.carAction !== "stop");
    });
    $("commandTarget").textContent = car.online ? "WifiCar ESP32 · 云端 WSS" : "WifiCar ESP32 · 等待云端接入";
    $("driveControlState").textContent = car.online
      ? (form.elements.namedItem("moving").checked ? "WSS在线 · 联调状态：行驶" : "WSS在线 · 联调状态：停车")
      : "小车未连接";

    const backend = status?.backend || {};
    const resources = backend.resources || {};
    const cpu = resources.cpu?.usage_pct;
    const memory = resources.memory?.usage_pct;
    const backendOnline = backendReachable && backend.online !== false;
    setNodeState("nodeBackendState", backendOnline ? "online" : "offline", backendOnline ? "已连接" : "未连接");
    $("nodeBackendDetail").textContent = backendOnline
      ? "Node.js " + (backend.node_version || "") + " · CPU " + (typeof cpu === "number" && Number.isFinite(cpu) ? cpu.toFixed(1) + "%" : "—") + " · 内存 " + (typeof memory === "number" && Number.isFinite(memory) ? memory.toFixed(1) + "%" : "—")
      : "本机状态接口不可达";
    setNodeInfo("nodeBackendInfo", [
      ["服务", backend.service || "Node.js HTTP 后端"],
      ["主机", backend.hostname || "—"],
      ["监听端口", backend.listen_port || "—"],
      ["CPU / 内存", (typeof cpu === "number" && Number.isFinite(cpu) ? cpu.toFixed(1) + "%" : "—") + " / " + (typeof memory === "number" && Number.isFinite(memory) ? memory.toFixed(1) + "%" : "—")],
      ["Node 版本", backend.node_version || "—"],
    ]);
  }
  function renderWebRtcNode() {
    const vision = latestRkVision;
    const visionAge = Number(vision?.age_ms);
    const visionAvailable = vision?.ok === true;
    const visionOnline = visionAvailable && Number.isFinite(visionAge) && visionAge <= 10000;
    const commandReceived = latestRkCommandAt > 0;
    const online = visionOnline || commandReceived;
    setNodeState("nodeRkState", visionOnline || (!visionAvailable && commandReceived) ? "online" : visionAvailable ? "offline" : "pending",
      visionOnline ? "已收到字符遥测" : visionAvailable ? "遥测已过期" : commandReceived ? "已收到字符指令" : "等待遥测");
    if (visionAvailable) {
      const mode = vision.mode === "navigation" ? "导航" : vision.mode === "adas" ? "ADAS" : "未启用";
      $("nodeRkDetail").textContent = `${mode} · 帧 ${Number(vision.frame_sequence) || 0} · ${Array.isArray(vision.detections) ? vision.detections.length : 0} 个目标${visionOnline ? "" : ` · ${Math.ceil(visionAge / 1000)} 秒前`}`;
      setNodeInfo("nodeRkInfo", [
        ["模式", mode], ["帧号", Number(vision.frame_sequence) || 0],
        ["目标数", Array.isArray(vision.detections) ? vision.detections.length : 0],
        ["方向", vision.inferred_direction_name || "未选择"],
        ["判断", vision.decision_text || "—"],
        ["ESP32动作", vision.esp32_action || "无新动作"],
        ["最近字符指令", latestRkCommandText || "—"],
      ]);
    } else if (commandReceived) {
      $("nodeRkDetail").textContent = `已收到字符指令 · ${new Date(latestRkCommandAt).toLocaleString("zh-CN")}`;
      setNodeInfo("nodeRkInfo", [["最新遥测", "等待推理遥测"], ["最近字符指令", latestRkCommandText || "—"]]);
    } else {
      $("nodeRkDetail").textContent = "等待 RK 上报检测与方向数据";
      setNodeInfo("nodeRkInfo", [["状态", "尚未收到 RK 遥测"]]);
    }
  }

  function renderRkCommand(item) {
    const text = String(item?.display_text || item?.broadcast_text || item?.message || "").trim();
    if (!text) return;
    const id = String(item?.id || item?.event_id || `${item?.time_bj || ""}:${text}`);
    if (seenRkCommandIds.has(id)) return;
    seenRkCommandIds.add(id);
    if (seenRkCommandIds.size > 1000) seenRkCommandIds = new Set([...seenRkCommandIds].slice(-500));
    const timeText = String(item?.time_bj || item?.report_created_at || "未知时间");
    const container = $("rkCommandLog");
    container.querySelector(".rk-command-empty")?.remove();
    const row = document.createElement("article");
    row.className = "rk-command-item";
    const time = document.createElement("time"); time.className = "rk-command-time"; time.textContent = timeText;
    const message = document.createElement("div"); message.className = "rk-command-text"; message.textContent = text;
    const source = document.createElement("span"); source.className = "rk-command-source"; source.textContent = String(item?.rk_device_id || "RK3568");
    row.append(time, message, source); container.prepend(row);
    while (container.children.length > 100) container.lastElementChild.remove();
    const timestamp = Date.parse(timeText.replace(" ", "T") + (timeText.includes("T") || /[+-]\d\d:\d\d$/.test(timeText) ? "" : "+08:00"));
    latestRkCommandAt = Number.isFinite(timestamp) ? Math.max(latestRkCommandAt, timestamp) : Date.now();
    latestRkCommandText = text;
    $("rkCommandState").textContent = "已接收字符指令";
    renderWebRtcNode();
  }
  async function pollRkCommands() {
    const base = backendBaseAddress();
    if (!base) return;
    try {
      const response = await fetch(`${base}/api/rk/user-messages?limit=100&offset=0`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (payload?.ok !== true || !Array.isArray(payload.items)) throw new Error("RK 字符消息接口响应格式无效");
      for (const item of [...payload.items].reverse()) renderRkCommand(item);
      if (payload.items.length === 0 && latestRkCommandAt === 0) $("rkCommandState").textContent = "接口在线 · 暂无指令";
    } catch {
      if (latestRkCommandAt === 0) $("rkCommandState").textContent = "等待后端连接";
    }
  }
  function startRkCommandPolling() {
    if (rkCommandTimer) clearInterval(rkCommandTimer);
    pollRkCommands();
    rkCommandTimer = setInterval(pollRkCommands, 2000);
  }
  function renderWebRtcPerformance() {
    const rtc = latestWebRtcStatus;
    const connected = rtc.connectionState === "connected";
    const hasReceivedFrames = Number.isFinite(rtc.framesReceived) && rtc.framesReceived > 0;
    const receiving = connected && rtc.receivingNow === true;
    const value = (number, unit = "") => Number.isFinite(number) ? `${number.toFixed(1)}${unit}` : "—";
    const visionActive = latestRkVision?.inference_enabled === true && latestRkVision?.mode !== "off";
    $("performanceConnection").textContent = visionActive ? "RK 字符遥测在线" : receiving ? "WebRTC 正在收帧" : connected && hasReceivedFrames ? "已连接·当前无新帧" : connected ? "WebRTC 已连接·等待视频" : "等待 RK 遥测";
    $("perfMediaStatus").textContent = visionActive ? "视频未上传 · 遥测正常" : receiving ? "正在接收" : connected && hasReceivedFrames ? "当前无新帧" : connected ? "等待媒体帧" : "未连接";
    $("perfFrames").textContent = Number.isFinite(rtc.framesReceived) ? Math.round(rtc.framesReceived).toLocaleString("zh-CN") : "—";
    $("perfRxFps").textContent = value(rtc.fps, " FPS");
    $("perfResolution").textContent = rtc.width && rtc.height ? `${rtc.width} × ${rtc.height}` : "—";
    $("perfDecodeFps").textContent = value(rtc.decodeFps, " FPS");
    $("perfBitrate").textContent = Number.isFinite(rtc.bitrateKbps) ? (rtc.bitrateKbps >= 1000 ? `${(rtc.bitrateKbps / 1000).toFixed(2)} Mb/s` : `${Math.round(rtc.bitrateKbps)} kb/s`) : "—";
    $("perfRtt").textContent = value(rtc.rttMs, " ms");
    $("perfJitter").textContent = value(rtc.jitterMs, " ms");
    $("perfPacketsLost").textContent = Number.isFinite(rtc.packetsLost) ? Math.round(rtc.packetsLost).toLocaleString("zh-CN") : "—";
    $("perfDropped").textContent = Number.isFinite(rtc.framesDropped) ? Math.round(rtc.framesDropped).toLocaleString("zh-CN") : "—";
    $("perfFreezes").textContent = Number.isFinite(rtc.freezeCount) ? Math.round(rtc.freezeCount).toLocaleString("zh-CN") : "—";
    const visionFps = Number(latestRkVision?.inference_fps);
    $("perfInferFps").textContent = latestRkVision?.inference_enabled === true && Number.isFinite(visionFps)
      ? `${visionFps.toFixed(2)} FPS` : latestRkVision?.mode === "off" ? "模型未启用" : "等待 RK 上报";
    drawTimingPie(latestStatus || {}, latestRkVision);
    drawPerformanceCharts(latestPerformanceSample);
  }
  function renderRkVision(payload) {
    latestRkVision = payload?.ok === true ? payload : null;
    if (!latestRkVision) {
      latestRkVisionFrameSequence = null;
      $("rkVisionState").textContent = "未连接";
      $("rkVisionMode").textContent = "—";
      $("rkVisionDirection").textContent = "—";
      $("rkVisionSafety").textContent = "—";
      $("rkVisionAction").textContent = "—";
      $("rkVisionLatency").textContent = "—";
      $("rkVisionDetections").textContent = "—";
      $("rkVisionDecision").textContent = "等待 RK 推理数据";
      $("rkVisionUpdated").textContent = "等待 RK 上报";
      $("rkCameraRows").innerHTML = '<tr><td colspan="3">等待上报</td></tr>';
      $("rkDetectionRows").innerHTML = '<tr><td colspan="3">等待上报</td></tr>';
      $("perfInferFps").textContent = "等待 RK 上报";
      renderWebRtcNode();
      drawTimingPie({}, null);
      drawPerformanceCharts(latestPerformanceSample);
      return;
    }

    const ageMs = Number(payload.age_ms);
    const stale = Number.isFinite(ageMs) && ageMs > 10000;
    const active = payload.inference_enabled === true && payload.mode !== "off";
    const directionNames = { 0: "直行", 1: "左转", 2: "右转", 3: "停车", 4: "左变道", 5: "右变道" };
    const modeNames = { adas: "ADAS", navigation: "导航", off: "未启用" };
    const actionNames = { straight: "直行", left: "左转", right: "右转", stop: "停车", lane_left: "左变道", lane_right: "右变道", uturn: "掉头", alarm: "报警" };
    const safetyNames = { allowed: "允许通行", slow: "减速", forbidden: "禁止", alarm: "报警停车" };
    const mode = String(payload.mode || "off");
    const direction = Number(payload.inferred_direction);
    const latency = Number(payload.inference_ms);
    const fps = Number(payload.inference_fps);
    const detections = Array.isArray(payload.detections) ? payload.detections : [];
    const cameras = Array.isArray(payload.per_camera) ? payload.per_camera : [];
    const visionFps = Number(payload.inference_fps);
    const frameSequence = Number(payload.frame_sequence);
    if (Number.isFinite(visionFps) && (Number.isFinite(frameSequence) ? frameSequence !== latestRkVisionFrameSequence : true)) {
      performanceSamples.push({ fps: visionFps, decodeFps: null, at: Date.now() });
      if (performanceSamples.length > 60) performanceSamples.splice(0, performanceSamples.length - 60);
      latestRkVisionFrameSequence = Number.isFinite(frameSequence) ? frameSequence : null;
    }
    $("rkVisionState").textContent = stale ? "数据超时" : active ? "推理中" : "模型未启用";
    $("rkVisionMode").textContent = modeNames[mode] || mode;
    $("rkVisionDirection").textContent = directionNames[direction] || payload.inferred_direction_name || "未确定";
    $("rkVisionSafety").textContent = payload.alarm ? "报警停车" : payload.forbidden ? "禁止" : payload.slow ? "减速" : safetyNames[payload.safety_state] || "允许通行";
    const command = payload.esp32_command || null;
    const commandStateNames = { sending: "等待回执", done: "已确认", failed: "未执行" };
    const actionLabel = payload.esp32_action ? (actionNames[payload.esp32_action] || payload.esp32_action) : "无新动作";
    const commandState = commandStateNames[command?.state] || "未发送";
    const commandError = command?.state === "failed" ? ` · ${command.error || "ESP32 控制失败"}` : "";
    $("rkVisionAction").textContent = `${actionLabel} · ${commandState}${commandError}`;
    $("rkVisionLatency").textContent = Number.isFinite(latency) ? `${latency.toFixed(1)} ms${Number.isFinite(fps) ? ` · ${fps.toFixed(2)} FPS` : ""}` : "—";
    $("rkVisionDetections").textContent = `${detections.length} 个目标`;
    $("rkVisionDecision").textContent = String(payload.decision_text || "无判断文本");
    $("rkVisionUpdated").textContent = stale ? `最后上报 ${Math.ceil(ageMs / 1000)} 秒前` : `帧 ${Number(payload.frame_sequence) || 0} · ${payload.time_bj || "刚刚"}`;
    $("perfInferFps").textContent = active && Number.isFinite(fps) ? `${fps.toFixed(2)} FPS` : "模型未启用";

    const cameraNames = { front: "前路", rear: "后路", left: "左路", right: "右路" };
    $("rkCameraRows").innerHTML = cameras.length ? cameras.map((item) => {
      const name = cameraNames[item.camera] || item.camera || `第${item.source}路`;
      const ms = Number(item.inference_ms);
      const count = Number(item.detection_count);
      return `<tr><td>${escapeHtml(name)}</td><td>${Number.isFinite(ms) ? `${ms.toFixed(1)} ms` : "—"}</td><td>${Number.isFinite(count) ? Math.round(count) : 0}</td></tr>`;
    }).join("") : '<tr><td colspan="3">暂无四路推理指标</td></tr>';
    $("rkDetectionRows").innerHTML = detections.length ? detections.slice(0, 50).map((item) => {
      const name = cameraNames[{ 1: "front", 2: "rear", 3: "left", 4: "right" }[Number(item.source)]] || `第${item.source}路`;
      const confidence = Number(item.confidence);
      return `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(item.class_name || "未知类别")}</td><td>${Number.isFinite(confidence) ? `${(confidence * 100).toFixed(1)}%` : "—"}</td></tr>`;
    }).join("") : '<tr><td colspan="3">当前帧无检测目标</td></tr>';
    renderWebRtcNode();
    drawTimingPie({}, payload);
    drawPerformanceCharts(latestPerformanceSample);
  }
  async function pollRkVision() {
    const base = backendBaseAddress();
    if (!base) return renderRkVision(null);
    try {
      const response = await fetch(`${base}/api/rk/realtime/vision/latest`, { cache: "no-store", signal: AbortSignal.timeout(4000) });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true) return renderRkVision(null);
      renderRkVision(payload);
      renderWebRtcPerformance();
    } catch {
      if (!latestRkVision || Number(latestRkVision.age_ms) > 10000) renderRkVision(null);
    }
  }
  $("performanceWhepConnect")?.remove();
  $("whepConnect")?.remove();
  $("whepDisconnect")?.remove();
  function applyFusionSettings() {
    const fields = $("fusionSettings").elements;
    try {
      if (!fusionController) throw new Error("融合模块加载失败");
      fusionController.configure({
        layout: ["front", "right", "rear", "left"].map((key) => Number(fields.namedItem(key).value)),
        ...Object.fromEntries(["fov", "pitchDown", "nearRow", "farRow"].map((key) => [key, Number(fields.namedItem(key).value)])),
      });
      $("fusionParameterState").textContent = "已应用 · 未标定";
    } catch { $("fusionParameterState").textContent = "参数无效：四路不可重复，内缘采样须大于外缘"; }
  }
  $("fusionSettings")?.addEventListener("submit", (event) => { event.preventDefault(); applyFusionSettings(); });
  $("fusionSettings")?.addEventListener("reset", () => setTimeout(applyFusionSettings, 0));

  function renderCameraStreamState() {
    const rtc = latestWebRtcStatus;
    const connected = rtc.connectionState === "connected";
    const receiving = connected && rtc.receivingNow === true;
    $("cameraStreamState").textContent = receiving ? "正在收帧" : connected ? "示意画面 · 等待新帧" : rtc.connectionState === "connecting" ? "示意画面 · 连接中" : "示意画面 · 未连接";
    $("cameraConnect").disabled = connected || rtc.connectionState === "connecting";
    $("cameraDisconnect").disabled = !connected && rtc.connectionState !== "connecting";
    cameras.forEach((camera) => {
      camera.dataset.streamState = receiving ? "live" : "waiting";
      camera.dataset.streamMessage = connected ? "等待新帧" : "等待视频连接";
    });
  }
  function clearCameraFrames() {
    stopCameraFrames();
    lastCameraVideoTime = -1;
    if (currentPage === "single-test") showCameraPlaceholders(true);
  }
  function showCameraPlaceholders(force = false) {
    cameras.forEach((camera) => {
      const canvas = camera.querySelector("canvas");
      canvas.hidden = false;
      camera.querySelector("img").hidden = true;
      camera.querySelector("video").hidden = true;
      if (force || canvas.dataset.frameMode !== "placeholder") drawDemo(canvas, Number(camera.dataset.camera), null);
      canvas.dataset.frameMode = "placeholder";
      delete canvas.dataset.liveFrame;
    });
  }
  function drawCameraFrames(forcePlaceholder = false) {
    if (currentPage !== "single-test") return;
    const source = $("webrtcVideo");
    cameras.forEach((camera) => {
      camera.querySelector("canvas").hidden = false;
      camera.querySelector("img").hidden = true;
      camera.querySelector("video").hidden = true;
    });
    if (!source.srcObject || source.readyState < 2 || !source.videoWidth || !source.videoHeight
      || latestWebRtcStatus.connectionState !== "connected" || latestWebRtcStatus.receivingNow !== true) {
      showCameraPlaceholders(forcePlaceholder);
      return;
    }
    const halfWidth = Math.floor(source.videoWidth / 2), halfHeight = Math.floor(source.videoHeight / 2);
    cameraRenderSequence += 1;
    cameras.forEach((camera, index) => {
      const canvas = camera.querySelector("canvas");
      const x = index % 2 ? halfWidth : 0, y = index > 1 ? halfHeight : 0;
      const width = index % 2 ? source.videoWidth - halfWidth : halfWidth;
      const height = index > 1 ? source.videoHeight - halfHeight : halfHeight;
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const context = canvas.getContext("2d");
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(source, x, y, width, height, 0, 0, width, height);
      canvas.dataset.frameMode = "live";
      canvas.dataset.liveFrame = String(cameraRenderSequence);
    });
  }
  function stopCameraFrames() {
    if (cameraAnimationMode === "video") $("webrtcVideo").cancelVideoFrameCallback?.(cameraAnimation);
    else if (cameraAnimation) cancelAnimationFrame(cameraAnimation);
    cameraAnimation = 0;
    cameraAnimationMode = "";
  }
  function startCameraFrames() {
    const source = $("webrtcVideo");
    if (cameraAnimation || currentPage !== "single-test" || !source.srcObject) return;
    const tick = () => {
      cameraAnimation = 0;
      if (currentPage !== "single-test" || !source.srcObject) return;
      if (source.currentTime !== lastCameraVideoTime) {
        lastCameraVideoTime = source.currentTime;
        drawCameraFrames();
      }
      startCameraFrames();
    };
    cameraAnimationMode = typeof source.requestVideoFrameCallback === "function" ? "video" : "animation";
    cameraAnimation = cameraAnimationMode === "video" ? source.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  }
  function renderDecision(result, source) {
    latestDecision = result;
    $("action").textContent = decisionActionLabel(result);
    $("arrow").textContent = result.maneuver === "停车" ? "■"
      : result.turn_signal === "左转向灯" ? "↖"
        : result.turn_signal === "右转向灯" ? "↗"
          : result.maneuver === "左转" ? "←" : result.maneuver === "右转" ? "→" : result.maneuver === "直行" ? "↑" : "—";
    $("reason").textContent = result.reason || "板端决策回报";
    const pill = $("decisionPill");
    pill.className = `pill ${result.alarm ? "red" : "green"}`;
    pill.textContent = result.alarm ? "需关注" : "正常";
    const alarm = $("alarm");
    alarm.className = `alarm ${result.alarm ? "warning" : ""}`;
    alarm.textContent = result.alarm ? `⚠ ${result.alarm_text || result.alarms?.join("；") || "驾驶风险"}` : "当前无报警";
    const executable = !result.alarm && ["左转", "直行", "右转", "停车"].includes(result.maneuver);
    $("executionState").textContent = executable ? "可执行" : "不可执行";
    $("executionState").className = executable ? "ok" : "blocked";
    $("executionReason").textContent = executable ? "当前场景规则允许执行规划动作" : (result.alarm_text || "感知或规则约束未满足，动作不会下发");
    $("commandAction").textContent = decisionActionLabel(result);
    $("commandHint").textContent = autoExecuteEnabled
      ? "自动执行已开启 · 连接小车后会按实时决策下发；风险状态将停车。"
      : executable ? "动作已通过当前场景规则；连接 WifiCar ESP32 后可直接下发。" : "当前动作未通过规则检查，发送按钮已锁定。";
    $("sendCommand").textContent = autoExecuteEnabled ? "自动执行中" : "发送当前决策";
    $("sendCommand").disabled = !executable || commandBusy || autoExecuteEnabled;
    $("trafficLight").className = `light ${result.signal === "红灯" ? "red" : result.signal === "绿灯" ? "green" : result.signal === "黄灯" ? "yellow" : ""}`;
    $("signalText").textContent = result.signal || "未知";
    $("laneText").textContent = `${result.lane || "—"} · ${result.lane_marking || "—"}`;
    $("decisionSource").textContent = source;
    drawBirdView(result);
    addEvent(result, source);
    maybeAutoExecute(result);
  }
  function decisionActionLabel(result) {
    if (result?.maneuver === "停车") return "停车";
    if (result?.turn_signal === "左转向灯") return result.alarm ? "向左变道（受限）" : "向左变道";
    if (result?.turn_signal === "右转向灯") return result.alarm ? "向右变道（受限）" : "向右变道";
    return result?.maneuver || "—";
  }
  function drawBirdView(result) {
    const canvas = $("birdView");
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (!rect.width || !rect.height) return;
    canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext("2d"); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const w = rect.width, h = rect.height;
    ctx.fillStyle = "#0c151d"; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = color.road; ctx.beginPath(); ctx.moveTo(w * .4, 0); ctx.lineTo(w * .6, 0); ctx.lineTo(w * .82, h); ctx.lineTo(w * .18, h); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = color.edge; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(w * .4, 0); ctx.lineTo(w * .18, h); ctx.moveTo(w * .6, 0); ctx.lineTo(w * .82, h); ctx.stroke();
    ctx.strokeStyle = result.lane_marking === "实线" ? color.yellow : color.dash; ctx.setLineDash(result.lane_marking === "实线" ? [] : [10, 11]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(w * .5, 0); ctx.lineTo(w * .5, h); ctx.stroke(); ctx.setLineDash([]);
    if (result.scene === "路口信号灯") {
      ctx.strokeStyle = "#d3dbd6"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(w * .27, h * .23); ctx.lineTo(w * .73, h * .23); ctx.stroke();
      for (let i = 0; i < 6; i++) { ctx.fillStyle = "#d9dfd8"; ctx.fillRect(w * (.3 + i * .07), h * .2, 8, 7); }
    }
    if (result.obstacle) { ctx.fillStyle = color.red; ctx.beginPath(); ctx.arc(w * .5, h * .34, 8, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = result.alarm ? color.red : color.cyan; ctx.beginPath(); ctx.moveTo(w * .5, h * .77); ctx.lineTo(w * .44, h * .91); ctx.lineTo(w * .56, h * .91); ctx.closePath(); ctx.fill();
    const move = result.maneuver;
    const laneChangeDirection = result.turn_signal === "左转向灯" ? -1 : result.turn_signal === "右转向灯" ? 1 : 0;
    ctx.strokeStyle = result.alarm ? color.red : color.cyan;
    ctx.lineWidth = 3; ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (move === "停车") {
      ctx.beginPath(); ctx.moveTo(w * .43, h * .48); ctx.lineTo(w * .57, h * .48); ctx.stroke();
    } else if (laneChangeDirection) {
      // Shift into the adjacent lane, then continue forward without a turn arrow.
      const targetX = .5 + laneChangeDirection * .13;
      ctx.beginPath();
      ctx.moveTo(w * .5, h * .74);
      ctx.bezierCurveTo(w * .5, h * .64, w * targetX, h * .64, w * targetX, h * .53);
      ctx.lineTo(w * targetX, h * .34);
      ctx.stroke();
    } else if (move === "左转" || move === "右转") {
      const targetX = move === "左转" ? .37 : .63;
      const startX = w * .5, startY = h * .47, endX = w * targetX, endY = h * .38;
      ctx.beginPath(); ctx.moveTo(w * .5, h * .72); ctx.lineTo(startX, startY); ctx.lineTo(endX, endY); ctx.stroke();
      drawArrowHead(ctx, startX, startY, endX, endY);
    } else if (move === "直行") {
      ctx.beginPath(); ctx.moveTo(w * .5, h * .72); ctx.lineTo(w * .5, h * .34); ctx.stroke();
    }
  }
  function drawArrowHead(ctx, fromX, fromY, tipX, tipY) {
    const angle = Math.atan2(tipY - fromY, tipX - fromX);
    const length = 10, spread = Math.PI / 6;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - length * Math.cos(angle - spread), tipY - length * Math.sin(angle - spread));
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - length * Math.cos(angle + spread), tipY - length * Math.sin(angle + spread));
    ctx.stroke();
  }
  function setPerception(adas) {
    const counts = adas?.perception?.counts || {};
    const pairs = [["斑马线", "zebra"], ["行人", "person"], ["红灯", "red"], ["绿灯", "green"], ["黄灯", "yellow"]];
    $("perception").innerHTML = pairs.map(([label, key]) => `<div>${label}<strong>${Number.isInteger(counts[key]) ? counts[key] : "—"}</strong></div>`).join("");
    if (adas?.perception?.source) {
      $("perceptionSource").textContent = `实测 · ${adas.perception.model || "环境模型"}`;
    } else if (adas) $("perceptionSource").textContent = "板端未上报模型结果";
  }
  function updateRoadRecognition(adas) {
    const setSignal = (id, value) => {
      const el = $(id); const text = value && value !== "未知" ? value : "未知";
      el.textContent = text;
      el.className = text === "红灯" ? "signal-red" : text === "绿灯" ? "signal-green" : text === "黄灯" ? "signal-yellow" : "signal-neutral";
    };
    if (mode === "local") {
      setSignal("signalLeft", state.signal_left);
      setSignal("signalStraight", state.signal_straight);
      setSignal("signalRight", state.signal_right);
      $("obstacleState").textContent = state.obstacle ? "有" : "无";
      $("lineLeft").textContent = state.left_lane_marking || "未知";
      $("lineRight").textContent = state.right_lane_marking || "未知";
      $("recognizedSpeedLimit").textContent = `${state.speed_limit_kmh || 40} km/h · 人工设置`;
      $("recognitionSource").textContent = "本地联调 · 人工设置识别结果";
      return;
    }
    const road = adas?.perception?.road_state;
    const signals = road?.signals || {};
    const show = (value) => value && value !== "未知" ? value : "未上报";
    setSignal("signalLeft", signals.left);
    setSignal("signalStraight", signals.straight);
    setSignal("signalRight", signals.right);
    $("obstacleState").textContent = typeof road?.obstacle === "boolean" ? (road.obstacle ? "有" : "无") : "未上报";
    $("lineLeft").textContent = show(road?.lane_markings?.left);
    $("lineRight").textContent = show(road?.lane_markings?.right);
    const recognized = Number.isInteger(road?.speed_limit_kmh) && road.speed_limit_kmh > 0 ? `${road.speed_limit_kmh} km/h · 识别` : "";
    $("recognizedSpeedLimit").textContent = recognized || `${$("consoleSpeedLimit").value || 40} km/h · 驾驶台设定`;
    $("recognitionSource").textContent = road ? `RK3568 YOLO · ${adas?.perception?.model || "环境模型"}` : adas?.perception?.source ? "板端模型有目标计数，未上报道路结构化字段" : "等待 RK3568 道路结构化识别字段";
  }
  function showPerformance(status) {
    drawTimingPie(status || {});
    renderWebRtcPerformance();
  }
  function stopPerformancePolling() {
    performanceGeneration++;
    if (performanceTimer) clearInterval(performanceTimer);
    performanceTimer = null;
  }
  function backendBaseAddress() {
    return $("backendBase").value.trim().replace(/\/+$/, "") || (location.protocol.startsWith("http") ? location.origin : "");
  }
  function selectedDataSource() {
    return $("dataSource")?.value === "rk" ? "rk" : "relay";
  }
  function syncDataSourceControls() {
    const relay = selectedDataSource() === "relay";
    $("rkHostLabel").hidden = relay;
    $("connect").textContent = relay ? "公网视频由 WHEP 播放器连接" : "连接局域网 RK 状态";
    $("dataSourceHint").textContent = relay
      ? "实时画面使用上方 WHEP 播放器直连云端；只读账号仅在播放器连接时使用，不保存到浏览器。"
      : "局域网模式由本机后端直接访问 RK3568；电脑需与板端处于可互通网络。";
  }
  async function fetchTerminalStatusSnapshot() {
    const base = backendBaseAddress();
    if (!base) return { status: latestStatus || {}, backendReachable: false };
    const source = selectedDataSource();
    const host = String($("rkHost")?.value || "192.168.100.105").trim();
    const statusRequest = fetch(`${base}/api/status`, { cache: "no-store", signal: AbortSignal.timeout(5000) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
    const pingUrl = `${base}/api/rk/ping?host=${encodeURIComponent(host)}&port=3000&timeout_ms=3000`;
    const pingRequest = source === "rk" ? fetch(pingUrl, { cache: "no-store", signal: AbortSignal.timeout(10000) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }) : Promise.resolve(null);
    const [statusResult, pingResult] = await Promise.allSettled([statusRequest, pingRequest]);
    const statusOk = statusResult.status === "fulfilled" && statusResult.value && typeof statusResult.value === "object";
    const pingOk = source === "rk" && pingResult.status === "fulfilled"
      && pingResult.value?.rk_ok === true && pingResult.value?.rk?.ok === true;
    if (statusOk) latestReportedStatus = statusResult.value;
    let status = statusOk ? statusResult.value : { ...(latestReportedStatus || latestStatus || {}) };
    if (source === "rk" && pingResult.status === "fulfilled") latestRkPing = pingResult.value;
    // The local RK HTTP health check supplements status telemetry. Cloud video
    // is a separate WHEP media session and never uses the JPEG snapshot proxy.
    if (source === "rk" && pingResult.status === "fulfilled") {
      status = {
        ...status,
        rk_online: pingOk,
        rk_http_online: pingOk,
        rk_api_listening: pingOk,
        rk_host: source === "relay" ? "47.113.231.233" : host,
        rk_port: source === "relay" ? 443 : 3000,
        rk_http_source: source,
        input_mode: pingOk ? (source === "relay" ? "https" : "http") : status.input_mode,
        view: pingOk ? "webrtc" : status.view,
        capture_running: pingOk ? true : status.capture_running,
      };
    }
    return { status, backendReachable: statusOk || (source === "rk" && pingResult.status === "fulfilled") };
  }
  function stopTerminalPolling() {
    terminalGeneration++;
    if (terminalTimer) clearInterval(terminalTimer);
    terminalTimer = null;
  }
  function startTerminalPolling() {
    stopTerminalPolling();
    if (mode !== "local" || currentPage === "performance") return;
    const generation = terminalGeneration;
    const poll = async () => {
      try {
        const result = await fetchTerminalStatusSnapshot();
        if (generation !== terminalGeneration || mode !== "local") return;
        latestStatus = result.status;
        updateTerminalNodes(result.status, result.backendReachable);
        if (autoExecuteEnabled) maybeAutoExecute(latestDecision);
      } catch {
        if (generation === terminalGeneration) updateTerminalNodes(latestStatus || {}, false);
      }
    };
    poll();
    terminalTimer = setInterval(poll, 2500);
  }
  async function refreshTerminalStatus() {
    try {
      const result = await fetchTerminalStatusSnapshot();
      latestStatus = result.status;
      if (mode === "live") applyLiveStatus(result.status); else { updateTerminalNodes(result.status, result.backendReachable); if (autoExecuteEnabled) maybeAutoExecute(latestDecision); }
    } catch {
      updateTerminalNodes(latestStatus || {}, false);
    }
  }
  function startPerformancePolling() {
    stopPerformancePolling();
    if (mode === "live") return;
    const generation = performanceGeneration;
    const poll = async () => {
      const base = $("backendBase").value.trim().replace(/\/+$/, "") || location.origin;
      try {
        pollRkVision();
        const result = await fetchTerminalStatusSnapshot();
        const status = result.status;
        if (generation !== performanceGeneration || currentPage !== "performance") return;
        latestStatus = status;
        updateTerminalNodes(status, result.backendReachable);
        showPerformance(status);
      } catch {
        if (generation === performanceGeneration && currentPage === "performance") {
          // A slow status request must not turn a known-good board into an
          // offline indication. The backend owns the freshness decision;
          // retain the last successful snapshot until a newer one arrives.
          const last = latestStatus && latestStatus.rk_online === true
            ? { ...latestStatus, rk_status_request_pending: true }
            : { rk_online: false };
          updateTerminalNodes(latestStatus || last, false);
          showPerformance(last);
        }
      }
    };
    poll();
    pollRkVision();
    performanceTimer = setInterval(poll, 2000);
  }
  function drawPerformanceCharts(sample) {
    latestPerformanceSample = sample;
    const line = $("performanceLine");
    if (!line || !line.getBoundingClientRect().width) return;
    const resizeCanvas = (canvas, minHeight = 220) => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = rect.width || 1;
      const height = rect.height || minHeight;
      const pixelWidth = Math.max(1, Math.round(width * ratio));
      const pixelHeight = Math.max(1, Math.round(height * ratio));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth; canvas.height = pixelHeight;
      }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
      return { ctx, width, height };
    };
    const lineBox = resizeCanvas(line, 230);
    const lctx = lineBox.ctx, lw = lineBox.width, lh = lineBox.height;
    lctx.clearRect(0, 0, lw, lh);
    const pad = { left: 38, right: 15, top: 15, bottom: 28 }, chartW = lw - pad.left - pad.right, chartH = lh - pad.top - pad.bottom;
    lctx.strokeStyle = "#263845"; lctx.lineWidth = 1; lctx.font = "10px Segoe UI"; lctx.fillStyle = color.muted; lctx.textAlign = "right";
    const samples = performanceSamples.filter((item) => Number.isFinite(item.fps));
    const maxValue = Math.max(10, ...samples.map((item) => item.fps));
    for (let i = 0; i <= 4; i++) { const y = pad.top + chartH * i / 4; lctx.beginPath(); lctx.moveTo(pad.left, y); lctx.lineTo(lw - pad.right, y); lctx.stroke(); lctx.fillText(`${Math.round(maxValue * (4 - i) / 4)}`, pad.left - 7, y + 3); }
    [["fps", "#68d7df"]].forEach(([key, stroke]) => {
      let drawing = false;
      lctx.strokeStyle = stroke; lctx.fillStyle = stroke; lctx.lineWidth = 2; lctx.beginPath();
      samples.forEach((item, index) => {
        if (!Number.isFinite(item[key])) { drawing = false; return; }
        const x = pad.left + chartW * (samples.length <= 1 ? .5 : index / (samples.length - 1));
        const y = pad.top + chartH * (1 - Math.max(0, item[key]) / maxValue);
        if (drawing) lctx.lineTo(x, y); else lctx.moveTo(x, y);
        drawing = true;
        if (samples.length === 1) lctx.fillRect(x - 2, y - 2, 4, 4);
      });
      lctx.stroke();
    });
    $("perfSampleCount").textContent = `${samples.length} 样本`;
  }
  function drawTimingPie(status, vision = null) {
    const canvas = $("performancePie"), legend = $("perfTimingLegend");
    if (!canvas || !legend) return;
    const cameraNames = { front: "前路", rear: "后路", left: "左路", right: "右路" };
    const cameraColors = { front: "#68d7df", rear: "#5c9ee8", left: "#73d7a4", right: "#e7b65e" };
    const order = ["front", "rear", "left", "right"];
    const cameraMetrics = new Map((Array.isArray(vision?.per_camera) ? vision.per_camera : [])
      .map((item, index) => [item.camera || order[index], item]));
    const stages = order.map((camera) => ({
      name: cameraNames[camera],
      value: Number(cameraMetrics.get(camera)?.inference_ms),
      color: cameraColors[camera],
    })).filter((item) => Number.isFinite(item.value) && item.value >= 0);
    const total = stages.reduce((sum, item) => sum + item.value, 0);
    const hasMeasurements = stages.some((item) => item.value > 0);
    $("perfTimingState").textContent = hasMeasurements ? `四路实测 · ${stages.length} 路` : "等待四路耗时";
    $("perfTimingTotal").textContent = hasMeasurements ? total.toFixed(1) : "—";
    if (!hasMeasurements || !canvas.getBoundingClientRect().width) {
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      legend.innerHTML = "<span>等待 RK 上报四路推理耗时</span>";
      return;
    }
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const x = rect.width / 2, y = rect.height / 2, radius = Math.min(rect.width, rect.height) * .42;
    let angle = -Math.PI / 2;
    stages.forEach((item) => {
      if (item.value <= 0) return;
      const next = angle + item.value / total * Math.PI * 2;
      ctx.beginPath(); ctx.arc(x, y, radius, angle, next); ctx.strokeStyle = item.color;
      ctx.lineWidth = Math.max(10, radius * .28); ctx.lineCap = "butt"; ctx.stroke(); angle = next;
    });
    legend.innerHTML = stages.map((item) => {
      const percent = total > 0 ? item.value / total * 100 : 0;
      return `<div><i style="background:${item.color}"></i><b>${escapeHtml(item.name)}</b><span>${item.value.toFixed(2)} ms · ${percent.toFixed(1)}%</span></div>`;
    }).join("");
  }
  let chartResizeFrame = 0;
  const scheduleChartResize = () => {
    if (chartResizeFrame || currentPage !== "performance") return;
    chartResizeFrame = requestAnimationFrame(() => {
      chartResizeFrame = 0;
      drawPerformanceCharts(latestPerformanceSample);
    });
  };
  window.addEventListener("resize", scheduleChartResize);
  if (typeof ResizeObserver !== "undefined") {
    const chartObserver = new ResizeObserver(scheduleChartResize);
    document.querySelectorAll("#performanceLine,#performancePie").forEach((element) => chartObserver.observe(element));
  }
  function setBoardFrameStatus(status) {
    if (currentPage === "single-test") { drawCameraFrames(); return; }
    cameras.forEach((camera, index) => {
      const image = camera.querySelector("img");
      const video = camera.querySelector("video");
      const canvas = camera.querySelector("canvas");
      image.hidden = camera.dataset.mediaType !== "image";
      video.hidden = camera.dataset.mediaType !== "video";
      canvas.hidden = Boolean(camera.dataset.mediaType);
      if (!camera.dataset.mediaType) drawDemo(canvas, index, null);
    });
    const boardOnline = mode === "live" && status?.rk_online === true;
    $("mediaStatus").textContent = boardOnline
      ? "实时视频请使用上方 WebRTC 播放器；本区域为四向示意，不轮询截图或绘制检测框"
      : "可导入本地道路素材回放；板端实时视频使用上方 WebRTC 播放器";
    $("fusionFrameInfo").textContent = "无截图轮询";
    return;
  }
  function setPage(page) {
    if (currentPage === "single-test" || currentPage === "sim-test") saveScenarioState();
    if (page === "single-test" || page === "sim-test") {
      if (page !== activeScenario) loadScenarioState(page);
      activeScenario = page;
      const targetMode = scenarioModes[page] || "local";
      if (targetMode !== mode) setMode(targetMode);
    }
    currentPage = page;
    if (page === "performance") { stopTerminalPolling(); startPerformancePolling(); }
    else { stopPerformancePolling(); if (mode === "local") startTerminalPolling(); else stopTerminalPolling(); }
    document.body.dataset.activePage = page;
    const dashboard = page === "single-test" || page === "sim-test";
    $("dashboardPage").hidden = !dashboard;
    $("performancePage").hidden = page !== "performance";
    $("fusionPage").hidden = page !== "fusion";
    $("detectionsPage").hidden = page !== "detections";
    $("deploymentPage").hidden = page !== "deployment";
    $("communicationPage").hidden = page !== "communication";
    window.dispatchEvent(new CustomEvent("adas-page-change", { detail: page }));
    fusionController?.setVisible(page === "fusion");
    $("terminalPanel").hidden = page === "single-test" || page === "fusion" || page === "detections" || page === "deployment" || page === "communication";
    webrtcPanel.hidden = page === "single-test" || page === "fusion" || page === "detections" || page === "deployment" || page === "communication";
    $("scenarioResults").hidden = page !== "sim-test";
    document.querySelectorAll("[data-page]").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
    if (page === "single-test") { $("sceneTitle").textContent = "单一驾驶行为决策 · 测试 1 / 2 / 4"; $("sourceNote").textContent = "单项动作测试沿用驾驶台识别输入；强制执行遇到规则警报时，小车停车并报警。"; }
    else if (page === "sim-test") { $("sceneTitle").textContent = "模拟智驾功能 · 测试 3"; $("sourceNote").textContent = "综合模拟驾驶测试：同时评估信号灯、车道、障碍物和速度约束。"; }
    else if (page === "dashboard") { $("sceneTitle").textContent = sceneTitle(state.scene); }
    if (page === "performance") showPerformance(latestStatus || {});
    else if (dashboard) updateLocal();
    if (page === "single-test") { renderCameraStreamState(); drawCameraFrames(); startCameraFrames(); }
    else { stopCameraFrames(); setBoardFrameStatus(latestStatus || {}); }
    requestAnimationFrame(() => { drawAllDemos(); drawFusion(); if (latestDecision) drawBirdView(latestDecision); });
  }
  function addEvent(result, source) {
    const signature = [source, result.scene, result.lane, result.signal, result.lane_marking, result.maneuver, result.alarm_text, result.moving, result.speed_kmh, result.turn_signal].join("|");
    if (eventLog.at(-1)?.signature === signature) return;
    eventLog.push({ time: nowText(), source, scene: result.scene || "—", action: result.maneuver || "—", alarm: result.alarm_text || "正常", signature });
    eventLog = eventLog.slice(-300);
    $("events").innerHTML = eventLog.slice(-30).reverse().map((event) => `<tr><td>${escapeHtml(event.time)}</td><td>${escapeHtml(event.source)} · ${escapeHtml(event.scene)}</td><td>${escapeHtml(event.action)}</td><td class="${event.alarm === "正常" ? "" : "bad"}">${escapeHtml(event.alarm)}</td></tr>`).join("");
  }
  function sceneTitle(scene) {
    return scene === "路口信号灯" ? "十字路口辅助驾驶" : scene === "道路变道" ? "车道变换辅助驾驶" : scene === "行人/障碍物" ? "行人避障与碰撞提醒" : "导航 / 夜间道路演示";
  }
  function switchScene(scene) {
    document.querySelectorAll(".scene").forEach((button) => button.classList.toggle("active", button.dataset.scene === scene));
    $("sceneSelect").value = scene;
    $("sceneTitle").textContent = sceneTitle(scene);
    updateLocal();
  }
  function saveScenarioState() {
    if (!scenarioStates[activeScenario]) return;
    Object.assign(scenarioStates[activeScenario], state, { _requestedChange: requestedChange });
    scenarioModes[activeScenario] = mode;
    scenarioAutoExecute[activeScenario] = autoExecuteEnabled;
  }
  function loadScenarioState(page) {
    const next = scenarioStates[page];
    if (!next) return;
    Object.assign(state, next);
    requestedChange = next._requestedChange || "";
    setFormValue("lane", state.lane);
    setFormValue("signal", state.signal);
    setFormValue("lane_marking", state.lane_marking);
    setFormValue("maneuver", state.maneuver);
    setFormValue("turn_signal", state.turn_signal);
    setFormValue("speed_limit_kmh", state.speed_limit_kmh);
    setFormValue("speed_kmh", state.speed_kmh);
    setFormValue("moving", state.moving);
    setFormValue("obstacle", state.obstacle);
    setFormValue("forced_change", state.forced_change);
    $("consoleSpeedLimit").value = state.speed_limit_kmh;
    $("consoleSpeedNumber").value = state.speed_kmh;
    $("consoleObstacle").value = state.obstacle ? "有" : "无";
    $("localSignalLeft").value = state.signal_left || "绿灯";
    $("localSignalStraight").value = state.signal_straight || "绿灯";
    $("localSignalRight").value = state.signal_right || "绿灯";
    $("localLineLeft").value = state.left_lane_marking || "虚线";
    $("localLineRight").value = state.right_lane_marking || "虚线";
    $("consoleForce").checked = Boolean(state.forced_change);
    autoExecuteEnabled = Boolean(scenarioAutoExecute[page]);
    lastAutoExecutionKey = "";
    updateAutoExecuteButton();
    $("sceneSelect").value = state.scene;
    document.querySelectorAll("[data-lane]").forEach((button) => button.classList.toggle("selected", button.dataset.lane === state.lane));
    syncChangeSelection();
  }
  function resetScenario() {
    autoExecuteEnabled = false;
    lastAutoExecutionKey = "";
    scenarioStates[activeScenario] = initialScenarioState();
    scenarioModes[activeScenario] = "local";
    scenarioAutoExecute[activeScenario] = false;
    loadScenarioState(activeScenario);
    syncChangeSelection();
    document.querySelectorAll("[data-lane]").forEach((button) => button.classList.toggle("selected", button.dataset.lane === "直行车道"));
    if (mode !== "local") setMode("local");
    switchScene(window.AdasPolicy.defaults.scene);
    $("speedValue").textContent = "30 km/h";
    updateAutoExecuteButton();
    drawAllDemos();
  }
  function applyLiveStatus(status) {
    latestStatus = status;
    updateTerminalNodes(status || {}, Boolean(status?.backend && status.backend.online !== false));
    const adas = status?.adas;
    showPerformance(status || {});
    setBoardFrameStatus(status || {});
    updateRoadRecognition(adas || null);
    const online = status?.rk_online === true;
    const wifiCar = status?.wifi_car || {};
    $("commandTarget").textContent = wifiCar.online ? `WifiCar ESP32 · ${wifiCar.host}:${wifiCar.port}` : "WifiCar ESP32 · 待连接";
    $("connection").innerHTML = `<i></i> ${online ? (status.rk_http_source === "relay" ? "公网数据源在线" : "板端在线") : (status.rk_http_source === "relay" ? "公网数据源离线" : "板端离线")}`;
    $("connection").style.color = online ? "var(--green)" : "var(--red)";
    $("sourceNote").textContent = online
      ? `只读数据源 · ${status.rk_http_source === "relay" ? "公网 ECS HTTPS" : status.input_mode === "pcie" ? "PCIe" : status.input_mode === "http" ? "HTTP" : "文件输入"} · ${status.capture_running ? "正在采集" : "未采集"}${status.view ? ` · ${status.view}` : ""}`
      : status.rk_http_source === "relay"
        ? "公网 ECS 中继暂不可用；检查令牌和互联网连接。小车控制与图像中继相互独立。"
        : "暂未收到板端状态。小车手动联调仍通过独立测试台连接，不会绕过场景规则下发驾驶决策。";
    $("footerStatus").textContent = online ? `最近状态 ${status.time_bj || "—"} · 只读监看` : "等待板端上报 · 不显示模拟硬件指标";
    if (online && status.capture_running) {
      const mask = status.pcie_source_mask ?? status.driver_capture_metrics?.source_mask;
      const valid = status.input_mode === "pcie" && Number.isInteger(mask) && mask >= 0 && mask <= 15 ? [0, 1, 2, 3].filter((i) => mask & (1 << i)).length : null;
      $("sourceMetric").innerHTML = `${valid == null ? "—" : valid}<em> / 4</em>`;
      $("sourceDetail").textContent = status.input_mode !== "pcie" ? "当前非 PCIe 实时输入" : valid == null ? "板端未提供有效源掩码" : valid === 4 ? "四路有效输入" : "输入不完整";
      const fps = status.input_mode === "pcie" ? status.pcie_rx_fps ?? status.driver_capture_metrics?.actual_rx_fps : null;
      $("fpsMetric").innerHTML = metric(fps, "FPS");
      $("latencyMetric").innerHTML = metric(status.perf_total_ms, "ms");
    } else { $("sourceMetric").innerHTML = "—<em> / 4</em>"; $("fpsMetric").innerHTML = "—<em> FPS</em>"; $("latencyMetric").innerHTML = "—<em> ms</em>"; }
    if (online && adas) {
      if (currentPage === "dashboard") $("sceneTitle").textContent = sceneTitle(adas.scene);
      $("sceneSelect").value = adas.scene;
      document.querySelectorAll(".scene").forEach((button) => button.classList.toggle("active", button.dataset.scene === adas.scene));
      $("speedMetric").innerHTML = metric(adas.speed_kmh, "km/h", 0);
      $("speedDetail").textContent = Number.isInteger(adas.speed_limit_kmh) && adas.speed_limit_kmh > 0
        ? `道路限速 ${adas.speed_limit_kmh} km/h · 板端`
        : `${$("consoleSpeedLimit").value || 40} km/h · 驾驶台设定`;
      renderDecision({ ...adas, reason: status.adas_decision_reason || "板端场景状态回报" }, "板端状态 · 只读");
      const age = Date.now() - adas.perception?.observed_at_ms;
      setPerception(status.capture_running && age >= 0 && age < 3000 ? adas : { ...adas, perception: null });
      $("decisionSource").textContent = `板端上报 · ${adas.input_source === "manual_console" ? "场景联调" : "输入来源未知"}`;
      $("sourceNote").textContent += adas.input_source === "manual_console" ? " · 决策输入为手动场景联调" : " · 决策来源由板端标记";
      $("laneText").textContent = `${adas.lane} · ${adas.lane_marking}`;
      if (status.view !== "http_snapshot") {
        $("fusionSource").textContent = status.input_mode === "pcie" ? "板端 PCIe 四路输入 · 待接入标定/拼接模型" : "板端文件输入 · 待接入标定/拼接模型";
        const frameWidth = status.driver_capture_metrics?.frame_width;
        const frameHeight = status.driver_capture_metrics?.frame_height;
        const frameSize = Number.isFinite(frameWidth) && Number.isFinite(frameHeight) && frameWidth > 0 && frameHeight > 0 ? `${frameWidth}×${frameHeight}` : "尺寸未上报";
        $("fusionFrameInfo").textContent = `${status.input_mode === "pcie" ? "PCIe" : "文件"} · ${frameSize}`;
      }
    } else {
      $("speedMetric").innerHTML = "—<em> km/h</em>";
      $("speedDetail").textContent = "等待板端状态";
      renderDecision({ scene: "未知", lane: "未知", lane_marking: "未知", signal: "未知", maneuver: "等待板端决策", reason: online ? "板端尚未上报 ADAS 场景状态" : "板端状态已离线", alarm: false }, "板端状态 · 只读");
      $("decisionPill").className = "pill";
      $("decisionPill").textContent = "待接入";
      $("alarm").textContent = "暂无可用状态";
      $("perceptionSource").textContent = "板端未上报 ADAS 状态"; setPerception(null);
      updateRoadRecognition(null);
      $("fusionSource").textContent = "等待板端四路输入 · 待接入标定/拼接模型";
      $("fusionFrameInfo").textContent = "等待输入";
    }
  }
  function setFormValue(name, value) {
    const control = form.elements.namedItem(name);
    if (!control) return;
    if (control.type === "checkbox") control.checked = Boolean(value);
    else control.value = value;
  }
  function evaluateConsoleIntent() {
    const adas = latestStatus?.adas || {};
    const road = adas.perception?.road_state || {};
    const leftMarking = road.lane_markings?.left || "未知";
    const rightMarking = road.lane_markings?.right || "未知";
    const direction = requestedChange === "左转向灯" ? "left" : requestedChange === "右转向灯" ? "right" : form.elements.namedItem("lane").value === "左车道" ? "left" : form.elements.namedItem("lane").value === "右车道" ? "right" : "straight";
    const signal = road.signals?.[direction];
    const roadStateReported = adas.perception?.road_state && typeof adas.perception.road_state === "object";
    const input = {
      scene: adas.scene || $("sceneSelect").value,
      lane: form.elements.namedItem("lane").value,
      signal: signal && signal !== "未知" && signal !== "无" ? signal : roadStateReported ? "未知" : adas.signal || "未知",
      lane_marking: adas.lane_marking || "未知",
      left_lane_marking: leftMarking,
      right_lane_marking: rightMarking,
      maneuver: requestedChange ? (requestedChange === "左转向灯" ? "左转" : "右转") : selectedLaneManeuver(),
      turn_signal: requestedChange || "关闭",
      speed_kmh: Number($("consoleSpeedNumber").value),
      speed_limit_kmh: Number.isInteger(road.speed_limit_kmh) && road.speed_limit_kmh > 0 ? road.speed_limit_kmh : Number($("consoleSpeedLimit").value),
      moving: Boolean(form.elements.namedItem("moving").checked),
      forced_change: $("consoleForce").checked,
      obstacle: typeof road.obstacle === "boolean" ? road.obstacle : adas.obstacle === true,
    };
    const decision = window.AdasPolicy.decide(input);
    renderDecision(decision, "驾驶台操作 · 板端感知约束");
    return decision;
  }
  function decisionAction(result) {
    if (!result || !["左转", "直行", "右转", "停车"].includes(result.maneuver)) return "";
    if (result.maneuver === "停车") return "stop";
    if (result.turn_signal === "左转向灯") return "lane_left";
    if (result.turn_signal === "右转向灯") return "lane_right";
    return result.maneuver === "左转" ? "left" : result.maneuver === "右转" ? "right" : "straight";
  }
  function updateAutoExecuteButton() {
    const button = $("autoExecute");
    button.classList.toggle("active", autoExecuteEnabled);
    button.setAttribute("aria-pressed", String(autoExecuteEnabled));
    $("autoExecuteState").textContent = autoExecuteEnabled ? "已开启 · 按决策下发" : "关闭 · 手动发送";
    $("sendCommand").textContent = autoExecuteEnabled ? "自动执行中" : "发送当前决策";
    const executable = latestDecision && !latestDecision.alarm && Boolean(decisionAction(latestDecision));
    $("sendCommand").disabled = autoExecuteEnabled || !executable || commandBusy;
  }
  function setAutoExecute(enabled) {
    autoExecuteEnabled = Boolean(enabled);
    scenarioAutoExecute[activeScenario] = autoExecuteEnabled;
    lastAutoExecutionKey = "";
    updateAutoExecuteButton();
    if (autoExecuteEnabled) maybeAutoExecute(latestDecision);
    else if (latestDecision) $("commandHint").textContent = latestDecision.alarm
      ? "当前动作未通过规则检查，发送按钮已锁定。"
      : "自动执行已关闭；点击“发送当前决策”后才会下发到小车。";
  }
  function maybeAutoExecute(result) {
    if (!autoExecuteEnabled || commandBusy || !result) return;
    const action = result.alarm ? ($("consoleForce").checked ? "alarm" : "stop") : decisionAction(result);
    if (!action) return;
    if (latestStatus?.wifi_car?.online !== true) {
      $("commandHint").textContent = "自动执行已开启 · 等待 WifiCar ESP32 连接；连接后将按当前决策下发。";
      return;
    }
    const key = `${action}|${result.maneuver}|${result.alarm ? "alarm" : "clear"}`;
    if (key === lastAutoExecutionKey) return;
    lastAutoExecutionKey = key;
    $("commandState").textContent = action === "alarm" ? "停车报警中" : "自动下发中";
    $("commandHint").textContent = action === "alarm"
      ? `实时决策触发停车报警：${result.alarm_text || "驾驶风险"}`
      : action === "stop" ? `实时决策要求停车${result.alarm_text ? `：${result.alarm_text}` : ""}` : "实时决策正在自动下发到小车。";
    sendWifiCarAction(action, "automatic").then((sent) => {
      if (!sent && lastAutoExecutionKey === key) lastAutoExecutionKey = "";
    });
  }
  function forceDecision(decision) {
    if (!decision) return;
    if (decision.alarm) {
      $("commandState").textContent = "停车报警中";
      $("commandHint").textContent = `强制操作被规则拦截，小车将停车并报警：${decision.alarm_text || "当前场景不可执行"}`;
      sendWifiCarAction("alarm", "decision");
    } else sendCommand();
  }
  function operateConsole(kind, value) {
    if (kind === "lane") {
      setFormValue("lane", value);
      setFormValue("turn_signal", "关闭");
      requestedChange = "";
      document.querySelectorAll("[data-lane]").forEach((button) => button.classList.toggle("selected", button.dataset.lane === value));
      syncChangeSelection();
    } else {
      requestedChange = value === "关闭" ? "" : value;
      setFormValue("turn_signal", requestedChange || "关闭");
      setFormValue("maneuver", requestedChange === "左转向灯" ? "左转" : requestedChange === "右转向灯" ? "右转" : selectedLaneManeuver());
      syncChangeSelection();
    }
    const decision = mode === "live" ? evaluateConsoleIntent() : (updateLocal(), latestDecision);
    if ($("consoleForce").checked && !autoExecuteEnabled) forceDecision(decision);
  }
  function toggleDock(dock, floating) {
    const before = dock.getBoundingClientRect();
    dock.classList.toggle("floating", floating);
    dock.dataset.floating = floating ? "true" : "false";
    const button = dock.querySelector(".float-dock");
    button.textContent = floating ? "停靠" : "浮动";
    if (floating) {
      dock.style.left = `${Math.max(8, Math.min(innerWidth - dock.offsetWidth - 8, before.left))}px`;
      dock.style.top = `${Math.max(8, Math.min(innerHeight - dock.offsetHeight - 8, before.top))}px`;
    } else { dock.style.left = ""; dock.style.top = ""; }
  }
  function installDockDragging(dock) {
    const head = dock.querySelector(".dock-head");
    let drag = null;
    head.addEventListener("pointerdown", (event) => {
      if (dock.dataset.floating !== "true" || event.target.closest("button")) return;
      const rect = dock.getBoundingClientRect();
      drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      head.setPointerCapture(event.pointerId);
    });
    head.addEventListener("pointermove", (event) => {
      if (!drag) return;
      dock.style.left = `${Math.max(0, Math.min(innerWidth - dock.offsetWidth, event.clientX - drag.x))}px`;
      dock.style.top = `${Math.max(0, Math.min(innerHeight - 50, event.clientY - drag.y))}px`;
    });
    head.addEventListener("pointerup", () => { drag = null; });
    head.addEventListener("pointercancel", () => { drag = null; });
  }
  function captureBehaviorEvidenceFrame() {
    const video = $("webrtcVideo");
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return "";
    try {
      const scale = Math.min(1, 640 / video.videoWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext("2d", { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.58);
    } catch { return ""; }
  }
  function behaviorMetadata(action, source, evidenceJpeg) {
    const category = ["left", "right", "uturn"].includes(action) ? "turn"
      : ["lane_left", "lane_right"].includes(action) ? "lane_change"
        : action === "alarm" ? "violation_warning" : "";
    if (!category) return undefined;
    return { category, source, forced: $("consoleForce")?.checked === true, evidence_jpeg: evidenceJpeg };
  }
  async function sendWifiCarAction(action, source = "manual") {
    const isDecisionCommand = source === "decision" || source === "automatic";
    if (commandBusy && action !== "stop" && action !== "alarm") return false;
    const generation = ++commandGeneration;
    const base = backendBaseAddress();
    if (!base) {
      const message = "请通过本机 HTTP 后端打开页面，或填写可访问的后端地址";
      if (isDecisionCommand) { $("commandState").textContent = "缺少后端"; $("commandHint").textContent = message; }
      else $("carTestMessage").textContent = message;
      return false;
    }
    commandBusy = true;
    $("sendCommand").disabled = true;
    document.querySelectorAll("[data-car-action]").forEach((button) => { if (button.dataset.carAction !== "stop") button.disabled = true; });
    if (isDecisionCommand) $("commandState").textContent = action === "alarm" ? "停车报警中" : "发送中";
    else $("carTestMessage").textContent = "正在发送 " + action + " …";
    const evidenceJpeg = captureBehaviorEvidenceFrame();
    try {
      const response = await fetch(base + "/api/wifi-car/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, behavior: behaviorMetadata(action, source, evidenceJpeg) }),
        signal: AbortSignal.timeout(5000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) throw new Error(payload.message || ("HTTP " + response.status));
      if (generation !== commandGeneration) return false;
      const labels = { left: "左转（路口转向）", straight: "直行", right: "右转（路口转向）", lane_left: "向左变道", lane_right: "向右变道", stop: "停车", alarm: "停车并报警", uturn: "掉头" };
      const line = (labels[action] || action) + "已由 ESP32 确认（" + payload.response + "）";
      if (isDecisionCommand) {
        $("commandState").textContent = "ESP32 已确认";
        $("commandHint").textContent = line;
        if (latestDecision) addEvent(latestDecision, "ESP32 已确认");
      } else $("carTestMessage").textContent = line;
      if (payload.status) updateTerminalNodes({ ...(latestStatus || {}), wifi_car: payload.status }, true);
      if (payload.behavior_log_saved === false) {
        const logStatus = $("behaviorLogStatus");
        if (logStatus) logStatus.textContent = "动作已执行；日志保存失败";
      }
      return true;
    } catch (error) {
      if (generation !== commandGeneration) return false;
      if (isDecisionCommand) {
        $("commandState").textContent = "发送失败";
        $("commandHint").textContent = "未发送：" + error.message;
      } else $("carTestMessage").textContent = "未发送：" + error.message;
      return false;
    } finally {
      if (generation === commandGeneration) {
        commandBusy = false;
        updateAutoExecuteButton();
        await refreshTerminalStatus();
      }
    }
  }
  async function sendCommand() {
    if (commandBusy || autoExecuteEnabled || !latestDecision || latestDecision.alarm) return;
    const action = decisionAction(latestDecision);
    if (!action) return;
    await sendWifiCarAction(action, "decision");
  }
  async function connectWifiCar() {
    const base = backendBaseAddress();
    if (!base) { $("carTestMessage").textContent = "无法访问后端：请从本机 HTTP 服务打开页面"; return; }
    $("carTestMessage").textContent = "正在查询云端 WSS 连接状态；ESP32 需先连接云端";
    try {
      const response = await fetch(base + "/api/wifi-car/connect", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: "{}", signal: AbortSignal.timeout(5000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) throw new Error(payload.message || ("HTTP " + response.status));
      if (payload.status) updateTerminalNodes({ ...(latestStatus || {}), wifi_car: payload.status }, true);
      $("carTestMessage").textContent = payload.status?.online ? "ESP32 已通过云端 WSS 接入" : "等待 ESP32 主动连接云端 WSS";
      refreshTerminalStatus();
    } catch (error) { $("carTestMessage").textContent = "连接请求失败：" + error.message; }
  }
  async function disconnectWifiCar() {
    const base = backendBaseAddress();
    if (!base) return;
    try {
      const response = await fetch(base + "/api/wifi-car/disconnect", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        signal: AbortSignal.timeout(5000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) throw new Error(payload.message || ("HTTP " + response.status));
      if (payload.status) updateTerminalNodes({ ...(latestStatus || {}), wifi_car: payload.status }, true);
      $("carTestMessage").textContent = "已发送停车命令；设备 WSS 保持连接以接收后续控制";
    } catch (error) { $("carTestMessage").textContent = "断开失败：" + error.message; }
  }
  function requestDriveStart() {
    setFormValue("moving", true);
    const decision = mode === "live" ? evaluateConsoleIntent() : (updateLocal(), latestDecision);
    if (!decision || decision.alarm || decision.maneuver === "停车") {
      $("driveControlState").textContent = "安全条件不满足";
      $("commandState").textContent = "行驶请求被拦截";
      $("commandHint").textContent = decision?.alarm_text || "当前决策要求停车，行驶指令未下发";
      if (decision?.alarm && $("consoleForce").checked && !autoExecuteEnabled) forceDecision(decision);
      return;
    }
    sendWifiCarAction(decisionAction(decision), "decision");
  }
  function requestDriveStop() {
    setFormValue("moving", false);
    if (mode === "live") evaluateConsoleIntent(); else updateLocal();
    sendWifiCarAction("stop", "decision");
  }
  async function connectLive() {
    if (mode !== "live") return;
    const generation = ++connectionGeneration;
    if (timer) clearInterval(timer);
    timer = null;
    const source = selectedDataSource();
    const host = String($("rkHost").value || "192.168.100.105").trim();
    if (source === "relay") {
      $("connection").innerHTML = "<i></i> 视频等待播放器连接";
      $("sourceNote").textContent = "公网视频由上方 WebRTC/WHEP 播放器独立连接；本页面不通过 ECS snapshot 轮询视频或检测框。板端性能数据须由状态接口单独提供。";
      $("footerStatus").textContent = "视频链路：RK 端画框 · 云端转发 · 上位机 WebRTC 播放";
      return;
    }
    const base = $("backendBase").value.trim().replace(/\/+$/, "");
    if (!base) { $("backendBase").focus(); $("backendBase").setCustomValidity("请填写后端地址，或从 HTTP 后端打开此页。"); $("backendBase").reportValidity(); return; }
    $("backendBase").setCustomValidity("");
    const pingUrl = `${base}/api/rk/ping?host=${encodeURIComponent(host)}&port=3000&timeout_ms=3000`;
    const isSourceOnline = (payload) => payload?.rk_ok === true && payload?.rk?.ok === true;
    const buildLiveStatus = (online, extra = {}) => ({
      ok: true,
      rk_online: Boolean(online),
      rk_api_listening: Boolean(online),
      capture_running: Boolean(online),
      view: "webrtc",
      input_mode: "http",
      rk_host: host,
      rk_port: 3000,
      rk_http_source: source,
      rk_http_online: Boolean(online),
      time_bj: nowText(),
      backend: latestReportedStatus?.backend || latestStatus?.backend || { online: true, service: "上位机 HTTP 代理", listen_port: location.port || "—", node_version: "—", resources: {} },
      wifi_car: latestReportedStatus?.wifi_car || latestStatus?.wifi_car || {},
      driver_capture_metrics: online ? { frame_width: 1280, frame_height: 720, source_mask: 15 } : {},
      ...extra,
    });
    try {
      const response = await fetch(pingUrl, { cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const ping = await response.json();
      if (!isSourceOnline(ping)) throw new Error(ping?.rk_err || "RK /api/ping 未返回 ok:true");
      if (mode !== "live" || generation !== connectionGeneration) return;
      applyLiveStatus(buildLiveStatus(true, { rk_ping: ping }));
      localStorage.setItem("adasBackendBase", base);
      localStorage.setItem("adasRkHost", host);
      localStorage.setItem("adasDataSource", source);
      if (timer) clearInterval(timer);
      timer = setInterval(async () => {
        try {
          const poll = await fetch(pingUrl, { cache: "no-store", signal: AbortSignal.timeout(5000) });
          if (!poll.ok) throw new Error(`HTTP ${poll.status}`);
          const ping = await poll.json();
          if (!isSourceOnline(ping)) throw new Error(ping?.rk_err || "RK /api/ping 未返回 ok:true");
          if (mode === "live" && generation === connectionGeneration) applyLiveStatus(buildLiveStatus(true, { rk_ping: ping }));
        }
        catch { if (mode === "live" && generation === connectionGeneration) {
          const last = { ...buildLiveStatus(false), rk_status_request_pending: true };
          applyLiveStatus(last);
          $("connection").innerHTML = "<i></i> RK 连接中断";
        } }
      }, 3000);
    } catch (error) {
      if (mode !== "live" || generation !== connectionGeneration) return;
      // Keep compatibility with an older local backend that has /api/status
      // but predates the RK ping proxy.  Current RK connections never need
      // this path because /api/rk/ping is available in the bundled backend.
      if (source === "rk") try {
        const legacyResponse = await fetch(`${base}/api/status`, { cache: "no-store", signal: AbortSignal.timeout(1800) });
        if (legacyResponse.ok) {
          const legacyStatus = await legacyResponse.json();
          if (mode === "live" && generation === connectionGeneration && legacyStatus && typeof legacyStatus === "object") {
            applyLiveStatus(legacyStatus);
            localStorage.setItem("adasBackendBase", base);
            if (timer) clearInterval(timer);
            timer = setInterval(async () => {
              try {
                const poll = await fetch(`${base}/api/status`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
                if (!poll.ok) throw new Error(`HTTP ${poll.status}`);
                const status = await poll.json();
                if (mode === "live" && generation === connectionGeneration) applyLiveStatus(status);
              } catch {}
            }, 2000);
            return;
          }
        }
      } catch {}
      applyLiveStatus(buildLiveStatus(false));
      $("connection").innerHTML = "<i></i> 连接失败";
      $("sourceNote").textContent = `无法连接 RK3568：${error.message}。请确认 ${host}:3000/api/ping 返回 ok:true。`;
    }
  }
  function setMode(next) {
    connectionGeneration++;
    mode = next;
    if (scenarioModes[activeScenario]) scenarioModes[activeScenario] = mode;
    document.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("selected", button.dataset.mode === mode));
    document.body.classList.toggle("local-mode", mode === "local");
    form.querySelectorAll("input,select").forEach((control) => { control.disabled = mode === "live"; });
    document.querySelectorAll(".local-road-input").forEach((control) => { control.disabled = mode === "live"; });
    document.querySelectorAll(".scene").forEach((button) => { button.disabled = mode === "live"; });
    $("sceneSelect").disabled = mode === "live";
    $("liveSettings").hidden = mode !== "live";
    $("controlHint").hidden = mode === "live";
    $("reset").disabled = mode === "live";
    if (mode === "live") { stopTerminalPolling(); applyLiveStatus({ rk_online: false }); connectLive(); }
    else { if (timer) clearInterval(timer); timer = null; setBoardFrameStatus({ rk_online: false }); updateLocal(); if (currentPage !== "performance") startTerminalPolling(); }
  }
  function clearMedia() {
    cameras.forEach((camera, index) => {
      const video = camera.querySelector("video"), image = camera.querySelector("img"), canvas = camera.querySelector("canvas");
      if (video.dataset.url) URL.revokeObjectURL(video.dataset.url);
      video.pause(); video.removeAttribute("src"); video.load(); delete video.dataset.url;
      if (image.dataset.url) URL.revokeObjectURL(image.dataset.url);
      delete image.dataset.url;
      delete camera.dataset.mediaType;
      image.removeAttribute("src"); image.hidden = true; video.hidden = true; canvas.hidden = false;
      camera.querySelector(".media-name").textContent = "联调示意 · 非采集画面";
      drawDemo(canvas, index, null);
    });
    $("mediaStatus").textContent = "可导入 U 盘中的道路视频 / 图片";
  }
  function loadMedia(camera, file) {
    if (!file.type.startsWith("video/") && !file.type.startsWith("image/")) return;
    const video = camera.querySelector("video"), image = camera.querySelector("img"), canvas = camera.querySelector("canvas");
    const name = camera.querySelector(".media-name"), url = URL.createObjectURL(file);
    if (video.dataset.url) URL.revokeObjectURL(video.dataset.url);
    if (image.dataset.url) URL.revokeObjectURL(image.dataset.url);
    video.pause(); video.removeAttribute("src"); image.removeAttribute("src");
    video.hidden = true; image.hidden = true; canvas.hidden = true;
    name.textContent = `${file.name} · ${Math.round(file.size / 1024)} KB`;
    if (file.type.startsWith("video/")) { camera.dataset.mediaType = "video"; video.src = url; video.dataset.url = url; video.hidden = false; video.load(); $("mediaStatus").textContent = "视频素材已载入 · 使用播放器暂停或拖动进度"; video.onerror = () => { $("mediaStatus").textContent = "浏览器无法解码此视频，请转换为 H.264 MP4"; }; }
    else { camera.dataset.mediaType = "image"; image.src = url; image.dataset.url = url; image.hidden = false; image.onload = () => URL.revokeObjectURL(url); $("mediaStatus").textContent = "图片素材已载入 · 手动确认角度与方向"; }
  }
  function drawDemo(canvas, index, config) {
    const box = canvas.getBoundingClientRect(), ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (!box.width || !box.height) return;
    canvas.width = Math.round(box.width * ratio); canvas.height = Math.round(box.height * ratio);
    const ctx = canvas.getContext("2d"); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const w = box.width, h = box.height;
    const sky = ctx.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, "#142b38"); sky.addColorStop(.53, "#29413e"); sky.addColorStop(.54, "#333b3b"); sky.addColorStop(1, "#1c292c"); ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#314044"; ctx.beginPath(); ctx.moveTo(w * .40, h * .48); ctx.lineTo(w * .60, h * .48); ctx.lineTo(w * .83, h); ctx.lineTo(w * .17, h); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#899795"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(w * .4, h * .48); ctx.lineTo(w * .17, h); ctx.moveTo(w * .6, h * .48); ctx.lineTo(w * .83, h); ctx.stroke();
    ctx.strokeStyle = "#b1b5a0"; ctx.setLineDash([7, 9]); ctx.beginPath(); ctx.moveTo(w * .5, h * .5); ctx.lineTo(w * .5, h); ctx.stroke(); ctx.setLineDash([]);
    if (index === 0 && config?.scene === "路口信号灯") {
      ctx.fillStyle = "#c2cbc2"; ctx.fillRect(w * .67, h * .28, 3, h * .18); ctx.fillStyle = config.signal === "红灯" ? color.red : config.signal === "绿灯" ? color.green : color.yellow; ctx.beginPath(); ctx.arc(w * .67, h * .26, 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#e7d8b0"; ctx.beginPath(); ctx.moveTo(w * .25, h * .42); ctx.lineTo(w * .75, h * .42); ctx.stroke();
    }
    if (config?.obstacle && (index === 0 || index === 1)) { ctx.fillStyle = color.red; ctx.beginPath(); ctx.arc(w * .53, h * .53, 5, 0, Math.PI * 2); ctx.fill(); }
    if (currentPage !== "single-test") {
      ctx.fillStyle = "rgba(8,17,24,.5)"; ctx.fillRect(0, h - 25, w, 25);
      ctx.fillStyle = color.ink; ctx.font = "9px sans-serif"; ctx.fillText(templates[index] + " · 示意画面", 8, h - 9);
    }
  }
  function drawAllDemos() {
    if (currentPage === "single-test") { drawCameraFrames(true); return; }
    cameras.forEach((camera, index) => { const canvas = camera.querySelector("canvas"); if (!canvas.hidden) drawDemo(canvas, index, mode === "local" ? window.AdasPolicy.decide(state) : null); });
  }
  function drawFusion() {
    if (fusionController) fusionController.refresh(true);
    else { drawFusionPlaceholder(); $("fusionState").textContent = "融合模块未加载"; }
  }
  function drawFusionPlaceholder() {
    const canvas = $("fusionCanvas");
    if (!canvas) return;
    const box = canvas.getBoundingClientRect(), ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (!box.width || !box.height) return;
    canvas.width = Math.round(box.width * ratio); canvas.height = Math.round(box.height * ratio);
    const ctx = canvas.getContext("2d"); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const w = box.width, h = box.height;
    ctx.fillStyle = "#09131b"; ctx.fillRect(0, 0, w, h);
    const cx = w * .5, cy = h * .54, radius = Math.min(w, h) * .34;
    const gradient = ctx.createRadialGradient(cx, cy, 4, cx, cy, radius * 1.8); gradient.addColorStop(0, "#304d50"); gradient.addColorStop(1, "#111f29"); ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(cx, cy, radius * 1.55, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#6bd4dc55"; ctx.lineWidth = 1; for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.arc(cx, cy, radius * i / 3, 0, Math.PI * 2); ctx.stroke(); }
    ctx.strokeStyle = "#a7b7b3"; ctx.lineWidth = 2; [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(([x, y]) => { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + x * radius * 1.4, cy + y * radius * 1.4); ctx.stroke(); });
    ctx.fillStyle = "#68d7df"; ctx.beginPath(); ctx.moveTo(cx, cy - 18); ctx.lineTo(cx - 15, cy + 17); ctx.lineTo(cx + 15, cy + 17); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#dceaf0"; ctx.font = "11px sans-serif"; ctx.textAlign = "center"; ctx.fillText("前", cx, cy - radius * 1.25); ctx.fillText("后", cx, cy + radius * 1.3); ctx.fillText("左", cx - radius * 1.3, cy + 4); ctx.fillText("右", cx + radius * 1.3, cy + 4);
    $("fusionFrameInfo").textContent = mode === "local" ? "本地联调 · 四路占位" : $("fusionFrameInfo").textContent;
  }
  function exportCsv() {
    const rows = [["time_bj", "source", "scene", "action", "state"], ...eventLog.map((e) => [e.time, e.source, e.scene, e.action, e.alarm])];
    const csv = "\ufeff" + rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); link.download = `adas-events-${nowText().replace(/[- :]/g, "")}.csv`; link.click(); URL.revokeObjectURL(link.href);
  }

  form.addEventListener("input", (event) => { if (event.target.name === "speed_kmh") $("speedValue").textContent = `${event.target.value} km/h`; updateLocal(); drawAllDemos(); });
  form.addEventListener("change", (event) => {
    if (event.target.name === "speed_limit_kmh") {
      event.target.value = readForm().speed_limit_kmh;
      $("consoleSpeedLimit").value = event.target.value;
    }
    if (event.target.name === "signal") {
      ["localSignalLeft", "localSignalStraight", "localSignalRight"].forEach((id) => { $(id).value = event.target.value; });
    }
    if (event.target.name === "lane_marking") {
      $("localLineLeft").value = event.target.value;
      $("localLineRight").value = event.target.value;
    }
    if (event.target.name === "obstacle") $("consoleObstacle").value = event.target.checked ? "有" : "无";
    updateLocal();
  });
  document.querySelectorAll(".local-road-input").forEach((control) => control.addEventListener("change", () => {
    if (control.id === "consoleObstacle") setFormValue("obstacle", control.value === "有");
    if (control.id === "consoleSpeedLimit") {
      const value = Math.max(10, Math.min(180, Number(control.value) || 40));
      control.value = value;
      setFormValue("speed_limit_kmh", value);
    }
    if (mode === "local") updateLocal();
  }));
  document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));
  $("showDashboard")?.addEventListener("click", () => setPage(activeScenario));
  document.querySelectorAll("[data-lane]").forEach((button) => button.addEventListener("click", () => operateConsole("lane", button.dataset.lane)));
  document.querySelectorAll("[data-change]").forEach((button) => button.addEventListener("click", () => operateConsole("change", button.dataset.change)));
  document.querySelectorAll(".dock-window").forEach((dock) => {
    installDockDragging(dock);
    dock.querySelector(".float-dock").addEventListener("click", () => toggleDock(dock, dock.dataset.floating !== "true"));
  });
  $("consoleSpeedLimit").addEventListener("input", () => {
    const value = Math.max(10, Math.min(180, Number($("consoleSpeedLimit").value) || 40));
    $("consoleSpeedLimit").value = value;
    setFormValue("speed_limit_kmh", value);
    if (mode === "live") evaluateConsoleIntent(); else updateLocal();
  });
  const updateConsoleSpeed = (value) => {
    const speed = Math.max(0, Math.min(180, Number(value) || 0));
    $("consoleSpeedNumber").value = speed;
    setFormValue("speed_kmh", speed);
    $("speedValue").textContent = `${speed} km/h`;
    if (mode === "live") evaluateConsoleIntent(); else updateLocal();
  };
  $("consoleSpeedNumber").addEventListener("input", (event) => updateConsoleSpeed(event.target.value));
  $("consoleForce").addEventListener("change", () => { setFormValue("forced_change", $("consoleForce").checked); if (mode === "live") evaluateConsoleIntent(); else updateLocal(); });
  $("sceneSelect").addEventListener("change", () => { switchScene($("sceneSelect").value); drawAllDemos(); });
  document.querySelectorAll(".scene").forEach((button) => button.addEventListener("click", () => { switchScene(button.dataset.scene); drawAllDemos(); }));
  document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  cameras.forEach((camera, index) => {
    const canvas = camera.querySelector("canvas"); drawDemo(canvas, index, null);
    camera.querySelector(".focus").addEventListener("click", () => { $("cameraGrid").classList.toggle("focused"); camera.classList.toggle("focused-camera"); });
  });
  $("sendCommand").addEventListener("click", sendCommand);
  $("autoExecute").addEventListener("click", () => setAutoExecute(!autoExecuteEnabled));
  $("driveStart").addEventListener("click", requestDriveStart);
  $("driveStop").addEventListener("click", requestDriveStop);
  $("wifiCarConnect").addEventListener("click", connectWifiCar);
  $("wifiCarDisconnect").addEventListener("click", disconnectWifiCar);
  $("refreshNodes").addEventListener("click", refreshTerminalStatus);
  document.querySelectorAll("[data-car-action]").forEach((button) => button.addEventListener("click", () => {
    sendWifiCarAction(button.dataset.carAction, "manual");
  }));
  $("reset").addEventListener("click", resetScenario);
  $("resetView").addEventListener("click", () => { $("cameraGrid").classList.remove("focused"); document.querySelectorAll(".focused-camera").forEach((x) => x.classList.remove("focused-camera")); });
  $("backendBase").value = localStorage.getItem("adasBackendBase") || (location.protocol.startsWith("http") ? location.origin : "");
  $("rkHost").value = localStorage.getItem("adasRkHost") || "192.168.100.105";
  $("rkHost").addEventListener("change", () => localStorage.setItem("adasRkHost", $("rkHost").value.trim()));
  $("dataSource").value = localStorage.getItem("adasDataSource") || "relay";
  $("dataSource").addEventListener("change", () => {
    localStorage.setItem("adasDataSource", selectedDataSource());
    syncDataSourceControls();
    if (mode === "live") connectLive();
    else if (currentPage !== "performance") startTerminalPolling();
  });
  syncDataSourceControls();
  $("connect").addEventListener("click", connectLive);
  $("fullscreen").addEventListener("click", () => { const p = !document.fullscreenElement ? document.documentElement.requestFullscreen?.() : document.exitFullscreen?.(); p?.catch(() => { $("footerStatus").textContent = "浏览器未允许全屏，可按 F11"; }); });
  $("export").addEventListener("click", exportCsv);
  document.addEventListener("keydown", (event) => {
    if (currentPage !== "single-test" && currentPage !== "sim-test") return;
    if (mode !== "local" || event.ctrlKey || event.altKey || /INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
    if (event.code === "Space") { event.preventDefault(); form.elements.namedItem("moving").click(); }
    if (event.key.toLowerCase() === "x") form.elements.namedItem("forced_change").click();
    if (["ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key)) event.preventDefault();
    if (event.key === "ArrowLeft") form.elements.namedItem("turn_signal").value = "左转向灯";
    if (event.key === "ArrowRight") form.elements.namedItem("turn_signal").value = "右转向灯";
    if (event.key === "ArrowUp") form.elements.namedItem("turn_signal").value = "关闭";
    updateLocal(); drawAllDemos();
  });
  window.addEventListener("resize", () => { drawAllDemos(); drawFusion(); drawBirdView(mode === "live" ? latestStatus?.adas || {} : window.AdasPolicy.decide(state)); });
  setInterval(() => { $("clock").textContent = nowText() + " CST"; }, 1000);
  $("clock").textContent = nowText() + " CST";
  $("liveSettings").hidden = true;
  document.body.classList.toggle("local-mode", mode === "local");
  updateAutoExecuteButton();
  updateLocal();
  setPage("performance");
  drawAllDemos();
  drawFusion();
  startRkCommandPolling();
})();
