#pragma once

#include <opencv2/core/mat.hpp>
#include <opencv2/core/types.hpp>
#include <string>
#include <vector>

struct AdasDetection {
    int model_id = -1;
    int class_id = -1;
    float score = 0.0f;
    cv::Rect box;
    std::string class_name;
};

bool adas_yolo_init(std::string *error = nullptr);
void adas_yolo_release();
bool adas_yolo_ready();
int adas_yolo_class_count();
// Detect on a BGR image. Letterbox pad is gray 114. Does not draw.
std::vector<AdasDetection> adas_yolo_detect(const cv::Mat &bgr);

// Draw detections onto a BGR image in place.
void adas_yolo_draw(cv::Mat &bgr, const std::vector<AdasDetection> &dets);
