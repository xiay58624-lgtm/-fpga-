#ifndef CAPTURE_THREAD_H
#define CAPTURE_THREAD_H

#include <QThread>
#include <QImage>
#include <QMutex>
#include <QByteArray>
#include <QString>
#include <QStringList>
#include <QJsonObject>
#include <QDateTime>
#include <opencv2/opencv.hpp>
#include <array>
#include <atomic>
#include <cstdint>
#include <chrono> // 必须包含，用于高精度计时
#include "pcie_dma_read_test.h"
#include "yolo.h"

class CaptureThread : public QThread {
    Q_OBJECT
public:
    enum class InputMode {
        Pcie = 0,
        SdCard = 1
    };

    enum class DisplayMode {
        FpgaMosaic = 0,
        SingleSource = 1,
        CustomMosaic = 2
    };

    enum class AlgoMode {
        PlateOnly = 0,
        EnvOnly = 1,
        Overlay = 2
    };

    explicit CaptureThread(QObject *parent = nullptr);
    ~CaptureThread();

    void startCapture();
    void stop();
    void acknowledgeFrameDelivery() noexcept;

    // The latest FPGA mosaic (source=0) or one of its four 640x360 tiles
    // (source=1..4), encoded on demand so browser requests do not block DMA.
    bool latestFrameJpeg(int source, QByteArray &jpeg,
                         QJsonObject &metadata) const;
    // Implicitly-shared RGB24 mosaic for zero-copy HTTP response preparation.
    bool latestFrameRgb24(QImage &frame, QJsonObject &metadata) const;
    // RGA-converted NV12 mosaic for the hardware H.264 uplink.
    bool latestFrameNv12(QByteArray &pixels, QJsonObject &metadata) const;
    // Most recent environment detections in 1280x720 mosaic coordinates.
    bool latestDetections(QJsonObject &payload) const;

    void setInputMode(InputMode mode);
    void setSdSourcePath(const QString &path);
    void setSdVideoPaths(const QStringList &paths);
    void setSdImageIntervalSeconds(int seconds);
    void setDisplayMode(DisplayMode mode);
    void setSingleSource(int sourceIndex);
    void setMosaicMapping(const std::array<int, 4>& quadrantToSource);
    void setAlgoMode(AlgoMode mode);
    void setGlobalInferenceEnabled(bool enabled);
    void configureRoadInference(int mode, int direction,
                                bool lanesEnabled = true,
                                bool lightsEnabled = true,
                                unsigned adasModelMask = 7) noexcept;
    quint64 displayConfigVersion() const noexcept {
        return m_displayConfigVersion.load(std::memory_order_acquire);
    }

signals:
    /**
     * @brief 图像帧就绪信号
     * @param image 转换后的 QImage，可直接在 QLabel 渲染
     */
    void frameReady(QImage image, quint64 displayConfigVersion);
    void roadInferenceResult(int direction, bool forbidden, bool slow, QString status);
    // Complete synchronized four-camera road inference telemetry for the
    // upper computer. Includes per-source boxes and an optional source-4 crop.
    void roadInferenceTelemetry(QJsonObject payload);
    void roadInferenceError(QString message, quint64 configVersion);
    void captureFailed(QString error);

    /**
     * @brief FPS 更新信号
     * @param fps 按 1000 / 推理耗时(ms) 计算的推理帧率
     */
    void fpsUpdate(double fps);
    void perfUpdate(QString text);
    void slidingStatus(bool enabled, int windowCount,
                       int workWidth, int workHeight);
    // capMs: V1 PCIe DMA duration or SD read/load duration.
    void perfParts(double capMs, double convMs, double viewMs, double detBoxMs, double detOcrMs,
                   double envMs, double uiMs, double totalMs, quint64 pcieRxFrames,
                   bool slidingEnabled, int slidingWindowCount);
    void perfDetParts(double preMs, double npuMs, double postMs);
    void perfDetRuntime(QJsonObject metrics);
    // One source (1..4) of generic YOLO detections for the Wi-Fi upper
    // computer.  This is separate from the legacy plate report signal.
    void detectionsReady(QJsonObject payload);
    void plateReport(QImage thumb, QString plate, QString color, QString time, int source, double recConf, double detConf);
    void violationReport(QByteArray jpeg, QByteArray thumbJpeg, QString time, int viewMode, int singleSource, int q0, int q1, int q2, int q3, double iou);

protected:
    void run() override;

private:
    // 线程控制
    bool m_abort;
    std::atomic_bool m_abortAtomic{false};
    // At most one full GUI frame may be queued across threads. Without this
    // backpressure Qt can retain an unbounded number of 1280x720 QImages.
    std::atomic_bool m_frameDeliveryPending{false};
    std::atomic<quint64> m_displayConfigVersion{1};
    std::atomic_bool m_globalInferenceEnabled{false};
    // Publish the entire road configuration atomically, including its model set.
    std::atomic<unsigned> m_roadConfiguration{0};
    QMutex m_mutex;
    QMutex m_cfgMutex;
    mutable QMutex m_latestFrameMutex;
    QImage m_latestMosaic;
    quint64 m_latestFrameSequence = 0;
    QDateTime m_latestFrameAt;
    QJsonObject m_latestDetections;
    
    // PCIe 与 硬件资源
    int m_fd;
    uint8_t *m_imageBufTemp; // V1 half-sampled 1280x720 RGB565 mosaic.
    uint8_t *m_imageBuf888;  // Native 1280x720 BGR working mosaic.
    uint8_t *m_viewBuf;      // Fixed 1280x720 GUI/environment preview.

    // 性能统计
    double m_fps;
    std::chrono::high_resolution_clock::time_point m_lastFrameTime;

    InputMode m_inputMode;
    QString m_sdSourcePath;
    QStringList m_sdVideoPaths;
    int m_sdImageIntervalSec;
    DisplayMode m_displayMode;
    int m_singleSource;
    std::array<int, 4> m_mosaicMapping;
    AlgoMode m_algoMode;

    // SD card media resume state. Stop/start pauses and continues;
    // changing source or input mode resets these positions.
    QString m_sdResumePath;
    int m_sdResumeImageIndex;
    std::array<int, 4> m_sdResumeQuadImageIndex;
    double m_sdResumeVideoFrame;

    // 内部辅助函数
    void rgb565_to_rgb888(const uint16_t *src, uint8_t *dst, int w, int h);
};

#endif // CAPTURE_THREAD_H
