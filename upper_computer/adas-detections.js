(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const names = { pedestrian: "行人", rider: "骑行者", car: "汽车", truck: "卡车", bus: "公交车",
    motorcycle: "摩托车", bicycle: "自行车", center_dashline: "虚线", center_solidline: "实线",
    Green_L_diaotou: "左转及掉头绿灯", green: "绿灯", green_L: "左转绿灯", green_R: "右转绿灯",
    green_Z_L: "直行及左转绿灯", green_non: "非机动车绿灯", green_prson: "行人绿灯", green_z: "直行绿灯",
    red: "红灯", red_L: "左转红灯", red_L_diaotou: "左转及掉头红灯", red_R: "右转红灯",
    red_Z: "直行红灯", red_diaotou: "掉头红灯", red_non: "非机动车红灯", red_person: "行人红灯", yellow: "黄灯" };
  const demoLogs = [
    { category: "bdd", image: "bdd-road-scene.jpg", imageAlt: "BDD 道路目标离线样图，含汽车和卡车检测框", type: "汽车、卡车", confidence: "汽车 0.95 · 卡车 0.91", description: "画面中检测到多辆汽车及一辆卡车。", behavior: "关注前车与大型车辆间距，保持安全车距。", execution: "仅建议，未执行" },
    { category: "traffic", image: "traffic-red.jpg", imageAlt: "红灯样图，包含红灯检测框", type: "红灯、左转红灯", confidence: "最高 0.91", description: "检测到 2 个红灯和 1 个左转红灯。", behavior: "停车等待并持续观察信号灯变化。", execution: "仅建议，未执行" },
    { category: "traffic", image: "traffic-green.jpg", imageAlt: "绿灯样图，包含绿灯检测框", type: "绿灯", confidence: "0.90", description: "检测到 1 个绿灯目标。", behavior: "确认路口及行人安全后再通行。", execution: "仅建议，未执行" },
    { category: "traffic", image: "traffic-green-turn.jpg", imageAlt: "旋转噪声场景绿灯样图，包含左转和直行绿灯检测框", type: "左转绿灯、直行绿灯", confidence: "0.85 · 0.59", description: "旋转和噪声场景中检测到左转绿灯及直行绿灯。", behavior: "结合车道方向确认通行路径，减速通过路口。", execution: "仅建议，未执行" },
    { category: "traffic", image: "traffic-green-blur.jpg", imageAlt: "运动模糊场景绿灯样图，包含直行绿灯检测框", type: "直行绿灯", confidence: "0.85 · 0.69", description: "运动模糊场景中检测到 2 个直行绿灯目标。", behavior: "降低速度并确认信号灯状态后通行。", execution: "仅建议，未执行" },
    { category: "road", image: "lane-dashed.jpg", imageAlt: "虚线样图，包含车道线检测框", type: "道路虚线", confidence: "最高 0.94", description: "画面中检测到多段虚线。", behavior: "如需变道，先确认相邻车道安全并开启转向提示。", execution: "仅建议，未执行" },
    { category: "road", image: "lane-solid.jpg", imageAlt: "实线样图，包含车道线检测框", type: "道路实线", confidence: "最高 0.93", description: "画面中检测到 2 段实线。", behavior: "保持当前车道，避免跨越实线。", execution: "仅建议，未执行" },
    { category: "road", image: "lane-dashed-2.jpg", imageAlt: "另一张虚线样图，包含虚线检测框", type: "道路虚线", confidence: "最高 0.94", description: "另一处道路场景中检测到 3 段虚线。", behavior: "变道前确认后方来车，保持车辆平稳行驶。", execution: "仅建议，未执行" },
    { category: "road", image: "lane-mixed.jpg", imageAlt: "混合车道线样图，包含实线和虚线检测框", type: "实线、虚线", confidence: "0.93 · 0.87", description: "同一画面中同时检测到实线和虚线。", behavior: "遵守实线约束，仅在允许区域内变道。", execution: "仅建议，未执行" },
  ];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let visible = false, timer = null, controller = null, sources = {}, failed = false, generation = 0;
  let behaviorTimer = null, behaviorController = null, behaviorPage = 1, behaviorExpanded = false;
  let behaviorTotal = 0, behaviorFailed = false;
  const time = (n) => new Date(n).toLocaleTimeString("zh-CN", { hour12: false });
  const fullTime = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? esc(value || "—") : date.toLocaleString("zh-CN", { hour12: false });
  };
  function renderDemoLogs() {
    const category = $("demoLogCategory").value;
    const rows = demoLogs.filter((item) => category === "all" || item.category === category);
    $("demoLogEntries").innerHTML = rows.map((item) => `<article class="demo-log-entry">
      <div class="demo-log-image"><img src="./demo_assets/${item.image}" alt="${esc(item.imageAlt)}" loading="lazy" decoding="async"></div>
      <div class="demo-log-fields">
        <div class="demo-log-field"><span>识别类型</span><strong>${esc(item.type)}</strong></div>
        <div class="demo-log-field"><span>置信度</span><strong>${esc(item.confidence)}</strong></div>
        <div class="demo-log-field"><span>检测描述</span><p>${esc(item.description)}</p></div>
        <div class="demo-log-field"><span>智驾建议</span><p>${esc(item.behavior)}</p></div>
        <div class="demo-log-field"><span>执行状态</span><strong>${esc(item.execution)}</strong></div>
      </div>
    </article>`).join("") || `<p class="demo-log-empty">该类别暂无样例记录</p>`;
  }
  function render() {
    const reports = [1, 2, 3, 4].map((id) => sources[id]).filter(Boolean);
    $("detectionConnection").textContent = failed ? "接收服务暂不可用" :
      !reports.length ? "等待 RK 上报" : reports.every((r) => r.stale) ? "上报已停止或超时" : "正在接收 RK 检测结果";
    const selected = $("detectionSource").value, family = $("detectionFamily").value;
    const rows = reports.filter((r) => selected === "all" || r.source === Number(selected))
      .flatMap((r) => r.detections.filter((d) => family === "all" || d.model === family).map((d) => ({ r, d })));
    $("detectionCount").textContent = `${rows.length} 个目标`;
    $("detectionRows").innerHTML = rows.length ? rows.map(({ r, d }) => {
      const hue = (d.class_id * 47 + (d.model === "traffic" ? 12 : d.model === "road" ? 185 : 60)) % 360;
      const view = { 1: "前向", 2: "后向", 3: "左向", 4: "右向" }[r.source] || `通道 ${r.source}`;
      return `<tr class="${r.stale ? "detection-stale" : ""}"><td>${view}</td><td><span class="detection-dot" style="background:hsl(${hue} 75% 65%)"></span>${esc(names[d.class_name] || d.class_name)}</td><td>${(d.confidence * 100).toFixed(1)}%</td><td>${[d.left, d.top, d.right, d.bottom].map(Math.round).join(", ")}</td><td>${esc(r.frame_sequence)}</td><td>${time(r.received_at_ms)}</td><td>${r.stale ? "已过期" : r.detections_stale ? "检测耗时较长" : "已接收"}</td></tr>`;
    }).join("") : `<tr><td colspan="7">${reports.length ? "当前筛选没有目标" : "尚未收到检测结果"}</td></tr>`;
  }
  function renderBehaviorLogs(items = []) {
    const pages = Math.max(1, Math.ceil(behaviorTotal / 10));
    if (!behaviorExpanded && behaviorPage > pages) behaviorPage = pages;
    $("behaviorPageInput").value = behaviorPage;
    $("behaviorPageInput").max = pages;
    $("behaviorPageInfo").textContent = behaviorExpanded ? `共 ${behaviorTotal} 条 · 展开浏览` : `第 ${behaviorPage} / ${pages} 页 · 共 ${behaviorTotal} 条`;
    $("behaviorLogStatus").textContent = behaviorFailed ? "行为日志暂不可用" : behaviorTotal ? `已载入 ${Math.min(items.length, behaviorTotal)} 条记录` : "暂无行为记录";
    $("behaviorRows").innerHTML = items.length ? items.map((item) => {
      const category = { turn: "转弯", lane_change: "变道", violation_warning: "违规警告" }[item.category] || "未知";
      const source = { manual: "手动操作", decision: "场景决策", automatic: "自动执行" }[item.source] || "未知来源";
      const evidenceFrame = item.evidence_frame ?? item.frame_sequence ?? item.evidence_id;
      const evidence = evidenceFrame == null || evidenceFrame === ""
        ? "无帧号记录" : `帧号 / 证据编号：${esc(evidenceFrame)}`;
      return `<tr><td>${evidence}</td><td>${category}<small>${esc(item.action_label || "")}</small></td><td>${fullTime(item.time)}</td><td>${item.executed ? "是 · ESP32 已确认" : `否 · ${esc(item.execution_detail || "未确认")}`}</td><td>${source}<small>${item.forced ? "强制执行" : "非强制"}</small></td><td>${item.warning ? "是" : "否"}</td></tr>`;
    }).join("") : `<tr><td colspan="6">${behaviorFailed ? "无法连接行为日志服务" : "暂无行为日志"}</td></tr>`;
    $("behaviorLogScroll").classList.toggle("expanded", behaviorExpanded);
    $("behaviorPageInput").disabled = behaviorExpanded;
    $("behaviorPageGo").disabled = behaviorExpanded;
    $("behaviorPageInfo").hidden = behaviorExpanded;
    $("behaviorExpand").textContent = behaviorExpanded ? "收起历史" : "展开全部历史";
    $("behaviorExpand").setAttribute("aria-expanded", String(behaviorExpanded));
  }
  async function pollBehaviorLogs() {
    if (!visible || document.hidden || behaviorController) return;
    const requestController = new AbortController();
    behaviorController = requestController;
    const limit = behaviorExpanded ? 5000 : 10;
    const offset = behaviorExpanded ? 0 : (behaviorPage - 1) * 10;
    const category = $("behaviorCategory").value;
    const timeout = setTimeout(() => requestController.abort(), 5000);
    try {
      const items = [];
      let data, currentOffset = offset;
      do {
        const query = new URLSearchParams({ category, limit: String(limit), offset: String(currentOffset) });
        const response = await fetch(`/api/behavior-logs?${query}`, { cache: "no-store", signal: requestController.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        data = await response.json();
        if (!data.ok || !Array.isArray(data.items)) throw new Error("Invalid behavior log response");
        items.push(...data.items);
        behaviorTotal = Number.isFinite(data.total) ? data.total : items.length;
        currentOffset += data.items.length;
      } while (behaviorExpanded && data.items.length === limit && currentOffset < behaviorTotal);
      behaviorFailed = false;
      renderBehaviorLogs(items);
    } catch {
      behaviorFailed = true;
      renderBehaviorLogs();
    } finally {
      clearTimeout(timeout);
      if (behaviorController === requestController) behaviorController = null;
      if (visible) behaviorTimer = setTimeout(pollBehaviorLogs, 2500);
    }
  }
  async function poll() {
    if (!visible || document.hidden || controller) return;
    const requestGeneration = generation;
    const requestController = new AbortController();
    controller = requestController;
    const timeout = setTimeout(() => requestController.abort(), 5000);
    try {
      const response = await fetch("/api/detections/latest", { cache: "no-store", signal: requestController.signal });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = await response.json();
      if (!data.ok || !data.sources) throw new Error("Invalid detection response");
      if (requestGeneration !== generation) return;
      sources = data.sources;
      failed = false;
    } catch {
      if (visible && requestGeneration === generation) failed = true;
    } finally {
      clearTimeout(timeout);
      if (controller === requestController) controller = null;
      if (visible && requestGeneration === generation) { render(); timer = setTimeout(poll, 1000); }
    }
  }
  function enterPage() {
    generation++;
    visible = true;
    render();
    poll();
    pollBehaviorLogs();
  }
  function leavePage() {
    generation++;
    visible = false;
    clearTimeout(timer);
    clearTimeout(behaviorTimer);
    controller?.abort();
    behaviorController?.abort();
    controller = null;
    behaviorController = null;
  }
  window.addEventListener("adas-page-change", (event) => {
    if (event.detail === "detections") enterPage();
    else leavePage();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearTimeout(timer); clearTimeout(behaviorTimer); }
    else if (visible) { poll(); pollBehaviorLogs(); }
  });
  $("detectionSource").addEventListener("change", render);
  $("detectionFamily").addEventListener("change", render);
  $("demoLogCategory").addEventListener("change", renderDemoLogs);
  renderDemoLogs();
  $("behaviorCategory").addEventListener("change", () => { behaviorPage = 1; clearTimeout(behaviorTimer); pollBehaviorLogs(); });
  $("behaviorPageGo").addEventListener("click", () => {
    const pages = Math.max(1, Math.ceil(behaviorTotal / 10));
    behaviorPage = Math.max(1, Math.min(pages, Math.floor(Number($("behaviorPageInput").value) || 1)));
    clearTimeout(behaviorTimer);
    pollBehaviorLogs();
  });
  $("behaviorPageInput").addEventListener("keydown", (event) => { if (event.key === "Enter") $("behaviorPageGo").click(); });
  $("behaviorExpand").addEventListener("click", () => {
    behaviorExpanded = !behaviorExpanded;
    clearTimeout(behaviorTimer);
    renderBehaviorLogs();
    pollBehaviorLogs();
  });
})();
