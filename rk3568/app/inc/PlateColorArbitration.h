#pragma once

#include <algorithm>

struct PlateColorPhysicalEvidence {
    float black_ratio = 0.0f;
    float blue_ratio = 0.0f;
    float green_ratio = 0.0f;
    float yellow_ratio = 0.0f;
    float average_value = 0.0f;
};

// Black and blue HSV masks overlap for very dark blue pixels. A real black
// plate therefore needs both substantial black coverage and a clear margin
// over blue before physical evidence may override the color model.
inline bool plateColorDecisiveBlack(
        const PlateColorPhysicalEvidence &evidence, int blackValueMax) {
    const float brightnessCeiling = static_cast<float>(
        std::clamp(blackValueMax + 75, 105, 150));
    const float competingChroma = std::max(
        {evidence.blue_ratio, evidence.green_ratio, evidence.yellow_ratio});
    return evidence.black_ratio >= 0.38f &&
           evidence.black_ratio - competingChroma >= 0.15f &&
           evidence.black_ratio >= 1.60f * competingChroma &&
           evidence.average_value <= brightnessCeiling;
}

inline bool plateColorLowLightBlack(
        const PlateColorPhysicalEvidence &evidence, int blackValueMax) {
    const float competingChroma = std::max(
        {evidence.blue_ratio, evidence.green_ratio, evidence.yellow_ratio});
    return evidence.average_value < static_cast<float>(blackValueMax) &&
           evidence.black_ratio >= 0.25f &&
           evidence.black_ratio - competingChroma >= 0.08f &&
           evidence.black_ratio >= 1.20f * competingChroma;
}
