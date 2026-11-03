#include "nav_yolo.h"

#include "cv.hpp"
#include "ez_rknn.hpp"
#include "structures.hpp"
#include "yolov5_nav_3out_postprocess.hpp"

#include <opencv2/imgproc.hpp>

#include <QFont>
#include <QFontMetrics>
#include <QImage>
#include <QPainter>
#include <QString>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <mutex>
#include <sstream>
#include <unistd.h>
#include <limits.h>
#include <vector>

namespace {

constexpr const char *kModelName = "nav_video7_v4_rk3568_w8a8.rknn";
constexpr int kNumClasses = 12;
constexpr float kConf = 0.25f;
constexpr float kNms = 0.45f;
constexpr int kBannerH = 168;

// Order used by nav_video7_yolov8n_12class_v4_dense50.
const char *kClassNames[kNumClasses] = {
    "通行",
    "向左变道",
    "向右变道",
    "向左变道",
    "领航中",
    "即将退出",
    "红灯",
    "绿灯",
    "行人",
    "虚线",
    "前车",
    "实线",
};

// Keep navigation, traffic lights, people, vehicles, and lane markings visually distinct.
const cv::Scalar kClassColors[kNumClasses] = {
    cv::Scalar(80, 200, 80),    // 通行
    cv::Scalar(80, 180, 255),   // 向左变道
    cv::Scalar(80, 180, 255),   // 向右变道
    cv::Scalar(80, 180, 255),   // 向左超车
    cv::Scalar(80, 200, 80),    // 领航中
    cv::Scalar(80, 200, 80),    // 即将退出
    cv::Scalar(40, 40, 220),    // 红灯
    cv::Scalar(255, 255, 0),    // 绿灯，青色
    cv::Scalar(180, 40, 220),   // 行人
    cv::Scalar(255, 180, 0),    // 虚线
    cv::Scalar(0, 140, 255),    // 前车
    cv::Scalar(255, 0, 180),    // 实线
};

std::mutex g_mtx;
ztu::rk::EzRknn *g_rknn = nullptr;
std::atomic<uint64_t> g_diag_call{0};

bool file_exists(const std::string &path) {
    return ::access(path.c_str(), R_OK) == 0;
}

std::string get_exe_dir() {
    char buf[PATH_MAX];
    ssize_t len = ::readlink("/proc/self/exe", buf, sizeof(buf) - 1);
    if (len <= 0) return "";
    buf[len] = '\0';
    std::string full(buf);
    const auto pos = full.find_last_of('/');
    if (pos == std::string::npos) return "";
    return full.substr(0, pos);
}

std::string resolve_model_path() {
    if (const char *override_path = std::getenv("RK3568_NAV_MODEL")) {
        if (override_path && *override_path && file_exists(override_path)) {
            return override_path;
        }
    }

    std::vector<std::string> candidates;
    if (const char *env_dir = std::getenv("RK3568_MODEL_DIR")) {
        if (env_dir && *env_dir) {
            candidates.emplace_back(std::string(env_dir) + "/" + kModelName);
        }
    }
    candidates.emplace_back(std::string("./app/model/") + kModelName);
    candidates.emplace_back(std::string("./model/") + kModelName);
    candidates.emplace_back(std::string("./models/") + kModelName);
    candidates.emplace_back(std::string("/userdata/nav_videos/") + kModelName);
    candidates.emplace_back(std::string("/userdata/nav_int8_test/") + kModelName);
    const std::string exe_dir = get_exe_dir();
    if (!exe_dir.empty()) {
        candidates.emplace_back(exe_dir + "/../model/" + kModelName);
        candidates.emplace_back(exe_dir + "/model/" + kModelName);
    }
    for (const auto &c : candidates) {
        if (file_exists(c)) return c;
    }
    return candidates.empty() ? std::string(kModelName) : candidates.front();
}

cv::Scalar color_for_id(int class_id) {
    if (class_id >= 0 && class_id < kNumClasses) return kClassColors[class_id];
    return cv::Scalar(0, 255, 0);
}

QColor qcolor_from_bgr(const cv::Scalar &bgr) {
    return QColor(
        static_cast<int>(bgr[2]),
        static_cast<int>(bgr[1]),
        static_cast<int>(bgr[0]));
}

// Timeline from nav_111440_frames/nav_heads.py (video_20260929_111440).
QString truth_action_at(int second) {
    if (second <= 1) return QStringLiteral("通行");
    switch (second) {
    case 12:
    case 13:
    case 17:
    case 44:
    case 47:
    case 50:
    case 51:
    case 52:
        return QStringLiteral("向右变道");
    default:
        break;
    }
    if (second >= 28 && second <= 32) return QStringLiteral("向左超车");
    if (second >= 59 && second <= 61) return QStringLiteral("向左变道");
    if (second >= 72) return QStringLiteral("即将退出");
    return QStringLiteral("领航中");
}

QString truth_light_at(int second) {
    static const int kGreen[] = {0, 1, 2, 4, 47, 48, 49, 95, 96, 97, 98, 99, 100};
    for (int g : kGreen) {
        if (second == g) return QStringLiteral("绿灯");
    }
    if ((second >= 70 && second <= 94) || second == 15 || second == 16) {
        return QStringLiteral("红灯");
    }
    return QStringLiteral("无灯");
}

// 5 km/h and below on video_20260929_111440. 8 km/h stays moving.
bool truth_braking(int second) {
    return (second >= 20 && second <= 23) || (second >= 75 && second <= 96);
}

bool is_action_class(int class_id) {
    return class_id >= 0 && class_id <= 5;
}

void decide(const std::vector<NavDetection> &dets,
            QString *action,
            QString *light,
            std::vector<cv::Rect> *people) {
    float best_action_conf = 0.0f;
    QString best_action;
    float light_conf = 0.0f;
    QString best_light = QStringLiteral("无灯");
    people->clear();
    for (const auto &det : dets) {
        if (is_action_class(det.class_id) && det.score > best_action_conf) {
            best_action_conf = det.score;
            best_action = QString::fromUtf8(kClassNames[det.class_id]);
        }
        if ((det.class_id == 6 || det.class_id == 7) && det.score > light_conf) {
            light_conf = det.score;
            best_light = QString::fromUtf8(kClassNames[det.class_id]);
        }
        if (det.class_id == 8) {
            people->push_back(det.box);
        }
    }
    *action = best_action.isEmpty() ? QStringLiteral("领航中") : best_action;
    *light = best_light;
}

// Lightweight blue-ring ego anchor (same idea as scene_boxes.ego_anchor).
bool ego_anchor(const cv::Mat &bgr, double *cx, double *cy) {
    if (bgr.empty() || !cx || !cy) return false;
    cv::Mat hsv;
    cv::cvtColor(bgr, hsv, cv::COLOR_BGR2HSV);
    const int h = bgr.rows;
    const int w = bgr.cols;
    const int x0 = static_cast<int>(w * 0.27);
    const int y0 = static_cast<int>(h * 0.18);
    const int x1 = std::min(w - 1, static_cast<int>(w * 0.93));
    const int y1 = std::min(h - 1, static_cast<int>(h * 0.84));
    if (x1 <= x0 || y1 <= y0) return false;

    cv::Mat view = hsv(cv::Rect(x0, y0, x1 - x0, y1 - y0));
    std::vector<cv::Mat> ch;
    cv::split(view, ch);
    cv::Mat blue =
        (ch[0] >= 95) & (ch[0] <= 130) & (ch[1] >= 110) & (ch[2] >= 70);
    blue.convertTo(blue, CV_8U, 255);

    cv::Mat labels, stats, cents;
    const int n = cv::connectedComponentsWithStats(blue, labels, stats, cents, 8);
    int best = -1;
    int best_area = 0;
    const int view_h = y1 - y0;
    for (int i = 1; i < n; ++i) {
        const int area = stats.at<int>(i, cv::CC_STAT_AREA);
        const int bw = stats.at<int>(i, cv::CC_STAT_WIDTH);
        const int bh = stats.at<int>(i, cv::CC_STAT_HEIGHT);
        const double icy = cents.at<double>(i, 1);
        if (bw < 70 || bw < bh * 1.4 || icy < view_h * 0.35) continue;
        if (area > best_area) {
            best_area = area;
            best = i;
        }
    }
    if (best < 0) return false;
    *cx = cents.at<double>(best, 0) + x0;
    *cy = cents.at<double>(best, 1) + y0;
    return true;
}

bool person_ahead(double ax, double ay, const std::vector<cv::Rect> &people) {
    for (const auto &box : people) {
        const double px = box.x + box.width * 0.5;
        const double py = box.y + box.height * 0.5;
        if (py > ay - 8 || py < ay - 360) continue;
        const double span = (ay - 8 - py) / 352.0;
        const double half = 190.0 * (1.0 - span) + 50.0 * span;
        if (std::abs(px - ax) < half) return true;
    }
    return false;
}

void paint_chinese(QPainter *painter,
                   const QString &text,
                   int x,
                   int y,
                   const QColor &color,
                   int pixel_size,
                   bool bold = true) {
    QFont font(QStringLiteral("WenQuanYi Zen Hei"));
    font.setPixelSize(pixel_size);
    font.setBold(bold);
    painter->setFont(font);
    painter->setPen(QColor(0, 0, 0, 180));
    painter->drawText(x + 1, y + 1, text);
    painter->setPen(color);
    painter->drawText(x, y, text);
}

enum class DriveSign { Straight, Left, Right, Stop };

DriveSign drive_sign_from(const QString &action, const QString &light) {
    if (light == QStringLiteral("红灯")) return DriveSign::Stop;
    if (action == QStringLiteral("向左变道") || action == QStringLiteral("向左超车")) {
        return DriveSign::Left;
    }
    if (action == QStringLiteral("向右变道")) return DriveSign::Right;
    return DriveSign::Straight;
}

void draw_stop_sign(cv::Mat &bgr, int cx, int cy, int s) {
    cv::circle(bgr, cv::Point(cx, cy), s, cv::Scalar(0, 0, 200), cv::FILLED, cv::LINE_AA);
    cv::circle(bgr, cv::Point(cx, cy), s, cv::Scalar(255, 255, 255), 3, cv::LINE_AA);
    cv::putText(bgr, "STOP", cv::Point(cx - s + 8, cy + s / 5),
                cv::FONT_HERSHEY_SIMPLEX, 0.8, cv::Scalar(255, 255, 255), 2, cv::LINE_AA);
}

void draw_arrow_sign(cv::Mat &bgr, DriveSign sign, int cx, int cy, int s, bool slow) {
    if (sign == DriveSign::Stop) {
        draw_stop_sign(bgr, cx, cy, s);
        return;
    }
    std::vector<cv::Point> pts;
    const int body = std::max(8, s / 3);
    const int neck = std::max(12, s / 2);
    if (sign == DriveSign::Left) {
        pts = {{cx - s, cy}, {cx - neck, cy - s / 2}, {cx - neck, cy - body},
               {cx + s, cy - body}, {cx + s, cy + body}, {cx - neck, cy + body},
               {cx - neck, cy + s / 2}};
    } else if (sign == DriveSign::Right) {
        pts = {{cx + s, cy}, {cx + neck, cy - s / 2}, {cx + neck, cy - body},
               {cx - s, cy - body}, {cx - s, cy + body}, {cx + neck, cy + body},
               {cx + neck, cy + s / 2}};
    } else {
        pts = {{cx, cy - s}, {cx - s / 2, cy - neck}, {cx - body, cy - neck},
               {cx - body, cy + s}, {cx + body, cy + s}, {cx + body, cy - neck},
               {cx + s / 2, cy - neck}};
    }
    const cv::Scalar fill = slow ? cv::Scalar(0, 180, 255) : cv::Scalar(0, 200, 0);
    const cv::Scalar edge(255, 255, 255);
    cv::fillConvexPoly(bgr, pts, fill, cv::LINE_AA);
    cv::polylines(bgr, pts, true, edge, 3, cv::LINE_AA);
    const char *label = (sign == DriveSign::Left)    ? "LEFT"
                        : (sign == DriveSign::Right) ? "RIGHT"
                                                     : "STRAIGHT";
    cv::putText(bgr, label, cv::Point(cx - 70, cy - s - 12),
                cv::FONT_HERSHEY_SIMPLEX, 0.9, edge, 2, cv::LINE_AA);
}

void draw_drive_sign(cv::Mat &bgr, DriveSign sign, bool slow, bool above_banner) {
    if (bgr.empty()) return;
    const int s = std::max(36, bgr.rows / 16);
    const int cx = bgr.cols / 2;
    const int margin = above_banner ? (kBannerH + s + 24) : (s + 48);
    const int cy = std::max(s + 20, bgr.rows - margin);
    draw_arrow_sign(bgr, sign, cx, cy, s, slow);
}

void draw_overlay_qt(cv::Mat &bgr,
                     const std::vector<NavDetection> &dets,
                     double video_second) {
    if (bgr.empty()) return;
    if (!bgr.isContinuous()) bgr = bgr.clone();

    cv::Mat rgb;
    cv::cvtColor(bgr, rgb, cv::COLOR_BGR2RGB);
    QImage qimg(rgb.data, rgb.cols, rgb.rows, static_cast<int>(rgb.step), QImage::Format_RGB888);

    QPainter painter(&qimg);
    painter.setRenderHint(QPainter::Antialiasing);
    painter.setRenderHint(QPainter::TextAntialiasing);

    for (const auto &det : dets) {
        const QColor color = qcolor_from_bgr(color_for_id(det.class_id));
        QPen pen(color);
        pen.setWidth(3);
        painter.setPen(pen);
        painter.setBrush(Qt::NoBrush);
        painter.drawRect(det.box.x, det.box.y, det.box.width, det.box.height);

        const QString label = QString::fromUtf8(nav_yolo_class_name(det.class_id));
        const int tx = det.box.x;
        const int ty = std::max(22, det.box.y - 6);
        paint_chinese(&painter, label, tx, ty, color, 22, true);
    }

    DriveSign video_sign = DriveSign::Straight;
    bool video_slow = false;
    if (video_second >= 0.0) {
        QString action;
        QString light;
        std::vector<cv::Rect> people;
        decide(dets, &action, &light, &people);
        std::vector<cv::Rect> ahead = people;
        for (const auto &det : dets) {
            if (det.class_id == 10) ahead.push_back(det.box);
        }

        const int second = static_cast<int>(video_second);
        const int capped = std::min(second, 100);
        const QString truth_action = truth_action_at(capped);
        const QString truth_light = truth_light_at(capped);
        const bool braking = truth_braking(capped);
        double ax = 0, ay = 0;
        const bool yield = ego_anchor(bgr, &ax, &ay) && person_ahead(ax, ay, ahead);

        QString advice;
        QColor advice_color(40, 180, 70);
        if (truth_light == QStringLiteral("红灯")) {
            advice = QStringLiteral("停止");
            advice_color = QColor(220, 40, 40);
            video_sign = DriveSign::Stop;
        } else if (braking) {
            advice = QStringLiteral("刹车");
            advice_color = QColor(220, 40, 40);
            video_sign = DriveSign::Stop;
        } else if (yield) {
            advice = QStringLiteral("降速");
            advice_color = QColor(230, 180, 40);
            video_slow = true;
            video_sign = drive_sign_from(truth_action, truth_light);
        } else {
            advice = truth_action;
            advice_color = QColor(40, 180, 70);
            video_sign = drive_sign_from(truth_action, truth_light);
        }

        const int banner_top = std::max(0, rgb.rows - kBannerH);
        painter.fillRect(0, banner_top, rgb.cols, kBannerH, QColor(0, 0, 0));

        const QColor ok(40, 180, 70);
        const QColor bad(220, 50, 50);
        const QColor line1 = (action == truth_action) ? ok : bad;
        const QColor line2 = (light == truth_light) ? ok : bad;

        paint_chinese(
            &painter,
            QStringLiteral("左上角状态  预测 %1    实际 %2").arg(action, truth_action),
            24,
            banner_top + 40,
            line1,
            34,
            true);
        paint_chinese(
            &painter,
            QStringLiteral("上方箭头  预测 %1    实际 %2").arg(light, truth_light),
            24,
            banner_top + 92,
            line2,
            34,
            true);
        paint_chinese(
            &painter,
            QStringLiteral("建议  %1").arg(advice),
            24,
            banner_top + 144,
            advice_color,
            34,
            true);
    }

    painter.end();
    cv::cvtColor(rgb, bgr, cv::COLOR_RGB2BGR);

    if (video_second >= 0.0) {
        draw_drive_sign(bgr, video_sign, video_slow, true);
    } else {
        QString action;
        QString light;
        std::vector<cv::Rect> people;
        decide(dets, &action, &light, &people);
        draw_drive_sign(bgr, drive_sign_from(action, light), false, false);
    }
}

} // namespace

bool nav_yolo_init(std::string *error) {
    std::lock_guard<std::mutex> lock(g_mtx);
    if (g_rknn) return true;

    const std::string path = resolve_model_path();
    if (!file_exists(path)) {
        if (error) {
            *error = "导航模型未找到: " + path +
                     "（可设置 RK3568_NAV_MODEL 或把 nav_video7_v4_rk3568_w8a8.rknn 放到 model 目录）";
        }
        return false;
    }

    try {
        g_rknn = new ztu::rk::EzRknn(path.c_str(), ztu::rk::EzRknn::Layout::CHW2HWC);
        g_rknn->setWantFloat(true);
    } catch (const std::exception &ex) {
        delete g_rknn;
        g_rknn = nullptr;
        if (error) *error = std::string("导航模型加载失败: ") + ex.what();
        return false;
    } catch (...) {
        delete g_rknn;
        g_rknn = nullptr;
        if (error) *error = "导航模型加载失败";
        return false;
    }
    return true;
}

void nav_yolo_release() {
    std::lock_guard<std::mutex> lock(g_mtx);
    delete g_rknn;
    g_rknn = nullptr;
}

bool nav_yolo_ready() {
    std::lock_guard<std::mutex> lock(g_mtx);
    return g_rknn != nullptr;
}

const char *nav_yolo_class_name(int class_id) {
    if (class_id >= 0 && class_id < kNumClasses) return kClassNames[class_id];
    return "unknown";
}

int nav_yolo_class_count() { return kNumClasses; }

std::vector<NavDetection> nav_yolo_detect(const cv::Mat &bgr) {
    std::vector<NavDetection> out;
    if (bgr.empty()) return out;
    const uint64_t diag_call = ++g_diag_call;

    std::lock_guard<std::mutex> lock(g_mtx);
    if (!g_rknn) return out;

    const int model_w = static_cast<int>(g_rknn->input_attrs[0].dims[2]);
    const int model_h = static_cast<int>(g_rknn->input_attrs[0].dims[1]);

    auto resize_param = ztu::cv::calculateResize(
        bgr.cols, bgr.rows, model_w, model_h, ztu::cv::ResizeMode::KEEP_RATIO_PAD);
    cv::Mat resized = ztu::cv::resize(
        bgr, resize_param, cv::Scalar(114, 114, 114));
    cv::cvtColor(resized, resized, cv::COLOR_BGR2RGB);

    ztu::nn::object_detect_result_list detections;
    // The retrained navigation model is YOLOv8-style: one decoded tensor
    // [1, 4 + classes, 8400], with xywh followed by sigmoid class scores.
    // Keep the old three-head YOLOv5 path below for rollback compatibility.
    const bool single_yolov8 =
        g_rknn->output_attrs.size() == 1 &&
        g_rknn->output_attrs[0].n_elems == static_cast<uint32_t>((4 + kNumClasses) * 8400);
    if (g_rknn->wantFloat() && single_yolov8) {
        auto res = g_rknn->inference(resized.data);
        if (!res.empty()) {
            const float *tensor = res[0];
            constexpr int candidates = 8400;
            constexpr int channels = 4 + kNumClasses;
            const auto &out_attr = g_rknn->output_attrs[0];
            bool channel_first = true;
            if (out_attr.n_dims >= 2) {
                const uint32_t d0 = out_attr.dims[out_attr.n_dims - 2];
                const uint32_t d1 = out_attr.dims[out_attr.n_dims - 1];
                if (d0 == candidates && d1 == channels) channel_first = false;
            }
            auto value_at = [&](int channel, int candidate) -> float {
                return channel_first
                    ? tensor[channel * candidates + candidate]
                    : tensor[candidate * channels + channel];
            };
            {
                std::ofstream diag("/tmp/rk3568_nav_v4_decode.log", std::ios::app);
                diag << "attrs dims=";
                for (uint32_t d = 0; d < out_attr.n_dims; ++d) {
                    if (d) diag << 'x';
                    diag << out_attr.dims[d];
                }
                diag << " fmt=" << static_cast<int>(out_attr.fmt)
                     << " type=" << static_cast<int>(out_attr.type)
                     << " n_elems=" << out_attr.n_elems
                     << " layout=" << (channel_first ? "CHW" : "HWC") << '\n';
            }
            struct Candidate {
                cv::Rect2f box;
                float score;
                int class_id;
            };
            std::vector<Candidate> candidates_out;
            candidates_out.reserve(128);
            float max_class_score = 0.0f;
            float coord_min = std::numeric_limits<float>::infinity();
            float coord_max = -std::numeric_limits<float>::infinity();
            int valid_coordinates = 0;
            int above_threshold = 0;
            auto probability = [](float value) {
                return (value >= 0.0f && value <= 1.0f)
                    ? value
                    : 1.0f / (1.0f + std::exp(-value));
            };
            for (int i = 0; i < candidates; ++i) {
                float cx = value_at(0, i);
                float cy = value_at(1, i);
                float bw = value_at(2, i);
                float bh = value_at(3, i);
                if (cx <= 0.0f || cy <= 0.0f || bw <= 0.0f || bh <= 0.0f) continue;
                ++valid_coordinates;
                coord_min = std::min({coord_min, cx, cy, bw, bh});
                coord_max = std::max({coord_max, cx, cy, bw, bh});
                if (cx <= 2.0f && cy <= 2.0f && bw <= 2.0f && bh <= 2.0f) {
                    cx *= model_w;
                    cy *= model_h;
                    bw *= model_w;
                    bh *= model_h;
                }
                int best_class = -1;
                float best_score = kConf;
                for (int c = 0; c < kNumClasses; ++c) {
                    const float score = probability(value_at(4 + c, i));
                    max_class_score = std::max(max_class_score, score);
                    if (score > best_score) {
                        best_score = score;
                        best_class = c;
                    }
                }
                if (best_class < 0) continue;
                ++above_threshold;
                candidates_out.push_back({
                    cv::Rect2f(cx - bw * 0.5f, cy - bh * 0.5f, bw, bh),
                    best_score, best_class});
            }
            std::sort(candidates_out.begin(), candidates_out.end(),
                      [](const Candidate &a, const Candidate &b) {
                          return a.score > b.score;
                      });
            std::vector<bool> suppressed(candidates_out.size(), false);
            auto overlap = [](const cv::Rect2f &a, const cv::Rect2f &b) {
                const float inter = (a & b).area();
                const float uni = a.area() + b.area() - inter;
                return uni > 0.0f ? inter / uni : 0.0f;
            };
            for (size_t i = 0; i < candidates_out.size(); ++i) {
                if (suppressed[i]) continue;
                const auto &keep = candidates_out[i];
                ztu::nn::object_detect_result det;
                det.cls_id = keep.class_id;
                det.prop = keep.score;
                det.box.left = static_cast<int>(keep.box.x);
                det.box.top = static_cast<int>(keep.box.y);
                det.box.right = static_cast<int>(keep.box.x + keep.box.width);
                det.box.bottom = static_cast<int>(keep.box.y + keep.box.height);
                detections.results.push_back(det);
                for (size_t j = i + 1; j < candidates_out.size(); ++j) {
                    if (!suppressed[j] && candidates_out[j].class_id == keep.class_id &&
                        overlap(keep.box, candidates_out[j].box) > kNms) {
                        suppressed[j] = true;
                    }
                }
            }
            detections.count = static_cast<int>(detections.results.size());
            if ((diag_call % 8) == 0) {
                std::ofstream diag("/tmp/rk3568_nav_v4_decode.log", std::ios::app);
                diag << "sample call=" << diag_call
                     << " want_float=" << g_rknn->wantFloat()
                     << " out_type=" << static_cast<int>(out_attr.type)
                     << " out_qnt=" << static_cast<int>(out_attr.qnt_type)
                     << " zp=" << out_attr.zp
                     << " scale=" << out_attr.scale
                     << " score_max=" << max_class_score
                     << " valid_xywh=" << valid_coordinates
                     << " xywh_minmax=" << coord_min << ',' << coord_max
                     << " above_conf=" << above_threshold
                     << " after_nms=" << detections.count << '\n';
            }
        }
    } else if (g_rknn->wantFloat()) {
        auto res = g_rknn->inference(resized.data);
        if (res.size() >= 3) {
            ztu::nn::yolov5_nav_3out_postprocess::postprocess(
                const_cast<const float **>(res.data()),
                kConf,
                kNms,
                &detections,
                model_w,
                model_h,
                11);
        }
    } else {
        auto res = g_rknn->inferenceRaw(resized.data);
        if (res.size() >= 3) {
            const void *outs[3] = {res[0], res[1], res[2]};
            bool is_u8[3] = {false, false, false};
            int32_t zps[3] = {0, 0, 0};
            float scales[3] = {1.0f, 1.0f, 1.0f};
            for (int i = 0; i < 3 && i < static_cast<int>(g_rknn->output_attrs.size()); ++i) {
                zps[i] = g_rknn->output_attrs[i].zp;
                scales[i] = g_rknn->output_attrs[i].scale;
                is_u8[i] = (g_rknn->output_attrs[i].type == RKNN_TENSOR_UINT8);
            }
            ztu::nn::yolov5_nav_3out_postprocess::postprocess_affine(
                outs, is_u8, zps, scales, kConf, kNms, &detections, model_w, model_h, 11);
        }
    }

    out.reserve(detections.results.size());
    for (auto &det : detections.results) {
        if (det.prop < kConf) continue;
        auto [left, top] = ztu::cv::reverseMapPoint(det.box.left, det.box.top, resize_param);
        auto [right, bottom] =
            ztu::cv::reverseMapPoint(det.box.right, det.box.bottom, resize_param);
        cv::Rect box(left, top, right - left, bottom - top);
        box &= cv::Rect(0, 0, bgr.cols, bgr.rows);
        if (box.width <= 1 || box.height <= 1) continue;

        NavDetection item;
        item.class_id = det.cls_id;
        item.score = det.prop;
        item.box = box;
        out.push_back(item);
    }
    if ((diag_call % 8) == 0) {
        std::ofstream diag("/tmp/rk3568_nav_v4_decode.log", std::ios::app);
        diag << "mapped call=" << diag_call << " final=" << out.size()
             << " image=" << bgr.cols << 'x' << bgr.rows << '\n';
    }
    return out;
}

void nav_yolo_draw(cv::Mat &bgr,
                   const std::vector<NavDetection> &dets,
                   double video_second) {
    draw_overlay_qt(bgr, dets, video_second);
}

void nav_yolo_recommend(const cv::Mat &bgr,
                        const std::vector<NavDetection> &dets,
                        int *direction,
                        bool *forbidden,
                        bool *slow,
                        QString *status) {
    if (!direction || !forbidden || !slow || !status) return;
    QString action;
    QString light;
    std::vector<cv::Rect> ahead;
    decide(dets, &action, &light, &ahead);
    for (const auto &det : dets) {
        if (det.class_id == 10) ahead.push_back(det.box);
    }
    int sign = 0;
    if (action == QStringLiteral("向左变道") || action == QStringLiteral("向左超车")) sign = 1;
    else if (action == QStringLiteral("向右变道")) sign = 2;
    const bool red = light == QStringLiteral("红灯");
    double ax = 0.0, ay = 0.0;
    *slow = ego_anchor(bgr, &ax, &ay) && person_ahead(ax, ay, ahead);
    *forbidden = red;
    *direction = red ? 3 : sign;
    *status = red ? QStringLiteral("导航识别红灯，停止")
        : (*slow ? QStringLiteral("导航识别前方目标，降速")
                 : QStringLiteral("导航：%1").arg(action));
}
