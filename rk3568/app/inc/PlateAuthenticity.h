#pragma once

#include <cstdint>

enum class PlateAuthenticityState : uint8_t {
    Unassessed,
    Supported,
    Ambiguous,
    Rejected,
};

struct PlateAuthenticityEvidence {
    bool assessable = false;
    bool glyph_layout = false;
    bool color_supported = false;
    bool grid_pattern = false;
    bool detector_strong = false;
    bool spatial_support = false;
    bool ocr_plausible = false;
    bool ocr_strong = false;
};

struct PlateAuthenticityDecision {
    PlateAuthenticityState state = PlateAuthenticityState::Unassessed;
    bool retain_candidate = true;
    bool allow_ocr_confirmation = true;
};

// Blur and small size mean that appearance evidence is unavailable, not that
// the candidate is false. Clear candidates, however, must look like a plate in
// addition to passing YOLO and geometric checks.
inline PlateAuthenticityDecision plateAuthenticityDecision(
        const PlateAuthenticityEvidence &evidence) {
    if (!evidence.assessable) {
        return {PlateAuthenticityState::Unassessed, true, true};
    }

    const bool strongOcr = evidence.ocr_plausible && evidence.ocr_strong;
    const bool ocrReinforced = strongOcr && evidence.detector_strong &&
        (evidence.spatial_support || evidence.glyph_layout ||
         evidence.color_supported);

    if (evidence.grid_pattern && !evidence.glyph_layout) {
        // Grilles remain a hard negative unless three independent signals
        // agree: detector, repeated/global observation, and strong OCR. Color
        // support prevents arbitrary dark grid regions from taking this path.
        if (strongOcr && evidence.detector_strong &&
            evidence.spatial_support && evidence.color_supported) {
            return {PlateAuthenticityState::Supported, true, true};
        }
        return {PlateAuthenticityState::Rejected, false, false};
    }

    const bool visualPair =
        evidence.glyph_layout && evidence.color_supported;
    const bool independentlyReinforced =
        evidence.detector_strong && evidence.spatial_support &&
        (evidence.glyph_layout || evidence.color_supported);
    if (visualPair || independentlyReinforced || ocrReinforced) {
        return {PlateAuthenticityState::Supported, true, true};
    }

    if (!evidence.glyph_layout && !evidence.color_supported) {
        // A clear plate can lose both appearance signals because of glare,
        // unusual colors, or perspective. Preserve repeated detections with a
        // structurally valid OCR result so alternate crops/frames can confirm
        // them, but do not publish a weak single observation.
        if (evidence.ocr_plausible && evidence.detector_strong &&
            evidence.spatial_support) {
            return {PlateAuthenticityState::Ambiguous, true, true};
        }
        return {PlateAuthenticityState::Rejected, false, false};
    }

    // One appearance signal is not enough on its own. Plausible OCR may remain
    // eligible for crop or temporal confirmation; otherwise only retain a
    // strongly repeated candidate for diagnosis.
    const bool ocrConfirmable = evidence.ocr_plausible &&
        evidence.detector_strong && evidence.spatial_support;
    const bool retain = ocrConfirmable ||
        (evidence.detector_strong && evidence.spatial_support);
    return {PlateAuthenticityState::Ambiguous, retain, ocrConfirmable};
}

inline const char *plateAuthenticityName(PlateAuthenticityState state) {
    switch (state) {
    case PlateAuthenticityState::Unassessed: return "unassessed";
    case PlateAuthenticityState::Supported: return "supported";
    case PlateAuthenticityState::Ambiguous: return "ambiguous";
    case PlateAuthenticityState::Rejected: return "rejected";
    }
    return "unknown";
}
