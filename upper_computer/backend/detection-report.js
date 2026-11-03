"use strict";

const classes = {
  bdd: ["pedestrian", "rider", "car", "truck", "bus", "motorcycle", "bicycle"],
  road: ["center_dashline", "center_solidline"],
  traffic: ["Green_L_diaotou", "green", "green_L", "green_R", "green_Z_L", "green_non",
    "green_prson", "green_z", "red", "red_L", "red_L_diaotou", "red_R", "red_Z",
    "red_diaotou", "red_non", "red_person", "yellow"],
};

function normalizeDetectionReport(body, now = Date.now()) {
  if (!body || typeof body !== "object" || Array.isArray(body) || "image_base64" in body) {
    throw new Error("invalid_detection_report");
  }
  const { source, width, height, frame_sequence: sequence, detections } = body;
  if (!Number.isInteger(source) || source < 0 || source > 4 ||
      !Number.isSafeInteger(sequence) || sequence < 1 || !Array.isArray(detections) ||
      detections.length > 200 || width !== (source === 0 ? 1280 : 640) ||
      height !== (source === 0 ? 720 : 360) || body.inference_enabled !== true ||
      !Number.isFinite(body.detection_age_ms) || body.detection_age_ms < 0) {
    throw new Error("invalid_detection_report");
  }
  const boxes = detections.map((d) => {
    if (!d || !classes[d.model] || !Number.isInteger(d.class_id) || d.class_id < 0 ||
        d.class_id >= classes[d.model].length || d.class_name !== classes[d.model][d.class_id] ||
        ![d.confidence, d.left, d.top, d.right, d.bottom].every(Number.isFinite) ||
        d.confidence < 0 || d.confidence > 1 || d.left < 0 || d.top < 0 ||
        d.right > width || d.bottom > height || d.right <= d.left || d.bottom <= d.top) {
      throw new Error("invalid_detection_box");
    }
    return { model: d.model, class_id: d.class_id, class_name: d.class_name,
      confidence: d.confidence, left: d.left, top: d.top, right: d.right, bottom: d.bottom };
  });
  const base = { frame_sequence: sequence, detection_frame_sequence: sequence,
    captured_at: String(body.captured_at || "").slice(0, 80), inference_enabled: true,
    inference_ms: Number.isFinite(body.inference_ms) ? body.inference_ms : null,
    detection_age_ms: body.detection_age_ms, received_at_ms: now,
    detections_stale: body.detections_stale === true || body.detection_age_ms > 1000 };
  const reports = {};
  if (source !== 0) {
    reports[source] = { ...base, source, width, height, coordinate_space: "source_640x360", detections: boxes };
    return reports;
  }
  reports[0] = { ...base, source: 0, width, height, coordinate_space: "mosaic_1280x720", detections: boxes };
  for (let tile = 1; tile <= 4; tile++) {
    const x = ((tile - 1) % 2) * 640, y = Math.floor((tile - 1) / 2) * 360;
    const selected = boxes.filter((b) => {
      const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
      return cx >= x && cx < x + 640 && cy >= y && cy < y + 360;
    }).map((b) => ({ ...b, source: tile, left: Math.max(x, b.left) - x,
      top: Math.max(y, b.top) - y, right: Math.min(x + 640, b.right) - x,
      bottom: Math.min(y + 360, b.bottom) - y }));
    reports[tile] = { ...base, source: tile, width: 640, height: 360,
      coordinate_space: "source_640x360", detections: selected };
  }
  return reports;
}

function withFreshness(item, now = Date.now()) {
  const receiveAge = Math.max(0, now - item.received_at_ms);
  return { ...item, relay_age_ms: receiveAge, current_detection_age_ms: item.detection_age_ms + receiveAge,
    stale: item.detections_stale || receiveAge > 5000 };
}

module.exports = { normalizeDetectionReport, withFreshness };
