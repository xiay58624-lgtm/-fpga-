"use strict";

const DIRECTION_ACTIONS = Object.freeze({
  0: "straight",
  1: "left",
  2: "right",
  3: "stop",
  4: "lane_left",
  5: "lane_right",
});
// Existing ESP32 P2..P6 commands restart their timed route on each receipt.
// Repeat after the turning phases, just before the old route stops.
const REFRESH_MS = Object.freeze({straight:500,stop:500,alarm:500,left:4800,right:4800,lane_left:3200,lane_right:3200,uturn:5400});
function integer(value) {
  return value !== null && value !== undefined && value !== "" && Number.isInteger(Number(value)) ? Number(value) : -1;
}

function resolveRkVisionCommand(body) {
  const mode = ["adas", "navigation", "off"].includes(String(body?.mode || ""))
    ? String(body.mode)
    : "off";
  const enabled = body?.inference_enabled !== false && mode !== "off";
  const redSignal = enabled && (body?.alarm === true || String(body?.alarm_reason || "") === "red_light" || body?.arrow_state === "red");
  const forbidden = enabled && body?.forbidden === true;
  const slow = enabled && body?.slow === true;
  const reportedArrowState = ["green", "red", "yellow", "unknown", "off"]
    .includes(String(body?.arrow_state || ""))
    ? String(body.arrow_state)
    : "";
  const inferredDirection = integer(body?.inferred_direction);
  const selectedDirection = integer(body?.selected_direction);
  const direction = selectedDirection === 4 || selectedDirection === 5
    ? selectedDirection
    : inferredDirection;

  let arrowState = "off";
  if (enabled) {
    if (redSignal || forbidden) arrowState = "red";
    else if (reportedArrowState === "off") arrowState = "off";
    else if (reportedArrowState === "unknown") arrowState = "unknown";
    else if (body?.decision_valid !== false && Object.prototype.hasOwnProperty.call(DIRECTION_ACTIONS, direction)) arrowState = "green";
    else arrowState = "unknown";
  }

  const redLightReported = body?.alarm === true || String(body?.alarm_reason || "") === "red_light";
  // A blocked ADAS arrow keeps its direction while the car stops and alarms.
  // Selecting ordinary stop by itself is not a detection-triggered alarm.
  const alarm = mode === "adas" && enabled && arrowState === "red" &&
    ([0, 1, 2, 4, 5].includes(direction) || redLightReported);
  const action = !enabled
    ? "stop"
    : arrowState === "red"
      ? (alarm ? "alarm" : "stop")
    : direction === 3 ? "stop"
    : arrowState === "green"
      ? DIRECTION_ACTIONS[direction]
      : null;

  return {
    mode,
    enabled,
    alarm,
    redSignal,
    forbidden,
    slow,
    inferredDirection,
    selectedDirection,
    direction,
    arrowState,
    action,
    commandKey: action ? `${mode}|${action}` : "",
    refreshMs: REFRESH_MS[action] || 500,
  };
}

module.exports = { resolveRkVisionCommand, REFRESH_MS };
