#pragma once

#include <memory>
#include <string>
#include <vector>
#include <opencv2/core.hpp>

namespace adas_models {
// Stable model IDs are independent of which models are currently selected.
constexpr unsigned Vehicles = 1u << 0;
constexpr unsigned Lines = 1u << 1;
constexpr unsigned Lights = 1u << 2;
constexpr unsigned All = Vehicles | Lines | Lights;

struct Detection {
    int modelId = -1;
    int classId = -1;
    float confidence = 0;
    cv::Rect box;
    std::string className;
};

// Owned and called exclusively by the road inference thread.
class ModelSet {
public:
    ModelSet();
    ~ModelSet();
    bool select(unsigned mask, std::string *error);
    std::vector<Detection> detect(const cv::Mat &bgr);
    void release();
private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};
}
