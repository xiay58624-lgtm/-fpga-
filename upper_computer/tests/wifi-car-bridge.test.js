const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");
const { WifiCarBridge, validPrivateIpv4, ACTIONS } = require("../backend/wifi-car-bridge");

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function main() {
  assert.equal(validPrivateIpv4("192.168.4.1"), "192.168.4.1");
  assert.equal(validPrivateIpv4("8.8.8.8"), "");
  assert.deepEqual(ACTIONS, {
    left: "P2", straight: "P1", right: "P3", stop: "K",
    lane_left: "P4", lane_right: "P5", uturn: "P6", alarm: "H",
  }, "manual driving actions map to their corresponding firmware routes");

  const received = [];
  const mock = net.createServer((socket) => {
    let buffer = "";
    socket.write("WIFICAR ");
    setTimeout(() => socket.write("READY\r\nA=forward B=reverse\r\n"), 5);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const command of lines) {
        if (!command) continue;
        received.push(command);
        socket.write("TCP OK: " + command + "\r\n");
      }
    });
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  const port = mock.address().port;
  const bridge = new WifiCarBridge({ host: "127.0.0.1", port, allowPortOverride: true, reconnectMs: 30, ackTimeoutMs: 800 });
  try {
    bridge.connect({ host: "127.0.0.1", port });
    await waitFor(() => bridge.getStatus().online, "bridge did not accept WIFICAR READY");
    const straight = await bridge.sendAction("straight");
    assert.equal(straight.response, "TCP OK: P1");
    const left = await bridge.sendAction("left");
    assert.equal(left.response, "TCP OK: P2");
    const right = await bridge.sendAction("right");
    assert.equal(right.response, "TCP OK: P3");
    await bridge.sendAction("lane_left");
    await bridge.sendAction("lane_right");
    await bridge.sendAction("stop");
    const alarm = await bridge.sendAction("alarm");
    assert.equal(alarm.command, "H", "firmware H command stops the route and activates the alarm");
    const uturn = await bridge.sendAction("uturn");
    assert.equal(uturn.command, "P6");
    assert.ok(bridge.getStatus().supported_actions.includes("uturn"));
    assert.deepEqual(bridge.getStatus().unsupported_actions, []);
    assert.equal(bridge.getStatus().last_command, "uturn");
    await bridge.disconnect();
    assert.deepEqual(received, ["P1", "P2", "P3", "P4", "P5", "K", "H", "P6", "K"], "movement actions use P1-P3, H stops and alarms, disconnect sends stop");
    assert.equal(bridge.getStatus().state, "idle");
    console.log("wifi-car-bridge: handshake, P1-P6 movement/lane/uturn mapping, stop and disconnect passed");
  } finally {
    bridge.close();
    mock.close();
    await once(mock, "close");
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
