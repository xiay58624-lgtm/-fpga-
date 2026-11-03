#pragma once

#include <algorithm>
#include <string>

struct PlateConsensusState {
    std::string confirmed_text;
    int confirmed_color = 0;
    float confirmed_confidence = 0.0f;

    std::string candidate_text;
    int candidate_color = 0;
    float candidate_confidence = 0.0f;
    int candidate_hits = 0;
    int candidate_strong_hits = 0;

    int stable_hits = 0;
    int misses = 0;
    bool reported = false;
};

// Strong observations already passed the per-frame OCR threshold/crop
// agreement. Weak observations are structurally valid and above a relaxed
// floor; they need one additional matching frame before promotion.
inline bool plateConsensusObserve(PlateConsensusState &state,
                                  const std::string &text,
                                  int color,
                                  float confidence,
                                  bool strong,
                                  bool staticFrame,
                                  int stableRequired) {
    if (text.empty()) return false;
    stableRequired = std::max(1, stableRequired);

    if (state.candidate_text != text) {
        state.candidate_text = text;
        state.candidate_color = color;
        state.candidate_confidence = confidence;
        state.candidate_hits = 1;
        state.candidate_strong_hits = strong ? 1 : 0;
    } else {
        state.candidate_hits = std::min(state.candidate_hits + 1, 1000);
        if (strong) {
            state.candidate_strong_hits =
                std::min(state.candidate_strong_hits + 1, 1000);
        }
        // Color can jitter independently of text. Keep the color attached to
        // the strongest OCR observation without resetting text consensus.
        if (confidence >= state.candidate_confidence) {
            state.candidate_color = color;
            state.candidate_confidence = confidence;
        }
    }
    state.misses = 0;

    const int weakRequired = std::max(3, stableRequired + 1);
    const bool promote = staticFrame
        ? strong
        : ((state.candidate_hits >= stableRequired &&
            state.candidate_strong_hits >= stableRequired) ||
           state.candidate_hits >= weakRequired);
    if (!promote) return false;

    const bool changed = state.confirmed_text != state.candidate_text;
    if (changed) state.reported = false;
    state.confirmed_text = state.candidate_text;
    state.confirmed_color = state.candidate_color;
    state.confirmed_confidence = state.candidate_confidence;
    state.stable_hits = state.candidate_hits;
    return true;
}

inline bool plateConsensusMiss(PlateConsensusState &state,
                               int maxMisses = 3) {
    state.misses++;
    if (state.misses < std::max(1, maxMisses)) return false;
    state = {};
    return true;
}

inline bool plateConsensusConfirmed(const PlateConsensusState &state) {
    return !state.confirmed_text.empty();
}

inline bool plateConsensusHasPendingReplacement(
        const PlateConsensusState &state) {
    return !state.confirmed_text.empty() &&
           !state.candidate_text.empty() &&
           state.candidate_text != state.confirmed_text;
}

// A strong replacement is safe to show immediately. A weak replacement needs
// two matching observations before it can displace confirmed on-screen text;
// cloud reporting still waits for the normal confirmation policy.
inline bool plateConsensusShouldDisplayCandidate(
        const PlateConsensusState &state) {
    if (state.candidate_text.empty()) return false;
    if (state.confirmed_text.empty()) return true;
    if (state.candidate_text == state.confirmed_text) return false;
    return state.candidate_strong_hits > 0 || state.candidate_hits >= 2;
}
