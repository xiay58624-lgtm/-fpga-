#pragma once

#include <array>
#include <chrono>
#include <QString>
#include <vector>
#include <opencv2/core/mat.hpp>
#include "adas_yolo.h"
#include "nav_yolo.h"
#include "AdasModelSet.h"

struct RoadOverlayDetection {
    int sourceIndex = 0;
    int classId = -1;
    float confidence = 0.0f;
    cv::Rect box;
    QString className;
    int modelId = -1;
    QString modelKey;
};

struct RoadInferenceResult {
    int direction = -1;
    bool forbidden = false;
    bool slow = false;
    QString status;
    std::vector<RoadOverlayDetection> detections;
    std::array<double, 4> cameraInferenceMs{0.0, 0.0, 0.0, 0.0};
    std::array<quint64, 4> cameraFrameSequences{};
    std::array<std::chrono::steady_clock::time_point, 4> cameraFrameAt{};
    std::array<bool, 4> cameraValid{};
    int updatedSource = 0;
    quint64 completedCycles = 0;
    quint64 completedUpdates = 0;
    bool decisionValid = false;
    quint64 sourceFrameSequence = 0;
    std::chrono::steady_clock::time_point sourceFrameAt;
    double inferenceMs = 0.0;
    QString error;
};

class RoadInferenceWorker final {
public:
    enum class Mode { Off = 0, Adas = 1, Navigation = 2 };
    RoadInferenceWorker() = default;
    ~RoadInferenceWorker();
    bool processSource(const cv::Mat &frame, int sourceIndex, Mode mode,
                       int requestedDirection, bool lanesEnabled, bool lightsEnabled,
                       RoadInferenceResult *result, QString *error,
                       unsigned adasModelMask = adas_models::All);
    bool process(const std::array<cv::Mat, 4> &cameraFrames,
                 Mode mode,
                 int requestedDirection,
                 bool lanesEnabled,
                 bool lightsEnabled,
                 RoadInferenceResult *result,
                 QString *error,
                 unsigned adasModelMask = adas_models::All);
    void release();

private:
    Mode m_loadedMode = Mode::Off;
    adas_models::ModelSet m_adasModels;
};
