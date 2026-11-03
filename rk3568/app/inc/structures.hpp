#pragma once

#include <cstdint>
#include <sstream>
#include <string>
#include <vector>

namespace ztu {
namespace nn {

// 图像区域矩形结构体
struct image_rect_t {
  int left;   // 左边界
  int top;    // 上边界
  int right;  // 右边界
  int bottom; // 下边界

  std::string to_string() const {
    std::ostringstream oss;
    oss << "image_rect_t{left: " << left << ", top: " << top
        << ", right: " << right << ", bottom: " << bottom << "}";
    return oss.str();
  }
};

// 检测结果结构体
// 检测结果结构体
struct object_detect_result {
  image_rect_t box;        // 检测框 (bounding box)
  float prop;              // 置信度 (confidence score)
  int cls_id;              // 类别ID (class ID)
  std::string custom_text; // 自定义文本，例如跟踪ID

  std::string to_string() const {
    std::ostringstream oss;
    oss << "object_detect_result{box: " << box.to_string() << ", prop: " << prop
        << ", cls_id: " << cls_id << ", custom_text: \"" << custom_text
        << "\", landmarks: [";
    for (int i = 0; i < 8; ++i) {
        oss << landmarks[i];
        if (i < 7) oss << ", ";
    }
    oss << "]}";
    return oss.str();
  }

  // ★ 刚才漏掉的在这里：定义这 8 个浮点数
  float landmarks[8]; 
};

// 检测结果列表结构体
struct object_detect_result_list {
  int id;                                    // 列表ID
  int count;                                 // 检测结果数量
  std::vector<object_detect_result> results; // 检测结果列表

  std::string to_string() const {
    std::ostringstream oss;
    oss << "object_detect_result_list{id: " << id << ", count: " << count
        << ", results: [";
    for (size_t i = 0; i < results.size(); ++i) {
      oss << results[i].to_string();
      if (i < results.size() - 1)
        oss << ", ";
    }
    oss << "]}";
    return oss.str();
  }
};

// 图像旋转矩形结构体
struct image_obb_box_t {
  int x;       // 中心X座标 (center x)
  int y;       // 中心Y座标 (center y)
  int w;       // 宽度 (width)
  int h;       // 高度 (height)
  float angle; // 旋转角度（弧度）(angle in radians)

  std::string to_string() const {
    std::ostringstream oss;
    oss << "image_obb_box_t{x: " << x << ", y: " << y << ", w: " << w
        << ", h: " << h << ", angle: " << angle << "}";
    return oss.str();
  }
};

// Letterbox参数结构体
struct letterbox_t {
  int x_pad;   // 在X方向的填充量 (padding in X direction)
  int y_pad;   // 在Y方向的填充量 (padding in Y direction)
  float scale; // 缩放比例 (scaling factor)

  std::string to_string() const {
    std::ostringstream oss;
    oss << "letterbox_t{x_pad: " << x_pad << ", y_pad: " << y_pad
        << ", scale: " << scale << "}";
    return oss.str();
  }
};

// 单一目标旋转矩形检测结果结构体
struct object_obb_detect_result {
  image_obb_box_t box;     // 检测框 (bounding box)
  float prop;              // 置信度 (confidence score)
  int cls_id;              // 类别ID (class ID)
  std::string custom_text; // 自定义文本，例如跟踪ID

  std::string to_string() const {
    std::ostringstream oss;
    oss << "object_obb_detect_result{box: " << box.to_string()
        << ", prop: " << prop << ", cls_id: " << cls_id << ", custom_text: \""
        << custom_text << "\"}";
    return oss.str();
  }
};

// 旋转矩形检测结果列表结构体
struct object_obb_detect_result_list {
  int id;    // 列表ID (identifier for the list)
  int count; // 检测结果数量 (number of valid results)
  std::vector<object_obb_detect_result> results; // 检测结果列表

  std::string to_string() const {
    std::ostringstream oss;
    oss << "object_obb_detect_result_list{id: " << id << ", count: " << count
        << ", results: [";
    for (size_t i = 0; i < results.size(); ++i) {
      oss << results[i].to_string();
      if (i < results.size() - 1)
        oss << ", ";
    }
    oss << "]}";
    return oss.str();
  }
};

typedef struct {
  int id;
  int count;
  std::vector<object_detect_result> results;
  std::vector<uint8_t> seg_mask;
} object_detect_segment1mask_result_list;

} // namespace nn
} // namespace ztu