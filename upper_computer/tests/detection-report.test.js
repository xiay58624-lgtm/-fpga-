const assert = require("node:assert/strict");
const { normalizeDetectionReport, withFreshness } = require("../backend/detection-report");
const box = { model: "bdd", class_id: 2, class_name: "car", confidence: 0.73,
  left: 620, top: 380, right: 720, bottom: 440 };
const report = { source: 0, width: 1280, height: 720, frame_sequence: 42,
  inference_enabled: true, inference_ms: 150, detection_age_ms: 170, detections: [box] };
const normalized = normalizeDetectionReport(report, 1000);
assert.equal(normalized[4].detections.length, 1);
assert.deepEqual(normalized[4].detections[0], { ...box, source: 4, left: 0, top: 20, right: 80, bottom: 80 });
assert.equal(normalized[3].detections.length, 0);
assert.equal(withFreshness(normalized[4], 6500).stale, true);
assert.equal(withFreshness(normalized[4], 1100).stale, false);
assert.equal(normalizeDetectionReport({ ...report, detections: [] })[4].detections.length, 0);
for (const change of [{ confidence: 2 }, { confidence: NaN }, { class_id: 7 }, { class_name: "train" },
  { model: "road", class_id: 0, class_name: "left_arrow" }, { right: 1400 }]) {
  assert.throws(() => normalizeDetectionReport({ ...report, detections: [{ ...box, ...change }] }));
}
assert.throws(() => normalizeDetectionReport({ ...report, image_base64: "not-allowed" }));
assert.throws(() => normalizeDetectionReport({ ...report, frame_sequence: 0 }));
assert.throws(() => normalizeDetectionReport({ ...report, inference_enabled: false }));
console.log("Detection report contract PASS: independent JSON, class/range checks, tile isolation, expiry, empty frames");
