#pragma once

#include <QDateTime>
#include <QJsonObject>
#include <QMap>
#include <QPair>
#include <QString>
#include <QVector>
#include <QtGlobal>

struct DriverCaptureMetrics {
    bool running = false;
    bool pcie = false;
    bool batchIoctl = false;
    bool irqWait = false;
    bool stagedCopy = false;
    bool frameV2 = false;
    bool mmapEnabled = false;
    bool metricValid = false;
    bool rateControlSupported = false;
    bool fixed30FpsActive = false;
    bool v1FallbackAllowed = false;
    bool v1FallbackActive = false;
    bool sourceLocked = false;
    quint64 framesTotal = 0;
    quint64 droppedFrames = 0;
    quint64 fpgaDroppedFrames = 0;
    quint64 hostDroppedFrames = 0;
    quint64 sequenceGaps = 0;
    quint64 protocolErrors = 0;
    double actualRxFps = 0.0;
    double frameIntervalMs = 0.0;
    double lastCaptureMs = 0.0;
    double dmaWaitMs = 0.0;
    double dmaTransferMs = 0.0;
    double kernelStagingMs = 0.0;
    double userCopyMs = 0.0;
    int dmaUnitBytes = 0;
    int dmaUnitCount = 0;
    int frameWidth = 0;
    int frameHeight = 0;
    int frameStrideBytes = 0;
    int frameBytes = 0;
    int ringCount = 0;
    quint32 driverAbiVersion = 0;
    quint32 driverFeatures = 0;
    quint32 fpgaProtocolVersion = 0;
    quint32 fpgaCapabilities = 0;
    quint32 targetFpsMilli = 0;
    quint32 fpgaTargetFpsMilli = 0;
    quint32 readBarBytes = 0;
    quint32 writeBarBytes = 0;
    quint32 sourceMask = 0;
    quint32 fpgaBuildId = 0;
    quint32 fpgaDebugState = 0;
    quint32 fifoLevel01 = 0;
    quint32 fifoLevel23 = 0;
    quint32 fpgaHandshakeState = 0;
    quint64 recoveryCount = 0;
    int consecutiveTimeouts = 0;
    QString mode;
    QString protocol;
    QString irqMode;
    QString recoveryState;
    QString lastError;
    QString batchFallbackReason;
    QString irqFallbackReason;
    QDateTime lastFrameAt;
};

struct DriverStatusRow {
    QString group;
    QString item;
    QString value;
    QString detail;
};

struct DriverStatusCollectorState {
    QDateTime lastTick;
    qint64 lastIrqSum = -1;
    quint64 lastCpuTotal = 0;
    quint64 lastCpuIdle = 0;
    QMap<QString, QPair<qulonglong, qulonglong>> lastDevfreqUsage;
};

struct DriverStatusSnapshot {
    QVector<DriverStatusRow> rows;
    QJsonObject json;
};

DriverStatusSnapshot collectDriverStatus(DriverStatusCollectorState *state = nullptr);

// Updated by the capture pipeline and read by both the GUI status dialog and
// the cloud status reporter. The mutex is internal to the implementation.
void updateDriverCaptureMetrics(const DriverCaptureMetrics &metrics);
DriverCaptureMetrics currentDriverCaptureMetrics();
