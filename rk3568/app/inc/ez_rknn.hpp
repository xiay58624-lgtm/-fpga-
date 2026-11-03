#pragma once

#include "rknn_api.h"
#include "rknn_dtype.hpp"
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <string>
#include <vector>

#if __cplusplus < 201703L
#error                                                                         \
    "C++17 or a later version is required to compile this class. Please use a C++17 compatible compiler and enable C++17 features (e.g., -std=c++17)."
// 中文错误信息：
// #error "这个类要求使用 C++17 或更高版本的标准进行编译。请使用兼容 C++17
// 的编译器，并启用 C++17 特性（例如 -std=c++17）。"
#endif

namespace ztu {
namespace rk {
class EzRknn {
public:
  enum class Layout {
    // 对四维输入数据：rknn布局设置为RKNN_TENSOR_NCHW,
    // 将rknn查询得到的输入shape做hwc -> chw交换
    // 适用于你打算使用ONNX模型原来的输入shape的情况，默认值，推荐使用。
    NCHW,
    ORIGINAL = NCHW,
    // 对四维输入数据：rknn布局设置为RKNN_TENSOR_NHWC,
    // 查询得到的输入shape不做任何处理
    // 适用于ONNX模型输入是NCHW，而你正好有NHWC数据，想让NPU帮你处理转置的情况。注意，此时你查询的模型输入shape也是NHWC的！
    NHWC,
    CHW2HWC = NHWC,
    // 对四维输入数据：rknn布局设置为RKNN_TENSOR_NHWC, 输入前进行chw -> hwc交换,
    // 将rknn查询得到的输入shape做hwc -> chw交换
    // 适用于选择NCHW时报错 Meet unsupported src layout for normalize: NCHW,
    // only support NHWC src layout! 的情况。
    NCHW_SOFTWARE,
    ORIGINAL_SOFTWARE = NCHW_SOFTWARE,
  };
  explicit EzRknn(const std::filesystem::path &model_path,
                  Layout layout = Layout::ORIGINAL,
                  rknn_core_mask core_mask = RKNN_NPU_CORE_UNDEFINED)
      : model_path_(model_path), layout_(layout), core_mask(core_mask) {
    init();
  }

  // 复制构造函数
  EzRknn(EzRknn &other)
      : model_path_(other.model_path_), io_num_(other.io_num_),
        input_attrs(other.input_attrs), output_attrs(other.output_attrs),
        layout_(other.layout_), core_mask(other.core_mask) {
    int ret = rknn_dup_context(&other.ctx, &ctx);
    if (ret < 0) {
      throw std::runtime_error("Failed to duplicate RKNN context");
    }
  }

  // 删除移动操作
  EzRknn(EzRknn &&) = delete;
  EzRknn &operator=(EzRknn &&) = delete;
  // 删除赋值操作
  EzRknn &operator=(const EzRknn &) = delete;

  ~EzRknn() {
    if (ctx != 0) {
      if (!last_outputs_.empty() && !outputs_prealloc_) {
        rknn_outputs_release(ctx, (uint32_t)last_outputs_.size(),
                             last_outputs_.data());
      }
      rknn_destroy(ctx);
      ctx = 0;
    }
  }

  bool wantFloat() const { return want_float_; }
  double lastRunDurationMs() const { return last_run_duration_ms_; }

  void setWantFloat(bool want_float) {
    std::lock_guard<std::mutex> lock(mutex_);
    want_float_ = want_float;
    configureOutputs();
  }

  // 推理函数,返回所有输出的float指针
  template <typename... Args> std::vector<float *> inference(Args *...inputs) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!want_float_) {
      throw std::runtime_error("want_float disabled, use inferenceRaw()");
    }

    // 检查输入参数数量是否匹配
    if (sizeof...(inputs) != io_num_.n_input) {
      throw std::runtime_error("Input count mismatch");
    }

    // 设置输入
    rknn_inputs_.clear();
    rknn_inputs_.reserve(io_num_.n_input);
    setInputs(rknn_inputs_, inputs...);

    // 执行推理
    int ret = rknn_inputs_set(ctx, io_num_.n_input, rknn_inputs_.data());
    if (ret < 0) {
      throw std::runtime_error("rknn_inputs_set failed");
    }

    ret = rknn_run(ctx, nullptr);
    if (ret < 0) {
      throw std::runtime_error("rknn_run failed");
    }
    updateLastRunDuration();

    if (outputs_prealloc_) {
      ret = rknn_outputs_get(ctx, io_num_.n_output, rknn_outputs_.data(),
                             nullptr);
      if (ret < 0) {
        outputs_prealloc_ = false;
        for (uint32_t i = 0; i < io_num_.n_output; i++) {
          rknn_outputs_[i].index = i;
          rknn_outputs_[i].want_float = true;
          rknn_outputs_[i].is_prealloc = false;
          rknn_outputs_[i].buf = nullptr;
          rknn_outputs_[i].size = 0;
        }
      }
    }

    if (!outputs_prealloc_) {
      ret = rknn_outputs_get(ctx, io_num_.n_output, rknn_outputs_.data(),
                             nullptr);
      if (ret < 0) {
        throw std::runtime_error("rknn_outputs_get failed");
      }
    }

    // 提取float指针
    std::vector<float *> results;
    results.reserve(io_num_.n_output);
    for (const auto &output : rknn_outputs_) {
      results.push_back(static_cast<float *>(output.buf));
    }

    if (!outputs_prealloc_) {
      if (!last_outputs_.empty()) {
        rknn_outputs_release(ctx, (uint32_t)last_outputs_.size(),
                             last_outputs_.data());
      }
      last_outputs_ = rknn_outputs_;
    }

    return results;
  }

  template <typename... Args> std::vector<void *> inferenceRaw(Args *...inputs) {
    std::lock_guard<std::mutex> lock(mutex_);

    if (sizeof...(inputs) != io_num_.n_input) {
      throw std::runtime_error("Input count mismatch");
    }

    rknn_inputs_.clear();
    rknn_inputs_.reserve(io_num_.n_input);
    setInputs(rknn_inputs_, inputs...);

    int ret = rknn_inputs_set(ctx, io_num_.n_input, rknn_inputs_.data());
    if (ret < 0) {
      throw std::runtime_error("rknn_inputs_set failed");
    }

    ret = rknn_run(ctx, nullptr);
    if (ret < 0) {
      throw std::runtime_error("rknn_run failed");
    }
    updateLastRunDuration();

    if (outputs_prealloc_) {
      ret = rknn_outputs_get(ctx, io_num_.n_output, rknn_outputs_.data(),
                             nullptr);
      if (ret < 0) {
        outputs_prealloc_ = false;
        for (uint32_t i = 0; i < io_num_.n_output; i++) {
          rknn_outputs_[i].index = i;
          rknn_outputs_[i].want_float = want_float_;
          rknn_outputs_[i].is_prealloc = false;
          rknn_outputs_[i].buf = nullptr;
          rknn_outputs_[i].size = 0;
        }
      }
    }

    if (!outputs_prealloc_) {
      ret = rknn_outputs_get(ctx, io_num_.n_output, rknn_outputs_.data(),
                             nullptr);
      if (ret < 0) {
        throw std::runtime_error("rknn_outputs_get failed");
      }
    }

    std::vector<void *> results;
    results.reserve(io_num_.n_output);
    for (const auto &output : rknn_outputs_) {
      results.push_back(output.buf);
    }

    if (!outputs_prealloc_) {
      if (!last_outputs_.empty()) {
        rknn_outputs_release(ctx, (uint32_t)last_outputs_.size(),
                             last_outputs_.data());
      }
      last_outputs_ = rknn_outputs_;
    }

    return results;
  }

#ifndef __ANDROID__
  std::string summary(int perf_runs = 0, bool color = true) const {
    char *no_color = getenv("NO_COLOR");
    if (no_color != NULL && no_color[0] != '\0')
      color = false;
    // ANSI颜色代码
    const std::string COLOR_RESET = color ? "\033[0m" : "";
    const std::string COLOR_RED = color ? "\033[31m" : "";
    const std::string COLOR_GREEN = color ? "\033[32m" : "";
    const std::string COLOR_YELLOW = color ? "\033[33m" : "";
    const std::string COLOR_BLUE = color ? "\033[34m" : "";
    const std::string COLOR_MAGENTA = color ? "\033[35m" : "";
    const std::string COLOR_CYAN = color ? "\033[36m" : "";
    const std::string COLOR_BOLD = color ? "\033[1m" : "";

    // 辅助函数,用于打印tensor属性
    auto print_rknn_tensor_attr = [&](std::stringstream &ss,
                                      const rknn_tensor_attr &attr,
                                      const std::string &prefix = "  ") {
      ss << prefix << COLOR_BOLD << "[" << attr.index << "]" << COLOR_RESET
         << ":" << COLOR_GREEN << attr.name << COLOR_RESET
         << " dims=" << COLOR_CYAN << "[";
      for (uint32_t i = 0; i < attr.n_dims; i++) {
        ss << attr.dims[i];
        if (i < attr.n_dims - 1)
          ss << ",";
      }
      ss << "]" << COLOR_RESET << "(n_elems=" << COLOR_YELLOW << attr.n_elems
         << COLOR_RESET << ") "
         << "type=" << COLOR_MAGENTA << get_type_string(attr.type)
         << COLOR_RESET << " "
         << "size=" << COLOR_YELLOW << attr.size << COLOR_RESET << " "
         << "fmt=" << COLOR_BLUE << get_format_string(attr.fmt) << COLOR_RESET
         << " "
         << "qnt=" << COLOR_RED << get_qnt_type_string(attr.qnt_type);
      if (attr.qnt_type == RKNN_TENSOR_QNT_DFP) {
        ss << "(fl=" << (int)attr.fl << ")";
      } else if (attr.qnt_type == RKNN_TENSOR_QNT_AFFINE_ASYMMETRIC) {
        ss << "(zp=" << attr.zp << ",scale=" << attr.scale << ")";
      }
      ss << COLOR_RESET << " w_stride=" << COLOR_YELLOW << attr.w_stride
         << COLOR_RESET << " size_with_stride=" << COLOR_YELLOW
         << attr.size_with_stride << COLOR_RESET;
      ss << std::endl;
    };

    std::stringstream ss;
    ss << COLOR_BOLD << "EzRknn: " << COLOR_GREEN << model_path_.string()
       << COLOR_RESET << std::endl;

    // Query SDK version
    rknn_sdk_version version;
    if (rknn_query(ctx, RKNN_QUERY_SDK_VERSION, &version, sizeof(version)) >=
        0) {
      ss << "\n"
         << COLOR_BOLD << "SDK Version: " << COLOR_RESET << COLOR_GREEN
         << version.api_version << COLOR_RESET << std::endl;
      ss << COLOR_BOLD << "Driver Version: " << COLOR_RESET << COLOR_GREEN
         << version.drv_version << COLOR_RESET << std::endl;
    }

    // Query memory size
    rknn_mem_size mem_size;
    if (rknn_query(ctx, RKNN_QUERY_MEM_SIZE, &mem_size, sizeof(mem_size)) >=
        0) {
      ss << "\n" << COLOR_BOLD << "Memory Info:" << COLOR_RESET << std::endl;
      ss << "  Weight Memory Size: " << COLOR_YELLOW
         << mem_size.total_weight_size << " bytes"
         << " (" << mem_size.total_weight_size / 1024.0F / 1024.0F << " MiB)"
         << COLOR_RESET << std::endl;
      ss << "  Internal Memory Size: " << COLOR_YELLOW
         << mem_size.total_internal_size << " bytes"
         << " (" << mem_size.total_internal_size / 1024.0F / 1024.0F << " MiB)"
         << COLOR_RESET << std::endl;
      ss << "  Total DMA Memory Size: " << COLOR_YELLOW
         << mem_size.total_dma_allocated_size << " bytes"
         << " (" << mem_size.total_dma_allocated_size / 1024.0F / 1024.0F
         << " MiB)" << COLOR_RESET << std::endl;
      ss << "  Total SRAM Size: " << COLOR_YELLOW << mem_size.total_sram_size
         << " bytes"
         << " (" << mem_size.total_sram_size / 1024.0F << " KiB)" << COLOR_RESET
         << std::endl;
      ss << "  Free SRAM Size: " << COLOR_YELLOW << mem_size.free_sram_size
         << " bytes"
         << " (" << mem_size.free_sram_size / 1024.0F << " KiB)" << COLOR_RESET
         << std::endl;
    }

    // Query input/output num
    ss << "\n" << COLOR_BOLD << "Input/Output Num:" << COLOR_RESET << std::endl;
    ss << "  Input Num: " << COLOR_CYAN << io_num_.n_input << COLOR_RESET
       << std::endl;
    ss << "  Output Num: " << COLOR_CYAN << io_num_.n_output << COLOR_RESET
       << std::endl;

    // Query input/output info
    ss << "\n"
       << COLOR_BOLD << "Inputs (" << COLOR_CYAN << input_attrs.size()
       << COLOR_BOLD << "):" << COLOR_RESET << std::endl;
    for (const auto &attr : input_attrs) {
      print_rknn_tensor_attr(ss, attr);
    }

    ss << "\n"
       << COLOR_BOLD << "Outputs (" << COLOR_CYAN << output_attrs.size()
       << COLOR_BOLD << "):" << COLOR_RESET << std::endl;
    for (const auto &attr : output_attrs) {
      print_rknn_tensor_attr(ss, attr);
    }

    // Query native input/output attributes
    ss << "\n"
       << COLOR_BOLD << "Native Input Attributes:" << COLOR_RESET << std::endl;
    for (uint32_t i = 0; i < io_num_.n_input; i++) {
      rknn_tensor_attr native_attr;
      native_attr.index = i;
      if (rknn_query(ctx, RKNN_QUERY_NATIVE_INPUT_ATTR, &native_attr,
                     sizeof(native_attr)) >= 0) {
        print_rknn_tensor_attr(ss, native_attr);
      }
    }

    ss << "\n"
       << COLOR_BOLD << "Native Output Attributes:" << COLOR_RESET << std::endl;
    for (uint32_t i = 0; i < io_num_.n_output; i++) {
      rknn_tensor_attr native_attr;
      native_attr.index = i;
      if (rknn_query(ctx, RKNN_QUERY_NATIVE_OUTPUT_ATTR, &native_attr,
                     sizeof(native_attr)) >= 0) {
        print_rknn_tensor_attr(ss, native_attr);
      }
    }

    // RKNN_QUERY_NATIVE_NHWC_INPUT_ATTR
    ss << "\n"
       << COLOR_BOLD << "Native NHWC Input Attributes:" << COLOR_RESET
       << std::endl;
    for (uint32_t i = 0; i < io_num_.n_input; i++) {
      rknn_tensor_attr native_attr;
      native_attr.index = i;
      if (rknn_query(ctx, RKNN_QUERY_NATIVE_NHWC_INPUT_ATTR, &native_attr,
                     sizeof(native_attr)) >= 0) {
        print_rknn_tensor_attr(ss, native_attr);
      }
    }

    // RKNN_QUERY_NATIVE_NHWC_OUTPUT_ATTR
    ss << "\n"
       << COLOR_BOLD << "Native NHWC Output Attributes:" << COLOR_RESET
       << std::endl;
    for (uint32_t i = 0; i < io_num_.n_output; i++) {
      rknn_tensor_attr native_attr;
      native_attr.index = i;
      if (rknn_query(ctx, RKNN_QUERY_NATIVE_NHWC_OUTPUT_ATTR, &native_attr,
                     sizeof(native_attr)) >= 0) {
        print_rknn_tensor_attr(ss, native_attr);
      }
    }

    // Query input dynamic range (for dynamic shape models)
    for (uint32_t i = 0; i < io_num_.n_input; i++) {
      rknn_input_range input_range;
      input_range.index = i;
      if (rknn_query(ctx, RKNN_QUERY_INPUT_DYNAMIC_RANGE, &input_range,
                     sizeof(input_range)) >= 0) {
        if (input_range.shape_number > 0) {
          ss << "\n"
             << COLOR_BOLD << "Dynamic Input Range for [" << COLOR_CYAN << i
             << COLOR_BOLD << "] " << COLOR_GREEN << input_range.name
             << COLOR_BOLD << ":" << COLOR_RESET << std::endl;
          ss << "  Format: " << COLOR_BLUE << get_format_string(input_range.fmt)
             << COLOR_RESET << std::endl;
          ss << "  Shape Count: " << COLOR_YELLOW << input_range.shape_number
             << COLOR_RESET << std::endl;
          for (uint32_t s = 0; s < input_range.shape_number; s++) {
            ss << "  Shape " << COLOR_CYAN << s << COLOR_RESET << ": "
               << COLOR_CYAN << "[";
            for (uint32_t d = 0; d < input_range.n_dims; d++) {
              ss << input_range.dyn_range[s][d];
              if (d < input_range.n_dims - 1)
                ss << ",";
            }
            ss << "]" << COLOR_RESET << std::endl;
          }
        }
      }
    }

    // Query current input/output attributes (for dynamic shape models)
    ss << "\n"
       << COLOR_BOLD << "Current Input Attributes:" << COLOR_RESET << std::endl;
    for (uint32_t i = 0; i < io_num_.n_input; i++) {
      rknn_tensor_attr curr_attr;
      curr_attr.index = i;
      if (rknn_query(ctx, RKNN_QUERY_CURRENT_INPUT_ATTR, &curr_attr,
                     sizeof(curr_attr)) >= 0) {
        print_rknn_tensor_attr(ss, curr_attr);
      }
    }

    ss << "\n"
       << COLOR_BOLD << "Current Output Attributes:" << COLOR_RESET
       << std::endl;
    for (uint32_t i = 0; i < io_num_.n_output; i++) {
      rknn_tensor_attr curr_attr;
      curr_attr.index = i;
      if (rknn_query(ctx, RKNN_QUERY_CURRENT_OUTPUT_ATTR, &curr_attr,
                     sizeof(curr_attr)) >= 0) {
        print_rknn_tensor_attr(ss, curr_attr);
      }
    }

    // 性能测试部分
    if (perf_runs > 0) {
      ss << "\n"
         << COLOR_BOLD << "Performance Test (" << COLOR_CYAN << perf_runs
         << COLOR_BOLD << " runs):" << COLOR_RESET << std::endl;

      std::vector<float> run_times;
      run_times.reserve(perf_runs);

      // 预热一次
      auto ret = rknn_run(ctx, nullptr);
      if (ret < 0) {
        ss << COLOR_RED << "Failed to run model for warmup" << COLOR_RESET
           << std::endl;
        return ss.str();
      }

      rknn_perf_run perf_run;
      if (rknn_query(ctx, RKNN_QUERY_PERF_RUN, &perf_run, sizeof(perf_run)) >=
          0) {
        ss << "  Warmup run: " << COLOR_YELLOW
           << perf_run.run_duration / 1000.0F << " ms" << COLOR_RESET
           << std::endl;
      }

      // 多次运行并记录时间
      for (int i = 0; i < perf_runs; i++) {
        ret = rknn_run(ctx, nullptr);
        if (ret < 0) {
          ss << COLOR_RED << "Failed to run model at iteration " << i
             << COLOR_RESET << std::endl;
          continue;
        }

        if (rknn_query(ctx, RKNN_QUERY_PERF_RUN, &perf_run, sizeof(perf_run)) >=
            0) {
          float ms = perf_run.run_duration / 1000.0F;
          run_times.push_back(ms);
          ss << "  Run " << COLOR_CYAN << i + 1 << COLOR_RESET << ": "
             << COLOR_YELLOW << ms << " ms" << COLOR_RESET << " ("
             << COLOR_GREEN << 1000.0F / ms << " FPS" << COLOR_RESET << ")"
             << std::endl;
        }
      }

      // 计算统计信息
      if (!run_times.empty()) {
        float sum = 0;
        float min_time = run_times[0];
        float max_time = run_times[0];

        for (float t : run_times) {
          sum += t;
          min_time = std::min(min_time, t);
          max_time = std::max(max_time, t);
        }

        float avg_time = sum / run_times.size();

        // 计算标准差
        float variance = 0;
        for (float t : run_times) {
          float diff = t - avg_time;
          variance += diff * diff;
        }
        float std_dev = std::sqrt(variance / run_times.size());

        ss << "\n"
           << COLOR_BOLD << "Performance Statistics:" << COLOR_RESET
           << std::endl;
        ss << "  Average Time: " << COLOR_YELLOW << avg_time << " ms"
           << COLOR_RESET << " (" << COLOR_GREEN << 1000.0F / avg_time << " FPS"
           << COLOR_RESET << ")" << std::endl;
        ss << "  Min Time: " << COLOR_YELLOW << min_time << " ms" << COLOR_RESET
           << " (" << COLOR_GREEN << 1000.0F / min_time << " FPS" << COLOR_RESET
           << ")" << std::endl;
        ss << "  Max Time: " << COLOR_YELLOW << max_time << " ms" << COLOR_RESET
           << " (" << COLOR_GREEN << 1000.0F / max_time << " FPS" << COLOR_RESET
           << ")" << std::endl;
        ss << "  Std Dev: " << COLOR_YELLOW << std_dev << " ms" << COLOR_RESET
           << std::endl;
      }
    } else {
      // Query performance details
      rknn_perf_detail perf_detail;
      if (rknn_query(ctx, RKNN_QUERY_PERF_DETAIL, &perf_detail,
                     sizeof(perf_detail)) >= 0) {
        ss << "\n"
           << COLOR_BOLD << "Performance Details:" << COLOR_RESET << std::endl;
        ss << COLOR_YELLOW << perf_detail.perf_data << COLOR_RESET << std::endl;
      }

      // Query run performance
      rknn_perf_run perf_run;
      if (rknn_query(ctx, RKNN_QUERY_PERF_RUN, &perf_run, sizeof(perf_run)) >=
          0) {
        ss << "\n"
           << COLOR_BOLD << "Run Duration: " << COLOR_YELLOW
           << perf_run.run_duration / 1000.0F << " ms" << COLOR_RESET
           << std::endl;
      }
    }

    // Query custom string if available
    rknn_custom_string custom_str;
    if (rknn_query(ctx, RKNN_QUERY_CUSTOM_STRING, &custom_str,
                   sizeof(custom_str)) >= 0) {
      if (strlen(custom_str.string) > 0) {
        ss << "\n"
           << COLOR_BOLD << "Custom String: " << COLOR_GREEN
           << custom_str.string << COLOR_RESET << std::endl;
      }
    }

    return ss.str();
  }
#endif

  std::vector<rknn_tensor_attr> input_attrs;
  std::vector<rknn_tensor_attr> output_attrs;
  rknn_core_mask core_mask = RKNN_NPU_CORE_UNDEFINED;
  rknn_context ctx = 0;

protected:
  static size_t typeBytes(rknn_tensor_type type) {
    switch (type) {
    case RKNN_TENSOR_INT8:
    case RKNN_TENSOR_UINT8:
      return 1;
    case RKNN_TENSOR_INT16:
    case RKNN_TENSOR_UINT16:
    case RKNN_TENSOR_FLOAT16:
      return 2;
    case RKNN_TENSOR_INT32:
    case RKNN_TENSOR_UINT32:
    case RKNN_TENSOR_FLOAT32:
      return 4;
    default:
      return 1;
    }
  }

  void configureOutputs() {
    rknn_outputs_.resize(io_num_.n_output);
    output_buffers_.resize(io_num_.n_output);
    for (uint32_t i = 0; i < io_num_.n_output; i++) {
      size_t bytes =
          want_float_ ? ((size_t)output_attrs[i].n_elems * sizeof(float))
                      : ((size_t)output_attrs[i].n_elems *
                         typeBytes(output_attrs[i].type));
      output_buffers_[i].resize(bytes);
      rknn_outputs_[i].index = i;
      rknn_outputs_[i].want_float = want_float_;
      rknn_outputs_[i].is_prealloc = true;
      rknn_outputs_[i].buf = output_buffers_[i].data();
      rknn_outputs_[i].size = bytes;
    }
    outputs_prealloc_ = true;
    last_outputs_.clear();
  }

  void init() {
    // 读取模型文件
    std::ifstream file(model_path_, std::ios::binary | std::ios::ate);
    if (!file.is_open()) {
      throw std::runtime_error("Failed to open model file: " +
                               model_path_.string());
    }

    size_t model_size = file.tellg();
    file.seekg(0, std::ios::beg);

    std::vector<uint8_t> model_data(model_size);
    if (!file.read(reinterpret_cast<char *>(model_data.data()), model_size)) {
      throw std::runtime_error("Failed to read model file");
    }

    // 初始化RKNN上下文
    int ret = rknn_init(&ctx, model_data.data(), model_size, 0, nullptr);
    if (ret < 0) {
      throw std::runtime_error("rknn_init failed with error code: " +
                               std::to_string(ret));
    }

    // 设置NPU核心
    if (core_mask != RKNN_NPU_CORE_UNDEFINED) {
      ret = rknn_set_core_mask(ctx, core_mask);
      if (ret < 0) {
        throw std::runtime_error("rknn_set_core_mask failed with error code: " +
                                 std::to_string(ret));
      }
    }

    // 查询输入输出信息
    ret = rknn_query(ctx, RKNN_QUERY_IN_OUT_NUM, &io_num_, sizeof(io_num_));
    if (ret < 0) {
      throw std::runtime_error("rknn_query failed with error code: " +
                               std::to_string(ret));
    }

    // 查询输入属性
    input_attrs.resize(io_num_.n_input);
    for (uint32_t i = 0; i < io_num_.n_input; i++) {
      input_attrs[i].index = i;
      ret = rknn_query(ctx, RKNN_QUERY_INPUT_ATTR, &input_attrs[i],
                       sizeof(rknn_tensor_attr));
      if (ret < 0) {
        throw std::runtime_error("Failed to query input attr");
      }

      // MODIFIED: Also swap dims for NCHW_SOFTWARE to present a user-friendly
      // NCHW shape. The native query usually returns NHWC.
      if (input_attrs[i].n_dims == 4 &&
          (layout_ == Layout::ORIGINAL ||
           layout_ == Layout::ORIGINAL_SOFTWARE)) {
        auto n = input_attrs[i].dims[0];
        auto h = input_attrs[i].dims[1];
        auto w = input_attrs[i].dims[2];
        auto c = input_attrs[i].dims[3];
        input_attrs[i].dims[0] = n;
        input_attrs[i].dims[1] = c;
        input_attrs[i].dims[2] = h;
        input_attrs[i].dims[3] = w;
      }
    }

    // 查询输出属性
    output_attrs.resize(io_num_.n_output);
    for (uint32_t i = 0; i < io_num_.n_output; i++) {
      output_attrs[i].index = i;
      ret = rknn_query(ctx, RKNN_QUERY_OUTPUT_ATTR, &output_attrs[i],
                       sizeof(rknn_tensor_attr));
      if (ret < 0) {
        throw std::runtime_error("Failed to query output attr");
      }
    }

    rknn_inputs_.reserve(io_num_.n_input);
    configureOutputs();
    temp_input_buffers_.resize(io_num_.n_input);
  }

  // 递归终止
  void setInputs(std::vector<rknn_input> &rknn_inputs) {}

  // 递归设置输入
  template <typename T, typename... Args>
  void setInputs(std::vector<rknn_input> &rknn_inputs, T *input,
                 Args *...rest) {
    rknn_input in = {};
    in.index = rknn_inputs.size();
    in.type = RknnDtype<T>::type;

    // MODIFIED: Simplified logic. NCHW layout gets NCHW format.
    // All other 4D layouts (NHWC, NCHW_SOFTWARE) get NHWC format.
    in.fmt =
        (input_attrs[in.index].n_dims == 4)
            ? (layout_ == Layout::NCHW ? RKNN_TENSOR_NCHW : RKNN_TENSOR_NHWC)
            : RKNN_TENSOR_UNDEFINED;

    void *data_ptr = const_cast<void *>(static_cast<const void *>(input));

    // ADDED: Handle NCHW_SOFTWARE transposition
    // If the layout is NCHW_SOFTWARE and input is 4D, we transpose it from
    // user-provided NCHW to a temporary NHWC buffer.
    if (layout_ == Layout::NCHW_SOFTWARE && input_attrs[in.index].n_dims == 4) {
      const auto &attr = input_attrs[in.index];
      // The dims are already swapped to NCHW in init()
      const int n = attr.dims[0];
      const int c = attr.dims[1];
      const int h = attr.dims[2];
      const int w = attr.dims[3];

      // Allocate a temporary buffer for the transposed (NHWC) data
      auto &buf = temp_input_buffers_[in.index];
      buf.resize((size_t)attr.n_elems * sizeof(std::remove_const_t<T>));
      using NonConstT = std::remove_const_t<T>;
      NonConstT *dst_nhwc =
          reinterpret_cast<NonConstT *>(buf.data());
      const T *src_nchw = input;

      // Perform NCHW to NHWC transposition
      for (int n_idx = 0; n_idx < n; ++n_idx) {
        for (int h_idx = 0; h_idx < h; ++h_idx) {
          for (int w_idx = 0; w_idx < w; ++w_idx) {
            for (int c_idx = 0; c_idx < c; ++c_idx) {
              // Destination (NHWC) index: n*H*W*C + h*W*C + w*C + c
              // Source (NCHW) index:      n*C*H*W + c*H*W + h*W + w
              dst_nhwc[(n_idx * h * w * c) + (h_idx * w * c) + (w_idx * c) +
                       c_idx] = src_nchw[(n_idx * c * h * w) + (c_idx * h * w) +
                                         (h_idx * w) + w_idx];
            }
          }
        }
      }
      // Update the data pointer to our new temporary buffer
      data_ptr = static_cast<void *>(dst_nhwc);
    }

    in.buf = data_ptr;
    in.size = input_attrs[in.index].n_elems * sizeof(T);
    rknn_inputs.push_back(in);

    setInputs(rknn_inputs, rest...);
  }

protected:
  void updateLastRunDuration() {
    rknn_perf_run perf_run = {};
    if (rknn_query(ctx, RKNN_QUERY_PERF_RUN, &perf_run,
                   sizeof(perf_run)) >= 0) {
      last_run_duration_ms_ = perf_run.run_duration / 1000.0;
    } else {
      last_run_duration_ms_ = 0.0;
    }
  }

  std::filesystem::path model_path_;
  std::mutex mutex_;

  rknn_input_output_num io_num_;
  Layout layout_;
  bool outputs_prealloc_ = true;
  bool want_float_ = true;
  double last_run_duration_ms_ = 0.0;
  std::vector<rknn_output>
      last_outputs_; // 保存上一次的输出,用于在下一次inference时释放

  // ADDED: Buffer to hold transposed input data for NCHW_SOFTWARE layout.
  // This vector's lifetime is managed within a single call to inference().
  std::vector<std::vector<uint8_t>> temp_input_buffers_;

  std::vector<rknn_input> rknn_inputs_;
  std::vector<rknn_output> rknn_outputs_;
  std::vector<std::vector<uint8_t>> output_buffers_;
};

} // namespace rk
} // namespace ztu
