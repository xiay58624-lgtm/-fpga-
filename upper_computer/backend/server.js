const http = require("http");
const https = require("https");
const os = require("os");
const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const zlib = require("zlib");
const { createHash, randomUUID, timingSafeEqual } = require("crypto");
const { WebSocketServer } = require("ws");
const { WifiCarWsBridge } = require("./wifi-car-ws-bridge");
const { normalizeDetectionReport, withFreshness } = require("./detection-report");
const { resolveRkVisionCommand } = require("./rk-vision-command");
const { ContinuousRkController } = require("./rk-command-loop");
const { CommunicationLog } = require("./communication-log");
const rkDetectionToken = Buffer.from(process.env.RK_DETECTION_TOKEN || "");
const rkVisionToken = Buffer.from(process.env.RK_VISION_TOKEN || process.env.RK_DETECTION_TOKEN || "");

function nowBjText() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const instanceId = randomUUID();
const startedAt = nowBjText();
const communicationLog = new CommunicationLog({ instanceId });
const wifiCarBridge = new WifiCarWsBridge({ onTrace: (event) => communicationLog.append(event) });
const wifiCarDeviceToken = String(process.env.WIFICAR_DEVICE_TOKEN || "").trim();

function wifiCarControlOriginAllowed(req) {
  const origin = String(req?.headers?.origin || "").trim();
  if (origin) {
    try {
      return new URL(origin).host.toLowerCase() === String(req?.headers?.host || "").toLowerCase();
    } catch {
      return false;
    }
  }
  const remote = String(req?.socket?.remoteAddress || "").replace(/^::ffff:/i, "");
  return remote === "127.0.0.1" || remote === "::1";
}

function readBody(req, limitBytes) {
  const limit = Number.isFinite(limitBytes) ? limitBytes : 2_000_000;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
      try {
        req.destroy(err);
      } catch {}
    };
    req.on("data", (c) => {
      if (done) return;
      chunks.push(c);
      total += c.length;
      if (total > limit) {
        const err = new Error("body_too_large");
        err.code = "body_too_large";
        err.status = 413;
        err.limit = limit;
        fail(err);
      }
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      const buf = Buffer.concat(chunks);
      const ct = String(req.headers["content-type"] || "");
      const m = ct.match(/charset=([^;]+)/i);
      const charset = m ? String(m[1]).trim().toLowerCase() : "utf-8";
      const bomUtf16le = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
      const enc = charset.includes("utf-16") || bomUtf16le ? "utf16le" : "utf8";
      resolve(buf.toString(enc));
    });
    req.on("error", (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

function readBodyBuffer(req, limitBytes) {
  const limit = Number.isFinite(limitBytes) ? limitBytes : 200_000_000;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
      try {
        req.destroy(err);
      } catch {}
    };
    req.on("data", (c) => {
      if (done) return;
      chunks.push(c);
      total += c.length;
      if (total > limit) {
        const err = new Error("body_too_large");
        err.code = "body_too_large";
        err.status = 413;
        err.limit = limit;
        fail(err);
      }
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

function sanitizeFileName(name) {
  const s = String(name || "file").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  return s.length > 120 ? s.slice(-120) : s;
}

function parseMultipartSingleFile(buf, boundary) {
  const b = Buffer.from(`--${boundary}`);
  const start = buf.indexOf(b);
  if (start < 0) return null;
  const headStart = start + b.length + 2;
  const headEnd = buf.indexOf(Buffer.from("\r\n\r\n"), headStart);
  if (headEnd < 0) return null;
  const headText = buf.slice(headStart, headEnd).toString("utf8");
  const fileNameMatch = headText.match(/filename="([^"]*)"/i);
  const ctMatch = headText.match(/content-type:\s*([^\r\n]+)/i);
  const fileName = fileNameMatch ? fileNameMatch[1] : "file";
  const contentType = ctMatch ? ctMatch[1].trim() : "application/octet-stream";
  const dataStart = headEnd + 4;
  const next = buf.indexOf(b, dataStart);
  if (next < 0) return null;
  const dataEnd = next - 2;
  const data = buf.slice(dataStart, dataEnd >= dataStart ? dataEnd : dataStart);
  return { fileName, contentType, data };
}

function parseMultipartFiles(buf, boundary) {
  const marker = Buffer.from(`--${boundary}`);
  const files = [];
  let pos = 0;
  while (pos < buf.length) {
    const start = buf.indexOf(marker, pos);
    if (start < 0) break;
    pos = start + marker.length;
    if (buf.slice(pos, pos + 2).toString("utf8") === "--") break;
    if (buf.slice(pos, pos + 2).toString("utf8") === "\r\n") pos += 2;
    const headEnd = buf.indexOf(Buffer.from("\r\n\r\n"), pos);
    if (headEnd < 0) break;
    const headText = buf.slice(pos, headEnd).toString("utf8");
    const nameMatch = headText.match(/name="([^"]*)"/i);
    const fileNameMatch = headText.match(/filename="([^"]*)"/i);
    const ctMatch = headText.match(/content-type:\s*([^\r\n]+)/i);
    const dataStart = headEnd + 4;
    const next = buf.indexOf(marker, dataStart);
    if (next < 0) break;
    const dataEnd = next - 2;
    if (fileNameMatch) {
      files.push({
        fieldName: nameMatch ? nameMatch[1] : "file",
        fileName: fileNameMatch[1] || "file",
        contentType: ctMatch ? ctMatch[1].trim() : "application/octet-stream",
        data: buf.slice(dataStart, dataEnd >= dataStart ? dataEnd : dataStart),
      });
    }
    pos = next;
  }
  return files;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(
    res,
    status,
    {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    JSON.stringify(obj),
  );
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  send(res, status, { "Content-Type": contentType, "Cache-Control": "no-store" }, text);
}

function sendCaptureJpeg(req, res, buf, cacheKey) {
  const safeKey = String(cacheKey || "capture").replace(/[^A-Za-z0-9_.-]/g, "_");
  const etag = `"${safeKey}-${buf.length}"`;
  const headers = {
    "Content-Type": "image/jpeg",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Length": String(buf.length),
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };
  const requestEtags = String(req?.headers?.["if-none-match"] || "")
    .split(",")
    .map((value) => value.trim());
  if (requestEtags.includes(etag) || requestEtags.includes("*")) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  send(res, 200, headers, buf);
}

function withCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Idempotency-Key, X-RK-Event-ID, X-RK-Device-ID, X-RK-Report-Attempt",
  );
  if (req.method === "OPTIONS") {
    send(res, 204, {}, "");
    return true;
  }
  return false;
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function parseNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function stripBase64DataUri(value) {
  return String(value || "").trim().replace(/^data:[^,;]+;base64,/i, "");
}

function confToPercent(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Number(clamp(n <= 1 ? n * 100 : n, 0, 100).toFixed(1));
}

function confidencePercent(percentValue, rawValue) {
  if (percentValue !== null && percentValue !== undefined && percentValue !== "") {
    const percent = Number(percentValue);
    if (Number.isFinite(percent)) return Number(clamp(percent, 0, 100).toFixed(1));
  }
  return confToPercent(rawValue);
}

function compactPlateConfidenceItem(item) {
  if (!item || typeof item !== "object") return null;
  const detConfPct = confidencePercent(item.det_conf_pct, item.det_conf);
  const recConfPct = confidencePercent(item.rec_conf_pct, item.rec_conf ?? item.conf);
  if (detConfPct === null && recConfPct === null) return null;
  return {
    id: String(item.id || ""),
    time_bj: String(item.time_bj || item.time || ""),
    plate: String(item.plate || ""),
    det_conf_pct: detConfPct,
    rec_conf_pct: recConfPct,
  };
}

function mergePlateConfidenceItems(sourceLists, limit) {
  const merged = new Map();
  let fallbackIndex = 0;
  for (const source of sourceLists) {
    for (const raw of Array.isArray(source) ? source : []) {
      const item = compactPlateConfidenceItem(raw);
      if (!item) continue;
      const key = item.id || `${item.time_bj}\u0000${item.plate}\u0000${fallbackIndex++}`;
      const current = merged.get(key);
      if (!current) {
        merged.set(key, item);
        continue;
      }
      if (current.det_conf_pct === null && item.det_conf_pct !== null) current.det_conf_pct = item.det_conf_pct;
      if (current.rec_conf_pct === null && item.rec_conf_pct !== null) current.rec_conf_pct = item.rec_conf_pct;
      if (!current.time_bj && item.time_bj) current.time_bj = item.time_bj;
      if (!current.plate && item.plate) current.plate = item.plate;
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => String(b.time_bj || "").localeCompare(String(a.time_bj || "")))
    .slice(0, limit)
    .reverse();
}

function wildcardMatch(text, pattern) {
  const t = String(text ?? "");
  const p = String(pattern ?? "");
  if (!p) return true;
  if (p === "*") return true;
  const rx = new RegExp(
    "^" +
      p
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
    "i",
  );
  return rx.test(t);
}

function csvEscape(v) {
  const raw = String(v ?? "");
  // Spreadsheet applications may execute cells beginning with formula
  // sigils even when the value is quoted as valid CSV.  Prefix user-supplied
  // string cells with an apostrophe; numeric values keep their native form.
  const s = typeof v === "string" && /^[\t ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, headers) {
  const head = headers.map((header) => csvEscape(header)).join(",");
  const lines = rows.map((r) => headers.map((h) => csvEscape(r[h])).join(","));
  return [head, ...lines].join("\n");
}

function toJsonl(rows) {
  const items = Array.isArray(rows) ? rows : [];
  return items.length ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n` : "";
}

function rkJournalTimeMs(item) {
  const numeric = Number(item?.report_created_at_ms ?? item?.snapshot_at_ms);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = parseRkBeijingTimestamp(item?.time_bj || item?.report_created_at);
  return parsed === null ? 0 : parsed;
}

function rkJournalMatches(item, q) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const eventId = String(item.event_id || item.report_id || "");
  const deviceId = String(item.rk_device_id || "");
  const nestedBusinessRows = ["parking", "etc"].flatMap((system) => {
    const snapshot = item?.business_snapshot?.[system];
    if (!snapshot || typeof snapshot !== "object") return [];
    return [...(Array.isArray(snapshot.accounts) ? snapshot.accounts : []), ...(Array.isArray(snapshot.records) ? snapshot.records : [])];
  });
  const plates = [String(item.plate || ""), ...nestedBusinessRows.map((row) => String(row?.plate || ""))].filter(Boolean);
  const start = String(q.get("start") || "").trim();
  const end = String(q.get("end") || "").trim();
  if (q.get("event_id") && eventId !== q.get("event_id")) return false;
  if (q.get("rk_device_id") && deviceId !== q.get("rk_device_id")) return false;
  if (q.get("biz_system")) {
    const system = String(q.get("biz_system")).trim().toLowerCase();
    const hasSystem = String(item.biz_system || "").trim().toLowerCase() === system
      || Boolean(item?.[system])
      || Boolean(item?.business_snapshot?.[system]);
    if (!hasSystem) return false;
  }
  if (q.get("event_type") && String(item.event_type || "") !== q.get("event_type")) return false;
  if (q.get("plate") && !plates.some((plate) => wildcardMatch(plate, q.get("plate")))) return false;
  const day = String(item.time_bj || item.report_created_at || "").slice(0, 10);
  if ((start || end) && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  if (start && day < start) return false;
  if (end && day > end) return false;
  return true;
}

function rkJournalQueryProblem(q, { pagination = true } = {}) {
  const requestedSystem = String(q.get("biz_system") || "").trim().toLowerCase();
  if (requestedSystem && !["parking", "etc"].includes(requestedSystem)) {
    return { error: "bad_biz_system", message: "biz_system must be parking or etc" };
  }
  const start = String(q.get("start") || "").trim();
  const end = String(q.get("end") || "").trim();
  for (const [field, value] of [["start", start], ["end", end]]) {
    if (!value) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || parseRkBeijingTimestamp(`${value} 00:00:00`) === null) {
      return { error: "bad_date_filter", field, message: `${field} must be a valid date in yyyy-MM-dd format` };
    }
  }
  if (start && end && start > end) return { error: "bad_time_range", message: "start must not be later than end" };
  if (!pagination) return null;
  for (const [field, min] of [["limit", 1], ["offset", 0]]) {
    const value = q.get(field);
    if (value === null || value === "") continue;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min) {
      return { error: "bad_pagination", field, message: `${field} must be an integer >= ${min}` };
    }
  }
  return null;
}

function dedupeRkJournalRows(rows) {
  const keyed = new Map();
  const unkeyed = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const eventId = String(row.event_id || row.report_id || "");
    const deviceId = String(row.rk_device_id || "");
    const key = eventId ? `${deviceId}\u0000${eventId}` : "";
    if (!key) {
      unkeyed.push(row);
      continue;
    }
    const current = keyed.get(key);
    if (!current || rkJournalTimeMs(row) >= rkJournalTimeMs(current)) keyed.set(key, row);
  }
  return [...keyed.values(), ...unkeyed];
}

function sortRkJournalRows(rows) {
  return (Array.isArray(rows) ? rows : []).slice().sort((a, b) => rkJournalTimeMs(b) - rkJournalTimeMs(a));
}

function pageRkJournalRows(rows, q) {
  const sorted = sortRkJournalRows(dedupeRkJournalRows(rows));
  const total = sorted.length;
  const limit = clamp(q.get("limit") === null || q.get("limit") === "" ? 100 : Number(q.get("limit")), 1, 5000);
  const offset = clamp(q.get("offset") === null || q.get("offset") === "" ? 0 : Number(q.get("offset")), 0, 2_000_000);
  return {
    items: sorted.slice(offset, offset + limit),
    total,
    limit,
    offset,
    has_more: offset + limit < total,
  };
}

function readRkUserMessageJournal(q) {
  return readJsonlAll(path.join(logRoot, "user_messages.jsonl"), 120_000_000)
    .filter((item) => rkJournalMatches(item, q));
}

function readRkBusinessEventJournal(q) {
  return readJsonlAll(path.join(logRoot, "business_events.jsonl"), 240_000_000)
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .filter((item) => Boolean(item.event_id || item.report_id))
    .filter((item) => String(item.report_type || "business") === "business")
    .filter((item) => rkJournalMatches(item, q));
}

function stripRkJournalPayload(item, { includeSnapshot = false } = {}) {
  const copy = item && typeof item === "object" && !Array.isArray(item) ? { ...item } : {};
  // Images are deliberately represented by managed URLs/paths everywhere in
  // history APIs.  This prevents a JSONL export from ballooning or leaking
  // the original request body while preserving the rest of the contract.
  delete copy.image_jpeg_base64;
  delete copy.thumb_jpeg_base64;
  delete copy.imageJpeg;
  delete copy.thumbJpeg;
  if (copy.business_snapshot && !includeSnapshot) {
    copy.snapshot_available = true;
    delete copy.business_snapshot;
  }
  return copy;
}

const RK_USER_MESSAGE_EXPORT_HEADERS = [
  "id", "device", "rk_device_id", "event_id", "report_id", "report_schema", "report_type", "delivery_semantics",
  "report_created_at", "report_created_at_ms", "report_attempt", "time_bj", "role", "user_state", "biz_system",
  "event_type", "template_key", "template_version", "config_version", "display_text", "broadcast_text", "source",
  "source_index", "plate", "plate_normalized", "color", "vehicle_type", "vehicle_type_code", "plate_category",
  "plate_category_code", "plate_category_rule", "plate_category_rule_version", "det_conf", "rec_conf", "conf",
  "target_device_id", "pay_status", "fee", "paid_from_balance", "need_pay", "balance_after", "arrears_after",
  "duration_minutes", "duration_text",
];
const RK_BUSINESS_EVENT_EXPORT_HEADERS = [
  "device", "rk_device_id", "event_id", "report_id", "report_schema", "report_type", "delivery_semantics",
  "report_created_at", "report_created_at_ms", "report_attempt", "time_bj", "parking", "etc", "persistence",
  "business_snapshot", "snapshot_available",
];

function sendRkJournalExport(res, rows, format, filename, baseHeaders = []) {
  const safeFormat = String(format || "csv").trim().toLowerCase();
  if (safeFormat === "jsonl") {
    send(res, 200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}.jsonl"`,
      "Cache-Control": "no-store",
    }, toJsonl(rows));
    return true;
  }
  if (safeFormat !== "csv") return false;
  const headers = Array.from(new Set([
    ...baseHeaders,
    ...rows.flatMap((row) => Object.keys(row || {})),
  ]))
    .filter((key) => /^[A-Za-z0-9_.-]{1,120}$/.test(key));
  const normalized = rows.map((row) => {
    const out = {};
    for (const key of headers) {
      const value = row?.[key];
      out[key] = value && typeof value === "object" ? JSON.stringify(value) : value;
    }
    return out;
  });
  send(res, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}.csv"`,
    "Cache-Control": "no-store",
  }, toCsv(normalized, headers));
  return true;
}

const staticRoot = path.resolve(__dirname, "..");
const logRoot = path.resolve(staticRoot, "log");
const rkStatusSnapshotPath = path.join(logRoot, "rk_status_latest.json");
const rkStatusPendingRoot = path.join(logRoot, "rk_status_pending");
const rkStatusPendingQuarantineRoot = path.join(rkStatusPendingRoot, "quarantine");

// The static fallback serves public assets only. Runtime code, credentials,
// uploaded models, and operational logs must stay behind API handlers.
const blockedStaticPrefixes = new Set([
  "/backend",
  "/log",
  "/exp",
  "/model",
  "/models",
  "/uploads",
  "/tts-zh_en",
  "/wechat-miniprogram",
  "/.git",
  "/.codex",
]);
const blockedStaticFileNames = new Set([
  "mysql-config.json",
  "ai-model-defaults.json",
  "llm_config.json",
  "esp32_config.json",
  "rk_user_message_config.json",
  "business_latest.json",
]);

function isBlockedStaticPath(safeRel) {
  const normalized = String(safeRel || "")
    .replace(/\\+/g, "/")
    .replace(/\/+/g, "/")
    .toLowerCase();
  if (!normalized || normalized === "/") return false;
  for (const prefix of blockedStaticPrefixes) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return true;
  }
  const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
  return blockedStaticFileNames.has(fileName);
}

try {
  if (!fs.existsSync(logRoot)) fs.mkdirSync(logRoot, { recursive: true });
} catch {}

function ensureDirSync(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

const captureRoot = path.resolve(logRoot, "captures");
const violationImageDir = path.resolve(captureRoot, "violations");
const plateImageDir = path.resolve(captureRoot, "plates");
const miniUploadDir = path.resolve(captureRoot, "mini");
const adasBehaviorImageDir = path.resolve(captureRoot, "adas-behavior");
ensureDirSync(captureRoot);
ensureDirSync(violationImageDir);
ensureDirSync(plateImageDir);
ensureDirSync(miniUploadDir);
ensureDirSync(adasBehaviorImageDir);

function persistAdasBehavior(action, behavior, result) {
  const category = ["left", "right", "uturn"].includes(action) ? "turn"
    : ["lane_left", "lane_right"].includes(action) ? "lane_change"
      : action === "alarm" ? "violation_warning" : "";
  if (!category || !behavior || behavior.category !== category) return null;
  const labels = { left: "左转", right: "右转", uturn: "掉头", lane_left: "向左变道", lane_right: "向右变道", alarm: "违规停车并报警" };
  const id = randomUUID();
  let evidenceId = "";
  const dataUrl = String(behavior.evidence_jpeg || "");
  const match = dataUrl.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (match && match[1].length <= 220_000) {
    const image = Buffer.from(match[1], "base64");
    if (image.length > 0 && image.length <= 160_000) {
      try {
        fs.writeFileSync(path.join(adasBehaviorImageDir, `${id}.jpg`), image, { flag: "wx", mode: 0o640 });
        evidenceId = id;
      } catch {}
    }
  }
  const source = ["manual", "decision", "automatic"].includes(String(behavior.source || "")) ? behavior.source : "manual";
  const executed = result?.ok === true && Boolean(result.response);
  const entry = {
    id,
    time: nowBjText(),
    category,
    action,
    action_label: labels[action],
    source,
    executed,
    forced: behavior.forced === true,
    warning: category === "violation_warning",
    execution_detail: executed ? "ESP32 已确认" : String(result?.response || "未收到 ESP32 确认").slice(0, 160),
    evidence_id: evidenceId,
  };
  if (!appendDurableJsonLine(path.join(logRoot, "adas_behavior_logs.jsonl"), entry)) {
    if (evidenceId) {
      try { fs.unlinkSync(path.join(adasBehaviorImageDir, `${evidenceId}.jpg`)); } catch {}
    }
    return false;
  }
  return true;
}

const userMessageConfigPath = path.join(logRoot, "rk_user_message_config.json");
const esp32ConfigPath = path.join(logRoot, "esp32_config.json");
const miniBlacklistPath = path.join(logRoot, "mini_blacklist.json");
const initialEsp32Config = loadEsp32Config();

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  const fb = Number(fallback);
  const base = Number.isFinite(n) ? n : Number.isFinite(fb) ? fb : min;
  return clamp(Math.round(base), min, max);
}

function defaultEsp32Config() {
  return {
    schema: "esp32.servo_config.v1",
    version: 1,
    updated_at: nowBjText(),
    host: String(process.env.ESP32_HOST || "").trim(),
    port: clampNum(process.env.ESP32_PORT || "80", 1, 65535, 80),
    device_id: cleanDeviceId(process.env.ESP32_DEVICE_ID || "esp32-servo-01", "esp32-servo-01"),
    mac: String(process.env.ESP32_MAC || "").trim(),
    heartbeat_ms: clampNum(process.env.ESP32_HEARTBEAT_MS || "3000", 500, 120000, 3000),
    command_poll_ms: clampNum(process.env.ESP32_COMMAND_POLL_MS || "1000", 200, 120000, 1000),
    timeout_ms: clampNum(process.env.ESP32_TIMEOUT_MS || "1500", 300, 15000, 1500),
    angle: clampNum(process.env.ESP32_SERVO_ANGLE || "90", 0, 180, 90),
    hold_ms: clampNum(process.env.ESP32_SERVO_HOLD_MS || "1000", 100, 60000, 1000),
    return_angle: clampNum(process.env.ESP32_SERVO_RETURN_ANGLE || "0", 0, 180, 0),
    return_enabled: String(process.env.ESP32_SERVO_RETURN_ENABLED || "1").trim() !== "0",
    gate_enabled: String(process.env.ESP32_GATE_ENABLED || "0").trim() === "1",
    gate_open_angle: clampNum(process.env.ESP32_GATE_OPEN_ANGLE || process.env.ESP32_SERVO_ANGLE || "90", 0, 180, 90),
    gate_close_angle: clampNum(process.env.ESP32_GATE_CLOSE_ANGLE || process.env.ESP32_SERVO_RETURN_ANGLE || "0", 0, 180, 0),
    gate_hold_ms: clampNum(process.env.ESP32_GATE_HOLD_MS || "20000", 1000, 300000, 20000),
    servo_gpio: clampNum(process.env.ESP32_SERVO_GPIO || "13", 0, 48, 13),
    pwm_hz: clampNum(process.env.ESP32_SERVO_PWM_HZ || "50", 40, 400, 50),
    min_pulse_us: clampNum(process.env.ESP32_SERVO_MIN_US || "500", 100, 3000, 500),
    max_pulse_us: clampNum(process.env.ESP32_SERVO_MAX_US || "2500", 500, 4000, 2500),
    offline_timeout_ms: clampNum(process.env.ESP32_ONLINE_MS || "10000", 1000, 120000, 10000),
    config_pull_ms: clampNum(process.env.ESP32_CONFIG_PULL_MS || "10000", 1000, 600000, 10000),
  };
}

function normalizeEsp32Config(input, { bumpVersion = false, baseConfig = null } = {}) {
  const defaults = defaultEsp32Config();
  const base = baseConfig && typeof baseConfig === "object" && !Array.isArray(baseConfig) ? { ...defaults, ...baseConfig } : defaults;
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const hostRaw = String(src.host ?? src.ip ?? base.host ?? "").trim();
  const safeHost = hostRaw ? safeHostText(hostRaw) : "";
  const minPulse = clampNum(src.min_pulse_us ?? src.minPulseUs ?? base.min_pulse_us, 100, 3000, base.min_pulse_us);
  const maxPulse = clampNum(src.max_pulse_us ?? src.maxPulseUs ?? base.max_pulse_us, Math.max(500, minPulse + 50), 4000, base.max_pulse_us);
  const versionIn = Number(src.version ?? base.version ?? 1);
  const nextVersion = bumpVersion ? Math.max(1, Math.floor(Number(base.version || 1)) + 1) : Number.isFinite(versionIn) && versionIn > 0 ? Math.floor(versionIn) : 1;
  return {
    schema: "esp32.servo_config.v1",
    version: nextVersion,
    updated_at: bumpVersion ? nowBjText() : String(src.updated_at || base.updated_at || nowBjText()).slice(0, 80),
    host: safeHost,
    port: clampNum(src.port ?? base.port, 1, 65535, base.port),
    device_id: cleanDeviceId(src.device_id || src.deviceId || src.device || base.device_id, base.device_id || "esp32-servo-01"),
    mac: String(src.mac ?? base.mac ?? "").trim().slice(0, 80),
    heartbeat_ms: clampNum(src.heartbeat_ms ?? src.heartbeatMs ?? base.heartbeat_ms, 500, 120000, base.heartbeat_ms),
    command_poll_ms: clampNum(src.command_poll_ms ?? src.poll_ms ?? src.commandPollMs ?? base.command_poll_ms, 200, 120000, base.command_poll_ms),
    timeout_ms: clampNum(src.timeout_ms ?? src.timeoutMs ?? base.timeout_ms, 300, 15000, base.timeout_ms),
    angle: clampNum(src.angle ?? base.angle, 0, 180, base.angle),
    hold_ms: clampNum(src.hold_ms ?? src.holdMs ?? base.hold_ms, 100, 60000, base.hold_ms),
    return_angle: clampNum(src.return_angle ?? src.returnAngle ?? base.return_angle, 0, 180, base.return_angle),
    return_enabled: typeof src.return_enabled === "boolean" ? src.return_enabled : typeof src.returnEnabled === "boolean" ? src.returnEnabled : base.return_enabled !== false,
    gate_enabled: typeof src.gate_enabled === "boolean" ? src.gate_enabled : typeof src.gateEnabled === "boolean" ? src.gateEnabled : base.gate_enabled === true,
    gate_open_angle: clampNum(src.gate_open_angle ?? src.gateOpenAngle ?? base.gate_open_angle, 0, 180, base.gate_open_angle),
    gate_close_angle: clampNum(src.gate_close_angle ?? src.gateCloseAngle ?? base.gate_close_angle, 0, 180, base.gate_close_angle),
    gate_hold_ms: clampNum(src.gate_hold_ms ?? src.gateHoldMs ?? base.gate_hold_ms, 1000, 300000, base.gate_hold_ms),
    servo_gpio: clampNum(src.servo_gpio ?? src.servoGpio ?? src.gpio ?? base.servo_gpio, 0, 48, base.servo_gpio),
    pwm_hz: clampNum(src.pwm_hz ?? src.pwmHz ?? base.pwm_hz, 40, 400, base.pwm_hz),
    min_pulse_us: minPulse,
    max_pulse_us: maxPulse,
    offline_timeout_ms: clampNum(src.offline_timeout_ms ?? src.offlineTimeoutMs ?? base.offline_timeout_ms, 1000, 120000, base.offline_timeout_ms),
    config_pull_ms: clampNum(src.config_pull_ms ?? src.configPullMs ?? base.config_pull_ms, 1000, 600000, base.config_pull_ms),
  };
}

function loadEsp32Config() {
  try {
    if (fs.existsSync(esp32ConfigPath) && fs.statSync(esp32ConfigPath).isFile()) {
      return normalizeEsp32Config(safeJsonParse(fs.readFileSync(esp32ConfigPath, "utf8")) || {});
    }
  } catch {}
  return normalizeEsp32Config(defaultEsp32Config());
}

function saveEsp32Config(cfg) {
  const normalized = normalizeEsp32Config(cfg, { bumpVersion: true });
  try {
    const tmp = `${esp32ConfigPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), "utf8");
    fs.renameSync(tmp, esp32ConfigPath);
  } catch {}
  return normalized;
}

function defaultUserMessageConfig() {
  return {
    schema: "rk3568.user_message_config.v1",
    version: 1,
    updated_at: nowBjText(),
    templates: {
      parking: {
        entry: "欢迎车牌{plate}进入停车场",
        exit_free: "车牌{plate}离场，停车{duration}，本次免费",
        exit_deducted: "车牌{plate}离场，停车{duration}，费用{fee}元，已扣费{paid}元",
        exit_insufficient: "车牌{plate}离场，费用{fee}元，请扫码支付{need_pay}元",
        exit_not_opened: "车牌{plate}未开通账户，请扫码支付{fee}元",
        arrears_suffix: "，欠费{arrears}元",
      },
      etc: {
        pass_deducted: "车牌{plate}，ETC通行费{fee}元，已扣费{paid}元",
        pass_insufficient: "车牌{plate}，ETC余额不足，请支付{need_pay}元",
        pass_not_opened: "车牌{plate}未开通ETC，请支付{fee}元",
        arrears_suffix: "，欠费{arrears}元",
      },
    },
  };
}

function cleanUserTemplate(v, maxLen = 300) {
  const s = String(v ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function normalizeUserMessageConfig(input, { bumpVersion = false, baseConfig = null } = {}) {
  const defaults = defaultUserMessageConfig();
  const base = baseConfig && typeof baseConfig === "object" && !Array.isArray(baseConfig)
    ? normalizeUserMessageConfig(baseConfig)
    : defaults;
  const src0 = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const src = src0.config && typeof src0.config === "object" && !Array.isArray(src0.config) ? src0.config : src0;
  const out = JSON.parse(JSON.stringify(base));
  const incomingTemplates =
    src.templates && typeof src.templates === "object" && !Array.isArray(src.templates)
      ? src.templates
      : { parking: src.parking, etc: src.etc };
  const allowed = {
    parking: Object.keys(defaults.templates.parking),
    etc: Object.keys(defaults.templates.etc),
  };
  for (const system of Object.keys(allowed)) {
    const sysObj = incomingTemplates?.[system];
    if (!sysObj || typeof sysObj !== "object" || Array.isArray(sysObj)) continue;
    for (const key of allowed[system]) {
      if (!Object.prototype.hasOwnProperty.call(sysObj, key)) continue;
      const text = cleanUserTemplate(sysObj[key]);
      if (text) out.templates[system][key] = text;
    }
  }
  const version = Number(src.version);
  out.version = Number.isFinite(version) && version > 0 ? Math.floor(version) : 1;
  if (bumpVersion) out.version = Math.max(out.version, Number(rkUserMessageConfig?.version || 1) + 1);
  out.updated_at = cleanUserTemplate(src.updated_at, 80) || nowBjText();
  if (bumpVersion) out.updated_at = nowBjText();
  return out;
}

function loadUserMessageConfig() {
  try {
    if (fs.existsSync(userMessageConfigPath)) {
      return normalizeUserMessageConfig(JSON.parse(fs.readFileSync(userMessageConfigPath, "utf8")));
    }
  } catch {}
  return defaultUserMessageConfig();
}

function saveUserMessageConfig(cfg) {
  const normalized = normalizeUserMessageConfig(cfg);
  try {
    fs.writeFileSync(userMessageConfigPath, JSON.stringify(normalized, null, 2), "utf8");
  } catch {}
  return normalized;
}

let rkUserMessageConfig = loadUserMessageConfig();

const llmConfigPath = path.join(logRoot, "llm_config.json");

function normalizeLlmProvider(v, fallback = "deepseek") {
  const s = String(v || "").trim().toLowerCase();
  return ["deepseek", "openai", "siliconflow"].includes(s) ? s : fallback;
}

function normalizeLlmBaseUrl(v, provider = "deepseek") {
  let s = String(v || "").trim().replace(/\/+$/, "");
  if (provider === "deepseek") {
    if (!s || s.includes("www.deepseek.com")) s = "https://api.deepseek.com";
  }
  return s;
}

function normalizeLlmModel(v, provider = "deepseek") {
  let s = String(v || "").trim();
  if (provider === "deepseek") {
    if (!s) s = "deepseek-chat";
    if (s === "deepseek_chat") s = "deepseek-chat";
  }
  return s;
}

function sanitizeLlmApiKey(v) {
  let s = String(v || "").trim();
  if (!s) return "";
  s = s.replace(/^Bearer\s+/i, "").trim();
  s = s.replace(/\/v1\/?$/i, "").trim();
  return s;
}

function normalizeLlmConfig(input, fallback = {}) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const provider = normalizeLlmProvider(src.provider, normalizeLlmProvider(fallback.provider));
  return {
    provider,
    base_url: normalizeLlmBaseUrl(src.base_url ?? fallback.base_url, provider),
    model: normalizeLlmModel(src.model ?? fallback.model, provider),
    api_key: sanitizeLlmApiKey(src.api_key ?? fallback.api_key ?? ""),
  };
}

function llmApiKeyProblem(apiKey) {
  const s = String(apiKey || "").trim();
  if (!s) return "missing";
  if (/^https?:\/\//i.test(s)) return "api_key_is_url";
  if (/\/v1\b/i.test(s) || /deepseek\.com/i.test(s)) return "api_key_looks_like_endpoint";
  if (s.length < 16) return "api_key_too_short";
  return "";
}

function publicLlmConfig(cfg) {
  const c = normalizeLlmConfig(cfg);
  return {
    provider: c.provider,
    base_url: c.base_url,
    model: c.model,
    api_key_set: Boolean(c.api_key),
  };
}

function publicVoiceConfig(cfg) {
  const c = normalizeLlmConfig(cfg);
  return {
    provider: c.provider,
    base_url: c.base_url,
    model: c.model,
    api_key_set: Boolean(c.api_key),
  };
}

const siliconflowTtsDefaults = {
  provider: "siliconflow",
  base_url: "https://api.siliconflow.cn",
  model: "fnlp/MOSS-TTSD-v0.5",
  voice: "fnlp/MOSS-TTSD-v0.5:anna",
  response_format: "mp3",
  api_key: "",
};

function normalizeSiliconflowTtsConfig(input, fallback = {}) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const fb = fallback && typeof fallback === "object" ? fallback : {};
  const base = String(src.base_url ?? fb.base_url ?? siliconflowTtsDefaults.base_url).trim().replace(/\/+$/, "") || siliconflowTtsDefaults.base_url;
  const model = String(src.model ?? fb.model ?? siliconflowTtsDefaults.model).trim() || siliconflowTtsDefaults.model;
  let voice = String(src.voice ?? fb.voice ?? `${model}:anna`).trim();
  if (!voice) voice = `${model}:anna`;
  if (!voice.includes(":")) voice = `${model}:${voice}`;
  const fmt = String(src.response_format ?? fb.response_format ?? "mp3").trim().toLowerCase();
  return {
    provider: "siliconflow",
    base_url: base,
    model,
    voice,
    response_format: ["mp3", "wav", "opus", "pcm"].includes(fmt) ? fmt : "mp3",
    api_key: sanitizeLlmApiKey(src.api_key ?? fb.api_key ?? ""),
  };
}

function publicSiliconflowTtsConfig(cfg) {
  const c = normalizeSiliconflowTtsConfig(cfg, siliconflowTtsDefaults);
  return {
    provider: c.provider,
    base_url: c.base_url,
    model: c.model,
    voice: c.voice,
    response_format: c.response_format,
    api_key_set: Boolean(c.api_key),
    voices: ["anna", "alex", "bella", "benjamin"].map((id) => ({ id, value: `${c.model}:${id}` })),
  };
}

const edgeTtsVoices = [
  { id: "zh-CN-YunxiNeural", name: "云溪", locale: "zh-CN", gender: "Male", description: "男声 · 沉稳专业" },
  { id: "zh-CN-YunjianNeural", name: "云健", locale: "zh-CN", gender: "Male", description: "男声 · 浑厚有力" },
  { id: "zh-CN-XiaoxiaoNeural", name: "晓晓", locale: "zh-CN", gender: "Female", description: "女声 · 温柔甜美" },
  { id: "zh-CN-XiaoyiNeural", name: "晓伊", locale: "zh-CN", gender: "Female", description: "女声 · 知性优雅" },
  { id: "zh-CN-liaoning-XiaobeiNeural", name: "晓北", locale: "zh-CN-liaoning", gender: "Female", description: "女声 · 东北口音" },
  { id: "zh-CN-shaanxi-XiaoniNeural", name: "晓妮", locale: "zh-CN-shaanxi", gender: "Female", description: "女声 · 陕西方言" },
  { id: "en-US-GuyNeural", name: "Guy", locale: "en-US", gender: "Male", description: "Male · American English" },
  { id: "en-US-JennyNeural", name: "Jenny", locale: "en-US", gender: "Female", description: "Female · American English" },
  { id: "en-GB-RyanNeural", name: "Ryan", locale: "en-GB", gender: "Male", description: "Male · British English" },
];

const edgeTtsDefaults = {
  provider: "edge",
  voice: "zh-CN-YunxiNeural",
  rate: "+0%",
  volume: "+0%",
  pitch: "+0Hz",
  response_format: "mp3",
};

function normalizeEdgeSignedPercent(v, fallback = "+0%") {
  const raw = String(v ?? fallback ?? "+0%").trim();
  const m = raw.match(/^([+-]?)(\d{1,3})%$/);
  if (!m) return fallback;
  const sign = m[1] === "-" ? -1 : 1;
  const n = clamp(sign * (parseInt(m[2], 10) || 0), -100, 100);
  return `${n >= 0 ? "+" : ""}${n}%`;
}

function normalizeEdgePitch(v, fallback = "+0Hz") {
  const raw = String(v ?? fallback ?? "+0Hz").trim();
  const m = raw.match(/^([+-]?)(\d{1,3})Hz$/i);
  if (!m) return fallback;
  const sign = m[1] === "-" ? -1 : 1;
  const n = clamp(sign * (parseInt(m[2], 10) || 0), -100, 100);
  return `${n >= 0 ? "+" : ""}${n}Hz`;
}

function normalizeEdgeTtsConfig(input, fallback = {}) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const fb = fallback && typeof fallback === "object" ? fallback : {};
  const voiceRaw = String(src.voice ?? fb.voice ?? edgeTtsDefaults.voice).trim();
  const voice = edgeTtsVoices.some((v) => v.id === voiceRaw) ? voiceRaw : edgeTtsDefaults.voice;
  return {
    provider: "edge",
    voice,
    rate: normalizeEdgeSignedPercent(src.rate ?? fb.rate, edgeTtsDefaults.rate),
    volume: normalizeEdgeSignedPercent(src.volume ?? fb.volume, edgeTtsDefaults.volume),
    pitch: normalizeEdgePitch(src.pitch ?? fb.pitch, edgeTtsDefaults.pitch),
    response_format: "mp3",
  };
}

function publicEdgeTtsConfig(cfg) {
  const c = normalizeEdgeTtsConfig(cfg, edgeTtsDefaults);
  return {
    provider: c.provider,
    voice: c.voice,
    rate: c.rate,
    volume: c.volume,
    pitch: c.pitch,
    response_format: c.response_format,
    voices: edgeTtsVoices,
  };
}

const ttsRuntimeDefaults = {
  provider: "siliconflow",
};

function normalizeTtsRuntimeConfig(input, fallback = {}) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const fb = fallback && typeof fallback === "object" && !Array.isArray(fallback) ? fallback : {};
  const provider = String(src.provider ?? src.tts_provider ?? fb.provider ?? ttsRuntimeDefaults.provider)
    .trim()
    .toLowerCase();
  return {
    provider: ["siliconflow", "local", "edge"].includes(provider) ? provider : ttsRuntimeDefaults.provider,
  };
}

function publicTtsRuntimeConfig(cfg) {
  const c = normalizeTtsRuntimeConfig(cfg, ttsRuntimeDefaults);
  return {
    provider: c.provider,
    providers: [
      { id: "siliconflow", label: "轨迹流动 API" },
      { id: "edge", label: "Edge TTS API" },
      { id: "local", label: "云端本地模型" },
    ],
  };
}

function loadLlmConfigFile() {
  try {
    if (!fs.existsSync(llmConfigPath) || !fs.statSync(llmConfigPath).isFile()) return {};
    const cfg = safeJsonParse(fs.readFileSync(llmConfigPath, "utf8")) || {};
    return cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : {};
  } catch {
    return {};
  }
}

function saveLlmConfigFile(kind, cfg) {
  const fileCfg = loadLlmConfigFile();
  fileCfg.schema = "rk3568.llm_config.v1";
  fileCfg.updated_at = nowBjText();
  if (kind === "tts_siliconflow") {
    fileCfg[kind] = {
      ...publicSiliconflowTtsConfig(cfg),
      api_key: String(cfg?.api_key || "").trim(),
      updated_at: nowBjText(),
    };
  } else if (kind === "tts_edge") {
    fileCfg[kind] = {
      ...publicEdgeTtsConfig(cfg),
      updated_at: nowBjText(),
    };
  } else if (kind === "tts_runtime") {
    fileCfg[kind] = {
      ...publicTtsRuntimeConfig(cfg),
      updated_at: nowBjText(),
    };
  } else {
    fileCfg[kind] = {
      ...publicLlmConfig(cfg),
      api_key: String(cfg?.api_key || "").trim(),
      updated_at: nowBjText(),
    };
  }
  const tmp = `${llmConfigPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(fileCfg, null, 2), "utf8");
  fs.renameSync(tmp, llmConfigPath);
  if (kind === "tts_siliconflow") return normalizeSiliconflowTtsConfig(fileCfg[kind], siliconflowTtsDefaults);
  if (kind === "tts_edge") return normalizeEdgeTtsConfig(fileCfg[kind], edgeTtsDefaults);
  if (kind === "tts_runtime") return normalizeTtsRuntimeConfig(fileCfg[kind], ttsRuntimeDefaults);
  return normalizeLlmConfig(fileCfg[kind]);
}

function saveJpegFile(dir, fileName, buf) {
  if (!(buf instanceof Buffer) || buf.length < 10) return null;
  const name = sanitizeFileName(fileName || "image.jpg");
  const abs = path.resolve(dir, name);
  try {
    fs.writeFileSync(abs, buf);
    return abs;
  } catch {
    return null;
  }
}

function toLogRelPath(absPath) {
  if (!absPath) return null;
  try {
    const rel = path.relative(logRoot, absPath);
    return rel.split(path.sep).join("/");
  } catch {
    return null;
  }
}

function fromLogRelPath(p) {
  const s = String(p || "").trim();
  if (!s) return null;
  if (path.isAbsolute(s)) return s;
  return path.resolve(logRoot, s);
}

function readJpegFile(absPath) {
  const p = fromLogRelPath(absPath);
  if (!p) return null;
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size < 10) return null;
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

function directCaptureImagePath(rootDir, id, kind) {
  const captureId = String(id || "").trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(captureId)) return null;
  const root = path.resolve(rootDir);
  const suffix = kind === "thumb" ? "_thumb.jpg" : ".jpg";
  const abs = path.resolve(root, `${captureId}${suffix}`);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return abs;
}

function readJsonlAll(filePath, maxBytes = 60_000_000) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return [];
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const text = buf.toString("utf8");
    const lines = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

function latestViolationsFromAudit() {
  const primaryRows = readJsonlAll(path.join(logRoot, "violations.jsonl"));
  const auditRows = readJsonlAll(path.join(logRoot, "violations_audit.jsonl"));
  const map = new Map();
  // The primary journal is the durable record boundary.  The audit journal
  // may be missing an individual line (for example after a disk-full event),
  // so always merge both sources instead of returning audit data exclusively.
  for (const r of [...primaryRows, ...auditRows]) {
    const id = String(r?.id || "");
    if (!id) continue;
    const cur = map.get(id) || { id };
    const persisted = dbViolationItem(r) || {};
    const auditEvent = String(r?.event || "").trim().toLowerCase();
    delete persisted.event;
    Object.entries(persisted).forEach(([key, value]) => {
      if (key === "id" || value === undefined || value === null) return;
      if (key === "time_bj" && auditEvent && auditEvent !== "created" && cur.time_bj) return;
      cur[key] = value;
    });
    cur.id = id;
    map.set(id, cur);
  }
  const out = Array.from(map.values());
  out.sort((a, b) => String(b?.time_bj || "").localeCompare(String(a?.time_bj || "")));
  return out;
}

function latestPlatesFromAudit() {
  const primaryRows = readJsonlAll(path.join(logRoot, "plates.jsonl"));
  const auditRows = readJsonlAll(path.join(logRoot, "plates_audit.jsonl"));
  const map = new Map();
  // Keep the primary capture journal authoritative even when its companion
  // audit append was interrupted.  Later audit fields still enrich the row.
  for (const r of [...primaryRows, ...auditRows]) {
    const id = String(r?.id || "");
    if (!id) continue;
    const cur = map.get(id) || { id };
    const persisted = dbPlateItem(r) || {};
    delete persisted.event;
    Object.entries(persisted).forEach(([key, value]) => {
      if (key === "id" || value === undefined || value === null) return;
      cur[key] = value;
    });
    cur.id = id;
    map.set(id, cur);
  }
  const out = Array.from(map.values());
  out.sort((a, b) => String(b?.time_bj || "").localeCompare(String(a?.time_bj || "")));
  return out;
}

const rkReportReceiptPath = path.join(logRoot, "rk_report_receipts.jsonl");
const rkReportRejectionPath = path.join(logRoot, "rk_report_rejections.jsonl");
const RK_REPORT_TYPES = new Set(["status", "plate", "violation", "user-message", "business"]);
const RK_REPORT_SCHEMA_DEFAULT = "rk3568.cloud_report.v1";
const RK_REPORT_SCHEMA_LEGACY = "rk3568.legacy_report.v0";
const RK_DELIVERY_SEMANTICS_DEFAULT = "at_least_once";
const RK_ALLOW_LEGACY_REPORTS = boolEnv(process.env.RK_ALLOW_LEGACY_REPORTS);
const RK_REPORT_CLOCK_SKEW_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000;
const RK_REPORT_CLOCK_SKEW_MS = (() => {
  const value = Number(process.env.RK_REPORT_CLOCK_SKEW_MS);
  return Number.isFinite(value) && value > 0
    ? clamp(value, 60_000, 30 * 24 * 60 * 60 * 1000)
    : RK_REPORT_CLOCK_SKEW_DEFAULT_MS;
})();
// The wire text has second precision while the companion value has
// millisecond precision.  A value from the same second can therefore differ
// by at most 999 ms; permitting a larger window would also accept an adjacent
// second and violate the v1 contract.  Keep the bound configurable for boards
// with a known clock-sampling quirk, but never widen it beyond one second.
const RK_REPORT_TIMESTAMP_TOLERANCE_DEFAULT_MS = 999;
const RK_REPORT_TIMESTAMP_TOLERANCE_MS = (() => {
  const raw = process.env.RK_REPORT_TIMESTAMP_TOLERANCE_MS;
  const value = raw === undefined || raw === null || String(raw).trim() === "" ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0
    ? clamp(Math.floor(value), 0, 999)
    : RK_REPORT_TIMESTAMP_TOLERANCE_DEFAULT_MS;
})();
let rkReportReceiptIndex = null;

function parseRkBeijingTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second) - 8 * 60 * 60 * 1000;
  // Re-add the fixed Beijing offset before comparing components.  Comparing
  // the UTC representation directly would fail for afternoon/evening times
  // because the corresponding UTC date may be the previous calendar day.
  const date = new Date(timestamp + 8 * 60 * 60 * 1000);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
  ) {
    return null;
  }
  return timestamp;
}

function validateRkReportTimestamps(root) {
  const reportCreatedAt = root?.report_created_at;
  if (typeof reportCreatedAt !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(reportCreatedAt)) {
    return {
      error: reportCreatedAt === undefined ? "missing_report_created_at" : "bad_report_created_at",
      message: "report_created_at must use a valid Beijing time yyyy-MM-dd HH:mm:ss",
    };
  }
  const reportCreatedAtMs = parseRkBeijingTimestamp(reportCreatedAt);
  if (reportCreatedAtMs === null) {
    return { error: "bad_report_created_at", message: "report_created_at must use a valid Beijing calendar time" };
  }
  const reportCreatedAtMsRaw = root?.report_created_at_ms;
  if (!Number.isSafeInteger(reportCreatedAtMsRaw) || reportCreatedAtMsRaw < 0) {
    return {
      error: reportCreatedAtMsRaw === undefined ? "missing_report_created_at_ms" : "bad_report_created_at_ms",
      message: "report_created_at_ms must be a non-negative safe integer",
    };
  }
  if (reportCreatedAtMsRaw - Date.now() > RK_REPORT_CLOCK_SKEW_MS) {
    return {
      error: "report_timestamp_out_of_range",
      message: `report_created_at_ms must not be more than ${Math.floor(RK_REPORT_CLOCK_SKEW_MS / 86400000)} days in the future`,
    };
  }
  if (Math.abs(reportCreatedAtMsRaw - reportCreatedAtMs) > RK_REPORT_TIMESTAMP_TOLERANCE_MS) {
    return {
      error: "report_timestamp_mismatch",
      message: "report_created_at and report_created_at_ms must refer to the same second",
    };
  }
  return null;
}

// The common v1 envelope is intentionally validated separately from the
// endpoint payload.  These helpers keep the endpoint handlers small and,
// importantly, reject malformed values before the normalizers coerce them
// into seemingly valid defaults.  Fields remain optional for compatibility
// with older RK builds; when a field is present its wire type is strict.
function rkPayloadProblem(field, message) {
  return {
    error: "bad_report_payload",
    field,
    message: message || `${field} has an invalid value`,
  };
}

function rkPayloadUsesV1(root) {
  return !RK_ALLOW_LEGACY_REPORTS || root?.report_schema === RK_REPORT_SCHEMA_DEFAULT;
}

function validateRkPayloadString(root, field, { nonEmpty = false, max = 1024 } = {}) {
  if (!Object.prototype.hasOwnProperty.call(root || {}, field)) return null;
  const value = root[field];
  if (value === null) return null;
  if (typeof value !== "string") return rkPayloadProblem(field, `${field} must be a string`);
  if (value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    return rkPayloadProblem(field, `${field} contains control characters or exceeds ${max} characters`);
  }
  if (nonEmpty && !value.trim()) return rkPayloadProblem(field, `${field} must not be empty`);
  return null;
}

function validateRkDeviceIdValue(value, path) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return rkPayloadProblem(path, `${path} must be a string`);
  if (!value) return null;
  if (value.trim() !== value || !/^[A-Za-z0-9_.:-]{1,80}$/.test(value)) {
    return rkPayloadProblem(path, `${path} must contain only ASCII letters, digits, underscore, dot, colon, or hyphen and be at most 80 characters`);
  }
  return null;
}

function validateRkDeviceIdField(root, field, path = field) {
  if (!Object.prototype.hasOwnProperty.call(root || {}, field)) return null;
  return validateRkDeviceIdValue(root[field], path);
}

function validateRkPayloadNumber(root, field, { integer = false, min = null, max = null } = {}) {
  if (!Object.prototype.hasOwnProperty.call(root || {}, field)) return null;
  const value = root[field];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return rkPayloadProblem(field, `${field} must be a finite JSON number`);
  if (integer && !Number.isSafeInteger(value)) return rkPayloadProblem(field, `${field} must be a safe integer`);
  if (min !== null && value < min) return rkPayloadProblem(field, `${field} must be >= ${min}`);
  if (max !== null && value > max) return rkPayloadProblem(field, `${field} must be <= ${max}`);
  return null;
}

function validateRkPayloadBoolean(root, field) {
  if (!Object.prototype.hasOwnProperty.call(root || {}, field)) return null;
  if (root[field] === null) return null;
  return typeof root[field] === "boolean" ? null : rkPayloadProblem(field, `${field} must be a boolean`);
}

function validateRkPayloadEnum(root, field, values, { nonEmpty = true } = {}) {
  const stringProblem = validateRkPayloadString(root, field, { nonEmpty });
  if (stringProblem || !Object.prototype.hasOwnProperty.call(root || {}, field)) return stringProblem;
  if (root[field] === null) return null;
  if (Array.isArray(values) && values.length && !values.includes(root[field])) {
    return rkPayloadProblem(field, `${field} must be one of: ${values.join(", ")}`);
  }
  return null;
}

function validateRkPayloadObject(root, field) {
  if (!Object.prototype.hasOwnProperty.call(root || {}, field)) return null;
  const value = root[field];
  if (value === null) return null;
  return value && typeof value === "object" && !Array.isArray(value)
    ? null
    : rkPayloadProblem(field, `${field} must be an object`);
}

// Validate fields inside the contract objects before the normalizers coerce
// or discard malformed values.  Nested fields are optional for compatibility
// with older RK builds; when present, their wire type remains authoritative.
function validateRkNestedFields(value, path, {
  strings = [],
  numbers = [],
  integers = [],
  booleans = [],
  objects = [],
  arrays = [],
} = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return rkPayloadProblem(path, `${path} must be an object`);
  }
  const checkString = (key, max = 1024) => {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return null;
    const raw = value[key];
    if (raw === null) return null;
    if (typeof raw !== "string") return rkPayloadProblem(`${path}.${key}`, `${path}.${key} must be a string`);
    if (raw.length > max || /[\x00-\x1f\x7f]/.test(raw)) {
      return rkPayloadProblem(`${path}.${key}`, `${path}.${key} contains control characters or exceeds ${max} characters`);
    }
    return null;
  };
  const checkNumber = (key, integer = false, min = null, max = null) => {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return null;
    const raw = value[key];
    if (raw === null) return null;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return rkPayloadProblem(`${path}.${key}`, `${path}.${key} must be a finite JSON number`);
    }
    if (integer && !Number.isSafeInteger(raw)) return rkPayloadProblem(`${path}.${key}`, `${path}.${key} must be a safe integer`);
    if (min !== null && raw < min) return rkPayloadProblem(`${path}.${key}`, `${path}.${key} must be >= ${min}`);
    if (max !== null && raw > max) return rkPayloadProblem(`${path}.${key}`, `${path}.${key} must be <= ${max}`);
    return null;
  };
  for (const entry of strings) {
    const [key, max] = Array.isArray(entry) ? entry : [entry, 1024];
    const problem = checkString(key, max);
    if (problem) return problem;
  }
  for (const entry of numbers) {
    const [key, min, max] = Array.isArray(entry) ? entry : [entry, 0, null];
    const problem = checkNumber(key, false, min ?? null, max ?? null);
    if (problem) return problem;
  }
  for (const entry of integers) {
    const [key, min, max] = Array.isArray(entry) ? entry : [entry, 0, null];
    const problem = checkNumber(key, true, min ?? null, max ?? null);
    if (problem) return problem;
  }
  for (const key of booleans) {
    if (Object.prototype.hasOwnProperty.call(value, key) && value[key] !== null && typeof value[key] !== "boolean") {
      return rkPayloadProblem(`${path}.${key}`, `${path}.${key} must be a boolean`);
    }
  }
  for (const key of objects) {
    if (Object.prototype.hasOwnProperty.call(value, key)
      && value[key] !== null
      && (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key]))) {
      return rkPayloadProblem(`${path}.${key}`, `${path}.${key} must be an object`);
    }
  }
  for (const key of arrays) {
    if (Object.prototype.hasOwnProperty.call(value, key) && value[key] !== null && !Array.isArray(value[key])) {
      return rkPayloadProblem(`${path}.${key}`, `${path}.${key} must be an array`);
    }
  }
  return null;
}

function validateRkNestedObject(root, field, spec = {}, pathOverride = null) {
  if (!Object.prototype.hasOwnProperty.call(root || {}, field)) return null;
  const value = root[field];
  const path = pathOverride || field;
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return rkPayloadProblem(path, `${path} must be an object`);
  }
  return validateRkNestedFields(value, path, spec);
}

function validateRkNestedArrayItems(value, path, { integer = false, min = null, max = null } = {}) {
  if (value === null) return null;
  if (!Array.isArray(value)) return rkPayloadProblem(path, `${path} must be an array`);
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "number" || !Number.isFinite(item) || (integer && !Number.isSafeInteger(item))) {
      return rkPayloadProblem(`${path}[${index}]`, `${path}[${index}] must be a JSON number${integer ? " integer" : ""}`);
    }
    if (min !== null && item < min) return rkPayloadProblem(`${path}[${index}]`, `${path}[${index}] must be >= ${min}`);
    if (max !== null && item > max) return rkPayloadProblem(`${path}[${index}]`, `${path}[${index}] must be <= ${max}`);
  }
  return null;
}

// These values are emitted by the current RK3568 clients.  Keeping the
// allow-lists here prevents the normalizers from turning an unknown string
// into a persisted, but meaningless, state value.
const RK_INFERENCE_STRATEGIES = new Set([
  "mosaic_single",
  "mosaic_letterbox_single",
  "per_source_full",
  "overlap_hybrid",
  "four_source_sliding",
  "single_source",
  "single_full_frame",
  "per_source_sliding",
  "sd_static",
  "inactive",
  "unknown",
]);
const RK_PREPROCESS_BACKENDS = new Set(["auto", "rga", "rga2", "opencv", "opencv_cpu", "cpu", "software", "none", "uninitialized", "unknown"]);
const RK_INFERENCE_UNITS = new Set(["source", "mosaic", "window", "frame", "single_source", "unknown"]);
const RK_FRAME_FORMATS = new Set(["BGR", "RGB", "BGR888", "RGB888", "BGR888P", "RGB888P", "NV12", "NV21", "YUYV", "UYVY", "RGB_UINT8_NHWC", "BGR_UINT8_NHWC", "unknown"]);

// All three wire locations (plate_detector_runtime, detector_runtime, and
// pcie_plate_inference.detector_runtime) feed the same normalizer.  Keeping a
// single superset here prevents an alias from bypassing type/range checks.
const RK_DETECTOR_RUNTIME_SPEC = Object.freeze({
  strings: [
    ["strategy", 120], ["preprocess_backend", 80], ["preprocess_requested", 80], ["preprocess_fallback_reason", 300],
    ["model_name", 160], ["model_path", 1024], ["configured_model_file", 512], ["recognizer_name", 160], ["recognizer_path", 1024],
    ["model_input", 160], ["model_input_format", 80], ["postprocess_contract", 320], ["output_mode", 96],
    ["detector_profile", 120], ["detector_family", 120], ["detector_model_name", 160], ["detector_input_type", 120],
    ["detector_output_contract", 600], ["detector_runtime_backend", 120],
    ["recognizer_profile", 120], ["recognizer_output_contract", 600], ["recognizer_input_format", 120],
    ["recognizer_text_layout", 160], ["recognizer_runtime_backend", 120],
    ["task_fps_semantics", 80], ["cycle_fps_semantics", 80], ["model_error", 500], ["recognizer_error", 500],
  ],
  numbers: [
    "pre_ms", "npu_wall_ms", "npu_hw_ms", "post_ms", "e2e_ms", "overlap_saved_ms", "task_fps",
    "task_throughput_fps", "subtask_throughput_fps", "cycle_fps", "cycle_ms", "result_age_ms",
    "display_cycle_ms", "display_fps", "overlay_max_age_ms",
  ],
  integers: [
    ["task_count", 0, 1000000], ["queue_depth", 0, 1000000], ["dropped_tasks", 0, Number.MAX_SAFE_INTEGER],
    ["capture_dropped_frames", 0, Number.MAX_SAFE_INTEGER],
    ["detector_profile_id", 0, 4], ["detector_input_width", 0, 16384], ["detector_input_height", 0, 16384],
    ["recognizer_profile_id", 0, 2], ["recognizer_input_width", 0, 16384], ["recognizer_input_height", 0, 16384],
  ],
  booleans: [
    "executed", "capture_async", "latest_only", "pipeline_enabled", "pipeline_active", "quantized_output",
    "model_ready", "recognizer_ready",
  ],
});

function validateRkNestedEnumValue(value, path, allowed) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !allowed.has(value)) {
    return rkPayloadProblem(path, `${path} must use a supported value`);
  }
  return null;
}

function validateRkSourceLayoutValue(value, path) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return rkPayloadProblem(path, `${path} must be a string`);
  const normalized = value.trim().toLowerCase();
  const named = new Set(["mosaic", "single", "unknown"]);
  const grid = /^(\d+)x(\d+)$/.exec(normalized);
  const validGrid = grid && Number(grid[1]) >= 1 && Number(grid[2]) >= 1
    && Number(grid[1]) <= 4 && Number(grid[2]) <= 4 && Number(grid[1]) * Number(grid[2]) <= 4;
  if (!named.has(normalized) && !validGrid) return rkPayloadProblem(path, `${path} must be a supported source layout`);
  return null;
}

function validateRkFrameFormatValue(value, path) {
  if (value === undefined || value === null) return null;
  const supportedVariant = typeof value === "string" && /^(?:RGB|BGR|NV12|NV21|YUYV|UYVY)[A-Z0-9_]*$/.test(value);
  if (typeof value !== "string" || (!RK_FRAME_FORMATS.has(value) && !supportedVariant)) return rkPayloadProblem(path, `${path} must use a supported pixel format`);
  return null;
}

function validateRkLetterboxConsistency(pcie, field) {
  if (!pcie || !Object.prototype.hasOwnProperty.call(pcie, field)) return null;
  const value = pcie[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const path = `pcie_plate_inference.${field}`;
  const geometry = [
    "source_width", "source_height", "model_width", "model_height",
    "content_width", "content_height", "pad_left", "pad_right", "pad_top", "pad_bottom",
  ];
  const present = geometry.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (!present.length) return Object.keys(value).length
    ? rkPayloadProblem(path, `${path} must include complete geometry when populated`)
    : null;
  const missing = geometry.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) return rkPayloadProblem(path, `${path} must include complete geometry (${missing.join(", ")})`);
  if (value.source_width <= 0 || value.source_height <= 0 || value.model_width <= 0 || value.model_height <= 0
      || value.content_width <= 0 || value.content_height <= 0) {
    return rkPayloadProblem(path, `${path} dimensions must be positive`);
  }
  if (value.content_width + value.pad_left + value.pad_right !== value.model_width) {
    return rkPayloadProblem(`${path}.content_width`, `${path} content_width + horizontal padding must equal model_width`);
  }
  if (value.content_height + value.pad_top + value.pad_bottom !== value.model_height) {
    return rkPayloadProblem(`${path}.content_height`, `${path} content_height + vertical padding must equal model_height`);
  }
  if (Object.prototype.hasOwnProperty.call(value, "pad_value_rgb")
      && Object.prototype.hasOwnProperty.call(value, "pad_value_bgr")
      && value.pad_value_rgb !== value.pad_value_bgr) {
    return rkPayloadProblem(`${path}.pad_value_rgb`, `${path}.pad_value_rgb and pad_value_bgr must match when both are present`);
  }
  if (value.scaleup === false && (value.content_width > value.source_width || value.content_height > value.source_height)) {
    return rkPayloadProblem(path, `${path} cannot enlarge content when scaleup is false`);
  }
  return null;
}

function countRkSourceMaskBits(mask) {
  let value = Number(mask);
  let count = 0;
  while (value > 0) {
    count += value & 1;
    value = Math.floor(value / 2);
  }
  return count;
}

function validateRkPcieTopology(root) {
  const pcie = root?.pcie_plate_inference;
  if (!pcie || typeof pcie !== "object" || Array.isArray(pcie)) return null;
  const has = (key) => Object.prototype.hasOwnProperty.call(pcie, key) && pcie[key] !== null;
  const sourceIndices = has("source_indices") ? pcie.source_indices : null;
  if (Array.isArray(sourceIndices)) {
    if (sourceIndices.length > 4) {
      return rkPayloadProblem("pcie_plate_inference.source_indices", "source_indices must contain at most four sources");
    }
    const unique = new Set(sourceIndices);
    if (unique.size !== sourceIndices.length) {
      return rkPayloadProblem("pcie_plate_inference.source_indices", "source_indices must not contain duplicate source numbers");
    }
  }
  const sourceCount = has("source_count") ? pcie.source_count : null;
  const activeCount = has("active_source_count") ? pcie.active_source_count : null;
  const sourceMask = has("source_mask") ? pcie.source_mask : null;
  if (sourceCount !== null && activeCount !== null && activeCount > sourceCount) {
    return rkPayloadProblem("pcie_plate_inference.active_source_count", "active_source_count must not exceed source_count");
  }
  if (Array.isArray(sourceIndices) && activeCount !== null && sourceIndices.length !== activeCount) {
    return rkPayloadProblem("pcie_plate_inference.source_indices", "source_indices length must equal active_source_count");
  }
  if (sourceMask !== null) {
    if (activeCount !== null && countRkSourceMaskBits(sourceMask) !== activeCount) {
      return rkPayloadProblem("pcie_plate_inference.source_mask", "source_mask bit count must equal active_source_count");
    }
    if (sourceCount !== null && (sourceMask & ~((1 << sourceCount) - 1)) !== 0) {
      return rkPayloadProblem("pcie_plate_inference.source_mask", "source_mask contains a source outside source_count");
    }
    if (Array.isArray(sourceIndices)) {
      const expectedMask = sourceIndices.reduce((mask, index) => mask | (1 << (index - 1)), 0);
      if (expectedMask !== sourceMask) {
        return rkPayloadProblem("pcie_plate_inference.source_mask", "source_mask must match source_indices");
      }
    }
  }
  if (has("source_width") && has("source_frame_width") && pcie.source_width !== pcie.source_frame_width) {
    return rkPayloadProblem("pcie_plate_inference.source_width", "source_width must match source_frame_width when both are present");
  }
  if (has("source_height") && has("source_frame_height") && pcie.source_height !== pcie.source_frame_height) {
    return rkPayloadProblem("pcie_plate_inference.source_height", "source_height must match source_frame_height when both are present");
  }
  if (pcie.source_layout === "2x2" && has("source_width") && has("source_height") && has("mosaic_width") && has("mosaic_height")
      && (pcie.mosaic_width !== pcie.source_width * 2 || pcie.mosaic_height !== pcie.source_height * 2)) {
    return rkPayloadProblem("pcie_plate_inference.mosaic_width", "2x2 source_layout requires mosaic dimensions to be twice the source dimensions");
  }
  for (const field of ["single_pass_letterbox", "per_source_letterbox"]) {
    const letterbox = pcie[field];
    if (!letterbox || typeof letterbox !== "object" || Array.isArray(letterbox)) continue;
    if (has("model_input_width") && Object.prototype.hasOwnProperty.call(letterbox, "model_width")
        && pcie.model_input_width !== letterbox.model_width) {
      return rkPayloadProblem(`pcie_plate_inference.${field}.model_width`, `${field}.model_width must match model_input_width`);
    }
    if (has("model_input_height") && Object.prototype.hasOwnProperty.call(letterbox, "model_height")
        && pcie.model_input_height !== letterbox.model_height) {
      return rkPayloadProblem(`pcie_plate_inference.${field}.model_height`, `${field}.model_height must match model_input_height`);
    }
  }
  return null;
}

function rkComparableValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return `number:${value}`;
  if (typeof value === "boolean") return `boolean:${value}`;
  if (typeof value === "string" && value.trim()) return `string:${value.trim().toLowerCase()}`;
  return null;
}

function validateRkEquivalentSources(sources, fields) {
  const seen = new Map();
  for (const source of sources) {
    if (!source?.value || typeof source.value !== "object" || Array.isArray(source.value)) continue;
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(source.value, field)) continue;
      const comparable = rkComparableValue(source.value[field]);
      if (comparable === null) continue;
      const previous = seen.get(field);
      if (previous && previous.comparable !== comparable) {
        return rkPayloadProblem(`${source.path}.${field}`, `${source.path}.${field} conflicts with ${previous.path}.${field}`);
      }
      if (!previous) seen.set(field, { comparable, path: source.path });
    }
  }
  return null;
}

function validateRkStatusConsistency(root) {
  const dmaProblem = validateRkEquivalentSources([
    { path: "pcie_dma_memory", value: root?.pcie_dma_memory },
    { path: "driver_status.dma_memory", value: root?.driver_status?.dma_memory },
  ], ["cma_total_kb", "cma_free_kb", "cma_minimum_kb", "cma_recommended_kb", "cma_sufficient", "cma_recommended"]);
  if (dmaProblem) return dmaProblem;
  const captureSources = [
    { path: "driver_capture_metrics", value: root?.driver_capture_metrics },
    { path: "driver_status.capture_metrics", value: root?.driver_status?.capture_metrics },
    { path: "driver_status.pcie.capture_metrics", value: root?.driver_status?.pcie?.capture_metrics },
    { path: "pcie_top_level", value: captureMetricsTopLevelSource(root) },
  ];
  const captureProblem = validateRkEquivalentSources(captureSources, [
    "protocol", "mode", "driver_abi_version", "driver_features", "fpga_protocol_version", "fpga_capabilities",
    "target_fps_milli", "fpga_target_fps_milli", "source_mask", "frame_width", "frame_height", "frame_stride_bytes",
    "frame_bytes", "ring_count", "bar_contract_ok", "all_four_sources_valid", "running", "pcie", "metric_valid",
  ]);
  if (captureProblem) return captureProblem;
  const runtimeSources = [
    { path: "plate_detector_runtime", value: root?.plate_detector_runtime },
    { path: "detector_runtime", value: root?.detector_runtime },
    { path: "pcie_plate_inference.detector_runtime", value: root?.pcie_plate_inference?.detector_runtime },
  ];
  const runtimeProblem = validateRkEquivalentSources(runtimeSources, [
    "strategy", "preprocess_backend", "preprocess_requested", "preprocess_fallback_reason",
    "pipeline_enabled", "pipeline_active", "quantized_output", "capture_async", "latest_only",
    "task_count", "queue_depth", "dropped_tasks", "capture_dropped_frames",
    "pre_ms", "npu_wall_ms", "npu_hw_ms", "post_ms", "e2e_ms", "overlap_saved_ms",
    "task_fps", "task_throughput_fps", "subtask_throughput_fps", "cycle_fps", "cycle_ms", "result_age_ms",
    "display_cycle_ms", "display_fps", "overlay_max_age_ms",
    "detector_profile_id", "detector_input_width", "detector_input_height",
    "recognizer_profile_id", "recognizer_input_width", "recognizer_input_height",
    "detector_model_name", "detector_output_contract", "detector_runtime_backend",
    "recognizer_profile", "recognizer_output_contract", "recognizer_input_format", "recognizer_runtime_backend",
  ]);
  if (runtimeProblem) return runtimeProblem;
  for (const source of captureSources) {
    const value = source.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const dropped = value.dropped_frames;
    const fpgaDropped = value.fpga_dropped_frames;
    const hostDropped = value.host_dropped_frames;
    if (typeof dropped === "number" && typeof fpgaDropped === "number" && typeof hostDropped === "number"
        && fpgaDropped + hostDropped > dropped) {
      return rkPayloadProblem(`${source.path}.dropped_frames`, `${source.path}.dropped_frames must be at least fpga_dropped_frames + host_dropped_frames`);
    }
    if (typeof value.frame_width === "number" && typeof value.frame_height === "number"
        && typeof value.frame_stride_bytes === "number" && typeof value.frame_bytes === "number"
        && value.frame_width > 0 && value.frame_height > 0
        && (value.frame_stride_bytes < value.frame_width
          || value.frame_bytes < value.frame_stride_bytes)) {
      return rkPayloadProblem(`${source.path}.frame_bytes`, `${source.path} frame byte and stride metrics are inconsistent`);
    }
  }
  const pcie = root?.pcie_plate_inference;
  const compareScalar = (leftPath, leftValue, rightPath, rightValue) => {
    if (leftValue === undefined || rightValue === undefined || leftValue === null || rightValue === null) return null;
    if (rkComparableValue(leftValue) !== rkComparableValue(rightValue)) {
      return rkPayloadProblem(rightPath, `${rightPath} conflicts with ${leftPath}`);
    }
    return null;
  };
  for (const source of runtimeSources) {
    if (!source.value || typeof source.value !== "object" || Array.isArray(source.value)) continue;
    for (const [rootField, runtimeField] of [
      ["plate_detector_model_name", "model_name"], ["detector_profile", "detector_profile"],
      ["detector_profile_id", "detector_profile_id"], ["detector_family", "detector_family"],
      ["detector_model_name", "detector_model_name"], ["detector_input_width", "detector_input_width"],
      ["detector_input_height", "detector_input_height"], ["detector_input_type", "detector_input_type"],
      ["detector_output_contract", "detector_output_contract"], ["detector_runtime_backend", "detector_runtime_backend"],
      ["plate_recognizer_model_name", "recognizer_name"], ["recognizer_profile", "recognizer_profile"],
      ["recognizer_profile_id", "recognizer_profile_id"], ["recognizer_output_contract", "recognizer_output_contract"],
      ["recognizer_input_width", "recognizer_input_width"], ["recognizer_input_height", "recognizer_input_height"],
      ["recognizer_input_format", "recognizer_input_format"], ["recognizer_text_layout", "recognizer_text_layout"],
      ["recognizer_runtime_backend", "recognizer_runtime_backend"],
      ["plate_detector_model_ready", "model_ready"], ["plate_recognizer_model_ready", "recognizer_ready"],
    ]) {
      const problem = compareScalar(rootField, root?.[rootField], `${source.path}.${runtimeField}`, source.value[runtimeField]);
      if (problem) return problem;
    }
    for (const [rootField, runtimeField] of [
      ["plate_inference_strategy", "strategy"], ["plate_inference_pipeline_enabled", "pipeline_enabled"],
      ["plate_inference_pipeline_active", "pipeline_active"], ["plate_det_quantized_output", "quantized_output"],
      ["plate_preprocess_backend", "preprocess_backend"], ["plate_preprocess_requested", "preprocess_requested"],
      ["plate_preprocess_fallback_reason", "preprocess_fallback_reason"], ["plate_capture_async", "capture_async"],
      ["plate_latest_only", "latest_only"], ["plate_overlay_max_age_ms", "overlay_max_age_ms"],
      ["perf_display_cycle_ms", "display_cycle_ms"], ["perf_display_fps", "display_fps"],
      ["perf_capture_dropped_frames", "capture_dropped_frames"], ["perf_det_task_count", "task_count"],
      ["perf_det_queue_depth", "queue_depth"], ["perf_det_dropped_tasks", "dropped_tasks"],
      ["perf_det_pre_ms", "pre_ms"], ["perf_det_npu_wall_ms", "npu_wall_ms"], ["perf_det_npu_hw_ms", "npu_hw_ms"],
      ["perf_det_post_ms", "post_ms"], ["perf_det_e2e_ms", "e2e_ms"], ["perf_det_overlap_saved_ms", "overlap_saved_ms"],
      ["perf_det_task_fps", "task_fps"], ["perf_det_cycle_fps", "cycle_fps"], ["perf_det_result_age_ms", "result_age_ms"],
    ]) {
      const problem = compareScalar(rootField, root?.[rootField], `${source.path}.${runtimeField}`, source.value[runtimeField]);
      if (problem) return problem;
    }
  }
  if (pcie && typeof pcie === "object" && !Array.isArray(pcie)) {
    for (const [rootField, nestedField] of [
      ["input_mode", "input_mode"], ["capture_running", "capture_running"],
      ["pcie_source_mask", "source_mask"], ["pcie_inference_strategy_configured", "configured_strategy"],
      ["pcie_plate_inference_strategy", "strategy"], ["plate_model_input_width", "model_input_width"],
      ["plate_model_input_height", "model_input_height"], ["plate_model_input_format", "model_input_format"],
      ["source_frame_format", "source_frame_format"],
    ]) {
      const scalarProblem = compareScalar(rootField, root?.[rootField], `pcie_plate_inference.${nestedField}`, pcie[nestedField]);
      if (scalarProblem) return scalarProblem;
    }
    for (const [rootField, nestedField] of [
      ["plate_inference_pipeline_enabled", "pipeline_enabled"],
    ]) {
      const scalarProblem = compareScalar(rootField, root?.[rootField], `pcie_plate_inference.${nestedField}`, pcie[nestedField]);
      if (scalarProblem) return scalarProblem;
    }
  }
  const driverStatus = root?.driver_status;
  if (driverStatus && typeof driverStatus === "object" && !Array.isArray(driverStatus)) {
    const nodeProblem = compareScalar("pcie_driver_node", root?.pcie_driver_node, "driver_status.device_node.path", driverStatus.device_node?.path);
    if (nodeProblem) return nodeProblem;
  }
  const reportDelivery = root?.report_delivery;
  if (reportDelivery && typeof reportDelivery === "object" && !Array.isArray(reportDelivery)) {
    for (const [flat, nested] of [["report_pending_count", "pending_count"], ["report_rejected_count", "rejected_saved_count"], ["report_last_result", "last_result"], ["report_last_error", "last_error"]]) {
      const problem = validateRkEquivalentSources([
        { path: flat, value: { value: root?.[flat] } },
        { path: `report_delivery`, value: { value: reportDelivery[nested] } },
      ], ["value"]);
      if (problem) return { ...problem, field: `report_delivery.${nested}` };
    }
  }
  const runtimeSettings = root?.runtime_settings;
  if (runtimeSettings && typeof runtimeSettings === "object" && !Array.isArray(runtimeSettings)) {
    const strategyProblem = compareScalar(
      "pcie_inference_strategy_configured",
      root?.pcie_inference_strategy_configured,
      "runtime_settings.pcie_inference_strategy",
      runtimeSettings.pcie_inference_strategy,
    );
    if (strategyProblem) return strategyProblem;
  }
  return null;
}

function validateRkCaptureMetricHex(root) {
  const sources = [
    { path: "driver_capture_metrics", value: root?.driver_capture_metrics },
    { path: "driver_status.capture_metrics", value: root?.driver_status?.capture_metrics },
    { path: "driver_status.pcie.capture_metrics", value: root?.driver_status?.pcie?.capture_metrics },
    { path: "pcie_top_level", value: captureMetricsTopLevelSource(root) },
  ];
  const hexFields = [
    "driver_abi_hex", "driver_features_hex", "fpga_protocol_hex", "fpga_capabilities_hex", "fpga_build_id_hex",
    "fpga_debug_state_hex", "fifo_level_01_hex", "fifo_level_23_hex", "fpga_handshake_state_hex", "source_mask_hex",
  ];
  const hexSeen = new Map();
  for (const source of sources) {
    if (!source.value || typeof source.value !== "object") continue;
    for (const field of hexFields) {
      if (!Object.prototype.hasOwnProperty.call(source.value, field)) continue;
      const value = source.value[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" || (value.trim() && !/^0x[0-9a-f]+$/i.test(value.trim()))) {
        return rkPayloadProblem(`${source.path}.${field}`, `${source.path}.${field} must be a hexadecimal string`);
      }
      if (typeof value === "string" && value.trim()) {
        const numeric = Number.parseInt(value.trim(), 16);
        const previous = hexSeen.get(field);
        if (previous && previous.value !== numeric) {
          return rkPayloadProblem(`${source.path}.${field}`, `${source.path}.${field} conflicts with ${previous.path}.${field}`);
        }
        if (!previous) hexSeen.set(field, { value: numeric, path: source.path });
      }
    }
    if (typeof source.value.source_mask === "number" && typeof source.value.source_mask_hex === "string" && source.value.source_mask_hex.trim()) {
      if (Number.parseInt(source.value.source_mask_hex, 16) !== source.value.source_mask) {
        return rkPayloadProblem(`${source.path}.source_mask_hex`, `${source.path}.source_mask_hex must match source_mask`);
      }
    }
    for (const [numberField, hexField] of [
      ["driver_abi_version", "driver_abi_hex"], ["driver_features", "driver_features_hex"],
      ["fpga_protocol_version", "fpga_protocol_hex"], ["fpga_capabilities", "fpga_capabilities_hex"],
      ["fpga_build_id", "fpga_build_id_hex"],
    ]) {
      if (typeof source.value[numberField] !== "number" || !Number.isSafeInteger(source.value[numberField])) continue;
      if (typeof source.value[hexField] !== "string" || !source.value[hexField].trim()) continue;
      if (Number.parseInt(source.value[hexField], 16) !== source.value[numberField]) {
        return rkPayloadProblem(`${source.path}.${hexField}`, `${source.path}.${hexField} must match ${numberField}`);
      }
    }
  }
  return null;
}

function validateRkDriverStatusDeep(root) {
  const status = root?.driver_status;
  if (!status || typeof status !== "object" || Array.isArray(status)) return null;
  const validateObjectArray = (value, path, spec, maxItems = Number.MAX_SAFE_INTEGER) => {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value)) return rkPayloadProblem(path, `${path} must be an array`);
    if (value.length > maxItems) return rkPayloadProblem(path, `${path} exceeds the ${maxItems} item limit`);
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (!item || typeof item !== "object" || Array.isArray(item)) return rkPayloadProblem(`${path}[${index}]`, `${path}[${index}] must be an object`);
      const problem = validateRkNestedFields(item, `${path}[${index}]`, spec);
      if (problem) return problem;
    }
    return null;
  };
  const validateStringArray = (value, path, max = 500, maxItems = Number.MAX_SAFE_INTEGER) => {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value)) return rkPayloadProblem(path, `${path} must be an array`);
    if (value.length > maxItems) return rkPayloadProblem(path, `${path} exceeds the ${maxItems} item limit`);
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] !== "string" || value[index].length > max || /[\x00-\x1f\x7f]/.test(value[index])) {
        return rkPayloadProblem(`${path}[${index}]`, `${path}[${index}] must be a printable string`);
      }
    }
    return null;
  };
  const freqSpec = {
    strings: [["name", 160], ["policy", 80], ["sysfs", 500], ["governor", 80], ["cur_freq_text", 120], ["usage_text", 120], ["load_raw", 240]],
    numbers: [["cur_freq_khz", 0, Number.MAX_SAFE_INTEGER], ["cur_freq_hz", 0, Number.MAX_SAFE_INTEGER], ["cur_freq_mhz", 0, Number.MAX_SAFE_INTEGER], ["usage_percent", 0, 100]],
  };
  const cpuPoliciesProblem = validateObjectArray(status.cpu?.policies, "driver_status.cpu.policies", freqSpec, 32);
  if (cpuPoliciesProblem) return cpuPoliciesProblem;
  for (const kind of ["gpu", "npu"]) {
    const devicesProblem = validateObjectArray(status[kind]?.devices, `driver_status.${kind}.devices`, {
      strings: [["name", 160], ["policy", 80], ["sysfs", 500], ["governor", 80], ["cur_freq_text", 120], ["usage_text", 120], ["load_raw", 240]],
      numbers: [["cur_freq_khz", 0, Number.MAX_SAFE_INTEGER], ["cur_freq_hz", 0, Number.MAX_SAFE_INTEGER], ["cur_freq_mhz", 0, Number.MAX_SAFE_INTEGER], ["usage_percent", 0, 100]],
    }, 32);
    if (devicesProblem) return devicesProblem;
  }
  if (status.interrupt?.per_cpu !== undefined && status.interrupt.per_cpu !== null) {
    if (status.interrupt.per_cpu.length > 64) return rkPayloadProblem("driver_status.interrupt.per_cpu", "driver_status.interrupt.per_cpu exceeds the 64 item limit");
    const perCpuProblem = validateRkNestedArrayItems(status.interrupt.per_cpu, "driver_status.interrupt.per_cpu", { min: 0 });
    if (perCpuProblem) return perCpuProblem;
  }
  const suggestionsProblem = validateStringArray(status.suggestions, "driver_status.suggestions", 500, 100);
  if (suggestionsProblem) return suggestionsProblem;
  if (status.rows !== undefined && status.rows !== null) {
    if (!Array.isArray(status.rows)) return rkPayloadProblem("driver_status.rows", "driver_status.rows must be an array");
    if (status.rows.length > 500) return rkPayloadProblem("driver_status.rows", "driver_status.rows exceeds the 500 item limit");
    for (let index = 0; index < status.rows.length; index += 1) {
      const row = status.rows[index];
      if (!row || typeof row !== "object" || Array.isArray(row)) return rkPayloadProblem(`driver_status.rows[${index}]`, `driver_status.rows[${index}] must be an object`);
      const rowProblem = validateRkNestedFields(row, `driver_status.rows[${index}]`, {
        strings: [["category", 80], ["item", 180], ["value", 500], ["detail", 1600]],
      });
      if (rowProblem) return rowProblem;
    }
  }
  const pcie = status.pcie;
  if (pcie?.devices !== undefined && pcie.devices !== null) {
    if (!Array.isArray(pcie.devices)) return rkPayloadProblem("driver_status.pcie.devices", "driver_status.pcie.devices must be an array");
    if (pcie.devices.length > 64) return rkPayloadProblem("driver_status.pcie.devices", "driver_status.pcie.devices exceeds the 64 item limit");
    for (let index = 0; index < pcie.devices.length; index += 1) {
      const device = pcie.devices[index];
      if (!device || typeof device !== "object" || Array.isArray(device)) return rkPayloadProblem(`driver_status.pcie.devices[${index}]`, `driver_status.pcie.devices[${index}] must be an object`);
      const deviceProblem = validateRkNestedFields(device, `driver_status.pcie.devices[${index}]`, {
        strings: [["bdf", 160], ["vendor", 160], ["device", 160], ["class", 160], ["irq", 160], ["enable", 160]],
        objects: ["link", "capability", "msi"],
      });
      if (deviceProblem) return deviceProblem;
      for (const [nested, spec] of [
        ["link", { strings: [["current_speed", 160], ["current_width", 160], ["max_speed", 160], ["max_width", 160]] }],
        ["capability", { booleans: ["pcie_present"], numbers: [["mps_bytes", 0, Number.MAX_SAFE_INTEGER], ["mrrs_bytes", 0, Number.MAX_SAFE_INTEGER]], strings: [["mps", 80], ["mrrs", 80]] }],
        ["msi", { booleans: ["present", "enabled"], numbers: [["mmc", 0, Number.MAX_SAFE_INTEGER], ["mme", 0, Number.MAX_SAFE_INTEGER]] }],
      ]) {
        const nestedProblem = validateRkNestedObject(device, nested, spec);
        if (nestedProblem) return { ...nestedProblem, field: `driver_status.pcie.devices[${index}].${nestedProblem.field}` };
      }
    }
  }
  return null;
}

function validateRkStatusPayload(root) {
  if (!rkPayloadUsesV1(root)) return null;
  const stringFields = [
    ["time_bj", 32],
    ["role", 40],
    ["user_state", 40],
    ["ui_mode", 40],
    ["account_mode", 40],
    ["biz_system", 40],
    ["adas_schema", 40],
    ["adas_scene", 48],
    ["adas_lane", 48],
    ["adas_lane_marking", 48],
    ["adas_signal", 48],
    ["adas_maneuver", 48],
    ["adas_turn_signal", 48],
    ["adas_input_source", 48],
    ["adas_alarm_text", 240],
    ["adas_fpga_arm_link", 80],
    ["input_mode", 24],
    ["infer_mode", 32],
    ["view", 160],
    ["sd_source_path", 1024],
    ["driver", 120],
    ["pcie_driver_node", 500],
    ["backend_base", 300],
    ["backend_source", 40],
    ["backend_error", 300],
    ["backend_last_ok_at", 80],
    ["backend_last_test_at", 80],
    ["runtime_settings_path", 1024],
    ["target_device_id", 80],
    ["rk_api_bind", 160],
    ["rk_api_error", 500],
    ["perf_cap_basis", 80],
    ["plate_detector_model_path", 1024],
    ["plate_detector_model_name", 160],
    ["detector_profile", 120],
    ["detector_family", 120],
    ["detector_model_name", 160],
    ["detector_input_type", 120],
    ["detector_output_contract", 600],
    ["detector_runtime_backend", 120],
    ["plate_recognizer_model_path", 1024],
    ["plate_recognizer_model_name", 160],
    ["recognizer_profile", 120],
    ["recognizer_output_contract", 600],
    ["recognizer_input_format", 120],
    ["recognizer_text_layout", 160],
    ["recognizer_runtime_backend", 120],
    ["plate_model_input_format", 80],
    ["plate_inference_strategy", 120],
    ["plate_preprocess_backend", 80],
    ["plate_preprocess_requested", 80],
    ["plate_preprocess_fallback_reason", 300],
    ["pcie_plate_inference_strategy", 120],
    ["plate_detector_configured_model_file", 512],
    ["plate_detector_active_model", 96],
    ["plate_detector_input", 160],
    ["plate_detector_postprocess", 320],
    ["plate_detector_model_error", 500],
    ["plate_recognizer_model_error", 500],
    ["perf_det_task_fps_semantics", 80],
    ["perf_det_cycle_fps_semantics", 80],
    ["pcie_protocol", 80],
    ["pcie_mode", 80],
    ["pcie_metric_basis", 120],
    ["pcie_last_capture_basis", 120],
    ["pcie_last_frame_at", 120],
    ["pcie_interrupt_mode", 80],
    ["pcie_recovery_state", 120],
    ["pcie_batch_fallback_reason", 300],
    ["pcie_irq_fallback_reason", 300],
    ["pcie_driver_abi_hex", 80],
    ["pcie_driver_features_hex", 80],
    ["pcie_fpga_protocol_hex", 80],
    ["pcie_fpga_capabilities_hex", 80],
    ["pcie_fpga_build_id_hex", 80],
    ["pcie_fpga_debug_state_hex", 80],
    ["pcie_fifo_level_01_hex", 80],
    ["pcie_fifo_level_23_hex", 80],
    ["pcie_fpga_handshake_state_hex", 80],
    ["pcie_source_mask_hex", 80],
    ["user_message_config_path", 1024],
    ["report_last_result", 80],
    ["report_last_error", 500],
  ];
  for (const [field, max] of stringFields) {
    const problem = validateRkPayloadString(root, field, { max });
    if (problem) return problem;
  }
  const targetDeviceProblem = validateRkDeviceIdField(root, "target_device_id");
  if (targetDeviceProblem) return targetDeviceProblem;
  for (const [field, values] of [
    ["role", ["user", "admin", "developer"]],
    ["user_state", ["normal", "user", "admin", "developer"]],
    ["ui_mode", ["user", "admin", "developer"]],
    ["account_mode", ["user", "admin", "developer"]],
    ["biz_system", ["parking", "etc", "adas"]],
    ["adas_schema", ["pango_adas.v1"]],
    ["adas_scene", ["路口信号灯", "道路变道", "行人/障碍物", "夜间道路"]],
    ["adas_lane", ["左车道", "直行车道", "右车道"]],
    ["adas_lane_marking", ["虚线", "实线", "未知"]],
    ["adas_signal", ["红灯", "绿灯", "黄灯", "未知"]],
    ["adas_maneuver", ["左转", "直行", "右转", "停车"]],
    ["adas_turn_signal", ["关闭", "左转向灯", "右转向灯"]],
    ["adas_input_source", ["manual_console", "unknown"]],
    ["driver", ["mounted", "not_mounted", "ok", "error", "unknown", "unavailable"]],
    ["input_mode", ["pcie", "sdcard"]],
    ["infer_mode", ["plate", "env", "overlay"]],
  ]) {
    const problem = validateRkPayloadEnum(root, field, values);
    if (problem) return problem;
  }
  if (root.user_state === "user" && root.role !== "user") {
    return rkPayloadProblem("user_state", "user_state=user requires role=user");
  }
  for (const field of [
    "capture_running", "backend_ok", "rk_api_listening", "pcie_driver_mounted", "pcie_driver_module_ok", "pcie_driver_bound_ok",
    "adas_moving", "adas_forced_change", "adas_obstacle", "adas_alarm",
    "plate_inference_pipeline_enabled", "plate_inference_pipeline_active", "plate_det_quantized_output",
    "plate_detector_model_ready", "plate_recognizer_model_ready", "auto_exposure_enabled",
    "plate_capture_async", "plate_latest_only", "pcie_sliding_enabled", "pcie_four_source_sliding_configured",
    "pcie_four_source_fixed_roi_enabled", "plate_sliding_status_known", "plate_sliding_active", "plate_sliding_enabled_last_run", "plate_sliding_removed",
    "pcie_metric_valid", "pcie_bar_contract_ok", "pcie_all_four_sources_valid", "pcie_rate_control_supported", "pcie_fixed_30fps_active",
    "pcie_v1_fallback_allowed", "pcie_v1_fallback_active", "pcie_source_locked", "pcie_staged_copy", "pcie_batch_ioctl",
    "pcie_irq_wait", "pcie_irq_fallback", "pcie_frame_v2", "pcie_mmap_enabled",
  ]) {
    const problem = validateRkPayloadBoolean(root, field);
    if (problem) return problem;
  }
  for (const field of [
    "fps", "perf_cap_ms", "capture_ms", "perf_conv_ms", "perf_view_ms", "perf_det_ms", "perf_ocr_ms",
    "perf_env_ms", "perf_infer_ms", "infer_ms", "perf_ui_ms", "perf_disp_ms", "perf_total_ms", "backend_latency_ms",
    "perf_det_pre_ms", "perf_det_npu_wall_ms", "perf_det_npu_hw_ms", "perf_det_post_ms", "perf_det_e2e_ms",
    "perf_det_overlap_saved_ms", "perf_det_task_fps", "perf_det_cycle_fps", "perf_det_result_age_ms",
    "perf_det_task_throughput_fps", "perf_det_subtask_throughput_fps", "perf_det_cycle_ms",
    "perf_display_cycle_ms", "perf_display_fps", "perf_capture_dropped_frames", "plate_overlay_max_age_ms",
    "plate_inference_result_age_ms", "plate_inference_pre_ms", "plate_inference_npu_ms", "plate_inference_post_ms",
    "pcie_rx_fps", "pcie_frame_interval_ms", "pcie_dma_ms", "pcie_dma_wait_ms", "pcie_dma_wait_avg_ms",
    "pcie_dma_wait_max_ms", "pcie_dma_wait_window_ms", "pcie_kernel_staging_ms", "pcie_user_copy_ms",
    "pcie_actual_rx_fps", "pcie_last_capture_ms",
  ]) {
    const problem = validateRkPayloadNumber(root, field, { min: 0 });
    if (problem) return problem;
  }
  for (const field of [
    "rk_api_port", "auto_exposure_level", "plate_detector_model", "plate_detector_configured_model", "detector_profile_id", "recognizer_profile_id", "plate_model_input_width", "plate_model_input_height",
    "detector_input_width", "detector_input_height", "recognizer_input_width", "recognizer_input_height",
    "pcie_inference_strategy_configured", "plate_inference_calls_per_cycle", "perf_det_task_count", "perf_det_queue_depth",
    "perf_det_dropped_tasks", "report_pending_count", "report_rejected_count", "pcie_dma_wait_sample_count", "pcie_rx_frames",
    "pcie_dropped_frames", "pcie_fpga_dropped_frames", "pcie_host_dropped_frames", "pcie_sequence_gaps", "pcie_driver_abi_version",
    "pcie_driver_features", "pcie_fpga_protocol_version", "pcie_fpga_capabilities", "pcie_target_fps_milli",
    "pcie_fpga_target_fps_milli", "pcie_bar0_read_bytes", "pcie_bar1_write_bytes", "pcie_source_mask", "pcie_fpga_build_id",
    "pcie_recovery_count", "pcie_consecutive_timeouts", "pcie_protocol_errors", "pcie_frame_width", "pcie_frame_height",
    "pcie_frame_stride_bytes", "pcie_frame_bytes", "pcie_ring_count", "plate_sliding_work_width",
    "plate_sliding_work_height", "plate_sliding_window_width", "plate_sliding_window_height", "plate_sliding_stride_x", "plate_sliding_stride_y",
    "pcie_dma_wait_sample_count", "pcie_dma_unit_bytes", "pcie_dma_unit_count", "pcie_overlap_window_width", "pcie_overlap_window_height",
    "pcie_overlap_pixels", "pcie_overlap_phase_count", "pcie_fragment_recovery_limit", "pcie_planned_base_calls_per_cycle",
    "adas_speed_kmh", "adas_speed_limit_kmh",
  ]) {
    const problem = validateRkPayloadNumber(root, field, { integer: true, min: 0 });
    if (problem) return problem;
  }
  const slidingWindowCountProblem = validateRkPayloadNumber(root, "plate_sliding_window_count", { integer: true, min: -1, max: 1000000 });
  if (slidingWindowCountProblem) return slidingWindowCountProblem;
  for (const [field, min, max] of [
    ["rk_api_port", 0, 65535], ["auto_exposure_level", 0, 100], ["detector_profile_id", 0, 4], ["recognizer_profile_id", 0, 2],
    ["pcie_inference_strategy_configured", 0, 2], ["pcie_source_mask", 0, 15], ["plate_detector_model", 0, 1],
    ["plate_detector_configured_model", 0, 1], ["plate_model_input_width", 0, 16384], ["plate_model_input_height", 0, 16384],
    ["detector_input_width", 0, 16384], ["detector_input_height", 0, 16384], ["recognizer_input_width", 0, 16384], ["recognizer_input_height", 0, 16384],
    ["pcie_overlap_window_width", 720, 1024],
    ["adas_speed_kmh", 0, 180], ["adas_speed_limit_kmh", 0, 180],
  ]) {
    if (Object.prototype.hasOwnProperty.call(root, field) && root[field] !== null && (root[field] < min || root[field] > max)) {
      return rkPayloadProblem(field, `${field} must be between ${min} and ${max}`);
    }
  }
  for (const field of [
    "runtime_settings", "driver_status", "pcie_dma_memory", "pcie_plate_inference", "plate_detector_runtime", "detector_runtime", "driver_capture_metrics",
    "report_delivery", "user_message_config", "user_message_config_sync", "tts_wav", "adas_perception",
  ]) {
    const problem = validateRkPayloadObject(root, field);
    if (problem) return problem;
  }
  const runtimeSettingsProblem = validateRkNestedObject(root, "runtime_settings", {
    strings: [["schema", 120], ["audio_output_device", 300], ["target_device_id", 80]],
    numbers: [
      ["plate_conf", 0, 1], ["env_conf", 0, 1], ["plate_min_sharpness", 0, 1000000],
      ["model_trust_val", 0, 1000], ["min_color_ratio", 0, 1],
      ["rec_conf_threshold", 0, 1000], ["double_upper_ratio", 0, 1000],
    ],
    integers: [
      ["algo_mode", 0, 16], ["theme", 0, 2], ["sd_image_interval_sec", 0, 86400], ["plate_ocr_period", 0, 1000000],
      ["plate_infer_stride", 0, 1000000], ["plate_sliding_mode", 0, 16], ["pcie_inference_strategy", 0, 2],
      ["det_preprocess_backend", 0, 2], ["detector_profile", 0, 4], ["recognizer_profile", 0, 2],
      ["pcie_overlap_window_width", 720, 1024],
      ["plate_geometry_min_short_edge", 0, 1000000], ["plate_geometry_min_area", 0, 1000000000],
      ["plate_geometry_min_aspect_x100", 0, 1000000], ["plate_geometry_max_aspect_x100", 0, 1000000],
      ["plate_min_short_edge", 0, 1000000], ["env_infer_stride", 0, 1000000], ["plate_stable_required", 0, 1000000],
      ["plate_box_hold_runs", 0, 1000000],
      ["plate_cooldown_frames", 0, 1000000], ["black_v_max", 0, 1000000], ["white_s_max", 0, 1000000],
      ["blue_h_min", 0, 1000000], ["green_h_min", 0, 1000000], ["yellow_h_min", 0, 1000000],
      ["yellow_h_max", 0, 1000000], ["double_lower_start", 0, 1000000],
    ],
    booleans: [
      "dedupe_by_source", "global_inference_enabled", "plate_sliding_enabled", "pcie_four_source_sliding", "det_pipeline_enabled", "det_quantized_output",
      "plate_show_unconfirmed", "plate_show_suspected", "plate_geometry_filter_enabled", "plate_upload_thumb", "env_enable", "show_det_parts",
    ],
  });
  if (runtimeSettingsProblem) return runtimeSettingsProblem;
  for (const field of ["draw_overlay", "draw_text", "draw_split"]) {
    const value = root.runtime_settings?.[field];
    if (value === undefined || value === null || typeof value === "boolean") continue;
    if (!Number.isSafeInteger(value) || (value !== 0 && value !== 1)) {
      return rkPayloadProblem(`runtime_settings.${field}`, `runtime_settings.${field} must be boolean or 0/1`);
    }
  }
  const runtimeTargetProblem = validateRkDeviceIdField(root.runtime_settings || {}, "target_device_id", "runtime_settings.target_device_id");
  if (runtimeTargetProblem) return runtimeTargetProblem;
  if (root.runtime_settings?.schema !== undefined && root.runtime_settings.schema !== null
      && (typeof root.runtime_settings.schema !== "string" || !/^rk3568\.runtime_settings\.v\d+$/.test(root.runtime_settings.schema))) {
    return rkPayloadProblem("runtime_settings.schema", "runtime_settings.schema must use rk3568.runtime_settings.vN");
  }
  const detectorRuntimeProblem = validateRkNestedObject(root, "plate_detector_runtime", RK_DETECTOR_RUNTIME_SPEC);
  if (detectorRuntimeProblem) return detectorRuntimeProblem;
  for (const [field, allowed] of [["strategy", RK_INFERENCE_STRATEGIES], ["preprocess_backend", RK_PREPROCESS_BACKENDS], ["preprocess_requested", RK_PREPROCESS_BACKENDS]]) {
    const enumProblem = validateRkNestedEnumValue(root.plate_detector_runtime?.[field], `plate_detector_runtime.${field}`, allowed);
    if (enumProblem) return enumProblem;
  }
  for (const field of ["model_input_format", "recognizer_input_format"]) {
    const formatProblem = validateRkFrameFormatValue(root.plate_detector_runtime?.[field], `plate_detector_runtime.${field}`);
    if (formatProblem) return formatProblem;
  }
  for (const field of ["plate_inference_strategy"]) {
    const enumProblem = validateRkPayloadEnum(root, field, Array.from(RK_INFERENCE_STRATEGIES));
    if (enumProblem) return enumProblem;
  }
  for (const field of ["plate_preprocess_backend", "plate_preprocess_requested"]) {
    const enumProblem = validateRkPayloadEnum(root, field, Array.from(RK_PREPROCESS_BACKENDS));
    if (enumProblem) return enumProblem;
  }
  for (const field of ["pcie_plate_inference_strategy"]) {
    const enumProblem = validateRkPayloadEnum(root, field, Array.from(RK_INFERENCE_STRATEGIES));
    if (enumProblem) return enumProblem;
  }
  const rootLayoutProblem = validateRkSourceLayoutValue(root.source_layout, "source_layout");
  if (rootLayoutProblem) return rootLayoutProblem;
  for (const field of ["plate_model_input_format", "source_frame_format"]) {
    const formatProblem = validateRkFrameFormatValue(root[field], field);
    if (formatProblem) return formatProblem;
  }
  const detectorRuntimeAliasProblem = validateRkNestedObject(root, "detector_runtime", RK_DETECTOR_RUNTIME_SPEC);
  if (detectorRuntimeAliasProblem) return detectorRuntimeAliasProblem;
  for (const [field, allowed] of [["strategy", RK_INFERENCE_STRATEGIES], ["preprocess_backend", RK_PREPROCESS_BACKENDS], ["preprocess_requested", RK_PREPROCESS_BACKENDS]]) {
    const enumProblem = validateRkNestedEnumValue(root.detector_runtime?.[field], `detector_runtime.${field}`, allowed);
    if (enumProblem) return enumProblem;
  }
  for (const field of ["model_input_format", "recognizer_input_format"]) {
    const formatProblem = validateRkFrameFormatValue(root.detector_runtime?.[field], `detector_runtime.${field}`);
    if (formatProblem) return formatProblem;
  }
  const pcieProblem = validateRkNestedObject(root, "pcie_plate_inference", {
    strings: [["schema", 120], ["input_mode", 24], ["view", 80], ["strategy", 120], ["source_layout", 40], ["source_frame_format", 80], ["model_input_format", 80], ["inference_unit", 40], ["detector_profile", 120], ["detector_family", 120], ["detector_output_contract", 600]],
    integers: [
      ["configured_strategy", 0, 2], ["calls_per_cycle", 0, 1000000], ["preprocess_backend_configured", 0, 2],
      ["planned_base_calls_per_cycle", 0, 1000000],
      ["source_count", 0, 4], ["active_source_count", 0, 4], ["source_mask", 0, 15], ["source_frame_width", 0, 65536],
      ["source_frame_height", 0, 65536], ["source_width", 0, 65536], ["source_height", 0, 65536], ["mosaic_width", 0, 131072],
      ["mosaic_height", 0, 131072], ["model_input_width", 0, 16384], ["model_input_height", 0, 16384],
      ["overlap_window_width", 0, 65536], ["overlap_window_height", 0, 65536], ["overlap_pixels", 0, 65536],
      ["overlap_phase_count", 0, 1000000], ["fragment_recovery_limit", 0, 4],
    ],
    booleans: [
      "applicable", "capture_running", "fixed_roi_enabled", "pcie_sliding_enabled", "configured_sliding", "pipeline_enabled", "rga_compiled",
      "quantized_output", "sliding_disabled_for_pcie", "fragment_companion_same_frame", "fragment_union_roi_redetect",
    ],
    objects: ["runtime", "detector_runtime", "single_pass_letterbox", "per_source_letterbox"],
    arrays: ["source_indices"],
  });
  if (pcieProblem) return pcieProblem;
  const pcieValue = root.pcie_plate_inference;
  if (pcieValue?.schema !== undefined && pcieValue.schema !== null && (typeof pcieValue.schema !== "string" || !/^rk3568_pcie_plate_inference_v[1-3]$/.test(pcieValue.schema))) {
    return rkPayloadProblem("pcie_plate_inference.schema", "pcie_plate_inference.schema must use rk3568_pcie_plate_inference_v1..v3");
  }
  if (pcieValue?.input_mode !== undefined && pcieValue.input_mode !== null && !["pcie", "sdcard"].includes(pcieValue.input_mode)) {
    return rkPayloadProblem("pcie_plate_inference.input_mode", "pcie_plate_inference.input_mode must be pcie or sdcard");
  }
  for (const field of ["source_frame_format", "model_input_format"]) {
    const formatProblem = validateRkFrameFormatValue(pcieValue?.[field], `pcie_plate_inference.${field}`);
    if (formatProblem) return formatProblem;
  }
  for (const [field, allowed] of [
    ["strategy", RK_INFERENCE_STRATEGIES], ["inference_unit", RK_INFERENCE_UNITS],
    ["preprocess_backend", RK_PREPROCESS_BACKENDS],
  ]) {
    const enumProblem = validateRkNestedEnumValue(pcieValue?.[field], `pcie_plate_inference.${field}`, allowed);
    if (enumProblem) return enumProblem;
  }
  for (const field of ["source_layout"]) {
    const layoutProblem = validateRkSourceLayoutValue(pcieValue?.[field], `pcie_plate_inference.${field}`);
    if (layoutProblem) return layoutProblem;
  }
  if (root.pcie_plate_inference && Object.prototype.hasOwnProperty.call(root.pcie_plate_inference, "source_indices")) {
    const sourceIndicesProblem = validateRkNestedArrayItems(root.pcie_plate_inference.source_indices, "pcie_plate_inference.source_indices", { integer: true, min: 1, max: 4 });
    if (sourceIndicesProblem) return sourceIndicesProblem;
  }
  for (const field of ["single_pass_letterbox", "per_source_letterbox"]) {
    const letterboxProblem = validateRkNestedObject(root.pcie_plate_inference || {}, field, {
      integers: [
        ["source_width", 0, 65536], ["source_height", 0, 65536], ["model_width", 0, 16384], ["model_height", 0, 16384],
        ["content_width", 0, 16384], ["content_height", 0, 16384], ["pad_left", 0, 16384], ["pad_right", 0, 16384],
        ["pad_top", 0, 16384], ["pad_bottom", 0, 16384], ["pad_value_rgb", 0, 255], ["pad_value_bgr", 0, 255],
      ],
      booleans: ["scaleup"],
    }, `pcie_plate_inference.${field}`);
    if (letterboxProblem) return letterboxProblem;
    const consistencyProblem = validateRkLetterboxConsistency(root.pcie_plate_inference, field);
    if (consistencyProblem) return consistencyProblem;
  }
  const pcieRuntimeProblem = validateRkNestedObject(root.pcie_plate_inference || {}, "runtime", {
    strings: [["strategy", 120]],
    integers: [["window_count", -1, 1000000], ["work_width", 0, 65536], ["work_height", 0, 65536], ["window_width", 0, 65536], ["window_height", 0, 65536], ["stride_x", 0, 65536], ["stride_y", 0, 65536]],
    booleans: ["status_known", "enabled", "active", "removed", "pcie_fixed_roi_enabled"],
  }, "pcie_plate_inference.runtime");
  if (pcieRuntimeProblem) return pcieRuntimeProblem;
  const runtimeStrategyProblem = validateRkNestedEnumValue(root.pcie_plate_inference?.runtime?.strategy, "pcie_plate_inference.runtime.strategy", RK_INFERENCE_STRATEGIES);
  if (runtimeStrategyProblem) return runtimeStrategyProblem;
  const pcieDetectorProblem = validateRkNestedObject(
    root.pcie_plate_inference || {},
    "detector_runtime",
    RK_DETECTOR_RUNTIME_SPEC,
    "pcie_plate_inference.detector_runtime",
  );
  if (pcieDetectorProblem) return pcieDetectorProblem;
  for (const [field, allowed] of [["strategy", RK_INFERENCE_STRATEGIES], ["preprocess_backend", RK_PREPROCESS_BACKENDS], ["preprocess_requested", RK_PREPROCESS_BACKENDS]]) {
    const enumProblem = validateRkNestedEnumValue(root.pcie_plate_inference?.detector_runtime?.[field], `pcie_plate_inference.detector_runtime.${field}`, allowed);
    if (enumProblem) return enumProblem;
  }
  for (const field of ["model_input_format", "recognizer_input_format"]) {
    const formatProblem = validateRkFrameFormatValue(root.pcie_plate_inference?.detector_runtime?.[field], `pcie_plate_inference.detector_runtime.${field}`);
    if (formatProblem) return formatProblem;
  }
  const driverCaptureMetricsSpec = {
    strings: [["mode", 80], ["protocol", 80], ["driver_abi_hex", 80], ["driver_features_hex", 80], ["fpga_protocol_hex", 80], ["fpga_capabilities_hex", 80], ["fpga_build_id_hex", 80], ["fpga_debug_state_hex", 80], ["fifo_level_01_hex", 80], ["fifo_level_23_hex", 80], ["fpga_handshake_state_hex", 80], ["source_mask_hex", 80], ["recovery_state", 120], ["metric_basis", 120], ["last_capture_basis", 120], ["last_error", 500], ["batch_fallback_reason", 300], ["irq_fallback_reason", 300], ["last_frame_at", 120], ["interrupt_mode", 80]],
    numbers: [
      ["actual_rx_fps", 0, 100000], ["frame_interval_ms", 0, 1000000000], ["dma_wait_ms", 0, 1000000000],
      ["dma_wait_avg_ms", 0, 1000000000], ["dma_wait_max_ms", 0, 1000000000], ["dma_wait_window_ms", 0, 1000000000],
      ["dma_transfer_ms", 0, 1000000000], ["kernel_staging_ms", 0, 1000000000], ["user_copy_ms", 0, 1000000000], ["last_capture_ms", 0, 1000000000],
    ],
    integers: [
      ["driver_abi_version", 0, Number.MAX_SAFE_INTEGER], ["driver_features", 0, Number.MAX_SAFE_INTEGER],
      ["fpga_protocol_version", 0, Number.MAX_SAFE_INTEGER], ["fpga_capabilities", 0, Number.MAX_SAFE_INTEGER],
      ["target_fps_milli", 0, 1000000], ["fpga_target_fps_milli", 0, 1000000], ["bar0_read_bytes", 0, Number.MAX_SAFE_INTEGER],
      ["bar1_write_bytes", 0, Number.MAX_SAFE_INTEGER], ["source_mask", 0, 15], ["fpga_build_id", 0, Number.MAX_SAFE_INTEGER],
      ["recovery_count", 0, Number.MAX_SAFE_INTEGER], ["consecutive_timeouts", 0, Number.MAX_SAFE_INTEGER], ["frames_total", 0, Number.MAX_SAFE_INTEGER],
      ["complete_frames", 0, Number.MAX_SAFE_INTEGER], ["dropped_frames", 0, Number.MAX_SAFE_INTEGER], ["fpga_dropped_frames", 0, Number.MAX_SAFE_INTEGER],
      ["host_dropped_frames", 0, Number.MAX_SAFE_INTEGER], ["sequence_gaps", 0, Number.MAX_SAFE_INTEGER], ["protocol_errors", 0, Number.MAX_SAFE_INTEGER],
      ["dma_wait_sample_count", 0, Number.MAX_SAFE_INTEGER], ["dma_unit_bytes", 0, Number.MAX_SAFE_INTEGER], ["dma_unit_count", 0, Number.MAX_SAFE_INTEGER],
      ["dma_units_per_frame", 0, Number.MAX_SAFE_INTEGER], ["frame_width", 0, 65536], ["frame_height", 0, 65536],
      ["frame_stride_bytes", 0, Number.MAX_SAFE_INTEGER], ["frame_bytes", 0, Number.MAX_SAFE_INTEGER], ["ring_count", 0, 1024],
    ],
    booleans: ["running", "pcie", "metric_valid", "bar_contract_ok", "all_four_sources_valid", "rate_control_supported", "fixed_30fps_active", "v1_fallback_allowed", "v1_fallback_active", "source_locked", "batch_ioctl", "irq_wait", "irq_fallback", "staged_copy", "frame_v2", "mmap_enabled"],
  };
  const driverMetricsProblem = validateRkNestedObject(root, "driver_capture_metrics", driverCaptureMetricsSpec);
  if (driverMetricsProblem) return driverMetricsProblem;
  const dmaProblem = validateRkNestedObject(root, "pcie_dma_memory", {
    strings: [["kernel_cmdline", 2000]],
    integers: [["cma_total_kb", 0, Number.MAX_SAFE_INTEGER], ["cma_free_kb", 0, Number.MAX_SAFE_INTEGER], ["cma_minimum_kb", 0, Number.MAX_SAFE_INTEGER], ["cma_recommended_kb", 0, Number.MAX_SAFE_INTEGER]],
    booleans: ["cma_sufficient", "cma_recommended"],
  });
  if (dmaProblem) return dmaProblem;
  const reportDeliveryProblem = validateRkNestedObject(root, "report_delivery", {
    strings: [["schema", 120], ["semantics", 40], ["idempotency_field", 80], ["queue_path", 1024], ["queue_persist_error", 500], ["last_report_id", 160], ["last_report_path", 240], ["last_result", 80], ["last_error", 500], ["last_attempt_at", 80], ["last_ok_at", 80], ["last_ack_id", 160]],
    integers: ["pending_count", "durable_pending_count", "rejected_saved_count", "queue_capacity", "request_timeout_ms", "accepted_total", "retry_total", "rejected_total", "dropped_total", "last_http_status"],
    booleans: ["in_flight", "queue_persist_ok"],
  });
  if (reportDeliveryProblem) return reportDeliveryProblem;
  const configProblem = validateRkNestedObject(root, "user_message_config", {
    strings: [["schema", 120], ["updated_at", 80]],
    integers: [["version", 0, Number.MAX_SAFE_INTEGER]],
  });
  if (configProblem) return configProblem;
  const syncProblem = validateRkNestedObject(root, "user_message_config_sync", {
    strings: [["path", 1024], ["last_result", 120], ["last_error", 500], ["last_sync_at", 80], ["last_applied_at", 80]],
    numbers: [["last_latency_ms", 0, null]],
    integers: [["interval_ms", 0, Number.MAX_SAFE_INTEGER], ["timeout_ms", 0, Number.MAX_SAFE_INTEGER], ["last_remote_version", 0, Number.MAX_SAFE_INTEGER]],
    booleans: ["enabled", "syncing", "last_ok"],
  });
  if (syncProblem) return syncProblem;
  const ttsProblem = validateRkNestedObject(root, "tts_wav", {
    strings: [["base_dir", 1024], ["output_device", 300], ["last_error", 500]],
    booleans: ["enabled", "ready"],
  });
  if (ttsProblem) return ttsProblem;
  const driverStatusProblem = validateRkNestedObject(root, "driver_status", {
    strings: [["schema", 120], ["time_local", 80], ["module_name", 120]],
    booleans: ["mounted"],
    objects: ["dma_memory", "device_node", "module", "cpu", "gpu", "npu", "interrupt", "pcie", "capture_metrics"],
    arrays: ["suggestions", "rows"],
  });
  if (driverStatusProblem) return driverStatusProblem;
  const driverDmaProblem = validateRkNestedObject(root.driver_status || {}, "dma_memory", {
    strings: [["kernel_cmdline", 2000]],
    integers: [["cma_total_kb", 0, Number.MAX_SAFE_INTEGER], ["cma_free_kb", 0, Number.MAX_SAFE_INTEGER], ["cma_minimum_kb", 0, Number.MAX_SAFE_INTEGER], ["cma_recommended_kb", 0, Number.MAX_SAFE_INTEGER]],
    booleans: ["cma_sufficient", "cma_recommended"],
  });
  if (driverDmaProblem) return driverDmaProblem;
  const deviceNodeProblem = validateRkNestedObject(root.driver_status || {}, "device_node", {
    strings: [["path", 500], ["permissions", 80]],
    booleans: ["exists"],
  });
  if (deviceNodeProblem) return deviceNodeProblem;
  const driverModuleProblem = validateRkNestedObject(root.driver_status || {}, "module", {
    strings: [["name", 120], ["version", 120]],
    booleans: ["loaded"],
  });
  if (driverModuleProblem) return driverModuleProblem;
  const driverCpuProblem = validateRkNestedObject(root.driver_status || {}, "cpu", {
    strings: [["usage_text", 500]],
    numbers: [["usage_percent", 0, 100]],
    arrays: ["policies"],
  });
  if (driverCpuProblem) return driverCpuProblem;
  for (const field of ["gpu", "npu"]) {
    const acceleratorProblem = validateRkNestedObject(root.driver_status || {}, field, { arrays: ["devices"] });
    if (acceleratorProblem) return acceleratorProblem;
  }
  const interruptProblem = validateRkNestedObject(root.driver_status || {}, "interrupt", {
    strings: [["raw", 1000], ["type", 120], ["controller", 120], ["hwirq", 120], ["trigger", 120], ["name", 160]],
    numbers: ["sum", "delta", "rate_per_sec"],
    integers: [["irq", 0, Number.MAX_SAFE_INTEGER]],
    booleans: ["found"],
    arrays: ["per_cpu"],
  });
  if (interruptProblem) return interruptProblem;
  const driverPcieProblem = validateRkNestedObject(root.driver_status || {}, "pcie", {
    integers: [["bound_count", 0, Number.MAX_SAFE_INTEGER]],
    objects: ["capture_metrics"],
    arrays: ["devices"],
  });
  if (driverPcieProblem) return driverPcieProblem;
  const driverStatusMetricsProblem = validateRkNestedObject(root.driver_status || {}, "capture_metrics", driverCaptureMetricsSpec);
  if (driverStatusMetricsProblem) return driverStatusMetricsProblem;
  const driverPcieMetricsProblem = validateRkNestedObject(root.driver_status?.pcie || {}, "capture_metrics", driverCaptureMetricsSpec);
  if (driverPcieMetricsProblem) return driverPcieMetricsProblem;
  const driverDeepProblem = validateRkDriverStatusDeep(root);
  if (driverDeepProblem) return driverDeepProblem;
  const captureHexProblem = validateRkCaptureMetricHex(root);
  if (captureHexProblem) return captureHexProblem;
  const topologyProblem = validateRkPcieTopology(root);
  if (topologyProblem) return topologyProblem;
  const consistencyProblem = validateRkStatusConsistency(root);
  if (consistencyProblem) return consistencyProblem;
  if (Object.prototype.hasOwnProperty.call(root, "time_bj") && root.time_bj !== null && parseRkBeijingTimestamp(root.time_bj) === null) {
    return rkPayloadProblem("time_bj", "time_bj must use a valid Beijing calendar time");
  }
  return null;
}

function validateRkPlatePayload(root) {
  if (!rkPayloadUsesV1(root)) return null;
  const stringFields = [
    ["time_bj", 32], ["source", 64], ["plate", 80], ["plate_normalized", 80], ["color", 40],
    ["vehicle_type", 80], ["vehicle_type_code", 80], ["plate_category", 80], ["plate_category_code", 80],
    ["plate_category_rule", 240], ["plate_category_rule_version", 120], ["input_mode", 24],
    ["event_schema", 120], ["detector_model_name", 160], ["detector_profile", 120], ["detector_family", 120],
    ["detector_output_contract", 600], ["detector_runtime_backend", 120], ["recognizer_model_name", 160],
    ["recognizer_profile", 120], ["recognizer_output_contract", 600], ["recognizer_input_format", 120],
    ["recognizer_text_layout", 160], ["recognizer_runtime_backend", 120], ["model_input_format", 80],
    ["inference_strategy", 120], ["source_frame_format", 80], ["source_layout", 40], ["sd_source_path", 1024],
    ["target_device_id", 80], ["target_mac", 80], ["thumb_jpeg_base64", 6_000_000], ["image_jpeg_base64", 12_000_000],
  ];
  for (const [field, max] of stringFields) {
    const problem = validateRkPayloadString(root, field, { max });
    if (problem) return problem;
  }
  const targetDeviceProblem = validateRkDeviceIdField(root, "target_device_id");
  if (targetDeviceProblem) return targetDeviceProblem;
  if (root.event_schema !== undefined && root.event_schema !== "rk3568_plate_event_v2") {
    return rkPayloadProblem("event_schema", "event_schema must be rk3568_plate_event_v2");
  }
  if (root.input_mode !== undefined && !["pcie", "sdcard"].includes(root.input_mode)) {
    return rkPayloadProblem("input_mode", "input_mode must be pcie or sdcard");
  }
  const plateStrategyProblem = validateRkPayloadEnum(root, "inference_strategy", Array.from(RK_INFERENCE_STRATEGIES));
  if (plateStrategyProblem) return plateStrategyProblem;
  const plateLayoutProblem = validateRkSourceLayoutValue(root.source_layout, "source_layout");
  if (plateLayoutProblem) return plateLayoutProblem;
  for (const field of ["source_frame_format", "model_input_format", "recognizer_input_format"]) {
    const formatProblem = validateRkFrameFormatValue(root[field], field);
    if (formatProblem) return formatProblem;
  }
  if (Object.prototype.hasOwnProperty.call(root, "time_bj") && parseRkBeijingTimestamp(root.time_bj) === null) {
    return rkPayloadProblem("time_bj", "time_bj must use a valid Beijing calendar time");
  }
  for (const field of ["inference_pipeline_active", "inference_capture_async", "inference_latest_only", "pcie_sliding_enabled"]) {
    const problem = validateRkPayloadBoolean(root, field);
    if (problem) return problem;
  }
  for (const field of ["det_conf", "rec_conf", "conf"]) {
    const problem = validateRkPayloadNumber(root, field, { min: 0, max: 1 });
    if (problem) return problem;
  }
  for (const field of ["inference_task_count", "inference_queue_depth", "inference_dropped_tasks", "source_index", "source_mask", "source_frame_width", "source_frame_height", "model_input_width", "model_input_height", "recognizer_input_width", "recognizer_input_height", "detector_profile_id", "recognizer_profile_id"]) {
    const problem = validateRkPayloadNumber(root, field, { integer: true, min: 0 });
    if (problem) return problem;
  }
  for (const [field, min, max] of [["source_index", 1, 4], ["source_mask", 0, 15], ["detector_profile_id", 0, 4], ["recognizer_profile_id", 0, 2]]) {
    if (!Object.prototype.hasOwnProperty.call(root, field)) continue;
    if (root[field] < min || root[field] > max) return rkPayloadProblem(field, `${field} must be between ${min} and ${max}`);
  }
  for (const field of ["inference_result_age_ms", "display_fps", "inference_pre_ms", "inference_npu_ms", "inference_post_ms"]) {
    const problem = validateRkPayloadNumber(root, field, { min: 0 });
    if (problem) return problem;
  }
  return null;
}

function validateRkUserMessagePayload(root) {
  if (!rkPayloadUsesV1(root)) return null;
  for (const [field, max] of [
    ["role", 40], ["user_state", 40], ["biz_system", 40], ["event_type", 120], ["template_key", 160],
    ["display_text", 600], ["broadcast_text", 600], ["time_bj", 32], ["source", 64], ["plate", 80],
    ["plate_normalized", 80], ["color", 40], ["vehicle_type", 80], ["vehicle_type_code", 80], ["plate_category", 80],
    ["plate_category_code", 80], ["plate_category_rule", 240], ["plate_category_rule_version", 120], ["pay_status", 40],
    ["duration_text", 120], ["target_device_id", 80],
  ]) {
    const problem = validateRkPayloadString(root, field, { max });
    if (problem) return problem;
  }
  const targetDeviceProblem = validateRkDeviceIdField(root, "target_device_id");
  if (targetDeviceProblem) return targetDeviceProblem;
  if (root.role !== undefined && root.role !== "user") return rkPayloadProblem("role", "role must be user for user-message reports");
  if (root.user_state !== undefined && root.user_state !== "normal") return rkPayloadProblem("user_state", "user_state must be normal for user-message reports");
  if (root.biz_system !== undefined && !["parking", "etc"].includes(String(root.biz_system).trim().toLowerCase())) {
    return rkPayloadProblem("biz_system", "biz_system must be parking or etc");
  }
  const eventType = root.event_type === undefined ? "" : root.event_type;
  if (eventType && !["parking_entry", "parking_exit", "etc_pass", "user_message"].includes(eventType)) {
    return rkPayloadProblem("event_type", "event_type must be parking_entry, parking_exit, etc_pass, or user_message");
  }
  const bizSystem = typeof root.biz_system === "string" ? root.biz_system.trim().toLowerCase() : "";
  if (eventType.startsWith("parking_") && bizSystem && bizSystem !== "parking") {
    return rkPayloadProblem("biz_system", "parking events require biz_system=parking");
  }
  if (eventType === "etc_pass" && bizSystem && bizSystem !== "etc") {
    return rkPayloadProblem("biz_system", "etc_pass requires biz_system=etc");
  }
  if (Object.prototype.hasOwnProperty.call(root, "time_bj") && parseRkBeijingTimestamp(root.time_bj) === null) {
    return rkPayloadProblem("time_bj", "time_bj must use a valid Beijing calendar time");
  }
  for (const field of ["template_version", "config_version", "source_index", "duration_minutes"]) {
    const problem = validateRkPayloadNumber(root, field, { integer: true, min: 0 });
    if (problem) return problem;
  }
  if (Object.prototype.hasOwnProperty.call(root, "source_index") && (root.source_index < 1 || root.source_index > 4)) {
    return rkPayloadProblem("source_index", "source_index must be between 1 and 4");
  }
  for (const field of ["det_conf", "rec_conf", "conf"]) {
    const problem = validateRkPayloadNumber(root, field, { min: 0, max: 1 });
    if (problem) return problem;
  }
  for (const field of ["fee", "paid_from_balance", "need_pay", "balance_after", "arrears_after"]) {
    const problem = validateRkPayloadNumber(root, field);
    if (problem) return problem;
  }
  return null;
}

function validateRkViolationPayload(root) {
  if (!rkPayloadUsesV1(root)) return null;
  if (Object.prototype.hasOwnProperty.call(root, "time_bj") && parseRkBeijingTimestamp(root.time_bj) === null) {
    return rkPayloadProblem("time_bj", "time_bj must use a valid Beijing calendar time");
  }
  for (const field of ["view_mode", "single_source"]) {
    const problem = validateRkPayloadNumber(root, field, { integer: true, min: 0 });
    if (problem) return problem;
  }
  for (const field of ["q0", "q1", "q2", "q3", "overlap_iou"]) {
    const problem = validateRkPayloadNumber(root, field, { min: 0 });
    if (problem) return problem;
  }
  for (const field of ["image_jpeg_base64", "thumb_jpeg_base64"]) {
    const problem = validateRkPayloadString(root, field, { nonEmpty: true, max: 12_000_000 });
    if (problem) return problem;
  }
  return null;
}

function normalizeRkReportIdentifier(value, maxLen) {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value).trim();
  if (!text || text.length > maxLen || /[\x00-\x1f\x7f]/.test(text)) return null;
  return text;
}

function rkRequestHeader(req, name) {
  const value = req?.headers?.[String(name || "").toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function normalizeRkReportType(value) {
  const text = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  return RK_REPORT_TYPES.has(text) ? text : "";
}

function normalizeRkReportIdentity(req, body, expectedType = "") {
  const root = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const normalizedExpectedType = normalizeRkReportType(expectedType);
  const reportedTypeText = String(root.report_type || "").trim();
  const reportedType = normalizeRkReportType(reportedTypeText);
  if (reportedTypeText && !reportedType) {
    return { error: "bad_report_type", message: "report_type must name a supported RK report endpoint" };
  }
  if (normalizedExpectedType && reportedType && reportedType !== normalizedExpectedType) {
    return { error: "report_type_mismatch", message: `report_type must be ${normalizedExpectedType} for this endpoint` };
  }
  const eventCandidates = [
    root.event_id,
    root.report_id,
    rkRequestHeader(req, "idempotency-key"),
    rkRequestHeader(req, "x-rk-event-id"),
  ]
    .filter((value) => value !== null && value !== undefined && String(value).trim() !== "")
    .map((value) => normalizeRkReportIdentifier(value, 160));
  if (eventCandidates.some((value) => value === null)) {
    return { error: "bad_event_id", message: "event_id must be a printable value no longer than 160 characters" };
  }
  const uniqueEventIds = Array.from(new Set(eventCandidates));
  if (uniqueEventIds.length > 1) {
    return { error: "idempotency_key_mismatch", message: "event_id, report_id and idempotency headers must match" };
  }

  const deviceCandidates = [root.rk_device_id, rkRequestHeader(req, "x-rk-device-id")]
    .filter((value) => value !== null && value !== undefined && String(value).trim() !== "")
    .map((value) => normalizeRkReportIdentifier(value, 128));
  if (deviceCandidates.some((value) => value === null)) {
    return { error: "bad_rk_device_id", message: "rk_device_id must be a printable value no longer than 128 characters" };
  }
  const uniqueDeviceIds = Array.from(new Set(deviceCandidates));
  if (uniqueDeviceIds.length > 1) {
    return { error: "rk_device_id_mismatch", message: "rk_device_id body and header values must match" };
  }

  const attemptHeader = rkRequestHeader(req, "x-rk-report-attempt");
  let reportAttempt = 1;
  if (attemptHeader !== undefined && attemptHeader !== null && String(attemptHeader).trim() !== "") {
    const attemptText = String(attemptHeader).trim();
    if (!/^\d+$/.test(attemptText)) {
      return { error: "bad_report_attempt", message: "X-RK-Report-Attempt must be an integer starting at 1" };
    }
    reportAttempt = Number(attemptText);
    if (!Number.isSafeInteger(reportAttempt) || reportAttempt < 1 || reportAttempt > 1_000_000_000) {
      return { error: "bad_report_attempt", message: "X-RK-Report-Attempt must be between 1 and 1000000000" };
    }
  }

  const schemaProvided = Object.prototype.hasOwnProperty.call(root, "report_schema");
  const declaredSchema = typeof root.report_schema === "string" ? root.report_schema.trim() : "";
  if (schemaProvided && (typeof root.report_schema !== "string" || root.report_schema !== RK_REPORT_SCHEMA_DEFAULT)) {
    return { error: "bad_report_schema", message: `report_schema must be ${RK_REPORT_SCHEMA_DEFAULT}` };
  }
  if (!RK_ALLOW_LEGACY_REPORTS && !declaredSchema) {
    return { error: "missing_report_schema", message: `report_schema=${RK_REPORT_SCHEMA_DEFAULT} is required` };
  }

  const enforceV1Identity = declaredSchema === RK_REPORT_SCHEMA_DEFAULT || !RK_ALLOW_LEGACY_REPORTS;
  if (enforceV1Identity) {
    if (!uniqueEventIds.length) {
      return { error: "missing_event_id", message: "event_id is required by rk3568.cloud_report.v1" };
    }
    if (!uniqueDeviceIds.length) {
      return { error: "missing_rk_device_id", message: "rk_device_id is required by rk3568.cloud_report.v1" };
    }
    if (root.device !== undefined && root.device !== "rk3568") {
      return { error: "bad_device", message: "device must be rk3568 for rk3568.cloud_report.v1" };
    }
    if (root.delivery_semantics !== undefined && root.delivery_semantics !== RK_DELIVERY_SEMANTICS_DEFAULT) {
      return { error: "bad_delivery_semantics", message: "delivery_semantics must be at_least_once" };
    }
  }

  if (declaredSchema === RK_REPORT_SCHEMA_DEFAULT || !RK_ALLOW_LEGACY_REPORTS) {
    if (root.event_id === undefined || root.event_id === null || root.event_id === "") {
      return { error: "missing_event_id", message: "event_id must be a non-empty string" };
    }
    if (typeof root.event_id !== "string" || root.event_id !== root.event_id.trim()) {
      return { error: "bad_event_id", message: "event_id must be a trimmed printable string" };
    }
    if (root.report_id === undefined || root.report_id === null || root.report_id === "") {
      return { error: "missing_report_id", message: "report_id must be a non-empty string equal to event_id" };
    }
    if (typeof root.report_id !== "string" || root.report_id !== root.report_id.trim()) {
      return { error: "bad_report_id", message: "report_id must be a trimmed printable string equal to event_id" };
    }
    if (root.rk_device_id === undefined || root.rk_device_id === null || root.rk_device_id === "") {
      return { error: "missing_rk_device_id", message: "rk_device_id must be a non-empty string" };
    }
    if (typeof root.rk_device_id !== "string" || root.rk_device_id !== root.rk_device_id.trim()) {
      return { error: "bad_rk_device_id", message: "rk_device_id must be a trimmed printable string" };
    }
    if (rkRequestHeader(req, "idempotency-key") === undefined || String(rkRequestHeader(req, "idempotency-key")).trim() === "") {
      return { error: "missing_idempotency_key", message: "Idempotency-Key must equal event_id" };
    }
    if (rkRequestHeader(req, "x-rk-event-id") === undefined || String(rkRequestHeader(req, "x-rk-event-id")).trim() === "") {
      return { error: "missing_event_header", message: "X-RK-Event-ID must equal event_id" };
    }
    if (attemptHeader === undefined || attemptHeader === null || String(attemptHeader).trim() === "") {
      return { error: "missing_report_attempt", message: "X-RK-Report-Attempt is required" };
    }
    if (root.device !== "rk3568") {
      return { error: root.device === undefined ? "missing_device" : "bad_device", message: "device must be rk3568" };
    }
    if (typeof root.report_type !== "string" || root.report_type !== normalizedExpectedType) {
      return { error: root.report_type === undefined ? "missing_report_type" : "report_type_mismatch", message: `report_type must be ${normalizedExpectedType}` };
    }
    if (root.delivery_semantics !== RK_DELIVERY_SEMANTICS_DEFAULT) {
      return {
        error: root.delivery_semantics === undefined ? "missing_delivery_semantics" : "bad_delivery_semantics",
        message: "delivery_semantics must be at_least_once",
      };
    }
    const timestampProblem = validateRkReportTimestamps(root);
    if (timestampProblem) return timestampProblem;
  }

  return {
    event_id: uniqueEventIds[0] || "",
    rk_device_id: uniqueDeviceIds[0] || "rk3568",
    report_type: normalizedExpectedType || reportedType,
    report_attempt: reportAttempt,
  };
}

function normalizeRkReportEnvelope(req, body, identity, expectedType = "") {
  const root = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const reportType = normalizeRkReportType(expectedType || identity?.report_type);
  const createdAtMsRaw = root.report_created_at_ms;
  const createdAtMs = typeof createdAtMsRaw === "number" && Number.isFinite(createdAtMsRaw) && createdAtMsRaw >= 0
    ? Math.floor(createdAtMsRaw)
    : Date.now();
  const device = typeof root.device === "string" ? cleanUserTemplate(root.device, 64) : "";
  const reportSchema = typeof root.report_schema === "string" ? cleanUserTemplate(root.report_schema, 120) : "";
  const deliverySemantics = typeof root.delivery_semantics === "string" ? cleanUserTemplate(root.delivery_semantics, 40) : "";
  const reportCreatedAt = typeof root.report_created_at === "string" ? cleanUserTemplate(root.report_created_at, 32) : "";
  const fallbackCreatedAt = typeof root.time_bj === "string" ? cleanUserTemplate(root.time_bj, 32) : "";
  const eventId = String(identity?.event_id || "");
  return {
    device: device || "rk3568",
    rk_device_id: String(identity?.rk_device_id || "rk3568"),
    ...(eventId ? { event_id: eventId, report_id: eventId } : {}),
    report_schema: reportSchema || RK_REPORT_SCHEMA_LEGACY,
    ...(reportType ? { report_type: reportType } : {}),
    delivery_semantics: !reportSchema && !eventId ? "best_effort" : deliverySemantics || RK_DELIVERY_SEMANTICS_DEFAULT,
    report_created_at: reportCreatedAt || fallbackCreatedAt || nowBjText(),
    report_created_at_ms: createdAtMs,
    report_attempt: Number(identity?.report_attempt) || 1,
  };
}

function rkReportReceiptKey(rkDeviceId, eventId) {
  return JSON.stringify([String(rkDeviceId || "rk3568"), String(eventId || "")]);
}

function normalizeStoredRkReportReceipt(value) {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!row) return null;
  const reportType = normalizeRkReportType(row.report_type) || "plate";
  const eventId = normalizeRkReportIdentifier(row.event_id || row.report_id, 160);
  if (!eventId) return null;
  const rkDeviceId = normalizeRkReportIdentifier(row.rk_device_id, 128) || "rk3568";
  return {
    report_type: reportType,
    rk_device_id: rkDeviceId,
    event_id: eventId,
    item_id: normalizeRkReportIdentifier(row.item_id || row.id, 160) || "",
    state: ["accepted", "record_persisted", "completed", "recovery_reset"].includes(String(row.state || "completed"))
      ? String(row.state || "completed")
      : "completed",
    report_attempt: Number.isSafeInteger(Number(row.report_attempt)) && Number(row.report_attempt) >= 1
      ? Number(row.report_attempt)
      : 1,
    time_bj: cleanUserTemplate(row.time_bj, 32),
    updated_at_ms: Number.isFinite(Number(row.updated_at_ms)) && Number(row.updated_at_ms) >= 0
      ? Math.floor(Number(row.updated_at_ms))
      : null,
    blacklist_hit: row.blacklist_hit === true,
    target_device_id: cleanDeviceId(row.target_device_id, ""),
    target_mac: cleanUserTemplate(row.target_mac, 80),
    recovery_reason: cleanUserTemplate(row.recovery_reason, 160),
  };
}

function ensureRkReportReceiptIndex() {
  if (rkReportReceiptIndex) return rkReportReceiptIndex;
  const index = new Map();
  for (const row of readJsonlAll(rkReportReceiptPath, 120_000_000)) {
    const receipt = normalizeStoredRkReportReceipt(row);
    if (!receipt) continue;
    const key = rkReportReceiptKey(receipt.rk_device_id, receipt.event_id);
    // A reset marker deliberately releases the old reservation.  It is kept
    // in the journal so a restart cannot resurrect a missing record from an
    // earlier record_persisted row.
    if (receipt.state === "recovery_reset") {
      index.delete(key);
      continue;
    }
    index.set(key, receipt);
  }

  // Reconcile per-event status files before migrating the legacy latest
  // snapshot.  This also upgrades an accepted-only receipt when the status
  // itself made it to disk before the process stopped.
  const pendingStatusRecords = readRkStatusPendingRecords();
  for (const pending of pendingStatusRecords) {
    mergeRkStatusPendingIntoReceiptIndex(index, pending.record, pending.path);
  }

  // Migrate completed records written before the dedicated receipt journal existed.
  const latestStatusRecord = latestStoredRkStatusRecord();
  if (latestStatusRecord) mergeRkStatusIntoReceiptIndex(index, latestStatusRecord);
  const migratedRows = [
    ...latestPlatesFromAudit().map((item) => ({ ...item, report_type: "plate" })),
    ...readJsonlAll(path.join(logRoot, "plates.jsonl")).map((item) => ({ ...item, report_type: "plate" })),
    ...latestViolationsFromAudit().map((item) => ({ ...item, report_type: "violation" })),
    ...readJsonlAll(path.join(logRoot, "user_messages.jsonl")).map((item) => ({ ...item, report_type: "user-message" })),
    ...readJsonlAll(path.join(logRoot, "business_events.jsonl")).map((item) => ({ ...item, report_type: "business" })),
  ];
  for (const item of migratedRows) {
    const receipt = normalizeStoredRkReportReceipt({ ...item, state: "record_persisted", item_id: item?.id });
    if (!receipt) continue;
    const key = rkReportReceiptKey(receipt.rk_device_id, receipt.event_id);
    const current = index.get(key);
    if (current && current.report_type !== receipt.report_type) continue;
    if (current?.state === "completed") continue;
    index.set(key, { ...(current || {}), ...receipt, state: "record_persisted" });
  }

  // accepted is only a process reservation.  If no pending/latest durable
  // record was found, release it so the next delivery can claim afresh.
  for (const [key, receipt] of index) {
    if (receipt.state === "accepted") index.delete(key);
    if (receipt.state === "completed" && receipt.report_type === "status") removeRkStatusPendingRecord(receipt);
  }

  let newestPendingStatus = null;
  for (const pending of pendingStatusRecords) {
    const identity = rkStatusRecordIdentity(pending.record);
    const receipt = identity ? index.get(rkReportReceiptKey(identity.rk_device_id, identity.event_id)) : null;
    if (receipt?.state !== "record_persisted" || receipt.report_type !== "status") continue;
    if (!newestPendingStatus || compareRkStatusRecords(pending.record, newestPendingStatus) > 0) {
      newestPendingStatus = pending.record;
    }
  }
  if (newestPendingStatus) persistRkStatusLatestRecord(newestPendingStatus);
  rkReportReceiptIndex = index;
  return rkReportReceiptIndex;
}

function appendDurableJsonLine(filePath, value) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, "a");
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function writeDurableJsonFile(filePath, value) {
  const target = path.resolve(filePath);
  const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.renameSync(tmp, target);
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
      fs.unlinkSync(target);
      fs.renameSync(tmp, target);
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
  }
}

function normalizeStoredRkStatusRecord(value) {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const status = row?.status && typeof row.status === "object" && !Array.isArray(row.status) ? row.status : null;
  if (!status) return null;
  const savedAtMs = Number(row.saved_at_ms);
  return {
    status,
    saved_at_ms: Number.isFinite(savedAtMs) && savedAtMs >= 0 ? Math.floor(savedAtMs) : 0,
  };
}

function rkStatusRecordIdentity(record) {
  const normalized = normalizeStoredRkStatusRecord(record);
  if (!normalized) return null;
  const eventId = normalizeRkReportIdentifier(normalized.status.event_id || normalized.status.report_id, 160);
  const rkDeviceId = normalizeRkReportIdentifier(normalized.status.rk_device_id, 128) || "rk3568";
  if (!eventId) return null;
  return {
    report_type: "status",
    rk_device_id: rkDeviceId,
    event_id: eventId,
    report_attempt: normalized.status.report_attempt,
    time_bj: cleanUserTemplate(normalized.status.time_bj, 32),
    updated_at_ms: normalized.saved_at_ms,
  };
}

function rkStatusRecordCreatedAtMs(record) {
  const value = Number(record?.status?.report_created_at_ms);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function compareRkStatusRecords(leftValue, rightValue) {
  const left = normalizeStoredRkStatusRecord(leftValue);
  const right = normalizeStoredRkStatusRecord(rightValue);
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  // Prefer the board's event time so a delayed retry cannot roll back a
  // status that was created later. Server time remains the legacy fallback.
  const leftCreatedAt = rkStatusRecordCreatedAtMs(left) || left.saved_at_ms;
  const rightCreatedAt = rkStatusRecordCreatedAtMs(right) || right.saved_at_ms;
  if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt > rightCreatedAt ? 1 : -1;
  const leftIdentity = rkStatusRecordIdentity(left);
  const rightIdentity = rkStatusRecordIdentity(right);
  const leftKey = JSON.stringify([leftIdentity?.rk_device_id || "", leftIdentity?.event_id || ""]);
  const rightKey = JSON.stringify([rightIdentity?.rk_device_id || "", rightIdentity?.event_id || ""]);
  if (leftKey !== rightKey) return leftKey > rightKey ? 1 : -1;
  if (left.saved_at_ms !== right.saved_at_ms) return left.saved_at_ms > right.saved_at_ms ? 1 : -1;
  return 0;
}

function rkStatusJournalValue(record) {
  const normalized = normalizeStoredRkStatusRecord(record);
  if (!normalized) return null;
  return {
    schema: "rk3568.cloud_status_journal.v2",
    saved_at_ms: normalized.saved_at_ms,
    status: normalized.status,
  };
}

function latestStoredRkStatusRecord() {
  try {
    const raw = JSON.parse(fs.readFileSync(rkStatusSnapshotPath, "utf8"));
    return normalizeStoredRkStatusRecord(raw);
  } catch {
    return null;
  }
}

function rkStatusPendingPath(identity) {
  const eventId = normalizeRkReportIdentifier(identity?.event_id || identity?.report_id, 160);
  const rkDeviceId = normalizeRkReportIdentifier(identity?.rk_device_id, 128) || "rk3568";
  if (!eventId) return "";
  const digest = createHash("sha256").update(`${rkDeviceId}\u0000${eventId}`).digest("hex");
  return path.join(rkStatusPendingRoot, `${digest}.json`);
}

function storedRkStatusMatches(record, identity) {
  if (!record || !identity?.event_id) return false;
  if (String(record.status.event_id || record.status.report_id || "") !== String(identity.event_id)) return false;
  return String(record.status.rk_device_id || "rk3568") === String(identity.rk_device_id || "rk3568");
}

function quarantineRkStatusPendingFile(filePath, reason = "invalid") {
  if (!filePath) return false;
  try {
    if (!fs.existsSync(filePath)) return true;
    fs.mkdirSync(rkStatusPendingQuarantineRoot, { recursive: true });
    const safeReason = String(reason || "invalid").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 40) || "invalid";
    const baseName = path.basename(filePath).replace(/\.json$/i, "");
    const quarantinePath = path.join(
      rkStatusPendingQuarantineRoot,
      `${baseName}-${Date.now()}-${randomUUID()}-${safeReason}.json`,
    );
    fs.renameSync(filePath, quarantinePath);
    return true;
  } catch {
    return false;
  }
}

function readRkStatusPendingRecord(identity) {
  const pendingPath = rkStatusPendingPath(identity);
  if (!pendingPath) return { record: null, path: "", state: "missing" };
  try {
    const pending = normalizeStoredRkStatusRecord(JSON.parse(fs.readFileSync(pendingPath, "utf8")));
    if (!pending) return { record: null, path: pendingPath, state: "invalid" };
    if (!storedRkStatusMatches(pending, identity)) return { record: null, path: pendingPath, state: "identity_mismatch" };
    return { record: pending, path: pendingPath, state: "ok" };
  } catch (error) {
    return { record: null, path: pendingPath, state: error?.code === "ENOENT" ? "missing" : "invalid" };
  }
}

function readRkStatusPendingRecords() {
  let entries = [];
  try {
    entries = fs.readdirSync(rkStatusPendingRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const records = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    const pendingPath = path.join(rkStatusPendingRoot, entry.name);
    let record = null;
    try {
      record = normalizeStoredRkStatusRecord(JSON.parse(fs.readFileSync(pendingPath, "utf8")));
    } catch {}
    const identity = rkStatusRecordIdentity(record);
    const expectedPath = identity ? rkStatusPendingPath(identity) : "";
    if (!record || !identity || path.resolve(expectedPath) !== path.resolve(pendingPath)) {
      quarantineRkStatusPendingFile(pendingPath, !record ? "invalid" : "identity-mismatch");
      continue;
    }
    records.push({ record, path: pendingPath });
  }
  records.sort((a, b) => compareRkStatusRecords(a.record, b.record));
  return records;
}

function mergeRkStatusIntoReceiptIndex(index, record, options = {}) {
  const identity = rkStatusRecordIdentity(record);
  if (!identity) {
    if (options.pendingPath) quarantineRkStatusPendingFile(options.pendingPath, "missing-identity");
    return false;
  }
  const receipt = normalizeStoredRkReportReceipt({
    ...identity,
    state: "record_persisted",
  });
  if (!receipt) return false;
  const key = rkReportReceiptKey(receipt.rk_device_id, receipt.event_id);
  const current = index.get(key);
  if (current && current.report_type !== "status") {
    if (options.pendingPath) quarantineRkStatusPendingFile(options.pendingPath, "receipt-conflict");
    return false;
  }
  if (current?.state === "completed") {
    if (options.pendingPath) removeRkStatusPendingRecord(identity);
    return true;
  }
  if (!current || current.state === "accepted" || current.state === "recovery_reset") {
    index.set(key, receipt);
    if (options.persistReceipt) appendDurableJsonLine(rkReportReceiptPath, receipt);
  } else if (current.state === "record_persisted" && current.updated_at_ms == null) {
    index.set(key, { ...current, updated_at_ms: receipt.updated_at_ms, time_bj: current.time_bj || receipt.time_bj });
  }
  return true;
}

function mergeRkStatusPendingIntoReceiptIndex(index, record, pendingPath) {
  return mergeRkStatusIntoReceiptIndex(index, record, { pendingPath, persistReceipt: true });
}

function findStoredRkStatusRecord(identity) {
  if (!identity?.event_id) return null;
  const pending = readRkStatusPendingRecord(identity);
  if (pending.record) return pending.record;
  if (pending.state === "invalid" || pending.state === "identity_mismatch") {
    quarantineRkStatusPendingFile(pending.path, pending.state);
  }
  const latest = latestStoredRkStatusRecord();
  return storedRkStatusMatches(latest, identity) ? latest : null;
}

function persistRkStatusLatestRecord(record, floorRecord = null) {
  const journalValue = rkStatusJournalValue(record);
  if (!journalValue) return { ok: false, applied: false, record: null };
  const current = latestStoredRkStatusRecord();
  const floor = normalizeStoredRkStatusRecord(floorRecord);
  const authoritative = current && floor
    ? compareRkStatusRecords(current, floor) >= 0 ? current : floor
    : current || floor;
  if (authoritative && compareRkStatusRecords(journalValue, authoritative) <= 0) {
    // A prior in-memory recovery may be newer than the file (for example
    // after a concurrent writer). Repair the file before acknowledging the
    // older event, otherwise the next restart would regress the snapshot.
    if (floor && (!current || compareRkStatusRecords(floor, current) > 0)) {
      if (!writeDurableJsonFile(rkStatusSnapshotPath, rkStatusJournalValue(floor))) {
        return { ok: false, applied: false, record: authoritative };
      }
      return { ok: true, applied: false, record: floor };
    }
    return { ok: true, applied: false, record: authoritative };
  }
  if (!writeDurableJsonFile(rkStatusSnapshotPath, journalValue)) {
    return { ok: false, applied: false, record: current };
  }
  return { ok: true, applied: true, record: journalValue };
}

function persistRkStatusRecord(status, savedAtMs = Date.now(), floorRecord = null) {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return { ok: false, latestApplied: false, record: null };
  }
  const record = {
    schema: "rk3568.cloud_status_journal.v2",
    saved_at_ms: Math.max(0, Math.floor(Number(savedAtMs) || Date.now())),
    status,
  };
  const pendingPath = rkStatusPendingPath(status);
  if (pendingPath) {
    try {
      fs.mkdirSync(rkStatusPendingRoot, { recursive: true });
    } catch {
      return { ok: false, latestApplied: false, record };
    }
    if (!writeDurableJsonFile(pendingPath, record)) return { ok: false, latestApplied: false, record };
  }
  const latest = persistRkStatusLatestRecord(record, floorRecord);
  return { ok: latest.ok, latestApplied: latest.applied, record, latest: latest.record };
}

function removeRkStatusPendingRecord(identity) {
  const pendingPath = rkStatusPendingPath(identity);
  if (!pendingPath) return true;
  try {
    if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
    return true;
  } catch {
    return false;
  }
}

function findRkReportReceipt(identity) {
  if (!identity?.event_id) return null;
  const index = ensureRkReportReceiptIndex();
  const key = rkReportReceiptKey(identity.rk_device_id, identity.event_id);
  const receipt = index.get(key) || null;
  if (receipt?.state === "accepted") {
    const updatedAt = Number(receipt.updated_at_ms);
    const leaseMs = clamp(parseInt(process.env.RK_REPORT_ACCEPTED_LEASE_MS || "300000", 10) || 300000, 10_000, 3_600_000);
    if (Number.isFinite(updatedAt) && updatedAt >= 0 && Date.now() - updatedAt > leaseMs) {
      // Some endpoint paths historically inspected the index directly rather
      // than going through claimRkReportReceipt.  Expire here as well so an
      // abandoned reservation cannot remain stuck at 425 forever.
      index.delete(key);
      return null;
    }
  }
  return receipt;
}

function persistRkReportReceipt(identity, patch = {}) {
  if (!identity?.event_id) return null;
  const receipt = normalizeStoredRkReportReceipt({
    report_type: identity.report_type,
    rk_device_id: identity.rk_device_id,
    event_id: identity.event_id,
    report_attempt: identity.report_attempt,
    time_bj: nowBjText(),
    updated_at_ms: Date.now(),
    ...patch,
  });
  if (!receipt || !appendDurableJsonLine(rkReportReceiptPath, receipt)) return null;
  const index = ensureRkReportReceiptIndex();
  const key = rkReportReceiptKey(receipt.rk_device_id, receipt.event_id);
  if (receipt.state === "recovery_reset") index.delete(key);
  else index.set(key, receipt);
  return receipt;
}

function resetRkReportReceiptForRetry(identity, reason = "status_recovery_missing") {
  if (!identity?.event_id) return false;
  const receipt = persistRkReportReceipt(identity, {
    state: "recovery_reset",
    recovery_reason: cleanUserTemplate(reason, 160),
  });
  if (!receipt) return false;
  ensureRkReportReceiptIndex().delete(rkReportReceiptKey(identity.rk_device_id, identity.event_id));
  return true;
}

function persistRkReportRecordStage(identity, patch = {}) {
  if (!identity?.event_id) return true;
  if (persistRkReportReceipt(identity, { ...patch, state: "record_persisted" })) return true;
  // The business journal is already durable.  Retain the recovery marker in
  // this process so an immediate retry can resume even if the receipt file is
  // temporarily unavailable; startup migration will rebuild it from the
  // business journal later.
  const fallback = normalizeStoredRkReportReceipt({
    report_type: identity.report_type,
    rk_device_id: identity.rk_device_id,
    event_id: identity.event_id,
    time_bj: nowBjText(),
    ...patch,
    state: "record_persisted",
  });
  if (fallback) ensureRkReportReceiptIndex().set(rkReportReceiptKey(identity.rk_device_id, identity.event_id), fallback);
  return false;
}

function releaseRkReportReservation(identity) {
  if (!identity?.event_id) return;
  const key = rkReportReceiptKey(identity.rk_device_id, identity.event_id);
  const current = ensureRkReportReceiptIndex().get(key);
  if (current?.state === "accepted") ensureRkReportReceiptIndex().delete(key);
}

function completeRkReportReceipt(identity, patch = {}) {
  if (!identity?.event_id) return true;
  const completedPatch = { ...patch, state: "completed" };
  if (persistRkReportReceipt(identity, completedPatch)) {
    if (identity.report_type === "status") removeRkStatusPendingRecord(identity);
    return true;
  }
  // Do not publish a process-local completed state when the journal write
  // fails. The durable record_persisted row remains replayable, so the next
  // delivery can safely retry side effects and then complete the receipt.
  return false;
}

function claimRkReportReceipt(identity, patch = {}) {
  if (!identity?.event_id) return { state: "new", receipt: null };
  let existing = findRkReportReceipt(identity);
  if (existing) {
    if (existing.report_type !== identity.report_type) return { state: "conflict", receipt: existing };
    if (existing.state === "accepted") {
      const ageMs = existing.updated_at_ms == null ? 0 : Date.now() - Number(existing.updated_at_ms);
      const leaseMs = clamp(parseInt(process.env.RK_REPORT_ACCEPTED_LEASE_MS || "300000", 10) || 300000, 10_000, 3_600_000);
      if (ageMs > leaseMs) {
        ensureRkReportReceiptIndex().delete(rkReportReceiptKey(identity.rk_device_id, identity.event_id));
        existing = null;
      }
    }
  }
  if (existing) {
    return {
      state: existing.state === "completed" ? "duplicate" : existing.state === "record_persisted" ? "resume" : "in_progress",
      receipt: existing,
    };
  }
  const receipt = persistRkReportReceipt(identity, { ...patch, state: "accepted" });
  return receipt ? { state: "new", receipt } : { state: "persist_failed", receipt: null };
}

function sendRkReportClaimResult(res, identity, claim, extra = {}) {
  if (claim?.state === "new") return false;
  if (claim?.state === "duplicate") {
    if (identity?.report_type === "status") removeRkStatusPendingRecord(identity);
    sendJson(res, 200, {
      ok: true,
      ...rkReportAckFields(identity, true),
      ...(claim.receipt?.item_id ? { id: claim.receipt.item_id } : {}),
      ...extra,
    });
    return true;
  }
  if (claim?.state === "in_progress") {
    sendJson(res, 425, { ok: false, error: "report_in_progress", message: "The first delivery is still being processed; retry later" });
    return true;
  }
  if (claim?.state === "resume") return false;
  if (claim?.state === "conflict") {
    sendJson(res, 409, { ok: false, error: "event_id_conflict", message: "event_id is already used by another report type" });
    return true;
  }
  sendJson(res, 503, { ok: false, error: "receipt_persist_failed", message: "Unable to durably reserve the RK event id" });
  return true;
}

function rkReportAckFields(identity, duplicate) {
  if (!identity?.event_id) return { duplicate: Boolean(duplicate), report_attempt: Number(identity?.report_attempt) || 1 };
  return {
    ack_id: identity.event_id,
    event_id: identity.event_id,
    report_id: identity.event_id,
    report_attempt: Number(identity.report_attempt) || 1,
    duplicate: Boolean(duplicate),
  };
}

const PLATE_CAPTURE_VEHICLE_TYPE_CODES = new Map([
  ["trailer", "trailer"], ["挂车", "trailer"],
  ["coach", "coach"], ["learner", "coach"], ["教练车", "coach"],
  ["hongkong", "hong_kong"], ["hk", "hong_kong"], ["香港车", "hong_kong"], ["香港车牌", "hong_kong"],
  ["macau", "macau"], ["mo", "macau"], ["澳门车", "macau"], ["澳门车牌", "macau"],
  ["armedpolice", "armed_police"], ["wj", "armed_police"], ["武警", "armed_police"], ["武警车牌", "armed_police"],
  ["military", "military"], ["militaryvehicle", "military"], ["军车", "military"],
  ["embassy", "embassy"], ["使馆车", "embassy"],
  ["consulate", "consulate"], ["consular", "consulate"], ["领馆车", "consulate"],
  ["police", "police"], ["警车", "police"],
  ["mediumlarge", "medium_large"], ["yellowplate", "medium_large"], ["黄牌车", "medium_large"], ["中大型车牌", "medium_large"], ["中大型车辆", "medium_large"],
  ["newenergy", "new_energy"], ["新能源车", "new_energy"], ["新能源车辆", "new_energy"], ["新能源", "new_energy"],
  ["fuel", "fuel"], ["fuelvehicle", "fuel"], ["燃油车", "fuel"], ["燃油", "fuel"],
  ["small", "small_car"], ["smallcar", "small_car"], ["小型车辆", "small_car"], ["小型汽车", "small_car"],
]);

function plateCaptureVehicleTypeCode(value) {
  const key = String(value || "").trim().toLowerCase().replace(/[\s\-_/]/g, "");
  return PLATE_CAPTURE_VEHICLE_TYPE_CODES.get(key) || "";
}

function inferredPlateCaptureVehicleTypeCode(item) {
  const source = item && typeof item === "object" ? item : {};
  const reported = [source.vehicle_type, source.vehicle_type_code, source.plate_category, source.plate_category_code];
  for (const value of reported) {
    const code = plateCaptureVehicleTypeCode(value);
    if (code) return code;
  }

  const plate = String(source.plate || "").trim().toUpperCase().replace(/[\s\-·•]/g, "");
  const color = String(source.color || "").trim().toLowerCase().replace(/[\s\-_/]/g, "");
  if (plate.includes("挂")) return "trailer";
  if (plate.includes("学")) return "coach";
  if (plate.includes("港")) return "hong_kong";
  if (plate.includes("澳")) return "macau";
  if (plate.startsWith("WJ")) return "armed_police";
  if (["ZG", "VA", "GS", "CS"].some((prefix) => plate.startsWith(prefix)) || plate.includes("军")) return "military";
  if (plate.includes("使")) return "embassy";
  if (plate.includes("领")) return "consulate";
  if (plate.includes("警")) return "police";
  if (color.includes("黄") || color.includes("yellow")) return "medium_large";
  if (color.includes("绿") || color.includes("green")) return "new_energy";
  if (color.includes("蓝") || color.includes("blue")) return "fuel";
  return "";
}

function normalizePlateCaptureDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const date = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) return "";
  return text;
}

function normalizePlateCaptureClock(value, fallback = "") {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return fallback;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizePlateCaptureInputSource(value) {
  const text = String(value || "").trim().toLowerCase().replace(/[\s_-]/g, "");
  if (text === "pcie") return "pcie";
  if (text === "sd" || text === "sdcard") return "sdcard";
  const channel = text.match(/^(?:src|scr)([1-4])$/);
  return channel ? `src${channel[1]}` : "";
}

function normalizePlateCaptureInputMode(value) {
  const normalized = normalizePlateCaptureInputSource(value);
  return normalized === "pcie" || normalized === "sdcard" ? normalized : "";
}

function normalizePlateCaptureChannel(value) {
  const normalized = normalizePlateCaptureInputSource(value);
  return /^src[1-4]$/.test(normalized) ? normalized : "";
}

function plateCaptureFiltersFromParams(searchParams) {
  const legacyDate = normalizePlateCaptureDate(searchParams?.get("date"));
  const startDate = normalizePlateCaptureDate(searchParams?.get("start_date")) || legacyDate;
  const endDate = normalizePlateCaptureDate(searchParams?.get("end_date")) || legacyDate;
  const startTime = startDate ? normalizePlateCaptureClock(searchParams?.get("start_time"), "00:00") : "";
  const endTime = endDate ? normalizePlateCaptureClock(searchParams?.get("end_time"), "23:59") : "";
  const legacyInputSource = normalizePlateCaptureInputSource(searchParams?.get("input_source"));
  const startKey = startDate ? `${startDate} ${startTime}` : "";
  const endKey = endDate ? `${endDate} ${endTime}` : "";
  return {
    start_date: startDate,
    start_time: startTime,
    end_date: endDate,
    end_time: endTime,
    vehicle_type: plateCaptureVehicleTypeCode(searchParams?.get("vehicle_type")),
    input_mode: normalizePlateCaptureInputMode(searchParams?.get("input_mode")) || normalizePlateCaptureInputMode(legacyInputSource),
    source: normalizePlateCaptureChannel(searchParams?.get("source")) || normalizePlateCaptureChannel(legacyInputSource),
    invalid_time_range: Boolean(startKey && endKey && startKey > endKey),
  };
}

function hasPlateCaptureFilters(filters) {
  return Boolean(filters?.start_date || filters?.end_date || filters?.vehicle_type || filters?.input_mode || filters?.source);
}

function plateCaptureMatchesFilters(item, filters) {
  if (!item || typeof item !== "object") return false;
  if (filters?.start_date || filters?.end_date) {
    const match = String(item.time_bj || item.time || "").trim().match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (!match) return false;
    const date = match ? `${match[1]}-${match[2]}-${match[3]}` : "";
    const clock = match?.[4] !== undefined ? `${String(match[4]).padStart(2, "0")}:${match[5]}` : "00:00";
    const key = `${date} ${clock}`;
    if (filters.start_date && key < `${filters.start_date} ${filters.start_time || "00:00"}`) return false;
    if (filters.end_date && key > `${filters.end_date} ${filters.end_time || "23:59"}`) return false;
  }
  if (filters?.vehicle_type && inferredPlateCaptureVehicleTypeCode(item) !== filters.vehicle_type) return false;
  if (filters?.input_mode) {
    const mode = normalizePlateCaptureInputMode(item.input_mode) || normalizePlateCaptureInputMode(item.source);
    if (mode !== filters.input_mode) return false;
  }
  if (filters?.source && normalizePlateCaptureChannel(item.source) !== filters.source) return false;
  return true;
}

function filterPlateCaptureItems(items, filters) {
  const list = Array.isArray(items) ? items : [];
  if (!hasPlateCaptureFilters(filters)) return list;
  return list.filter((item) => plateCaptureMatchesFilters(item, filters));
}

function mergePlateCaptureItems(sources, maxItems = 20000) {
  const out = new Map();
  let anonymousIndex = 0;
  for (const source of sources || []) {
    for (const item of Array.isArray(source) ? source : []) {
      if (!item || typeof item !== "object") continue;
      const id = String(item.id || "").trim();
      const key = id || `anonymous:${String(item.time_bj || item.time || "")}:${String(item.plate || "")}:${anonymousIndex++}`;
      if (!out.has(key)) out.set(key, item);
    }
  }
  return Array.from(out.values())
    .sort((a, b) => String(b?.time_bj || b?.time || "").localeCompare(String(a?.time_bj || a?.time || "")))
    .slice(0, Math.max(1, Number(maxItems) || 20000));
}

async function collectPlateCaptureHistory(maxItems = 20000) {
  const limit = clamp(Number(maxItems) || 20000, 1, 20000);
  const db = await mysqlListPlates(limit, 0);
  const dbItems = db?.items || [];
  const auditItems = latestPlatesFromAudit();
  return mergePlateCaptureItems([rkReported.plates, dbItems, auditItems], limit);
}

async function collectViolationCaptureHistory(maxItems = 20000) {
  const limit = clamp(Number(maxItems) || 20000, 1, 20000);
  const db = await mysqlListViolations(Math.min(limit, 5000), 0);
  const dbItems = db?.items || [];
  const auditItems = latestViolationsFromAudit();
  return {
    items: mergePlateCaptureItems([rkReported.violations, dbItems, auditItems], limit),
    db_items: dbItems,
    audit_items: auditItems,
  };
}

function captureHistorySource({ dbItems = [], memoryItems = [], memoryFromLog = false, auditItems = [] } = {}) {
  const hasDb = Array.isArray(dbItems) && dbItems.length > 0;
  const hasMemory = Array.isArray(memoryItems) && memoryItems.length > 0;
  const hasAudit = Array.isArray(auditItems) && auditItems.length > 0;
  if (hasDb && (hasMemory || hasAudit)) return "merged";
  if (hasDb) return "mysql";
  if (hasMemory) return memoryFromLog ? "log" : "memory";
  return hasAudit ? "log" : "empty";
}

function tarOctal(n, width) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  const s = v.toString(8);
  const out = s.length + 1 > width ? s.slice(-Math.max(0, width - 1)) : s;
  return out.padStart(width - 1, "0") + "\0";
}

function tarHeader(name, size, mtimeSec) {
  const buf = Buffer.alloc(512, 0);
  const write = (off, len, text) => {
    const b = Buffer.from(String(text || ""), "utf8");
    b.copy(buf, off, 0, Math.min(len, b.length));
  };
  const safe = String(name || "").replace(/^\/*/, "").slice(0, 100);
  write(0, 100, safe);
  write(100, 8, tarOctal(0o644, 8));
  write(108, 8, tarOctal(0, 8));
  write(116, 8, tarOctal(0, 8));
  write(124, 12, tarOctal(size, 12));
  write(136, 12, tarOctal(mtimeSec, 12));
  for (let i = 148; i < 156; i += 1) buf[i] = 0x20;
  write(156, 1, "0");
  write(257, 6, "ustar");
  write(263, 2, "00");
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += buf[i];
  const sumText = tarOctal(sum, 8);
  write(148, 8, sumText);
  return buf;
}

function sendTarGz(res, baseName, files) {
  const name = sanitizeFileName(baseName || "export");
  res.writeHead(200, {
    "Content-Type": "application/gzip",
    "Content-Disposition": `attachment; filename="${name}.tar.gz"`,
    "Cache-Control": "no-store",
  });
  const gzip = zlib.createGzip({ level: 6 });
  gzip.pipe(res);
  const nowSec = Math.floor(Date.now() / 1000);
  for (const f of Array.isArray(files) ? files : []) {
    const fn = String(f?.name || "").trim();
    if (!fn) continue;
    const data = Buffer.isBuffer(f?.data) ? f.data : Buffer.from(String(f?.data ?? ""), "utf8");
    gzip.write(tarHeader(fn, data.length, nowSec));
    gzip.write(data);
    const pad = data.length % 512 === 0 ? 0 : 512 - (data.length % 512);
    if (pad) gzip.write(Buffer.alloc(pad, 0));
  }
  gzip.end(Buffer.alloc(1024, 0));
}

function writeJsonFile(name, obj) {
  try {
    fs.writeFileSync(path.join(logRoot, name), JSON.stringify(obj, null, 2), "utf8");
  } catch {}
}

function appendJsonLine(name, obj) {
  try {
    fs.appendFileSync(path.join(logRoot, name), JSON.stringify(obj) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

const deviceHealthPath = path.join(logRoot, "device_health.jsonl");
const DEVICE_HEALTH_MAX_SAMPLES = clamp(parseInt(process.env.DEVICE_HEALTH_MAX_SAMPLES || "12000", 10) || 12000, 600, 50000);
let deviceHealthLastSampleAt = 0;
let deviceHealthTrimCounter = 0;

function appendBoundedJsonLine(filePath, obj, maxSamples = DEVICE_HEALTH_MAX_SAMPLES) {
  try {
    fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
    deviceHealthTrimCounter += 1;
    const st = fs.statSync(filePath);
    if (deviceHealthTrimCounter < 120 && st.size < 16 * 1024 * 1024) return;
    deviceHealthTrimCounter = 0;
    const rows = tailJsonl(filePath, maxSamples, 24 * 1024 * 1024);
    fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  } catch {}
}

function removeJsonlRecordsById(name, id) {
  const target = String(id || "");
  if (!target) return 0;
  const file = path.join(logRoot, name);
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return 0;
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    let removed = 0;
    const kept = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const row = safeJsonParse(line);
      if (row && String(row.id || "") === target) {
        removed += 1;
        continue;
      }
      kept.push(line);
    }
    if (!removed) return 0;
    const tmp = `${file}.delete-${process.pid}-${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
    fs.renameSync(tmp, file);
    return removed;
  } catch {
    return 0;
  }
}

function unlinkCaptureFile(filePath, allowedRoot) {
  const abs = fromLogRelPath(filePath);
  const root = path.resolve(allowedRoot);
  if (!abs) return false;
  const rel = path.relative(root, path.resolve(abs));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
    fs.unlinkSync(abs);
    return true;
  } catch {
    return false;
  }
}

function removeCaptureFiles(item, kind) {
  const root = kind === "violation" ? violationImageDir : plateImageDir;
  const paths = new Set([String(item?.image_path || ""), String(item?.thumb_path || "")].filter(Boolean));
  let removed = 0;
  for (const filePath of paths) {
    if (unlinkCaptureFile(filePath, root)) removed += 1;
  }
  return removed;
}

function clearCaptureImageFiles(kind) {
  const root = path.resolve(kind === "violation" ? violationImageDir : plateImageDir);
  let removed = 0;
  let failed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed, failed: 1 };
  }
  for (const entry of entries) {
    if (!entry?.isFile() || !/\.jpe?g$/i.test(entry.name)) continue;
    const abs = path.resolve(root, entry.name);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      failed += 1;
      continue;
    }
    try {
      fs.unlinkSync(abs);
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}

function miniNormalizePlate(v) {
  return String(v || "")
    .trim()
    .replace(/[\s\-_\.·•]+/g, "")
    .toUpperCase()
    .slice(0, 32);
}

function miniPublicImageUrl(req, relUrl) {
  const s = String(relUrl || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  const host = String(req?.headers?.host || "").trim();
  if (!host) return s;
  const proto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  return `${proto}://${host}${s.startsWith("/") ? s : `/${s}`}`;
}

function miniLoadBlacklist() {
  try {
    const raw = fs.existsSync(miniBlacklistPath) ? fs.readFileSync(miniBlacklistPath, "utf8") : "";
    const json = raw ? safeJsonParse(raw) : null;
    const items = Array.isArray(json?.items) ? json.items : Array.isArray(json) ? json : [];
    return items
      .map((it) => ({
        id: String(it?.id || randomUUID()),
        plate: miniNormalizePlate(it?.plate),
        reason: String(it?.reason || it?.violation_type || "违规车辆").trim().slice(0, 120),
        violation_type: String(it?.violation_type || it?.type || "parking_violation").trim().slice(0, 80),
        note: String(it?.note || "").trim().slice(0, 240),
        source: String(it?.source || "mini").trim().slice(0, 40),
        image_url: String(it?.image_url || "").trim(),
        image_path: String(it?.image_path || "").trim(),
        operator: String(it?.operator || "评委端").trim().slice(0, 40),
        created_at: String(it?.created_at || nowBjText()),
        updated_at: String(it?.updated_at || it?.created_at || nowBjText()),
        hits: Number.isFinite(Number(it?.hits)) ? Math.max(0, Math.round(Number(it.hits))) : 0,
        last_hit_at: String(it?.last_hit_at || ""),
        hit_event_ids: Array.isArray(it?.hit_event_ids)
          ? it.hit_event_ids.map((value) => cleanUserTemplate(value, 160)).filter(Boolean).slice(-256)
          : [],
      }))
      .filter((it) => it.plate);
  } catch {
    return [];
  }
}

function miniSaveBlacklist(items) {
  const clean = Array.isArray(items) ? items : [];
  try {
    const tmp = `${miniBlacklistPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schema: "mini.blacklist.v1", updated_at: nowBjText(), items: clean }, null, 2), "utf8");
    fs.renameSync(tmp, miniBlacklistPath);
    return true;
  } catch {
    return false;
  }
}

function miniReadBlacklistEvents(limit = 100, plate = "") {
  const p = miniNormalizePlate(plate);
  const file = path.join(logRoot, "mini_blacklist_events.jsonl");
  try {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const ev = safeJsonParse(lines[i]);
      if (!ev) continue;
      const evPlate = miniNormalizePlate(ev.plate || ev?.item?.plate || ev?.meta?.plate);
      if (p && !evPlate.includes(p)) continue;
      out.push({
        event_id: ev.event_id || `${ev.time_bj || ""}_${ev.event || "event"}_${evPlate}_${i}`,
        event_type: String(ev.event || ev.event_type || "event"),
        time_bj: String(ev.time_bj || ev.time || ""),
        plate: evPlate,
        source: String(ev?.meta?.source || ev?.item?.source || ""),
        reason: String(ev?.item?.reason || ev?.meta?.reason || ev?.meta?.id || ""),
        meta: ev.meta || null,
        item: ev.item || null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function dbBlacklistItem(item) {
  const plate = miniNormalizePlate(item?.plate);
  if (!plate) return null;
  const now = nowBjText();
  return {
    id: String(item?.id || randomUUID()),
    plate,
    reason: String(item?.reason || item?.violation_type || "违规车辆").trim().slice(0, 120),
    violation_type: String(item?.violation_type || item?.type || "parking_violation").trim().slice(0, 80),
    note: String(item?.note || "").trim().slice(0, 240),
    source: String(item?.source || "mini").trim().slice(0, 40),
    image_url: String(item?.image_url || "").trim(),
    image_path: String(item?.image_path || "").trim(),
    operator: String(item?.operator || item?.operator_name || "评委端").trim().slice(0, 40),
    created_at: String(item?.created_at || item?.created_at_bj || now),
    updated_at: String(item?.updated_at || item?.updated_at_bj || now),
    hits: Number.isFinite(Number(item?.hits)) ? Math.max(0, Math.round(Number(item.hits))) : 0,
    last_hit_at: String(item?.last_hit_at || ""),
  };
}

async function mysqlSaveBlacklistEvent(eventType, plate, item = null, meta = null) {
  const pool = await ensureMysqlPool();
  const p = miniNormalizePlate(plate || item?.plate || meta?.plate);
  if (!pool || !p) return false;
  try {
    await pool.execute(
      `INSERT INTO mini_blacklist_events
       (event_id,event_type,time_bj,plate,meta_json,item_json)
       VALUES (?,?,?,?,?,?)`,
      [randomUUID(), String(eventType || "event").slice(0, 32), nowBjText(), p, dbJson(meta || {}), dbJson(item || {})],
    );
    mysqlState.last_ok_at = nowBjText();
    return true;
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_blacklist_event_failed", message: String(e?.message || e).slice(0, 500) };
    return false;
  }
}

async function mysqlUpsertBlacklist(item) {
  const pool = await ensureMysqlPool();
  const clean = dbBlacklistItem(item);
  if (!pool || !clean) return false;
  try {
    await pool.execute(
      `INSERT INTO mini_blacklist
       (plate,id,reason,violation_type,note,source,image_url,image_path,operator_name,hits,last_hit_at,created_at_bj,updated_at_bj,raw_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
       id=VALUES(id), reason=VALUES(reason), violation_type=VALUES(violation_type), note=VALUES(note),
       source=VALUES(source), image_url=VALUES(image_url), image_path=VALUES(image_path),
       operator_name=VALUES(operator_name), hits=GREATEST(hits, VALUES(hits)), last_hit_at=VALUES(last_hit_at),
       updated_at_bj=VALUES(updated_at_bj), raw_json=VALUES(raw_json)`,
      [
        clean.plate,
        clean.id,
        clean.reason,
        clean.violation_type,
        clean.note,
        clean.source,
        clean.image_url,
        clean.image_path,
        clean.operator,
        clean.hits,
        clean.last_hit_at || null,
        clean.created_at,
        clean.updated_at,
        dbJson(clean),
      ],
    );
    mysqlState.last_ok_at = nowBjText();
    return true;
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_blacklist_upsert_failed", message: String(e?.message || e).slice(0, 500) };
    return false;
  }
}

async function mysqlRemoveBlacklist(plate, { recordEvent = true } = {}) {
  const pool = await ensureMysqlPool();
  const p = miniNormalizePlate(plate);
  if (!pool || !p) return false;
  try {
    await pool.execute("DELETE FROM mini_blacklist WHERE plate=?", [p]);
    if (recordEvent) await mysqlSaveBlacklistEvent("deleted", p, null, {});
    mysqlState.last_ok_at = nowBjText();
    return true;
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_blacklist_delete_failed", message: String(e?.message || e).slice(0, 500) };
    return false;
  }
}

async function mysqlMarkBlacklistHit(plate, meta = {}) {
  const pool = await ensureMysqlPool();
  const p = miniNormalizePlate(plate);
  if (!pool || !p) return null;
  const now = nowBjText();
  try {
    const [rows] = await pool.query("SELECT * FROM mini_blacklist WHERE plate=? LIMIT 1", [p]);
    const r = rows?.[0];
    if (!r) return null;
    await pool.execute(
      "UPDATE mini_blacklist SET hits=hits+1,last_hit_at=?,updated_at_bj=? WHERE plate=?",
      [now, now, p],
    );
    const item = {
      ...(safeJsonParse(r.raw_json) || {}),
      id: r.id,
      plate: r.plate,
      reason: r.reason,
      violation_type: r.violation_type,
      note: r.note,
      source: r.source,
      image_url: r.image_url,
      image_path: r.image_path,
      operator: r.operator_name,
      hits: Number(r.hits || 0) + 1,
      last_hit_at: now,
      created_at: r.created_at_bj,
      updated_at: now,
    };
    await mysqlSaveBlacklistEvent("hit", p, item, meta);
    mysqlState.last_ok_at = nowBjText();
    return item;
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_blacklist_hit_failed", message: String(e?.message || e).slice(0, 500) };
    return null;
  }
}

async function mysqlListBlacklist(q) {
  const pool = await ensureMysqlPool();
  if (!pool) return null;
  const plate = miniNormalizePlate(q?.get?.("plate") || q?.plate || "");
  const limit = clamp(parseInt(q?.get?.("limit") || q?.limit || "300", 10), 1, 1000);
  try {
    const params = [];
    let where = "";
    if (plate) {
      where = "WHERE plate LIKE ?";
      params.push(`%${plate}%`);
    }
    const [rows] = await pool.query(
      `SELECT plate,id,reason,violation_type,note,source,image_url,image_path,operator_name,hits,last_hit_at,created_at_bj,updated_at_bj,raw_json
       FROM mini_blacklist ${where}
       ORDER BY updated_at DESC, updated_at_bj DESC
       LIMIT ?`,
      [...params, limit],
    );
    mysqlState.last_ok_at = nowBjText();
    const items = (Array.isArray(rows) ? rows : []).map((r) => ({
      ...(safeJsonParse(r.raw_json) || {}),
      id: r.id,
      plate: r.plate,
      reason: r.reason,
      violation_type: r.violation_type,
      note: r.note,
      source: r.source,
      image_url: r.image_url,
      image_path: r.image_path,
      operator: r.operator_name,
      hits: Number(r.hits || 0),
      last_hit_at: r.last_hit_at || "",
      created_at: r.created_at_bj || "",
      updated_at: r.updated_at_bj || "",
    }));
    return { total: items.length, items };
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_blacklist_list_failed", message: String(e?.message || e).slice(0, 500) };
    return null;
  }
}

async function mysqlListBlacklistEvents(q) {
  const pool = await ensureMysqlPool();
  if (!pool) return null;
  const plate = miniNormalizePlate(q?.get?.("plate") || q?.plate || "");
  const limit = clamp(parseInt(q?.get?.("limit") || q?.limit || "100", 10), 1, 500);
  try {
    const params = [];
    let where = "";
    if (plate) {
      where = "WHERE plate LIKE ?";
      params.push(`%${plate}%`);
    }
    const [rows] = await pool.query(
      `SELECT event_id,event_type,time_bj,plate,meta_json,item_json
       FROM mini_blacklist_events ${where}
       ORDER BY created_at DESC, time_bj DESC
       LIMIT ?`,
      [...params, limit],
    );
    mysqlState.last_ok_at = nowBjText();
    const items = (Array.isArray(rows) ? rows : []).map((r) => {
      const meta = safeJsonParse(r.meta_json) || {};
      const item = safeJsonParse(r.item_json) || {};
      return {
        event_id: r.event_id,
        event_type: r.event_type,
        time_bj: r.time_bj,
        plate: r.plate,
        source: meta.source || item.source || "",
        reason: item.reason || meta.reason || meta.id || "",
        meta,
        item,
      };
    });
    return { total: items.length, items };
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_blacklist_events_failed", message: String(e?.message || e).slice(0, 500) };
    return null;
  }
}

async function mysqlSyncBlacklistFromJsonOnce() {
  if (mysqlState.blacklistMigrated) return;
  mysqlState.blacklistMigrated = true;
  const items = miniLoadBlacklist();
  if (!items.length) return;
  await Promise.all(items.map((it) => mysqlUpsertBlacklist(it)));
}

function miniFindBlacklist(plate) {
  const p = miniNormalizePlate(plate);
  if (!p) return null;
  return miniLoadBlacklist().find((it) => miniNormalizePlate(it.plate) === p) || null;
}

function miniUpsertBlacklist(input = {}, { syncDb = true, existingItem = null } = {}) {
  const plate = miniNormalizePlate(input.plate);
  if (!plate) return { ok: false, error: "bad_plate" };
  const items = miniLoadBlacklist();
  const now = nowBjText();
  const idx = items.findIndex((it) => miniNormalizePlate(it.plate) === plate);
  const dbExisting = existingItem && miniNormalizePlate(existingItem.plate) === plate ? existingItem : null;
  const wasExisting = idx >= 0 || Boolean(dbExisting);
  const patch = {
    plate,
    reason: String(input.reason || input.violation_type || "违规车辆").trim().slice(0, 120),
    violation_type: String(input.violation_type || input.type || "parking_violation").trim().slice(0, 80),
    note: String(input.note || "").trim().slice(0, 240),
    source: String(input.source || "mini").trim().slice(0, 40),
    image_url: String(input.image_url || "").trim(),
    image_path: String(input.image_path || "").trim(),
    operator: String(input.operator || "评委端").trim().slice(0, 40),
    updated_at: now,
  };
  let item;
  if (wasExisting) {
    const base = idx >= 0 ? items[idx] : dbExisting;
    item = { ...base, ...patch };
    if (idx >= 0) items[idx] = item;
    else items.unshift(item);
  } else {
    item = { id: randomUUID(), created_at: now, hits: 0, last_hit_at: "", ...patch };
    items.unshift(item);
  }
  miniSaveBlacklist(items);
  appendJsonLine("mini_blacklist_events.jsonl", { event: wasExisting ? "updated" : "created", time_bj: now, item });
  if (syncDb) {
    void mysqlUpsertBlacklist(item);
    void mysqlSaveBlacklistEvent(wasExisting ? "updated" : "created", plate, item, {});
  }
  return { ok: true, item, total: items.length, event_type: wasExisting ? "updated" : "created" };
}

function miniRemoveBlacklist(plate, { syncDb = true } = {}) {
  const p = miniNormalizePlate(plate);
  if (!p) return { ok: false, error: "bad_plate" };
  const items = miniLoadBlacklist();
  const next = items.filter((it) => miniNormalizePlate(it.plate) !== p);
  miniSaveBlacklist(next);
  appendJsonLine("mini_blacklist_events.jsonl", { event: "deleted", time_bj: nowBjText(), plate: p });
  if (syncDb) void mysqlRemoveBlacklist(p);
  return { ok: true, removed: next.length !== items.length, total: next.length };
}

function miniMarkBlacklistHit(plate, meta = {}) {
  const p = miniNormalizePlate(plate);
  if (!p) return null;
  const items = miniLoadBlacklist();
  const idx = items.findIndex((it) => miniNormalizePlate(it.plate) === p);
  if (idx < 0) return null;
  const hitEventId = cleanUserTemplate(meta?.event_id, 160);
  const priorEventIds = Array.isArray(items[idx].hit_event_ids) ? items[idx].hit_event_ids : [];
  if (hitEventId && priorEventIds.includes(hitEventId)) return items[idx];
  const now = nowBjText();
  items[idx] = {
    ...items[idx],
    hits: Number(items[idx].hits || 0) + 1,
    last_hit_at: now,
    updated_at: now,
    hit_event_ids: hitEventId ? [...priorEventIds, hitEventId].slice(-256) : priorEventIds,
  };
  if (!miniSaveBlacklist(items)) return { ...items[idx], hit_persist_failed: true };
  appendDurableJsonLine(path.join(logRoot, "mini_blacklist_events.jsonl"), { event: "hit", event_id: hitEventId || undefined, time_bj: now, plate: p, meta });
  void mysqlUpsertBlacklist(items[idx]);
  void mysqlSaveBlacklistEvent("hit", p, items[idx], meta);
  return items[idx];
}

function miniPlateFromInferResult(result) {
  const plates = Array.isArray(result?.plates) ? result.plates : [];
  const candidates = plates
    .map((p) => ({
      plate: miniNormalizePlate(p?.text || p?.plate || p?.label),
      score: Number(p?.score ?? p?.conf ?? p?.rec_conf ?? 0),
    }))
    .filter((p) => p.plate);
  candidates.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  if (candidates[0]) return candidates[0];
  const ocrText = miniNormalizePlate(result?.ocr?.text || result?.ocr_text);
  return ocrText ? { plate: ocrText, score: Number(result?.ocr?.score || 0) } : null;
}

const miniRuntimeState = {
  statusCache: { at: 0, host: "", value: null },
  inferActive: 0,
  rateBuckets: new Map(),
};

function miniClientIp(req) {
  return String(req?.headers?.["x-forwarded-for"] || req?.socket?.remoteAddress || "")
    .split(",")[0]
    .trim() || "unknown";
}

function checkMiniRateLimit(req, key, { windowMs = 10_000, max = 20 } = {}) {
  const now = Date.now();
  const bucketKey = `${key}:${miniClientIp(req)}`;
  let bucket = miniRuntimeState.rateBuckets.get(bucketKey);
  if (!bucket || now - Number(bucket.startAt || 0) >= windowMs) {
    bucket = { startAt: now, count: 0 };
    miniRuntimeState.rateBuckets.set(bucketKey, bucket);
  }
  bucket.count += 1;
  if (bucket.count <= max) return { ok: true };
  return { ok: false, retryAfterMs: Math.max(500, windowMs - (now - bucket.startAt)) };
}

function sendMiniRateLimited(res, limit) {
  sendJson(res, 429, {
    ok: false,
    error: "rate_limited",
    message: "操作太频繁，请稍后再试。",
    retry_after_ms: limit?.retryAfterMs || 1000,
  });
}

function cleanupMiniRateBuckets() {
  const now = Date.now();
  for (const [key, bucket] of miniRuntimeState.rateBuckets.entries()) {
    if (!bucket || now - Number(bucket.startAt || 0) > 120_000) miniRuntimeState.rateBuckets.delete(key);
  }
}

async function miniInferPlateFromImageBuffer(imgBuf) {
  if (!(imgBuf instanceof Buffer) || imgBuf.length < 10) return { ok: false, error: "bad_image" };
  const maxActive = clamp(parseInt(process.env.MINI_INFER_MAX_ACTIVE || "1", 10) || 1, 1, 4);
  if (miniRuntimeState.inferActive >= maxActive) {
    return {
      ok: false,
      error: "busy",
      message: "云端识别任务较多，请稍后重试。",
      active: miniRuntimeState.inferActive,
      max_active: maxActive,
    };
  }
  if (!aiReadyForMode("overlay")) {
    return { ok: false, error: "model_not_ready", message: "YOLO/OCR 模型未就绪，可手动输入车牌加入黑名单。" };
  }
  miniRuntimeState.inferActive += 1;
  try {
    const activeYolo = aiActiveModel("yolo");
    const activeOcr = aiActiveModel("ocr");
    const charsetPath = resolveOcrCharsetPath(activeOcr);
    if (aiPython.engine === "python") {
      const r = await callAiPython({
        op: "infer",
        mode: "overlay",
        yolo_path: activeYolo?.full_path ?? "",
        ocr_path: activeOcr?.full_path ?? "",
        ocr_charset_path: charsetPath || "",
        image_jpeg_base64: imgBuf.toString("base64"),
        width: 1280,
        height: 720,
        det_conf: 0.25,
      });
      if (!r?.ok) return { ok: false, error: r?.error || "infer_failed", message: r?.message || "" };
      const picked = miniPlateFromInferResult(r);
      return { ok: true, engine: "python", result: r, picked };
    }
    const seed = hash32(imgBuf);
    const result = { ok: true, engine: "fake", plates: [{ text: `TEST${String(seed % 100000).padStart(5, "0")}`, score: 0.88 }] };
    return { ok: true, engine: "fake", result, picked: miniPlateFromInferResult(result) };
  } catch (e) {
    return { ok: false, error: "infer_failed", message: String(e?.message || e) };
  } finally {
    miniRuntimeState.inferActive = Math.max(0, miniRuntimeState.inferActive - 1);
  }
}

async function miniBuildStatus(req) {
  cleanupMiniRateBuckets();
  const now = Date.now();
  const host = String(req?.headers?.host || "");
  const ttlMs = clamp(parseInt(process.env.MINI_STATUS_CACHE_MS || "1200", 10) || 1200, 300, 5000);
  const cache = miniRuntimeState.statusCache;
  if (cache.value && cache.host === host && now - Number(cache.at || 0) < ttlMs) {
    return {
      ...cache.value,
      time_bj: nowBjText(),
      backend: { ...(cache.value.backend || {}), uptime_s: Math.round(process.uptime()) },
      cache: { hit: true, ttl_ms: ttlMs, age_ms: now - Number(cache.at || 0) },
    };
  }
  await ensureMysqlPool();
  const status = rkReported.status || {};
  const rkAge = rkReported.statusAtMs ? Date.now() - Number(rkReported.statusAtMs) : null;
  const platesPage = await mysqlListPlates(1, 0);
  const violationsPage = await mysqlListViolations(1, 0);
  const blacklist = miniLoadBlacklist();
  const out = {
    ok: true,
    time_bj: nowBjText(),
    backend: { ok: true, host: String(req?.headers?.host || ""), uptime_s: Math.round(process.uptime()) },
    database: { mysql: mysqlPublicStatus() },
    rk3568: {
      online: rkIsOnline(),
      age_ms: rkAge,
      device: status.device || "RK3568",
      biz_system: status.biz_system || "",
      input_mode: status.input_mode || "",
      capture_running: status.capture_running === true,
    },
    esp32: buildEsp32Status(),
    counters: {
      plates: Number(platesPage?.total ?? rkReported.plates?.length ?? 0),
      violations: Number(violationsPage?.total ?? rkReported.violations?.length ?? 0),
      blacklist: blacklist.length,
      blacklist_hits: blacklist.reduce((sum, it) => sum + Number(it.hits || 0), 0),
    },
    latest: {
      plate: compactPlateItem(rkReported.plates?.[0] || platesPage?.items?.[0] || null) || {},
      violation: compactViolationItem(rkReported.violations?.[0] || violationsPage?.items?.[0] || null) || { ai: {} },
    },
  };
  miniRuntimeState.statusCache = { at: Date.now(), host, value: out };
  return out;
}

const mysqlConfigPath = path.resolve(__dirname, "mysql-config.json");
const mysqlState = {
  enabled: false,
  ready: false,
  pool: null,
  initPromise: null,
  error: null,
  config: null,
  driver_missing: false,
  last_ok_at: null,
  retry_at_ms: 0,
  capture_metrics_writes: 0,
};

const RK_CAPTURE_METRICS_DB_MAX = clamp(parseInt(process.env.RK_CAPTURE_METRICS_DB_MAX || "50000", 10) || 50000, 1000, 500000);

function boolEnv(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on", "启用", "是"].includes(s);
}

function loadMysqlConfig() {
  let fileCfg = {};
  try {
    if (fs.existsSync(mysqlConfigPath) && fs.statSync(mysqlConfigPath).isFile()) {
      fileCfg = safeJsonParse(fs.readFileSync(mysqlConfigPath, "utf8")) || {};
    }
  } catch {}
  const envEnabled = process.env.MYSQL_ENABLED ?? process.env.DB_ENABLED;
  const enabled = envEnabled != null ? boolEnv(envEnabled) : fileCfg.enabled === true;
  return {
    enabled,
    host: String(process.env.MYSQL_HOST || fileCfg.host || "127.0.0.1").trim(),
    port: clamp(parseInt(String(process.env.MYSQL_PORT || fileCfg.port || "3306"), 10) || 3306, 1, 65535),
    user: String(process.env.MYSQL_USER || fileCfg.user || "root").trim(),
    password: String(process.env.MYSQL_PASSWORD ?? fileCfg.password ?? ""),
    database: String(process.env.MYSQL_DATABASE || fileCfg.database || "rk3568_http").trim(),
    connectionLimit: clamp(parseInt(String(process.env.MYSQL_CONNECTION_LIMIT || fileCfg.connectionLimit || "5"), 10) || 5, 1, 30),
  };
}

function businessMysqlWritePolicy() {
  const enabled = Boolean((mysqlState.config || loadMysqlConfig()).enabled);
  const configured = process.env.RK_BUSINESS_REQUIRE_MYSQL;
  return {
    enabled,
    // When MySQL is enabled it is part of the durable business snapshot by
    // default. Operators can explicitly keep JSON-only availability during a
    // database maintenance window by setting RK_BUSINESS_REQUIRE_MYSQL=0.
    required: enabled && (configured == null ? true : boolEnv(configured)),
  };
}

function mysqlPublicStatus() {
  const cfg = mysqlState.config || loadMysqlConfig();
  return {
    enabled: Boolean(cfg.enabled),
    ready: Boolean(mysqlState.ready),
    driver_missing: Boolean(mysqlState.driver_missing),
    host: cfg.host || null,
    port: cfg.port || null,
    database: cfg.database || null,
    user: cfg.user || null,
    connectionLimit: cfg.connectionLimit || null,
    config_path: mysqlConfigPath,
    last_ok_at: mysqlState.last_ok_at,
    retry_at_ms: mysqlState.retry_at_ms || null,
    error: mysqlState.error,
  };
}

function mysqlIdent(name) {
  const s = String(name || "").replace(/[^A-Za-z0-9_$]/g, "");
  return s || "rk3568_http";
}

function isMysqlDuplicateSchemaError(error) {
  return [1060, 1061].includes(Number(error?.errno))
    || ["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"].includes(String(error?.code || ""));
}

async function ensureMysqlColumn(pool, database, table, column, definition) {
  const [rows] = await pool.query(
    `SELECT 1 AS present
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?
     LIMIT 1`,
    [database, table, column],
  );
  if (Array.isArray(rows) && rows.length) return false;
  try {
    await pool.query(
      `ALTER TABLE \`${mysqlIdent(table)}\` ADD COLUMN \`${mysqlIdent(column)}\` ${definition}`,
    );
  } catch (error) {
    // A second instance can win the migration race after our metadata check.
    if (!isMysqlDuplicateSchemaError(error)) throw error;
  }
  return true;
}

async function ensureMysqlIndex(pool, database, table, index, columnsSql) {
  const [rows] = await pool.query(
    `SELECT 1 AS present
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME=?
     LIMIT 1`,
    [database, table, index],
  );
  if (Array.isArray(rows) && rows.length) return false;
  try {
    await pool.query(
      `ALTER TABLE \`${mysqlIdent(table)}\` ADD INDEX \`${mysqlIdent(index)}\` (${columnsSql})`,
    );
  } catch (error) {
    if (!isMysqlDuplicateSchemaError(error)) throw error;
  }
  return true;
}

async function migrateMysqlBusinessSnapshotSchema(pool, database) {
  // CREATE TABLE IF NOT EXISTS does not evolve tables created by older cloud
  // releases. These idempotent migrations keep an in-place upgrade usable.
  await ensureMysqlColumn(pool, database, "rk_business_accounts", "snapshot_at_ms", "BIGINT NULL");
  await ensureMysqlColumn(pool, database, "rk_business_records", "snapshot_at_ms", "BIGINT NULL");
  await ensureMysqlIndex(pool, database, "rk_business_accounts", "idx_snapshot_at", "`snapshot_at_ms`");
  await ensureMysqlIndex(pool, database, "rk_business_records", "idx_snapshot_at", "`snapshot_at_ms`");
}

function requireMysqlDriver() {
  try {
    return require("mysql2/promise");
  } catch (e) {
    mysqlState.driver_missing = true;
    mysqlState.retry_at_ms = Date.now() + 10000;
    mysqlState.error = { code: "mysql2_missing", message: "请在 backend 目录执行 npm install mysql2" };
    return null;
  }
}

async function ensureMysqlPool() {
  const cfg = loadMysqlConfig();
  mysqlState.config = cfg;
  mysqlState.enabled = Boolean(cfg.enabled);
  if (!cfg.enabled) {
    mysqlState.ready = false;
    mysqlState.error = null;
    mysqlState.retry_at_ms = 0;
    return null;
  }
  if (mysqlState.pool && mysqlState.ready) return mysqlState.pool;
  if (mysqlState.retry_at_ms && Date.now() < mysqlState.retry_at_ms) return null;
  if (mysqlState.initPromise) return mysqlState.initPromise;
  mysqlState.initPromise = (async () => {
    const mysql = requireMysqlDriver();
    if (!mysql) return null;
    const database = mysqlIdent(cfg.database);
    try {
      const baseConn = await mysql.createConnection({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        connectTimeout: 2500,
      });
      await baseConn.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      await baseConn.end();
      const pool = mysql.createPool({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        database,
        charset: "utf8mb4",
        waitForConnections: true,
        connectionLimit: cfg.connectionLimit,
        queueLimit: 0,
        connectTimeout: 2500,
      });
      await pool.query(`
        CREATE TABLE IF NOT EXISTS rk_plate_captures (
          id VARCHAR(64) NOT NULL PRIMARY KEY,
          time_bj VARCHAR(32) NOT NULL,
          source VARCHAR(64) NULL,
          plate VARCHAR(64) NOT NULL,
          color VARCHAR(32) NULL,
          vehicle_type VARCHAR(64) NULL,
          conf DECIMAL(8,4) NULL,
          image_url VARCHAR(255) NULL,
          image_path VARCHAR(512) NULL,
          thumb_url VARCHAR(255) NULL,
          thumb_path VARCHAR(512) NULL,
          image_bytes INT NULL,
          thumb_bytes INT NULL,
          raw_json LONGTEXT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_time_bj (time_bj),
          INDEX idx_plate_time (plate, time_bj)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS rk_driver_capture_metrics (
          sample_id VARCHAR(64) NOT NULL PRIMARY KEY,
          time_bj VARCHAR(32) NOT NULL,
          sample_at_ms BIGINT NOT NULL,
          device VARCHAR(64) NULL,
          input_mode VARCHAR(24) NULL,
          running TINYINT NULL,
          metric_valid TINYINT NULL,
          pcie_rx_fps DOUBLE NULL,
          pcie_frame_interval_ms DOUBLE NULL,
          pcie_dma_ms DOUBLE NULL,
          pcie_dma_wait_ms DOUBLE NULL,
          pcie_user_copy_ms DOUBLE NULL,
          pcie_rx_frames BIGINT NULL,
          pcie_dropped_frames BIGINT NULL,
          metric_source VARCHAR(80) NULL,
          raw_driver_json LONGTEXT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_capture_sample_at (sample_at_ms),
          INDEX idx_capture_time_bj (time_bj)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS rk_violation_captures (
          id VARCHAR(64) NOT NULL PRIMARY KEY,
          time_bj VARCHAR(32) NOT NULL,
          view_mode INT NULL,
          single_source INT NULL,
          q0 DOUBLE NULL,
          q1 DOUBLE NULL,
          q2 DOUBLE NULL,
          q3 DOUBLE NULL,
          overlap_iou DOUBLE NULL,
          image_url VARCHAR(255) NULL,
          image_path VARCHAR(512) NULL,
          thumb_url VARCHAR(255) NULL,
          thumb_path VARCHAR(512) NULL,
          image_len INT NULL,
          thumb_len INT NULL,
          ai_state VARCHAR(32) NULL,
          ai_ok TINYINT NULL,
          ai_violation TINYINT NULL,
          ai_desc VARCHAR(255) NULL,
          manual_reviewed TINYINT NULL,
          manual_violation TINYINT NULL,
          manual_desc VARCHAR(255) NULL,
          raw_json LONGTEXT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_time_bj (time_bj),
          INDEX idx_ai_state (ai_state),
          INDEX idx_manual_reviewed (manual_reviewed)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS rk_business_accounts (
          \`system\` VARCHAR(16) NOT NULL,
          plate VARCHAR(64) NOT NULL,
          balance DECIMAL(12,2) NULL,
          arrears DECIMAL(12,2) NULL,
          status VARCHAR(32) NULL,
          updated_at VARCHAR(32) NULL,
          snapshot_at_ms BIGINT NULL,
          raw_json LONGTEXT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (\`system\`, plate),
          INDEX idx_system_status (\`system\`, status),
          INDEX idx_snapshot_at (snapshot_at_ms)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS rk_business_records (
          \`system\` VARCHAR(16) NOT NULL,
          record_key VARCHAR(128) NOT NULL,
          time_bj VARCHAR(32) NOT NULL,
          plate VARCHAR(64) NOT NULL,
          source VARCHAR(64) NULL,
          delta DECIMAL(12,2) NULL,
          balance DECIMAL(12,2) NULL,
          arrears DECIMAL(12,2) NULL,
          result VARCHAR(32) NULL,
          snapshot_at_ms BIGINT NULL,
          raw_json LONGTEXT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (\`system\`, record_key),
          INDEX idx_system_time (\`system\`, time_bj),
          INDEX idx_snapshot_at (snapshot_at_ms)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS rk_business_snapshots (
          \`system\` VARCHAR(16) NOT NULL PRIMARY KEY,
          snapshot_at_ms BIGINT NULL,
          accounts_count INT NULL,
          records_count INT NULL,
          raw_json LONGTEXT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await migrateMysqlBusinessSnapshotSchema(pool, database);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS mini_blacklist (
          plate VARCHAR(64) NOT NULL PRIMARY KEY,
          id VARCHAR(64) NOT NULL,
          reason VARCHAR(120) NULL,
          violation_type VARCHAR(80) NULL,
          note VARCHAR(240) NULL,
          source VARCHAR(40) NULL,
          image_url VARCHAR(255) NULL,
          image_path VARCHAR(512) NULL,
          operator_name VARCHAR(40) NULL,
          hits INT NOT NULL DEFAULT 0,
          last_hit_at VARCHAR(32) NULL,
          created_at_bj VARCHAR(32) NULL,
          updated_at_bj VARCHAR(32) NULL,
          raw_json LONGTEXT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_hits (hits),
          INDEX idx_updated_at_bj (updated_at_bj)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS mini_blacklist_events (
          event_id VARCHAR(64) NOT NULL PRIMARY KEY,
          event_type VARCHAR(32) NOT NULL,
          time_bj VARCHAR(32) NOT NULL,
          plate VARCHAR(64) NOT NULL,
          meta_json LONGTEXT NULL,
          item_json LONGTEXT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_plate_time (plate, time_bj),
          INDEX idx_event_time (event_type, time_bj)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      mysqlState.pool = pool;
      mysqlState.ready = true;
      mysqlState.driver_missing = false;
      mysqlState.error = null;
      mysqlState.last_ok_at = nowBjText();
      mysqlState.retry_at_ms = 0;
      setTimeout(async () => {
        try {
          const [parkingSnap, etcSnap] = await Promise.all([
            mysqlLoadBusinessSnapshot("parking"),
            mysqlLoadBusinessSnapshot("etc"),
          ]);
          applyMysqlBusinessSnapshotIfCurrent("parking", parkingSnap);
          applyMysqlBusinessSnapshotIfCurrent("etc", etcSnap);
          writeBizLatestSnapshot();
        } catch {}
      }, 0);
      return pool;
    } catch (e) {
      mysqlState.ready = false;
      mysqlState.error = { code: e?.code || "mysql_error", message: String(e?.message || e).slice(0, 500) };
      mysqlState.retry_at_ms = Date.now() + 10000;
      return null;
    } finally {
      mysqlState.initPromise = null;
    }
  })();
  return mysqlState.initPromise;
}

function dbJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return "{}";
  }
}

function dbTinyBool(v) {
  if (v === null || v === undefined) return null;
  return v === true || v === 1 || v === "1" ? 1 : 0;
}

function dbPlateItem(item) {
  if (!item || typeof item !== "object") return null;
  const copy = { ...item };
  delete copy.thumb_jpeg_base64;
  delete copy.image_jpeg_base64;
  delete copy.thumbJpeg;
  delete copy.imageJpeg;
  return copy;
}

function dbViolationItem(item) {
  if (!item || typeof item !== "object") return null;
  const copy = { ...item };
  delete copy.thumb_jpeg_base64;
  delete copy.image_jpeg_base64;
  delete copy.thumbJpeg;
  delete copy.imageJpeg;
  return copy;
}

async function mysqlSavePlate(item) {
  const pool = await ensureMysqlPool();
  if (!pool || !item?.id) return false;
  const clean = dbPlateItem(item);
  try {
    await pool.execute(
      `INSERT INTO rk_plate_captures
       (id,time_bj,source,plate,color,vehicle_type,conf,image_url,image_path,thumb_url,thumb_path,image_bytes,thumb_bytes,raw_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
       time_bj=VALUES(time_bj), source=VALUES(source), plate=VALUES(plate), color=VALUES(color),
       vehicle_type=VALUES(vehicle_type), conf=VALUES(conf), image_url=VALUES(image_url), image_path=VALUES(image_path),
       thumb_url=VALUES(thumb_url), thumb_path=VALUES(thumb_path), image_bytes=VALUES(image_bytes),
       thumb_bytes=VALUES(thumb_bytes), raw_json=VALUES(raw_json)`,
      [
        String(item.id),
        String(item.time_bj || ""),
        item.source ?? null,
        item.plate ?? "",
        item.color ?? null,
        item.vehicle_type ?? null,
        Number.isFinite(Number(item.conf)) ? Number(item.conf) : null,
        item.image_url ?? null,
        item.image_path ?? null,
        item.thumb_url ?? null,
        item.thumb_path ?? null,
        Number.isFinite(Number(item.image_bytes)) ? Number(item.image_bytes) : null,
        Number.isFinite(Number(item.thumb_bytes)) ? Number(item.thumb_bytes) : null,
        dbJson(clean),
      ],
    );
    mysqlState.last_ok_at = nowBjText();
    return true;
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_insert_plate_failed", message: String(e?.message || e).slice(0, 500) };
    return false;
  }
}

async function mysqlSaveViolation(item) {
  const pool = await ensureMysqlPool();
  if (!pool || !item?.id) return false;
  const clean = dbViolationItem(item);
  const ai = item.ai && typeof item.ai === "object" ? item.ai : {};
  const manual = item.manual && typeof item.manual === "object" ? item.manual : {};
  try {
    await pool.execute(
      `INSERT INTO rk_violation_captures
       (id,time_bj,view_mode,single_source,q0,q1,q2,q3,overlap_iou,image_url,image_path,thumb_url,thumb_path,image_len,thumb_len,
        ai_state,ai_ok,ai_violation,ai_desc,manual_reviewed,manual_violation,manual_desc,raw_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
       time_bj=VALUES(time_bj), view_mode=VALUES(view_mode), single_source=VALUES(single_source),
       q0=VALUES(q0), q1=VALUES(q1), q2=VALUES(q2), q3=VALUES(q3), overlap_iou=VALUES(overlap_iou),
       image_url=VALUES(image_url), image_path=VALUES(image_path), thumb_url=VALUES(thumb_url), thumb_path=VALUES(thumb_path),
       image_len=VALUES(image_len), thumb_len=VALUES(thumb_len), ai_state=VALUES(ai_state), ai_ok=VALUES(ai_ok),
       ai_violation=VALUES(ai_violation), ai_desc=VALUES(ai_desc), manual_reviewed=VALUES(manual_reviewed),
       manual_violation=VALUES(manual_violation), manual_desc=VALUES(manual_desc), raw_json=VALUES(raw_json)`,
      [
        String(item.id),
        String(item.time_bj || ""),
        Number.isFinite(Number(item.view_mode)) ? Number(item.view_mode) : null,
        Number.isFinite(Number(item.single_source)) ? Number(item.single_source) : null,
        Number.isFinite(Number(item.q0)) ? Number(item.q0) : null,
        Number.isFinite(Number(item.q1)) ? Number(item.q1) : null,
        Number.isFinite(Number(item.q2)) ? Number(item.q2) : null,
        Number.isFinite(Number(item.q3)) ? Number(item.q3) : null,
        Number.isFinite(Number(item.overlap_iou)) ? Number(item.overlap_iou) : null,
        item.image_url ?? null,
        item.image_path ?? null,
        item.thumb_url ?? null,
        item.thumb_path ?? null,
        Number.isFinite(Number(item.image_len)) ? Number(item.image_len) : null,
        Number.isFinite(Number(item.thumb_len)) ? Number(item.thumb_len) : null,
        ai.state ?? null,
        dbTinyBool(ai.ok),
        dbTinyBool(ai.violation),
        ai.desc ?? null,
        dbTinyBool(manual.reviewed),
        dbTinyBool(manual.violation),
        manual.desc ?? null,
        dbJson(clean),
      ],
    );
    mysqlState.last_ok_at = nowBjText();
    return true;
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_insert_violation_failed", message: String(e?.message || e).slice(0, 500) };
    return false;
  }
}

async function mysqlListPlates(limit, offset) {
  const pool = await ensureMysqlPool();
  if (!pool) return null;
  try {
    const [countRows] = await pool.query("SELECT COUNT(*) AS total FROM rk_plate_captures");
    const total = Number(countRows?.[0]?.total || 0);
    const [rows] = await pool.query(
      `SELECT id,time_bj,source,plate,color,vehicle_type,conf,image_url,image_path,thumb_url,thumb_path,image_bytes,thumb_bytes,raw_json
       FROM rk_plate_captures ORDER BY time_bj DESC, created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    mysqlState.last_ok_at = nowBjText();
    return {
      total,
      items: (rows || []).map((r) => {
        const raw = safeJsonParse(r.raw_json) || {};
        return {
          ...raw,
          id: r.id,
          time_bj: r.time_bj,
          source: r.source ?? raw.source,
          plate: r.plate ?? raw.plate,
          color: r.color ?? raw.color,
          vehicle_type: r.vehicle_type ?? raw.vehicle_type,
          conf: r.conf == null ? raw.conf ?? null : Number(r.conf),
          image_url: r.image_url ?? raw.image_url,
          image_path: r.image_path ?? raw.image_path,
          thumb_url: r.thumb_url ?? raw.thumb_url,
          thumb_path: r.thumb_path ?? raw.thumb_path,
          image_bytes: r.image_bytes ?? raw.image_bytes,
          thumb_bytes: r.thumb_bytes ?? raw.thumb_bytes,
        };
      }),
    };
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_query_plates_failed", message: String(e?.message || e).slice(0, 500) };
    return null;
  }
}

async function mysqlListPlateConfidenceItems(limit) {
  const pool = await ensureMysqlPool();
  if (!pool) return null;
  try {
    const [rows] = await pool.query(
      `SELECT id,time_bj,plate,conf,raw_json
       FROM rk_plate_captures ORDER BY time_bj DESC, created_at DESC LIMIT ?`,
      [limit],
    );
    mysqlState.last_ok_at = nowBjText();
    return (rows || []).map((row) => {
      const raw = safeJsonParse(row.raw_json) || {};
      return {
        ...raw,
        id: row.id || raw.id,
        time_bj: row.time_bj || raw.time_bj,
        plate: row.plate || raw.plate,
        conf: row.conf == null ? raw.conf ?? null : Number(row.conf),
      };
    });
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_query_plate_confidence_failed", message: String(e?.message || e).slice(0, 500) };
    return null;
  }
}

async function mysqlSaveRkCaptureMetrics(sample, driverStatus) {
  const pool = await ensureMysqlPool();
  if (!pool || !sample?.sample_id) return false;
  try {
    await pool.execute(
      `INSERT INTO rk_driver_capture_metrics
       (sample_id,time_bj,sample_at_ms,device,input_mode,running,metric_valid,
        pcie_rx_fps,pcie_frame_interval_ms,pcie_dma_ms,pcie_dma_wait_ms,pcie_user_copy_ms,
        pcie_rx_frames,pcie_dropped_frames,metric_source,raw_driver_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         time_bj=VALUES(time_bj), sample_at_ms=VALUES(sample_at_ms), device=VALUES(device),
         input_mode=VALUES(input_mode), running=VALUES(running), metric_valid=VALUES(metric_valid),
         pcie_rx_fps=VALUES(pcie_rx_fps), pcie_frame_interval_ms=VALUES(pcie_frame_interval_ms),
         pcie_dma_ms=VALUES(pcie_dma_ms), pcie_dma_wait_ms=VALUES(pcie_dma_wait_ms),
         pcie_user_copy_ms=VALUES(pcie_user_copy_ms), pcie_rx_frames=VALUES(pcie_rx_frames),
         pcie_dropped_frames=VALUES(pcie_dropped_frames), metric_source=VALUES(metric_source),
         raw_driver_json=VALUES(raw_driver_json)`,
      [
        sample.sample_id,
        sample.time_bj,
        sample.sample_at_ms,
        sample.device || null,
        sample.input_mode || null,
        dbTinyBool(sample.running),
        dbTinyBool(sample.metric_valid),
        sample.pcie_rx_fps ?? null,
        sample.pcie_frame_interval_ms ?? null,
        sample.pcie_dma_ms ?? null,
        sample.pcie_dma_wait_ms ?? null,
        sample.pcie_user_copy_ms ?? null,
        sample.pcie_rx_frames ?? null,
        sample.pcie_dropped_frames ?? null,
        sample.metric_source || null,
        dbJson(driverStatus || {}),
      ],
    );
    mysqlState.capture_metrics_writes = Number(mysqlState.capture_metrics_writes || 0) + 1;
    if (mysqlState.capture_metrics_writes % 100 === 0) {
      const [cutoffRows] = await pool.query(
        "SELECT sample_at_ms FROM rk_driver_capture_metrics ORDER BY sample_at_ms DESC LIMIT 1 OFFSET ?",
        [RK_CAPTURE_METRICS_DB_MAX - 1],
      );
      const cutoffMs = Number(cutoffRows?.[0]?.sample_at_ms);
      if (Number.isFinite(cutoffMs)) {
        await pool.execute("DELETE FROM rk_driver_capture_metrics WHERE sample_at_ms < ?", [cutoffMs]);
      }
    }
    mysqlState.last_ok_at = nowBjText();
    return true;
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_insert_capture_metrics_failed", message: String(e?.message || e).slice(0, 500) };
    return false;
  }
}

async function mysqlListRkCaptureMetrics(limit) {
  const pool = await ensureMysqlPool();
  if (!pool) return null;
  try {
    const [rows] = await pool.query(
      `SELECT sample_id,time_bj,sample_at_ms,device,input_mode,running,metric_valid,
              pcie_rx_fps,pcie_frame_interval_ms,pcie_dma_ms,pcie_dma_wait_ms,pcie_user_copy_ms,
              pcie_rx_frames,pcie_dropped_frames,metric_source,raw_driver_json
       FROM rk_driver_capture_metrics
       WHERE input_mode = 'pcie'
       ORDER BY sample_at_ms DESC LIMIT ?`,
      [limit],
    );
    mysqlState.last_ok_at = nowBjText();
    return (rows || []).map((row) => {
      const driverStatus = safeJsonParse(row.raw_driver_json) || {};
      const metrics = driverStatus.capture_metrics && typeof driverStatus.capture_metrics === "object" ? driverStatus.capture_metrics : {};
      return {
        sample_id: String(row.sample_id || ""),
        time_bj: String(row.time_bj || ""),
        sample_at_ms: Number(row.sample_at_ms) || 0,
        device: String(row.device || ""),
        input_mode: String(row.input_mode || ""),
        running: row.running == null ? null : Boolean(row.running),
        metric_valid: row.metric_valid == null ? null : Boolean(row.metric_valid),
        pcie_rx_fps: row.pcie_rx_fps == null ? null : Number(row.pcie_rx_fps),
        pcie_frame_interval_ms: row.pcie_frame_interval_ms == null ? null : Number(row.pcie_frame_interval_ms),
        pcie_dma_ms: row.pcie_dma_ms == null ? null : Number(row.pcie_dma_ms),
        pcie_dma_wait_ms: row.pcie_dma_wait_ms == null ? null : Number(row.pcie_dma_wait_ms),
        pcie_dma_wait_avg_ms: cleanDriverNumber(metrics.dma_wait_avg_ms),
        pcie_dma_wait_max_ms: cleanDriverNumber(metrics.dma_wait_max_ms),
        pcie_dma_wait_window_ms: cleanDriverNumber(metrics.dma_wait_window_ms),
        pcie_dma_wait_sample_count: cleanDriverNumber(metrics.dma_wait_sample_count),
        pcie_user_copy_ms: row.pcie_user_copy_ms == null ? null : Number(row.pcie_user_copy_ms),
        pcie_rx_frames: row.pcie_rx_frames == null ? null : Number(row.pcie_rx_frames),
        pcie_dropped_frames: row.pcie_dropped_frames == null ? null : Number(row.pcie_dropped_frames),
        drop_rate_pct: captureMetricsDropRate(row.pcie_rx_frames, row.pcie_dropped_frames),
        metric_source: String(row.metric_source || ""),
        dma_unit_bytes: cleanDriverNumber(metrics.dma_unit_bytes),
        dma_units_per_frame: cleanDriverNumber(metrics.dma_units_per_frame),
        batch_ioctl: typeof metrics.batch_ioctl === "boolean" ? metrics.batch_ioctl : null,
        irq_wait: typeof metrics.irq_wait === "boolean" ? metrics.irq_wait : null,
        irq_fallback: typeof metrics.irq_fallback === "boolean" ? metrics.irq_fallback : null,
        metric_basis: cleanDriverText(metrics.metric_basis, 120),
        last_error: cleanDriverText(metrics.last_error, 500),
      };
    });
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_query_capture_metrics_failed", message: String(e?.message || e).slice(0, 500) };
    return null;
  }
}

async function mysqlListViolations(limit, offset) {
  const pool = await ensureMysqlPool();
  if (!pool) return null;
  try {
    const [countRows] = await pool.query("SELECT COUNT(*) AS total FROM rk_violation_captures");
    const total = Number(countRows?.[0]?.total || 0);
    const [rows] = await pool.query(
      `SELECT id,time_bj,view_mode,single_source,q0,q1,q2,q3,overlap_iou,image_url,image_path,thumb_url,thumb_path,
              image_len,thumb_len,ai_state,ai_ok,ai_violation,ai_desc,manual_reviewed,manual_violation,manual_desc,raw_json
       FROM rk_violation_captures ORDER BY time_bj DESC, created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    mysqlState.last_ok_at = nowBjText();
    return {
      total,
      items: (rows || []).map((r) => {
        const raw = safeJsonParse(r.raw_json) || {};
        const ai = r.ai_state || r.ai_ok != null || r.ai_violation != null || r.ai_desc
          ? { ...(raw.ai || {}), state: r.ai_state, ok: r.ai_ok == null ? null : Boolean(r.ai_ok), violation: r.ai_violation == null ? null : Boolean(r.ai_violation), desc: r.ai_desc }
          : raw.ai ?? null;
        const manual = r.manual_reviewed || r.manual_violation != null || r.manual_desc
          ? { ...(raw.manual || {}), reviewed: Boolean(r.manual_reviewed), violation: r.manual_violation == null ? null : Boolean(r.manual_violation), desc: r.manual_desc }
          : raw.manual ?? null;
        return {
          ...raw,
          id: r.id,
          time_bj: r.time_bj,
          view_mode: r.view_mode,
          single_source: r.single_source,
          q0: r.q0,
          q1: r.q1,
          q2: r.q2,
          q3: r.q3,
          overlap_iou: r.overlap_iou,
          image_url: r.image_url ?? raw.image_url,
          image_path: r.image_path ?? raw.image_path,
          thumb_url: r.thumb_url ?? raw.thumb_url,
          thumb_path: r.thumb_path ?? raw.thumb_path,
          image_len: r.image_len ?? raw.image_len,
          thumb_len: r.thumb_len ?? raw.thumb_len,
          ai,
          manual,
        };
      }),
    };
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_query_violations_failed", message: String(e?.message || e).slice(0, 500) };
    return null;
  }
}

async function mysqlFindPlatePaths(id) {
  const pool = await ensureMysqlPool();
  if (!pool || !id) return null;
  try {
    const [rows] = await pool.query(
      "SELECT image_path,thumb_path FROM rk_plate_captures WHERE id=? LIMIT 1",
      [String(id)],
    );
    mysqlState.last_ok_at = nowBjText();
    return rows?.[0] || null;
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_find_plate_failed", message: String(e?.message || e).slice(0, 500) };
    return null;
  }
}

async function mysqlFindViolationPaths(id) {
  const pool = await ensureMysqlPool();
  if (!pool || !id) return null;
  try {
    const [rows] = await pool.query(
      "SELECT image_path,thumb_path FROM rk_violation_captures WHERE id=? LIMIT 1",
      [String(id)],
    );
    mysqlState.last_ok_at = nowBjText();
    return rows?.[0] || null;
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_find_violation_failed", message: String(e?.message || e).slice(0, 500) };
    return null;
  }
}

async function mysqlClearPlates() {
  const pool = await ensureMysqlPool();
  if (!pool) return false;
  try {
    await pool.query("DELETE FROM rk_plate_captures");
    mysqlState.last_ok_at = nowBjText();
    return true;
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_clear_plates_failed", message: String(e?.message || e).slice(0, 500) };
    return false;
  }
}

async function mysqlDeletePlate(id) {
  const pool = await ensureMysqlPool();
  if (!pool || !id) return null;
  try {
    const [result] = await pool.execute("DELETE FROM rk_plate_captures WHERE id=?", [String(id)]);
    mysqlState.last_ok_at = nowBjText();
    return Number(result?.affectedRows || 0) > 0;
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_delete_plate_failed", message: String(e?.message || e).slice(0, 500) };
    return false;
  }
}

async function mysqlClearViolations() {
  const pool = await ensureMysqlPool();
  if (!pool) return false;
  try {
    await pool.query("DELETE FROM rk_violation_captures");
    mysqlState.last_ok_at = nowBjText();
    return true;
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_clear_violations_failed", message: String(e?.message || e).slice(0, 500) };
    return false;
  }
}

async function mysqlDeleteViolation(id) {
  const pool = await ensureMysqlPool();
  if (!pool || !id) return null;
  try {
    const [result] = await pool.execute("DELETE FROM rk_violation_captures WHERE id=?", [String(id)]);
    mysqlState.last_ok_at = nowBjText();
    return Number(result?.affectedRows || 0) > 0;
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_delete_violation_failed", message: String(e?.message || e).slice(0, 500) };
    return false;
  }
}

function bizRound2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function bizSnapshotFromStore(system) {
  const store = biz?.[system];
  if (!store) return { accounts: [], records: [] };
  return {
    accounts: Array.from(store.accounts.values()).map((a) => ({
      plate: String(a?.plate ?? "").trim(),
      balance: bizRound2(a?.balance ?? 0),
      arrears: bizRound2(a?.arrears ?? 0),
      status: String(a?.status ?? "active"),
      updated_at: String(a?.updated_at ?? nowBjText()),
    })),
    records: Array.isArray(store.records)
      ? store.records.map((r) => ({
          time_bj: String(r?.time_bj ?? nowBjText()),
          plate: String(r?.plate ?? "").trim(),
          source: String(r?.source ?? ""),
          delta: bizRound2(r?.delta ?? r?.amount ?? r?.change ?? 0),
          balance: bizRound2(r?.balance ?? 0),
          arrears: bizRound2(r?.arrears ?? 0),
          result: String(r?.result ?? ""),
        }))
      : [],
  };
}

function bizSnapshotBody(system) {
  const sys = system === "etc" ? "etc" : "parking";
  const snap = bizSnapshotFromStore(sys);
  return { [sys]: snap };
}

function mysqlBizAccountRow(system, item, snapshotAtMs) {
  const clean = item && typeof item === "object" ? item : {};
  const plate = String(clean.plate ?? "").trim();
  if (!plate) return null;
  return [
    system,
    plate,
    Number.isFinite(Number(clean.balance)) ? Number(clean.balance) : 0,
    Number.isFinite(Number(clean.arrears)) ? Number(clean.arrears) : 0,
    String(clean.status ?? "active"),
    String(clean.updated_at ?? nowBjText()),
    Number.isFinite(Number(snapshotAtMs)) ? Math.floor(Number(snapshotAtMs)) : Date.now(),
    dbJson(clean),
  ];
}

function mysqlBizRecordRow(system, item, snapshotAtMs, index = 0) {
  const clean = item && typeof item === "object" ? item : {};
  const plate = String(clean.plate ?? "").trim();
  if (!plate) return null;
  const recordKey = String(clean.id ?? clean.record_id ?? `${clean.time_bj ?? nowBjText()}|${plate}|${clean.source ?? ""}|${index}|${clean.delta ?? clean.amount ?? clean.change ?? 0}`);
  return [
    system,
    recordKey,
    String(clean.time_bj ?? nowBjText()),
    plate,
    clean.source ?? null,
    Number.isFinite(Number(clean.delta ?? clean.amount ?? clean.change)) ? Number(clean.delta ?? clean.amount ?? clean.change) : null,
    Number.isFinite(Number(clean.balance)) ? Number(clean.balance) : null,
    Number.isFinite(Number(clean.arrears)) ? Number(clean.arrears) : null,
    clean.result ?? null,
    Number.isFinite(Number(snapshotAtMs)) ? Math.floor(Number(snapshotAtMs)) : Date.now(),
    dbJson(clean),
  ];
}

async function mysqlBulkInsertRows(conn, sql, rows, chunkSize = 400) {
  if (!conn || !Array.isArray(rows) || rows.length === 0) return;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    if (chunk.length) await conn.query(sql, [chunk]);
  }
}

async function mysqlSaveBusinessSnapshot(system, accounts, records, snapshotAtMs) {
  const pool = await ensureMysqlPool();
  if (!pool) return false;
  const sys = system === "etc" ? "etc" : "parking";
  const accRows = (Array.isArray(accounts) ? accounts : [])
    .map((item) => mysqlBizAccountRow(sys, item, snapshotAtMs))
    .filter(Boolean);
  const recRows = (Array.isArray(records) ? records : [])
    .map((item, idx) => mysqlBizRecordRow(sys, item, snapshotAtMs, idx))
    .filter(Boolean);
  let conn = null;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.query("DELETE FROM rk_business_accounts WHERE `system`=?", [sys]);
    await conn.query("DELETE FROM rk_business_records WHERE `system`=?", [sys]);
    if (accRows.length) {
      await mysqlBulkInsertRows(
        conn,
        `INSERT INTO rk_business_accounts
         (\`system\`,plate,balance,arrears,status,updated_at,snapshot_at_ms,raw_json)
         VALUES ?`,
        accRows,
      );
    }
    if (recRows.length) {
      await mysqlBulkInsertRows(
        conn,
        `INSERT INTO rk_business_records
         (\`system\`,record_key,time_bj,plate,source,delta,balance,arrears,result,snapshot_at_ms,raw_json)
         VALUES ?`,
        recRows,
      );
    }
    await conn.execute(
      `INSERT INTO rk_business_snapshots
       (\`system\`,snapshot_at_ms,accounts_count,records_count,raw_json)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
       snapshot_at_ms=VALUES(snapshot_at_ms), accounts_count=VALUES(accounts_count),
       records_count=VALUES(records_count), raw_json=VALUES(raw_json)`,
      [
        sys,
        Number.isFinite(Number(snapshotAtMs)) ? Math.floor(Number(snapshotAtMs)) : Date.now(),
        accRows.length,
        recRows.length,
        dbJson({ accounts_count: accRows.length, records_count: recRows.length }),
      ],
    );
    await conn.commit();
    mysqlState.last_ok_at = nowBjText();
    return true;
  } catch (e) {
    if (conn) {
      try {
        await conn.rollback();
      } catch {}
    }
    mysqlState.error = { code: e?.code || "mysql_save_business_failed", message: String(e?.message || e).slice(0, 500) };
    return false;
  } finally {
    if (conn) conn.release();
  }
}

async function mysqlClearBusinessSnapshot(system, snapshotAtMs = Date.now()) {
  const pool = await ensureMysqlPool();
  if (!pool) return false;
  const sys = system === "etc" ? "etc" : "parking";
  const clearedAtMs = Number.isFinite(Number(snapshotAtMs))
    ? Math.max(1, Math.floor(Number(snapshotAtMs)))
    : Date.now();
  let conn = null;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.query("DELETE FROM rk_business_accounts WHERE `system`=?", [sys]);
    await conn.query("DELETE FROM rk_business_records WHERE `system`=?", [sys]);
    await conn.execute(
      `INSERT INTO rk_business_snapshots
       (\`system\`,snapshot_at_ms,accounts_count,records_count,raw_json)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
       snapshot_at_ms=VALUES(snapshot_at_ms), accounts_count=0,
       records_count=0, raw_json=VALUES(raw_json)`,
      [sys, clearedAtMs, 0, 0, dbJson({ cleared: true, snapshot_at_ms: clearedAtMs })],
    );
    await conn.commit();
    mysqlState.last_ok_at = nowBjText();
    return true;
  } catch (e) {
    if (conn) {
      try {
        await conn.rollback();
      } catch {}
    }
    mysqlState.error = { code: e?.code || "mysql_clear_business_failed", message: String(e?.message || e).slice(0, 500) };
    return false;
  } finally {
    if (conn) conn.release();
  }
}

async function mysqlLoadBusinessSnapshot(system) {
  const pool = await ensureMysqlPool();
  if (!pool) return null;
  const sys = system === "etc" ? "etc" : "parking";
  try {
    const [accRows] = await pool.query(
      `SELECT plate,balance,arrears,status,updated_at,snapshot_at_ms,raw_json
       FROM rk_business_accounts
       WHERE \`system\`=?
       ORDER BY plate ASC`,
      [sys],
    );
    const [recRows] = await pool.query(
      `SELECT record_key,time_bj,plate,source,delta,balance,arrears,result,snapshot_at_ms,raw_json
       FROM rk_business_records
       WHERE \`system\`=?
       ORDER BY time_bj DESC, created_at DESC`,
      [sys],
    );
    const [snapRows] = await pool.query(
      "SELECT snapshot_at_ms,accounts_count,records_count FROM rk_business_snapshots WHERE `system`=? LIMIT 1",
      [sys],
    );
    const snap = snapRows?.[0] || null;
    const accounts = (Array.isArray(accRows) ? accRows : []).map((r) => {
      const raw = safeJsonParse(r.raw_json) || {};
      return {
        ...raw,
        plate: r.plate ?? raw.plate,
        balance: r.balance == null ? raw.balance ?? null : Number(r.balance),
        arrears: r.arrears == null ? raw.arrears ?? null : Number(r.arrears),
        status: r.status ?? raw.status,
        updated_at: r.updated_at ?? raw.updated_at,
        snapshot_at_ms: r.snapshot_at_ms == null ? raw.snapshot_at_ms ?? null : Number(r.snapshot_at_ms),
      };
    });
    const records = (Array.isArray(recRows) ? recRows : []).map((r) => {
      const raw = safeJsonParse(r.raw_json) || {};
      return {
        ...raw,
        record_key: r.record_key,
        time_bj: r.time_bj ?? raw.time_bj,
        plate: r.plate ?? raw.plate,
        source: r.source ?? raw.source,
        delta: r.delta == null ? raw.delta ?? null : Number(r.delta),
        balance: r.balance == null ? raw.balance ?? null : Number(r.balance),
        arrears: r.arrears == null ? raw.arrears ?? null : Number(r.arrears),
        result: r.result ?? raw.result,
        snapshot_at_ms: r.snapshot_at_ms == null ? raw.snapshot_at_ms ?? null : Number(r.snapshot_at_ms),
      };
    });
    const snapshotAtMs = businessSnapshotAtMs(snap?.snapshot_at_ms)
      || Math.max(
        0,
        ...accounts.map((a) => businessSnapshotAtMs(a.snapshot_at_ms)),
        ...records.map((r) => businessSnapshotAtMs(r.snapshot_at_ms)),
      )
      || null;
    mysqlState.last_ok_at = nowBjText();
    return {
      accounts,
      records,
      snapshot_at_ms: snapshotAtMs,
      has_snapshot: Boolean(snap),
      has_data: accounts.length > 0 || records.length > 0,
    };
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_load_business_failed", message: String(e?.message || e).slice(0, 500) };
    return null;
  }
}

async function mysqlListBusinessAccounts(system, q) {
  const pool = await ensureMysqlPool();
  if (!pool) return null;
  const sys = system === "etc" ? "etc" : "parking";
  try {
    const [rows] = await pool.query(
      `SELECT plate,balance,arrears,status,updated_at,snapshot_at_ms,raw_json
       FROM rk_business_accounts
       WHERE \`system\`=?
       ORDER BY plate ASC`,
      [sys],
    );
    const [snapRows] = await pool.query("SELECT snapshot_at_ms,accounts_count,records_count FROM rk_business_snapshots WHERE `system`=? LIMIT 1", [sys]);
    const snap = snapRows?.[0] || null;
    const allRows = Array.isArray(rows) ? rows : [];
    const plate = q.get("plate") ?? "";
    const status = q.get("status") ?? "";
    const limit = clamp(parseInt(q.get("limit") ?? "2000", 10), 1, 5000);
    const items = allRows
      .map((r) => {
        const raw = safeJsonParse(r.raw_json) || {};
        return {
          ...raw,
          plate: r.plate ?? raw.plate,
          balance: r.balance == null ? raw.balance ?? null : Number(r.balance),
          arrears: r.arrears == null ? raw.arrears ?? null : Number(r.arrears),
          status: r.status ?? raw.status,
          updated_at: r.updated_at ?? raw.updated_at,
          snapshot_at_ms: r.snapshot_at_ms == null ? raw.snapshot_at_ms ?? null : Number(r.snapshot_at_ms),
        };
      })
      .filter((a) => wildcardMatch(a.plate, plate))
      .filter((a) => (status ? String(a.status ?? "") === status : true));
    const total = items.length;
    const snapshotAtMs = Number(snap?.snapshot_at_ms) || allRows.reduce((max, r) => Math.max(max, Number(r.snapshot_at_ms) || 0), 0) || null;
    mysqlState.last_ok_at = nowBjText();
    return {
      total,
      items: items.slice(0, limit),
      snapshot_at_ms: snapshotAtMs,
      has_snapshot: Boolean(snap),
      has_data: allRows.length > 0,
    };
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_query_business_accounts_failed", message: String(e?.message || e).slice(0, 500) };
    return null;
  }
}

async function mysqlListBusinessRecords(system, q) {
  const pool = await ensureMysqlPool();
  if (!pool) return null;
  const sys = system === "etc" ? "etc" : "parking";
  try {
    const [rows] = await pool.query(
      `SELECT record_key,time_bj,plate,source,delta,balance,arrears,result,snapshot_at_ms,raw_json
       FROM rk_business_records
       WHERE \`system\`=?
       ORDER BY time_bj DESC, created_at DESC`,
      [sys],
    );
    const [snapRows] = await pool.query("SELECT snapshot_at_ms,accounts_count,records_count FROM rk_business_snapshots WHERE `system`=? LIMIT 1", [sys]);
    const snap = snapRows?.[0] || null;
    const allRows = Array.isArray(rows) ? rows : [];
    const plate = q.get("plate") ?? "";
    const start = q.get("start") ?? "";
    const end = q.get("end") ?? "";
    const result = q.get("result") ?? "";
    const limit = clamp(parseInt(q.get("limit") ?? "200", 10), 1, 5000);
    const items = allRows
      .map((r) => {
        const raw = safeJsonParse(r.raw_json) || {};
        return {
          ...raw,
          record_key: r.record_key,
          time_bj: r.time_bj ?? raw.time_bj,
          plate: r.plate ?? raw.plate,
          source: r.source ?? raw.source,
          delta: r.delta == null ? raw.delta ?? null : Number(r.delta),
          balance: r.balance == null ? raw.balance ?? null : Number(r.balance),
          arrears: r.arrears == null ? raw.arrears ?? null : Number(r.arrears),
          result: r.result ?? raw.result,
          snapshot_at_ms: r.snapshot_at_ms == null ? raw.snapshot_at_ms ?? null : Number(r.snapshot_at_ms),
        };
      })
      .filter((r) => wildcardMatch(r.plate, plate))
      .filter((r) => (result ? String(r.result ?? "") === result : true))
      .filter((r) => (start ? String(r.time_bj ?? "").slice(0, 10) >= start : true))
      .filter((r) => (end ? String(r.time_bj ?? "").slice(0, 10) <= end : true));
    const total = items.length;
    const snapshotAtMs = Number(snap?.snapshot_at_ms) || allRows.reduce((max, r) => Math.max(max, Number(r.snapshot_at_ms) || 0), 0) || null;
    mysqlState.last_ok_at = nowBjText();
    return {
      total,
      items: items.slice(0, limit),
      snapshot_at_ms: snapshotAtMs,
      has_snapshot: Boolean(snap),
      has_data: allRows.length > 0,
    };
  } catch (e) {
    mysqlState.error = { code: e?.code || "mysql_query_business_records_failed", message: String(e?.message || e).slice(0, 500) };
    return null;
  }
}

const apiState = {
  captureRunning: false,
  inferMode: "plate",
  view: "mosaic_raw",
};

ensureRkReportReceiptIndex();
const restoredRkStatusRecord = latestStoredRkStatusRecord();
const rkReported = {
  status: restoredRkStatusRecord?.status || null,
  statusAtMs: restoredRkStatusRecord?.saved_at_ms || 0,
  captureMetrics: [],
  plates: [],
  platesHydratedFromLog: false,
  previewJpeg: null,
  previewUpdatedAt: null,
  // Latest generic YOLO report for each physical 640x360 source. This is
  // intentionally memory-only: the browser needs the live result, not a
  // historical detection archive.
  detectionsBySource: {},
  // Road-model telemetry is separate from the legacy generic YOLO reports.
  // The latest record feeds the operator console; every accepted record is
  // also appended to rk_vision_realtime.jsonl.
  realtimeVision: null,
  realtimeVisionAtMs: 0,
  realtimeVisionCommandKey: "",
  realtimeVisionCommand: null,
  realtimeVisionLastAttemptKey: "",
  realtimeVisionLastAttemptAtMs: 0,
  violations: [],
  violationsHydratedFromLog: false,
  userMessages: [],
  peerIp: null,
  peerSeenAtMs: null,
  peerRkDeviceId: null,
  userMessageConfigSyncing: false,
  userMessageConfigSyncAtMs: 0,
  userMessageConfigSyncResult: null,
  userMessageConfigPull: null,
};

const rkCommandLoop = new ContinuousRkController({
  send: (action) => wifiCarBridge.sendAutoAction(action, { source: "rk_realtime_vision", frame_sequence: rkCommandLoop.meta?.frameSequence ?? null }),
  onCommand: (command, meta) => {
    rkReported.realtimeVisionCommand = command;
    if (command.ok === true) rkReported.realtimeVisionCommandKey = rkCommandLoop.desired.commandKey;
    if (rkReported.realtimeVision) {
      rkReported.realtimeVision.esp32_command = command;
      rkReported.realtimeVision.esp32_action = command.action;
    }
    if (command.state !== "sending") {
      if (command.ok === false) communicationLog.append({ channel: "system", transport: "WSS", status: "error",
        summary: `RK 控制请求未完成：${command.action} · ${command.error || "unknown"}`,
        command_id: command.id, frame_sequence: meta.frameSequence ?? null, action: command.action });
      appendDurableJsonLine(path.join(logRoot, "rk_vision_commands.jsonl"), {
        time_bj: nowBjText(), frame_sequence: meta.frameSequence || 0,
        mode: meta.mode || "off", requested_action: command.action, command,
      });
      console.info(`[RK_VISION_COMMAND] action=${command.action} state=${command.state} ok=${command.ok === true ? 1 : 0} repeat=${command.refresh_count} error=${command.error || "none"}`);
    }
  },
});
const rkCommandTimer = setInterval(() => rkCommandLoop.tick(), 100);
rkCommandTimer.unref?.();


if (rkReported.status) {
  apiState.captureRunning = rkReported.status.capture_running === true;
  apiState.inferMode = String(rkReported.status.infer_mode || apiState.inferMode);
  apiState.view = String(rkReported.status.view || apiState.view);
}
rkReported.userMessages = readJsonlAll(path.join(logRoot, "user_messages.jsonl"))
  .filter((item) => item && typeof item === "object")
  .slice(-500)
  .reverse();

const RK_PLATES_MAX = clamp(parseInt(process.env.RK_PLATES_MAX ?? "5000", 10) || 5000, 50, 20000);
const RK_VIOLATIONS_MAX = clamp(parseInt(process.env.RK_VIOLATIONS_MAX ?? "2000", 10) || 2000, 50, 20000);
const RK_CAPTURE_METRICS_MEMORY_MAX = clamp(parseInt(process.env.RK_CAPTURE_METRICS_MEMORY_MAX ?? "600", 10) || 600, 60, 5000);
const ESP32_ONLINE_MS = clamp(parseInt(process.env.ESP32_ONLINE_MS || "10000", 10) || 10000, 1000, 120000);
// RK status reports are delivered through the board's retry queue. Under
// NPU/PCIe load a report can occasionally arrive several seconds late even
// while capture and the board HTTP API remain healthy. Keep the online
// window long enough to cover that delivery jitter; the next report still
// refreshes the timestamp immediately.
const RK_ONLINE_TIMEOUT_MS = clamp(
  parseInt(process.env.RK_ONLINE_TIMEOUT_MS || "30000", 10) || 30000,
  8000,
  120000,
);
rkReported.plates = latestPlatesFromAudit().slice(0, RK_PLATES_MAX);
rkReported.violations = latestViolationsFromAudit().slice(0, RK_VIOLATIONS_MAX);
rkReported.platesHydratedFromLog = rkReported.plates.length > 0;
rkReported.violationsHydratedFromLog = rkReported.violations.length > 0;

async function deletePlateCaptureById(id) {
  const target = String(id || "").trim();
  if (!target) return { ok: false, error: "bad_id" };
  const memoryItem = (rkReported.plates || []).find((item) => String(item?.id || "") === target) || null;
  const auditItem = latestPlatesFromAudit().find((item) => String(item?.id || "") === target) || null;
  const dbPaths = await mysqlFindPlatePaths(target);
  const pathItem = memoryItem || auditItem || dbPaths || null;
  const before = Array.isArray(rkReported.plates) ? rkReported.plates.length : 0;
  rkReported.plates = (rkReported.plates || []).filter((item) => String(item?.id || "") !== target);
  const memoryRemoved = before - rkReported.plates.length;
  const logRemoved = ["plates.jsonl", "plates_audit.jsonl"].reduce((sum, name) => sum + removeJsonlRecordsById(name, target), 0);
  const dbRemoved = await mysqlDeletePlate(target);
  const filesRemoved = pathItem ? removeCaptureFiles({ ...pathItem, ...dbPaths }, "plate") : 0;
  const found = Boolean(memoryItem || auditItem || dbPaths || memoryRemoved || logRemoved || dbRemoved);
  return { ok: found, id: target, removed: found, memory_removed: memoryRemoved, log_removed: logRemoved, db_removed: dbRemoved === true, files_removed: filesRemoved };
}

async function deleteViolationCaptureById(id) {
  const target = String(id || "").trim();
  if (!target) return { ok: false, error: "bad_id" };
  const memoryItem = (rkReported.violations || []).find((item) => String(item?.id || "") === target) || null;
  const auditItem = latestViolationsFromAudit().find((item) => String(item?.id || "") === target) || null;
  const dbPaths = await mysqlFindViolationPaths(target);
  const pathItem = memoryItem || auditItem || dbPaths || null;
  const before = Array.isArray(rkReported.violations) ? rkReported.violations.length : 0;
  rkReported.violations = (rkReported.violations || []).filter((item) => String(item?.id || "") !== target);
  const memoryRemoved = before - rkReported.violations.length;
  const logRemoved = ["violations.jsonl", "violations_audit.jsonl", "violations_manual.jsonl"].reduce((sum, name) => sum + removeJsonlRecordsById(name, target), 0);
  const dbRemoved = await mysqlDeleteViolation(target);
  const filesRemoved = pathItem ? removeCaptureFiles({ ...pathItem, ...dbPaths }, "violation") : 0;
  const found = Boolean(memoryItem || auditItem || dbPaths || memoryRemoved || logRemoved || dbRemoved);
  return { ok: found, id: target, removed: found, memory_removed: memoryRemoved, log_removed: logRemoved, db_removed: dbRemoved === true, files_removed: filesRemoved };
}

const esp32State = {
  cfg: initialEsp32Config,
  device: "esp32-servo",
  device_id: cleanDeviceId(initialEsp32Config.device_id || process.env.ESP32_DEVICE_ID || "esp32-servo-01", "esp32-servo-01"),
  mac: String(initialEsp32Config.mac || process.env.ESP32_MAC || "").trim(),
  ip: "",
  port: 80,
  uptime_ms: null,
  servo_ready: null,
  last_seen_ms: 0,
  last_ping_ms: null,
  last_ping_at_ms: 0,
  last_error: "",
  last_response: null,
  servo_busy: false,
  last_servo_at_ms: 0,
  last_servo_result: null,
  command_poll_enabled: null,
  command_poll_ms: initialEsp32Config.command_poll_ms,
  last_command_id: "",
  last_command_state: "",
  last_command_result: null,
  last_command_at_ms: 0,
  commands: [],
  commandHistory: [],
  // Completed IDs are retained separately from the bounded history so a
  // deterministic RK gate command cannot be enqueued again after history
  // trimming or a process restart.
  completedCommandIds: new Set(),
  completedCommandMap: new Map(),
  // Command cancellations are journaled as tombstones.  This prevents a
  // queued command removed from memory (for example, a superseded gate-close)
  // from coming back after a process restart.
  cancelledCommandIds: new Set(),
  gates: {},
  gate: {
    enabled: Boolean(initialEsp32Config.gate_enabled),
    open: false,
    closing: false,
    close_due_ms: 0,
    timer: null,
    last_plate: "",
    last_plate_at_ms: 0,
    last_open_command_id: "",
    last_close_command_id: "",
    last_event: "",
    last_error: "",
    target_key: "",
    target_device_id: "",
    target_mac: "",
  },
};

let violationAiCfg = normalizeLlmConfig(loadLlmConfigFile().violation_ai, {
  provider: String(process.env.VIOLATION_LLM_PROVIDER || "deepseek").trim().toLowerCase(),
  base_url: String(process.env.VIOLATION_LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").trim(),
  model: String(process.env.VIOLATION_LLM_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-chat").trim(),
  api_key: String(process.env.VIOLATION_LLM_API_KEY || process.env.DEEPSEEK_API_KEY || "").trim(),
});

const violationAiState = {
  running: false,
  queue: [],
};

function pickViolationItemById(id) {
  return (rkReported.violations || []).find((x) => String(x?.id || "") === String(id || ""));
}

async function runViolationAiForItem(item) {
  const provider = violationAiCfg?.provider || "deepseek";
  const base_url = violationAiCfg?.base_url || "https://api.deepseek.com";
  const model = violationAiCfg?.model || "deepseek-chat";
  const api_key = String(violationAiCfg?.api_key || "").trim();
  if (!api_key) {
    return { state: "error", ok: false, violation: null, desc: "需人工确认", provider, model, error: "llm_api_key_missing" };
  }

  const timeoutMs = clamp(parseInt(process.env.VIOLATION_LLM_TIMEOUT_MS || "60000", 10) || 60000, 5000, 180000);
  const maxTokens = clamp(parseInt(process.env.VIOLATION_LLM_MAX_TOKENS || "220", 10) || 220, 64, 1200);
  const useThumb = String(process.env.VIOLATION_LLM_USE_THUMB || "1").trim() !== "0";
  let imgBuf = null;
  if (useThumb) {
    if (item?.thumbJpeg instanceof Buffer && item.thumbJpeg.length > 200) imgBuf = item.thumbJpeg;
    if (!imgBuf) imgBuf = readJpegFile(item?.thumb_path);
    if (!imgBuf) {
      const b64 = typeof item?.thumb_jpeg_base64 === "string" ? item.thumb_jpeg_base64.trim() : "";
      if (b64 && b64.length <= 250000 && /^[A-Za-z0-9+/=]+$/.test(b64)) {
        try {
          const b = Buffer.from(b64, "base64");
          if (b.length > 200) imgBuf = b;
        } catch {}
      }
    }
    if (imgBuf && imgBuf.length <= 200) imgBuf = null;
  }
  if (!imgBuf) {
    if (item?.imageJpeg instanceof Buffer && item.imageJpeg.length > 1000) imgBuf = item.imageJpeg;
    if (!imgBuf) imgBuf = readJpegFile(item?.image_path);
    if (imgBuf && imgBuf.length <= 1000) imgBuf = null;
  }
  if (!(imgBuf instanceof Buffer) || imgBuf.length < 200) {
    return { state: "error", ok: false, violation: null, desc: "需人工确认", provider, model, error: "bad_image" };
  }

  const img64 = imgBuf.toString("base64");
  const overlap_iou = Number(item?.overlap_iou ?? 0) || 0;
  const view_mode = Number(item?.view_mode ?? 0) || 0;
  const single_source = Number(item?.single_source ?? 0) || 0;
  const q0 = Number(item?.q0 ?? 0) || 0;
  const q1 = Number(item?.q1 ?? 0) || 0;
  const q2 = Number(item?.q2 ?? 0) || 0;
  const q3 = Number(item?.q3 ?? 0) || 0;

  const prompt = [
    "你是道路交通综合违规抓拍审核助手，不要只检查机动车。",
    "请根据图片判断是否存在道路交通违规或明显危险行为。",
    "违规对象包括但不限于：机动车、非机动车、行人、乘客以及道路设施相关行为。",
    "重点识别：机动车闯红灯、压线/逆行/占道、斑马线前不礼让行人、红灯或禁行状态下仍通行；行人闯红灯、横穿机动车道、翻越护栏/围栏、在车流中停留；非机动车闯红灯、逆行、占用机动车道等。",
    "如果画面中人员/车辆正常通行、车辆已让行、行人按信号灯和斑马线通行，或证据不足无法确认违规，应判定为 false。",
    "输出严格为 JSON：{\"violation\":true/false,\"desc\":\"...\"}。",
    "desc 为中文，50个字以内，描述主体和违规类型，例如“行人翻越护栏”“行人闯红灯过街”“车辆斑马线前未礼让行人”。",
  ].join("\n");
  const sys = "只输出JSON，不要多余文字。";
  const metaText = `RK环境检测命中目标；overlap_iou=${overlap_iou}；view_mode=${view_mode}；single_source=${single_source}；q0=${q0},q1=${q1},q2=${q2},q3=${q3}。`;

  const buildMessages = ({ withImage }) => {
    if (withImage) {
      return [
        { role: "system", content: sys },
        {
          role: "user",
          content: [
            { type: "text", text: `${prompt}\n${metaText}` },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${img64}`, detail: "low" } },
          ],
        },
      ];
    }
    return [
      { role: "system", content: sys },
      { role: "user", content: `${prompt}\n${metaText}` },
    ];
  };

  const doCall = async ({ withImage, withJsonFormat }) => {
    const messages = buildMessages({ withImage });
    return llmChat(messages, {
      timeout_ms: timeoutMs,
      temperature: 0.2,
      max_tokens: maxTokens,
      ...(withJsonFormat ? { response_format: { type: "json_object" } } : {}),
      provider,
      base_url,
      model,
      api_key,
    });
  };

  let resp = null;
  try {
    resp = await doCall({ withImage: true, withJsonFormat: true });
  } catch (e) {
    const msg = String(e?.message || e);
    const is400 = msg.includes("llm_http_400") || Number(e?.status) === 400;
    if (is400) {
      try {
        resp = await doCall({ withImage: true, withJsonFormat: false });
      } catch (e2) {
        const msg2 = String(e2?.message || e2);
        const is400b = msg2.includes("llm_http_400") || Number(e2?.status) === 400;
        if (is400b) {
          const hint = "model_or_payload_not_supported";
          const detail = e2?.body ? JSON.stringify(e2.body).slice(0, 500) : msg2;
          return { state: "error", ok: false, violation: null, desc: "需人工确认", provider, model, error: `${hint}: ${detail}` };
        }
        throw e2;
      }
    } else {
      throw e;
    }
  }

  const content = extractLlmResponseText(resp);
  if (!content) throw llmEmptyResponseError(resp);
  const j = extractJsonObject(content) || {};
  let v = null;
  const vRaw = j.violation;
  if (typeof vRaw === "boolean") v = vRaw;
  else if (typeof vRaw === "number" && Number.isFinite(vRaw)) v = vRaw !== 0;
  else if (typeof vRaw === "string") {
    const t = vRaw.trim().toLowerCase();
    if (["true", "1", "yes", "y", "是"].includes(t)) v = true;
    else if (["false", "0", "no", "n", "否"].includes(t)) v = false;
    else if (t.includes("不")) v = false;
    else if (t.includes("违")) v = true;
  }
  if (v == null) {
    if (content.includes("不违规") || content.includes("未违规") || content.includes("无违规")) v = false;
    else if (content.includes("违规")) v = true;
  }
  const desc = clampTextLen(j.desc || "", 50);
  return { state: "done", ok: true, violation: v, desc: desc || null, provider, model, error: null, raw: content };
}

async function violationAiLoopOnce() {
  if (violationAiState.running) return;
  violationAiState.running = true;
  try {
    while (violationAiState.queue.length) {
      const id = violationAiState.queue.shift();
      const it = pickViolationItemById(id);
      if (!it) continue;
      if (it?.ai?.state === "done") continue;
      it.ai = { ...(it.ai || {}), state: "pending", ok: false, error: null };
      try {
        const out = await runViolationAiForItem(it);
        it.ai = out;
        appendDurableJsonLine(path.join(logRoot, "violations.jsonl"), {
          ...dbViolationItem(it),
          ai: { ...out, raw: undefined },
        });
        appendDurableJsonLine(path.join(logRoot, "violations_audit.jsonl"), {
          event: "ai_done",
          id: it.id,
          time_bj: nowBjText(),
          ai: { ...out, raw: undefined },
        });
      } catch (e) {
        const msg = String(e?.message || e);
        it.ai = { state: "error", ok: false, violation: null, desc: "需人工确认", provider: violationAiCfg?.provider || "deepseek", model: violationAiCfg?.model || "deepseek-chat", error: msg };
        appendDurableJsonLine(path.join(logRoot, "violations_audit.jsonl"), {
          event: "ai_error",
          id: it.id,
          time_bj: nowBjText(),
          ai: it.ai,
        });
      }
      void mysqlSaveViolation(it);
    }
  } finally {
    violationAiState.running = false;
  }
}

function enqueueViolationAi(id) {
  const s = String(id || "");
  if (!s) return;
  if (!violationAiState.queue.includes(s)) violationAiState.queue.push(s);
  setTimeout(() => {
    violationAiLoopOnce().catch(() => {});
  }, 10);
}

for (const item of rkReported.violations) {
  if (item?.id && item?.ai?.state === "pending") enqueueViolationAi(item.id);
}

const modelDefaults = {
  yolo: String(process.env.MODEL_DEFAULT_YOLO || "").trim() || "plate_detect_mixed.rknn",
  ocr: String(process.env.MODEL_DEFAULT_OCR || "").trim() || "plate_rec_color.rknn",
};
const aiModelDefaultsPath = path.resolve(__dirname, "ai-model-defaults.json");

function readAiModelDefaultsConfig() {
  try {
    if (!fs.existsSync(aiModelDefaultsPath) || !fs.statSync(aiModelDefaultsPath).isFile()) return {};
    const cfg = JSON.parse(fs.readFileSync(aiModelDefaultsPath, "utf8"));
    return cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : {};
  } catch {
    return {};
  }
}

function writeAiModelDefaultsConfig(cfg) {
  const out = cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : {};
  out.schema = "rk3568.ai_model_defaults.v1";
  out.updated_at = nowBjText();
  const tmp = `${aiModelDefaultsPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), "utf8");
  fs.renameSync(tmp, aiModelDefaultsPath);
}

function normalizeModelPathItem(kind, fullPath, source) {
  const raw = String(fullPath || "").trim();
  if (!raw) return null;
  const norm = path.resolve(raw);
  let exists = false;
  try {
    exists = fs.existsSync(norm) && fs.statSync(norm).isFile();
  } catch {}
  return {
    file_name: path.basename(norm),
    dir: path.dirname(norm),
    full_path: norm,
    exists,
    source: source || "path",
  };
}

function resolveSavedDefaultModel(kind) {
  const cfg = readAiModelDefaultsConfig();
  const item = cfg?.models?.[kind] ?? cfg?.[kind];
  const fullPath = typeof item === "string" ? item : item?.full_path;
  return normalizeModelPathItem(kind, fullPath, "default_path");
}

function saveDefaultAiModelPath(kind, model) {
  if (!["yolo", "ocr"].includes(kind) || !model?.full_path) return null;
  const item = normalizeModelPathItem(kind, model.full_path, "default_path");
  if (!item?.exists) return null;
  const cfg = readAiModelDefaultsConfig();
  if (!cfg.models || typeof cfg.models !== "object" || Array.isArray(cfg.models)) cfg.models = {};
  cfg.models[kind] = {
    file_name: item.file_name,
    full_path: item.full_path,
    source: model.source || "path",
    updated_at: nowBjText(),
  };
  try {
    writeAiModelDefaultsConfig(cfg);
  } catch {
    return null;
  }
  return item;
}

function clearDefaultAiModelPath(kind) {
  const cfg = readAiModelDefaultsConfig();
  if (cfg.models && typeof cfg.models === "object") delete cfg.models[kind];
  if (Object.prototype.hasOwnProperty.call(cfg, kind)) delete cfg[kind];
  try {
    writeAiModelDefaultsConfig(cfg);
  } catch {}
}

function saveDefaultTtsModelPath(model) {
  if (!model?.full_path) return null;
  const item = normalizeModelPathItem("tts", model.full_path, model.source || "path");
  if (!item?.exists) return null;
  const cfg = readAiModelDefaultsConfig();
  if (!cfg.models || typeof cfg.models !== "object" || Array.isArray(cfg.models)) cfg.models = {};
  cfg.models.tts = {
    file_name: item.file_name,
    full_path: item.full_path,
    source: model.source || "path",
    updated_at: nowBjText(),
  };
  try {
    writeAiModelDefaultsConfig(cfg);
  } catch {
    return null;
  }
  return item;
}

function clearDefaultTtsModelPath() {
  const cfg = readAiModelDefaultsConfig();
  if (cfg.models && typeof cfg.models === "object") delete cfg.models.tts;
  if (Object.prototype.hasOwnProperty.call(cfg, "tts")) delete cfg.tts;
  try {
    writeAiModelDefaultsConfig(cfg);
  } catch {}
}

function modelPathExists(model) {
  if (!model?.full_path) return false;
  try {
    return fs.existsSync(model.full_path) && fs.statSync(model.full_path).isFile();
  } catch {
    return false;
  }
}

const ttsDefaults = {
  tts: String(process.env.TTS_DEFAULT_MODEL || "zh_CN-huayan-medium.onnx").trim() || "zh_CN-huayan-medium.onnx",
};

function resolveModelDir() {
  const envDir = String(process.env.RK3568_MODEL_DIR || "").trim();
  const cands = [];
  if (envDir) cands.push(envDir);
  cands.push(path.resolve(__dirname, "../../rk3568/app/model"));
  cands.push(path.resolve(__dirname, "../model"));
  cands.push(path.resolve(__dirname, "../models"));
  for (const d of cands) {
    try {
      if (fs.existsSync(d) && fs.statSync(d).isDirectory()) return d;
    } catch {}
  }
  return "";
}

function resolveDefaultModel(kind) {
  const saved = resolveSavedDefaultModel(kind);
  if (saved?.exists) return saved;
  const dir = resolveModelDir();
  if (!dir) return null;
  const fileName = modelDefaults[kind];
  if (!fileName) return null;
  if (kind === "ocr") {
    const envPath = String(process.env.OCR_DEFAULT_MODEL_PATH || process.env.MODEL_DEFAULT_OCR_PATH || "").trim();
    const cands = [];
    if (envPath) {
      if (path.isAbsolute(envPath)) cands.push(envPath);
      cands.push(path.resolve(__dirname, envPath));
      cands.push(path.join(dir, envPath));
      cands.push(path.join(uploadDir, envPath));
    }
    for (const p of cands) {
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          const full_path = path.resolve(p);
          return {
            file_name: path.basename(full_path),
            dir: path.dirname(full_path),
            full_path,
            exists: true,
          };
        }
      } catch {}
    }
    try {
      const list = fs.readdirSync(__dirname);
      const pickLatest = (exts) => {
        let best = null;
        for (const name of list) {
          const full = path.join(__dirname, name);
          const ext = fileExt(full);
          if (!exts.includes(ext)) continue;
          try {
            const st = fs.statSync(full);
            if (!st.isFile()) continue;
            const t = Number(st.mtimeMs || 0);
            if (!best || t > best.t) best = { full, t };
          } catch {}
        }
        return best?.full ? path.resolve(best.full) : "";
      };
      const oxnn = pickLatest([".oxnn"]);
      if (oxnn) return { file_name: path.basename(oxnn), dir: path.dirname(oxnn), full_path: oxnn, exists: true };
      const onnx = pickLatest([".onnx"]);
      if (onnx) return { file_name: path.basename(onnx), dir: path.dirname(onnx), full_path: onnx, exists: true };
    } catch {}
  }
  if (kind === "yolo") {
    const repo = findLocalYolov5Repo();
    if (repo) {
      const cand = path.resolve(repo, "weights/plate_detect.pt");
      try {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
          return { file_name: path.basename(cand), dir: path.dirname(cand), full_path: cand, exists: true };
        }
      } catch {}
    }
  }
  if (kind === "ocr") {
    const repo = findLocalYolov5Repo();
    if (repo) {
      const cand = path.resolve(repo, "weights/plate_rec_color.pth");
      try {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
          return { file_name: path.basename(cand), dir: path.dirname(cand), full_path: cand, exists: true };
        }
      } catch {}
    }
  }
  const full = path.join(dir, fileName);
  try {
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      return { file_name: fileName, dir, full_path: full, exists: true };
    }
  } catch {}
  return { file_name: fileName, dir, full_path: full, exists: false };
}

const aiState = {
  models: {
    yolo: null,
    ocr: null,
  },
  model_paths: {
    yolo: null,
    ocr: null,
  },
  ocr_charset: {
    file_name: null,
    full_path: null,
    uploaded_at: null,
    source: null,
  },
  last: null,
};

function aiActiveModel(kind) {
  const p = aiState.model_paths[kind];
  if (p && p.load_ok !== false && modelPathExists(p)) return p;
  const m = aiState.models[kind];
  if (m && m.load_ok !== false && modelPathExists(m)) return { ...m, source: "upload" };
  const r = resolveDefaultModel(kind);
  return r && r.exists ? { ...r, source: r.source || "default" } : null;
}

function aiReady() {
  return Boolean(aiActiveModel("yolo") && aiActiveModel("ocr"));
}

const ttsState = {
  model: null,
  model_path: null,
  last: null,
};

function resolveDefaultTtsModel() {
  const saved = resolveSavedDefaultModel("tts");
  if (saved?.exists) return saved;
  const envPath = String(process.env.TTS_DEFAULT_MODEL_PATH || "").trim();
  const modelDir = resolveModelDir();
  const bundledTtsPath = path.resolve(staticRoot, "tts-zh_en/tts-zh_en/voice-assistant-v3/voice-assistant/models/tts/zh_CN-huayan-medium.onnx");
  const cands = [];
  const addCand = (p) => {
    if (!p) return;
    cands.push(path.isAbsolute(p) ? p : path.resolve(__dirname, p));
    if (modelDir) cands.push(path.join(modelDir, p));
    cands.push(path.join(staticRoot, p));
    cands.push(path.join(staticRoot, "model", "tts", p));
    cands.push(path.join(uploadDir, p));
  };
  addCand(envPath);
  addCand(bundledTtsPath);
  addCand(ttsDefaults.tts);

  const dirs = [
    modelDir,
    path.resolve(staticRoot, "tts-zh_en/tts-zh_en/voice-assistant-v3/voice-assistant/models/tts"),
    path.resolve(staticRoot, "model", "tts"),
    path.resolve(staticRoot, "models", "tts"),
    path.resolve(staticRoot, "model"),
    path.resolve(staticRoot, "models"),
    uploadDir,
  ].filter(Boolean);

  for (const full of cands) {
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        const p = path.resolve(full);
        return { file_name: path.basename(p), dir: path.dirname(p), full_path: p, exists: true };
      }
    } catch {}
  }

  let best = null;
  const prefer = [".onnx", ".oxnn", ".pt", ".pth"];
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const ext = fileExt(full);
        if (!prefer.includes(ext)) continue;
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        const hasConfig = ext === ".onnx" || ext === ".oxnn" ? fs.existsSync(`${full}.json`) : true;
        const score = (hasConfig ? 100 : 0) + (prefer.length - prefer.indexOf(ext));
        const t = Number(st.mtimeMs || 0);
        if (!best || score > best.score || (score === best.score && t > best.t)) best = { full: path.resolve(full), score, t };
      }
    } catch {}
  }
  if (best?.full) return { file_name: path.basename(best.full), dir: path.dirname(best.full), full_path: best.full, exists: true };

  const fallbackDir = path.resolve(staticRoot, "model", "tts");
  const fallback = path.join(fallbackDir, ttsDefaults.tts);
  return { file_name: path.basename(fallback), dir: fallbackDir, full_path: fallback, exists: false };
}

function ttsActiveModel() {
  if (ttsState.model_path) return ttsState.model_path;
  if (ttsState.model) return { ...ttsState.model, source: "upload" };
  const r = resolveDefaultTtsModel();
  return r && r.exists ? { ...r, source: "default" } : null;
}

function ttsModelUsable(model) {
  if (!model?.full_path || !modelPathExists(model)) return false;
  const ext = fileExt(model.full_path);
  if (ext === ".onnx" || ext === ".oxnn") return ttsPiperConfigInfo(model)?.config_exists === true;
  if (ext === ".pt" || ext === ".pth") return true;
  if (ext === ".rknn") return true;
  return false;
}

function ttsReady() {
  return ttsModelUsable(ttsActiveModel());
}

function ttsRuntimeReady() {
  const runtime = activeTtsRuntimeCfg();
  if (runtime.provider === "siliconflow") return Boolean(activeSiliconflowTtsCfg().api_key);
  if (runtime.provider === "edge") return true;
  return ttsReady();
}

let siliconflowTtsCfg = normalizeSiliconflowTtsConfig(loadLlmConfigFile().tts_siliconflow, {
  ...siliconflowTtsDefaults,
  api_key: String(process.env.SILICONFLOW_API_KEY || "").trim(),
});
let edgeTtsCfg = normalizeEdgeTtsConfig(loadLlmConfigFile().tts_edge, edgeTtsDefaults);
let ttsRuntimeCfg = normalizeTtsRuntimeConfig(loadLlmConfigFile().tts_runtime, ttsRuntimeDefaults);

function activeSiliconflowTtsCfg() {
  return normalizeSiliconflowTtsConfig(siliconflowTtsCfg, siliconflowTtsDefaults);
}

function activeEdgeTtsCfg() {
  return normalizeEdgeTtsConfig(edgeTtsCfg, edgeTtsDefaults);
}

function activeTtsRuntimeCfg() {
  return normalizeTtsRuntimeConfig(ttsRuntimeCfg, ttsRuntimeDefaults);
}

async function requestEdgeTtsSpeech(text, cfgInput = {}, timeoutMs = 60000) {
  const s = String(text || "").trim();
  const cfg = normalizeEdgeTtsConfig(cfgInput, activeEdgeTtsCfg());
  if (!s) {
    const err = new Error("bad_text");
    err.code = "bad_text";
    throw err;
  }
  const timeout = clamp(parseInt(String(timeoutMs || "60000"), 10), 3000, 180000);
  const started = Date.now();
  let EdgeTTS = null;
  try {
    const mod = await import("@andresaya/edge-tts");
    EdgeTTS = mod?.EdgeTTS || mod?.default?.EdgeTTS || mod?.default;
  } catch (e) {
    e.code = "edge_tts_module_missing";
    throw e;
  }
  if (typeof EdgeTTS !== "function") {
    const err = new Error("edge_tts_class_missing");
    err.code = "edge_tts_class_missing";
    throw err;
  }
  const timer = new Promise((_, reject) => {
    setTimeout(() => {
      const err = new Error("edge_tts_timeout");
      err.code = "edge_tts_timeout";
      reject(err);
    }, timeout);
  });
  const options = {
    rate: cfg.rate,
    volume: cfg.volume,
    pitch: cfg.pitch,
    outputFormat: "audio-24khz-48kbitrate-mono-mp3",
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const readBufferedAudio = async (engine) => {
    let lastErr = null;
    for (let i = 0; i < 8; i += 1) {
      try {
        const out = engine.toBuffer();
        const outBuf = Buffer.isBuffer(out) ? out : Buffer.from(out || []);
        if (outBuf.length >= 10) return outBuf;
      } catch (e) {
        lastErr = e;
      }
      await wait(80 + i * 40);
    }
    throw lastErr || new Error("edge_tts_empty_audio");
  };
  const synthesizeOnce = async () => {
    const engine = new EdgeTTS();
    await engine.synthesize(s, cfg.voice, options);
    return readBufferedAudio(engine);
  };
  const synthesizeStreamOnce = async () => {
    const engine = new EdgeTTS();
    const chunks = [];
    for await (const chunk of engine.synthesizeStream(s, cfg.voice, options)) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || []);
      if (buf.length) chunks.push(buf);
    }
    return Buffer.concat(chunks);
  };
  const buffer = await Promise.race([
    (async () => {
      let lastErr = null;
      for (let i = 0; i < 2; i += 1) {
        try {
          return await synthesizeOnce();
        } catch (e) {
          lastErr = e;
          await wait(150 + i * 150);
        }
      }
      try {
        return await synthesizeStreamOnce();
      } catch (e) {
        throw lastErr || e;
      }
    })(),
    timer,
  ]);
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length < 10) {
    const err = new Error("edge_tts_empty_audio");
    err.code = "edge_tts_empty_audio";
    throw err;
  }
  return {
    buffer: buf,
    content_type: "audio/mpeg",
    cfg,
    duration_ms: Date.now() - started,
  };
}

function requestSiliconflowSpeech(text, cfgInput = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const s = String(text || "").trim();
    const cfg = normalizeSiliconflowTtsConfig(cfgInput, activeSiliconflowTtsCfg());
    if (!s) {
      const err = new Error("bad_text");
      err.code = "bad_text";
      reject(err);
      return;
    }
    if (!cfg.api_key) {
      const err = new Error("siliconflow_api_key_missing");
      err.code = "siliconflow_api_key_missing";
      reject(err);
      return;
    }
    const base = String(cfg.base_url || siliconflowTtsDefaults.base_url).replace(/\/+$/, "");
    const urlText = `${base}/v1/audio/speech`;
    const u = new URL(urlText);
    const body = JSON.stringify({
      model: cfg.model,
      input: s,
      voice: cfg.voice,
      response_format: cfg.response_format || "mp3",
      stream: true,
    });
    const req = https.request(
      {
        method: "POST",
        host: u.hostname,
        port: u.port || 443,
        path: u.pathname + (u.search || ""),
        timeout: clamp(parseInt(String(timeoutMs || "60000"), 10), 3000, 180000),
        headers: {
          Authorization: `Bearer ${cfg.api_key}`,
          "Content-Type": "application/json",
          Accept: "*/*",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on("data", (c) => {
          chunks.push(c);
          total += c.length;
          if (total > 30_000_000) {
            req.destroy(new Error("tts_audio_too_large"));
          }
        });
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(`siliconflow_http_${res.statusCode}`);
            err.code = `siliconflow_http_${res.statusCode}`;
            err.status = res.statusCode;
            err.body = buf.toString("utf8").slice(0, 1000);
            reject(err);
            return;
          }
          resolve({
            buffer: buf,
            content_type: res.headers["content-type"] || (cfg.response_format === "wav" ? "audio/wav" : "audio/mpeg"),
            cfg,
          });
        });
      },
    );
    req.on("error", (e) => reject(e));
    req.on("timeout", () => {
      try {
        req.destroy(new Error("siliconflow_timeout"));
      } catch {}
    });
    req.write(body);
    req.end();
  });
}

function requestSiliconflowTranscription(audioBuf, fileName = "voice.mp3", contentType = "audio/mpeg", cfgInput = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const buf = audioBuf instanceof Buffer ? audioBuf : Buffer.alloc(0);
    const cfg = normalizeSiliconflowTtsConfig(cfgInput, activeSiliconflowTtsCfg());
    const model = String(cfgInput?.asr_model || process.env.SILICONFLOW_ASR_MODEL || "FunAudioLLM/SenseVoiceSmall").trim();
    const apiKey = sanitizeLlmApiKey(cfgInput?.asr_api_key || cfgInput?.api_key || process.env.SILICONFLOW_ASR_API_KEY || cfg.api_key);
    if (buf.length < 10) {
      const err = new Error("bad_audio");
      err.code = "bad_audio";
      reject(err);
      return;
    }
    if (!apiKey) {
      const err = new Error("siliconflow_asr_api_key_missing");
      err.code = "siliconflow_asr_api_key_missing";
      reject(err);
      return;
    }
    const base = String(cfgInput?.base_url || process.env.SILICONFLOW_ASR_BASE_URL || cfg.base_url || siliconflowTtsDefaults.base_url).replace(/\/+$/, "");
    const u = new URL(`${base}/v1/audio/transcriptions`);
    const boundary = `----rkmini${Date.now()}${Math.random().toString(16).slice(2)}`;
    const safeName = sanitizeFileName(fileName || "voice.mp3");
    const parts = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`, "utf8"),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${contentType || "audio/mpeg"}\r\n\r\n`, "utf8"),
      buf,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ];
    const body = Buffer.concat(parts);
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.request(
      {
        method: "POST",
        host: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + (u.search || ""),
        timeout: clamp(parseInt(String(timeoutMs || "60000"), 10), 3000, 180000),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          Accept: "application/json",
          "Content-Length": body.length,
        },
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on("data", (c) => {
          chunks.push(c);
          total += c.length;
          if (total > 5_000_000) req.destroy(new Error("asr_response_too_large"));
        });
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {}
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(`siliconflow_asr_http_${res.statusCode}`);
            err.code = `siliconflow_asr_http_${res.statusCode}`;
            err.status = res.statusCode;
            err.body = json || raw.slice(0, 1000);
            reject(err);
            return;
          }
          const text = String(json?.text || json?.result || json?.data?.text || "").trim();
          resolve({ text, raw: json || raw, model, provider: "siliconflow" });
        });
      },
    );
    req.on("error", (e) => reject(e));
    req.on("timeout", () => {
      try {
        req.destroy(new Error("siliconflow_asr_timeout"));
      } catch {}
    });
    req.write(body);
    req.end();
  });
}

async function synthesizeTtsWavBase64(text, options = {}) {
  const s = String(text || "").trim();
  if (!s) return { available: false, reason: "bad_text" };
  const rawOptions = options && typeof options === "object" ? options : {};
  const runtimeCfg = activeTtsRuntimeCfg();
  const providerRaw = String(rawOptions.provider || rawOptions.tts_provider || runtimeCfg.provider || "").trim().toLowerCase();
  const provider = providerRaw === "local" || providerRaw === "piper" ? "local" : providerRaw === "edge" || providerRaw === "edge-tts" ? "edge" : providerRaw === "siliconflow" ? "siliconflow" : runtimeCfg.provider;
  if (provider === "siliconflow") {
    try {
      const r = await requestSiliconflowSpeech(s, rawOptions.siliconflow || rawOptions, rawOptions.timeout_ms);
      ttsState.last = {
        time_bj: nowBjText(),
        text_len: s.length,
        duration_ms: null,
        model: r.cfg.model,
        source: "siliconflow",
        backend: "siliconflow",
        voice: r.cfg.voice,
      };
      return {
        available: true,
        content_type: r.content_type,
        encoding: "base64",
        wav_base64: r.buffer.toString("base64"),
        text: s,
        model: r.cfg.model,
        backend: "siliconflow",
        voice: r.cfg.voice,
      };
    } catch (e) {
      return { available: false, reason: e?.code || "siliconflow_tts_failed", message: String(e?.body || e?.message || e), backend: "siliconflow" };
    }
  }
  if (provider === "edge") {
    try {
      const r = await requestEdgeTtsSpeech(s, rawOptions.edge || rawOptions, rawOptions.timeout_ms);
      ttsState.last = {
        time_bj: nowBjText(),
        text_len: s.length,
        duration_ms: r.duration_ms,
        model: "Microsoft Edge TTS",
        source: "edge",
        backend: "edge",
        voice: r.cfg.voice,
        rate: r.cfg.rate,
        volume: r.cfg.volume,
      };
      return {
        available: true,
        content_type: r.content_type,
        encoding: "base64",
        wav_base64: r.buffer.toString("base64"),
        text: s,
        model: "Microsoft Edge TTS",
        backend: "edge",
        voice: r.cfg.voice,
        rate: r.cfg.rate,
        volume: r.cfg.volume,
      };
    } catch (e) {
      return { available: false, reason: e?.code || "edge_tts_failed", message: String(e?.message || e), backend: "edge" };
    }
  }
  const active = ttsActiveModel();
  if (!active) return { available: false, reason: "model_not_loaded" };
  if (!ttsModelUsable(active)) {
    const piper = ttsPiperConfigInfo(active);
    return {
      available: false,
      reason: piper?.config_exists === false ? "tts_config_missing" : "tts_model_unusable",
      active: compactPathItem(active),
      piper,
    };
  }
  const body = options && typeof options === "object" ? { tts_options: options } : {};
  const ttsOptions = normalizeTtsOptions(body);
  const ext = fileExt(active.full_path);
  try {
    if (ext === ".onnx" || ext === ".oxnn" || ext === ".pt" || ext === ".pth") {
      const deps = ensurePythonTtsDeps(ext);
      if (!deps.ok) return { available: false, reason: deps.error || "deps_missing", message: deps.message };
      const r = await callAiPython({ op: "tts_speak", tts_path: active.full_path, text: s, tts_options: ttsOptions });
      if (!r?.ok || !r?.wav_base64) return { available: false, reason: r?.error || "tts_failed", message: r?.message };
      ttsState.last = { time_bj: nowBjText(), text_len: s.length, duration_ms: null, model: active.file_name, source: active.source, backend: r?.backend ?? null, tuning: ttsOptions.enabled ? ttsOptions : null };
      return {
        available: true,
        content_type: "audio/wav",
        encoding: "base64",
        wav_base64: String(r.wav_base64),
        text: s,
        model: active.file_name,
        backend: r?.backend ?? null,
      };
    }
    const seed = hash32(Buffer.from(s, "utf8"));
    const freq = 260 + (seed % 700);
    const durationMs = 300 + clamp(s.length * 60, 0, 1800);
    const wav = writeWavTone(freq, durationMs);
    ttsState.last = { time_bj: nowBjText(), text_len: s.length, duration_ms: durationMs, model: active.file_name, source: active.source, tuning: ttsOptions.enabled ? ttsOptions : null };
    return {
      available: true,
      content_type: "audio/wav",
      encoding: "base64",
      wav_base64: wav.toString("base64"),
      text: s,
      model: active.file_name,
      backend: "tone",
      duration_ms: durationMs,
    };
  } catch (e) {
    return { available: false, reason: "python_not_ready", message: String(e?.message || e), meta: e?.meta ?? aiPython.lastError ?? null };
  }
}

function ttsPiperConfigInfo(model) {
  const ext = fileExt(model?.full_path);
  if (!model?.full_path || (ext !== ".onnx" && ext !== ".oxnn")) return null;
  const configPath = `${model.full_path}.json`;
  const info = { config_path: configPath, config_exists: false };
  try {
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) return info;
    info.config_exists = true;
    const cfg = safeJsonParse(fs.readFileSync(configPath, "utf8")) || {};
    const audio = cfg.audio && typeof cfg.audio === "object" ? cfg.audio : {};
    const inference = cfg.inference && typeof cfg.inference === "object" ? cfg.inference : {};
    info.num_speakers = Number.isFinite(Number(cfg.num_speakers)) ? Number(cfg.num_speakers) : null;
    info.sample_rate = Number.isFinite(Number(audio.sample_rate)) ? Number(audio.sample_rate) : null;
    info.default_tuning = {
      length_scale: Number.isFinite(Number(inference.length_scale)) ? Number(inference.length_scale) : null,
      noise_scale: Number.isFinite(Number(inference.noise_scale)) ? Number(inference.noise_scale) : null,
      noise_w: Number.isFinite(Number(inference.noise_w)) ? Number(inference.noise_w) : null,
    };
  } catch (e) {
    info.config_error = String(e?.message || e);
  }
  return info;
}

function normalizeTtsOptions(body) {
  const src = body?.tts_options && typeof body.tts_options === "object" ? body.tts_options : body?.options && typeof body.options === "object" ? body.options : {};
  const enabled = src.enabled === true || src.enabled === 1 || src.enabled === "1" || src.enabled === "true";
  const out = { enabled };
  if (!enabled) return out;
  const speaker = parseNumber(src.speaker_id ?? src.speakerId);
  if (speaker !== null) out.speaker_id = Math.round(clamp(speaker, 0, 999));
  const lengthScale = parseNumber(src.length_scale ?? src.lengthScale);
  if (lengthScale !== null) out.length_scale = clamp(lengthScale, 0.5, 1.8);
  const noiseScale = parseNumber(src.noise_scale ?? src.noiseScale);
  if (noiseScale !== null) out.noise_scale = clamp(noiseScale, 0.1, 1.5);
  const noiseW = parseNumber(src.noise_w ?? src.noiseW);
  if (noiseW !== null) out.noise_w = clamp(noiseW, 0.1, 1.5);
  const silence = parseNumber(src.sentence_silence ?? src.sentenceSilence);
  if (silence !== null) out.sentence_silence = clamp(silence, 0, 5);
  return out;
}

function normalizeAiMode(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "yolo") return "yolo";
  if (s === "ocr") return "ocr";
  return "overlay";
}

function aiNeedYolo(mode) {
  return normalizeAiMode(mode) !== "ocr";
}

function aiNeedOcr(mode) {
  return normalizeAiMode(mode) !== "yolo";
}

function fileExt(p) {
  return String(path.extname(String(p || "")) || "").toLowerCase();
}

function aiModelUsable(kind, model) {
  if (!model?.full_path) return false;
  if (model.load_ok === false) return false;
  const ext = fileExt(model.full_path);
  if (aiPython.engine === "python") {
    if (kind === "yolo") return ext === ".pt" || ext === ".pth";
    if (kind === "ocr") return ext === ".onnx" || ext === ".oxnn" || ext === ".pt" || ext === ".pth";
  }
  return true;
}

function aiReadyForMode(mode) {
  const needYolo = aiNeedYolo(mode);
  const needOcr = aiNeedOcr(mode);
  const yolo = aiActiveModel("yolo");
  const ocr = aiActiveModel("ocr");
  const yoloOk = needYolo ? Boolean(yolo && aiModelUsable("yolo", yolo)) : true;
  const ocrOk = needOcr ? Boolean(ocr && aiModelUsable("ocr", ocr) && (resolveOcrCharsetPath(ocr) || fileExt(ocr?.full_path) === ".pth" || fileExt(ocr?.full_path) === ".pt")) : true;
  return Boolean(yoloOk && ocrOk);
}

const uploadDir = path.resolve(__dirname, "uploads");
function ensureUploadDir() {
  try {
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  } catch {}
}

function safeJsonParse(text) {
  try {
    if (Buffer.isBuffer(text)) text = text.toString("utf8");
    if (typeof text === "string") text = text.replace(/^\uFEFF/, "").trim();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const aiPython = {
  proc: null,
  buf: "",
  pending: new Map(),
  nextId: 1,
  starting: false,
  lastError: null,
  engine: String(process.env.AI_ENGINE || "python").trim().toLowerCase() === "fake" ? "fake" : "python",
};

function aiPythonScriptPath() {
  return path.resolve(__dirname, "py/ai_worker.py");
}

function aiPythonReqPath() {
  return path.resolve(__dirname, "py/requirements.txt");
}

function pythonCmd() {
  const envCmd = String(process.env.PYTHON || "").trim();
  if (envCmd) return envCmd;
  const localBin = process.platform === "win32"
    ? path.resolve(__dirname, ".venv/Scripts/python.exe")
    : path.resolve(__dirname, ".venv/bin/python");
  try {
    if (fs.existsSync(localBin) && fs.statSync(localBin).isFile()) return localBin;
  } catch {}
  if (process.platform !== "win32") {
    const py3 = runSyncSimple("python3", ["--version"]);
    if (py3.ok) return "python3";
  }
  return "python";
}

function pythonEnv() {
  const env = { ...process.env };
  if (!String(env.YOLO_CONFIG_DIR || "").trim()) {
    const configDir = path.join(uploadDir, "ultralytics");
    try {
      fs.mkdirSync(configDir, { recursive: true });
    } catch {}
    env.YOLO_CONFIG_DIR = configDir;
  }
  return env;
}

function runSync(cmd, args) {
  try {
    const r = childProcess.spawnSync(cmd, args, { encoding: "utf8", env: pythonEnv() });
    return { ok: r.status === 0, status: r.status ?? -1, out: r.stdout || "", err: r.stderr || "" };
  } catch (e) {
    return { ok: false, status: -1, out: "", err: String(e?.message || e) };
  }
}

function runSyncSimple(cmd, args) {
  try {
    const r = childProcess.spawnSync(cmd, args, { encoding: "utf8" });
    return { ok: r.status === 0, status: r.status ?? -1, out: r.stdout || "", err: r.stderr || "" };
  } catch (e) {
    return { ok: false, status: -1, out: "", err: String(e?.message || e) };
  }
}

function summarizeCmdResult(r, max = 800) {
  const text = [r?.out, r?.err].filter(Boolean).join("\n").trim();
  return text ? text.slice(0, max) : "";
}

function pythonDepsStatus() {
  const cmd = pythonCmd();
  const version = runSync(cmd, ["--version"]);
  const pip = runSync(cmd, ["-m", "pip", "--version"]);
  const modules = ["ultralytics", "cv2", "numpy", "torch", "onnxruntime", "piper", "pypinyin"];
  const code = [
    "import importlib.util, json",
    `mods=${JSON.stringify(modules)}`,
    "print(json.dumps({m: bool(importlib.util.find_spec(m)) for m in mods}))",
  ].join("; ");
  const check = runSync(cmd, ["-c", code]);
  let found = {};
  try {
    found = JSON.parse(String(check.out || "").trim());
  } catch {}
  const missing = modules.filter((m) => found[m] !== true);
  return {
    command: cmd,
    version_ok: Boolean(version.ok),
    version: summarizeCmdResult(version, 200),
    pip_ok: Boolean(pip.ok),
    pip: summarizeCmdResult(pip, 300),
    modules: found,
    missing,
    ready: missing.length === 0,
    check_error: check.ok ? null : summarizeCmdResult(check),
  };
}

let pythonDepsCache = { at: 0, status: null };

function cachedPythonDepsStatus(maxAgeMs = 10000) {
  const now = Date.now();
  if (pythonDepsCache.status && now - pythonDepsCache.at < maxAgeMs) return pythonDepsCache.status;
  const status = pythonDepsStatus();
  pythonDepsCache = { at: now, status };
  return status;
}

function ensurePythonDeps() {
  const check = runSync(pythonCmd(), ["-c", "import ultralytics,cv2,numpy,torch,onnxruntime; print('ok')"]);
  if (check.ok) return { ok: true };
  if (String(process.env.AI_AUTO_PIP || "1") !== "1") {
    return { ok: false, error: "deps_missing", message: check.err || check.out || "deps missing" };
  }
  const req = aiPythonReqPath();
  const pip = runSync(pythonCmd(), ["-m", "pip", "install", "-r", req]);
  if (!pip.ok) return { ok: false, error: "pip_failed", message: pip.err || pip.out || "pip failed", python: cachedPythonDepsStatus(0) };
  const check2 = runSync(pythonCmd(), ["-c", "import ultralytics,cv2,numpy,torch,onnxruntime; print('ok')"]);
  return check2.ok ? { ok: true } : { ok: false, error: "deps_missing", message: check2.err || check2.out || "deps missing", python: cachedPythonDepsStatus(0) };
}

function ensurePythonTtsDeps(ext) {
  const auto = String(process.env.AI_AUTO_PIP || "1") === "1";
  const req = aiPythonReqPath();
  const checkCode =
    ext === ".onnx" || ext === ".oxnn"
      ? "from piper.voice import PiperVoice; import onnxruntime,numpy; print('ok')"
      : ext === ".pt" || ext === ".pth"
        ? "import torch,numpy; print('ok')"
        : "print('ok')";
  const check = runSync(pythonCmd(), ["-c", checkCode]);
  if (check.ok) return { ok: true };
  if (!auto) return { ok: false, error: "deps_missing", message: check.err || check.out || "deps missing" };
  const pip = runSync(pythonCmd(), ["-m", "pip", "install", "-r", req]);
  if (!pip.ok) return { ok: false, error: "pip_failed", message: pip.err || pip.out || "pip failed", python: cachedPythonDepsStatus(0) };
  const check2 = runSync(pythonCmd(), ["-c", checkCode]);
  return check2.ok ? { ok: true } : { ok: false, error: "deps_missing", message: check2.err || check2.out || "deps missing", python: cachedPythonDepsStatus(0) };
}

function dirHasFile(dir, relPath) {
  try {
    const p = path.resolve(dir, relPath);
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findLocalYolov5Repo() {
  const home = os.homedir();
  const torchHome = String(process.env.TORCH_HOME || "").trim();
  const cands = [
    String(process.env.YOLOV5_REPO || "").trim(),
    path.resolve(__dirname, "vendor/Chinese_license_plate_detection_recognition-main"),
    torchHome ? path.resolve(torchHome, "hub/ultralytics_yolov5_master") : "",
    home ? path.resolve(home, ".cache/torch/hub/ultralytics_yolov5_master") : "",
    path.resolve(__dirname, "../../http/Chinese_license_plate_detection_recognition-main (2)/Chinese_license_plate_detection_recognition-main"),
    path.resolve(__dirname, "../../HTTP/Chinese_license_plate_detection_recognition-main (2)/Chinese_license_plate_detection_recognition-main"),
    path.resolve(__dirname, "../../http/Chinese_license_plate_detection_recognition-main/Chinese_license_plate_detection_recognition-main"),
    path.resolve(__dirname, "../../HTTP/Chinese_license_plate_detection_recognition-main/Chinese_license_plate_detection_recognition-main"),
  ];
  for (const d of cands) {
    if (!d) continue;
    if (dirHasFile(d, "hubconf.py") && dirHasFile(d, "models/common.py")) return d;
  }
  return "";
}

function startAiPython() {
  if (aiPython.engine !== "python") return;
  if (aiPython.proc || aiPython.starting) return;
  aiPython.starting = true;
  const deps = ensurePythonDeps();
  if (!deps.ok) {
    aiPython.engine = "fake";
    aiPython.lastError = deps;
    aiPython.starting = false;
    return;
  }

  const env = pythonEnv();
  if (!String(env.YOLOV5_REPO || "").trim()) {
    const localRepo = findLocalYolov5Repo();
    if (localRepo) env.YOLOV5_REPO = localRepo;
  }
  const p = childProcess.spawn(pythonCmd(), [aiPythonScriptPath()], { stdio: ["pipe", "pipe", "pipe"], env });
  aiPython.proc = p;
  aiPython.buf = "";
  aiPython.engine = "python";
  aiPython.lastError = null;

  const pythonFail = (meta) => {
    aiPython.proc = null;
    aiPython.lastError = meta;
    Array.from(aiPython.pending.values()).forEach((it) => {
      clearTimeout(it.t);
      it.reject(new Error("python_exit"));
    });
    aiPython.pending.clear();
  };

  const onLine = (line) => {
    const j = safeJsonParse(line);
    if (!j) return;
    const id = j?.id;
    if (id && aiPython.pending.has(id)) {
      const it = aiPython.pending.get(id);
      aiPython.pending.delete(id);
      clearTimeout(it.t);
      it.resolve(j);
    }
  };

  p.stdout.on("data", (c) => {
    aiPython.buf += String(c || "");
    while (true) {
      const i = aiPython.buf.indexOf("\n");
      if (i < 0) break;
      const line = aiPython.buf.slice(0, i).trim();
      aiPython.buf = aiPython.buf.slice(i + 1);
      if (line) onLine(line);
    }
  });

  p.stderr.on("data", (c) => {
    const s = String(c || "").trim();
    if (s) aiPython.lastError = { ok: false, error: "python_stderr", message: s };
  });

  p.stdin.on("error", (e) => {
    const meta = { ok: false, error: "python_stdin", message: String(e?.message || e) };
    pythonFail(meta);
    try {
      p.kill("SIGTERM");
    } catch {}
  });

  p.on("exit", (code) => {
    pythonFail({ ok: false, error: "python_exit", code });
  });

  aiPython.starting = false;
}

function callAiPython(payload) {
  startAiPython();
  if (!aiPython.proc) {
    const e = new Error("python_not_ready");
    e.meta = aiPython.lastError;
    return Promise.reject(e);
  }
  const id = String(aiPython.nextId++);
  const msg = JSON.stringify({ id, ...payload }) + "\n";
  return new Promise((resolve, reject) => {
    const timeoutMs = clamp(parseInt(String(process.env.AI_PYTHON_TIMEOUT_MS || (payload?.op === "infer" ? "60000" : "120000")), 10), 5000, 300000);
    const t = setTimeout(() => {
      aiPython.pending.delete(id);
      reject(new Error("python_timeout"));
    }, timeoutMs);
    aiPython.pending.set(id, { resolve, reject, t });
    try {
      aiPython.proc.stdin.write(msg);
    } catch (e) {
      clearTimeout(t);
      aiPython.pending.delete(id);
      reject(e);
    }
  });
}

async function validateAiModelsPartial(kind, fullPath) {
  if (aiPython.engine !== "python") return { ok: true, engine: "fake" };
  try {
    const mode = kind === "yolo" ? "yolo" : "ocr";
    const activeYolo = kind === "yolo" ? { full_path: fullPath } : null;
    const activeOcr = kind === "ocr" ? { full_path: fullPath } : null;
    const charsetPath = kind === "ocr" ? resolveOcrCharsetPath(activeOcr) : "";
    const r = await callAiPython({
      op: "load",
      mode,
      yolo_path: activeYolo?.full_path ?? "",
      ocr_path: activeOcr?.full_path ?? "",
      ocr_charset_path: charsetPath,
    });
    return r?.ok ? { ok: true, yolo_backend: r?.yolo_backend ?? null } : { ok: false, error: r?.error, message: r?.message };
  } catch (e) {
    return { ok: false, error: "python_not_ready", meta: e?.meta ?? aiPython.lastError ?? null };
  }
}

function resolveUserModelPath(kind, inputPath) {
  const raw = String(inputPath || "").trim();
  if (!raw) return null;
  const dir = resolveModelDir();
  const full = path.isAbsolute(raw) ? raw : dir ? path.join(dir, raw) : raw;
  const norm = path.resolve(full);
  try {
    if (fs.existsSync(norm) && fs.statSync(norm).isFile()) {
      return { file_name: path.basename(norm), full_path: norm, exists: true, source: "path" };
    }
  } catch {}
  return { file_name: path.basename(norm), full_path: norm, exists: false, source: "path" };
}

function resolveOcrCharsetPath(activeOcr) {
  const envP = String(process.env.OCR_CHARSET_PATH || "").trim();
  const cands = [];
  if (envP) cands.push(envP);
  if (aiState.ocr_charset?.full_path) cands.push(aiState.ocr_charset.full_path);
  cands.push(path.resolve(__dirname, "py/plate_charset.txt"));
  const ocrPath = activeOcr?.full_path;
  if (ocrPath) {
    const ext = fileExt(ocrPath);
    if (ext === ".pth" || ext === ".pt") return "";
  }
  if (ocrPath) {
    const dir = path.dirname(ocrPath);
    cands.push(path.join(dir, "charset.txt"));
    cands.push(path.join(dir, "keys.txt"));
    cands.push(path.join(dir, "ppocr_keys_v1.txt"));
  }
  const modelDir = resolveModelDir();
  if (modelDir) {
    cands.push(path.join(modelDir, "charset.txt"));
    cands.push(path.join(modelDir, "keys.txt"));
    cands.push(path.join(modelDir, "ppocr_keys_v1.txt"));
  }
  for (const p of cands) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return path.resolve(p);
    } catch {}
  }
  return "";
}

function writeWavTone(freqHz, durationMs) {
  const sr = 22050;
  const dur = clamp(Number(durationMs) || 600, 150, 2500);
  const freq = clamp(Number(freqHz) || 440, 120, 1200);
  const samples = Math.floor((sr * dur) / 1000);
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sr;
    const a = Math.sin(2 * Math.PI * freq * t);
    const env = i < sr * 0.02 ? i / (sr * 0.02) : i > samples - sr * 0.05 ? (samples - i) / (sr * 0.05) : 1;
    const v = Math.round(a * env * 0.4 * 32767);
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

function hash32(buf) {
  let h = 2166136261;
  for (let i = 0; i < buf.length; i += 1) {
    h ^= buf[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function fakeDetections(width, height, seed) {
  const w = Math.max(2, Number(width) || 0);
  const h = Math.max(2, Number(height) || 0);
  const n = 1 + (seed % 2);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const s = (seed + i * 9973) >>> 0;
    const bw = Math.round((0.28 + ((s % 1000) / 1000) * 0.18) * w);
    const bh = Math.round(bw * 0.28);
    const x1 = Math.round(((s >>> 8) % Math.max(1, w - bw)) || 0);
    const y1 = Math.round(((s >>> 16) % Math.max(1, h - bh)) || 0);
    out.push({
      cls: "plate",
      score: Number((0.78 + ((s % 1000) / 1000) * 0.18).toFixed(3)),
      x1,
      y1,
      x2: x1 + bw,
      y2: y1 + bh,
    });
  }
  return out;
}

function fakeOcr(seed) {
  const a = (seed % 9000) + 1000;
  const text = `YB${a}`;
  const score = Number((0.72 + ((seed % 1000) / 1000) * 0.25).toFixed(3));
  return { text, score };
}

function seedAccounts(system) {
  const plates =
    system === "parking"
      ? ["粤B12345", "京A88888", "沪C55667", "浙A19999", "川A22334"]
      : ["粤B88990", "京A13579", "沪C24680", "浙A88889", "川A33445"];
  const map = new Map();
  plates.forEach((plate, i) => {
    map.set(plate, {
      plate,
      balance: 50 + i * 10,
      arrears: i % 3 === 0 ? 0 : i % 3 === 1 ? 5 : 12,
      status: "active",
      updated_at: nowBjText(),
    });
  });
  return map;
}

function seedRecords(system, accounts) {
  const arr = [];
  Array.from(accounts.values()).forEach((acc, idx) => {
    arr.push({
      id: randomUUID(),
      time_bj: nowBjText(),
      plate: acc.plate,
      source: `src${(idx % 4) + 1}`,
      delta: system === "parking" ? -2.5 : -3.0,
      balance: acc.balance,
      arrears: acc.arrears,
      result: "ok",
    });
  });
  return arr;
}

const DEMO_BIZ = String(process.env.DEMO_BIZ || "").trim() === "1";
const DEMO_PLATES = String(process.env.DEMO_PLATES || "").trim() === "1";
const DEMO_VIOLATIONS = String(process.env.DEMO_VIOLATIONS || "").trim() === "1";
function makeBizStore(system) {
  const accounts = DEMO_BIZ ? seedAccounts(system) : new Map();
  const records = DEMO_BIZ ? seedRecords(system, accounts) : [];
  return { accounts, records };
}
const biz = {
  parking: makeBizStore("parking"),
  etc: makeBizStore("etc"),
};

const rkBizReported = {
  parking: { accounts: [], records: [], updatedAt: null, report: null },
  etc: { accounts: [], records: [], updatedAt: null, report: null },
};

function businessSnapshotAtMs(value) {
  const at = Number(value);
  return Number.isFinite(at) && at > 0 ? Math.floor(at) : 0;
}

function rkBizHasSnapshot(system) {
  return businessSnapshotAtMs(rkBizReported[system]?.updatedAt) > 0;
}

function mysqlBusinessSnapshotAvailable(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  return snapshot.has_snapshot === true
    || snapshot.has_data === true
    || businessSnapshotAtMs(snapshot.snapshot_at_ms) > 0
    || (Array.isArray(snapshot.accounts) && snapshot.accounts.length > 0)
    || (Array.isArray(snapshot.records) && snapshot.records.length > 0);
}

function selectBusinessSnapshotSource(system, mysqlSnapshot) {
  const rkAt = businessSnapshotAtMs(rkBizReported[system]?.updatedAt);
  const mysqlAt = businessSnapshotAtMs(mysqlSnapshot?.snapshot_at_ms);
  const rkAvailable = rkBizHasSnapshot(system);
  const mysqlAvailable = mysqlBusinessSnapshotAvailable(mysqlSnapshot);
  if (mysqlAvailable && (!rkAvailable || mysqlAt >= rkAt)) return "mysql";
  if (rkAvailable) return "rk";
  return mysqlAvailable ? "mysql" : "";
}

function applyMysqlBusinessSnapshotIfCurrent(system, snapshot) {
  if (selectBusinessSnapshotSource(system, snapshot) !== "mysql") return false;
  const at = businessSnapshotAtMs(snapshot?.snapshot_at_ms);
  if (!at) return false;
  rkBizReported[system].accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
  rkBizReported[system].records = Array.isArray(snapshot.records) ? snapshot.records : [];
  rkBizReported[system].updatedAt = at;
  return true;
}

function rkBizIsActive(system) {
  const st = rkBizReported[system];
  if (!st) return false;
  const t = Number(st.updatedAt);
  if (!Number.isFinite(t) || t <= 0) return false;
  return Date.now() - t <= 10 * 60 * 1000;
}

try {
  const p = path.join(logRoot, "business_latest.json");
  if (fs.existsSync(p)) {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    ["parking", "etc"].forEach((system) => {
      const s = j?.[system];
      if (!s || typeof s !== "object") return;
      rkBizReported[system].accounts = Array.isArray(s.accounts) ? s.accounts : [];
      rkBizReported[system].records = Array.isArray(s.records) ? s.records : [];
      rkBizReported[system].updatedAt = businessSnapshotAtMs(s.snapshot_at_ms ?? s.updatedAt) || null;
      rkBizReported[system].report = s.report && typeof s.report === "object" && !Array.isArray(s.report) ? s.report : null;
    });
  }
} catch {}

function listAccounts(system, q) {
  const store = biz[system];
  if (!store) return [];
  const plate = q.get("plate") ?? "";
  const status = q.get("status") ?? "";
  let items = Array.from(store.accounts.values());
  items = items.filter((a) => wildcardMatch(a.plate, plate));
  if (status) items = items.filter((a) => a.status === status);
  items.sort((a, b) => a.plate.localeCompare(b.plate));
  return items;
}

function listRecords(system, q) {
  const store = biz[system];
  if (!store) return [];
  const plate = q.get("plate") ?? "";
  const start = q.get("start") ?? "";
  const end = q.get("end") ?? "";
  const result = q.get("result") ?? "";
  let items = store.records.slice();
  if (plate) items = items.filter((r) => wildcardMatch(r.plate, plate));
  if (result) items = items.filter((r) => r.result === result);
  if (start) items = items.filter((r) => String(r.time_bj ?? "").slice(0, 10) >= start);
  if (end) items = items.filter((r) => String(r.time_bj ?? "").slice(0, 10) <= end);
  items.sort((a, b) => String(b.time_bj).localeCompare(String(a.time_bj)));
  const limit = clamp(parseInt(q.get("limit") ?? "200", 10), 1, 2000);
  return items.slice(0, limit);
}

function ensureAccount(system, plate) {
  const store = biz[system];
  if (!store) return null;
  const p = String(plate ?? "").trim();
  if (!p) return null;
  let acc = store.accounts.get(p);
  if (!acc) {
    acc = { plate: p, balance: 0, arrears: 0, status: "active", updated_at: nowBjText() };
    store.accounts.set(p, acc);
  }
  return acc;
}

function pushRecord(system, rec) {
  const store = biz[system];
  if (!store) return;
  store.records.unshift(rec);
  if (store.records.length > 5000) store.records.length = 5000;
}

function settleBusinessArrears(acc) {
  if (!acc || Number(acc.arrears || 0) <= 0 || Number(acc.balance || 0) <= 0) return 0;
  const paid = Math.min(Number(acc.arrears || 0), Number(acc.balance || 0));
  acc.balance = bizRound2(Number(acc.balance || 0) - paid);
  acc.arrears = bizRound2(Number(acc.arrears || 0) - paid);
  return bizRound2(paid);
}

async function hydrateLocalBusinessStore(system) {
  const sys = system === "etc" ? "etc" : "parking";
  const store = biz[sys];
  if (!store) return false;
  const db = await mysqlLoadBusinessSnapshot(sys);
  const rk = rkBizReported[sys];
  const selected = selectBusinessSnapshotSource(sys, db);
  const src = selected === "mysql" ? db : selected === "rk" ? rk : null;
  if (!src) return false;
  const accounts = Array.isArray(src.accounts) ? src.accounts : [];
  const records = Array.isArray(src.records) ? src.records : [];
  store.accounts.clear();
  for (const item of accounts) {
    const plate = String(item?.plate ?? "").trim();
    if (!plate) continue;
    store.accounts.set(plate, {
      plate,
      balance: bizRound2(item?.balance ?? 0),
      arrears: bizRound2(item?.arrears ?? 0),
      status: String(item?.status ?? "active"),
      updated_at: String(item?.updated_at ?? item?.time_bj ?? nowBjText()),
    });
  }
  store.records = records.slice(0, 5000).map((r) => ({
    id: String(r?.id ?? r?.record_key ?? randomUUID()),
    time_bj: String(r?.time_bj ?? nowBjText()),
    plate: String(r?.plate ?? "").trim(),
    source: String(r?.source ?? ""),
    delta: bizRound2(r?.delta ?? r?.amount ?? r?.change ?? 0),
    balance: bizRound2(r?.balance ?? 0),
    arrears: bizRound2(r?.arrears ?? 0),
    result: String(r?.result ?? ""),
  })).filter((r) => r.plate);
  return true;
}

async function persistLocalBusinessStore(system, op, record = null) {
  const sys = system === "etc" ? "etc" : "parking";
  const store = biz[sys];
  if (!store) return false;
  const snapshotAtMs = Date.now();
  const snap = bizSnapshotFromStore(sys);
  rkBizReported[sys].accounts = snap.accounts;
  rkBizReported[sys].records = snap.records;
  rkBizReported[sys].updatedAt = snapshotAtMs;
  await mysqlSaveBusinessSnapshot(sys, snap.accounts, snap.records, snapshotAtMs);
  writeBizLatestSnapshot();
  appendJsonLine("business_events.jsonl", {
    time_bj: nowBjText(),
    system: sys,
    op,
    via: "local",
    accounts: snap.accounts.length,
    records: snap.records.length,
    ...(record ? { plate: record.plate, delta: record.delta, balance: record.balance, result: record.result } : {}),
  });
  return true;
}

async function applyLocalBusinessOp(system, op, { plate, amount = null } = {}) {
  const sys = system === "etc" ? "etc" : "parking";
  const p = String(plate ?? "").trim();
  if (!p) return { ok: false, error: "bad_plate" };
  const amt = amount === null || amount === undefined || amount === "" ? null : parseNumber(amount);
  if (
    (op === "open" && amt !== null && amt < 0) ||
    (op === "recharge" && (amt === null || amt <= 0)) ||
    (op === "debit" && (amt === null || amt === 0))
  ) {
    return { ok: false, error: "bad_params" };
  }

  await hydrateLocalBusinessStore(sys);
  const acc = ensureAccount(sys, p);
  if (!acc) return { ok: false, error: "bad_system" };
  const time_bj = nowBjText();
  let delta = 0;
  let result = "ok";
  let source = `web-${op}`;

  if (op === "open") {
    acc.status = "active";
    if (amt !== null && amt > 0) {
      delta = bizRound2(amt);
      acc.balance = bizRound2(Number(acc.balance || 0) + delta);
      settleBusinessArrears(acc);
      source = "web-open";
    }
  } else if (op === "close") {
    acc.status = "closed";
  } else if (op === "recharge") {
    delta = bizRound2(amt);
    acc.balance = bizRound2(Number(acc.balance || 0) + delta);
    settleBusinessArrears(acc);
    acc.status = "active";
  } else if (op === "debit") {
    delta = -Math.abs(bizRound2(amt));
    const nextBalance = bizRound2(Number(acc.balance || 0) + delta);
    if (nextBalance < 0) {
      acc.balance = 0;
      acc.arrears = bizRound2(Number(acc.arrears || 0) + Math.abs(nextBalance));
      result = "arrears";
    } else {
      acc.balance = nextBalance;
    }
    acc.status = acc.status === "closed" ? "closed" : "active";
  } else {
    return { ok: false, error: "bad_op" };
  }

  acc.balance = bizRound2(acc.balance);
  acc.arrears = bizRound2(acc.arrears);
  acc.updated_at = time_bj;

  const shouldRecord = op !== "open" || true;
  const record = shouldRecord
    ? {
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
        time_bj,
        plate: p,
        source,
        delta: bizRound2(delta),
        balance: bizRound2(acc.balance),
        arrears: bizRound2(acc.arrears),
        result,
      }
    : null;
  if (record) pushRecord(sys, record);
  await persistLocalBusinessStore(sys, op, record);
  return {
    ok: true,
    local: true,
    system: sys,
    op,
    account: { ...acc },
    record,
    report: bizSnapshotBody(sys),
  };
}

async function handleForwardedBusinessOp(res, system, op, payload, timeoutMs = 2400) {
  const body = payload && typeof payload === "object" ? payload : {};
  const local = await applyLocalBusinessOp(system, op, body);
  if (!local.ok) {
    sendJson(res, local.error === "bad_params" || local.error === "bad_plate" ? 400 : 500, local);
    return;
  }

  if (rkIsOnline()) {
    const rk = rkForwardTarget();
    const r = await httpPostJson(`${rk.base}/api/business/${system}/${op}`, body, timeoutMs);
    if (r.ok && r.json?.ok === true) {
      if (r.json?.report && typeof r.json.report === "object") {
        appendJsonLine("business_events.jsonl", { time_bj: nowBjText(), system, op, via: "forward", report_received: true });
      }
      sendJson(res, 200, { ...local, forwarded_to_rk: true, rk_base: rk.base, rk_source: rk.source, rk: r.json });
      return;
    }
    sendJson(res, 200, {
      ...local,
      forwarded_to_rk: false,
      fallback: "local",
      forward_error: r.json?.error || r.text || "rk_forward_failed",
      rk_base: rk.base,
      rk_status: r.status,
    });
    return;
  }

  sendJson(res, 200, { ...local, forwarded_to_rk: false, fallback: "local", reason: "rk_offline" });
}

const previewJpegBase64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhISEyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";
const previewJpeg = Buffer.from(previewJpegBase64, "base64");

function serveStatic(req, res, pathname) {
  const rawRel = pathname === "/" ? "/adas.html" : pathname;
  let rel = rawRel;
  try {
    rel = decodeURIComponent(rawRel);
  } catch {}
  const safeRel = rel.replace(/\\/g, "/");
  if (isBlockedStaticPath(safeRel)) {
    sendText(res, 404, "not found");
    return true;
  }
  const filePath = path.resolve(staticRoot, "." + safeRel);
  if (!filePath.startsWith(staticRoot + path.sep)) {
    sendText(res, 403, "forbidden");
    return true;
  }

  if (safeRel === "/api/preview.jpg") return false;

  if (!fs.existsSync(filePath)) return false;
  const st = fs.statSync(filePath);
  if (st.isDirectory()) return false;

  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml; charset=utf-8",
    ".ico": "image/x-icon",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".csv": "text/csv; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
  };
  const ct = mime[ext] || "application/octet-stream";

  const buf = fs.readFileSync(filePath);
  send(res, 200, { "Content-Type": ct, "Cache-Control": "no-store" }, buf);
  return true;
}

function notFound(res) {
  sendJson(res, 404, { error: "not_found" });
}

function writeBizLatestSnapshot() {
  const out = {};
  ["parking", "etc"].forEach((system) => {
    const st = rkBizReported[system];
    if (!st) return;
    const at = Number(st.updatedAt) || 0;
    if (!at) return;
    out[system] = {
      accounts: Array.isArray(st.accounts) ? st.accounts : [],
      records: Array.isArray(st.records) ? st.records : [],
      updatedAt: at,
      snapshot_at_ms: at,
      ...(st.report && typeof st.report === "object" ? { report: st.report } : {}),
    };
  });
  return writeDurableJsonFile(path.join(logRoot, "business_latest.json"), out);
}

function normalizeBusinessSystem(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "etc" || s.includes("etc")) return "etc";
  if (s === "parking" || s === "park" || s.includes("parking") || s.includes("停车") || s.includes("停車")) return "parking";
  return null;
}

function normalizeRkAdasStatus(body, bizSystem) {
  if (bizSystem !== "adas" || body?.adas_schema !== "pango_adas.v1") return null;
  const allowed = {
    scene: ["路口信号灯", "道路变道", "行人/障碍物", "夜间道路"],
    lane: ["左车道", "直行车道", "右车道"],
    lane_marking: ["虚线", "实线", "未知"],
    signal: ["红灯", "绿灯", "黄灯", "未知"],
    maneuver: ["左转", "直行", "右转", "停车"],
    turn_signal: ["关闭", "左转向灯", "右转向灯"],
  };
  const enumValue = (field, values) => {
    const value = cleanUserTemplate(body?.[`adas_${field}`], 48);
    return values.includes(value) ? value : "未知";
  };
  const integer = (field, fallback, min, max) => {
    const value = Number(body?.[`adas_${field}`]);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  };
  const text = cleanUserTemplate(body?.adas_alarm_text, 240);
  const link = cleanUserTemplate(body?.adas_fpga_arm_link, 80);
  let perception = null;
  const raw = body?.adas_perception;
  const keys = ["zebra", "person", "red", "green", "black", "yellow"];
  if (raw && raw.source === "rknn_environment" &&
      keys.every((key) => Number.isInteger(raw.counts?.[key]) && raw.counts[key] >= 0 && raw.counts[key] <= 10000) &&
      Number.isSafeInteger(raw.observed_at_ms) && raw.observed_at_ms > 0) {
    perception = {
      source: raw.source,
      model: cleanUserTemplate(raw.model, 160),
      counts: Object.fromEntries(keys.map((key) => [key, raw.counts[key]])),
      observed_at_ms: raw.observed_at_ms,
      view_mode: [0, 1, 2].includes(raw.view_mode) ? raw.view_mode : null,
      single_source: [1, 2, 3, 4].includes(raw.single_source) ? raw.single_source : null,
    };
    const road = raw.road_state && typeof raw.road_state === "object" && !Array.isArray(raw.road_state) ? raw.road_state : null;
    if (road) {
      const signal = (value) => {
        const text = cleanUserTemplate(value, 16).toLowerCase();
        const aliases = { red: "红灯", green: "绿灯", yellow: "黄灯", none: "无", absent: "无", unknown: "未知" };
        const normalized = aliases[text] || value;
        return ["红灯", "绿灯", "黄灯", "无", "未知"].includes(normalized) ? normalized : "未知";
      };
      const marking = (value) => {
        const text = cleanUserTemplate(value, 16).toLowerCase();
        const aliases = { solid: "实线", dashed: "虚线", none: "无", absent: "无", unknown: "未知" };
        const normalized = aliases[text] || value;
        return ["实线", "虚线", "无", "未知"].includes(normalized) ? normalized : "未知";
      };
      const speed = Number(road.speed_limit_kmh);
      perception.road_state = {
        signals: {
          left: signal(road.signals?.left), straight: signal(road.signals?.straight), right: signal(road.signals?.right),
        },
        obstacle: typeof road.obstacle === "boolean" ? road.obstacle : null,
        lane_markings: { left: marking(road.lane_markings?.left), right: marking(road.lane_markings?.right) },
        speed_limit_kmh: Number.isInteger(speed) && speed > 0 && speed <= 180 ? speed : null,
      };
    }
  }
  return {
    schema: "pango_adas.v1",
    input_source: body?.adas_input_source === "manual_console" ? "manual_console" : "unknown",
    scene: enumValue("scene", allowed.scene),
    lane: enumValue("lane", allowed.lane),
    lane_marking: enumValue("lane_marking", allowed.lane_marking),
    signal: enumValue("signal", allowed.signal),
    maneuver: enumValue("maneuver", allowed.maneuver),
    turn_signal: enumValue("turn_signal", allowed.turn_signal),
    speed_kmh: integer("speed_kmh", 0, 0, 180),
    speed_limit_kmh: integer("speed_limit_kmh", 0, 0, 180),
    moving: body?.adas_moving === true,
    forced_change: body?.adas_forced_change === true,
    obstacle: body?.adas_obstacle === true,
    alarm: body?.adas_alarm === true,
    alarm_text: text,
    fpga_arm_link: link || "等待PCIe有效帧",
    ...(perception ? { perception } : {}),
  };
}

function businessReportContainer(body) {
  if (body?.report && typeof body.report === "object") return body.report;
  if (body?.business && typeof body.business === "object") return body.business;
  return body && typeof body === "object" ? body : {};
}

function businessReportTargetSystem(body) {
  return (
    normalizeBusinessSystem(body?.biz_system) ||
    normalizeBusinessSystem(body?.business_system) ||
    normalizeBusinessSystem(body?.system) ||
    normalizeBusinessSystem(body?.profile) ||
    normalizeBusinessSystem(body?.mode) ||
    normalizeBusinessSystem(rkReported.status?.biz_system) ||
    "parking"
  );
}

function validateRkBusinessPayload(root) {
  if (!rkPayloadUsesV1(root)) return null;
  if (Object.prototype.hasOwnProperty.call(root, "time_bj")) {
    const timeProblem = validateRkPayloadString(root, "time_bj", { nonEmpty: true, max: 32 });
    if (timeProblem) return timeProblem;
    if (parseRkBeijingTimestamp(root.time_bj) === null) return rkPayloadProblem("time_bj", "time_bj must use a valid Beijing calendar time");
  }
  for (const field of ["biz_system", "business_system", "system", "profile", "mode"]) {
    const problem = validateRkPayloadString(root, field, { max: 80 });
    if (problem) return problem;
  }
  for (const candidate of ["biz_system", "business_system", "system", "profile", "mode"]) {
    if (root[candidate] !== undefined && normalizeBusinessSystem(root[candidate]) === null) {
      return rkPayloadProblem(candidate, `${candidate} must identify parking or etc`);
    }
  }
  const container = businessReportContainer(root);
  const rootHasSnapshot = Array.isArray(container?.accounts) || Array.isArray(container?.records);
  const targetSystem = rootHasSnapshot ? businessReportTargetSystem(root) : null;
  for (const system of ["parking", "etc"]) {
    const snapshot = container?.[system] || (rootHasSnapshot && system === targetSystem ? container : null);
    if (snapshot === undefined || snapshot === null) continue;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return rkPayloadProblem(system, `${system} must be an object`);
    for (const kind of ["accounts", "records"]) {
      if (!Array.isArray(snapshot[kind])) return rkPayloadProblem(`${system}.${kind}`, `${system}.${kind} must be an array`);
      if (snapshot[kind].length > 5000) return rkPayloadProblem(`${system}.${kind}`, `${system}.${kind} exceeds the 5000 item limit`);
    }
    for (let index = 0; index < snapshot.accounts.length; index += 1) {
      const account = snapshot.accounts[index];
      if (!account || typeof account !== "object" || Array.isArray(account)) return rkPayloadProblem(`${system}.accounts[${index}]`, "account must be an object");
      if (typeof account.plate !== "string" || !account.plate.trim()) return rkPayloadProblem(`${system}.accounts[${index}].plate`, "plate must be a non-empty string");
      for (const field of ["balance", "arrears"]) {
        const problem = validateRkPayloadNumber(account, field);
        if (problem) return { ...problem, field: `${system}.accounts[${index}].${field}` };
      }
      for (const field of ["status", "updated_at", "time_bj"]) {
        const problem = validateRkPayloadString(account, field, { max: 160 });
        if (problem) return { ...problem, field: `${system}.accounts[${index}].${field}` };
      }
    }
    for (let index = 0; index < snapshot.records.length; index += 1) {
      const record = snapshot.records[index];
      if (!record || typeof record !== "object" || Array.isArray(record)) return rkPayloadProblem(`${system}.records[${index}]`, "record must be an object");
      if (typeof record.plate !== "string" || !record.plate.trim()) return rkPayloadProblem(`${system}.records[${index}].plate`, "plate must be a non-empty string");
      for (const field of ["delta", "balance", "arrears"]) {
        const problem = validateRkPayloadNumber(record, field);
        if (problem) return { ...problem, field: `${system}.records[${index}].${field}` };
      }
      if (Object.prototype.hasOwnProperty.call(record, "amount")) {
        const problem = validateRkPayloadNumber(record, "amount");
        if (problem) return { ...problem, field: `${system}.records[${index}].amount` };
      }
      for (const field of ["time_bj", "source", "result"]) {
        const problem = validateRkPayloadString(record, field, { max: 160 });
        if (problem) return { ...problem, field: `${system}.records[${index}].${field}` };
      }
      if (record.time_bj !== undefined && parseRkBeijingTimestamp(record.time_bj) === null) {
        return rkPayloadProblem(`${system}.records[${index}].time_bj`, "time_bj must use a valid Beijing calendar time");
      }
    }
  }
  return null;
}

async function ingestBizReport(body, updatedAtMs, reportMeta = null) {
  const now = Number(updatedAtMs) || Date.now();
  const latest = {};
  const systems = ["parking", "etc"];
  const container = businessReportContainer(body);
  const rootHasSnapshot = Array.isArray(container?.accounts) || Array.isArray(container?.records);
  const targetSystem = rootHasSnapshot ? businessReportTargetSystem(body) : null;
  const round2 = (v, field) => {
    if (rkPayloadUsesV1(body) && typeof v !== "number") {
      const error = new Error(`business snapshot field ${field} must be a JSON number`);
      error.code = "bad_business_snapshot";
      error.status = 400;
      throw error;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) {
      const error = new Error(`business snapshot field ${field} must be a finite number`);
      error.code = "bad_business_snapshot";
      error.status = 400;
      throw error;
    }
    return Number(n.toFixed(2));
  };
  let foundSnapshot = false;
  systems.forEach((system) => {
    const p = container?.[system] || (rootHasSnapshot && system === targetSystem ? container : null);
    if (!p || typeof p !== "object") return;
    foundSnapshot = true;
    if (!Array.isArray(p.accounts) || !Array.isArray(p.records) || p.accounts.length > 5000 || p.records.length > 5000) {
      const error = new Error(`${system} must contain accounts[] and records[] with at most 5000 items each`);
      error.code = "bad_business_snapshot";
      error.status = 400;
      throw error;
    }
    const accountsIn = p.accounts;
    const recordsIn = p.records;
    const accounts = accountsIn
      .map((a, index) => {
        const plate = String(a?.plate ?? "").trim();
        if (!plate) {
          const error = new Error(`${system}.accounts[${index}].plate is required`);
          error.code = "bad_business_snapshot";
          error.status = 400;
          throw error;
        }
        return {
          plate,
          balance: round2(a?.balance ?? 0, `${system}.accounts[${index}].balance`),
          arrears: round2(a?.arrears ?? 0, `${system}.accounts[${index}].arrears`),
          status: String(a?.status ?? "active"),
          updated_at: String(a?.updated_at ?? a?.time_bj ?? nowBjText()),
        };
      });
    const records = recordsIn
      .map((r, index) => {
        const plate = String(r?.plate ?? "").trim();
        if (!plate) {
          const error = new Error(`${system}.records[${index}].plate is required`);
          error.code = "bad_business_snapshot";
          error.status = 400;
          throw error;
        }
        return {
          time_bj: String(r?.time_bj ?? nowBjText()),
          plate,
          source: String(r?.source ?? ""),
          delta: round2(r?.delta ?? r?.amount ?? 0, `${system}.records[${index}].delta`),
          balance: round2(r?.balance ?? 0, `${system}.records[${index}].balance`),
          arrears: round2(r?.arrears ?? 0, `${system}.records[${index}].arrears`),
          result: String(r?.result ?? ""),
        };
      });
    if (Number(rkBizReported[system].updatedAt || 0) > now) {
      latest[system] = { ignored_stale: true, updatedAt: Number(rkBizReported[system].updatedAt) };
      return;
    }
    latest[system] = { accounts, records, updatedAt: now };
  });
  if (!foundSnapshot) {
    const error = new Error("business report must contain a complete parking or ETC snapshot");
    error.code = "bad_business_snapshot";
    error.status = 400;
    throw error;
  }
  const previous = {};
  Object.entries(latest).forEach(([system, snap]) => {
    if (snap.ignored_stale) return;
    previous[system] = { ...rkBizReported[system] };
    rkBizReported[system].accounts = snap.accounts;
    rkBizReported[system].records = snap.records;
    rkBizReported[system].updatedAt = snap.updatedAt;
    if (reportMeta && typeof reportMeta === "object") rkBizReported[system].report = { ...reportMeta };
  });
  if (!writeBizLatestSnapshot()) {
    Object.entries(previous).forEach(([system, snap]) => Object.assign(rkBizReported[system], snap));
    const error = new Error("unable to durably save business_latest.json");
    error.code = "business_persist_failed";
    error.status = 507;
    throw error;
  }
  const mysqlPolicy = businessMysqlWritePolicy();
  const snapshotsToPersist = Object.entries(latest).filter(([, snap]) => !snap.ignored_stale);
  const mysqlResults = mysqlPolicy.enabled
    ? await Promise.all(
        snapshotsToPersist.map(async ([system, snap]) => ({
          system,
          ok: await mysqlSaveBusinessSnapshot(system, snap.accounts, snap.records, snap.updatedAt),
        })),
      )
    : [];
  const mysqlPersisted = !mysqlPolicy.enabled || mysqlResults.every((item) => item.ok);
  latest.persistence = {
    local_json: true,
    mysql_enabled: mysqlPolicy.enabled,
    mysql_required: mysqlPolicy.required,
    mysql_persisted: mysqlPersisted,
    mysql_failed_systems: mysqlResults.filter((item) => !item.ok).map((item) => item.system),
  };
  if (mysqlPolicy.required && !mysqlPersisted) {
    const error = new Error("business snapshot is durable locally but could not be committed to MySQL");
    error.code = "business_mysql_persist_failed";
    error.status = 503;
    error.durable_local = true;
    error.persistence = latest.persistence;
    throw error;
  }
  return latest;
}

function queryRkAccounts(system, q) {
  const st = rkBizReported[system];
  if (!st) return { items: [], total: 0 };
  const plate = q.get("plate") ?? "";
  const status = q.get("status") ?? "";
  let items = Array.isArray(st.accounts) ? st.accounts.slice() : [];
  items = items.filter((a) => wildcardMatch(a.plate, plate));
  if (status) items = items.filter((a) => a.status === status);
  items.sort((a, b) => String(a.plate).localeCompare(String(b.plate)));
  const total = items.length;
  const limit = clamp(parseInt(q.get("limit") ?? "2000", 10), 1, 5000);
  return { items: items.slice(0, limit), total };
}

function listRkAccounts(system, q) {
  return queryRkAccounts(system, q).items;
}

function queryRkRecords(system, q) {
  const st = rkBizReported[system];
  if (!st) return { items: [], total: 0 };
  const plate = q.get("plate") ?? "";
  const start = q.get("start") ?? "";
  const end = q.get("end") ?? "";
  const result = q.get("result") ?? "";
  let items = Array.isArray(st.records) ? st.records.slice() : [];
  if (plate) items = items.filter((r) => wildcardMatch(r.plate, plate));
  if (result) items = items.filter((r) => r.result === result);
  if (start) items = items.filter((r) => String(r.time_bj ?? "").slice(0, 10) >= start);
  if (end) items = items.filter((r) => String(r.time_bj ?? "").slice(0, 10) <= end);
  items.sort((a, b) => String(b.time_bj).localeCompare(String(a.time_bj)));
  const total = items.length;
  const limit = clamp(parseInt(q.get("limit") ?? "200", 10), 1, 5000);
  return { items: items.slice(0, limit), total };
}

function listRkRecords(system, q) {
  return queryRkRecords(system, q).items;
}

function publicRkBusinessReport(system, snapshotAtMs = null) {
  const report = rkBizReported?.[system]?.report;
  if (!report || typeof report !== "object") return null;
  const requestedAt = businessSnapshotAtMs(snapshotAtMs);
  const reportAt = businessSnapshotAtMs(report.report_created_at_ms);
  if (requestedAt && reportAt && requestedAt !== reportAt) return null;
  return { ...report };
}

function normalizeIpv4Text(addr) {
  const s = String(addr || "").trim();
  if (!s) return null;
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v = m ? m[1] : s;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(v)) return null;
  return v;
}

function trackRkPeer(req, identity = null) {
  const ip = normalizeIpv4Text(req?.socket?.remoteAddress);
  if (!ip) return;
  const reportedDeviceId = normalizeRkReportIdentifier(identity?.rk_device_id, 128) || "";
  const activeDeviceId = normalizeRkReportIdentifier(rkReported.status?.rk_device_id, 128) || "";
  if (reportedDeviceId && activeDeviceId && reportedDeviceId !== activeDeviceId) return;
  rkReported.peerIp = ip;
  rkReported.peerSeenAtMs = Date.now();
  rkReported.peerRkDeviceId = reportedDeviceId || activeDeviceId || null;
}

function trackRkPeerOnSuccess(req, res, identity = null) {
  if (!res || typeof res.once !== "function") return;
  res.once("finish", () => {
    if (res.statusCode >= 200 && res.statusCode < 300) trackRkPeer(req, identity);
  });
}

function recordRkReportRejection(req, identity, problem) {
  appendBoundedJsonLine(rkReportRejectionPath, {
    time_bj: nowBjText(),
    received_at_ms: Date.now(),
    rk_device_id: normalizeRkReportIdentifier(identity?.rk_device_id, 128) || "rk3568",
    event_id: normalizeRkReportIdentifier(identity?.event_id, 160) || null,
    report_type: normalizeRkReportIdentifier(identity?.report_type, 40) || "status",
    field: cleanUserTemplate(problem?.field, 240) || null,
    message: cleanUserTemplate(problem?.message, 500) || "Rejected RK report payload",
    source_ip: miniClientIp(req),
    user_agent: cleanUserTemplate(req?.headers?.["user-agent"], 240) || null,
  }, 5000);
}

function cleanDriverText(v, maxLen = 1200) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function cleanDriverNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function putDriverText(out, key, v, maxLen) {
  const s = cleanDriverText(v, maxLen);
  if (s) out[key] = s;
}

function putDriverNumber(out, key, v) {
  const n = cleanDriverNumber(v);
  if (n !== null) out[key] = n;
}

function putDriverBool(out, key, v) {
  if (typeof v === "boolean") out[key] = v;
}

function normalizeDriverRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .slice(0, 500)
    .map((row) => {
      const r = row && typeof row === "object" ? row : {};
      return {
        category: cleanDriverText(r.category, 80) || "设备",
        item: cleanDriverText(r.item, 180) || "—",
        value: cleanDriverText(r.value, 500) || "—",
        detail: cleanDriverText(r.detail, 1600),
      };
    })
    .filter((r) => r.item !== "—" || r.value !== "—" || r.detail);
}

function normalizeDriverFreqDevice(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  putDriverText(out, "name", raw.name, 160);
  putDriverText(out, "policy", raw.policy, 80);
  putDriverText(out, "sysfs", raw.sysfs, 500);
  putDriverText(out, "governor", raw.governor, 80);
  putDriverText(out, "cur_freq_text", raw.cur_freq_text, 120);
  putDriverText(out, "usage_text", raw.usage_text, 120);
  putDriverText(out, "load_raw", raw.load_raw, 240);
  putDriverNumber(out, "cur_freq_khz", raw.cur_freq_khz);
  putDriverNumber(out, "cur_freq_hz", raw.cur_freq_hz);
  putDriverNumber(out, "cur_freq_mhz", raw.cur_freq_mhz);
  putDriverNumber(out, "usage_percent", raw.usage_percent);
  return Object.keys(out).length ? out : null;
}

function normalizeDriverCaptureMetrics(...rawSources) {
  const sources = rawSources.filter((raw) => raw && typeof raw === "object" && !Array.isArray(raw));
  if (!sources.length) return null;
  const out = {};
  const firstValue = (keys, accept) => {
    for (const source of sources) {
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const value = source[key];
        if (accept(value)) return value;
      }
    }
    return undefined;
  };

  const boolFields = {
    running: ["running"],
    pcie: ["pcie"],
    metric_valid: ["metric_valid"],
    batch_ioctl: ["batch_ioctl"],
    staged_copy: ["staged_copy", "pcie_staged_copy"],
    irq_wait: ["irq_wait"],
    irq_fallback: ["irq_fallback"],
    frame_v2: ["frame_v2", "pcie_frame_v2"],
    mmap_enabled: ["mmap_enabled", "pcie_mmap_enabled"],
    bar_contract_ok: ["bar_contract_ok", "pcie_bar_contract_ok"],
    all_four_sources_valid: ["all_four_sources_valid", "pcie_all_four_sources_valid"],
    rate_control_supported: ["rate_control_supported", "pcie_rate_control_supported"],
    fixed_30fps_active: ["fixed_30fps_active", "pcie_fixed_30fps_active"],
    v1_fallback_allowed: ["v1_fallback_allowed", "pcie_v1_fallback_allowed"],
    v1_fallback_active: ["v1_fallback_active", "pcie_v1_fallback_active"],
    source_locked: ["source_locked", "pcie_source_locked"],
  };
  Object.entries(boolFields).forEach(([target, aliases]) => {
    const value = firstValue(aliases, (v) => typeof v === "boolean");
    if (typeof value === "boolean") out[target] = value;
  });

  const numberFields = {
    actual_rx_fps: ["actual_rx_fps", "pcie_rx_fps"],
    frame_interval_ms: ["frame_interval_ms", "pcie_frame_interval_ms"],
    dma_transfer_ms: ["dma_transfer_ms", "pcie_dma_ms"],
    dma_wait_ms: ["dma_wait_ms", "pcie_dma_wait_ms"],
    dma_wait_avg_ms: ["dma_wait_avg_ms", "pcie_dma_wait_avg_ms"],
    dma_wait_max_ms: ["dma_wait_max_ms", "pcie_dma_wait_max_ms"],
    dma_wait_window_ms: ["dma_wait_window_ms", "pcie_dma_wait_window_ms"],
    dma_wait_sample_count: ["dma_wait_sample_count", "pcie_dma_wait_sample_count"],
    kernel_staging_ms: ["kernel_staging_ms", "pcie_kernel_staging_ms"],
    user_copy_ms: ["user_copy_ms", "pcie_user_copy_ms"],
    complete_frames: ["complete_frames", "frames_total", "pcie_rx_frames"],
    dropped_frames: ["dropped_frames", "pcie_dropped_frames"],
    fpga_dropped_frames: ["fpga_dropped_frames", "pcie_fpga_dropped_frames"],
    host_dropped_frames: ["host_dropped_frames", "pcie_host_dropped_frames"],
    sequence_gaps: ["sequence_gaps", "pcie_sequence_gaps"],
    dma_unit_bytes: ["dma_unit_bytes"],
    dma_units_per_frame: ["dma_units_per_frame", "dma_unit_count"],
    driver_abi_version: ["driver_abi_version", "pcie_driver_abi_version"],
    driver_features: ["driver_features", "pcie_driver_features"],
    fpga_protocol_version: ["fpga_protocol_version", "pcie_fpga_protocol_version"],
    fpga_capabilities: ["fpga_capabilities", "pcie_fpga_capabilities"],
    target_fps_milli: ["target_fps_milli", "pcie_target_fps_milli"],
    fpga_target_fps_milli: ["fpga_target_fps_milli", "pcie_fpga_target_fps_milli"],
    bar0_read_bytes: ["bar0_read_bytes", "pcie_bar0_read_bytes"],
    bar1_write_bytes: ["bar1_write_bytes", "pcie_bar1_write_bytes"],
    source_mask: ["source_mask", "pcie_source_mask"],
    fpga_build_id: ["fpga_build_id", "pcie_fpga_build_id"],
    recovery_count: ["recovery_count", "pcie_recovery_count"],
    consecutive_timeouts: ["consecutive_timeouts", "pcie_consecutive_timeouts"],
    protocol_errors: ["protocol_errors", "pcie_protocol_errors"],
    frame_width: ["frame_width", "pcie_frame_width"],
    frame_height: ["frame_height", "pcie_frame_height"],
    frame_stride_bytes: ["frame_stride_bytes", "pcie_frame_stride_bytes"],
    frame_bytes: ["frame_bytes", "pcie_frame_bytes"],
    ring_count: ["ring_count", "pcie_ring_count"],
  };
  const integerNumberFields = new Set([
    "complete_frames",
    "dropped_frames",
    "fpga_dropped_frames",
    "host_dropped_frames",
    "sequence_gaps",
    "dma_wait_sample_count",
    "dma_unit_bytes",
    "dma_units_per_frame",
    "driver_abi_version",
    "driver_features",
    "fpga_protocol_version",
    "fpga_capabilities",
    "target_fps_milli",
    "fpga_target_fps_milli",
    "bar0_read_bytes",
    "bar1_write_bytes",
    "source_mask",
    "fpga_build_id",
    "recovery_count",
    "consecutive_timeouts",
    "protocol_errors",
    "frame_width",
    "frame_height",
    "frame_stride_bytes",
    "frame_bytes",
    "ring_count",
  ]);
  Object.entries(numberFields).forEach(([target, aliases]) => {
    const raw = firstValue(aliases, (v) => v !== null && v !== "" && Number.isFinite(Number(v)));
    if (raw === undefined) return;
    const value = Math.max(0, Number(raw));
    out[target] = integerNumberFields.has(target)
      ? Math.floor(value)
      : Number(value.toFixed(4));
  });

  const textFields = {
    mode: ["mode"],
    protocol: ["protocol", "pcie_protocol"],
    metric_basis: ["metric_basis"],
    last_capture_basis: ["last_capture_basis"],
    last_frame_at: ["last_frame_at"],
    last_error: ["last_error"],
    driver_abi_hex: ["driver_abi_hex"],
    driver_features_hex: ["driver_features_hex"],
    fpga_protocol_hex: ["fpga_protocol_hex"],
    fpga_capabilities_hex: ["fpga_capabilities_hex"],
    fpga_build_id_hex: ["fpga_build_id_hex"],
    fpga_debug_state_hex: ["fpga_debug_state_hex"],
    fifo_level_01_hex: ["fifo_level_01_hex"],
    fifo_level_23_hex: ["fifo_level_23_hex"],
    fpga_handshake_state_hex: ["fpga_handshake_state_hex"],
    interrupt_mode: ["interrupt_mode", "pcie_interrupt_mode"],
    source_mask_hex: ["source_mask_hex"],
    recovery_state: ["recovery_state", "pcie_recovery_state"],
    batch_fallback_reason: ["batch_fallback_reason"],
    irq_fallback_reason: ["irq_fallback_reason"],
  };
  Object.entries(textFields).forEach(([target, aliases]) => {
    const preserveEmpty = ["last_error", "batch_fallback_reason", "irq_fallback_reason"].includes(target);
    const value = firstValue(aliases, (v) => typeof v === "string" && (preserveEmpty || Boolean(v.trim())));
    if (value !== undefined) out[target] = cleanDriverText(value, target === "last_error" ? 500 : 120);
  });

  const lastCaptureEntry = sources
    .map((source) => ({ source, value: Number(source.last_capture_ms) }))
    .find((entry) => Number.isFinite(entry.value));
  if (lastCaptureEntry) {
    const value = Number(Math.max(0, lastCaptureEntry.value).toFixed(4));
    out.last_capture_ms = value;
    const basis = String(lastCaptureEntry.source.last_capture_basis || out.last_capture_basis || "").trim().toLowerCase();
    const protocol = String(lastCaptureEntry.source.protocol || out.protocol || "").trim().toLowerCase();
    const mode = String(lastCaptureEntry.source.mode || out.mode || "").trim().toLowerCase();
    const isV2Wait = lastCaptureEntry.source.frame_v2 === true
      || protocol.startsWith("v2")
      || mode.includes("frame-v2")
      || mode.includes("mmap");
    if (out.dma_wait_ms === undefined && (basis === "dqbuf_wait" || (!basis && isV2Wait))) out.dma_wait_ms = value;
    if (out.dma_transfer_ms === undefined && (basis === "dma_total" || (!basis && !isV2Wait))) out.dma_transfer_ms = value;
  }

  // Preserve the v10.9 wire names while retaining the historical aliases
  // consumed by existing charts and exports.
  if (out.complete_frames !== undefined) out.frames_total = out.complete_frames;
  if (out.dma_units_per_frame !== undefined) out.dma_unit_count = out.dma_units_per_frame;

  return Object.keys(out).length ? out : null;
}

function captureMetricsTopLevelSource(body) {
  const raw = body && typeof body === "object" ? body : {};
  return {
    protocol: raw.pcie_protocol,
    mode: raw.pcie_mode,
    metric_valid: raw.pcie_metric_valid,
    metric_basis: raw.pcie_metric_basis,
    last_capture_basis: raw.pcie_last_capture_basis,
    last_frame_at: raw.pcie_last_frame_at,
    driver_abi_version: raw.pcie_driver_abi_version,
    driver_abi_hex: raw.pcie_driver_abi_hex,
    driver_features_hex: raw.pcie_driver_features_hex,
    fpga_protocol_hex: raw.pcie_fpga_protocol_hex,
    fpga_capabilities_hex: raw.pcie_fpga_capabilities_hex,
    fpga_build_id_hex: raw.pcie_fpga_build_id_hex,
    fpga_debug_state_hex: raw.pcie_fpga_debug_state_hex,
    fifo_level_01_hex: raw.pcie_fifo_level_01_hex,
    fifo_level_23_hex: raw.pcie_fifo_level_23_hex,
    fpga_handshake_state_hex: raw.pcie_fpga_handshake_state_hex,
    source_mask_hex: raw.pcie_source_mask_hex,
    actual_rx_fps: raw.pcie_rx_fps,
    frame_interval_ms: raw.pcie_frame_interval_ms,
    dma_transfer_ms: raw.pcie_dma_ms,
    dma_wait_ms: raw.pcie_dma_wait_ms,
    dma_wait_avg_ms: raw.pcie_dma_wait_avg_ms,
    dma_wait_max_ms: raw.pcie_dma_wait_max_ms,
    dma_wait_window_ms: raw.pcie_dma_wait_window_ms,
    dma_wait_sample_count: raw.pcie_dma_wait_sample_count,
    kernel_staging_ms: raw.pcie_kernel_staging_ms,
    user_copy_ms: raw.pcie_user_copy_ms,
    complete_frames: raw.pcie_rx_frames,
    dropped_frames: raw.pcie_dropped_frames,
    fpga_dropped_frames: raw.pcie_fpga_dropped_frames,
    host_dropped_frames: raw.pcie_host_dropped_frames,
    sequence_gaps: raw.pcie_sequence_gaps,
    driver_features: raw.pcie_driver_features,
    fpga_protocol_version: raw.pcie_fpga_protocol_version,
    fpga_capabilities: raw.pcie_fpga_capabilities,
    target_fps_milli: raw.pcie_target_fps_milli,
    fpga_target_fps_milli: raw.pcie_fpga_target_fps_milli,
    bar0_read_bytes: raw.pcie_bar0_read_bytes,
    bar1_write_bytes: raw.pcie_bar1_write_bytes,
    bar_contract_ok: raw.pcie_bar_contract_ok,
    interrupt_mode: raw.pcie_interrupt_mode,
    source_mask: raw.pcie_source_mask,
    all_four_sources_valid: raw.pcie_all_four_sources_valid,
    fpga_build_id: raw.pcie_fpga_build_id,
    rate_control_supported: raw.pcie_rate_control_supported,
    fixed_30fps_active: raw.pcie_fixed_30fps_active,
    v1_fallback_allowed: raw.pcie_v1_fallback_allowed,
    v1_fallback_active: raw.pcie_v1_fallback_active,
    source_locked: raw.pcie_source_locked,
    recovery_count: raw.pcie_recovery_count,
    consecutive_timeouts: raw.pcie_consecutive_timeouts,
    recovery_state: raw.pcie_recovery_state,
    staged_copy: raw.pcie_staged_copy,
    batch_ioctl: raw.pcie_batch_ioctl,
    irq_wait: raw.pcie_irq_wait,
    batch_fallback_reason: raw.pcie_batch_fallback_reason,
    irq_fallback_reason: raw.pcie_irq_fallback_reason,
    frame_v2: raw.pcie_frame_v2,
    mmap_enabled: raw.pcie_mmap_enabled,
    frame_width: raw.pcie_frame_width,
    frame_height: raw.pcie_frame_height,
    frame_stride_bytes: raw.pcie_frame_stride_bytes,
    frame_bytes: raw.pcie_frame_bytes,
    ring_count: raw.pcie_ring_count,
    protocol_errors: raw.pcie_protocol_errors,
  };
}

function extractDriverCaptureMetrics(body) {
  const raw = body && typeof body === "object" ? body : {};
  const driverStatus = raw.driver_status && typeof raw.driver_status === "object" ? raw.driver_status : {};
  const candidates = [
    { source: "driver_status.capture_metrics", value: driverStatus.capture_metrics },
    { source: "driver_status.pcie.capture_metrics", value: driverStatus.pcie?.capture_metrics },
    { source: "driver_capture_metrics", value: raw.driver_capture_metrics },
    { source: "pcie_top_level", value: captureMetricsTopLevelSource(raw) },
  ];
  const normalized = candidates.map((candidate) => ({ ...candidate, metrics: normalizeDriverCaptureMetrics(candidate.value) }));
  const metrics = normalizeDriverCaptureMetrics(...normalized.map((candidate) => candidate.metrics).filter(Boolean));
  const source = normalized.find((candidate) => candidate.metrics)?.source || "";
  return { metrics, source };
}

function normalizeRkRuntimeSettings(body) {
  const root = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const raw = root.runtime_settings && typeof root.runtime_settings === "object" && !Array.isArray(root.runtime_settings)
    ? root.runtime_settings
    : {};
  const out = {};
  if (typeof raw.schema === "string") putDriverText(out, "schema", raw.schema, 120);
  const putInt = (key, value, max = Number.MAX_SAFE_INTEGER) => {
    if (value === null || value === undefined || value === "" || typeof value === "boolean" || typeof value === "object") return;
    const number = Number(value);
    if (Number.isInteger(number) && number >= 0 && number <= max) out[key] = number;
  };
  const putNumber = (key, value, max = Number.MAX_SAFE_INTEGER) => {
    if (value === null || value === undefined || value === "" || typeof value === "boolean" || typeof value === "object") return;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0 && number <= max) out[key] = Number(number.toFixed(6));
  };

  putNumber("plate_conf", raw.plate_conf, 1);
  putNumber("env_conf", raw.env_conf, 1);
  putInt("algo_mode", raw.algo_mode, 16);
  putInt("sd_image_interval_sec", raw.sd_image_interval_sec, 86_400);
  putInt("plate_ocr_period", raw.plate_ocr_period, 1_000_000);
  putInt("plate_infer_stride", raw.plate_infer_stride, 1_000_000);
  putInt("plate_sliding_mode", raw.plate_sliding_mode, 16);
  putInt("pcie_inference_strategy", raw.pcie_inference_strategy ?? root.pcie_inference_strategy_configured, 2);
  putInt("pcie_overlap_window_width", raw.pcie_overlap_window_width, 16384);
  putInt("det_preprocess_backend", raw.det_preprocess_backend, 2);
  putInt("detector_profile", raw.detector_profile, 4);
  putInt("recognizer_profile", raw.recognizer_profile, 2);
  [
    "theme",
    "plate_geometry_min_short_edge",
    "plate_geometry_min_area",
    "plate_geometry_min_aspect_x100",
    "plate_geometry_max_aspect_x100",
    "plate_min_short_edge",
    "env_infer_stride",
    "plate_stable_required",
    "plate_box_hold_runs",
    "plate_cooldown_frames",
    "black_v_max",
    "white_s_max",
    "blue_h_min",
    "green_h_min",
    "yellow_h_min",
    "yellow_h_max",
    "double_lower_start",
  ].forEach((key) => putInt(key, raw[key], 1_000_000));
  [
    "plate_min_sharpness",
    "model_trust_val",
    "min_color_ratio",
    "rec_conf_threshold",
    "double_upper_ratio",
  ].forEach((key) => putNumber(key, raw[key], 1_000_000));
  [
    "dedupe_by_source",
    "global_inference_enabled",
    "plate_sliding_enabled",
    "pcie_four_source_sliding",
    "det_pipeline_enabled",
    "det_quantized_output",
    "plate_show_unconfirmed",
    "plate_show_suspected",
    "plate_geometry_filter_enabled",
    "plate_upload_thumb",
    "env_enable",
    "show_det_parts",
  ].forEach((key) => putDriverBool(out, key, raw[key]));
  ["draw_overlay", "draw_text", "draw_split"].forEach((key) => {
    if (typeof raw[key] === "boolean") out[key] = raw[key];
    else if (raw[key] === 0 || raw[key] === 1) out[key] = raw[key] === 1;
  });
  [
    ["audio_output_device", 300],
    ["target_device_id", 160],
  ].forEach(([key, maxLen]) => {
    if (typeof raw[key] === "string") putDriverText(out, key, raw[key], maxLen);
  });
  const legacySliding = typeof raw.pcie_four_source_sliding === "boolean"
    ? raw.pcie_four_source_sliding
    : typeof root.pcie_four_source_sliding_configured === "boolean"
      ? root.pcie_four_source_sliding_configured
      : null;
  if (typeof legacySliding === "boolean") out.pcie_four_source_sliding = legacySliding;
  return Object.keys(out).length ? out : null;
}

function normalizeRkReportDelivery(body) {
  const root = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const raw = root.report_delivery && typeof root.report_delivery === "object" && !Array.isArray(root.report_delivery)
    ? root.report_delivery
    : {};
  const out = {};
  const textFields = {
    schema: 120,
    semantics: 40,
    idempotency_field: 80,
    queue_path: 1024,
    queue_persist_error: 500,
    last_report_id: 160,
    last_report_path: 240,
    last_result: 80,
    last_error: 500,
    last_attempt_at: 80,
    last_ok_at: 80,
    last_ack_id: 160,
  };
  Object.entries(textFields).forEach(([key, maxLen]) => {
    if (typeof raw[key] !== "string") return;
    const value = cleanUserTemplate(raw[key], maxLen);
    const preserveEmpty = [
      "last_report_id",
      "last_report_path",
      "last_result",
      "last_error",
      "last_attempt_at",
      "last_ok_at",
      "last_ack_id",
    ].includes(key);
    if (value || preserveEmpty) out[key] = value;
  });
  ["in_flight", "queue_persist_ok"].forEach((key) => {
    if (typeof raw[key] === "boolean") out[key] = raw[key];
  });
  [
    "pending_count",
    "durable_pending_count",
    "rejected_saved_count",
    "queue_capacity",
    "request_timeout_ms",
    "accepted_total",
    "retry_total",
    "rejected_total",
    "dropped_total",
    "last_http_status",
  ].forEach((key) => {
    const rawValue = raw[key];
    if (rawValue === null || rawValue === undefined || rawValue === "" || typeof rawValue === "boolean" || typeof rawValue === "object") return;
    const value = Number(rawValue);
    if (Number.isFinite(value) && value >= 0) out[key] = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
  });
  if (!Object.keys(out).length) return null;
  return out;
}

function normalizeRkUserMessageConfigSync(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  ["enabled", "syncing", "last_ok"].forEach((key) => putDriverBool(out, key, raw[key]));
  const textFields = {
    path: 1024,
    last_result: 120,
    last_error: 500,
    last_sync_at: 80,
    last_applied_at: 80,
  };
  Object.entries(textFields).forEach(([key, maxLen]) => {
    if (typeof raw[key] !== "string") return;
    const value = cleanUserTemplate(raw[key], maxLen);
    if (value || key === "last_error") out[key] = value;
  });
  ["interval_ms", "timeout_ms", "last_latency_ms", "last_remote_version"].forEach((key) => {
    const value = raw[key];
    if (value === null || value === undefined || value === "" || typeof value === "boolean" || typeof value === "object") return;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) out[key] = key === "last_latency_ms" ? Number(number.toFixed(4)) : Math.floor(number);
  });
  return Object.keys(out).length ? out : null;
}

function normalizeRkTtsWav(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  ["enabled", "ready"].forEach((key) => putDriverBool(out, key, raw[key]));
  const textFields = { base_dir: 1024, output_device: 300, last_error: 500 };
  Object.entries(textFields).forEach(([key, maxLen]) => {
    if (typeof raw[key] !== "string") return;
    const value = cleanUserTemplate(raw[key], maxLen);
    if (value || key === "last_error") out[key] = value;
  });
  return Object.keys(out).length ? out : null;
}

function firstInferenceValue(sources, keys, accept) {
  const aliases = Array.isArray(keys) ? keys : [keys];
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const key of aliases) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const value = source[key];
      if (accept(value)) return value;
    }
  }
  return undefined;
}

function normalizeInferenceEnum(value, maxLen = 80) {
  const text = cleanDriverText(value, maxLen).toLowerCase();
  return /^[a-z0-9_]+$/.test(text) ? text : "";
}

function normalizeInferenceNumber(value, integer = false, min = 0) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean" || typeof value === "object") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const normalized = Math.max(min, number);
  return integer ? Math.floor(normalized) : Number(normalized.toFixed(4));
}

function normalizeDetectorModelCode(value) {
  const number = normalizeInferenceNumber(value, true, 0);
  return number === 0 || number === 1 ? number : null;
}

function plateDetectorTopLevelSource(root) {
  return {
    model_name: root.plate_detector_model_name,
    model_path: root.plate_detector_model_path,
    detector_profile: root.detector_profile,
    detector_profile_id: root.detector_profile_id,
    detector_family: root.detector_family,
    detector_model_name: root.detector_model_name,
    detector_input_width: root.detector_input_width,
    detector_input_height: root.detector_input_height,
    detector_input_type: root.detector_input_type,
    detector_output_contract: root.detector_output_contract,
    detector_runtime_backend: root.detector_runtime_backend,
    configured_model_file: root.plate_detector_configured_model_file,
    model_ready: root.plate_detector_model_ready,
    model_error: root.plate_detector_model_error,
    recognizer_ready: root.plate_recognizer_model_ready,
    recognizer_error: root.plate_recognizer_model_error,
    recognizer_name: root.plate_recognizer_model_name,
    recognizer_path: root.plate_recognizer_model_path,
    recognizer_profile: root.recognizer_profile,
    recognizer_profile_id: root.recognizer_profile_id,
    recognizer_output_contract: root.recognizer_output_contract,
    recognizer_input_width: root.recognizer_input_width,
    recognizer_input_height: root.recognizer_input_height,
    recognizer_input_format: root.recognizer_input_format,
    recognizer_text_layout: root.recognizer_text_layout,
    recognizer_runtime_backend: root.recognizer_runtime_backend,
    model_input: root.plate_detector_input,
    model_input_width: root.plate_model_input_width,
    model_input_height: root.plate_model_input_height,
    model_input_format: root.plate_model_input_format,
    postprocess_contract: root.plate_detector_postprocess,
    strategy: root.plate_inference_strategy,
    pipeline_enabled: root.plate_inference_pipeline_enabled,
    pipeline_active: root.plate_inference_pipeline_active,
    preprocess_backend: root.plate_preprocess_backend,
    preprocess_requested: root.plate_preprocess_requested,
    preprocess_fallback_reason: root.plate_preprocess_fallback_reason,
    quantized_output: root.plate_det_quantized_output,
    capture_async: root.plate_capture_async,
    latest_only: root.plate_latest_only,
    overlay_max_age_ms: root.plate_overlay_max_age_ms,
    display_cycle_ms: root.perf_display_cycle_ms,
    display_fps: root.perf_display_fps,
    capture_dropped_frames: root.perf_capture_dropped_frames,
    task_count: root.perf_det_task_count ?? root.plate_inference_calls_per_cycle,
    queue_depth: root.perf_det_queue_depth,
    dropped_tasks: root.perf_det_dropped_tasks,
    pre_ms: root.perf_det_pre_ms,
    npu_wall_ms: root.perf_det_npu_wall_ms,
    npu_hw_ms: root.perf_det_npu_hw_ms,
    post_ms: root.perf_det_post_ms,
    e2e_ms: root.perf_det_e2e_ms,
    overlap_saved_ms: root.perf_det_overlap_saved_ms,
    task_fps: root.perf_det_task_fps,
    task_throughput_fps: root.perf_det_task_throughput_fps,
    subtask_throughput_fps: root.perf_det_subtask_throughput_fps,
    task_fps_semantics: root.perf_det_task_fps_semantics,
    cycle_fps: root.perf_det_cycle_fps,
    cycle_ms: root.perf_det_cycle_ms,
    cycle_fps_semantics: root.perf_det_cycle_fps_semantics,
    result_age_ms: root.perf_det_result_age_ms,
  };
}

function normalizePlateDetectorRuntime(body) {
  const root = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const pcie = root.pcie_plate_inference && typeof root.pcie_plate_inference === "object" && !Array.isArray(root.pcie_plate_inference)
    ? root.pcie_plate_inference
    : {};
  const direct = root.plate_detector_runtime && typeof root.plate_detector_runtime === "object" && !Array.isArray(root.plate_detector_runtime)
    ? root.plate_detector_runtime
    : {};
  const nested = pcie.detector_runtime && typeof pcie.detector_runtime === "object" && !Array.isArray(pcie.detector_runtime)
    ? pcie.detector_runtime
    : {};
  const standalone = root.detector_runtime && typeof root.detector_runtime === "object" && !Array.isArray(root.detector_runtime)
    ? root.detector_runtime
    : {};
  const top = plateDetectorTopLevelSource(root);
  const sources = [direct, nested, standalone, top];
  const hasPayload = Object.keys(direct).length > 0
    || Object.keys(nested).length > 0
    || Object.keys(standalone).length > 0
    || Object.values(top).some((value) => value !== undefined && value !== null);
  if (!hasPayload) return null;

  const out = {};
  const boolFields = [
    "executed",
    "capture_async",
    "latest_only",
    "pipeline_enabled",
    "pipeline_active",
    "quantized_output",
    "model_ready",
    "recognizer_ready",
  ];
  boolFields.forEach((key) => {
    const value = firstInferenceValue(sources, key, (candidate) => typeof candidate === "boolean");
    if (typeof value === "boolean") out[key] = value;
  });
  ["strategy", "preprocess_backend", "preprocess_requested", "task_fps_semantics", "cycle_fps_semantics"].forEach((key) => {
    const value = firstInferenceValue(sources, key, (candidate) => typeof candidate === "string" && Boolean(candidate.trim()));
    const normalized = normalizeInferenceEnum(value);
    if (normalized) out[key] = normalized;
  });
  const textFields = {
    model_name: 160,
    model_path: 1024,
    configured_model_file: 512,
    recognizer_name: 160,
    recognizer_path: 1024,
    model_input: 160,
    model_input_format: 80,
    postprocess_contract: 320,
    output_mode: 96,
    detector_profile: 120,
    detector_family: 120,
    detector_model_name: 160,
    detector_input_type: 120,
    detector_output_contract: 600,
    detector_runtime_backend: 120,
    recognizer_profile: 120,
    recognizer_output_contract: 600,
    recognizer_input_format: 120,
    recognizer_text_layout: 160,
    recognizer_runtime_backend: 120,
  };
  Object.entries(textFields).forEach(([key, maxLen]) => {
    const value = firstInferenceValue(sources, key, (candidate) => typeof candidate === "string" && Boolean(candidate.trim()));
    const normalized = cleanDriverText(value, maxLen);
    if (normalized) out[key] = normalized;
  });
  const errorFields = {
    model_error: 500,
    recognizer_error: 500,
  };
  Object.entries(errorFields).forEach(([key, maxLen]) => {
    const value = firstInferenceValue(sources, key, (candidate) => typeof candidate === "string");
    if (value !== undefined) out[key] = String(value).trim().slice(0, maxLen);
  });
  const fallbackReason = firstInferenceValue(sources, "preprocess_fallback_reason", (candidate) => typeof candidate === "string");
  if (fallbackReason !== undefined) out.preprocess_fallback_reason = String(fallbackReason).trim().slice(0, 300);

  [
    "task_count",
    "queue_depth",
    "dropped_tasks",
    "detector_profile_id",
    "detector_input_width",
    "detector_input_height",
    "recognizer_profile_id",
    "recognizer_input_width",
    "recognizer_input_height",
  ].forEach((key) => {
    const value = firstInferenceValue(sources, key, (candidate) => normalizeInferenceNumber(candidate, true) !== null);
    const normalized = normalizeInferenceNumber(value, true);
    if (normalized !== null) out[key] = normalized;
  });
  [
    "pre_ms",
    "npu_wall_ms",
    "npu_hw_ms",
    "post_ms",
    "e2e_ms",
    "overlap_saved_ms",
    "task_fps",
    "task_throughput_fps",
    "subtask_throughput_fps",
    "cycle_fps",
    "cycle_ms",
    "result_age_ms",
    "overlay_max_age_ms",
    "display_cycle_ms",
    "display_fps",
    "capture_dropped_frames",
  ].forEach((key) => {
    const value = firstInferenceValue(sources, key, (candidate) => normalizeInferenceNumber(candidate) !== null);
    const normalized = normalizeInferenceNumber(value);
    if (normalized !== null) out[key] = normalized;
  });
  const taskThroughput = out.subtask_throughput_fps ?? out.task_throughput_fps ?? out.task_fps;
  if (taskThroughput !== undefined) {
    if (out.task_fps === undefined) out.task_fps = taskThroughput;
    if (out.task_throughput_fps === undefined) out.task_throughput_fps = taskThroughput;
    if (out.subtask_throughput_fps === undefined) out.subtask_throughput_fps = taskThroughput;
    if (!out.task_fps_semantics) out.task_fps_semantics = "subtask_throughput";
  }
  if ((out.cycle_fps !== undefined || out.cycle_ms !== undefined) && !out.cycle_fps_semantics) {
    out.cycle_fps_semantics = "full_detection_cycle";
  }
  return Object.keys(out).length ? out : null;
}

function normalizeInferenceLetterbox(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  [
    "source_width",
    "source_height",
    "model_width",
    "model_height",
    "content_width",
    "content_height",
    "pad_left",
    "pad_right",
    "pad_top",
    "pad_bottom",
  ].forEach((key) => {
    const value = normalizeInferenceNumber(raw[key], true);
    if (value !== null) out[key] = value;
  });
  const padValue = normalizeInferenceNumber(raw.pad_value_rgb ?? raw.pad_value_bgr, true);
  if (padValue !== null) out.pad_value_rgb = padValue;
  const legacyPadValue = normalizeInferenceNumber(raw.pad_value_bgr, true);
  if (legacyPadValue !== null) out.pad_value_bgr = legacyPadValue;
  if (typeof raw.scaleup === "boolean") out.scaleup = raw.scaleup;
  return Object.keys(out).length ? out : null;
}

function normalizePciePlateInference(body, runtimeSettingsOverride = null, detectorRuntimeOverride = null) {
  const root = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const raw = root.pcie_plate_inference && typeof root.pcie_plate_inference === "object" && !Array.isArray(root.pcie_plate_inference)
    ? root.pcie_plate_inference
    : {};
  const runtimeRaw = raw.runtime && typeof raw.runtime === "object" && !Array.isArray(raw.runtime) ? raw.runtime : {};
  const runtimeSettings = runtimeSettingsOverride || normalizeRkRuntimeSettings(root);
  const detectorRuntime = detectorRuntimeOverride || normalizePlateDetectorRuntime(root);
  const inferenceSchema = String(raw.schema || "").toLowerCase();
  const runtimeSchema = String(runtimeSettings?.schema || "").toLowerCase();
  const protocolV3 = inferenceSchema.endsWith("_v3") || runtimeSchema.endsWith(".v3");
  const modernProtocol = /_v(?:2|3)$/.test(inferenceSchema)
    || raw.configured_strategy !== undefined
    || root.pcie_inference_strategy_configured !== undefined
    || /\.v(?:2|3)$/.test(runtimeSchema);
  const aliasKeys = [
    "pcie_inference_strategy_configured",
    "pcie_four_source_sliding_configured",
    "pcie_four_source_fixed_roi_enabled",
    "pcie_plate_inference_strategy",
    "plate_sliding_status_known",
    "plate_sliding_active",
    "plate_sliding_enabled_last_run",
    "plate_sliding_window_count",
    "plate_sliding_work_width",
    "plate_sliding_work_height",
    "plate_sliding_window_width",
    "plate_sliding_window_height",
    "plate_sliding_stride_x",
    "plate_sliding_stride_y",
  ];
  const hasPayload = Object.keys(raw).length > 0
    || aliasKeys.some((key) => Object.prototype.hasOwnProperty.call(root, key))
    || Number.isInteger(runtimeSettings?.pcie_inference_strategy)
    || typeof runtimeSettings?.pcie_four_source_sliding === "boolean";
  if (!hasPayload) return null;

  const out = {};
  const putBoolFrom = (target, ...values) => {
    const value = values.find((candidate) => typeof candidate === "boolean");
    if (typeof value === "boolean") out[target] = value;
  };
  const putInt = (target, value, min = 0) => {
    const normalized = normalizeInferenceNumber(value, true, min);
    if (normalized !== null) out[target] = normalized;
  };

  putDriverText(out, "schema", raw.schema, 120);
  putDriverText(out, "input_mode", raw.input_mode ?? root.input_mode, 24);
  putDriverText(out, "view", raw.view ?? root.view, 80);
  putBoolFrom("applicable", raw.applicable);
  putBoolFrom("capture_running", raw.capture_running, root.capture_running);
  putBoolFrom("fixed_roi_enabled", raw.fixed_roi_enabled, root.pcie_four_source_fixed_roi_enabled);
  if (modernProtocol) putBoolFrom("pcie_sliding_enabled", raw.pcie_sliding_enabled, root.pcie_four_source_sliding_configured);
  putBoolFrom("fragment_companion_same_frame", raw.fragment_companion_same_frame);
  putBoolFrom("fragment_union_roi_redetect", raw.fragment_union_roi_redetect);
  putBoolFrom("pipeline_enabled", raw.pipeline_enabled, detectorRuntime?.pipeline_enabled, runtimeSettings?.det_pipeline_enabled);
  putBoolFrom("rga_compiled", raw.rga_compiled);
  putBoolFrom("quantized_output", raw.quantized_output, detectorRuntime?.quantized_output, runtimeSettings?.det_quantized_output);
  putBoolFrom("sliding_disabled_for_pcie", raw.sliding_disabled_for_pcie);
  putBoolFrom(
    "configured_sliding",
    raw.configured_sliding,
    root.pcie_four_source_sliding_configured,
    runtimeSettings?.pcie_four_source_sliding,
  );
  const strategy = normalizeInferenceEnum(raw.strategy || root.pcie_plate_inference_strategy || root.plate_inference_strategy);
  if (strategy) out.strategy = strategy;
  const configuredStrategy = normalizeInferenceNumber(
    raw.configured_strategy ?? root.pcie_inference_strategy_configured ?? runtimeSettings?.pcie_inference_strategy,
    true,
  );
  if (configuredStrategy !== null && configuredStrategy <= 2) out.configured_strategy = configuredStrategy;
  const preprocessConfigured = normalizeInferenceNumber(raw.preprocess_backend_configured ?? runtimeSettings?.det_preprocess_backend, true);
  if (preprocessConfigured !== null && preprocessConfigured <= 2) out.preprocess_backend_configured = preprocessConfigured;
  putInt(
    "calls_per_cycle",
    raw.calls_per_cycle ?? (protocolV3 ? undefined : root.plate_inference_calls_per_cycle ?? detectorRuntime?.task_count),
  );
  putInt(
    "planned_base_calls_per_cycle",
    raw.planned_base_calls_per_cycle ?? (protocolV3 ? raw.calls_per_cycle : undefined),
  );

  [
    "source_count",
    "active_source_count",
    "source_width",
    "source_height",
    "source_frame_width",
    "source_frame_height",
    "mosaic_width",
    "mosaic_height",
    "model_input_width",
    "model_input_height",
    "overlap_window_width",
    "overlap_window_height",
    "overlap_pixels",
    "overlap_phase_count",
    "fragment_recovery_limit",
  ].forEach((key) => putInt(key, raw[key]));
  const sourceMask = raw.source_mask === null || raw.source_mask === undefined || raw.source_mask === "" ? null : Number(raw.source_mask);
  if (Number.isInteger(sourceMask) && sourceMask >= 0 && sourceMask <= 15) out.source_mask = sourceMask;

  const inferenceTextFields = {
    source_layout: 40,
    source_frame_format: 80,
    model_input_format: 80,
    inference_unit: 40,
    detector_profile: 120,
    detector_family: 120,
    detector_output_contract: 600,
  };
  Object.entries(inferenceTextFields).forEach(([key, maxLen]) => {
    const fallback = key === "detector_profile"
      ? root.detector_profile ?? detectorRuntime?.detector_profile
      : key === "detector_family"
        ? root.detector_family ?? detectorRuntime?.detector_family
        : key === "detector_output_contract"
          ? root.detector_output_contract ?? detectorRuntime?.detector_output_contract
          : undefined;
    putDriverText(out, key, raw[key] ?? fallback, maxLen);
  });
  if (Array.isArray(raw.source_indices)) {
    const sourceIndices = Array.from(new Set(raw.source_indices
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 4)))
      .slice(0, 4);
    if (sourceIndices.length) out.source_indices = sourceIndices;
  }

  const runtime = {};
  const putRuntimeBool = (target, ...values) => {
    const value = values.find((candidate) => typeof candidate === "boolean");
    if (typeof value === "boolean") runtime[target] = value;
  };
  const putRuntimeInt = (target, value, min = 0) => {
    if (value === null || value === undefined || value === "") return;
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    runtime[target] = Math.max(min, Math.floor(number));
  };
  putRuntimeBool("status_known", runtimeRaw.status_known, root.plate_sliding_status_known);
  putRuntimeBool("enabled", runtimeRaw.enabled, root.plate_sliding_enabled_last_run);
  putRuntimeBool("active", runtimeRaw.active, root.plate_sliding_active);
  putRuntimeBool("removed", runtimeRaw.removed, root.plate_sliding_removed);
  putRuntimeBool("pcie_fixed_roi_enabled", runtimeRaw.pcie_fixed_roi_enabled, root.pcie_four_source_fixed_roi_enabled);
  const runtimeStrategy = normalizeInferenceEnum(runtimeRaw.strategy, 120);
  if (runtimeStrategy) runtime.strategy = runtimeStrategy;
  putRuntimeInt("window_count", runtimeRaw.window_count ?? root.plate_sliding_window_count, -1);
  ["work_width", "work_height", "window_width", "window_height", "stride_x", "stride_y"].forEach((key) => {
    const alias = `plate_sliding_${key}`;
    putRuntimeInt(key, runtimeRaw[key] ?? root[alias]);
  });
  if (Object.keys(runtime).length) out.runtime = runtime;

  if (detectorRuntime) out.detector_runtime = detectorRuntime;
  const singlePassLetterbox = normalizeInferenceLetterbox(raw.single_pass_letterbox);
  const perSourceLetterbox = normalizeInferenceLetterbox(raw.per_source_letterbox);
  if (singlePassLetterbox) out.single_pass_letterbox = singlePassLetterbox;
  if (perSourceLetterbox) out.per_source_letterbox = perSourceLetterbox;
  return Object.keys(out).length ? out : null;
}

function pciePlateInferenceAliasFields(inference) {
  const value = inference && typeof inference === "object" ? inference : null;
  if (!value) return {};
  const runtime = value.runtime && typeof value.runtime === "object" ? value.runtime : {};
  const out = {};
  if (Number.isInteger(value.configured_strategy)) out.pcie_inference_strategy_configured = value.configured_strategy;
  if (typeof value.pcie_sliding_enabled === "boolean") out.pcie_four_source_sliding_configured = value.pcie_sliding_enabled;
  else if (typeof value.configured_sliding === "boolean") out.pcie_four_source_sliding_configured = value.configured_sliding;
  if (typeof value.fixed_roi_enabled === "boolean") out.pcie_four_source_fixed_roi_enabled = value.fixed_roi_enabled;
  if (value.strategy) out.pcie_plate_inference_strategy = value.strategy;
  if (typeof runtime.status_known === "boolean") out.plate_sliding_status_known = runtime.status_known;
  if (typeof runtime.active === "boolean") out.plate_sliding_active = runtime.active;
  if (typeof runtime.enabled === "boolean") out.plate_sliding_enabled_last_run = runtime.enabled;
  const numberAliases = {
    window_count: "plate_sliding_window_count",
    work_width: "plate_sliding_work_width",
    work_height: "plate_sliding_work_height",
    window_width: "plate_sliding_window_width",
    window_height: "plate_sliding_window_height",
    stride_x: "plate_sliding_stride_x",
    stride_y: "plate_sliding_stride_y",
  };
  Object.entries(numberAliases).forEach(([source, target]) => {
    if (Number.isFinite(Number(runtime[source]))) out[target] = Number(runtime[source]);
  });
  return out;
}

function plateDetectorTopLevelFields(detectorRuntime, pcieInference = null) {
  const runtime = detectorRuntime && typeof detectorRuntime === "object" ? detectorRuntime : {};
  const pcie = pcieInference && typeof pcieInference === "object" ? pcieInference : {};
  const out = {};
  const strategy = runtime.strategy || pcie.strategy;
  if (strategy) out.plate_inference_strategy = strategy;
  const boolAliases = {
    pipeline_enabled: "plate_inference_pipeline_enabled",
    pipeline_active: "plate_inference_pipeline_active",
    quantized_output: "plate_det_quantized_output",
    capture_async: "plate_capture_async",
    latest_only: "plate_latest_only",
  };
  Object.entries(boolAliases).forEach(([source, target]) => {
    const value = typeof runtime[source] === "boolean" ? runtime[source] : source === "pipeline_enabled" && typeof pcie.pipeline_enabled === "boolean" ? pcie.pipeline_enabled : source === "quantized_output" && typeof pcie.quantized_output === "boolean" ? pcie.quantized_output : null;
    if (typeof value === "boolean") out[target] = value;
  });
  if (runtime.preprocess_backend) out.plate_preprocess_backend = runtime.preprocess_backend;
  if (runtime.preprocess_requested) out.plate_preprocess_requested = runtime.preprocess_requested;
  if (Object.prototype.hasOwnProperty.call(runtime, "preprocess_fallback_reason")) out.plate_preprocess_fallback_reason = runtime.preprocess_fallback_reason;
  const callsPerCycle = normalizeInferenceNumber(runtime.task_count ?? pcie.calls_per_cycle, true);
  if (callsPerCycle !== null) out.plate_inference_calls_per_cycle = callsPerCycle;
  const numberAliases = {
    pre_ms: "perf_det_pre_ms",
    npu_wall_ms: "perf_det_npu_wall_ms",
    npu_hw_ms: "perf_det_npu_hw_ms",
    post_ms: "perf_det_post_ms",
    e2e_ms: "perf_det_e2e_ms",
    overlap_saved_ms: "perf_det_overlap_saved_ms",
    task_fps: "perf_det_task_fps",
    task_throughput_fps: "perf_det_task_throughput_fps",
    subtask_throughput_fps: "perf_det_subtask_throughput_fps",
    cycle_fps: "perf_det_cycle_fps",
    cycle_ms: "perf_det_cycle_ms",
    result_age_ms: "perf_det_result_age_ms",
    task_count: "perf_det_task_count",
    queue_depth: "perf_det_queue_depth",
    dropped_tasks: "perf_det_dropped_tasks",
    overlay_max_age_ms: "plate_overlay_max_age_ms",
    display_cycle_ms: "perf_display_cycle_ms",
    display_fps: "perf_display_fps",
    capture_dropped_frames: "perf_capture_dropped_frames",
  };
  Object.entries(numberAliases).forEach(([source, target]) => {
    if (Number.isFinite(Number(runtime[source]))) out[target] = Number(runtime[source]);
  });
  const textAliases = {
    task_fps_semantics: "perf_det_task_fps_semantics",
    cycle_fps_semantics: "perf_det_cycle_fps_semantics",
  };
  Object.entries(textAliases).forEach(([source, target]) => {
    if (runtime[source]) out[target] = runtime[source];
  });
  return out;
}

function normalizePlateDetectorModelFields(body, detectorRuntime = null) {
  const root = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const runtime = detectorRuntime && typeof detectorRuntime === "object" ? detectorRuntime : {};
  const pcie = root.pcie_plate_inference && typeof root.pcie_plate_inference === "object" && !Array.isArray(root.pcie_plate_inference)
    ? root.pcie_plate_inference
    : {};
  const out = {};
  const model = normalizeDetectorModelCode(root.plate_detector_model);
  const configuredModel = normalizeDetectorModelCode(root.plate_detector_configured_model);
  if (model !== null) out.plate_detector_model = model;
  if (configuredModel !== null) out.plate_detector_configured_model = configuredModel;

  const activeModel = normalizeInferenceEnum(root.plate_detector_active_model, 96);
  if (activeModel) out.plate_detector_active_model = activeModel;
  const modelReady = typeof root.plate_detector_model_ready === "boolean"
    ? root.plate_detector_model_ready
    : runtime.model_ready;
  const recognizerReady = typeof root.plate_recognizer_model_ready === "boolean"
    ? root.plate_recognizer_model_ready
    : runtime.recognizer_ready;
  if (typeof modelReady === "boolean") out.plate_detector_model_ready = modelReady;
  if (typeof recognizerReady === "boolean") out.plate_recognizer_model_ready = recognizerReady;

  const modelError = typeof root.plate_detector_model_error === "string"
    ? root.plate_detector_model_error
    : typeof runtime.model_error === "string"
      ? runtime.model_error
      : undefined;
  const recognizerError = typeof root.plate_recognizer_model_error === "string"
    ? root.plate_recognizer_model_error
    : typeof runtime.recognizer_error === "string"
      ? runtime.recognizer_error
      : undefined;
  if (modelError !== undefined) out.plate_detector_model_error = String(modelError).trim().slice(0, 500);
  if (recognizerError !== undefined) out.plate_recognizer_model_error = String(recognizerError).trim().slice(0, 500);

  putDriverText(out, "plate_detector_configured_model_file", root.plate_detector_configured_model_file || runtime.configured_model_file, 512);
  putDriverText(out, "plate_detector_model_name", root.plate_detector_model_name || runtime.model_name, 160);
  putDriverText(out, "plate_detector_model_path", root.plate_detector_model_path || runtime.model_path, 1024);
  putDriverText(out, "plate_recognizer_model_name", root.plate_recognizer_model_name || runtime.recognizer_name, 160);
  putDriverText(out, "plate_recognizer_model_path", root.plate_recognizer_model_path || runtime.recognizer_path, 1024);
  putDriverText(out, "plate_detector_input", root.plate_detector_input || runtime.model_input, 160);
  putDriverText(out, "plate_detector_postprocess", root.plate_detector_postprocess || runtime.postprocess_contract, 320);
  putDriverText(out, "detector_profile", root.detector_profile || pcie.detector_profile || runtime.detector_profile, 120);
  putDriverText(out, "detector_family", root.detector_family || pcie.detector_family || runtime.detector_family, 120);
  putDriverText(out, "detector_model_name", root.detector_model_name || runtime.detector_model_name || root.plate_detector_model_name, 160);
  putDriverText(out, "detector_input_type", root.detector_input_type || runtime.detector_input_type, 120);
  putDriverText(
    out,
    "detector_output_contract",
    root.detector_output_contract || pcie.detector_output_contract || runtime.detector_output_contract || root.plate_detector_postprocess,
    600,
  );
  putDriverText(out, "detector_runtime_backend", root.detector_runtime_backend || runtime.detector_runtime_backend, 120);
  putDriverText(out, "recognizer_profile", root.recognizer_profile || runtime.recognizer_profile, 120);
  putDriverText(out, "recognizer_output_contract", root.recognizer_output_contract || runtime.recognizer_output_contract, 600);
  putDriverText(out, "recognizer_input_format", root.recognizer_input_format || runtime.recognizer_input_format, 120);
  putDriverText(out, "recognizer_text_layout", root.recognizer_text_layout || runtime.recognizer_text_layout, 160);
  putDriverText(out, "recognizer_runtime_backend", root.recognizer_runtime_backend || runtime.recognizer_runtime_backend, 120);
  const putBoundedInt = (key, value, max) => {
    const normalized = normalizeInferenceNumber(value, true);
    if (normalized !== null && normalized <= max) out[key] = normalized;
  };
  putBoundedInt("detector_profile_id", root.detector_profile_id ?? runtime.detector_profile_id, 4);
  putBoundedInt("detector_input_width", root.detector_input_width ?? runtime.detector_input_width, 16384);
  putBoundedInt("detector_input_height", root.detector_input_height ?? runtime.detector_input_height, 16384);
  putBoundedInt("recognizer_profile_id", root.recognizer_profile_id ?? runtime.recognizer_profile_id, 2);
  putBoundedInt("recognizer_input_width", root.recognizer_input_width ?? runtime.recognizer_input_width, 16384);
  putBoundedInt("recognizer_input_height", root.recognizer_input_height ?? runtime.recognizer_input_height, 16384);
  const modelInputWidth = normalizeInferenceNumber(root.plate_model_input_width ?? runtime.model_input_width ?? pcie.model_input_width, true);
  const modelInputHeight = normalizeInferenceNumber(root.plate_model_input_height ?? runtime.model_input_height ?? pcie.model_input_height, true);
  if (modelInputWidth !== null && modelInputWidth <= 16384) out.plate_model_input_width = modelInputWidth;
  if (modelInputHeight !== null && modelInputHeight <= 16384) out.plate_model_input_height = modelInputHeight;
  putDriverText(out, "plate_model_input_format", root.plate_model_input_format || runtime.model_input_format || pcie.model_input_format, 80);
  return Object.keys(out).length ? out : null;
}

function normalizeRkPlateEventMetadata(body, context = {}) {
  const root = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const status = context.status && typeof context.status === "object" && !Array.isArray(context.status) ? context.status : {};
  const pcie = status.pcie_plate_inference && typeof status.pcie_plate_inference === "object" && !Array.isArray(status.pcie_plate_inference)
    ? status.pcie_plate_inference
    : {};
  const statusRuntime = status.plate_detector_runtime && typeof status.plate_detector_runtime === "object" && !Array.isArray(status.plate_detector_runtime)
    ? status.plate_detector_runtime
    : pcie.detector_runtime && typeof pcie.detector_runtime === "object" && !Array.isArray(pcie.detector_runtime)
      ? pcie.detector_runtime
      : {};
  const out = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(root, key);
  const putText = (key, value, maxLen, { keepEmpty = false } = {}) => {
    const normalized = cleanUserTemplate(value, maxLen);
    if (normalized || keepEmpty) out[key] = normalized;
  };
  const putInt = (key, value, min, max) => {
    if (value === null || value === undefined || value === "") return;
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    const normalized = Math.floor(number);
    if (normalized >= min && normalized <= max) out[key] = normalized;
  };
  const putNumber = (key, value, min = 0) => {
    const normalized = normalizeInferenceNumber(value, false, min);
    if (normalized !== null) out[key] = normalized;
  };
  const putBool = (key, ...values) => {
    const value = values.find((candidate) => typeof candidate === "boolean");
    if (typeof value === "boolean") out[key] = value;
  };

  putText("role", root.role, 40);
  putText("event_schema", root.event_schema || context.default_event_schema, 120);
  const normalizedPlate = miniNormalizePlate(root.plate_normalized || context.plate || root.plate);
  if (normalizedPlate) out.plate_normalized = normalizedPlate;

  const source = String(context.source || root.source || "").trim();
  const sourceMatch = source.match(/^(?:src|scr|source)(\d+)$/i);
  const reportedSourceIndex = Number(root.source_index);
  if (Number.isInteger(reportedSourceIndex) && reportedSourceIndex >= 1 && reportedSourceIndex <= 4) {
    out.source_index = reportedSourceIndex;
  } else if (sourceMatch) {
    putInt("source_index", sourceMatch[1], 1, 4);
  }

  if (has("plate_category_rule")) putText("plate_category_rule", root.plate_category_rule, 160, { keepEmpty: true });
  putText("plate_category_rule_version", root.plate_category_rule_version, 120);
  putText(
    "detector_model_name",
    root.detector_model_name || root.plate_detector_model_name || status.detector_model_name || status.plate_detector_model_name,
    160,
  );
  putText(
    "recognizer_model_name",
    root.recognizer_model_name || root.plate_recognizer_model_name || status.recognizer_model_name || status.plate_recognizer_model_name,
    160,
  );
  putText("detector_profile", root.detector_profile || status.detector_profile || pcie.detector_profile || statusRuntime.detector_profile, 120);
  putInt("detector_profile_id", root.detector_profile_id ?? status.detector_profile_id ?? statusRuntime.detector_profile_id, 0, 4);
  putText("detector_family", root.detector_family || status.detector_family || pcie.detector_family || statusRuntime.detector_family, 120);
  putText(
    "detector_output_contract",
    root.detector_output_contract || status.detector_output_contract || pcie.detector_output_contract || statusRuntime.detector_output_contract,
    600,
  );
  putText("detector_runtime_backend", root.detector_runtime_backend || status.detector_runtime_backend || statusRuntime.detector_runtime_backend, 120);
  putText("recognizer_profile", root.recognizer_profile || status.recognizer_profile || statusRuntime.recognizer_profile, 120);
  putInt("recognizer_profile_id", root.recognizer_profile_id ?? status.recognizer_profile_id ?? statusRuntime.recognizer_profile_id, 0, 2);
  putText(
    "recognizer_output_contract",
    root.recognizer_output_contract || status.recognizer_output_contract || statusRuntime.recognizer_output_contract,
    600,
  );
  putInt("recognizer_input_width", root.recognizer_input_width ?? status.recognizer_input_width ?? statusRuntime.recognizer_input_width, 0, 16384);
  putInt("recognizer_input_height", root.recognizer_input_height ?? status.recognizer_input_height ?? statusRuntime.recognizer_input_height, 0, 16384);
  putText("recognizer_input_format", root.recognizer_input_format || status.recognizer_input_format || statusRuntime.recognizer_input_format, 120);
  putText("recognizer_text_layout", root.recognizer_text_layout || status.recognizer_text_layout || statusRuntime.recognizer_text_layout, 160);
  putText("recognizer_runtime_backend", root.recognizer_runtime_backend || status.recognizer_runtime_backend || statusRuntime.recognizer_runtime_backend, 120);
  putInt(
    "model_input_width",
    root.model_input_width ?? root.plate_model_input_width ?? status.plate_model_input_width ?? pcie.model_input_width,
    0,
    16384,
  );
  putInt(
    "model_input_height",
    root.model_input_height ?? root.plate_model_input_height ?? status.plate_model_input_height ?? pcie.model_input_height,
    0,
    16384,
  );
  putText(
    "model_input_format",
    root.model_input_format || root.plate_model_input_format || status.plate_model_input_format || pcie.model_input_format,
    80,
  );

  const inferenceStrategy = normalizeInferenceEnum(
    root.inference_strategy || status.plate_inference_strategy || status.pcie_plate_inference_strategy || pcie.strategy,
  );
  if (inferenceStrategy) out.inference_strategy = inferenceStrategy;
  putInt(
    "inference_task_count",
    root.inference_task_count ?? root.perf_det_task_count ?? root.plate_inference_calls_per_cycle ?? status.perf_det_task_count ?? status.plate_detector_runtime?.task_count,
    0,
    100000,
  );
  putBool("inference_pipeline_active", root.inference_pipeline_active, root.plate_inference_pipeline_active, status.plate_inference_pipeline_active);
  putBool("inference_capture_async", root.inference_capture_async, root.plate_capture_async, status.plate_capture_async, statusRuntime.capture_async);
  putBool("inference_latest_only", root.inference_latest_only, root.plate_latest_only, status.plate_latest_only, statusRuntime.latest_only);
  putInt("inference_queue_depth", root.inference_queue_depth ?? root.perf_det_queue_depth ?? status.perf_det_queue_depth ?? statusRuntime.queue_depth, 0, 1_000_000);
  putInt("inference_dropped_tasks", root.inference_dropped_tasks ?? root.perf_det_dropped_tasks ?? status.perf_det_dropped_tasks ?? statusRuntime.dropped_tasks, 0, Number.MAX_SAFE_INTEGER);
  putNumber("inference_result_age_ms", root.inference_result_age_ms ?? root.perf_det_result_age_ms ?? status.perf_det_result_age_ms ?? statusRuntime.result_age_ms);
  putNumber("display_fps", root.display_fps ?? root.perf_display_fps ?? status.perf_display_fps ?? statusRuntime.display_fps);
  putNumber("inference_pre_ms", root.inference_pre_ms ?? root.perf_det_pre_ms ?? status.perf_det_pre_ms ?? statusRuntime.pre_ms);
  putNumber("inference_npu_ms", root.inference_npu_ms ?? root.inference_npu_wall_ms ?? root.perf_det_npu_wall_ms ?? status.perf_det_npu_wall_ms ?? statusRuntime.npu_wall_ms);
  putNumber("inference_post_ms", root.inference_post_ms ?? root.perf_det_post_ms ?? status.perf_det_post_ms ?? statusRuntime.post_ms);

  putInt("source_frame_width", root.source_frame_width ?? root.source_width ?? pcie.source_frame_width ?? pcie.source_width, 0, 65536);
  putInt("source_frame_height", root.source_frame_height ?? root.source_height ?? pcie.source_frame_height ?? pcie.source_height, 0, 65536);
  putText("source_frame_format", root.source_frame_format || pcie.source_frame_format, 80);
  putText("source_layout", root.source_layout || pcie.source_layout, 40);
  putInt("source_mask", root.source_mask ?? root.pcie_source_mask ?? pcie.source_mask, 0, 15);
  putBool("pcie_sliding_enabled", root.pcie_sliding_enabled, root.pcie_four_source_sliding_configured, pcie.pcie_sliding_enabled);
  return out;
}

function captureMetricsDropRate(completeFrames, droppedFrames) {
  const complete = Number(completeFrames);
  const dropped = Number(droppedFrames);
  if (!Number.isFinite(complete) || !Number.isFinite(dropped) || complete < 0 || dropped < 0) return null;
  const total = complete + dropped;
  if (total <= 0) return 0;
  return Number(((dropped / total) * 100).toFixed(4));
}

function buildRkCaptureMetricsSample(metrics, meta = {}) {
  if (!metrics || typeof metrics !== "object") return null;
  const completeFrames = cleanDriverNumber(metrics.complete_frames);
  const droppedFrames = cleanDriverNumber(metrics.dropped_frames);
  return {
    sample_id: cleanDriverText(meta.sample_id, 64) || randomUUID(),
    time_bj: cleanDriverText(meta.time_bj || nowBjText(), 32),
    sample_at_ms: Number(meta.sample_at_ms) || Date.now(),
    device: cleanDriverText(meta.device || "rk3568", 64),
    input_mode: cleanDriverText(meta.input_mode, 24),
    running: typeof metrics.running === "boolean" ? metrics.running : null,
    metric_valid: typeof metrics.metric_valid === "boolean" ? metrics.metric_valid : null,
    pcie_rx_fps: cleanDriverNumber(metrics.actual_rx_fps),
    pcie_frame_interval_ms: cleanDriverNumber(metrics.frame_interval_ms),
    pcie_dma_ms: cleanDriverNumber(metrics.dma_transfer_ms),
    pcie_dma_wait_ms: cleanDriverNumber(metrics.dma_wait_ms),
    pcie_dma_wait_avg_ms: cleanDriverNumber(metrics.dma_wait_avg_ms),
    pcie_dma_wait_max_ms: cleanDriverNumber(metrics.dma_wait_max_ms),
    pcie_dma_wait_window_ms: cleanDriverNumber(metrics.dma_wait_window_ms),
    pcie_dma_wait_sample_count: cleanDriverNumber(metrics.dma_wait_sample_count),
    pcie_user_copy_ms: cleanDriverNumber(metrics.user_copy_ms),
    pcie_rx_frames: completeFrames == null ? null : Math.max(0, Math.floor(completeFrames)),
    pcie_dropped_frames: droppedFrames == null ? null : Math.max(0, Math.floor(droppedFrames)),
    drop_rate_pct: captureMetricsDropRate(completeFrames, droppedFrames),
    metric_source: cleanDriverText(meta.metric_source, 80),
    dma_unit_bytes: cleanDriverNumber(metrics.dma_unit_bytes),
    dma_units_per_frame: cleanDriverNumber(metrics.dma_units_per_frame),
    batch_ioctl: typeof metrics.batch_ioctl === "boolean" ? metrics.batch_ioctl : null,
    irq_wait: typeof metrics.irq_wait === "boolean" ? metrics.irq_wait : null,
    irq_fallback: typeof metrics.irq_fallback === "boolean" ? metrics.irq_fallback : null,
    metric_basis: cleanDriverText(metrics.metric_basis, 120),
    last_frame_at: cleanDriverText(metrics.last_frame_at, 120),
    last_error: cleanDriverText(metrics.last_error, 500),
  };
}

function mergeRkCaptureMetricsItems(sourceLists, limit) {
  const merged = new Map();
  let fallback = 0;
  for (const source of sourceLists) {
    for (const item of Array.isArray(source) ? source : []) {
      if (!item || typeof item !== "object") continue;
      const key = String(item.sample_id || "") || `${item.sample_at_ms || ""}\u0000${item.time_bj || ""}\u0000${fallback++}`;
      if (!merged.has(key)) merged.set(key, { ...item });
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => Number(b.sample_at_ms || 0) - Number(a.sample_at_ms || 0) || String(b.time_bj || "").localeCompare(String(a.time_bj || "")))
    .slice(0, limit)
    .reverse();
}

function normalizeDriverDmaMemory(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  ["cma_total_kb", "cma_free_kb", "cma_minimum_kb", "cma_recommended_kb"].forEach((key) => {
    const value = raw[key];
    if (value === null || value === undefined || value === "" || typeof value === "boolean" || typeof value === "object") return;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) out[key] = Math.floor(number);
  });
  ["cma_sufficient", "cma_recommended"].forEach((key) => putDriverBool(out, key, raw[key]));
  if (typeof raw.kernel_cmdline === "string") putDriverText(out, "kernel_cmdline", raw.kernel_cmdline, 2000);
  return Object.keys(out).length ? out : null;
}

function normalizeDriverStatus(raw, captureMetricsOverride = null) {
  if ((!raw || typeof raw !== "object" || Array.isArray(raw)) && !captureMetricsOverride) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
  const out = {};
  putDriverText(out, "schema", raw.schema, 120);
  putDriverText(out, "time_local", raw.time_local, 80);
  putDriverText(out, "module_name", raw.module_name, 120);
  putDriverBool(out, "mounted", raw.mounted);
  const dmaMemory = normalizeDriverDmaMemory(raw.dma_memory);
  if (dmaMemory) out.dma_memory = dmaMemory;

  if (raw.device_node && typeof raw.device_node === "object") {
    const node = {};
    putDriverText(node, "path", raw.device_node.path, 500);
    putDriverBool(node, "exists", raw.device_node.exists);
    putDriverText(node, "permissions", raw.device_node.permissions, 80);
    if (Object.keys(node).length) out.device_node = node;
  }

  if (raw.module && typeof raw.module === "object") {
    const mod = {};
    putDriverText(mod, "name", raw.module.name, 120);
    putDriverBool(mod, "loaded", raw.module.loaded);
    putDriverText(mod, "version", raw.module.version, 120);
    if (Object.keys(mod).length) out.module = mod;
  }

  if (raw.cpu && typeof raw.cpu === "object") {
    const cpu = {};
    putDriverText(cpu, "usage_text", raw.cpu.usage_text, 120);
    putDriverNumber(cpu, "usage_percent", raw.cpu.usage_percent);
    const policies = Array.isArray(raw.cpu.policies)
      ? raw.cpu.policies.map(normalizeDriverFreqDevice).filter(Boolean).slice(0, 32)
      : [];
    if (policies.length) cpu.policies = policies;
    if (Object.keys(cpu).length) out.cpu = cpu;
  }

  ["gpu", "npu"].forEach((kind) => {
    const src = raw[kind];
    if (!src || typeof src !== "object") return;
    const devices = Array.isArray(src.devices) ? src.devices.map(normalizeDriverFreqDevice).filter(Boolean).slice(0, 32) : [];
    if (devices.length) out[kind] = { devices };
  });

  const captureMetrics = normalizeDriverCaptureMetrics(
    captureMetricsOverride,
    raw.capture_metrics,
    raw.pcie?.capture_metrics,
  );
  if (captureMetrics) out.capture_metrics = captureMetrics;

  if (raw.interrupt && typeof raw.interrupt === "object") {
    const it = {};
    putDriverBool(it, "found", raw.interrupt.found);
    putDriverText(it, "raw", raw.interrupt.raw, 1600);
    putDriverNumber(it, "irq", raw.interrupt.irq);
    putDriverNumber(it, "sum", raw.interrupt.sum);
    if (Array.isArray(raw.interrupt.per_cpu)) {
      it.per_cpu = raw.interrupt.per_cpu.map((v) => cleanDriverNumber(v)).filter((v) => v !== null).slice(0, 64);
    }
    putDriverText(it, "type", raw.interrupt.type, 120);
    putDriverText(it, "controller", raw.interrupt.controller, 120);
    putDriverText(it, "hwirq", raw.interrupt.hwirq, 120);
    putDriverText(it, "trigger", raw.interrupt.trigger, 120);
    putDriverText(it, "name", raw.interrupt.name, 180);
    putDriverNumber(it, "delta", raw.interrupt.delta);
    putDriverNumber(it, "rate_per_sec", raw.interrupt.rate_per_sec);
    if (Object.keys(it).length) out.interrupt = it;
  }

  if (raw.pcie && typeof raw.pcie === "object") {
    const pcie = {};
    putDriverNumber(pcie, "bound_count", raw.pcie.bound_count);
    if (captureMetrics) pcie.capture_metrics = captureMetrics;
    if (Array.isArray(raw.pcie.devices)) {
      pcie.devices = raw.pcie.devices
        .slice(0, 64)
        .map((dev) => {
          const d = dev && typeof dev === "object" ? dev : {};
          const row = {};
          ["bdf", "vendor", "device", "class", "irq", "enable"].forEach((k) => putDriverText(row, k, d[k], 160));
          if (d.link && typeof d.link === "object") {
            const link = {};
            ["current_speed", "current_width", "max_speed", "max_width"].forEach((k) => putDriverText(link, k, d.link[k], 160));
            if (Object.keys(link).length) row.link = link;
          }
          if (d.capability && typeof d.capability === "object") {
            const cap = {};
            putDriverBool(cap, "pcie_present", d.capability.pcie_present);
            putDriverNumber(cap, "mps_bytes", d.capability.mps_bytes);
            putDriverText(cap, "mps", d.capability.mps, 80);
            putDriverNumber(cap, "mrrs_bytes", d.capability.mrrs_bytes);
            putDriverText(cap, "mrrs", d.capability.mrrs, 80);
            if (Object.keys(cap).length) row.capability = cap;
          }
          if (d.msi && typeof d.msi === "object") {
            const msi = {};
            putDriverBool(msi, "present", d.msi.present);
            putDriverBool(msi, "enabled", d.msi.enabled);
            putDriverNumber(msi, "mmc", d.msi.mmc);
            putDriverNumber(msi, "mme", d.msi.mme);
            if (Object.keys(msi).length) row.msi = msi;
          }
          return Object.keys(row).length ? row : null;
        })
        .filter(Boolean);
    }
    if (Object.keys(pcie).length) out.pcie = pcie;
  }

  if (Array.isArray(raw.suggestions)) {
    out.suggestions = raw.suggestions.map((v) => cleanDriverText(v, 500)).filter(Boolean).slice(0, 100);
  }
  const rows = normalizeDriverRows(raw.rows);
  if (rows.length) out.rows = rows;

  return Object.keys(out).length ? out : null;
}

function deviceInfoRow(category, item, value, detail = "") {
  return {
    category: cleanDriverText(category, 80) || "设备",
    item: cleanDriverText(item, 180) || "—",
    value: value === null || value === undefined || value === "" ? "—" : cleanDriverText(value, 500),
    detail: cleanDriverText(detail, 1600),
  };
}

function formatRkInputMode(inputMode) {
  const mode = String(inputMode || "").trim().toLowerCase();
  if (mode === "sdcard") return "SD卡输入";
  if (mode === "pcie") return "PCIe输入";
  return "未知";
}

function fmtDeviceAge(ms) {
  if (ms === null || ms === undefined || ms === "") return "—";
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${Math.round(n / 1000)}s`;
  if (n < 3_600_000) return `${Math.round(n / 60_000)}min`;
  return `${Math.round(n / 3_600_000)}h`;
}

function readHostCpuTotals() {
  try {
    const cpus = os.cpus();
    if (!Array.isArray(cpus) || !cpus.length) return null;
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
      const times = cpu?.times || {};
      const cpuIdle = Number(times.idle || 0);
      const cpuTotal = Object.values(times).reduce((sum, value) => sum + Number(value || 0), 0);
      idle += cpuIdle;
      total += cpuTotal;
    }
    return {
      idle,
      total,
      cores: cpus.length,
      model: cleanDriverText(cpus[0]?.model || "", 180),
    };
  } catch {
    return null;
  }
}

const backendResourceSampleState = {
  hostCpu: readHostCpuTotals(),
  processCpu: process.cpuUsage(),
  processAtNs: process.hrtime.bigint(),
  cacheAtMs: 0,
  cache: null,
};

function resourcePercent(used, total) {
  const usedNumber = Number(used);
  const totalNumber = Number(total);
  if (!Number.isFinite(usedNumber) || !Number.isFinite(totalNumber) || totalNumber <= 0) return null;
  return Number(Math.max(0, Math.min(100, (usedNumber / totalNumber) * 100)).toFixed(1));
}

function backendDiskUsage() {
  try {
    if (typeof fs.statfsSync !== "function") return null;
    const stat = fs.statfsSync(logRoot);
    const blockSize = Number(stat?.bsize || stat?.frsize || 0);
    const blocks = Number(stat?.blocks || 0);
    const availableBlocks = Number(stat?.bavail ?? stat?.bfree ?? 0);
    const totalBytes = blockSize * blocks;
    const availableBytes = blockSize * availableBlocks;
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    return {
      path: logRoot,
      total_bytes: Math.round(totalBytes),
      used_bytes: Math.round(usedBytes),
      available_bytes: Math.round(availableBytes),
      usage_pct: resourcePercent(usedBytes, totalBytes),
    };
  } catch {
    return null;
  }
}

function sampleBackendResources() {
  const nowMs = Date.now();
  if (backendResourceSampleState.cache && nowMs - backendResourceSampleState.cacheAtMs < 500) {
    return backendResourceSampleState.cache;
  }

  const hostCpu = readHostCpuTotals();
  const previousHostCpu = backendResourceSampleState.hostCpu;
  let hostCpuUsagePct = null;
  if (hostCpu && previousHostCpu) {
    const totalDelta = hostCpu.total - previousHostCpu.total;
    const idleDelta = hostCpu.idle - previousHostCpu.idle;
    if (totalDelta > 0) hostCpuUsagePct = Number(Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)).toFixed(1));
  }
  backendResourceSampleState.hostCpu = hostCpu;

  const processAtNs = process.hrtime.bigint();
  const processCpu = process.cpuUsage();
  const elapsedUs = Number(processAtNs - backendResourceSampleState.processAtNs) / 1000;
  const processCpuUs = Math.max(
    0,
    Number(processCpu.user || 0) - Number(backendResourceSampleState.processCpu.user || 0) +
      Number(processCpu.system || 0) - Number(backendResourceSampleState.processCpu.system || 0),
  );
  const cores = Math.max(1, Number(hostCpu?.cores || os.cpus()?.length || 1));
  const processCpuUsagePct = elapsedUs > 0
    ? Number(Math.max(0, Math.min(100, (processCpuUs / elapsedUs / cores) * 100)).toFixed(1))
    : null;
  backendResourceSampleState.processAtNs = processAtNs;
  backendResourceSampleState.processCpu = processCpu;

  const totalMemory = Number(os.totalmem() || 0);
  const freeMemory = Number(os.freemem() || 0);
  const usedMemory = Math.max(0, totalMemory - freeMemory);
  const processMemory = process.memoryUsage();
  const loadAverage = os.loadavg().map((value) => Number(Number(value || 0).toFixed(2)));
  const resources = {
    sampled_at_ms: nowMs,
    cpu: {
      usage_pct: hostCpuUsagePct,
      process_usage_pct: processCpuUsagePct,
      cores,
      model: hostCpu?.model || "",
      load_1m: loadAverage[0] ?? null,
      load_5m: loadAverage[1] ?? null,
      load_15m: loadAverage[2] ?? null,
    },
    memory: {
      total_bytes: totalMemory,
      used_bytes: usedMemory,
      free_bytes: freeMemory,
      usage_pct: resourcePercent(usedMemory, totalMemory),
    },
    process: {
      rss_bytes: Number(processMemory.rss || 0),
      heap_used_bytes: Number(processMemory.heapUsed || 0),
      heap_total_bytes: Number(processMemory.heapTotal || 0),
      external_bytes: Number(processMemory.external || 0),
      rss_host_pct: resourcePercent(processMemory.rss, totalMemory),
    },
    disk: backendDiskUsage(),
  };
  backendResourceSampleState.cacheAtMs = nowMs;
  backendResourceSampleState.cache = resources;
  return resources;
}

function buildBackendStatus(req = null) {
  const listenPort = Number(req?.socket?.localPort || process.env.PORT || 8080) || 8080;
  return {
    ok: true,
    online: true,
    service: "rk-http-backend",
    hostname: os.hostname(),
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    node_version: process.version,
    pid: process.pid,
    started_at: startedAt,
    uptime_s: Math.round(process.uptime()),
    host_uptime_s: Math.round(os.uptime()),
    listen_port: listenPort,
    host: String(req?.headers?.host || ""),
    resources: sampleBackendResources(),
    database: {
      mysql: mysqlPublicStatus(),
    },
  };
}

function fmtCaptureMetric(value, unit = "", digits = 2) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const text = Number.isInteger(n) && digits === 0 ? String(n) : n.toFixed(digits);
  return unit ? `${text} ${unit}` : text;
}

function captureFlagText(value) {
  return value === true ? "启用" : value === false ? "未启用" : "未知";
}

function formatCaptureHex(textValue, numberValue, width = 8) {
  const raw = String(textValue || "").trim();
  if (/^0x[0-9a-f]+$/i.test(raw)) return `0x${raw.slice(2).toUpperCase()}`;
  const number = Number(numberValue);
  if (!Number.isFinite(number) || number < 0) return raw || "—";
  return `0x${Math.floor(number).toString(16).toUpperCase().padStart(width, "0")}`;
}

function formatFpgaTargetFps(value) {
  const milliFps = Number(value);
  return Number.isFinite(milliFps) && milliFps >= 0 ? `${(milliFps / 1000).toFixed(3)} FPS` : "—";
}

function formatPcieSourceMask(metrics) {
  const mask = Number(metrics?.source_mask);
  const hex = formatCaptureHex(metrics?.source_mask_hex, mask);
  if (!Number.isFinite(mask) || mask < 0) return hex;
  const normalized = Math.floor(mask);
  const sources = [0, 1, 2, 3].filter((bit) => (normalized & (1 << bit)) !== 0).map((bit) => `SRC${bit + 1}`);
  return `${hex} · ${sources.length ? sources.join(" / ") : "无有效源"}`;
}

function formatInferenceFrameSize(width, height) {
  const w = Number(width);
  const h = Number(height);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? `${Math.floor(w)} × ${Math.floor(h)}` : "—";
}

function formatPcieInferenceStrategy(strategy) {
  const labels = {
    mosaic_single: "四路拼接整图单次推理",
    per_source_full: "四路独立推理",
    overlap_hybrid: "重叠双窗边界恢复",
    four_source_sliding: "四路分别滑窗",
    mosaic_letterbox_single: "整图补边单次推理",
    single_source: "PCIe 单路推理",
    sd_static: "SD 静态图片推理",
    inactive: "当前未启用",
  };
  return labels[String(strategy || "")] || "尚未上报";
}

function describePcieInferenceStrategy(strategy) {
  const descriptions = {
    mosaic_single: "2560×1440 四路拼接图等比缩放到模型输入，每轮执行一次 YOLO",
    per_source_full: "四个 1280×720 物理源分别缩放并推理，结果映射回原始拼接画面",
    overlap_hybrid: "四路各执行基础检测，并在同帧重叠窗口和原图联合 ROI 中恢复跨边界车牌",
    four_source_sliding: "SRC1-SRC4 分别按窗口扫描，减少整张拼接图缩小造成的小车牌信息损失",
    mosaic_letterbox_single: "整张拼接图补黑边后缩放到模型输入尺寸，每帧执行一次推理",
    single_source: "仅对当前 PCIe 单路画面执行车牌推理",
    sd_static: "SD 静态图片沿用静态图片检测策略",
    inactive: "当前输入源或显示模式没有执行车牌推理",
  };
  return descriptions[String(strategy || "")] || "RK 尚未返回最近一次实际推理策略";
}

function formatConfiguredPcieStrategy(value) {
  const number = Number(value);
  if (number === 0) return "整图单次推理";
  if (number === 1) return "四路独立推理";
  if (number === 2) return "重叠双窗边界恢复";
  return "未知";
}

function formatDetectorModel(value, fallback = "") {
  const number = normalizeDetectorModelCode(value);
  if (number === 0) return "YOLOv5（兼容模型）";
  if (number === 1) return "Pose26";
  const text = String(fallback || "").trim();
  if (/pose[_-]?26/i.test(text)) return "Pose26";
  if (/yolo[_-]?v?5|legacy/i.test(text)) return "YOLOv5（兼容模型）";
  return text || "未知";
}

function formatDetectorInputContract(value) {
  const text = String(value || "").trim();
  if (text === "640x640_rgb_uint8_nhwc") return "640 × 640 · RGB uint8 NHWC";
  if (text === "1280x720_rgb_uint8_nhwc") return "1280 × 720 · RGB uint8 NHWC";
  return text || "未知";
}

function formatDetectorOutputMode(value, quantizedOutput) {
  const text = String(value || "").trim();
  if (text) return text;
  if (quantizedOutput === true) return "原生量化输出";
  if (quantizedOutput === false) return "浮点输出";
  return "未知";
}

function formatDetectorPreprocessBackend(value) {
  const labels = { rga: "RGA 硬件加速", opencv: "OpenCV 软件处理", uninitialized: "尚未初始化" };
  return labels[String(value || "")] || "未知";
}

function formatConfiguredPreprocessBackend(value) {
  const number = Number(value);
  if (number === 0) return "自动选择";
  if (number === 1) return "OpenCV";
  if (number === 2) return "RGA";
  return "未知";
}

function formatPreprocessRequest(value) {
  return ({ auto: "自动选择", rga: "RGA", opencv: "OpenCV" })[String(value || "")] || "未知";
}

function formatPreprocessFallback(reason) {
  const text = String(reason || "");
  if (!text) return "无回退";
  if (text === "rga_not_compiled") return "RGA 未编译，已回退 OpenCV";
  if (text === "rga_resize_failed") return "RGA 缩放失败，已回退 OpenCV";
  return text;
}

function appendInferenceLetterboxRows(rows, category, contentItem, paddingItem, letterbox) {
  if (!letterbox || typeof letterbox !== "object") return;
  rows.push(
    deviceInfoRow(
      category,
      contentItem,
      formatInferenceFrameSize(letterbox.content_width, letterbox.content_height),
      `源画面=${formatInferenceFrameSize(letterbox.source_width, letterbox.source_height)}；模型=${formatInferenceFrameSize(letterbox.model_width, letterbox.model_height)}`,
    ),
    deviceInfoRow(
      category,
      paddingItem,
      `上 ${letterbox.pad_top ?? "—"} / 下 ${letterbox.pad_bottom ?? "—"} / 左 ${letterbox.pad_left ?? "—"} / 右 ${letterbox.pad_right ?? "—"}`,
      `填充值 RGB=${letterbox.pad_value_rgb ?? letterbox.pad_value_bgr ?? "—"}；允许放大=${captureFlagText(letterbox.scaleup)}`,
    ),
  );
}

function buildPciePlateInferenceDeviceRows(status) {
  const runtimeSettings = normalizeRkRuntimeSettings(status);
  const detectorRuntime = normalizePlateDetectorRuntime(status);
  const inference = normalizePciePlateInference(status, runtimeSettings, detectorRuntime);
  const modelFields = normalizePlateDetectorModelFields(status, detectorRuntime);
  if (!inference && !runtimeSettings && !detectorRuntime && !modelFields) return [];
  const value = inference || {};
  const detector = detectorRuntime || value.detector_runtime || {};
  const runtime = value.runtime && typeof value.runtime === "object" ? value.runtime : {};
  const configured = typeof value.configured_sliding === "boolean" ? value.configured_sliding : runtimeSettings?.pcie_four_source_sliding;
  const configuredStrategy = Number(value.configured_strategy ?? runtimeSettings?.pcie_inference_strategy);
  const detectorRuntimeSignals = [
    "executed",
    "pipeline_enabled",
    "pipeline_active",
    "task_count",
    "queue_depth",
    "dropped_tasks",
    "pre_ms",
    "npu_wall_ms",
    "npu_hw_ms",
    "post_ms",
    "e2e_ms",
    "cycle_fps",
    "cycle_ms",
  ];
  const hasModernDetectorRuntime = detectorRuntimeSignals.some((key) => Object.prototype.hasOwnProperty.call(detector, key));
  const modernProtocol = /_v(?:2|3)$/.test(String(value.schema || "").toLowerCase()) || Number.isFinite(configuredStrategy) || hasModernDetectorRuntime;
  const strategy = String(detector.strategy || value.strategy || "");
  const statusKnown = runtime.status_known;
  const active = runtime.active;
  const enabled = runtime.enabled;
  const legacyRuntimeValue = statusKnown === false
    ? "等待首次推理"
    : active === true
      ? "正在生效"
      : enabled === true
        ? "最近一次已启用"
        : enabled === false
          ? "最近一次未启用"
          : "状态未知";
  const windowCount = Number(runtime.window_count);
  const sourceCount = Number(value.source_count);
  const actualCallsPerCycle = Number(detector.task_count ?? status.perf_det_task_count ?? status.plate_inference_calls_per_cycle);
  const plannedCallsPerCycle = Number(value.planned_base_calls_per_cycle ?? value.calls_per_cycle);
  const modelCode = normalizeDetectorModelCode(status.plate_detector_model);
  const configuredModelCode = normalizeDetectorModelCode(status.plate_detector_configured_model);
  const activeModel = String(status.plate_detector_active_model || "").trim();
  const modelName = String(detector.detector_model_name || status.detector_model_name || detector.model_name || status.plate_detector_model_name || "").trim();
  const modelPath = String(detector.model_path || status.plate_detector_model_path || "").trim();
  const configuredModelFile = String(detector.configured_model_file || status.plate_detector_configured_model_file || "").trim();
  const modelReady = typeof detector.model_ready === "boolean" ? detector.model_ready : status.plate_detector_model_ready;
  const modelError = String(detector.model_error ?? status.plate_detector_model_error ?? "").trim();
  const recognizerReady = typeof detector.recognizer_ready === "boolean" ? detector.recognizer_ready : status.plate_recognizer_model_ready;
  const recognizerError = String(detector.recognizer_error ?? status.plate_recognizer_model_error ?? "").trim();
  const recognizerName = String(detector.recognizer_name || status.plate_recognizer_model_name || "").trim();
  const recognizerPath = String(detector.recognizer_path || status.plate_recognizer_model_path || "").trim();
  const modelInput = String(detector.model_input || status.plate_detector_input || "").trim();
  const modelInputWidth = detector.model_input_width ?? value.model_input_width ?? status.plate_model_input_width;
  const modelInputHeight = detector.model_input_height ?? value.model_input_height ?? status.plate_model_input_height;
  const modelInputFormat = String(detector.model_input_format || value.model_input_format || status.plate_model_input_format || "").trim();
  const detectorInputWidth = modelFields?.detector_input_width ?? detector.detector_input_width;
  const detectorInputHeight = modelFields?.detector_input_height ?? detector.detector_input_height;
  const detectorInputType = String(modelFields?.detector_input_type || detector.detector_input_type || "").trim();
  const detectorInputContract = detectorInputWidth !== undefined || detectorInputHeight !== undefined || detectorInputType
    ? `${formatInferenceFrameSize(detectorInputWidth, detectorInputHeight)}${detectorInputType ? ` · ${detectorInputType}` : ""}`
    : "";
  const postprocessContract = String(detector.postprocess_contract || status.plate_detector_postprocess || "").trim();
  const detectorProfile = String(modelFields?.detector_profile || value.detector_profile || detector.detector_profile || "").trim();
  const detectorProfileId = modelFields?.detector_profile_id ?? detector.detector_profile_id;
  const detectorFamily = String(modelFields?.detector_family || value.detector_family || detector.detector_family || "").trim();
  const detectorOutputContract = String(modelFields?.detector_output_contract || value.detector_output_contract || detector.detector_output_contract || "").trim();
  const detectorRuntimeBackend = String(modelFields?.detector_runtime_backend || detector.detector_runtime_backend || "").trim();
  const recognizerProfile = String(modelFields?.recognizer_profile || detector.recognizer_profile || "").trim();
  const recognizerProfileId = modelFields?.recognizer_profile_id ?? detector.recognizer_profile_id;
  const recognizerOutputContract = String(modelFields?.recognizer_output_contract || detector.recognizer_output_contract || "").trim();
  const recognizerInput = Number(modelFields?.recognizer_input_width) > 0 && Number(modelFields?.recognizer_input_height) > 0
    ? formatInferenceFrameSize(modelFields.recognizer_input_width, modelFields.recognizer_input_height)
    : "";
  const recognizerInputFormat = String(modelFields?.recognizer_input_format || detector.recognizer_input_format || "").trim();
  const recognizerTextLayout = String(modelFields?.recognizer_text_layout || detector.recognizer_text_layout || "").trim();
  const recognizerRuntimeBackend = String(modelFields?.recognizer_runtime_backend || detector.recognizer_runtime_backend || "").trim();
  const modelHasPayload = modelCode !== null
    || configuredModelCode !== null
    || typeof modelReady === "boolean"
    || Boolean(activeModel || modelName || modelPath || configuredModelFile || modelError || modelInput || modelInputWidth || modelInputHeight || modelInputFormat || detectorInputContract || postprocessContract || detector.output_mode || detectorProfile || detectorFamily || detectorOutputContract || detectorRuntimeBackend);
  const recognizerHasPayload = typeof recognizerReady === "boolean" || Boolean(recognizerName || recognizerPath || recognizerError || recognizerProfile || recognizerOutputContract || recognizerInput || recognizerInputFormat || recognizerTextLayout || recognizerRuntimeBackend);
  const recoveryExtraCalls = Number.isFinite(actualCallsPerCycle) && Number.isFinite(plannedCallsPerCycle)
    ? Math.max(0, Math.floor(actualCallsPerCycle) - Math.floor(plannedCallsPerCycle))
    : 0;
  const executionValue = typeof detector.executed === "boolean" ? (detector.executed ? "正在执行" : "当前未执行") : legacyRuntimeValue;
  const rows = [
    ...(modelHasPayload
      ? [
          deviceInfoRow(
            "检测模型",
            "当前模型",
            `${formatDetectorModel(modelCode, activeModel || modelName)}${modelName ? ` · ${modelName}` : ""}`,
            `active_model=${activeModel || "—"}；模型编号=${modelCode ?? "—"}`,
          ),
          ...(configuredModelCode !== null
            ? [deviceInfoRow("检测模型", "配置模型", formatDetectorModel(configuredModelCode), `配置编号=${configuredModelCode}`)]
            : []),
          ...(typeof modelReady === "boolean"
            ? [deviceInfoRow(
                "检测模型",
                "检测模型状态",
                modelReady ? "已就绪" : modelError ? "加载失败" : "未就绪",
                modelError ? `检测模型错误=${modelError}` : "检测模型已独立完成初始化检查",
              )]
            : []),
          ...(configuredModelFile
            ? [deviceInfoRow("检测模型", "配置模型文件", configuredModelFile, "运行设置当前选中的检测模型文件")]
            : []),
          ...(modelPath
            ? [deviceInfoRow("检测模型", "模型文件", modelPath, "最近一次推理实际使用的 RKNN 文件")]
            : []),
          ...(modelError
            ? [deviceInfoRow("检测模型", "检测模型错误", modelError, "仅表示检测模型加载或契约异常，与 OCR 状态相互独立")]
            : []),
          ...(modelInput
            ? [deviceInfoRow("检测模型", "输入契约", formatDetectorInputContract(modelInput), `原始值=${modelInput}`)]
            : []),
          ...(detectorInputContract
            ? [deviceInfoRow("检测模型", "检测输入契约", detectorInputContract, "detector_input_width/height/type；与通用 plate_model_input_* 分开保留")]
            : []),
          ...(postprocessContract
            ? [deviceInfoRow("检测模型", "后处理契约", postprocessContract, "模型输出对应的解码器契约")]
            : []),
          ...(detectorProfile || detectorFamily || detectorProfileId !== undefined
            ? [deviceInfoRow("检测模型", "模型 Profile", detectorProfile || "—", `ID=${detectorProfileId ?? "—"}；family=${detectorFamily || "—"}`)]
            : []),
          ...(detectorOutputContract || detectorRuntimeBackend
            ? [deviceInfoRow("检测模型", "输出与运行后端", detectorOutputContract || "—", `runtime=${detectorRuntimeBackend || "—"}`)]
            : []),
          ...(detector.output_mode || typeof detector.quantized_output === "boolean"
            ? [deviceInfoRow("检测模型", "输出模式", formatDetectorOutputMode(detector.output_mode, detector.quantized_output), `量化输出=${captureFlagText(detector.quantized_output)}`)]
            : []),
        ]
      : []),
    ...(recognizerHasPayload
      ? [
          ...(typeof recognizerReady === "boolean"
            ? [deviceInfoRow(
                "OCR 模型",
                "OCR 模型状态",
                recognizerReady ? "已就绪" : recognizerError ? "加载失败" : "未就绪",
                recognizerError ? `OCR 模型错误=${recognizerError}` : "OCR 文字与颜色识别模型已独立完成初始化检查",
              )]
            : []),
          ...(recognizerPath
            ? [deviceInfoRow("OCR 模型", "OCR 模型文件", recognizerPath, "RK3568 当前解析到的 OCR RKNN 模型路径")]
            : []),
          ...(recognizerName
            ? [deviceInfoRow("OCR 模型", "OCR 模型名称", recognizerName, "本次状态上报实际使用的 OCR 模型名")]
            : []),
          ...(recognizerProfile || recognizerProfileId !== undefined
            ? [deviceInfoRow("OCR 模型", "OCR Profile", recognizerProfile || "—", `ID=${recognizerProfileId ?? "—"}`)]
            : []),
          ...(recognizerInput || recognizerInputFormat || recognizerTextLayout
            ? [deviceInfoRow("OCR 模型", "OCR 输入契约", `${recognizerInput || "—"}${recognizerInputFormat ? ` · ${recognizerInputFormat}` : ""}`, `文本布局=${recognizerTextLayout || "—"}`)]
            : []),
          ...(recognizerOutputContract || recognizerRuntimeBackend
            ? [deviceInfoRow("OCR 模型", "OCR 输出与后端", recognizerOutputContract || "—", `runtime=${recognizerRuntimeBackend || "—"}`)]
            : []),
          ...(recognizerError
            ? [deviceInfoRow("OCR 模型", "OCR 模型错误", recognizerError, "仅影响文字与颜色识别，不改变检测模型就绪状态")]
            : []),
        ]
      : []),
    deviceInfoRow(
      "检测策略",
      "当前策略",
      formatPcieInferenceStrategy(strategy),
      `${describePcieInferenceStrategy(strategy)}${value.schema ? `；协议=${value.schema}` : ""}；输入=${value.input_mode || status.input_mode || "—"}；视图=${value.view || status.view || "—"}`,
    ),
    ...(runtimeSettings?.schema
      ? [deviceInfoRow("检测配置", "运行设置版本", runtimeSettings.schema, "按上报版本解析检测策略、流水线、前处理和量化输出设置")]
      : []),
    ...(status.runtime_settings_path
      ? [deviceInfoRow("检测配置", "运行设置文件", status.runtime_settings_path, "RK3568 当前加载的 runtime_settings.json 路径")]
      : []),
    ...(runtimeSettings && [runtimeSettings.plate_conf, runtimeSettings.env_conf, runtimeSettings.rec_conf_threshold].some((item) => item !== undefined)
      ? [deviceInfoRow(
          "检测配置",
          "识别阈值",
          `车牌=${runtimeSettings.plate_conf ?? "—"} / 环境=${runtimeSettings.env_conf ?? "—"}`,
          `OCR=${runtimeSettings.rec_conf_threshold ?? "—"}；最短边=${runtimeSettings.plate_min_short_edge ?? "—"}；清晰度=${runtimeSettings.plate_min_sharpness ?? "—"}`,
        )]
      : []),
    ...(runtimeSettings && [runtimeSettings.algo_mode, runtimeSettings.plate_infer_stride, runtimeSettings.plate_ocr_period].some((item) => item !== undefined)
      ? [deviceInfoRow(
          "检测配置",
          "调度与去重",
          `算法=${runtimeSettings.algo_mode ?? "—"} · 步长=${runtimeSettings.plate_infer_stride ?? "—"}`,
          `OCR周期=${runtimeSettings.plate_ocr_period ?? "—"}；按源去重=${captureFlagText(runtimeSettings.dedupe_by_source)}；稳定帧=${runtimeSettings.plate_stable_required ?? "—"}；冷却=${runtimeSettings.plate_cooldown_frames ?? "—"}`,
        )]
      : []),
    ...(runtimeSettings && [runtimeSettings.sd_image_interval_sec, runtimeSettings.env_infer_stride, runtimeSettings.plate_sliding_mode, runtimeSettings.plate_sliding_enabled].some((item) => item !== undefined)
      ? [deviceInfoRow(
          "检测配置",
          "采样与滑窗",
          `SD间隔=${runtimeSettings.sd_image_interval_sec ?? "—"}s · 环境步长=${runtimeSettings.env_infer_stride ?? "—"}`,
          `滑窗模式=${runtimeSettings.plate_sliding_mode ?? "—"}；滑窗=${captureFlagText(runtimeSettings.plate_sliding_enabled)}；四路滑窗=${captureFlagText(runtimeSettings.pcie_four_source_sliding)}`,
        )]
      : []),
    ...(runtimeSettings && [runtimeSettings.detector_profile, runtimeSettings.recognizer_profile, runtimeSettings.det_preprocess_backend].some((item) => item !== undefined)
      ? [deviceInfoRow(
          "检测配置",
          "模型配置",
          `检测=${runtimeSettings.detector_profile ?? "—"} · OCR=${runtimeSettings.recognizer_profile ?? "—"}`,
          `前处理=${runtimeSettings.det_preprocess_backend ?? "—"}；流水线=${captureFlagText(runtimeSettings.det_pipeline_enabled)}；量化直解=${captureFlagText(runtimeSettings.det_quantized_output)}`,
        )]
      : []),
    ...(runtimeSettings && [runtimeSettings.draw_overlay, runtimeSettings.plate_upload_thumb, runtimeSettings.env_enable].some((item) => item !== undefined)
      ? [deviceInfoRow(
          "检测配置",
          "显示与上传",
          `叠加=${captureFlagText(runtimeSettings.draw_overlay)} · 缩略图=${captureFlagText(runtimeSettings.plate_upload_thumb)}`,
          `文字=${captureFlagText(runtimeSettings.draw_text)}；分割线=${captureFlagText(runtimeSettings.draw_split)}；检测部件=${captureFlagText(runtimeSettings.show_det_parts)}；环境识别=${captureFlagText(runtimeSettings.env_enable)}；显示未确认=${captureFlagText(runtimeSettings.plate_show_unconfirmed)}；显示疑似=${captureFlagText(runtimeSettings.plate_show_suspected)}`,
        )]
      : []),
    ...(runtimeSettings && [runtimeSettings.black_v_max, runtimeSettings.white_s_max, runtimeSettings.blue_h_min, runtimeSettings.green_h_min, runtimeSettings.yellow_h_min, runtimeSettings.yellow_h_max].some((item) => item !== undefined)
      ? [deviceInfoRow(
          "检测配置",
          "颜色判定阈值",
          `黑V≤${runtimeSettings.black_v_max ?? "—"} · 白S≤${runtimeSettings.white_s_max ?? "—"}`,
          `蓝H≥${runtimeSettings.blue_h_min ?? "—"}；绿H≥${runtimeSettings.green_h_min ?? "—"}；黄H=${runtimeSettings.yellow_h_min ?? "—"}-${runtimeSettings.yellow_h_max ?? "—"}；可信V=${runtimeSettings.model_trust_val ?? "—"}；最小颜色占比=${runtimeSettings.min_color_ratio ?? "—"}`,
        )]
      : []),
    ...(runtimeSettings && [runtimeSettings.double_upper_ratio, runtimeSettings.double_lower_start].some((item) => item !== undefined)
      ? [deviceInfoRow(
          "检测配置",
          "双层车牌规则",
          `上层占比=${runtimeSettings.double_upper_ratio ?? "—"}`,
          `下层起点=${runtimeSettings.double_lower_start ?? "—"}；OCR置信阈值=${runtimeSettings.rec_conf_threshold ?? "—"}`,
        )]
      : []),
    ...(runtimeSettings && (runtimeSettings.theme || runtimeSettings.audio_output_device || runtimeSettings.target_device_id)
      ? [deviceInfoRow(
          "检测配置",
          "界面与目标设备",
          runtimeSettings.theme || "—",
          `音频=${runtimeSettings.audio_output_device || "—"}；目标=${runtimeSettings.target_device_id || "—"}`,
        )]
      : []),
    ...(Number.isFinite(configuredStrategy)
      ? [deviceInfoRow("检测配置", "配置策略", formatConfiguredPcieStrategy(configuredStrategy), `设置值=${Math.floor(configuredStrategy)}；0=整图单次，1=四路独立，2=重叠双窗边界恢复；兼容字段=${status.pcie_inference_strategy_configured ?? "—"}`)]
      : []),
    ...(Number.isFinite(Number(runtimeSettings?.pcie_overlap_window_width))
      ? [deviceInfoRow(
          "检测配置",
          "配置窗口宽度",
          `${Math.floor(Number(runtimeSettings.pcie_overlap_window_width))} px`,
          `实际窗口=${formatInferenceFrameSize(value.overlap_window_width, value.overlap_window_height)}；实际重叠=${value.overlap_pixels ?? "—"} px`,
        )]
      : []),
    ...(modernProtocol
      ? [
          deviceInfoRow(
            "检测配置",
            "ROI / 重叠窗口",
            value.fixed_roi_enabled === false && value.pcie_sliding_enabled === false ? "均未启用" : value.pcie_sliding_enabled === true ? "重叠窗口已启用" : "存在启用项",
            `fixed_roi_enabled=${captureFlagText(value.fixed_roi_enabled)}；pcie_sliding_enabled=${captureFlagText(value.pcie_sliding_enabled)}`,
          ),
        ]
      : []),
    ...(typeof configured === "boolean" && !modernProtocol
      ? [deviceInfoRow("PCIe推理", "四路滑窗配置", configured ? "已开启" : "已关闭", "v1 兼容字段；v2 不再使用滑窗策略")]
      : []),
    deviceInfoRow(
      "检测策略",
      "实际运行状态",
      executionValue,
      detectorRuntime
        ? `executed=${captureFlagText(detector.executed)}；采集=${captureFlagText(value.capture_running)}；适用=${captureFlagText(value.applicable)}；实际策略=${strategy || "—"}`
        : `状态已知=${captureFlagText(statusKnown)}；最近启用=${captureFlagText(enabled)}；当前生效=${captureFlagText(active)}；采集=${captureFlagText(value.capture_running)}；适用=${captureFlagText(value.applicable)}`,
    ),
    ...(Number.isFinite(actualCallsPerCycle)
      ? [deviceInfoRow(
          "检测策略",
          "实际检测调用",
          `${Math.max(0, Math.floor(actualCallsPerCycle))} 次`,
          recoveryExtraCalls > 0
            ? `较基础计划多 ${recoveryExtraCalls} 次，用于同帧边界恢复；来源=detector_runtime.task_count/perf_det_task_count`
            : "最近一轮实际完成的 YOLO 调用数；来源=detector_runtime.task_count/perf_det_task_count",
        )]
      : []),
    ...(Number.isFinite(plannedCallsPerCycle)
      ? [deviceInfoRow(
          "检测策略",
          "基础计划调用",
          `${Math.max(0, Math.floor(plannedCallsPerCycle))} 次`,
          `不含条件补窗和联合 ROI 复检；calls_per_cycle=${value.calls_per_cycle ?? "—"}`,
        )]
      : []),
    ...(value.overlap_window_width || value.overlap_window_height || value.overlap_pixels !== undefined
      ? [deviceInfoRow(
          "边界恢复",
          "重叠检测窗口",
          `${formatInferenceFrameSize(value.overlap_window_width, value.overlap_window_height)} · 重叠 ${value.overlap_pixels ?? "—"} px`,
          `调度阶段=${value.overlap_phase_count ?? "—"}；完整单路、左窗和右窗循环执行`,
        )]
      : []),
    ...(typeof value.fragment_companion_same_frame === "boolean" || typeof value.fragment_union_roi_redetect === "boolean"
      ? [deviceInfoRow(
          "边界恢复",
          "碎片闭环恢复",
          value.fragment_companion_same_frame === true && value.fragment_union_roi_redetect === true ? "同帧补检已启用" : "部分能力未启用",
          `相邻窗补跑=${captureFlagText(value.fragment_companion_same_frame)}；联合 ROI 复检=${captureFlagText(value.fragment_union_roi_redetect)}；每轮最多恢复 ${value.fragment_recovery_limit ?? "—"} 路`,
        )]
      : []),
    ...(Number.isFinite(windowCount)
      ? [
          deviceInfoRow(
            "PCIe推理",
            "每帧检测窗口",
            windowCount < 0 ? "等待首次推理" : `${Math.floor(windowCount)} 个`,
            `工作画面=${formatInferenceFrameSize(runtime.work_width, runtime.work_height)}；窗口=${formatInferenceFrameSize(runtime.window_width, runtime.window_height)}；步长=${formatInferenceFrameSize(runtime.stride_x, runtime.stride_y)}`,
          ),
        ]
      : []),
    ...(Number.isFinite(sourceCount) || Number.isFinite(Number(value.active_source_count)) || (value.source_width && value.source_height)
      ? [
          deviceInfoRow(
            "检测策略",
            "四路输入布局",
            `${Number.isFinite(sourceCount) ? `${Math.max(0, Math.floor(sourceCount))} 路` : "—"} · 单路 ${formatInferenceFrameSize(value.source_width, value.source_height)}`,
            [
              `生效=${Number.isFinite(Number(value.active_source_count)) ? Math.max(0, Math.floor(Number(value.active_source_count))) : "—"} 路`,
              `布局=${value.source_layout || "—"}`,
              `掩码=${value.source_mask ?? "—"}`,
              `序号=${Array.isArray(value.source_indices) ? value.source_indices.join(",") : "—"}`,
              `格式=${value.source_frame_format || "—"}`,
              `推理单元=${value.inference_unit || "—"}`,
              `拼接画面=${formatInferenceFrameSize(value.mosaic_width, value.mosaic_height)}`,
            ].join("；"),
          ),
        ]
      : []),
    ...(modelInputWidth || modelInputHeight || modelInputFormat
      ? [deviceInfoRow("检测策略", "模型输入尺寸", `${formatInferenceFrameSize(modelInputWidth, modelInputHeight)}${modelInputFormat ? ` · ${modelInputFormat}` : ""}`, "检测模型实际接收的单个输入尺寸和像素格式")]
      : []),
    ...(typeof value.sliding_disabled_for_pcie === "boolean"
      ? [deviceInfoRow("检测配置", "PCIe 滑窗", value.sliding_disabled_for_pcie ? "已禁用" : "未声明禁用", "事件/状态明确给出的 PCIe 滑窗禁用标记")]
      : []),
  ];

  const hasPipelineInfo = [
    detector.pipeline_enabled,
    detector.pipeline_active,
    detector.preprocess_backend,
    detector.preprocess_requested,
    value.pipeline_enabled,
    value.preprocess_backend_configured,
    value.rga_compiled,
    detector.quantized_output,
  ].some((item) => item !== undefined && item !== null && item !== "");
  if (hasPipelineInfo) {
    const pipelineEnabled = typeof detector.pipeline_enabled === "boolean" ? detector.pipeline_enabled : value.pipeline_enabled;
    const pipelineActive = detector.pipeline_active;
    const pipelineValue = pipelineEnabled === false
      ? "未启用"
      : pipelineActive === true
        ? "已生效"
        : pipelineEnabled === true
          ? "已开启，当前未重叠"
          : "未知";
    rows.push(
      deviceInfoRow("检测流水线", "流水线状态", pipelineValue, `运行配置=${captureFlagText(value.pipeline_enabled ?? runtimeSettings?.det_pipeline_enabled)}；实际允许=${captureFlagText(pipelineEnabled)}；本轮重叠=${captureFlagText(pipelineActive)}`),
      deviceInfoRow(
        "检测流水线",
        "前处理后端",
        formatDetectorPreprocessBackend(detector.preprocess_backend),
        `请求=${formatPreprocessRequest(detector.preprocess_requested)}；设置=${formatConfiguredPreprocessBackend(value.preprocess_backend_configured ?? runtimeSettings?.det_preprocess_backend)}；RGA编译=${captureFlagText(value.rga_compiled)}`,
      ),
      ...(Object.prototype.hasOwnProperty.call(detector, "preprocess_fallback_reason")
        ? [deviceInfoRow("检测流水线", "前处理回退", formatPreprocessFallback(detector.preprocess_fallback_reason), detector.preprocess_fallback_reason ? `原始值=${detector.preprocess_fallback_reason}` : "RGA/OpenCV 按请求正常执行")]
        : []),
      ...(typeof detector.quantized_output === "boolean" || typeof value.quantized_output === "boolean"
        ? [deviceInfoRow("检测流水线", "量化输出直解", (detector.quantized_output ?? value.quantized_output) ? "开启" : "关闭", `运行配置=${captureFlagText(value.quantized_output ?? runtimeSettings?.det_quantized_output)}；实际=${captureFlagText(detector.quantized_output)}；开启时直接解码 RKNN 量化输出`)]
        : []),
    );
  }

  if ([detector.queue_depth, detector.dropped_tasks].some((item) => Number.isFinite(Number(item)))) {
    rows.push(deviceInfoRow("检测任务", "任务队列", `${detector.queue_depth ?? "—"} 个等待`, `累计覆盖丢弃=${detector.dropped_tasks ?? "—"} 个；当前实现最大队列深度为 1`));
  }
  if (detector.pre_ms !== undefined) rows.push(deviceInfoRow("检测性能", "前处理耗时", fmtCaptureMetric(detector.pre_ms, "ms"), "裁剪、缩放、补边、颜色转换和输入准备总和"));
  if (detector.npu_wall_ms !== undefined) rows.push(deviceInfoRow("检测性能", "NPU 墙钟耗时", fmtCaptureMetric(detector.npu_wall_ms, "ms"), "inputs_set、rknn_run、outputs_get 的端到端墙钟总和"));
  if (detector.npu_hw_ms !== undefined) rows.push(deviceInfoRow("检测性能", "NPU 核执行耗时", fmtCaptureMetric(detector.npu_hw_ms, "ms"), "RKNN_QUERY_PERF_RUN 返回的真实 NPU 硬件执行时间"));
  if (detector.post_ms !== undefined) rows.push(deviceInfoRow("检测性能", "后处理耗时", fmtCaptureMetric(detector.post_ms, "ms"), "输出解码、阈值、NMS、四角点和坐标映射总和"));
  if (detector.e2e_ms !== undefined) rows.push(deviceInfoRow("检测性能", "检测端到端耗时", fmtCaptureMetric(detector.e2e_ms, "ms"), `流水线隐藏=${fmtCaptureMetric(detector.overlap_saved_ms, "ms")}`));
  const subtaskThroughput = detector.subtask_throughput_fps ?? detector.task_throughput_fps ?? detector.task_fps;
  if (subtaskThroughput !== undefined) {
    rows.push(deviceInfoRow(
      "检测性能",
      "子任务吞吐",
      fmtCaptureMetric(subtaskThroughput, "任务/s"),
      `旧字段 task_fps=${detector.task_fps ?? "—"}；语义=${detector.task_fps_semantics || "subtask_throughput"}；不是整轮检测 FPS`,
    ));
  }
  if (detector.cycle_fps !== undefined || detector.cycle_ms !== undefined) {
    rows.push(deviceInfoRow(
      "检测性能",
      "整轮检测帧率",
      fmtCaptureMetric(detector.cycle_fps, "FPS"),
      `整轮周期=${fmtCaptureMetric(detector.cycle_ms, "ms")}；语义=${detector.cycle_fps_semantics || "full_detection_cycle"}`,
    ));
  }
  if (detector.result_age_ms !== undefined) rows.push(deviceInfoRow("检测性能", "结果延迟", fmtCaptureMetric(detector.result_age_ms, "ms"), "检测结果产生时相对输入任务的年龄"));
  if ([detector.capture_async, detector.latest_only, detector.overlay_max_age_ms].some((item) => item !== undefined)) {
    rows.push(deviceInfoRow(
      "检测实时性",
      "异步最新帧",
      detector.capture_async === true && detector.latest_only === true ? "已启用" : "未完全启用",
      `异步采集=${captureFlagText(detector.capture_async)}；仅保留最新=${captureFlagText(detector.latest_only)}；叠加最大年龄=${fmtCaptureMetric(detector.overlay_max_age_ms, "ms")}`,
    ));
  }
  if ([detector.display_cycle_ms, detector.display_fps, detector.capture_dropped_frames].some((item) => item !== undefined)) {
    rows.push(deviceInfoRow(
      "检测实时性",
      "显示与采集",
      fmtCaptureMetric(detector.display_fps, "FPS"),
      `显示周期=${fmtCaptureMetric(detector.display_cycle_ms, "ms")}；采集覆盖丢弃=${fmtCaptureMetric(detector.capture_dropped_frames, "帧", 0)}`,
    ));
  }

  appendInferenceLetterboxRows(rows, "整图补边", "缩放后有效内容", "黑边范围", value.single_pass_letterbox);
  appendInferenceLetterboxRows(rows, "单路补边", "单路缩放后有效内容", "单路黑边范围", value.per_source_letterbox);
  return rows;
}

function buildRkDeviceInfo() {
  const status = rkReported.status && typeof rkReported.status === "object" ? rkReported.status : {};
  const driverStatus = normalizeDriverStatus(status.driver_status) || null;
  const captureMetrics = normalizeDriverCaptureMetrics(driverStatus?.capture_metrics);
  const captureDropRate = captureMetrics
    ? captureMetricsDropRate(captureMetrics.complete_frames, captureMetrics.dropped_frames)
    : null;
  const captureRetentionRate = Number.isFinite(captureDropRate)
    ? Math.max(0, Math.min(100, 100 - captureDropRate))
    : null;
  const nowMs = Date.now();
  const statusAge = rkReported.statusAtMs ? nowMs - Number(rkReported.statusAtMs) : null;
  const peerAge = rkReported.peerSeenAtMs ? nowMs - Number(rkReported.peerSeenAtMs) : null;
  const inputMode = String(status.input_mode || "").trim().toLowerCase();
  const inputDetail = inputMode === "sdcard" && status.sd_source_path ? `路径=${status.sd_source_path}` : inputMode ? `原始值=${inputMode}` : "";
  const msgSync = rkReported.userMessageConfigSyncResult || null;
  const pullSync = status.user_message_config_sync && typeof status.user_message_config_sync === "object" ? status.user_message_config_sync : null;
  const backendBase = String(status.backend_base || "").trim();
  const backendOk = typeof status.backend_ok === "boolean" ? status.backend_ok : null;
  const backendLatency = Number(status.backend_latency_ms);
  const dmaMemory = normalizeDriverDmaMemory(status.pcie_dma_memory || driverStatus?.dma_memory);
  const reportDelivery = status.report_delivery && typeof status.report_delivery === "object" ? status.report_delivery : null;
  const ttsWav = status.tts_wav && typeof status.tts_wav === "object" ? status.tts_wav : null;
  const pullSyncState = pullSync
    ? pullSync.enabled === false
      ? "未启用"
      : pullSync.last_ok === true
        ? "正常"
        : pullSync.last_ok === false
          ? "异常"
          : "已启用"
    : rkReported.userMessageConfigPull
      ? rkReported.userMessageConfigPull.result === "applied" ? "已返回新配置" : "无更新"
      : "未拉取";
  const driverBound = typeof status.pcie_driver_bound_ok === "boolean"
    ? status.pcie_driver_bound_ok
    : driverStatus?.pcie?.bound_count !== undefined
      ? Number(driverStatus.pcie.bound_count) > 0
      : null;
  const rows = [
    deviceInfoRow("设备", "设备名称", status.device || "RK3568"),
    ...(status.rk_device_id ? [deviceInfoRow("设备", "RK 设备 ID", status.rk_device_id, "幂等键第一维；用于区分不同 RK3568 终端")] : []),
    ...(status.event_id || status.report_id ? [deviceInfoRow("上报身份", "事件 ID", status.event_id || status.report_id, `report_id=${status.report_id || "—"}；发送次数=${status.report_attempt ?? "—"}`)] : []),
    ...(status.report_schema || status.report_type || status.delivery_semantics
      ? [deviceInfoRow("上报身份", "上报契约", status.report_schema || "—", `类型=${status.report_type || "—"}；投递=${status.delivery_semantics || "—"}`)]
      : []),
    ...(status.report_created_at || status.report_created_at_ms !== undefined
      ? [deviceInfoRow("上报身份", "事件生成时间", status.report_created_at || "—", `Unix毫秒=${status.report_created_at_ms ?? "—"}`)]
      : []),
    deviceInfoRow("网络", "设备 IP", rkReported.peerIp || "", `来源=RK 上报连接；最近上报=${fmtDeviceAge(peerAge)}`),
    deviceInfoRow("后端", "云后端地址", backendBase || "", status.backend_source ? `来源=${status.backend_source}` : ""),
    deviceInfoRow("后端", "连接状态", backendOk === true ? "正常" : backendOk === false ? "异常" : "未知", Number.isFinite(backendLatency) ? `延迟=${Math.round(backendLatency)}ms` : ""),
    deviceInfoRow("后端", "最近成功", status.backend_last_ok_at || "", status.backend_error ? `错误=${status.backend_error}` : ""),
    ...(status.backend_last_test_at ? [deviceInfoRow("后端", "最近连通测试", status.backend_last_test_at, status.backend_error ? `结果=${status.backend_error}` : "") ] : []),
    ...(typeof status.rk_api_listening === "boolean" || status.rk_api_port !== undefined || status.rk_api_bind
      ? [deviceInfoRow(
          "本地 API",
          "RK API 服务",
          status.rk_api_listening === true ? "监听中" : status.rk_api_listening === false ? "未监听" : "未知",
          `地址=${status.rk_api_bind || "—"}:${status.rk_api_port ?? "—"}；错误=${status.rk_api_error || "无"}`,
        )]
      : []),
    ...(reportDelivery
      ? [deviceInfoRow(
          "上报投递",
          "可靠队列",
          `${reportDelivery.pending_count ?? status.report_pending_count ?? "—"} 条待发`,
          `语义=${reportDelivery.semantics || status.delivery_semantics || "—"}；重试=${reportDelivery.retry_total ?? "—"}；拒绝=${reportDelivery.rejected_saved_count ?? status.report_rejected_count ?? "—"}；最近=${reportDelivery.last_result || status.report_last_result || "—"}；错误=${reportDelivery.last_error || status.report_last_error || "无"}`,
        )]
      : []),
    deviceInfoRow("状态", "在线状态", rkIsOnline() ? "在线" : "离线", `状态年龄=${fmtDeviceAge(statusAge)}`),
    deviceInfoRow("状态", "板端时间", status.time_bj || driverStatus?.time_local || ""),
    deviceInfoRow("状态", "用户态", status.user_state || "未知", `角色=${status.role || "—"}；业务系统=${status.biz_system || "—"}`),
    ...(status.ui_mode || status.account_mode ? [deviceInfoRow("状态", "界面 / 账户模式", status.ui_mode || "—", `account_mode=${status.account_mode || "—"}`)] : []),
    ...(status.infer_mode ? [deviceInfoRow("状态", "推理模式", status.infer_mode, `视图=${status.view || "—"}`)] : []),
    deviceInfoRow("普通用户", "播报配置", status.user_message_config?.version ? `v${status.user_message_config.version}` : `v${rkUserMessageConfig.version}`, status.user_message_config?.updated_at || rkUserMessageConfig.updated_at || ""),
    ...(status.user_message_config_path ? [deviceInfoRow("普通用户", "播报配置文件", status.user_message_config_path, "RK3568 本地配置文件路径")] : []),
    deviceInfoRow("普通用户", "云端拉取", pullSyncState, pullSync ? `启用=${captureFlagText(pullSync.enabled)} 结果=${pullSync.last_result || "—"} 云端v${pullSync.last_remote_version ?? "—"} 间隔=${pullSync.interval_ms ?? "—"}ms 超时=${pullSync.timeout_ms ?? "—"}ms 延迟=${pullSync.last_latency_ms ?? "—"}ms 同步中=${captureFlagText(pullSync.syncing)} 路径=${pullSync.path || "—"} 最近=${pullSync.last_sync_at || "—"} 应用=${pullSync.last_applied_at || "—"} 错误=${pullSync.last_error || "无"}` : rkReported.userMessageConfigPull ? `RK本地v${rkReported.userMessageConfigPull.local_version ?? "—"} 云端v${rkReported.userMessageConfigPull.remote_version ?? "—"} ${rkReported.userMessageConfigPull.time_bj || ""}` : ""),
    deviceInfoRow("普通用户", "最近显示文字", rkReported.userMessages[0]?.display_text || "", rkReported.userMessages[0]?.time_bj || ""),
    ...(status.target_device_id ? [deviceInfoRow("控制目标", "ESP32 目标设备", status.target_device_id, status.runtime_settings?.target_device_id ? "来源=运行设置" : "来源=状态上报")] : []),
    ...(ttsWav
      ? [deviceInfoRow("音频", "板端 TTS WAV", ttsWav.enabled === true ? (ttsWav.ready === true ? "已就绪" : "未就绪") : "未启用", `目录=${ttsWav.base_dir || "—"}；输出=${ttsWav.output_device || "—"}；错误=${ttsWav.last_error || "无"}`)]
      : []),
    deviceInfoRow("采集", "输入源", formatRkInputMode(inputMode), `${inputDetail}${inputDetail && status.perf_cap_basis ? "；" : ""}${status.perf_cap_basis ? `采集耗时口径=${status.perf_cap_basis}` : ""}`),
    ...buildPciePlateInferenceDeviceRows(status),
    deviceInfoRow("显示", "自动曝光", status.auto_exposure_enabled === true ? "开启" : status.auto_exposure_enabled === false ? "关闭" : "未知", status.auto_exposure_level == null ? "" : `level=${status.auto_exposure_level}`),
    deviceInfoRow("PCIE", "驱动挂载", status.pcie_driver_mounted === true ? "已挂载" : status.pcie_driver_mounted === false ? "未挂载" : driverStatus?.mounted === true ? "已挂载" : driverStatus?.mounted === false ? "未挂载" : "未知"),
    deviceInfoRow("PCIE", "设备节点", status.pcie_driver_node || driverStatus?.device_node?.path || "", driverStatus?.device_node?.permissions ? `permissions=${driverStatus.device_node.permissions}` : ""),
    deviceInfoRow("PCIE", "内核模块", status.pcie_driver_module_ok === true ? "module ok" : status.pcie_driver_module_ok === false ? "module bad" : driverStatus?.module?.loaded === true ? "module ok" : driverStatus?.module?.loaded === false ? "module bad" : "未知", driverStatus?.module?.name || driverStatus?.module_name || ""),
    ...(driverStatus?.module?.version ? [deviceInfoRow("PCIE", "内核模块版本", driverStatus.module.version, driverStatus.module.name || driverStatus.module_name || "")] : []),
    ...(driverBound !== null
      ? [deviceInfoRow("PCIE", "设备绑定", driverBound ? "已绑定" : "未绑定", `显式状态=${captureFlagText(status.pcie_driver_bound_ok)}；bound_count=${driverStatus?.pcie?.bound_count ?? "—"}`)]
      : []),
    ...(dmaMemory
      ? [deviceInfoRow(
          "PCIE",
          "DMA / CMA 内存",
          `${dmaMemory.cma_total_kb ?? "—"} KB`,
          `空闲=${dmaMemory.cma_free_kb ?? "—"} KB；最低=${dmaMemory.cma_minimum_kb ?? "—"} KB；推荐=${dmaMemory.cma_recommended_kb ?? "—"} KB；满足最低=${captureFlagText(dmaMemory.cma_sufficient)}；满足推荐=${captureFlagText(dmaMemory.cma_recommended)}`,
        )]
      : []),
    ...(captureMetrics
      ? [
          ...(captureMetrics.driver_features !== undefined || captureMetrics.driver_features_hex
            ? [deviceInfoRow("PCIe协议", "驱动特性位图", formatCaptureHex(captureMetrics.driver_features_hex, captureMetrics.driver_features), captureMetrics.driver_features == null ? "" : `十进制=${captureMetrics.driver_features}`)]
            : []),
          ...(captureMetrics.protocol || captureMetrics.driver_abi_version !== undefined
            ? [deviceInfoRow("PCIe协议", "采集协议 / ABI", captureMetrics.protocol || "未知", captureMetrics.driver_abi_version == null ? "" : `ABI=${captureMetrics.driver_abi_hex || captureMetrics.driver_abi_version}`)]
            : []),
          ...(captureMetrics.fpga_protocol_version !== undefined || captureMetrics.fpga_protocol_hex
            ? [deviceInfoRow("PCIe协议", "FPGA 协议", captureMetrics.fpga_protocol_hex || formatCaptureHex("", captureMetrics.fpga_protocol_version), captureMetrics.fpga_capabilities == null ? "" : `能力=${captureMetrics.fpga_capabilities_hex || formatCaptureHex("", captureMetrics.fpga_capabilities)}`)]
            : []),
          ...(captureMetrics.fpga_build_id !== undefined || captureMetrics.fpga_build_id_hex
            ? [deviceInfoRow("PCIe协议", "FPGA 构建号", captureMetrics.fpga_build_id_hex || formatCaptureHex("", captureMetrics.fpga_build_id), "用于确认 FPGA 比特流与 RK 驱动版本配套")]
            : []),
          ...(captureMetrics.fpga_debug_state_hex || captureMetrics.fifo_level_01_hex || captureMetrics.fifo_level_23_hex || captureMetrics.fpga_handshake_state_hex
            ? [deviceInfoRow(
                "PCIe协议",
                "FPGA 调试快照",
                captureMetrics.fpga_debug_state_hex || "—",
                `FIFO01=${captureMetrics.fifo_level_01_hex || "—"}；FIFO23=${captureMetrics.fifo_level_23_hex || "—"}；握手=${captureMetrics.fpga_handshake_state_hex || "—"}`,
              )]
            : []),
          ...(captureMetrics.fpga_target_fps_milli !== undefined
            ? [deviceInfoRow("PCIe协议", "FPGA 目标帧率", formatFpgaTargetFps(captureMetrics.fpga_target_fps_milli), `寄存器回读=${captureMetrics.fpga_target_fps_milli} milli-FPS`)]
            : []),
          ...(typeof captureMetrics.bar_contract_ok === "boolean"
            ? [deviceInfoRow("PCIe协议", "双 BAR 契约", captureMetrics.bar_contract_ok ? "校验通过" : "校验失败", "BAR0 只读、BAR1 只写，均需覆盖协议寄存器区间")]
            : []),
          ...(captureMetrics.bar0_read_bytes !== undefined
            ? [deviceInfoRow("BAR映射", "BAR0 只读窗口", formatResourceBytes(captureMetrics.bar0_read_bytes), `${captureMetrics.bar0_read_bytes} bytes；寄存器读取`)]
            : []),
          ...(captureMetrics.bar1_write_bytes !== undefined
            ? [deviceInfoRow("BAR映射", "BAR1 写窗口", formatResourceBytes(captureMetrics.bar1_write_bytes), `${captureMetrics.bar1_write_bytes} bytes；配置与控制写入`)]
            : []),
          ...(captureMetrics.interrupt_mode
            ? [deviceInfoRow("中断", "实际中断模式", captureMetrics.interrupt_mode, captureMetrics.interrupt_mode === "MSI" ? "使用 MSI 中断" : captureMetrics.interrupt_mode === "INTx" ? "MSI 不可用，已回退 INTx" : "驱动未确认中断模式")]
            : []),
          ...(captureMetrics.source_mask !== undefined || captureMetrics.source_mask_hex
            ? [deviceInfoRow("输入源", "有效源掩码", formatPcieSourceMask(captureMetrics), captureMetrics.source_mask == null ? "" : `十进制=${captureMetrics.source_mask}；低 4 位对应 SRC1-SRC4`)]
            : []),
          ...(typeof captureMetrics.all_four_sources_valid === "boolean"
            ? [deviceInfoRow("输入源", "四路输入状态", captureMetrics.all_four_sources_valid ? "四路完整" : "输入不完整", captureMetrics.all_four_sources_valid ? "SRC1-SRC4 均包含在最近有效帧中" : "请检查 source_mask 与对应输入链路")]
            : []),
          ...(captureMetrics.protocol_errors !== undefined
            ? [deviceInfoRow("异常", "协议错误", `${captureMetrics.protocol_errors} 次`, captureMetrics.protocol_errors === 0 ? "未发现无效元数据或越界 DONE 位" : "驱动已拒绝异常帧，请检查 FPGA 协议和元数据")]
            : []),
          ...(typeof captureMetrics.rate_control_supported === "boolean" || typeof captureMetrics.fixed_30fps_active === "boolean"
            ? [deviceInfoRow("PCIe协议", "固定 30 FPS", captureMetrics.fixed_30fps_active === true ? "已生效" : captureMetrics.fixed_30fps_active === false ? "未生效" : "未知", `帧率控制=${captureFlagText(captureMetrics.rate_control_supported)}；请求=${formatFpgaTargetFps(captureMetrics.target_fps_milli)}`)]
            : []),
          ...(typeof captureMetrics.frame_v2 === "boolean" || typeof captureMetrics.mmap_enabled === "boolean"
            ? [deviceInfoRow("PCIe缓冲", "V2 零拷贝通道", captureMetrics.frame_v2 === true && captureMetrics.mmap_enabled === true ? "已启用" : "未完全启用", `V2=${captureFlagText(captureMetrics.frame_v2)}；mmap=${captureFlagText(captureMetrics.mmap_enabled)}；环形缓冲=${captureMetrics.ring_count ?? "—"}`)]
            : []),
          ...(captureMetrics.frame_width !== undefined || captureMetrics.frame_height !== undefined || captureMetrics.frame_bytes !== undefined
            ? [deviceInfoRow("PCIe缓冲", "完整帧格式", `${captureMetrics.frame_width ?? "—"}×${captureMetrics.frame_height ?? "—"}`, `stride=${captureMetrics.frame_stride_bytes ?? "—"} bytes；frame=${captureMetrics.frame_bytes ?? "—"} bytes`)]
            : []),
          ...(typeof captureMetrics.source_locked === "boolean" || captureMetrics.recovery_state || captureMetrics.recovery_count !== undefined
            ? [deviceInfoRow("PCIe恢复", "输入与恢复", captureMetrics.source_locked === true ? "输入已锁定" : captureMetrics.source_locked === false ? "等待输入锁定" : "未知", `状态=${captureMetrics.recovery_state || "—"}；恢复=${captureMetrics.recovery_count ?? "—"} 次；连续超时=${captureMetrics.consecutive_timeouts ?? "—"}`)]
            : []),
          ...(typeof captureMetrics.v1_fallback_active === "boolean" || typeof captureMetrics.v1_fallback_allowed === "boolean"
            ? [deviceInfoRow("PCIe恢复", "旧协议回退", captureMetrics.v1_fallback_active === true ? "正在使用 V1" : "未使用 V1", `允许回退=${captureFlagText(captureMetrics.v1_fallback_allowed)}`)]
            : []),
          deviceInfoRow("PCIe采集", "采集线程", captureMetrics.running === true ? "运行中" : captureMetrics.running === false ? "已停止" : "未知", `PCIe=${captureFlagText(captureMetrics.pcie)}；模式=${captureMetrics.mode || "—"}；有效采样=${captureFlagText(captureMetrics.metric_valid)}；口径=${captureMetrics.metric_basis || "—"}；最近采集=${fmtCaptureMetric(captureMetrics.last_capture_ms, "ms")}`),
          deviceInfoRow("PCIe采集", "实际收帧率", fmtCaptureMetric(captureMetrics.actual_rx_fps, "FPS"), "完整帧送达速率，不等同于推理帧率"),
          deviceInfoRow("PCIe采集", "源画面周期", fmtCaptureMetric(captureMetrics.frame_interval_ms, "ms"), "由 FPGA SOF 计算；30 FPS 约为 33.3 ms"),
          deviceInfoRow("PCIe采集", "DMA 搬运耗时", fmtCaptureMetric(captureMetrics.dma_transfer_ms, "ms"), captureMetrics.frame_v2 === true ? "V2 无独立 DMA 时间戳时固定为 0，不用等待时间代替" : "旧采集路径的单帧 DMA 统计"),
          deviceInfoRow(
            "PCIe采集",
            "等待完整画面",
            fmtCaptureMetric(captureMetrics.dma_wait_avg_ms ?? captureMetrics.dma_wait_ms, "ms"),
            captureMetrics.dma_wait_avg_ms !== undefined
              ? `1秒峰值=${fmtCaptureMetric(captureMetrics.dma_wait_max_ms, "ms")}；样本=${captureMetrics.dma_wait_sample_count ?? "—"} 帧；窗口=${fmtCaptureMetric(captureMetrics.dma_wait_window_ms, "ms")}；瞬时=${fmtCaptureMetric(captureMetrics.dma_wait_ms, "ms")}`
              : `瞬时值（旧固件）；口径=${captureMetrics.last_capture_basis || "—"}；IRQ等待=${captureFlagText(captureMetrics.irq_wait)}；IRQ回退=${captureFlagText(captureMetrics.irq_fallback)}`,
          ),
          ...(captureMetrics.kernel_staging_ms !== undefined
            ? [deviceInfoRow("PCIe采集", "内核拼帧耗时", fmtCaptureMetric(captureMetrics.kernel_staging_ms, "ms"), `暂存复制=${captureFlagText(captureMetrics.staged_copy)}`)]
            : []),
          deviceInfoRow("PCIe采集", "用户态复制耗时", fmtCaptureMetric(captureMetrics.user_copy_ms, "ms")),
          deviceInfoRow("PCIe采集", "有效画面", fmtCaptureMetric(captureMetrics.complete_frames, "帧", 0), "累计完整接收的画面"),
          deviceInfoRow("PCIe采集", "丢失画面", fmtCaptureMetric(captureMetrics.dropped_frames, "帧", 0), "累计被覆盖或丢弃的画面"),
          ...(captureMetrics.fpga_dropped_frames !== undefined || captureMetrics.host_dropped_frames !== undefined
            ? [deviceInfoRow("PCIe采集", "丢失来源", `FPGA ${captureMetrics.fpga_dropped_frames ?? "—"} / RK ${captureMetrics.host_dropped_frames ?? "—"}`, `序号跳变=${captureMetrics.sequence_gaps ?? "—"}；序号跳变仅用于诊断，不重复计入丢失总数`)]
            : []),
          deviceInfoRow("PCIe采集", "数据保留率", fmtCaptureMetric(captureRetentionRate, "%", 2), `丢失率=${fmtCaptureMetric(captureDropRate, "%", 3)}；有效画面÷总画面`),
          deviceInfoRow("PCIe采集", "DMA 单元", fmtCaptureMetric(captureMetrics.dma_unit_bytes, "byte", 0), `每帧单元数=${fmtCaptureMetric(captureMetrics.dma_units_per_frame, "个", 0)}；批量ioctl=${captureFlagText(captureMetrics.batch_ioctl)}`),
          ...(captureMetrics.batch_fallback_reason || captureMetrics.irq_fallback_reason
            ? [deviceInfoRow("PCIe恢复", "兼容路径回退", captureMetrics.batch_fallback_reason || captureMetrics.irq_fallback_reason, `batch=${captureMetrics.batch_fallback_reason || "无"}；irq=${captureMetrics.irq_fallback_reason || "无"}`)]
            : []),
          deviceInfoRow("PCIe采集", "最近错误", captureMetrics.last_error || "无", captureMetrics.last_frame_at ? `最近完整帧=${captureMetrics.last_frame_at}` : ""),
        ]
      : []),
  ];
  if (driverStatus?.rows?.length) {
    rows.push(...driverStatus.rows.map((r) => deviceInfoRow(r.category, r.item, r.value, r.detail)));
  }
  if (driverStatus) {
    if (driverStatus.device_node) rows.push(deviceInfoRow("PCIE", "设备节点诊断", driverStatus.device_node.exists === true ? "存在" : driverStatus.device_node.exists === false ? "不存在" : "未知", `路径=${driverStatus.device_node.path || "—"}；权限=${driverStatus.device_node.permissions || "—"}`));
    if (driverStatus.dma_memory?.kernel_cmdline) rows.push(deviceInfoRow("PCIE", "内核启动参数", driverStatus.dma_memory.kernel_cmdline, "用于核对 CMA 预留参数"));
    if (driverStatus.cpu?.usage_text) rows.push(deviceInfoRow("CPU", "运行占比", driverStatus.cpu.usage_text));
    (driverStatus.cpu?.policies || []).forEach((p) => rows.push(deviceInfoRow("CPU", `${p.policy || "policy"} 当前频率`, p.cur_freq_text || (p.cur_freq_mhz ? `${p.cur_freq_mhz} MHz` : ""), `governor=${p.governor || "—"}  sysfs=${p.sysfs || "—"}`)));
    ["gpu", "npu"].forEach((kind) => {
      (driverStatus[kind]?.devices || []).forEach((d) => rows.push(deviceInfoRow(kind.toUpperCase(), `${d.name || kind} 当前频率`, d.cur_freq_text || (d.cur_freq_mhz ? `${d.cur_freq_mhz} MHz` : ""), `usage=${d.usage_text || "—"}  governor=${d.governor || "—"}`)));
    });
    if (driverStatus.interrupt) rows.push(deviceInfoRow("中断", driverStatus.interrupt.name || "驱动中断", driverStatus.interrupt.sum ?? "", `irq=${driverStatus.interrupt.irq ?? "—"} rate=${driverStatus.interrupt.rate_per_sec ?? "—"}/s`));
    (driverStatus.pcie?.devices || []).forEach((d) => rows.push(deviceInfoRow("PCIe", d.bdf || "设备", `${d.vendor || "—"} / ${d.device || "—"}`, `speed=${d.link?.current_speed || "—"} width=${d.link?.current_width || "—"} irq=${d.irq || "—"}`)));
    (driverStatus.suggestions || []).forEach((suggestion, index) => rows.push(deviceInfoRow("诊断建议", `建议 ${index + 1}`, suggestion)));
  }
  return {
    name: "RK3568",
    online: rkIsOnline(),
    ip: rkReported.peerIp || "",
    status_age_ms: statusAge,
    peer_seen_age_ms: peerAge,
    driver_status: driverStatus,
    ...(status.plate_detector_model !== undefined ? { plate_detector_model: status.plate_detector_model } : {}),
    ...(status.plate_detector_configured_model !== undefined ? { plate_detector_configured_model: status.plate_detector_configured_model } : {}),
    ...(status.plate_detector_active_model ? { plate_detector_active_model: status.plate_detector_active_model } : {}),
    ...(status.plate_detector_model_name ? { plate_detector_model_name: status.plate_detector_model_name } : {}),
    ...(status.plate_detector_model_path ? { plate_detector_model_path: status.plate_detector_model_path } : {}),
    ...(status.plate_recognizer_model_name ? { plate_recognizer_model_name: status.plate_recognizer_model_name } : {}),
    ...(status.plate_recognizer_model_path ? { plate_recognizer_model_path: status.plate_recognizer_model_path } : {}),
    ...(status.plate_model_input_width !== undefined ? { plate_model_input_width: status.plate_model_input_width } : {}),
    ...(status.plate_model_input_height !== undefined ? { plate_model_input_height: status.plate_model_input_height } : {}),
    ...(status.plate_model_input_format ? { plate_model_input_format: status.plate_model_input_format } : {}),
    ...(status.plate_detector_input ? { plate_detector_input: status.plate_detector_input } : {}),
    ...(status.plate_detector_postprocess ? { plate_detector_postprocess: status.plate_detector_postprocess } : {}),
    plate_detector_runtime: normalizePlateDetectorRuntime(status),
    pcie_plate_inference: normalizePciePlateInference(status, normalizeRkRuntimeSettings(status)),
    rows,
  };
}

function buildEsp32DeviceInfo() {
  const s = buildEsp32Status();
  const rows = [
    deviceInfoRow("设备", "设备名称", s.device || "ESP32"),
    deviceInfoRow("设备", "设备 ID", s.device_id || ""),
    deviceInfoRow("网络", "设备 IP", s.ip || s.target_host || "", `目标=${s.target || "—"}；来源=${s.target_source || "—"}`),
    deviceInfoRow("网络", "HTTP 端口", s.port || s.target_port || 80),
    deviceInfoRow("网络", "MAC", s.mac || ""),
    deviceInfoRow("状态", "在线状态", s.online ? "在线" : "离线", `心跳年龄=${fmtDeviceAge(s.last_seen_age_ms)}`),
    deviceInfoRow("配置", "心跳间隔", s.heartbeat_ms == null ? "—" : `${s.heartbeat_ms}ms`),
    deviceInfoRow("轮询", "命令轮询", s.command_poll_enabled === true ? "开启" : s.command_poll_enabled === false ? "关闭" : "未知", s.command_poll_ms == null ? "" : `间隔=${s.command_poll_ms}ms`),
    deviceInfoRow("配置", "请求超时", s.config?.timeout_ms == null ? "—" : `${s.config.timeout_ms}ms`),
    deviceInfoRow("轮询", "待执行命令", `${s.queued_commands || 0}`, `执行中=${s.active_commands || 0}`),
    deviceInfoRow("轮询", "最近命令", s.last_command_id || "", s.last_command_state || ""),
    deviceInfoRow("状态", "通信延迟", s.latency_ms == null ? "" : `${s.latency_ms}ms`),
    deviceInfoRow("状态", "运行时长", s.uptime_ms == null ? "" : fmtDeviceAge(s.uptime_ms)),
    deviceInfoRow("舵机", "就绪状态", s.servo_busy ? "动作中" : s.servo_ready === true ? "就绪" : s.servo_ready === false ? "未就绪" : "未知"),
    deviceInfoRow("舵机", "翻转配置", `${s.config?.angle ?? "—"}° / ${s.config?.hold_ms ?? "—"}ms`, `回位=${s.config?.return_enabled ? "开启" : "关闭"} ${s.config?.return_angle ?? "—"}°`),
    deviceInfoRow("异常", "最近错误", s.last_error || ""),
  ];
  const raw = esp32State.last_response && typeof esp32State.last_response === "object" ? esp32State.last_response : null;
  if (raw) {
    Object.entries(raw)
      .slice(0, 80)
      .forEach(([k, v]) => rows.push(deviceInfoRow("上报", k, typeof v === "object" ? JSON.stringify(v) : String(v))));
  }
  return { name: "ESP32", online: s.online, ip: s.ip || s.target_host || "", rows, status: s };
}

function buildDatabaseDeviceInfo() {
  const s = mysqlPublicStatus();
  const host = s.host ? `${s.host}${s.port ? `:${s.port}` : ""}` : "";
  const online = Boolean(s.enabled && s.ready);
  const statusText = !s.enabled
    ? "未启用"
    : online
      ? "已连接"
      : s.driver_missing
        ? "缺少驱动"
        : s.error
          ? "连接异常"
          : "连接中";
  const rows = [
    deviceInfoRow("数据库", "数据库名称", s.database || ""),
    deviceInfoRow("数据库", "连接状态", statusText, s.error?.code || s.error?.message || ""),
    deviceInfoRow("网络", "主机地址", host || ""),
    deviceInfoRow("网络", "用户名", s.user || ""),
    deviceInfoRow("配置", "连接池", s.connectionLimit == null ? "" : `${s.connectionLimit}`),
    deviceInfoRow("配置", "配置文件", s.config_path || ""),
    deviceInfoRow("状态", "最近成功", s.last_ok_at || ""),
    deviceInfoRow("状态", "下次重试", s.retry_at_ms == null ? "" : `${s.retry_at_ms}`, s.retry_at_ms == null ? "" : `剩余=${Math.max(0, Number(s.retry_at_ms) - Date.now())}ms`),
    deviceInfoRow("异常", "最近错误", s.error?.code || "", s.error?.message || ""),
  ];
  return {
    name: "MySQL",
    online,
    ip: host || "",
    rows,
    status: s,
  };
}

function formatResourceBytes(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatResourcePercent(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : "—";
}

function captureDirectoryUsage(dir) {
  let count = 0;
  let bytes = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry?.isFile() || !/\.jpe?g$/i.test(entry.name)) continue;
      try {
        const stat = fs.statSync(path.resolve(dir, entry.name));
        count += 1;
        bytes += Number(stat.size || 0);
      } catch {}
    }
  } catch {}
  return { count, bytes };
}

function buildBackendDeviceInfo(req = null) {
  const backend = buildBackendStatus(req);
  const resources = backend.resources || {};
  const cpu = resources.cpu || {};
  const memory = resources.memory || {};
  const processMemory = resources.process || {};
  const disk = resources.disk || {};
  const databaseInfo = buildDatabaseDeviceInfo();
  const plates = captureDirectoryUsage(plateImageDir);
  const violations = captureDirectoryUsage(violationImageDir);
  const rows = [
    deviceInfoRow("服务", "运行状态", "运行中", `PID=${backend.pid}；Node=${backend.node_version}`),
    deviceInfoRow("服务", "后端地址", backend.host || os.hostname(), `监听端口=${backend.listen_port}`),
    deviceInfoRow("服务", "运行时长", fmtDeviceAge(Number(backend.uptime_s || 0) * 1000), `启动时间=${backend.started_at}`),
    deviceInfoRow("系统", "主机名称", backend.hostname || "", `${backend.platform} ${backend.release} ${backend.arch}`),
    deviceInfoRow("CPU", "整机占用率", formatResourcePercent(cpu.usage_pct), `${cpu.cores || "—"} 核；${cpu.model || "—"}`),
    deviceInfoRow("CPU", "后端进程占用率", formatResourcePercent(cpu.process_usage_pct), "按整机总计算能力归一化"),
    deviceInfoRow("CPU", "系统负载", `${cpu.load_1m ?? "—"} / ${cpu.load_5m ?? "—"} / ${cpu.load_15m ?? "—"}`, "1 / 5 / 15 分钟"),
    deviceInfoRow("内存", "整机占用率", formatResourcePercent(memory.usage_pct), `${formatResourceBytes(memory.used_bytes)} / ${formatResourceBytes(memory.total_bytes)}`),
    deviceInfoRow("内存", "Node RSS", formatResourceBytes(processMemory.rss_bytes), `占整机=${formatResourcePercent(processMemory.rss_host_pct)}`),
    deviceInfoRow("内存", "Node 堆内存", `${formatResourceBytes(processMemory.heap_used_bytes)} / ${formatResourceBytes(processMemory.heap_total_bytes)}`, "已用 / 已分配"),
    deviceInfoRow("磁盘", "系统盘占用率", formatResourcePercent(disk.usage_pct), `${formatResourceBytes(disk.used_bytes)} / ${formatResourceBytes(disk.total_bytes)}；可用=${formatResourceBytes(disk.available_bytes)}`),
    deviceInfoRow("存储", "车牌抓拍图片", `${plates.count} 个文件`, formatResourceBytes(plates.bytes)),
    deviceInfoRow("存储", "违规抓拍图片", `${violations.count} 个文件`, formatResourceBytes(violations.bytes)),
    ...databaseInfo.rows.map((row) => deviceInfoRow("数据库", row.item, row.value, [row.category, row.detail].filter(Boolean).join("；"))),
  ];
  return {
    name: "云端后端",
    online: true,
    ip: backend.host || backend.hostname || "",
    rows,
    status: backend,
  };
}

function buildTerminalDeviceInfo(req = null) {
  return {
    ok: true,
    time_bj: nowBjText(),
    rk3568: buildRkDeviceInfo(),
    esp32: buildEsp32DeviceInfo(),
    backend: buildBackendDeviceInfo(req),
    database: buildDatabaseDeviceInfo(),
  };
}

function rkIsOnline() {
  const at = Number(rkReported.statusAtMs || 0) || 0;
  if (!at) return false;
  const age = Date.now() - at;
  return age >= 0 && age < RK_ONLINE_TIMEOUT_MS;
}

function rkForwardTarget() {
  const envHost = String(process.env.RK_IP || "192.168.100.105").trim();
  const port = clamp(parseInt(process.env.RK_PORT || "3000", 10), 1, 65535);
  const activeDeviceId = normalizeRkReportIdentifier(rkReported.status?.rk_device_id, 128) || "";
  const peerOk = Boolean(
    rkIsOnline()
    && activeDeviceId
    && rkReported.peerIp
    && rkReported.peerRkDeviceId === activeDeviceId
    && rkReported.peerSeenAtMs
    && Date.now() - rkReported.peerSeenAtMs < 60_000,
  );
  const host = peerOk ? rkReported.peerIp : envHost;
  return { base: `http://${host}:${port}`, host, port, source: peerOk ? "peer" : "env" };
}

function maybeSyncUserMessageConfigToRk(boardMeta) {
  if (String(process.env.RK3568_USER_MESSAGE_PUSH_LEGACY || "0").trim() !== "1") return;
  const boardVersion = Number(boardMeta?.version);
  const targetVersion = Number(rkUserMessageConfig?.version);
  if (!Number.isFinite(targetVersion) || targetVersion <= 0) return;
  if (Number.isFinite(boardVersion) && boardVersion >= targetVersion) return;
  if (rkReported.userMessageConfigSyncing) return;
  const now = Date.now();
  if (now - Number(rkReported.userMessageConfigSyncAtMs || 0) < 5000) return;

  rkReported.userMessageConfigSyncing = true;
  rkReported.userMessageConfigSyncAtMs = now;
  const rk = rkForwardTarget();
  httpPostJson(`${rk.base}/api/user-message/config`, { config: rkUserMessageConfig }, 1800)
    .then((forward) => {
      rkReported.userMessageConfigSyncResult = {
        time_bj: nowBjText(),
        target: rk,
        target_version: targetVersion,
        board_version: Number.isFinite(boardVersion) ? boardVersion : null,
        ok: Boolean(forward?.ok && forward?.json?.ok === true),
        status: forward?.status ?? null,
        err: forward?.ok ? null : forward?.text ?? null,
      };
    })
    .catch((e) => {
      rkReported.userMessageConfigSyncResult = {
        time_bj: nowBjText(),
        target: rk,
        target_version: targetVersion,
        board_version: Number.isFinite(boardVersion) ? boardVersion : null,
        ok: false,
        status: 0,
        err: String(e?.message || e),
      };
    })
    .finally(() => {
      rkReported.userMessageConfigSyncing = false;
    });
}

async function applyRkStatusSideEffects(status, savedAtMs, options = {}) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return { metrics_applied: false };
  const captureMetricsInfo = extractDriverCaptureMetrics(status);
  const captureMetrics = captureMetricsInfo.metrics;
  const inputMode = String(status.input_mode || "").trim().toLowerCase();
  const pcieMetricsActive = inputMode === "pcie"
    || (!inputMode && (captureMetrics?.mode === "pcie" || captureMetrics?.pcie === true));
  let metricsApplied = false;
  let mysqlPersisted = null;
  if (pcieMetricsActive && captureMetrics) {
    const eventId = normalizeRkReportIdentifier(status.event_id || status.report_id, 160) || "";
    const rkDeviceId = normalizeRkReportIdentifier(status.rk_device_id, 128) || "rk3568";
    const sampleId = eventId
      ? createHash("sha256").update(`${rkDeviceId}\u0000${eventId}`).digest("hex").slice(0, 64)
      : "";
    const sample = buildRkCaptureMetricsSample(captureMetrics, {
      time_bj: cleanUserTemplate(status.time_bj, 32) || nowBjText(),
      sample_at_ms: Number.isFinite(Number(savedAtMs)) ? Math.max(0, Math.floor(Number(savedAtMs))) : Date.now(),
      sample_id: sampleId,
      device: cleanUserTemplate(status.device, 64) || "rk3568",
      input_mode: inputMode || captureMetrics.mode || "",
      metric_source: captureMetricsInfo.source,
    });
    if (sample) {
      const existingIndex = rkReported.captureMetrics.findIndex((item) => item?.sample_id === sample.sample_id);
      if (existingIndex >= 0) rkReported.captureMetrics.splice(existingIndex, 1);
      rkReported.captureMetrics.push(sample);
      rkReported.captureMetrics.sort((a, b) => Number(b?.sample_at_ms || 0) - Number(a?.sample_at_ms || 0));
      if (rkReported.captureMetrics.length > RK_CAPTURE_METRICS_MEMORY_MAX) {
        rkReported.captureMetrics.length = RK_CAPTURE_METRICS_MEMORY_MAX;
      }
      metricsApplied = true;
      if (businessMysqlWritePolicy().enabled) {
        mysqlPersisted = await mysqlSaveRkCaptureMetrics(sample, status.driver_status || null);
      }
    }
  }
  if (options.syncConfig === true) maybeSyncUserMessageConfigToRk(status.user_message_config);
  return { metrics_applied: metricsApplied, mysql_persisted: mysqlPersisted };
}

function rkBaseUrl() {
  const ip = String(process.env.RK_IP || "192.168.100.105").trim();
  const port = clamp(parseInt(process.env.RK_PORT || "3000", 10), 1, 65535);
  return `http://${ip}:${port}`;
}

function safeHostText(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (s.includes("/") || s.includes("\\") || s.includes("@") || s.includes(":")) return "";
  if (!/^[a-zA-Z0-9.-]+$/.test(s)) return "";
  return s;
}

function rkBaseUrlFromQuery(u) {
  const hostIn = safeHostText(u?.searchParams?.get("host") || u?.searchParams?.get("ip"));
  const portInRaw = String(u?.searchParams?.get("port") || "").trim();
  const portIn = clamp(parseInt(portInRaw || "0", 10), 1, 65535);

  const envHost = String(process.env.RK_IP || "192.168.100.105").trim();
  const envPort = clamp(parseInt(process.env.RK_PORT || "3000", 10), 1, 65535);

  const host = hostIn || envHost;
  const port = portInRaw ? portIn : envPort;
  return { base: `http://${host}:${port}`, host, port, host_in: hostIn || null, port_in: portInRaw ? portIn : null };
}

function esp32IsOnline() {
  const at = Number(esp32State.last_seen_ms || 0) || 0;
  if (!at) return false;
  const age = Date.now() - at;
  return age >= 0 && age <= ESP32_ONLINE_MS;
}

function clampEsp32Angle(v, fallback) {
  const n = Number(v);
  return clamp(Number.isFinite(n) ? Math.round(n) : fallback, 0, 180);
}

function clampEsp32HoldMs(v, fallback) {
  const n = Number(v);
  return clamp(Number.isFinite(n) ? Math.round(n) : fallback, 100, 60000);
}

function cleanDeviceId(v, fallback = "esp32-servo-01") {
  const s = String(v || "").trim();
  if (!s) return fallback;
  return s.replace(/[^\w:.-]/g, "").slice(0, 80) || fallback;
}

function publicEsp32Command(cmd) {
  if (!cmd || typeof cmd !== "object") return null;
  return {
    id: cmd.id,
    type: cmd.type,
    action: cmd.action || "",
    source: cmd.source || "",
    angle: cmd.angle,
    hold_ms: cmd.hold_ms,
    return_angle: cmd.return_angle,
    return_enabled: cmd.return_enabled,
    device_id: cmd.device_id || "",
    mac: cmd.mac || "",
    state: cmd.state || "queued",
    created_at_ms: cmd.created_at_ms || null,
    created_at: cmd.created_at || "",
    pulled_at_ms: cmd.pulled_at_ms || null,
    done_at_ms: cmd.done_at_ms || null,
    ok: typeof cmd.ok === "boolean" ? cmd.ok : null,
    error: cmd.error || "",
    message: cmd.message || "",
    event_id: cmd.event_id || "",
    plate: cmd.plate || "",
    gate_close_due_ms: Number(cmd.gate_close_due_ms) || null,
  };
}

function esp32CommandMatches(cmd, deviceId, mac) {
  if (!cmd || typeof cmd !== "object") return false;
  const cmdDevice = String(cmd.device_id || "").trim();
  const cmdMac = String(cmd.mac || "").trim().toLowerCase();
  const dev = String(deviceId || "").trim();
  const m = String(mac || "").trim().toLowerCase();
  if (cmdDevice && dev && cmdDevice !== dev) return false;
  if (cmdMac && m && cmdMac !== m) return false;
  return true;
}

function enqueueEsp32Command(body = {}, source = "api") {
  const type = String(body?.type || body?.command || "servo_flip").trim() || "servo_flip";
  if (!["servo_flip", "drive_action"].includes(type)) {
    return { ok: false, error: "unsupported_command", message: "Supported commands are servo_flip and drive_action." };
  }
  const payload = body?.payload && typeof body.payload === "object" ? body.payload : body;
  const action = type === "drive_action" ? String(payload?.action || "").trim() : "";
  if (type === "drive_action" && !["左转", "直行", "右转", "停车"].includes(action)) {
    return { ok: false, error: "bad_drive_action", message: "drive_action requires 左转、直行、右转 or 停车." };
  }
  const commandId = cleanUserTemplate(body?.id || `cmd_${Date.now()}_${randomUUID().slice(0, 8)}`, 160);
  if (!commandId) return { ok: false, error: "bad_command_id" };
  const existing = esp32State.commands.find((item) => String(item?.id || "") === commandId)
    || esp32State.commandHistory.find((item) => String(item?.id || "") === commandId)
    || esp32State.completedCommandMap?.get(commandId)
    || (esp32State.completedCommandIds?.has(commandId) ? { id: commandId, state: "done", ok: true } : null);
  if (existing) {
    const failed = existing.state === "failed" || existing.ok === false || existing.result?.ok === false;
    if (!failed) return { ok: true, duplicate: true, command: existing };
    // A failed command is retryable.  Keep its history for diagnostics, but
    // release the deterministic ID so a gate action can be attempted again.
    esp32State.completedCommandIds?.delete(commandId);
    esp32State.completedCommandMap?.delete(commandId);
    esp32State.commands = esp32State.commands.filter((item) => String(item?.id || "") !== commandId);
  }
  const command = {
    id: commandId,
    type,
    action,
    device_id: cleanDeviceId(body?.device_id || body?.deviceId || body?.device, ""),
    mac: String(body?.mac || "").trim(),
    angle: clampEsp32Angle(payload?.angle, esp32State.cfg.angle),
    hold_ms: clampEsp32HoldMs(payload?.hold_ms, esp32State.cfg.hold_ms),
    return_angle: clampEsp32Angle(payload?.return_angle, esp32State.cfg.return_angle),
    return_enabled: typeof payload?.return_enabled === "boolean" ? payload.return_enabled : Boolean(esp32State.cfg.return_enabled),
    state: "queued",
    source,
    created_at_ms: Date.now(),
    created_at: nowBjText(),
    pulled_at_ms: null,
    done_at_ms: null,
    ok: null,
    error: "",
    message: "",
    event_id: cleanUserTemplate(body?.event_id, 160),
    plate: cleanUserTemplate(body?.plate, 80),
    gate_close_due_ms: Number.isFinite(Number(body?.gate_close_due_ms)) ? Math.max(0, Math.floor(Number(body.gate_close_due_ms))) : null,
  };
  const maxQueued = clamp(parseInt(process.env.ESP32_COMMAND_QUEUE_MAX || "50", 10) || 50, 5, 500);
  // Keep active/pulled commands intact.  Before adding a new command, evict
  // only the oldest queued commands and persist a cancellation tombstone for
  // each one so the eviction survives a restart.
  const queuedCommands = esp32State.commands.filter((item) => item?.state === "queued");
  const needEvict = Math.max(0, esp32State.commands.length - maxQueued + 1);
  if (needEvict > 0) {
    const evict = queuedCommands.slice(0, needEvict);
    if (evict.length < needEvict) {
      return { ok: false, error: "command_queue_full", message: "ESP32 command queue is full of active commands." };
    }
    for (const old of evict) {
      if (!cancelEsp32Command(old, "queue_limit")) {
        return { ok: false, error: "command_cancel_persist_failed", message: "Unable to persist ESP32 command queue eviction." };
      }
    }
    const evictIds = new Set(evict.map((item) => String(item.id)));
    esp32State.commands = esp32State.commands.filter((item) => !evictIds.has(String(item?.id || "")));
  }
  if (!appendDurableJsonLine(path.join(logRoot, "esp32_events.jsonl"), { event: "command_enqueue", time_bj: nowBjText(), command: publicEsp32Command(command) })) {
    return { ok: false, error: "command_persist_failed", message: "Unable to durably enqueue the ESP32 command." };
  }
  esp32State.commands.push(command);
  return { ok: true, command };
}

function cancelEsp32Command(command, reason = "cancelled") {
  const id = String(command?.id || "").trim();
  if (!id) return true;
  const event = {
    event: "command_cancel",
    time_bj: nowBjText(),
    command_id: id,
    reason: cleanUserTemplate(reason, 80),
    command: publicEsp32Command(command),
  };
  if (!appendDurableJsonLine(path.join(logRoot, "esp32_events.jsonl"), event)) return false;
  if (!esp32State.cancelledCommandIds) esp32State.cancelledCommandIds = new Set();
  esp32State.cancelledCommandIds.add(id);
  return true;
}

function rkGateCommandId(eventId, action, target = {}) {
  const source = `${String(eventId || "")}|${String(action || "")}|${String(target?.device_id || "")}|${String(target?.mac || "").toLowerCase()}`;
  if (!String(eventId || "").trim()) return "";
  return `rk_gate_${String(action || "cmd")}_${createHash("sha256").update(source).digest("hex").slice(0, 32)}`;
}

function esp32GateTargetFromMeta(meta = {}) {
  const targetDeviceId = cleanDeviceId(
    meta?.target_device_id || meta?.targetDeviceId || meta?.device_id || meta?.deviceId || meta?.device,
    "",
  );
  const targetMac = String(meta?.target_mac || meta?.targetMac || meta?.mac || "").trim();
  return {
    device_id: targetDeviceId || esp32State.cfg.device_id || esp32State.device_id,
    mac: targetMac || esp32State.cfg.mac || esp32State.mac,
  };
}

function esp32GateKey(target = {}) {
  const deviceId = cleanDeviceId(target?.device_id || target?.deviceId || target?.device, "");
  const mac = String(target?.mac || "").trim().toLowerCase();
  if (deviceId) return `device:${deviceId}`;
  if (mac) return `mac:${mac}`;
  return "default";
}

function createEsp32GateState(target = {}) {
  return {
    enabled: Boolean(esp32State.cfg.gate_enabled),
    open: false,
    closing: false,
    close_due_ms: 0,
    timer: null,
    last_plate: "",
    last_plate_at_ms: 0,
    last_open_command_id: "",
    last_close_command_id: "",
    last_event: "",
    last_error: "",
    target_key: esp32GateKey(target),
    target_device_id: cleanDeviceId(target?.device_id || target?.deviceId || target?.device, ""),
    target_mac: String(target?.mac || "").trim(),
    event_id: "",
  };
}

function esp32DefaultGateTarget() {
  return {
    device_id: esp32State.cfg.device_id || esp32State.device_id || "",
    mac: esp32State.cfg.mac || esp32State.mac || "",
  };
}

function getEsp32Gate(target = {}) {
  const mergedTarget = {
    device_id: target?.device_id || target?.deviceId || target?.device || "",
    mac: target?.mac || "",
  };
  const key = esp32GateKey(mergedTarget);
  if (!esp32State.gates || typeof esp32State.gates !== "object") esp32State.gates = {};
  if (!esp32State.gates[key]) esp32State.gates[key] = createEsp32GateState(mergedTarget);
  const gate = esp32State.gates[key];
  gate.enabled = Boolean(esp32State.cfg.gate_enabled);
  gate.target_key = key;
  if (mergedTarget.device_id) gate.target_device_id = cleanDeviceId(mergedTarget.device_id, gate.target_device_id || "");
  if (mergedTarget.mac) gate.target_mac = String(mergedTarget.mac).trim();
  return gate;
}

function syncEsp32PrimaryGate(gate = null) {
  if (!gate) {
    const gates = Object.values(esp32State.gates || {});
    gate = gates.find((g) => g && (g.open || g.closing)) || gates.find((g) => g && (g.last_plate || g.last_event)) || getEsp32Gate(esp32DefaultGateTarget());
  }
  esp32State.gate = gate;
  return gate;
}

function findEsp32GateByCommandId(commandId) {
  const id = String(commandId || "");
  if (!id) return null;
  return Object.values(esp32State.gates || {}).find((g) => g && (g.last_open_command_id === id || g.last_close_command_id === id)) || null;
}

function scheduleEsp32GateClose(gate = null) {
  const g = gate || syncEsp32PrimaryGate();
  if (g.timer) {
    clearTimeout(g.timer);
    g.timer = null;
  }
  const due = Number(g.close_due_ms || 0) || 0;
  if (!g.open || !due) return;
  const waitMs = Math.max(50, due - Date.now());
  g.timer = setTimeout(() => {
    g.timer = null;
    closeEsp32GateIfDue(g);
  }, Math.min(waitMs, 2_147_000_000));
  syncEsp32PrimaryGate(g);
}

function openEsp32GateForPlate(plate, meta = {}) {
  if (!esp32State.cfg.gate_enabled) return { ok: true, skipped: true, reason: "gate_disabled" };
  const now = Date.now();
  const target = esp32GateTargetFromMeta(meta);
  const gate = getEsp32Gate(target);
  const holdMs = clamp(parseInt(String(esp32State.cfg.gate_hold_ms || "20000"), 10) || 20000, 1000, 300000);
  const due = now + holdMs;
  const wasOpen = Boolean(gate.open);
  const wasClosing = Boolean(gate.closing);
  const previousGateState = {
    open: gate.open,
    closing: gate.closing,
    close_due_ms: gate.close_due_ms,
    last_plate: gate.last_plate,
    last_plate_at_ms: gate.last_plate_at_ms,
    last_open_command_id: gate.last_open_command_id,
    last_close_command_id: gate.last_close_command_id,
    last_event: gate.last_event,
    last_error: gate.last_error,
    event_id: gate.event_id,
    target_device_id: gate.target_device_id,
    target_mac: gate.target_mac,
  };
  const queuedCloseCommands = esp32State.commands.filter((cmd) =>
    cmd?.source === "gate_close" && cmd.state === "queued" && esp32CommandMatches(cmd, target.device_id, target.mac));
  for (const cmd of queuedCloseCommands) {
    if (!cancelEsp32Command(cmd, "gate_reopened")) {
      gate.last_error = "command_cancel_persist_failed";
      syncEsp32PrimaryGate(gate);
      return { ok: false, error: "command_cancel_persist_failed", message: "Unable to durably cancel the pending gate-close command" };
    }
  }
  for (const cmd of queuedCloseCommands) {
    const idx = esp32State.commands.indexOf(cmd);
    if (idx >= 0) esp32State.commands.splice(idx, 1);
  }
  const removedCloseCount = queuedCloseCommands.length;
  if (removedCloseCount > 0) {
    gate.last_close_command_id = "";
  }
  if (wasClosing) {
    gate.last_close_command_id = "";
  }
  gate.enabled = true;
  gate.open = true;
  gate.closing = false;
  gate.close_due_ms = due;
  gate.last_plate = String(plate || "").trim();
  gate.last_plate_at_ms = now;
  gate.target_device_id = target.device_id || "";
  gate.target_mac = target.mac || "";
  if (meta?.event_id) gate.event_id = cleanUserTemplate(meta.event_id, 160);
  gate.last_event = "extend";
  gate.last_error = "";

  const hasOpenCommand =
    esp32State.commands.some((cmd) => cmd.source === "gate_open" && (cmd.state === "queued" || cmd.state === "pulled") && esp32CommandMatches(cmd, target.device_id, target.mac)) ||
    (esp32State.last_command_state === "pulled" && esp32State.last_command_id === gate.last_open_command_id);
  let command = null;
  let duplicateResult = null;
  const shouldSendOpen = !hasOpenCommand && (!wasOpen || wasClosing || removedCloseCount > 0 || Boolean(previousGateState.last_error));
  if (shouldSendOpen) {
    const r = enqueueEsp32Command({
      id: rkGateCommandId(meta?.event_id, "open", target) || undefined,
      type: "servo_flip",
      device_id: target.device_id,
      mac: target.mac,
      angle: esp32State.cfg.gate_open_angle,
      hold_ms: 200,
      return_angle: esp32State.cfg.gate_close_angle,
      return_enabled: false,
      event_id: meta?.event_id,
      plate: gate.last_plate,
      gate_close_due_ms: due,
    }, "gate_open");
    if (!r.ok) {
      Object.assign(gate, previousGateState);
      gate.last_error = r.error || "gate_open_failed";
      scheduleEsp32GateClose(gate);
      syncEsp32PrimaryGate(gate);
      return r;
    }
    command = r.command;
    gate.last_open_command_id = command.id;
    duplicateResult = r.duplicate && command && command.result && typeof command.result === "object"
      ? command.result
      : null;
    if (duplicateResult) {
      if (duplicateResult.ok === true) {
        gate.open = true;
        gate.closing = false;
        gate.last_event = "open_done";
        gate.last_error = "";
      } else {
        gate.open = false;
        gate.closing = false;
        gate.close_due_ms = 0;
        gate.last_event = "open_failed";
        gate.last_error = duplicateResult.error || duplicateResult.message || "gate_open_failed";
      }
    } else {
      gate.last_event = "open";
    }
  }

  appendDurableJsonLine(path.join(logRoot, "esp32_events.jsonl"), {
    event: command ? "gate_open" : "gate_extend",
    time_bj: nowBjText(),
    plate: gate.last_plate,
    hold_ms: holdMs,
    close_due_ms: due,
    source: meta?.source || "",
    event_id: cleanUserTemplate(meta?.event_id, 160),
    target_key: gate.target_key || "",
    target_device_id: target.device_id || "",
    target_mac: target.mac || "",
    command: publicEsp32Command(command),
  });
  scheduleEsp32GateClose(gate);
  if (duplicateResult && duplicateResult.ok !== true) {
    return {
      ok: false,
      error: gate.last_error || "gate_open_failed",
      message: "The previous gate-open command failed; retry the same event.",
    };
  }
  return { ok: true, command: publicEsp32Command(command), close_due_ms: due, target_device_id: target.device_id || "", target_mac: target.mac || "" };
}

function closeEsp32GateIfDue(targetOrForce = false, forceArg = false) {
  const force = typeof targetOrForce === "boolean" ? targetOrForce : Boolean(forceArg);
  const gate = typeof targetOrForce === "object" && targetOrForce ? targetOrForce : syncEsp32PrimaryGate();
  if (!gate.open) return { ok: true, skipped: true, reason: "gate_already_closed" };
  const now = Date.now();
  const due = Number(gate.close_due_ms || 0) || 0;
  if (!force && due && now < due) {
    scheduleEsp32GateClose(gate);
    return { ok: true, skipped: true, reason: "gate_hold_active", close_due_ms: due };
  }
  const r = enqueueEsp32Command({
    id: rkGateCommandId(gate.event_id, "close", {
      device_id: gate.target_device_id || esp32State.cfg.device_id || esp32State.device_id,
      mac: gate.target_mac || esp32State.cfg.mac || esp32State.mac,
    }) || undefined,
    type: "servo_flip",
    device_id: gate.target_device_id || esp32State.cfg.device_id || esp32State.device_id,
    mac: gate.target_mac || esp32State.cfg.mac || esp32State.mac,
    angle: esp32State.cfg.gate_close_angle,
    hold_ms: 200,
    return_angle: esp32State.cfg.gate_close_angle,
    return_enabled: false,
    event_id: gate.event_id,
    plate: gate.last_plate,
    gate_close_due_ms: 0,
  }, "gate_close");
  if (!r.ok) {
    gate.last_error = r.error || "gate_close_failed";
    scheduleEsp32GateClose(gate);
    syncEsp32PrimaryGate(gate);
    return r;
  }
  if (r.duplicate && r.command?.result && typeof r.command.result === "object") {
    const duplicateResult = r.command.result;
    if (duplicateResult.ok === true) {
      gate.open = false;
      gate.closing = false;
      gate.close_due_ms = 0;
      gate.last_close_command_id = r.command.id;
      gate.last_open_command_id = "";
      gate.last_event = force ? "force_close_done" : "close_done";
      gate.last_error = "";
      if (gate.timer) {
        clearTimeout(gate.timer);
        gate.timer = null;
      }
      syncEsp32PrimaryGate(gate);
      return { ok: true, duplicate: true, command: publicEsp32Command(r.command) };
    }
    gate.open = true;
    gate.closing = false;
    gate.last_event = "close_failed";
    gate.last_error = duplicateResult.error || duplicateResult.message || "gate_close_failed";
    scheduleEsp32GateClose(gate);
    syncEsp32PrimaryGate(gate);
    return { ok: false, error: gate.last_error, message: "The previous gate-close command failed; retry the same event." };
  }
  gate.open = false;
  gate.closing = true;
  gate.close_due_ms = 0;
  gate.last_close_command_id = r.command.id;
  gate.last_open_command_id = "";
  gate.last_event = force ? "force_close" : "close";
  gate.last_error = "";
  appendDurableJsonLine(path.join(logRoot, "esp32_events.jsonl"), {
    event: gate.last_event,
    time_bj: nowBjText(),
    plate: gate.last_plate,
    event_id: gate.event_id || "",
    target_key: gate.target_key || "",
    target_device_id: gate.target_device_id || "",
    target_mac: gate.target_mac || "",
    command: publicEsp32Command(r.command),
  });
  syncEsp32PrimaryGate(gate);
  return { ok: true, command: publicEsp32Command(r.command) };
}

function rkPlateSideEffectFailure(blacklistHit, gate) {
  if (blacklistHit?.hit_persist_failed) {
    return { error: "blacklist_persist_failed", message: "Blacklist hit state could not be durably saved" };
  }
  if (!gate || gate.ok !== true) {
    return {
      error: gate?.error || "gate_command_failed",
      message: gate?.message || "The plate was saved; gate side effects will be retried with the same event_id",
    };
  }
  return null;
}

function removeQueuedEsp32GateCommands() {
  let count = 0;
  for (let i = esp32State.commands.length - 1; i >= 0; i--) {
    const cmd = esp32State.commands[i];
    if ((cmd?.source === "gate_open" || cmd?.source === "gate_close") && cmd.state === "queued") {
      if (cancelEsp32Command(cmd, "gate_disabled")) {
        esp32State.commands.splice(i, 1);
        count += 1;
      }
    }
  }
  return count;
}

function clearEsp32GateTimer() {
  for (const gate of Object.values(esp32State.gates || {})) {
    if (gate?.timer) {
      clearTimeout(gate.timer);
      gate.timer = null;
    }
  }
  if (esp32State.gate.timer) {
    clearTimeout(esp32State.gate.timer);
    esp32State.gate.timer = null;
  }
}

function pullEsp32Command(query = {}) {
  const deviceId = cleanDeviceId(query.device_id || query.deviceId || query.device, "");
  const mac = String(query.mac || "").trim();
  const now = Date.now();
  esp32State.last_seen_ms = now;
  if (deviceId) esp32State.device_id = deviceId;
  if (mac) esp32State.mac = mac;
  const leaseMs = clamp(parseInt(process.env.ESP32_COMMAND_LEASE_MS || "10000", 10) || 10000, 1000, 120000);
  const idx = esp32State.commands.findIndex((cmd) => {
    if (!esp32CommandMatches(cmd, deviceId, mac)) return false;
    if (cmd.state === "queued") return true;
    if (cmd.state === "pulled" && cmd.pulled_at_ms && now - Number(cmd.pulled_at_ms) > leaseMs) return true;
    return false;
  });
  if (idx < 0) return { ok: true, command: null };
  const cmd = esp32State.commands[idx];
  // The pull is an acknowledgement boundary. Persist the transition before
  // mutating memory so a journal failure leaves the command queued and safe
  // to retry after the device reconnects or the process restarts.
  const pulledCommand = {
    ...cmd,
    state: "pulled",
    pulled_at_ms: now,
    pulled_at: nowBjText(),
  };
  if (!appendDurableJsonLine(path.join(logRoot, "esp32_events.jsonl"), {
    event: "command_pull",
    time_bj: nowBjText(),
    device_id: deviceId || null,
    mac: mac || null,
    command: publicEsp32Command(pulledCommand),
  })) {
    return { ok: false, error: "command_pull_persist_failed", message: "Unable to durably save the ESP32 command pull" };
  }
  Object.assign(cmd, pulledCommand);
  esp32State.servo_busy = true;
  esp32State.last_command_id = cmd.id;
  esp32State.last_command_state = "pulled";
  esp32State.last_command_at_ms = now;
  return { ok: true, command: cmd };
}

function finishEsp32Command(body = {}) {
  const id = String(body?.id || body?.command_id || "").trim();
  if (!id) return { ok: false, error: "bad_command_id" };
  const historical = esp32State.commandHistory.find((item) => String(item?.id || "") === id)
    || esp32State.completedCommandMap?.get(id);
  if (historical) {
    return { ok: true, duplicate: true, command: historical, result: historical.result || null };
  }
  const idx = esp32State.commands.findIndex((cmd) => String(cmd.id) === id);
  const now = Date.now();
  const ok = Boolean(body?.ok);
  const requestedState = String(body?.state || "").trim().toLowerCase();
  // Keep the durable state machine closed: arbitrary device strings would be
  // restored as queued after a restart by normalizeRestoredEsp32Command.
  const state = ["done", "failed"].includes(requestedState)
    ? requestedState
    : (ok ? "done" : "failed");
  const result = {
    id,
    device_id: cleanDeviceId(body?.device_id || body?.deviceId || body?.device, ""),
    mac: String(body?.mac || "").trim(),
    ok,
    state,
    message: String(body?.message || "").slice(0, 500),
    error: String(body?.error || "").slice(0, 500),
    angle: body?.angle == null ? null : clampEsp32Angle(body.angle, esp32State.cfg.angle),
    hold_ms: body?.hold_ms == null ? null : clampEsp32HoldMs(body.hold_ms, esp32State.cfg.hold_ms),
    return_angle: body?.return_angle == null ? null : clampEsp32Angle(body.return_angle, esp32State.cfg.return_angle),
    return_enabled: typeof body?.return_enabled === "boolean" ? body.return_enabled : null,
    done_at_ms: now,
    done_at: nowBjText(),
    raw: body && typeof body === "object" ? body : null,
  };
  if (!appendDurableJsonLine(path.join(logRoot, "esp32_events.jsonl"), { event: "command_result", time_bj: nowBjText(), result })) {
    return { ok: false, error: "command_result_persist_failed", message: "Unable to durably save the ESP32 command result" };
  }
  esp32State.last_seen_ms = now;
  if (result.device_id) esp32State.device_id = result.device_id;
  if (result.mac) esp32State.mac = result.mac;
  let cmd = idx >= 0 ? esp32State.commands[idx] : null;
  const cmdSource = cmd?.source || "";
  if (cmd) {
    cmd.state = state;
    cmd.ok = ok;
    cmd.error = result.error;
    cmd.message = result.message;
    cmd.done_at_ms = now;
    cmd.done_at = result.done_at;
    cmd.result = result;
    esp32State.commands.splice(idx, 1);
  } else {
    cmd = { id, type: String(body?.type || "servo_flip"), state, ok, done_at_ms: now, result };
  }
  const historyItem = { ...publicEsp32Command(cmd), result };
  esp32State.commandHistory.unshift(historyItem);
  if (!esp32State.completedCommandIds) esp32State.completedCommandIds = new Set();
  if (!esp32State.completedCommandMap) esp32State.completedCommandMap = new Map();
  esp32State.completedCommandIds.add(id);
  esp32State.completedCommandMap.set(id, historyItem);
  const maxHistory = clamp(parseInt(process.env.ESP32_COMMAND_HISTORY_MAX || "80", 10) || 80, 10, 500);
  if (esp32State.commandHistory.length > maxHistory) esp32State.commandHistory.length = maxHistory;
  esp32State.last_command_id = id;
  esp32State.last_command_state = state;
  esp32State.last_command_result = result;
  esp32State.last_command_at_ms = now;
  esp32State.last_servo_at_ms = now;
  esp32State.last_servo_result = result;
  esp32State.servo_busy = false;
  if (typeof body?.servo_ready === "boolean") esp32State.servo_ready = body.servo_ready;
  if (result.error) esp32State.last_error = result.error;
  else if (ok) esp32State.last_error = "";
  const gate = findEsp32GateByCommandId(id) || esp32State.gate;
  if (cmdSource === "gate_open" && gate && id === gate.last_open_command_id) {
    if (ok) {
      gate.open = true;
      gate.closing = false;
      gate.last_event = "open_done";
      gate.last_error = "";
      scheduleEsp32GateClose(gate);
    } else {
      gate.open = false;
      gate.closing = false;
      gate.close_due_ms = 0;
      gate.last_error = result.error || result.message || "gate_open_failed";
      if (gate.timer) {
        clearTimeout(gate.timer);
        gate.timer = null;
      }
    }
    syncEsp32PrimaryGate(gate);
  } else if (cmdSource === "gate_close" && gate && id === gate.last_close_command_id) {
    gate.closing = false;
    if (ok) {
      gate.open = false;
      gate.close_due_ms = 0;
      gate.last_event = "close_done";
      gate.last_error = "";
    } else {
      gate.open = true;
      gate.last_event = "close_failed";
      gate.last_error = result.error || result.message || "gate_close_failed";
    }
    syncEsp32PrimaryGate(gate);
  }
  return { ok: true, command: cmd, result };
}

function normalizeRestoredEsp32Command(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = cleanUserTemplate(value.id || value.command_id, 160);
  if (!id) return null;
  const stateText = String(value.state || "queued").trim().toLowerCase();
  const state = ["queued", "pulled", "done", "failed"].includes(stateText) ? stateText : "queued";
  const numberOrNull = (input) => {
    const n = Number(input);
    return Number.isFinite(n) ? n : null;
  };
  const command = {
    id,
    type: String(value.type || value.command || "servo_flip").trim() || "servo_flip",
    action: ["左转", "直行", "右转", "停车"].includes(String(value.action || "").trim()) ? String(value.action).trim() : "",
    source: cleanUserTemplate(value.source, 80),
    angle: clampEsp32Angle(value.angle, esp32State.cfg.angle),
    hold_ms: clampEsp32HoldMs(value.hold_ms, esp32State.cfg.hold_ms),
    return_angle: clampEsp32Angle(value.return_angle, esp32State.cfg.return_angle),
    return_enabled: typeof value.return_enabled === "boolean" ? value.return_enabled : Boolean(esp32State.cfg.return_enabled),
    device_id: cleanDeviceId(value.device_id || value.deviceId || value.device, ""),
    mac: String(value.mac || "").trim(),
    state,
    created_at_ms: numberOrNull(value.created_at_ms),
    created_at: cleanUserTemplate(value.created_at, 32),
    pulled_at_ms: numberOrNull(value.pulled_at_ms),
    pulled_at: cleanUserTemplate(value.pulled_at, 32),
    done_at_ms: numberOrNull(value.done_at_ms),
    done_at: cleanUserTemplate(value.done_at, 32),
    ok: typeof value.ok === "boolean" ? value.ok : null,
    error: cleanUserTemplate(value.error, 500),
    message: cleanUserTemplate(value.message, 500),
    event_id: cleanUserTemplate(value.event_id, 160),
    plate: cleanUserTemplate(value.plate, 80),
    gate_close_due_ms: numberOrNull(value.gate_close_due_ms),
  };
  if (value.result && typeof value.result === "object" && !Array.isArray(value.result)) command.result = value.result;
  return command;
}

function restoredEsp32Gate(row = {}, command = null) {
  const source = row && typeof row === "object" ? row : {};
  const cmd = command && typeof command === "object" ? command : (source.command && typeof source.command === "object" ? source.command : {});
  const target = {
    device_id: cleanDeviceId(source.target_device_id || cmd.device_id, ""),
    mac: String(source.target_mac || cmd.mac || "").trim(),
  };
  const explicitKey = cleanUserTemplate(source.target_key, 160);
  const key = explicitKey || esp32GateKey(target);
  if (!esp32State.gates || typeof esp32State.gates !== "object") esp32State.gates = {};
  if (!esp32State.gates[key]) {
    esp32State.gates[key] = createEsp32GateState(target);
    esp32State.gates[key].target_key = key;
  }
  const gate = esp32State.gates[key];
  gate.target_key = key;
  if (target.device_id) gate.target_device_id = target.device_id;
  if (target.mac) gate.target_mac = target.mac;
  return gate;
}

function restoreEsp32GateCommandLink(command) {
  if (!command || (command.source !== "gate_open" && command.source !== "gate_close")) return null;
  const gate = restoredEsp32Gate({
    target_device_id: command.device_id,
    target_mac: command.mac,
    target_key: esp32GateKey({ device_id: command.device_id, mac: command.mac }),
  }, command);
  if (command.source === "gate_open") {
    if (!gate.last_open_command_id || !gate.open) gate.last_open_command_id = command.id;
    if (command.event_id) gate.event_id = command.event_id;
    if (command.plate) gate.last_plate = command.plate;
    if (command.gate_close_due_ms) gate.close_due_ms = command.gate_close_due_ms;
  } else {
    gate.last_close_command_id = command.id;
    if (command.event_id) gate.event_id = command.event_id;
    if (command.plate) gate.last_plate = command.plate;
  }
  return gate;
}

function applyRestoredEsp32GateEvent(row) {
  if (!row || typeof row !== "object") return;
  const event = String(row.event || "").trim().toLowerCase();
  if (!["gate_open", "gate_extend", "close", "force_close", "gate_close", "close_done"].includes(event)) return;
  const command = row.command && typeof row.command === "object" ? normalizeRestoredEsp32Command(row.command) : null;
  const gate = restoredEsp32Gate(row, command);
  const eventId = cleanUserTemplate(row.event_id || command?.event_id, 160);
  if (eventId) gate.event_id = eventId;
  const plate = cleanUserTemplate(row.plate || command?.plate, 80);
  if (plate) gate.last_plate = plate;
  const createdAt = Number(command?.created_at_ms);
  if (Number.isFinite(createdAt) && createdAt > 0) gate.last_plate_at_ms = createdAt;
  if (event === "gate_open" || event === "gate_extend") {
    gate.enabled = true;
    gate.open = true;
    gate.closing = false;
    const due = Number(row.close_due_ms || command?.gate_close_due_ms || 0);
    if (Number.isFinite(due) && due > 0) gate.close_due_ms = Math.floor(due);
    if (command?.id) gate.last_open_command_id = command.id;
    gate.last_event = event === "gate_extend" ? "extend" : "open";
    gate.last_error = "";
  } else {
    gate.open = false;
    gate.closing = event !== "close_done";
    gate.close_due_ms = 0;
    if (command?.id) gate.last_close_command_id = command.id;
    gate.last_open_command_id = "";
    gate.last_event = event === "force_close" ? "force_close" : event === "close_done" ? "close_done" : "close";
  }
}

function applyRestoredEsp32CommandResult(command, result) {
  if (!command || !result) return;
  const gate = restoreEsp32GateCommandLink(command);
  if (!gate) return;
  const ok = result.ok === true;
  if (command.source === "gate_open" && gate.last_open_command_id === command.id) {
    if (ok) {
      gate.open = true;
      gate.closing = false;
      gate.last_event = "open_done";
      gate.last_error = "";
    } else {
      gate.open = false;
      gate.closing = false;
      gate.close_due_ms = 0;
      gate.last_error = cleanUserTemplate(result.error || result.message, 500);
    }
  } else if (command.source === "gate_close" && gate.last_close_command_id === command.id) {
    gate.closing = false;
    if (ok) {
      gate.open = false;
      gate.close_due_ms = 0;
      gate.last_event = "close_done";
      gate.last_error = "";
    } else {
      gate.open = true;
      gate.last_error = cleanUserTemplate(result.error || result.message, 500);
      gate.last_event = "close_failed";
    }
  }
}

function applyRestoredEsp32CommandCancel(command, reason = "cancelled") {
  if (!command || typeof command !== "object") return;
  const id = String(command.id || "");
  if (!id) return;
  const gate = restoreEsp32GateCommandLink(command);
  if (!gate) return;
  const text = cleanUserTemplate(reason, 120) || "cancelled";
  if (command.source === "gate_open" && gate.last_open_command_id === id) {
    gate.last_open_command_id = "";
    gate.open = false;
    gate.closing = false;
    gate.close_due_ms = 0;
    gate.last_event = "open_cancelled";
    gate.last_error = text;
    if (gate.timer) {
      clearTimeout(gate.timer);
      gate.timer = null;
    }
  } else if (command.source === "gate_close" && gate.last_close_command_id === id) {
    // closeEsp32GateIfDue marks the gate closed before the device executes the
    // queued command.  A cancellation means that physical close never
    // happened, so restore the gate to the open state and let a later
    // gate-open/extend event override it when present.
    gate.last_close_command_id = "";
    gate.open = true;
    gate.closing = false;
    gate.last_event = "close_cancelled";
    gate.last_error = text;
  }
}

function restoreEsp32CommandState() {
  const filePath = path.join(logRoot, "esp32_events.jsonl");
  const rows = readJsonlAll(filePath, 120_000_000);
  if (!rows.length) return { restored: false, commands: 0, history: 0, gates: 0 };
  const pending = new Map();
  const completed = new Map();
  const historyRows = [];
  const cancelled = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const event = String(row.event || "").trim().toLowerCase();
    if (event === "config") {
      const cfg = row.config && typeof row.config === "object" && !Array.isArray(row.config) ? row.config : null;
      if (cfg) {
        if (cfg.device_id) esp32State.device_id = cleanDeviceId(cfg.device_id, esp32State.device_id);
        if (cfg.mac) esp32State.mac = String(cfg.mac).trim();
        if (cfg.gate_enabled === false) {
          for (const gate of Object.values(esp32State.gates || {})) {
            if (!gate) continue;
            gate.enabled = false;
            gate.open = false;
            gate.closing = false;
            gate.close_due_ms = 0;
            gate.last_event = "disabled";
            gate.last_error = "";
          }
        }
      }
      continue;
    }
    if (event === "command_enqueue") {
      const command = normalizeRestoredEsp32Command(row.command);
      if (!command) continue;
      if (completed.has(command.id)) {
        const prior = completed.get(command.id);
        const priorFailed = prior?.state === "failed" || prior?.ok === false || prior?.result?.ok === false;
        if (!priorFailed) continue;
        // A later enqueue retries a failed deterministic command.  Keep the
        // old result in history, but let the new command become authoritative.
        completed.delete(command.id);
      }
      // A later enqueue with the same ID starts a new logical command after a
      // previous cancellation; consume the old tombstone in that case.
      cancelled.delete(command.id);
      pending.set(command.id, command);
      if (command.source === "gate_open" || command.source === "gate_close") restoreEsp32GateCommandLink(command);
      continue;
    }
    if (event === "command_cancel") {
      const id = cleanUserTemplate(row.command_id || row.command?.id, 160);
      if (!id || completed.has(id)) continue;
      const command = normalizeRestoredEsp32Command(row.command)
        || pending.get(id)
        || { id, source: "", state: "queued" };
      pending.delete(id);
      cancelled.add(id);
      applyRestoredEsp32CommandCancel(command, row.reason);
      continue;
    }
    if (event === "command_pull") {
      const pulled = normalizeRestoredEsp32Command(row.command);
      if (!pulled || completed.has(pulled.id) || cancelled.has(pulled.id)) continue;
      const prior = pending.get(pulled.id) || {};
      // A pulled command without a result is deliberately requeued below.
      pending.set(pulled.id, { ...prior, ...pulled, state: "queued", pulled_at_ms: null, pulled_at: "" });
      if (pulled.device_id) esp32State.device_id = pulled.device_id;
      if (pulled.mac) esp32State.mac = pulled.mac;
      continue;
    }
    if (event === "command_result") {
      const rawResult = row.result && typeof row.result === "object" ? row.result : null;
      const id = cleanUserTemplate(rawResult?.id || row.command_id, 160);
      if (!id || completed.has(id) || cancelled.has(id)) continue;
      const prior = pending.get(id) || normalizeRestoredEsp32Command(rawResult) || { id, type: "servo_flip" };
      const result = rawResult || { id, ok: false, state: "failed" };
      const command = normalizeRestoredEsp32Command({
        ...prior,
        state: String(result.state || (result.ok ? "done" : "failed")),
        ok: typeof result.ok === "boolean" ? result.ok : false,
        error: result.error || prior.error,
        message: result.message || prior.message,
        done_at_ms: result.done_at_ms || prior.done_at_ms,
        done_at: result.done_at || prior.done_at,
        result,
      }) || { ...prior, id, state: "done", result };
      pending.delete(id);
      completed.set(id, command);
      historyRows.push(command);
      applyRestoredEsp32CommandResult(command, result);
      esp32State.last_command_id = id;
      esp32State.last_command_state = command.state;
      esp32State.last_command_result = result;
      esp32State.last_command_at_ms = Number(result.done_at_ms) || Date.now();
      esp32State.last_seen_ms = Math.max(Number(esp32State.last_seen_ms) || 0, Number(result.done_at_ms) || 0);
      if (result.device_id) esp32State.device_id = cleanDeviceId(result.device_id, esp32State.device_id);
      if (result.mac) esp32State.mac = String(result.mac).trim();
      continue;
    }
    applyRestoredEsp32GateEvent(row);
  }

  // Reconstruct gate links for old journals that did not include gate_* rows.
  for (const command of pending.values()) restoreEsp32GateCommandLink(command);

  const maxQueued = clamp(parseInt(process.env.ESP32_COMMAND_QUEUE_MAX || "50", 10) || 50, 5, 500);
  esp32State.commands = Array.from(pending.values())
    .map((command) => ({ ...command, state: "queued", pulled_at_ms: null, pulled_at: "" }))
    .slice(-maxQueued);
  const maxHistory = clamp(parseInt(process.env.ESP32_COMMAND_HISTORY_MAX || "80", 10) || 80, 10, 500);
  esp32State.commandHistory = [];
  esp32State.completedCommandIds = new Set();
  esp32State.completedCommandMap = new Map();
  esp32State.cancelledCommandIds = new Set(cancelled);
  for (const command of historyRows.slice(-maxHistory)) {
    const historyItem = { ...publicEsp32Command(command), result: command.result || null };
    esp32State.commandHistory.unshift(historyItem);
    esp32State.completedCommandIds.add(command.id);
    esp32State.completedCommandMap.set(command.id, historyItem);
  }
  esp32State.servo_busy = false;
  for (const gate of Object.values(esp32State.gates || {})) {
    gate.timer = null;
    if (gate.open && Number(gate.close_due_ms) > 0) scheduleEsp32GateClose(gate);
  }
  syncEsp32PrimaryGate();
  return {
    restored: true,
    commands: esp32State.commands.length,
    history: esp32State.commandHistory.length,
    gates: Object.keys(esp32State.gates || {}).length,
  };
}

function esp32TargetFromInput(body, u) {
  const hostIn = safeHostText(body?.host || body?.ip || body?.esp32_host || u?.searchParams?.get("host") || u?.searchParams?.get("ip"));
  const portRaw = String(body?.port || body?.esp32_port || u?.searchParams?.get("port") || "").trim();
  const portIn = portRaw ? clamp(parseInt(portRaw, 10) || 80, 1, 65535) : null;
  if (hostIn) return { host: hostIn, port: portIn || 80, source: "request", base: `http://${hostIn}:${portIn || 80}` };

  const lastIp = safeHostText(esp32State.ip);
  const lastPort = clamp(parseInt(String(esp32State.port || "80"), 10) || 80, 1, 65535);
  const cfgHost = safeHostText(esp32State.cfg.host);
  const cfgPort = clamp(parseInt(String(esp32State.cfg.port || "80"), 10) || 80, 1, 65535);
  if (lastIp && esp32IsOnline()) return { host: lastIp, port: lastPort, source: "heartbeat", base: `http://${lastIp}:${lastPort}` };
  if (cfgHost) return { host: cfgHost, port: cfgPort, source: "config", base: `http://${cfgHost}:${cfgPort}` };
  if (lastIp) return { host: lastIp, port: lastPort, source: "heartbeat", base: `http://${lastIp}:${lastPort}` };

  return null;
}

function publicEsp32GateStatus(gate, now = Date.now()) {
  const g = gate || getEsp32Gate(esp32DefaultGateTarget());
  const due = Number(g.close_due_ms || 0) || 0;
  return {
    enabled: Boolean(esp32State.cfg.gate_enabled),
    key: g.target_key || "",
    target_device_id: g.target_device_id || "",
    target_mac: g.target_mac || "",
    open: Boolean(g.open),
    closing: Boolean(g.closing),
    close_due_ms: due || null,
    remain_ms: due ? Math.max(0, due - now) : 0,
    last_plate: g.last_plate || "",
    last_plate_at_ms: g.last_plate_at_ms || null,
    last_plate_age_ms: g.last_plate_at_ms ? Math.max(0, now - g.last_plate_at_ms) : null,
    last_event: g.last_event || "",
    last_error: g.last_error || "",
    open_angle: esp32State.cfg.gate_open_angle,
    close_angle: esp32State.cfg.gate_close_angle,
    hold_ms: esp32State.cfg.gate_hold_ms,
    last_open_command_id: g.last_open_command_id || "",
    last_close_command_id: g.last_close_command_id || "",
  };
}

function buildEsp32Status() {
  const at = Number(esp32State.last_seen_ms || 0) || 0;
  const target = esp32TargetFromInput({}, null);
  const now = Date.now();
  const leaseMs = clamp(parseInt(process.env.ESP32_COMMAND_LEASE_MS || "10000", 10) || 10000, 1000, 120000);
  const hasActive = esp32State.commands.some((cmd) => cmd.state === "pulled" && cmd.pulled_at_ms && now - Number(cmd.pulled_at_ms) <= leaseMs);
  const primaryGate = syncEsp32PrimaryGate();
  const gates = Object.values(esp32State.gates || {}).map((g) => publicEsp32GateStatus(g, now));
  return {
    ok: true,
    online: esp32IsOnline(),
    device: esp32State.device || "esp32-servo",
    device_id: esp32State.device_id || esp32State.cfg.device_id || "esp32-servo-01",
    mac: esp32State.mac || esp32State.cfg.mac || "",
    ip: esp32State.ip || "",
    port: Number(esp32State.port || 80) || 80,
    target: target?.base || "",
    target_host: target?.host || "",
    target_port: target?.port || esp32State.cfg.port || 80,
    target_source: target?.source || "",
    servo_ready: esp32State.servo_ready,
    servo_busy: Boolean(esp32State.servo_busy || hasActive),
    command_poll_enabled: esp32State.command_poll_enabled,
    command_poll_ms: esp32State.command_poll_ms ?? esp32State.cfg.command_poll_ms ?? null,
    heartbeat_ms: esp32State.cfg.heartbeat_ms,
    queued_commands: esp32State.commands.filter((cmd) => cmd.state === "queued").length,
    active_commands: esp32State.commands.filter((cmd) => cmd.state === "pulled").length,
    last_command_id: esp32State.last_command_id || "",
    last_command_state: esp32State.last_command_state || "",
    last_command_at_ms: esp32State.last_command_at_ms || null,
    last_command_result: esp32State.last_command_result || null,
    pending_command: publicEsp32Command(esp32State.commands[0]),
    command_history: esp32State.commandHistory.slice(0, 10),
    uptime_ms: esp32State.uptime_ms === null || esp32State.uptime_ms === undefined ? null : Number.isFinite(Number(esp32State.uptime_ms)) ? Number(esp32State.uptime_ms) : null,
    last_seen_at_ms: at || null,
    last_seen_age_ms: at ? Date.now() - at : null,
    latency_ms: esp32State.last_ping_ms === null || esp32State.last_ping_ms === undefined ? null : Number.isFinite(Number(esp32State.last_ping_ms)) ? Math.round(Number(esp32State.last_ping_ms)) : null,
    last_ping_at_ms: esp32State.last_ping_at_ms || null,
    last_servo_at_ms: esp32State.last_servo_at_ms || null,
    last_error: esp32State.last_error || "",
    gate: publicEsp32GateStatus(primaryGate, now),
    gates,
    config: { ...esp32State.cfg },
  };
}

const HEALTH_DEVICE_KEYS = ["backend", "rk3568", "esp32", "mysql"];

function healthNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function healthScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) * 10) / 10));
}

function resourcePenalty(value, warning, critical, warningPenalty, criticalPenalty) {
  const n = healthNumber(value);
  if (n === null) return 0;
  if (n >= critical) return criticalPenalty;
  if (n >= warning) return warningPenalty;
  return 0;
}

function buildDeviceHealthSnapshot() {
  const now = Date.now();
  const backend = buildBackendStatus();
  const resources = backend?.resources || {};
  const cpu = resources.cpu || {};
  const memory = resources.memory || {};
  const disk = resources.disk || {};
  const rk = rkReported.status && typeof rkReported.status === "object" ? rkReported.status : null;
  const rkOnline = rkIsOnline();
  const esp = buildEsp32Status();
  const mysql = mysqlPublicStatus();
  const anomalies = [];
  const addAnomaly = (device, severity, type, message, value = null) => {
    anomalies.push({ device, severity, type, message, value: healthNumber(value) });
  };

  const backendScore = 100
    - resourcePenalty(cpu.usage_pct, 80, 95, 15, 35)
    - resourcePenalty(memory.usage_pct, 80, 95, 15, 30)
    - resourcePenalty(disk.usage_pct, 85, 97, 15, 35);
  if (healthNumber(cpu.usage_pct) >= 95) addAnomaly("backend", "error", "cpu_high", "处理器占用过高", cpu.usage_pct);
  else if (healthNumber(cpu.usage_pct) >= 80) addAnomaly("backend", "warning", "cpu_high", "处理器占用偏高", cpu.usage_pct);
  if (healthNumber(memory.usage_pct) >= 95) addAnomaly("backend", "error", "memory_high", "内存占用过高", memory.usage_pct);
  else if (healthNumber(memory.usage_pct) >= 80) addAnomaly("backend", "warning", "memory_high", "内存占用偏高", memory.usage_pct);
  if (healthNumber(disk.usage_pct) >= 97) addAnomaly("backend", "error", "disk_high", "磁盘空间紧张", disk.usage_pct);
  else if (healthNumber(disk.usage_pct) >= 85) addAnomaly("backend", "warning", "disk_high", "磁盘空间偏紧张", disk.usage_pct);

  let rkScore = rk ? (rkOnline ? 100 : 0) : null;
  if (rk && !rkOnline) addAnomaly("rk3568", "offline", "device_offline", "RK3568 暂无最新状态");
  if (rk && rkOnline && rk.backend_ok === false) {
    rkScore -= 30;
    addAnomaly("rk3568", "error", "backend_timeout", "RK3568 访问后端失败", rk.backend_latency_ms);
  }
  if (rk && rkOnline && rk.input_mode === "pcie" && rk.pcie_driver_mounted === false) {
    rkScore -= 30;
    addAnomaly("rk3568", "error", "pcie_driver", "PCIe 驱动未挂载");
  }
  if (rk && Number(rk.pcie_protocol_errors) > 0) {
    rkScore -= 20;
    addAnomaly("rk3568", "error", "protocol_error", "采集协议出现错误", rk.pcie_protocol_errors);
  }
  if (rk && Number(rk.pcie_dropped_frames) > 0) {
    rkScore -= 8;
    addAnomaly("rk3568", "warning", "frame_drop", "采集过程中存在丢帧", rk.pcie_dropped_frames);
  }
  const detectorRuntime = rk?.plate_detector_runtime || rk?.pcie_plate_inference?.detector_runtime || {};
  if (detectorRuntime.last_error) {
    rkScore -= 18;
    addAnomaly("rk3568", "error", "detector_error", "推理链路报告错误");
  }
  if (Number(detectorRuntime.queue_depth) >= 4) {
    rkScore -= 8;
    addAnomaly("rk3568", "warning", "detector_queue", "推理任务排队偏多", detectorRuntime.queue_depth);
  }

  const hasEspTarget = Boolean(esp.target || esp.target_host || esp.mac || esp.ip || esp.last_seen_at_ms);
  let espScore = hasEspTarget ? (esp.online ? 100 : 0) : null;
  if (hasEspTarget && !esp.online) addAnomaly("esp32", "offline", "device_offline", "ESP32 暂无最新心跳");
  if (esp.online && esp.last_error) {
    espScore -= 24;
    addAnomaly("esp32", "error", "device_error", "ESP32 报告最近错误");
  }
  if (esp.online && esp.servo_ready === false) {
    espScore -= 18;
    addAnomaly("esp32", "warning", "servo_not_ready", "舵机尚未就绪");
  }
  if (esp.online && Number(esp.queued_commands) >= 5) {
    espScore -= 8;
    addAnomaly("esp32", "warning", "command_queue", "待执行动作较多", esp.queued_commands);
  }

  const mysqlEnabled = mysql?.enabled === true;
  let mysqlScore = mysqlEnabled ? (mysql.ready === true ? 100 : 0) : null;
  if (mysqlEnabled && mysql.ready !== true) {
    mysqlScore = 0;
    addAnomaly("mysql", "error", "database_unready", "数据库暂不可用");
  }

  return {
    schema: "rk3568.device_health.v1",
    sample_at_ms: now,
    time_bj: nowBjText(),
    devices: {
      backend: {
        online: true,
        score: healthScore(backendScore),
        latency_ms: null,
        cpu_pct: healthNumber(cpu.usage_pct),
        memory_pct: healthNumber(memory.usage_pct),
        disk_pct: healthNumber(disk.usage_pct),
      },
      rk3568: {
        online: rk ? rkOnline : null,
        score: rkScore === null ? null : healthScore(rkScore),
        latency_ms: healthNumber(rk?.backend_latency_ms),
        input_mode: String(rk?.input_mode || ""),
        capture_running: rk?.capture_running === true,
      },
      esp32: {
        online: hasEspTarget ? esp.online === true : null,
        score: espScore === null ? null : healthScore(espScore),
        latency_ms: healthNumber(esp.latency_ms),
        servo_ready: typeof esp.servo_ready === "boolean" ? esp.servo_ready : null,
      },
      mysql: {
        enabled: mysqlEnabled,
        online: mysqlEnabled ? mysql.ready === true : null,
        score: mysqlScore,
        latency_ms: healthNumber(mysql.last_latency_ms),
      },
    },
    anomalies,
  };
}

function recordDeviceHealth(force = false) {
  const now = Date.now();
  if (!force && now - deviceHealthLastSampleAt < 15_000) return null;
  const sample = buildDeviceHealthSnapshot();
  deviceHealthLastSampleAt = now;
  appendBoundedJsonLine(deviceHealthPath, sample);
  return sample;
}

function logAnalysisRange(value) {
  const key = String(value || "1h").trim().toLowerCase();
  const hours = { "1h": 1, "6h": 6, "24h": 24, "72h": 72, "7d": 168 }[key] || 1;
  return { key: Object.prototype.hasOwnProperty.call({ "1h": 1, "6h": 6, "24h": 24, "72h": 72, "7d": 168 }, key) ? key : "1h", ms: hours * 60 * 60 * 1000 };
}

function healthSamplesInRange(startMs, endMs) {
  const rows = tailJsonl(deviceHealthPath, DEVICE_HEALTH_MAX_SAMPLES, 24 * 1024 * 1024);
  return rows
    .filter((row) => Number(row?.sample_at_ms) >= startMs && Number(row?.sample_at_ms) <= endMs)
    .sort((a, b) => Number(a.sample_at_ms) - Number(b.sample_at_ms));
}

function healthEventSeverityRank(value) {
  return { info: 1, warning: 2, error: 3, offline: 3 }[String(value || "")] || 0;
}

function aggregateHealthEvents(samples, device, severity, bucketMs) {
  const incidents = [];
  const open = new Map();
  const maxGap = Math.max(90_000, bucketMs * 2);
  for (const sample of samples) {
    const at = Number(sample?.sample_at_ms) || 0;
    for (const item of Array.isArray(sample?.anomalies) ? sample.anomalies : []) {
      if (device !== "all" && item.device !== device) continue;
      if (severity !== "all" && item.severity !== severity) continue;
      const key = `${item.device}:${item.type}`;
      const prev = open.get(key);
      if (prev && at - prev.last_at_ms <= maxGap) {
        prev.last_at_ms = at;
        prev.occurrences += 1;
        if (item.value !== null && item.value !== undefined) prev.value = item.value;
      } else {
        const next = {
          id: `${key}:${at}`,
          device: item.device,
          severity: item.severity,
          type: item.type,
          message: item.message,
          value: item.value ?? null,
          first_at_ms: at,
          last_at_ms: at,
          occurrences: 1,
        };
        incidents.push(next);
        open.set(key, next);
      }
    }
  }
  return incidents
    .sort((a, b) => b.last_at_ms - a.last_at_ms)
    .map((item) => ({
      ...item,
      time_bj: new Date(item.first_at_ms).toLocaleString("zh-CN", { hour12: false }),
      last_time_bj: new Date(item.last_at_ms).toLocaleString("zh-CN", { hour12: false }),
      duration_ms: Math.max(0, item.last_at_ms - item.first_at_ms),
      severity_rank: healthEventSeverityRank(item.severity),
    }));
}

function buildLogAnalysis(req, query = {}) {
  recordDeviceHealth(false);
  const range = logAnalysisRange(query.range);
  const endMs = Date.now();
  const startMs = endMs - range.ms;
  const device = ["all", ...HEALTH_DEVICE_KEYS].includes(String(query.device || "all")) ? String(query.device || "all") : "all";
  const severity = ["all", "warning", "error", "offline"].includes(String(query.severity || "all")) ? String(query.severity || "all") : "all";
  const samples = healthSamplesInRange(startMs, endMs);
  const bucketMs = Math.max(60_000, Math.ceil(range.ms / 96 / 60_000) * 60_000);
  const bucketCount = Math.max(1, Math.ceil(range.ms / bucketMs));
  const stabilitySeries = [];
  const anomalySeries = [];
  const sums = Object.fromEntries(HEALTH_DEVICE_KEYS.map((key) => [key, { total: 0, count: 0, latency: 0, latencyCount: 0 }]));
  for (let i = 0; i < bucketCount; i += 1) {
    const from = startMs + i * bucketMs;
    const to = Math.min(endMs, from + bucketMs);
    const bucket = samples.filter((sample) => Number(sample.sample_at_ms) >= from && Number(sample.sample_at_ms) < to);
    const stabilityPoint = { at_ms: from, time_bj: new Date(from).toLocaleString("zh-CN", { hour12: false }) };
    const anomalyPoint = { at_ms: from, time_bj: stabilityPoint.time_bj, warning: 0, error: 0, offline: 0, total: 0 };
    for (const key of HEALTH_DEVICE_KEYS) {
      const values = bucket.map((sample) => sample?.devices?.[key]).filter((value) => value && healthNumber(value.score) !== null);
      const selected = device === "all" || device === key;
      stabilityPoint[key] = selected && values.length ? Math.round((values.reduce((sum, value) => sum + Number(value.score), 0) / values.length) * 10) / 10 : null;
      if (values.length) {
        sums[key].total += values.reduce((sum, value) => sum + Number(value.score), 0);
        sums[key].count += values.length;
        values.forEach((value) => {
          const latency = healthNumber(value.latency_ms);
          if (latency !== null) {
            sums[key].latency += latency;
            sums[key].latencyCount += 1;
          }
        });
      }
    }
    bucket.forEach((sample) => {
      (Array.isArray(sample?.anomalies) ? sample.anomalies : []).forEach((item) => {
        if (device !== "all" && item.device !== device) return;
        if (item.severity === "warning" || item.severity === "error" || item.severity === "offline") anomalyPoint[item.severity] += 1;
      });
    });
    anomalyPoint.total = anomalyPoint.warning + anomalyPoint.error + anomalyPoint.offline;
    stabilitySeries.push(stabilityPoint);
    anomalySeries.push(anomalyPoint);
  }
  const allEvents = aggregateHealthEvents(samples, "all", "all", bucketMs);
  const events = aggregateHealthEvents(samples, device, severity, bucketMs);
  const latest = samples.length ? samples[samples.length - 1] : recordDeviceHealth(true);
  const devices = HEALTH_DEVICE_KEYS.map((key) => {
    const current = latest?.devices?.[key] || {};
    const stat = sums[key];
    return {
      id: key,
      score: stat.count ? Math.round((stat.total / stat.count) * 10) / 10 : healthNumber(current.score),
      current_score: healthNumber(current.score),
      online: typeof current.online === "boolean" ? current.online : null,
      enabled: current.enabled !== false,
      avg_latency_ms: stat.latencyCount ? Math.round((stat.latency / stat.latencyCount) * 10) / 10 : healthNumber(current.latency_ms),
      samples: stat.count,
      anomaly_count: allEvents.filter((event) => event.device === key).length,
    };
  });
  const activeDevices = devices.filter((item) => item.enabled && item.score !== null);
  const overall = activeDevices.length ? Math.round((activeDevices.reduce((sum, item) => sum + item.score, 0) / activeDevices.length) * 10) / 10 : null;
  return {
    ok: true,
    generated_at: nowBjText(),
    range: { key: range.key, start_ms: startMs, end_ms: endMs, bucket_ms: bucketMs },
    filter: { device, severity },
    summary: {
      stability_pct: overall,
      anomaly_count: events.length,
      sample_count: samples.length,
      affected_devices: new Set(events.map((item) => item.device)).size,
      current_online: activeDevices.filter((item) => item.online === true).length,
      active_devices: activeDevices.length,
    },
    devices,
    stability_series: stabilitySeries,
    anomaly_series: anomalySeries,
    events: events.slice(0, 300),
    source: { sample_interval_ms: 30_000 },
  };
}

function updateEsp32FromHeartbeat(body, req) {
  const peerIp = normalizeIpv4Text(req?.socket?.remoteAddress);
  const bodyIp = safeHostText(body?.ip || body?.host || body?.esp32_ip);
  const portRaw = body?.port ?? body?.http_port ?? body?.server_port ?? esp32State.cfg.port ?? 80;
  esp32State.ip = bodyIp || peerIp || esp32State.ip || "";
  esp32State.port = clamp(parseInt(String(portRaw || "80"), 10) || 80, 1, 65535);
  esp32State.mac = String(body?.mac || esp32State.mac || "").trim();
  esp32State.device = String(body?.device || esp32State.device || "esp32-servo").trim();
  esp32State.device_id = cleanDeviceId(body?.device_id || body?.deviceId || esp32State.device_id, esp32State.device_id || "esp32-servo-01");
  syncEsp32PrimaryGate(getEsp32Gate({ device_id: esp32State.device_id, mac: esp32State.mac }));
  esp32State.servo_ready = typeof body?.servo_ready === "boolean" ? body.servo_ready : esp32State.servo_ready;
  if (typeof body?.servo_busy === "boolean") esp32State.servo_busy = body.servo_busy;
  if (typeof body?.command_poll_enabled === "boolean") esp32State.command_poll_enabled = body.command_poll_enabled;
  const pollMs = Number(body?.command_poll_ms);
  if (Number.isFinite(pollMs)) esp32State.command_poll_ms = clamp(Math.round(pollMs), 100, 120000);
  if (body?.last_command_id != null) esp32State.last_command_id = String(body.last_command_id).slice(0, 120);
  if (body?.last_command_state != null) esp32State.last_command_state = String(body.last_command_state).slice(0, 80);
  const uptime = Number(body?.uptime_ms);
  esp32State.uptime_ms = Number.isFinite(uptime) ? Math.max(0, Math.round(uptime)) : esp32State.uptime_ms;
  esp32State.last_seen_ms = Date.now();
  esp32State.last_error = "";
  esp32State.last_response = body && typeof body === "object" ? body : null;
}

function updateEsp32FromDeviceResponse(body, target) {
  const j = body && typeof body === "object" ? body : {};
  esp32State.ip = safeHostText(j.ip || j.host) || target?.host || esp32State.ip || "";
  esp32State.port = clamp(parseInt(String(j.port || target?.port || esp32State.port || 80), 10) || 80, 1, 65535);
  esp32State.mac = String(j.mac || esp32State.mac || "").trim();
  esp32State.device = String(j.device || esp32State.device || "esp32-servo").trim();
  if (j.device_id != null) esp32State.device_id = cleanDeviceId(j.device_id, esp32State.device_id || esp32State.cfg.device_id || "esp32-servo-01");
  esp32State.servo_ready = typeof j.servo_ready === "boolean" ? j.servo_ready : esp32State.servo_ready;
  if (typeof j.command_poll_enabled === "boolean") esp32State.command_poll_enabled = j.command_poll_enabled;
  const pollMs = Number(j.command_poll_ms);
  if (Number.isFinite(pollMs)) esp32State.command_poll_ms = clamp(Math.round(pollMs), 200, 120000);
  const uptime = Number(j.uptime_ms);
  esp32State.uptime_ms = Number.isFinite(uptime) ? Math.max(0, Math.round(uptime)) : esp32State.uptime_ms;
  esp32State.last_seen_ms = Date.now();
  esp32State.last_response = j;
}

function httpGetJson(url, timeoutMs = 900, headers = {}) {
  return new Promise((resolve) => {
    let done = false;
    const started = Date.now();
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        method: "GET",
        host: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + (u.search || ""),
        timeout: timeoutMs,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (done) return;
          done = true;
          const ms = Date.now() - started;
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {}
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, ms, json, text: data });
        });
      },
    );
    req.on("error", (e) => {
      if (done) return;
      done = true;
      const ms = Date.now() - started;
      resolve({ ok: false, status: 0, ms, json: null, text: String(e?.message || e) });
    });
    req.on("timeout", () => {
      try {
        req.destroy(new Error("timeout"));
      } catch {}
    });
    req.end();
  });
}

function httpGetBuffer(url, timeoutMs = 1800) {
  return new Promise((resolve) => {
    let done = false;
    const started = Date.now();
    let u;
    try {
      u = new URL(url);
    } catch (error) {
      resolve({ ok: false, status: 0, ms: 0, buffer: null, headers: {}, text: String(error?.message || error) });
      return;
    }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        method: "GET",
        host: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + (u.search || ""),
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          if (done) return;
          done = true;
          const buffer = Buffer.concat(chunks);
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            ms: Date.now() - started,
            buffer,
            headers: res.headers || {},
            text: buffer.toString("utf8"),
          });
        });
      },
    );
    req.on("error", (error) => {
      if (done) return;
      done = true;
      resolve({ ok: false, status: 0, ms: Date.now() - started, buffer: null, headers: {}, text: String(error?.message || error) });
    });
    req.on("timeout", () => {
      try { req.destroy(new Error("timeout")); } catch {}
    });
    req.end();
  });
}

function httpPostJson(url, jsonBody, timeoutMs = 1400) {
  return new Promise((resolve) => {
    let done = false;
    const started = Date.now();
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const body = JSON.stringify(jsonBody ?? {});
    const req = mod.request(
      {
        method: "POST",
        host: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + (u.search || ""),
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (done) return;
          done = true;
          const ms = Date.now() - started;
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {}
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, ms, json, text: data });
        });
      },
    );
    req.on("error", (e) => {
      if (done) return;
      done = true;
      const ms = Date.now() - started;
      resolve({ ok: false, status: 0, ms, json: null, text: String(e?.message || e) });
    });
    req.on("timeout", () => {
      try {
        req.destroy(new Error("timeout"));
      } catch {}
    });
    req.write(body);
    req.end();
  });
}

let opsLlmCfg = normalizeLlmConfig(loadLlmConfigFile().ops_llm, {
  provider: "deepseek",
  base_url: String(process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").trim(),
  model: String(process.env.DEEPSEEK_MODEL || "deepseek-chat").trim(),
  api_key: String(process.env.DEEPSEEK_API_KEY || "").trim(),
});

let voiceInteractionCfg = normalizeLlmConfig(loadLlmConfigFile().voice_interaction, {
  provider: "deepseek",
  base_url: String(process.env.VOICE_LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").trim(),
  model: String(process.env.VOICE_LLM_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-chat").trim(),
  api_key: String(process.env.VOICE_LLM_API_KEY || process.env.DEEPSEEK_API_KEY || "").trim(),
});

function activeOpsLlmCfg() {
  return normalizeLlmConfig(opsLlmCfg, {
    provider: "deepseek",
    base_url: "https://api.deepseek.com",
    model: "deepseek-chat",
    api_key: "",
  });
}

function activeVoiceInteractionCfg() {
  return normalizeLlmConfig(voiceInteractionCfg, activeOpsLlmCfg());
}

const opsState = {
  lastRkPing: null,
  lastAskAtByIp: new Map(),
};

function tailTextFile(filePath, maxBytes = 180_000) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return "";
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

function tailJsonl(filePath, n = 50, maxBytes = 180_000) {
  const text = tailTextFile(filePath, maxBytes);
  if (!text) return [];
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (let i = Math.max(0, lines.length - n); i < lines.length; i++) {
    try {
      out.push(JSON.parse(lines[i]));
    } catch {}
  }
  return out;
}

function llmContentText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      if (typeof item.text === "string") return item.text;
      if (typeof item.text?.value === "string") return item.text.value;
      if (typeof item.content === "string") return item.content;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractLlmResponseText(json) {
  const choice = json?.choices?.[0];
  const candidates = [
    choice?.message?.content,
    choice?.text,
    json?.output_text,
  ];
  for (const candidate of candidates) {
    const text = llmContentText(candidate);
    if (text) return text;
  }
  if (Array.isArray(json?.output)) {
    for (const item of json.output) {
      const text = llmContentText(item?.content ?? item?.text);
      if (text) return text;
    }
  }
  return "";
}

function llmEmptyResponseError(json) {
  const choice = json?.choices?.[0] || {};
  const message = choice?.message || {};
  const usage = json?.usage && typeof json.usage === "object" ? json.usage : {};
  const err = new Error("llm_empty_response");
  err.code = "llm_empty_response";
  err.body = {
    finish_reason: choice?.finish_reason ?? null,
    has_reasoning_content: Boolean(llmContentText(message?.reasoning_content)),
    usage: {
      prompt_tokens: Number.isFinite(Number(usage.prompt_tokens)) ? Number(usage.prompt_tokens) : null,
      completion_tokens: Number.isFinite(Number(usage.completion_tokens)) ? Number(usage.completion_tokens) : null,
      total_tokens: Number.isFinite(Number(usage.total_tokens)) ? Number(usage.total_tokens) : null,
    },
  };
  return err;
}

function llmChat(messages, opts = {}) {
  return new Promise((resolve, reject) => {
    const merged = normalizeLlmConfig(opts, activeOpsLlmCfg());
    const provider = merged.provider;
    const apiKey = merged.api_key;
    let baseUrl = merged.base_url;
    let model = merged.model;

    if (!apiKey) {
      const err = new Error("llm_api_key_missing");
      err.code = "llm_api_key_missing";
      reject(err);
      return;
    }
    if (!baseUrl) {
      const err = new Error("llm_base_url_missing");
      err.code = "llm_base_url_missing";
      reject(err);
      return;
    }
    const timeoutMs = clamp(parseInt(String(opts.timeout_ms || "20000"), 10), 2000, 180000);
    const payload = {
      model,
      messages: Array.isArray(messages) ? messages : [],
      temperature: Number.isFinite(Number(opts.temperature)) ? Number(opts.temperature) : 0.2,
      max_tokens: clamp(parseInt(String(opts.max_tokens || "900"), 10), 64, 4096),
      stream: false,
    };
    const isSiliconflowQwen36 = (provider === "siliconflow" || /siliconflow/i.test(baseUrl)) && /qwen3\.6/i.test(model);
    if (typeof opts.enable_thinking === "boolean") payload.enable_thinking = opts.enable_thinking;
    else if (isSiliconflowQwen36) payload.enable_thinking = false;
    if (opts.response_format && typeof opts.response_format === "object") payload.response_format = opts.response_format;
    const body = JSON.stringify(payload);
    const baseHasV1 = /\/v1$/i.test(baseUrl);
    const candidates = baseHasV1 ? [`${baseUrl}/chat/completions`] : [`${baseUrl}/v1/chat/completions`, `${baseUrl}/chat/completions`];

    const doReq = (urlText, next) => {
      const u = new URL(urlText);
      const mod = u.protocol === "http:" ? http : https;
      const req = mod.request(
        {
          method: "POST",
          host: u.hostname,
          port: u.port || (u.protocol === "http:" ? 80 : 443),
          path: u.pathname + (u.search || ""),
          timeout: timeoutMs,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            const ok = res.statusCode >= 200 && res.statusCode < 300;
            let json = null;
            try {
              json = JSON.parse(data);
            } catch {}
            if (!ok) {
              if ((res.statusCode === 404 || res.statusCode === 405) && typeof next === "function") {
                next();
                return;
              }
              if (res.statusCode === 401 || res.statusCode === 403) {
                const err = new Error("llm_unauthorized");
                err.code = "llm_unauthorized";
                err.status = res.statusCode;
                err.body = json ?? data;
                err.endpoint = urlText;
                reject(err);
                return;
              }
              const err = new Error(`llm_http_${res.statusCode}`);
              err.status = res.statusCode;
              err.body = json ?? data;
              err.endpoint = urlText;
              reject(err);
              return;
            }
            resolve(json);
          });
        },
      );
      req.on("error", (e) => reject(e));
      req.on("timeout", () => {
        try {
          req.destroy(new Error("timeout"));
        } catch {}
      });
      req.write(body);
      req.end();
    };

    const tryIdx = (i) => {
      if (i >= candidates.length) {
        const err = new Error("llm_all_endpoints_failed");
        err.code = "llm_all_endpoints_failed";
        reject(err);
        return;
      }
      doReq(candidates[i], i + 1 < candidates.length ? () => tryIdx(i + 1) : null);
    };
    tryIdx(0);
  });
}

function clampTextLen(s, maxChars = 20) {
  const arr = Array.from(String(s || "").trim());
  if (arr.length <= maxChars) return arr.join("");
  return arr.slice(0, maxChars).join("");
}

function extractJsonObject(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

function safeTailLines(filePath, maxLines = 40, maxBytes = 80_000) {
  const text = tailTextFile(filePath, maxBytes);
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((s) => s.trimEnd())
    .filter(Boolean)
    .slice(-maxLines);
}

function safeFileStat(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { exists: true, size: st.size, mtime_bj: new Date(st.mtimeMs).toLocaleString("zh-CN", { hour12: false }) };
  } catch {
    return { exists: false };
  }
}

function compactPathItem(x) {
  if (!x || typeof x !== "object") return null;
  return {
    file_name: x.file_name ?? null,
    full_path: x.full_path ?? null,
    source: x.source ?? null,
    exists: x.exists ?? null,
    size: x.size ?? null,
    uploaded_at: x.uploaded_at ?? null,
    load_ok: x.load_ok ?? null,
    load_error: x.load_error ?? null,
  };
}

function compactPlateItem(it) {
  if (!it || typeof it !== "object") return null;
  return {
    id: it.id ?? null,
    rk_device_id: it.rk_device_id ?? null,
    event_id: it.event_id ?? null,
    report_id: it.report_id ?? null,
    report_schema: it.report_schema ?? null,
    report_type: it.report_type ?? null,
    delivery_semantics: it.delivery_semantics ?? null,
    report_created_at: it.report_created_at ?? null,
    report_created_at_ms: it.report_created_at_ms ?? null,
    event_schema: it.event_schema ?? null,
    time_bj: it.time_bj ?? null,
    source: it.source ?? null,
    source_index: it.source_index ?? null,
    plate: it.plate ?? null,
    plate_normalized: it.plate_normalized ?? null,
    color: it.color ?? null,
    vehicle_type: it.vehicle_type ?? null,
    vehicle_type_code: it.vehicle_type_code ?? null,
    plate_category: it.plate_category ?? null,
    plate_category_code: it.plate_category_code ?? null,
    plate_category_rule: it.plate_category_rule ?? null,
    plate_category_rule_version: it.plate_category_rule_version ?? null,
    input_mode: it.input_mode ?? null,
    sd_source_path: it.sd_source_path ?? null,
    target_device_id: it.target_device_id ?? null,
    target_mac: it.target_mac ?? null,
    detector_model_name: it.detector_model_name ?? null,
    recognizer_model_name: it.recognizer_model_name ?? null,
    model_input_width: it.model_input_width ?? null,
    model_input_height: it.model_input_height ?? null,
    model_input_format: it.model_input_format ?? null,
    inference_strategy: it.inference_strategy ?? null,
    inference_task_count: it.inference_task_count ?? null,
    inference_pipeline_active: it.inference_pipeline_active ?? null,
    inference_pre_ms: it.inference_pre_ms ?? null,
    inference_npu_ms: it.inference_npu_ms ?? null,
    inference_post_ms: it.inference_post_ms ?? null,
    source_frame_width: it.source_frame_width ?? null,
    source_frame_height: it.source_frame_height ?? null,
    source_frame_format: it.source_frame_format ?? null,
    source_layout: it.source_layout ?? null,
    source_mask: it.source_mask ?? null,
    pcie_sliding_enabled: it.pcie_sliding_enabled ?? null,
    conf: it.conf ?? null,
    det_conf: it.det_conf ?? null,
    det_conf_pct: it.det_conf_pct ?? null,
    rec_conf: it.rec_conf ?? null,
    rec_conf_pct: it.rec_conf_pct ?? null,
    image_url: it.image_url ?? null,
    image_path: it.image_path ?? null,
    thumb_url: it.thumb_url ?? null,
    thumb_path: it.thumb_path ?? null,
  };
}

function compactViolationItem(it) {
  if (!it || typeof it !== "object") return null;
  return {
    id: it.id ?? null,
    time_bj: it.time_bj ?? null,
    source: it.source ?? null,
    view_mode: it.view_mode ?? null,
    single_source: it.single_source ?? null,
    overlap_iou: it.overlap_iou ?? null,
    image_path: it.image_path ?? null,
    thumb_path: it.thumb_path ?? null,
    ai: it.ai
      ? {
          state: it.ai.state ?? null,
          ok: it.ai.ok ?? null,
          violation: it.ai.violation ?? null,
          desc: it.ai.desc ?? null,
          provider: it.ai.provider ?? null,
          model: it.ai.model ?? null,
          error: it.ai.error ?? null,
        }
      : null,
  };
}

function opsNetworkInfo(req) {
  const listenPort = Number(req?.socket?.localPort) || null;
  const ipv4 = [];
  try {
    const nics = os.networkInterfaces();
    Object.values(nics || {}).forEach((arr) => {
      (arr || []).forEach((it) => {
        if (!it || it.family !== "IPv4" || it.internal) return;
        if (!ipv4.includes(it.address)) ipv4.push(it.address);
      });
    });
  } catch {}
  return {
    host_header: String(req?.headers?.host || ""),
    listen_port: listenPort,
    local_address: req?.socket?.localAddress ?? null,
    remote_address: req?.socket?.remoteAddress ?? null,
    ipv4,
    access_urls: listenPort ? ipv4.map((ip) => `http://${ip}:${listenPort}/`) : [],
  };
}

function buildOpsDiagnostics(ctx) {
  const checks = [];
  const status = ctx?.rk?.status;
  checks.push({ key: "backend", state: "ok", text: "PC 后端进程运行中" });
  checks.push({
    key: "rk_online",
    state: ctx?.rk?.online ? "ok" : "warn",
    text: ctx?.rk?.online ? "RK 最近有状态上报" : "未检测到近期 RK 状态上报",
  });
  checks.push({
    key: "esp32_online",
    state: ctx?.esp32?.online ? "ok" : ctx?.esp32?.target ? "warn" : "info",
    text: ctx?.esp32?.online ? "ESP32 在线" : ctx?.esp32?.target ? "ESP32 暂未在线，已有目标地址" : "ESP32 未发现目标地址",
  });
  if (status) {
    const mounted = status.pcie_driver_mounted;
    checks.push({
      key: "pcie",
      state: mounted === true ? "ok" : mounted === false ? "warn" : "info",
      text: mounted === true ? "PCIE 驱动已挂载" : mounted === false ? "PCIE 驱动未挂载" : "PCIE 驱动状态未知",
    });
  }
  checks.push({
    key: "ai",
    state: ctx?.ai?.ready ? "ok" : "warn",
    text: ctx?.ai?.ready ? "视觉 AI 模型可用" : "视觉 AI 模型未完全就绪",
  });
  checks.push({
    key: "tts",
    state: ctx?.tts?.ready ? "ok" : "info",
    text: ctx?.tts?.ready ? "TTS 模型可用" : "TTS 后端模型未就绪，可由浏览器语音兜底",
  });
  checks.push({
    key: "ops_llm",
    state: ctx?.ops_llm?.api_key_set ? "ok" : "warn",
    text: ctx?.ops_llm?.api_key_set ? "运维助手大模型 Key 已配置" : "运维助手大模型 Key 未配置",
  });
  checks.push({
    key: "violation_ai",
    state: ctx?.violation_ai?.api_key_set ? "ok" : "info",
    text: ctx?.violation_ai?.api_key_set ? "违规抓拍 AI Key 已配置" : "违规抓拍 AI Key 未配置",
  });
  return checks;
}

function buildOpsContext(req, opts = {}) {
  const tailN = clamp(parseInt(String(opts.tail_n || process.env.OPS_LLM_TAIL_N || "30"), 10) || 30, 0, 200);
  const includeLogs = opts.include_logs !== false;
  const status = rkReported?.status ?? null;
  const statusAt = Number(rkReported?.statusAtMs || 0) || 0;
  const nowMs = Date.now();
  const activeYolo = aiActiveModel("yolo");
  const activeOcr = aiActiveModel("ocr");
  const activeTts = ttsActiveModel();
  const ctx = {
    ok: true,
    time_bj: nowBjText(),
    backend: {
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      uptime_s: Math.round(process.uptime()),
      started_at: startedAt,
      instance_id: instanceId,
      static_root: staticRoot,
      log_root: logRoot,
      upload_dir: uploadDir,
      files: {
        plates: safeFileStat(path.join(logRoot, "plates.jsonl")),
        violations: safeFileStat(path.join(logRoot, "violations.jsonl")),
        business_latest: safeFileStat(path.join(logRoot, "business_latest.json")),
        server_console: safeFileStat(path.join(__dirname, "server.console.log")),
      },
    },
    network: opsNetworkInfo(req),
    database: {
      mysql: mysqlPublicStatus(),
    },
    api_state: { ...apiState },
    rk: {
      online: rkIsOnline(),
      status,
      status_at_ms: statusAt || null,
      status_age_ms: statusAt ? nowMs - statusAt : null,
      peer_ip: rkReported?.peerIp ?? null,
      peer_rk_device_id: rkReported?.peerRkDeviceId ?? null,
      peer_seen_age_ms: rkReported?.peerSeenAtMs ? nowMs - Number(rkReported.peerSeenAtMs) : null,
      forward_target: rkForwardTarget(),
      last_rk_ping: opsState.lastRkPing,
      preview_age_ms: rkReported?.previewUpdatedAt ? nowMs - Number(rkReported.previewUpdatedAt) : null,
      plates_count: Array.isArray(rkReported?.plates) ? rkReported.plates.length : 0,
      violations_count: Array.isArray(rkReported?.violations) ? rkReported.violations.length : 0,
      last_plate: compactPlateItem(Array.isArray(rkReported?.plates) && rkReported.plates.length ? rkReported.plates[0] : null),
      last_violation: compactViolationItem(Array.isArray(rkReported?.violations) && rkReported.violations.length ? rkReported.violations[0] : null),
    },
    esp32: buildEsp32Status(),
    ai: {
      engine: aiPython.engine,
      worker_alive: Boolean(aiPython.proc && !aiPython.proc.killed),
      worker_last_error: aiPython.lastError ?? null,
      ready: aiReadyForMode(apiState.inferMode || "overlay"),
      models_present: aiReady(),
      infer_mode_ready: aiReadyForMode(apiState.inferMode || "overlay"),
      active: { yolo: compactPathItem(activeYolo), ocr: compactPathItem(activeOcr) },
      model_paths: { yolo: compactPathItem(aiState.model_paths.yolo), ocr: compactPathItem(aiState.model_paths.ocr) },
      uploaded: { yolo: compactPathItem(aiState.models.yolo), ocr: compactPathItem(aiState.models.ocr) },
      ocr_charset: compactPathItem(aiState.ocr_charset),
      last: aiState.last,
    },
    tts: {
      ready: ttsRuntimeReady(),
      local_ready: ttsReady(),
      active: compactPathItem(activeTts),
      uploaded: compactPathItem(ttsState.model),
      model_path: compactPathItem(ttsState.model_path),
      runtime: publicTtsRuntimeConfig(activeTtsRuntimeCfg()),
      siliconflow: publicSiliconflowTtsConfig(activeSiliconflowTtsCfg()),
      last: ttsState.last,
    },
    ops_llm: publicLlmConfig(activeOpsLlmCfg()),
    voice_interaction: publicVoiceConfig(activeVoiceInteractionCfg()),
    violation_ai: {
      provider: violationAiCfg?.provider || "deepseek",
      base_url: violationAiCfg?.base_url || "",
      model: violationAiCfg?.model || "",
      api_key_set: Boolean(String(violationAiCfg?.api_key || "").trim()),
      running: Boolean(violationAiState.running),
      queue_len: Array.isArray(violationAiState.queue) ? violationAiState.queue.length : 0,
    },
    business: {
      parking: {
        source: rkBizIsActive("parking") ? "rk" : rkBizHasSnapshot("parking") ? "rk_cached" : DEMO_BIZ ? "demo" : "backend",
        active: rkBizIsActive("parking"),
        accounts_count: rkBizHasSnapshot("parking") ? rkBizReported.parking.accounts.length : biz.parking.accounts.size,
        records_count: rkBizHasSnapshot("parking") ? rkBizReported.parking.records.length : biz.parking.records.length,
        updated_age_ms: rkBizReported.parking.updatedAt ? nowMs - Number(rkBizReported.parking.updatedAt) : null,
      },
      etc: {
        source: rkBizIsActive("etc") ? "rk" : rkBizHasSnapshot("etc") ? "rk_cached" : DEMO_BIZ ? "demo" : "backend",
        active: rkBizIsActive("etc"),
        accounts_count: rkBizHasSnapshot("etc") ? rkBizReported.etc.accounts.length : biz.etc.accounts.size,
        records_count: rkBizHasSnapshot("etc") ? rkBizReported.etc.records.length : biz.etc.records.length,
        updated_age_ms: rkBizReported.etc.updatedAt ? nowMs - Number(rkBizReported.etc.updatedAt) : null,
      },
    },
    tail: {
      plates: tailJsonl(path.join(logRoot, "plates.jsonl"), tailN),
      violations: tailJsonl(path.join(logRoot, "violations.jsonl"), tailN),
      violations_audit: tailJsonl(path.join(logRoot, "violations_audit.jsonl"), Math.min(tailN, 30)),
      business_events: tailJsonl(path.join(logRoot, "business_events.jsonl"), tailN),
    },
  };
  if (includeLogs) {
    ctx.logs = {
      server_console: safeTailLines(path.join(__dirname, "server.console.log"), 50),
      runner_err: safeTailLines(path.join(__dirname, "runner.err.log"), 40),
      runner_out: safeTailLines(path.join(__dirname, "runner.out.log"), 30),
    };
  }
  ctx.diagnostics = buildOpsDiagnostics(ctx);
  return ctx;
}

function shrinkOpsContextForPrompt(ctx, maxChars) {
  const out = JSON.parse(JSON.stringify(ctx || {}));
  let text = JSON.stringify(out, null, 2);
  if (text.length <= maxChars) return text;
  if (out.logs) {
    out.logs.server_console = Array.isArray(out.logs.server_console) ? out.logs.server_console.slice(-18) : [];
    out.logs.runner_err = Array.isArray(out.logs.runner_err) ? out.logs.runner_err.slice(-12) : [];
    out.logs.runner_out = Array.isArray(out.logs.runner_out) ? out.logs.runner_out.slice(-12) : [];
  }
  if (out.tail) {
    Object.keys(out.tail).forEach((k) => {
      if (Array.isArray(out.tail[k])) out.tail[k] = out.tail[k].slice(-10);
    });
  }
  text = JSON.stringify(out, null, 2);
  if (text.length <= maxChars) return text;
  delete out.logs;
  if (out.tail) {
    Object.keys(out.tail).forEach((k) => {
      if (Array.isArray(out.tail[k])) out.tail[k] = out.tail[k].slice(-5);
    });
  }
  text = JSON.stringify(out, null, 2);
  if (text.length <= maxChars) return text;
  out.tail = {};
  return JSON.stringify(out, null, 2).slice(0, maxChars) + "\n...truncated";
}

function opsLocalStateText(v, okText = "正常", badText = "异常", unknownText = "未知") {
  return v === true ? okText : v === false ? badText : unknownText;
}

function buildOpsLocalAnswer(question, summary, reason = "") {
  const s = summary && typeof summary === "object" ? summary : {};
  const q = String(question || "").trim();
  const rkOnline = s?.rk?.online === true;
  const esp32Online = s?.esp32?.online === true;
  const mysqlReady = s?.database?.mysql?.ready === true;
  const aiReady = s?.ai?.ready === true;
  const ttsReady = s?.tts?.ready === true;
  const checks = Array.isArray(s?.diagnostics) ? s.diagnostics : [];
  const warnLines = checks
    .filter((it) => it && it.state !== "ok")
    .slice(0, 5)
    .map((it) => `- ${it.text || it.key || "未知诊断项"}`);
  const focusEsp32 = /esp32|舵机|servo|轮询/i.test(q);
  const focusRk = /rk|3568|上报|联通|连接/i.test(q);
  const focusAi = /ai|模型|推理|yolo|ocr|tts/i.test(q);
  const steps = [];
  if (focusRk || !rkOnline) {
    steps.push("在 RK3568 设置页确认后端地址为 `http://101.201.76.16`，不要带 `:8080` 或 `/api/...`。");
    steps.push("在 RK3568 终端执行：`curl http://101.201.76.16/api/ping`，再观察网页 RK 是否变为在线。");
  }
  if (focusEsp32 || !esp32Online) {
    steps.push("在 ESP32 串口确认 `Heartbeat posted, status=200`，并执行 `command_poll on`。");
    steps.push("云端验证：`curl http://101.201.76.16/api/esp32/status`，看 `online`、`queued_commands` 和 `last_command_state`。");
  }
  if (focusAi || !aiReady) {
    steps.push("检查模型与 Python Worker：`curl http://101.201.76.16/api/ai/diagnostics`。");
    steps.push("YOLO 用 `.pt`，OCR 用 `.onnx`；上传后点击“应用模型路径”写入默认模型。");
  }
  if (!mysqlReady) {
    steps.push("检查数据库：`curl http://101.201.76.16/api/db/status`，确认 MySQL `ready=true`。");
  }
  if (!steps.length) {
    steps.push("先点“获取摘要”确认后端、RK、ESP32、AI/TTS 四项状态，再根据 WARN 项逐个排查。");
    steps.push("若问题可复现，保留串口日志、`/api/status` 和 `/api/ops/summary` 返回，便于继续定位。");
  }
  const reasonText = reason.includes("api_key") ? "未配置运维助手 API Key，当前使用本地规则诊断。" : reason ? `大模型暂不可用：${reason}，当前使用本地规则诊断。` : "当前使用本地规则诊断。";
  return [
    "# 运维助手本地诊断",
    "",
    reasonText,
    "",
    "## 当前状态",
    `- 后端：运行中，端口 ${s?.backend?.listen_port ?? s?.network?.listen_port ?? "—"}`,
    `- RK3568：${rkOnline ? "在线" : "未检测到近期上报"}，状态年龄 ${fmtDeviceAge(s?.rk?.status_age_ms)}`,
    `- ESP32：${esp32Online ? "在线" : "离线"}，命令状态 ${s?.esp32?.last_command_state || "—"}，待执行 ${s?.esp32?.queued_commands ?? 0}`,
    `- MySQL：${opsLocalStateText(mysqlReady, "已连接", "未连接")}`,
    `- AI/TTS：${aiReady ? "AI就绪" : "AI未就绪"} / ${ttsReady ? "TTS就绪" : "TTS未就绪"}`,
    "",
    "## 优先处理",
    ...(warnLines.length ? warnLines : ["- 当前摘要未发现明确 WARN，优先按你的问题场景做定向验证。"]),
    "",
    "## 下一步",
    ...steps.slice(0, 6).map((it) => `- ${it}`),
  ].join("\n");
}

function buildVoiceLocalAnswer(text, ctx = {}) {
  const q = String(text || "").trim();
  const status = rkReported?.status || null;
  const esp = buildEsp32Status();
  if (/esp32|舵机|抬杆|栏杆|闸机/i.test(q)) {
    return esp.online
      ? `ESP32 当前在线。设备 ${esp.device_id || "未命名"}，可以下发抬杆、回落和测试命令。`
      : "ESP32 当前未在线，请先确认供电、WiFi、后端地址和心跳接口。";
  }
  if (/rk|状态|在线|终端/i.test(q)) {
    const age = Number(rkReported?.statusAtMs) ? Math.round((Date.now() - Number(rkReported.statusAtMs)) / 1000) : null;
    return status ? `RK3568 当前有状态上报，最近一次约 ${age ?? 0} 秒前，业务模式为 ${status.biz_system || "未知"}。` : "暂未检测到 RK3568 状态上报，请确认 RK 后端地址配置和网络连通。";
  }
  if (/车牌|车辆|抓拍|识别/i.test(q)) {
    const latest = Array.isArray(rkReported?.plates) && rkReported.plates[0] ? rkReported.plates[0] : null;
    return latest ? `最近识别到车牌 ${latest.plate || "未知"}，来源 ${latest.source || "未知"}。` : "当前还没有车牌抓拍记录。";
  }
  if (/数据库|mysql/i.test(q)) {
    return mysqlState.ready ? "MySQL 数据库当前已连接，业务数据和抓拍记录可以落库保存。" : `数据库当前不可用：${mysqlState.error?.message || mysqlState.error?.code || "未连接"}`;
  }
  return ctx.role === "rk" ? "收到终端语音请求，云端已处理。你可以继续询问设备状态、车牌识别、ESP32 抬杆或数据库连接。" : "收到。你可以问我 RK 状态、ESP32 抬杆、车牌抓拍、数据库状态或业务账户情况。";
}

function clampVoiceAnswerText(text, maxChars = 200) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  if (chars.length <= maxChars) return clean;
  const clipped = chars.slice(0, maxChars).join("").trim();
  const clippedChars = Array.from(clipped);
  let lastSentenceEnd = -1;
  for (let i = 0; i < clippedChars.length; i += 1) {
    if ("。！？.!?".includes(clippedChars[i])) lastSentenceEnd = i;
  }
  if (lastSentenceEnd >= Math.min(60, maxChars - 1)) {
    return clippedChars.slice(0, lastSentenceEnd + 1).join("").trim();
  }
  return clipped.replace(/[，、；：,.，\s]+$/g, "").trim() + "。";
}

async function runVoiceInteraction(input, opts = {}) {
  const text = String(input || "").trim();
  if (!text) return { ok: false, error: "bad_text" };
  const cfg = normalizeLlmConfig(opts.api || {}, activeVoiceInteractionCfg());
  const role = String(opts.role || opts.client || "web").trim().toLowerCase();
  const wantAudio = opts.want_audio === true || opts.return_audio === true;
  const sys = [
    "你是 RK3568 上位机系统的车路协同语音助手。",
    "回答必须简短、口语化，适合直接 TTS 播报。",
    "优先围绕 RK3568、ESP32 抬杆、车牌抓拍、违规抓拍、停车场/ETC、数据库和云端通信回答。",
    "必须控制在 200 个汉字以内，用完整句子结束，不要输出长段解释。",
  ].join("\n");
  const summary = buildOpsContext({ socket: { localPort: currentPort || PORT } }, { tail_n: 8, include_logs: false });
  const summaryText = shrinkOpsContextForPrompt(summary, 6000);
  let answer = "";
  let fallback = false;
  let errMeta = null;
  if (cfg.api_key && cfg.base_url && cfg.model) {
    try {
      const json = await llmChat(
        [
          { role: "system", content: sys },
          { role: "user", content: `终端来源：${role}\n用户语音文本：${text}\n\n系统摘要：\n${summaryText}` },
        ],
        { ...cfg, max_tokens: 260, temperature: 0.2, timeout_ms: clamp(parseInt(String(opts.timeout_ms || "25000"), 10), 3000, 60000) },
      );
      answer = extractLlmResponseText(json);
      if (!answer) throw llmEmptyResponseError(json);
    } catch (e) {
      fallback = true;
      errMeta = { error: String(e?.code || e?.message || "llm_failed"), status: e?.status || null };
    }
  } else {
    fallback = true;
    errMeta = { error: "voice_api_not_configured" };
  }
  if (!answer) answer = buildVoiceLocalAnswer(text, { role });
  answer = clampVoiceAnswerText(answer, 200);
  let audio = wantAudio ? await synthesizeTtsWavBase64(answer, opts.tts_options || opts.ttsOptions || {}) : { available: false, reason: "not_requested" };
  const out = {
    ok: true,
    input: text,
    answer,
    fallback,
    error: errMeta,
    provider: cfg.provider,
    model: cfg.model,
    time_bj: nowBjText(),
    tts_hint: { text: answer, local_tts_path: "/api/tts/speak" },
    audio,
  };
  appendJsonLine("voice_interactions.jsonl", { time_bj: out.time_bj, role, input: text, answer, fallback, provider: cfg.provider, model: cfg.model });
  return out;
}

const server = http.createServer(async (req, res) => {
  try {
  if (withCors(req, res)) return;

  const u = new URL(req.url, `http://${req.headers.host}`);
  const pathname = u.pathname;

  if (pathname === "/api/communication/history" && req.method === "GET") {
    sendJson(res, 200, communicationLog.snapshot({ after: u.searchParams.get("after"), instance: u.searchParams.get("instance") || "", limit: u.searchParams.get("limit") || 100 }));
    return;
  }
  if (pathname === "/api/communication/events" && req.method === "GET") {
    communicationLog.stream(req, res, { after: u.searchParams.get("after"), instance: u.searchParams.get("instance") || "" });
    return;
  }

  if (pathname === "/api/ping" && req.method === "GET") {
    const host = String(req.headers.host || "");
    const listenPort = req.socket?.localPort ?? null;
    const baseUrl = host ? `http://${host}/` : "";
    const remoteAddress = req.socket?.remoteAddress ?? null;
    const localAddress = req.socket?.localAddress ?? null;
    const nics = os.networkInterfaces();
    const ipv4 = [];
    Object.values(nics || {}).forEach((arr) => {
      (arr || []).forEach((it) => {
        if (!it || it.family !== "IPv4" || it.internal) return;
        if (!ipv4.includes(it.address)) ipv4.push(it.address);
      });
    });
    const accessUrls = ipv4
      .map((ip) => (Number.isFinite(listenPort) && listenPort ? `http://${ip}:${listenPort}/` : null))
      .filter(Boolean);
    sendJson(res, 200, {
      ok: true,
      server_time: nowBjText(),
      node: process.version,
      uptime_s: Math.round(process.uptime()),
      pid: process.pid,
      instance_id: instanceId,
      started_at: startedAt,
      host,
      listen_port: listenPort,
      base_url: baseUrl,
      local_address: localAddress,
      remote_address: remoteAddress,
      ipv4,
      access_urls: accessUrls,
      rk_report_contract: {
        schema: RK_REPORT_SCHEMA_DEFAULT,
        strict: !RK_ALLOW_LEGACY_REPORTS,
        legacy_allowed: RK_ALLOW_LEGACY_REPORTS,
        future_clock_skew_ms: RK_REPORT_CLOCK_SKEW_MS,
        timestamp_text_tolerance_ms: RK_REPORT_TIMESTAMP_TOLERANCE_MS,
        delayed_reports_allowed: true,
      },
    });
    return;
  }

  if (pathname === "/api/mini/status" && req.method === "GET") {
    sendJson(res, 200, await miniBuildStatus(req));
    return;
  }

  if (pathname === "/api/mini/blacklist" && req.method === "GET") {
    const q = miniNormalizePlate(u.searchParams.get("plate") || "");
    await mysqlSyncBlacklistFromJsonOnce();
    const db = await mysqlListBlacklist(u.searchParams);
    const items = (db?.items || miniLoadBlacklist()
      .filter((it) => (q ? miniNormalizePlate(it.plate).includes(q) : true))
      .slice(0, 300))
      .map((it) => ({ ...it, image_url_abs: miniPublicImageUrl(req, it.image_url) }));
    sendJson(res, 200, { ok: true, total: db?.total ?? items.length, source: db ? "mysql" : "file", items });
    return;
  }

  if (pathname === "/api/blacklist" && req.method === "GET") {
    const q = miniNormalizePlate(u.searchParams.get("plate") || "");
    await mysqlSyncBlacklistFromJsonOnce();
    const db = await mysqlListBlacklist(u.searchParams);
    const items = (db?.items || miniLoadBlacklist()
      .filter((it) => (q ? miniNormalizePlate(it.plate).includes(q) : true))
      .slice(0, clamp(parseInt(u.searchParams.get("limit") || "300", 10), 1, 1000)))
      .map((it) => ({ ...it, image_url_abs: miniPublicImageUrl(req, it.image_url) }));
    sendJson(res, 200, { ok: true, total: db?.total ?? items.length, source: db ? "mysql" : "file", items });
    return;
  }

  if (pathname === "/api/blacklist/events" && req.method === "GET") {
    await mysqlSyncBlacklistFromJsonOnce();
    const db = await mysqlListBlacklistEvents(u.searchParams);
    const plate = u.searchParams.get("plate") || "";
    const limit = clamp(parseInt(u.searchParams.get("limit") || "100", 10), 1, 500);
    const items = db?.items || miniReadBlacklistEvents(limit, plate);
    sendJson(res, 200, { ok: true, total: db?.total ?? items.length, source: db ? "mysql" : "file", items });
    return;
  }

  if ((pathname === "/api/mini/blacklist" || pathname === "/api/blacklist") && req.method === "POST") {
    const limit = checkMiniRateLimit(req, "blacklist_write", { windowMs: 10_000, max: 12 });
    if (!limit.ok) {
      sendMiniRateLimited(res, limit);
      return;
    }
    const body = safeJsonParse(await readBody(req, 120_000)) || {};
    const normalizedPlate = miniNormalizePlate(body?.plate);
    let existingDbItem = null;
    if (normalizedPlate) {
      const dbBefore = await mysqlListBlacklist(new URLSearchParams({ plate: normalizedPlate, limit: "1" }));
      existingDbItem = dbBefore?.items?.find((item) => miniNormalizePlate(item?.plate) === normalizedPlate) || null;
    }
    const r = miniUpsertBlacklist({
      plate: body?.plate,
      reason: body?.reason,
      violation_type: body?.violation_type || body?.type,
      note: body?.note,
      operator: body?.operator,
      image_url: body?.image_url,
      image_path: body?.image_path,
      source: body?.source || "mini_manual",
    }, { syncDb: false, existingItem: existingDbItem });
    if (r.ok && r.item) {
      await mysqlUpsertBlacklist(r.item);
      await mysqlSaveBlacklistEvent(r.event_type || "updated", r.item.plate, r.item, { source: r.item.source || "web_manual" });
    }
    sendJson(res, r.ok ? 200 : 400, r);
    return;
  }

  if ((pathname === "/api/blacklist/delete" || pathname === "/api/mini/blacklist/delete") && req.method === "POST") {
    const limit = checkMiniRateLimit(req, "blacklist_delete", { windowMs: 10_000, max: 12 });
    if (!limit.ok) {
      sendMiniRateLimited(res, limit);
      return;
    }
    const body = safeJsonParse(await readBody(req, 80_000)) || {};
    const r = miniRemoveBlacklist(body?.plate, { syncDb: false });
    if (r.ok) {
      const dbRemoved = await mysqlRemoveBlacklist(body?.plate, { recordEvent: false });
      if (r.removed || dbRemoved === true) await mysqlSaveBlacklistEvent("deleted", body?.plate, null, { source: "web_manual" });
    }
    sendJson(res, r.ok ? 200 : 400, r);
    return;
  }

  if (pathname === "/api/mini/blacklist/upload" && req.method === "POST") {
    const limit = checkMiniRateLimit(req, "blacklist_upload", { windowMs: 30_000, max: 4 });
    if (!limit.ok) {
      sendMiniRateLimited(res, limit);
      return;
    }
    const ct = String(req.headers["content-type"] || "");
    const mb = ct.match(/boundary=([^;]+)/i);
    if (!mb) {
      sendJson(res, 400, { ok: false, error: "bad_content_type" });
      return;
    }
    const boundary = String(mb[1]).replace(/^"|"$/g, "");
    const buf = await readBodyBuffer(req, 30_000_000);
    const part = parseMultipartSingleFile(buf, boundary);
    if (!part || !part.data || part.data.length < 10) {
      sendJson(res, 400, { ok: false, error: "no_file" });
      return;
    }
    const id = randomUUID();
    const fileName = `${id}_${sanitizeFileName(part.fileName || "plate.jpg")}`;
    const imageAbs = saveJpegFile(miniUploadDir, fileName, part.data);
    const imagePath = toLogRelPath(imageAbs);
    const imageUrl = imagePath ? `/api/mini/uploads/${encodeURIComponent(path.basename(imagePath))}` : "";
    const infer = await miniInferPlateFromImageBuffer(part.data);
    if (infer?.error === "busy") {
      appendJsonLine("mini_uploads.jsonl", {
        event: "upload_busy",
        time_bj: nowBjText(),
        id,
        file_name: part.fileName,
        image_url: imageUrl,
        image_path: imagePath,
        infer_ok: false,
        infer_error: infer.error,
        infer_message: infer.message,
      });
      sendJson(res, 429, {
        ok: false,
        error: "busy",
        message: infer.message || "云端识别繁忙，请稍后重试。",
        id,
        image_url: imageUrl,
        image_url_abs: miniPublicImageUrl(req, imageUrl),
        infer,
      });
      return;
    }
    const pickedPlate = infer?.picked?.plate || "";
    const autoAdd = String(u.searchParams.get("auto_add") || "0") === "1";
    const inputPlate = miniNormalizePlate(u.searchParams.get("plate") || pickedPlate);
    let blacklist = null;
    if (autoAdd && inputPlate) {
      const add = miniUpsertBlacklist({
        plate: inputPlate,
        reason: u.searchParams.get("reason") || "拍照导入违规车辆",
        violation_type: u.searchParams.get("violation_type") || "parking_violation",
        note: u.searchParams.get("note") || "",
        operator: u.searchParams.get("operator") || "评委端",
        image_url: imageUrl,
        image_path: imagePath,
        source: "mini_upload",
      });
      blacklist = add.item || null;
    }
    appendJsonLine("mini_uploads.jsonl", {
      event: "upload",
      time_bj: nowBjText(),
      id,
      file_name: part.fileName,
      image_url: imageUrl,
      image_path: imagePath,
      infer_ok: infer?.ok === true,
      infer_error: infer?.error || "",
      infer_message: infer?.message || "",
      picked_plate: pickedPlate,
      auto_add: Boolean(blacklist),
    });
    sendJson(res, 200, {
      ok: true,
      id,
      image_url: imageUrl,
      image_url_abs: miniPublicImageUrl(req, imageUrl),
      infer,
      picked_plate: pickedPlate,
      blacklist,
      message: pickedPlate ? "已识别车牌，请确认后加入黑名单。" : "未识别到车牌，可手动输入后加入黑名单。",
    });
    return;
  }

  const mMiniUploadImg = pathname.match(/^\/api\/mini\/uploads\/([^/]+)$/);
  if (mMiniUploadImg && req.method === "GET") {
    const name = sanitizeFileName(decodeURIComponent(String(mMiniUploadImg[1] || "")));
    const buf = readJpegFile(path.join(miniUploadDir, name));
    if (!buf) {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    send(res, 200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" }, buf);
    return;
  }

  if (pathname === "/api/mini/voice" && req.method === "POST") {
    const limit = checkMiniRateLimit(req, "voice", { windowMs: 15_000, max: 6 });
    if (!limit.ok) {
      sendMiniRateLimited(res, limit);
      return;
    }
    const body = safeJsonParse(await readBody(req, 160_000)) || {};
    const text = String(body?.text || body?.question || body?.asr_text || "").trim();
    const result = await runVoiceInteraction(text, {
      role: "mini",
      client: "wechat-mini-program",
      want_audio: body?.want_audio === true,
      tts_options: body?.tts_options && typeof body.tts_options === "object" ? body.tts_options : null,
      timeout_ms: body?.timeout_ms,
    });
    sendJson(res, result.ok ? 200 : 400, { ...result, endpoint: "/api/mini/voice" });
    return;
  }

  if (pathname === "/api/mini/voice/tts" && req.method === "POST") {
    const limit = checkMiniRateLimit(req, "voice_tts", { windowMs: 15_000, max: 8 });
    if (!limit.ok) {
      sendMiniRateLimited(res, limit);
      return;
    }
    const body = safeJsonParse(await readBody(req, 160_000)) || {};
    const text = String(body?.text || body?.answer || "").trim();
    const ttsOptions = body?.tts_options && typeof body.tts_options === "object" ? body.tts_options : {};
    const audio = await synthesizeTtsWavBase64(text, ttsOptions);
    sendJson(res, audio.available ? 200 : 503, {
      ok: audio.available === true,
      audio,
      endpoint: "/api/mini/voice/tts",
      message: audio.available ? "语音已生成" : audio.message || audio.reason || "语音生成失败",
    });
    return;
  }

  if (pathname === "/api/mini/voice/asr" && req.method === "POST") {
    const limit = checkMiniRateLimit(req, "voice_asr", { windowMs: 15_000, max: 6 });
    if (!limit.ok) {
      sendMiniRateLimited(res, limit);
      return;
    }
    const ct = String(req.headers["content-type"] || "");
    const mb = ct.match(/boundary=([^;]+)/i);
    if (!mb) {
      sendJson(res, 400, { ok: false, error: "bad_content_type", message: "语音上传格式错误，请重新录音。" });
      return;
    }
    const boundary = String(mb[1]).replace(/^"|"$/g, "");
    const buf = await readBodyBuffer(req, 12_000_000);
    const parts = parseMultipartFiles(buf, boundary).filter((p) => p && p.data && p.data.length >= 10);
    const part =
      parts.find((p) => String(p.fieldName || "").toLowerCase() === "file") ||
      parts.find((p) => /^audio\//i.test(String(p.contentType || ""))) ||
      parts[0];
    if (!part || !part.data || part.data.length < 10) {
      sendJson(res, 400, { ok: false, error: "no_audio", message: "没有收到有效录音文件。" });
      return;
    }
    try {
      const r = await requestSiliconflowTranscription(part.data, part.fileName || "voice.mp3", part.contentType || "audio/mpeg", activeSiliconflowTtsCfg(), 60000);
      const text = String(r.text || "").trim();
      appendJsonLine("mini_voice_asr.jsonl", {
        time_bj: nowBjText(),
        ok: Boolean(text),
        text,
        file_name: part.fileName || "voice.mp3",
        size: part.data.length,
        content_type: part.contentType || "",
        provider: r.provider,
        model: r.model,
      });
      sendJson(res, 200, {
        ok: Boolean(text),
        text,
        asr_text: text,
        provider: r.provider,
        model: r.model,
        endpoint: "/api/mini/voice/asr",
        message: text ? "语音识别完成" : "云端未识别到文字，请手动输入。",
      });
    } catch (e) {
      const reason = String(e?.code || e?.message || "asr_failed");
      appendJsonLine("mini_voice_asr.jsonl", {
        time_bj: nowBjText(),
        ok: false,
        error: reason,
        status: e?.status || null,
        file_name: part.fileName || "voice.mp3",
        size: part.data.length,
      });
      sendJson(res, 503, {
        ok: false,
        error: reason,
        message: reason.includes("api_key") ? "云端语音识别未配置 API Key，可先手动输入文字。" : "云端语音识别失败，可先手动输入文字。",
        endpoint: "/api/mini/voice/asr",
      });
    }
    return;
  }

  if (pathname === "/api/mini/gate/open" && req.method === "POST") {
    const limit = checkMiniRateLimit(req, "gate_open", { windowMs: 10_000, max: 8 });
    if (!limit.ok) {
      sendMiniRateLimited(res, limit);
      return;
    }
    const body = safeJsonParse(await readBody(req, 80_000)) || {};
    const r = enqueueEsp32Command({
      type: "servo_flip",
      device_id: body?.device_id || body?.deviceId || esp32State.cfg.device_id,
      mac: body?.mac || esp32State.cfg.mac,
      angle: clampEsp32Angle(body?.angle, esp32State.cfg.gate_open_angle),
      hold_ms: clampEsp32HoldMs(body?.hold_ms, esp32State.cfg.gate_hold_ms),
      return_angle: clampEsp32Angle(body?.return_angle, esp32State.cfg.gate_close_angle),
      return_enabled: body?.return_enabled !== false,
    }, "mini_gate_open");
    if (!r.ok) {
      sendJson(res, 400, r);
      return;
    }
    sendJson(res, 200, { ok: true, command: publicEsp32Command(r.command), status: buildEsp32Status() });
    return;
  }

  if (pathname === "/api/ops/summary" && req.method === "GET") {
    sendJson(res, 200, buildOpsContext(req, { tail_n: 80, include_logs: true }));
    return;
  }

  if (pathname === "/api/logs/analysis" && req.method === "GET") {
    sendJson(res, 200, buildLogAnalysis(req, {
      range: u.searchParams.get("range"),
      device: u.searchParams.get("device"),
      severity: u.searchParams.get("severity"),
    }));
    return;
  }

  if (pathname === "/api/llm/config" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      ops_llm: publicLlmConfig(activeOpsLlmCfg()),
      violation_ai: publicLlmConfig(violationAiCfg),
      voice_interaction: publicVoiceConfig(activeVoiceInteractionCfg()),
      tts_runtime: publicTtsRuntimeConfig(activeTtsRuntimeCfg()),
      tts_siliconflow: publicSiliconflowTtsConfig(activeSiliconflowTtsCfg()),
      tts_edge: publicEdgeTtsConfig(activeEdgeTtsCfg()),
      config_path: llmConfigPath,
      persisted: safeFileStat(llmConfigPath),
    });
    return;
  }

  if (pathname === "/api/llm/config" && req.method === "POST") {
    let body;
    try {
      body = safeJsonParse(await readBody(req, 80_000)) || {};
    } catch (e) {
      sendJson(res, e?.status || 400, { ok: false, error: String(e?.code || "bad_request") });
      return;
    }
    const target = String(body?.target || body?.kind || "ops_llm").trim().toLowerCase();
    if (!["ops_llm", "violation_ai", "voice_interaction", "tts_siliconflow", "tts_edge", "tts_runtime"].includes(target)) {
      sendJson(res, 400, { ok: false, error: "bad_target" });
      return;
    }
    const cfgInput = body?.config && typeof body.config === "object" ? body.config : body;
    if (target === "tts_runtime") {
      ttsRuntimeCfg = saveLlmConfigFile(target, normalizeTtsRuntimeConfig(cfgInput, activeTtsRuntimeCfg()));
      sendJson(res, 200, { ok: true, target, config: publicTtsRuntimeConfig(ttsRuntimeCfg), config_path: llmConfigPath });
      return;
    }
    const keepApiKey = body?.keep_api_key === true || cfgInput?.keep_api_key === true;
    if (target === "tts_siliconflow") {
      const fallbackCfg = activeSiliconflowTtsCfg();
      const cfg = normalizeSiliconflowTtsConfig(cfgInput, fallbackCfg);
      if (keepApiKey && !String(cfgInput?.api_key || "").trim()) cfg.api_key = fallbackCfg.api_key || "";
      if (!cfg.base_url || !cfg.model || !cfg.voice || !cfg.api_key) {
        sendJson(res, 400, { ok: false, error: "missing_fields" });
        return;
      }
      const keyProblem = llmApiKeyProblem(cfg.api_key);
      if (keyProblem) {
        sendJson(res, 400, { ok: false, error: keyProblem, message: "API Key 不能填写 Base URL，请填写 SiliconFlow 控制台生成的密钥。" });
        return;
      }
      siliconflowTtsCfg = saveLlmConfigFile(target, cfg);
      sendJson(res, 200, { ok: true, target, config: publicSiliconflowTtsConfig(siliconflowTtsCfg), config_path: llmConfigPath });
      return;
    }
    if (target === "tts_edge") {
      edgeTtsCfg = saveLlmConfigFile(target, normalizeEdgeTtsConfig(cfgInput, activeEdgeTtsCfg()));
      sendJson(res, 200, { ok: true, target, config: publicEdgeTtsConfig(edgeTtsCfg), config_path: llmConfigPath });
      return;
    }
    const fallbackCfg = target === "ops_llm" ? activeOpsLlmCfg() : target === "violation_ai" ? violationAiCfg : activeVoiceInteractionCfg();
    const cfg = normalizeLlmConfig(cfgInput, fallbackCfg);
    if (keepApiKey && !String(cfgInput?.api_key || "").trim()) cfg.api_key = fallbackCfg.api_key || "";
    if (!cfg.base_url || !cfg.model || !cfg.api_key) {
      sendJson(res, 400, { ok: false, error: "missing_fields" });
      return;
    }
    const keyProblem = llmApiKeyProblem(cfg.api_key);
    if (keyProblem) {
      sendJson(res, 400, { ok: false, error: keyProblem, message: "API Key 不能填写 Base URL，请填写服务商控制台生成的密钥。" });
      return;
    }
    const saved = saveLlmConfigFile(target, cfg);
    if (target === "ops_llm") opsLlmCfg = saved;
    if (target === "violation_ai") violationAiCfg = saved;
    if (target === "voice_interaction") voiceInteractionCfg = saved;
    sendJson(res, 200, { ok: true, target, config: publicLlmConfig(saved), config_path: llmConfigPath });
    return;
  }

  if ((pathname === "/api/voice/interact" || pathname === "/api/rk/voice/interact") && req.method === "POST") {
    let body;
    try {
      body = safeJsonParse(await readBody(req, 160_000)) || {};
    } catch (e) {
      sendJson(res, e?.status || 400, { ok: false, error: String(e?.code || "bad_request") });
      return;
    }
    const text = String(body?.text || body?.question || body?.asr_text || body?.input || "").trim();
    const result = await runVoiceInteraction(text, {
      role: pathname.startsWith("/api/rk/") ? "rk" : "web",
      client: body?.client || body?.device || "",
      api: body?.api && typeof body.api === "object" ? body.api : null,
      want_audio: body?.want_audio === true || body?.return_audio === true,
      tts_options: body?.tts_options && typeof body.tts_options === "object" ? body.tts_options : null,
      timeout_ms: body?.timeout_ms,
    });
    sendJson(res, result.ok ? 200 : 400, {
      ...result,
      rk_endpoint: "/api/rk/voice/interact",
      web_endpoint: "/api/voice/interact",
    });
    return;
  }

  if (pathname === "/api/ai/diagnostics" && req.method === "GET") {
    const deps = cachedPythonDepsStatus(0);
    const activeYolo = aiActiveModel("yolo");
    const activeOcr = aiActiveModel("ocr");
    const activeTts = ttsActiveModel();
    sendJson(res, 200, {
      ok: true,
      time_bj: nowBjText(),
      engine: aiPython.engine,
      worker_alive: Boolean(aiPython.proc && !aiPython.proc.killed),
      worker_last_error: aiPython.lastError,
      python: deps,
      model_dir: resolveModelDir(),
      upload_dir: uploadDir,
      ai: {
        ready_modes: {
          overlay: aiReadyForMode("overlay"),
          yolo: aiReadyForMode("yolo"),
          ocr: aiReadyForMode("ocr"),
        },
        active: { yolo: compactPathItem(activeYolo), ocr: compactPathItem(activeOcr) },
        charset: resolveOcrCharsetPath(activeOcr) || null,
      },
      tts: {
        ready: ttsReady(),
        active: compactPathItem(activeTts),
        piper: ttsPiperConfigInfo(activeTts),
      },
      llm: {
        ops_llm: publicLlmConfig(activeOpsLlmCfg()),
        violation_ai: publicLlmConfig(violationAiCfg),
        voice_interaction: publicVoiceConfig(activeVoiceInteractionCfg()),
      },
      limits: {
        ai_model_upload_bytes: 300_000_000,
        tts_model_upload_bytes: 300_000_000,
        infer_frame_json_bytes: 25_000_000,
        nginx_hint: "云端通过 Nginx 访问时建议配置 client_max_body_size 350m",
      },
    });
    return;
  }

  if (pathname === "/api/ai/restart" && req.method === "POST") {
    const shouldStart = ["1", "true", "yes", "on"].includes(String(u.searchParams.get("start") || "").trim().toLowerCase());
    try {
      if (aiPython.proc) aiPython.proc.kill("SIGKILL");
    } catch {}
    aiPython.proc = null;
    aiPython.pending.clear();
    aiPython.lastError = null;
    if (String(process.env.AI_ENGINE || "python").trim().toLowerCase() !== "fake") aiPython.engine = "python";
    pythonDepsCache = { at: 0, status: null };
    if (shouldStart) startAiPython();
    sendJson(res, 200, {
      ok: true,
      engine: aiPython.engine,
      worker_alive: Boolean(aiPython.proc && !aiPython.proc.killed),
      python: cachedPythonDepsStatus(0),
      last_error: aiPython.lastError,
      started: shouldStart,
    });
    return;
  }

  if (pathname === "/api/ops/ask" && req.method === "POST") {
    const ip = String(req.socket?.remoteAddress || "");
    const now = Date.now();
    const lastAt = opsState.lastAskAtByIp.get(ip) || 0;
    const minGapMs = 1200;
    if (now - lastAt < minGapMs) {
      const retryAfterMs = Math.max(0, minGapMs - (now - lastAt));
      sendJson(res, 429, { ok: false, error: "rate_limited", retry_after_ms: retryAfterMs });
      return;
    }
    opsState.lastAskAtByIp.set(ip, now);
    let body;
    try {
      body = safeJsonParse(await readBody(req, 120_000)) || {};
    } catch (e) {
      sendJson(res, e?.status || 400, { ok: false, error: String(e?.code || "bad_request") });
      return;
    }
    const question = String(body?.question ?? "").trim();
    if (!question) {
      sendJson(res, 400, { ok: false, error: "missing_question" });
      return;
    }
    const apiIn = body?.api && typeof body.api === "object" ? body.api : null;
    const apiCfg = apiIn
      ? {
          provider: String(apiIn?.provider || "").trim().toLowerCase(),
          base_url: String(apiIn?.base_url || "").trim(),
          model: String(apiIn?.model || "").trim(),
          api_key: String(apiIn?.api_key || "").trim(),
        }
      : null;
    if (apiCfg) {
      if (!["", "deepseek", "openai"].includes(apiCfg.provider)) apiCfg.provider = "deepseek";
      if (apiCfg.base_url.length > 220) apiCfg.base_url = apiCfg.base_url.slice(0, 220);
      if (apiCfg.model.length > 80) apiCfg.model = apiCfg.model.slice(0, 80);
      if (apiCfg.api_key.length > 240) apiCfg.api_key = apiCfg.api_key.slice(0, 240);
      if (!apiCfg.provider) apiCfg.provider = "deepseek";
    }

    const maxSummaryChars = clamp(parseInt(process.env.OPS_LLM_MAX_SUMMARY_CHARS || "18000", 10) || 18000, 4000, 160000);
    const summary = buildOpsContext(req, { tail_n: 30, include_logs: false });
    const summaryText = shrinkOpsContextForPrompt(summary, maxSummaryChars);

    const sys = [
      "你是运维/调试 Copilot，负责排查 RK3568(端) ↔ Node 后端(PC) ↔ 前端(HTML) 的联调问题。",
      "输出要求：用中文，分段给出：现象复述、当前状态、根因候选(按概率排序)、下一步验证命令(Windows/Linux 分开)、建议修复。",
      "优先给出能直接执行的命令、界面路径和配置位置。",
      "如果信息不足，明确列出还缺哪些日志、接口返回或配置截图。",
      "不要编造不存在的日志字段；若信息不足，明确列出需要补充的观测点。",
    ].join("\n");

    try {
      const timeoutMs = clamp(parseInt(process.env.OPS_LLM_TIMEOUT_MS || "60000", 10) || 60000, 5000, 180000);
      const json = await llmChat(
        [
          { role: "system", content: sys },
          { role: "user", content: `用户问题：${question}\n\n现场摘要(JSON)：\n${summaryText}` },
        ],
        { ...(apiCfg || {}), max_tokens: 1800, temperature: 0.2, timeout_ms: timeoutMs },
      );
      const answer = extractLlmResponseText(json);
      if (!answer) throw llmEmptyResponseError(json);
      const used = normalizeLlmConfig(apiCfg || {}, activeOpsLlmCfg());
      sendJson(res, 200, { ok: true, answer, summary, model: used.model, provider: used.provider });
    } catch (e) {
      const msg = String(e?.message || e?.code || "llm_failed");
      const status = Number(e?.status) || null;
      const endpoint = typeof e?.endpoint === "string" ? e.endpoint : null;
      const body = e?.body == null ? null : typeof e.body === "string" ? e.body.slice(0, 1200) : e.body;
      const answer = buildOpsLocalAnswer(question, summary, msg);
      sendJson(res, 200, { ok: true, answer, summary, fallback: true, error: "llm_failed", message: msg, status, endpoint, body });
    }
    return;
  }

  if (pathname === "/api/ops/report" && req.method === "POST") {
    let body;
    try {
      body = safeJsonParse(await readBody(req, 140_000)) || {};
    } catch (e) {
      sendJson(res, e?.status || 400, { ok: false, error: String(e?.code || "bad_request") });
      return;
    }
    const question = String(body?.question ?? "").trim() || "生成一份一键排障报告";
    const apiIn = body?.api && typeof body.api === "object" ? body.api : null;
    const apiCfg = apiIn
      ? {
          provider: String(apiIn?.provider || "").trim().toLowerCase(),
          base_url: String(apiIn?.base_url || "").trim(),
          model: String(apiIn?.model || "").trim(),
          api_key: String(apiIn?.api_key || "").trim(),
        }
      : null;
    if (apiCfg) {
      if (!["", "deepseek", "openai"].includes(apiCfg.provider)) apiCfg.provider = "deepseek";
      if (apiCfg.base_url.length > 220) apiCfg.base_url = apiCfg.base_url.slice(0, 220);
      if (apiCfg.model.length > 80) apiCfg.model = apiCfg.model.slice(0, 80);
      if (apiCfg.api_key.length > 240) apiCfg.api_key = apiCfg.api_key.slice(0, 240);
      if (!apiCfg.provider) apiCfg.provider = "deepseek";
    }
    const maxSummaryChars = clamp(parseInt(process.env.OPS_LLM_MAX_SUMMARY_CHARS || "18000", 10) || 18000, 4000, 160000);
    const summary = buildOpsContext(req, { tail_n: 30, include_logs: false });
    const summaryText = shrinkOpsContextForPrompt(summary, maxSummaryChars);
    const sys = [
      "你是运维/调试 Copilot。请生成一份可复制粘贴的 Markdown 排障报告。",
      "格式：标题、概览、当前状态、时间线、根因候选、验证步骤(带命令)、临时绕过方案、长期修复建议。",
      "优先给出最可执行的步骤，不要空话。",
      "命令必须可执行；Windows 用 PowerShell；RK 用 Linux 常用命令。",
    ].join("\n");
    try {
      const timeoutMs = clamp(parseInt(process.env.OPS_LLM_TIMEOUT_MS || "60000", 10) || 60000, 5000, 180000);
      const json = await llmChat(
        [
          { role: "system", content: sys },
          { role: "user", content: `报告主题：${question}\n\n现场摘要(JSON)：\n${summaryText}` },
        ],
        { ...(apiCfg || {}), max_tokens: 2200, temperature: 0.2, timeout_ms: timeoutMs },
      );
      const markdown = extractLlmResponseText(json);
      if (!markdown) throw llmEmptyResponseError(json);
      const used = normalizeLlmConfig(apiCfg || {}, activeOpsLlmCfg());
      sendJson(res, 200, { ok: true, markdown, summary, model: used.model, provider: used.provider });
    } catch (e) {
      const msg = String(e?.message || e?.code || "llm_failed");
      const status = Number(e?.status) || null;
      const endpoint = typeof e?.endpoint === "string" ? e.endpoint : null;
      const body = e?.body == null ? null : typeof e.body === "string" ? e.body.slice(0, 1200) : e.body;
      const markdown = [
        "# 运维排障报告",
        "",
        buildOpsLocalAnswer(question, summary, msg),
        "",
        "## 备注",
        "当前报告由本地规则生成。配置运维助手 API Key 后，可生成更完整的大模型报告。",
      ].join("\n");
      sendJson(res, 200, { ok: true, markdown, summary, fallback: true, error: "llm_failed", message: msg, status, endpoint, body });
    }
    return;
  }

  if (pathname === "/api/rk/ping" && req.method === "GET") {
    const rk = rkBaseUrlFromQuery(u);
    const timeoutMsRaw = String(u.searchParams.get("timeout_ms") || "").trim();
    const timeoutMs = clamp(parseInt(timeoutMsRaw || "3000", 10), 200, 10000);
    const backendPort = Number(req.socket?.localPort) || null;
    const backendHint = backendPort ? `&backend_port=${encodeURIComponent(String(backendPort))}` : "";
    const r = await httpGetJson(`${rk.base}/api/ping?ts=${Date.now()}${backendHint}`, timeoutMs);
    sendJson(res, 200, {
      ok: true,
      rk_base: rk.base,
      rk_host: rk.host,
      rk_port: rk.port,
      rk_host_in: rk.host_in,
      rk_port_in: rk.port_in,
      rk_timeout_ms: timeoutMs,
      rk_ok: Boolean(r?.ok && r?.json?.ok === true),
      rk_latency_ms: r?.ms ?? null,
      rk_status: r?.status ?? null,
      rk: r?.json ?? null,
      rk_err: r?.ok ? null : r?.text ?? null,
      time_bj: nowBjText(),
    });
    return;
  }

  if (pathname === "/api/relay/ping" && req.method === "GET") {
    const token = String(process.env.RELAY_VIEWER_TOKEN || "").trim();
    const relayBase = String(process.env.RELAY_BASE_URL || "https://47.113.231.233").trim().replace(/\/+$/, "");
    if (!token) {
      sendJson(res, 200, { ok: true, relay_ok: false, error: "relay_token_missing", message: "Set RELAY_VIEWER_TOKEN in the backend process environment" });
      return;
    }
    const relay = await httpGetJson(`${relayBase}/api/adas/snapshot?source=0&ts=${Date.now()}`, 8000, { "X-Viewer-Token": token });
    const snapshot = relay?.json;
    const relayOk = Boolean(relay?.ok && snapshot?.ok === true && typeof snapshot?.image_base64 === "string" && snapshot.image_base64.length > 0);
    sendJson(res, 200, {
      ok: true,
      relay_ok: relayOk,
      relay_base: relayBase,
      relay_status: relay?.status || 0,
      relay_latency_ms: relay?.ms ?? null,
      relay_error: relayOk ? null : String(snapshot?.error || snapshot?.message || relay?.text || "Relay snapshot unavailable").slice(0, 300),
      width: relayOk ? snapshot.width : null,
      height: relayOk ? snapshot.height : null,
      time_bj: nowBjText(),
    });
    return;
  }

  if (pathname === "/api/ai/status" && req.method === "GET") {
    const rYolo = resolveDefaultModel("yolo");
    const rOcr = resolveDefaultModel("ocr");
    const yolo = aiState.models.yolo;
    const ocr = aiState.models.ocr;
    const activeYolo = aiActiveModel("yolo");
    const activeOcr = aiActiveModel("ocr");
    const charsetPath = resolveOcrCharsetPath(activeOcr);
    sendJson(res, 200, {
      ok: true,
      engine: aiPython.engine,
      python_error: aiPython.lastError,
      ready: aiReadyForMode("overlay"),
      supported_modes: ["overlay", "yolo", "ocr"],
      ready_modes: {
        overlay: aiReadyForMode("overlay"),
        yolo: aiReadyForMode("yolo"),
        ocr: aiReadyForMode("ocr"),
      },
      models: {
        yolo: yolo
          ? { file_name: yolo.file_name, full_path: yolo.full_path, uploaded_at: yolo.uploaded_at, size: yolo.size }
          : null,
        ocr: ocr ? { file_name: ocr.file_name, full_path: ocr.full_path, uploaded_at: ocr.uploaded_at, size: ocr.size } : null,
      },
      model_paths: {
        yolo: aiState.model_paths.yolo ? { file_name: aiState.model_paths.yolo.file_name, full_path: aiState.model_paths.yolo.full_path, exists: modelPathExists(aiState.model_paths.yolo), source: aiState.model_paths.yolo.source } : null,
        ocr: aiState.model_paths.ocr ? { file_name: aiState.model_paths.ocr.file_name, full_path: aiState.model_paths.ocr.full_path, exists: modelPathExists(aiState.model_paths.ocr), source: aiState.model_paths.ocr.source } : null,
      },
      resolved: {
        yolo: rYolo ? { file_name: rYolo.file_name, dir: rYolo.dir, full_path: rYolo.full_path, exists: Boolean(rYolo.exists), source: rYolo.source || "default" } : null,
        ocr: rOcr ? { file_name: rOcr.file_name, dir: rOcr.dir, full_path: rOcr.full_path, exists: Boolean(rOcr.exists), source: rOcr.source || "default" } : null,
      },
      active: {
        yolo: activeYolo ? { file_name: activeYolo.file_name, full_path: activeYolo.full_path, source: activeYolo.source } : null,
        ocr: activeOcr ? { file_name: activeOcr.file_name, full_path: activeOcr.full_path, source: activeOcr.source } : null,
      },
      ocr_charset: {
        set: aiState.ocr_charset?.full_path ? { file_name: aiState.ocr_charset.file_name, full_path: aiState.ocr_charset.full_path, source: aiState.ocr_charset.source } : null,
        active: charsetPath ? { full_path: charsetPath, exists: true } : null,
      },
      last: aiState.last,
    });
    return;
  }

  if (pathname === "/api/ai/ocr-charset-path" && req.method === "POST") {
    const raw = await readBody(req);
    const body = safeJsonParse(raw) || {};
    const p = resolveUserModelPath("ocr_charset", body?.path);
    if (!p) {
      aiState.ocr_charset = { file_name: null, full_path: null, uploaded_at: null, source: null };
      sendJson(res, 200, { ok: true, cleared: true });
      return;
    }
    if (!p.exists) {
      sendJson(res, 400, { ok: false, error: "path_not_found", path: p.full_path });
      return;
    }
    aiState.ocr_charset = { file_name: p.file_name, full_path: p.full_path, uploaded_at: nowBjText(), source: "path" };
    sendJson(res, 200, { ok: true, ocr_charset: aiState.ocr_charset });
    return;
  }

  if (pathname === "/api/ai/ocr-charset" && req.method === "POST") {
    const ct = String(req.headers["content-type"] || "");
    const mb = ct.match(/boundary=([^;]+)/i);
    if (!mb) {
      sendJson(res, 400, { ok: false, error: "bad_content_type" });
      return;
    }
    const boundary = String(mb[1]).replace(/^"|"$/g, "");
    const buf = await readBodyBuffer(req, 20_000_000);
    const part = parseMultipartSingleFile(buf, boundary);
    if (!part || !part.data || part.data.length === 0) {
      sendJson(res, 400, { ok: false, error: "no_file" });
      return;
    }
    ensureUploadDir();
    const baseName = sanitizeFileName(part.fileName);
    const fileName = `ocr_charset_${Date.now()}_${baseName}`;
    const fullPath = path.join(uploadDir, fileName);
    try {
      fs.writeFileSync(fullPath, part.data);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: "write_failed", message: String(e?.message || e) });
      return;
    }
    aiState.ocr_charset = { file_name: baseName, full_path: fullPath, uploaded_at: nowBjText(), source: "upload" };
    sendJson(res, 200, { ok: true, ocr_charset: aiState.ocr_charset });
    return;
  }

  if (pathname === "/api/tts/status" && req.method === "GET") {
    const resolved = resolveDefaultTtsModel();
    const active = ttsActiveModel();
    const activeExt = active ? fileExt(active.full_path) : "";
    const runtime = activeTtsRuntimeCfg();
    const sfCfg = activeSiliconflowTtsCfg();
    const edgeCfg = activeEdgeTtsCfg();
    const localReady = ttsReady();
    const apiReady = Boolean(sfCfg.api_key);
    const edgeReady = true;
    const engine = activeExt === ".onnx" || activeExt === ".pt" || activeExt === ".pth" ? "python" : "tone";
    sendJson(res, 200, {
      ok: true,
      ready: runtime.provider === "siliconflow" ? apiReady : runtime.provider === "edge" ? edgeReady : localReady,
      local_ready: localReady,
      api_ready: apiReady,
      edge_ready: edgeReady,
      engine,
      supported_exts: [".onnx", ".oxnn", ".pt", ".pth", ".rknn"],
      model: ttsState.model ? { file_name: ttsState.model.file_name, full_path: ttsState.model.full_path, uploaded_at: ttsState.model.uploaded_at, size: ttsState.model.size } : null,
      model_path: ttsState.model_path ? { file_name: ttsState.model_path.file_name, full_path: ttsState.model_path.full_path } : null,
      resolved: resolved
        ? { file_name: resolved.file_name, dir: resolved.dir, full_path: resolved.full_path, exists: Boolean(resolved.exists) }
        : null,
      active: active ? { file_name: active.file_name, full_path: active.full_path, source: active.source } : null,
      piper: ttsPiperConfigInfo(active),
      runtime: publicTtsRuntimeConfig(runtime),
      siliconflow: publicSiliconflowTtsConfig(sfCfg),
      edge: publicEdgeTtsConfig(edgeCfg),
      last: ttsState.last,
    });
    return;
  }

  if (pathname === "/api/tts/model-path" && req.method === "POST") {
    const raw = await readBody(req);
    const body = safeJsonParse(raw) || {};
    const p = resolveUserModelPath("tts", body?.path);
    if (!p) {
      ttsState.model_path = null;
      clearDefaultTtsModelPath();
      sendJson(res, 200, { ok: true, cleared: true, persisted: true });
      return;
    }
    if (!p.exists) {
      sendJson(res, 400, { ok: false, error: "path_not_found", path: p.full_path });
      return;
    }
    ttsState.model_path = { file_name: p.file_name, full_path: p.full_path, source: "path" };
    const savedDefault = saveDefaultTtsModelPath(ttsState.model_path);
    sendJson(res, 200, { ok: true, model_path: ttsState.model_path, default_model: savedDefault, persisted: Boolean(savedDefault) });
    return;
  }

  if (pathname === "/api/tts/model" && req.method === "POST") {
    const ct = String(req.headers["content-type"] || "");
    const mb = ct.match(/boundary=([^;]+)/i);
    if (!mb) {
      sendJson(res, 400, { ok: false, error: "bad_content_type" });
      return;
    }
    const boundary = String(mb[1]).replace(/^"|"$/g, "");
    const buf = await readBodyBuffer(req, 300_000_000);
    const parts = parseMultipartFiles(buf, boundary).filter((part) => part?.data?.length > 0);
    if (!parts.length) {
      sendJson(res, 400, { ok: false, error: "no_file" });
      return;
    }
    ensureUploadDir();
    const modelPart = parts.find((part) => {
      const ext = fileExt(part.fileName);
      return ext === ".onnx" || ext === ".oxnn" || ext === ".pt" || ext === ".pth" || ext === ".rknn";
    });
    const configParts = parts.filter((part) => /\.onnx\.json$/i.test(String(part.fileName || "")) || /\.oxnn\.json$/i.test(String(part.fileName || "")));
    if (!modelPart && parts.length === 1 && configParts.length === 1) {
      const part = parts[0];
      const baseName = sanitizeFileName(part.fileName);
      const active = ttsActiveModel();
      const activeExt = fileExt(active?.full_path);
      if (!active || (activeExt !== ".onnx" && activeExt !== ".oxnn")) {
        sendJson(res, 409, { ok: false, error: "tts_onnx_missing", message: "Upload or set the .onnx/.oxnn model before uploading .onnx.json." });
        return;
      }
      const fullPath = `${active.full_path}.json`;
      try {
        fs.writeFileSync(fullPath, part.data);
      } catch (e) {
        sendJson(res, 500, { ok: false, error: "write_failed", message: String(e?.message || e) });
        return;
      }
      sendJson(res, 200, { ok: true, config: { file_name: baseName, full_path: fullPath, size: part.data.length }, model: ttsState.model, model_path: ttsState.model_path, piper: ttsPiperConfigInfo(active) });
      return;
    }
    if (!modelPart) {
      sendJson(res, 400, { ok: false, error: "tts_model_missing", message: "请选择 .onnx/.oxnn/.pt/.pth/.rknn 主模型文件，或上传包含主模型的 TTS 文件夹。" });
      return;
    }
    const baseName = sanitizeFileName(modelPart.fileName);
    const fileName = `tts_${Date.now()}_${baseName}`;
    const fullPath = path.join(uploadDir, fileName);
    try {
      fs.writeFileSync(fullPath, modelPart.data);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: "write_failed", message: String(e?.message || e) });
      return;
    }
    ttsState.model = { file_name: baseName, full_path: fullPath, size: modelPart.data.length, uploaded_at: nowBjText() };
    ttsState.model_path = null;
    const savedDefault = saveDefaultTtsModelPath({ ...ttsState.model, source: "upload" });
    let config = null;
    const modelBaseNoJson = String(baseName).replace(/\.(onnx|oxnn)$/i, "");
    const matchingConfig =
      configParts.find((part) => sanitizeFileName(part.fileName).toLowerCase() === `${baseName.toLowerCase()}.json`) ||
      configParts.find((part) => sanitizeFileName(part.fileName).toLowerCase().endsWith(`${modelBaseNoJson.toLowerCase()}.onnx.json`)) ||
      configParts.find((part) => sanitizeFileName(part.fileName).toLowerCase().endsWith(`${modelBaseNoJson.toLowerCase()}.oxnn.json`)) ||
      configParts[0] ||
      null;
    const siblingConfig = `${fullPath}.json`;
    try {
      if (matchingConfig && (fileExt(fullPath) === ".onnx" || fileExt(fullPath) === ".oxnn")) {
        fs.writeFileSync(siblingConfig, matchingConfig.data);
        config = { file_name: sanitizeFileName(matchingConfig.fileName), full_path: siblingConfig, size: matchingConfig.data.length };
      } else {
        const origConfig = `${path.resolve(path.dirname(fullPath), baseName)}.json`;
        if ((fileExt(fullPath) === ".onnx" || fileExt(fullPath) === ".oxnn") && fs.existsSync(origConfig) && fs.statSync(origConfig).isFile() && !fs.existsSync(siblingConfig)) {
          fs.copyFileSync(origConfig, siblingConfig);
          config = { file_name: path.basename(origConfig), full_path: siblingConfig, size: fs.statSync(siblingConfig).size };
        }
      }
    } catch {}
    sendJson(res, 200, { ok: true, model: ttsState.model, config, default_model: savedDefault, persisted: Boolean(savedDefault), piper: ttsPiperConfigInfo(ttsState.model), files_received: parts.length });
    return;
  }

  if (pathname === "/api/tts/speak" && req.method === "POST") {
    const raw = await readBody(req);
    const body = safeJsonParse(raw) || {};
    const text = String(body?.text ?? "").trim();
    if (!text) {
      sendJson(res, 400, { ok: false, error: "bad_text" });
      return;
    }
    const ttsOptions = body?.tts_options && typeof body.tts_options === "object" ? body.tts_options : normalizeTtsOptions(body);
    const audio = await synthesizeTtsWavBase64(text, ttsOptions);
    if (!audio.available || !audio.wav_base64) {
      const status = audio.reason === "bad_text" ? 400 : audio.reason === "model_not_loaded" || audio.reason === "tts_config_missing" || audio.reason === "tts_model_unusable" ? 409 : 503;
      sendJson(res, status, { ok: false, error: audio.reason || "tts_failed", ...audio });
      return;
    }
    send(res, 200, { "Content-Type": audio.content_type || "audio/wav", "Cache-Control": "no-store" }, Buffer.from(String(audio.wav_base64), "base64"));
    return;
  }

  const mAiModelPath = pathname.match(/^\/api\/ai\/model-path\/(yolo|ocr)$/);
  if (mAiModelPath && req.method === "POST") {
    const kind = mAiModelPath[1];
    const raw = await readBody(req);
    const body = safeJsonParse(raw) || {};
    const p = resolveUserModelPath(kind, body?.path);
    if (!p) {
      aiState.model_paths[kind] = null;
      clearDefaultAiModelPath(kind);
      sendJson(res, 200, { ok: true, cleared: true, persisted: true });
      return;
    }
    if (!p.exists) {
      sendJson(res, 400, { ok: false, error: "path_not_found", path: p.full_path });
      return;
    }
    const validation = await validateAiModelsPartial(kind, p.full_path);
    if (!validation?.ok) {
      sendJson(res, 422, {
        ok: false,
        error: "model_load_failed",
        kind,
        model_path: { file_name: p.file_name, full_path: p.full_path, source: "path", load_ok: false, load_error: validation?.message || validation?.error || "load_failed" },
        load: validation,
        active: aiActiveModel(kind),
      });
      return;
    }
    aiState.model_paths[kind] = { file_name: p.file_name, full_path: p.full_path, source: "path", load_ok: true, load_error: null };
    const defaultModel = saveDefaultAiModelPath(kind, aiState.model_paths[kind]);
    sendJson(res, 200, { ok: true, model_path: aiState.model_paths[kind], default_model_path: defaultModel, persisted: Boolean(defaultModel), load: validation });
    return;
  }

  const mAiModelClear = pathname.match(/^\/api\/ai\/model-clear\/(yolo|ocr)$/);
  if (mAiModelClear && req.method === "POST") {
    const kind = mAiModelClear[1];
    aiState.models[kind] = null;
    sendJson(res, 200, { ok: true, cleared: true, kind });
    return;
  }

  const mAiModel = pathname.match(/^\/api\/ai\/model\/(yolo|ocr)$/);
  if (mAiModel && req.method === "POST") {
    const kind = mAiModel[1];
    const ct = String(req.headers["content-type"] || "");
    const mb = ct.match(/boundary=([^;]+)/i);
    if (!mb) {
      sendJson(res, 400, { ok: false, error: "bad_content_type" });
      return;
    }
    const boundary = String(mb[1]).replace(/^"|"$/g, "");
    const buf = await readBodyBuffer(req, 300_000_000);
    const part = parseMultipartSingleFile(buf, boundary);
    if (!part || !part.data || part.data.length === 0) {
      sendJson(res, 400, { ok: false, error: "no_file" });
      return;
    }
    ensureUploadDir();
    const baseName = sanitizeFileName(part.fileName);
    const fileName = `${kind}_${Date.now()}_${baseName}`;
    const fullPath = path.join(uploadDir, fileName);
    try {
      fs.writeFileSync(fullPath, part.data);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: "write_failed", message: String(e?.message || e) });
      return;
    }
    const validation = await validateAiModelsPartial(kind, fullPath);
    const candidate = { file_name: baseName, full_path: fullPath, size: part.data.length, uploaded_at: nowBjText(), load_ok: validation?.ok === true, load_error: validation?.ok ? null : validation?.message || validation?.error || "load_failed" };
    if (!validation?.ok) {
      sendJson(res, 200, { ok: true, accepted: false, model: candidate, load: validation, active: aiActiveModel(kind) });
      return;
    }
    aiState.models[kind] = candidate;
    aiState.model_paths[kind] = null;
    const defaultModel = saveDefaultAiModelPath(kind, aiState.models[kind]);
    sendJson(res, 200, { ok: true, accepted: true, model: aiState.models[kind], default_model_path: defaultModel, persisted: Boolean(defaultModel), load: validation });
    return;
  }

  if (pathname === "/api/ai/infer/frame" && req.method === "POST") {
    const raw = await readBody(req, 25_000_000);
    const body = safeJsonParse(raw) || {};
    const mode = normalizeAiMode(body?.mode);
    const needYolo = aiNeedYolo(mode);
    const needOcr = aiNeedOcr(mode);
    const activeYolo = aiActiveModel("yolo");
    const activeOcr = aiActiveModel("ocr");
    if ((needYolo && (!activeYolo || !aiModelUsable("yolo", activeYolo))) || (needOcr && (!activeOcr || !aiModelUsable("ocr", activeOcr)))) {
      sendJson(res, 409, {
        ok: false,
        error: "model_not_loaded",
        mode,
        missing: [needYolo && (!activeYolo || !aiModelUsable("yolo", activeYolo)) ? "yolo" : null, needOcr && (!activeOcr || !aiModelUsable("ocr", activeOcr)) ? "ocr" : null].filter(Boolean),
      });
      return;
    }
    const charsetPath = needOcr ? resolveOcrCharsetPath(activeOcr) : "";
    if (needOcr && !charsetPath) {
      sendJson(res, 409, { ok: false, error: "ocr_charset_missing" });
      return;
    }
    const base64 = String(body?.image_jpeg_base64 || "");
    const width = clamp(parseInt(body?.width || "0", 10), 2, 4096);
    const height = clamp(parseInt(body?.height || "0", 10), 2, 4096);
    const detConfRaw = parseNumber(body?.det_conf);
    const detConf = detConfRaw == null ? null : clamp(detConfRaw, 0.01, 0.99);
    const detMinWRaw = parseNumber(body?.det_min_w);
    const detMinHRaw = parseNumber(body?.det_min_h);
    const detArMinRaw = parseNumber(body?.det_ar_min);
    const detArMaxRaw = parseNumber(body?.det_ar_max);
    const detMinW = detMinWRaw == null ? (mode === "yolo" ? 2 : null) : clamp(detMinWRaw, 0, 4096);
    const detMinH = detMinHRaw == null ? (mode === "yolo" ? 2 : null) : clamp(detMinHRaw, 0, 4096);
    const detArMin = detArMinRaw == null ? (mode === "yolo" ? 0.05 : null) : clamp(detArMinRaw, 0.01, 100);
    const detArMax = detArMaxRaw == null ? (mode === "yolo" ? 20 : null) : clamp(detArMaxRaw, 0.01, 100);
    if (!base64) {
      sendJson(res, 400, { ok: false, error: "bad_image" });
      return;
    }
    let imgBuf;
    try {
      imgBuf = Buffer.from(base64, "base64");
    } catch {
      imgBuf = null;
    }
    if (!imgBuf || imgBuf.length < 10) {
      sendJson(res, 400, { ok: false, error: "bad_image" });
      return;
    }
    if (aiPython.engine === "python") {
      try {
        const r = await callAiPython({
          op: "infer",
          mode,
          yolo_path: needYolo ? activeYolo?.full_path ?? "" : "",
          ocr_path: needOcr ? activeOcr?.full_path ?? "" : "",
          ocr_charset_path: needOcr ? charsetPath : "",
          image_jpeg_base64: base64,
          width,
          height,
          det_conf: detConf == null ? undefined : detConf,
          det_min_w: detMinW == null ? undefined : detMinW,
          det_min_h: detMinH == null ? undefined : detMinH,
          det_ar_min: detArMin == null ? undefined : detArMin,
          det_ar_max: detArMax == null ? undefined : detArMax,
        });
        if (!r?.ok) {
          sendJson(res, 500, { ok: false, error: r?.error || "python_failed", message: r?.message });
          return;
        }
        const inputW = Number(r?.input_width) || width;
        const inputH = Number(r?.input_height) || height;
        const out = {
          ok: true,
          ready: true,
          engine: "python",
          mode,
          time_bj: nowBjText(),
          input_width: inputW,
          input_height: inputH,
          stage_ms: r?.stage_ms ?? {},
          models: { yolo: activeYolo?.file_name ?? null, ocr: activeOcr?.file_name ?? null },
          model_sources: { yolo: activeYolo?.source ?? null, ocr: activeOcr?.source ?? null },
          boxes: Array.isArray(r?.boxes) ? r.boxes : [],
          det_debug: r?.det_debug ?? null,
          ocr: r?.ocr ?? null,
          plates: Array.isArray(r?.plates) ? r.plates : [],
        };
        aiState.last = { time_bj: out.time_bj, mode: out.mode, stage_ms: out.stage_ms, ocr: out.ocr, det_count: out.boxes.length };
        sendJson(res, 200, out);
        return;
      } catch (e) {
        sendJson(res, 503, { ok: false, error: "python_not_ready", meta: e?.meta ?? aiPython.lastError ?? null });
        return;
      }
    }

    const seed = hash32(imgBuf);
    const detMs = needYolo ? 8 + (seed % 10) : 0;
    const ocrMs = needOcr ? 7 + ((seed >>> 8) % 12) : 0;
    const totalMs = detMs + ocrMs + 4;
    const boxes = needYolo ? fakeDetections(width, height, seed) : [];
    const ocr = needOcr ? fakeOcr(seed) : null;
    const out = {
      ok: true,
      ready: true,
      engine: "fake",
      mode,
      time_bj: nowBjText(),
      input_width: width,
      input_height: height,
      stage_ms: { det_ms: detMs, ocr_ms: ocrMs, total_ms: totalMs },
      models: { yolo: activeYolo?.file_name ?? null, ocr: activeOcr?.file_name ?? null },
      model_sources: { yolo: activeYolo?.source ?? null, ocr: activeOcr?.source ?? null },
      boxes,
      ocr,
    };
    aiState.last = { time_bj: out.time_bj, mode: out.mode, stage_ms: out.stage_ms, ocr: out.ocr, det_count: boxes.length };
    opsState.lastRkPing = { ...out, at_bj: nowBjText() };
    sendJson(res, 200, out);
    return;
  }

  if (pathname === "/api/esp32/status" && req.method === "GET") {
    sendJson(res, 200, buildEsp32Status());
    return;
  }

  if (pathname === "/api/wifi-car/status" && req.method === "GET") {
    sendJson(res, 200, wifiCarBridge.getStatus());
    return;
  }

  if (pathname === "/api/wifi-car/connect" && req.method === "POST") {
    if (!wifiCarControlOriginAllowed(req)) {
      sendJson(res, 403, { ok: false, error: "origin_not_allowed", message: "小车控制只接受本机同源页面或本机请求" });
      return;
    }
    sendJson(res, 200, { ok: true, status: wifiCarBridge.getStatus(), message: "ESP32 请主动连接云端 WSS" });
    return;
  }

  if (pathname === "/api/wifi-car/disconnect" && req.method === "POST") {
    if (!wifiCarControlOriginAllowed(req)) {
      sendJson(res, 403, { ok: false, error: "origin_not_allowed", message: "小车控制只接受本机同源页面或本机请求" });
      return;
    }
    sendJson(res, 200, { ok: true, status: await wifiCarBridge.disconnect() });
    return;
  }

  if (pathname === "/api/wifi-car/command" && req.method === "POST") {
    if (!wifiCarControlOriginAllowed(req)) {
      sendJson(res, 403, { ok: false, error: "origin_not_allowed", message: "小车控制只接受本机同源页面或本机请求" });
      return;
    }
    const body = safeJsonParse(await readBody(req, 300_000)) || {};
    const requestedAction = String(body.action || "").trim().toLowerCase();
    const automaticDecision = ["automatic", "decision"].includes(String(body.behavior?.source || ""));
    const redAdasArrow = rkReported.realtimeVision?.mode === "adas" &&
      rkReported.realtimeVision?.arrow_state === "red" && rkReported.realtimeVision?.alarm === true &&
      Date.now() - rkReported.realtimeVisionAtMs <= 10000;
    const action = automaticDecision && requestedAction === "alarm" && !redAdasArrow ? "stop" : requestedAction;
    try {
      const result = await wifiCarBridge.sendAction(action, { source: "operator" });
      const behaviorLogSaved = persistAdasBehavior(action, body.behavior, result);
      sendJson(res, 200, { ...result, ...(behaviorLogSaved !== null ? { behavior_log_saved: behaviorLogSaved } : {}) });
    } catch (error) {
      const code = String(error?.code || "wifi_car_command_failed");
      const status = code === "unsupported_action" ? 400 : code === "wifi_car_offline" || code === "command_busy" ? 409 : 502;
      const executionDetail = String(error?.message || error);
      communicationLog.append({ channel: "system", transport: "WSS", status: "error", action,
        summary: `上位机请求未完成：${action} · ${code} · ${executionDetail}` });
      const behaviorLogSaved = persistAdasBehavior(action, body.behavior,
        { ok: false, response: executionDetail });
      sendJson(res, status, { ok: false, error: code, message: executionDetail, status: wifiCarBridge.getStatus(),
        ...(behaviorLogSaved !== null ? { behavior_log_saved: behaviorLogSaved } : {}) });
    }
    return;
  }

  if (pathname === "/api/esp32/config" && req.method === "GET") {
    sendJson(res, 200, { ok: true, config: { ...esp32State.cfg }, status: buildEsp32Status() });
    return;
  }

  if (pathname === "/api/esp32/config" && req.method === "POST") {
    const raw = await readBody(req, 80_000);
    const body = safeJsonParse(raw) || {};
    const host = String(body?.host ?? body?.ip ?? "").trim();
    const safeHost = host ? safeHostText(host) : "";
    if (host && !safeHost) {
      sendJson(res, 400, { ok: false, error: "bad_host" });
      return;
    }
    if ("host" in body || "ip" in body) esp32State.cfg.host = safeHost;
    if ("port" in body) esp32State.cfg.port = clamp(parseInt(String(body.port || "80"), 10) || 80, 1, 65535);
    if ("device_id" in body || "deviceId" in body || "device" in body) {
      const nextDeviceId = cleanDeviceId(body?.device_id || body?.deviceId || body?.device, esp32State.cfg.device_id || "esp32-servo-01");
      esp32State.cfg.device_id = nextDeviceId;
      esp32State.device_id = nextDeviceId;
    }
    if ("mac" in body) {
      const nextMac = String(body.mac || "").trim();
      esp32State.cfg.mac = nextMac;
      esp32State.mac = nextMac;
    }
    if ("heartbeat_ms" in body) esp32State.cfg.heartbeat_ms = clamp(parseInt(String(body.heartbeat_ms || esp32State.cfg.heartbeat_ms), 10) || esp32State.cfg.heartbeat_ms, 500, 120000);
    if ("command_poll_ms" in body) {
      const nextPoll = clamp(parseInt(String(body.command_poll_ms || esp32State.cfg.command_poll_ms), 10) || esp32State.cfg.command_poll_ms, 200, 120000);
      esp32State.cfg.command_poll_ms = nextPoll;
      esp32State.command_poll_ms = nextPoll;
    }
    if ("timeout_ms" in body) esp32State.cfg.timeout_ms = clamp(parseInt(String(body.timeout_ms || esp32State.cfg.timeout_ms), 10) || esp32State.cfg.timeout_ms, 300, 15000);
    if ("angle" in body) esp32State.cfg.angle = clampEsp32Angle(body.angle, esp32State.cfg.angle);
    if ("hold_ms" in body) esp32State.cfg.hold_ms = clampEsp32HoldMs(body.hold_ms, esp32State.cfg.hold_ms);
    if ("return_angle" in body) esp32State.cfg.return_angle = clampEsp32Angle(body.return_angle, esp32State.cfg.return_angle);
    if ("return_enabled" in body) esp32State.cfg.return_enabled = Boolean(body.return_enabled);
    if ("gate_enabled" in body) {
      esp32State.cfg.gate_enabled = Boolean(body.gate_enabled);
      esp32State.gate.enabled = Boolean(body.gate_enabled);
      if (!esp32State.cfg.gate_enabled) {
        removeQueuedEsp32GateCommands();
        clearEsp32GateTimer();
        for (const gate of Object.values(esp32State.gates || {})) {
          if (!gate) continue;
          gate.enabled = false;
          gate.open = false;
          gate.closing = false;
          gate.close_due_ms = 0;
          gate.last_event = "disabled";
        }
        esp32State.gate.open = false;
        esp32State.gate.closing = false;
        esp32State.gate.close_due_ms = 0;
      }
    }
    if ("gate_open_angle" in body) esp32State.cfg.gate_open_angle = clampEsp32Angle(body.gate_open_angle, esp32State.cfg.gate_open_angle);
    if ("gate_close_angle" in body) esp32State.cfg.gate_close_angle = clampEsp32Angle(body.gate_close_angle, esp32State.cfg.gate_close_angle);
    if ("gate_hold_ms" in body) esp32State.cfg.gate_hold_ms = clamp(parseInt(String(body.gate_hold_ms || esp32State.cfg.gate_hold_ms), 10) || esp32State.cfg.gate_hold_ms, 1000, 300000);
    esp32State.cfg = saveEsp32Config(esp32State.cfg);
    esp32State.device_id = esp32State.cfg.device_id || esp32State.device_id;
    esp32State.mac = esp32State.cfg.mac || esp32State.mac;
    esp32State.command_poll_ms = esp32State.cfg.command_poll_ms;
    esp32State.gate.enabled = Boolean(esp32State.cfg.gate_enabled);
    appendDurableJsonLine(path.join(logRoot, "esp32_events.jsonl"), { event: "config", time_bj: nowBjText(), config: { ...esp32State.cfg } });
    sendJson(res, 200, { ok: true, config: { ...esp32State.cfg }, status: buildEsp32Status() });
    return;
  }

  if (pathname === "/api/esp32/heartbeat" && req.method === "POST") {
    const raw = await readBody(req, 120_000);
    const body = safeJsonParse(raw) || {};
    updateEsp32FromHeartbeat(body, req);
    sendJson(res, 200, { ok: true, server_time_ms: Date.now(), status: buildEsp32Status() });
    return;
  }

  if (pathname === "/api/esp32/command/enqueue" && req.method === "POST") {
    const raw = await readBody(req, 80_000);
    const body = safeJsonParse(raw) || {};
    const r = enqueueEsp32Command(body, "api");
    if (!r.ok) {
      sendJson(res, 400, r);
      return;
    }
    sendJson(res, 200, { ok: true, command: publicEsp32Command(r.command), status: buildEsp32Status() });
    return;
  }

  if (pathname === "/api/esp32/command/pull" && req.method === "GET") {
    const pulled = pullEsp32Command({
      device_id: u.searchParams.get("device_id") || u.searchParams.get("deviceId"),
      device: u.searchParams.get("device"),
      mac: u.searchParams.get("mac"),
    });
    if (!pulled.ok) {
      sendJson(res, 507, pulled);
      return;
    }
    const command = pulled.command;
    if (!command) {
      sendJson(res, 200, { ok: true, command: null });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      command: {
        id: command.id,
        type: command.type,
        action: command.action || "",
        angle: command.angle,
        hold_ms: command.hold_ms,
        return_angle: command.return_angle,
        return_enabled: command.return_enabled,
        device_id: command.device_id || "",
        mac: command.mac || "",
      },
    });
    return;
  }

  if (pathname === "/api/esp32/command/result" && req.method === "POST") {
    const raw = await readBody(req, 80_000);
    const body = safeJsonParse(raw) || {};
    const r = finishEsp32Command(body);
    if (!r.ok) {
      sendJson(res, r.error === "command_result_persist_failed" ? 507 : 400, r);
      return;
    }
    sendJson(res, 200, { ok: true, id: r.result.id, state: r.result.state });
    return;
  }

  if (pathname === "/api/esp32/ping" && req.method === "POST") {
    const raw = await readBody(req, 80_000);
    const body = safeJsonParse(raw) || {};
    const started = Date.now();
    const online = esp32IsOnline();
    const latencyMs = Math.max(0, Date.now() - started);
    esp32State.last_ping_ms = latencyMs;
    esp32State.last_ping_at_ms = Date.now();
    if (online) {
      esp32State.last_error = "";
    } else {
      esp32State.last_error = "esp32_heartbeat_timeout";
    }
    appendJsonLine("esp32_events.jsonl", {
      event: "ping",
      time_bj: nowBjText(),
      mode: "cloud_heartbeat",
      ok: online,
      latency_ms: latencyMs,
      error: online ? "" : esp32State.last_error,
    });
    sendJson(res, online ? 200 : 409, {
      ok: online,
      online,
      mode: "cloud_heartbeat",
      latency_ms: latencyMs,
      error: online ? null : "esp32_offline",
      message: online ? "ESP32 heartbeat is online." : "ESP32 heartbeat timeout. Wait for heartbeat from device.",
      summary: buildEsp32Status(),
    });
    return;
  }

  if (pathname === "/api/esp32/servo/flip" && req.method === "POST") {
    const raw = await readBody(req, 80_000);
    const body = safeJsonParse(raw) || {};
    const leaseMs = clamp(parseInt(process.env.ESP32_COMMAND_LEASE_MS || "10000", 10) || 10000, 1000, 120000);
    const activeCommand = esp32State.commands.find((cmd) => cmd.state === "pulled" && cmd.pulled_at_ms && Date.now() - Number(cmd.pulled_at_ms) <= leaseMs);
    if (activeCommand) {
      sendJson(res, 409, { ok: false, error: "busy", message: "ESP32 servo command is already in progress.", status: buildEsp32Status() });
      return;
    }
    const r = enqueueEsp32Command({
      type: "servo_flip",
      device_id: body?.device_id || body?.deviceId || body?.device,
      mac: body?.mac,
      angle: clampEsp32Angle(body?.angle, esp32State.cfg.angle),
      hold_ms: clampEsp32HoldMs(body?.hold_ms, esp32State.cfg.hold_ms),
      return_angle: clampEsp32Angle(body?.return_angle, esp32State.cfg.return_angle),
      return_enabled: typeof body?.return_enabled === "boolean" ? body.return_enabled : Boolean(esp32State.cfg.return_enabled),
    }, "servo_flip_api");
    if (!r.ok) {
      sendJson(res, 400, r);
      return;
    }
    esp32State.last_servo_at_ms = Date.now();
    sendJson(res, 200, {
      ok: true,
      mode: "cloud_command_queue",
      queued: true,
      command: publicEsp32Command(r.command),
      payload: {
        angle: r.command.angle,
        hold_ms: r.command.hold_ms,
        return_angle: r.command.return_angle,
        return_enabled: r.command.return_enabled,
      },
      message: "Command queued. ESP32 will pull it from cloud backend.",
      summary: buildEsp32Status(),
    });
    return;
  }

  if (pathname === "/api/esp32/gate/close" && req.method === "POST") {
    const raw = await readBody(req, 80_000);
    const body = safeJsonParse(raw) || {};
    const target = esp32GateTargetFromMeta(body);
    const gate = getEsp32Gate(target);
    const r = closeEsp32GateIfDue(gate, true);
    sendJson(res, r.ok ? 200 : 400, { ...r, status: buildEsp32Status() });
    return;
  }

  if (pathname === "/api/db/status" && req.method === "GET") {
    await ensureMysqlPool();
    sendJson(res, 200, { ok: true, mysql: mysqlPublicStatus() });
    return;
  }

  if (pathname === "/api/status" && req.method === "GET") {
    if (rkReported.status && typeof rkReported.status === "object") {
      const atMs = Number(rkReported.statusAtMs || 0) || 0;
      const ageMs = atMs ? Date.now() - atMs : 0;
       const online = atMs ? ageMs >= 0 && ageMs < RK_ONLINE_TIMEOUT_MS : false;
      const cloudUserMessageSync = {
        enabled: true,
        mode: "cloud_pull",
        path: "/api/rk/user-message/config",
        syncing: rkReported.userMessageConfigSyncing,
        last_result: rkReported.userMessageConfigSyncResult,
        last_pull: rkReported.userMessageConfigPull,
      };
      sendJson(res, 200, {
        ...rkReported.status,
        rk_online: online,
        rk_realtime_vision: rkReported.realtimeVision
          ? { ...rkReported.realtimeVision,
              age_ms: Math.max(0, Date.now() - rkReported.realtimeVisionAtMs) }
          : null,
        rk_peer_ip: rkReported.peerIp || null,
        rk_last_seen_at_ms: atMs || null,
        rk_last_seen_age_ms: atMs ? ageMs : null,
         rk_online_timeout_ms: RK_ONLINE_TIMEOUT_MS,
        user_message_config: rkReported.status.user_message_config || {
          schema: rkUserMessageConfig.schema,
          version: rkUserMessageConfig.version,
          updated_at: rkUserMessageConfig.updated_at,
        },
        user_message_config_sync: rkReported.status.user_message_config_sync || cloudUserMessageSync,
        cloud_user_message_config_sync: cloudUserMessageSync,
        last_user_message: rkReported.userMessages[0] || null,
        user_messages_count: rkReported.userMessages.length,
        database: {
          mysql: mysqlPublicStatus(),
        },
        backend: buildBackendStatus(req),
        esp32: buildEsp32Status(),
        wifi_car: wifiCarBridge.getStatus(),
      });
      return;
    }
    const fps = apiState.captureRunning ? 22 + Math.random() * 8 : 0;
    const capMs = apiState.captureRunning ? 10 + Math.random() * 16 : 0;
    const inferMs = apiState.captureRunning ? 12 + Math.random() * 18 : 0;
    sendJson(res, 200, {
      device: "RK3568",
      driver: "ok",
      rk_online: false,
      rk_realtime_vision: null,
      rk_peer_ip: null,
      rk_last_seen_at_ms: null,
      rk_last_seen_age_ms: null,
      rk_online_timeout_ms: RK_ONLINE_TIMEOUT_MS,
      capture_running: apiState.captureRunning,
      infer_mode: apiState.inferMode,
      view: apiState.view,
      fps: Number(fps.toFixed(1)),
      capture_ms: Math.round(capMs),
      infer_ms: Math.round(inferMs),
      time_bj: nowBjText(),
      user_message_config: {
        schema: rkUserMessageConfig.schema,
        version: rkUserMessageConfig.version,
        updated_at: rkUserMessageConfig.updated_at,
      },
      user_message_config_sync: {
        enabled: true,
        mode: "cloud_pull",
        path: "/api/rk/user-message/config",
        syncing: rkReported.userMessageConfigSyncing,
        last_result: rkReported.userMessageConfigSyncResult,
        last_pull: rkReported.userMessageConfigPull,
      },
      last_user_message: rkReported.userMessages[0] || null,
      user_messages_count: rkReported.userMessages.length,
      database: {
        mysql: mysqlPublicStatus(),
      },
      backend: buildBackendStatus(req),
      esp32: buildEsp32Status(),
      wifi_car: wifiCarBridge.getStatus(),
    });
    return;
  }

  if ((pathname === "/api/device-info" || pathname === "/api/terminal/device-info") && req.method === "GET") {
    sendJson(res, 200, buildTerminalDeviceInfo(req));
    return;
  }

  if (pathname === "/api/rk/capture-metrics/history" && req.method === "GET") {
    const limit = clamp(parseInt(u.searchParams.get("limit") ?? "60", 10) || 60, 2, 240);
    const fetchLimit = Math.min(500, Math.max(limit * 2, limit));
    const memoryItems = rkReported.captureMetrics
      .filter((item) => String(item?.input_mode || "").trim().toLowerCase() === "pcie")
      .slice(0, fetchLimit);
    const dbItems = (await mysqlListRkCaptureMetrics(fetchLimit)) || [];
    const items = mergeRkCaptureMetricsItems([memoryItems, dbItems], limit);
    sendJson(res, 200, {
      ok: true,
      items,
      latest: items.length ? items[items.length - 1] : null,
      count: items.length,
      limit,
      generated_at: nowBjText(),
      source: [memoryItems.length ? "memory" : "", dbItems.length ? "mysql" : ""].filter(Boolean).join("+") || "empty",
      metric_basis: "complete_frame_delivery",
    });
    return;
  }

  if (pathname === "/api/plates/confidence-trend" && req.method === "GET") {
    const limit = clamp(parseInt(u.searchParams.get("limit") ?? "60", 10) || 60, 2, 240);
    const fetchLimit = Math.min(500, Math.max(limit * 3, limit));
    const memoryItems = rkReported.plates.slice(0, fetchLimit);
    const dbItems = (await mysqlListPlateConfidenceItems(fetchLimit)) || [];
    const sources = [memoryItems, dbItems];
    let items = mergePlateConfidenceItems(sources, limit);
    let auditUsed = false;
    if (items.length < limit) {
      sources.push(latestPlatesFromAudit().slice(0, fetchLimit));
      items = mergePlateConfidenceItems(sources, limit);
      auditUsed = true;
    }
    sendJson(res, 200, {
      ok: true,
      items,
      count: items.length,
      limit,
      generated_at: nowBjText(),
      source: [memoryItems.length ? "memory" : "", dbItems.length ? "mysql" : "", auditUsed ? "audit" : ""].filter(Boolean).join("+") || "empty",
    });
    return;
  }

  if (pathname === "/api/plates" && req.method === "GET") {
    const limit = clamp(parseInt(u.searchParams.get("limit") ?? "20", 10), 1, 200);
    const offset = clamp(parseInt(u.searchParams.get("offset") ?? "0", 10) || 0, 0, 1000000);
    const filters = plateCaptureFiltersFromParams(u.searchParams);
    if (filters.invalid_time_range) {
      sendJson(res, 400, { ok: false, error: "bad_time_range", message: "start datetime must not be later than end datetime" });
      return;
    }
    if (hasPlateCaptureFilters(filters)) {
      const history = await collectPlateCaptureHistory(Math.max(RK_PLATES_MAX, 5000));
      const filtered = filterPlateCaptureItems(history, filters);
      const items = filtered
        .slice(offset, offset + limit)
        .map(dbPlateItem)
        .filter(Boolean);
      sendJson(res, 200, {
        items,
        total: filtered.length,
        offset,
        limit,
        has_more: offset + items.length < filtered.length,
        source: "filtered_history",
        filters: { ...filters, invalid_time_range: undefined },
      });
      return;
    }
    const historyLimit = Math.min(20000, Math.max(RK_PLATES_MAX, offset + limit));
    const history = await collectPlateCaptureHistory(historyLimit);
    if (history.length || !DEMO_PLATES) {
      const total = history.length;
      const items = history
        .slice(offset, offset + limit)
        .map(dbPlateItem)
        .filter(Boolean);
      const source = captureHistorySource({
        memoryItems: rkReported.plates,
        memoryFromLog: rkReported.platesHydratedFromLog,
        auditItems: latestPlatesFromAudit(),
      });
      sendJson(res, 200, { items, total, offset, limit, has_more: offset + items.length < total, source });
      return;
    }
    const items = [];
    const pool = ["粤B12345", "京A88888", "沪C55667", "浙A19999", "川A22334", "粤B88990", "京A13579"];
    for (let i = 0; i < limit; i += 1) {
      const plate = pool[Math.floor(Math.random() * pool.length)];
      items.push({
        time_bj: nowBjText(),
        source: `src${(i % 4) + 1}`,
        plate,
        color: ["蓝", "黄", "绿", "白"][i % 4],
        conf: Number((0.85 + Math.random() * 0.14).toFixed(2)),
        det_conf_pct: Number((85 + Math.random() * 14).toFixed(1)),
        rec_conf_pct: Number((85 + Math.random() * 14).toFixed(1)),
      });
    }
    sendJson(res, 200, { items, total: items.length, offset: 0, limit, has_more: false, demo: true });
    return;
  }

  if (pathname === "/api/plates/export" && req.method === "GET") {
    const format = String(u.searchParams.get("format") || "csv").trim().toLowerCase();
    const includeImages = String(u.searchParams.get("include_images") || "0").trim() === "1";
    const filters = plateCaptureFiltersFromParams(u.searchParams);
    if (filters.invalid_time_range) {
      sendJson(res, 400, { ok: false, error: "bad_time_range", message: "start datetime must not be later than end datetime" });
      return;
    }
    let items;
    if (hasPlateCaptureFilters(filters)) {
      items = filterPlateCaptureItems(await collectPlateCaptureHistory(Math.max(RK_PLATES_MAX, 5000)), filters);
    } else {
      items = await collectPlateCaptureHistory(Math.max(RK_PLATES_MAX, 5000));
    }
    const rows = (items || []).map((it) => ({
      id: String(it?.id || ""),
      device: String(it?.device || ""),
      role: String(it?.role || ""),
      rk_device_id: String(it?.rk_device_id || ""),
      event_id: String(it?.event_id || ""),
      report_id: String(it?.report_id || ""),
      report_schema: String(it?.report_schema || ""),
      report_type: String(it?.report_type || ""),
      delivery_semantics: String(it?.delivery_semantics || ""),
      report_created_at: String(it?.report_created_at || ""),
      report_created_at_ms: it?.report_created_at_ms ?? null,
      report_attempt: it?.report_attempt ?? null,
      event_schema: String(it?.event_schema || ""),
      time_bj: String(it?.time_bj || ""),
      source: String(it?.source || ""),
      source_index: it?.source_index ?? null,
      plate: String(it?.plate || ""),
      plate_normalized: String(it?.plate_normalized || ""),
      color: String(it?.color || ""),
      vehicle_type: String(it?.vehicle_type || ""),
      vehicle_type_code: String(it?.vehicle_type_code || ""),
      plate_category: String(it?.plate_category || ""),
      plate_category_code: String(it?.plate_category_code || ""),
      plate_category_rule: String(it?.plate_category_rule || ""),
      plate_category_rule_version: String(it?.plate_category_rule_version || ""),
      input_mode: String(it?.input_mode || ""),
      sd_source_path: String(it?.sd_source_path || ""),
      detector_model_name: String(it?.detector_model_name || ""),
      detector_profile: String(it?.detector_profile || ""),
      detector_profile_id: it?.detector_profile_id ?? null,
      detector_family: String(it?.detector_family || ""),
      detector_output_contract: String(it?.detector_output_contract || ""),
      detector_runtime_backend: String(it?.detector_runtime_backend || ""),
      recognizer_model_name: String(it?.recognizer_model_name || ""),
      recognizer_profile: String(it?.recognizer_profile || ""),
      recognizer_profile_id: it?.recognizer_profile_id ?? null,
      recognizer_output_contract: String(it?.recognizer_output_contract || ""),
      recognizer_input_width: it?.recognizer_input_width ?? null,
      recognizer_input_height: it?.recognizer_input_height ?? null,
      recognizer_input_format: String(it?.recognizer_input_format || ""),
      recognizer_text_layout: String(it?.recognizer_text_layout || ""),
      recognizer_runtime_backend: String(it?.recognizer_runtime_backend || ""),
      model_input_width: it?.model_input_width ?? null,
      model_input_height: it?.model_input_height ?? null,
      model_input_format: String(it?.model_input_format || ""),
      inference_strategy: String(it?.inference_strategy || ""),
      inference_task_count: it?.inference_task_count ?? null,
      inference_pipeline_active: it?.inference_pipeline_active ?? null,
      inference_capture_async: it?.inference_capture_async ?? null,
      inference_latest_only: it?.inference_latest_only ?? null,
      inference_queue_depth: it?.inference_queue_depth ?? null,
      inference_dropped_tasks: it?.inference_dropped_tasks ?? null,
      inference_result_age_ms: it?.inference_result_age_ms ?? null,
      display_fps: it?.display_fps ?? null,
      inference_pre_ms: it?.inference_pre_ms ?? null,
      inference_npu_ms: it?.inference_npu_ms ?? null,
      inference_post_ms: it?.inference_post_ms ?? null,
      source_frame_width: it?.source_frame_width ?? null,
      source_frame_height: it?.source_frame_height ?? null,
      source_frame_format: String(it?.source_frame_format || ""),
      source_layout: String(it?.source_layout || ""),
      source_mask: it?.source_mask ?? null,
      pcie_sliding_enabled: it?.pcie_sliding_enabled ?? null,
      conf: it?.conf ?? null,
      det_conf: it?.det_conf ?? null,
      rec_conf: it?.rec_conf ?? null,
      det_conf_pct: it?.det_conf_pct ?? null,
      rec_conf_pct: it?.rec_conf_pct ?? null,
      target_device_id: String(it?.target_device_id || ""),
      target_mac: String(it?.target_mac || ""),
      image_url: String(it?.image_url || ""),
      image_path: String(it?.image_path || ""),
      thumb_url: String(it?.thumb_url || ""),
      thumb_path: String(it?.thumb_path || ""),
    }));
    const headers = [
      "id",
      "device",
      "role",
      "rk_device_id",
      "event_id",
      "report_id",
      "report_schema",
      "report_type",
      "delivery_semantics",
      "report_created_at",
      "report_created_at_ms",
      "report_attempt",
      "event_schema",
      "time_bj",
      "source",
      "source_index",
      "input_mode",
      "sd_source_path",
      "plate",
      "plate_normalized",
      "color",
      "vehicle_type",
      "vehicle_type_code",
      "plate_category",
      "plate_category_code",
      "plate_category_rule",
      "plate_category_rule_version",
      "detector_model_name",
      "detector_profile",
      "detector_profile_id",
      "detector_family",
      "detector_output_contract",
      "detector_runtime_backend",
      "recognizer_model_name",
      "recognizer_profile",
      "recognizer_profile_id",
      "recognizer_output_contract",
      "recognizer_input_width",
      "recognizer_input_height",
      "recognizer_input_format",
      "recognizer_text_layout",
      "recognizer_runtime_backend",
      "model_input_width",
      "model_input_height",
      "model_input_format",
      "inference_strategy",
      "inference_task_count",
      "inference_pipeline_active",
      "inference_capture_async",
      "inference_latest_only",
      "inference_queue_depth",
      "inference_dropped_tasks",
      "inference_result_age_ms",
      "display_fps",
      "inference_pre_ms",
      "inference_npu_ms",
      "inference_post_ms",
      "source_frame_width",
      "source_frame_height",
      "source_frame_format",
      "source_layout",
      "source_mask",
      "pcie_sliding_enabled",
      "conf",
      "det_conf",
      "rec_conf",
      "det_conf_pct",
      "rec_conf_pct",
      "target_device_id",
      "target_mac",
      "image_url",
      "image_path",
      "thumb_url",
      "thumb_path",
    ];
    if (!includeImages) {
      if (format === "jsonl") {
        const text = toJsonl(rows);
        send(res, 200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Disposition": `attachment; filename="plates.jsonl"` }, text);
        return;
      }
      const csv = toCsv(rows, headers);
      send(res, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="plates.csv"` }, csv);
      return;
    }
    const expId = randomUUID();
    const csv = toCsv(rows, headers);
    const files = [{ name: "plates.csv", data: Buffer.from(csv, "utf8") }];
    for (const it of items || []) {
      const id = String(it?.id || "");
      const ip = it?.image_path;
      const tp = it?.thumb_path;
      if (id && ip) {
        const buf = readJpegFile(ip);
        if (buf) files.push({ name: `images/${sanitizeFileName(id)}.jpg`, data: buf });
      }
      if (id && tp) {
        const buf = readJpegFile(tp);
        if (buf) files.push({ name: `images/${sanitizeFileName(id)}_thumb.jpg`, data: buf });
      }
    }
    sendTarGz(res, `plates_${expId}`, files);
    return;
  }

  if (pathname === "/api/preview.jpg" && req.method === "GET") {
    sendJson(res, 410, { ok: false, error: "media_receive_disabled", message: "Video and image reception is disabled; use RK text reports." });
    return;
  }

  // Read-only JSON proxy for the RK3568 snapshot API.  The snapshot keeps
  // the JPEG and detections in one response, so the browser never has to
  // match a stale detection report to a newer frame.
  if (pathname === "/api/adas/snapshot" && req.method === "GET") {
    sendJson(res, 410, { ok: false, error: "media_receive_disabled", message: "Snapshot reception is disabled; RK detection metadata remains available through /api/detections/latest." });
    return;
    /* istanbul ignore next: compatibility path kept unreachable for older clients. */
    const sourceText = String(u.searchParams.get("source") || "0").trim();
    const source = Number(sourceText);
    if (!Number.isInteger(source) || source < 0 || source > 4) {
      sendJson(res, 400, { ok: false, error: "invalid_source", message: "source must be 0, 1, 2, 3 or 4" });
      return;
    }
    const useRelay = String(u.searchParams.get("target") || "").trim().toLowerCase() === "relay";
    const token = useRelay ? String(process.env.RELAY_VIEWER_TOKEN || "").trim() : "";
    if (useRelay && !token) {
      sendJson(res, 503, { ok: false, error: "relay_token_missing", message: "Set RELAY_VIEWER_TOKEN in the backend process environment" });
      return;
    }
    const rk = useRelay ? null : (u.searchParams.has("host") || u.searchParams.has("ip") || u.searchParams.has("port")
      ? rkBaseUrlFromQuery(u) : rkForwardTarget());
    const relayBase = useRelay ? String(process.env.RELAY_BASE_URL || "https://47.113.231.233").trim().replace(/\/+$/, "") : "";
    const target = useRelay
      ? `${relayBase}/api/adas/snapshot?source=${source}&ts=${Date.now()}`
      : `${rk.base}/api/adas/snapshot?source=${source}&ts=${Date.now()}`;
    const forwarded = await httpGetJson(target, useRelay ? 8000 : 3500, useRelay ? { "X-Viewer-Token": token } : {});
    const payload = forwarded?.json;
    if (!forwarded.ok || !payload || payload.ok !== true || typeof payload.image_base64 !== "string" || !payload.image_base64.trim()) {
      sendJson(res, 503, {
        ok: false,
        error: useRelay ? "relay_snapshot_unavailable" : "rk_snapshot_unavailable",
        ...(useRelay ? { relay_base: relayBase, relay_status: forwarded?.status || 0 } : { rk_base: rk.base, rk_status: forwarded?.status || 0 }),
        message: forwarded?.text ? String(forwarded.text).slice(0, 300) : "RK snapshot API unavailable",
      });
      return;
    }
    const detections = Array.isArray(payload.detections) ? payload.detections.slice(0, 500) : [];
    sendJson(res, 200, {
      ...payload,
      ok: true,
      source,
      detections,
      ...(useRelay ? { source_backend: "relay", relay_base: relayBase } : { rk_base: rk.base }),
      received_at_ms: Date.now(),
    });
    return;
  }

  // Proxy the board's live 2x2 mosaic/tile API through the PC backend.  The
  // browser should use this endpoint instead of talking to the RK TCP server
  // directly, which keeps the board address and CORS policy on the backend.
  if (pathname === "/api/adas/frame" && req.method === "GET") {
    sendJson(res, 410, { ok: false, error: "media_receive_disabled", message: "Frame reception is disabled; RK detection metadata remains available through /api/detections/latest." });
    return;
    /* istanbul ignore next: compatibility path kept unreachable for older clients. */
    const sourceText = String(u.searchParams.get("source") || "").trim();
    if (sourceText) {
      const source = Number(sourceText);
      if (!Number.isInteger(source) || source < 0 || source > 4) {
        sendJson(res, 400, { ok: false, error: "invalid_source", message: "source must be 0, 1, 2, 3 or 4" });
        return;
      }
    }
    const rk = rkForwardTarget();
    const target = `${rk.base}/api/adas/frame${u.search || ""}`;
    const forwarded = await httpGetBuffer(target, 2200);
    if (!forwarded.ok || !forwarded.buffer || forwarded.buffer.length < 10) {
      sendJson(res, 503, {
        ok: false,
        error: "rk_frame_unavailable",
        rk_base: rk.base,
        rk_status: forwarded.status || 0,
        message: forwarded.text ? forwarded.text.slice(0, 300) : "RK frame API unavailable",
      });
      return;
    }
    const headers = {
      "Content-Type": String(forwarded.headers["content-type"] || "image/jpeg"),
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      "Content-Length": String(forwarded.buffer.length),
      "X-RK-Frame-Sequence": String(forwarded.headers["x-rk-frame_sequence"] || ""),
      "X-RK-Captured-At": String(forwarded.headers["x-rk-captured_at"] || ""),
      "X-RK-Source": String(forwarded.headers["x-rk-source"] || ""),
    };
    send(res, 200, headers, forwarded.buffer);
    return;
  }

  // Latest generic YOLO reports are deliberately kept in memory.  They are
  // telemetry for the live dashboard, not a historical detection archive.
  if (pathname === "/api/rk/realtime/vision" && req.method === "POST") {
    const suppliedVisionToken = Buffer.from(String(req.headers["x-rk-vision-token"] || ""));
    if (!rkVisionToken.length || suppliedVisionToken.length !== rkVisionToken.length ||
        !timingSafeEqual(suppliedVisionToken, rkVisionToken)) {
      sendJson(res, 401, { ok: false, error: "invalid_rk_vision_token" });
      return;
    }
    const raw = await readBody(req, 900_000);
    const body = safeJsonParse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: "bad_json", message: "A JSON object is required" });
      return;
    }
    const control = resolveRkVisionCommand(body);
    const { mode, forbidden, slow, alarm, inferredDirection, selectedDirection,
      arrowState, action, commandKey } = control;
    const detections = Array.isArray(body.detections) ? body.detections.slice(0, 500) : [];
    const cleanDetections = detections.filter((d) => d && Number.isInteger(Number(d.source)) &&
      Number(d.source) >= 1 && Number(d.source) <= 4 && Number.isFinite(Number(d.confidence)) &&
      Number.isFinite(Number(d.left)) && Number.isFinite(Number(d.top)) &&
      Number.isFinite(Number(d.right)) && Number.isFinite(Number(d.bottom)))
      .map((d) => ({
        source: Math.round(Number(d.source)),
        class_id: Number.isInteger(Number(d.class_id)) ? Number(d.class_id) : -1,
        class_name: String(d.class_name || "").slice(0, 120),
        confidence: Math.max(0, Math.min(1, Number(d.confidence))),
        left: Number(d.left), top: Number(d.top), right: Number(d.right), bottom: Number(d.bottom),
      }));
    const frameSequence = Number.isSafeInteger(Number(body.frame_sequence))
      ? Number(body.frame_sequence) : 0;
    communicationLog.append({ channel: "rk_rx", direction: "rx", transport: "HTTPS", status: "received", payload: raw,
      endpoint: pathname, frame_sequence: frameSequence,
      summary: `RK 原始推理上报 · ${mode} · 帧 ${frameSequence} · 目标 ${cleanDetections.length} · 箭头 ${arrowState} · 动作 ${action || "保持"}` });
    const perCamera = (Array.isArray(body.per_camera) ? body.per_camera : [])
      .filter((item) => item && Number.isInteger(Number(item.source)) &&
        Number(item.source) >= 1 && Number(item.source) <= 4)
      .slice(0, 4)
      .map((item) => ({
        source: Number(item.source),
        camera: String(item.camera || "").slice(0, 24),
        inference_ms: Number.isFinite(Number(item.inference_ms)) ? Number(item.inference_ms) : null,
        detection_count: Number.isFinite(Number(item.detection_count))
          ? Math.max(0, Math.floor(Number(item.detection_count))) : 0,
      }));
    const receivedAt = Date.now();
    rkCommandLoop.accept(control, {frameSequence, mode});
    const command = rkCommandLoop.command;
    const activeAction = rkCommandLoop.desired?.action || "stop";

    const stored = {
      schema: "rk3568.realtime.vision.v1",
      device: String(body.device || "rk3568").slice(0, 80),
      time_bj: String(body.time_bj || nowBjText()).slice(0, 32),
      received_at_ms: receivedAt,
      mode,
      mode_id: Number.isInteger(Number(body.mode_id)) ? Number(body.mode_id) : 0,
      inference_enabled: body.inference_enabled !== false && mode !== "off",
      frame_sequence: frameSequence,
      selected_direction: Number.isInteger(Number(body.selected_direction)) ? Number(body.selected_direction) : -1,
      selected_direction_name: String(body.selected_direction_name || "未选择").slice(0, 40),
      inferred_direction: Number.isInteger(inferredDirection) ? inferredDirection : -1,
      inferred_direction_name: String(body.inferred_direction_name || "未选择").slice(0, 40),
      arrow_state: arrowState,
      action_allowed: arrowState === "green",
      forbidden, slow, alarm,
      alarm_reason: alarm ? (body.alarm_reason === "red_light" || body.alarm === true ? "red_light" : "direction_forbidden") : "",
      red_light: control.redSignal,
      command_held: rkCommandLoop.held,
      safety_state: activeAction === "alarm" ? "alarm" : activeAction === "stop" ? "stopped" : "allowed",
      decision_text: String(body.decision_text || "").slice(0, 300),
      inference_ms: Number.isFinite(Number(body.inference_ms)) ? Number(body.inference_ms) : null,
      inference_fps: Number.isFinite(Number(body.inference_fps)) ? Number(body.inference_fps) : null,
      completed_cycles: Number.isFinite(Number(body.completed_cycles)) ? Number(body.completed_cycles) : null,
      per_camera: perCamera,
      camera_order: Array.isArray(body.camera_order) ? body.camera_order.slice(0, 4) : ["front", "rear", "left", "right"],
      detections: cleanDetections,
      esp32_action: activeAction,
      esp32_command: rkReported.realtimeVisionCommand,
    };
    rkReported.realtimeVision = stored;
    rkReported.realtimeVisionAtMs = receivedAt;
    appendDurableJsonLine(path.join(logRoot, "rk_vision_realtime.jsonl"), stored);
    console.info(`[RK_VISION] mode=${mode} frame=${frameSequence} boxes=${cleanDetections.length} action=${action || "none"} alarm=${alarm ? 1 : 0} decision=${stored.decision_text}`);
    sendJson(res, 200, { ok: true, frame_sequence: frameSequence, detections: cleanDetections.length,
      alarm, action: activeAction, command, latest: stored, command_loop: rkCommandLoop.getStatus() });
    return;
  }

  if (pathname === "/api/rk/realtime/vision/latest" && req.method === "GET") {
    sendJson(res, rkReported.realtimeVision ? 200 : 404, rkReported.realtimeVision
      ? { ok: true, ...rkReported.realtimeVision, command_loop: rkCommandLoop.getStatus(), age_ms: Math.max(0, Date.now() - rkReported.realtimeVisionAtMs) }
      : { ok: false, error: "vision_not_ready" });
    return;
  }

  if (pathname === "/api/rk/report/detections" && req.method === "POST") {
    const supplied = Buffer.from(String(req.headers["x-device-token"] || ""));
    if (!rkDetectionToken.length || supplied.length !== rkDetectionToken.length ||
        !timingSafeEqual(supplied, rkDetectionToken)) {
      sendJson(res, 401, { ok: false, error: "invalid_device_token" });
      return;
    }
    const raw = await readBody(req, 500_000);
    const body = safeJsonParse(raw);
    let reports;
    try { reports = normalizeDetectionReport(body); }
    catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
      return;
    }
    Object.assign(rkReported.detectionsBySource, reports);
    communicationLog.append({ channel: "rk_rx", direction: "rx", transport: "HTTPS", status: "received", payload: raw,
      endpoint: pathname, frame_sequence: body.frame_sequence ?? null,
      summary: `RK 检测上报 · 通道 ${body.source} · 帧 ${body.frame_sequence} · 目标 ${body.detections.length}` });
    sendJson(res, 200, { ok: true, source: body.source, frame_sequence: body.frame_sequence,
      count: body.detections.length });
    return;
  }

  if (pathname === "/api/detections/latest" && req.method === "GET") {
    const sourceText = String(u.searchParams.get("source") || "").trim();
    if (sourceText) {
      const source = Number(sourceText);
      const item = Number.isInteger(source) && source >= 0 && source <= 4
        ? rkReported.detectionsBySource[String(source)] || null : null;
      sendJson(res, item ? 200 : 404, item ? { ok: true, ...withFreshness(item) } : { ok: false, error: "source_not_found" });
      return;
    }
    sendJson(res, 200, { ok: true, sources: Object.fromEntries(Object.entries(rkReported.detectionsBySource)
      .map(([key, item]) => [key, withFreshness(item)])) });
    return;
  }

  if (pathname === "/api/behavior-logs" && req.method === "GET") {
    const category = String(u.searchParams.get("category") || "all");
    const allowedCategories = new Set(["turn", "lane_change", "violation_warning"]);
    if (category !== "all" && !allowedCategories.has(category)) {
      sendJson(res, 400, { ok: false, error: "bad_category" });
      return;
    }
    const limit = Math.max(1, Math.min(5000, Math.floor(Number(u.searchParams.get("limit")) || 10)));
    const offset = Math.max(0, Math.min(1_000_000, Math.floor(Number(u.searchParams.get("offset")) || 0)));
    const rows = readJsonlAll(path.join(logRoot, "adas_behavior_logs.jsonl"), 250_000_000)
      .filter((item) => category === "all" || item.category === category)
      .reverse();
    sendJson(res, 200, { ok: true, total: rows.length, items: rows.slice(offset, offset + limit) });
    return;
  }

  const behaviorImageMatch = pathname.match(/^\/api\/behavior-logs\/([0-9a-f-]{36})\/image$/i);
  if (behaviorImageMatch && req.method === "GET") {
    const imagePath = path.join(adasBehaviorImageDir, `${behaviorImageMatch[1]}.jpg`);
    try {
      const image = fs.readFileSync(imagePath);
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": String(image.length),
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(image);
    } catch {
      sendJson(res, 404, { ok: false, error: "evidence_not_found" });
    }
    return;
  }

  if (pathname === "/api/rk/report/status" && req.method === "POST") {
    const raw = await readBody(req);
    const body = safeJsonParse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: "bad_json", message: "A JSON object is required" });
      return;
    }
    const reportIdentity = normalizeRkReportIdentity(req, body, "status");
    if (reportIdentity.error) {
      sendJson(res, 400, { ok: false, error: reportIdentity.error, message: reportIdentity.message });
      return;
    }
    trackRkPeerOnSuccess(req, res, reportIdentity);
    const reportEnvelope = normalizeRkReportEnvelope(req, body, reportIdentity, "status");
    const reportClaim = claimRkReportReceipt(reportIdentity, { time_bj: cleanUserTemplate(body?.time_bj || nowBjText(), 32) });
    if (sendRkReportClaimResult(res, reportIdentity, reportClaim)) return;
    if (reportClaim.state === "resume") {
      const stored = findStoredRkStatusRecord(reportIdentity);
      if (!stored) {
        const reset = resetRkReportReceiptForRetry(reportIdentity, "status_recovery_missing");
        sendJson(res, 503, {
          ok: false,
          error: "status_recovery_missing",
          recovery_reset: reset,
          retryable: reset,
          message: reset
            ? "The durable status record was unavailable; retry with the same event_id to start a fresh delivery"
            : "Receipt exists but the durable status snapshot is unavailable",
        });
        return;
      }
      const currentMemoryRecord = rkReported.status && typeof rkReported.status === "object"
        ? { status: rkReported.status, saved_at_ms: Number(rkReported.statusAtMs || 0) }
        : null;
      const latestPersisted = persistRkStatusLatestRecord(stored, currentMemoryRecord);
      if (!latestPersisted.ok) {
        sendJson(res, 503, {
          ok: false,
          error: "status_recovery_persist_failed",
          message: "The recovered status could not be made durable; retry with the same event_id",
        });
        return;
      }
      const shouldRestoreAsLatest = !currentMemoryRecord || compareRkStatusRecords(stored, currentMemoryRecord) > 0;
      if (shouldRestoreAsLatest) {
        rkReported.status = stored.status;
        rkReported.statusAtMs = Number.isFinite(Number(stored.saved_at_ms)) ? Math.max(0, Math.floor(Number(stored.saved_at_ms))) : Date.now();
        apiState.captureRunning = stored.status.capture_running === true;
        apiState.inferMode = String(stored.status.infer_mode || apiState.inferMode);
        apiState.view = String(stored.status.view || apiState.view);
      }
      // These operations are idempotent by event/sample ID. Replaying them
      // before completing the receipt closes the crash window between status
      // persistence and the derived metrics/config work.
      await applyRkStatusSideEffects(stored.status, stored.saved_at_ms, { syncConfig: shouldRestoreAsLatest });
      const receiptPersisted = completeRkReportReceipt(reportIdentity, { time_bj: stored.status.time_bj || nowBjText() });
      sendJson(res, receiptPersisted ? 200 : 503, receiptPersisted
        ? { ok: true, ...rkReportAckFields(reportIdentity, true) }
        : { ok: false, error: "receipt_complete_failed", message: "Status was restored; retry with the same event_id" });
      return;
    }
    const statusPayloadProblem = validateRkStatusPayload(body);
    if (statusPayloadProblem) {
      recordRkReportRejection(req, reportIdentity, statusPayloadProblem);
      releaseRkReportReservation(reportIdentity);
      sendJson(res, 400, { ok: false, ...statusPayloadProblem });
      return;
    }
    const timeBj = typeof body?.time_bj === "string" ? cleanUserTemplate(body.time_bj, 32) || nowBjText() : nowBjText();
    const captureRunningRaw = typeof body?.capture_running === "boolean" ? body.capture_running : null;
    const inferMode = String(body?.infer_mode || apiState.inferMode);
    const view = String(body?.view || apiState.view);
    const fps = body?.fps == null ? null : Number(body.fps);
    const capMs = body?.capture_ms == null ? null : Number(body.capture_ms);
    const inferMs = body?.infer_ms == null ? null : Number(body.infer_ms);
    const perfCapMs = body?.perf_cap_ms == null ? null : Number(body.perf_cap_ms);
    const perfConvMs = body?.perf_conv_ms == null ? null : Number(body.perf_conv_ms);
    const perfViewMs = body?.perf_view_ms == null ? null : Number(body.perf_view_ms);
    const perfDetMs = body?.perf_det_ms == null ? null : Number(body.perf_det_ms);
    const perfOcrMs = body?.perf_ocr_ms == null ? null : Number(body.perf_ocr_ms);
    const perfEnvMs = body?.perf_env_ms == null ? null : Number(body.perf_env_ms);
    const perfInferMs = body?.perf_infer_ms == null ? null : Number(body.perf_infer_ms);
    const perfUiMs = body?.perf_ui_ms == null ? null : Number(body.perf_ui_ms);
    const perfDispMs = body?.perf_disp_ms == null ? null : Number(body.perf_disp_ms);
    const perfTotalMs = body?.perf_total_ms == null ? null : Number(body.perf_total_ms);
    const device = reportEnvelope.device;
    const roleRaw = String(body?.role || "").trim().toLowerCase();
    const role = ["user", "admin", "developer"].includes(roleRaw) ? roleRaw : null;
    const userStateRaw = String(body?.user_state || roleRaw || "").trim().toLowerCase();
    const userState = ["normal", "user", "admin", "developer"].includes(userStateRaw) ? userStateRaw : null;
    const uiModeRaw = String(body?.ui_mode || "").trim().toLowerCase();
    const uiMode = ["user", "admin", "developer"].includes(uiModeRaw) ? uiModeRaw : null;
    const accountModeRaw = String(body?.account_mode || "").trim().toLowerCase();
    const accountMode = ["user", "admin", "developer"].includes(accountModeRaw) ? accountModeRaw : null;
    const bizSystem = body?.biz_system === "adas" ? "adas" : normalizeBusinessSystem(body?.biz_system);
    const adasStatus = normalizeRkAdasStatus(body, bizSystem);
    const userMessageConfigRaw = body?.user_message_config && typeof body.user_message_config === "object" ? body.user_message_config : null;
    const userMessageConfigMeta = userMessageConfigRaw
      ? {
          schema: cleanUserTemplate(userMessageConfigRaw.schema || "rk3568.user_message_config.v1", 120),
          version: Number.isFinite(Number(userMessageConfigRaw.version)) ? Math.floor(Number(userMessageConfigRaw.version)) : null,
          updated_at: cleanUserTemplate(userMessageConfigRaw.updated_at, 80),
        }
      : null;
    const userMessageSyncMeta = normalizeRkUserMessageConfigSync(body?.user_message_config_sync);
    const autoExposureEnabled = typeof body?.auto_exposure_enabled === "boolean" ? body.auto_exposure_enabled : null;
    const autoExposureLevel = Number.isFinite(Number(body?.auto_exposure_level)) ? Math.max(0, Math.min(100, Math.floor(Number(body.auto_exposure_level)))) : null;
    const inputModeRaw = String(body?.input_mode || "").trim().toLowerCase();
    const inputMode = inputModeRaw === "pcie" || inputModeRaw === "sdcard" ? inputModeRaw : null;
    const captureMetricsInfo = extractDriverCaptureMetrics(body);
    const reportedCaptureMetrics = captureMetricsInfo.metrics;
    const pcieMetricsActive = inputMode === "pcie"
      || (inputMode === null && (reportedCaptureMetrics?.mode === "pcie" || reportedCaptureMetrics?.pcie === true));
    const captureMetrics = pcieMetricsActive ? reportedCaptureMetrics : null;
    const captureRunning = captureRunningRaw !== null ? captureRunningRaw : captureMetrics?.running === true;
    const driverStatus = normalizeDriverStatus(body?.driver_status, captureMetrics);
    if (!pcieMetricsActive && driverStatus) {
      delete driverStatus.capture_metrics;
      if (driverStatus.pcie) delete driverStatus.pcie.capture_metrics;
    }
    const driver = String(body?.driver || (driverStatus?.mounted === true ? "mounted" : driverStatus?.mounted === false ? "not_mounted" : "ok"));
    const sdSourcePath = body?.sd_source_path == null ? null : String(body.sd_source_path);
    // driver_status is collected after the legacy top-level probes and is the
    // authoritative snapshot when a driver changes state between both reads.
    const pcieMounted = typeof driverStatus?.mounted === "boolean" ? driverStatus.mounted : typeof body?.pcie_driver_mounted === "boolean" ? body.pcie_driver_mounted : null;
    const pcieNode = body?.pcie_driver_node == null ? driverStatus?.device_node?.path ?? null : String(body.pcie_driver_node);
    const pcieModuleOk = typeof driverStatus?.module?.loaded === "boolean" ? driverStatus.module.loaded : typeof body?.pcie_driver_module_ok === "boolean" ? body.pcie_driver_module_ok : null;
    const pcieBoundOk = typeof body?.pcie_driver_bound_ok === "boolean"
      ? body.pcie_driver_bound_ok
      : Number.isFinite(Number(driverStatus?.pcie?.bound_count))
        ? Number(driverStatus.pcie.bound_count) > 0
        : null;
    const directDmaMemory = normalizeDriverDmaMemory(body?.pcie_dma_memory);
    const nestedDmaMemory = driverStatus?.dma_memory && typeof driverStatus.dma_memory === "object" ? driverStatus.dma_memory : null;
    const pcieDmaMemory = directDmaMemory || nestedDmaMemory
      ? { ...(nestedDmaMemory || {}), ...(directDmaMemory || {}) }
      : null;
    const backendBase = cleanUserTemplate(body?.backend_base, 300);
    const backendSourceRaw = cleanUserTemplate(body?.backend_source, 40);
    const backendSource = backendSourceRaw || null;
    const backendOk = typeof body?.backend_ok === "boolean" ? body.backend_ok : null;
    const backendLatency = normalizeInferenceNumber(body?.backend_latency_ms);
    const backendError = typeof body?.backend_error === "string" ? cleanUserTemplate(body.backend_error, 300) : null;
    const backendLastOkAt = cleanUserTemplate(body?.backend_last_ok_at, 80);
    const backendLastTestAt = cleanUserTemplate(body?.backend_last_test_at, 80);
    const targetDeviceId = cleanDeviceId(
      body?.target_device_id || body?.targetDeviceId || body?.runtime_settings?.target_device_id,
      "",
    );
    const perfCapBasis = typeof body?.perf_cap_basis === "string" ? cleanUserTemplate(body.perf_cap_basis, 80) : "";
    const rkApiListening = typeof body?.rk_api_listening === "boolean" ? body.rk_api_listening : null;
    const rkApiPort = normalizeInferenceNumber(body?.rk_api_port, true);
    const rkApiBind = typeof body?.rk_api_bind === "string" ? cleanUserTemplate(body.rk_api_bind, 160) : "";
    const rkApiError = typeof body?.rk_api_error === "string" ? cleanUserTemplate(body.rk_api_error, 500) : null;
    const ttsWav = normalizeRkTtsWav(body?.tts_wav);
    const runtimeSettings = normalizeRkRuntimeSettings(body);
    const runtimeSettingsPath = typeof body?.runtime_settings_path === "string"
      ? cleanUserTemplate(body.runtime_settings_path, 1024)
      : "";
    const reportDelivery = normalizeRkReportDelivery(body);
    const plateDetectorRuntime = normalizePlateDetectorRuntime(body);
    const pciePlateInference = normalizePciePlateInference(body, runtimeSettings, plateDetectorRuntime);
    const pciePlateInferenceAliases = pciePlateInferenceAliasFields(pciePlateInference);
    const plateDetectorFields = plateDetectorTopLevelFields(plateDetectorRuntime, pciePlateInference);
    const plateDetectorModelFields = normalizePlateDetectorModelFields(body, plateDetectorRuntime);

    const status = {
      ...reportEnvelope,
      driver,
      ...(role ? { role } : {}),
      ...(userState ? { user_state: userState } : {}),
      ...(uiMode ? { ui_mode: uiMode } : {}),
      ...(accountMode ? { account_mode: accountMode } : {}),
      ...(bizSystem ? { biz_system: bizSystem } : {}),
      ...(adasStatus ? { adas: adasStatus } : {}),
      user_message_config: userMessageConfigMeta || {
        schema: rkUserMessageConfig.schema,
        version: rkUserMessageConfig.version,
        updated_at: rkUserMessageConfig.updated_at,
      },
      ...(userMessageSyncMeta ? { user_message_config_sync: userMessageSyncMeta } : {}),
      ...(inputMode ? { input_mode: inputMode } : {}),
      ...(inputMode === "sdcard" && sdSourcePath ? { sd_source_path: sdSourcePath } : {}),
      ...(backendBase ? { backend_base: backendBase } : {}),
      ...(backendSource ? { backend_source: backendSource } : {}),
      ...(typeof backendOk === "boolean" ? { backend_ok: backendOk } : {}),
      ...(backendLatency !== null ? { backend_latency_ms: backendLatency } : {}),
      ...(backendError !== null ? { backend_error: backendError } : {}),
      ...(backendLastOkAt ? { backend_last_ok_at: backendLastOkAt } : {}),
      ...(backendLastTestAt ? { backend_last_test_at: backendLastTestAt } : {}),
      ...(targetDeviceId ? { target_device_id: targetDeviceId } : {}),
      ...(typeof rkApiListening === "boolean" ? { rk_api_listening: rkApiListening } : {}),
      ...(rkApiPort !== null && rkApiPort <= 65535 ? { rk_api_port: rkApiPort } : {}),
      ...(rkApiBind ? { rk_api_bind: rkApiBind } : {}),
      ...(rkApiError !== null ? { rk_api_error: rkApiError } : {}),
      ...(ttsWav ? { tts_wav: ttsWav } : {}),
      ...(typeof autoExposureEnabled === "boolean" ? { auto_exposure_enabled: autoExposureEnabled } : {}),
      ...(autoExposureLevel != null ? { auto_exposure_level: autoExposureLevel } : {}),
      ...(typeof pcieMounted === "boolean" ? { pcie_driver_mounted: pcieMounted } : {}),
      ...(pcieNode ? { pcie_driver_node: pcieNode } : {}),
      ...(typeof pcieModuleOk === "boolean" ? { pcie_driver_module_ok: pcieModuleOk } : {}),
      ...(typeof pcieBoundOk === "boolean" ? { pcie_driver_bound_ok: pcieBoundOk } : {}),
      ...(pcieDmaMemory ? { pcie_dma_memory: pcieDmaMemory } : {}),
      ...(captureMetrics ? { driver_capture_metrics: captureMetrics } : {}),
      ...(runtimeSettings ? { runtime_settings: runtimeSettings } : {}),
      ...(runtimeSettingsPath ? { runtime_settings_path: runtimeSettingsPath } : {}),
      ...(reportDelivery ? {
        report_delivery: reportDelivery,
        report_pending_count: reportDelivery.pending_count ?? null,
        report_rejected_count: reportDelivery.rejected_saved_count ?? null,
        report_last_result: reportDelivery.last_result || "",
        report_last_error: reportDelivery.last_error || "",
      } : {}),
      ...(cleanUserTemplate(body?.user_message_config_path, 1024) ? { user_message_config_path: cleanUserTemplate(body.user_message_config_path, 1024) } : {}),
      ...(pciePlateInference ? { pcie_plate_inference: pciePlateInference, ...pciePlateInferenceAliases } : {}),
      ...(plateDetectorRuntime ? { plate_detector_runtime: plateDetectorRuntime } : {}),
      ...plateDetectorFields,
      ...(plateDetectorModelFields || {}),
      capture_running: captureRunning,
      infer_mode: inferMode,
      view,
      ...(Number.isFinite(fps) ? { fps } : {}),
      ...(Number.isFinite(perfCapMs) ? { perf_cap_ms: Number(perfCapMs.toFixed(4)) } : {}),
      ...(Number.isFinite(capMs) ? { capture_ms: Number(capMs.toFixed(4)) } : Number.isFinite(perfCapMs) ? { capture_ms: Number(perfCapMs.toFixed(4)) } : {}),
      ...(perfCapBasis ? { perf_cap_basis: perfCapBasis } : {}),
      ...(Number.isFinite(perfConvMs) ? { perf_conv_ms: Number(perfConvMs.toFixed(4)) } : {}),
      ...(Number.isFinite(perfViewMs) ? { perf_view_ms: Number(perfViewMs.toFixed(4)) } : {}),
      ...(Number.isFinite(perfDetMs) ? { perf_det_ms: Number(perfDetMs.toFixed(4)) } : {}),
      ...(Number.isFinite(perfOcrMs) ? { perf_ocr_ms: Number(perfOcrMs.toFixed(4)) } : {}),
      ...(Number.isFinite(perfEnvMs) ? { perf_env_ms: Number(perfEnvMs.toFixed(4)) } : {}),
      ...(Number.isFinite(perfInferMs) ? { perf_infer_ms: Number(perfInferMs.toFixed(4)) } : {}),
      ...(Number.isFinite(inferMs) ? { infer_ms: Number(inferMs.toFixed(4)) } : Number.isFinite(perfInferMs) ? { infer_ms: Number(perfInferMs.toFixed(4)) } : {}),
      ...(Number.isFinite(perfUiMs) ? { perf_ui_ms: Number(perfUiMs.toFixed(4)) } : {}),
      ...(Number.isFinite(perfDispMs) ? { perf_disp_ms: Number(perfDispMs.toFixed(4)) } : {}),
      ...(Number.isFinite(perfTotalMs) ? { perf_total_ms: Number(perfTotalMs.toFixed(4)) } : {}),
      ...(Number.isFinite(captureMetrics?.actual_rx_fps) ? { pcie_rx_fps: captureMetrics.actual_rx_fps } : {}),
      ...(Number.isFinite(captureMetrics?.frame_interval_ms) ? { pcie_frame_interval_ms: captureMetrics.frame_interval_ms } : {}),
      ...(Number.isFinite(captureMetrics?.dma_transfer_ms) ? { pcie_dma_ms: captureMetrics.dma_transfer_ms } : {}),
      ...(Number.isFinite(captureMetrics?.dma_wait_ms) ? { pcie_dma_wait_ms: captureMetrics.dma_wait_ms } : {}),
      ...(Number.isFinite(captureMetrics?.dma_wait_avg_ms) ? { pcie_dma_wait_avg_ms: captureMetrics.dma_wait_avg_ms } : {}),
      ...(Number.isFinite(captureMetrics?.dma_wait_max_ms) ? { pcie_dma_wait_max_ms: captureMetrics.dma_wait_max_ms } : {}),
      ...(Number.isFinite(captureMetrics?.dma_wait_window_ms) ? { pcie_dma_wait_window_ms: captureMetrics.dma_wait_window_ms } : {}),
      ...(Number.isFinite(captureMetrics?.dma_wait_sample_count) ? { pcie_dma_wait_sample_count: captureMetrics.dma_wait_sample_count } : {}),
      ...(Number.isFinite(captureMetrics?.user_copy_ms) ? { pcie_user_copy_ms: captureMetrics.user_copy_ms } : {}),
      ...(Number.isFinite(captureMetrics?.complete_frames) ? { pcie_rx_frames: captureMetrics.complete_frames } : {}),
      ...(Number.isFinite(captureMetrics?.dropped_frames) ? { pcie_dropped_frames: captureMetrics.dropped_frames } : {}),
      ...(Number.isFinite(captureMetrics?.driver_features) ? { pcie_driver_features: captureMetrics.driver_features } : {}),
      ...(Number.isFinite(captureMetrics?.fpga_target_fps_milli) ? { pcie_fpga_target_fps_milli: captureMetrics.fpga_target_fps_milli } : {}),
      ...(Number.isFinite(captureMetrics?.bar0_read_bytes) ? { pcie_bar0_read_bytes: captureMetrics.bar0_read_bytes } : {}),
      ...(Number.isFinite(captureMetrics?.bar1_write_bytes) ? { pcie_bar1_write_bytes: captureMetrics.bar1_write_bytes } : {}),
      ...(typeof captureMetrics?.bar_contract_ok === "boolean" ? { pcie_bar_contract_ok: captureMetrics.bar_contract_ok } : {}),
      ...(captureMetrics?.interrupt_mode ? { pcie_interrupt_mode: captureMetrics.interrupt_mode } : {}),
      ...(Number.isFinite(captureMetrics?.source_mask) ? { pcie_source_mask: captureMetrics.source_mask } : {}),
      ...(typeof captureMetrics?.all_four_sources_valid === "boolean" ? { pcie_all_four_sources_valid: captureMetrics.all_four_sources_valid } : {}),
      ...(Number.isFinite(captureMetrics?.protocol_errors) ? { pcie_protocol_errors: captureMetrics.protocol_errors } : {}),
      ...(driverStatus ? { driver_status: driverStatus } : {}),
      time_bj: timeBj,
    };

    const statusSavedAtMs = Date.now();
    const statusPersistence = reportIdentity.event_id
      ? persistRkStatusRecord(status, statusSavedAtMs, rkReported.status && typeof rkReported.status === "object"
        ? { status: rkReported.status, saved_at_ms: Number(rkReported.statusAtMs || 0) }
        : null)
      : { ok: true, latestApplied: true, record: { status, saved_at_ms: statusSavedAtMs } };
    if (reportIdentity.event_id && !statusPersistence.ok) {
      releaseRkReportReservation(reportIdentity);
      sendJson(res, 507, { ok: false, error: "status_persist_failed", message: "Unable to durably save the RK status snapshot" });
      return;
    }
    const statusBecameLatest = statusPersistence.latestApplied || !rkReported.status;
    if (statusBecameLatest) {
      const effectiveStatusRecord = statusPersistence.latest || statusPersistence.record || { status, saved_at_ms: statusSavedAtMs };
      rkReported.status = effectiveStatusRecord.status;
      rkReported.statusAtMs = Number.isFinite(Number(effectiveStatusRecord.saved_at_ms))
        ? Math.max(0, Math.floor(Number(effectiveStatusRecord.saved_at_ms)))
        : statusSavedAtMs;
      apiState.captureRunning = effectiveStatusRecord.status.capture_running === true;
      apiState.inferMode = String(effectiveStatusRecord.status.infer_mode || apiState.inferMode);
      apiState.view = String(effectiveStatusRecord.status.view || apiState.view);
    }
    await applyRkStatusSideEffects(status, statusSavedAtMs, { syncConfig: statusBecameLatest });
    if (!persistRkReportRecordStage(reportIdentity, { time_bj: timeBj })) {
      sendJson(res, 503, { ok: false, error: "receipt_stage_failed", message: "Status was saved; retry with the same event_id" });
      return;
    }
    const receiptPersisted = completeRkReportReceipt(reportIdentity, { time_bj: timeBj });
    if (!receiptPersisted) {
      sendJson(res, 503, { ok: false, error: "receipt_complete_failed", message: "Status was applied; retry with the same event_id" });
      return;
    }
    communicationLog.append({ channel: "rk_rx", direction: "rx", transport: "HTTPS", status: "received", payload: raw,
      endpoint: pathname, summary: "RK 状态 / 字符遥测上报" });
    sendJson(res, 200, { ok: true, ...rkReportAckFields(reportIdentity, false) });
    return;
  }

  if (pathname === "/api/rk/report/plate" && req.method === "POST") {
    const raw = await readBody(req);
    const body = safeJsonParse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: "bad_json", message: "A JSON object is required" });
      return;
    }
    const reportIdentity = normalizeRkReportIdentity(req, body, "plate");
    if (reportIdentity.error) {
      sendJson(res, 400, { ok: false, error: reportIdentity.error, message: reportIdentity.message });
      return;
    }
    trackRkPeerOnSuccess(req, res, reportIdentity);
    const reportEnvelope = normalizeRkReportEnvelope(req, body, reportIdentity, "plate");
    const timeBj = cleanUserTemplate(body?.time_bj || nowBjText(), 32);
    const source = cleanUserTemplate(body?.source, 64);
    const plate = cleanUserTemplate(body?.plate, 64);
    const color = cleanUserTemplate(body?.color, 32);
    const reportedVehicleType = cleanUserTemplate(body?.vehicle_type, 64);
    const reportedVehicleTypeCode = cleanUserTemplate(body?.vehicle_type_code, 64);
    const reportedPlateCategory = cleanUserTemplate(body?.plate_category, 64);
    const reportedPlateCategoryCode = cleanUserTemplate(body?.plate_category_code, 64);
    const vehicleType = reportedVehicleType || reportedPlateCategory;
    const vehicleTypeCode = reportedVehicleTypeCode || reportedPlateCategoryCode;
    const plateCategory = reportedPlateCategory || reportedVehicleType;
    const plateCategoryCode = reportedPlateCategoryCode || reportedVehicleTypeCode;
    const statusInputMode = String(rkReported.status?.input_mode || "").trim().toLowerCase();
    const bodyInputMode = cleanUserTemplate(body?.input_mode, 24).toLowerCase();
    const inputModeCandidate = bodyInputMode || statusInputMode;
    const inputMode = inputModeCandidate === "sdcard" || inputModeCandidate === "pcie" ? inputModeCandidate : "";
    const statusSdSourcePath = inputMode === "sdcard" ? rkReported.status?.sd_source_path : "";
    const sdSourcePath = inputMode === "sdcard" ? cleanUserTemplate(body?.sd_source_path || statusSdSourcePath, 512) : "";
    const targetDeviceId = cleanDeviceId(
      body?.target_device_id || body?.targetDeviceId || rkReported.status?.target_device_id || rkReported.status?.runtime_settings?.target_device_id,
      "",
    );
    const targetMac = cleanUserTemplate(body?.target_mac || body?.targetMac, 80);
    const detConf = parseNumber(body?.det_conf);
    const recConf = parseNumber(body?.rec_conf ?? body?.conf);
    const conf = parseNumber(body?.conf ?? body?.rec_conf);
    const detConfPct = confToPercent(detConf);
    const recConfPct = confToPercent(recConf);
    const imageBase64 = stripBase64DataUri(body?.image_jpeg_base64);
    const thumbBase64 = stripBase64DataUri(body?.thumb_jpeg_base64);

    const existingReceipt = findRkReportReceipt(reportIdentity);
    if (existingReceipt) {
      if (existingReceipt.report_type !== reportIdentity.report_type) {
        sendJson(res, 409, { ok: false, error: "event_id_conflict", message: "event_id is already used by another report type" });
        return;
      }
      if (existingReceipt.state === "record_persisted") {
        const persistedItem = [...rkReported.plates, ...latestPlatesFromAudit()]
          .find((item) => String(item?.event_id || item?.report_id || "") === reportIdentity.event_id
            && String(item?.rk_device_id || "rk3568") === reportIdentity.rk_device_id);
        if (!persistedItem) {
          sendJson(res, 503, { ok: false, error: "plate_recovery_record_missing", message: "Receipt exists but the durable plate record is unavailable" });
          return;
        }
        const recoveredBlacklistHit = miniMarkBlacklistHit(persistedItem.plate, {
          event_id: reportIdentity.event_id,
          source: persistedItem.source,
          id: persistedItem.id,
          target_device_id: persistedItem.target_device_id,
          target_mac: persistedItem.target_mac,
          image_url: persistedItem.image_url || "",
          thumb_url: persistedItem.thumb_url || "",
        });
        const recoveredGate = recoveredBlacklistHit
          ? { ok: true, skipped: true, reason: "blacklist_hit", plate: persistedItem.plate, blacklist: recoveredBlacklistHit }
          : openEsp32GateForPlate(persistedItem.plate, {
              source: persistedItem.source,
              id: persistedItem.id,
              event_id: reportIdentity.event_id,
              target_device_id: persistedItem.target_device_id,
              target_mac: persistedItem.target_mac,
            });
        const recoveredSideEffectFailure = rkPlateSideEffectFailure(recoveredBlacklistHit, recoveredGate);
        if (recoveredSideEffectFailure) {
          sendJson(res, 503, {
            ok: false,
            ...recoveredSideEffectFailure,
            message: `${recoveredSideEffectFailure.message}; retry with the same event_id`,
          });
          return;
        }
        const receiptPersisted = completeRkReportReceipt(reportIdentity, {
          item_id: persistedItem.id,
          time_bj: persistedItem.time_bj,
          blacklist_hit: Boolean(recoveredBlacklistHit),
          target_device_id: persistedItem.target_device_id || "",
          target_mac: persistedItem.target_mac || "",
        });
        if (!receiptPersisted) {
          sendJson(res, 503, { ok: false, error: "receipt_complete_failed", message: "Recovered side effects were applied; retry with the same event_id" });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          ...rkReportAckFields(reportIdentity, true),
          id: persistedItem.id,
          gate: recoveredGate,
          blacklist_hit: Boolean(recoveredBlacklistHit),
          blacklist: recoveredBlacklistHit,
          target_device_id: persistedItem.target_device_id || "",
          target_mac: persistedItem.target_mac || "",
        });
        return;
      }
      if (existingReceipt.state !== "completed") {
        sendJson(res, 425, { ok: false, error: "report_in_progress", message: "The first delivery is still being processed; retry later" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        ...rkReportAckFields(reportIdentity, true),
        id: existingReceipt.item_id || "",
        gate: { ok: true, skipped: true, reason: "duplicate_event" },
        blacklist_hit: existingReceipt.blacklist_hit === true,
        blacklist: null,
        target_device_id: existingReceipt.target_device_id || targetDeviceId || "",
        target_mac: existingReceipt.target_mac || targetMac || "",
      });
      return;
    }

    // Validate the business payload only after resolving an existing event.
    // A lost response may be retried with just the idempotency key; that
    // request must still receive the same completed/recovery acknowledgement.
    const platePayloadProblem = validateRkPlatePayload(body);
    if (platePayloadProblem) {
      releaseRkReportReservation(reportIdentity);
      sendJson(res, 400, { ok: false, ...platePayloadProblem });
      return;
    }
    if (!plate) {
      sendJson(res, 400, { ok: false, error: "bad_plate" });
      return;
    }

    const id = randomUUID();
    if (reportIdentity.event_id && !persistRkReportReceipt(reportIdentity, { state: "accepted", item_id: id, time_bj: timeBj })) {
      sendJson(res, 503, { ok: false, error: "receipt_persist_failed", message: "Unable to durably reserve the plate event id" });
      return;
    }
    let imageBuf = null;
    let thumbBuf = null;
    const imageValid = imageBase64 && imageBase64.length <= 5_000_000 && /^[A-Za-z0-9+/=]+$/.test(imageBase64);
    if (imageValid) {
      try {
        const buf = Buffer.from(imageBase64, "base64");
        if (buf.length > 200) imageBuf = buf;
      } catch {
        imageBuf = null;
      }
    }
    const thumbValid = thumbBase64 && thumbBase64.length <= 220000 && /^[A-Za-z0-9+/=]+$/.test(thumbBase64);
    if (thumbValid) {
      try {
        const buf = Buffer.from(thumbBase64, "base64");
        if (buf.length > 10) thumbBuf = buf;
      } catch {
        thumbBuf = null;
      }
    }
    const imageAbs = imageBuf ? saveJpegFile(plateImageDir, `${id}.jpg`, imageBuf) : null;
    const thumbAbs = thumbBuf ? saveJpegFile(plateImageDir, `${id}_thumb.jpg`, thumbBuf) : null;
    const imagePath = toLogRelPath(imageAbs);
    const thumbPath = toLogRelPath(thumbAbs);
    const imageUrl = imagePath ? `/api/plates/${encodeURIComponent(id)}/image.jpg` : null;
    const thumbUrl = thumbPath ? `/api/plates/${encodeURIComponent(id)}/thumb.jpg` : null;
    const itemSource = source || "src1";
    const eventMetadata = normalizeRkPlateEventMetadata(body, {
      source: itemSource,
      plate,
      status: rkReported.status,
      default_event_schema: "rk3568_plate_event_v2",
    });
    const reportMetadata = reportEnvelope;

    const item = {
      id,
      time_bj: timeBj,
      source: itemSource,
      plate,
      ...reportMetadata,
      color: color || "未知",
      ...eventMetadata,
      ...(vehicleType ? { vehicle_type: vehicleType } : {}),
      ...(vehicleTypeCode ? { vehicle_type_code: vehicleTypeCode } : {}),
      ...(plateCategory ? { plate_category: plateCategory } : {}),
      ...(plateCategoryCode ? { plate_category_code: plateCategoryCode } : {}),
      ...(inputMode ? { input_mode: inputMode } : {}),
      ...(sdSourcePath ? { sd_source_path: sdSourcePath } : {}),
      ...(Number.isFinite(detConf) ? { det_conf: Number(detConf.toFixed(4)) } : {}),
      ...(Number.isFinite(detConfPct) ? { det_conf_pct: detConfPct } : {}),
      ...(Number.isFinite(recConf) ? { rec_conf: Number(recConf.toFixed(4)) } : {}),
      ...(Number.isFinite(conf) ? { conf: Number(conf.toFixed(4)) } : {}),
      ...(Number.isFinite(recConfPct) ? { rec_conf_pct: recConfPct } : {}),
      ...(targetDeviceId ? { target_device_id: targetDeviceId } : {}),
      ...(targetMac ? { target_mac: targetMac } : {}),
      ...(imageUrl ? { image_url: imageUrl } : {}),
      ...(imagePath ? { image_path: imagePath, image_bytes: imageBuf.length } : {}),
      ...(thumbUrl ? { thumb_url: thumbUrl } : {}),
      ...(thumbPath ? { thumb_path: thumbPath, thumb_bytes: thumbBuf.length } : {}),
    };
    const persistedItem = dbPlateItem(item);
    if (!appendDurableJsonLine(path.join(logRoot, "plates.jsonl"), persistedItem)) {
      releaseRkReportReservation(reportIdentity);
      removeCaptureFiles(item, "plate");
      sendJson(res, 507, { ok: false, error: "plate_persist_failed", message: "Unable to durably save the plate event" });
      return;
    }
    appendDurableJsonLine(path.join(logRoot, "plates_audit.jsonl"), { event: "created", ...persistedItem });
    rkReported.plates.unshift(item);
    rkReported.platesHydratedFromLog = false;
    if (rkReported.plates.length > RK_PLATES_MAX) rkReported.plates.length = RK_PLATES_MAX;
    void mysqlSavePlate(item);

    if (reportIdentity.event_id && !persistRkReportReceipt(reportIdentity, {
      state: "record_persisted",
      item_id: id,
      time_bj: timeBj,
      target_device_id: item.target_device_id || "",
      target_mac: item.target_mac || "",
    })) {
      const fallback = normalizeStoredRkReportReceipt({
        report_type: "plate",
        rk_device_id: reportIdentity.rk_device_id,
        event_id: reportIdentity.event_id,
        state: "record_persisted",
        item_id: id,
        time_bj: timeBj,
        target_device_id: item.target_device_id || "",
        target_mac: item.target_mac || "",
      });
      if (fallback) ensureRkReportReceiptIndex().set(rkReportReceiptKey(reportIdentity.rk_device_id, reportIdentity.event_id), fallback);
      sendJson(res, 503, { ok: false, error: "receipt_stage_failed", message: "Plate was saved; retry with the same event_id to finish side effects" });
      return;
    }

    if (imageBuf || thumbBuf) {
      rkReported.previewJpeg = imageBuf || thumbBuf;
      rkReported.previewUpdatedAt = Date.now();
    }

    const blacklistHit = miniMarkBlacklistHit(item.plate, {
      event_id: reportIdentity.event_id,
      source: item.source,
      id,
      target_device_id: item.target_device_id,
      target_mac: item.target_mac,
      image_url: item.image_url || "",
      thumb_url: item.thumb_url || "",
    });
    const gate = blacklistHit
      ? { ok: true, skipped: true, reason: "blacklist_hit", plate: item.plate, blacklist: blacklistHit }
      : openEsp32GateForPlate(item.plate, {
          source: item.source,
          id,
          event_id: reportIdentity.event_id,
          target_device_id: item.target_device_id,
          target_mac: item.target_mac,
        });
    const sideEffectFailure = rkPlateSideEffectFailure(blacklistHit, gate);
    if (sideEffectFailure) {
      sendJson(res, 503, {
        ok: false,
        ...sideEffectFailure,
        message: `${sideEffectFailure.message}; retry with the same event_id`,
        id,
      });
      return;
    }

    const receiptPersisted = completeRkReportReceipt(reportIdentity, {
        item_id: id,
        time_bj: timeBj,
        blacklist_hit: Boolean(blacklistHit),
        target_device_id: item.target_device_id || "",
        target_mac: item.target_mac || "",
      });

    if (!receiptPersisted) {
      sendJson(res, 503, {
        ok: false,
        error: "receipt_complete_failed",
        message: "Plate data was saved, but the durable acknowledgement journal is unavailable; retry with the same event_id",
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      ...rkReportAckFields(reportIdentity, false),
      id,
      gate,
      blacklist_hit: Boolean(blacklistHit),
      blacklist: blacklistHit,
      target_device_id: item.target_device_id || "",
      target_mac: item.target_mac || "",
    });
    return;
  }

  if (pathname === "/api/rk/report/user-message" && req.method === "POST") {
    const raw = await readBody(req);
    const body = safeJsonParse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: "bad_json", message: "A JSON object is required" });
      return;
    }
    const reportIdentity = normalizeRkReportIdentity(req, body, "user-message");
    if (reportIdentity.error) {
      sendJson(res, 400, { ok: false, error: reportIdentity.error, message: reportIdentity.message });
      return;
    }
    trackRkPeerOnSuccess(req, res, reportIdentity);
    const reportEnvelope = normalizeRkReportEnvelope(req, body, reportIdentity, "user-message");
    const displayText = cleanUserTemplate(body?.display_text || body?.broadcast_text, 600);
    const broadcastText = cleanUserTemplate(body?.broadcast_text || body?.display_text, 600);
    const bizSystemRaw = String(body?.biz_system || "").trim().toLowerCase();
    const id = randomUUID();
    const reportClaim = claimRkReportReceipt(reportIdentity, {
      item_id: id,
      time_bj: cleanUserTemplate(body?.time_bj || nowBjText(), 32),
    });
    if (sendRkReportClaimResult(res, reportIdentity, reportClaim)) return;
    if (reportClaim.state === "resume") {
      const resumedId = reportClaim.receipt?.item_id || "";
      const persistedItem = [...(rkReported.userMessages || []), ...readJsonlAll(path.join(logRoot, "user_messages.jsonl"))]
        .find((item) => String(item?.id || "") === resumedId
          && String(item?.event_id || "") === reportIdentity.event_id
          && String(item?.rk_device_id || "rk3568") === reportIdentity.rk_device_id);
      if (!persistedItem) {
        sendJson(res, 503, { ok: false, error: "user_message_recovery_missing", message: "Receipt exists but the durable user message is unavailable" });
        return;
      }
      const receiptPersisted = completeRkReportReceipt(reportIdentity, { item_id: resumedId, time_bj: persistedItem.time_bj || nowBjText() });
      sendJson(res, receiptPersisted ? 200 : 503, receiptPersisted
        ? { ok: true, ...rkReportAckFields(reportIdentity, true), id: resumedId, item: persistedItem }
        : { ok: false, error: "receipt_complete_failed", message: "Retry with the same event_id" });
      return;
    }
    const userMessagePayloadProblem = validateRkUserMessagePayload(body);
    if (userMessagePayloadProblem) {
      releaseRkReportReservation(reportIdentity);
      sendJson(res, 400, { ok: false, ...userMessagePayloadProblem });
      return;
    }
    if (!displayText && !broadcastText) {
      releaseRkReportReservation(reportIdentity);
      sendJson(res, 400, { ok: false, error: "bad_message", message: "display_text or broadcast_text is required" });
      return;
    }
    const plate = cleanUserTemplate(body?.plate, 80);
    const source = cleanUserTemplate(body?.source, 40);
    const eventMetadata = normalizeRkPlateEventMetadata(body, { source, plate, status: rkReported.status });
    const targetDeviceId = cleanDeviceId(body?.target_device_id || body?.targetDeviceId, "");
    const reportedVehicleType = cleanUserTemplate(body?.vehicle_type, 64);
    const reportedVehicleTypeCode = cleanUserTemplate(body?.vehicle_type_code, 64);
    const reportedPlateCategory = cleanUserTemplate(body?.plate_category, 64);
    const reportedPlateCategoryCode = cleanUserTemplate(body?.plate_category_code, 64);
    const item = {
      id,
      time_bj: String(body?.time_bj || nowBjText()),
      ...reportEnvelope,
      role: cleanUserTemplate(body?.role || "user", 40) || "user",
      user_state: cleanUserTemplate(body?.user_state || "normal", 40) || "normal",
      biz_system: bizSystemRaw === "etc" ? "etc" : "parking",
      event_type: cleanUserTemplate(body?.event_type || "user_message", 120),
      template_key: cleanUserTemplate(body?.template_key, 120) || null,
      template_version: Number.isFinite(Number(body?.template_version)) ? Math.floor(Number(body.template_version)) : null,
      config_version: Number.isFinite(Number(body?.config_version)) ? Math.floor(Number(body.config_version)) : null,
      display_text: displayText || broadcastText || "",
      broadcast_text: broadcastText || displayText || "",
      plate,
      source,
      ...eventMetadata,
      ...(targetDeviceId ? { target_device_id: targetDeviceId } : {}),
      color: cleanUserTemplate(body?.color, 32),
      ...(reportedVehicleType || reportedPlateCategory ? { vehicle_type: reportedVehicleType || reportedPlateCategory } : {}),
      ...(reportedVehicleTypeCode || reportedPlateCategoryCode ? { vehicle_type_code: reportedVehicleTypeCode || reportedPlateCategoryCode } : {}),
      ...(reportedPlateCategory || reportedVehicleType ? { plate_category: reportedPlateCategory || reportedVehicleType } : {}),
      ...(reportedPlateCategoryCode || reportedVehicleTypeCode ? { plate_category_code: reportedPlateCategoryCode || reportedVehicleTypeCode } : {}),
      conf: Number.isFinite(Number(body?.conf ?? body?.rec_conf)) ? Number(Number(body.conf ?? body.rec_conf).toFixed(4)) : null,
      det_conf: Number.isFinite(Number(body?.det_conf)) ? Number(Number(body.det_conf).toFixed(4)) : null,
      det_conf_pct: confToPercent(body?.det_conf),
      rec_conf: Number.isFinite(Number(body?.rec_conf)) ? Number(Number(body.rec_conf).toFixed(4)) : null,
      rec_conf_pct: confToPercent(body?.rec_conf ?? body?.conf),
      pay_status: cleanUserTemplate(body?.pay_status, 40) || null,
      fee: Number.isFinite(Number(body?.fee)) ? Number(Number(body.fee).toFixed(2)) : null,
      paid_from_balance: Number.isFinite(Number(body?.paid_from_balance)) ? Number(Number(body.paid_from_balance).toFixed(2)) : null,
      need_pay: Number.isFinite(Number(body?.need_pay)) ? Number(Number(body.need_pay).toFixed(2)) : null,
      balance_after: Number.isFinite(Number(body?.balance_after)) ? Number(Number(body.balance_after).toFixed(2)) : null,
      arrears_after: Number.isFinite(Number(body?.arrears_after)) ? Number(Number(body.arrears_after).toFixed(2)) : null,
      duration_minutes: Number.isFinite(Number(body?.duration_minutes)) ? Math.floor(Number(body.duration_minutes)) : null,
      duration_text: cleanUserTemplate(body?.duration_text, 120),
    };
    if (!appendDurableJsonLine(path.join(logRoot, "user_messages.jsonl"), item)) {
      releaseRkReportReservation(reportIdentity);
      sendJson(res, 507, { ok: false, error: "user_message_persist_failed", message: "Unable to durably save the user message" });
      return;
    }
    rkReported.userMessages.unshift(item);
    if (rkReported.userMessages.length > 500) rkReported.userMessages.length = 500;
    if (!persistRkReportRecordStage(reportIdentity, { item_id: id, time_bj: item.time_bj })) {
      sendJson(res, 503, { ok: false, error: "receipt_stage_failed", message: "User message was saved; retry with the same event_id" });
      return;
    }
    const receiptPersisted = completeRkReportReceipt(reportIdentity, { item_id: id, time_bj: item.time_bj });
    if (!receiptPersisted) {
      sendJson(res, 503, { ok: false, error: "receipt_complete_failed", message: "User message was saved; retry with the same event_id" });
      return;
    }
    communicationLog.append({ channel: "rk_rx", direction: "rx", transport: "HTTPS", status: "received", payload: raw,
      endpoint: pathname, summary: `RK 字符消息 · ${displayText || broadcastText || "用户消息"}` });
    sendJson(res, 200, { ok: true, ...rkReportAckFields(reportIdentity, false), item });
    return;
  }

  if (pathname === "/api/rk/report/violation" && req.method === "POST") {
    const raw = await readBody(req, 12_000_000);
    const body = safeJsonParse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: "bad_json", message: "A JSON object is required" });
      return;
    }
    const reportIdentity = normalizeRkReportIdentity(req, body, "violation");
    if (reportIdentity.error) {
      sendJson(res, 400, { ok: false, error: reportIdentity.error, message: reportIdentity.message });
      return;
    }
    trackRkPeerOnSuccess(req, res, reportIdentity);
    const reportEnvelope = normalizeRkReportEnvelope(req, body, reportIdentity, "violation");
    const time_bj = String(body?.time_bj || nowBjText());
    const view_mode = Number(body?.view_mode ?? 0) || 0;
    const single_source = Number(body?.single_source ?? 0) || 0;
    const q0 = Number(body?.q0 ?? 0) || 0;
    const q1 = Number(body?.q1 ?? 0) || 0;
    const q2 = Number(body?.q2 ?? 0) || 0;
    const q3 = Number(body?.q3 ?? 0) || 0;
    const overlap_iou = Number(body?.overlap_iou ?? 0) || 0;
    const img64 = stripBase64DataUri(body?.image_jpeg_base64);
    const thumb64 = stripBase64DataUri(body?.thumb_jpeg_base64);

    // Resolve an existing event before validating/decoding the image again.
    // A retry may legitimately contain only the idempotency key after the
    // first request reached the server but its response was lost.
    const id = randomUUID();
    const reportClaim = claimRkReportReceipt(reportIdentity, { item_id: id, time_bj });
    if (sendRkReportClaimResult(res, reportIdentity, reportClaim, { ai: { state: "duplicate" } })) return;
    if (reportClaim.state === "resume") {
      const resumedId = reportClaim.receipt?.item_id || "";
      const persistedItem = [...rkReported.violations, ...latestViolationsFromAudit()]
        .find((item) => String(item?.id || "") === resumedId
          && String(item?.event_id || item?.report_id || "") === reportIdentity.event_id
          && String(item?.rk_device_id || "rk3568") === reportIdentity.rk_device_id);
      if (!persistedItem) {
        sendJson(res, 503, { ok: false, error: "violation_recovery_missing", message: "Receipt exists but the durable violation record is unavailable" });
        return;
      }
      if (persistedItem.ai?.state === "pending") enqueueViolationAi(resumedId);
      const receiptPersisted = completeRkReportReceipt(reportIdentity, {
        item_id: resumedId,
        time_bj: persistedItem.time_bj || time_bj,
      });
      sendJson(res, receiptPersisted ? 200 : 503, receiptPersisted
        ? { ok: true, ...rkReportAckFields(reportIdentity, true), id: resumedId, ai: persistedItem.ai || { state: "restored" } }
        : { ok: false, error: "receipt_complete_failed", message: "Retry with the same event_id" });
      return;
    }

    const violationPayloadProblem = validateRkViolationPayload(body);
    if (violationPayloadProblem) {
      releaseRkReportReservation(reportIdentity);
      sendJson(res, 400, { ok: false, ...violationPayloadProblem });
      return;
    }
    if (!img64 || img64.length < 1000 || img64.length > 11_500_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(img64)) {
      releaseRkReportReservation(reportIdentity);
      sendJson(res, 400, { ok: false, error: "bad_image" });
      return;
    }

    let imgBuf = null;
    let thumbBuf = null;
    try {
      imgBuf = Buffer.from(img64, "base64");
      if (!imgBuf || imgBuf.length < 1000) imgBuf = null;
    } catch {
      imgBuf = null;
    }
    if (thumb64 && thumb64.length <= 300_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(thumb64)) {
      try {
        thumbBuf = Buffer.from(thumb64, "base64");
        if (!thumbBuf || thumbBuf.length < 200) thumbBuf = null;
      } catch {
        thumbBuf = null;
      }
    }
    if (!imgBuf) {
      releaseRkReportReservation(reportIdentity);
      sendJson(res, 400, { ok: false, error: "bad_image", message: "image_jpeg_base64 could not be decoded" });
      return;
    }
    const reportMetadata = reportEnvelope;
    const item = {
      id,
      time_bj,
      ...reportMetadata,
      view_mode,
      single_source,
      q0,
      q1,
      q2,
      q3,
      overlap_iou,
      image_len: imgBuf ? imgBuf.length : 0,
      thumb_len: thumbBuf ? thumbBuf.length : 0,
      image_url: `/api/violations/${encodeURIComponent(id)}/image.jpg`,
      thumb_url: thumbBuf ? `/api/violations/${encodeURIComponent(id)}/thumb.jpg` : null,
      ai: { ok: false, violation: null, desc: null, provider: violationAiCfg?.provider || "deepseek", model: violationAiCfg?.model || "deepseek-chat", error: null },
    };
    const imageAbs = imgBuf ? saveJpegFile(violationImageDir, `${id}.jpg`, imgBuf) : null;
    const thumbAbs = thumbBuf ? saveJpegFile(violationImageDir, `${id}_thumb.jpg`, thumbBuf) : null;
    const imagePath = toLogRelPath(imageAbs);
    const thumbPath = toLogRelPath(thumbAbs);
    if (imagePath) item.image_path = imagePath;
    if (thumbPath) item.thumb_path = thumbPath;
    if (!imagePath) {
      releaseRkReportReservation(reportIdentity);
      removeCaptureFiles(item, "violation");
      sendJson(res, 507, { ok: false, error: "violation_image_persist_failed", message: "Unable to save the violation image" });
      return;
    }

    item.ai = { ...(item.ai || {}), state: "pending", ok: false, violation: null, desc: null, error: null };
    const auditItem = {
      event: "created",
      id,
      time_bj,
      ...reportMetadata,
      view_mode,
      single_source,
      q0,
      q1,
      q2,
      q3,
      overlap_iou,
      image_len: item.image_len,
      thumb_len: item.thumb_len,
      image_url: item.image_url,
      thumb_url: item.thumb_url,
      image_path: imagePath,
      thumb_path: thumbPath,
      ai: item.ai,
    };
    if (!appendDurableJsonLine(path.join(logRoot, "violations_audit.jsonl"), auditItem)) {
      releaseRkReportReservation(reportIdentity);
      removeCaptureFiles(item, "violation");
      sendJson(res, 507, { ok: false, error: "violation_persist_failed", message: "Unable to durably save the violation event" });
      return;
    }
    rkReported.violations.unshift(item);
    rkReported.violationsHydratedFromLog = false;
    if (rkReported.violations.length > RK_VIOLATIONS_MAX) rkReported.violations.length = RK_VIOLATIONS_MAX;
    void mysqlSaveViolation(item);
    if (!persistRkReportRecordStage(reportIdentity, { item_id: id, time_bj })) {
      sendJson(res, 503, { ok: false, error: "receipt_stage_failed", message: "Violation was saved; retry with the same event_id" });
      return;
    }
    enqueueViolationAi(id);
    const receiptPersisted = completeRkReportReceipt(reportIdentity, { item_id: id, time_bj });
    if (!receiptPersisted) {
      sendJson(res, 503, { ok: false, error: "receipt_complete_failed", message: "Violation was saved; retry with the same event_id" });
      return;
    }
    sendJson(res, 200, { ok: true, ...rkReportAckFields(reportIdentity, false), id, ai: item.ai });
    return;
  }

  const mViolImg = pathname.match(/^\/api\/violations\/([^/]+)\/(image|thumb)\.jpg$/);
  if (mViolImg && req.method === "GET") {
    const id = decodeURIComponent(String(mViolImg[1] || ""));
    const kind = String(mViolImg[2] || "");
    const it = (rkReported.violations || []).find((x) => String(x?.id || "") === id);
    let buf = readJpegFile(directCaptureImagePath(violationImageDir, id, kind));
    if (!buf) buf = kind === "thumb" ? readJpegFile(it?.thumb_path) : readJpegFile(it?.image_path);
    if (!buf && kind === "thumb") {
      const b64 = typeof it?.thumb_jpeg_base64 === "string" ? it.thumb_jpeg_base64.trim() : "";
      if (b64 && b64.length <= 250000 && /^[A-Za-z0-9+/=]+$/.test(b64)) {
        try {
          const b = Buffer.from(b64, "base64");
          if (b.length > 10) buf = b;
        } catch {}
      }
    }
    if (!buf) {
      const audit = latestViolationsFromAudit().find((x) => String(x?.id || "") === id) || null;
      buf = kind === "thumb" ? readJpegFile(audit?.thumb_path) : readJpegFile(audit?.image_path);
    }
    if (!buf) {
      const dbPaths = await mysqlFindViolationPaths(id);
      buf = kind === "thumb" ? readJpegFile(dbPaths?.thumb_path) : readJpegFile(dbPaths?.image_path);
    }
    if (!buf || !(buf instanceof Buffer) || buf.length < 10) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }
    sendCaptureJpeg(req, res, buf, `violation-${id}-${kind}`);
    return;
  }

  const mViolDelete = pathname.match(/^\/api\/violations\/([^/]+)\/delete$/);
  if (mViolDelete && (req.method === "POST" || req.method === "DELETE")) {
    const id = decodeURIComponent(String(mViolDelete[1] || ""));
    const result = await deleteViolationCaptureById(id);
    sendJson(res, result.ok ? 200 : 404, result.ok ? result : { ...result, error: result.error || "not_found" });
    return;
  }

  const mPlateImg = pathname.match(/^\/api\/plates\/([^/]+)\/(image|thumb)\.jpg$/);
  if (mPlateImg && req.method === "GET") {
    const id = decodeURIComponent(String(mPlateImg[1] || ""));
    const kind = String(mPlateImg[2] || "");
    const it = (rkReported.plates || []).find((x) => String(x?.id || "") === id);
    let buf = readJpegFile(directCaptureImagePath(plateImageDir, id, kind));
    if (!buf) buf = kind === "thumb" ? readJpegFile(it?.thumb_path) : readJpegFile(it?.image_path);
    if (!buf) {
      const b64Raw = kind === "thumb" ? it?.thumb_jpeg_base64 : it?.image_jpeg_base64;
      const b64 = typeof b64Raw === "string" ? b64Raw.trim() : "";
      const maxLen = kind === "thumb" ? 250000 : 6_000_000;
      const minLen = kind === "thumb" ? 10 : 200;
      if (b64 && b64.length <= maxLen && /^[A-Za-z0-9+/=]+$/.test(b64)) {
        try {
          const b = Buffer.from(b64, "base64");
          if (b.length > minLen) buf = b;
        } catch {}
      }
    }
    if (!buf) {
      const audit = latestPlatesFromAudit().find((x) => String(x?.id || "") === id) || null;
      buf = kind === "thumb" ? readJpegFile(audit?.thumb_path) : readJpegFile(audit?.image_path);
    }
    if (!buf) {
      const dbPaths = await mysqlFindPlatePaths(id);
      buf = kind === "thumb" ? readJpegFile(dbPaths?.thumb_path) : readJpegFile(dbPaths?.image_path);
    }
    if (!buf || !(buf instanceof Buffer) || buf.length < 10) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }
    sendCaptureJpeg(req, res, buf, `plate-${id}-${kind}`);
    return;
  }

  const mPlateDelete = pathname.match(/^\/api\/plates\/([^/]+)\/delete$/);
  if (mPlateDelete && (req.method === "POST" || req.method === "DELETE")) {
    const id = decodeURIComponent(String(mPlateDelete[1] || ""));
    const result = await deletePlateCaptureById(id);
    sendJson(res, result.ok ? 200 : 404, result.ok ? result : { ...result, error: result.error || "not_found" });
    return;
  }

  if (pathname === "/api/rk/report/clear" && req.method === "POST") {
    rkReported.plates = [];
    rkReported.platesHydratedFromLog = false;
    rkReported.previewJpeg = null;
    rkReported.previewUpdatedAt = null;
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/plates/clear" && req.method === "POST") {
    rkReported.plates = [];
    rkReported.platesHydratedFromLog = false;
    rkReported.previewJpeg = null;
    rkReported.previewUpdatedAt = null;
    try {
      const p = path.join(logRoot, "plates.jsonl");
      if (fs.existsSync(p)) fs.writeFileSync(p, "", "utf8");
    } catch {}
    try {
      const p = path.join(logRoot, "plates_audit.jsonl");
      if (fs.existsSync(p)) fs.writeFileSync(p, "", "utf8");
    } catch {}
    const dbCleared = await mysqlClearPlates();
    const imageFiles = clearCaptureImageFiles("plate");
    sendJson(res, 200, { ok: true, db_cleared: dbCleared, image_files: imageFiles });
    return;
  }

  if (pathname === "/api/violations" && req.method === "GET") {
    const limit = clamp(parseInt(u.searchParams.get("limit") || "80", 10) || 80, 1, 5000);
    const offset = clamp(parseInt(u.searchParams.get("offset") || "0", 10) || 0, 0, 2000000);
    const historyData = await collectViolationCaptureHistory(Math.max(RK_VIOLATIONS_MAX, offset + limit));
    const history = historyData.items;
    const total = history.length;
    if (total || !DEMO_VIOLATIONS) {
      const items = history
      .slice(offset, offset + limit)
      .map(dbViolationItem)
      .filter(Boolean);
      const source = captureHistorySource({
        dbItems: historyData.db_items,
        memoryItems: rkReported.violations,
        memoryFromLog: rkReported.violationsHydratedFromLog,
        auditItems: historyData.audit_items,
      });
      sendJson(res, 200, { ok: true, total, limit, offset, items, has_more: offset + items.length < total, source });
      return;
    }
    const items = [];
    sendJson(res, 200, { ok: true, total: 0, limit, offset, items, has_more: false, source: "empty", demo: true });
    return;
  }

  if (pathname === "/api/violations/export" && req.method === "GET") {
    const format = String(u.searchParams.get("format") || "csv").trim().toLowerCase();
    const includeImages = String(u.searchParams.get("include_images") || "0").trim() === "1";
    const violationHistory = await collectViolationCaptureHistory(Math.max(RK_VIOLATIONS_MAX, 5000));
    const items = violationHistory.items;
    const rows = (items || []).map((it) => ({
      id: String(it?.id || ""),
      device: String(it?.device || ""),
      rk_device_id: String(it?.rk_device_id || ""),
      event_id: String(it?.event_id || ""),
      report_id: String(it?.report_id || ""),
      report_schema: String(it?.report_schema || ""),
      report_type: String(it?.report_type || ""),
      delivery_semantics: String(it?.delivery_semantics || ""),
      report_created_at: String(it?.report_created_at || ""),
      report_created_at_ms: it?.report_created_at_ms ?? null,
      report_attempt: it?.report_attempt ?? null,
      time_bj: String(it?.time_bj || ""),
      view_mode: it?.view_mode ?? null,
      single_source: it?.single_source ?? null,
      q0: it?.q0 ?? null,
      q1: it?.q1 ?? null,
      q2: it?.q2 ?? null,
      q3: it?.q3 ?? null,
      overlap_iou: it?.overlap_iou ?? null,
      ai_state: String(it?.ai?.state || ""),
      ai_ok: it?.ai?.ok ?? null,
      ai_violation: it?.ai?.violation ?? null,
      ai_desc: String(it?.ai?.desc || ""),
      manual_reviewed: it?.manual?.reviewed ?? null,
      manual_violation: it?.manual?.violation ?? null,
      manual_desc: String(it?.manual?.desc || ""),
      image_url: String(it?.image_url || ""),
      thumb_url: String(it?.thumb_url || ""),
      image_path: String(it?.image_path || ""),
      thumb_path: String(it?.thumb_path || ""),
    }));
    const headers = [
      "id",
      "device",
      "rk_device_id",
      "event_id",
      "report_id",
      "report_schema",
      "report_type",
      "delivery_semantics",
      "report_created_at",
      "report_created_at_ms",
      "report_attempt",
      "time_bj",
      "view_mode",
      "single_source",
      "q0",
      "q1",
      "q2",
      "q3",
      "overlap_iou",
      "ai_state",
      "ai_ok",
      "ai_violation",
      "ai_desc",
      "manual_reviewed",
      "manual_violation",
      "manual_desc",
      "image_url",
      "thumb_url",
      "image_path",
      "thumb_path",
    ];
    if (!includeImages) {
      if (format === "jsonl") {
        const text = toJsonl(rows);
        send(res, 200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Disposition": `attachment; filename="violations.jsonl"` }, text);
        return;
      }
      const csv = toCsv(rows, headers);
      send(res, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="violations.csv"` }, csv);
      return;
    }
    const expId = randomUUID();
    const csv = toCsv(rows, headers);
    const files = [{ name: "violations.csv", data: Buffer.from(csv, "utf8") }];
    for (const it of items || []) {
      const id = String(it?.id || "");
      const ip = it?.image_path;
      const tp = it?.thumb_path;
      if (id && ip) {
        const buf = readJpegFile(ip);
        if (buf) files.push({ name: `images/${sanitizeFileName(id)}.jpg`, data: buf });
      }
      if (id && tp) {
        const buf = readJpegFile(tp);
        if (buf) files.push({ name: `images/${sanitizeFileName(id)}_thumb.jpg`, data: buf });
      }
    }
    sendTarGz(res, `violations_${expId}`, files);
    return;
  }

  const mViolAiRerun = pathname.match(/^\/api\/violations\/([^/]+)\/ai\/rerun$/);
  if (mViolAiRerun && req.method === "POST") {
    const id = decodeURIComponent(String(mViolAiRerun[1] || ""));
    const it = (rkReported.violations || []).find((x) => String(x?.id || "") === id);
    if (!it) {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    it.ai = { ...(it.ai || {}), state: "pending", ok: false, violation: null, desc: null, error: null };
    enqueueViolationAi(it.id);
    void mysqlSaveViolation(it);
    sendJson(res, 200, { ok: true, id: it.id, ai: it.ai });
    return;
  }

  const mViolReview = pathname.match(/^\/api\/violations\/([^/]+)\/review$/);
  if (mViolReview && req.method === "POST") {
    const id = decodeURIComponent(String(mViolReview[1] || ""));
    const it = (rkReported.violations || []).find((x) => String(x?.id || "") === id);
    if (!it) {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    const raw = await readBody(req, 120_000);
    const body = safeJsonParse(raw) || {};
    const vRaw = body?.violation;
    let v = null;
    if (typeof vRaw === "boolean") v = vRaw;
    else if (typeof vRaw === "number" && Number.isFinite(vRaw)) v = vRaw !== 0;
    else if (vRaw === null) v = null;
    else if (typeof vRaw === "string") {
      const t = vRaw.trim().toLowerCase();
      if (["true", "1", "yes", "y", "是"].includes(t)) v = true;
      else if (["false", "0", "no", "n", "否"].includes(t)) v = false;
      else v = null;
    }
    const desc = clampTextLen(String(body?.desc || ""), 50);
    const time_bj = nowBjText();
    it.manual = {
      reviewed: true,
      time_bj,
      violation: v,
      desc: desc || null,
    };
    appendJsonLine("violations_manual.jsonl", { id: it.id, time_bj, manual: it.manual });
    appendJsonLine("violations_audit.jsonl", { event: "manual_review", id: it.id, time_bj, manual: it.manual });
    void mysqlSaveViolation(it);
    sendJson(res, 200, { ok: true, id: it.id, manual: it.manual });
    return;
  }

  if (pathname === "/api/violations/clear" && req.method === "POST") {
    rkReported.violations = [];
    rkReported.violationsHydratedFromLog = false;
    try {
      const p = path.join(logRoot, "violations.jsonl");
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
    try {
      const p = path.join(logRoot, "violations_manual.jsonl");
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
    try {
      const p = path.join(logRoot, "violations_audit.jsonl");
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
    const dbCleared = await mysqlClearViolations();
    const imageFiles = clearCaptureImageFiles("violation");
    sendJson(res, 200, { ok: true, cleared: true, db_cleared: dbCleared, image_files: imageFiles });
    return;
  }

  if (pathname === "/api/violation/ai/config" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      provider: violationAiCfg?.provider || "deepseek",
      base_url: violationAiCfg?.base_url || "",
      model: violationAiCfg?.model || "",
      api_key_set: Boolean(String(violationAiCfg?.api_key || "").trim()),
    });
    return;
  }

  if (pathname === "/api/violation/ai/config" && req.method === "POST") {
    const raw = await readBody(req, 60_000);
    const body = safeJsonParse(raw) || {};
    const cfg = normalizeLlmConfig(body, violationAiCfg);
    const provider = cfg.provider;
    const base_url = cfg.base_url;
    const model = cfg.model;
    const api_key = cfg.api_key;
    if (!["deepseek", "openai"].includes(provider)) {
      sendJson(res, 400, { ok: false, error: "bad_provider" });
      return;
    }
    if (!base_url || !model || !api_key) {
      sendJson(res, 400, { ok: false, error: "missing_fields" });
      return;
    }
    const keyProblem = llmApiKeyProblem(api_key);
    if (keyProblem) {
      sendJson(res, 400, { ok: false, error: keyProblem, message: "API Key 不能填写 Base URL，请填写服务商控制台生成的密钥。" });
      return;
    }
    violationAiCfg = saveLlmConfigFile("violation_ai", { provider, base_url, model, api_key });
    sendJson(res, 200, { ok: true, provider, base_url, model, api_key_set: true, persisted: true, config_path: llmConfigPath });
    return;
  }

  if (pathname === "/api/rk/report/business" && req.method === "POST") {
    const raw = await readBody(req);
    const body = safeJsonParse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: "bad_json", message: "A JSON object is required" });
      return;
    }
    const reportIdentity = normalizeRkReportIdentity(req, body, "business");
    if (reportIdentity.error) {
      sendJson(res, 400, { ok: false, error: reportIdentity.error, message: reportIdentity.message });
      return;
    }
    trackRkPeerOnSuccess(req, res, reportIdentity);
    const reportEnvelope = normalizeRkReportEnvelope(req, body, reportIdentity, "business");
    const snapshotAtMs = reportEnvelope.report_created_at_ms;
    const reportClaim = claimRkReportReceipt(reportIdentity, { time_bj: cleanUserTemplate(body?.time_bj || nowBjText(), 32) });
    if (sendRkReportClaimResult(res, reportIdentity, reportClaim)) return;
    if (reportClaim.state === "resume") {
      const resumedEvent = readJsonlAll(path.join(logRoot, "business_events.jsonl"))
        .find((row) => String(row?.event_id || row?.report_id || "") === reportIdentity.event_id
          && String(row?.rk_device_id || "rk3568") === reportIdentity.rk_device_id
          && String(row?.report_type || "business") === "business");
      const resumedSnapshotAtMs = Number.isFinite(Number(resumedEvent?.report_created_at_ms))
        ? Math.floor(Number(resumedEvent.report_created_at_ms))
        : snapshotAtMs;
      const hasDurableSnapshot = Boolean(resumedEvent)
        || ["parking", "etc"].some((system) => Number(rkBizReported[system]?.updatedAt || 0) >= resumedSnapshotAtMs);
      if (!hasDurableSnapshot) {
        sendJson(res, 503, { ok: false, error: "business_recovery_missing", message: "Receipt exists but the durable business snapshot is unavailable" });
        return;
      }
      const receiptPersisted = completeRkReportReceipt(reportIdentity, { time_bj: resumedEvent?.time_bj || body?.time_bj || nowBjText() });
      sendJson(res, receiptPersisted ? 200 : 503, receiptPersisted
        ? {
            ok: true,
            ...rkReportAckFields(reportIdentity, true),
            snapshot_at_ms: resumedSnapshotAtMs,
            ...(resumedEvent?.persistence ? { persistence: resumedEvent.persistence } : {}),
          }
        : { ok: false, error: "receipt_complete_failed", message: "Retry with the same event_id" });
      return;
    }
    const businessPayloadProblem = validateRkBusinessPayload(body);
    if (businessPayloadProblem) {
      releaseRkReportReservation(reportIdentity);
      sendJson(res, 400, { ok: false, ...businessPayloadProblem });
      return;
    }
    let latest = null;
    try {
      latest = await ingestBizReport(body, snapshotAtMs, {
        ...reportEnvelope,
        report_type: "business",
      });
    } catch (error) {
      releaseRkReportReservation(reportIdentity);
      sendJson(res, Number(error?.status) || 500, {
        ok: false,
        error: String(error?.code || "business_ingest_failed"),
        message: String(error?.message || error),
        ...(error?.durable_local === true ? { durable_local: true } : {}),
        ...(error?.persistence && typeof error.persistence === "object" ? { persistence: error.persistence } : {}),
      });
      return;
    }
    const businessSnapshot = {};
    for (const system of ["parking", "etc"]) {
      const snapshot = latest?.[system];
      if (!snapshot || snapshot.ignored_stale) continue;
      businessSnapshot[system] = {
        accounts: Array.isArray(snapshot.accounts) ? snapshot.accounts : [],
        records: Array.isArray(snapshot.records) ? snapshot.records : [],
      };
    }
    const event = {
      time_bj: cleanUserTemplate(body?.time_bj || reportEnvelope.report_created_at || nowBjText(), 32),
      ...reportEnvelope,
      parking: latest.parking
        ? latest.parking.ignored_stale
          ? { ignored_stale: true }
          : { accounts: latest.parking.accounts.length, records: latest.parking.records.length }
        : undefined,
      etc: latest.etc
        ? latest.etc.ignored_stale
          ? { ignored_stale: true }
          : { accounts: latest.etc.accounts.length, records: latest.etc.records.length }
        : undefined,
      persistence: latest.persistence,
      // Keep the exact accepted snapshot alongside its envelope.  The
      // latest-state file remains authoritative for current queries, while
      // this journal makes a historical business report auditable/exportable.
      ...(Object.keys(businessSnapshot).length ? { business_snapshot: businessSnapshot } : {}),
    };
    if (!appendDurableJsonLine(path.join(logRoot, "business_events.jsonl"), event)) {
      releaseRkReportReservation(reportIdentity);
      sendJson(res, 507, { ok: false, error: "business_event_persist_failed", message: "Snapshot was saved but its receipt metadata could not be persisted; retry" });
      return;
    }
    if (!persistRkReportRecordStage(reportIdentity, { time_bj: event.time_bj })) {
      sendJson(res, 503, { ok: false, error: "receipt_stage_failed", message: "Business snapshot was saved; retry with the same event_id" });
      return;
    }
    const receiptPersisted = completeRkReportReceipt(reportIdentity, { time_bj: event.time_bj });
    if (!receiptPersisted) {
      sendJson(res, 503, { ok: false, error: "receipt_complete_failed", message: "Business snapshot was saved; retry with the same event_id" });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      ...rkReportAckFields(reportIdentity, false),
      snapshot_at_ms: snapshotAtMs,
      persistence: latest.persistence,
    });
    return;
  }

  if ((pathname === "/api/rk/user-messages" || pathname === "/api/user-messages") && req.method === "GET") {
    const queryProblem = rkJournalQueryProblem(u.searchParams);
    if (queryProblem) {
      sendJson(res, 400, { ok: false, ...queryProblem });
      return;
    }
    const page = pageRkJournalRows(readRkUserMessageJournal(u.searchParams), u.searchParams);
    const items = page.items.map((item) => stripRkJournalPayload(item));
    sendJson(res, 200, {
      ok: true,
      ...page,
      items,
      source: "jsonl",
      generated_at: nowBjText(),
    });
    return;
  }

  if ((pathname === "/api/rk/user-messages/export" || pathname === "/api/user-messages/export") && req.method === "GET") {
    const queryProblem = rkJournalQueryProblem(u.searchParams, { pagination: false });
    if (queryProblem) {
      sendJson(res, 400, { ok: false, ...queryProblem });
      return;
    }
    const rows = sortRkJournalRows(dedupeRkJournalRows(readRkUserMessageJournal(u.searchParams))).map((item) => stripRkJournalPayload(item));
    const format = String(u.searchParams.get("format") || "csv").trim().toLowerCase();
    if (!sendRkJournalExport(res, rows, format, "rk-user-messages", RK_USER_MESSAGE_EXPORT_HEADERS)) {
      sendJson(res, 400, { ok: false, error: "bad_format", message: "format must be csv or jsonl" });
    }
    return;
  }

  if ((pathname === "/api/rk/business-events" || pathname === "/api/business/events") && req.method === "GET") {
    const queryProblem = rkJournalQueryProblem(u.searchParams);
    if (queryProblem) {
      sendJson(res, 400, { ok: false, ...queryProblem });
      return;
    }
    const page = pageRkJournalRows(readRkBusinessEventJournal(u.searchParams), u.searchParams);
    const includeSnapshot = String(u.searchParams.get("include_snapshot") || "0") === "1";
    const items = page.items.map((item) => stripRkJournalPayload(item, { includeSnapshot }));
    sendJson(res, 200, {
      ok: true,
      ...page,
      items,
      source: "jsonl",
      generated_at: nowBjText(),
      snapshot_included: includeSnapshot,
    });
    return;
  }

  if ((pathname === "/api/rk/business-events/export" || pathname === "/api/business/events/export") && req.method === "GET") {
    const queryProblem = rkJournalQueryProblem(u.searchParams, { pagination: false });
    if (queryProblem) {
      sendJson(res, 400, { ok: false, ...queryProblem });
      return;
    }
    const rows = sortRkJournalRows(dedupeRkJournalRows(readRkBusinessEventJournal(u.searchParams))).map((item) => stripRkJournalPayload(item, { includeSnapshot: true }));
    const format = String(u.searchParams.get("format") || "csv").trim().toLowerCase();
    if (!sendRkJournalExport(res, rows, format, "rk-business-events", RK_BUSINESS_EVENT_EXPORT_HEADERS)) {
      sendJson(res, 400, { ok: false, error: "bad_format", message: "format must be csv or jsonl" });
    }
    return;
  }

  if (pathname === "/api/rk/user-message/config" && req.method === "GET") {
    const localVersion = Number(u.searchParams.get("version"));
    const device = cleanUserTemplate(u.searchParams.get("device") || "", 120);
    const targetVersion = Number(rkUserMessageConfig?.version || 1);
    const hasVersion = Number.isFinite(localVersion) && localVersion > 0;
    const noUpdate = hasVersion && localVersion >= targetVersion;
    rkReported.userMessageConfigPull = {
      time_bj: nowBjText(),
      device: device || null,
      local_version: hasVersion ? Math.floor(localVersion) : null,
      remote_version: targetVersion,
      result: noUpdate ? "not_modified" : "applied",
      status: noUpdate ? 204 : 200,
      path: "/api/rk/user-message/config",
    };
    if (noUpdate) {
      res.writeHead(204, {
        "Cache-Control": "no-store",
        "X-Config-Version": String(targetVersion),
      });
      res.end();
      return;
    }
    sendJson(res, 200, {
      ok: true,
      config: rkUserMessageConfig,
    });
    return;
  }

  if (pathname === "/api/rk/user-message/config" && req.method === "POST") {
    const raw = await readBody(req, 120_000);
    const body = safeJsonParse(raw) || {};
    const nextCfg = normalizeUserMessageConfig(body, { bumpVersion: true, baseConfig: rkUserMessageConfig });
    rkUserMessageConfig = saveUserMessageConfig(nextCfg);

    sendJson(res, 200, {
      ok: true,
      config: rkUserMessageConfig,
      mode: "cloud_pull",
      pull_path: "/api/rk/user-message/config",
      message: "配置已保存，等待 RK 主动拉取。",
      last_pull: rkReported.userMessageConfigPull,
    });
    return;
  }

  const mBizClear = pathname.match(/^\/api\/business\/(parking|etc)\/clear$/);
  if (mBizClear && req.method === "POST") {
    const system = mBizClear[1];
    const clearedAtMs = Date.now();
    const previousReported = {
      accounts: Array.isArray(rkBizReported[system]?.accounts) ? rkBizReported[system].accounts.slice() : [],
      records: Array.isArray(rkBizReported[system]?.records) ? rkBizReported[system].records.slice() : [],
      updatedAt: rkBizReported[system]?.updatedAt ?? null,
      report: rkBizReported[system]?.report || null,
    };
    const previousLocal = biz?.[system]
      ? { accounts: new Map(biz[system].accounts), records: biz[system].records.slice() }
      : null;
    rkBizReported[system].accounts = [];
    rkBizReported[system].records = [];
    // Keep an explicit, timestamped empty snapshot. Omitting the system would
    // allow an older JSON/MySQL snapshot to reappear after a restart.
    rkBizReported[system].updatedAt = clearedAtMs;
    rkBizReported[system].report = null;
    if (biz?.[system]) {
      try {
        biz[system].accounts.clear();
        biz[system].records.length = 0;
      } catch {}
    }
    if (!writeBizLatestSnapshot()) {
      Object.assign(rkBizReported[system], previousReported);
      if (previousLocal && biz?.[system]) {
        biz[system].accounts = previousLocal.accounts;
        biz[system].records = previousLocal.records;
      }
      sendJson(res, 507, { ok: false, error: "business_clear_persist_failed", message: "Unable to durably save the empty business snapshot" });
      return;
    }

    const mysqlPolicy = businessMysqlWritePolicy();
    const mysqlCleared = mysqlPolicy.enabled
      ? await mysqlClearBusinessSnapshot(system, clearedAtMs)
      : null;
    const event = {
      time_bj: nowBjText(),
      clear: system,
      snapshot_at_ms: clearedAtMs,
      persistence: {
        local_json: true,
        mysql_enabled: mysqlPolicy.enabled,
        mysql_required: mysqlPolicy.required,
        mysql_persisted: mysqlCleared !== false,
      },
    };
    if (!appendDurableJsonLine(path.join(logRoot, "business_events.jsonl"), event)) {
      sendJson(res, 507, {
        ok: false,
        error: "business_clear_event_persist_failed",
        cleared: true,
        snapshot_at_ms: clearedAtMs,
        persistence: event.persistence,
      });
      return;
    }
    if (mysqlPolicy.required && mysqlCleared !== true) {
      sendJson(res, 503, {
        ok: false,
        error: "business_clear_mysql_failed",
        message: "The empty snapshot is durable locally; retry to finish the MySQL tombstone",
        cleared: true,
        durable_local: true,
        snapshot_at_ms: clearedAtMs,
        persistence: event.persistence,
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      cleared: true,
      snapshot_at_ms: clearedAtMs,
      persistence: event.persistence,
    });
    return;
  }

  if (pathname === "/api/capture/start" && req.method === "POST") {
    apiState.captureRunning = true;
    sendJson(res, 200, { ok: true });
    return;
  }
  if (pathname === "/api/capture/stop" && req.method === "POST") {
    apiState.captureRunning = false;
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/infer/mode" && req.method === "POST") {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const mode = String(body?.mode ?? "");
    apiState.inferMode = ["plate", "env", "overlay"].includes(mode) ? mode : apiState.inferMode;
    sendJson(res, 200, { ok: true, mode: apiState.inferMode });
    return;
  }

  if (pathname === "/api/view" && req.method === "POST") {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const view = String(body?.view ?? "");
    apiState.view = view || apiState.view;
    sendJson(res, 200, { ok: true, view: apiState.view });
    return;
  }

  const mAccounts = pathname.match(/^\/api\/business\/(parking|etc)\/accounts$/);
  if (mAccounts && req.method === "GET") {
    const system = mAccounts[1];
    const db = await mysqlListBusinessAccounts(system, u.searchParams);
    const selectedSource = selectBusinessSnapshotSource(system, db);
    const rkAt = businessSnapshotAtMs(rkBizReported[system].updatedAt);
    const mysqlAt = businessSnapshotAtMs(db?.snapshot_at_ms);
    if (selectedSource === "mysql") {
      sendJson(res, 200, {
        items: db.items,
        total: db.total,
        demo: false,
        source: "mysql",
        snapshot_at_ms: mysqlAt || null,
        snapshot_age_ms: mysqlAt ? Date.now() - mysqlAt : null,
        mysql_snapshot_at_ms: mysqlAt || null,
        rk_updated_at_ms: rkAt || null,
        rk_updated_age_ms: rkAt ? Date.now() - rkAt : null,
        report: publicRkBusinessReport(system, mysqlAt || rkAt),
      });
      return;
    }
    if (selectedSource === "rk") {
      const result = queryRkAccounts(system, u.searchParams);
      sendJson(res, 200, {
        items: result.items,
        total: result.total,
        demo: false,
        source: rkBizIsActive(system) ? "rk" : "rk_cached",
        snapshot_at_ms: rkAt || null,
        snapshot_age_ms: rkAt ? Date.now() - rkAt : null,
        mysql_snapshot_at_ms: mysqlAt || null,
        rk_updated_at_ms: rkAt || null,
        rk_updated_age_ms: rkAt ? Date.now() - rkAt : null,
        report: publicRkBusinessReport(system, rkAt),
      });
      return;
    }
    const items = listAccounts(system, u.searchParams);
    sendJson(res, 200, { items, demo: DEMO_BIZ, source: DEMO_BIZ ? "demo" : "backend" });
    return;
  }

  const mRecords = pathname.match(/^\/api\/business\/(parking|etc)\/records$/);
  if (mRecords && req.method === "GET") {
    const system = mRecords[1];
    const db = await mysqlListBusinessRecords(system, u.searchParams);
    const selectedSource = selectBusinessSnapshotSource(system, db);
    const rkAt = businessSnapshotAtMs(rkBizReported[system].updatedAt);
    const mysqlAt = businessSnapshotAtMs(db?.snapshot_at_ms);
    if (selectedSource === "mysql") {
      sendJson(res, 200, {
        items: db.items,
        total: db.total,
        demo: false,
        source: "mysql",
        snapshot_at_ms: mysqlAt || null,
        snapshot_age_ms: mysqlAt ? Date.now() - mysqlAt : null,
        mysql_snapshot_at_ms: mysqlAt || null,
        rk_updated_at_ms: rkAt || null,
        rk_updated_age_ms: rkAt ? Date.now() - rkAt : null,
        report: publicRkBusinessReport(system, mysqlAt || rkAt),
      });
      return;
    }
    if (selectedSource === "rk") {
      const result = queryRkRecords(system, u.searchParams);
      sendJson(res, 200, {
        items: result.items,
        total: result.total,
        demo: false,
        source: rkBizIsActive(system) ? "rk" : "rk_cached",
        snapshot_at_ms: rkAt || null,
        snapshot_age_ms: rkAt ? Date.now() - rkAt : null,
        mysql_snapshot_at_ms: mysqlAt || null,
        rk_updated_at_ms: rkAt || null,
        rk_updated_age_ms: rkAt ? Date.now() - rkAt : null,
        report: publicRkBusinessReport(system, rkAt),
      });
      return;
    }
    const items = listRecords(system, u.searchParams);
    sendJson(res, 200, { items, demo: DEMO_BIZ, source: DEMO_BIZ ? "demo" : "backend" });
    return;
  }

  const mOpen = pathname.match(/^\/api\/business\/(parking|etc)\/open$/);
  if (mOpen && req.method === "POST") {
    const system = mOpen[1];
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const plate = String(body?.plate ?? "").trim();
    const amount = body?.amount === undefined || body?.amount === null || body?.amount === "" ? null : parseNumber(body?.amount);
    if (!plate) {
      sendJson(res, 400, { ok: false, error: "bad_plate" });
      return;
    }
    if (amount !== null && amount < 0) {
      sendJson(res, 400, { ok: false, error: "bad_params" });
      return;
    }
    await handleForwardedBusinessOp(res, system, "open", { plate, amount }, 2200);
    return;
  }

  const mClose = pathname.match(/^\/api\/business\/(parking|etc)\/close$/);
  if (mClose && req.method === "POST") {
    const system = mClose[1];
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const plate = String(body?.plate ?? "").trim();
    if (!plate) {
      sendJson(res, 400, { ok: false, error: "bad_plate" });
      return;
    }
    await handleForwardedBusinessOp(res, system, "close", { plate }, 2200);
    return;
  }

  const mRecharge = pathname.match(/^\/api\/business\/(parking|etc)\/recharge$/);
  if (mRecharge && req.method === "POST") {
    const system = mRecharge[1];
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const plate = String(body?.plate ?? "").trim();
    const amount = parseNumber(body?.amount);
    if (!plate || amount === null || amount <= 0) {
      sendJson(res, 400, { ok: false, error: "bad_params" });
      return;
    }
    await handleForwardedBusinessOp(res, system, "recharge", { plate, amount }, 2400);
    return;
  }

  const mDebit = pathname.match(/^\/api\/business\/(parking|etc)\/debit$/);
  if (mDebit && req.method === "POST") {
    const system = mDebit[1];
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const plate = String(body?.plate ?? "").trim();
    const amount = parseNumber(body?.amount);
    if (!plate || amount === null || amount === 0) {
      sendJson(res, 400, { ok: false, error: "bad_params" });
      return;
    }
    await handleForwardedBusinessOp(res, system, "debit", { plate, amount }, 2400);
    return;
  }

  const mExport = pathname.match(/^\/api\/business\/(parking|etc)\/export\/(accounts|records)$/);
  if (mExport && req.method === "GET") {
    const system = mExport[1];
    const kind = mExport[2];
    if (kind === "accounts") {
      const db = await mysqlListBusinessAccounts(system, u.searchParams);
      const source = selectBusinessSnapshotSource(system, db);
      const items = source === "mysql" ? db.items : source === "rk" ? listRkAccounts(system, u.searchParams) : listAccounts(system, u.searchParams);
      const csv = toCsv(items, ["plate", "balance", "arrears", "status", "updated_at"]);
      send(res, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${system}_accounts.csv"` }, csv);
      return;
    }
    if (kind === "records") {
      const db = await mysqlListBusinessRecords(system, u.searchParams);
      const source = selectBusinessSnapshotSource(system, db);
      const items = source === "mysql" ? db.items : source === "rk" ? listRkRecords(system, u.searchParams) : listRecords(system, u.searchParams);
      const csv = toCsv(items, ["time_bj", "plate", "source", "delta", "balance", "arrears", "result"]);
      send(res, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${system}_records.csv"` }, csv);
      return;
    }
  }

  if (serveStatic(req, res, pathname)) return;
  notFound(res);
  } catch (e) {
    if (res.writableEnded) return;
    const status = Number(e?.status) || 500;
    const code = String(e?.code || e?.error || "server_error");
    const message = String(e?.message || e);
    sendJson(res, status, { ok: false, error: code, message, ...(e?.limit ? { limit: e.limit } : {}) });
  }
});

const HOST = process.env.HOST || "0.0.0.0";
const PORT = clamp(parseInt(process.env.PORT || "8080", 10), 1, 65535);
const PORT_FROM_ENV = Object.prototype.hasOwnProperty.call(process.env, "PORT");
let currentPort = PORT;
let tried = 0;

function tryListen() {
  tried += 1;
  server.listen(currentPort, HOST, () => {
    process.stdout.write(`HTTP backend: http://${HOST}:${currentPort}/\n`);
    if (aiPython.engine === "python") {
      setTimeout(() => {
        try {
          startAiPython();
        } catch (e) {
          aiPython.lastError = { ok: false, error: "python_autostart_failed", message: String(e?.message || e) };
        }
      }, 300);
    }
  });
}

const wifiCarWss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
server.on("upgrade", (req, socket, head) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || "localhost"}`); } catch {}
  if (url?.pathname !== "/device/wifi-car") return;
  const auth = String(req.headers.authorization || "");
  const supplied = Buffer.from(auth.startsWith("Bearer ") ? auth.slice(7) : "");
  const expected = Buffer.from(wifiCarDeviceToken);
  if (expected.length < 32 || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wifiCarWss.handleUpgrade(req, socket, head, (ws) => {
    wifiCarWss.emit("connection", ws, req);
    wifiCarBridge.attach(ws);
  });
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE" && !PORT_FROM_ENV && tried < 12) {
    const next = currentPort + 1;
    if (next <= 65535) {
      process.stdout.write(`Port ${currentPort} in use, try ${next}\n`);
      currentPort = next;
      setTimeout(() => tryListen(), 50);
      return;
    }
  }
  process.stderr.write(String(err?.stack || err) + "\n");
  process.exit(1);
});

function shutdown(reason) {
  process.stdout.write(`HTTP backend stopping: ${reason}\n`);
  // The WifiCar firmware stops the motors when its persistent TCP client disconnects.
  clearInterval(rkCommandTimer);
  wifiCarBridge.close();
  try {
    server.close(() => {
      process.stdout.write("HTTP backend stopped\n");
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1200);
  } catch {
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const deviceHealthTimer = setInterval(() => {
  recordDeviceHealth(false);
}, 30_000);
deviceHealthTimer.unref?.();
setTimeout(() => recordDeviceHealth(true), 1000).unref?.();

try {
  restoreEsp32CommandState();
} catch (error) {
  process.stderr.write(`ESP32 command state restore failed: ${String(error?.stack || error)}\n`);
}

tryListen();
