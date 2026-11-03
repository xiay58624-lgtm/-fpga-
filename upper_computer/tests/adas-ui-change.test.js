const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const { chromium } = require(process.env.ADAS_PLAYWRIGHT_MODULE || "playwright");

async function main() {
  const root = path.resolve(__dirname, "..");
  const assets = new Set(["adas.html", "adas.css", "adas.js", "adas-policy.js", "adas-webrtc.js", "adas-fusion.js", "adas-detections.js", "adas-detections.css", "demo_assets/bdd-road-scene.jpg", "demo_assets/traffic-red.jpg", "demo_assets/traffic-green.jpg", "demo_assets/traffic-green-turn.jpg", "demo_assets/traffic-green-blur.jpg", "demo_assets/lane-dashed.jpg", "demo_assets/lane-solid.jpg", "demo_assets/lane-dashed-2.jpg", "demo_assets/lane-mixed.jpg"]);
  const server = http.createServer((request, response) => {
    const name = new URL(request.url, "http://localhost").pathname.slice(1) || "adas.html";
    if (!assets.has(name)) { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", name.endsWith("css") ? "text/css" : name.endsWith("js") ? "text/javascript" : name.endsWith(".jpg") ? "image/jpeg" : "text/html; charset=utf-8");
    response.end(fs.readFileSync(path.join(root, name)));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  let browser;
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/status") return route.fulfill({ json: {
        rk_online: true, capture_running: true, input_mode: "pcie",
        perf_cap_ms: 20, perf_conv_ms: 10, perf_view_ms: 5, perf_det_ms: 30,
        perf_ocr_ms: 0, perf_env_ms: 25, perf_ui_ms: 10, perf_total_ms: 100,
      } });
      if (url.pathname === "/api/detections/latest") return route.fulfill({ json: { ok: true, sources: {
        1: { source: 1, stale: false, detections: [], received_at_ms: Date.now(), frame_sequence: 7 },
      } } });
      if (url.pathname === "/api/rk/realtime/vision/latest") return route.fulfill({ json: {
        ok: true, mode: "adas", inference_enabled: true, frame_sequence: 12,
        inference_ms: 145, inference_fps: 2.5, age_ms: 100,
        detections: [{ source: 1, class_name: "car", confidence: 0.91 }],
        per_camera: [
          { camera: "front", inference_ms: 35, detection_count: 1 },
          { camera: "rear", inference_ms: 36, detection_count: 2 },
          { camera: "left", inference_ms: 37, detection_count: 3 },
          { camera: "right", inference_ms: 37, detection_count: 4 },
        ],
        inferred_direction_name: "直行", safety_state: "allowed", decision_text: "当前未检测到限制条件",
      } });
      if (url.pathname === "/api/behavior-logs") {
        const all = Array.from({ length: 12 }, (_, index) => ({
          id: `event-${index}`, time: new Date(Date.now() - index * 1000).toISOString(),
          category: index % 2 ? "lane_change" : "turn", action_label: `动作 ${index}`,
          executed: true, forced: index === 0, warning: false, evidence_id: "",
        }));
        const filtered = url.searchParams.get("category") === "all" ? all : all.filter((item) => item.category === url.searchParams.get("category"));
        const offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 10);
        return route.fulfill({ json: { ok: true, total: filtered.length, items: filtered.slice(offset, offset + limit) } });
      }
      return route.fulfill({ json: { ok: true, status: {}, backend: { online: true }, wifi_car: { online: false } } });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator("#performancePage").waitFor({ state: "visible" });
    assert.equal(await page.locator("#performancePage .performance-panel #performanceConnection").count(), 1);
    assert.equal(await page.locator("#performancePage .performance-panel .perf-card").count(), 3);
    assert.equal(await page.locator("#performancePage .performance-panel .chart-card").count(), 2);
    const performanceTitleSizes = await page.evaluate(() => ({
      terminal: getComputedStyle(document.querySelector("#terminalPanel h3")).fontSize,
      performance: getComputedStyle(document.querySelector("#performancePage .performance-hero h3")).fontSize,
    }));
    assert.equal(performanceTitleSizes.performance, performanceTitleSizes.terminal);
    assert.equal(await page.locator("#performancePie").count(), 1);
    assert.equal(await page.locator("#perfTimingState").textContent(), "四路实测 · 4 路");
    assert.equal(await page.locator("#perfTimingTotal").textContent(), "145.0");
    assert.equal(await page.locator("#perfTimingLegend > div").count(), 4);
    assert.equal(await page.locator("#perfInferFps").textContent(), "2.50 FPS");
    assert.equal(await page.locator("#rkVisionMode").textContent(), "ADAS");
    assert.equal(await page.locator("#rkCameraRows tr").count(), 4);
    assert.ok(await page.evaluate(() => {
      const canvas = document.querySelector("#performancePie");
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels.some((value, index) => index % 4 === 3 && value > 0);
    }));
    const performanceOrder = await page.evaluate(() => {
      const panels = [...document.querySelectorAll("#performancePage .performance-charts, #performancePage .performance-webrtc")];
      return { panels: panels.map((node) => node.className), html: document.querySelector("#performancePage")?.innerHTML.slice(-500) };
    });
    assert.deepEqual(performanceOrder.panels, ["performance-charts", "panel webrtc-panel performance-webrtc"], JSON.stringify(performanceOrder));
    const navStyle = await page.locator('[data-page="performance"]').evaluate((node) => ({
      grid: getComputedStyle(node).gridTemplateColumns,
      num: getComputedStyle(node.querySelector("span")).fontSize,
      label: getComputedStyle(node.querySelector("b")).fontSize,
    }));
    assert.equal(navStyle.num, "14px"); assert.equal(navStyle.label, "15px");
    assert.match(navStyle.grid, /^36px /);
    if (process.argv[2]) {
      fs.mkdirSync(process.argv[2], { recursive: true });
      await page.screenshot({ path: path.join(process.argv[2], "performance-desktop.png"), fullPage: true });
    }
    await page.locator('[data-page="detections"]').click();
    await page.locator("#behaviorRows tr").nth(9).waitFor();
    assert.equal(await page.locator("#detectionsPage .detection-log #detectionRows").count(), 1);
    assert.equal(await page.locator("#demoLogEntries .demo-log-entry").count(), 9);
    assert.equal(await page.locator("#demoLogEntries .demo-log-image img").evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0)), true);
    assert.equal(await page.locator("#demoLogEntries .demo-log-meta, #demoLogEntries .demo-log-image span").count(), 0);
    assert.equal(await page.locator("#demoLogEntries .demo-log-field").count(), 45);
    assert.equal(await page.locator("#demoLogEntries .demo-log-field").first().innerText(), "识别类型\n汽车、卡车");
    assert.equal(await page.locator(".demo-log-source").count(), 0);
    await page.locator("#demoLogCategory").selectOption("traffic");
    assert.equal(await page.locator("#demoLogEntries .demo-log-entry").count(), 4);
    assert.equal(await page.locator("#demoLogEntries").getByText("仅建议，未执行").count(), 4);
    await page.locator("#demoLogCategory").selectOption("all");
    if (process.argv[2]) await page.screenshot({ path: path.join(process.argv[2], "detections-desktop.png"), fullPage: true });
    assert.equal(await page.locator("#detectionCount").isVisible(), false);
    assert.equal((await page.locator(".behavior-log thead").innerText()).includes("用户操作 / 是否强制"), false);
    assert.equal(await page.locator("#detectionSource").inputValue(), "1");
    assert.equal(await page.locator("#behaviorRows tr").count(), 10);
    await page.locator("#behaviorPageInput").fill("2");
    await page.locator("#behaviorPageGo").click();
    await page.locator("#behaviorRows").getByText("动作 10").waitFor();
    assert.equal(await page.locator("#behaviorRows tr").count(), 2);
    await page.locator("#behaviorExpand").click();
    await page.locator("#behaviorRows").getByText("动作 0").waitFor();
    assert.equal(await page.locator("#behaviorRows tr").count(), 12);
    assert.equal(await page.locator("#behaviorPageInput").isDisabled(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator("#demoLogEntries .demo-log-image").evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).width === `${node.parentElement.clientWidth}px`)), true);
    const mobileNavColumns = await page.locator(".sidebar nav").evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length);
    assert.equal(mobileNavColumns, 2);
    if (process.argv[2]) await page.screenshot({ path: path.join(process.argv[2], "behavior-mobile.png"), fullPage: true });
    assert.deepEqual(errors, []);
    console.log("adas-ui-change: timing ring, page order, menu sizing, detection default and behavior log pagination passed");
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
