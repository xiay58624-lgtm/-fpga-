#include "PlateEvaluator.h"

#include "PlateCategory.h"
#include "yolo.h"

#include <QDateTime>
#include <QCryptographicHash>
#include <QDir>
#include <QDirIterator>
#include <QElapsedTimer>
#include <QFileInfo>
#include <QImage>
#include <QImageReader>
#include <QSaveFile>
#include <QTextStream>
#include <algorithm>
#include <cmath>
#include <utility>
#include <opencv2/imgproc.hpp>

namespace {

constexpr const char *kSchemaVersion = "rk3568.plate_evaluation.v2";

bool isSupportedImage(const QString &path) {
    const QString suffix = QFileInfo(path).suffix().trimmed().toLower();
    return suffix == "jpg" || suffix == "jpeg" || suffix == "png" ||
           suffix == "bmp" || suffix == "webp";
}

QStringList collectImages(const QString &folder) {
    QStringList files;
    QDirIterator it(folder, QDir::Files, QDirIterator::Subdirectories);
    while (it.hasNext()) {
        const QString path = it.next();
        if (isSupportedImage(path)) files.append(QFileInfo(path).absoluteFilePath());
    }
    std::sort(files.begin(), files.end(), [](const QString &a, const QString &b) {
        return QString::compare(a, b, Qt::CaseSensitive) < 0;
    });
    return files;
}

cv::Mat loadBgrImage(const QString &path, QString &error) {
    QImageReader reader(path);
    reader.setAutoTransform(true);
    const QImage image = reader.read();
    if (image.isNull()) {
        error = reader.errorString().trimmed();
        if (error.isEmpty()) error = "image_read_failed";
        return {};
    }
    const QImage rgb = image.convertToFormat(QImage::Format_RGB888);
    cv::Mat rgbMat(rgb.height(), rgb.width(), CV_8UC3,
                   const_cast<uchar*>(rgb.constBits()), rgb.bytesPerLine());
    cv::Mat bgr;
    cv::cvtColor(rgbMat, bgr, cv::COLOR_RGB2BGR);
    return bgr.clone();
}

QString csvCell(QString value) {
    value.replace('"', "\"\"");
    if (value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r')) {
        return QStringLiteral("\"") + value + QStringLiteral("\"");
    }
    return value;
}

void writeCsvRow(QTextStream &out, const QStringList &cells) {
    QStringList escaped;
    escaped.reserve(cells.size());
    for (const QString &cell : cells) escaped.append(csvCell(cell));
    out << escaped.join(',') << "\r\n";
}

QString decimal(double value, int precision = 6) {
    if (!std::isfinite(value)) return QString();
    return QString::number(value, 'f', precision);
}

struct CodeName {
    QString code;
    QString name;
};

CodeName plateType(int index) {
    if (index == 0) return {"single", "单层车牌"};
    if (index == 1) return {"double", "双层车牌"};
    return {"unknown", "未知"};
}

CodeName plateColor(int index) {
    switch (index) {
        case 0: return {"black", "黑色"};
        case 1: return {"blue", "蓝色"};
        case 2: return {"green", "绿色"};
        case 3: return {"white", "白色"};
        case 4: return {"yellow", "黄色"};
        default: return {"unknown", "未知"};
    }
}

QString normalizedRelativePath(const QDir &root, const QString &absolutePath) {
    QString relative = root.relativeFilePath(absolutePath);
    relative.replace('\\', '/');
    return relative.normalized(QString::NormalizationForm_C);
}

QString imageIdFromRelativePath(const QString &relativePath) {
    const QByteArray normalized = relativePath.normalized(QString::NormalizationForm_C).toUtf8();
    return QString::fromLatin1(
        QCryptographicHash::hash(normalized, QCryptographicHash::Sha256).toHex());
}

QStringList baseCells(const QString &runId,
                      int imageIndex,
                      const QString &relativePath,
                      int width,
                      int height,
                      int detectionIndex,
                      bool detected) {
    return {
        kSchemaVersion,
        runId,
        QString::number(imageIndex),
        imageIdFromRelativePath(relativePath),
        relativePath,
        QFileInfo(relativePath).fileName(),
        QString::number(width),
        QString::number(height),
        QString::number(detectionIndex),
        detected ? "1" : "0"
    };
}

void appendEmptyPrediction(QStringList &cells) {
    // plate through landmark coordinates
    for (int i = 0; i < 22; ++i) cells.append(QString());
}

QString modelFileName(const char *path) {
    if (!path || !*path) return QString();
    return QFileInfo(QString::fromLocal8Bit(path)).fileName();
}

} // namespace

bool exportPlateEvaluationCsv(const QString &imageFolder,
                              const QString &csvPath,
                              const PlateEvaluationProgress &progress,
                              PlateEvaluationSummary &summary,
                              QString &error) {
    summary = {};
    error.clear();

    const QFileInfo folderInfo(imageFolder);
    if (!folderInfo.exists() || !folderInfo.isDir()) {
        error = "图片文件夹不存在或不可访问";
        return false;
    }
    if (csvPath.trimmed().isEmpty()) {
        error = "CSV 输出路径为空";
        return false;
    }

    const QString rootPath = folderInfo.absoluteFilePath();
    const QDir root(rootPath);
    const QStringList images = collectImages(rootPath);
    summary.totalImages = images.size();
    summary.csvPath = QFileInfo(csvPath).absoluteFilePath();
    if (images.isEmpty()) {
        error = "文件夹中未找到受支持的图片";
        return false;
    }

    if (progress && !progress(0, images.size(), QString())) {
        summary.canceled = true;
        error = "canceled";
        return false;
    }

    yolo_init();
    if (!yolo_is_ready()) {
        error = QString("模型未就绪：%1").arg(QString::fromLocal8Bit(yolo_last_error()));
        return false;
    }

    QSaveFile file(summary.csvPath);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        error = QString("无法创建 CSV：%1").arg(file.errorString());
        return false;
    }
    file.write("\xEF\xBB\xBF", 3);
    QTextStream out(&file);
    out.setCodec("UTF-8");

    writeCsvRow(out, {
        "schema_version", "run_id", "image_index", "image_id", "relative_path", "image_name",
        "image_width", "image_height", "detection_index", "detected", "plate_number",
        "plate_type_code", "plate_type_name", "vehicle_type_code", "vehicle_type_name",
        "plate_color_code", "plate_color_name", "det_confidence", "ocr_confidence",
        "ocr_accepted", "bbox_left", "bbox_top", "bbox_right", "bbox_bottom",
        "point0_x", "point0_y", "point1_x", "point1_y", "point2_x", "point2_y",
        "point3_x", "point3_y", "processing_ms", "status", "error_message",
        "det_model", "ocr_model", "det_threshold", "ocr_threshold",
        "plate_number_normalized", "vehicle_type_rule", "vehicle_type_rule_version"
    });

    const QString runId = QDateTime::currentDateTime().toString("yyyyMMddHHmmsszzz");
    const QString detModel = modelFileName(yolo_detection_model_path());
    const QString ocrModel = modelFileName(yolo_recognition_model_path());
    const QString detThreshold = decimal(yolo_evaluation_detection_threshold());
    const QString ocrThreshold = decimal(yolo_ocr_acceptance_threshold());
    QElapsedTimer totalTimer;
    totalTimer.start();

    for (int i = 0; i < images.size(); ++i) {
        const QString relativePath = normalizedRelativePath(root, images[i]);
        if (progress && !progress(i, images.size(), relativePath)) {
            summary.canceled = true;
            error = "canceled";
            file.cancelWriting();
            return false;
        }

        QElapsedTimer imageTimer;
        imageTimer.start();
        QString readError;
        cv::Mat image = loadBgrImage(images[i], readError);
        if (image.empty()) {
            const double processingMs = (double)imageTimer.nsecsElapsed() / 1000000.0;
            QStringList cells = baseCells(runId, i + 1, relativePath, 0, 0, 0, false);
            appendEmptyPrediction(cells);
            cells << decimal(processingMs, 3) << "image_read_error" << readError
                  << detModel << ocrModel << detThreshold << ocrThreshold
                  << QString() << "empty_plate" << plateCategoryRuleVersion();
            writeCsvRow(out, cells);
            ++summary.failedImages;
            ++summary.processedImages;
            if (progress && !progress(i + 1, images.size(), relativePath)) {
                summary.canceled = true;
                error = "canceled";
                file.cancelWriting();
                return false;
            }
            continue;
        }

        std::vector<PlateEvaluationResult> predictions;
        std::string inferenceError;
        const bool inferenceOk = yolo_evaluate_image(image, predictions, inferenceError);
        const double processingMs = (double)imageTimer.nsecsElapsed() / 1000000.0;
        if (!inferenceOk) {
            QStringList cells = baseCells(runId, i + 1, relativePath, image.cols, image.rows, 0, false);
            appendEmptyPrediction(cells);
            cells << decimal(processingMs, 3) << "inference_error"
                  << QString::fromLocal8Bit(inferenceError.c_str())
                  << detModel << ocrModel << detThreshold << ocrThreshold
                  << QString() << "empty_plate" << plateCategoryRuleVersion();
            writeCsvRow(out, cells);
            ++summary.failedImages;
        } else if (predictions.empty()) {
            QStringList cells = baseCells(runId, i + 1, relativePath, image.cols, image.rows, 0, false);
            appendEmptyPrediction(cells);
            cells << decimal(processingMs, 3) << "no_detection" << QString()
                  << detModel << ocrModel << detThreshold << ocrThreshold
                  << QString() << "empty_plate" << plateCategoryRuleVersion();
            writeCsvRow(out, cells);
            ++summary.noDetectionImages;
        } else {
            ++summary.detectedImages;
            summary.detectionRows += (int)predictions.size();
            for (int detectionIndex = 0; detectionIndex < (int)predictions.size(); ++detectionIndex) {
                const PlateEvaluationResult &prediction = predictions[(size_t)detectionIndex];
                const QString plate = QString::fromUtf8(prediction.plate_no.c_str());
                const CodeName type = plateType(prediction.plate_type_idx);
                const CodeName color = plateColor(prediction.color_idx);
                const PlateCategoryInfo vehicle = classifyPlateCategory(plate, color.code);
                QStringList cells = baseCells(runId, i + 1, relativePath, image.cols, image.rows,
                                              detectionIndex + 1, true);
                cells << plate << type.code << type.name << vehicle.code << vehicle.name
                      << color.code << color.name << decimal(prediction.det_conf)
                      << decimal(prediction.ocr_conf) << (prediction.ocr_accepted ? "1" : "0")
                      << QString::number(prediction.bbox_left)
                      << QString::number(prediction.bbox_top)
                      << QString::number(prediction.bbox_right)
                      << QString::number(prediction.bbox_bottom);
                for (float point : prediction.landmarks) cells << decimal(point, 3);
                cells << decimal(processingMs, 3)
                      << QString::fromLatin1(prediction.status.c_str())
                      << QString::fromLocal8Bit(prediction.error.c_str())
                      << detModel << ocrModel << detThreshold << ocrThreshold
                      << normalizePlateForProtocol(plate) << vehicle.rule
                      << plateCategoryRuleVersion();
                writeCsvRow(out, cells);
                if (prediction.ocr_accepted) ++summary.acceptedOcrRows;
            }
        }

        ++summary.processedImages;
        if (progress && !progress(i + 1, images.size(), relativePath)) {
            summary.canceled = true;
            error = "canceled";
            file.cancelWriting();
            return false;
        }
    }

    out.flush();
    if (out.status() != QTextStream::Ok) {
        error = "CSV 写入失败";
        file.cancelWriting();
        return false;
    }
    if (!file.commit()) {
        error = QString("CSV 保存失败：%1").arg(file.errorString());
        return false;
    }
    summary.elapsedMs = totalTimer.elapsed();
    return true;
}
