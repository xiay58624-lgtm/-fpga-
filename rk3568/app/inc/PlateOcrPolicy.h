#pragma once

#include <algorithm>
#include <cmath>
#include <limits>
#include <map>
#include <string>
#include <vector>

struct PlateOcrVote {
    std::string text;
    float confidence = 0.0f;
    bool format_ok = false;
    bool confirmable = false;
};

struct PlateOcrVoteConsensus {
    bool accepted = false;
    std::string text;
    int matching_votes = 0;
    int best_index = -1;
    float top_two_average = 0.0f;
};

struct PlateOcrAttemptQuality {
    bool format_ok = false;
    bool confirmation_allowed = false;
    int authenticity_rank = 0;
    float confidence = 0.0f;
};

// Retry crops exist to recover text from imperfect detector landmarks. A
// visually convincing crop with invalid text must not outrank another crop
// that produced a structurally valid, confirmable plate string.
inline bool plateOcrAttemptPreferred(
        const PlateOcrAttemptQuality &candidate,
        const PlateOcrAttemptQuality &current) {
    const bool candidateUsable =
        candidate.format_ok && candidate.confirmation_allowed;
    const bool currentUsable =
        current.format_ok && current.confirmation_allowed;
    if (candidateUsable != currentUsable) return candidateUsable;
    if (candidate.format_ok != current.format_ok) return candidate.format_ok;
    if (candidate.confirmation_allowed != current.confirmation_allowed) {
        return candidate.confirmation_allowed;
    }
    if (candidate.authenticity_rank != current.authenticity_rank) {
        return candidate.authenticity_rank > current.authenticity_rank;
    }
    return candidate.confidence > current.confidence;
}

// Exact agreement between two independent crops is stronger than one
// high-scoring crop. Only the two strongest matching votes determine the
// confidence floor, so an additional weak crop cannot invalidate agreement.
inline PlateOcrVoteConsensus plateOcrVoteConsensus(
        const std::vector<PlateOcrVote> &votes,
        float minimumTopTwoAverage) {
    struct Group {
        int count = 0;
        int best_index = -1;
        float highest = -std::numeric_limits<float>::infinity();
        float second = -std::numeric_limits<float>::infinity();
    };

    std::map<std::string, Group> groups;
    for (size_t i = 0; i < votes.size(); ++i) {
        const PlateOcrVote &vote = votes[i];
        if (!vote.format_ok || !vote.confirmable || vote.text.empty() ||
            !std::isfinite(vote.confidence)) {
            continue;
        }
        Group &group = groups[vote.text];
        ++group.count;
        if (vote.confidence > group.highest) {
            group.second = group.highest;
            group.highest = vote.confidence;
            group.best_index = static_cast<int>(i);
        } else if (vote.confidence > group.second) {
            group.second = vote.confidence;
        }
    }

    PlateOcrVoteConsensus result;
    for (const auto &entry : groups) {
        const Group &group = entry.second;
        if (group.count < 2 || !std::isfinite(group.second)) continue;
        const float topTwoAverage = 0.5f * (group.highest + group.second);
        if (topTwoAverage < minimumTopTwoAverage) continue;
        if (!result.accepted || group.count > result.matching_votes ||
            (group.count == result.matching_votes &&
             topTwoAverage > result.top_two_average)) {
            result.accepted = true;
            result.text = entry.first;
            result.matching_votes = group.count;
            result.best_index = group.best_index;
            result.top_two_average = topTwoAverage;
        }
    }
    return result;
}

inline bool plateDetectorEvidenceStrong(float detectorConfidence,
                                        int windowSupport) {
    return detectorConfidence >= 0.45f ||
           (windowSupport >= 2 && detectorConfidence >= 0.30f);
}

inline bool plateStaticWindowEvidence(float detectorConfidence,
                                      int windowSupport,
                                      float configuredDetectionThreshold) {
    const float detectorFloor = std::max(
        0.30f, configuredDetectionThreshold);
    return windowSupport >= 2 && detectorConfidence >= detectorFloor;
}
