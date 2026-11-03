#include "yolo.h"
#include "opencv2/core/mat.hpp"
#include "opencv2/highgui.hpp"
#include "opencv2/imgproc.hpp"
#include "cv.hpp"
#include "PlateAuthenticity.h"
#include "PlateColorArbitration.h"
#include "PlateConsensus.h"
#include "PlateDisplayPolicy.h"
#include "PlateOcrPolicy.h"
#include "PlateSliding.h"
#include "PlateTextValidation.h"
#include "PlateDetectorProfiles.h"
#include "PlateRecognizerProfiles.h"
#include "InferenceTimingPolicy.h"
#include "structures.hpp"
#include "yolov5_ztopt_3out_postprocess.hpp"
#include "ez_rknn.hpp"
#include <string>
#include <vector>
#include <array>
#include <cstdint>
#include <numeric>
#include <cmath>
#include <unordered_map>
#include <QImage>
#include <QPainter>
#include <QFont>
#include <mutex>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <chrono>
#include <algorithm>
#include <cctype>
#include <map>
#include <set>
#include <limits>
#include <future>
#include <thread>
#include <atomic>
#include <memory>
#include <unistd.h>
#include <limits.h>

#ifdef RK3568_HAVE_RGA
#include <im2d.h>
#endif

// 模型相对路径宏定义
// ================= 全局配置 =================
// 1. 类别与颜色映射
static const std::vector<std::string> classes = {"Single-Plate", "Double-Plate"};
static const std::vector<cv::Scalar> class_colors = {
    cv::Scalar(0, 255, 0),     // Single-Plate - 绿色
    cv::Scalar(255, 0, 0)      // Double-Plate - 蓝色
};

// 中文车牌字典 (支持 UTF-8 终端打印)
static const std::vector<std::string> PLATE_CHR = {
    "#", "京", "沪", "津", "渝", "冀", "晋", "蒙", "辽", "吉", "黑", "苏", "浙", 
    "皖", "闽", "赣", "鲁", "豫", "鄂", "湘", "粤", "桂", "琼", "川", "贵", "云", 
    "藏", "陕", "甘", "青", "宁", "新", "学", "警", "港", "澳", "挂", "使", "领", 
    "民", "航", "危", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", 
    "A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L", "M", "N", "P", 
    "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "险", "品"
};

// 新版 plate_color.rknn 的测试脚本字典：
// '#京沪津渝冀晋蒙辽吉黑苏浙皖闽赣鲁豫鄂湘粤桂琼川贵云藏陕甘青宁新学警港澳挂使领民航深0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'
// 注意：新版模型仍输出 78 类，但测试脚本只保留 76 个字符，idx >= 76 时直接跳过。
static const std::vector<std::string> PLATE_CHR_NEW_COLOR_TEXT = {
    "#", "京", "沪", "津", "渝", "冀", "晋", "蒙", "辽", "吉", "黑", "苏", "浙",
    "皖", "闽", "赣", "鲁", "豫", "鄂", "湘", "粤", "桂", "琼", "川", "贵", "云",
    "藏", "陕", "甘", "青", "宁", "新", "学", "警", "港", "澳", "挂", "使", "领",
    "民", "航", "深", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
    "A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L", "M", "N", "P",
    "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"
};

// 拼音版字典 (用于 OpenCV 画面渲染，防止问号乱码)
static const std::vector<std::string> PLATE_CHR_EN = {
    "#", "Jing", "Hu", "Jin", "Yu", "Ji", "Jin", "Meng", "Liao", "Ji", "Hei", "Su", "Zhe", 
    "Wan", "Min", "Gan", "Lu", "Yu", "E", "Xiang", "Yue", "Gui", "Qiong", "Chuan", "Gui", "Yun", 
    "Zang", "Shan", "Gan", "Qing", "Ning", "Xin", "Xue", "Jing", "Gang", "Ao", "Gua", "Shi", "Ling", 
    "Min", "Hang", "Wei", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", 
    "A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L", "M", "N", "P", 
    "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "Xian", "Pin"
};

static const std::vector<std::string> COLOR_MAP = {"黑", "蓝", "绿", "白", "黄"};
static const std::vector<std::string> COLOR_MAP_EN = {"Black", "Blue", "Green", "White", "Yellow"};

// 全局 NPU 模型指针
static ztu::rk::EzRknn *rknn_det = nullptr;
static ztu::rk::EzRknn *rknn_rec = nullptr; // ★ 新增：识别模型
static bool g_model_ready = false;
static std::string g_model_error;
static std::atomic<int> g_requested_detector_profile{0};
static plate_detector::ProfileId g_active_detector_profile =
    plate_detector::ProfileId::LegacyV5;
static std::atomic<int> g_requested_recognizer_profile{0};
static plate_recognizer::ProfileId g_active_recognizer_profile =
    plate_recognizer::ProfileId::PlateColor;
static std::mutex g_model_mutex;

enum class RecTextLayout {
    TimeMajor21x78,      // 当前旧模型：等价于 (1, 21, 78)
    ClassMajor78x1x21   // 新版 plate_color.rknn：等价于 (1, 78, 1, 21)
};

static RecTextLayout g_rec_text_layout = RecTextLayout::TimeMajor21x78;
static int g_rec_time_steps = 21;
static int g_rec_class_count = 78;
static bool g_rec_use_new_charset = false;
static bool g_rec_input_bgr = false;
static std::string g_rec_model_input_type = "UINT8";
static int g_rec_text_output_index = 0;
static int g_rec_color_output_index = 1;
static int g_rec_input_width = 168;
static int g_rec_input_height = 48;
static std::string g_det_model_path;
static std::string g_rec_model_path;

static std::mutex g_report_mutex;
static std::vector<PlateReportEvent> g_report_events;

static int g_view_mode = 0;
static int g_single_source = 1;
static int g_quad_map[4] = {1, 2, 3, 4};
static bool g_dedupe_by_source = true;
static bool g_native_mosaic_enabled = false;
static int g_native_source_width = 1280;
static int g_native_source_height = 720;
static unsigned int g_native_source_mask = 0x0fu;
static bool g_next_run_is_static_frame = false;
static std::atomic<unsigned long long> g_pending_source_frame_sequence{0};

void yolo_set_view_context(int view_mode, int single_source, int q0, int q1, int q2, int q3) {
    g_view_mode = view_mode;
    g_single_source = single_source;
    g_quad_map[0] = q0;
    g_quad_map[1] = q1;
    g_quad_map[2] = q2;
    g_quad_map[3] = q3;
    for (int i = 0; i < 4; ++i) {
        if (g_quad_map[i] < 0) g_quad_map[i] = 0;
        if (g_quad_map[i] > 4) g_quad_map[i] = 4;
    }
    if (g_single_source < 1) g_single_source = 1;
    if (g_single_source > 4) g_single_source = 4;
}

void yolo_set_dedupe_by_source(bool enabled) {
    g_dedupe_by_source = enabled;
}

void yolo_set_native_mosaic_layout(bool enabled, int source_width,
                                   int source_height, unsigned int source_mask) {
    g_native_mosaic_enabled = enabled;
    g_native_source_width = std::max(1, source_width);
    g_native_source_height = std::max(1, source_height);
    g_native_source_mask = source_mask & 0x0fu;
}

void yolo_prepare_static_frame() {
    g_next_run_is_static_frame = true;
}

void yolo_set_source_frame_sequence(unsigned long long sequence) {
    g_pending_source_frame_sequence.store(sequence, std::memory_order_release);
}

const char* yolo_color_name(int color_idx) {
    if (color_idx < 0 || color_idx >= (int)COLOR_MAP.size()) return "";
    return COLOR_MAP[color_idx].c_str();
}

const char* yolo_detection_model_path() {
    return g_det_model_path.c_str();
}

const char* yolo_recognition_model_path() {
    return g_rec_model_path.c_str();
}

static const plate_recognizer::Profile &active_recognizer_profile() {
    return plate_recognizer::profile(g_active_recognizer_profile);
}

int yolo_current_recognizer_profile() {
    return plate_recognizer::profileToInt(g_active_recognizer_profile);
}

const char* yolo_current_recognizer_profile_key() {
    return active_recognizer_profile().key;
}

const char* yolo_current_recognizer_model_name() {
    return active_recognizer_profile().model_file;
}

const char* yolo_current_recognizer_output_contract() {
    return active_recognizer_profile().output_contract;
}

const char* yolo_current_recognizer_input_format() {
    return g_rec_input_bgr ? "BGR_UINT8_NHWC" : "RGB_UINT8_NHWC";
}

const char* yolo_current_recognizer_model_input_type() {
    return g_rec_model_input_type.c_str();
}

const char* yolo_current_recognizer_text_layout() {
    return g_rec_text_layout == RecTextLayout::ClassMajor78x1x21
        ? "class_major_78x1x21" : "time_major_21x78";
}

int yolo_current_recognizer_input_width() {
    return g_rec_input_width;
}

int yolo_current_recognizer_input_height() {
    return g_rec_input_height;
}

static const plate_detector::Profile &active_detector_profile() {
    return plate_detector::profile(g_active_detector_profile);
}

int yolo_current_detector_profile() {
    return plate_detector::profileToInt(g_active_detector_profile);
}

const char* yolo_current_detector_profile_key() {
    return active_detector_profile().key;
}

const char* yolo_current_detector_family() {
    return active_detector_profile().family_name;
}

const char* yolo_current_detector_model_name() {
    return active_detector_profile().model_file;
}

const char* yolo_current_detector_sha256() {
    return active_detector_profile().sha256;
}

const char* yolo_current_detector_output_contract() {
    return active_detector_profile().output_contract;
}

int yolo_current_detector_input_width() {
    return active_detector_profile().input_width;
}

int yolo_current_detector_input_height() {
    return active_detector_profile().input_height;
}

void yolo_set_detector_profile(int profile) {
    g_requested_detector_profile.store(
        plate_detector::profileToInt(plate_detector::profileFromInt(profile)),
        std::memory_order_release);
}

void yolo_set_recognizer_profile(int profile) {
    g_requested_recognizer_profile.store(
        plate_recognizer::profileToInt(
            plate_recognizer::profileFromInt(profile)),
        std::memory_order_release);
}

bool yolo_pop_report_event(PlateReportEvent& out) {
    std::lock_guard<std::mutex> lock(g_report_mutex);
    if (g_report_events.empty()) return false;
    out = std::move(g_report_events.front());
    g_report_events.erase(g_report_events.begin());
    return true;
}

static bool file_exists(const std::string& p) {
    return ::access(p.c_str(), R_OK) == 0;
}

static std::string lower_copy(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) {
        return (char)std::tolower(c);
    });
    return s;
}

static bool env_enabled(const char* name, bool defVal) {
    const char* s = std::getenv(name);
    if (!s || !*s) return defVal;
    return std::atoi(s) != 0;
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
    const char* envPack = std::getenv("RK3568_TEST_PACK_DIR");
    std::vector<std::string> candidates;
    if (modelName && *modelName && file_exists(modelName)) return modelName;
    if (envDir && *envDir) candidates.emplace_back(std::string(envDir) + "/" + modelName);
    if (envPack && *envPack) {
        candidates.emplace_back(std::string(envPack) + "/models/" + modelName);
        candidates.emplace_back(std::string(envPack) +
                                "/rk3568_test_pack_20260806/models/" +
                                modelName);
    }
    candidates.emplace_back(std::string("./app/model/") + modelName);
    candidates.emplace_back(std::string("./model/") + modelName);
    candidates.emplace_back(std::string("./models/") + modelName);
    candidates.emplace_back(std::string(
        "./rk3568_test_pack_20260806/rk3568_test_pack_20260806/models/") +
                            modelName);
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

static std::string resolve_plate_rec_model_path(
        plate_recognizer::ProfileId profile_id, bool allow_override) {
    const char* overrideName = std::getenv("RK3568_PLATE_REC_MODEL");
    if (allow_override && overrideName && *overrideName) {
        return resolve_model_path(overrideName);
    }
    return resolve_model_path(
        plate_recognizer::profile(profile_id).model_file);
}

// ================= 辅助算法模块 =================
ColorThresholds g_color_cfg; // 定义全局变量

void set_color_thresholds(const ColorThresholds& cfg) {
    g_color_cfg = cfg;
}

// 1. HSV 颜色分析结果结构体
struct RoiColorAnalysis {
    float blue_ratio = 0, green_ratio = 0, yellow_ratio = 0, white_ratio = 0, black_ratio = 0;
    float avg_h = 0, avg_s = 0, avg_v = 0;
};

static float roi_color_ratio(const RoiColorAnalysis& roi, int color) {
    switch (color) {
    case 0: return roi.black_ratio;
    case 1: return roi.blue_ratio;
    case 2: return roi.green_ratio;
    case 3: return roi.white_ratio;
    case 4: return roi.yellow_ratio;
    default: return 0.0f;
    }
}

static float roi_dominant_color_ratio(const RoiColorAnalysis& roi) {
    return std::max({roi.black_ratio, roi.blue_ratio, roi.green_ratio,
                     roi.white_ratio, roi.yellow_ratio});
}

// 2. HSV 颜色分析函数
static RoiColorAnalysis analyze_roi_color(const cv::Mat& roi) {
    RoiColorAnalysis res;
    if (roi.empty()) return res;

    // 1. 转换空间
    cv::Mat hsv;
    cv::cvtColor(roi, hsv, cv::COLOR_BGR2HSV);

    // 2. 动态计算中心区域 (防止车牌太小时 rect 变成负数)
    int margin_w = std::min(8, hsv.cols / 4);
    int margin_h = std::min(8, hsv.rows / 4);
    cv::Rect center_rect(margin_w, margin_h, 
                        hsv.cols - 2 * margin_w, 
                        hsv.rows - 2 * margin_h);
    
    cv::Mat hsv_center = hsv(center_rect);
    float total = (float)hsv_center.total();

    // 3. 计算均值 (直接处理 3 通道，比 split 快)
    cv::Scalar mean_hsv = cv::mean(hsv_center);
    res.avg_h = mean_hsv[0];
    res.avg_s = mean_hsv[1];
    res.avg_v = mean_hsv[2];

    // 4. 掩码统计逻辑 (使用全局调节参数)
    cv::Mat mask;

    // 蓝色统计
    cv::inRange(hsv_center, 
                cv::Scalar(g_color_cfg.blue_h_min, 30, 0), 
                cv::Scalar(140, 255, 255), mask);
    res.blue_ratio = cv::countNonZero(mask) / total;

    // 绿色统计
    cv::inRange(hsv_center, 
                cv::Scalar(g_color_cfg.green_h_min, 35, 60), 
                cv::Scalar(95, 255, 255), mask);
    res.green_ratio = cv::countNonZero(mask) / total;

    // 黄色统计
    cv::inRange(hsv_center, 
                cv::Scalar(g_color_cfg.yellow_h_min, 40, 50), 
                cv::Scalar(g_color_cfg.yellow_h_max, 255, 255), mask);
    res.yellow_ratio = cv::countNonZero(mask) / total;

    // 白色统计 (核心：低饱和度 S)
    cv::inRange(hsv_center, 
                cv::Scalar(0, 0, 120), 
                cv::Scalar(180, g_color_cfg.white_s_max, 255), mask);
    res.white_ratio = cv::countNonZero(mask) / total;

    // 黑色统计 (核心：低亮度 V)
    cv::inRange(hsv_center, 
                cv::Scalar(0, 0, 0), 
                cv::Scalar(180, 255, g_color_cfg.black_v_max), mask);
    res.black_ratio = cv::countNonZero(mask) / total;

    return res;
}

// 3. 模型混合颜色推断 (软色卡+硬预测)
struct RecognizerOutputView {
    const float *data = nullptr;
    const void *raw_data = nullptr;
    bool quantized = false;
    bool uint8 = false;
    int zero_point = 0;
    float scale = 1.0f;

    bool valid() const { return data || raw_data; }

    float at(std::size_t index) const {
        if (quantized && raw_data) {
            const int raw = uint8
                ? static_cast<int>(static_cast<const uint8_t *>(raw_data)[index])
                : static_cast<int>(static_cast<const int8_t *>(raw_data)[index]);
            return (static_cast<float>(raw) - static_cast<float>(zero_point)) *
                   scale;
        }
        return data ? data[index] : 0.0f;
    }
};

static int correct_color(const RecognizerOutputView& color_probs_raw,
                         const RoiColorAnalysis& roi,
                         int cls_id, float* model_confidence = nullptr,
                         int* model_color = nullptr) {
    // --- 阶段 1: 概率标准化 (Softmax) ---
    std::vector<float> probs(5);
    float sum_exp = 0;
    for(int i=0; i<5; ++i) { 
        probs[i] = std::exp(color_probs_raw.at(static_cast<std::size_t>(i)));
        sum_exp += probs[i]; 
    }
    
    int model_idx = 0; 
    float max_prob = 0;
    for(int i=0; i<5; ++i) {
        probs[i] /= sum_exp;
        if(probs[i] > max_prob) {
            max_prob = probs[i];
            model_idx = i;
        }
    }
    if (model_confidence) *model_confidence = max_prob;
    if (model_color) *model_color = model_idx;

    // 获取第二候选，用于模糊地带仲裁
    int second_idx = 0; float second_prob = -1.0f;
    for(int i=0; i<5; ++i) {
        if(i != model_idx && probs[i] > second_prob) {
            second_prob = probs[i];
            second_idx = i;
        }
    }

    // --- 阶段 2: 高置信度快速通行 ---
    // 如果模型非常有信心（超过设定的信任阈值），直接采纳模型结果
    // Physical black evidence must run before the model-trust fast path. A
    // confident blue prediction can otherwise never be corrected on a black
    // plate whose white glyphs raise the average brightness.
    const PlateColorPhysicalEvidence physicalEvidence = {
        roi.black_ratio, roi.blue_ratio, roi.green_ratio,
        roi.yellow_ratio, roi.avg_v
    };
    if (plateColorDecisiveBlack(
            physicalEvidence, g_color_cfg.black_v_max)) {
        return 0;
    }

    if (max_prob > g_color_cfg.model_trust_val) {
        return model_idx;
    }

    // --- 阶段 3: 物理特征硬纠正 (一票否决权) ---
    // 优先级最高：如果物理特征极其明显，无论模型如何预测，强制纠正
    
    // 1. 黑色判定：极低亮度
    if (plateColorLowLightBlack(
            physicalEvidence, g_color_cfg.black_v_max)) return 0;
    
    // 2. 白色判定：极低饱和度 + 高亮度
    if (roi.white_ratio > 0.3f && roi.avg_s < g_color_cfg.white_s_max) return 3;

    // --- 阶段 4: 低置信度仲裁逻辑 ---
    // 当模型犹豫不决时，根据物理统计比例进行“仲裁”
    
    // 情况 A: 蓝黑之争 (常见于暗光环境)
    bool is_blue_black_struggle = (model_idx == 0 || model_idx == 1);
    if (is_blue_black_struggle) {
        // 如果蓝色像素占比超过设定的最小门槛，且多于黑色占比，判为蓝色
        if (roi.blue_ratio > g_color_cfg.min_color_ratio && roi.blue_ratio > roi.black_ratio) {
            return 1; 
        }
        return 0; // 否则倾向于黑色或环境阴影
    }

    // 情况 B: 黄绿之争 (常见于新能源 vs 大货车/教练车)
    bool is_yellow_green_struggle = (model_idx == 2 || model_idx == 4 || second_idx == 2 || second_idx == 4);
    if (is_yellow_green_struggle) {
        float green_score = roi.green_ratio * 100.0f;
        float yellow_score = roi.yellow_ratio * 100.0f;

        // 色调加成：如果平均色调落在黄色或绿色区间，增加相应权重
        if (roi.avg_h >= g_color_cfg.yellow_h_min && roi.avg_h <= g_color_cfg.yellow_h_max) {
            yellow_score += 10.0f;
        } else if (roi.avg_h > g_color_cfg.green_h_min && roi.avg_h < 90) {
            green_score += 10.0f;
        }

        if (green_score > yellow_score * 1.2f && roi.green_ratio > g_color_cfg.min_color_ratio) return 2;
        if (yellow_score > green_score * 1.2f && roi.yellow_ratio > g_color_cfg.min_color_ratio) return 4;
    }

    // 默认兜底：如果仲裁无果，返回模型最看好的颜色
    return model_idx;
}

// 4. 解析识别字符串 (贪心搜索去除连续重复)
/**
 * @brief 车牌识别解码 (CTC Greedy Search)
 * @param char_out 模型输出原始数据指针 [21 * 78]
 * @param out_cn   输出的中文车牌字符串
 * @param out_conf 输出的平均识别置信度 (0.0 - 1.0)
 */
static float rec_char_value(const RecognizerOutputView& char_out, int t, int c) {
    const std::size_t index = g_rec_text_layout == RecTextLayout::ClassMajor78x1x21
        ? static_cast<std::size_t>(c * g_rec_time_steps + t)
        : static_cast<std::size_t>(t * g_rec_class_count + c);
    return char_out.at(index);
}

static void apply_recognizer_contract(
        plate_recognizer::ProfileId profile_id,
        const plate_recognizer::Contract &contract) {
    g_active_recognizer_profile = profile_id;
    g_rec_text_layout =
        contract.text_layout == plate_recognizer::TextLayout::ClassMajor78x1x21
            ? RecTextLayout::ClassMajor78x1x21
            : RecTextLayout::TimeMajor21x78;
    g_rec_time_steps = 21;
    g_rec_class_count = 78;
    g_rec_text_output_index = contract.text_output_index;
    g_rec_color_output_index = contract.color_output_index;
    g_rec_input_width = contract.input_width;
    g_rec_input_height = contract.input_height;
    switch (static_cast<rknn_tensor_type>(contract.input_type)) {
    case RKNN_TENSOR_INT8:
        g_rec_model_input_type = "INT8";
        break;
    case RKNN_TENSOR_UINT8:
        g_rec_model_input_type = "UINT8";
        break;
    default:
        g_rec_model_input_type = "UNKNOWN";
        break;
    }

    const plate_recognizer::Profile &selected =
        plate_recognizer::profile(profile_id);
    g_rec_use_new_charset = selected.new_charset ||
        g_rec_text_layout == RecTextLayout::ClassMajor78x1x21;
    g_rec_input_bgr = selected.input_bgr ||
        g_rec_text_layout == RecTextLayout::ClassMajor78x1x21;

    if (const char* s = std::getenv("RK3568_REC_TEXT_LAYOUT")) {
        const std::string value = lower_copy(s);
        if (value == "new" || value == "class_major" || value == "78x1x21") {
            g_rec_text_layout = RecTextLayout::ClassMajor78x1x21;
            g_rec_use_new_charset = true;
            g_rec_input_bgr = true;
        } else if (value == "old" || value == "time_major" || value == "21x78") {
            g_rec_text_layout = RecTextLayout::TimeMajor21x78;
        }
    }
    if (const char* s = std::getenv("RK3568_REC_CHARSET")) {
        const std::string value = lower_copy(s);
        if (value == "new" || value == "plate_color") g_rec_use_new_charset = true;
        if (value == "old" || value == "legacy") g_rec_use_new_charset = false;
    }
    g_rec_input_bgr = env_enabled("RK3568_REC_INPUT_BGR", g_rec_input_bgr);
}

static void decode_plate(const RecognizerOutputView& char_out,
                         std::string& out_cn, float& out_conf) {
    out_cn = "";
    out_conf = 0.0f;
    if (!char_out.valid() || g_rec_time_steps <= 0 || g_rec_class_count <= 0) return;

    const std::vector<std::string>& charset = g_rec_use_new_charset ? PLATE_CHR_NEW_COLOR_TEXT : PLATE_CHR;
    
    int pre_idx = -1;
    double total_prob = 0.0;
    int char_count = 0;

    for (int i = 0; i < g_rec_time_steps; ++i) {
        int max_idx = 0;
        float max_val = rec_char_value(char_out, i, 0);
        double row_sum = max_val;
        bool all_nonneg = max_val >= 0.0f;

        // 1. 寻找当前时间步概率最大的字符
        for (int j = 1; j < g_rec_class_count; ++j) {
            float val = rec_char_value(char_out, i, j);
            if (val > max_val) {
                max_val = val;
                max_idx = j;
            }
            row_sum += val;
            if (val < 0.0f) all_nonneg = false;
        }

        // 2. CTC 解码规则：跳过空白符(0)和连续重复符
        if (max_idx != 0 && max_idx != pre_idx) {
            if (max_idx >= (int)charset.size()) {
                pre_idx = max_idx;
                continue;
            }
            out_cn += charset[max_idx];
            
            // 如果模型输出已经是概率分布，则直接使用；否则对这一行做 softmax
            double char_prob = 0.0;
            if (all_nonneg && row_sum > 0.8 && row_sum < 1.2) {
                char_prob = max_val;
            } else {
                double denom = 0.0;
                for (int j = 0; j < g_rec_class_count; ++j) {
                    denom += std::exp((double)rec_char_value(char_out, i, j) - (double)max_val);
                }
                if (denom > 0.0) char_prob = 1.0 / denom;
            }
            total_prob += char_prob;
            char_count++;
        }
        pre_idx = max_idx;
    }

    // 3. 计算平均置信度
    if (char_count > 0) {
        out_conf = total_prob / char_count;
    }
}

static cv::Size recognition_input_size() {
    constexpr int kFallbackWidth = 168;
    constexpr int kFallbackHeight = 48;
    if (!rknn_rec || rknn_rec->input_attrs.empty()) {
        return cv::Size(kFallbackWidth, kFallbackHeight);
    }

    const auto& attr = rknn_rec->input_attrs[0];
    if (attr.n_dims == 4) {
        // EzRknn::CHW2HWC exposes the queried input shape as NHWC.
        const int height = static_cast<int>(attr.dims[1]);
        const int width = static_cast<int>(attr.dims[2]);
        if (width > 1 && height > 1) return cv::Size(width, height);
    }
    return cv::Size(kFallbackWidth, kFallbackHeight);
}

static std::vector<cv::Point2f> ordered_plate_points(
        const std::vector<cv::Point2f>& pts) {
    if (pts.size() != 4) return {};

    int tl = 0, tr = 0, br = 0, bl = 0;
    float minSum = std::numeric_limits<float>::max();
    float maxSum = std::numeric_limits<float>::lowest();
    float minDiff = std::numeric_limits<float>::max();
    float maxDiff = std::numeric_limits<float>::lowest();
    for (int i = 0; i < 4; ++i) {
        const float sum = pts[(size_t)i].x + pts[(size_t)i].y;
        const float diff = pts[(size_t)i].y - pts[(size_t)i].x;
        if (sum < minSum) { minSum = sum; tl = i; }
        if (sum > maxSum) { maxSum = sum; br = i; }
        if (diff < minDiff) { minDiff = diff; tr = i; }
        if (diff > maxDiff) { maxDiff = diff; bl = i; }
    }

    const std::array<int, 4> indices = {tl, tr, br, bl};
    std::set<int> unique(indices.begin(), indices.end());
    if (unique.size() != 4) return pts;
    return {pts[(size_t)tl], pts[(size_t)tr],
            pts[(size_t)br], pts[(size_t)bl]};
}

static std::vector<cv::Point2f> expanded_plate_points(
        const std::vector<cv::Point2f>& pts, float expand_ratio) {
    std::vector<cv::Point2f> expanded = ordered_plate_points(pts);
    if (expanded.size() != 4) return {};
    if (expand_ratio > 0) {
        cv::Point2f center(0, 0);
        for (const auto& p : pts) center += p;
        center.x /= 4.0f; center.y /= 4.0f;
        for (auto& p : expanded) {
            p.x += (p.x - center.x) * expand_ratio;
            p.y += (p.y - center.y) * expand_ratio;
        }
    }
    return expanded;
}

static cv::Mat warp_plate_quad(const cv::Mat& image,
                               const std::vector<cv::Point2f>& src_pts,
                               const cv::Size& output_size) {
    if (image.empty() || src_pts.size() != 4 ||
        output_size.width < 1 || output_size.height < 1) {
        return {};
    }
    const std::vector<cv::Point2f> dst_pts = {
        {0.0f, 0.0f},
        {static_cast<float>(output_size.width - 1), 0.0f},
        {static_cast<float>(output_size.width - 1), static_cast<float>(output_size.height - 1)},
        {0.0f, static_cast<float>(output_size.height - 1)}
    };
    cv::Mat M = cv::getPerspectiveTransform(src_pts, dst_pts);
    cv::Mat warped;
    cv::warpPerspective(image, warped, M, output_size, cv::INTER_LINEAR);
    return warped;
}

static cv::Mat prepare_plate_recognition_roi(const cv::Mat& image,
                                             const std::vector<cv::Point2f>& pts,
                                             bool double_layer,
                                             float expand_ratio = 0.075f) {
    const cv::Size input_size = recognition_input_size();
    const std::vector<cv::Point2f> expanded = expanded_plate_points(pts, expand_ratio);
    if (expanded.size() != 4) return {};

    if (!double_layer) {
        return warp_plate_quad(image, expanded, input_size);
    }

    const float upper_rate = std::clamp(
        g_color_cfg.double_upper_ratio / 1000.0f, 0.001f, 0.999f);
    const float lower_rate = std::clamp(
        g_color_cfg.double_lower_start / 1000.0f, 0.001f, 0.999f);
    const cv::Point2f left_upper = expanded[0] + (expanded[3] - expanded[0]) * upper_rate;
    const cv::Point2f right_upper = expanded[1] + (expanded[2] - expanded[1]) * upper_rate;
    const cv::Point2f left_lower = expanded[0] + (expanded[3] - expanded[0]) * lower_rate;
    const cv::Point2f right_lower = expanded[1] + (expanded[2] - expanded[1]) * lower_rate;

    const std::vector<cv::Point2f> upper_quad = {
        expanded[0], expanded[1], right_upper, left_upper
    };
    const std::vector<cv::Point2f> lower_quad = {
        left_lower, right_lower, expanded[2], expanded[3]
    };
    const int upper_width = input_size.width / 2;
    const int lower_width = input_size.width - upper_width;
    cv::Mat upper = warp_plate_quad(
        image, upper_quad, cv::Size(upper_width, input_size.height));
    cv::Mat lower = warp_plate_quad(
        image, lower_quad, cv::Size(lower_width, input_size.height));
    if (upper.empty() || lower.empty() || upper.rows != lower.rows ||
        upper.type() != lower.type()) {
        return {};
    }

    cv::Mat merged;
    cv::hconcat(upper, lower, merged);
    return merged;
}

static cv::Mat prepare_plate_fallback_roi(
        const cv::Mat& image, const std::vector<cv::Point2f>& pts,
        bool double_layer, const PlateSlidingBox* detectorBox) {
    if (image.empty() || pts.size() != 4) return {};

    float left = pts[0].x;
    float right = pts[0].x;
    float top = pts[0].y;
    float bottom = pts[0].y;
    for (const auto& point : pts) {
        left = std::min(left, point.x);
        right = std::max(right, point.x);
        top = std::min(top, point.y);
        bottom = std::max(bottom, point.y);
    }
    if (detectorBox && detectorBox->right > detectorBox->left &&
        detectorBox->bottom > detectorBox->top) {
        left = std::min(left, detectorBox->left);
        right = std::max(right, detectorBox->right);
        top = std::min(top, detectorBox->top);
        bottom = std::max(bottom, detectorBox->bottom);
    }
    const float width = right - left;
    const float height = bottom - top;
    if (width <= 2.0f || height <= 2.0f) return {};

    const float padX = std::max(2.0f, width * 0.10f);
    const float padY = std::max(2.0f, height * 0.15f);
    left = std::clamp(left - padX, 0.0f, static_cast<float>(image.cols - 1));
    right = std::clamp(right + padX, 0.0f, static_cast<float>(image.cols - 1));
    top = std::clamp(top - padY, 0.0f, static_cast<float>(image.rows - 1));
    bottom = std::clamp(bottom + padY, 0.0f, static_cast<float>(image.rows - 1));
    if (right - left <= 2.0f || bottom - top <= 2.0f) return {};

    const std::vector<cv::Point2f> axisAligned = {
        {left, top}, {right, top}, {right, bottom}, {left, bottom}
    };
    return prepare_plate_recognition_roi(
        image, axisAligned, double_layer, 0.0f);
}

static PlateQuadGeometry plate_geometry_from_cv(
        const std::vector<cv::Point2f>& points) {
    const std::vector<cv::Point2f> ordered = ordered_plate_points(points);
    if (ordered.size() != 4) return {};
    std::array<PlateSlidingPoint, 4> converted{};
    for (size_t i = 0; i < converted.size(); ++i) {
        converted[i] = {ordered[i].x, ordered[i].y};
    }
    return plateQuadGeometry(converted);
}

static float plate_min_short_edge() {
    float value = 10.0f;
    if (const char* s = std::getenv("RK3568_PLATE_MIN_SHORT_EDGE")) {
        char* end = nullptr;
        const float parsed = std::strtof(s, &end);
        if (end != s && std::isfinite(parsed)) value = parsed;
    }
    return std::clamp(value, 4.0f, 80.0f);
}

static double plate_min_sharpness() {
    double value = 18.0;
    if (const char* s = std::getenv("RK3568_PLATE_MIN_SHARPNESS")) {
        char* end = nullptr;
        const double parsed = std::strtod(s, &end);
        if (end != s && std::isfinite(parsed)) value = parsed;
    }
    return std::clamp(value, 0.0, 500.0);
}

static double plate_roi_sharpness(const cv::Mat& roi) {
    if (roi.empty()) return 0.0;
    cv::Mat gray;
    if (roi.channels() == 1) gray = roi;
    else cv::cvtColor(roi, gray, cv::COLOR_BGR2GRAY);
    cv::Mat laplacian;
    cv::Laplacian(gray, laplacian, CV_32F, 3);
    cv::Scalar mean;
    cv::Scalar stddev;
    cv::meanStdDev(laplacian, mean, stddev);
    return stddev[0] * stddev[0];
}

struct PlateGlyphBandAnalysis {
    bool valid = false;
    int components = 0;
    float score = 0.0f;
};

static PlateGlyphBandAnalysis analyze_plate_glyph_mask(const cv::Mat& mask) {
    PlateGlyphBandAnalysis result;
    if (mask.empty() || mask.type() != CV_8UC1 ||
        mask.cols < 24 || mask.rows < 12) {
        return result;
    }

    cv::Mat work = mask.clone();
    const int borderX = std::max(1, work.cols / 84);
    const int borderY = std::max(1, work.rows / 24);
    work.rowRange(0, borderY).setTo(0);
    work.rowRange(work.rows - borderY, work.rows).setTo(0);
    work.colRange(0, borderX).setTo(0);
    work.colRange(work.cols - borderX, work.cols).setTo(0);
    cv::morphologyEx(
        work, work, cv::MORPH_CLOSE,
        cv::getStructuringElement(cv::MORPH_RECT, cv::Size(2, 2)));

    cv::Mat labels, stats, centroids;
    const int count = cv::connectedComponentsWithStats(
        work, labels, stats, centroids, 8, CV_32S);
    struct GlyphComponent {
        int left = 0;
        int right = 0;
        int height = 0;
        int area = 0;
        float centerY = 0.0f;
    };
    std::vector<GlyphComponent> components;
    components.reserve(std::max(0, count - 1));
    const float imageArea = static_cast<float>(work.total());
    for (int i = 1; i < count; ++i) {
        const int x = stats.at<int>(i, cv::CC_STAT_LEFT);
        const int y = stats.at<int>(i, cv::CC_STAT_TOP);
        const int width = stats.at<int>(i, cv::CC_STAT_WIDTH);
        const int height = stats.at<int>(i, cv::CC_STAT_HEIGHT);
        const int area = stats.at<int>(i, cv::CC_STAT_AREA);
        const float fill = static_cast<float>(area) /
            std::max(1.0f, static_cast<float>(width * height));
        if (height < 0.25f * work.rows || height > 0.92f * work.rows ||
            width < 2 || width > 0.22f * work.cols ||
            area < std::max(5.0f, 0.0015f * imageArea) ||
            area > 0.12f * imageArea || fill < 0.08f || fill > 0.95f ||
            x <= borderX || x + width >= work.cols - borderX ||
            y <= borderY || y + height >= work.rows - borderY) {
            continue;
        }
        components.push_back({x, x + width, height, area,
                              static_cast<float>(centroids.at<double>(i, 1))});
    }
    if (components.size() < 4 || components.size() > 18) return result;

    std::vector<float> centers;
    std::vector<int> heights;
    centers.reserve(components.size());
    heights.reserve(components.size());
    for (const auto& component : components) {
        centers.push_back(component.centerY);
        heights.push_back(component.height);
    }
    const size_t middle = centers.size() / 2;
    std::nth_element(centers.begin(), centers.begin() + middle, centers.end());
    std::nth_element(heights.begin(), heights.begin() + middle, heights.end());
    const float medianCenter = centers[middle];
    const float medianHeight = static_cast<float>(heights[middle]);

    int aligned = 0;
    int minLeft = work.cols;
    int maxRight = 0;
    int alignedArea = 0;
    for (const auto& component : components) {
        const bool centerAligned =
            std::fabs(component.centerY - medianCenter) <= 0.18f * work.rows;
        const bool heightAligned = component.height >= 0.45f * medianHeight &&
                                   component.height <= 1.80f * medianHeight;
        if (!centerAligned || !heightAligned) continue;
        ++aligned;
        minLeft = std::min(minLeft, component.left);
        maxRight = std::max(maxRight, component.right);
        alignedArea += component.area;
    }
    const float span = aligned > 0
        ? static_cast<float>(maxRight - minLeft) / work.cols : 0.0f;
    const float coverage = static_cast<float>(alignedArea) / imageArea;
    result.components = aligned;
    result.score = std::clamp(
        0.12f * aligned + 0.90f * span + 0.50f * coverage, 0.0f, 3.0f);
    result.valid = aligned >= 4 && aligned <= 14 &&
                   span >= 0.38f && coverage >= 0.018f && coverage <= 0.48f;
    return result;
}

static int count_projection_runs(const std::vector<uint8_t>& active) {
    int runs = 0;
    bool inside = false;
    for (uint8_t value : active) {
        if (value && !inside) {
            ++runs;
            inside = true;
        } else if (!value) {
            inside = false;
        }
    }
    return runs;
}

static bool plate_grid_pattern(const cv::Mat& gray,
                               int& verticalRuns, int& horizontalRuns) {
    verticalRuns = 0;
    horizontalRuns = 0;
    if (gray.empty() || gray.type() != CV_8UC1 ||
        gray.cols < 24 || gray.rows < 12) {
        return false;
    }
    cv::Mat edges;
    cv::Canny(gray, edges, 50.0, 150.0, 3, true);
    const int x0 = std::max(2, gray.cols / 20);
    const int x1 = std::min(gray.cols - 2, gray.cols - x0);
    const int y0 = std::max(2, gray.rows / 10);
    const int y1 = std::min(gray.rows - 2, gray.rows - y0);
    if (x1 <= x0 || y1 <= y0) return false;

    std::vector<uint8_t> vertical(static_cast<size_t>(x1 - x0), 0);
    std::vector<uint8_t> horizontal(static_cast<size_t>(y1 - y0), 0);
    for (int x = x0; x < x1; ++x) {
        const int pixels = cv::countNonZero(edges(cv::Rect(x, y0, 1, y1 - y0)));
        vertical[static_cast<size_t>(x - x0)] =
            pixels >= static_cast<int>(0.72f * (y1 - y0));
    }
    for (int y = y0; y < y1; ++y) {
        const int pixels = cv::countNonZero(edges(cv::Rect(x0, y, x1 - x0, 1)));
        horizontal[static_cast<size_t>(y - y0)] =
            pixels >= static_cast<int>(0.70f * (x1 - x0));
    }
    verticalRuns = count_projection_runs(vertical);
    horizontalRuns = count_projection_runs(horizontal);
    return (verticalRuns >= 4 && horizontalRuns >= 2) ||
           (verticalRuns >= 9 && horizontalRuns >= 1);
}

struct PlateAppearanceAnalysis {
    bool assessable = false;
    bool glyph_layout = false;
    bool grid_pattern = false;
    int glyph_components = 0;
    int vertical_grid_lines = 0;
    int horizontal_grid_lines = 0;
    float glyph_score = 0.0f;
    float dominant_color_ratio = 0.0f;
    float contrast = 0.0f;
};

static PlateAppearanceAnalysis analyze_plate_appearance(
        const cv::Mat& roi, float sourceShortEdge, double sharpness,
        float minShortEdge, double minSharpness,
        const RoiColorAnalysis& colorAnalysis) {
    PlateAppearanceAnalysis result;
    if (roi.empty()) return result;

    cv::Mat gray;
    if (roi.channels() == 1) gray = roi;
    else cv::cvtColor(roi, gray, cv::COLOR_BGR2GRAY);
    cv::Scalar mean, stddev;
    cv::meanStdDev(gray, mean, stddev);
    result.contrast = static_cast<float>(stddev[0]);
    const float assessableSize = std::max(16.0f, 1.5f * minShortEdge);
    const double assessableSharpness = std::max(30.0, 1.5 * minSharpness);
    result.assessable = sourceShortEdge >= assessableSize &&
                        sharpness >= assessableSharpness &&
                        result.contrast >= 10.0f;

    cv::Mat binary;
    cv::threshold(gray, binary, 0, 255, cv::THRESH_BINARY | cv::THRESH_OTSU);
    const PlateGlyphBandAnalysis lightGlyphs =
        analyze_plate_glyph_mask(binary);
    cv::bitwise_not(binary, binary);
    const PlateGlyphBandAnalysis darkGlyphs =
        analyze_plate_glyph_mask(binary);
    const PlateGlyphBandAnalysis& bestGlyphs =
        lightGlyphs.score >= darkGlyphs.score ? lightGlyphs : darkGlyphs;
    result.glyph_layout = bestGlyphs.valid;
    result.glyph_components = bestGlyphs.components;
    result.glyph_score = bestGlyphs.score;

    result.dominant_color_ratio =
        roi_dominant_color_ratio(colorAnalysis);
    result.grid_pattern = plate_grid_pattern(
        gray, result.vertical_grid_lines, result.horizontal_grid_lines);
    return result;
}

struct PlateOcrAttempt {
    cv::Mat roi;
    std::string plate;
    float confidence = 0.0f;
    int color = -1;
    float color_model_confidence = 0.0f;
    float color_ratio = 0.0f;
    PlateAppearanceAnalysis appearance;
    PlateAuthenticityDecision authenticity;
    bool format_ok = false;
    bool confidence_ok = false;
};

struct PlateOcrDecision {
    PlateOcrAttempt result;
    bool accepted = false;
    bool retried = false;
    int attempt_count = 0;
    int agreement_votes = 0;
    float short_edge = 0.0f;
    double sharpness = 0.0;
    std::string status;
    std::string detail;
};

static PlateOcrAttempt infer_plate_roi(
        const cv::Mat& roi, int cls_id, float sourceShortEdge,
        double sharpness, float minShortEdge, double minSharpness,
        float detectorConfidence, int windowSupport) {
    PlateOcrAttempt attempt;
    attempt.roi = roi;
    if (roi.empty()) return attempt;

    const RoiColorAnalysis roiAnalysis = analyze_roi_color(roi);
    attempt.appearance = analyze_plate_appearance(
        roi, sourceShortEdge, sharpness, minShortEdge, minSharpness,
        roiAnalysis);
    cv::Mat roiRgb;
    const cv::Mat* recognitionInput = &roi;
    if (!g_rec_input_bgr) {
        cv::cvtColor(roi, roiRgb, cv::COLOR_BGR2RGB);
        recognitionInput = &roiRgb;
    }
    std::vector<float *> recRawFloat;
    std::vector<void *> recRawQuantized;
    if (rknn_rec->wantFloat()) {
        recRawFloat = rknn_rec->inference(recognitionInput->data);
    } else {
        recRawQuantized = rknn_rec->inferenceRaw(recognitionInput->data);
    }
    const std::size_t outputCount = rknn_rec->output_attrs.size();
    if (g_rec_text_output_index < 0 || g_rec_color_output_index < 0 ||
        static_cast<std::size_t>(g_rec_text_output_index) >= outputCount ||
        static_cast<std::size_t>(g_rec_color_output_index) >= outputCount) {
        throw std::runtime_error("recognizer output mapping is invalid");
    }
    const auto makeOutputView = [&](int outputIndex) {
        RecognizerOutputView view;
        const std::size_t index = static_cast<std::size_t>(outputIndex);
        const rknn_tensor_attr &attr = rknn_rec->output_attrs[index];
        if (rknn_rec->wantFloat()) {
            view.data = recRawFloat[index];
        } else {
            view.raw_data = recRawQuantized[index];
            view.quantized = attr.type == RKNN_TENSOR_INT8 ||
                             attr.type == RKNN_TENSOR_UINT8;
            view.uint8 = attr.type == RKNN_TENSOR_UINT8;
            view.zero_point = attr.zp;
            view.scale = attr.scale;
        }
        return view;
    };
    const RecognizerOutputView textOutput =
        makeOutputView(g_rec_text_output_index);
    const RecognizerOutputView colorOutput =
        makeOutputView(g_rec_color_output_index);
    decode_plate(textOutput,
                 attempt.plate, attempt.confidence);
    int modelColor = -1;
    attempt.color = correct_color(
        colorOutput,
        roiAnalysis, cls_id,
        &attempt.color_model_confidence, &modelColor);
    attempt.color_ratio = roi_color_ratio(roiAnalysis, attempt.color);
    attempt.format_ok = plateTextPlausible(attempt.plate);
    attempt.confidence_ok =
        static_cast<int>(attempt.confidence * 1000.0f) >=
        g_color_cfg.rec_conf_threshold;
    const float modelColorRatio = roi_color_ratio(roiAnalysis, modelColor);
    const bool colorSupported =
        attempt.color_model_confidence >= 0.82f ||
        attempt.appearance.dominant_color_ratio >= 0.45f ||
        (attempt.color_model_confidence >= 0.50f &&
         std::max(attempt.color_ratio, modelColorRatio) >= 0.08f);
    PlateAuthenticityEvidence evidence;
    evidence.assessable = attempt.appearance.assessable;
    evidence.glyph_layout = attempt.appearance.glyph_layout;
    evidence.color_supported = colorSupported;
    evidence.grid_pattern = attempt.appearance.grid_pattern;
    evidence.detector_strong = plateDetectorEvidenceStrong(
        detectorConfidence, windowSupport);
    evidence.spatial_support = windowSupport >= 2;
    evidence.ocr_plausible = attempt.format_ok;
    const float configuredOcrThreshold =
        static_cast<float>(g_color_cfg.rec_conf_threshold) / 1000.0f;
    evidence.ocr_strong = attempt.format_ok &&
        attempt.confidence >= std::max(0.72f, configuredOcrThreshold);
    attempt.authenticity = plateAuthenticityDecision(evidence);
    return attempt;
}

static bool better_ocr_attempt(const PlateOcrAttempt& candidate,
                               const PlateOcrAttempt& current) {
    const auto authenticityRank = [](PlateAuthenticityState state) {
        switch (state) {
        case PlateAuthenticityState::Supported: return 4;
        case PlateAuthenticityState::Unassessed: return 3;
        case PlateAuthenticityState::Ambiguous: return 2;
        case PlateAuthenticityState::Rejected: return 1;
        }
        return 0;
    };
    return plateOcrAttemptPreferred(
        {candidate.format_ok,
         candidate.authenticity.allow_ocr_confirmation,
         authenticityRank(candidate.authenticity.state),
         candidate.confidence},
        {current.format_ok,
         current.authenticity.allow_ocr_confirmation,
         authenticityRank(current.authenticity.state),
         current.confidence});
}

static PlateOcrDecision recognize_plate_candidate(
        const cv::Mat& image, const std::vector<cv::Point2f>& points,
        int cls_id, const PlateSlidingBox* detectorBox = nullptr,
        bool requireCropAgreement = false, float detectorConfidence = 0.0f,
        int windowSupport = 1) {
    PlateOcrDecision decision;
    const PlateQuadGeometry geometry = plate_geometry_from_cv(points);
    decision.short_edge = std::min(geometry.width, geometry.height);
    const float minShortEdge = plate_min_short_edge();
    if (!geometry.convex || decision.short_edge < 4.0f) {
        decision.status = "too_small";
        char detail[128];
        std::snprintf(detail, sizeof(detail),
                      "short_edge=%.2f,min=%.2f,convex=%d",
                      decision.short_edge, minShortEdge, geometry.convex ? 1 : 0);
        decision.detail = detail;
        return decision;
    }
    const bool belowConfiguredSize = decision.short_edge < minShortEdge;

    cv::Mat primary = prepare_plate_recognition_roi(
        image, points, cls_id == 1, 0.075f);
    cv::Mat tight = prepare_plate_recognition_roi(
        image, points, cls_id == 1, 0.020f);
    if (primary.empty() && tight.empty()) {
        decision.status = "invalid_roi";
        decision.detail = "perspective_transform_failed";
        return decision;
    }

    const double primarySharpness = plate_roi_sharpness(primary);
    const double tightSharpness = plate_roi_sharpness(tight);
    decision.sharpness = std::max(primarySharpness, tightSharpness);
    const double minSharpness = plate_min_sharpness();
    const bool belowConfiguredSharpness =
        minSharpness > 0.0 && decision.sharpness < minSharpness;

    // Size and sharpness are noisy at night. They affect how much evidence is
    // required, but must not discard a candidate before OCR can inspect it.
    const bool weakQuality =
        belowConfiguredSize && belowConfiguredSharpness;
    const float strictThreshold =
        static_cast<float>(g_color_cfg.rec_conf_threshold) / 1000.0f;
    const auto directAccepted = [&](const PlateOcrAttempt& attempt) {
        if (!attempt.authenticity.allow_ocr_confirmation) return false;
        if (!attempt.format_ok || !attempt.confidence_ok) return false;
        if (!weakQuality) return true;
        return attempt.confidence >= std::min(0.98f, strictThreshold + 0.10f);
    };
    const float agreementThreshold =
        std::max(0.40f, strictThreshold - 0.25f);

    // Keep the established 7.5% crop first unless only the tighter crop passes
    // the quality gate. The second RKNN call happens only after an OCR failure.
    const bool tightFirst = primary.empty() ||
        (primarySharpness < minSharpness && tightSharpness >= minSharpness);
    const cv::Mat& firstRoi = tightFirst ? tight : primary;
    const cv::Mat& secondRoi = tightFirst ? primary : tight;
    const double firstSharpness = tightFirst ? tightSharpness : primarySharpness;
    const double secondSharpness = tightFirst ? primarySharpness : tightSharpness;
    PlateOcrAttempt first = infer_plate_roi(
        firstRoi, cls_id, decision.short_edge, firstSharpness,
        minShortEdge, minSharpness, detectorConfidence, windowSupport);
    std::vector<PlateOcrAttempt> attempts;
    attempts.reserve(3);
    attempts.push_back(first);
    decision.attempt_count = 1;
    decision.result = first;
    decision.accepted = !requireCropAgreement && directAccepted(first);

    const auto applyCropConsensus = [&]() {
        std::vector<PlateOcrVote> votes;
        votes.reserve(attempts.size());
        for (const PlateOcrAttempt &attempt : attempts) {
            votes.push_back({
                attempt.plate, attempt.confidence, attempt.format_ok,
                attempt.authenticity.allow_ocr_confirmation
            });
        }
        const PlateOcrVoteConsensus consensus = plateOcrVoteConsensus(
            votes, agreementThreshold);
        decision.agreement_votes = consensus.matching_votes;
        if (!consensus.accepted) return false;

        const PlateOcrAttempt *bestMatching = nullptr;
        for (const PlateOcrAttempt &attempt : attempts) {
            if (attempt.plate != consensus.text || !attempt.format_ok ||
                !attempt.authenticity.allow_ocr_confirmation) {
                continue;
            }
            if (!bestMatching || better_ocr_attempt(attempt, *bestMatching)) {
                bestMatching = &attempt;
            }
        }
        if (bestMatching) decision.result = *bestMatching;
        decision.accepted = true;
        return true;
    };

    if (!decision.accepted && !secondRoi.empty()) {
        PlateOcrAttempt second = infer_plate_roi(
            secondRoi, cls_id, decision.short_edge, secondSharpness,
            minShortEdge, minSharpness, detectorConfidence, windowSupport);
        attempts.push_back(second);
        decision.attempt_count = static_cast<int>(attempts.size());
        decision.retried = true;
        const bool secondAccepted = directAccepted(second);
        if (better_ocr_attempt(second, decision.result)) decision.result = second;
        decision.accepted = !requireCropAgreement && secondAccepted;
        applyCropConsensus();
    }

    // Landmark regression occasionally covers only part of a plate even when
    // the detector box is useful. A padded axis-aligned crop is a rare third
    // attempt and therefore does not add work to successful OCR calls.
    if (!decision.accepted) {
        cv::Mat fallback = prepare_plate_fallback_roi(
            image, points, cls_id == 1, detectorBox);
        if (!fallback.empty()) {
            const double fallbackSharpness = plate_roi_sharpness(fallback);
            PlateOcrAttempt fallbackAttempt = infer_plate_roi(
                fallback, cls_id, decision.short_edge, fallbackSharpness,
                minShortEdge, minSharpness, detectorConfidence, windowSupport);
            attempts.push_back(fallbackAttempt);
            decision.attempt_count = static_cast<int>(attempts.size());
            decision.retried = true;
            const bool fallbackAccepted = directAccepted(fallbackAttempt);
            if (better_ocr_attempt(fallbackAttempt, decision.result)) {
                decision.result = fallbackAttempt;
            }
            decision.accepted = !requireCropAgreement && fallbackAccepted;
            applyCropConsensus();
        }
    }

    // Independent SD/evaluation images have no temporal evidence. Prefer two
    // agreeing crops, while retaining an escape hatch for an exceptionally
    // confident single crop when perspective makes the alternatives unusable.
    if (requireCropAgreement && !decision.accepted &&
        decision.result.authenticity.allow_ocr_confirmation &&
        decision.result.format_ok &&
        decision.result.confidence >=
            std::max(0.92f, strictThreshold + 0.20f)) {
        decision.accepted = true;
    }

    if (!decision.result.authenticity.retain_candidate) {
        decision.accepted = false;
        decision.status = decision.result.authenticity.state ==
                PlateAuthenticityState::Rejected
            ? "non_plate_appearance" : "ambiguous_appearance";
    } else if (decision.accepted) decision.status = decision.retried ? "ok_retry" : "ok";
    else if (decision.result.plate.empty()) decision.status = "ocr_empty";
    else if (!decision.result.format_ok) decision.status = "invalid_plate_format";
    else if (!decision.result.confidence_ok) decision.status = "low_ocr_confidence";
    else if (requireCropAgreement && decision.attempt_count >= 2 &&
             decision.agreement_votes < 2) decision.status = "crop_disagreement";
    else if (belowConfiguredSize) decision.status = "too_small";
    else if (belowConfiguredSharpness) decision.status = "too_blurry";
    else decision.status = "low_ocr_confidence";

    if (!decision.accepted) {
        char detail[448];
        std::snprintf(detail, sizeof(detail),
                      "text=%s,confidence=%.4f,format_ok=%d,retried=%d,"
                      "attempts=%d,agreement_votes=%d,"
                      "short_edge=%.2f,sharpness=%.2f,auth=%s,assessable=%d,"
                      "glyph=%d,glyph_count=%d,color_model=%.3f,color_ratio=%.3f,"
                      "dominant_color=%.3f,grid=%d,grid_lines=%dx%d",
                      decision.result.plate.c_str(), decision.result.confidence,
                      decision.result.format_ok ? 1 : 0,
                      decision.retried ? 1 : 0,
                      decision.attempt_count,
                      decision.agreement_votes,
                      decision.short_edge, decision.sharpness,
                      plateAuthenticityName(decision.result.authenticity.state),
                      decision.result.appearance.assessable ? 1 : 0,
                      decision.result.appearance.glyph_layout ? 1 : 0,
                      decision.result.appearance.glyph_components,
                      decision.result.color_model_confidence,
                      decision.result.color_ratio,
                      decision.result.appearance.dominant_color_ratio,
                      decision.result.appearance.grid_pattern ? 1 : 0,
                      decision.result.appearance.vertical_grid_lines,
                      decision.result.appearance.horizontal_grid_lines);
        decision.detail = detail;
    }
    return decision;
}

/**
 * @brief 绘制带阴影的中文字符 (修复 width 弃用警告并适配动态颜色)
 * @return 返回文字实际占用的宽度，用于动态调整背景框
 */
static int draw_chinese_text(cv::Mat& img, const std::string& text, cv::Point pos, cv::Scalar color, int font_size) {
    if (img.empty()) return 0;

    // 注意：OpenCV 默认是 BGR，但 Qt 绘图通常期望 RGB。
    // 如果 yolo_run 传入的是原图，这里建议使用 Format_RGB888 并在绘制前后保持一致
    QImage qimg((uchar*)img.data, img.cols, img.rows, img.step, QImage::Format_RGB888);
    QPainter painter(&qimg);
    
    // 开启抗锯齿，保证在 RK3568 高清输出时文字边缘不发虚
    painter.setRenderHint(QPainter::Antialiasing);
    painter.setRenderHint(QPainter::TextAntialiasing);

    // 1. 配置字体
    QFont font("WenQuanYi Zen Hei");
    font.setPixelSize(font_size);
    font.setBold(true); 
    painter.setFont(font);

    // 2. 精准计算宽度 (彻底消除 width 警告)
    QString qstr = QString::fromUtf8(text.c_str());
    QFontMetrics metrics(font);
    // horizontalAdvance 是 Qt 5.11+ 推荐的写法，比 width 更精准
    int text_w = metrics.horizontalAdvance(qstr); 

    // 3. 绘制文字阴影 (提升在大图背景下的辨识度)
    // 偏移 1 像素，使用半透明深色
    painter.setPen(QColor(0, 0, 0, 160)); 
    painter.drawText(pos.x + 1, pos.y + 1, qstr);

    // 4. 绘制主体文字
    // 将 OpenCV 的 Scalar 转换为 Qt 的 QColor (注意 BGR/RGB 顺序)
    // 默认使用 yolo_run 传进来的 text_color，通常为白色或灰色
    QColor textColor(color[0], color[1], color[2]);
    if (color == cv::Scalar(255, 255, 255)) {
        painter.setPen(Qt::white);
    } else {
        painter.setPen(textColor);
    }
    
    painter.drawText(pos.x, pos.y, qstr);

    painter.end();
    
    return text_w; 
}
static float g_conf_threshold = 0.25f;
static float g_nms_threshold = 0.45f;
static bool g_pose26_head_conf_enabled = false;
static std::array<float, 3> g_pose26_head_thresholds = {0.10f, 0.10f, 0.10f};
static float sliding_detection_threshold();

void set_yolo_threshold(float conf, float nms) {
    g_conf_threshold = conf;
    g_nms_threshold = nms;
}

void yolo_set_pose26_head_thresholds(bool enabled, float p3, float p4,
                                     float p5) {
    g_pose26_head_conf_enabled = enabled;
    g_pose26_head_thresholds = {
        std::clamp(p3, 0.001f, 0.999f),
        std::clamp(p4, 0.001f, 0.999f),
        std::clamp(p5, 0.001f, 0.999f)};
}

float yolo_effective_detection_threshold() {
    return g_conf_threshold;
}

float yolo_evaluation_detection_threshold() {
    return g_conf_threshold;
}

float yolo_ocr_acceptance_threshold() {
    return (float)g_color_cfg.rec_conf_threshold / 1000.0f;
}

// A still image has no temporal OCR history. Repeated detection in overlapping
// windows supplies independent spatial evidence, so one strict, plausible OCR
// result may be used even when alternate perspective crops disagree slightly.
static bool accept_static_window_consensus(
        const PlateOcrDecision& decision, float detectorConfidence,
        int windowSupport) {
    const float strictOcrThreshold =
        static_cast<float>(g_color_cfg.rec_conf_threshold) / 1000.0f;
    return plateStaticWindowEvidence(
               detectorConfidence, windowSupport, g_conf_threshold) &&
           decision.result.authenticity.retain_candidate &&
           decision.result.authenticity.allow_ocr_confirmation &&
           decision.result.format_ok && !decision.result.plate.empty() &&
           decision.result.confidence >= strictOcrThreshold;
}

/**
 * @brief 绘制虚线辅助函数
 */
void draw_dashed_line(cv::Mat& img, cv::Point pt1, cv::Point pt2, cv::Scalar color, int thickness) {
    float dist = std::sqrt(std::pow(pt1.x - pt2.x, 2) + std::pow(pt1.y - pt2.y, 2));
    if (dist < 1.0f) return;
    int dash_len = 4; 
    cv::Point2f direction = cv::Point2f(pt2.x - pt1.x, pt2.y - pt1.y) / dist;

    for (int i = 0; i < dist; i += dash_len * 2) {
        cv::Point start = pt1 + cv::Point(direction * i);
        cv::Point end = pt1 + cv::Point(direction * std::min((float)(i + dash_len), dist));
        cv::line(img, start, end, color, thickness);
    }
}

/**
 * @brief 绘制双层车牌透视辅助线
 */
void draw_plate_split_lines(cv::Mat &frame, const std::vector<cv::Point> &pts, const cv::Scalar &color) {
    float r_up = g_color_cfg.double_upper_ratio / 1000.0f;
    float r_low = g_color_cfg.double_lower_start / 1000.0f;

    // 根据 ztu::nn 的 landmarks 顺序进行线性插值
    cv::Point p_l_up = pts[0] + (pts[3] - pts[0]) * r_up;
    cv::Point p_r_up = pts[1] + (pts[2] - pts[1]) * r_up;
    cv::Point p_l_low = pts[0] + (pts[3] - pts[0]) * r_low;
    cv::Point p_r_low = pts[1] + (pts[2] - pts[1]) * r_low;

    draw_dashed_line(frame, p_l_up, p_r_up, color, 1);
    draw_dashed_line(frame, p_l_low, p_r_low, color, 1);
}
// ================= 核心流程 =================

static rknn_core_mask parse_core_mask();
static rknn_core_mask parse_core_mask_env(const char* env_name);

static std::vector<plate_detector::TensorView> detector_tensor_views(
        const ztu::rk::EzRknn *detector,
        const std::vector<float *> *buffers = nullptr,
        const std::vector<void *> *raw_buffers = nullptr) {
    std::vector<plate_detector::TensorView> views;
    if (!detector) return views;
    views.reserve(detector->output_attrs.size());
    for (size_t index = 0; index < detector->output_attrs.size(); ++index) {
        const rknn_tensor_attr &attr = detector->output_attrs[index];
        plate_detector::TensorView view;
        if (buffers && index < buffers->size()) view.data = (*buffers)[index];
        if (raw_buffers && index < raw_buffers->size()) {
            view.raw_data = (*raw_buffers)[index];
            view.quantized = attr.type == RKNN_TENSOR_INT8 ||
                             attr.type == RKNN_TENSOR_UINT8;
            view.uint8 = attr.type == RKNN_TENSOR_UINT8;
            view.zero_point = attr.zp;
            view.scale = attr.scale;
        }
        const bool channel_last_shape = attr.n_dims == 4 &&
            (attr.dims[3] == 2 || attr.dims[3] == 4 ||
             attr.dims[3] == 8 || attr.dims[3] == 45);
        view.layout = attr.fmt == RKNN_TENSOR_NHWC || channel_last_shape
            ? plate_detector::TensorLayout::Nhwc
            : plate_detector::TensorLayout::Nchw;
        view.dims.reserve(attr.n_dims);
        for (uint32_t dim = 0; dim < attr.n_dims; ++dim) {
            view.dims.push_back(static_cast<int>(attr.dims[dim]));
        }
        views.push_back(std::move(view));
    }
    return views;
}

static bool detector_supports_affine_quantized_outputs(
        const ztu::rk::EzRknn *detector) {
    if (!detector || detector->output_attrs.empty()) return false;
    return std::all_of(
        detector->output_attrs.begin(), detector->output_attrs.end(),
        [](const rknn_tensor_attr &attr) {
            return (attr.type == RKNN_TENSOR_INT8 ||
                    attr.type == RKNN_TENSOR_UINT8) &&
                   attr.qnt_type == RKNN_TENSOR_QNT_AFFINE_ASYMMETRIC &&
                   std::isfinite(attr.scale) && attr.scale > 0.0f;
        });
}

static std::unique_ptr<ztu::rk::EzRknn> create_detector(
        plate_detector::ProfileId profile_id, rknn_core_mask core_mask,
        std::string &model_path, std::string &error) {
    error.clear();
    const plate_detector::Profile &selected =
        plate_detector::profile(profile_id);
    const char *override_name = std::getenv("RK3568_PLATE_DET_MODEL");
    model_path = resolve_model_path(
        override_name && *override_name ? override_name : selected.model_file);

    try {
        auto detector = std::make_unique<ztu::rk::EzRknn>(
            model_path.c_str(), ztu::rk::EzRknn::Layout::CHW2HWC, core_mask);
        if (detector->input_attrs.empty() ||
            detector->input_attrs[0].n_dims != 4) {
            throw std::runtime_error("detector input must be one NHWC image");
        }
        const int input_height = detector->input_attrs[0].dims[1];
        const int input_width = detector->input_attrs[0].dims[2];
        std::string contract_error;
        if (!plate_detector::validateContract(
                profile_id, input_width, input_height,
                detector_tensor_views(detector.get()), contract_error)) {
            throw std::runtime_error("detector contract: " + contract_error);
        }

        const bool affine_quantized_outputs =
            detector_supports_affine_quantized_outputs(detector.get());
        const bool requested_quantized = env_enabled(
            "RK3568_DET_QUANTIZED_OUTPUT", true);
        if (selected.require_float_outputs || !affine_quantized_outputs) {
            detector->setWantFloat(true);
            if (requested_quantized && !affine_quantized_outputs) {
                std::fprintf(stderr,
                    "[detector] quantized_output_disabled profile=%s "
                    "reason=outputs_not_int8_or_uint8\n",
                    selected.key);
            }
        } else if (const char *want_float =
                       std::getenv("RK3568_DET_WANT_FLOAT")) {
            detector->setWantFloat(std::atoi(want_float) != 0);
        } else {
            // Configure the final output contract before warmup. Changing a
            // live RKNN context from float outputs to quantized preallocated
            // outputs after warmup can block the first real inference on the
            // RK3568 runtime.
            detector->setWantFloat(!requested_quantized);
        }

        if (env_enabled("RK3568_DET_WARMUP", true)) {
            std::vector<uint8_t> blank(detector->input_attrs[0].n_elems, 114);
            if (detector->wantFloat()) detector->inference(blank.data());
            else detector->inferenceRaw(blank.data());
        }
        std::fprintf(stderr,
            "[detector] profile_selected key=%s family=%s model=%s "
            "input=%dx%d output_contract=%s output_mode=%s "
            "raw_affine_supported=%d "
            "runtime=cpp_rknn_npu\n",
            selected.key, selected.family_name, model_path.c_str(),
            selected.input_width, selected.input_height,
            selected.output_contract,
            detector->wantFloat() ? "float" : "quantized",
            affine_quantized_outputs ? 1 : 0);
        return detector;
    } catch (const std::exception &exception) {
        error = exception.what();
        return nullptr;
    }
}

static std::unique_ptr<ztu::rk::EzRknn> create_recognizer(
        plate_recognizer::ProfileId profile_id, rknn_core_mask core_mask,
        bool allow_override, std::string &model_path,
        plate_recognizer::Contract &contract, std::string &error) {
    error.clear();
    const plate_recognizer::Profile &selected =
        plate_recognizer::profile(profile_id);
    model_path = resolve_plate_rec_model_path(profile_id, allow_override);

    try {
        auto recognizer = std::make_unique<ztu::rk::EzRknn>(
            model_path.c_str(), ztu::rk::EzRknn::Layout::CHW2HWC,
            core_mask);
        if (recognizer->input_attrs.size() != 1 ||
            recognizer->input_attrs[0].n_dims != 4) {
            throw std::runtime_error(
                "recognizer input must be one NHWC image");
        }
        const rknn_tensor_attr &input = recognizer->input_attrs[0];
        const int input_height = static_cast<int>(input.dims[1]);
        const int input_width = static_cast<int>(input.dims[2]);
        const int input_channels = static_cast<int>(input.dims[3]);
        if (input.type != RKNN_TENSOR_UINT8 && input.type != RKNN_TENSOR_INT8) {
            throw std::runtime_error(
                "recognizer model input type unsupported: " +
                std::to_string(static_cast<int>(input.type)) +
                " (supported model attributes: UINT8/INT8; transport: UINT8 NHWC)");
        }

        std::vector<plate_recognizer::TensorView> outputs;
        outputs.reserve(recognizer->output_attrs.size());
        for (const rknn_tensor_attr &attr : recognizer->output_attrs) {
            plate_recognizer::TensorView view;
            view.elements = attr.n_elems;
            view.dims.reserve(attr.n_dims);
            for (uint32_t index = 0; index < attr.n_dims; ++index) {
                view.dims.push_back(static_cast<int>(attr.dims[index]));
            }
            outputs.push_back(std::move(view));
        }
        if (!plate_recognizer::validateContract(
                profile_id, input_width, input_height, input_channels,
                outputs, contract, error)) {
            throw std::runtime_error("recognizer contract: " + error);
        }
        contract.input_type = static_cast<int>(input.type);
        contract.input_qnt_type = static_cast<int>(input.qnt_type);
        contract.input_zero_point = input.zp;
        contract.input_scale = input.scale;
        contract.input_fl = input.fl;

        const bool quantizedOutputs = !recognizer->output_attrs.empty() &&
            std::all_of(recognizer->output_attrs.begin(),
                        recognizer->output_attrs.end(),
                        [](const rknn_tensor_attr &attr) {
            return (attr.type == RKNN_TENSOR_INT8 ||
                    attr.type == RKNN_TENSOR_UINT8) &&
                   attr.qnt_type == RKNN_TENSOR_QNT_AFFINE_ASYMMETRIC &&
                   std::isfinite(attr.scale) && attr.scale > 0.0f;
        });
        // Keep INT8/UINT8 outputs in their native buffers. Float output is
        // only a compatibility fallback for a model with a non-affine or
        // floating-point output contract.
        recognizer->setWantFloat(!quantizedOutputs);
        if (env_enabled("RK3568_REC_WARMUP", true)) {
            std::vector<uint8_t> blank(input.n_elems, 0);
            if (recognizer->wantFloat()) recognizer->inference(blank.data());
            else recognizer->inferenceRaw(blank.data());
        }
        std::fprintf(stderr,
            "[recognizer] profile_selected key=%s model=%s "
            "input=%dx%d format=%s model_input_type=%s transport=UINT8_NHWC "
            "output_contract=%s text_layout=%s "
            "text_output=%d color_output=%d output_mode=%s runtime=cpp_rknn_npu\n",
            selected.key, model_path.c_str(), input_width, input_height,
            selected.input_bgr ? "BGR_UINT8_NHWC" : "RGB_UINT8_NHWC",
            input.type == RKNN_TENSOR_INT8 ? "INT8" : "UINT8",
            selected.output_contract,
            plate_recognizer::textLayoutName(contract.text_layout),
            contract.text_output_index, contract.color_output_index,
            recognizer->wantFloat() ? "float_fallback" : "quantized");
        return recognizer;
    } catch (const std::exception &exception) {
        error = exception.what();
        return nullptr;
    }
}

void yolo_init() {
  if (g_model_ready) return;
  if (rknn_det && rknn_rec) { g_model_ready = true; return; }

  std::lock_guard<std::mutex> model_lock(g_model_mutex);
  if (g_model_ready) return;
  try {
      rknn_core_mask det_mask = parse_core_mask_env("RK3568_DET_CORE_MASK");
      if (det_mask == RKNN_NPU_CORE_UNDEFINED) det_mask = parse_core_mask();
      rknn_core_mask rec_mask = parse_core_mask_env("RK3568_REC_CORE_MASK");
      if (rec_mask == RKNN_NPU_CORE_UNDEFINED) rec_mask = parse_core_mask();
      if(!rknn_det) {
          const plate_detector::ProfileId requested =
              plate_detector::profileFromInt(
                  g_requested_detector_profile.load(std::memory_order_acquire));
          std::string detector_error;
          std::unique_ptr<ztu::rk::EzRknn> detector = create_detector(
              requested, det_mask, g_det_model_path, detector_error);
          if (!detector) throw std::runtime_error(detector_error);
          rknn_det = detector.release();
          g_active_detector_profile = requested;
      }
       
      if(!rknn_rec) {
          const plate_recognizer::ProfileId requested =
              plate_recognizer::profileFromInt(
                  g_requested_recognizer_profile.load(
                      std::memory_order_acquire));
          std::string recognizer_error;
          std::string recognizer_path;
          plate_recognizer::Contract contract;
          std::unique_ptr<ztu::rk::EzRknn> recognizer = create_recognizer(
              requested, rec_mask, true, recognizer_path, contract,
              recognizer_error);
          if (!recognizer) throw std::runtime_error(recognizer_error);
          rknn_rec = recognizer.release();
          g_rec_model_path = recognizer_path;
          apply_recognizer_contract(requested, contract);
      }

      g_model_ready = (rknn_det && rknn_rec);
      g_model_error.clear();
  } catch (const std::exception& e) {
      const char* envDir = std::getenv("RK3568_MODEL_DIR");
      const plate_detector::Profile &requested = plate_detector::profile(
          plate_detector::profileFromInt(
              g_requested_detector_profile.load(std::memory_order_acquire)));
      std::string det_path = resolve_model_path(requested.model_file);
      const plate_recognizer::ProfileId requested_recognizer =
          plate_recognizer::profileFromInt(
              g_requested_recognizer_profile.load(
                  std::memory_order_acquire));
      std::string rec_path = resolve_plate_rec_model_path(
          requested_recognizer, true);
      g_model_error = std::string(e.what()) +
                      " | RK3568_MODEL_DIR=" + (envDir ? envDir : "") +
                      " | det=" + det_path +
                      " | rec=" + rec_path;
      if (rknn_det) { delete rknn_det; rknn_det = nullptr; }
      if (rknn_rec) { delete rknn_rec; rknn_rec = nullptr; }
      g_model_ready = false;
  }
}

bool yolo_reload_detector_profile(int profile_value, std::string &error) {
    const plate_detector::ProfileId requested =
        plate_detector::profileFromInt(profile_value);
    std::lock_guard<std::mutex> model_lock(g_model_mutex);
    rknn_core_mask det_mask = parse_core_mask_env("RK3568_DET_CORE_MASK");
    if (det_mask == RKNN_NPU_CORE_UNDEFINED) det_mask = parse_core_mask();

    std::string candidate_path;
    std::unique_ptr<ztu::rk::EzRknn> candidate = create_detector(
        requested, det_mask, candidate_path, error);
    if (!candidate) return false;

    ztu::rk::EzRknn *previous = rknn_det;
    rknn_det = candidate.release();
    g_active_detector_profile = requested;
    g_requested_detector_profile.store(
        plate_detector::profileToInt(requested), std::memory_order_release);
    g_det_model_path = candidate_path;
    g_model_ready = rknn_det && rknn_rec;
    g_model_error.clear();
    delete previous;
    yolo_reset_temporal_state();
    return true;
}

bool yolo_reload_recognizer_profile(int profile_value, std::string &error) {
    const plate_recognizer::ProfileId requested =
        plate_recognizer::profileFromInt(profile_value);
    std::lock_guard<std::mutex> model_lock(g_model_mutex);
    rknn_core_mask rec_mask = parse_core_mask_env("RK3568_REC_CORE_MASK");
    if (rec_mask == RKNN_NPU_CORE_UNDEFINED) rec_mask = parse_core_mask();

    std::string candidate_path;
    plate_recognizer::Contract candidate_contract;
    std::unique_ptr<ztu::rk::EzRknn> candidate = create_recognizer(
        requested, rec_mask, false, candidate_path, candidate_contract,
        error);
    if (!candidate) return false;

    ztu::rk::EzRknn *previous = rknn_rec;
    rknn_rec = candidate.release();
    g_rec_model_path = candidate_path;
    g_requested_recognizer_profile.store(
        plate_recognizer::profileToInt(requested),
        std::memory_order_release);
    apply_recognizer_contract(requested, candidate_contract);
    g_model_ready = rknn_det && rknn_rec;
    g_model_error.clear();
    delete previous;
    yolo_reset_temporal_state();
    return true;
}


struct PlateMemory {
    PlateConsensusState consensus;
    int life = 0; // 生命值：目标消失后，结果还能维持多少帧
    uint32_t last_ocr_detection = 0;
    bool display_suppressed = false;
    // Relaxed OCR is display-only. It helps tiny/blurred plates remain useful
    // on screen without allowing an invalid string to become a report event.
    std::string relaxed_display_text;
    int relaxed_display_color = 0;
    float relaxed_display_confidence = 0.0f;
};

// 静态缓存：Key 为 track_id 或位置索引
static std::map<std::string, PlateMemory> g_plate_cache;
static std::unordered_map<std::string, uint32_t> g_plate_cooldown;

static rknn_core_mask parse_core_mask() {
  const char* s = std::getenv("RK3568_RKNN_CORE_MASK");
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

static rknn_core_mask parse_core_mask_env(const char* env_name) {
  const char* s = std::getenv(env_name);
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

/**
 * @brief 核心推理与渲染主函数
 */
/**
 * @brief 智能获取文字物理宽度助手
 */
static int get_label_width(const std::string& text, int font_size) {
    QFont font("WenQuanYi Zen Hei");
    font.setPixelSize(font_size);
    font.setBold(true);
    return QFontMetrics(font).horizontalAdvance(QString::fromUtf8(text.c_str()));
}
static uint32_t g_frame_counter = 0;
static double g_last_det_box_ms = 0.0;
static double g_last_det_ocr_ms = 0.0;
static double g_last_det_pre_ms = 0.0;
static double g_last_det_npu_ms = 0.0;
static double g_last_det_npu_hw_ms = 0.0;
static double g_last_det_post_ms = 0.0;
static double g_last_det_e2e_ms = 0.0;
static double g_last_det_overlap_saved_ms = 0.0;
static bool g_last_det_executed = false;
static bool g_last_det_pipeline_enabled = false;
static bool g_last_det_pipeline_active = false;
static int g_last_det_task_count = 0;
static int g_last_det_score_candidates = 0;
static int g_last_det_decoded_candidates = 0;
static int g_last_det_final_candidates = 0;
static int g_last_det_configured_stride = 1;
static unsigned long long g_last_det_source_frame_sequence = 0;
static std::string g_last_det_strategy = "inactive";
static std::string g_last_det_preprocess_backend = "opencv";
static std::string g_last_det_preprocess_requested = "auto";
static std::string g_last_det_preprocess_fallback_reason;
static std::atomic<int> g_requested_quantized_output{-1};
static int g_plate_ocr_period = 5;
static int g_plate_ocr_fast_period = 1;
static int g_plate_stable_required = 2;
static uint32_t g_plate_cooldown_frames = 150;

struct DetCacheItem {
    int cls_id = -1;
    float prop = 0.0f;
    std::string custom_text;
    cv::Point pts_i[4];
    cv::Point2f pts_f[4];
    PlateSlidingBox box;
    PlateSlidingBox detector_box;
    uint64_t track_id = 0;
    int track_hits = 1;
    int window_support = 1;
    int source_idx = 0;
    uint32_t last_seen_frame = 0;
    uint32_t last_seen_detection = 0;
    bool full_frame_context = false;
    plate_display::VisualIdentitySignature visual_signature{};
    bool visual_signature_valid = false;
    bool visual_refresh_needed = false;
    bool visible = true;
    PlateAuthenticityState authenticity_state =
        PlateAuthenticityState::Unassessed;
    bool appearance_checked = false;
    bool retain_candidate = true;
};

struct PlateDetectionCandidate {
    int cls_id = -1;
    float prop = 0.0f;
    std::string custom_text;
    PlateSlidingBox box;
    PlateSlidingBox detector_box;
    std::array<cv::Point2f, 4> points{};
    uint8_t internal_edge_mask = PlateEdgeNone;
    bool touches_internal_edge = false;
    int window_support = 1;
    PlateSlidingWindow source_window;
    bool requires_fragment_merge = false;
    bool full_frame_context = false;
};

struct PlateDetectorStats {
    double pre_ms = 0.0;
    double npu_ms = 0.0;
    double npu_hw_ms = 0.0;
    double post_ms = 0.0;
    bool pipeline_active = false;
    std::string preprocess_backend = "opencv";
    std::string preprocess_requested = "auto";
    std::string preprocess_fallback_reason;
    int window_count = 0;
    int objectness_candidates = 0;
    int decoded_candidates = 0;
    int local_nms_kept = 0;
    int local_nms_rejected = 0;
    int score_rejected = 0;
    int unsupported_rejected = 0;
    int class_rejected = 0;
    int geometry_rejected = 0;
    int accepted_candidates = 0;
    int internal_edge_candidates = 0;
    int cross_nms_rejected = 0;
    int fragment_pairs_merged = 0;
    int work_width = 0;
    int work_height = 0;
};

static int plate_geometry_filter_env_int(const char *name, int defaultValue,
                                         int minimum, int maximum) {
    const char *value = std::getenv(name);
    if (!value || !*value) return defaultValue;
    char *end = nullptr;
    const long parsed = std::strtol(value, &end, 10);
    if (end == value) return defaultValue;
    const long bounded = std::max<long>(
        minimum, std::min<long>(maximum, parsed));
    return static_cast<int>(bounded);
}

static PlateGeometryFilterConfig current_plate_geometry_filter_config() {
    PlateGeometryFilterConfig config;
    config.enabled = env_enabled("RK3568_PLATE_GEOMETRY_FILTER", false);
    config.min_short_edge = static_cast<float>(plate_geometry_filter_env_int(
        "RK3568_PLATE_GEOMETRY_MIN_SHORT_EDGE", 8, 1, 200));
    config.min_area = static_cast<float>(plate_geometry_filter_env_int(
        "RK3568_PLATE_GEOMETRY_MIN_AREA", 80, 1, 100000));
    const int minAspectX100 = plate_geometry_filter_env_int(
        "RK3568_PLATE_GEOMETRY_MIN_ASPECT_X100", 100, 100, 1000);
    const int maxAspectX100 = plate_geometry_filter_env_int(
        "RK3568_PLATE_GEOMETRY_MAX_ASPECT_X100", 650,
        minAspectX100, 1000);
    config.min_aspect = minAspectX100 / 100.0f;
    config.max_aspect = maxAspectX100 / 100.0f;
    return config;
}

static std::vector<PlateDetectionCandidate> filter_plate_geometry_candidates(
        std::vector<PlateDetectionCandidate> candidates,
        PlateDetectorStats &stats) {
    const PlateGeometryFilterConfig config =
        current_plate_geometry_filter_config();
    if (!config.enabled) return candidates;

    const auto started = std::chrono::steady_clock::now();
    const size_t before = candidates.size();
    int rejectNonConvex = 0;
    int rejectShortEdge = 0;
    int rejectArea = 0;
    int rejectAspectLow = 0;
    int rejectAspectHigh = 0;
    std::vector<PlateDetectionCandidate> filtered;
    filtered.reserve(candidates.size());
    for (PlateDetectionCandidate &candidate : candidates) {
        const std::vector<cv::Point2f> points(
            candidate.points.begin(), candidate.points.end());
        const PlateQuadGeometry geometry = plate_geometry_from_cv(points);
        const PlateGeometryFilterResult result =
            plateGeometryFilter(geometry, config);
        if (result.keep) {
            filtered.push_back(std::move(candidate));
            continue;
        }
        switch (result.reason) {
        case PlateGeometryFilterRejectReason::NonConvex:
            ++rejectNonConvex;
            break;
        case PlateGeometryFilterRejectReason::ShortEdge:
            ++rejectShortEdge;
            break;
        case PlateGeometryFilterRejectReason::Area:
            ++rejectArea;
            break;
        case PlateGeometryFilterRejectReason::AspectLow:
            ++rejectAspectLow;
            break;
        case PlateGeometryFilterRejectReason::AspectHigh:
            ++rejectAspectHigh;
            break;
        case PlateGeometryFilterRejectReason::None:
            break;
        }
    }

    const int rejected = static_cast<int>(before - filtered.size());
    stats.geometry_rejected += rejected;
    stats.post_ms += std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - started).count();
    if (env_enabled("RK3568_PLATE_DEBUG", false)) {
        std::fprintf(stderr,
            "[plate-debug] geometry_filter before=%zu kept=%zu rejected=%d "
            "min_short=%.1f min_area=%.1f aspect=%.2f..%.2f "
            "reason(nonconvex=%d short=%d area=%d aspect_low=%d aspect_high=%d)\n",
            before, filtered.size(), rejected, config.min_short_edge,
            config.min_area, config.min_aspect, config.max_aspect,
            rejectNonConvex, rejectShortEdge, rejectArea,
            rejectAspectLow, rejectAspectHigh);
    }
    return filtered;
}

static std::vector<DetCacheItem> g_det_cache;
static std::vector<cv::Rect> g_last_overlay_regions;
static uint32_t g_last_sig = 0;
static bool g_has_sig = false;
static int g_det_age = 0;
static unsigned long long g_last_detection_source_sequence = 0;
static bool g_has_det_run = false;
static int g_plate_sig_force = 0;
static uint64_t g_next_plate_track_id = 1;
static uint32_t g_detection_counter = 0;
static int g_adaptive_scan_phase = 0;
static bool g_current_detection_retains_cache = false;
static bool g_current_scan_is_global = false;
static std::array<PlateSlidingWindow, 4> g_current_scan_regions{};
static constexpr int kMotionGridWidth = 64;
static constexpr int kMotionGridHeight = 36;
static constexpr int kMotionGridSize = kMotionGridWidth * kMotionGridHeight;
static std::array<std::array<uint8_t, kMotionGridSize>, 4> g_motion_luma{};
static std::array<bool, 4> g_motion_luma_valid{};
static std::array<int, 4> g_motion_preferred_strip{-1, -1, -1, -1};
static std::array<int, 4> g_motion_override_streak{};
static unsigned int g_pending_scene_cut_mask = 0u;

void yolo_reset_temporal_state() {
    g_det_cache.clear();
    g_last_overlay_regions.clear();
    g_plate_cache.clear();
    g_det_age = 0;
    g_pending_source_frame_sequence.store(0, std::memory_order_release);
    g_last_detection_source_sequence = 0;
    g_has_det_run = false;
    g_has_sig = false;
    g_last_sig = 0;
    g_detection_counter = 0;
    g_adaptive_scan_phase = 0;
    g_current_detection_retains_cache = false;
    g_current_scan_is_global = false;
    g_current_scan_regions = {};
    g_motion_luma = {};
    g_motion_luma_valid = {};
    g_motion_preferred_strip = {-1, -1, -1, -1};
    g_motion_override_streak = {};
    g_pending_scene_cut_mask = 0u;
    std::lock_guard<std::mutex> lock(g_report_mutex);
    g_report_events.clear();
}

static uint8_t sampled_luma(const cv::Mat &frame, int x, int y) {
    const uint8_t *pixel = frame.ptr<uint8_t>(y) + x * frame.channels();
    return static_cast<uint8_t>((29 * pixel[0] + 150 * pixel[1] +
                                 77 * pixel[2]) >> 8);
}

static unsigned int update_native_motion_state(const cv::Mat &frame) {
    g_motion_preferred_strip = {-1, -1, -1, -1};
    unsigned int sceneCutMask = 0u;
    if (frame.empty() || frame.channels() < 3 ||
        frame.cols != g_native_source_width * 2 ||
        frame.rows != g_native_source_height * 2) {
        return sceneCutMask;
    }

    for (int source = 0; source < 4; ++source) {
        if ((g_native_source_mask & (1u << source)) == 0u) continue;
        const int offsetX = (source & 1) * g_native_source_width;
        const int offsetY = (source >> 1) * g_native_source_height;
        std::array<uint8_t, kMotionGridSize> current{};
        std::array<uint64_t, 3> stripDiff{};
        uint64_t totalDiff = 0;
        int changedSamples = 0;

        for (int gy = 0; gy < kMotionGridHeight; ++gy) {
            const int localY = std::min(
                g_native_source_height - 1,
                ((2 * gy + 1) * g_native_source_height) /
                    (2 * kMotionGridHeight));
            for (int gx = 0; gx < kMotionGridWidth; ++gx) {
                const int localX = std::min(
                    g_native_source_width - 1,
                    ((2 * gx + 1) * g_native_source_width) /
                        (2 * kMotionGridWidth));
                const int index = gy * kMotionGridWidth + gx;
                const uint8_t value = sampled_luma(
                    frame, offsetX + localX, offsetY + localY);
                current[static_cast<size_t>(index)] = value;
                if (!g_motion_luma_valid[static_cast<size_t>(source)]) continue;

                const int difference = std::abs(
                    static_cast<int>(value) -
                    static_cast<int>(g_motion_luma[static_cast<size_t>(source)]
                                                      [static_cast<size_t>(index)]));
                totalDiff += static_cast<uint64_t>(difference);
                if (difference >= 32) ++changedSamples;
                for (int strip = 0; strip < 3; ++strip) {
                    const int stripX = strip * 320;
                    if (localX >= stripX && localX < stripX + 640) {
                        stripDiff[static_cast<size_t>(strip)] +=
                            static_cast<uint64_t>(difference);
                    }
                }
            }
        }

        if (g_motion_luma_valid[static_cast<size_t>(source)]) {
            const double meanDiff = static_cast<double>(totalDiff) /
                                    static_cast<double>(kMotionGridSize);
            const double changedRatio = static_cast<double>(changedSamples) /
                                        static_cast<double>(kMotionGridSize);
            const bool sceneCut =
                (meanDiff >= 24.0 && changedRatio >= 0.35) ||
                meanDiff >= 42.0;
            if (sceneCut) {
                sceneCutMask |= 1u << source;
            } else if (totalDiff >= 800u && changedSamples >= 8) {
                const auto best = std::max_element(
                    stripDiff.begin(), stripDiff.end());
                g_motion_preferred_strip[static_cast<size_t>(source)] =
                    static_cast<int>(std::distance(stripDiff.begin(), best));
            }
        }
        g_motion_luma[static_cast<size_t>(source)] = current;
        g_motion_luma_valid[static_cast<size_t>(source)] = true;
    }
    return sceneCutMask;
}

static bool capture_visual_signature(
        const cv::Mat &frame, const PlateSlidingBox &box,
        plate_display::VisualIdentitySignature &signature) {
    if (frame.empty() || frame.channels() < 3) return false;
    const int left = std::clamp(
        static_cast<int>(std::floor(box.left)), 0, frame.cols - 1);
    const int top = std::clamp(
        static_cast<int>(std::floor(box.top)), 0, frame.rows - 1);
    const int right = std::clamp(
        static_cast<int>(std::ceil(box.right)), left + 1, frame.cols);
    const int bottom = std::clamp(
        static_cast<int>(std::ceil(box.bottom)), top + 1, frame.rows);
    if (right - left < 2 || bottom - top < 2) return false;

    constexpr int kGridWidth = 16;
    constexpr int kGridHeight = 8;
    for (int gy = 0; gy < kGridHeight; ++gy) {
        const int y = std::min(
            bottom - 1,
            top + ((2 * gy + 1) * (bottom - top)) / (2 * kGridHeight));
        for (int gx = 0; gx < kGridWidth; ++gx) {
            const int x = std::min(
                right - 1,
                left + ((2 * gx + 1) * (right - left)) / (2 * kGridWidth));
            signature[static_cast<size_t>(gy * kGridWidth + gx)] =
                sampled_luma(frame, x, y);
        }
    }
    return true;
}

static bool cached_visual_changed(const cv::Mat &frame,
                                  const DetCacheItem &item) {
    if (!item.visual_signature_valid) return false;
    plate_display::VisualIdentitySignature current{};
    if (!capture_visual_signature(frame, item.box, current)) return true;
    return plate_display::visualIdentityChanged(
        item.visual_signature, item.visual_signature_valid, current, true);
}

static void purge_changed_sources(unsigned int sourceMask) {
    if (sourceMask == 0u) return;
    g_det_cache.erase(std::remove_if(g_det_cache.begin(), g_det_cache.end(),
        [sourceMask](const DetCacheItem &item) {
            return item.source_idx >= 1 && item.source_idx <= 4 &&
                   (sourceMask & (1u << (item.source_idx - 1))) != 0u;
        }), g_det_cache.end());

    for (auto it = g_plate_cache.begin(); it != g_plate_cache.end();) {
        bool erase = false;
        for (int source = 1; source <= 4; ++source) {
            const std::string prefix =
                "source_" + std::to_string(source) + ":";
            if ((sourceMask & (1u << (source - 1))) != 0u &&
                it->first.compare(0, prefix.size(), prefix) == 0) {
                erase = true;
                break;
            }
        }
        if (erase) it = g_plate_cache.erase(it);
        else ++it;
    }

    std::lock_guard<std::mutex> lock(g_report_mutex);
    g_report_events.erase(std::remove_if(
        g_report_events.begin(), g_report_events.end(),
        [sourceMask](const PlateReportEvent &event) {
            return event.source_idx >= 1 && event.source_idx <= 4 &&
                   (sourceMask & (1u << (event.source_idx - 1))) != 0u;
        }), g_report_events.end());
}

static inline uint32_t frame_sig(const cv::Mat& frame) {
    if (frame.empty() || !frame.data) return 0;
    uint32_t h = 2166136261u;
    int div = 48;
    if (const char* s = std::getenv("RK3568_PLATE_SIG_DIV")) {
        int v = std::atoi(s);
        if (v > 4 && v < 512) div = v;
    }
    const int c = frame.channels();
    const int stepX = std::max(1, div);
    const int stepY = std::max(1, div);
    for (int y = stepY / 2; y < frame.rows; y += stepY) {
        const uint8_t* row = frame.ptr<uint8_t>(y);
        for (int x = stepX / 2; x < frame.cols; x += stepX) {
            const uint8_t* px = row + x * c;
            const int b = px[0];
            const int g = px[1];
            const int r = px[2];
            const uint8_t y8 = (uint8_t)((77 * r + 150 * g + 29 * b) >> 8);
            const uint8_t q = (uint8_t)(y8 >> 4);
            h ^= (uint32_t)q;
            h *= 16777619u;
        }
    }
    return h;
}

static float sliding_detection_threshold() {
    float threshold = 0.10f;
    if (const char *s = std::getenv("RK3568_PLATE_SLIDING_CONF")) {
        char *end = nullptr;
        const float parsed = std::strtof(s, &end);
        if (end != s && std::isfinite(parsed)) threshold = parsed;
    }
    return std::clamp(threshold, 0.01f, 0.999f);
}

static int sliding_max_side() {
    int max_side = 1920;
    if (const char *s = std::getenv("RK3568_PLATE_SLIDING_MAX_SIDE")) {
        char *end = nullptr;
        const long parsed = std::strtol(s, &end, 10);
        if (end != s) {
            if (parsed == 0) return 0;
            if (parsed >= 640 && parsed <= 8192) max_side = static_cast<int>(parsed);
        }
    }
    return max_side;
}

static bool plate_debug_enabled() {
    return env_enabled("RK3568_PLATE_DEBUG", false);
}

static uint64_t plate_debug_image_hash(const cv::Mat &image) {
    if (image.empty() || !image.data) return 0;
    uint64_t hash = 1469598103934665603ull;
    const size_t rowBytes = static_cast<size_t>(image.cols) * image.elemSize();
    for (int row = 0; row < image.rows; ++row) {
        const uint8_t *data = image.ptr<uint8_t>(row);
        for (size_t index = 0; index < rowBytes; ++index) {
            hash ^= static_cast<uint64_t>(data[index]);
            hash *= 1099511628211ull;
        }
    }
    return hash;
}

static void print_plate_debug_summary(const PlateDetectorStats &stats,
                                      bool use_sliding, size_t final_count) {
    if (!plate_debug_enabled()) return;
    std::fprintf(stderr,
        "[plate-debug] frame sliding=%d work=%dx%d windows=%d objectness=%d decoded=%d "
        "local_nms=%d local_nms_reject=%d reject_score=%d reject_unsupported=%d "
        "reject_class=%d reject_geometry=%d "
        "accepted=%d internal_edge=%d cross_nms_reject=%d fragment_merge=%d final=%zu\n",
        use_sliding ? 1 : 0, stats.work_width, stats.work_height,
        stats.window_count, stats.objectness_candidates,
        stats.decoded_candidates, stats.local_nms_kept, stats.local_nms_rejected,
        stats.score_rejected, stats.unsupported_rejected,
        stats.class_rejected, stats.geometry_rejected,
        stats.accepted_candidates, stats.internal_edge_candidates,
        stats.cross_nms_rejected, stats.fragment_pairs_merged, final_count);
}

static int sliding_mode() {
    const char *s = std::getenv("RK3568_PLATE_SLIDING_MODE");
    if (!s || !*s) return 0; // auto: still images only
    const std::string value = lower_copy(s);
    if (value == "always" || value == "all" || value == "on") return 1;
    if (value == "off" || value == "disabled" || value == "none") return 2;
    const int mode = std::atoi(s);
    return mode >= 0 && mode <= 2 ? mode : 0;
}

static cv::Point2f map_detector_point(float x, float y,
                                      const ztu::cv::ResizeImpl &resize_param,
                                      int offset_x, int offset_y) {
    const auto mapped = ztu::cv::reverseMapPoint(
        static_cast<int>(std::lround(x)), static_cast<int>(std::lround(y)), resize_param);
    return cv::Point2f(static_cast<float>(mapped.first + offset_x),
                       static_cast<float>(mapped.second + offset_y));
}

static PlateSlidingBox box_from_points(const std::array<cv::Point2f, 4> &points) {
    PlateSlidingBox box;
    box.left = box.right = points[0].x;
    box.top = box.bottom = points[0].y;
    for (size_t i = 1; i < points.size(); ++i) {
        box.left = std::min(box.left, points[i].x);
        box.top = std::min(box.top, points[i].y);
        box.right = std::max(box.right, points[i].x);
        box.bottom = std::max(box.bottom, points[i].y);
    }
    return box;
}

enum class DetectorPreprocessBackend {
    Auto = 0,
    OpenCv = 1,
    Rga = 2
};

static DetectorPreprocessBackend requested_preprocess_backend() {
    const char *value = std::getenv("RK3568_DET_PREPROCESS_BACKEND");
    if (!value || !*value) return DetectorPreprocessBackend::Auto;
    if (std::strcmp(value, "1") == 0 || std::strcmp(value, "opencv") == 0) {
        return DetectorPreprocessBackend::OpenCv;
    }
    if (std::strcmp(value, "2") == 0 || std::strcmp(value, "rga") == 0) {
        return DetectorPreprocessBackend::Rga;
    }
    return DetectorPreprocessBackend::Auto;
}

static const char *preprocess_backend_name(DetectorPreprocessBackend backend) {
    switch (backend) {
    case DetectorPreprocessBackend::OpenCv: return "opencv";
    case DetectorPreprocessBackend::Rga: return "rga";
    default: return "auto";
    }
}

bool yolo_rga_available() {
#ifdef RK3568_HAVE_RGA
    return true;
#else
    return false;
#endif
}

struct PreparedPlatePatch {
    cv::Mat resized_rgb;
    ztu::cv::ResizeImpl resize_param{};
    double pre_ms = 0.0;
    bool valid = false;
    std::string backend = "opencv";
    std::string requested = "auto";
    std::string fallback_reason;
};

#ifdef RK3568_HAVE_RGA
static bool rga_resize_bgr(const cv::Mat &src, cv::Mat &dst) {
    if (src.empty() || dst.empty() || src.type() != CV_8UC3 ||
        dst.type() != CV_8UC3) {
        return false;
    }
    const int srcStridePixels = static_cast<int>(src.step / src.elemSize());
    rga_buffer_t srcBuffer = wrapbuffer_virtualaddr(
        const_cast<unsigned char *>(src.data), src.cols, src.rows,
        RK_FORMAT_BGR_888, srcStridePixels, src.rows);
    rga_buffer_t dstBuffer = wrapbuffer_virtualaddr(
        dst.data, dst.cols, dst.rows, RK_FORMAT_BGR_888,
        dst.cols, dst.rows);
    return imresize(srcBuffer, dstBuffer) == IM_STATUS_SUCCESS;
}
#endif

static PreparedPlatePatch prepare_plate_patch(const cv::Mat &patch,
                                               int model_w, int model_h,
                                               bool sliding_mode_enabled) {
    PreparedPlatePatch prepared;
    const auto started = std::chrono::steady_clock::now();
    const DetectorPreprocessBackend requested = requested_preprocess_backend();
    prepared.requested = preprocess_backend_name(requested);
    prepared.resize_param = ztu::cv::calculateResize(
        patch.cols, patch.rows, model_w, model_h);
    // The four comparison models were exported and calibrated with gray 114
    // letterbox padding. Keep the legacy detector's established live-video
    // black padding for compatibility.
    const cv::Scalar padColor =
        active_detector_profile().custom_decoder || sliding_mode_enabled
            ? cv::Scalar(114, 114, 114)
            : cv::Scalar(0, 0, 0);

    bool usedRga = false;
    if (requested != DetectorPreprocessBackend::OpenCv) {
#ifdef RK3568_HAVE_RGA
        cv::Mat resizedBgr(
            static_cast<int>(prepared.resize_param.scaleTargetHeight),
            static_cast<int>(prepared.resize_param.scaleTargetWidth),
            CV_8UC3);
        if (rga_resize_bgr(patch, resizedBgr)) {
            prepared.resized_rgb = cv::Mat(model_h, model_w, CV_8UC3, padColor);
            const cv::Rect content(
                static_cast<int>(prepared.resize_param.padLeft),
                static_cast<int>(prepared.resize_param.padTop),
                resizedBgr.cols, resizedBgr.rows);
            cv::cvtColor(resizedBgr, prepared.resized_rgb(content),
                         cv::COLOR_BGR2RGB);
            usedRga = true;
            prepared.backend = "rga";
        } else {
            prepared.fallback_reason = "rga_resize_failed";
        }
#else
        prepared.fallback_reason = "rga_not_compiled";
#endif
    }

    if (!usedRga) {
        cv::cvtColor(ztu::cv::resize(patch, prepared.resize_param, padColor),
                     prepared.resized_rgb, cv::COLOR_BGR2RGB);
        prepared.backend = "opencv";
    }
    prepared.valid = !prepared.resized_rgb.empty();
    prepared.pre_ms = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - started).count();
    return prepared;
}

static void detect_plate_patch(const cv::Mat &patch, int offset_x, int offset_y,
                               int work_width, int work_height,
                               bool sliding_mode_enabled,
                               bool full_frame_context,
                               float post_threshold, float candidate_threshold,
                               float final_threshold,
                               std::vector<PlateDetectionCandidate> &candidates,
                               PlateDetectorStats &stats,
                               const PreparedPlatePatch *prepared_input = nullptr) {
    if (patch.empty()) return;

    const auto tick = []() { return std::chrono::steady_clock::now(); };
    const auto elapsed_ms = [](const auto &start, const auto &end) {
        return std::chrono::duration<double, std::milli>(end - start).count();
    };
    const int model_w = rknn_det->input_attrs[0].dims[2];
    const int model_h = rknn_det->input_attrs[0].dims[1];

    PreparedPlatePatch localPrepared;
    if (!prepared_input) {
        localPrepared = prepare_plate_patch(
            patch, model_w, model_h, sliding_mode_enabled);
        prepared_input = &localPrepared;
    }
    if (!prepared_input->valid) return;
    const auto &resize_param = prepared_input->resize_param;
    const cv::Mat &resized_rgb = prepared_input->resized_rgb;
    stats.pre_ms += prepared_input->pre_ms;
    stats.preprocess_backend = prepared_input->backend;
    stats.preprocess_requested = prepared_input->requested;
    if (!prepared_input->fallback_reason.empty()) {
        stats.preprocess_fallback_reason = prepared_input->fallback_reason;
    }

    const bool trace_first_patch = g_frame_counter == 1;
    if (trace_first_patch) {
        std::fprintf(stderr,
            "[detector] first_patch_ready offset=%d,%d patch=%dx%d "
            "model=%dx%d backend=%s output_mode=%s\n",
            offset_x, offset_y, patch.cols, patch.rows, model_w, model_h,
            prepared_input->backend.c_str(),
            rknn_det->wantFloat() ? "float" : "quantized");
        std::fprintf(stderr,
            "[detector] first_npu_start offset=%d,%d\n",
            offset_x, offset_y);
    }

    const auto npu_start = tick();
    ztu::nn::object_detect_result_list detections;
    ztu::nn::yolov5_ztopt_3out_postprocess::postprocess_stats post_stats;
    std::vector<float *> detRawFloat;
    std::vector<void *> detRawQuantized;
    const plate_detector::Profile &detector_profile =
        active_detector_profile();
    if (detector_profile.require_float_outputs && !rknn_det->wantFloat()) {
        rknn_det->setWantFloat(true);
    }
    if (rknn_det->wantFloat()) {
        detRawFloat = rknn_det->inference(resized_rgb.data);
    } else {
        detRawQuantized = rknn_det->inferenceRaw(resized_rgb.data);
    }
    const auto npu_end = tick();
    if (trace_first_patch) {
        std::fprintf(stderr,
            "[detector] first_npu_done offset=%d,%d wall=%.2fms hw=%.2fms\n",
            offset_x, offset_y, elapsed_ms(npu_start, npu_end),
            rknn_det->lastRunDurationMs());
    }

    const auto post_start = tick();
    if (detector_profile.custom_decoder) {
        std::vector<plate_detector::Detection> profile_detections;
        plate_detector::DecodeStats decode_stats;
        std::string decode_error;
        std::array<float, 3> active_head_thresholds{};
        const std::array<float, 3> *head_thresholds = nullptr;
        if (g_pose26_head_conf_enabled &&
            detector_profile.family == plate_detector::Family::Yolo26) {
            for (size_t index = 0; index < active_head_thresholds.size(); ++index) {
                active_head_thresholds[index] = std::max(
                    final_threshold, g_pose26_head_thresholds[index]);
            }
            head_thresholds = &active_head_thresholds;
        }
        const std::vector<plate_detector::TensorView> views =
            rknn_det->wantFloat()
                ? detector_tensor_views(rknn_det, &detRawFloat)
                : detector_tensor_views(rknn_det, nullptr, &detRawQuantized);
        if (!plate_detector::decode(
                g_active_detector_profile, views,
                final_threshold,
                profile_detections, decode_stats, decode_error,
                head_thresholds)) {
            g_model_error = std::string("detector decode failed: ") +
                            decode_error;
            std::fprintf(stderr, "[detector] decode_failed profile=%s err=%s\n",
                         detector_profile.key, decode_error.c_str());
            return;
        }
        post_stats.objectness_candidates = decode_stats.score_candidates;
        post_stats.decoded_candidates = decode_stats.decoded_candidates;
        post_stats.nms_kept = decode_stats.nms_kept;
        detections.results.reserve(profile_detections.size());
        for (const plate_detector::Detection &source : profile_detections) {
            ztu::nn::object_detect_result result{};
            result.box.left = static_cast<int>(std::lround(source.left));
            result.box.top = static_cast<int>(std::lround(source.top));
            result.box.right = static_cast<int>(std::lround(source.right));
            result.box.bottom = static_cast<int>(std::lround(source.bottom));
            result.prop = source.confidence;
            result.cls_id = source.class_id;
            result.custom_text = source.head >= 0
                ? "P" + std::to_string(source.head + 3) : "P?";
            std::copy(source.landmarks.begin(), source.landmarks.end(),
                      result.landmarks);
            detections.results.push_back(std::move(result));
        }
        detections.count = static_cast<int>(detections.results.size());
    } else if (rknn_det->wantFloat()) {
        ztu::nn::yolov5_ztopt_3out_postprocess::postprocess(
            const_cast<const float **>(detRawFloat.data()),
            post_threshold, g_nms_threshold,
            &detections, model_w, model_h, classes.size(), &post_stats);
    } else {
        const void *outputs[3] = {
            detRawQuantized[0], detRawQuantized[1], detRawQuantized[2]
        };
        bool is_u8[3] = {false, false, false};
        int32_t zero_points[3] = {0, 0, 0};
        float scales[3] = {1.0f, 1.0f, 1.0f};
        for (int i = 0; i < 3 && i < static_cast<int>(rknn_det->output_attrs.size()); ++i) {
            zero_points[i] = rknn_det->output_attrs[i].zp;
            scales[i] = rknn_det->output_attrs[i].scale;
            is_u8[i] = rknn_det->output_attrs[i].type == RKNN_TENSOR_UINT8;
        }
        ztu::nn::yolov5_ztopt_3out_postprocess::postprocess_affine(
            outputs, is_u8, zero_points, scales,
            post_threshold, g_nms_threshold,
            &detections, model_w, model_h, classes.size(), &post_stats);
    }
    stats.objectness_candidates += post_stats.objectness_candidates;
    stats.decoded_candidates += post_stats.decoded_candidates;
    stats.local_nms_kept += post_stats.nms_kept;
    stats.local_nms_rejected += std::max(
        0, post_stats.decoded_candidates - post_stats.nms_kept);

    const float active_candidate_threshold =
        detector_profile.custom_decoder ? 0.0f : candidate_threshold;
    for (const auto &det : detections.results) {
        if (det.cls_id < 0 || det.cls_id >= static_cast<int>(classes.size())) {
            ++stats.class_rejected;
            if (plate_debug_enabled()) {
                std::fprintf(stderr,
                    "[plate-debug] window=(%d,%d %dx%d) reject=class class=%d score=%.6f\n",
                    offset_x, offset_y, patch.cols, patch.rows, det.cls_id, det.prop);
            }
            continue;
        }
        if (det.prop < active_candidate_threshold) {
            ++stats.score_rejected;
            if (plate_debug_enabled()) {
                std::fprintf(stderr,
                    "[plate-debug] window=(%d,%d %dx%d) reject=recall_score "
                    "score=%.6f recall_threshold=%.3f\n",
                    offset_x, offset_y, patch.cols, patch.rows,
                    det.prop, active_candidate_threshold);
            }
            continue;
        }

        PlateDetectionCandidate candidate;
        candidate.cls_id = det.cls_id;
        candidate.prop = det.prop;
        candidate.custom_text = det.custom_text;
        candidate.full_frame_context = full_frame_context;
        candidate.source_window = {
            offset_x, offset_y, patch.cols, patch.rows
        };
        for (int k = 0; k < 4; ++k) {
            candidate.points[(size_t)k] = map_detector_point(
                det.landmarks[k * 2], det.landmarks[k * 2 + 1],
                resize_param, offset_x, offset_y);
        }

        const std::vector<cv::Point2f> ordered = ordered_plate_points(
            std::vector<cv::Point2f>(candidate.points.begin(), candidate.points.end()));
        if (ordered.size() == 4) {
            for (int k = 0; k < 4; ++k) candidate.points[(size_t)k] = ordered[(size_t)k];
        }

        const cv::Point2f box_tl = map_detector_point(
            static_cast<float>(det.box.left), static_cast<float>(det.box.top),
            resize_param, offset_x, offset_y);
        const cv::Point2f box_br = map_detector_point(
            static_cast<float>(det.box.right), static_cast<float>(det.box.bottom),
            resize_param, offset_x, offset_y);
        candidate.box = {
            std::min(box_tl.x, box_br.x), std::min(box_tl.y, box_br.y),
            std::max(box_tl.x, box_br.x), std::max(box_tl.y, box_br.y)
        };
        candidate.detector_box = candidate.box;

        // Drawing and OCR both use the four landmarks, so NMS must use the
        // same visible geometry. Otherwise an auxiliary bbox can overlap while
        // the half-plate landmark box survives on screen.
        const PlateSlidingBox landmark_box = box_from_points(candidate.points);
        const float landmark_width = landmark_box.right - landmark_box.left;
        const float landmark_height = landmark_box.bottom - landmark_box.top;
        if (landmark_width > 0.0f && landmark_height > 0.0f) {
            candidate.box = landmark_box;
        }

        std::array<PlateSlidingPoint, 4> quadPoints{};
        for (int k = 0; k < 4; ++k) {
            quadPoints[(size_t)k] = {
                candidate.points[(size_t)k].x, candidate.points[(size_t)k].y
            };
        }
        const PlateQuadGeometry quad = plateQuadGeometry(quadPoints);
        const float minAspect = det.cls_id == 0 ? 1.25f : 0.70f;
        const float maxAspect = det.cls_id == 0 ? 9.00f : 4.50f;
        const float fragmentMinAspect = det.cls_id == 0 ? 0.55f : 0.40f;
        const float activeMinAspect = sliding_mode_enabled
            ? fragmentMinAspect
            : minAspect;
        if (!quad.convex || quad.width <= 5.0f || quad.height <= 5.0f ||
            quad.area <= 25.0f || quad.aspect <= activeMinAspect ||
            quad.aspect >= maxAspect) {
            ++stats.geometry_rejected;
            if (plate_debug_enabled()) {
                std::fprintf(stderr,
                    "[plate-debug] window=(%d,%d %dx%d) reject=geometry "
                    "score=%.6f box=(%.1f,%.1f,%.1f,%.1f) "
                    "quad=%.1fx%.1f aspect=%.3f area=%.1f convex=%d\n",
                    offset_x, offset_y, patch.cols, patch.rows, det.prop,
                    candidate.box.left, candidate.box.top,
                    candidate.box.right, candidate.box.bottom,
                    quad.width, quad.height, quad.aspect, quad.area,
                    quad.convex ? 1 : 0);
            }
            continue;
        }
        candidate.requires_fragment_merge =
            sliding_mode_enabled && quad.aspect <= minAspect;

        if (sliding_mode_enabled) {
            const float edge_margin = std::clamp(0.25f * quad.height, 12.0f, 32.0f);
            const bool has_left_neighbor = offset_x > 0;
            const bool has_top_neighbor = offset_y > 0;
            const bool has_right_neighbor = offset_x + patch.cols < work_width;
            const bool has_bottom_neighbor = offset_y + patch.rows < work_height;
            if (has_left_neighbor &&
                candidate.box.left <= offset_x + edge_margin) {
                candidate.internal_edge_mask |= PlateEdgeLeft;
            }
            if (has_right_neighbor &&
                candidate.box.right >= offset_x + patch.cols - edge_margin) {
                candidate.internal_edge_mask |= PlateEdgeRight;
            }
            if (has_top_neighbor &&
                candidate.box.top <= offset_y + edge_margin) {
                candidate.internal_edge_mask |= PlateEdgeTop;
            }
            if (has_bottom_neighbor &&
                candidate.box.bottom >= offset_y + patch.rows - edge_margin) {
                candidate.internal_edge_mask |= PlateEdgeBottom;
            }
            candidate.touches_internal_edge =
                candidate.internal_edge_mask != PlateEdgeNone;
            if (candidate.touches_internal_edge) ++stats.internal_edge_candidates;
        }
        if (plate_debug_enabled()) {
            std::fprintf(stderr,
                "[plate-debug] window=(%d,%d %dx%d) keep class=%d score=%.6f "
                "box=(%.1f,%.1f,%.1f,%.1f) size=%.1fx%.1f "
                "fragment_only=%d below_final=%d\n",
                offset_x, offset_y, patch.cols, patch.rows, det.cls_id, det.prop,
                candidate.box.left, candidate.box.top,
                candidate.box.right, candidate.box.bottom, quad.width, quad.height,
                candidate.requires_fragment_merge ? 1 : 0,
                det.prop < final_threshold ? 1 : 0);
        }
        candidates.push_back(std::move(candidate));
        ++stats.accepted_candidates;
    }
    const auto post_end = tick();
    if (trace_first_patch) {
        std::fprintf(stderr,
            "[detector] first_post_done offset=%d,%d post=%.2fms "
            "decoded=%d nms_input=%d truncated=%d candidates=%zu\n",
            offset_x, offset_y, elapsed_ms(post_start, post_end),
            post_stats.decoded_candidates,
            post_stats.nms_input_candidates,
            post_stats.pre_nms_truncated, candidates.size());
    }

    stats.npu_ms += elapsed_ms(npu_start, npu_end);
    stats.npu_hw_ms += rknn_det->lastRunDurationMs();
    stats.post_ms += elapsed_ms(post_start, post_end);
    ++stats.window_count;
    if (plate_debug_enabled()) {
        std::fprintf(stderr,
            "[plate-debug] window=(%d,%d %dx%d) objectness_threshold=%.3f "
            "candidate_threshold=%.3f final_threshold=%.3f "
            "objectness=%d decoded=%d local_nms=%d\n",
            offset_x, offset_y, patch.cols, patch.rows, post_threshold,
            active_candidate_threshold, final_threshold,
            post_stats.objectness_candidates,
            post_stats.decoded_candidates, post_stats.nms_kept);
    }
}

static PlateDetectionCandidate merge_plate_fragment_pair(
        const PlateDetectionCandidate &a, const PlateDetectionCandidate &b,
        PlateFragmentJoinDirection direction) {
    PlateDetectionCandidate merged;
    merged.prop = std::max(a.prop, b.prop);
    merged.custom_text.clear();
    merged.internal_edge_mask =
        static_cast<uint8_t>(a.internal_edge_mask | b.internal_edge_mask);
    merged.touches_internal_edge =
        merged.internal_edge_mask != PlateEdgeNone;
    merged.window_support = std::max(1, a.window_support) +
                            std::max(1, b.window_support);
    merged.requires_fragment_merge = false;
    const int mergedWindowLeft = std::min(
        a.source_window.x, b.source_window.x);
    const int mergedWindowTop = std::min(
        a.source_window.y, b.source_window.y);
    const int mergedWindowRight = std::max(
        a.source_window.x + a.source_window.width,
        b.source_window.x + b.source_window.width);
    const int mergedWindowBottom = std::max(
        a.source_window.y + a.source_window.height,
        b.source_window.y + b.source_window.height);
    merged.source_window = {
        mergedWindowLeft, mergedWindowTop,
        mergedWindowRight - mergedWindowLeft,
        mergedWindowBottom - mergedWindowTop
    };

    std::vector<cv::Point2f> allPoints;
    allPoints.reserve(8);
    allPoints.insert(allPoints.end(), a.points.begin(), a.points.end());
    allPoints.insert(allPoints.end(), b.points.begin(), b.points.end());
    const cv::RotatedRect rect = cv::minAreaRect(allPoints);
    cv::Point2f rawPoints[4];
    rect.points(rawPoints);
    const std::vector<cv::Point2f> ordered = ordered_plate_points(
        {rawPoints[0], rawPoints[1], rawPoints[2], rawPoints[3]});
    if (ordered.size() == 4) {
        for (size_t i = 0; i < merged.points.size(); ++i) {
            merged.points[i] = ordered[i];
        }
    } else {
        merged.points = a.points;
    }
    merged.box = box_from_points(merged.points);
    merged.detector_box = {
        std::min(a.detector_box.left, b.detector_box.left),
        std::min(a.detector_box.top, b.detector_box.top),
        std::max(a.detector_box.right, b.detector_box.right),
        std::max(a.detector_box.bottom, b.detector_box.bottom)
    };

    if (direction == PlateFragmentJoinDirection::Vertical) {
        merged.cls_id = 1;
    } else if (a.cls_id == b.cls_id) {
        merged.cls_id = a.cls_id;
    } else {
        std::array<PlateSlidingPoint, 4> points{};
        for (size_t i = 0; i < points.size(); ++i) {
            points[i] = {merged.points[i].x, merged.points[i].y};
        }
        merged.cls_id = plateQuadGeometry(points).aspect >= 1.75f ? 0 : 1;
    }
    return merged;
}

static void reconcile_plate_fragments(
        std::vector<PlateDetectionCandidate> &candidates,
        PlateDetectorStats &stats) {
    struct MergePair {
        size_t first = 0;
        size_t second = 0;
        PlateFragmentJoinDecision decision;
    };

    std::vector<MergePair> pairs;
    for (size_t i = 0; i < candidates.size(); ++i) {
        for (size_t j = i + 1; j < candidates.size(); ++j) {
            if (candidates[i].full_frame_context ||
                candidates[j].full_frame_context) {
                continue;
            }
            const PlateFragmentJoinDecision decision = plateSlidingFragmentJoin(
                candidates[i].box, candidates[j].box,
                candidates[i].cls_id, candidates[j].cls_id,
                candidates[i].internal_edge_mask,
                candidates[j].internal_edge_mask,
                &candidates[i].source_window,
                &candidates[j].source_window);
            if (decision.direction != PlateFragmentJoinDirection::None) {
                pairs.push_back({i, j, decision});
            }
        }
    }
    if (pairs.empty()) return;

    std::stable_sort(pairs.begin(), pairs.end(),
        [](const MergePair &a, const MergePair &b) {
            return a.decision.score > b.decision.score;
        });
    std::vector<bool> consumed(candidates.size(), false);
    std::vector<PlateDetectionCandidate> reconciled;
    reconciled.reserve(candidates.size());
    for (const MergePair &pair : pairs) {
        if (consumed[pair.first] || consumed[pair.second]) continue;
        reconciled.push_back(merge_plate_fragment_pair(
            candidates[pair.first], candidates[pair.second],
            pair.decision.direction));
        consumed[pair.first] = true;
        consumed[pair.second] = true;
        ++stats.fragment_pairs_merged;
    }
    for (size_t i = 0; i < candidates.size(); ++i) {
        if (!consumed[i]) reconciled.push_back(std::move(candidates[i]));
    }
    candidates.swap(reconciled);
}

static std::vector<PlateDetectionCandidate> detect_plate_candidates_single(
        const cv::Mat &frame, bool use_sliding, PlateDetectorStats &stats,
        bool emit_summary,
        const PreparedPlatePatch *prepared_input = nullptr) {
    std::vector<PlateDetectionCandidate> candidates;
    if (frame.empty() || !rknn_det || rknn_det->input_attrs.empty()) return candidates;

    cv::Mat work_frame = frame;
    PlateSlidingWorkSize work_size{frame.cols, frame.rows, 1.0f};
    if (use_sliding) {
        work_size = plateSlidingWorkSize(frame.cols, frame.rows, sliding_max_side());
        if (work_size.width != frame.cols || work_size.height != frame.rows) {
            cv::resize(frame, work_frame, cv::Size(work_size.width, work_size.height),
                       0.0, 0.0, cv::INTER_AREA);
        }
    }
    stats.work_width = work_frame.cols;
    stats.work_height = work_frame.rows;

    std::vector<PlateSlidingWindow> windows;
    if (use_sliding) {
        windows = makePlateSlidingWindows(work_frame.cols, work_frame.rows, 640, 320);
    } else {
        windows.push_back({0, 0, work_frame.cols, work_frame.rows});
    }

    const float post_threshold = use_sliding
        ? sliding_detection_threshold()
        : g_conf_threshold;
    const float candidate_threshold = use_sliding
        ? post_threshold
        : g_conf_threshold;
    const float final_threshold = g_conf_threshold;
    if (use_sliding && plateSlidingNeedsGlobalPass(
            work_frame.cols, work_frame.rows, 640)) {
        detect_plate_patch(
            work_frame, 0, 0, work_frame.cols, work_frame.rows,
            false, true, final_threshold, final_threshold, final_threshold,
            candidates, stats);
    }
    for (const PlateSlidingWindow &window : windows) {
        const cv::Rect rect(window.x, window.y, window.width, window.height);
        detect_plate_patch(work_frame(rect), window.x, window.y,
                           work_frame.cols, work_frame.rows, use_sliding, false,
                           post_threshold, candidate_threshold, final_threshold,
                           candidates, stats,
                           use_sliding ? nullptr : prepared_input);
    }

    const auto map_to_original = [&](std::vector<PlateDetectionCandidate> &items) {
        if (work_frame.cols == frame.cols && work_frame.rows == frame.rows) return;
        const float scale_x = static_cast<float>(frame.cols) / work_frame.cols;
        const float scale_y = static_cast<float>(frame.rows) / work_frame.rows;
        for (auto &candidate : items) {
            candidate.box.left *= scale_x;
            candidate.box.right *= scale_x;
            candidate.box.top *= scale_y;
            candidate.box.bottom *= scale_y;
            candidate.detector_box.left *= scale_x;
            candidate.detector_box.right *= scale_x;
            candidate.detector_box.top *= scale_y;
            candidate.detector_box.bottom *= scale_y;
            for (auto &point : candidate.points) {
                point.x *= scale_x;
                point.y *= scale_y;
            }
        }
    };

    if (!use_sliding) {
        map_to_original(candidates);
        if (emit_summary) {
            print_plate_debug_summary(stats, use_sliding, candidates.size());
        }
        return candidates;
    }

    const auto nms_start = std::chrono::steady_clock::now();
    // Reconstruct complementary edge fragments before NMS. Otherwise two
    // overlapping halves of a large plate can suppress each other before the
    // reconstruction code sees both candidates.
    if (candidates.size() >= 2) reconcile_plate_fragments(candidates, stats);

    const size_t beforeWeakGeometry = candidates.size();
    candidates.erase(std::remove_if(candidates.begin(), candidates.end(),
        [](const PlateDetectionCandidate &candidate) {
            return candidate.requires_fragment_merge;
        }), candidates.end());
    stats.geometry_rejected += static_cast<int>(
        beforeWeakGeometry - candidates.size());

    if (candidates.size() < 2) {
        if (!candidates.empty() && !plateSlidingCandidateHasEvidence(
                candidates[0].prop, final_threshold,
                candidates[0].window_support)) {
            ++stats.unsupported_rejected;
            candidates.clear();
        }
        map_to_original(candidates);
        const auto nms_end = std::chrono::steady_clock::now();
        stats.post_ms += std::chrono::duration<double, std::milli>(
            nms_end - nms_start).count();
        if (emit_summary) {
            print_plate_debug_summary(stats, use_sliding, candidates.size());
        }
        return candidates;
    }

    std::vector<PlateSlidingBox> boxes;
    std::vector<float> scores;
    std::vector<bool> internal_edges;
    boxes.reserve(candidates.size());
    scores.reserve(candidates.size());
    internal_edges.reserve(candidates.size());
    for (const auto &candidate : candidates) {
        boxes.push_back(candidate.box);
        scores.push_back(candidate.prop);
        // A global observation is a fallback until it proves that a local
        // candidate is only a fragment. This keeps local-window landmarks for
        // small plates when both passes found a similarly complete box.
        internal_edges.push_back(
            candidate.touches_internal_edge || candidate.full_frame_context);
    }
    for (size_t localIndex = 0; localIndex < candidates.size(); ++localIndex) {
        if (candidates[localIndex].full_frame_context) {
            continue;
        }
        for (size_t globalIndex = 0; globalIndex < candidates.size();
             ++globalIndex) {
            if (!candidates[globalIndex].full_frame_context) continue;
            if (plateSlidingGlobalSupersedesFragment(
                    boxes[globalIndex], boxes[localIndex])) {
                internal_edges[localIndex] = true;
                internal_edges[globalIndex] = false;
                break;
            }
        }
    }
    const std::vector<int> keep = plateSlidingNms(
        boxes, scores, internal_edges, 0.3f, 0.65f);

    // Count how many overlapping windows independently support each retained
    // plate. This is later used as spatial evidence for one-frame SD images.
    std::vector<int> supportCounts;
    supportCounts.reserve(keep.size());
    for (int index : keep) {
        int support = 0;
        for (size_t candidateIndex = 0; candidateIndex < candidates.size();
             ++candidateIndex) {
            const float iou = plateSlidingIou(
                boxes[(size_t)index], boxes[candidateIndex]);
            const float ios = plateSlidingIntersectionOverSmaller(
                boxes[(size_t)index], boxes[candidateIndex]);
            if ((int)candidateIndex == index || iou > 0.3f || ios > 0.65f) {
                support += std::max(1, candidates[candidateIndex].window_support);
            }
        }
        supportCounts.push_back(std::max(1, support));
    }

    std::vector<PlateDetectionCandidate> filtered;
    filtered.reserve(keep.size());
    for (size_t keepIndex = 0; keepIndex < keep.size(); ++keepIndex) {
        PlateDetectionCandidate candidate =
            std::move(candidates[(size_t)keep[keepIndex]]);
        candidate.window_support = supportCounts[keepIndex];
        filtered.push_back(std::move(candidate));
    }
    stats.cross_nms_rejected += static_cast<int>(candidates.size() - filtered.size());
    const size_t beforeEvidenceFilter = filtered.size();
    filtered.erase(std::remove_if(filtered.begin(), filtered.end(),
        [&](const PlateDetectionCandidate &candidate) {
            return !plateSlidingCandidateHasEvidence(
                candidate.prop, final_threshold, candidate.window_support);
        }), filtered.end());
    stats.unsupported_rejected += static_cast<int>(
        beforeEvidenceFilter - filtered.size());
    map_to_original(filtered);
    const auto nms_end = std::chrono::steady_clock::now();
    stats.post_ms += std::chrono::duration<double, std::milli>(nms_end - nms_start).count();
    if (plate_debug_enabled()) {
        for (const auto &candidate : filtered) {
            std::fprintf(stderr,
                "[plate-debug] final score=%.6f support=%d edge_mask=%u global=%d "
                "box=(%.1f,%.1f,%.1f,%.1f)\n",
                candidate.prop, candidate.window_support,
                static_cast<unsigned>(candidate.internal_edge_mask),
                candidate.full_frame_context ? 1 : 0,
                candidate.box.left, candidate.box.top,
                candidate.box.right, candidate.box.bottom);
        }
    }
    if (emit_summary) {
        print_plate_debug_summary(stats, use_sliding, filtered.size());
    }
    return filtered;
}

static void accumulate_detector_stats(PlateDetectorStats &dst,
                                      const PlateDetectorStats &src) {
    dst.pre_ms += src.pre_ms;
    dst.npu_ms += src.npu_ms;
    dst.npu_hw_ms += src.npu_hw_ms;
    dst.post_ms += src.post_ms;
    dst.pipeline_active = dst.pipeline_active || src.pipeline_active;
    if (!src.preprocess_backend.empty()) {
        dst.preprocess_backend = src.preprocess_backend;
    }
    if (!src.preprocess_requested.empty()) {
        dst.preprocess_requested = src.preprocess_requested;
    }
    if (!src.preprocess_fallback_reason.empty()) {
        dst.preprocess_fallback_reason = src.preprocess_fallback_reason;
    }
    dst.window_count += src.window_count;
    dst.objectness_candidates += src.objectness_candidates;
    dst.decoded_candidates += src.decoded_candidates;
    dst.local_nms_kept += src.local_nms_kept;
    dst.local_nms_rejected += src.local_nms_rejected;
    dst.score_rejected += src.score_rejected;
    dst.unsupported_rejected += src.unsupported_rejected;
    dst.class_rejected += src.class_rejected;
    dst.geometry_rejected += src.geometry_rejected;
    dst.accepted_candidates += src.accepted_candidates;
    dst.internal_edge_candidates += src.internal_edge_candidates;
    dst.cross_nms_rejected += src.cross_nms_rejected;
    dst.fragment_pairs_merged += src.fragment_pairs_merged;
}

static void offset_detection_candidate(PlateDetectionCandidate &candidate,
                                       int offset_x, int offset_y) {
    candidate.box.left += offset_x;
    candidate.box.right += offset_x;
    candidate.box.top += offset_y;
    candidate.box.bottom += offset_y;
    candidate.detector_box.left += offset_x;
    candidate.detector_box.right += offset_x;
    candidate.detector_box.top += offset_y;
    candidate.detector_box.bottom += offset_y;
    candidate.source_window.x += offset_x;
    candidate.source_window.y += offset_y;
    for (cv::Point2f &point : candidate.points) {
        point.x += offset_x;
        point.y += offset_y;
    }
}

static bool bounded_native_sliding_enabled() {
    return env_enabled("RK3568_PCIE_BOUNDED_SLIDING", true);
}

struct AdaptiveAtlasTransform {
    bool enabled = false;
    int source = 0;
    cv::Rect tile;
    cv::Rect content;
    PlateSlidingWindow strip;
    float scale = 1.0f;
    int mosaic_offset_x = 0;
    int mosaic_offset_y = 0;
};

static PlateSlidingBox map_adaptive_atlas_box(
        const PlateSlidingBox &box, const AdaptiveAtlasTransform &transform) {
    const auto mapX = [&](float value) {
        const float local = (value - transform.content.x) / transform.scale;
        return static_cast<float>(transform.mosaic_offset_x + transform.strip.x) +
               std::clamp(local, 0.0f,
                          static_cast<float>(transform.strip.width - 1));
    };
    const auto mapY = [&](float value) {
        const float local = (value - transform.content.y) / transform.scale;
        return static_cast<float>(transform.mosaic_offset_y + transform.strip.y) +
               std::clamp(local, 0.0f,
                          static_cast<float>(transform.strip.height - 1));
    };
    return {mapX(box.left), mapY(box.top), mapX(box.right), mapY(box.bottom)};
}

static bool map_adaptive_atlas_candidate(
        PlateDetectionCandidate &candidate,
        const std::array<AdaptiveAtlasTransform, 4> &transforms) {
    const float centerX = 0.5f * (candidate.box.left + candidate.box.right);
    const float centerY = 0.5f * (candidate.box.top + candidate.box.bottom);
    const int tileCol = centerX >= 320.0f ? 1 : 0;
    const int tileRow = centerY >= 320.0f ? 1 : 0;
    const int tileIndex = tileCol + tileRow * 2;
    const AdaptiveAtlasTransform &transform =
        transforms[static_cast<size_t>(tileIndex)];
    if (!transform.enabled || transform.scale <= 0.0f) return false;

    const float tileLeft = static_cast<float>(transform.tile.x);
    const float tileTop = static_cast<float>(transform.tile.y);
    const float tileRight = static_cast<float>(transform.tile.x + transform.tile.width);
    const float tileBottom = static_cast<float>(transform.tile.y + transform.tile.height);
    if (candidate.box.left < tileLeft || candidate.box.top < tileTop ||
        candidate.box.right > tileRight || candidate.box.bottom > tileBottom) {
        return false;
    }

    const float contentLeft = static_cast<float>(transform.content.x);
    const float contentTop = static_cast<float>(transform.content.y);
    const float contentRight = static_cast<float>(
        transform.content.x + transform.content.width);
    const float contentBottom = static_cast<float>(
        transform.content.y + transform.content.height);
    if (centerX < contentLeft || centerX >= contentRight ||
        centerY < contentTop || centerY >= contentBottom) {
        return false;
    }

    for (cv::Point2f &point : candidate.points) {
        const float localX = (point.x - transform.content.x) / transform.scale;
        const float localY = (point.y - transform.content.y) / transform.scale;
        point.x = static_cast<float>(transform.mosaic_offset_x + transform.strip.x) +
                  std::clamp(localX, 0.0f,
                             static_cast<float>(transform.strip.width - 1));
        point.y = static_cast<float>(transform.mosaic_offset_y + transform.strip.y) +
                  std::clamp(localY, 0.0f,
                             static_cast<float>(transform.strip.height - 1));
    }
    candidate.box = box_from_points(candidate.points);
    candidate.detector_box = map_adaptive_atlas_box(
        candidate.detector_box, transform);
    candidate.source_window = {
        transform.mosaic_offset_x + transform.strip.x,
        transform.mosaic_offset_y + transform.strip.y,
        transform.strip.width,
        transform.strip.height
    };
    candidate.internal_edge_mask = PlateEdgeNone;
    candidate.touches_internal_edge = false;
    candidate.requires_fragment_merge = false;
    candidate.full_frame_context = false;
    return true;
}

static void offset_detection_candidate(PlateDetectionCandidate &candidate,
                                       int offset_x, int offset_y);

static std::vector<PlateDetectionCandidate> detect_bounded_native_mosaic(
        const cv::Mat &frame, PlateDetectorStats &stats) {
    const std::vector<PlateSlidingWindow> strips = makePlateFullHeightStrips(
        g_native_source_width, g_native_source_height, 640, 320);
    const int phaseCount = 1 + static_cast<int>(strips.size());
    if (phaseCount <= 1) {
        g_adaptive_scan_phase = 0;
        g_current_detection_retains_cache = false;
        return detect_plate_candidates_single(frame, false, stats, true);
    }

    const unsigned int sceneCutMask = g_pending_scene_cut_mask;
    g_pending_scene_cut_mask = 0u;
    int changedSource = -1;
    int changedCount = 0;
    for (int source = 0; source < 4; ++source) {
        if ((sceneCutMask & (1u << source)) != 0u) {
            changedSource = source;
            ++changedCount;
        }
    }
    if (changedCount == 1 && changedSource >= 0) {
        const int offsetX = (changedSource & 1) * g_native_source_width;
        const int offsetY = (changedSource >> 1) * g_native_source_height;
        const cv::Rect sourceRect(
            offsetX, offsetY, g_native_source_width, g_native_source_height);
        g_current_detection_retains_cache = true;
        g_current_scan_is_global = false;
        g_current_scan_regions = {};
        g_current_scan_regions[static_cast<size_t>(changedSource)] = {
            sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height
        };
        std::vector<PlateDetectionCandidate> candidates =
            detect_plate_candidates_single(
                frame(sourceRect), false, stats, false);
        for (PlateDetectionCandidate &candidate : candidates) {
            offset_detection_candidate(candidate, offsetX, offsetY);
            candidate.full_frame_context = true;
        }
        print_plate_debug_summary(stats, true, candidates.size());
        return candidates;
    }
    if (changedCount > 1) {
        g_adaptive_scan_phase = 0;
    }
    if (g_adaptive_scan_phase < 0 || g_adaptive_scan_phase >= phaseCount) {
        g_adaptive_scan_phase = 0;
    }

    const int phase = g_adaptive_scan_phase;
    g_adaptive_scan_phase = (g_adaptive_scan_phase + 1) % phaseCount;
    g_current_detection_retains_cache = true;
    g_current_scan_is_global = phase == 0;
    g_current_scan_regions = {};

    if (phase == 0) {
        std::vector<PlateDetectionCandidate> candidates =
            detect_plate_candidates_single(frame, false, stats, false);
        for (PlateDetectionCandidate &candidate : candidates) {
            candidate.full_frame_context = true;
        }
        print_plate_debug_summary(stats, true, candidates.size());
        return candidates;
    }

    const int scheduledStripIndex = phase - 1;
    cv::Mat atlas(640, 640, frame.type(), cv::Scalar(114, 114, 114));
    std::array<AdaptiveAtlasTransform, 4> transforms{};
    for (int source = 0; source < 4; ++source) {
        if ((g_native_source_mask & (1u << source)) == 0u) continue;
        int stripIndex = scheduledStripIndex;
        const int preferred =
            g_motion_preferred_strip[static_cast<size_t>(source)];
        if (preferred >= 0 && preferred < static_cast<int>(strips.size()) &&
            g_motion_override_streak[static_cast<size_t>(source)] < 2) {
            stripIndex = preferred;
            ++g_motion_override_streak[static_cast<size_t>(source)];
        } else {
            g_motion_override_streak[static_cast<size_t>(source)] = 0;
        }
        const PlateSlidingWindow strip =
            strips[static_cast<size_t>(stripIndex)];
        const int sourceOffsetX = (source & 1) * g_native_source_width;
        const int sourceOffsetY = (source >> 1) * g_native_source_height;
        const cv::Rect sourceStrip(
            sourceOffsetX + strip.x, sourceOffsetY + strip.y,
            strip.width, strip.height);
        const cv::Rect tile((source & 1) * 320, (source >> 1) * 320, 320, 320);
        const float scale = std::min(
            static_cast<float>(tile.width) / strip.width,
            static_cast<float>(tile.height) / strip.height);
        const int resizedWidth = std::max(
            1, static_cast<int>(std::lround(strip.width * scale)));
        const int resizedHeight = std::max(
            1, static_cast<int>(std::lround(strip.height * scale)));
        const cv::Rect content(
            tile.x + (tile.width - resizedWidth) / 2,
            tile.y + (tile.height - resizedHeight) / 2,
            resizedWidth, resizedHeight);
        cv::resize(frame(sourceStrip), atlas(content), content.size(),
                   0.0, 0.0, cv::INTER_AREA);

        AdaptiveAtlasTransform &transform = transforms[static_cast<size_t>(source)];
        transform.enabled = true;
        transform.source = source + 1;
        transform.tile = tile;
        transform.content = content;
        transform.strip = strip;
        transform.scale = scale;
        transform.mosaic_offset_x = sourceOffsetX;
        transform.mosaic_offset_y = sourceOffsetY;
        g_current_scan_regions[static_cast<size_t>(source)] = {
            sourceStrip.x, sourceStrip.y, sourceStrip.width, sourceStrip.height
        };
    }

    PlateDetectorStats atlasStats;
    std::vector<PlateDetectionCandidate> atlasCandidates =
        detect_plate_candidates_single(atlas, true, atlasStats, false);
    accumulate_detector_stats(stats, atlasStats);
    stats.work_width = atlas.cols;
    stats.work_height = atlas.rows;

    std::vector<PlateDetectionCandidate> mapped;
    mapped.reserve(atlasCandidates.size());
    for (PlateDetectionCandidate &candidate : atlasCandidates) {
        if (map_adaptive_atlas_candidate(candidate, transforms)) {
            const float centerX = 0.5f *
                (candidate.box.left + candidate.box.right);
            const float centerY = 0.5f *
                (candidate.box.top + candidate.box.bottom);
            const int source = 1 +
                (centerX >= g_native_source_width ? 1 : 0) +
                (centerY >= g_native_source_height ? 2 : 0);
            const AdaptiveAtlasTransform &transform =
                transforms[static_cast<size_t>(std::clamp(source - 1, 0, 3))];
            PlateSlidingBox localBox = candidate.box;
            localBox.left -= transform.mosaic_offset_x;
            localBox.right -= transform.mosaic_offset_x;
            localBox.top -= transform.mosaic_offset_y;
            localBox.bottom -= transform.mosaic_offset_y;
            const float plateHeight = std::max(
                1.0f, localBox.bottom - localBox.top);
            const float edgeMargin = std::clamp(
                0.25f * plateHeight, 12.0f, 32.0f);
            candidate.internal_edge_mask = plateSlidingInternalEdgeMask(
                localBox, transform.strip, g_native_source_width,
                g_native_source_height, edgeMargin);
            candidate.touches_internal_edge =
                candidate.internal_edge_mask != PlateEdgeNone;
            if (candidate.touches_internal_edge) {
                ++stats.internal_edge_candidates;
                ++stats.geometry_rejected;
                continue;
            }
            mapped.push_back(std::move(candidate));
        }
    }
    print_plate_debug_summary(stats, true, mapped.size());
    return mapped;
}

static std::vector<PlateDetectionCandidate> detect_plate_candidates(
        const cv::Mat &frame, bool use_sliding, PlateDetectorStats &stats) {
    const bool nativeMosaic = g_native_mosaic_enabled &&
        frame.cols == g_native_source_width * 2 &&
        frame.rows == g_native_source_height * 2;
    if (!nativeMosaic) {
        g_current_detection_retains_cache = false;
        g_current_scan_is_global = false;
        g_current_scan_regions = {};
        std::vector<PlateDetectionCandidate> candidates =
            detect_plate_candidates_single(frame, use_sliding, stats, false);
        std::vector<PlateDetectionCandidate> filtered =
            filter_plate_geometry_candidates(
            std::move(candidates), stats);
        print_plate_debug_summary(stats, use_sliding, filtered.size());
        return filtered;
    }

    std::vector<PlateDetectionCandidate> combined;
    g_current_detection_retains_cache = false;
    g_current_scan_is_global = false;
    g_current_scan_regions = {};
    stats.work_width = 0;
    stats.work_height = 0;
    std::vector<int> activeSources;
    for (int source = 0; source < 4; ++source) {
        if ((g_native_source_mask & (1u << source)) != 0u) {
            activeSources.push_back(source);
        }
    }
    const bool pipelineEnabled = env_enabled("RK3568_DET_PIPELINE", true) &&
        !use_sliding && activeSources.size() > 1;
    const bool traceFirstNativeInference = g_frame_counter == 1;
    stats.pipeline_active = pipelineEnabled;
    const int modelW = rknn_det->input_attrs[0].dims[2];
    const int modelH = rknn_det->input_attrs[0].dims[1];
    PreparedPlatePatch prepared;
    if (pipelineEnabled) {
        const int source = activeSources.front();
        const cv::Rect sourceRect(
            (source & 1) * g_native_source_width,
            (source >> 1) * g_native_source_height,
            g_native_source_width, g_native_source_height);
        prepared = prepare_plate_patch(frame(sourceRect), modelW, modelH, false);
    }

    for (size_t activeIndex = 0; activeIndex < activeSources.size();
         ++activeIndex) {
        const int source = activeSources[activeIndex];
        const int offsetX = (source & 1) * g_native_source_width;
        const int offsetY = (source >> 1) * g_native_source_height;
        const cv::Rect sourceRect(offsetX, offsetY,
                                  g_native_source_width,
                                  g_native_source_height);
        if (traceFirstNativeInference) {
            std::fprintf(stderr,
                "[detector] first_source_start source=%d input=%dx%d pipeline=%d\n",
                source + 1, sourceRect.width, sourceRect.height,
                pipelineEnabled ? 1 : 0);
        }
        std::future<PreparedPlatePatch> nextPrepared;
        if (pipelineEnabled && activeIndex + 1 < activeSources.size()) {
            const int nextSource = activeSources[activeIndex + 1];
            const cv::Rect nextRect(
                (nextSource & 1) * g_native_source_width,
                (nextSource >> 1) * g_native_source_height,
                g_native_source_width, g_native_source_height);
            const cv::Mat nextFrame = frame(nextRect);
            nextPrepared = std::async(std::launch::async,
                [nextFrame, modelW, modelH]() {
                    return prepare_plate_patch(nextFrame, modelW, modelH, false);
                });
        }

        PlateDetectorStats sourceStats;
        std::vector<PlateDetectionCandidate> sourceCandidates =
            detect_plate_candidates_single(
                frame(sourceRect), use_sliding, sourceStats, false,
                pipelineEnabled ? &prepared : nullptr);
        if (traceFirstNativeInference) {
            std::fprintf(stderr,
                "[detector] first_source_done source=%d pre=%.2fms npu=%.2fms "
                "post=%.2fms candidates=%zu\n",
                source + 1, sourceStats.pre_ms, sourceStats.npu_ms,
                sourceStats.post_ms, sourceCandidates.size());
        }
        accumulate_detector_stats(stats, sourceStats);
        stats.work_width = std::max(stats.work_width, sourceStats.work_width);
        stats.work_height = std::max(stats.work_height, sourceStats.work_height);
        for (PlateDetectionCandidate &candidate : sourceCandidates) {
            offset_detection_candidate(candidate, offsetX, offsetY);
            combined.push_back(std::move(candidate));
        }
        if (nextPrepared.valid()) {
            if (traceFirstNativeInference) {
                std::fprintf(stderr,
                    "[detector] first_preprocess_wait next_source=%d\n",
                    activeSources[activeIndex + 1] + 1);
            }
            prepared = nextPrepared.get();
        }
    }
    if (stats.work_width <= 0 || stats.work_height <= 0) {
        stats.work_width = frame.cols;
        stats.work_height = frame.rows;
    }
    std::vector<PlateDetectionCandidate> filtered =
        filter_plate_geometry_candidates(std::move(combined), stats);
    print_plate_debug_summary(stats, use_sliding, filtered.size());
    return filtered;
}

bool yolo_evaluate_image(const cv::Mat &frame, std::vector<PlateEvaluationResult> &results,
                         std::string &error) {
    results.clear();
    error.clear();
    if (frame.empty() || !frame.data) {
        error = "empty_image";
        return false;
    }
    if (frame.type() != CV_8UC3) {
        error = "unsupported_image_format";
        return false;
    }

    yolo_init();
    if (!rknn_det || !rknn_rec) {
        error = g_model_error.empty() ? "model_not_ready" : g_model_error;
        return false;
    }

    try {
        PlateDetectorStats detector_stats;
        const std::vector<PlateDetectionCandidate> detections =
            detect_plate_candidates(frame, false, detector_stats);

        for (const auto &det : detections) {

            PlateEvaluationResult result;
            result.plate_type_idx = det.cls_id;
            result.det_conf = det.prop;
            result.status = "detected";

            std::vector<cv::Point2f> points(4);
            float minX = (float)frame.cols;
            float minY = (float)frame.rows;
            float maxX = 0.0f;
            float maxY = 0.0f;
            for (int k = 0; k < 4; ++k) {
                const float pointX = det.points[(size_t)k].x;
                const float pointY = det.points[(size_t)k].y;
                points[k] = cv::Point2f(pointX, pointY);
                result.landmarks[(size_t)k * 2] = pointX;
                result.landmarks[(size_t)k * 2 + 1] = pointY;
                minX = std::min(minX, pointX);
                minY = std::min(minY, pointY);
                maxX = std::max(maxX, pointX);
                maxY = std::max(maxY, pointY);
            }
            result.bbox_left = std::clamp((int)std::floor(minX), 0, frame.cols - 1);
            result.bbox_top = std::clamp((int)std::floor(minY), 0, frame.rows - 1);
            result.bbox_right = std::clamp((int)std::ceil(maxX), 0, frame.cols - 1);
            result.bbox_bottom = std::clamp((int)std::ceil(maxY), 0, frame.rows - 1);

            try {
                const PlateOcrDecision decision = recognize_plate_candidate(
                    frame, points, det.cls_id, &det.detector_box, true,
                    det.prop, det.window_support);
                if (!decision.result.authenticity.retain_candidate) {
                    if (plate_debug_enabled()) {
                        std::fprintf(stderr,
                            "[plate-debug] evaluation reject=appearance "
                            "det=%.4f support=%d status=%s %s\n",
                            det.prop, det.window_support,
                            decision.status.c_str(), decision.detail.c_str());
                    }
                    continue;
                }
                const bool windowConsensusAccepted =
                    accept_static_window_consensus(
                        decision, det.prop, det.window_support);
                result.plate_no = decision.result.plate;
                result.ocr_conf = decision.result.confidence;
                result.color_idx = decision.result.color;
                result.ocr_accepted = decision.accepted || windowConsensusAccepted;
                result.status = windowConsensusAccepted && !decision.accepted
                    ? "ok_window_consensus"
                    : decision.status;
                result.error = decision.detail;
            } catch (const std::exception &e) {
                result.status = "ocr_error";
                result.error = e.what();
            }
            results.push_back(std::move(result));
        }
    } catch (const std::exception &e) {
        error = e.what();
        results.clear();
        return false;
    }
    return true;
}

static int detection_source_index(const PlateSlidingBox &box,
                                  int frameWidth, int frameHeight) {
    if (g_view_mode == 1) return g_single_source;
    const float centerX = 0.5f * (box.left + box.right);
    const float centerY = 0.5f * (box.top + box.bottom);
    const int quadrant = (centerX >= frameWidth * 0.5f ? 1 : 0) +
                         (centerY >= frameHeight * 0.5f ? 2 : 0);
    return std::clamp(g_quad_map[quadrant], 1, 4);
}

static int adaptive_cache_frames() {
    int frames = 6;
    if (const char *s = std::getenv("RK3568_ADAPTIVE_CACHE_FRAMES")) {
        char *end = nullptr;
        const long parsed = std::strtol(s, &end, 10);
        if (end != s) frames = static_cast<int>(parsed);
    }
    return std::clamp(frames, 1, 30);
}

static bool current_strip_covers(const DetCacheItem &item) {
    if (g_current_scan_is_global || item.source_idx < 1 || item.source_idx > 4) {
        return false;
    }
    const PlateSlidingWindow &region =
        g_current_scan_regions[static_cast<size_t>(item.source_idx - 1)];
    if (region.width <= 0 || region.height <= 0) return false;
    const float centerX = 0.5f * (item.box.left + item.box.right);
    const float centerY = 0.5f * (item.box.top + item.box.bottom);
    return centerX >= region.x && centerX < region.x + region.width &&
           centerY >= region.y && centerY < region.y + region.height;
}

/**
 * @brief 核心推理与渲染函数
 */
void yolo_run(cv::Mat &frame) {
    g_last_overlay_regions.clear();
    if (frame.empty()) return;
    if (!rknn_det || !rknn_rec) yolo_init();
    if (!rknn_det || !rknn_rec) return;
    const int requestedQuantized =
        g_requested_quantized_output.exchange(-1, std::memory_order_acq_rel);
    if (!active_detector_profile().require_float_outputs &&
        detector_supports_affine_quantized_outputs(rknn_det) &&
        requestedQuantized >= 0 &&
        rknn_det->wantFloat() == (requestedQuantized != 0)) {
        rknn_det->setWantFloat(requestedQuantized == 0);
    }
    const bool staticFrame = g_next_run_is_static_frame;
    g_next_run_is_static_frame = false;
    const unsigned long long sourceFrameSequence =
        g_pending_source_frame_sequence.exchange(
            0, std::memory_order_acq_rel);

    g_last_det_executed = false;
    g_last_det_pre_ms = 0.0;
    g_last_det_npu_ms = 0.0;
    g_last_det_npu_hw_ms = 0.0;
    g_last_det_post_ms = 0.0;
    g_last_det_e2e_ms = 0.0;
    g_last_det_overlap_saved_ms = 0.0;
    g_last_det_task_count = 0;
    g_last_det_score_candidates = 0;
    g_last_det_decoded_candidates = 0;
    g_last_det_final_candidates = 0;
    g_last_det_source_frame_sequence = sourceFrameSequence;
    g_last_det_pipeline_enabled = env_enabled("RK3568_DET_PIPELINE", true);
    g_last_det_pipeline_active = false;
    g_last_det_preprocess_backend = "opencv";
    g_last_det_preprocess_requested = preprocess_backend_name(
        requested_preprocess_backend());
    g_last_det_preprocess_fallback_reason.clear();
    if (g_native_mosaic_enabled) {
        g_last_det_strategy = "per_source_full";
    } else if (frame.cols == g_native_source_width * 2 &&
               frame.rows == g_native_source_height * 2) {
        g_last_det_strategy = "mosaic_single";
    } else if (staticFrame) {
        g_last_det_strategy = "sd_static";
    } else {
        g_last_det_strategy = "single_source";
    }

    if (staticFrame) {
        // A folder image exists for only one capture iteration. Do not inherit
        // tracking state or cached detections from the previous image.
        g_det_cache.clear();
        g_plate_cache.clear();
        g_det_age = 0;
        g_has_det_run = false;
        g_has_sig = false;
    }

    const bool nativeAdaptiveFrame = false;
    if (nativeAdaptiveFrame) {
        const unsigned int sceneCutMask = update_native_motion_state(frame);
        if (sceneCutMask != 0u) {
            purge_changed_sources(sceneCutMask);
            g_pending_scene_cut_mask |= sceneCutMask;
        }
    }

    auto tick = []() { return std::chrono::steady_clock::now(); };
    auto ms = [](const std::chrono::steady_clock::time_point& a, const std::chrono::steady_clock::time_point& b) {
        return std::chrono::duration<double, std::milli>(b - a).count();
    };

    int drawOverlay = 1;
    if (const char* s = std::getenv("RK3568_DRAW_OVERLAY")) drawOverlay = std::atoi(s);
    int drawText = 1;
    if (const char* s = std::getenv("RK3568_DRAW_TEXT")) drawText = std::atoi(s);
    int drawSplit = 1;
    if (const char* s = std::getenv("RK3568_DRAW_SPLIT")) drawSplit = std::atoi(s);
    auto tBox0 = tick();
    double ocrMs = 0.0;
    g_frame_counter++;
    static bool realtimeOcrPolicyLogged = false;
    if (!realtimeOcrPolicyLogged) {
        std::fprintf(stderr,
            "[plate] realtime_ocr_policy=v10.26 schedule=detection_counter "
            "stale_text=hidden multi_track=isolated geometry_filter=configurable "
            "stride_basis=source_sequence signature_samples=%zu\n",
            plate_display::kVisualIdentitySamples);
        realtimeOcrPolicyLogged = true;
    }
    static int detStride = 1;
    if (const char* s = std::getenv("RK3568_PLATE_INFER_STRIDE")) {
        int v = std::atoi(s);
        if (v > 0 && v <= 60) detStride = v;
    }
    if (const char* s = std::getenv("RK3568_PLATE_SIG_FORCE")) {
        g_plate_sig_force = std::atoi(s) != 0 ? 1 : 0;
    } else {
        g_plate_sig_force = 0;
    }
    if (const char* s = std::getenv("RK3568_PLATE_OCR_PERIOD")) {
        int v = std::atoi(s);
        if (v > 0 && v <= 60) g_plate_ocr_period = v;
    }
    g_last_det_configured_stride = detStride;
    if (const char* s = std::getenv("RK3568_PLATE_OCR_FAST_PERIOD")) {
        int v = std::atoi(s);
        if (v > 0 && v <= 10) g_plate_ocr_fast_period = v;
    }
    if (const char* s = std::getenv("RK3568_PLATE_STABLE_REQUIRED")) {
        int v = std::atoi(s);
        if (v > 0 && v <= 10) g_plate_stable_required = v;
    }
    if (const char* s = std::getenv("RK3568_PLATE_COOLDOWN_FRAMES")) {
        int v = std::atoi(s);
        if (v >= 0 && v <= 3000) g_plate_cooldown_frames = (uint32_t)v;
    }
    int boxHoldRuns = 1;
    if (const char* s = std::getenv("RK3568_PLATE_BOX_HOLD_RUNS")) {
        const int v = std::atoi(s);
        if (v >= 0 && v <= 3) boxHoldRuns = v;
    }

    g_det_age++;
    const bool sourceSequenceDue = sourceFrameSequence != 0 &&
        inference_timing::sourceFrameDue(
            sourceFrameSequence, g_last_detection_source_sequence,
            detStride);
    bool need_det = staticFrame || !g_has_det_run || (detStride <= 1) ||
        (sourceFrameSequence != 0 ? sourceSequenceDue
                                  : (g_det_age >= detStride));
    if (nativeAdaptiveFrame && g_pending_scene_cut_mask != 0u) {
        need_det = true;
    }
    if (g_plate_sig_force != 0) {
        uint32_t sig = frame_sig(frame);
        if (!g_has_sig || sig != g_last_sig) {
            g_last_sig = sig;
            g_has_sig = true;
            need_det = true;
        }
    }

    if (need_det) {
        g_det_age = 0;
        if (sourceFrameSequence != 0) {
            g_last_detection_source_sequence = sourceFrameSequence;
        }
        g_has_det_run = true;
        ++g_detection_counter;
        constexpr bool use_sliding = false;
        PlateDetectorStats detector_stats;
        const auto detectorStarted = tick();
        const std::vector<PlateDetectionCandidate> detections =
            detect_plate_candidates(frame, use_sliding, detector_stats);
        const double detectorE2eMs = ms(detectorStarted, tick());
        g_last_det_score_candidates = detector_stats.objectness_candidates;
        g_last_det_decoded_candidates = detector_stats.decoded_candidates;
        g_last_det_final_candidates = static_cast<int>(detections.size());

        std::vector<DetCacheItem> new_cache;
        new_cache.reserve(detections.size());
        std::vector<bool> previous_used(g_det_cache.size(), false);
        for (const auto &det : detections) {

            DetCacheItem item;
            item.cls_id = det.cls_id;
            item.prop = det.prop;
            item.custom_text = det.custom_text;
            item.box = det.box;
            item.detector_box = det.detector_box;
            item.window_support = det.window_support;
            item.source_idx = detection_source_index(
                det.box, frame.cols, frame.rows);
            item.last_seen_frame = g_frame_counter;
            item.last_seen_detection = g_detection_counter;
            item.full_frame_context = det.full_frame_context;
            item.visual_signature_valid = capture_visual_signature(
                frame, item.box, item.visual_signature);
            for (int k = 0; k < 4; ++k) {
                item.pts_f[k] = det.points[(size_t)k];
                item.pts_i[k] = cv::Point(
                    static_cast<int>(std::lround(det.points[(size_t)k].x)),
                    static_cast<int>(std::lround(det.points[(size_t)k].y)));
            }

            int bestPrevious = -1;
            float bestMatch = 0.0f;
            for (size_t oldIndex = 0; oldIndex < g_det_cache.size(); ++oldIndex) {
                if (previous_used[oldIndex]) continue;
                if (g_det_cache[oldIndex].source_idx != item.source_idx) continue;
                float match = plateSlidingTrackMatchScore(
                    item.box, g_det_cache[oldIndex].box);
                const uint32_t trackAge = g_detection_counter -
                    g_det_cache[oldIndex].last_seen_detection;
                if (match <= 0.0f && !g_det_cache[oldIndex].visible &&
                    trackAge <= static_cast<uint32_t>(adaptive_cache_frames())) {
                    match = plateSlidingHiddenTrackReacquireScore(
                        item.box, g_det_cache[oldIndex].box);
                }
                if (match > bestMatch) {
                    bestMatch = match;
                    bestPrevious = static_cast<int>(oldIndex);
                }
            }
            if (bestPrevious >= 0) {
                const DetCacheItem &previous =
                    g_det_cache[static_cast<size_t>(bestPrevious)];
                if (previous.full_frame_context &&
                    !item.full_frame_context &&
                    plateSlidingGlobalSupersedesFragment(
                        previous.box, item.box)) {
                    DetCacheItem retained = previous;
                    retained.last_seen_detection = g_detection_counter;
                    previous_used[static_cast<size_t>(bestPrevious)] = true;
                    new_cache.push_back(std::move(retained));
                    continue;
                }
                const float matchedBoxIou = plateSlidingIou(
                    previous.box, item.box);
                const plate_display::VisualIdentityDifference visualDifference =
                    plate_display::visualIdentityDifference(
                        previous.visual_signature,
                        previous.visual_signature_valid,
                        item.visual_signature,
                        item.visual_signature_valid);
                const bool identityChanged =
                    plate_display::shouldResetTrackIdentity(
                        matchedBoxIou,
                        plate_display::visualIdentityChanged(
                            previous.visual_signature,
                            previous.visual_signature_valid,
                            item.visual_signature,
                            item.visual_signature_valid));
                if (identityChanged) {
                    item.track_id = g_next_plate_track_id++;
                    if (g_next_plate_track_id == 0) g_next_plate_track_id = 1;
                    item.track_hits = 1;
                    if (plate_debug_enabled()) {
                        std::fprintf(stderr,
                            "[plate-debug] old_track=%llu reset=visual_identity\n",
                            static_cast<unsigned long long>(previous.track_id));
                    }
                } else {
                    item.track_id = previous.track_id;
                    item.track_hits = std::min(previous.track_hits + 1, 1000);
                    item.visual_refresh_needed =
                        plate_display::visualIdentityNeedsRefresh(
                            visualDifference);
                    item.authenticity_state = previous.authenticity_state;
                    item.appearance_checked = previous.appearance_checked;
                    item.retain_candidate = previous.retain_candidate;
                }
                if (plate_debug_enabled() && visualDifference.valid &&
                    (identityChanged || item.visual_refresh_needed)) {
                    std::fprintf(stderr,
                        "[plate-debug] track=%llu visual iou=%.4f mean=%.2f "
                        "changed=%d reset=%d refresh=%d\n",
                        static_cast<unsigned long long>(previous.track_id),
                        matchedBoxIou, visualDifference.mean_difference,
                        visualDifference.changed_samples,
                        identityChanged ? 1 : 0,
                        item.visual_refresh_needed ? 1 : 0);
                }
                previous_used[static_cast<size_t>(bestPrevious)] = true;
            } else {
                item.track_id = g_next_plate_track_id++;
                if (g_next_plate_track_id == 0) g_next_plate_track_id = 1;
                item.track_hits = 1;
            }
            new_cache.push_back(std::move(item));
        }
        if (g_current_detection_retains_cache ||
            (!staticFrame && boxHoldRuns > 0)) {
            const uint32_t maxAge = static_cast<uint32_t>(adaptive_cache_frames());
            for (size_t oldIndex = 0; oldIndex < g_det_cache.size(); ++oldIndex) {
                if (previous_used[oldIndex]) continue;
                const DetCacheItem &previous = g_det_cache[oldIndex];
                const uint32_t age =
                    g_detection_counter - previous.last_seen_detection;
                const bool retainPartialScan = g_current_detection_retains_cache &&
                    age <= maxAge &&
                    !(previous.visible && current_strip_covers(previous));
                const bool retainFullScanMiss =
                    !g_current_detection_retains_cache &&
                    plate_display::retainAfterMiss(
                        staticFrame, age, boxHoldRuns);
                if (!retainPartialScan && !retainFullScanMiss) {
                    continue;
                }
                new_cache.push_back(previous);
            }
        }
        g_det_cache.swap(new_cache);

        g_last_det_pre_ms = detector_stats.pre_ms;
        g_last_det_npu_ms = detector_stats.npu_ms;
        g_last_det_npu_hw_ms = detector_stats.npu_hw_ms;
        g_last_det_post_ms = detector_stats.post_ms;
        g_last_det_e2e_ms = detectorE2eMs;
        g_last_det_overlap_saved_ms = std::max(
            0.0, detector_stats.pre_ms + detector_stats.npu_ms +
                     detector_stats.post_ms - detectorE2eMs);
        g_last_det_executed = true;
        g_last_det_pipeline_active = detector_stats.pipeline_active;
        g_last_det_task_count = detector_stats.window_count;
        g_last_det_preprocess_backend = detector_stats.preprocess_backend;
        g_last_det_preprocess_requested = detector_stats.preprocess_requested;
        g_last_det_preprocess_fallback_reason =
            detector_stats.preprocess_fallback_reason;
    }

    if (nativeAdaptiveFrame) {
        for (DetCacheItem &item : g_det_cache) {
            if (item.last_seen_frame != g_frame_counter &&
                cached_visual_changed(frame, item)) {
                item.visible = false;
            }
        }
    }

    QImage qimg;
    QPainter painter;
    QFont font;
    QFontMetrics metrics(font);
    bool hasPainter = false;
    // Static SD images clear the OCR cache at the start of every pass. Create
    // the painter from this frame's detections so a newly decoded plate can be
    // rendered in the same pass in which it is reported.
    if (drawOverlay != 0 && drawText != 0 && !g_det_cache.empty()) {
        qimg = QImage((uchar*)frame.data, frame.cols, frame.rows, frame.step, QImage::Format_RGB888);
        if (painter.begin(&qimg)) {
            painter.setRenderHint(QPainter::Antialiasing);
            painter.setRenderHint(QPainter::TextAntialiasing);
            font = QFont("WenQuanYi Zen Hei");
            font.setPixelSize(26);
            font.setBold(true);
            painter.setFont(font);
            metrics = QFontMetrics(font);
            hasPainter = true;
        }
    }

    std::set<std::string> active_ids;

    // C. 遍历检测结果
    for (auto &det : g_det_cache) {
        if (!det.visible) continue;
        std::vector<cv::Point> pts_i(4);
        std::vector<cv::Point2f> pts_f(4);
        for (int k = 0; k < 4; ++k) {
            pts_i[k] = det.pts_i[k];
            pts_f[k] = det.pts_f[k];
        }

        const int source_idx = det.source_idx > 0
            ? det.source_idx
            : detection_source_index(det.box, frame.cols, frame.rows);

        // Pose26 stores its output head (P3/P4/P5) in custom_text. Multiple
        // plates can share that metadata, so it must never identify OCR state.
        // Track IDs are unique per detection target; source scoping also keeps
        // independent camera tiles isolated after layout changes.
        const std::string obj_id = plate_display::ocrTrackCacheKey(
            source_idx, det.track_id);
        active_ids.insert(obj_id);

        // --- OCR 决策：缓存命中或周期性更新 ---
        bool has_cache = g_plate_cache.count(obj_id);
        int stableHits = 0;
        bool hasConfirmedCache = false;
        bool hasPendingReplacement = false;
        uint32_t lastOcrDetection = 0;
        if (has_cache) {
            stableHits = g_plate_cache[obj_id].consensus.candidate_hits;
            hasConfirmedCache = plateConsensusConfirmed(
                g_plate_cache[obj_id].consensus);
            hasPendingReplacement = plateConsensusHasPendingReplacement(
                g_plate_cache[obj_id].consensus);
            lastOcrDetection = g_plate_cache[obj_id].last_ocr_detection;
        }
        const bool needFast = !hasConfirmedCache || hasPendingReplacement ||
            det.visual_refresh_needed ||
            (stableHits < g_plate_stable_required);
        const int period = needFast ? g_plate_ocr_fast_period : g_plate_ocr_period;
        const bool detectionFresh = staticFrame ||
            det.last_seen_frame == g_frame_counter;
        const bool doOcr = plate_display::ocrRefreshDue(
            detectionFresh, staticFrame, has_cache, period,
            g_detection_counter, lastOcrDetection);
        if (doOcr) {
            auto tO0 = tick();
            const PlateOcrDecision decision = recognize_plate_candidate(
                frame, pts_f, det.cls_id, &det.detector_box, staticFrame,
                det.prop, det.window_support);
            det.authenticity_state = decision.result.authenticity.state;
            det.appearance_checked = true;
            det.retain_candidate =
                decision.result.authenticity.retain_candidate;
            const bool windowConsensusAccepted = staticFrame &&
                accept_static_window_consensus(
                    decision, det.prop, det.window_support);
            const bool strongObservation =
                decision.accepted || windowConsensusAccepted;
            const float strictOcrThreshold =
                static_cast<float>(g_color_cfg.rec_conf_threshold) / 1000.0f;
            const float relaxedOcrThreshold =
                std::max(0.35f, strictOcrThreshold - 0.25f);
            // Keep the strict path for confirmation/reporting, but allow a
            // non-empty low-confidence OCR string to be shown for tiny or
            // blurred plates. Format and appearance checks must not hide a
            // useful on-screen result when the detector already found a box.
            const float displayOcrThreshold =
                plate_display::relaxedOcrDisplayThreshold(strictOcrThreshold);
            const bool relaxedDisplayObservation =
                plate_display::canDisplayRelaxedOcrText(
                    decision.result.plate, decision.result.confidence,
                    strictOcrThreshold);
            const bool usableObservation =
                det.retain_candidate &&
                decision.result.authenticity.allow_ocr_confirmation &&
                decision.result.format_ok &&
                !decision.result.plate.empty() &&
                decision.result.confidence >= relaxedOcrThreshold;
            if (usableObservation) {
                const std::string& cur_plate = decision.result.plate;
                const float cur_conf = decision.result.confidence;
                const int cur_color = decision.result.color;
                PlateMemory memo;
                auto it = g_plate_cache.find(obj_id);
                if (it != g_plate_cache.end()) memo = it->second;
                memo.last_ocr_detection = g_detection_counter;
                memo.display_suppressed = false;
                memo.relaxed_display_text = decision.result.plate;
                memo.relaxed_display_color = decision.result.color;
                memo.relaxed_display_confidence = decision.result.confidence;

                const int consensusRequired = nativeAdaptiveFrame
                    ? std::min(2, std::max(1, g_plate_stable_required))
                    : g_plate_stable_required;
                plateConsensusObserve(
                    memo.consensus, cur_plate, cur_color, cur_conf,
                    strongObservation, staticFrame, consensusRequired);
                memo.life = 20;

                const int requiredHits =
                    staticFrame ? 1 : consensusRequired;
                const bool confirmedCurrent =
                    plateConsensusConfirmed(memo.consensus) &&
                    memo.consensus.confirmed_text == cur_plate;
                if (confirmedCurrent && !memo.consensus.reported &&
                    memo.consensus.stable_hits >= requiredHits) {
                    const std::string& confirmedPlate =
                        memo.consensus.confirmed_text;
                    std::string cooldown_key = confirmedPlate;
                    if (g_dedupe_by_source) {
                        cooldown_key = confirmedPlate + "@" +
                            std::to_string(source_idx);
                    }

                    auto itc = g_plate_cooldown.find(cooldown_key);
                    const bool cooldownExpired = staticFrame ||
                        (itc == g_plate_cooldown.end()) ||
                        (g_frame_counter - itc->second >=
                         g_plate_cooldown_frames);
                    if (cooldownExpired) {
                        cv::Mat thumb_bgr;
                        cv::resize(decision.result.roi, thumb_bgr,
                                   cv::Size(240, 80), 0, 0, cv::INTER_LINEAR);
                        cv::Mat thumb_rgb;
                        cv::cvtColor(
                            thumb_bgr, thumb_rgb, cv::COLOR_BGR2RGB);
                        QImage thumb_img(
                            (const uchar*)thumb_rgb.data,
                            thumb_rgb.cols, thumb_rgb.rows, thumb_rgb.step,
                            QImage::Format_RGB888);
                        QImage thumb_copy = thumb_img.copy();
                        std::lock_guard<std::mutex> lock(g_report_mutex);
                        g_report_events.push_back({
                            confirmedPlate,
                            memo.consensus.confirmed_color,
                            memo.consensus.confirmed_confidence,
                            det.prop, source_idx, std::move(thumb_copy)
                        });
                        g_plate_cooldown[cooldown_key] = g_frame_counter;
                        memo.consensus.reported = true;
                    }
                }

                if (!strongObservation && plate_debug_enabled()) {
                    std::fprintf(stderr,
                        "[plate-debug] track=%llu det=%.4f provisional text=%s "
                        "ocr=%.4f hits=%d strong=%d status=%s\n",
                        static_cast<unsigned long long>(det.track_id),
                        det.prop, cur_plate.c_str(), cur_conf,
                        memo.consensus.candidate_hits,
                        memo.consensus.candidate_strong_hits,
                        decision.status.c_str());
                }
                if (windowConsensusAccepted && !decision.accepted &&
                    plate_debug_enabled()) {
                    std::fprintf(stderr,
                        "[plate-debug] track=%llu det=%.4f "
                        "accept=window_consensus support=%d text=%s ocr=%.4f\n",
                        static_cast<unsigned long long>(det.track_id),
                        det.prop, det.window_support, cur_plate.c_str(), cur_conf);
                }
                g_plate_cache[obj_id] = std::move(memo);
            } else {
                auto cached = g_plate_cache.find(obj_id);
                if (relaxedDisplayObservation) {
                    PlateMemory memo;
                    if (cached != g_plate_cache.end()) memo = cached->second;
                    memo.last_ocr_detection = g_detection_counter;
                    memo.display_suppressed = false;
                    memo.relaxed_display_text = decision.result.plate;
                    memo.relaxed_display_color = decision.result.color;
                    memo.relaxed_display_confidence =
                        decision.result.confidence;
                    memo.life = 20;
                    g_plate_cache[obj_id] = std::move(memo);
                    if (plate_debug_enabled()) {
                        std::fprintf(stderr,
                            "[plate-debug] relaxed_display track=%llu "
                            "text=%s ocr=%.4f threshold=%.4f "
                            "format_ok=%d auth=%s\n",
                            static_cast<unsigned long long>(det.track_id),
                            decision.result.plate.c_str(),
                            decision.result.confidence, displayOcrThreshold,
                            decision.result.format_ok ? 1 : 0,
                            plateAuthenticityName(
                                decision.result.authenticity.state));
                    }
                } else {
                    if (cached != g_plate_cache.end()) {
                        cached->second.last_ocr_detection = g_detection_counter;
                        cached->second.display_suppressed = true;
                        const int missLimit = nativeAdaptiveFrame &&
                            plateConsensusConfirmed(cached->second.consensus)
                                ? 8 : 3;
                        if (plateConsensusMiss(
                                cached->second.consensus, missLimit)) {
                            g_plate_cache.erase(cached);
                        }
                    }
                    if (plate_debug_enabled()) {
                        std::fprintf(stderr,
                            "[plate-debug] track=%llu det=%.4f reject=ocr "
                            "status=%s %s\n",
                            static_cast<unsigned long long>(det.track_id),
                            det.prop, decision.status.c_str(),
                            decision.detail.c_str());
                    }
                }
            }
            if (plate_debug_enabled()) {
                const auto currentMemo = g_plate_cache.find(obj_id);
                const PlateConsensusState *consensus =
                    currentMemo == g_plate_cache.end()
                        ? nullptr : &currentMemo->second.consensus;
                const char *confirmedText = consensus
                    ? consensus->confirmed_text.c_str() : "";
                const char *candidateText = consensus
                    ? consensus->candidate_text.c_str() : "";
                const bool suppressed = currentMemo != g_plate_cache.end() &&
                    currentMemo->second.display_suppressed;
                const cv::Mat &ocrRoi = decision.result.roi;
                std::fprintf(stderr,
                    "[plate-debug] ocr frame=%u detection=%u track=%llu "
                    "source=%d roi=%dx%d continuous=%d hash=%016llx "
                    "attempts=%d usable=%d relaxed=%d accepted=%d "
                    "status=%s text=%s "
                    "confidence=%.4f confirmed=%s candidate=%s suppressed=%d\n",
                    g_frame_counter, g_detection_counter,
                    static_cast<unsigned long long>(det.track_id), source_idx,
                    ocrRoi.cols, ocrRoi.rows, ocrRoi.isContinuous() ? 1 : 0,
                    static_cast<unsigned long long>(
                        plate_debug_image_hash(ocrRoi)),
                    decision.attempt_count, usableObservation ? 1 : 0,
                    relaxedDisplayObservation ? 1 : 0,
                    decision.accepted ? 1 : 0, decision.status.c_str(),
                    decision.result.plate.c_str(), decision.result.confidence,
                    confirmedText, candidateText, suppressed ? 1 : 0);
            }
            auto tO1 = tick();
            ocrMs += ms(tO0, tO1);
        }

        // --- 渲染层 ---
        // Authenticity is still used by the strict confirmation/reporting
        // path, but it must not suppress the detector box or a relaxed OCR
        // string on the live image.
        auto memoIt = g_plate_cache.find(obj_id);
        const bool confirmedAvailable = memoIt != g_plate_cache.end() &&
            plateConsensusConfirmed(memoIt->second.consensus) &&
            plateTextPlausible(
                memoIt->second.consensus.confirmed_text);
        const bool pendingReplacement = memoIt != g_plate_cache.end() &&
            plateConsensusHasPendingReplacement(memoIt->second.consensus);
        const bool displaySuppressed = memoIt != g_plate_cache.end() &&
            memoIt->second.display_suppressed;
        const bool candidatePreferred = memoIt != g_plate_cache.end() &&
            !displaySuppressed &&
            plateConsensusShouldDisplayCandidate(memoIt->second.consensus);
        const bool provisional = candidatePreferred &&
            memoIt->second.consensus.candidate_hits > 0 &&
            plateTextPlausible(memoIt->second.consensus.candidate_text);
        const bool confirmed = plate_display::canDisplayConfirmedText(
            confirmedAvailable, pendingReplacement, displaySuppressed) &&
            !provisional;
        const bool relaxedDisplay = memoIt != g_plate_cache.end() &&
            !displaySuppressed && !memoIt->second.relaxed_display_text.empty() &&
            !confirmed && !provisional;
        // Every retained detector candidate has already gone through the OCR
        // path when its freshness/period policy allows it. Keep its geometry
        // visible while OCR consensus is pending, but never expose a
        // user-facing "suspected plate" classification. A relaxed OCR string
        // is display-only and is not treated as a confirmed report.
        const bool hasPlateText = confirmed || provisional || relaxedDisplay;
        const cv::Scalar theme_color = class_colors[det.cls_id];

        if (drawOverlay != 0) {
            cv::Rect geometryRegion = cv::boundingRect(pts_i);
            geometryRegion.x -= 6;
            geometryRegion.y -= 6;
            geometryRegion.width += 12;
            geometryRegion.height += 12;
            geometryRegion &= cv::Rect(0, 0, frame.cols, frame.rows);
            if (!geometryRegion.empty()) {
                g_last_overlay_regions.push_back(geometryRegion);
            }
        }
        
        // 1. 绘制检测框 (始终显示)
        if (drawOverlay != 0) {
            for (int i = 0; i < 4; ++i)
                cv::line(frame, pts_i[i], pts_i[(i+1)%4], theme_color, 2, cv::LINE_AA);
        }

        // 2. 集成虚线绘制逻辑
        if (drawOverlay != 0 && drawSplit != 0 && det.cls_id == 1) {
            draw_plate_split_lines(frame, pts_i, cv::Scalar(0, 0, 255));
        }

        // 3. 绘制彩色定位点
        const cv::Scalar pt_colors[] = { {0,0,255}, {0,255,0}, {255,0,0}, {0,255,255} };
        if (drawOverlay != 0) {
            for (int k = 0; k < 4; ++k) cv::circle(frame, pts_i[k], 4, pt_colors[k], -1);
        }

        // 4. A plausible OCR result is visible immediately. Reporting still
        // waits for consensus, so detector-only false positives stay out of
        // the capture list and cloud events.
        if (drawOverlay != 0 && hasPainter && hasPlateText) {
            QString qstr;
            const int txt_size = hasPlateText ? 26 : 20;
            const int labelHeight = hasPlateText ? 38 : 31;
            if (confirmed) {
                auto &memo = memoIt->second;
                memo.life = 20;
                const int colorIndex = std::clamp(
                    memo.consensus.confirmed_color, 0,
                    static_cast<int>(COLOR_MAP.size()) - 1);
                const std::string label = memo.consensus.confirmed_text +
                    " " + COLOR_MAP[static_cast<size_t>(colorIndex)];
                qstr = QString::fromUtf8(label.c_str());
            } else if (provisional) {
                auto &memo = memoIt->second;
                memo.life = 20;
                const int colorIndex = std::clamp(
                    memo.consensus.candidate_color, 0,
                    static_cast<int>(COLOR_MAP.size()) - 1);
                const std::string label = memo.consensus.candidate_text +
                    " " + COLOR_MAP[static_cast<size_t>(colorIndex)];
                qstr = QString::fromUtf8(label.c_str());
            } else if (relaxedDisplay) {
                const auto &memo = memoIt->second;
                const int colorIndex = std::clamp(
                    memo.relaxed_display_color, 0,
                    static_cast<int>(COLOR_MAP.size()) - 1);
                const std::string label = memo.relaxed_display_text +
                    " " + COLOR_MAP[static_cast<size_t>(colorIndex)];
                qstr = QString::fromUtf8(label.c_str());
            }
            if (txt_size != font.pixelSize()) {
                font.setPixelSize(txt_size);
                painter.setFont(font);
                metrics = QFontMetrics(font);
            }
            const int boxWidth = std::min(
                frame.cols, metrics.horizontalAdvance(qstr) + 15);
            const int labelX = std::clamp(
                pts_i[0].x, 0, std::max(0, frame.cols - boxWidth));
            const int labelY = std::clamp(
                pts_i[0].y - labelHeight, 0,
                std::max(0, frame.rows - labelHeight));

            cv::Rect labelRegion(labelX, labelY, boxWidth + 1,
                                 labelHeight + 1);
            labelRegion &= cv::Rect(0, 0, frame.cols, frame.rows);
            if (!labelRegion.empty()) {
                g_last_overlay_regions.push_back(labelRegion);
            }

            cv::rectangle(frame, cv::Point(labelX, labelY),
                          cv::Point(labelX + boxWidth,
                                    labelY + labelHeight), theme_color, -1);

            painter.setPen(QColor(0, 0, 0, 160));
            painter.drawText(labelX + 6, labelY + labelHeight - 9, qstr);
            painter.setPen(Qt::white);
            painter.drawText(labelX + 5, labelY + labelHeight - 10, qstr);
        }
    }

    if (hasPainter) painter.end();

    // D. 离场清理
    for (auto it = g_plate_cache.begin(); it != g_plate_cache.end(); ) {
        if (active_ids.find(it->first) == active_ids.end()) {
            it->second.life--;
            if (it->second.life <= 0) { it = g_plate_cache.erase(it); continue; }
        }
        ++it;
    }

    auto tBox1 = tick();
    g_last_det_box_ms = ms(tBox0, tBox1) - ocrMs;
    if (g_last_det_box_ms < 0.0) g_last_det_box_ms = 0.0;
    g_last_det_ocr_ms = ocrMs;
}

void yolo_get_last_overlay_regions(std::vector<cv::Rect> &regions) {
    regions = g_last_overlay_regions;
}

void yolo_get_last_stage_ms(double* det_box_ms, double* det_ocr_ms) {
    if (det_box_ms) *det_box_ms = g_last_det_box_ms;
    if (det_ocr_ms) *det_ocr_ms = g_last_det_ocr_ms;
}

void yolo_get_last_det_parts(double* pre_ms, double* npu_ms, double* post_ms) {
    if (pre_ms) *pre_ms = g_last_det_pre_ms;
    if (npu_ms) *npu_ms = g_last_det_npu_ms;
    if (post_ms) *post_ms = g_last_det_post_ms;
}

void yolo_get_last_det_runtime_metrics(PlateDetectorRuntimeMetrics* metrics) {
    if (!metrics) return;
    metrics->executed = g_last_det_executed;
    metrics->pipeline_enabled = g_last_det_pipeline_enabled;
    metrics->pipeline_active = g_last_det_pipeline_active;
    metrics->quantized_output = rknn_det && !rknn_det->wantFloat();
    metrics->task_count = g_last_det_task_count;
    metrics->score_candidates = g_last_det_score_candidates;
    metrics->decoded_candidates = g_last_det_decoded_candidates;
    metrics->final_candidates = g_last_det_final_candidates;
    metrics->configured_stride = g_last_det_configured_stride;
    metrics->source_frame_sequence = g_last_det_source_frame_sequence;
    metrics->last_detection_source_sequence =
        g_last_detection_source_sequence;
    metrics->queue_depth = g_last_det_pipeline_active ? 1 : 0;
    metrics->dropped_tasks = 0;
    metrics->pre_ms = g_last_det_pre_ms;
    metrics->npu_wall_ms = g_last_det_npu_ms;
    metrics->npu_hw_ms = g_last_det_npu_hw_ms;
    metrics->post_ms = g_last_det_post_ms;
    metrics->e2e_ms = g_last_det_e2e_ms;
    metrics->overlap_saved_ms = g_last_det_overlap_saved_ms;
    metrics->worker_ms = 0.0;
    metrics->overlay_ms = 0.0;
    // A single yolo_run() has no wall-clock reporting window and therefore
    // cannot produce an actual completion FPS. CaptureThread fills these
    // fields from completed cycle/task counts over its reporting interval.
    metrics->task_fps = 0.0;
    metrics->cycle_fps = 0.0;
    metrics->result_age_ms = g_last_det_e2e_ms;
    metrics->strategy = g_last_det_strategy.c_str();
    metrics->preprocess_backend = g_last_det_preprocess_backend.c_str();
    metrics->preprocess_requested = g_last_det_preprocess_requested.c_str();
    metrics->preprocess_fallback_reason =
        g_last_det_preprocess_fallback_reason.c_str();
}

void yolo_set_detector_quantized_output(bool enabled) {
    if (active_detector_profile().require_float_outputs) return;
    g_requested_quantized_output.store(enabled ? 1 : 0,
                                       std::memory_order_release);
}

bool yolo_is_ready() {
    return g_model_ready;
}

const char* yolo_last_error() {
    return g_model_error.c_str();
}
