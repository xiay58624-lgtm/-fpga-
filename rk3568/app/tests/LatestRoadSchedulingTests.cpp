#include "AsyncRoadWorker.h"
#include <atomic>
#include <iostream>
#include <stdexcept>

namespace {
std::mutex gateMutex;
std::condition_variable gateCondition;
struct Call { int source, pixel; };
std::vector<Call> calls;
int permits = 0;
bool drain = false;

void require(bool ok, const char *message) {
    if (!ok) throw std::runtime_error(message);
}
void waitCalls(size_t count) {
    std::unique_lock<std::mutex> lock(gateMutex);
    require(gateCondition.wait_for(lock, std::chrono::seconds(5), [=] {
        return calls.size() >= count;
    }), "inference did not start");
}
void advance() {
    std::lock_guard<std::mutex> lock(gateMutex);
    ++permits;
    gateCondition.notify_all();
}
void unblock() {
    std::lock_guard<std::mutex> lock(gateMutex);
    drain = true;
    gateCondition.notify_all();
}
struct Processor {
    void release() {}
    bool processSource(const cv::Mat &frame, int source, RoadInferenceWorker::Mode,
                       int, bool, bool, RoadInferenceResult *out, QString *, unsigned mask) {
        {
            std::unique_lock<std::mutex> lock(gateMutex);
            calls.push_back({source, frame.at<cv::Vec3b>(0, 0)[0]});
            gateCondition.notify_all();
            gateCondition.wait(lock, [] { return permits > 0 || drain; });
            if (permits > 0) --permits;
        }
        out->direction = source;
        out->decisionValid = source == 4;
        out->detections.push_back({source, int(mask), .8f, cv::Rect(0, 0, 1, 1), {}, int(mask), {}});
        return true;
    }
};
using Worker = BasicAsyncRoadWorker<Processor>;
RoadInferenceResult result(Worker &worker, quint64 version, quint64 updates) {
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < deadline) {
        RoadInferenceResult r;
        if (worker.takeResult(version, r) && r.completedUpdates >= updates) return r;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    throw std::runtime_error("result timeout");
}
}

int main() {
    Worker worker;
    try {
        worker.configure(1, RoadInferenceWorker::Mode::Adas, 0, false, false, 1);
        cv::Mat first(4, 4, CV_8UC3, cv::Scalar(11, 11, 11));
        worker.submit(first, 101, 1);
        waitCalls(1);
        require(calls[0].source == 4, "source 4 was not prioritized");
        cv::Mat newer(4, 4, CV_8UC3, cv::Scalar(22, 22, 22));
        worker.submit(newer, 102, 1);
        newer.setTo(cv::Scalar(99, 99, 99));
        advance();
        waitCalls(2);
        const auto a = result(worker, 1, 1);
        require(a.updatedSource == 4 && a.detections.size() == 1 && !a.completedCycles,
                "first camera waited for full round or inflated cycles");
        require(calls[1].source == 1 && calls[1].pixel == 22,
                "next camera did not use newest owned snapshot");
        advance();
        waitCalls(3);
        const auto b = result(worker, 1, 2);
        require(b.detections.size() == 2 && b.cameraFrameSequences[3] == 101 &&
                b.cameraFrameSequences[0] == 102, "camera caches lost or mislabeled");
        require(b.direction == 4 && b.sourceFrameSequence == 101,
                "non-decision camera overwrote source 4 decision");
        advance(); waitCalls(4); advance(); waitCalls(5);
        const auto c = result(worker, 1, 4);
        require(c.completedCycles == 1 && c.detections.size() == 4,
                "four-camera fairness/cache/cycle count broken");
        // A new configuration invalidates a running source as well as cached boxes.
        worker.configure(2, RoadInferenceWorker::Mode::Adas, 0, false, false, 4);
        worker.submit(first, 201, 2);
        advance(); waitCalls(6);
        RoadInferenceResult old;
        require(!worker.takeResult(2, old), "in-flight obsolete result leaked");
        advance(); waitCalls(7);
        const auto d = result(worker, 2, 1);
        require(d.sourceFrameSequence == 201 && d.detections.size() == 1 &&
                d.detections[0].modelId == 4 && !d.completedCycles,
                "new generation inherited old cache/model/counters");
        worker.configure(3, RoadInferenceWorker::Mode::Adas, 0, false, false, 0);
        worker.submit(first, 301, 3);
        advance();
        std::this_thread::sleep_for(std::chrono::milliseconds(30));
        require(!worker.takeResult(3, old), "disabled selection produced result");
        worker.configure(4, RoadInferenceWorker::Mode::Navigation, 0, false, false, 0);
        worker.submit(first, 401, 4);
        waitCalls(8); advance(); waitCalls(9);
        const auto e = result(worker, 4, 1);
        require(e.updatedSource == 4 && e.sourceFrameSequence == 401,
                "navigation did not resume with source 4");
        unblock();
        // Finish the single submission, then stop; no same-frame busy loop.
        waitCalls(11);
        std::this_thread::sleep_for(std::chrono::milliseconds(30));
        {
            std::lock_guard<std::mutex> lock(gateMutex);
            require(calls.size() == 11, "same input repeatedly inferred without new frames");
        }
        worker.stop();
        std::cout << "PASS: partial publish, latest snapshot, owned pixels, independent caches/ages, "
                     "source4 decisions, fairness, exact cycles, cancellation, disable, navigation, idle\n";
        return 0;
    } catch (const std::exception &e) {
        unblock(); worker.stop();
        std::cerr << e.what() << '\n';
        return 1;
    }
}
