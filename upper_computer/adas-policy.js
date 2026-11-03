(function (root) {
  "use strict";
  const defaults = Object.freeze({
    scene: "路口信号灯", lane: "直行车道", signal: "绿灯", lane_marking: "虚线",
    turn_signal: "关闭", speed_kmh: 30, speed_limit_kmh: 40,
    moving: true, forced_change: false, obstacle: false, maneuver: "直行",
  });
  function decide(input) {
    const s = { ...defaults, ...input };
    const alarms = [];
    const reasons = [];
    let action = s.maneuver;
    if (s.speed_kmh > s.speed_limit_kmh) alarms.push("超速提醒");
    const laneAction = s.turn_signal === "左转向灯" ? "左转" : s.turn_signal === "右转向灯" ? "右转" : "直行";
    // Force execution changes how an unsafe requested maneuver is handled; it must
    // not invent a lane-change request when the driver selected "不变道".
    const laneChangeRequested = s.turn_signal !== "关闭";
    const changeMarking = s.turn_signal === "左转向灯"
      ? (s.left_lane_marking || s.lane_marking)
      : s.turn_signal === "右转向灯"
        ? (s.right_lane_marking || s.lane_marking)
        : s.lane_marking;
    const laneAllowed = changeMarking === "虚线";
    const junctionAction = s.lane === "左车道" ? "左转" : s.lane === "右车道" ? "右转" : "直行";
    if (s.signal !== "绿灯") {
      action = "停车";
      reasons.push("非绿灯信号，建议停车");
      if (s.moving && s.signal === "红灯") alarms.push("红灯强行行驶");
      else if (s.moving) alarms.push("非绿灯行驶");
    } else {
      action = laneChangeRequested ? (laneAllowed ? laneAction : "直行") : junctionAction;
      reasons.push(laneChangeRequested ? (laneAllowed ? "目标侧虚线，按变道指令规划" : "目标侧车道线为实线或未上报，禁止变道") : "绿灯通行，按所在车道规划方向");
    }
    if (laneChangeRequested && !laneAllowed) alarms.push("实线或未知车道线限制变道");
    if (laneChangeRequested && s.forced_change && !laneAllowed) alarms.push("强制变道未执行");
    if (s.obstacle) {
      action = "停车";
      reasons.push("前方行人/障碍物风险，建议停车");
      if (s.moving) alarms.push("前方碰撞风险，请停车");
    }
    if (s.obstacle && s.moving) action = "停车";
    const reason = reasons.join("；") || "按照导航指令模拟行驶";
    return { ...s, maneuver: action, reason, alarm: alarms.length > 0, alarms,
      alarm_text: alarms.join("；"), input_source: "manual_console" };
  }
  const api = { defaults, decide };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AdasPolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
