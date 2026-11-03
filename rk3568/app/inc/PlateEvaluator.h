#pragma once

#include <QString>
#include <QtGlobal>
#include <functional>

struct PlateEvaluationSummary {
    int totalImages = 0;
    int processedImages = 0;
    int detectedImages = 0;
    int noDetectionImages = 0;
    int failedImages = 0;
    int detectionRows = 0;
    int acceptedOcrRows = 0;
    bool canceled = false;
    qint64 elapsedMs = 0;
    QString csvPath;
};

using PlateEvaluationProgress =
    std::function<bool(int completed, int total, const QString &relativePath)>;

bool exportPlateEvaluationCsv(const QString &imageFolder,
                              const QString &csvPath,
                              const PlateEvaluationProgress &progress,
                              PlateEvaluationSummary &summary,
                              QString &error);
