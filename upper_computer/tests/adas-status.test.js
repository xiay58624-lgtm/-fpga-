const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const root = path.resolve(__dirname, "..");
let counter = 0;
const bj = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
function envelope() {
  const ms = Date.now();
  const id = "adas-test-" + (++counter);
  return { device: "rk3568", rk_device_id: "adas-test-device", event_id: id, report_id: id,
    report_schema: "rk3568.cloud_report.v1", report_type: "status", delivery_semantics: "at_least_once",
    report_created_at: bj(ms), report_created_at_ms: ms, time_bj: bj(ms) };
}
const data = {
  biz_system: "adas", input_mode: "sdcard", infer_mode: "env", capture_running: true,
  adas_schema: "pango_adas.v1", adas_input_source: "manual_console",
  adas_scene: "道路变道", adas_lane: "左车道", adas_signal: "红灯", adas_lane_marking: "实线",
  adas_maneuver: "直行", adas_turn_signal: "左转向灯", adas_speed_kmh: 30, adas_speed_limit_kmh: 40,
  adas_moving: true, adas_forced_change: true, adas_obstacle: false,
  adas_alarm: true, adas_alarm_text: "实线强制变道", adas_fpga_arm_link: "文件回放 · 未使用PCIe",
  adas_perception: { source: "rknn_environment", model: "best_rk3568.rknn",
    observed_at_ms: Date.now(), view_mode: 0, single_source: 1,
    counts: { zebra: 1, person: 2, red: 1, green: 0, black: 0, yellow: 0 },
    road_state: { signals: { left: "绿灯", straight: "红灯", right: "黄灯" }, obstacle: true,
      lane_markings: { left: "虚线", right: "实线" }, speed_limit_kmh: 50 } },
};
async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "adas-status-"));
  const backend = path.join(temp, "backend");
  fs.mkdirSync(backend);
  fs.copyFileSync(path.join(root, "backend/server.js"), path.join(backend, "server.js"));
  fs.copyFileSync(path.join(root, "backend/detection-report.js"), path.join(backend, "detection-report.js"));
  fs.copyFileSync(path.join(root, "backend/wifi-car-bridge.js"), path.join(backend, "wifi-car-bridge.js"));
  fs.copyFileSync(path.join(root, "backend/wifi-car-ws-bridge.js"), path.join(backend, "wifi-car-ws-bridge.js"));
  fs.copyFileSync(path.join(root, "adas.html"), path.join(temp, "adas.html"));
  const probe = http.createServer().listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  let child;
  function start() {
    child = spawn(process.execPath, ["server.js"], { cwd: backend, windowsHide: true,
      env: { ...process.env, NODE_PATH: path.join(root, "backend", "node_modules"), HOST: "127.0.0.1", PORT: String(port), MYSQL_ENABLED: "0", AI_ENGINE: "fake", RK_ALLOW_LEGACY_REPORTS: "0" },
      stdio: ["ignore", "pipe", "pipe"] });
  }
  async function stop() { if (child && child.exitCode === null) { const exit = once(child, "exit"); child.kill(); await exit; } }
  async function ready() {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch("http://127.0.0.1:" + port + "/api/ping")).ok) return; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("backend startup timeout");
  }
  async function post(overrides = {}) {
    const body = { ...envelope(), ...data, ...overrides };
    const response = await fetch("http://127.0.0.1:" + port + "/api/rk/report/status", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": body.event_id,
        "X-RK-Event-ID": body.event_id, "X-RK-Report-Attempt": "1" }, body: JSON.stringify(body) });
    return { response, json: await response.json() };
  }
  async function status() { return (await fetch("http://127.0.0.1:" + port + "/api/status")).json(); }
  try {
    start(); await ready();
    assert.match(await (await fetch("http://127.0.0.1:" + port + "/")).text(), /ADAS 驾驶感知工作台/);
    let wifi = await fetch("http://127.0.0.1:" + port + "/api/wifi-car/connect", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ host: "8.8.8.8", port: 8888 }),
    });
    assert.equal(wifi.status, 200, "cloud mode waits for the ESP32 to connect over WSS");
    wifi = await fetch("http://127.0.0.1:" + port + "/api/wifi-car/command", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "uturn" }),
    });
    assert.equal(wifi.status, 409, "supported U-turn action must be rejected only because the car is offline");
    assert.equal((await wifi.json()).error, "wifi_car_offline");
    wifi = await fetch("http://127.0.0.1:" + port + "/api/wifi-car/command", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "alarm" }),
    });
    assert.equal(wifi.status, 409, "firmware alarm action must be recognized and rejected only because the car is offline");
    assert.equal((await wifi.json()).error, "wifi_car_offline");
    let result = await post(); assert.equal(result.response.status, 200, JSON.stringify(result.json));
    const current = await status();
    assert.equal(current.biz_system, "adas"); assert.equal(current.adas.lane_marking, "实线");
    assert.equal(current.wifi_car.online, false); assert.equal(current.wifi_car.state, "waiting_for_device");
    assert.equal(current.adas.input_source, "manual_console"); assert.equal(current.adas.alarm, true);
    assert.equal(current.adas.perception.counts.person, 2);
    assert.equal(current.adas.perception.view_mode, 0);
    assert.deepEqual(current.adas.perception.road_state, { signals: { left: "绿灯", straight: "红灯", right: "黄灯" },
      obstacle: true, lane_markings: { left: "虚线", right: "实线" }, speed_limit_kmh: 50 });
    result = await post({ adas_perception: { ...data.adas_perception, road_state: { signals: { left: "green", straight: "red", right: "yellow" }, obstacle: false, lane_markings: { left: "dashed", right: "solid" }, speed_limit_kmh: 45 } } });
    assert.equal(result.response.status, 200, JSON.stringify(result.json));
    assert.deepEqual((await status()).adas.perception.road_state, { signals: { left: "绿灯", straight: "红灯", right: "黄灯" },
      obstacle: false, lane_markings: { left: "虚线", right: "实线" }, speed_limit_kmh: 45 });
    for (const [field, value] of [["adas_speed_kmh", "fast"], ["adas_speed_kmh", 999], ["adas_speed_kmh", 1.5],
      ["adas_alarm", "yes"], ["adas_signal", "<script>"], ["adas_perception", []]]) {
      result = await post({ [field]: value }); assert.equal(result.response.status, 400, JSON.stringify(result.json));
      assert.equal((await status()).adas.lane_marking, "实线", "invalid status cannot replace valid state");
    }
    await stop(); start(); await ready();
    assert.equal((await status()).adas.perception.counts.person, 2, "ADAS state survives backend restart");
    await new Promise((resolve) => setTimeout(resolve, 5));
    result = await post({ biz_system: "parking", adas_schema: undefined });
    assert.equal(result.response.status, 200, JSON.stringify(result.json));
    assert.equal((await status()).adas, undefined, "switching back to the old business mode clears ADAS");
    console.log("adas-status: strict report, persistence, invalid input and legacy-mode isolation passed");
  } finally {
    await stop();
    // temp was created by this test; all fixtures are contained under this exact path.
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
