#pragma once

#include <algorithm>
#include <cstdint>
#include <math.h>
#include <numeric>
#include <stdlib.h>
#include <sys/time.h>
#include <type_traits>
#include <vector>

#include <set>
#include <vector>
#include <array>
#include "structures.hpp"

namespace ztu {
namespace nn {
namespace yolov5_ztopt_3out_postprocess {

struct postprocess_stats {
  int objectness_candidates = 0;
  int decoded_candidates = 0;
  int nms_input_candidates = 0;
  int pre_nms_truncated = 0;
  int nms_kept = 0;
};

// Verified against plate_detect.pt Detect.anchor_grid. These values belong to
// the plate detector and must not be replaced by the unrelated best_rk3568
// environment-model anchors.
static constexpr float anchor[3][6] = {
    {4.0f, 5.0f, 8.0f, 10.0f, 13.0f, 16.0f},            // stride 8
    {23.0f, 29.0f, 43.0f, 55.0f, 73.0f, 105.0f},        // stride 16
    {146.0f, 217.0f, 231.0f, 300.0f, 335.0f, 433.0f}    // stride 32
};

namespace {

// Common strides for YOLOv5
const int YOLOv5_STRIDES[] = {8, 16, 32};
const int NUM_STRIDES = sizeof(YOLOv5_STRIDES) / sizeof(YOLOv5_STRIDES[0]);
constexpr int MAX_PRE_NMS_CANDIDATES = 512;

inline static int clamp(float val, int min, int max) {
  return val > min ? (val < max ? val : max) : min;
}

static float CalculateOverlap(float xmin0, float ymin0, float xmax0,
                              float ymax0, float xmin1, float ymin1,
                              float xmax1, float ymax1) {
  float w = fmax(0.f, fmin(xmax0, xmax1) - fmax(xmin0, xmin1) + 1.0);
  float h = fmax(0.f, fmin(ymax0, ymax1) - fmax(ymin0, ymin1) + 1.0);
  float i = w * h;
  float u = (xmax0 - xmin0 + 1.0) * (ymax0 - ymin0 + 1.0) +
            (xmax1 - xmin1 + 1.0) * (ymax1 - ymin1 + 1.0) - i;
  return u <= 0.f ? 0.f : (i / u);
}

static float CalculateIntersectionOverSmaller(float xmin0, float ymin0,
                                              float xmax0, float ymax0,
                                              float xmin1, float ymin1,
                                              float xmax1, float ymax1) {
  const float w = fmax(0.f, fmin(xmax0, xmax1) - fmax(xmin0, xmin1));
  const float h = fmax(0.f, fmin(ymax0, ymax1) - fmax(ymin0, ymin1));
  const float intersection = w * h;
  const float area0 = fmax(0.f, xmax0 - xmin0) * fmax(0.f, ymax0 - ymin0);
  const float area1 = fmax(0.f, xmax1 - xmin1) * fmax(0.f, ymax1 - ymin1);
  const float smaller = fmin(area0, area1);
  return smaller <= 0.f ? 0.f : intersection / smaller;
}

static int nms(int validCount, std::vector<float> &outputLocations,
               const std::vector<int> &classIds, std::vector<int> &order,
               int filterId,
               float threshold) {
  for (int i = 0; i < validCount; ++i) {
    int n = order[i];
    if (n == -1 || (filterId >= 0 && classIds[n] != filterId)) {
      continue;
    }
    for (int j = i + 1; j < validCount; ++j) {
      int m = order[j];
      if (m == -1 || (filterId >= 0 && classIds[m] != filterId)) {
        continue;
      }
      float xmin0 = outputLocations[n * 4 + 0];
      float ymin0 = outputLocations[n * 4 + 1];
      float xmax0 = outputLocations[n * 4 + 0] + outputLocations[n * 4 + 2];
      float ymax0 = outputLocations[n * 4 + 1] + outputLocations[n * 4 + 3];

      float xmin1 = outputLocations[m * 4 + 0];
      float ymin1 = outputLocations[m * 4 + 1];
      float xmax1 = outputLocations[m * 4 + 0] + outputLocations[m * 4 + 2];
      float ymax1 = outputLocations[m * 4 + 1] + outputLocations[m * 4 + 3];

      float iou = CalculateOverlap(xmin0, ymin0, xmax0, ymax0, xmin1, ymin1,
                                   xmax1, ymax1);
      float ios = CalculateIntersectionOverSmaller(
          xmin0, ymin0, xmax0, ymax0, xmin1, ymin1, xmax1, ymax1);

      if (iou > threshold || ios > 0.65f) {
        order[j] = -1;
      }
    }
  }
  return 0;
}

static std::vector<int> top_candidate_indices(
    const std::vector<float> &scores, postprocess_stats *stats) {
  std::vector<int> indices(scores.size());
  std::iota(indices.begin(), indices.end(), 0);
  const size_t keep = std::min(
      indices.size(), static_cast<size_t>(MAX_PRE_NMS_CANDIDATES));
  std::partial_sort(
      indices.begin(), indices.begin() + keep, indices.end(),
      [&scores](int lhs, int rhs) {
        if (scores[static_cast<size_t>(lhs)] ==
            scores[static_cast<size_t>(rhs)]) {
          return lhs < rhs;
        }
        return scores[static_cast<size_t>(lhs)] >
               scores[static_cast<size_t>(rhs)];
      });
  indices.resize(keep);
  if (stats) {
    stats->nms_input_candidates = static_cast<int>(keep);
    stats->pre_nms_truncated =
        static_cast<int>(scores.size() - keep);
  }
  return indices;
}

static float sigmoid(float x) { return 1.0 / (1.0 + expf(-x)); }

static float unsigmoid(float y) { return -1.0 * logf((1.0 / y) - 1.0); }

inline static int32_t __clip(float val, float min, float max) {
  float f = val <= min ? min : (val >= max ? max : val);
  return f;
}

static int8_t qnt_f32_to_affine(float f32, int32_t zp, float scale) {
  float dst_val = (f32 / scale) + zp;
  int8_t res = (int8_t)__clip(dst_val, -128, 127);
  return res;
}

static uint8_t qnt_f32_to_affine_u8(float f32, int32_t zp, float scale) {
  float dst_val = (f32 / scale) + zp;
  uint8_t res = (uint8_t)__clip(dst_val, 0, 255);
  return res;
}

static float deqnt_affine_to_f32(int8_t qnt, int32_t zp, float scale) {
  return ((float)qnt - (float)zp) * scale;
}

static float deqnt_affine_u8_to_f32(uint8_t qnt, int32_t zp, float scale) {
  return ((float)qnt - (float)zp) * scale;
}

static int process_fp32(float *input, const float *anchor, int grid_h,
                        int grid_w, int height, int width, int stride,
                        std::vector<float> &boxes, std::vector<float> &objProbs,
                        std::vector<int> &classId, 
                        std::vector<std::array<float, 8>> &landmarks_vec, // ★ 补上参数
                        float threshold, const int prop_box_size,
                        const int class_nums, postprocess_stats *stats) {
  int validCount = 0;
  int grid_len = grid_h * grid_w;
  
  // 🌟 核心修改点 1：强制指定 NPU 输出的通道数为 15
  const int actual_box_size = 15; 

  for (int a = 0; a < 3; a++) {
    for (int i = 0; i < grid_h; i++) {
      for (int j = 0; j < grid_w; j++) {
        
        float box_confidence =
            sigmoid(input[(actual_box_size * a + 4) * grid_len + i * grid_w + j]);
            
        if (box_confidence > threshold) {
          if (stats) ++stats->objectness_candidates;
          int offset = (actual_box_size * a) * grid_len + i * grid_w + j;
          float *in_ptr = input + offset;
          
          float box_x = sigmoid(*in_ptr) * 2.0 - 0.5;
          float box_y = sigmoid(in_ptr[1 * grid_len]) * 2.0 - 0.5;
          float box_w = sigmoid(in_ptr[2 * grid_len]) * 2.0;
          float box_h = sigmoid(in_ptr[3 * grid_len]) * 2.0;
          
          box_x = (box_x + j) * (float)stride;
          box_y = (box_y + i) * (float)stride;
          box_w = box_w * box_w * (float)anchor[a * 2];
          box_h = box_h * box_h * (float)anchor[a * 2 + 1];
          box_x -= (box_w / 2.0);
          box_y -= (box_h / 2.0);

          // ★ 新增：解码 4 个关键点
          std::array<float, 8> lm;
          for (int k = 0; k < 4; ++k) {
              lm[k * 2]     = in_ptr[(5 + k * 2) * grid_len] * (float)anchor[a * 2] + j * stride;
              lm[k * 2 + 1] = in_ptr[(6 + k * 2) * grid_len] * (float)anchor[a * 2 + 1] + i * stride;
          }

          float prob0 = sigmoid(in_ptr[13 * grid_len]); 
          float prob1 = sigmoid(in_ptr[14 * grid_len]); 
          
          int maxClassId = (prob0 > prob1) ? 0 : 1;
          float maxClassProbs = (prob0 > prob1) ? prob0 : prob1;

          // Match the exported ONNX postprocess: the configured threshold is
          // an objectness threshold. Class probabilities select the class and
          // contribute to the final score, but are not filtered separately.
          objProbs.push_back(maxClassProbs * box_confidence);
          classId.push_back(maxClassId);
          validCount++;
          if (stats) ++stats->decoded_candidates;
          boxes.push_back(box_x);
          boxes.push_back(box_y);
          boxes.push_back(box_w);
          boxes.push_back(box_h);
          landmarks_vec.push_back(lm);
        }
      }
    }
  }
  return validCount;
}

template <typename QT>
static int process_affine(const QT *input, int32_t zp, float scale,
                          const float *anchor, int grid_h, int grid_w,
                          int height, int width, int stride,
                          std::vector<float> &boxes,
                          std::vector<float> &objProbs,
                          std::vector<int> &classId,
                          std::vector<std::array<float, 8>> &landmarks_vec,
                          float threshold, const int prop_box_size,
                          const int class_nums, postprocess_stats *stats) {
  int validCount = 0;
  int grid_len = grid_h * grid_w;
  const int actual_box_size = 15;

  auto dq = [&](QT v) -> float {
    if constexpr (std::is_same<QT, uint8_t>::value) {
      return deqnt_affine_u8_to_f32(v, zp, scale);
    } else {
      return deqnt_affine_to_f32((int8_t)v, zp, scale);
    }
  };

  const float logit_th = unsigmoid(threshold);
  QT q_th = (QT)0;
  if constexpr (std::is_same<QT, uint8_t>::value) {
    q_th = (QT)qnt_f32_to_affine_u8(logit_th, zp, scale);
  } else {
    q_th = (QT)qnt_f32_to_affine(logit_th, zp, scale);
  }

  for (int a = 0; a < 3; a++) {
    for (int i = 0; i < grid_h; i++) {
      for (int j = 0; j < grid_w; j++) {
        QT raw_conf = input[(actual_box_size * a + 4) * grid_len + i * grid_w + j];
        if (raw_conf >= q_th) {
          const float box_confidence = sigmoid(dq(raw_conf));
          if (box_confidence <= threshold) {
            continue;
          }
          if (stats) ++stats->objectness_candidates;

          int offset = (actual_box_size * a) * grid_len + i * grid_w + j;
          const QT *in_ptr = input + offset;

          QT raw_prob0 = in_ptr[13 * grid_len];
          QT raw_prob1 = in_ptr[14 * grid_len];

          float box_x = sigmoid(dq(in_ptr[0])) * 2.0f - 0.5f;
          float box_y = sigmoid(dq(in_ptr[1 * grid_len])) * 2.0f - 0.5f;
          float box_w = sigmoid(dq(in_ptr[2 * grid_len])) * 2.0f;
          float box_h = sigmoid(dq(in_ptr[3 * grid_len])) * 2.0f;

          box_x = (box_x + j) * (float)stride;
          box_y = (box_y + i) * (float)stride;
          box_w = box_w * box_w * (float)anchor[a * 2];
          box_h = box_h * box_h * (float)anchor[a * 2 + 1];
          box_x -= (box_w / 2.0f);
          box_y -= (box_h / 2.0f);

          std::array<float, 8> lm;
          for (int k = 0; k < 4; ++k) {
            lm[k * 2] = dq(in_ptr[(5 + k * 2) * grid_len]) *
                            (float)anchor[a * 2] +
                        j * stride;
            lm[k * 2 + 1] = dq(in_ptr[(6 + k * 2) * grid_len]) *
                                (float)anchor[a * 2 + 1] +
                            i * stride;
          }

          float prob0 = sigmoid(dq(raw_prob0));
          float prob1 = sigmoid(dq(raw_prob1));

          int maxClassId = (prob0 > prob1) ? 0 : 1;
          float maxClassProbs = (prob0 > prob1) ? prob0 : prob1;

          objProbs.push_back(maxClassProbs * box_confidence);
          classId.push_back(maxClassId);
          validCount++;
          if (stats) ++stats->decoded_candidates;
          boxes.push_back(box_x);
          boxes.push_back(box_y);
          boxes.push_back(box_w);
          boxes.push_back(box_h);
          landmarks_vec.push_back(lm);
        }
      }
    }
  }
  return validCount;
}

} // anonymous namespace

static int postprocess(const float *outputs[], float conf_threshold,
                       float nms_threshold,
                       object_detect_result_list *od_results,
                       int model_in_w = 640, int model_in_h = 640,
                       int num_classes = 80,
                       postprocess_stats *stats = nullptr) {
  const int prop_box_size = 15;
  std::vector<float> filterBoxes;
  std::vector<float> objProbs;
  std::vector<int> classId;
  std::vector<std::array<float, 8>> filterLandmarks; // ★ 新增暂存向量
  int validCount = 0;
  od_results->results.clear();
  od_results->count = 0;
  if (stats) *stats = {};

  std::vector<int> grid_hs(NUM_STRIDES);
  std::vector<int> grid_ws(NUM_STRIDES);
  for (int i = 0; i < NUM_STRIDES; ++i) {
    grid_hs[i] = model_in_h / YOLOv5_STRIDES[i];
    grid_ws[i] = model_in_w / YOLOv5_STRIDES[i];
  }

  for (int i = 0; i < NUM_STRIDES; i++) {
    int grid_h = grid_hs[i];
    int grid_w = grid_ws[i];
    int stride = YOLOv5_STRIDES[i];
    validCount +=
        process_fp32((float *)outputs[i], anchor[i], grid_h, grid_w, model_in_h,
                     model_in_w, stride, filterBoxes, objProbs, classId,
                     filterLandmarks, // ★ 传入关键点向量
                     conf_threshold, prop_box_size, num_classes, stats);
  }

  if (validCount <= 0) {
    if (stats) stats->nms_input_candidates = 0;
    return 0;
  }
  
  std::vector<int> indexArray = top_candidate_indices(objProbs, stats);
  validCount = static_cast<int>(indexArray.size());

  // Single-plate and double-plate predictions describe mutually exclusive
  // shapes of the same physical object. Suppress overlaps across classes so
  // one plate cannot survive as two boxes solely due to class disagreement.
  nms(validCount, filterBoxes, classId, indexArray, -1, nms_threshold);

  od_results->results.reserve(validCount);

  /* box valid detect target */
  for (int i = 0; i < validCount; ++i) {
    if (indexArray[i] == -1) {
      continue;
    }
    int n = indexArray[i];

    float x1 = filterBoxes[n * 4 + 0];
    float y1 = filterBoxes[n * 4 + 1];
    float x2 = x1 + filterBoxes[n * 4 + 2];
    float y2 = y1 + filterBoxes[n * 4 + 3];
    int id = classId[n];
    float obj_conf = objProbs[static_cast<size_t>(n)];

    object_detect_result result;
    result.box.left = (int)(clamp(x1, 0, model_in_w));
    result.box.top = (int)(clamp(y1, 0, model_in_h));
    result.box.right = (int)(clamp(x2, 0, model_in_w));
    result.box.bottom = (int)(clamp(y2, 0, model_in_h));
    result.prop = obj_conf;
    result.cls_id = id;

    // ★ 修复：赋值必须要放在循环里面！
    for (int k = 0; k < 8; ++k) {
        result.landmarks[k] = filterLandmarks[n][k];
    }

    od_results->results.push_back(result);
  }

  od_results->count = od_results->results.size();
  if (stats) stats->nms_kept = od_results->count;
  return 0;
}

static int postprocess_affine(const void *outputs[], const bool is_u8[],
                              const int32_t zps[], const float scales[],
                              float conf_threshold, float nms_threshold,
                              object_detect_result_list *od_results,
                              int model_in_w = 640, int model_in_h = 640,
                              int num_classes = 80,
                              postprocess_stats *stats = nullptr) {
  const int prop_box_size = 15;
  std::vector<float> filterBoxes;
  std::vector<float> objProbs;
  std::vector<int> classId;
  std::vector<std::array<float, 8>> filterLandmarks;
  int validCount = 0;
  od_results->results.clear();
  od_results->count = 0;
  if (stats) *stats = {};

  std::vector<int> grid_hs(NUM_STRIDES);
  std::vector<int> grid_ws(NUM_STRIDES);
  for (int i = 0; i < NUM_STRIDES; ++i) {
    grid_hs[i] = model_in_h / YOLOv5_STRIDES[i];
    grid_ws[i] = model_in_w / YOLOv5_STRIDES[i];
  }

  for (int i = 0; i < NUM_STRIDES; i++) {
    int grid_h = grid_hs[i];
    int grid_w = grid_ws[i];
    int stride = YOLOv5_STRIDES[i];
    if (is_u8[i]) {
      validCount += process_affine((const uint8_t *)outputs[i], zps[i],
                                   scales[i], anchor[i], grid_h, grid_w,
                                   model_in_h, model_in_w, stride, filterBoxes,
                                   objProbs, classId, filterLandmarks,
                                   conf_threshold, prop_box_size, num_classes,
                                   stats);
    } else {
      validCount += process_affine((const int8_t *)outputs[i], zps[i], scales[i],
                                   anchor[i], grid_h, grid_w, model_in_h,
                                   model_in_w, stride, filterBoxes, objProbs,
                                   classId, filterLandmarks, conf_threshold,
                                   prop_box_size, num_classes, stats);
    }
  }

  if (validCount <= 0) {
    if (stats) stats->nms_input_candidates = 0;
    return 0;
  }

  std::vector<int> indexArray = top_candidate_indices(objProbs, stats);
  validCount = static_cast<int>(indexArray.size());

  nms(validCount, filterBoxes, classId, indexArray, -1, nms_threshold);

  od_results->results.reserve(validCount);

  for (int i = 0; i < validCount; ++i) {
    if (indexArray[i] == -1) {
      continue;
    }
    int n = indexArray[i];

    object_detect_result result;
    float x1 = filterBoxes[n * 4 + 0];
    float y1 = filterBoxes[n * 4 + 1];
    float x2 = x1 + filterBoxes[n * 4 + 2];
    float y2 = y1 + filterBoxes[n * 4 + 3];
    result.box.left = (int)(clamp(x1, 0, model_in_w));
    result.box.top = (int)(clamp(y1, 0, model_in_h));
    result.box.right = (int)(clamp(x2, 0, model_in_w));
    result.box.bottom = (int)(clamp(y2, 0, model_in_h));
    result.prop = objProbs[static_cast<size_t>(n)];
    result.cls_id = classId[n];
    result.custom_text = "";
    for (int k = 0; k < 8; ++k) {
      result.landmarks[k] = filterLandmarks[n][k];
    }
    od_results->results.push_back(result);
  }
  od_results->count = od_results->results.size();
  if (stats) stats->nms_kept = od_results->count;
  return 0;
}

} // namespace yolov5_ztopt_3out_postprocess
} // namespace nn
} // namespace ztu
