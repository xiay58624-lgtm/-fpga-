#include "AdasModelSet.h"
#include "AdasOutputContract.h"
#include "ez_rknn.hpp"

#include <QDebug>
#include <QDir>
#include <QCoreApplication>
#include <QFileInfo>
#include <QFile>
#include <QCryptographicHash>
#include <opencv2/imgproc.hpp>
#include <array>
#include <cstdlib>
#include <stdexcept>

namespace adas_models {
namespace {
struct Spec {
    int id;
    const char *key;
    const char *file;
    const char *sha256;
    std::vector<std::string> classes;
};
const std::array<Spec, 3> specs{{
    {0, "vehicles", "bdd7_rk3568_fp16.rknn",
        "7daddec0f014a32532e7fa3d32ff163bfa698fb0f31fd0ffaebc5d8ae9858b25",
        {"pedestrian", "rider", "car", "truck", "bus", "motorcycle", "bicycle"}},
    {1, "lines", "lane_rk3568_fp16.rknn",
        "ef67bfd7665656e47be948c772db61dd86f7216e1afaea39a37577a06bc0755c",
        {"center_dashline", "center_solidline"}},
    {2, "lights", "traffic_rk3568_fp16.rknn",
        "e454b4afca770ce84a591ea97534aae28af389da08f8d5ddb68e9a5b7c5c33e5",
        {"Green_L_diaotou", "green", "green_L", "green_R", "green_Z_L",
         "green_non", "green_prson", "green_z", "red", "red_L",
         "red_L_diaotou", "red_R", "red_Z", "red_diaotou", "red_non",
         "red_person", "yellow"}}
}};

QString modelPath(const char *file) {
    QStringList dirs;
    const QString configured = QString::fromLocal8Bit(qgetenv("RK3568_MODEL_DIR"));
    if (!configured.isEmpty()) dirs << configured;
    dirs << "./app/model" << "./model" << "./models"
         << QCoreApplication::applicationDirPath() + "/../model"
         << QCoreApplication::applicationDirPath() + "/model";
    for (const auto &dir : dirs) {
        const QString path = QDir(dir).filePath(QString::fromLatin1(file));
        if (QFileInfo(path).isFile()) return path;
    }
    throw std::runtime_error(std::string("ADAS model missing: ") + file);
}

void checkContract(const ztu::rk::EzRknn &model, const Spec &spec) {
    if (model.input_attrs.size() != 1 || model.output_attrs.size() != 1)
        throw std::runtime_error("expected one input and one decoded output");
    const auto &in = model.input_attrs[0];
    const auto &out = model.output_attrs[0];
    if (in.n_dims != 4 || in.dims[0] != 1 || in.dims[1] != 640 ||
        in.dims[2] != 640 || in.dims[3] != 3 || in.n_elems != 640 * 640 * 3)
        throw std::runtime_error("expected NHWC input [1,640,640,3]");
    const unsigned channels = 4u + static_cast<unsigned>(spec.classes.size());
    // RKNN runtime 2.3 reports these hash-verified FP16 models as AFFINE
    // with identity scaling. want_float=true still returns decoded floats.
    // Accept only that exact identity marker, never an integer/raw tensor.
    const bool floatOutput = out.type == RKNN_TENSOR_FLOAT16 ||
                             out.type == RKNN_TENSOR_FLOAT32;
    const bool identityScaling = out.qnt_type == RKNN_TENSOR_QNT_NONE ||
        (out.qnt_type == RKNN_TENSOR_QNT_AFFINE_ASYMMETRIC &&
         out.zp == 0 && out.scale == 1.0f);
    if (out.n_dims != 3 || out.dims[0] != 1 || out.dims[1] != channels ||
        out.dims[2] != 8400 || out.n_elems != channels * 8400 ||
        !floatOutput || !identityScaling)
        throw std::runtime_error(std::string(spec.file) +
            ": expected float output [1,4+classes,8400] with identity scaling; " +
            "dims=" + std::to_string(out.n_dims) + "," +
            std::to_string(out.dims[0]) + "," + std::to_string(out.dims[1]) + "," +
            std::to_string(out.dims[2]) + " type=" + std::to_string(out.type) +
            " qnt=" + std::to_string(out.qnt_type) + " zp=" +
            std::to_string(out.zp) + " scale=" + std::to_string(out.scale));
}

float iou(const cv::Rect &a, const cv::Rect &b) {
    const int intersection = (a & b).area();
    const int sum = a.area() + b.area() - intersection;
    return sum > 0 ? static_cast<float>(intersection) / sum : 0;
}
}

struct ModelSet::Impl {
    std::array<std::unique_ptr<ztu::rk::EzRknn>, 3> runtimes;
    unsigned selected = 0;
};
ModelSet::ModelSet() : m_impl(std::make_unique<Impl>()) {}
ModelSet::~ModelSet() = default;
void ModelSet::release() {
    for (auto &runtime : m_impl->runtimes) runtime.reset();
    m_impl->selected = 0;
}

bool ModelSet::select(unsigned mask, std::string *error) {
    mask &= All;
    // Free deselected models before allocating new contexts on the small board.
    for (const auto &spec : specs)
        if (!(mask & (1u << spec.id))) m_impl->runtimes[spec.id].reset();
    m_impl->selected = 0;
    try {
        for (const auto &spec : specs) {
            if (!(mask & (1u << spec.id))) continue;
            auto &runtime = m_impl->runtimes[spec.id];
            if (!runtime) {
                const QString path = modelPath(spec.file);
                QFile modelFile(path);
                QCryptographicHash hash(QCryptographicHash::Sha256);
                if (!modelFile.open(QIODevice::ReadOnly) || !hash.addData(&modelFile) ||
                    hash.result().toHex() != QByteArray(spec.sha256))
                    throw std::runtime_error(std::string("ADAS model hash mismatch: ") + spec.file);
                modelFile.close();
                auto candidate = std::make_unique<ztu::rk::EzRknn>(
                    path.toStdString(), ztu::rk::EzRknn::Layout::CHW2HWC);
                candidate->setWantFloat(true);
                checkContract(*candidate, spec);
                qInfo().noquote() << "ADAS_MODEL verified" << spec.key << path
                    << "classes=" << spec.classes.size()
                    << "output=1," << spec.classes.size() + 4 << ",8400 want_float=1";
                runtime = std::move(candidate);
            }
        }
        m_impl->selected = mask;
        return true;
    } catch (const std::exception &e) {
        // Never silently continue with a partial selection.
        release();
        if (error) *error = e.what();
        return false;
    }
}

std::vector<Detection> ModelSet::detect(const cv::Mat &bgr) {
    if (bgr.empty() || bgr.type() != CV_8UC3)
        throw std::runtime_error("ADAS input is not BGR uint8");
    const double scale = std::min(640.0 / bgr.cols, 640.0 / bgr.rows);
    const int width = std::clamp(static_cast<int>(std::lround(bgr.cols * scale)), 1, 640);
    const int height = std::clamp(static_cast<int>(std::lround(bgr.rows * scale)), 1, 640);
    const int padX = (640 - width) / 2, padY = (640 - height) / 2;
    cv::Mat rgb, resized;
    cv::cvtColor(bgr, rgb, cv::COLOR_BGR2RGB);
    cv::resize(rgb, resized, cv::Size(width, height), 0, 0, cv::INTER_LINEAR);
    cv::Mat input(640, 640, CV_8UC3, cv::Scalar(0, 0, 0));
    resized.copyTo(input(cv::Rect(padX, padY, width, height)));
    std::vector<Detection> result;
    for (const auto &spec : specs) {
        if (!(m_impl->selected & (1u << spec.id))) continue;
        auto &runtime = m_impl->runtimes[spec.id];
        const auto outputs = runtime->inference(input.data);
        if (outputs.size() != 1) throw std::runtime_error("ADAS output count changed");
        const auto candidates = decodeProbabilities(outputs[0], 4 + spec.classes.size(),
                                                    8400, spec.classes.size(), 0.25f);
        std::vector<Detection> kept;
        for (const auto &d : candidates) {
            const int left = std::clamp(static_cast<int>(std::floor((d.cx - d.width / 2 - padX) / scale)), 0, bgr.cols);
            const int top = std::clamp(static_cast<int>(std::floor((d.cy - d.height / 2 - padY) / scale)), 0, bgr.rows);
            const int right = std::clamp(static_cast<int>(std::ceil((d.cx + d.width / 2 - padX) / scale)), 0, bgr.cols);
            const int bottom = std::clamp(static_cast<int>(std::ceil((d.cy + d.height / 2 - padY) / scale)), 0, bgr.rows);
            if (right - left < 2 || bottom - top < 2) continue;
            const cv::Rect box(left, top, right - left, bottom - top);
            bool duplicate = false;
            for (const auto &previous : kept)
                if (previous.classId == d.classId && iou(previous.box, box) > 0.4f) {
                    duplicate = true; break;
                }
            if (duplicate) continue;
            kept.push_back({spec.id, d.classId, d.confidence, box, spec.classes[d.classId]});
            if (kept.size() >= 60) break;
        }
        result.insert(result.end(), kept.begin(), kept.end());
    }
    return result;
}
}
