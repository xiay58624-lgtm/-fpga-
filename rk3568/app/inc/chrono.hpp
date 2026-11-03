#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <deque>
#include <mutex>
#include <thread>
#include <vector>

namespace ztu {
namespace chrono {

class RateLimiter {
public:
  // 构造函数接受每秒最大调用次数
  explicit RateLimiter(double calls_per_second)
      : interval_(std::chrono::duration_cast<Clock::duration>(
            std::chrono::duration<double>(1.0 / calls_per_second))),
        last_call_(Clock::now()) {}

  // 等待直到允许下一次调用
  void wait() {
    std::lock_guard<std::mutex> lock(mutex_);
    auto now = Clock::now();
    auto elapsed = now - last_call_;

    if (elapsed < interval_) {
      std::this_thread::sleep_for(interval_ - elapsed);
    }

    last_call_ = Clock::now();
  }

  // 函数调用运算符重载，方便使用
  void operator()() { wait(); }

private:
  using Clock = std::chrono::steady_clock;
  const Clock::duration interval_;
  Clock::time_point last_call_;
  std::mutex mutex_;
};

class FPSCounter {
public:
  FPSCounter(std::chrono::milliseconds window = std::chrono::seconds(1))
      : timeWindow_(window) {}

  void update() {
    auto now = std::chrono::high_resolution_clock::now();
    frameFinishTimes_.push_back(now);

    // 清理超出时间窗口的旧记录
    auto timeWindowStart = now - timeWindow_;
    while (!frameFinishTimes_.empty() &&
           frameFinishTimes_.front() < timeWindowStart) {
      frameFinishTimes_.pop_front();
    }
  }

  double getAverageFPS() const {
    if (frameFinishTimes_.size() < 2) {
      return 0.0;
    }
    auto timeDiff = frameFinishTimes_.back() - frameFinishTimes_.front();
    double seconds = std::chrono::duration<double>(timeDiff).count();
    return (frameFinishTimes_.size() - 1) / seconds;
  }

  double getOnePercentLowFPS() const {
    if (frameFinishTimes_.size() < 2) {
      return 0.0;
    }

    std::vector<double> frameDurations;
    for (size_t i = 1; i < frameFinishTimes_.size(); ++i) {
      std::chrono::duration<double> duration =
          frameFinishTimes_[i] - frameFinishTimes_[i - 1];
      frameDurations.push_back(duration.count());
    }

    if (frameDurations.empty()) {
      return 0.0;
    }

    std::sort(frameDurations.begin(), frameDurations.end());

    size_t onePercentCount = std::max(
        1UL, static_cast<size_t>(std::floor(frameDurations.size() * 0.01)));

    double sumOfWorstFrameDurations = 0.0;
    for (size_t i = 0; i < onePercentCount; ++i) {
      sumOfWorstFrameDurations += frameDurations[i];
    }

    double averageOfWorstFrameDuration =
        sumOfWorstFrameDurations / onePercentCount;

    if (averageOfWorstFrameDuration > 0) {
      return 1.0 / averageOfWorstFrameDuration;
    } else {
      return 0.0;
    }
  }

private:
  std::chrono::milliseconds timeWindow_;
  std::deque<std::chrono::high_resolution_clock::time_point> frameFinishTimes_;
};

} // namespace chrono
} // namespace ztu
