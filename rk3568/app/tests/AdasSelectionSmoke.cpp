#include "AdasModelSet.h"
#include <QCoreApplication>
#include <QJsonObject>
#include <QJsonArray>
#include <QJsonDocument>
#include <QFile>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <chrono>
#include <array>
#include <iostream>
#include <cmath>
#include <stdexcept>

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    try {
        if (argc != 5) throw std::runtime_error("vehicles.jpg lines.jpg lights.jpg report.json required");
        std::array<cv::Mat, 3> images;
        for (int i = 0; i < 3; ++i) {
            images[i] = cv::imread(argv[i + 1]);
            if (images[i].empty()) throw std::runtime_error("test image missing");
        }
        adas_models::ModelSet models;
        QJsonArray checks;
        // Include disabling all, partial deselection, and re-enabling models.
        for (unsigned mask : {1u, 2u, 4u, 3u, 5u, 6u, 7u, 0u, 1u}) {
            std::string error;
            if (!models.select(mask, &error)) throw std::runtime_error(error);
            for (int sample = 0; sample < 3; ++sample) {
                const auto start = std::chrono::steady_clock::now();
                const auto detections = models.detect(images[sample]);
                QJsonArray boxes;
                bool ownPositive = false;
                cv::Mat annotated = images[sample].clone();
                for (const auto &d : detections) {
                    if (d.modelId < 0 || d.modelId > 2 || !(mask & (1u << d.modelId)))
                        throw std::runtime_error("unchecked model leaked a detection");
                    if (!std::isfinite(d.confidence) || d.confidence < .25f || d.confidence > 1)
                        throw std::runtime_error("invalid detection score");
                    if (d.className.empty()) throw std::runtime_error("missing class label");
                    if (d.modelId == sample) ownPositive = true;
                    boxes.append(QJsonObject{{"model_id", d.modelId}, {"class_id", d.classId},
                        {"class_name", QString::fromStdString(d.className)},
                        {"confidence", d.confidence}, {"left", d.box.x}, {"top", d.box.y},
                        {"right", d.box.x + d.box.width}, {"bottom", d.box.y + d.box.height}});
                    cv::rectangle(annotated, d.box, cv::Scalar(30 + d.modelId * 70, 200, 80), 2);
                    cv::putText(annotated, d.className, d.box.tl(), cv::FONT_HERSHEY_SIMPLEX,
                                .5, cv::Scalar(255, 20, 220), 1);
                }
                if ((mask & (1u << sample)) && !ownPositive)
                    throw std::runtime_error("selected model missed its known positive sample");
                const double elapsed = std::chrono::duration<double, std::milli>(
                    std::chrono::steady_clock::now() - start).count();
                checks.append(QJsonObject{{"mask", static_cast<int>(mask)}, {"sample", sample},
                    {"inference_ms", elapsed}, {"detections", boxes}, {"passed", true}});
                if (mask == 7) cv::imwrite(std::string(argv[4]) + ".sample" + std::to_string(sample) + ".jpg", annotated);
                std::cout << "selection mask=" << mask << " sample=" << sample
                    << " boxes=" << detections.size() << " ms=" << elapsed << " PASS\n" << std::flush;
            }
        }
        QFile report(QString::fromLocal8Bit(argv[4]));
        if (!report.open(QIODevice::WriteOnly)) throw std::runtime_error("cannot save report");
        report.write(QJsonDocument(QJsonObject{{"ok", true}, {"checks", checks}}).toJson());
        return 0;
    } catch (const std::exception &e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
