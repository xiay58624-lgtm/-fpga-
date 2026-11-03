#pragma once

#include <opencv2/core/mat.hpp>
#include <cstdint>
#include <string>
#include <vector>
#include <cstdint>
#include <vector>

void generic_yolo_init();
bool generic_yolo_is_ready();
void generic_yolo_run(cv::Mat &frame);
void generic_yolo_run(cv::Mat &frame, bool split_mosaic);
void generic_set_threshold(float conf, float nms);

// A stable, serializable copy of the most recent environment detections.
// Coordinates are in the image passed to generic_yolo_run().
struct GenericYoloDetection {
    int model_id = -1;
    int class_id = -1;
    float confidence = 0.0f;
    int left = 0;
    int top = 0;
    int right = 0;
    int bottom = 0;
    std::string model_key;
    std::string class_name;
};

// Associate the next inference with the PCIe frame sequence that produced it.
void generic_yolo_set_frame_sequence(std::uint64_t sequence);
bool generic_yolo_get_last_detections(std::vector<GenericYoloDetection> &out,
                                      std::uint64_t &frame_sequence);

struct EnvViolationEvent {
    std::vector<uint8_t> jpeg;
    std::vector<uint8_t> thumb_jpeg;
    int zebra_count = 0;
    int person_count = 0;
    int zebra_left = 0;
    int zebra_top = 0;
    int zebra_right = 0;
    int zebra_bottom = 0;
    int person_left = 0;
    int person_top = 0;
    int person_right = 0;
    int person_bottom = 0;
    float overlap_iou = 0.0f;
};

bool generic_yolo_pop_violation_event(EnvViolationEvent &out);

