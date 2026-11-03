#pragma once

#include "opencv2/core/types.hpp"
#include <cstddef>
#include <opencv2/opencv.hpp>

#include "structures.hpp"

namespace ztu {
namespace cv {

namespace detail { // Internal helper namespace

// Helper function to generate distinct colors using batch conversion from HSV
// to BGR
static std::vector<::cv::Scalar> generate_colors(int num_colors) {
  std::vector<::cv::Scalar> colors;
  if (num_colors <= 0)
    return colors;
  // 在 HSV 空间中创建一个 1×N 的矩阵
  ::cv::Mat hsv(1, num_colors, CV_8UC3);
  for (int i = 0; i < num_colors; i++) {
    int hue = static_cast<int>(i * 180.0 / num_colors) % 180;
    hsv.at<::cv::Vec3b>(0, i) = ::cv::Vec3b(hue, 200, 200);
  }
  // 将整个 HSV 矩阵转换为 BGR 矩阵
  ::cv::Mat bgr;
  ::cv::cvtColor(hsv, bgr, ::cv::COLOR_HSV2BGR);
  for (int i = 0; i < num_colors; i++) {
    ::cv::Vec3b bgr_pixel = bgr.at<::cv::Vec3b>(0, i);
    colors.push_back(::cv::Scalar(bgr_pixel[0], bgr_pixel[1], bgr_pixel[2]));
  }
  return colors;
}

struct DrawingHelper {
  std::vector<::cv::Scalar> palette_;
  bool color_by_text_flag_;
  const std::vector<std::string> &class_labels_ref_;

  DrawingHelper(const std::vector<::cv::Scalar> &user_colors,
                const std::vector<std::string> &class_labels,
                bool color_by_custom_text)
      : color_by_text_flag_(color_by_custom_text),
        class_labels_ref_(class_labels) {

    palette_ = user_colors; // Copy user-provided colors

    if (palette_.empty()) {
      int num_colors_to_generate = 0;
      if (color_by_text_flag_) {
        num_colors_to_generate = 20; // Default for hashing custom text
        if (!class_labels_ref_.empty()) {
          num_colors_to_generate =
              std::max(num_colors_to_generate,
                       static_cast<int>(class_labels_ref_.size()));
        }
      } else {
        // Not coloring by text, so class_labels are primary if available.
        if (!class_labels_ref_.empty()) {
          num_colors_to_generate = class_labels_ref_.size();
        }
        // If class_labels_ref_ is empty and not coloring by text,
        // num_colors_to_generate will remain 0.
      }

      if (num_colors_to_generate > 0) {
        palette_ = generate_colors(num_colors_to_generate);
      }
    }

    // If palette is still empty (e.g., no user colors, 0 colors requested,
    // or generate_colors failed), ensure there's at least one default color.
    if (palette_.empty()) {
      palette_.push_back(::cv::Scalar(128, 128, 128)); // Default gray
    }
  }

  ::cv::Scalar get_color_for_detection(int cls_id,
                                       const std::string &custom_text) const {
    if (palette_.empty()) { // Should always have at least the default gray
      return ::cv::Scalar(128, 128, 128);
    }

    if (color_by_text_flag_ && !custom_text.empty()) {
      std::hash<std::string> str_hasher;
      size_t text_hash = str_hasher(custom_text);
      return palette_[text_hash % palette_.size()];
    } else {
      // Use class_id for color.
      // If class_labels_ref_ is empty, we use cls_id modulo palette size.
      // This means cls_id doesn't need to correspond to an index in
      // class_labels_ref_ if class_labels_ref_ is empty.
      if (class_labels_ref_.empty()) {
        // No class labels to validate against, but can still use cls_id for
        // color indexing if cls_id is e.g. a track ID.
        return palette_[static_cast<unsigned int>(cls_id) % palette_.size()];
      } else {
        // class_labels_ref_ is not empty, cls_id must be a valid index.
        if (cls_id < 0 ||
            cls_id >= static_cast<int>(class_labels_ref_.size())) {
          throw std::runtime_error("Invalid class ID " +
                                   std::to_string(cls_id) +
                                   " for class_labels of size " +
                                   std::to_string(class_labels_ref_.size()));
        }
        return palette_[cls_id % palette_.size()];
      }
    }
  }

  std::string format_label_text(int cls_id, float confidence,
                                const std::string &custom_text_val) const {
    std::string primary_label_text;
    if (!class_labels_ref_.empty()) {
      if (cls_id >= 0 && cls_id < static_cast<int>(class_labels_ref_.size())) {
        primary_label_text = class_labels_ref_[cls_id];
      } else {
        // If class_labels_ref_ is not empty, but cls_id is invalid for it.
        // This is an error if we are not primarily identifying by custom_text.
        if (!color_by_text_flag_ || custom_text_val.empty()) {
          throw std::runtime_error(
              "Invalid class ID " + std::to_string(cls_id) +
              " for label formatting with non-empty class_labels of size " +
              std::to_string(class_labels_ref_.size()));
        }
        // If coloring by text, or custom_text_val is primary, an invalid cls_id
        // for labels might be okay.
      }
    }

    std::ostringstream conf_ss;
    // Show confidence if it's meaningfully positive, or if there's no class
    // label (it becomes the primary info).
    if (confidence > 1e-5 || primary_label_text.empty()) {
      conf_ss << std::fixed << std::setprecision(2) << confidence;
    }

    std::string text = primary_label_text;
    std::string conf_str = conf_ss.str();

    if (!text.empty() && !conf_str.empty()) {
      text += " ";
    }
    text += conf_str;

    if (!custom_text_val.empty()) {
      if (!text.empty()) {
        text += " ";
      }
      text += custom_text_val;
    }
    return text;
  }
};

} // namespace detail

// 图片缩放模式
enum class ResizeMode {
  STRETCH,        // 拉伸缩放,可能变形
  KEEP_RATIO_PAD, // 按比例缩放,保持全图
  KEEP_RATIO_CROP // 按比例裁切缩放,可能裁剪
};

struct ResizeImpl {
  size_t originalWidth;
  size_t originalHeight;
  size_t targetWidth;
  size_t targetHeight;
  size_t scaleTargetWidth;
  size_t scaleTargetHeight;
  bool doCrop;
  size_t cropLeft;
  size_t cropTop;
  size_t cropRight;
  size_t cropBottom;
  bool doPad;     // 是否需要padding
  size_t padLeft; // 左侧padding大小
  size_t padTop;  // 顶部padding大小
};

// 计算缩放参数
static ResizeImpl
calculateResize(size_t srcWidth, size_t srcHeight, size_t dstWidth,
                size_t dstHeight,
                ResizeMode mode = ResizeMode::KEEP_RATIO_PAD) {
  ResizeImpl impl;
  impl.originalWidth = srcWidth;
  impl.originalHeight = srcHeight;
  impl.targetWidth = dstWidth;
  impl.targetHeight = dstHeight;
  impl.doCrop = false;
  impl.doPad = false;

  double scale_w = static_cast<double>(dstWidth) / srcWidth;
  double scale_h = static_cast<double>(dstHeight) / srcHeight;

  switch (mode) {
  case ResizeMode::STRETCH: {
    impl.scaleTargetWidth = dstWidth;
    impl.scaleTargetHeight = dstHeight;
    break;
  }
  case ResizeMode::KEEP_RATIO_PAD: {
    double scale = std::min(scale_w, scale_h);
    impl.scaleTargetWidth = static_cast<size_t>(srcWidth * scale);
    impl.scaleTargetHeight = static_cast<size_t>(srcHeight * scale);
    impl.doPad = true;
    impl.padLeft = (dstWidth - impl.scaleTargetWidth) / 2;
    impl.padTop = (dstHeight - impl.scaleTargetHeight) / 2;
    break;
  }
  case ResizeMode::KEEP_RATIO_CROP: {
    double scale = std::max(scale_w, scale_h);
    impl.scaleTargetWidth = static_cast<size_t>(srcWidth * scale);
    impl.scaleTargetHeight = static_cast<size_t>(srcHeight * scale);
    impl.doCrop = true;
    impl.cropLeft = (impl.scaleTargetWidth - dstWidth) / 2;
    impl.cropTop = (impl.scaleTargetHeight - dstHeight) / 2;
    impl.cropRight = impl.cropLeft + dstWidth;
    impl.cropBottom = impl.cropTop + dstHeight;
    break;
  }
  }

  return impl;
}

// 执行缩放操作
static ::cv::Mat resize(const ::cv::Mat &src, const ResizeImpl &impl,
                        const ::cv::Scalar &padColor = ::cv::Scalar(0, 0, 0)) {
  if (src.empty()) {
    return ::cv::Mat();
  }

  ::cv::Mat dst;

  // 先进行缩放
  ::cv::resize(src, dst,
               ::cv::Size(impl.scaleTargetWidth, impl.scaleTargetHeight));

  // 如果需要裁切
  if (impl.doCrop) {
    ::cv::Rect roi(impl.cropLeft, impl.cropTop, impl.targetWidth,
                   impl.targetHeight);
    dst = dst(roi);
  }

  // 如果需要padding
  if (impl.doPad) {
    ::cv::Mat padded(impl.targetHeight, impl.targetWidth, src.type(), padColor);
    ::cv::Rect roi(impl.padLeft, impl.padTop, impl.scaleTargetWidth,
                   impl.scaleTargetHeight);
    dst.copyTo(padded(roi));
    dst = padded;
  }

  return dst;
}

// 便捷方法,直接使用宽高调用
static ::cv::Mat resize(const ::cv::Mat &src, int width, int height,
                        ResizeMode mode = ResizeMode::KEEP_RATIO_PAD,
                        const ::cv::Scalar &padColor = ::cv::Scalar(0, 0, 0)) {
  if (src.empty() || width <= 0 || height <= 0) {
    return ::cv::Mat();
  }

  auto impl = calculateResize(src.cols, src.rows, width, height, mode);
  return resize(src, impl, padColor);
}

// 将原图上的点转换为缩放后图片上的对应点
// @param x 原图上的x坐标
// @param y 原图上的y坐标
// @param impl 缩放参数
// @return 转换后的点坐标,如果点在缩放后图片范围外则返回(-1,-1)
static std::pair<int, int> mapPoint(int x, int y, const ResizeImpl &impl) {
  // 将输入点钳制到原图范围内
  x = std::clamp(x, 0, static_cast<int>(impl.originalWidth - 1));
  y = std::clamp(y, 0, static_cast<int>(impl.originalHeight - 1));

  // 计算缩放比例
  double scale_x =
      static_cast<double>(impl.scaleTargetWidth) / impl.originalWidth;
  double scale_y =
      static_cast<double>(impl.scaleTargetHeight) / impl.originalHeight;

  // 将点按比例缩放
  int scaled_x = static_cast<int>(x * scale_x);
  int scaled_y = static_cast<int>(y * scale_y);

  // 如果是裁切模式,需要减去裁切的偏移
  if (impl.doCrop) {
    scaled_x -= impl.cropLeft;
    scaled_y -= impl.cropTop;

    // 钳制到裁切后的范围内
    scaled_x = std::clamp(scaled_x, 0, static_cast<int>(impl.targetWidth - 1));
    scaled_y = std::clamp(scaled_y, 0, static_cast<int>(impl.targetHeight - 1));
  }

  // 如果是padding模式,需要加上padding的偏移
  if (impl.doPad) {
    scaled_x += impl.padLeft;
    scaled_y += impl.padTop;

    // 钳制到padding后的范围内
    scaled_x =
        std::clamp(scaled_x, static_cast<int>(impl.padLeft),
                   static_cast<int>(impl.padLeft + impl.scaleTargetWidth - 1));
    scaled_y =
        std::clamp(scaled_y, static_cast<int>(impl.padTop),
                   static_cast<int>(impl.padTop + impl.scaleTargetHeight - 1));
  }

  return std::make_pair(scaled_x, scaled_y);
}

// 便捷方法,直接使用Point2i作为输入
static ::cv::Point2i mapPoint(const ::cv::Point2i &pt, const ResizeImpl &impl) {
  auto result = mapPoint(pt.x, pt.y, impl);
  return ::cv::Point2i(result.first, result.second);
}

// 将缩放后图片上的点转换为原图上的对应点
// @param x 缩放后图片上的x坐标
// @param y 缩放后图片上的y坐标
// @param impl 缩放参数
// @return 转换后的点坐标,如果点在原图范围外则返回(-1,-1)
static std::pair<int, int> reverseMapPoint(int x, int y,
                                           const ResizeImpl &impl) {
  // 将输入点钳制到目标图片范围内
  x = std::clamp(x, 0, static_cast<int>(impl.targetWidth - 1));
  y = std::clamp(y, 0, static_cast<int>(impl.targetHeight - 1));

  int mapped_x = x;
  int mapped_y = y;

  // 如果是padding模式,需要减去padding的偏移
  if (impl.doPad) {
    mapped_x -= impl.padLeft;
    mapped_y -= impl.padTop;

    // 钳制到padding内的有效区域
    mapped_x =
        std::clamp(mapped_x, 0, static_cast<int>(impl.scaleTargetWidth - 1));
    mapped_y =
        std::clamp(mapped_y, 0, static_cast<int>(impl.scaleTargetHeight - 1));
  }

  // 如果是裁切模式,需要加上裁切的偏移
  if (impl.doCrop) {
    mapped_x += impl.cropLeft;
    mapped_y += impl.cropTop;
  }

  // 计算反向缩放比例
  double scale_x =
      static_cast<double>(impl.originalWidth) / impl.scaleTargetWidth;
  double scale_y =
      static_cast<double>(impl.originalHeight) / impl.scaleTargetHeight;

  // 将点按比例反向缩放
  int original_x = static_cast<int>(mapped_x * scale_x);
  int original_y = static_cast<int>(mapped_y * scale_y);

  // 确保结果在原图范围内
  original_x =
      std::clamp(original_x, 0, static_cast<int>(impl.originalWidth - 1));
  original_y =
      std::clamp(original_y, 0, static_cast<int>(impl.originalHeight - 1));

  return std::make_pair(original_x, original_y);
}

// 便捷方法,直接使用Point2i作为输入
static ::cv::Point2i reverseMapPoint(const ::cv::Point2i &pt,
                                     const ResizeImpl &impl) {
  auto result = reverseMapPoint(pt.x, pt.y, impl);
  return ::cv::Point2i(result.first, result.second);
}

/**
 * @brief 将缩放后图片坐标系下的 OBB 转换回原图坐标系
 *
 * @param obb_resized OBB 定义 (中心点x, y, 宽w, 高h,
 * 角度angle)，坐标相对于缩放/填充/裁剪后的目标图像。
 * @param impl 对应的 ResizeImpl 缩放参数。
 * @return image_obb_box_t OBB 在原图坐标系下的定义。
 */
static ztu::nn::image_obb_box_t
reverseMapObb(const ztu::nn::image_obb_box_t &obb_resized,
              const ResizeImpl &impl) {

  ztu::nn::image_obb_box_t obb_original;

  // 1. Reverse Map the Center Point
  // Use double precision for intermediate calculation
  std::pair<double, double> original_center =
      reverseMapPoint(static_cast<double>(obb_resized.x),
                      static_cast<double>(obb_resized.y), impl);

  // Handle potential error from reverseMapPoint (e.g., division by zero)
  if (original_center.first < 0 && original_center.second < 0) {
    // Return a default/invalid OBB
    obb_original.x = -1;
    obb_original.y = -1;
    obb_original.w = 0;
    obb_original.h = 0;
    obb_original.angle = 0.0f;
    return obb_original;
  }

  obb_original.x = static_cast<int>(std::round(original_center.first));
  obb_original.y = static_cast<int>(std::round(original_center.second));

  // 2. Calculate Inverse Scaling Factors for Width and Height
  if (impl.scaleTargetWidth == 0 || impl.scaleTargetHeight == 0) {
    // Should have been caught by reverseMapPoint, but double check
    obb_original.w = 0;
    obb_original.h = 0;
    obb_original.angle = 0.0f; // Or keep original angle? Depends.
    return obb_original;
  }
  double inv_scale_x =
      static_cast<double>(impl.originalWidth) / impl.scaleTargetWidth;
  double inv_scale_y =
      static_cast<double>(impl.originalHeight) / impl.scaleTargetHeight;

  // 3. Reverse Scale Width and Height
  double original_w_double = static_cast<double>(obb_resized.w) * inv_scale_x;
  double original_h_double = static_cast<double>(obb_resized.h) * inv_scale_y;
  obb_original.w = static_cast<int>(std::round(original_w_double));
  obb_original.h = static_cast<int>(std::round(original_h_double));
  // Ensure w/h are non-negative
  if (obb_original.w < 0)
    obb_original.w = 0;
  if (obb_original.h < 0)
    obb_original.h = 0;

  // 4. Adjust Angle (only needed for non-uniform scaling like STRETCH)
  // Check if scaling factors are significantly different
  constexpr double scale_diff_threshold = 1e-5;
  if (std::abs(inv_scale_x - inv_scale_y) > scale_diff_threshold) {
    // Angle transformation under non-uniform scaling:
    // Consider a vector (cos(a), sin(a)) in the stretched space.
    // In the original space, it becomes (cos(a)*inv_scale_x,
    // sin(a)*inv_scale_y). The new angle is atan2 of the transformed vector
    // components.
    float original_angle_rad = obb_resized.angle;
    double transformed_x = std::cos(original_angle_rad) * inv_scale_x;
    double transformed_y = std::sin(original_angle_rad) * inv_scale_y;
    obb_original.angle =
        static_cast<float>(std::atan2(transformed_y, transformed_x));
  } else {
    // Scaling is effectively uniform, angle remains the same
    obb_original.angle = obb_resized.angle;
  }

  // Optional: Clamp the final center point to original image bounds
  // obb_original.x = std::clamp(obb_original.x, 0,
  // static_cast<int>(impl.originalWidth - 1)); obb_original.y =
  // std::clamp(obb_original.y, 0, static_cast<int>(impl.originalHeight - 1));
  // Width and height are already positive. Whether the box *fits* requires more
  // checks if needed.

  return obb_original;
}

// --- Function to draw standard bounding boxes ---
static void draw_detections(
    ::cv::Mat &image, const ztu::nn::object_detect_result_list &detections,
    const std::vector<std::string> &class_labels,
    std::vector<::cv::Scalar> colors = {}, bool color_by_custom_text = false) {

  if (detections.results.empty()) {
    return; // Nothing to draw
  }

  detail::DrawingHelper helper(colors, class_labels, color_by_custom_text);

  int line_thickness = 2;
  double font_scale = 0.5;
  int font_face = ::cv::FONT_HERSHEY_SIMPLEX;
  int text_thickness = 1;

  for (const auto &det : detections.results) {
    ::cv::Scalar current_box_color =
        helper.get_color_for_detection(det.cls_id, det.custom_text);

    std::string text =
        helper.format_label_text(det.cls_id, det.prop, det.custom_text);

    const auto &box = det.box;
    // Clamp box coordinates to image dimensions
    int left = std::max(0, box.left);
    int top = std::max(0, box.top);
    int right = std::min(image.cols - 1, box.right);
    int bottom = std::min(image.rows - 1, box.bottom);

    if (left >= right || top >= bottom) {
      continue;
    }

    ::cv::Point pt1(left, top);
    ::cv::Point pt2(right, bottom);
    ::cv::rectangle(image, pt1, pt2, current_box_color, line_thickness);

    if (text.empty())
      continue; // No label to draw

    int baseline = 0;
    ::cv::Size text_size = ::cv::getTextSize(text, font_face, font_scale,
                                             text_thickness, &baseline);
    baseline += text_thickness;

    int text_bg_x = left;
    int text_bg_y = top - text_size.height - baseline - 2;
    int text_bg_width = text_size.width + 4;
    int text_bg_height = text_size.height + baseline + 4;

    if (text_bg_y < 0) {
      text_bg_y = top + line_thickness + 2;
    }
    if (text_bg_x + text_bg_width > image.cols) {
      text_bg_x = image.cols - text_bg_width;
    }
    if (text_bg_x < 0) {
      text_bg_x = 0;
    }

    ::cv::Rect text_bg_rect(text_bg_x, text_bg_y, text_bg_width,
                            text_bg_height);
    text_bg_rect &= ::cv::Rect(0, 0, image.cols, image.rows);
    if (text_bg_rect.area() > 0) {
      ::cv::rectangle(image, text_bg_rect, current_box_color, ::cv::FILLED);
    }

    ::cv::Point text_org(text_bg_x + 2, text_bg_y + text_size.height + 2);

    if (text_org.x < 0)
      text_org.x = 0;
    if (text_org.y < 0)
      text_org.y = text_size.height;
    if (text_org.x >= image.cols)
      text_org.x = image.cols - 1;
    if (text_org.y >= image.rows)
      text_org.y = image.rows - 1;

    if (text_bg_rect.contains(
            text_org)) { // Only draw if text origin is within its background
      ::cv::putText(image, text, text_org, font_face, font_scale,
                    ::cv::Scalar(255, 255, 255), text_thickness, ::cv::LINE_AA);
    }
  }
}

// --- Function to draw oriented bounding boxes (OBB) ---
static void draw_detections(
    ::cv::Mat &image, const ztu::nn::object_obb_detect_result_list &detections,
    const std::vector<std::string> &class_labels,
    std::vector<::cv::Scalar> colors = {}, bool color_by_custom_text = false) {

  if (detections.results.empty()) {
    return; // Nothing to draw
  }

  detail::DrawingHelper helper(colors, class_labels, color_by_custom_text);

  int line_thickness = 2;
  double font_scale = 0.5;
  int font_face = ::cv::FONT_HERSHEY_SIMPLEX;
  int text_thickness = 1;

  for (const auto &det : detections.results) {
    ::cv::Scalar current_box_color =
        helper.get_color_for_detection(det.cls_id, det.custom_text);

    std::string text =
        helper.format_label_text(det.cls_id, det.prop, det.custom_text);

    const auto &box = det.box;
    ::cv::Point2f center(static_cast<float>(box.x), static_cast<float>(box.y));
    ::cv::Size2f size(static_cast<float>(box.w), static_cast<float>(box.h));
    float angle_degrees = box.angle * 180.0f / static_cast<float>(CV_PI);
    ::cv::RotatedRect rotated_rect(center, size, angle_degrees);

    ::cv::Point2f vertices[4];
    rotated_rect.points(vertices);

    for (int i = 0; i < 4; ++i) {
      ::cv::Point pt1 = vertices[i];
      ::cv::Point pt2 = vertices[(i + 1) % 4];
      ::cv::clipLine(image.size(), pt1, pt2);
      if (::cv::norm(pt1 - pt2) > 1) {
        ::cv::line(image, pt1, pt2, current_box_color, line_thickness,
                   ::cv::LINE_AA);
      }
    }

    if (text.empty())
      continue; // No label to draw

    ::cv::Rect bounding_rect = rotated_rect.boundingRect();
    int label_ref_x = std::max(0, bounding_rect.x);
    int label_ref_y = std::max(0, bounding_rect.y);

    int baseline = 0;
    ::cv::Size text_size = ::cv::getTextSize(text, font_face, font_scale,
                                             text_thickness, &baseline);
    baseline += text_thickness;

    int text_bg_x = label_ref_x;
    int text_bg_y = label_ref_y - text_size.height - baseline - 2;
    int text_bg_width = text_size.width + 4;
    int text_bg_height = text_size.height + baseline + 4;

    if (text_bg_y < 0) {
      text_bg_y = label_ref_y + line_thickness + 2;
    }
    if (text_bg_x + text_bg_width > image.cols) {
      text_bg_x = image.cols - text_bg_width;
    }
    if (text_bg_x < 0) {
      text_bg_x = 0;
    }

    ::cv::Rect text_bg_rect(text_bg_x, text_bg_y, text_bg_width,
                            text_bg_height);
    text_bg_rect &= ::cv::Rect(0, 0, image.cols, image.rows);
    if (text_bg_rect.area() > 0) {
      ::cv::rectangle(image, text_bg_rect, current_box_color, ::cv::FILLED);
    }

    ::cv::Point text_org(text_bg_x + 2, text_bg_y + text_size.height + 2);

    if (text_org.x < 0)
      text_org.x = 0;
    if (text_org.y < 0)
      text_org.y = text_size.height;
    if (text_org.x >= image.cols)
      text_org.x = image.cols - 1;
    if (text_org.y >= image.rows)
      text_org.y = image.rows - 1;

    if (text_bg_rect.contains(
            text_org)) { // Only draw if text origin is within its background
      ::cv::putText(image, text, text_org, font_face, font_scale,
                    ::cv::Scalar(255, 255, 255), text_thickness, ::cv::LINE_AA);
    }
  }
}

} // namespace cv
} // namespace ztu
