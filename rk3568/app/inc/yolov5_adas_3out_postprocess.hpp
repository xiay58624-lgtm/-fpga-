#pragma once

#include <cstdint>
#include <math.h>
#include <vector>
#include <set>
#include <type_traits>
#include "structures.hpp"

namespace ztu {
namespace nn {
// ADAS 14-class raw YOLOv5 heads (adas_best_final_int8.rknn / topic3 miss7).
// Anchors must match the fused export report for the deployed .rknn.
// topic3 miss7 fine-tune uses COCO-default anchors from yolov5n.yaml.
namespace yolov5_adas_3out_postprocess {

static constexpr float anchor[3][6] = {
    {10.0f, 13.0f, 16.0f, 30.0f, 33.0f, 23.0f},
    {30.0f, 61.0f, 62.0f, 45.0f, 59.0f, 119.0f},
    {116.0f, 90.0f, 156.0f, 198.0f, 373.0f, 326.0f}
};

namespace {

static constexpr int YOLOV5_STRIDES[] = {8, 16, 32};

static float CalculateOverlap(float xmin0, float ymin0, float xmax0, float ymax0,
                              float xmin1, float ymin1, float xmax1, float ymax1) {
  float w = fmax(0.f, fmin(xmax0, xmax1) - fmax(xmin0, xmin1) + 1.0f);
  float h = fmax(0.f, fmin(ymax0, ymax1) - fmax(ymin0, ymin1) + 1.0f);
  float i = w * h;
  float u = (xmax0 - xmin0 + 1.0f) * (ymax0 - ymin0 + 1.0f) +
            (xmax1 - xmin1 + 1.0f) * (ymax1 - ymin1 + 1.0f) - i;
  return u <= 0.f ? 0.f : (i / u);
}

static int nms(int validCount, std::vector<float> &outputLocations,
               std::vector<int> classIds, std::vector<int> &order, int filterId,
               float threshold) {
  for (int i = 0; i < validCount; ++i) {
    int n = order[i];
    if (n == -1 || classIds[n] != filterId) continue;
    for (int j = i + 1; j < validCount; ++j) {
      int m = order[j];
      if (m == -1 || classIds[m] != filterId) continue;
      float xmin0 = outputLocations[n * 4 + 0];
      float ymin0 = outputLocations[n * 4 + 1];
      float xmax0 = outputLocations[n * 4 + 0] + outputLocations[n * 4 + 2];
      float ymax0 = outputLocations[n * 4 + 1] + outputLocations[n * 4 + 3];
      float xmin1 = outputLocations[m * 4 + 0];
      float ymin1 = outputLocations[m * 4 + 1];
      float xmax1 = outputLocations[m * 4 + 0] + outputLocations[m * 4 + 2];
      float ymax1 = outputLocations[m * 4 + 1] + outputLocations[m * 4 + 3];
      float iou = CalculateOverlap(xmin0, ymin0, xmax0, ymax0, xmin1, ymin1, xmax1, ymax1);
      if (iou > threshold) order[j] = -1;
    }
  }
  return 0;
}

static int quick_sort_indice_inverse(std::vector<float> &input, int left,
                                     int right, std::vector<int> &indices) {
  float key;
  int key_index;
  int low = left;
  int high = right;
  if (left < right) {
    key_index = indices[left];
    key = input[left];
    while (low < high) {
      while (low < high && input[high] <= key) high--;
      input[low] = input[high];
      indices[low] = indices[high];
      while (low < high && input[low] >= key) low++;
      input[high] = input[low];
      indices[high] = indices[low];
    }
    input[low] = key;
    indices[low] = key_index;
    quick_sort_indice_inverse(input, left, low - 1, indices);
    quick_sort_indice_inverse(input, low + 1, right, indices);
  }
  return low;
}

static float sigmoid(float x) { return 1.0f / (1.0f + expf(-x)); }
static float unsigmoid(float y) { return -1.0f * logf((1.0f / y) - 1.0f); }

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

static int process_fp32(float *input, const float *anchor_ptr, int grid_h,
                        int grid_w, int stride, std::vector<float> &boxes,
                        std::vector<float> &objProbs, std::vector<int> &classId,
                        float threshold, int prop_box_size, int class_nums) {
  int validCount = 0;
  int grid_len = grid_h * grid_w;
  for (int a = 0; a < 3; a++) {
    for (int i = 0; i < grid_h; i++) {
      for (int j = 0; j < grid_w; j++) {
        float box_confidence =
            sigmoid(input[(prop_box_size * a + 4) * grid_len + i * grid_w + j]);
        if (box_confidence < threshold) continue;
        int offset = (prop_box_size * a) * grid_len + i * grid_w + j;
        float *in_ptr = input + offset;
        float box_x = sigmoid(*in_ptr) * 2.0f - 0.5f;
        float box_y = sigmoid(in_ptr[grid_len]) * 2.0f - 0.5f;
        float box_w = sigmoid(in_ptr[2 * grid_len]) * 2.0f;
        float box_h = sigmoid(in_ptr[3 * grid_len]) * 2.0f;
        box_x = (box_x + j) * (float)stride;
        box_y = (box_y + i) * (float)stride;
        box_w = box_w * box_w * (float)anchor_ptr[a * 2];
        box_h = box_h * box_h * (float)anchor_ptr[a * 2 + 1];
        box_x -= (box_w / 2.0f);
        box_y -= (box_h / 2.0f);

        float maxClassProbs = sigmoid(in_ptr[5 * grid_len]);
        int maxClassId = 0;
        for (int k = 1; k < class_nums; ++k) {
          float prob = sigmoid(in_ptr[(5 + k) * grid_len]);
          if (prob > maxClassProbs) {
            maxClassId = k;
            maxClassProbs = prob;
          }
        }
        if (maxClassProbs < threshold) continue;
        objProbs.push_back(maxClassProbs * box_confidence);
        classId.push_back(maxClassId);
        validCount++;
        boxes.push_back(box_x);
        boxes.push_back(box_y);
        boxes.push_back(box_w);
        boxes.push_back(box_h);
      }
    }
  }
  return validCount;
}

template <typename QT>
static int process_affine(const QT *input, int32_t zp, float scale,
                          const float *anchor_ptr, int grid_h, int grid_w,
                          int stride, std::vector<float> &boxes,
                          std::vector<float> &objProbs,
                          std::vector<int> &classId, float threshold,
                          int prop_box_size, int class_nums) {
  int validCount = 0;
  int grid_len = grid_h * grid_w;

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
        QT raw_conf = input[(prop_box_size * a + 4) * grid_len + i * grid_w + j];
        if (raw_conf < q_th) continue;

        int offset = (prop_box_size * a) * grid_len + i * grid_w + j;
        const QT *in_ptr = input + offset;

        QT raw_max = in_ptr[5 * grid_len];
        int maxClassId = 0;
        for (int k = 1; k < class_nums; ++k) {
          QT v = in_ptr[(5 + k) * grid_len];
          if (v > raw_max) {
            raw_max = v;
            maxClassId = k;
          }
        }
        if (raw_max < q_th) continue;

        float box_confidence = sigmoid(dq(raw_conf));

        float box_x = sigmoid(dq(in_ptr[0])) * 2.0f - 0.5f;
        float box_y = sigmoid(dq(in_ptr[grid_len])) * 2.0f - 0.5f;
        float box_w = sigmoid(dq(in_ptr[2 * grid_len])) * 2.0f;
        float box_h = sigmoid(dq(in_ptr[3 * grid_len])) * 2.0f;
        box_x = (box_x + j) * (float)stride;
        box_y = (box_y + i) * (float)stride;
        box_w = box_w * box_w * (float)anchor_ptr[a * 2];
        box_h = box_h * box_h * (float)anchor_ptr[a * 2 + 1];
        box_x -= (box_w / 2.0f);
        box_y -= (box_h / 2.0f);

        float maxClassProbs = sigmoid(dq(raw_max));
        if (maxClassProbs < threshold) continue;

        objProbs.push_back(maxClassProbs * box_confidence);
        classId.push_back(maxClassId);
        validCount++;
        boxes.push_back(box_x);
        boxes.push_back(box_y);
        boxes.push_back(box_w);
        boxes.push_back(box_h);
      }
    }
  }
  return validCount;
}

} // namespace

static int postprocess(const float *outputs[], float conf_threshold,
                       float nms_threshold,
                       object_detect_result_list *od_results,
                       int model_in_w = 640, int model_in_h = 640,
                       int num_classes = 80) {
  const int prop_box_size = 5 + num_classes;
  std::vector<float> filterBoxes;
  std::vector<float> objProbs;
  std::vector<int> classId;
  int validCount = 0;
  od_results->results.clear();

  for (int i = 0; i < 3; i++) {
    int stride = YOLOV5_STRIDES[i];
    int grid_h = model_in_h / stride;
    int grid_w = model_in_w / stride;
    validCount += process_fp32(const_cast<float *>(outputs[i]), anchor[i], grid_h, grid_w,
                               stride, filterBoxes, objProbs, classId, conf_threshold,
                               prop_box_size, num_classes);
  }

  if (validCount <= 0) {
    od_results->count = 0;
    return 0;
  }

  std::vector<int> indexArray(validCount);
  for (int i = 0; i < validCount; ++i) indexArray[i] = i;
  quick_sort_indice_inverse(objProbs, 0, validCount - 1, indexArray);

  std::set<int> class_set(classId.begin(), classId.end());
  for (int c : class_set) nms(validCount, filterBoxes, classId, indexArray, c, nms_threshold);

  for (int i = 0; i < validCount; i++) {
    int idx = indexArray[i];
    if (idx == -1) continue;
    object_detect_result det;
    det.cls_id = classId[idx];
    det.prop = objProbs[i];
    det.box.left = (int)filterBoxes[idx * 4 + 0];
    det.box.top = (int)filterBoxes[idx * 4 + 1];
    det.box.right = (int)(filterBoxes[idx * 4 + 0] + filterBoxes[idx * 4 + 2]);
    det.box.bottom = (int)(filterBoxes[idx * 4 + 1] + filterBoxes[idx * 4 + 3]);
    od_results->results.push_back(det);
  }

  od_results->count = (int)od_results->results.size();
  return 0;
}

static int postprocess_affine(const void *outputs[], const bool is_u8[],
                              const int32_t zps[], const float scales[],
                              float conf_threshold, float nms_threshold,
                              object_detect_result_list *od_results,
                              int model_in_w = 640, int model_in_h = 640,
                              int num_classes = 80) {
  const int prop_box_size = 5 + num_classes;
  std::vector<float> filterBoxes;
  std::vector<float> objProbs;
  std::vector<int> classId;
  int validCount = 0;
  od_results->results.clear();

  for (int i = 0; i < 3; i++) {
    int stride = YOLOV5_STRIDES[i];
    int grid_h = model_in_h / stride;
    int grid_w = model_in_w / stride;
    if (is_u8[i]) {
      validCount += process_affine((const uint8_t *)outputs[i], zps[i], scales[i],
                                   anchor[i], grid_h, grid_w, stride, filterBoxes,
                                   objProbs, classId, conf_threshold,
                                   prop_box_size, num_classes);
    } else {
      validCount += process_affine((const int8_t *)outputs[i], zps[i], scales[i],
                                   anchor[i], grid_h, grid_w, stride, filterBoxes,
                                   objProbs, classId, conf_threshold,
                                   prop_box_size, num_classes);
    }
  }

  if (validCount <= 0) {
    od_results->count = 0;
    return 0;
  }

  std::vector<int> indexArray(validCount);
  for (int i = 0; i < validCount; ++i) indexArray[i] = i;
  quick_sort_indice_inverse(objProbs, 0, validCount - 1, indexArray);

  std::set<int> class_set(classId.begin(), classId.end());
  for (int c : class_set) nms(validCount, filterBoxes, classId, indexArray, c, nms_threshold);

  for (int i = 0; i < validCount; i++) {
    int idx = indexArray[i];
    if (idx == -1) continue;
    object_detect_result det;
    det.cls_id = classId[idx];
    det.prop = objProbs[i];
    det.box.left = (int)filterBoxes[idx * 4 + 0];
    det.box.top = (int)filterBoxes[idx * 4 + 1];
    det.box.right = (int)(filterBoxes[idx * 4 + 0] + filterBoxes[idx * 4 + 2]);
    det.box.bottom = (int)(filterBoxes[idx * 4 + 1] + filterBoxes[idx * 4 + 3]);
    od_results->results.push_back(det);
  }

  od_results->count = (int)od_results->results.size();
  return 0;
}

} // namespace yolov5_adas_3out_postprocess
} // namespace nn
} // namespace ztu

