#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <numeric>
#include <vector>

// A small, runtime-independent description of one source-image tile.  Keeping
// this header free of OpenCV/RKNN types makes the window policy easy to test on
// the build host as well as on RK3568.
struct PlateSlidingWindow {
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;
};

struct PlateSlidingWorkSize {
    int width = 0;
    int height = 0;
    float scale = 1.0f;
};

struct PlateSlidingBox {
    float left = 0.0f;
    float top = 0.0f;
    float right = 0.0f;
    float bottom = 0.0f;
};

enum PlateSlidingInternalEdge : uint8_t {
    PlateEdgeNone = 0,
    PlateEdgeLeft = 1U << 0,
    PlateEdgeRight = 1U << 1,
    PlateEdgeTop = 1U << 2,
    PlateEdgeBottom = 1U << 3,
};

enum class PlateFragmentJoinDirection {
    None,
    Horizontal,
    Vertical,
};

struct PlateFragmentJoinDecision {
    PlateFragmentJoinDirection direction = PlateFragmentJoinDirection::None;
    float score = 0.0f;
};

struct PlateSlidingPoint {
    float x = 0.0f;
    float y = 0.0f;
};

struct PlateQuadGeometry {
    float width = 0.0f;
    float height = 0.0f;
    float aspect = 0.0f;
    float area = 0.0f;
    bool convex = false;
};

struct PlateGeometryFilterConfig {
    bool enabled = false;
    float min_short_edge = 8.0f;
    float min_area = 80.0f;
    float min_aspect = 1.0f;
    float max_aspect = 6.5f;
};

enum class PlateGeometryFilterRejectReason {
    None,
    NonConvex,
    ShortEdge,
    Area,
    AspectLow,
    AspectHigh,
};

struct PlateGeometryFilterResult {
    bool keep = true;
    PlateGeometryFilterRejectReason reason =
        PlateGeometryFilterRejectReason::None;
};

inline PlateGeometryFilterResult plateGeometryFilter(
        const PlateQuadGeometry &geometry,
        const PlateGeometryFilterConfig &config) {
    if (!config.enabled) return {};
    if (!geometry.convex) {
        return {false, PlateGeometryFilterRejectReason::NonConvex};
    }

    const float shortEdge = std::min(geometry.width, geometry.height);
    const float longEdge = std::max(geometry.width, geometry.height);
    if (shortEdge < config.min_short_edge) {
        return {false, PlateGeometryFilterRejectReason::ShortEdge};
    }
    if (geometry.area < config.min_area) {
        return {false, PlateGeometryFilterRejectReason::Area};
    }

    const float aspect = shortEdge > 1e-6f ? longEdge / shortEdge : 0.0f;
    if (aspect < config.min_aspect) {
        return {false, PlateGeometryFilterRejectReason::AspectLow};
    }
    if (aspect > config.max_aspect) {
        return {false, PlateGeometryFilterRejectReason::AspectHigh};
    }
    return {};
}

// Limit very large still images before tiling. Detection coordinates are
// mapped back to the original frame after cross-window NMS, so OCR still uses
// the full-resolution source pixels. maxSide=0 keeps native-resolution tiles.
inline PlateSlidingWorkSize plateSlidingWorkSize(int imageWidth, int imageHeight,
                                                 int maxSide) {
    PlateSlidingWorkSize result{imageWidth, imageHeight, 1.0f};
    if (imageWidth <= 0 || imageHeight <= 0 || maxSide <= 0) return result;

    const int longest = std::max(imageWidth, imageHeight);
    if (longest <= maxSide) return result;

    result.scale = static_cast<float>(maxSide) / static_cast<float>(longest);
    result.width = std::max(1, static_cast<int>(std::lround(imageWidth * result.scale)));
    result.height = std::max(1, static_cast<int>(std::lround(imageHeight * result.scale)));
    return result;
}

inline std::vector<int> plateSlidingStarts(int extent, int window, int stride) {
    std::vector<int> starts;
    if (extent <= 0 || window <= 0 || stride <= 0) return starts;
    if (extent <= window) {
        starts.push_back(0);
        return starts;
    }

    for (int pos = 0; pos + window <= extent; pos += stride) {
        starts.push_back(pos);
    }
    const int last = extent - window;
    if (starts.empty() || starts.back() != last) starts.push_back(last);
    return starts;
}

// For a source smaller than one model window, use one full-source tile.  This
// mirrors the reference implementation and avoids creating an artificial
// second crop when (for example) a night image is only 538 pixels high.
inline std::vector<PlateSlidingWindow> makePlateSlidingWindows(
        int imageWidth, int imageHeight, int window = 640, int stride = 320) {
    std::vector<PlateSlidingWindow> result;
    if (imageWidth <= 0 || imageHeight <= 0 || window <= 0 || stride <= 0) {
        return result;
    }

    // Tile the two axes independently. A wide 811x538 image still needs two
    // horizontal windows even though its short side is below 640 pixels.
    const int tileWidth = std::min(imageWidth, window);
    const int tileHeight = std::min(imageHeight, window);
    const std::vector<int> xs = plateSlidingStarts(imageWidth, tileWidth, stride);
    const std::vector<int> ys = plateSlidingStarts(imageHeight, tileHeight, stride);
    result.reserve(xs.size() * ys.size());
    for (int y : ys) {
        for (int x : xs) result.push_back({x, y, tileWidth, tileHeight});
    }
    return result;
}

// Video capture already provides one complete 720-line source. Sliding that
// axis by only 80 pixels duplicates almost the entire image, so live PCIe
// inference scans full-height vertical strips and overlaps only horizontally.
inline std::vector<PlateSlidingWindow> makePlateFullHeightStrips(
        int imageWidth, int imageHeight, int stripWidth = 640,
        int stride = 320) {
    std::vector<PlateSlidingWindow> result;
    if (imageWidth <= 0 || imageHeight <= 0 || stripWidth <= 0 || stride <= 0) {
        return result;
    }

    const int width = std::min(imageWidth, stripWidth);
    const std::vector<int> xs = plateSlidingStarts(imageWidth, width, stride);
    result.reserve(xs.size());
    for (int x : xs) result.push_back({x, 0, width, imageHeight});
    return result;
}

// Mark only crop edges that have another overlapping crop behind them. A
// detection touching a physical source-image edge is still valid, while one
// touching an internal strip edge may be only a partial plate.
inline uint8_t plateSlidingInternalEdgeMask(
        const PlateSlidingBox &box, const PlateSlidingWindow &window,
        int imageWidth, int imageHeight, float margin) {
    uint8_t mask = PlateEdgeNone;
    const float safeMargin = std::max(0.0f, margin);
    if (window.x > 0 && box.left <= window.x + safeMargin) {
        mask |= PlateEdgeLeft;
    }
    if (window.x + window.width < imageWidth &&
        box.right >= window.x + window.width - safeMargin) {
        mask |= PlateEdgeRight;
    }
    if (window.y > 0 && box.top <= window.y + safeMargin) {
        mask |= PlateEdgeTop;
    }
    if (window.y + window.height < imageHeight &&
        box.bottom >= window.y + window.height - safeMargin) {
        mask |= PlateEdgeBottom;
    }
    return mask;
}

// Sliding crops preserve small targets, while one global pass preserves plates
// that are large enough to span a crop boundary. Avoid a duplicate global pass
// when the whole image already fits in one detector window.
inline bool plateSlidingNeedsGlobalPass(int imageWidth, int imageHeight,
                                        int window = 640) {
    return imageWidth > window || imageHeight > window;
}

inline float platePointDistance(const PlateSlidingPoint &a,
                                const PlateSlidingPoint &b) {
    return std::hypot(a.x - b.x, a.y - b.y);
}

inline float platePointCross(const PlateSlidingPoint &a,
                             const PlateSlidingPoint &b,
                             const PlateSlidingPoint &c) {
    return (b.x - a.x) * (c.y - b.y) -
           (b.y - a.y) * (c.x - b.x);
}

// Points are TL, TR, BR, BL. Measuring the actual quadrilateral edges keeps a
// rotated plate's aspect ratio stable; an axis-aligned bounding box does not.
inline PlateQuadGeometry plateQuadGeometry(
        const std::array<PlateSlidingPoint, 4> &points) {
    PlateQuadGeometry result;
    result.width = 0.5f * (platePointDistance(points[0], points[1]) +
                           platePointDistance(points[3], points[2]));
    result.height = 0.5f * (platePointDistance(points[0], points[3]) +
                            platePointDistance(points[1], points[2]));
    result.aspect = result.height > 1e-6f ? result.width / result.height : 0.0f;

    float twiceArea = 0.0f;
    for (size_t i = 0; i < points.size(); ++i) {
        const PlateSlidingPoint &a = points[i];
        const PlateSlidingPoint &b = points[(i + 1) % points.size()];
        twiceArea += a.x * b.y - a.y * b.x;
    }
    result.area = std::fabs(twiceArea) * 0.5f;

    float direction = 0.0f;
    result.convex = true;
    for (size_t i = 0; i < points.size(); ++i) {
        const float cross = platePointCross(
            points[i], points[(i + 1) % points.size()],
            points[(i + 2) % points.size()]);
        if (std::fabs(cross) <= 1e-4f) {
            result.convex = false;
            break;
        }
        if (direction == 0.0f) direction = cross;
        else if ((direction > 0.0f) != (cross > 0.0f)) {
            result.convex = false;
            break;
        }
    }
    return result;
}

inline float plateSlidingIou(const PlateSlidingBox &a, const PlateSlidingBox &b) {
    const float left = std::max(a.left, b.left);
    const float top = std::max(a.top, b.top);
    const float right = std::min(a.right, b.right);
    const float bottom = std::min(a.bottom, b.bottom);
    const float iw = std::max(0.0f, right - left);
    const float ih = std::max(0.0f, bottom - top);
    const float intersection = iw * ih;
    const float areaA = std::max(0.0f, a.right - a.left) *
                        std::max(0.0f, a.bottom - a.top);
    const float areaB = std::max(0.0f, b.right - b.left) *
                        std::max(0.0f, b.bottom - b.top);
    const float unionArea = areaA + areaB - intersection;
    return unionArea > 1e-6f ? intersection / unionArea : 0.0f;
}

inline float plateSlidingIntersectionOverSmaller(const PlateSlidingBox &a,
                                                  const PlateSlidingBox &b) {
    const float left = std::max(a.left, b.left);
    const float top = std::max(a.top, b.top);
    const float right = std::min(a.right, b.right);
    const float bottom = std::min(a.bottom, b.bottom);
    const float intersection = std::max(0.0f, right - left) *
                               std::max(0.0f, bottom - top);
    const float areaA = std::max(0.0f, a.right - a.left) *
                        std::max(0.0f, a.bottom - a.top);
    const float areaB = std::max(0.0f, b.right - b.left) *
                        std::max(0.0f, b.bottom - b.top);
    const float smaller = std::min(areaA, areaB);
    return smaller > 1e-6f ? intersection / smaller : 0.0f;
}

inline float plateSlidingBoxArea(const PlateSlidingBox &box) {
    return std::max(0.0f, box.right - box.left) *
           std::max(0.0f, box.bottom - box.top);
}

// Prefer a global observation only when it is materially more complete than a
// local observation. Similar-sized local boxes retain their higher-resolution
// landmarks and continue to compete by detector score.
inline bool plateSlidingGlobalSupersedesFragment(
        const PlateSlidingBox &globalBox,
        const PlateSlidingBox &localBox) {
    const float globalArea = plateSlidingBoxArea(globalBox);
    const float localArea = plateSlidingBoxArea(localBox);
    if (globalArea <= 1.0f || localArea <= 1.0f ||
        globalArea < 1.18f * localArea) {
        return false;
    }
    if (plateSlidingIntersectionOverSmaller(globalBox, localBox) < 0.70f) {
        return false;
    }

    const float globalWidth = globalBox.right - globalBox.left;
    const float globalHeight = globalBox.bottom - globalBox.top;
    const float globalCenterX = 0.5f * (globalBox.left + globalBox.right);
    const float globalCenterY = 0.5f * (globalBox.top + globalBox.bottom);
    const float localCenterX = 0.5f * (localBox.left + localBox.right);
    const float localCenterY = 0.5f * (localBox.top + localBox.bottom);
    const float centerDistance = std::hypot(
        globalCenterX - localCenterX, globalCenterY - localCenterY);
    const float globalDiagonal = std::max(
        1.0f, std::hypot(globalWidth, globalHeight));
    return centerDistance <= 0.28f * globalDiagonal;
}

inline float plateSlidingIntervalOverlap(float a0, float a1,
                                         float b0, float b1) {
    return std::max(0.0f, std::min(a1, b1) - std::max(a0, b0));
}

inline float plateSlidingIntervalGap(float a0, float a1,
                                     float b0, float b1) {
    if (a1 < b0) return b0 - a1;
    if (b1 < a0) return a0 - b1;
    return 0.0f;
}

// A sliding-window boundary can leave two predictions on different visible
// parts of one plate. Compact non-overlapping halves are joined conservatively.
// Wide fragments are joined only when they overlap and carry complementary
// crop-edge evidence, which distinguishes them from adjacent complete plates.
inline PlateFragmentJoinDecision plateSlidingFragmentJoin(
        const PlateSlidingBox &a, const PlateSlidingBox &b,
        int classA, int classB, uint8_t edgeMaskA, uint8_t edgeMaskB,
        const PlateSlidingWindow *windowA = nullptr,
        const PlateSlidingWindow *windowB = nullptr) {
    const float widthA = a.right - a.left;
    const float heightA = a.bottom - a.top;
    const float widthB = b.right - b.left;
    const float heightB = b.bottom - b.top;
    if (widthA <= 1.0f || heightA <= 1.0f ||
        widthB <= 1.0f || heightB <= 1.0f) {
        return {};
    }

    const float aspectA = widthA / heightA;
    const float aspectB = widthB / heightB;
    const float centerAx = 0.5f * (a.left + a.right);
    const float centerAy = 0.5f * (a.top + a.bottom);
    const float centerBx = 0.5f * (b.left + b.right);
    const float centerBy = 0.5f * (b.top + b.bottom);
    const bool aIsLeft = centerAx <= centerBx;
    const bool aIsTop = centerAy <= centerBy;
    const bool complementaryHorizontalEdges = aIsLeft
        ? ((edgeMaskA & PlateEdgeRight) != 0 &&
           (edgeMaskB & PlateEdgeLeft) != 0)
        : ((edgeMaskB & PlateEdgeRight) != 0 &&
           (edgeMaskA & PlateEdgeLeft) != 0);
    const bool complementaryVerticalEdges = aIsTop
        ? ((edgeMaskA & PlateEdgeBottom) != 0 &&
           (edgeMaskB & PlateEdgeTop) != 0)
        : ((edgeMaskB & PlateEdgeBottom) != 0 &&
           (edgeMaskA & PlateEdgeTop) != 0);

    // Landmark regression does not always end exactly at the crop boundary.
    // Use the originating windows as independent evidence when two overlapping
    // horizontal tiles observe aligned parts of the same source-image region.
    bool horizontalWindowEvidence = false;
    if (windowA && windowB && windowA->x != windowB->x) {
        const float windowALeft = static_cast<float>(windowA->x);
        const float windowARight = windowALeft + windowA->width;
        const float windowATop = static_cast<float>(windowA->y);
        const float windowABottom = windowATop + windowA->height;
        const float windowBLeft = static_cast<float>(windowB->x);
        const float windowBRight = windowBLeft + windowB->width;
        const float windowBTop = static_cast<float>(windowB->y);
        const float windowBBottom = windowBTop + windowB->height;
        const float sharedLeft = std::max(windowALeft, windowBLeft);
        const float sharedRight = std::min(windowARight, windowBRight);
        const float sharedTop = std::max(windowATop, windowBTop);
        const float sharedBottom = std::min(windowABottom, windowBBottom);
        const float tolerance = std::max(24.0f, 0.75f *
            std::max(heightA, heightB));
        const bool aMeetsSharedStrip =
            a.right >= sharedLeft - tolerance &&
            a.left <= sharedRight + tolerance;
        const bool bMeetsSharedStrip =
            b.right >= sharedLeft - tolerance &&
            b.left <= sharedRight + tolerance;
        const bool centerOrderMatches = windowA->x < windowB->x
            ? centerAx <= centerBx + tolerance
            : centerBx <= centerAx + tolerance;
        horizontalWindowEvidence = sharedRight > sharedLeft &&
            sharedBottom > sharedTop && aMeetsSharedStrip &&
            bMeetsSharedStrip && centerOrderMatches;
    }

    const float verticalOverlap = plateSlidingIntervalOverlap(
        a.top, a.bottom, b.top, b.bottom);
    const float verticalOverlapRatio = verticalOverlap /
        std::max(1.0f, std::min(heightA, heightB));
    const float heightSimilarity = std::min(heightA, heightB) /
        std::max(heightA, heightB);
    const float horizontalGap = plateSlidingIntervalGap(
        a.left, a.right, b.left, b.right);
    const float unionWidth = std::max(a.right, b.right) -
                             std::min(a.left, b.left);
    const float unionHeight = std::max(a.bottom, b.bottom) -
                              std::min(a.top, b.top);
    const float unionAspect = unionWidth / std::max(1.0f, unionHeight);
    const float horizontalOverlap = plateSlidingIntervalOverlap(
        a.left, a.right, b.left, b.right);
    const float horizontalOverlapRatio = horizontalOverlap /
        std::max(1.0f, std::min(widthA, widthB));

    const float horizontalMinAspect = (classA == 1 && classB == 1) ? 0.9f : 1.6f;
    const float horizontalMaxAspect = (classA == 1 && classB == 1) ? 3.5f : 7.5f;

    // With 50% overlap, a plate wider than the overlap can be truncated by
    // both neighboring windows. Those fragments are often already wide and
    // overlap heavily, so the compact-fragment rule below cannot identify
    // them. Complementary right/left edge evidence makes this merge safe.
    if ((complementaryHorizontalEdges || horizontalWindowEvidence) &&
        horizontalOverlapRatio >= 0.12f &&
        verticalOverlapRatio >= 0.68f && heightSimilarity >= 0.50f &&
        unionAspect >= horizontalMinAspect && unionAspect <= 9.0f) {
        return {PlateFragmentJoinDirection::Horizontal,
                4.0f + 2.0f * verticalOverlapRatio + heightSimilarity +
                    horizontalOverlapRatio};
    }

    const bool bothDoubleLayer = classA == 1 && classB == 1;
    const float fragmentMaxAspect = bothDoubleLayer
        ? (horizontalWindowEvidence ? 1.8f : 1.2f)
        : (horizontalWindowEvidence ? 3.25f : 2.6f);
    const bool compactHorizontalFragments =
        aspectA <= fragmentMaxAspect && aspectB <= fragmentMaxAspect;
    const bool closeWithoutEdge = horizontalGap <= 0.20f *
        std::max(heightA, heightB);
    if (compactHorizontalFragments && verticalOverlapRatio >= 0.62f &&
        heightSimilarity >= 0.55f &&
        horizontalGap <= 0.85f * std::max(heightA, heightB) &&
        unionAspect >= horizontalMinAspect && unionAspect <= horizontalMaxAspect &&
        (complementaryHorizontalEdges || horizontalWindowEvidence ||
         closeWithoutEdge)) {
        const float gapPenalty = horizontalGap /
            std::max(1.0f, std::max(heightA, heightB));
        return {PlateFragmentJoinDirection::Horizontal,
                2.0f * verticalOverlapRatio + heightSimilarity - gapPenalty};
    }

    // A vertical join is only plausible for a double-layer plate. This also
    // covers a horizontal sliding boundary cutting its upper and lower rows.
    const float verticalJoinHorizontalOverlap = plateSlidingIntervalOverlap(
        a.left, a.right, b.left, b.right);
    const float verticalJoinOverlapRatio = verticalJoinHorizontalOverlap /
        std::max(1.0f, std::min(widthA, widthB));
    const float widthSimilarity = std::min(widthA, widthB) /
        std::max(widthA, widthB);
    const float verticalGap = plateSlidingIntervalGap(
        a.top, a.bottom, b.top, b.bottom);
    const bool compactVerticalFragments = aspectA >= 1.0f && aspectB >= 1.0f;
    const bool verticalClassEvidence = classA == 1 || classB == 1;
    const bool closeVerticalWithoutEdge = verticalGap <= 0.15f *
        std::max(heightA, heightB);
    if (verticalClassEvidence && compactVerticalFragments &&
        verticalJoinOverlapRatio >= 0.68f && widthSimilarity >= 0.55f &&
        verticalGap <= 0.60f * std::max(heightA, heightB) &&
        unionAspect >= 0.65f && unionAspect <= 2.6f &&
        (complementaryVerticalEdges || closeVerticalWithoutEdge)) {
        const float gapPenalty = verticalGap /
            std::max(1.0f, std::max(heightA, heightB));
        return {PlateFragmentJoinDirection::Vertical,
                2.0f * verticalJoinOverlapRatio + widthSimilarity - gapPenalty};
    }

    return {};
}

// A single-window candidate must pass the configured final detector score.
// Matching observations from at least two windows are retained for OCR, which
// is the final guard against low-score reconstruction false positives.
inline bool plateSlidingCandidateHasEvidence(float score,
                                             float finalThreshold,
                                             int windowSupport) {
    return score >= finalThreshold || windowSupport >= 2;
}

// Return a positive score when two detections are spatially consistent enough
// to represent the same plate in consecutive detector updates.
inline float plateSlidingTrackMatchScore(const PlateSlidingBox &a,
                                         const PlateSlidingBox &b) {
    const float widthA = a.right - a.left;
    const float heightA = a.bottom - a.top;
    const float widthB = b.right - b.left;
    const float heightB = b.bottom - b.top;
    if (widthA <= 1.0f || heightA <= 1.0f ||
        widthB <= 1.0f || heightB <= 1.0f) {
        return -1.0f;
    }

    const float widthSimilarity = std::min(widthA, widthB) /
        std::max(widthA, widthB);
    const float heightSimilarity = std::min(heightA, heightB) /
        std::max(heightA, heightB);
    const float sizeSimilarity = widthSimilarity * heightSimilarity;
    if (sizeSimilarity < 0.28f) return -1.0f;

    const float iou = plateSlidingIou(a, b);
    const float ios = plateSlidingIntersectionOverSmaller(a, b);
    const float centerAx = 0.5f * (a.left + a.right);
    const float centerAy = 0.5f * (a.top + a.bottom);
    const float centerBx = 0.5f * (b.left + b.right);
    const float centerBy = 0.5f * (b.top + b.bottom);
    const float centerDistance = std::hypot(centerAx - centerBx,
                                            centerAy - centerBy);
    const float referenceDiagonal = std::max(
        12.0f, 0.5f * (std::hypot(widthA, heightA) +
                       std::hypot(widthB, heightB)));
    const float normalizedDistance = centerDistance / referenceDiagonal;

    if (iou >= 0.12f || ios >= 0.45f) {
        return 3.0f * iou + ios + sizeSimilarity - normalizedDistance;
    }
    if (normalizedDistance <= 0.35f && sizeSimilarity >= 0.55f) {
        return 1.0f + sizeSimilarity - normalizedDistance;
    }
    return -1.0f;
}

// Hidden adaptive tracks may move by roughly one plate width before their ROI
// is scanned again. This fallback is intentionally distance-limited and is
// used only for hidden tracks from the same physical source.
inline float plateSlidingHiddenTrackReacquireScore(
        const PlateSlidingBox &a, const PlateSlidingBox &b) {
    const float widthA = a.right - a.left;
    const float heightA = a.bottom - a.top;
    const float widthB = b.right - b.left;
    const float heightB = b.bottom - b.top;
    if (widthA <= 1.0f || heightA <= 1.0f ||
        widthB <= 1.0f || heightB <= 1.0f) {
        return -1.0f;
    }
    const float sizeSimilarity =
        (std::min(widthA, widthB) / std::max(widthA, widthB)) *
        (std::min(heightA, heightB) / std::max(heightA, heightB));
    if (sizeSimilarity < 0.20f) return -1.0f;

    const float centerDistance = std::hypot(
        0.5f * (a.left + a.right - b.left - b.right),
        0.5f * (a.top + a.bottom - b.top - b.bottom));
    const float referenceDiagonal = 0.5f *
        (std::hypot(widthA, heightA) + std::hypot(widthB, heightB));
    const float allowedDistance = std::clamp(
        0.90f * referenceDiagonal, 24.0f, 64.0f);
    if (centerDistance > allowedDistance) return -1.0f;
    return 0.5f + sizeSimilarity - centerDistance / allowedDistance;
}

// Cross-window NMS is intentionally class-agnostic.  A plate detected as
// single-layer in one tile and double-layer in its neighbor still represents
// one physical plate and must produce one OCR/report event.
inline std::vector<int> plateSlidingNms(const std::vector<PlateSlidingBox> &boxes,
                                        const std::vector<float> &scores,
                                        const std::vector<bool> &touchesInternalEdge,
                                        float iouThreshold = 0.3f,
                                        float iosThreshold = 0.65f) {
    const size_t count = std::min(boxes.size(), scores.size());
    std::vector<int> order(count);
    std::iota(order.begin(), order.end(), 0);
    const auto isEdge = [&touchesInternalEdge](int index) {
        return static_cast<size_t>(index) < touchesInternalEdge.size() &&
               touchesInternalEdge[static_cast<size_t>(index)];
    };
    std::stable_sort(order.begin(), order.end(), [&](int a, int b) {
        const bool edgeA = isEdge(a);
        const bool edgeB = isEdge(b);
        if (edgeA != edgeB) return !edgeA;
        if (scores[(size_t)a] != scores[(size_t)b]) {
            return scores[(size_t)a] > scores[(size_t)b];
        }
        return plateSlidingBoxArea(boxes[(size_t)a]) >
               plateSlidingBoxArea(boxes[(size_t)b]);
    });

    std::vector<int> keep;
    while (!order.empty()) {
        const int current = order.front();
        keep.push_back(current);
        std::vector<int> remaining;
        remaining.reserve(order.size() - 1);
        for (size_t i = 1; i < order.size(); ++i) {
            const PlateSlidingBox &candidate = boxes[(size_t)order[i]];
            const float iou = plateSlidingIou(boxes[(size_t)current], candidate);
            const float ios = plateSlidingIntersectionOverSmaller(
                boxes[(size_t)current], candidate);
            if (iou <= iouThreshold && ios <= iosThreshold) {
                remaining.push_back(order[i]);
            }
        }
        order.swap(remaining);
    }
    return keep;
}


inline std::vector<int> plateSlidingNms(const std::vector<PlateSlidingBox> &boxes,
                                        const std::vector<float> &scores,
                                        float iouThreshold = 0.3f,
                                        float iosThreshold = 0.65f) {
    return plateSlidingNms(boxes, scores, {}, iouThreshold, iosThreshold);
}
