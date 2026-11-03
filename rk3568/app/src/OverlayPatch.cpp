#include "OverlayPatch.h"

#include <opencv2/core.hpp>
#include <cstddef>
#include <utility>

namespace {

bool validFramePair(const cv::Mat &before, const cv::Mat &after) {
    return !before.empty() && !after.empty() &&
           before.size() == after.size() &&
           before.type() == CV_8UC3 && after.type() == CV_8UC3;
}

bool overlaps(const cv::Rect &left, const cv::Rect &right) {
    return (left & right).area() > 0;
}

}  // namespace

std::vector<cv::Rect> normalizeOverlayRegions(
        const std::vector<cv::Rect> &regions, const cv::Size &frameSize) {
    std::vector<cv::Rect> normalized;
    if (frameSize.width <= 0 || frameSize.height <= 0) return normalized;

    const cv::Rect frameBounds(0, 0, frameSize.width, frameSize.height);
    normalized.reserve(regions.size());
    for (const cv::Rect &candidate : regions) {
        cv::Rect merged = candidate & frameBounds;
        if (merged.empty()) continue;

        for (size_t index = 0; index < normalized.size();) {
            if (!overlaps(merged, normalized[index])) {
                ++index;
                continue;
            }
            merged |= normalized[index];
            normalized.erase(normalized.begin() +
                             static_cast<std::ptrdiff_t>(index));
            index = 0;
        }
        normalized.push_back(merged);
    }
    return normalized;
}

std::vector<OverlayPatch> buildOverlayPatches(
        const cv::Mat &before, const cv::Mat &after,
        const std::vector<cv::Rect> &regions) {
    std::vector<OverlayPatch> patches;
    if (!validFramePair(before, after)) return patches;

    const std::vector<cv::Rect> normalized =
        normalizeOverlayRegions(regions, before.size());
    patches.reserve(normalized.size());
    for (const cv::Rect &region : normalized) {
        cv::Mat difference;
        cv::absdiff(before(region), after(region), difference);

        cv::Mat unchanged;
        cv::inRange(difference, cv::Scalar::all(0), cv::Scalar::all(0),
                    unchanged);

        OverlayPatch patch;
        patch.region = region;
        cv::bitwise_not(unchanged, patch.mask);
        if (cv::countNonZero(patch.mask) == 0) continue;
        patch.image = after(region).clone();
        patches.push_back(std::move(patch));
    }
    return patches;
}

void applyOverlayPatches(cv::Mat &destination,
                         const std::vector<OverlayPatch> &patches) {
    if (destination.empty() || destination.type() != CV_8UC3) return;

    const cv::Rect frameBounds(0, 0, destination.cols, destination.rows);
    for (const OverlayPatch &patch : patches) {
        if (patch.region.empty() || (patch.region & frameBounds) != patch.region ||
            patch.image.size() != patch.region.size() ||
            patch.image.type() != destination.type() ||
            patch.mask.size() != patch.region.size() ||
            patch.mask.type() != CV_8UC1) {
            continue;
        }
        patch.image.copyTo(destination(patch.region), patch.mask);
    }
}
