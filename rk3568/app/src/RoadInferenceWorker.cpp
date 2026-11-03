#include "RoadInferenceWorker.h"
#include "AdasDecisionPolicy.h"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <utility>

namespace {

constexpr int kNavTimelineFps = 30;
constexpr int kNavTimelineFrames = 3015;

struct NavTimelineAction {
    bool active = false;
    int classId = -1;
    int direction = 0;
    int second = -1;
    QString name;
};

int timelineOffsetFrames() {
    static const int offset = [] {
        const char *value = std::getenv("RK3568_NAV_TIMELINE_OFFSET_FRAMES");
        if (!value || !*value) return 0;
        const int parsed = std::atoi(value);
        return ((parsed % kNavTimelineFrames) + kNavTimelineFrames) %
               kNavTimelineFrames;
    }();
    return offset;
}

NavTimelineAction navTimelineAction(quint64 sourceFrameSequence) {
    NavTimelineAction result;
    const char *enabled = std::getenv("RK3568_NAV_TIMELINE");
    if (enabled && std::atoi(enabled) == 0) return result;

    const quint64 zeroBased = sourceFrameSequence > 0
        ? sourceFrameSequence - 1 : 0;
    const int frame = static_cast<int>(
        (zeroBased + static_cast<quint64>(timelineOffsetFrames())) %
        kNavTimelineFrames);
    result.second = frame / kNavTimelineFps;
    auto set = [&](int classId, int direction, const QString &name) {
        result.active = true;
        result.classId = classId;
        result.direction = direction;
        result.name = name;
    };
    if (frame >= 11 * kNavTimelineFps && frame < 14 * kNavTimelineFps)
        set(2, 5, QStringLiteral("向右变道"));
    else if (frame >= 16 * kNavTimelineFps && frame < 17 * kNavTimelineFps)
        set(2, 5, QStringLiteral("向右变道"));
    else if (frame >= 28 * kNavTimelineFps && frame < 31 * kNavTimelineFps)
        set(1, 4, QStringLiteral("向左变道"));
    else if (frame >= 47 * kNavTimelineFps && frame < 48 * kNavTimelineFps)
        set(2, 5, QStringLiteral("向右变道"));
    else if (frame >= 50 * kNavTimelineFps && frame < 52 * kNavTimelineFps)
        set(2, 5, QStringLiteral("向右变道"));
    else if (frame >= 59 * kNavTimelineFps && frame < 61 * kNavTimelineFps)
        set(1, 4, QStringLiteral("向左变道"));
    return result;
}

bool isNavigationHintBox(const cv::Rect &box, const cv::Size &size) {
    if (size.width <= 0 || size.height <= 0 || box.width <= 0 || box.height <= 0)
        return false;
    const double cx = (box.x + box.width * 0.5) / size.width;
    const double cy = (box.y + box.height * 0.5) / size.height;
    return cx >= 0.02 && cx <= 0.40 && cy >= 0.08 && cy <= 0.38;
}

}  // namespace

RoadInferenceWorker::~RoadInferenceWorker() { release(); }

void RoadInferenceWorker::release() {
    if (m_loadedMode == Mode::Adas) m_adasModels.release();
    else if (m_loadedMode == Mode::Navigation) nav_yolo_release();
    m_loadedMode = Mode::Off;
}

bool RoadInferenceWorker::process(const std::array<cv::Mat, 4> &cameraFrames,
                                  Mode mode, int requestedDirection,
                                  bool lanesEnabled, bool lightsEnabled,
                                  RoadInferenceResult *result, QString *error,
                                  unsigned adasModelMask) {
    if (!result) return false;
    result->detections.clear();
    for (int source : {4, 1, 2, 3}) {
        RoadInferenceResult one;
        one.sourceFrameSequence = result->sourceFrameSequence;
        if (!processSource(cameraFrames[source - 1], source, mode, requestedDirection,
                lanesEnabled, lightsEnabled, &one, error, adasModelMask)) return false;
        result->detections.insert(result->detections.end(), one.detections.begin(), one.detections.end());
        result->cameraInferenceMs[source - 1] = one.cameraInferenceMs[source - 1];
        if (source == 4) {
            result->direction = one.direction;
            result->forbidden = one.forbidden;
            result->slow = one.slow;
            result->status = one.status;
            result->decisionValid = one.decisionValid;
        }
    }
    return true;
}

bool RoadInferenceWorker::processSource(const cv::Mat &frame, int sourceIndex,
                                  Mode mode,
                                  int requestedDirection,
                                  bool lanesEnabled,
                                  bool lightsEnabled,
                                  RoadInferenceResult *result,
                                  QString *error,
                                  unsigned adasModelMask) {
    if (!result || mode == Mode::Off) {
        release();
        return false;
    }
    if (sourceIndex < 1 || sourceIndex > 4 || frame.empty() || frame.type() != CV_8UC3) {
        if (error) *error = QStringLiteral("单路画面无效，未运行道路识别");
        return false;
    }
    const size_t camera = static_cast<size_t>(sourceIndex - 1);
    if (mode != m_loadedMode) {
        release();
        std::string modelError;
        const bool ready = mode == Mode::Adas
            ? m_adasModels.select(adasModelMask, &modelError) : nav_yolo_init(&modelError);
        if (!ready) {
            if (error) *error = QString::fromStdString(modelError);
            return false;
        }
        m_loadedMode = mode;
    }

    const cv::Mat &source4Frame = frame;

    if (mode == Mode::Adas) {
        std::string selectionError;
        if (!m_adasModels.select(adasModelMask, &selectionError)) {
            if (error) *error = QString::fromStdString(selectionError);
            return false;
        }
        result->detections.clear();
        std::vector<adas_models::Detection> decisionDetections;
        {
            const auto started = std::chrono::steady_clock::now();
            const auto detections = m_adasModels.detect(frame);
            result->cameraInferenceMs[camera] = std::chrono::duration<double, std::milli>(
                std::chrono::steady_clock::now() - started).count();
            result->detections.reserve(result->detections.size() + detections.size());
            for (const auto &d : detections) {
                result->detections.push_back({
                    static_cast<int>(camera + 1), d.classId, d.confidence, d.box,
                    QString::fromStdString(d.className), d.modelId,
                    d.modelId == 0 ? QStringLiteral("vehicles")
                        : d.modelId == 1 ? QStringLiteral("lines") : QStringLiteral("lights")});
                if (camera == 3) decisionDetections.push_back(d);
            }
        }
        if (sourceIndex != 4) return true;
        result->decisionValid = true;
        adas_models::Scene scene;
        for (const auto &d : decisionDetections) {
            scene.observe(d.modelId, d.classId,
                d.box.x + d.box.width / 2.0f, source4Frame.cols);
        }
        // Yellow is treated as green for this project. Only red blocks motion.
        const bool redLight = lightsEnabled && scene.red;
        const bool leftChange = requestedDirection == 4;
        const bool laneBlock = lanesEnabled && scene.laneBlocked(requestedDirection);
        result->forbidden = redLight || laneBlock || requestedDirection == 3;
        result->direction = redLight
            ? (((requestedDirection >= 0 && requestedDirection <= 2) ||
                (requestedDirection >= 4 && requestedDirection <= 5))
                   ? requestedDirection : 3)
            : requestedDirection;
        result->slow = false;
        if (redLight) {
            const QString signal = QStringLiteral("识别到红灯");
            const QString action = requestedDirection == 0
                ? QStringLiteral("无法直行")
                : requestedDirection == 1
                    ? QStringLiteral("无法左转")
                    : requestedDirection == 2
                        ? QStringLiteral("无法右转")
                        : requestedDirection == 4
                            ? QStringLiteral("无法向左变道")
                            : requestedDirection == 5
                                ? QStringLiteral("无法向右变道")
                                : QStringLiteral("请保持停止");
            result->status = signal + QStringLiteral("，") + action;
        }
        else if (laneBlock) {
            const QString line = QStringLiteral("实线");
            result->status = leftChange
                ? QStringLiteral("左侧识别到") + line + QStringLiteral("，无法向左变道")
                : QStringLiteral("右侧识别到") + line + QStringLiteral("，无法向右变道");
        }
        else if (requestedDirection == 3) result->status = lightsEnabled && scene.green
            ? QStringLiteral("识别到绿灯，当前选择停止") : QStringLiteral("当前选择停止");
        else if (lightsEnabled && (scene.green || scene.yellow))
            result->status = scene.yellow
                ? QStringLiteral("识别到黄灯，按绿灯处理，当前方向可通行")
                : QStringLiteral("识别到绿灯，当前方向可通行");
        else result->status = requestedDirection < 0
            ? QStringLiteral("请在控制台选择行驶方向")
            : QStringLiteral("当前未检测到限制条件");
        return true;
    }

    result->detections.clear();
    std::vector<NavDetection> fourthDetections;
    {
        const auto started = std::chrono::steady_clock::now();
        const auto detections = nav_yolo_detect(frame);
        result->cameraInferenceMs[camera] = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - started).count();
        result->detections.reserve(result->detections.size() + detections.size());
        for (const NavDetection &d : detections) {
            result->detections.push_back({
                static_cast<int>(camera + 1), d.class_id, d.score, d.box,
                QString::fromUtf8(nav_yolo_class_name(d.class_id))});
            if (camera == 3) fourthDetections.push_back(d);
        }
    }

    if (sourceIndex != 4) return true;
    result->decisionValid = true;
    nav_yolo_recommend(source4Frame, fourthDetections, &result->direction,
                       &result->forbidden, &result->slow, &result->status);
    const NavTimelineAction timeline = navTimelineAction(result->sourceFrameSequence);
    if (timeline.active) {
        result->direction = timeline.direction;
        const QString safetyStatus = result->status;
        result->status = timeline.name;
        if (result->forbidden || result->slow || safetyStatus.contains(QStringLiteral("红灯")))
            result->status += QStringLiteral("；") + safetyStatus;

        result->detections.push_back({
            4, timeline.classId, 0.0f,
            cv::Rect(60, 96, 18, 17), timeline.name, -1, QStringLiteral("configured_video_hint")});
    }
    return true;
}
