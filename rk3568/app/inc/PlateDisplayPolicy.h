#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string>

namespace plate_display {

constexpr std::size_t kVisualIdentitySamples = 128;
using VisualIdentitySignature =
    std::array<std::uint8_t, kVisualIdentitySamples>;

struct VisualIdentityDifference {
    bool valid = false;
    double mean_difference = 0.0;
    int changed_samples = 0;
};

inline double effectiveOverlayMaxAgeMs(double configuredMaxAgeMs,
                                       double workerMs) {
    const double configured = std::clamp(configuredMaxAgeMs, 50.0, 2000.0);
    if (workerMs <= 0.0) return configured;
    return std::min(2000.0, std::max(configured, workerMs * 2.0 + 100.0));
}

inline bool retainAfterMiss(bool staticFrame,
                            std::uint32_t missedRuns,
                            int configuredHoldRuns) {
    const int holdRuns = std::clamp(configuredHoldRuns, 0, 3);
    return !staticFrame && missedRuns > 0 &&
           missedRuns <= static_cast<std::uint32_t>(holdRuns);
}

inline VisualIdentityDifference visualIdentityDifference(
        const VisualIdentitySignature &previous,
        bool previousValid,
        const VisualIdentitySignature &current,
        bool currentValid) {
    VisualIdentityDifference result;
    if (!previousValid || !currentValid) return result;

    int totalDifference = 0;
    result.valid = true;
    for (std::size_t i = 0; i < previous.size(); ++i) {
        const int difference = std::max(
            static_cast<int>(previous[i]), static_cast<int>(current[i])) -
            std::min(static_cast<int>(previous[i]), static_cast<int>(current[i]));
        totalDifference += difference;
        if (difference >= 32) ++result.changed_samples;
    }
    result.mean_difference =
        static_cast<double>(totalDifference) / previous.size();
    return result;
}

inline bool visualIdentityChanged(
        const VisualIdentitySignature &previous,
        bool previousValid,
        const VisualIdentitySignature &current,
        bool currentValid) {
    const VisualIdentityDifference difference = visualIdentityDifference(
        previous, previousValid, current, currentValid);
    if (!difference.valid) return false;
    return difference.mean_difference >= 30.0 ||
           (difference.mean_difference >= 12.0 &&
            difference.changed_samples >= 16);
}

inline bool visualIdentityNeedsRefresh(
        const VisualIdentityDifference &difference) {
    if (!difference.valid) return false;
    return difference.mean_difference >= 18.0 ||
           (difference.mean_difference >= 8.0 &&
            difference.changed_samples >= 12);
}

inline bool shouldResetTrackIdentity(float boxIou,
                                     bool visualChanged) {
    return visualChanged && boxIou >= 0.55f;
}

inline bool canDisplayConfirmedText(bool confirmedAvailable,
                                    bool pendingReplacement,
                                    bool displaySuppressed) {
    return confirmedAvailable && !pendingReplacement && !displaySuppressed;
}

inline float relaxedOcrDisplayThreshold(float configuredThreshold) {
    return std::max(0.20f, configuredThreshold - 0.50f);
}

// Detector geometry already establishes where the plate is. A non-empty OCR
// result may therefore be shown even when strict format or visual-authenticity
// checks reject it. Those checks still protect confirmation and reporting.
inline bool canDisplayRelaxedOcrText(const std::string &text,
                                     float confidence,
                                     float configuredThreshold) {
    return !text.empty() && std::isfinite(confidence) &&
           confidence >= relaxedOcrDisplayThreshold(configuredThreshold);
}

inline bool ocrRefreshDue(bool detectionFresh,
                          bool staticFrame,
                          bool hasCache,
                          int period,
                          std::uint32_t detectionCounter,
                          std::uint32_t lastOcrDetection) {
    if (!detectionFresh) return false;
    if (staticFrame || !hasCache || period <= 1) return true;
    return detectionCounter - lastOcrDetection >=
           static_cast<std::uint32_t>(period);
}

inline std::string ocrTrackCacheKey(int sourceIndex,
                                    std::uint64_t trackId) {
    return "source_" + std::to_string(sourceIndex) + ":track_" +
           std::to_string(trackId);
}

} // namespace plate_display
