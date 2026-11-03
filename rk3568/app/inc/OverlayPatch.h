#pragma once

#include <opencv2/core/mat.hpp>
#include <opencv2/core/types.hpp>
#include <vector>

struct OverlayPatch {
    cv::Rect region;
    cv::Mat image;
    cv::Mat mask;
};

std::vector<cv::Rect> normalizeOverlayRegions(
    const std::vector<cv::Rect> &regions, const cv::Size &frameSize);

std::vector<OverlayPatch> buildOverlayPatches(
    const cv::Mat &before, const cv::Mat &after,
    const std::vector<cv::Rect> &regions);

void applyOverlayPatches(cv::Mat &destination,
                         const std::vector<OverlayPatch> &patches);
