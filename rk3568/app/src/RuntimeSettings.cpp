#include "RuntimeSettings.h"

#include "generic_yolo.h"
#include "yolo.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QDebug>
#include <QSaveFile>
#include <QStandardPaths>
#include <QtGlobal>
#include <algorithm>

namespace {

int clampInt(int v, int lo, int hi) {
    return std::max(lo, std::min(hi, v));
}

float clampFloat(float v, float lo, float hi) {
    return std::max(lo, std::min(hi, v));
}

bool envBool(const char *name, bool def) {
    const QByteArray v = qgetenv(name).trimmed().toLower();
    if (v.isEmpty()) return def;
    return !(v == "0" || v == "false" || v == "off" || v == "no");
}

int envInt(const char *name, int def, int lo, int hi) {
    const QByteArray v = qgetenv(name).trimmed();
    if (v.isEmpty()) return def;
    bool ok = false;
    const int x = v.toInt(&ok);
    return ok ? clampInt(x, lo, hi) : def;
}

QString envString(const char *name, const QString &def) {
    const QByteArray v = qgetenv(name).trimmed();
    return v.isEmpty() ? def : QString::fromLocal8Bit(v);
}

RuntimeSettingsData clampSettings(RuntimeSettingsData s) {
    s.plateConf = clampFloat(s.plateConf, 0.01f, 0.999f);
    s.pose26P3Conf = clampFloat(s.pose26P3Conf, 0.001f, 0.999f);
    s.pose26P4Conf = clampFloat(s.pose26P4Conf, 0.001f, 0.999f);
    s.pose26P5Conf = clampFloat(s.pose26P5Conf, 0.001f, 0.999f);
    s.envConf = clampFloat(s.envConf, 0.01f, 0.999f);
    s.algoMode = clampInt(s.algoMode, 0, 2);
    s.sdImageIntervalSec = clampInt(s.sdImageIntervalSec, 1, 5);
    s.plateOcrPeriod = clampInt(s.plateOcrPeriod, 1, 60);
    s.plateInferStride = clampInt(s.plateInferStride, 1, 60);
    s.pcieInferenceStrategy = clampInt(s.pcieInferenceStrategy, 0, 1);
    s.detPreprocessBackend = clampInt(s.detPreprocessBackend, 0, 2);
    s.detectorProfile = clampInt(s.detectorProfile, 0, 8);
    s.recognizerProfile = clampInt(s.recognizerProfile, 0, 2);
    s.plateGeometryMinShortEdge = clampInt(
        s.plateGeometryMinShortEdge, 1, 200);
    s.plateGeometryMinArea = clampInt(
        s.plateGeometryMinArea, 1, 100000);
    s.plateGeometryMinAspectX100 = clampInt(
        s.plateGeometryMinAspectX100, 100, 1000);
    s.plateGeometryMaxAspectX100 = clampInt(
        s.plateGeometryMaxAspectX100,
        s.plateGeometryMinAspectX100, 1000);
    s.plateMinShortEdge = clampInt(s.plateMinShortEdge, 4, 80);
    s.plateMinSharpness = clampInt(s.plateMinSharpness, 0, 500);
    s.envInferStride = clampInt(s.envInferStride, 1, 60);
    s.plateStableRequired = clampInt(s.plateStableRequired, 1, 10);
    s.plateBoxHoldRuns = clampInt(s.plateBoxHoldRuns, 0, 3);
    s.plateCooldownFrames = clampInt(s.plateCooldownFrames, 0, 3000);
    s.drawOverlay = s.drawOverlay ? 1 : 0;
    s.drawText = s.drawText ? 1 : 0;
    s.drawSplit = s.drawSplit ? 1 : 0;
    s.blackVMax = clampInt(s.blackVMax, 0, 255);
    s.whiteSMax = clampInt(s.whiteSMax, 0, 255);
    s.blueHMin = clampInt(s.blueHMin, 0, 180);
    s.greenHMin = clampInt(s.greenHMin, 0, 180);
    s.yellowHMin = clampInt(s.yellowHMin, 0, 180);
    s.yellowHMax = clampInt(s.yellowHMax, 0, 180);
    s.modelTrustVal = clampFloat(s.modelTrustVal, 0.0f, 1.0f);
    s.minColorRatio = clampFloat(s.minColorRatio, 0.0f, 1.0f);
    s.recConfThreshold = clampInt(s.recConfThreshold, 0, 1000);
    s.doubleUpperRatio = clampInt(s.doubleUpperRatio, 0, 1000);
    s.doubleLowerStart = clampInt(s.doubleLowerStart, 0, 1000);
    s.theme = clampInt(s.theme, 0, 2);
    s.audioOutputDevice = s.audioOutputDevice.trimmed();
    if (s.audioOutputDevice.isEmpty()) s.audioOutputDevice = "default";
    s.targetDeviceId = s.targetDeviceId.trimmed();
    if (s.targetDeviceId.isEmpty()) s.targetDeviceId = "esp32-servo-01";
    return s;
}

RuntimeSettingsData applyEnvDefaults(RuntimeSettingsData s) {
    s.pose26HeadConfEnabled = envBool(
        "RK3568_POSE26_HEAD_CONF_ENABLED", s.pose26HeadConfEnabled);
    s.pose26P3Conf = static_cast<float>(envInt(
        "RK3568_POSE26_P3_CONF_X1000",
        static_cast<int>(s.pose26P3Conf * 1000.0f), 1, 999)) / 1000.0f;
    s.pose26P4Conf = static_cast<float>(envInt(
        "RK3568_POSE26_P4_CONF_X1000",
        static_cast<int>(s.pose26P4Conf * 1000.0f), 1, 999)) / 1000.0f;
    s.pose26P5Conf = static_cast<float>(envInt(
        "RK3568_POSE26_P5_CONF_X1000",
        static_cast<int>(s.pose26P5Conf * 1000.0f), 1, 999)) / 1000.0f;
    s.sdImageIntervalSec = envInt("RK3568_SD_IMAGE_INTERVAL_SEC", s.sdImageIntervalSec, 1, 5);
    s.globalInferenceEnabled = envBool(
        "RK3568_GLOBAL_INFERENCE", s.globalInferenceEnabled);
    s.plateOcrPeriod = envInt("RK3568_PLATE_OCR_PERIOD", s.plateOcrPeriod, 1, 60);
    s.plateInferStride = envInt("RK3568_PLATE_INFER_STRIDE", s.plateInferStride, 1, 60);
    s.pcieInferenceStrategy = envInt(
        "RK3568_PCIE_INFERENCE_STRATEGY", s.pcieInferenceStrategy, 0, 1);
    if (qgetenv("RK3568_PCIE_INFERENCE_STRATEGY").trimmed().isEmpty() &&
        envBool("RK3568_PCIE_FOUR_SOURCE_SLIDING", false)) {
        s.pcieInferenceStrategy = 1;
    }
    s.detPipelineEnabled = envBool(
        "RK3568_DET_PIPELINE", s.detPipelineEnabled);
    s.detPreprocessBackend = envInt(
        "RK3568_DET_PREPROCESS_BACKEND", s.detPreprocessBackend, 0, 2);
    s.detQuantizedOutput = envBool(
        "RK3568_DET_QUANTIZED_OUTPUT", s.detQuantizedOutput);
    s.detectorProfile = envInt(
        "RK3568_PLATE_DETECTOR_PROFILE", s.detectorProfile, 0, 8);
    s.recognizerProfile = envInt(
        "RK3568_PLATE_RECOGNIZER_PROFILE", s.recognizerProfile, 0, 2);
    s.plateShowUnconfirmed = envBool(
        "RK3568_SHOW_UNCONFIRMED_PLATES", s.plateShowUnconfirmed);
    s.plateShowUnconfirmed = envBool(
        "RK3568_SHOW_SUSPECTED_PLATES", s.plateShowUnconfirmed);
    s.plateGeometryFilterEnabled = envBool(
        "RK3568_PLATE_GEOMETRY_FILTER", s.plateGeometryFilterEnabled);
    s.plateGeometryMinShortEdge = envInt(
        "RK3568_PLATE_GEOMETRY_MIN_SHORT_EDGE",
        s.plateGeometryMinShortEdge, 1, 200);
    s.plateGeometryMinArea = envInt(
        "RK3568_PLATE_GEOMETRY_MIN_AREA",
        s.plateGeometryMinArea, 1, 100000);
    s.plateGeometryMinAspectX100 = envInt(
        "RK3568_PLATE_GEOMETRY_MIN_ASPECT_X100",
        s.plateGeometryMinAspectX100, 100, 1000);
    s.plateGeometryMaxAspectX100 = envInt(
        "RK3568_PLATE_GEOMETRY_MAX_ASPECT_X100",
        s.plateGeometryMaxAspectX100, 100, 1000);
    s.plateMinShortEdge = envInt(
        "RK3568_PLATE_MIN_SHORT_EDGE", s.plateMinShortEdge, 4, 80);
    s.plateMinSharpness = envInt(
        "RK3568_PLATE_MIN_SHARPNESS", s.plateMinSharpness, 0, 500);
    s.envInferStride = envInt("RK3568_ENV_INFER_STRIDE", s.envInferStride, 1, 60);
    s.plateStableRequired = envInt("RK3568_PLATE_STABLE_REQUIRED", s.plateStableRequired, 1, 10);
    s.plateBoxHoldRuns = envInt(
        "RK3568_PLATE_BOX_HOLD_RUNS", s.plateBoxHoldRuns, 0, 3);
    s.plateCooldownFrames = envInt("RK3568_PLATE_COOLDOWN_FRAMES", s.plateCooldownFrames, 0, 3000);
    s.plateUploadThumb = envBool("RK3568_PLATE_UPLOAD_THUMB", s.plateUploadThumb);
    s.drawOverlay = envInt("RK3568_DRAW_OVERLAY", s.drawOverlay, 0, 1);
    s.drawText = envInt("RK3568_DRAW_TEXT", s.drawText, 0, 1);
    s.drawSplit = envInt("RK3568_DRAW_SPLIT", s.drawSplit, 0, 1);
    s.envEnable = envBool("RK3568_ENV_ENABLE", s.envEnable);
    s.showDetParts = envBool("RK3568_SHOW_DET_PARTS", s.showDetParts);
    s.audioOutputDevice = envString("RK3568_TTS_DEVICE", s.audioOutputDevice);
    s.targetDeviceId = envString("RK3568_TARGET_DEVICE_ID", s.targetDeviceId);
    return clampSettings(s);
}

void readJson(RuntimeSettingsData &s, const QJsonObject &o) {
    auto b = [&o](const char *k, bool def) {
        return o.contains(k) ? o.value(k).toBool(def) : def;
    };
    auto i = [&o](const char *k, int def) {
        return o.contains(k) ? o.value(k).toInt(def) : def;
    };
    auto f = [&o](const char *k, float def) {
        return o.contains(k) ? (float)o.value(k).toDouble(def) : def;
    };

    s.plateConf = f("plate_conf", s.plateConf);
    s.pose26HeadConfEnabled = b(
        "pose26_head_conf_enabled", s.pose26HeadConfEnabled);
    s.pose26P3Conf = f("pose26_p3_conf", s.pose26P3Conf);
    s.pose26P4Conf = f("pose26_p4_conf", s.pose26P4Conf);
    s.pose26P5Conf = f("pose26_p5_conf", s.pose26P5Conf);
    s.envConf = f("env_conf", s.envConf);
    s.algoMode = i("algo_mode", s.algoMode);
    s.dedupeBySource = b("dedupe_by_source", s.dedupeBySource);
    s.sdImageIntervalSec = i("sd_image_interval_sec", s.sdImageIntervalSec);
    s.globalInferenceEnabled = b(
        "global_inference_enabled", s.globalInferenceEnabled);
    s.plateOcrPeriod = i("plate_ocr_period", s.plateOcrPeriod);
    s.plateInferStride = i("plate_infer_stride", s.plateInferStride);
    const QString settingsSchema = o.value("schema").toString();
    const bool migrateLegacyPcieDefault =
        settingsSchema.isEmpty() || settingsSchema == "rk3568.runtime_settings.v2";
    if (o.contains("pcie_inference_strategy")) {
        s.pcieInferenceStrategy = i(
            "pcie_inference_strategy", s.pcieInferenceStrategy);
        // v2 wrote the old mosaic default into every saved settings file.
        // Treat that value as a legacy default once; an explicit choice made
        // after this migration is stored under the v3 schema and preserved.
        if (migrateLegacyPcieDefault && s.pcieInferenceStrategy == 0) {
            s.pcieInferenceStrategy = 1;
        }
    } else if (b("pcie_four_source_sliding", false)) {
        s.pcieInferenceStrategy = 1;
    }
    s.detPipelineEnabled = b(
        "det_pipeline_enabled", s.detPipelineEnabled);
    s.detPreprocessBackend = i(
        "det_preprocess_backend", s.detPreprocessBackend);
    s.detQuantizedOutput = b(
        "det_quantized_output", s.detQuantizedOutput);
    s.detectorProfile = i("detector_profile", s.detectorProfile);
    s.recognizerProfile = i("recognizer_profile", s.recognizerProfile);
    // The new key deliberately defaults to true instead of inheriting the old
    // debug-only false value. This migrates existing installations to the
    // three-state display without overwriting the rest of their configuration.
    if (o.contains("plate_show_suspected")) {
        s.plateShowUnconfirmed =
            o.value("plate_show_suspected").toBool(s.plateShowUnconfirmed);
    }
    s.plateGeometryFilterEnabled = b(
        "plate_geometry_filter_enabled", s.plateGeometryFilterEnabled);
    s.plateGeometryMinShortEdge = i(
        "plate_geometry_min_short_edge", s.plateGeometryMinShortEdge);
    s.plateGeometryMinArea = i(
        "plate_geometry_min_area", s.plateGeometryMinArea);
    s.plateGeometryMinAspectX100 = i(
        "plate_geometry_min_aspect_x100", s.plateGeometryMinAspectX100);
    s.plateGeometryMaxAspectX100 = i(
        "plate_geometry_max_aspect_x100", s.plateGeometryMaxAspectX100);
    s.plateMinShortEdge = i("plate_min_short_edge", s.plateMinShortEdge);
    s.plateMinSharpness = i("plate_min_sharpness", s.plateMinSharpness);
    s.envInferStride = i("env_infer_stride", s.envInferStride);
    s.plateStableRequired = i("plate_stable_required", s.plateStableRequired);
    s.plateBoxHoldRuns = i("plate_box_hold_runs", s.plateBoxHoldRuns);
    s.plateCooldownFrames = i("plate_cooldown_frames", s.plateCooldownFrames);
    s.plateUploadThumb = b("plate_upload_thumb", s.plateUploadThumb);
    s.drawOverlay = i("draw_overlay", s.drawOverlay);
    s.drawText = i("draw_text", s.drawText);
    s.drawSplit = i("draw_split", s.drawSplit);
    s.envEnable = b("env_enable", s.envEnable);
    s.showDetParts = b("show_det_parts", s.showDetParts);
    s.blackVMax = i("black_v_max", s.blackVMax);
    s.whiteSMax = i("white_s_max", s.whiteSMax);
    s.blueHMin = i("blue_h_min", s.blueHMin);
    s.greenHMin = i("green_h_min", s.greenHMin);
    s.yellowHMin = i("yellow_h_min", s.yellowHMin);
    s.yellowHMax = i("yellow_h_max", s.yellowHMax);
    s.modelTrustVal = f("model_trust_val", s.modelTrustVal);
    s.minColorRatio = f("min_color_ratio", s.minColorRatio);
    s.recConfThreshold = i("rec_conf_threshold", s.recConfThreshold);
    s.doubleUpperRatio = i("double_upper_ratio", s.doubleUpperRatio);
    s.doubleLowerStart = i("double_lower_start", s.doubleLowerStart);
    s.theme = i("theme", s.theme);
    if (o.contains("audio_output_device")) {
        s.audioOutputDevice = o.value("audio_output_device").toString(s.audioOutputDevice).trimmed();
    }
    if (o.contains("target_device_id")) {
        s.targetDeviceId = o.value("target_device_id").toString(s.targetDeviceId).trimmed();
    }
}

QJsonObject runtimeSettingsToJsonInternal(const RuntimeSettingsData &s) {
    QJsonObject o;
    o.insert("schema", "rk3568.runtime_settings.v10");
    o.insert("plate_conf", s.plateConf);
    o.insert("pose26_head_conf_enabled", s.pose26HeadConfEnabled);
    o.insert("pose26_p3_conf", s.pose26P3Conf);
    o.insert("pose26_p4_conf", s.pose26P4Conf);
    o.insert("pose26_p5_conf", s.pose26P5Conf);
    o.insert("env_conf", s.envConf);
    o.insert("algo_mode", s.algoMode);
    o.insert("dedupe_by_source", s.dedupeBySource);
    o.insert("sd_image_interval_sec", s.sdImageIntervalSec);
    o.insert("global_inference_enabled", s.globalInferenceEnabled);
    o.insert("plate_ocr_period", s.plateOcrPeriod);
    o.insert("plate_infer_stride", s.plateInferStride);
    // Compatibility marker for older cloud parsers. Sliding-window inference
    // was removed in v10.3 and cannot be re-enabled by JSON or environment.
    o.insert("plate_sliding_mode", 2);
    o.insert("plate_sliding_enabled", false);
    o.insert("pcie_inference_strategy", s.pcieInferenceStrategy);
    o.insert("pcie_four_source_sliding", false);
    o.insert("det_pipeline_enabled", s.detPipelineEnabled);
    o.insert("det_preprocess_backend", s.detPreprocessBackend);
    o.insert("det_quantized_output", s.detQuantizedOutput);
    o.insert("detector_profile", s.detectorProfile);
    o.insert("recognizer_profile", s.recognizerProfile);
    o.insert("plate_show_unconfirmed", s.plateShowUnconfirmed);
    o.insert("plate_show_suspected", s.plateShowUnconfirmed);
    o.insert("plate_geometry_filter_enabled", s.plateGeometryFilterEnabled);
    o.insert("plate_geometry_min_short_edge", s.plateGeometryMinShortEdge);
    o.insert("plate_geometry_min_area", s.plateGeometryMinArea);
    o.insert("plate_geometry_min_aspect_x100", s.plateGeometryMinAspectX100);
    o.insert("plate_geometry_max_aspect_x100", s.plateGeometryMaxAspectX100);
    o.insert("plate_min_short_edge", s.plateMinShortEdge);
    o.insert("plate_min_sharpness", s.plateMinSharpness);
    o.insert("env_infer_stride", s.envInferStride);
    o.insert("plate_stable_required", s.plateStableRequired);
    o.insert("plate_box_hold_runs", s.plateBoxHoldRuns);
    o.insert("plate_cooldown_frames", s.plateCooldownFrames);
    o.insert("plate_upload_thumb", s.plateUploadThumb);
    o.insert("draw_overlay", s.drawOverlay);
    o.insert("draw_text", s.drawText);
    o.insert("draw_split", s.drawSplit);
    o.insert("env_enable", s.envEnable);
    o.insert("show_det_parts", s.showDetParts);
    o.insert("black_v_max", s.blackVMax);
    o.insert("white_s_max", s.whiteSMax);
    o.insert("blue_h_min", s.blueHMin);
    o.insert("green_h_min", s.greenHMin);
    o.insert("yellow_h_min", s.yellowHMin);
    o.insert("yellow_h_max", s.yellowHMax);
    o.insert("model_trust_val", s.modelTrustVal);
    o.insert("min_color_ratio", s.minColorRatio);
    o.insert("rec_conf_threshold", s.recConfThreshold);
    o.insert("double_upper_ratio", s.doubleUpperRatio);
    o.insert("double_lower_start", s.doubleLowerStart);
    o.insert("theme", s.theme);
    o.insert("audio_output_device", s.audioOutputDevice);
    o.insert("target_device_id", s.targetDeviceId);
    return o;
}

bool applyRuntimeSettingsJsonInternal(RuntimeSettingsData &settings, const QJsonObject &json) {
    if (json.isEmpty()) return false;
    readJson(settings, json);
    settings = clampSettings(settings);
    return true;
}

} // namespace

QJsonObject runtimeSettingsToJson(const RuntimeSettingsData &settings) {
    return runtimeSettingsToJsonInternal(clampSettings(settings));
}

bool applyRuntimeSettingsJson(RuntimeSettingsData &settings, const QJsonObject &json) {
    return applyRuntimeSettingsJsonInternal(settings, json);
}

QString runtimeSettingsPath() {
    const QByteArray envPath = qgetenv("RK3568_RUNTIME_SETTINGS_PATH");
    if (!envPath.isEmpty()) return QString::fromUtf8(envPath);
    QString base = QStandardPaths::writableLocation(QStandardPaths::AppConfigLocation);
    if (base.isEmpty()) base = QDir::homePath();
    return QDir(base).filePath("runtime_settings.json");
}

RuntimeSettingsData loadRuntimeSettings() {
    RuntimeSettingsData s = applyEnvDefaults(RuntimeSettingsData{});
    QFile f(runtimeSettingsPath());
    if (f.open(QIODevice::ReadOnly | QIODevice::Text)) {
        const QJsonObject o = QJsonDocument::fromJson(f.readAll()).object();
        if (!o.isEmpty()) readJson(s, o);
    }
    // The launcher can select a fixed inference mode for a deployment bundle.
    // This must be applied after JSON loading so an old desktop setting cannot
    // silently switch an environment-only bundle back to plate recognition.
    if (!qgetenv("RK3568_ALGO_MODE").trimmed().isEmpty()) {
        s.algoMode = envInt("RK3568_ALGO_MODE", s.algoMode, 0, 2);
    }
    // This diagnostic switch is intentionally a real startup override. It
    // must be possible to run one display-only session without editing the
    // persisted GUI settings file.
    if (!qgetenv("RK3568_GLOBAL_INFERENCE").trimmed().isEmpty()) {
        s.globalInferenceEnabled = envBool(
            "RK3568_GLOBAL_INFERENCE", s.globalInferenceEnabled);
    }
    // Unlike the normal GUI settings, an explicitly supplied PCIe strategy is
    // a diagnostic/performance override and must win over a saved JSON value.
    if (!qgetenv("RK3568_PCIE_INFERENCE_STRATEGY").trimmed().isEmpty()) {
        s.pcieInferenceStrategy = envInt(
            "RK3568_PCIE_INFERENCE_STRATEGY", s.pcieInferenceStrategy, 0, 1);
    }
    return clampSettings(s);
}

bool saveRuntimeSettings(const RuntimeSettingsData &settings) {
    const RuntimeSettingsData s = clampSettings(settings);
    const QString p = runtimeSettingsPath();
    QDir().mkpath(QFileInfo(p).absolutePath());
    QSaveFile f(p);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        qWarning() << "saveRuntimeSettings: open failed:" << p << f.errorString();
        return false;
    }
    f.write(QJsonDocument(runtimeSettingsToJsonInternal(s)).toJson(QJsonDocument::Indented));
    if (!f.commit()) {
        qWarning() << "saveRuntimeSettings: commit failed:" << p << f.errorString();
        return false;
    }
    return true;
}

void applyRuntimeSettingsToProcess(const RuntimeSettingsData &settings) {
    const RuntimeSettingsData s = clampSettings(settings);
    qputenv("RK3568_ALGO_MODE", QByteArray::number(s.algoMode));
    qputenv("RK3568_SD_IMAGE_INTERVAL_SEC", QByteArray::number(s.sdImageIntervalSec));
    qputenv("RK3568_GLOBAL_INFERENCE",
            s.globalInferenceEnabled ? "1" : "0");
    qputenv("RK3568_PLATE_OCR_PERIOD", QByteArray::number(s.plateOcrPeriod));
    qputenv("RK3568_PLATE_INFER_STRIDE", QByteArray::number(s.plateInferStride));
    qputenv("RK3568_POSE26_HEAD_CONF_ENABLED",
            s.pose26HeadConfEnabled ? "1" : "0");
    qputenv("RK3568_POSE26_P3_CONF_X1000",
            QByteArray::number(static_cast<int>(s.pose26P3Conf * 1000.0f)));
    qputenv("RK3568_POSE26_P4_CONF_X1000",
            QByteArray::number(static_cast<int>(s.pose26P4Conf * 1000.0f)));
    qputenv("RK3568_POSE26_P5_CONF_X1000",
            QByteArray::number(static_cast<int>(s.pose26P5Conf * 1000.0f)));
    qputenv("RK3568_PLATE_SLIDING_MODE", "2");
    qunsetenv("RK3568_PLATE_SLIDING_MODE_OVERRIDE");
    qunsetenv("RK3568_PLATE_SLIDING_CONF");
    qunsetenv("RK3568_PLATE_SLIDING_MAX_SIDE");
    qputenv("RK3568_PCIE_INFERENCE_STRATEGY",
            QByteArray::number(s.pcieInferenceStrategy));
    qputenv("RK3568_PCIE_FOUR_SOURCE_SLIDING", "0");
    qputenv("RK3568_DET_PIPELINE", s.detPipelineEnabled ? "1" : "0");
    qputenv("RK3568_DET_PREPROCESS_BACKEND",
            QByteArray::number(s.detPreprocessBackend));
    qputenv("RK3568_DET_QUANTIZED_OUTPUT",
            s.detQuantizedOutput ? "1" : "0");
    qputenv("RK3568_PLATE_DETECTOR_PROFILE",
            QByteArray::number(s.detectorProfile));
    qputenv("RK3568_PLATE_RECOGNIZER_PROFILE",
            QByteArray::number(s.recognizerProfile));
    qputenv("RK3568_DET_WANT_FLOAT",
            s.detQuantizedOutput ? "0" : "1");
    qputenv("RK3568_SHOW_UNCONFIRMED_PLATES", s.plateShowUnconfirmed ? "1" : "0");
    qputenv("RK3568_SHOW_SUSPECTED_PLATES", s.plateShowUnconfirmed ? "1" : "0");
    qputenv("RK3568_PLATE_GEOMETRY_FILTER",
            s.plateGeometryFilterEnabled ? "1" : "0");
    qputenv("RK3568_PLATE_GEOMETRY_MIN_SHORT_EDGE",
            QByteArray::number(s.plateGeometryMinShortEdge));
    qputenv("RK3568_PLATE_GEOMETRY_MIN_AREA",
            QByteArray::number(s.plateGeometryMinArea));
    qputenv("RK3568_PLATE_GEOMETRY_MIN_ASPECT_X100",
            QByteArray::number(s.plateGeometryMinAspectX100));
    qputenv("RK3568_PLATE_GEOMETRY_MAX_ASPECT_X100",
            QByteArray::number(s.plateGeometryMaxAspectX100));
    qputenv("RK3568_PLATE_MIN_SHORT_EDGE", QByteArray::number(s.plateMinShortEdge));
    qputenv("RK3568_PLATE_MIN_SHARPNESS", QByteArray::number(s.plateMinSharpness));
    qputenv("RK3568_ENV_INFER_STRIDE", QByteArray::number(s.envInferStride));
    qputenv("RK3568_PLATE_STABLE_REQUIRED", QByteArray::number(s.plateStableRequired));
    qputenv("RK3568_PLATE_BOX_HOLD_RUNS",
            QByteArray::number(s.plateBoxHoldRuns));
    qputenv("RK3568_PLATE_COOLDOWN_FRAMES", QByteArray::number(s.plateCooldownFrames));
    qputenv("RK3568_PLATE_UPLOAD_THUMB", s.plateUploadThumb ? "1" : "0");
    qputenv("RK3568_DRAW_OVERLAY", QByteArray::number(s.drawOverlay));
    qputenv("RK3568_DRAW_TEXT", QByteArray::number(s.drawText));
    qputenv("RK3568_DRAW_SPLIT", QByteArray::number(s.drawSplit));
    qputenv("RK3568_ENV_ENABLE", s.envEnable ? "1" : "0");
    qputenv("RK3568_SHOW_DET_PARTS", s.showDetParts ? "1" : "0");
    qputenv("RK3568_TTS_DEVICE", s.audioOutputDevice.toLocal8Bit());
    qputenv("RK3568_TARGET_DEVICE_ID", s.targetDeviceId.toLocal8Bit());

    set_yolo_threshold(s.plateConf, 0.45f);
    yolo_set_pose26_head_thresholds(
        s.pose26HeadConfEnabled, s.pose26P3Conf, s.pose26P4Conf,
        s.pose26P5Conf);
    generic_set_threshold(s.envConf, 0.4f);
    yolo_set_dedupe_by_source(s.dedupeBySource);
    yolo_set_detector_profile(s.detectorProfile);
    yolo_set_recognizer_profile(s.recognizerProfile);
    yolo_set_detector_quantized_output(s.detQuantizedOutput);

    g_color_cfg.black_v_max = s.blackVMax;
    g_color_cfg.white_s_max = s.whiteSMax;
    g_color_cfg.blue_h_min = s.blueHMin;
    g_color_cfg.green_h_min = s.greenHMin;
    g_color_cfg.yellow_h_min = s.yellowHMin;
    g_color_cfg.yellow_h_max = s.yellowHMax;
    g_color_cfg.model_trust_val = s.modelTrustVal;
    g_color_cfg.min_color_ratio = s.minColorRatio;
    g_color_cfg.rec_conf_threshold = s.recConfThreshold;
    g_color_cfg.double_upper_ratio = s.doubleUpperRatio;
    g_color_cfg.double_lower_start = s.doubleLowerStart;
}
