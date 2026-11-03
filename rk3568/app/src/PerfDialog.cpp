#include "PerfDialog.h"
#include "UiSizing.h"
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QPainter>
#include <QFont>
#include <QGridLayout>
#include <QFrame>
#include <algorithm>
#include <cmath>

static inline QColor perfColor(int idx) {
    static const QColor colors[7] = {
        QColor(255, 167, 38),
        QColor(66, 165, 245),
        QColor(102, 187, 106),
        QColor(171, 71, 188),
        QColor(0, 188, 212),
        QColor(255, 202, 40),
        QColor(239, 83, 80)
    };
    return colors[std::max(0, std::min(6, idx))];
}

class PerfDialog::DonutWidget : public QWidget {
public:
    explicit DonutWidget(QWidget *parent = nullptr) : QWidget(parent) {
        setMinimumSize(360, 260);
    }

    void setParts(double capMs, double convMs, double viewMs, double detBoxMs, double detOcrMs, double envMs, double uiMs, double totalMs) {
        m_cap = capMs;
        m_conv = convMs;
        m_view = viewMs;
        m_detBox = detBoxMs;
        m_detOcr = detOcrMs;
        m_env = envMs;
        m_ui = uiMs;
        m_total = totalMs;
        update();
    }

protected:
    void paintEvent(QPaintEvent *) override {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing, true);

        QColor bg = Qt::white;
        QColor fg = Qt::black;
        p.fillRect(rect(), bg);

        const double parts[7] = {m_cap, m_conv, m_view, m_detBox, m_detOcr, m_env, m_ui};
        double componentTotal = 0.0;
        for (double part : parts) componentTotal += std::max(0.0, part);
        const double total = componentTotal > 1e-6
            ? componentTotal : std::max(1e-6, m_total);

        QRectF r(18, 18, height() - 36, height() - 36);
        if (r.width() < 160) {
            r.setWidth(160);
            r.setHeight(160);
        }

        const double startDeg = 90.0;
        double cur = startDeg;

        p.setPen(Qt::NoPen);
        for (int i = 0; i < 7; ++i) {
            double frac = std::max(0.0, parts[i]) / total;
            double span = frac * 360.0;
            if (span < 0.2) continue;
            p.setBrush(perfColor(i));
            p.drawPie(r, (int)std::llround(cur * 16.0), (int)std::llround(-span * 16.0));
            cur -= span;
        }

        QRectF inner = r.adjusted(r.width() * 0.22, r.height() * 0.22, -r.width() * 0.22, -r.height() * 0.22);
        p.setBrush(bg);
        p.drawEllipse(inner);

        QFont f = p.font();
        f.setPixelSize(componentTotal > m_total * 1.05 ? 14 : 16);
        f.setBold(true);
        p.setFont(f);
        p.setPen(fg);
        const QString centerText = componentTotal > m_total * 1.05
            ? QString("分项合计\n%1 ms\n墙钟 %2 ms")
                  .arg((int)std::llround(componentTotal))
                  .arg((int)std::llround(m_total))
            : QString("总耗时\n%1 ms").arg((int)std::llround(m_total));
        p.drawText(inner, Qt::AlignCenter, centerText);
    }

private:
    double m_cap = 0.0;
    double m_conv = 0.0;
    double m_view = 0.0;
    double m_detBox = 0.0;
    double m_detOcr = 0.0;
    double m_env = 0.0;
    double m_ui = 0.0;
    double m_total = 0.0;
};

PerfDialog::PerfDialog(QWidget *parent) : QDialog(parent) {
    setWindowTitle("耗时占比");
    setModal(false);
    UiSizing::fitWindow(this, QSize(680, 430), 24);

    QPalette pal = palette();
    pal.setColor(QPalette::Window, Qt::white);
    pal.setColor(QPalette::WindowText, Qt::black);
    setPalette(pal);
    setAutoFillBackground(true);

    QVBoxLayout *root = new QVBoxLayout(this);
    root->setContentsMargins(10, 10, 10, 10);
    root->setSpacing(10);

    QLabel *title = new QLabel("耗时占比（环形图）", this);
    QFont ft = title->font();
    ft.setPixelSize(16);
    ft.setBold(true);
    title->setFont(ft);

    m_donut = new DonutWidget(this);
    QWidget *main = new QWidget(this);
    QHBoxLayout *mainL = new QHBoxLayout(main);
    mainL->setContentsMargins(0, 0, 0, 0);
    mainL->setSpacing(12);
    mainL->addWidget(m_donut, 1);

    QWidget *legend = new QWidget(main);
    QGridLayout *grid = new QGridLayout(legend);
    grid->setContentsMargins(0, 0, 0, 0);
    grid->setHorizontalSpacing(10);
    grid->setVerticalSpacing(10);

    const char* names[7] = {"取帧/等待(cap)", "转换(conv)", "视图(view)", "推理-标框(det)", "推理-识别(ocr)", "推理-env", "显示(ui)"};
    for (int i = 0; i < 7; ++i) {
        QFrame *sw = new QFrame(legend);
        sw->setFixedSize(14, 14);
        sw->setFrameShape(QFrame::NoFrame);
        sw->setAutoFillBackground(true);
        QPalette pal = sw->palette();
        pal.setColor(QPalette::Window, perfColor(i));
        sw->setPalette(pal);
        m_legSwatch[i] = sw;

        QLabel *lab = new QLabel(QString::fromUtf8(names[i]), legend);
        lab->setMinimumWidth(220);
        lab->setStyleSheet("color: #000000;");
        m_legText[i] = lab;

        grid->addWidget(sw, i, 0, Qt::AlignVCenter);
        grid->addWidget(lab, i, 1, Qt::AlignVCenter);
    }
    m_detPartsLabel = new QLabel("det_parts: (未启用)", legend);
    m_detPartsLabel->setStyleSheet("color: #000000;");
    m_detPartsLabel->setMinimumWidth(300);
    m_detPartsLabel->setWordWrap(true);
    grid->addWidget(m_detPartsLabel, 7, 0, 1, 2, Qt::AlignVCenter);
    grid->setRowStretch(8, 1);
    mainL->addWidget(legend, 0);

    root->addWidget(title);
    root->addWidget(main, 1);

    m_pcieFramesLabel = new QLabel("本次 PCIe 完整接收：0 帧", this);
    QFont rxFont = m_pcieFramesLabel->font();
    rxFont.setPixelSize(11);
    m_pcieFramesLabel->setFont(rxFont);
    m_pcieFramesLabel->setStyleSheet("color: #666666;");
    m_pcieFramesLabel->setWordWrap(true);
    root->addWidget(m_pcieFramesLabel);
}

void PerfDialog::setParts(double capMs, double convMs, double viewMs,
                          double detBoxMs, double detOcrMs, double envMs,
                          double uiMs, double totalMs, bool slidingEnabled,
                          int slidingWindowCount) {
    if (!m_donut) return;
    Q_UNUSED(slidingEnabled);
    Q_UNUSED(slidingWindowCount);
    m_donut->setParts(capMs, convMs, viewMs, detBoxMs, detOcrMs, envMs, uiMs, totalMs);

    const double parts[7] = {capMs, convMs, viewMs, detBoxMs, detOcrMs, envMs, uiMs};
    double componentTotal = 0.0;
    for (double part : parts) componentTotal += std::max(0.0, part);
    const double total = componentTotal > 1e-6
        ? componentTotal : std::max(1e-6, totalMs);
    const QString names[7] = {
        QStringLiteral("取帧/等待(cap)"), QStringLiteral("转换(conv)"),
        QStringLiteral("视图(view)"), QStringLiteral("推理-标框(det)"),
        QStringLiteral("推理-识别(ocr)"), QStringLiteral("推理-env"),
        QStringLiteral("显示(ui)")
    };
    for (int i = 0; i < 7; ++i) {
        if (!m_legText[i]) continue;
        double frac = std::max(0.0, parts[i]) / total;
        QString t = QString("%1  %2ms  %3%")
                        .arg(names[i])
                        .arg(parts[i], 0, 'f', 2)
                        .arg(frac * 100.0, 0, 'f', 1);
        m_legText[i]->setText(t);
    }
}

void PerfDialog::setDetParts(double preMs, double npuMs, double postMs) {
    if (!m_detPartsLabel) return;
    m_detPartsLabel->setText(QString("det_parts: pre %1ms  npu %2ms  post %3ms")
                                 .arg((int)std::llround(preMs))
                                 .arg((int)std::llround(npuMs))
                                 .arg((int)std::llround(postMs)));
}

void PerfDialog::setDetRuntime(const QJsonObject &metrics) {
    if (!m_detPartsLabel) return;
    const double preMs = metrics.value("pre_ms").toDouble();
    const double npuWallMs = metrics.value("npu_wall_ms").toDouble();
    const double npuHwMs = metrics.value("npu_hw_ms").toDouble();
    const double postMs = metrics.value("post_ms").toDouble();
    const double e2eMs = metrics.value("e2e_ms").toDouble();
    const double taskFps = metrics.value("task_fps").toDouble();
    const double cycleFps = metrics.value("cycle_fps").toDouble();
    const int taskCount = metrics.value("task_count").toInt();
    const bool pipelineActive = metrics.value("pipeline_active").toBool();
    const QString strategy = metrics.value("strategy").toString();
    const QString backend = metrics.value("preprocess_backend").toString();
    const QString requested = metrics.value("preprocess_requested").toString();
    const QString fallback = metrics.value("preprocess_fallback_reason").toString();
    QString text = QString(
        "检测前处理 %1 ms (%2，设置 %3)\n"
        "NPU墙钟 %4 ms | NPU硬件 %5 ms | 检测后处理 %6 ms\n"
        "策略 %7 | 流水线 %8 | 任务 %9 | 端到端 %10 ms | 任务 %11 FPS | 轮次 %12 FPS")
        .arg(preMs, 0, 'f', 2)
        .arg(backend, requested)
        .arg(npuWallMs, 0, 'f', 2)
        .arg(npuHwMs, 0, 'f', 2)
        .arg(postMs, 0, 'f', 2)
        .arg(strategy)
        .arg(pipelineActive ? QStringLiteral("运行") : QStringLiteral("未运行"))
        .arg(taskCount)
        .arg(e2eMs, 0, 'f', 2)
        .arg(taskFps, 0, 'f', 2)
        .arg(cycleFps, 0, 'f', 2);
    if (!fallback.isEmpty()) text += QString("\n前处理回退：%1").arg(fallback);
    m_detPartsLabel->setText(text);
}

void PerfDialog::setPcieMetrics(quint64 frames, double rxFps,
                                double frameIntervalMs, double dqWaitMs,
                                bool frameV2) {
    if (!m_pcieFramesLabel) return;
    if (!frameV2) {
        m_pcieFramesLabel->setText(QString("本次 PCIe 完整接收：%1 帧").arg(frames));
        return;
    }
    const QString fpsText = rxFps > 0.0
        ? QString::number(rxFps, 'f', 2) : QStringLiteral("N/A");
    const QString intervalText = frameIntervalMs > 0.0
        ? QString::number(frameIntervalMs, 'f', 2) : QStringLiteral("N/A");
    m_pcieFramesLabel->setText(
        QString("PCIe完整接收：%1帧 | 收帧：%2 FPS | 帧间隔：%3 ms | DQ等待：%4 ms | DMA搬运：N/A")
            .arg(frames)
            .arg(fpsText)
            .arg(intervalText)
            .arg(dqWaitMs, 0, 'f', 2));
}

