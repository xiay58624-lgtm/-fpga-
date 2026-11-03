#include "AsyncRoadWorker.h"
#include <QCoreApplication>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <iostream>
#include <thread>
#include <stdexcept>

static RoadInferenceResult waitFor(AsyncRoadWorker &worker, quint64 version,
                                   quint64 sequence) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(60);
    while (std::chrono::steady_clock::now() < deadline) {
        RoadInferenceResult result;
        if (worker.takeResult(version, result)) {
            if (!result.error.isEmpty()) throw std::runtime_error(result.error.toStdString());
            if (result.sourceFrameSequence != sequence)
                throw std::runtime_error("obsolete configuration/frame was delivered");
            if (!std::all_of(result.cameraValid.begin(), result.cameraValid.end(),
                             [](bool valid) { return valid; })) continue;
            if (result.completedCycles < 1) continue;
            return result;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    throw std::runtime_error("asynchronous result timeout");
}

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    try {
        if (argc != 5) throw std::runtime_error("vehicles lines lights report required");
        cv::Mat mosaic(720, 1280, CV_8UC3);
        for (int i = 0; i < 4; ++i) {
            cv::Mat image = cv::imread(argv[1 + i % 3]);
            if (image.empty()) throw std::runtime_error("sample missing");
            cv::Mat tile = mosaic(cv::Rect((i % 2) * 640, (i / 2) * 360, 640, 360));
            tile.setTo(cv::Scalar());
            const double scale = std::min(640.0 / image.cols, 360.0 / image.rows);
            const int w = std::lround(image.cols * scale), h = std::lround(image.rows * scale);
            cv::Mat roi = tile(cv::Rect((640 - w) / 2, (360 - h) / 2, w, h));
            cv::resize(image, roi, roi.size());
        }
        AsyncRoadWorker worker;
        worker.configure(1, RoadInferenceWorker::Mode::Adas, -1, true, true, 7);
        worker.submit(mosaic, 101, 1);
        std::this_thread::sleep_for(std::chrono::milliseconds(40));
        // Switch while all-model inference is in flight. Its results must be discarded.
        worker.configure(2, RoadInferenceWorker::Mode::Adas, -1, false, false, 1);
        worker.submit(mosaic, 201, 2);
        const auto vehicles = waitFor(worker, 2, 201);
        if (vehicles.detections.empty()) throw std::runtime_error("vehicles result empty");
        for (const auto &d : vehicles.detections)
            if (d.modelId != 0) throw std::runtime_error("deselected model survived generation switch");
        worker.configure(3, RoadInferenceWorker::Mode::Adas, -1, false, false, 0);
        worker.submit(mosaic, 301, 3);
        std::this_thread::sleep_for(std::chrono::milliseconds(300));
        RoadInferenceResult disabled;
        if (worker.takeResult(3, disabled)) throw std::runtime_error("disabled selection produced a result");
        worker.configure(4, RoadInferenceWorker::Mode::Adas, -1, false, true, 4);
        worker.submit(mosaic, 401, 4);
        const auto lights = waitFor(worker, 4, 401);
        if (lights.detections.empty()) throw std::runtime_error("lights result empty");
        for (const auto &d : lights.detections)
            if (d.modelId != 2) throw std::runtime_error("incorrect model after re-enable");
        worker.configure(5, RoadInferenceWorker::Mode::Off, -1, false, false, 0);
        worker.stop();
        QFile report(QString::fromLocal8Bit(argv[4]));
        if (!report.open(QIODevice::WriteOnly)) throw std::runtime_error("report write failed");
        report.write(QJsonDocument(QJsonObject{{"ok", true},
            {"discarded_inflight_generation", true}, {"disabled_no_result", true},
            {"vehicles_boxes", int(vehicles.detections.size())},
            {"vehicles_ms", vehicles.inferenceMs},
            {"lights_boxes", int(lights.detections.size())},
            {"lights_ms", lights.inferenceMs},
            {"no_cross_model_leak", true}}).toJson());
        std::cout << "async selection/in-flight cancellation/re-enable: PASS\n";
        return 0;
    } catch (const std::exception &e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
