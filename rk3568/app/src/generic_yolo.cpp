#include "generic_yolo.h"
#include "cv.hpp"
#include "structures.hpp"
#include "yolov5_std_3out_postprocess.hpp"
#include "ez_rknn.hpp"
#include <opencv2/imgproc.hpp>
#include <QBuffer>
#include <QByteArray>
#include <QImage>
#include <unistd.h>
#include <limits.h>
#include <cstdlib>
#include <cstring>
#include <chrono>
#include <deque>
#include <mutex>
#include <string>
#include <vector>
#include <sstream>
#include <algorithm>
#include <array>
#include <cmath>
#include <memory>
#include <cstdio>
#include <fstream>

struct EnvModelSpec {
    const char *key;
    const char *file;
    std::vector<std::string> classes;
    cv::Scalar color;
};

static const std::vector<EnvModelSpec> kEnvModels = {
    {"bdd", "bdd100k_yolo11n_640_7class_rk3568_int8.rknn",
     {"pedestrian", "rider", "car", "truck", "bus",
      "motorcycle", "bicycle"},
     cv::Scalar(255, 80, 40)},
    {"road", "road_markings_yolov8n_640_rk3568_int8.rknn",
     {"center_dashline", "center_solidline", "lane_boundries", "left_arrow",
      "right_arrow", "stop_line", "straight_left_arrow",
      "straight_right_arrow", "straight_arrow"},
     cv::Scalar(40, 180, 255)},
    {"traffic", "traffic_lights_yolo11s_640_rk3568_int8.rknn",
     {"Green_L_diaotou", "green", "green_L", "green_R", "green_Z_L",
      "green_non", "green_prson", "green_z", "red", "red_L",
      "red_L_diaotou", "red_R", "red_Z", "red_diaotou", "red_non",
      "red_person", "yellow"},
     cv::Scalar(80, 80, 255)}
};

struct EnvDetection {
    cv::Rect box;
    float confidence = 0.0f;
    int class_id = -1;
    int model_id = -1;
};

struct EnvModelRuntime {
    const EnvModelSpec *spec = nullptr;
    std::unique_ptr<ztu::rk::EzRknn> rknn;
};

static std::vector<EnvModelRuntime> g_models;
static float g_conf_th = 0.25f;
static float g_nms_th = 0.4f;
static std::mutex g_detection_mtx;
static std::vector<GenericYoloDetection> g_last_detections;
static std::uint64_t g_detection_frame_sequence = 0;
static std::uint64_t g_pending_frame_sequence = 0;

static void env_debug_log(const std::string &message) {
    // Keep diagnostics available when the Qt process stdout is redirected to
    // the launcher pipe on the board.
    std::ofstream out("/tmp/rk3568_generic_yolo.log", std::ios::app);
    if (out) out << message << '\n';
}

static int env_max_dets();
static rknn_core_mask parse_env_core_mask();

static std::mutex g_violation_mtx;
static std::deque<EnvViolationEvent> g_violation_q;
static int64_t g_last_violation_ms = 0;

static inline float iou_rect(const cv::Rect& a, const cv::Rect& b) {
    int x1 = std::max(a.x, b.x);
    int y1 = std::max(a.y, b.y);
    int x2 = std::min(a.x + a.width, b.x + b.width);
    int y2 = std::min(a.y + a.height, b.y + b.height);
    int iw = std::max(0, x2 - x1);
    int ih = std::max(0, y2 - y1);
    int inter = iw * ih;
    int ua = a.width * a.height + b.width * b.height - inter;
    if (ua <= 0) return 0.0f;
    return (float)inter / (float)ua;
}

static inline std::vector<uint8_t> encode_jpeg(const cv::Mat& bgr, int max_w, int quality) {
    if (bgr.empty()) return {};
    cv::Mat src = bgr;
    cv::Mat resized;
    if (max_w > 0 && src.cols > max_w) {
        int h = (int)std::llround((double)src.rows * (double)max_w / (double)src.cols);
        cv::resize(src, resized, cv::Size(max_w, std::max(2, h)), 0, 0, cv::INTER_AREA);
        src = resized;
    }
    cv::Mat rgb;
    cv::cvtColor(src, rgb, cv::COLOR_BGR2RGB);
    QImage img(rgb.data, rgb.cols, rgb.rows, (int)rgb.step, QImage::Format_RGB888);
    QByteArray out;
    QBuffer qb(&out);
    qb.open(QIODevice::WriteOnly);
    img.save(&qb, "JPG", std::max(30, std::min(95, quality)));
    if (out.isEmpty()) return {};
    return std::vector<uint8_t>((const uint8_t*)out.constData(), (const uint8_t*)out.constData() + out.size());
}

bool generic_yolo_pop_violation_event(EnvViolationEvent &out) {
    std::lock_guard<std::mutex> lk(g_violation_mtx);
    if (g_violation_q.empty()) return false;
    out = std::move(g_violation_q.front());
    g_violation_q.pop_front();
    return true;
}

void generic_set_threshold(float conf, float nms) {
    if (conf < 0.0f) conf = 0.0f;
    if (conf > 1.0f) conf = 1.0f;
    if (nms < 0.0f) nms = 0.0f;
    if (nms > 1.0f) nms = 1.0f;
    g_conf_th = conf;
    g_nms_th = nms;
}

void generic_yolo_set_frame_sequence(std::uint64_t sequence) {
    std::lock_guard<std::mutex> lock(g_detection_mtx);
    g_pending_frame_sequence = sequence;
}

bool generic_yolo_get_last_detections(std::vector<GenericYoloDetection> &out,
                                      std::uint64_t &frame_sequence) {
    std::lock_guard<std::mutex> lock(g_detection_mtx);
    out = g_last_detections;
    frame_sequence = g_detection_frame_sequence;
    return true;
}

static void clear_last_detections() {
    std::lock_guard<std::mutex> lock(g_detection_mtx);
    g_last_detections.clear();
    g_detection_frame_sequence = g_pending_frame_sequence;
}

static cv::Scalar color_for_detection(const EnvDetection &det) {
    if (det.model_id == 2 && det.class_id >= 0 && det.class_id < 17) {
        const std::string &name = kEnvModels[2].classes[(size_t)det.class_id];
        if (name.find("green") != std::string::npos) return cv::Scalar(0, 220, 0);
        if (name.find("red") != std::string::npos) return cv::Scalar(0, 0, 235);
        if (name == "yellow") return cv::Scalar(0, 210, 255);
    }
    static const std::array<cv::Scalar, 12> palette = {{
        cv::Scalar(255, 80, 40), cv::Scalar(40, 180, 255), cv::Scalar(150, 60, 220),
        cv::Scalar(0, 210, 170), cv::Scalar(255, 190, 0), cv::Scalar(80, 80, 255),
        cv::Scalar(0, 165, 255), cv::Scalar(180, 80, 40), cv::Scalar(80, 220, 120),
        cv::Scalar(220, 80, 180), cv::Scalar(180, 180, 60), cv::Scalar(60, 160, 255)
    }};
    const int index = std::max(0, det.model_id * 4 + det.class_id);
    return palette[(size_t)index % palette.size()];
}

static bool env_model_selected(const char *key) {
    const char *value = std::getenv("RK3568_ENV_MODEL_SET");
    if (!value || !*value || std::strcmp(value, "all") == 0) return true;
    std::string requested(value);
    size_t start = 0;
    while (start < requested.size()) {
        size_t end = requested.find_first_of(",; ", start);
        if (requested.substr(start, end == std::string::npos ? end : end - start) == key) return true;
        if (end == std::string::npos) break;
        start = end + 1;
    }
    return false;
}

static int env_max_dets() {
    const char* env = std::getenv("RK3568_ENV_MAX_DETS");
    if (env && *env) {
        int v = std::atoi(env);
        if (v > 0 && v < 10000) return v;
    }
    return 60;
}

static rknn_core_mask parse_env_core_mask() {
    const char* s = std::getenv("RK3568_ENV_CORE_MASK");
    if (!s || !*s) return RKNN_NPU_CORE_UNDEFINED;
    if (strcmp(s, "0") == 0) return RKNN_NPU_CORE_0;
    if (strcmp(s, "1") == 0) return RKNN_NPU_CORE_1;
    if (strcmp(s, "2") == 0) return RKNN_NPU_CORE_2;
    if (strcmp(s, "01") == 0 || strcmp(s, "0_1") == 0) return RKNN_NPU_CORE_0_1;
    if (strcmp(s, "02") == 0 || strcmp(s, "0_2") == 0) {
#ifdef RKNN_NPU_CORE_0_2
        return RKNN_NPU_CORE_0_2;
#else
        return RKNN_NPU_CORE_UNDEFINED;
#endif
    }
    if (strcmp(s, "12") == 0 || strcmp(s, "1_2") == 0) {
#ifdef RKNN_NPU_CORE_1_2
        return RKNN_NPU_CORE_1_2;
#else
        return RKNN_NPU_CORE_UNDEFINED;
#endif
    }
    if (strcmp(s, "012") == 0 || strcmp(s, "0_1_2") == 0 || strcmp(s, "all") == 0) {
#ifdef RKNN_NPU_CORE_0_1_2
        return RKNN_NPU_CORE_0_1_2;
#else
        return RKNN_NPU_CORE_UNDEFINED;
#endif
    }
    return RKNN_NPU_CORE_UNDEFINED;
}

static bool file_exists(const std::string& p) {
    return ::access(p.c_str(), R_OK) == 0;
}

static std::string get_exe_dir() {
    char buf[PATH_MAX];
    ssize_t len = ::readlink("/proc/self/exe", buf, sizeof(buf) - 1);
    if (len <= 0) return "";
    buf[len] = '\0';
    std::string full(buf);
    auto pos = full.find_last_of('/');
    if (pos == std::string::npos) return "";
    return full.substr(0, pos);
}

static std::string resolve_model_path(const char* modelName) {
    const char* envDir = std::getenv("RK3568_MODEL_DIR");
    std::vector<std::string> candidates;
    if (envDir && *envDir) candidates.emplace_back(std::string(envDir) + "/" + modelName);
    candidates.emplace_back(std::string("./app/model/") + modelName);
    candidates.emplace_back(std::string("./model/") + modelName);
    candidates.emplace_back(std::string("./models/") + modelName);
    std::string exeDir = get_exe_dir();
    if (!exeDir.empty()) {
        candidates.emplace_back(exeDir + "/../model/" + modelName);
        candidates.emplace_back(exeDir + "/model/" + modelName);
    }
    for (const auto& c : candidates) {
        if (file_exists(c)) return c;
    }
    return candidates.empty() ? std::string(modelName) : candidates.front();
}

void generic_yolo_init() {
    if (!g_models.empty()) return;
    env_debug_log("init begin model_dir=" +
                  std::string(std::getenv("RK3568_MODEL_DIR")
                                  ? std::getenv("RK3568_MODEL_DIR") : "(unset)"));
    const bool want_float = [] {
        const char *s = std::getenv("RK3568_ENV_WANT_FLOAT");
        return s && std::atoi(s) != 0;
    }();
    for (size_t index = 0; index < kEnvModels.size(); ++index) {
        const EnvModelSpec &spec = kEnvModels[index];
        if (!env_model_selected(spec.key)) {
            env_debug_log(std::string("skip model selection key=") + spec.key);
            continue;
        }
        const std::string path = resolve_model_path(spec.file);
        if (!file_exists(path)) {
            env_debug_log(std::string("model missing key=") + spec.key +
                          " path=" + path);
            continue;
        }
        try {
            EnvModelRuntime runtime;
            runtime.spec = &spec;
            runtime.rknn = std::make_unique<ztu::rk::EzRknn>(
                path.c_str(), ztu::rk::EzRknn::Layout::CHW2HWC,
                parse_env_core_mask());
            if (!want_float) runtime.rknn->setWantFloat(false);
            std::ostringstream info;
            info << "model loaded key=" << spec.key << " path=" << path
                 << " inputs=" << runtime.rknn->input_attrs.size()
                 << " outputs=" << runtime.rknn->output_attrs.size();
            for (const auto &attr : runtime.rknn->output_attrs) {
                info << " dims=";
                for (uint32_t d = 0; d < attr.n_dims; ++d) {
                    if (d) info << 'x';
                    info << attr.dims[d];
                }
                info << " type=" << static_cast<int>(attr.type)
                     << " qnt=" << static_cast<int>(attr.qnt_type)
                     << " fl=" << static_cast<int>(attr.fl)
                     << " zp=" << attr.zp << " scale=" << attr.scale;
            }
            env_debug_log(info.str());
            g_models.push_back(std::move(runtime));
        } catch (const std::exception &e) {
            env_debug_log(std::string("model load exception key=") + spec.key +
                          " error=" + e.what());
        } catch (...) {
            env_debug_log(std::string("model load unknown exception key=") + spec.key);
        }
    }
    env_debug_log("init end loaded=" + std::to_string(g_models.size()));
}

bool generic_yolo_is_ready() {
    if (g_models.empty()) generic_yolo_init();
    return !g_models.empty();
}

static float output_value(const void *data, const rknn_tensor_attr &attr,
                          size_t index, bool raw) {
    if (!raw) return static_cast<const float *>(data)[index];
    int value = 0;
    if (attr.type == RKNN_TENSOR_UINT8) value = static_cast<const uint8_t *>(data)[index];
    else value = static_cast<const int8_t *>(data)[index];
    return (static_cast<float>(value) - static_cast<float>(attr.zp)) * attr.scale;
}

static void decode_yolo11(EnvModelRuntime &runtime,
                          const cv::Mat &frame,
                          const ztu::cv::ResizeImpl &resize_param,
                          const cv::Mat &input,
                          std::vector<EnvDetection> &detections) {
    auto &model = *runtime.rknn;
    if (model.output_attrs.size() != 1) return;
    const rknn_tensor_attr &attr = model.output_attrs[0];
    if (attr.n_dims < 3) return;
    int channels = static_cast<int>(attr.dims[1]);
    int count = static_cast<int>(attr.dims[2]);
    bool channel_major = true;
    if (channels != 4 + static_cast<int>(runtime.spec->classes.size())) {
        if (static_cast<int>(attr.dims[2]) == 4 + static_cast<int>(runtime.spec->classes.size())) {
            channels = static_cast<int>(attr.dims[2]);
            count = static_cast<int>(attr.dims[1]);
            channel_major = false;
        } else {
            return;
        }
    }
    std::vector<float> scores;
    auto infer_one = [&](const void *data, bool raw) {
        int threshold_candidates = 0;
        int valid_boxes = 0;
        float max_score = 0.0f;
        float max_cx = 0.0f, max_cy = 0.0f;
        float max_width = 0.0f, max_height = 0.0f;
        for (int i = 0; i < count; ++i) {
            auto at = [&](int channel) {
                const size_t offset = channel_major
                    ? static_cast<size_t>(channel) * static_cast<size_t>(count) + static_cast<size_t>(i)
                    : static_cast<size_t>(i) * static_cast<size_t>(channels) + static_cast<size_t>(channel);
                return output_value(data, attr, offset, raw);
            };
            int class_id = -1;
            float best = 0.0f;
            for (int c = 0; c < channels - 4; ++c) {
                float score = at(c + 4);
                if (score < 0.0f || score > 1.0f) score = 1.0f / (1.0f + std::exp(-score));
                if (score > best) { best = score; class_id = c; }
            }
            max_score = std::max(max_score, best);
            if (class_id < 0 || best < g_conf_th) continue;
            ++threshold_candidates;
            const float cx = at(0), cy = at(1), width = at(2), height = at(3);
            max_cx = std::max(max_cx, std::abs(cx));
            max_cy = std::max(max_cy, std::abs(cy));
            max_width = std::max(max_width, std::abs(width));
            max_height = std::max(max_height, std::abs(height));
            if (!std::isfinite(cx) || !std::isfinite(cy) || !std::isfinite(width) || !std::isfinite(height) ||
                width <= 0.0f || height <= 0.0f) continue;
            auto p0 = ztu::cv::reverseMapPoint((int)std::lround(cx - width * 0.5f),
                                               (int)std::lround(cy - height * 0.5f), resize_param);
            auto p1 = ztu::cv::reverseMapPoint((int)std::lround(cx + width * 0.5f),
                                               (int)std::lround(cy + height * 0.5f), resize_param);
            cv::Rect box((int)std::lround(p0.first), (int)std::lround(p0.second),
                         (int)std::lround(p1.first - p0.first), (int)std::lround(p1.second - p0.second));
            box &= cv::Rect(0, 0, frame.cols, frame.rows);
            if (box.width > 1 && box.height > 1) {
                ++valid_boxes;
                detections.push_back({box, best, class_id, -1});
            }
        }
        static std::array<int, 3> debug_calls{{0, 0, 0}};
        const int debug_id = runtime.spec == &kEnvModels[0] ? 0
            : (runtime.spec == &kEnvModels[1] ? 1 : 2);
        if (debug_id >= 0 && debug_id < static_cast<int>(debug_calls.size()) &&
            (++debug_calls[static_cast<size_t>(debug_id)] % 10) == 0) {
            std::ostringstream info;
            info << "decode key=" << runtime.spec->key
                 << " mode=" << (raw ? "int8" : "float")
                 << " conf=" << g_conf_th
                 << " max_score=" << max_score
                 << " threshold=" << threshold_candidates
                 << " valid=" << valid_boxes
                 << " abs_xywh=" << max_cx << ',' << max_cy << ','
                 << max_width << ',' << max_height;
            env_debug_log(info.str());
        }
    };
    if (model.wantFloat()) {
        auto outputs = model.inference(input.data);
        if (!outputs.empty()) infer_one(outputs[0], false);
    } else {
        auto outputs = model.inferenceRaw(input.data);
        static std::array<bool, 3> logged_raw{{false, false, false}};
        const int model_id = runtime.spec == &kEnvModels[0] ? 0
            : (runtime.spec == &kEnvModels[1] ? 1 : 2);
        if (model_id >= 0 && model_id < static_cast<int>(logged_raw.size()) &&
            !logged_raw[static_cast<size_t>(model_id)]) {
            logged_raw[static_cast<size_t>(model_id)] = true;
            std::ostringstream info;
            info << "first raw inference key=" << runtime.spec->key
                 << " outputs=" << outputs.size();
            if (!outputs.empty()) {
                const size_t count = static_cast<size_t>(model.output_attrs[0].n_elems);
                const size_t sample = std::min<size_t>(count, 16);
                info << " sample=";
                for (size_t i = 0; i < sample; ++i) {
                    if (i) info << ',';
                    if (model.output_attrs[0].type == RKNN_TENSOR_UINT8)
                        info << static_cast<int>(static_cast<const uint8_t *>(outputs[0])[i]);
                    else
                        info << static_cast<int>(static_cast<const int8_t *>(outputs[0])[i]);
                }
            }
            env_debug_log(info.str());
        }
        if (!outputs.empty()) infer_one(outputs[0], true);
    }
}

void generic_yolo_run(cv::Mat &frame) {
    generic_yolo_run(frame, false);
}

static void constrain_detections_to_mosaic(
    std::vector<EnvDetection> &detections, const cv::Size &size) {
    if (size.width < 2 || size.height < 2) return;
    const int halfW = size.width / 2;
    const int halfH = size.height / 2;
    const cv::Rect full(0, 0, size.width, size.height);
    std::vector<EnvDetection> constrained;
    constrained.reserve(detections.size());
    for (EnvDetection det : detections) {
        const int cx = det.box.x + det.box.width / 2;
        const int cy = det.box.y + det.box.height / 2;
        const int left = cx >= halfW ? halfW : 0;
        const int top = cy >= halfH ? halfH : 0;
        const cv::Rect tile(left, top, size.width - left,
                            size.height - top);
        det.box &= tile & full;
        if (det.box.width > 1 && det.box.height > 1) {
            constrained.push_back(std::move(det));
        }
    }
    detections.swap(constrained);
}

void generic_yolo_run(cv::Mat &frame, bool split_mosaic) {
    if (frame.empty()) return;
    clear_last_detections();
    if (g_models.empty()) generic_yolo_init();
    if (g_models.empty()) return;

    std::vector<EnvDetection> detections;
    for (size_t model_id = 0; model_id < g_models.size(); ++model_id) {
        EnvModelRuntime &runtime = g_models[model_id];
        const int model_w = runtime.rknn->input_attrs[0].dims[2];
        const int model_h = runtime.rknn->input_attrs[0].dims[1];
        auto resize_param = ztu::cv::calculateResize(frame.cols, frame.rows, model_w, model_h);
        cv::Mat input = ztu::cv::resize(frame, resize_param);
        cv::cvtColor(input, input, cv::COLOR_BGR2RGB);
        const size_t before = detections.size();
        decode_yolo11(runtime, frame, resize_param, input, detections);
        for (size_t i = before; i < detections.size(); ++i) detections[i].model_id = (int)model_id;
    }
    std::sort(detections.begin(), detections.end(), [](const EnvDetection &a, const EnvDetection &b) {
        return a.confidence > b.confidence;
    });
    std::vector<EnvDetection> kept;
    for (const EnvDetection &candidate : detections) {
        bool duplicate = false;
        for (const EnvDetection &existing : kept) {
            if (candidate.model_id != existing.model_id || candidate.class_id != existing.class_id) continue;
            if (iou_rect(candidate.box, existing.box) > g_nms_th) { duplicate = true; break; }
        }
        if (!duplicate) kept.push_back(candidate);
        if ((int)kept.size() >= env_max_dets()) break;
    }
    detections.swap(kept);
    // The FPGA frame is a 2x2 mosaic. A detector box is assigned by its
    // center and clipped to that tile so labels from one camera can never be
    // drawn into a neighboring camera view.
    if (split_mosaic) {
        constrain_detections_to_mosaic(detections, frame.size());
    }

    // Publish a thread-safe copy for the Wi-Fi/API path.  The overlay below
    // is intentionally independent from this snapshot, so a browser can
    // request a frame and its detections without touching the capture loop.
    {
        std::vector<GenericYoloDetection> snapshot;
        snapshot.reserve(detections.size());
        for (const EnvDetection &det : detections) {
            if (det.confidence < g_conf_th) continue;
            GenericYoloDetection item;
            item.model_id = det.model_id;
            item.class_id = det.class_id;
            item.confidence = det.confidence;
            item.left = det.box.x;
            item.top = det.box.y;
            item.right = det.box.x + det.box.width;
            item.bottom = det.box.y + det.box.height;
            const EnvModelSpec *spec =
                (det.model_id >= 0 && det.model_id < static_cast<int>(g_models.size()) &&
                 g_models[static_cast<size_t>(det.model_id)].spec)
                    ? g_models[static_cast<size_t>(det.model_id)].spec
                    : nullptr;
            if (spec) {
                item.model_key = spec->key;
                if (det.class_id >= 0 &&
                    det.class_id < static_cast<int>(spec->classes.size())) {
                    item.class_name = spec->classes[static_cast<size_t>(det.class_id)];
                }
            }
            if (item.class_name.empty()) {
                item.class_name = std::string("id:") + std::to_string(det.class_id);
            }
            snapshot.push_back(std::move(item));
        }
        std::lock_guard<std::mutex> lock(g_detection_mtx);
        g_last_detections = std::move(snapshot);
        g_detection_frame_sequence = g_pending_frame_sequence;
    }

    cv::Rect zebra_rect;
    bool has_zebra = false;
    bool has_red = false;
    bool has_green = false;
    std::vector<cv::Rect> person_rects;
    for (const auto &det : detections) {
        if (det.confidence < g_conf_th) continue;
        if (det.model_id == 0 && det.class_id == 0) {
            cv::Rect r = det.box;
            r &= cv::Rect(0, 0, frame.cols, frame.rows);
            if (r.area() > 0) person_rects.push_back(r);
        } else if (det.model_id == 2 && det.class_id >= 0) {
            const std::string &name = kEnvModels[2].classes[(size_t)det.class_id];
            has_red = has_red || name.find("red") != std::string::npos;
            has_green = has_green || name.find("green") != std::string::npos;
        }
    }

    bool trig = has_zebra || has_red || has_green || !person_rects.empty();
    cv::Rect best_person;
    float best_iou = 0.0f;
    if (!person_rects.empty()) {
        best_person = person_rects.front();
        for (const auto& pr : person_rects) {
            if (pr.area() > best_person.area()) best_person = pr;
        }
    }
    if (has_zebra && !person_rects.empty()) {
        for (const auto& pr : person_rects) {
            float v = iou_rect(pr, zebra_rect);
            if (v > best_iou) best_iou = v;
        }
    }

    if (trig) {
        const int64_t nowMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                                  std::chrono::steady_clock::now().time_since_epoch())
                                  .count();
        int cooldownMs = 2500;
        if (const char* s = std::getenv("RK3568_VIOLATION_COOLDOWN_MS")) {
            int v = std::atoi(s);
            if (v > 0) cooldownMs = v;
        }
        if (g_last_violation_ms <= 0 || (nowMs - g_last_violation_ms) >= cooldownMs) {
            g_last_violation_ms = nowMs;
            int q = 82;
            if (const char* s = std::getenv("RK3568_VIOLATION_JPEG_QUALITY")) q = std::atoi(s);
            int maxW = 960;
            if (const char* s = std::getenv("RK3568_VIOLATION_MAX_W")) maxW = std::atoi(s);
            int thumbW = 480;
            if (const char* s = std::getenv("RK3568_VIOLATION_THUMB_W")) thumbW = std::atoi(s);

            EnvViolationEvent ev;
            ev.jpeg = encode_jpeg(frame, maxW, q);
            ev.thumb_jpeg = encode_jpeg(frame, thumbW, 75);
            ev.zebra_count = has_zebra ? 1 : 0;
            ev.person_count = (int)person_rects.size();
            if (has_zebra) {
                ev.zebra_left = zebra_rect.x;
                ev.zebra_top = zebra_rect.y;
                ev.zebra_right = zebra_rect.x + zebra_rect.width;
                ev.zebra_bottom = zebra_rect.y + zebra_rect.height;
            }
            if (!person_rects.empty()) {
                ev.person_left = best_person.x;
                ev.person_top = best_person.y;
                ev.person_right = best_person.x + best_person.width;
                ev.person_bottom = best_person.y + best_person.height;
            }
            ev.overlap_iou = best_iou;

            if (!ev.jpeg.empty()) {
                std::lock_guard<std::mutex> lk(g_violation_mtx);
                g_violation_q.push_back(std::move(ev));
                while ((int)g_violation_q.size() > 6) g_violation_q.pop_front();
            }
        }
    }

    for (const auto &det : detections) {
        if (det.confidence < g_conf_th) continue;
        cv::Rect rect = det.box;
        rect &= cv::Rect(0, 0, frame.cols, frame.rows);
        cv::Scalar color = color_for_detection(det);
        cv::rectangle(frame, rect, color, 2, cv::LINE_AA);
        std::ostringstream ss;
        const EnvModelSpec *spec = (det.model_id >= 0 && det.model_id < (int)kEnvModels.size())
            ? &kEnvModels[(size_t)det.model_id] : nullptr;
        if (spec && det.class_id >= 0 && det.class_id < (int)spec->classes.size()) {
            ss << spec->key << ":" << spec->classes[(size_t)det.class_id];
        } else ss << "id:" << det.class_id;
        ss << " " << std::fixed;
        ss.precision(2);
        ss << det.confidence;
        std::string label = ss.str();
        int base = 0;
        cv::Size ts = cv::getTextSize(label, cv::FONT_HERSHEY_SIMPLEX, 0.5, 1, &base);
        int x = rect.x;
        int y = std::max(0, rect.y - ts.height - 6);
        cv::rectangle(frame, cv::Rect(x, y, ts.width + 6, ts.height + 6), color, -1);
        cv::putText(frame, label, cv::Point(x + 3, y + ts.height + 1), cv::FONT_HERSHEY_SIMPLEX, 0.5, cv::Scalar(255,255,255), 1, cv::LINE_AA);
    }
}

