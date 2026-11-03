#pragma once

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <vector>

namespace adas_models {
struct Candidate {
    int classId;
    float confidence;
    float cx, cy, width, height;
};

// Only the verified decoded YOLO output [1,4+classes,8400] is accepted.
// Scores are probabilities. Reapplying sigmoid would conceal a bad contract.
inline std::vector<Candidate> decodeProbabilities(const float *data,
                                                  int channels, int count,
                                                  int classes, float threshold) {
    if (!data || channels != classes + 4 || count != 8400)
        throw std::runtime_error("ADAS output shape mismatch");
    std::vector<Candidate> result;
    for (int i = 0; i < count; ++i) {
        int bestClass = -1;
        float best = 0;
        for (int c = 0; c < classes; ++c) {
            const float score = data[(4 + c) * count + i];
            if (!std::isfinite(score) || score < 0 || score > 1)
                throw std::runtime_error("ADAS class score is not a probability");
            if (score > best) { best = score; bestClass = c; }
        }
        if (bestClass < 0 || best < threshold) continue;
        const float cx = data[i], cy = data[count + i];
        const float w = data[2 * count + i], h = data[3 * count + i];
        if (!std::isfinite(cx) || !std::isfinite(cy) ||
            !std::isfinite(w) || !std::isfinite(h) ||
            w <= 0 || h <= 0 || w > 1280 || h > 1280 ||
            cx < -640 || cx > 1280 || cy < -640 || cy > 1280) continue;
        result.push_back({bestClass, best, cx, cy, w, h});
    }
    std::sort(result.begin(), result.end(), [](const Candidate &a, const Candidate &b) {
        return a.confidence > b.confidence;
    });
    // Bound postprocessing even for an unexpectedly dense frame.
    if (result.size() > 1000) result.resize(1000);
    return result;
}
}
