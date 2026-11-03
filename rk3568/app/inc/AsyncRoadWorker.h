#pragma once

#include "RoadInferenceWorker.h"
#include <algorithm>
#include <condition_variable>
#include <mutex>
#include <numeric>
#include <thread>

// One RKNN owner, one replaceable latest mosaic, four independent result caches.
template<class Processor>
class BasicAsyncRoadWorker final {
public:
    BasicAsyncRoadWorker() : m_thread([this] { loop(); }) {}
    ~BasicAsyncRoadWorker() { stop(); }
    void configure(quint64 version, RoadInferenceWorker::Mode mode, int direction,
                   bool lanes, bool lights, unsigned mask) {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (version == m_version) return;
        m_version = version;
        m_mode = mode;
        m_direction = direction;
        m_lanes = lanes;
        m_lights = lights;
        m_mask = mask;
        m_hasJob = m_hasResult = false;
        m_job.frame.release();
        m_cache = m_result = {};
        m_next = 0;
        m_configurationChanged = true;
        m_condition.notify_one();
    }
    void submit(const cv::Mat &frame, quint64 sequence, quint64 version) {
        if (frame.empty() || frame.cols < 2 || frame.rows < 2) return;
        std::lock_guard<std::mutex> lock(m_mutex);
        if (m_stopped || version != m_version || m_mode == RoadInferenceWorker::Mode::Off ||
            (m_mode == RoadInferenceWorker::Mode::Adas && m_mask == 0)) return;
        if (m_hasJob && !m_latestUsed) ++m_dropped;
        m_job = {frame.clone(), sequence, version, std::chrono::steady_clock::now(),
                 m_mode, m_direction, m_lanes, m_lights, m_mask};
        m_hasJob = true;
        m_latestUsed = false;
        m_condition.notify_one();
    }
    bool takeResult(quint64 version, RoadInferenceResult &result) {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (!m_hasResult || version != m_version) return false;
        result = std::move(m_result);
        m_hasResult = false;
        return true;
    }
    quint64 dropped() const {
        std::lock_guard<std::mutex> lock(m_mutex);
        return m_dropped;
    }
    void stop() {
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            m_stopped = true;
            m_hasJob = false;
            m_condition.notify_one();
        }
        if (m_thread.joinable()) m_thread.join();
    }
private:
    struct Job {
        cv::Mat frame;
        quint64 sequence = 0, version = 0;
        std::chrono::steady_clock::time_point at;
        RoadInferenceWorker::Mode mode = RoadInferenceWorker::Mode::Off;
        int direction = -1;
        bool lanes = true, lights = true;
        unsigned mask = 0;
    };
    static constexpr std::array<int, 4> kOrder{{4, 1, 2, 3}};
    bool ready() const {
        const int i = kOrder[m_next] - 1;
        return m_hasJob && (!m_cache.cameraValid[i] ||
                             m_job.sequence != m_cache.cameraFrameSequences[i]);
    }
    void loop() {
        Processor inference;
        for (;;) {
            Job job;
            int source;
            {
                std::unique_lock<std::mutex> lock(m_mutex);
                m_condition.wait(lock, [this] {
                    return m_stopped || ready() || m_configurationChanged;
                });
                if (m_stopped) return;
                if (m_configurationChanged) {
                    m_configurationChanged = false;
                    if (m_mode == RoadInferenceWorker::Mode::Off ||
                        (m_mode == RoadInferenceWorker::Mode::Adas && !m_mask)) {
                        lock.unlock();
                        inference.release();
                        continue;
                    }
                }
                if (!ready()) continue;
                // Immutable owned snapshot; the capture buffer may be reused.
                job = m_job;
                source = kOrder[m_next];
                m_latestUsed = true;
            }
            RoadInferenceResult one;
            one.sourceFrameSequence = job.sequence;
            one.sourceFrameAt = job.at;
            const auto start = std::chrono::steady_clock::now();
            try {
                const int w = job.frame.cols / 2, h = job.frame.rows / 2;
                const int column = (source - 1) % 2, row = (source - 1) / 2;
                const cv::Rect roi(column * w, row * h,
                    column ? job.frame.cols - w : w, row ? job.frame.rows - h : h);
                if (!inference.processSource(job.frame(roi), source, job.mode, job.direction,
                        job.lanes, job.lights, &one, &one.error, job.mask) && one.error.isEmpty())
                    one.error = QStringLiteral("道路模型推理失败");
            } catch (const std::exception &e) {
                one.error = QString::fromLocal8Bit(e.what());
            } catch (...) {
                one.error = QStringLiteral("道路推理发生未知异常");
            }
            const double elapsed = std::chrono::duration<double, std::milli>(
                std::chrono::steady_clock::now() - start).count();
            std::lock_guard<std::mutex> lock(m_mutex);
            if (job.version != m_version || m_stopped) continue;
            if (!one.error.isEmpty()) {
                m_cache = {};
                m_cache.error = one.error;
                m_hasJob = false;
            } else {
                const int i = source - 1;
                auto &boxes = m_cache.detections;
                boxes.erase(std::remove_if(boxes.begin(), boxes.end(), [source](const RoadOverlayDetection &d) {
                    return d.sourceIndex == source;
                }), boxes.end());
                boxes.insert(boxes.end(), one.detections.begin(), one.detections.end());
                m_cache.cameraInferenceMs[i] = elapsed;
                m_cache.cameraFrameSequences[i] = job.sequence;
                m_cache.cameraFrameAt[i] = job.at;
                m_cache.cameraValid[i] = true;
                m_cache.updatedSource = source;
                ++m_cache.completedUpdates;
                // Only source 4 may update the decision and its timestamp.
                if (source == 4) {
                    m_cache.direction = one.direction;
                    m_cache.forbidden = one.forbidden;
                    m_cache.slow = one.slow;
                    m_cache.status = one.status;
                    m_cache.decisionValid = one.decisionValid;
                    m_cache.sourceFrameSequence = job.sequence;
                    m_cache.sourceFrameAt = job.at;
                }
                m_next = (m_next + 1) % kOrder.size();
                if (m_next == 0) ++m_cache.completedCycles;
                m_cache.inferenceMs = std::accumulate(m_cache.cameraInferenceMs.begin(),
                                                       m_cache.cameraInferenceMs.end(), 0.0);
            }
            m_result = m_cache;
            m_hasResult = true;
        }
    }
    mutable std::mutex m_mutex;
    std::condition_variable m_condition;
    Job m_job;
    RoadInferenceResult m_cache, m_result;
    quint64 m_version = 0, m_dropped = 0;
    RoadInferenceWorker::Mode m_mode = RoadInferenceWorker::Mode::Off;
    int m_direction = -1;
    size_t m_next = 0;
    bool m_lanes = true, m_lights = true, m_stopped = false;
    bool m_hasJob = false, m_hasResult = false, m_configurationChanged = false;
    bool m_latestUsed = false;
    unsigned m_mask = 0;
    std::thread m_thread;
};

using AsyncRoadWorker = BasicAsyncRoadWorker<RoadInferenceWorker>;
