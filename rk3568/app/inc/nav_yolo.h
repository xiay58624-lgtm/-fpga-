#pragma once

#include <opencv2/core/mat.hpp>
#include <opencv2/core/types.hpp>
#include <string>
#include <vector>
#include <QString>

struct NavDetection {
    int class_id = -1;
    float score = 0.0f;
    cv::Rect box;
};

bool nav_yolo_init(std::string *error = nullptr);
void nav_yolo_release();
bool nav_yolo_ready();
const char *nav_yolo_class_name(int class_id);
int nav_yolo_class_count();

// Detect on a BGR image. Letterbox pad is gray 114. Does not draw.
std::vector<NavDetection> nav_yolo_detect(const cv::Mat &bgr);

// Draw boxes + Chinese labels. If video_second >= 0, also draw the PC-style
// bottom banner (预测/实际/建议) using the 111440 timeline.
void nav_yolo_draw(cv::Mat &bgr,
                   const std::vector<NavDetection> &dets,
                   double video_second = -1.0);

// Real-time HUD recommendation: direction 0=straight, 1=left, 2=right,
// 3=stop. The legacy video timeline is deliberately not consulted.
void nav_yolo_recommend(const cv::Mat &bgr,
                        const std::vector<NavDetection> &dets,
                        int *direction,
                        bool *forbidden,
                        bool *slow,
                        QString *status);
