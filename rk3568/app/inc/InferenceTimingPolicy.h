#pragma once

#include <algorithm>
#include <cstdint>

namespace inference_timing {

// Use the capture/FPGA sequence rather than the number of yolo_run() calls.
// If inference was busy and source frames were dropped, the next available
// frame becomes due immediately instead of starting a second stride countdown.
inline bool sourceFrameDue(std::uint64_t sourceSequence,
                           std::uint64_t lastDetectionSequence,
                           int configuredStride) {
    const std::uint64_t stride = static_cast<std::uint64_t>(
        std::max(1, configuredStride));
    if (sourceSequence == 0) return false;
    if (lastDetectionSequence == 0 ||
        sourceSequence <= lastDetectionSequence) {
        return true;
    }
    return sourceSequence - lastDetectionSequence >= stride;
}

struct CompletionDelta {
    std::uint64_t cycles = 0;
    std::uint64_t tasks = 0;
};

inline CompletionDelta completionDelta(std::uint64_t currentCycles,
                                       std::uint64_t currentTasks,
                                       std::uint64_t previousCycles,
                                       std::uint64_t previousTasks) {
    return {
        currentCycles >= previousCycles
            ? currentCycles - previousCycles : currentCycles,
        currentTasks >= previousTasks
            ? currentTasks - previousTasks : currentTasks,
    };
}

} // namespace inference_timing
