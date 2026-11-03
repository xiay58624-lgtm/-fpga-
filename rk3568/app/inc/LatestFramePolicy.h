#pragma once

#include <cstdint>

namespace latest_frame {

inline bool canAcceptTask(bool stopped, bool busy, bool hasPendingTask) {
    return !stopped && !busy && !hasPendingTask;
}

inline bool resultUsable(bool hasResult,
                         std::uint64_t resultGeneration,
                         std::uint64_t currentGeneration,
                         double resultAgeMs,
                         double maxAgeMs) {
    return hasResult &&
           resultGeneration == currentGeneration &&
           resultAgeMs >= 0.0 &&
           resultAgeMs <= maxAgeMs;
}

// The producer already suppresses frames whose generation is no longer
// current. A receiver may still hold an older expected generation when a
// setting changes the producer between two GUI events, so accept newer frames
// and advance the receiver instead of rejecting every subsequent frame.
inline bool displayFrameUsable(std::uint64_t frameGeneration,
                               std::uint64_t expectedGeneration) {
    return frameGeneration != 0 &&
           (expectedGeneration == 0 || frameGeneration >= expectedGeneration);
}

} // namespace latest_frame
