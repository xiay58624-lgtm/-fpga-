#include "PlateDetectorProfiles.h"

#include <algorithm>
#include <cstdint>
#include <cmath>
#include <limits>
#include <numeric>
#include <sstream>
#include <tuple>

namespace plate_detector {
namespace {

struct HeadSpec {
    int stride;
    int height;
    int width;
    std::array<std::array<float, 2>, 3> anchors;
    float threshold;
};

struct Shape4d {
    int channels = 0;
    int height = 0;
    int width = 0;
};

const std::vector<Profile> kProfiles = {
    {ProfileId::LegacyV5, "legacy_v5", "V5 旧版 640x640",
     "yolov5", "plate_detect_mixed.rknn", 640, 640,
     Family::YoloV5, "yolov5_anchor_pose_3x15", false, false, ""},
    {ProfileId::V5Focus720, "v5_focus_720", "V5 FocusConv6 1280x720",
     "yolov5", "plate_det_v5_focus_1280x720.rknn", 1280, 720,
     Family::YoloV5, "yolov5_anchor_pose_3x15", true, false, ""},
    {ProfileId::Yolo26P3Lite384, "yolo26_p3lite_384",
      "YOLO26 P3Lite INT8 640x384", "yolo26",
      "plate_det_yolo26_p3lite_640x384_int8.rknn", 640, 384,
      Family::Yolo26, "pose26_raw_box_cls_kpt_9out", true, false, ""},
    {ProfileId::Yolo26P3Fp16, "yolo26_p3_fp16", "YOLO26 P3 FP16 768x448",
     "yolo26", "plate_det_yolo26_p3_768x448_fp16.rknn", 768, 448,
     Family::Yolo26, "pose26_raw_box_cls_kpt_9out", true, true, ""},
    {ProfileId::V5Shuffle720, "v5_shuffle_720",
     "V5 ShuffleNetV2 1280x720", "yolov5",
     "plate_det_v5_shufflenet_1280x720.rknn", 1280, 720,
     Family::YoloV5, "yolov5_anchor_pose_3x15_p3neck", true, false, ""},
    {ProfileId::Pose26_1280x720_Fp, "pose26_1280x720_fp",
     "Pose26 1280x720 FP", "pose26", "p3_rk3568_fp.rknn", 1280, 720,
     Family::Yolo26,
     "pose26_p3_box_cls_kpt_p4_box_cls_kpt_p5_box_cls_kpt_9out_nchw",
     true, true,
     "8c749c190787171191d954822984962789c973ac9d3ff768688f356f7fc9016c"},
    {ProfileId::Pose26_1280x720_FullInt8, "pose26_1280x720_full_int8",
     "Pose26 1280x720 Full INT8", "pose26",
     "p3_rk3568_heads_full_int8.rknn", 1280, 720, Family::Yolo26,
     "pose26_p3_box_cls_kpt_p4_box_cls_kpt_p5_box_cls_kpt_9out_nchw",
     true, false,
     "7d13f18433f91ff8191287fe2a04e32bd2071e258871a88f5473ad2ae015ce97"},
    {ProfileId::Pose26_1280x720_KptFp16, "pose26_1280x720_kpt_fp16",
     "Pose26 1280x720 KPT FP16", "pose26",
     "p3_rk3568_heads_kpt_fp16.rknn", 1280, 720, Family::Yolo26,
     "pose26_p3_box_cls_kpt_p4_box_cls_kpt_p5_box_cls_kpt_9out_nchw",
     true, true,
     "6953dbafba05f1264c21448bd0094a2a6188bfe40213364ca50928840f21de8a"},
    {ProfileId::Pose26_1280x720_P4UpstreamFp16,
     "pose26_1280x720_p4_upstream_fp16_v7",
     "Pose26 1280x720 P4 Upstream FP16 v7", "pose26",
     "p3_rk3568_heads_p4_upstream_fp16_v7.rknn", 1280, 720,
     Family::Yolo26,
     "pose26_p3_box_cls_kpt_p4_box_cls_kpt_p5_box_cls_kpt_9out_nchw",
     true, true,
     "a189bedfb174ca4393285dd9b960d42c30e7e19a7b2e76370b90ecc9a85c8941"},
};

constexpr std::array<HeadSpec, 3> kHeads720 = {{
    {8, 90, 160, {{{4, 5}, {8, 10}, {13, 16}}}, 0.0f},
    {16, 45, 80, {{{23, 29}, {43, 55}, {73, 105}}}, 0.0f},
    {32, 23, 40, {{{146, 217}, {231, 300}, {335, 433}}}, 0.0f},
}};

float sigmoid(float value) {
    value = std::max(-30.0f, std::min(30.0f, value));
    return 1.0f / (1.0f + std::exp(-value));
}

bool shape4d(const TensorView &view, Shape4d &shape) {
    if (view.dims.size() != 4 || view.dims[0] != 1) return false;
    if (view.layout == TensorLayout::Nchw) {
        shape = {view.dims[1], view.dims[2], view.dims[3]};
    } else {
        shape = {view.dims[3], view.dims[1], view.dims[2]};
    }
    return shape.channels > 0 && shape.height > 0 && shape.width > 0;
}

float valueAt(const TensorView &view, const Shape4d &shape,
              int channel, int y, int x) {
    size_t index = 0;
    if (view.layout == TensorLayout::Nchw) {
        index = static_cast<size_t>(((channel * shape.height) + y) *
                                    shape.width + x);
    } else {
        index = static_cast<size_t>(((y * shape.width) + x) *
                                    shape.channels + channel);
    }
    if (view.quantized && view.raw_data) {
        const int raw = view.uint8
            ? static_cast<int>(static_cast<const uint8_t *>(view.raw_data)[index])
            : static_cast<int>(static_cast<const int8_t *>(view.raw_data)[index]);
        return (static_cast<float>(raw) - static_cast<float>(view.zero_point)) *
               view.scale;
    }
    return view.data ? view.data[index] : 0.0f;
}

float area(const Detection &detection) {
    return std::max(0.0f, detection.right - detection.left) *
           std::max(0.0f, detection.bottom - detection.top);
}

float intersection(const Detection &one, const Detection &two) {
    return std::max(0.0f, std::min(one.right, two.right) -
                              std::max(one.left, two.left)) *
           std::max(0.0f, std::min(one.bottom, two.bottom) -
                              std::max(one.top, two.top));
}

float iou(const Detection &one, const Detection &two) {
    const float overlap = intersection(one, two);
    return overlap / std::max(1e-9f, area(one) + area(two) - overlap);
}

float containment(const Detection &one, const Detection &two) {
    return intersection(one, two) / std::max(1e-9f, std::min(area(one), area(two)));
}

std::vector<Detection> nms(std::vector<Detection> candidates,
                           float threshold, bool class_aware = true) {
    std::sort(candidates.begin(), candidates.end(),
              [](const Detection &one, const Detection &two) {
                  return one.confidence > two.confidence;
              });
    std::vector<Detection> kept;
    for (const Detection &candidate : candidates) {
        bool duplicate = false;
        for (const Detection &existing : kept) {
            if (class_aware && candidate.class_id != existing.class_id) continue;
            if (iou(candidate, existing) > threshold) {
                duplicate = true;
                break;
            }
        }
        if (!duplicate) kept.push_back(candidate);
    }
    return kept;
}

const TensorView *findTensor(const std::vector<TensorView> &outputs,
                             int channels, int height, int width) {
    for (const TensorView &output : outputs) {
        Shape4d shape;
        if (shape4d(output, shape) && shape.channels == channels &&
            shape.height == height && shape.width == width) {
            return &output;
        }
    }
    return nullptr;
}

std::string shapesText(const std::vector<TensorView> &outputs) {
    std::ostringstream stream;
    for (size_t index = 0; index < outputs.size(); ++index) {
        if (index) stream << ';';
        stream << '[';
        for (size_t dim = 0; dim < outputs[index].dims.size(); ++dim) {
            if (dim) stream << ',';
            stream << outputs[index].dims[dim];
        }
        stream << ']';
    }
    return stream.str();
}

int headSize(int input_size, int stride) {
    return (input_size + stride - 1) / stride;
}

bool validateV5(const std::vector<TensorView> &outputs, std::string &error) {
    if (outputs.size() != 3) {
        error = "expected 3 YOLOv5 outputs, got " +
                std::to_string(outputs.size());
        return false;
    }
    for (const HeadSpec &head : kHeads720) {
        if (!findTensor(outputs, 45, head.height, head.width)) {
            error = "missing YOLOv5 45-channel head; outputs=" +
                    shapesText(outputs);
            return false;
        }
    }
    return true;
}

bool validateYolo26(const Profile &selected,
                    const std::vector<TensorView> &outputs,
                    std::string &error) {
    if (outputs.size() != 9) {
        error = "expected 9 YOLO26 outputs, got " +
                std::to_string(outputs.size());
        return false;
    }
    for (int level = 0; level < 3; ++level) {
        const int stride = 8 << level;
        const int height = headSize(selected.input_height, stride);
        const int width = headSize(selected.input_width, stride);
        const int expected_channels[3] = {4, 2, 8};
        for (int branch = 0; branch < 3; ++branch) {
            const int output_index = level * 3 + branch;
            Shape4d shape;
            if (!shape4d(outputs[static_cast<size_t>(output_index)], shape) ||
                shape.channels != expected_channels[branch] ||
                shape.height != height || shape.width != width) {
                error = "YOLO26 output contract requires P" +
                        std::to_string(level + 3) + " " +
                        (branch == 0 ? "box" : branch == 1 ? "cls" : "kpt") +
                        " at index " + std::to_string(output_index) +
                        " with shape [1," +
                        std::to_string(expected_channels[branch]) + "," +
                        std::to_string(height) + "," +
                        std::to_string(width) + "]; outputs=" +
                        shapesText(outputs);
                return false;
            }
        }
    }
    return true;
}

std::vector<Detection> decodeV5Head(const TensorView &output,
                                    const HeadSpec &head, int head_index,
                                    float threshold, DecodeStats &stats) {
    Shape4d shape;
    shape4d(output, shape);
    std::vector<Detection> detections;
    for (int anchor_index = 0; anchor_index < 3; ++anchor_index) {
        const float anchor_x = head.anchors[anchor_index][0];
        const float anchor_y = head.anchors[anchor_index][1];
        const int base = anchor_index * 15;
        for (int y = 0; y < head.height; ++y) {
            for (int x = 0; x < head.width; ++x) {
                const float objectness = sigmoid(valueAt(output, shape, base + 4, y, x));
                const float class0 = sigmoid(valueAt(output, shape, base + 13, y, x));
                const float class1 = sigmoid(valueAt(output, shape, base + 14, y, x));
                const int class_id = class1 > class0 ? 1 : 0;
                const float confidence = objectness * std::max(class0, class1);
                if (!std::isfinite(confidence) || confidence < threshold) continue;
                ++stats.score_candidates;

                const float center_x =
                    (sigmoid(valueAt(output, shape, base, y, x)) * 2.0f -
                     0.5f + x) * head.stride;
                const float center_y =
                    (sigmoid(valueAt(output, shape, base + 1, y, x)) * 2.0f -
                     0.5f + y) * head.stride;
                const float width_value =
                    std::pow(sigmoid(valueAt(output, shape, base + 2, y, x)) *
                                 2.0f,
                             2.0f) * anchor_x;
                const float height_value =
                    std::pow(sigmoid(valueAt(output, shape, base + 3, y, x)) *
                                 2.0f,
                             2.0f) * anchor_y;

                Detection detection;
                detection.left = center_x - width_value * 0.5f;
                detection.top = center_y - height_value * 0.5f;
                detection.right = center_x + width_value * 0.5f;
                detection.bottom = center_y + height_value * 0.5f;
                detection.confidence = confidence;
                detection.class_id = class_id;
                detection.head = head_index;
                for (int point = 0; point < 4; ++point) {
                    detection.landmarks[point * 2] =
                        valueAt(output, shape, base + 5 + point * 2, y, x) *
                            anchor_x +
                        x * head.stride;
                    detection.landmarks[point * 2 + 1] =
                        valueAt(output, shape, base + 6 + point * 2, y, x) *
                            anchor_y +
                        y * head.stride;
                }
                detections.push_back(detection);
                ++stats.decoded_candidates;
            }
        }
    }
    return detections;
}

bool passesShuffleRule(const Detection &detection, int model_width,
                       int model_height) {
    const float width = std::max(0.0f, detection.right - detection.left);
    const float height = std::max(1e-9f, detection.bottom - detection.top);
    if (detection.head == 0 && detection.class_id == 0 &&
        width / height < 1.6f) {
        return false;
    }
    if (detection.head == 2 && width / model_width >= 0.49f &&
        height / model_height >= 0.32f) {
        return false;
    }
    if (detection.head == 1 && height / model_height >= 0.16f) return false;
    return true;
}

float verticalOverlap(const Detection &one, const Detection &two) {
    const float overlap = std::max(
        0.0f, std::min(one.bottom, two.bottom) - std::max(one.top, two.top));
    const float smaller = std::min(one.bottom - one.top, two.bottom - two.top);
    return overlap / std::max(1e-9f, smaller);
}

bool mergeableP5(const Detection &one, const Detection &two) {
    if (one.head != 2 || two.head != 2 || one.class_id != two.class_id ||
        verticalOverlap(one, two) < 0.7f) {
        return false;
    }
    const float smaller_height =
        std::min(one.bottom - one.top, two.bottom - two.top);
    const float gap = std::max(
        0.0f, std::max(one.left, two.left) - std::min(one.right, two.right));
    if (gap > 0.15f * smaller_height) return false;
    const float left = std::min(one.left, two.left);
    const float right = std::max(one.right, two.right);
    const float top = std::min(one.top, two.top);
    const float bottom = std::max(one.bottom, two.bottom);
    const float ratio = (right - left) / std::max(1e-9f, bottom - top);
    return ratio >= 2.0f && ratio <= 8.0f;
}

Detection mergeP5(const Detection &one, const Detection &two) {
    const Detection &left =
        one.landmarks[0] + one.landmarks[6] <
                two.landmarks[0] + two.landmarks[6]
            ? one
            : two;
    const Detection &right = &left == &one ? two : one;
    Detection merged = one.confidence >= two.confidence ? one : two;
    merged.landmarks = {left.landmarks[0], left.landmarks[1],
                        right.landmarks[2], right.landmarks[3],
                        right.landmarks[4], right.landmarks[5],
                        left.landmarks[6], left.landmarks[7]};
    merged.left = std::min({merged.landmarks[0], merged.landmarks[2],
                            merged.landmarks[4], merged.landmarks[6]});
    merged.top = std::min({merged.landmarks[1], merged.landmarks[3],
                           merged.landmarks[5], merged.landmarks[7]});
    merged.right = std::max({merged.landmarks[0], merged.landmarks[2],
                             merged.landmarks[4], merged.landmarks[6]});
    merged.bottom = std::max({merged.landmarks[1], merged.landmarks[3],
                              merged.landmarks[5], merged.landmarks[7]});
    return merged;
}

std::vector<Detection> routeShuffle(std::vector<Detection> decoded) {
    const std::array<float, 3> thresholds = {0.15f, 0.25f, 0.385f};
    std::vector<Detection> candidates;
    for (const Detection &detection : decoded) {
        if (detection.head < 0 || detection.head > 2 ||
            detection.confidence < thresholds[detection.head] ||
            !passesShuffleRule(detection, 1280, 720)) {
            continue;
        }
        candidates.push_back(detection);
    }
    std::sort(candidates.begin(), candidates.end(),
              [](const Detection &one, const Detection &two) {
                  return one.confidence > two.confidence;
              });
    std::vector<Detection> routed;
    for (const Detection &candidate : candidates) {
        bool duplicate = false;
        for (const Detection &existing : routed) {
            if (candidate.head == existing.head) continue;
            if (iou(candidate, existing) >= 0.45f ||
                containment(candidate, existing) >= 0.8f) {
                duplicate = true;
                break;
            }
        }
        if (!duplicate) routed.push_back(candidate);
    }

    std::vector<Detection> merged;
    std::vector<bool> consumed(routed.size(), false);
    for (size_t i = 0; i < routed.size(); ++i) {
        if (consumed[i]) continue;
        Detection current = routed[i];
        for (size_t j = i + 1; j < routed.size(); ++j) {
            if (!consumed[j] && mergeableP5(current, routed[j])) {
                current = mergeP5(current, routed[j]);
                consumed[j] = true;
            }
        }
        merged.push_back(current);
    }
    return merged;
}

bool decodeV5(ProfileId id, const std::vector<TensorView> &outputs,
              float minimum_score, std::vector<Detection> &detections,
              DecodeStats &stats, std::string &error) {
    if (!validateV5(outputs, error)) return false;
    std::array<float, 3> thresholds{};
    float nms_iou = 0.6f;
    if (id == ProfileId::V5Focus720) {
        thresholds = {0.39f, 0.46f, 0.36f};
    } else {
        thresholds = {0.01f, 0.01f, 0.01f};
        nms_iou = 0.5f;
    }

    std::vector<Detection> decoded;
    for (int level = 0; level < 3; ++level) {
        const HeadSpec &head = kHeads720[level];
        const TensorView *output =
            findTensor(outputs, 45, head.height, head.width);
        const float decode_floor =
            id == ProfileId::V5Focus720 && level == 2
                ? std::min(thresholds[level], 0.35f)
                : thresholds[level];
        std::vector<Detection> level_detections = decodeV5Head(
            *output, head, level,
            std::max(minimum_score, decode_floor), stats);
        if (id == ProfileId::V5Shuffle720) {
            level_detections = nms(std::move(level_detections), 0.5f, true);
        }
        decoded.insert(decoded.end(), level_detections.begin(),
                       level_detections.end());
    }

    if (id == ProfileId::V5Focus720) {
        std::vector<Detection> accepted;
        for (const Detection &candidate : decoded) {
            bool keep = candidate.confidence >= thresholds[candidate.head];
            if (!keep && candidate.head == 2 && candidate.class_id == 0 &&
                candidate.confidence >= 0.35f) {
                const float ratio =
                    (candidate.right - candidate.left) /
                    std::max(1e-9f, candidate.bottom - candidate.top);
                keep = ratio >= 2.2f;
            }
            if (keep) accepted.push_back(candidate);
        }
        detections = nms(std::move(accepted), nms_iou, true);
    } else {
        detections = routeShuffle(std::move(decoded));
    }
    stats.nms_kept = static_cast<int>(detections.size());
    return true;
}

bool decodeYolo26(const Profile &selected,
                  const std::vector<TensorView> &outputs,
                  float minimum_score, std::vector<Detection> &detections,
                  DecodeStats &stats, std::string &error,
                  const std::array<float, 3> *head_thresholds) {
    if (!validateYolo26(selected, outputs, error)) return false;
    // Match the verified Pose26 deployment script. P3 is the small-object
    // head; keeping it at 0.001 is important for small plates.
    const std::array<float, 3> p3lite_thresholds = {0.001f, 0.10f, 0.10f};
    std::vector<Detection> decoded;
    for (int level = 0; level < 3; ++level) {
        const int stride = 8 << level;
        const int height = headSize(selected.input_height, stride);
        const int width = headSize(selected.input_width, stride);
        const TensorView *box = &outputs[static_cast<size_t>(level * 3)];
        const TensorView *cls = &outputs[static_cast<size_t>(level * 3 + 1)];
        const TensorView *keypoint =
            &outputs[static_cast<size_t>(level * 3 + 2)];
        Shape4d box_shape, cls_shape, keypoint_shape;
        shape4d(*box, box_shape);
        shape4d(*cls, cls_shape);
        shape4d(*keypoint, keypoint_shape);
        const float profile_threshold = head_thresholds
            ? (*head_thresholds)[static_cast<size_t>(level)]
            : selected.id == ProfileId::Yolo26P3Lite384
                ? p3lite_thresholds[level] : 0.10f;
        const float threshold = std::max(minimum_score, profile_threshold);
        for (int y = 0; y < height; ++y) {
            for (int x = 0; x < width; ++x) {
                const float class0 = sigmoid(valueAt(*cls, cls_shape, 0, y, x));
                const float class1 = sigmoid(valueAt(*cls, cls_shape, 1, y, x));
                const int class_id = class1 > class0 ? 1 : 0;
                const float confidence = std::max(class0, class1);
                if (!std::isfinite(confidence) || confidence < threshold) continue;
                ++stats.score_candidates;
                const float anchor_x = x + 0.5f;
                const float anchor_y = y + 0.5f;
                const float left_distance = valueAt(*box, box_shape, 0, y, x);
                const float top_distance = valueAt(*box, box_shape, 1, y, x);
                const float right_distance = valueAt(*box, box_shape, 2, y, x);
                const float bottom_distance = valueAt(*box, box_shape, 3, y, x);
                Detection detection;
                detection.left = (anchor_x - left_distance) * stride;
                detection.top = (anchor_y - top_distance) * stride;
                detection.right = (anchor_x + right_distance) * stride;
                detection.bottom = (anchor_y + bottom_distance) * stride;
                detection.confidence = confidence;
                detection.class_id = class_id;
                detection.head = level;
                for (int point = 0; point < 4; ++point) {
                    detection.landmarks[point * 2] =
                        (valueAt(*keypoint, keypoint_shape, point * 2, y, x) +
                         anchor_x) * stride;
                    detection.landmarks[point * 2 + 1] =
                        (valueAt(*keypoint, keypoint_shape, point * 2 + 1, y, x) +
                         anchor_y) * stride;
                }
                decoded.push_back(detection);
                ++stats.decoded_candidates;
            }
        }
    }
    detections = nms(std::move(decoded), 0.45f, true);
    if (detections.size() > 300) detections.resize(300);
    stats.nms_kept = static_cast<int>(detections.size());
    return true;
}

} // namespace

const std::vector<Profile> &profiles() { return kProfiles; }

ProfileId profileFromInt(int value) {
    if (value < 0 || value >= static_cast<int>(kProfiles.size())) {
        return ProfileId::LegacyV5;
    }
    return static_cast<ProfileId>(value);
}

int profileToInt(ProfileId id) { return static_cast<int>(id); }

const Profile &profile(ProfileId id) {
    const int index = profileToInt(id);
    return index >= 0 && index < static_cast<int>(kProfiles.size())
        ? kProfiles[static_cast<size_t>(index)]
        : kProfiles.front();
}

bool validateContract(ProfileId id, int input_width, int input_height,
                      const std::vector<TensorView> &outputs,
                      std::string &error) {
    error.clear();
    const Profile &selected = profile(id);
    if (input_width != selected.input_width ||
        input_height != selected.input_height) {
        error = "input shape mismatch: expected " +
                std::to_string(selected.input_width) + "x" +
                std::to_string(selected.input_height) + ", got " +
                std::to_string(input_width) + "x" +
                std::to_string(input_height);
        return false;
    }
    if (!selected.custom_decoder) return true;
    return selected.family == Family::YoloV5
               ? validateV5(outputs, error)
               : validateYolo26(selected, outputs, error);
}

bool decode(ProfileId id, const std::vector<TensorView> &outputs,
            float minimum_score, std::vector<Detection> &detections,
            DecodeStats &stats, std::string &error,
            const std::array<float, 3> *head_thresholds) {
    detections.clear();
    stats = {};
    error.clear();
    const Profile &selected = profile(id);
    if (!selected.custom_decoder) {
        error = "legacy profile uses the established quantized YOLOv5 decoder";
        return false;
    }
    return selected.family == Family::YoloV5
               ? decodeV5(id, outputs, minimum_score, detections, stats, error)
               : decodeYolo26(selected, outputs, minimum_score, detections,
                              stats, error, head_thresholds);
}

} // namespace plate_detector
