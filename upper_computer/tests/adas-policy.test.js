const assert = require("node:assert/strict");
const { decide } = require("../adas-policy");

// Contest scenarios and failure boundaries, including simultaneous risks.
assert.equal(decide({ signal: "红灯", moving: false }).maneuver, "停车");
assert.equal(decide({ signal: "红灯", moving: false }).alarm, false);
assert.deepEqual(decide({ signal: "红灯", moving: true }).alarms, ["红灯强行行驶"]);
for (const [lane, action] of [["左车道", "左转"], ["直行车道", "直行"], ["右车道", "右转"]]) {
  assert.equal(decide({ signal: "绿灯", lane }).maneuver, action);
  const forcedNoLaneChange = decide({ signal: "绿灯", lane, lane_marking: "实线", forced_change: true, turn_signal: "关闭" });
  assert.equal(forcedNoLaneChange.maneuver, action,
    `Forced execution without a lane-change request must preserve the ${lane} route`);
  assert.equal(forcedNoLaneChange.alarm, false,
    "A lane-line restriction must not become a false alarm when no lane change was requested");
}
assert.equal(decide({ signal: "未知" }).maneuver, "停车");
assert.equal(decide({ signal: "黄灯" }).maneuver, "停车");
const forcedRedLane = decide({ signal: "红灯", lane: "左车道", turn_signal: "关闭", forced_change: true });
assert.equal(forcedRedLane.maneuver, "停车", "forced execution must not override a red light");
assert.deepEqual(forcedRedLane.alarms, ["红灯强行行驶"], "force without a lane-change request must not add a spurious lane-change alarm");
const forcedObstacleLane = decide({ signal: "绿灯", lane: "左车道", turn_signal: "关闭", forced_change: true, obstacle: true });
assert.equal(forcedObstacleLane.maneuver, "停车", "an obstacle still takes priority over a forced left-lane route");
assert.deepEqual(forcedObstacleLane.alarms, ["前方碰撞风险，请停车"]);
assert.equal(decide({ scene: "道路变道", lane_marking: "虚线", turn_signal: "左转向灯" }).maneuver, "左转");
assert.equal(decide({ scene: "道路变道", lane_marking: "虚线", turn_signal: "右转向灯" }).maneuver, "右转");
assert.equal(decide({ signal: "绿灯", lane_marking: "实线", left_lane_marking: "虚线", right_lane_marking: "实线", turn_signal: "左转向灯" }).maneuver, "左转",
  "A left lane change uses the left-side line report");
assert.equal(decide({ signal: "绿灯", lane_marking: "虚线", left_lane_marking: "虚线", right_lane_marking: "实线", turn_signal: "右转向灯", forced_change: true }).maneuver, "直行",
  "A right lane change is blocked by a solid right-side line even when the left line is dashed");
for (const marking of ["实线", "未知"]) {
  const denied = decide({ scene: "道路变道", lane_marking: marking, forced_change: true, turn_signal: "左转向灯" });
  assert.equal(denied.maneuver, "直行");
  assert.equal(denied.alarm, true, "Opening the turn signal must not bypass solid-line protection");
}
assert.deepEqual(decide({ scene: "道路变道", signal: "红灯", lane_marking: "虚线", turn_signal: "右转向灯" }).alarms,
  ["红灯强行行驶"], "The red-light alarm remains active while evaluating lane-change input");
assert.equal(decide({ obstacle: true, moving: false }).maneuver, "停车");
assert.equal(decide({ obstacle: true, moving: false }).alarm, false);
assert.equal(decide({ speed_kmh: 40, speed_limit_kmh: 40 }).alarm, false);
assert.deepEqual(decide({ signal: "红灯", moving: true, speed_kmh: 60, obstacle: true }).alarms,
  ["超速提醒", "红灯强行行驶", "前方碰撞风险，请停车"]);
const combined = decide({ signal: "红灯", moving: true, speed_kmh: 60, speed_limit_kmh: 40, lane_marking: "实线", turn_signal: "左转向灯", forced_change: true, obstacle: true });
assert.equal(combined.maneuver, "停车", "Obstacle and signal hazards must take priority over a requested turn");
assert.deepEqual(combined.alarms, ["超速提醒", "红灯强行行驶", "实线或未知车道线限制变道", "强制变道未执行", "前方碰撞风险，请停车"]);
assert.equal(decide({ scene: "夜间道路", maneuver: "右转", signal: "红灯" }).maneuver, "停车",
  "Signal, lane, obstacle and speed checks are shared across dashboard scenarios");
console.log("adas-policy: contest scenarios and combined-risk boundaries passed");
