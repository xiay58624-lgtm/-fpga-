#include "adas_yolo.h"

#include "cv.hpp"
#include "ez_rknn.hpp"
#include "structures.hpp"
#include "yolov5_adas_3out_postprocess.hpp"

#include <opencv2/imgproc.hpp>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unistd.h>
#include <limits.h>
#include <array>
#include <vector>

namespace {

constexpr const char *kModelName = "bdd7_rk3568_fp16.rknn";
constexpr int kBddClassCount = 7;
constexpr int kLegacyClassCount = 14;
constexpr float kConf = 0.25f;
constexpr float kNms = 0.40f;

const char *kBddClassNames[kBddClassCount] = {
    "pedestrian", "rider", "car", "truck", "bus", "motorcycle", "bicycle"
};

const char *kLegacyClassNames[kLegacyClassCount] = {
    "dash", "solid", "boundary", "stop", "red", "green", "yellow",
    "light", "zebra", "person", "car", "cone", "sphere", "column"
};

std::mutex g_mtx;
std::unique_ptr<ztu::rk::EzRknn> g_rknn;
int g_numClasses = 0;
bool g_bdd7Model = false;

static float overlap(const cv::Rect &a, const cv::Rect &b) {
    const cv::Rect intersection = a & b;
    const int unionArea = a.area() + b.area() - intersection.area();
    return unionArea > 0 ? static_cast<float>(intersection.area()) / unionArea : 0.0f;
}

bool file_exists(const std::string &path) {
    return ::access(path.c_str(), R_OK) == 0;
}

std::string get_exe_dir() {
    char buf[PATH_MAX];
    const ssize_t len = ::readlink("/proc/self/exe", buf, sizeof(buf) - 1);
    if (len <= 0) return {};
    buf[len] = '\0';
    const std::string full(buf);
    const auto pos = full.find_last_of('/');
    return pos == std::string::npos ? std::string() : full.substr(0, pos);
}

std::string resolve_model_path() {
    if (const char *overridePath = std::getenv("RK3568_ADAS_MODEL")) {
        if (*overridePath) return overridePath;
    }

    std::vector<std::string> candidates;
    if (const char *modelDir = std::getenv("RK3568_MODEL_DIR")) {
        if (*modelDir) candidates.emplace_back(std::string(modelDir) + "/" + kModelName);
    }
    candidates.emplace_back(std::string("./app/model/") + kModelName);
    candidates.emplace_back(std::string("./model/") + kModelName);
    candidates.emplace_back(std::string("./models/") + kModelName);
    const std::string exeDir = get_exe_dir();
    if (!exeDir.empty()) {
        candidates.emplace_back(exeDir + "/../model/" + kModelName);
        candidates.emplace_back(exeDir + "/model/" + kModelName);
    }
    for (const auto &path : candidates) {
        if (file_exists(path)) return path;
    }
    return candidates.empty() ? std::string(kModelName) : candidates.front();
}

} // namespace

bool adas_yolo_init(std::string *error) {
    std::lock_guard<std::mutex> lock(g_mtx);
    if (g_rknn) return true;

    const std::string path = resolve_model_path();
    if (!file_exists(path)) {
        if (error) *error = "ADAS 模型未找到: " + path;
        return false;
    }

    try {
        g_rknn = std::make_unique<ztu::rk::EzRknn>(
            path.c_str(), ztu::rk::EzRknn::Layout::CHW2HWC);
        g_rknn->setWantFloat(true);
        if (g_rknn->input_attrs.size() != 1) {
            throw std::runtime_error("ADAS 模型必须只有一个输入张量");
        }
        if (g_rknn->output_attrs.size() == 1) {
            const auto &attr = g_rknn->output_attrs[0];
            if (attr.n_dims != 3 || attr.dims[0] != 1 || attr.dims[2] != 8400 ||
                attr.dims[1] != 4 + kBddClassCount) {
                throw std::runtime_error("BDD7 模型输出必须为 [1,11,8400]");
            }
            g_numClasses = kBddClassCount;
            g_bdd7Model = true;
        } else if (g_rknn->output_attrs.size() == 3) {
            g_numClasses = kLegacyClassCount;
            g_bdd7Model = false;
        } else {
            throw std::runtime_error("不支持的 ADAS 输出数量：仅支持 BDD7 单输出或旧 14 类三头模型");
        }
    } catch (const std::exception &ex) {
        g_rknn.reset();
        g_numClasses = 0;
        g_bdd7Model = false;
        if (error) *error = std::string("ADAS 模型加载失败: ") + ex.what();
        return false;
    } catch (...) {
        g_rknn.reset();
        if (error) *error = "ADAS 模型加载失败";
        return false;
    }
    return true;
}

void adas_yolo_release() {
    std::lock_guard<std::mutex> lock(g_mtx);
    g_rknn.reset();
    g_numClasses = 0;
    g_bdd7Model = false;
}

bool adas_yolo_ready() {
    std::lock_guard<std::mutex> lock(g_mtx);
    return static_cast<bool>(g_rknn);
}

int adas_yolo_class_count() {
    std::lock_guard<std::mutex> lock(g_mtx);
    return g_numClasses;
}

std::vector<AdasDetection> adas_yolo_detect(const cv::Mat &bgr) {
    std::vector<AdasDetection> out;
    if (bgr.empty()) return out;

    std::lock_guard<std::mutex> lock(g_mtx);
    if (!g_rknn) return out;

    const int modelW = static_cast<int>(g_rknn->input_attrs[0].dims[2]);
    const int modelH = static_cast<int>(g_rknn->input_attrs[0].dims[1]);
    const auto resize = ztu::cv::calculateResize(
        bgr.cols, bgr.rows, modelW, modelH, ztu::cv::ResizeMode::KEEP_RATIO_PAD);
    cv::Mat input = ztu::cv::resize(bgr, resize, cv::Scalar(114, 114, 114));
    cv::cvtColor(input, input, cv::COLOR_BGR2RGB);

    if (g_bdd7Model) {
        const auto outputs = g_rknn->inference(input.data);
        if (outputs.size() != 1 || g_rknn->output_attrs.size() != 1) return out;
        const auto &attr = g_rknn->output_attrs[0];
        constexpr int candidates = 8400;
        constexpr int channels = 4 + kBddClassCount;
        std::vector<AdasDetection> candidatesOut;
        candidatesOut.reserve(128);
        const float *tensor = outputs[0];
        for (int i = 0; i < candidates; ++i) {
            auto at = [&](int channel) {
                const size_t offset = attr.dims[1] == channels
                    ? static_cast<size_t>(channel) * candidates + i
                    : static_cast<size_t>(i) * channels + channel;
                return tensor[offset];
            };
            int classId = -1;
            float score = 0.0f;
            for (int c = 0; c < kBddClassCount; ++c) {
                const float value = at(c + 4);
                if (!std::isfinite(value) || value < -0.001f || value > 1.001f)
                    return {};
                if (value > score) { score = value; classId = c; }
            }
            if (score < kConf || classId < 0) continue;
            const float cx = at(0), cy = at(1), width = at(2), height = at(3);
            if (!std::isfinite(cx) || !std::isfinite(cy) ||
                !std::isfinite(width) || !std::isfinite(height) ||
                width <= 0.0f || height <= 0.0f ||
                width > modelW * 2.0f || height > modelH * 2.0f) continue;
            const auto topLeft = ztu::cv::reverseMapPoint(
                static_cast<int>(std::lround(cx - width * 0.5f)),
                static_cast<int>(std::lround(cy - height * 0.5f)), resize);
            const auto bottomRight = ztu::cv::reverseMapPoint(
                static_cast<int>(std::lround(cx + width * 0.5f)),
                static_cast<int>(std::lround(cy + height * 0.5f)), resize);
            cv::Rect box(static_cast<int>(std::lround(topLeft.first)),
                         static_cast<int>(std::lround(topLeft.second)),
                         static_cast<int>(std::lround(bottomRight.first - topLeft.first)),
                         static_cast<int>(std::lround(bottomRight.second - topLeft.second)));
            box &= cv::Rect(0, 0, bgr.cols, bgr.rows);
            if (box.width <= 1 || box.height <= 1) continue;
            AdasDetection result;
            result.model_id = 0;
            result.class_id = classId;
            result.score = score;
            result.box = box;
            result.class_name = kBddClassNames[classId];
            candidatesOut.push_back(std::move(result));
        }
        std::stable_sort(candidatesOut.begin(), candidatesOut.end(),
            [](const AdasDetection &a, const AdasDetection &b) {
                return a.score > b.score;
            });
        for (const auto &candidate : candidatesOut) {
            bool duplicate = false;
            for (const auto &kept : out) {
                if (candidate.class_id == kept.class_id &&
                    overlap(candidate.box, kept.box) > kNms) {
                    duplicate = true;
                    break;
                }
            }
            if (!duplicate) out.push_back(candidate);
            if (out.size() >= 100) break;
        }
        return out;
    }

    ztu::nn::object_detect_result_list detections;
    const auto outputs = g_rknn->inference(input.data);
    if (outputs.size() < 3) return out;
    ztu::nn::yolov5_adas_3out_postprocess::postprocess(
        const_cast<const float **>(outputs.data()), kConf, 0.45f,
        &detections, modelW, modelH, kLegacyClassCount);

    out.reserve(detections.results.size());
    for (const auto &det : detections.results) {
        if (det.cls_id < 0 || det.cls_id >= kLegacyClassCount || det.prop < kConf) continue;
        const auto topLeft = ztu::cv::reverseMapPoint(det.box.left, det.box.top, resize);
        const auto bottomRight = ztu::cv::reverseMapPoint(det.box.right, det.box.bottom, resize);
        cv::Rect box(static_cast<int>(std::lround(topLeft.first)),
                     static_cast<int>(std::lround(topLeft.second)),
                     static_cast<int>(std::lround(bottomRight.first - topLeft.first)),
                     static_cast<int>(std::lround(bottomRight.second - topLeft.second)));
        box &= cv::Rect(0, 0, bgr.cols, bgr.rows);
        if (box.width <= 1 || box.height <= 1) continue;
        AdasDetection result;
        result.model_id = det.cls_id <= 1 ? 1 :
            (det.cls_id >= 4 && det.cls_id <= 6 ? 2 : 0);
        result.class_id = det.cls_id;
        result.score = det.prop;
        result.box = box;
        result.class_name = kLegacyClassNames[det.cls_id];
        out.push_back(std::move(result));
    }
    return out;
}

void adas_yolo_draw(cv::Mat &bgr, const std::vector<AdasDetection> &dets) {
    if (bgr.empty()) return;
    for (const auto &det : dets) {
        const cv::Scalar color = det.model_id == 2 ? cv::Scalar(80, 80, 255)
            : det.model_id == 1 ? cv::Scalar(40, 180, 255)
                                : cv::Scalar(255, 80, 40);
        cv::rectangle(bgr, det.box, color, 2, cv::LINE_AA);
        const std::string label = det.class_name;
        cv::putText(bgr, label, cv::Point(det.box.x, std::max(16, det.box.y - 4)),
                    cv::FONT_HERSHEY_SIMPLEX, 0.55, color, 1, cv::LINE_AA);
    }
}
