#pragma once

#include <opencv2/core/mat.hpp>
#include <opencv2/core/types.hpp>
#include <array>
#include <string>
#include <vector>
#include <QImage>


struct ColorThresholds {
    // HSV 范围参数
    int black_v_max = 60;
    int white_s_max = 35;
    int blue_h_min = 100;
    int green_h_min = 35;
    int yellow_h_min = 18;
    int yellow_h_max = 35;

    // 仲裁逻辑参数 (新增)
    float model_trust_val = 0.8f;   // 模型信任度阈值
    float min_color_ratio = 0.08f;  // 触发修正的最小像素比例
    int double_upper_ratio = 416; 
    int double_lower_start = 333;

    // OCR 识别置信度阈值 (精度: 0.1%)
    // 默认 700 表示 70.0%，低于此值可能显示为 "识别中..."
    int rec_conf_threshold = 700;
};

extern ColorThresholds g_color_cfg;


void set_color_thresholds(const ColorThresholds& cfg);

struct PlateReportEvent {
    std::string plate_no;
    int color_idx;
    float conf;      // 车牌识别置信度
    float det_conf;  // 车牌检测框置信度
    int source_idx;
    QImage thumb;
};

struct PlateEvaluationResult {
    std::string plate_no;
    int plate_type_idx = -1;  // 0=single, 1=double
    int color_idx = -1;       // 0=black, 1=blue, 2=green, 3=white, 4=yellow
    float det_conf = 0.0f;
    float ocr_conf = 0.0f;
    bool ocr_accepted = false;
    int bbox_left = 0;
    int bbox_top = 0;
    int bbox_right = 0;
    int bbox_bottom = 0;
    std::array<float, 8> landmarks{};
    std::string status;
    std::string error;
};

const char* yolo_color_name(int color_idx);
bool yolo_pop_report_event(PlateReportEvent& out);
void yolo_set_view_context(int view_mode, int single_source, int q0, int q1, int q2, int q3);
// Tell the detector that frame is a native 2x2 source mosaic. Each enabled
// source is inferred at source_width x source_height before detections are
// mapped back to the full mosaic coordinates.
void yolo_set_native_mosaic_layout(bool enabled, int source_width,
                                   int source_height, unsigned int source_mask);
void yolo_set_dedupe_by_source(bool enabled);
// Mark only the next yolo_run() call as an independent still image. Detection
// and OCR run immediately, and a valid OCR result can report in one frame.
void yolo_prepare_static_frame();
// Associate the next yolo_run() with its capture/FPGA frame sequence. Live
// inference stride is measured against this sequence, not worker call count.
void yolo_set_source_frame_sequence(unsigned long long sequence);
// Clear detections, OCR consensus and adaptive scan state after an input/view
// generation change. Call this only from the inference thread.
void yolo_reset_temporal_state();

// Initialize YOLO/RKNN once before inference.
void yolo_init();
// 增加一个设置阈值的接口
void set_yolo_threshold(float conf, float nms);
void yolo_set_pose26_head_thresholds(bool enabled, float p3, float p4,
                                     float p5);
// Run YOLO on a BGR frame and show detection result.
void yolo_run( cv::Mat &frame);
// Return the clipped regions changed by the most recent yolo_run() overlay.
// The inference thread owns this state and must consume it before the next run.
void yolo_get_last_overlay_regions(std::vector<cv::Rect> &regions);

// Run one independent plate detection + OCR pass without live-stream
// stability, cooldown, deduplication, drawing, or report-event filtering.
bool yolo_evaluate_image(const cv::Mat &bgr, std::vector<PlateEvaluationResult> &results,
                         std::string &error);
const char* yolo_detection_model_path();
const char* yolo_recognition_model_path();
// Select the detector implementation. Runtime settings call the setter before
// yolo_init(); the reload API is used by the GUI only while capture is stopped.
void yolo_set_detector_profile(int profile);
bool yolo_reload_detector_profile(int profile, std::string &error);
int yolo_current_detector_profile();
const char* yolo_current_detector_profile_key();
const char* yolo_current_detector_family();
const char* yolo_current_detector_model_name();
const char* yolo_current_detector_sha256();
const char* yolo_current_detector_output_contract();
int yolo_current_detector_input_width();
int yolo_current_detector_input_height();
// Select and inspect the OCR implementation. Reload is intended for the GUI
// while capture is stopped; the candidate is validated and warmed before it
// replaces the active RKNN context.
void yolo_set_recognizer_profile(int profile);
bool yolo_reload_recognizer_profile(int profile, std::string &error);
int yolo_current_recognizer_profile();
const char* yolo_current_recognizer_profile_key();
const char* yolo_current_recognizer_model_name();
const char* yolo_current_recognizer_output_contract();
const char* yolo_current_recognizer_input_format();
const char* yolo_current_recognizer_model_input_type();
const char* yolo_current_recognizer_text_layout();
int yolo_current_recognizer_input_width();
int yolo_current_recognizer_input_height();
float yolo_effective_detection_threshold();
float yolo_evaluation_detection_threshold();
float yolo_ocr_acceptance_threshold();

void yolo_get_last_stage_ms(double* det_box_ms, double* det_ocr_ms);
void yolo_get_last_det_parts(double* pre_ms, double* npu_ms, double* post_ms);
struct PlateDetectorRuntimeMetrics {
    bool executed = false;
    bool pipeline_enabled = false;
    bool pipeline_active = false;
    bool quantized_output = false;
    int task_count = 0;
    int queue_depth = 0;
    unsigned long long dropped_tasks = 0;
    int score_candidates = 0;
    int decoded_candidates = 0;
    int final_candidates = 0;
    int configured_stride = 1;
    unsigned long long source_frame_sequence = 0;
    unsigned long long last_detection_source_sequence = 0;
    double pre_ms = 0.0;
    double npu_wall_ms = 0.0;
    double npu_hw_ms = 0.0;
    double post_ms = 0.0;
    double e2e_ms = 0.0;
    double overlap_saved_ms = 0.0;
    double worker_ms = 0.0;
    double overlay_ms = 0.0;
    double task_fps = 0.0;
    double cycle_fps = 0.0;
    double result_age_ms = 0.0;
    const char* strategy = "inactive";
    const char* preprocess_backend = "opencv";
    const char* preprocess_requested = "auto";
    const char* preprocess_fallback_reason = "";
};
void yolo_get_last_det_runtime_metrics(PlateDetectorRuntimeMetrics* metrics);
bool yolo_rga_available();
void yolo_set_detector_quantized_output(bool enabled);
bool yolo_is_ready();
const char* yolo_last_error();
