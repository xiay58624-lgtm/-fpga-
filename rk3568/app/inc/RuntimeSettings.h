#pragma once

#include <QJsonObject>
#include <QString>

struct RuntimeSettingsData {
    float plateConf = 0.25f;
    bool pose26HeadConfEnabled = false;
    float pose26P3Conf = 0.10f;
    float pose26P4Conf = 0.10f;
    float pose26P5Conf = 0.10f;
    float envConf = 0.5f;
    int algoMode = 0;
    bool dedupeBySource = true;
    int sdImageIntervalSec = 1;

    // Keep capture, preview, and GUI active while bypassing every inference
    // stage. This is enabled by default so existing deployments keep their
    // production behavior.
    bool globalInferenceEnabled = true;

    int plateOcrPeriod = 2;
    int plateInferStride = 1;
    // PCIe four-source inference: 0=one mosaic pass, 1=one full-frame pass
    // for every enabled 640x360 source. PCIe never uses fixed strip ROIs.
    // Per-source inference is the production default because it preserves
    // all available detail in each half-sampled 640x360 source.
    int pcieInferenceStrategy = 1;
    // Overlap preprocessing of source N+1 with inference of source N when the
    // four-source independent strategy is active.
    bool detPipelineEnabled = true;
    // 0=auto (prefer RGA), 1=OpenCV, 2=RGA with automatic OpenCV fallback.
    int detPreprocessBackend = 0;
    // Decode quantized RKNN detector outputs directly instead of requesting
    // float conversion from the runtime.
    bool detQuantizedOutput = true;
    // 0=legacy V5, 1=V5 Focus 720p, 2=YOLO26 P3Lite INT8,
    // 3=YOLO26 P3 FP16, 4=V5 ShuffleNetV2 720p, 5-8=Pose26 1280x720
    // canary-pack profiles (FP, full INT8, KPT FP16, P4 upstream FP16).
    int detectorProfile = 0;
    // 0=plate_color, 1=legacy plate_rec_color,
    // 2=v12 deployment model from 2026-08-12.
    int recognizerProfile = 0;
    // Legacy compatibility field. Unconfirmed candidates remain OCR inputs,
    // but the UI no longer exposes a "suspected plate" display mode.
    bool plateShowUnconfirmed = false;
    // Optional second-stage filter in source-image coordinates. It runs after
    // detector decode/NMS and before tracking, OCR, drawing, and reporting.
    bool plateGeometryFilterEnabled = false;
    int plateGeometryMinShortEdge = 8;
    int plateGeometryMinArea = 80;
    int plateGeometryMinAspectX100 = 100;
    int plateGeometryMaxAspectX100 = 650;
    // OCR quality guard; one weak metric may still be recovered by OCR.
    int plateMinShortEdge = 10;
    // Variance of Laplacian on the rectified 168x48 ROI. Zero disables it.
    int plateMinSharpness = 18;
    int envInferStride = 3;
    int plateStableRequired = 2;
    // Number of consecutive detector misses for which a live-video box is
    // retained. Static images never retain detections across files.
    int plateBoxHoldRuns = 1;
    int plateCooldownFrames = 150;
    bool plateUploadThumb = true;

    int drawOverlay = 1;
    int drawText = 1;
    int drawSplit = 1;
    bool envEnable = true;
    bool showDetParts = false;

    int blackVMax = 60;
    int whiteSMax = 35;
    int blueHMin = 100;
    int greenHMin = 35;
    int yellowHMin = 18;
    int yellowHMax = 35;
    float modelTrustVal = 0.8f;
    float minColorRatio = 0.08f;
    int recConfThreshold = 700;
    int doubleUpperRatio = 416;
    int doubleLowerStart = 333;
    int theme = 0;
    QString audioOutputDevice = "default";
    QString targetDeviceId = "esp32-servo-01";
};

QString runtimeSettingsPath();
RuntimeSettingsData loadRuntimeSettings();
bool saveRuntimeSettings(const RuntimeSettingsData &settings);
void applyRuntimeSettingsToProcess(const RuntimeSettingsData &settings);
QJsonObject runtimeSettingsToJson(const RuntimeSettingsData &settings);
bool applyRuntimeSettingsJson(RuntimeSettingsData &settings, const QJsonObject &json);
