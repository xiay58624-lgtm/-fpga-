#include "DriverStatusDialog.h"

#include "DriverStatusCollector.h"
#include "UiSizing.h"

#include <QAbstractItemView>
#include <QColor>
#include <QFont>
#include <QHeaderView>
#include <QHBoxLayout>
#include <QGridLayout>
#include <QGroupBox>
#include <QLabel>
#include <QPushButton>
#include <QTableWidget>
#include <QTableWidgetItem>
#include <QTimer>
#include <QVBoxLayout>

DriverStatusDialog::DriverStatusDialog(QWidget *parent) : QDialog(parent) {
    setWindowTitle("驱动状态");
    const bool compact720 = UiSizing::isCompact720(this);
    UiSizing::fitWindow(this, QSize(1000, 660), 24);

    QVBoxLayout *vl = new QVBoxLayout(this);
    vl->setContentsMargins(18, 18, 18, 18);
    vl->setSpacing(12);

    QGroupBox *captureBox = new QGroupBox("实时采集真实指标", this);
    QGridLayout *captureGrid = new QGridLayout(captureBox);
    captureGrid->setContentsMargins(12, 10, 12, 10);
    captureGrid->setHorizontalSpacing(18);
    captureGrid->setVerticalSpacing(8);
    captureBox->setStyleSheet(
        "QGroupBox { border: 1px solid #9fb5cc; border-radius: 4px; margin-top: 8px; "
        "font-weight: 600; color: #1f3b57; background: #f7fbff; }"
        "QGroupBox::title { subcontrol-origin: margin; left: 10px; padding: 0 5px; }"
        "QLabel[class=\"metric-name\"] { color: #526273; }"
        "QLabel[class=\"metric-value\"] { color: #0f172a; font-weight: 600; }");
    auto addMetric = [captureGrid, compact720](int row, int col, const QString &name, QLabel **value) {
        QLabel *nameLabel = new QLabel(name);
        nameLabel->setProperty("class", "metric-name");
        QLabel *valueLabel = new QLabel("N/A");
        valueLabel->setProperty("class", "metric-value");
        valueLabel->setMinimumWidth(compact720 ? 120 : 180);
        captureGrid->addWidget(nameLabel, row, col * 2);
        captureGrid->addWidget(valueLabel, row, col * 2 + 1);
        if (value) *value = valueLabel;
    };
    addMetric(0, 0, "状态", &m_captureStatus);
    addMetric(0, 1, "PCIe 实际收帧率", &m_captureFps);
    addMetric(0, 2, "实际帧间隔", &m_captureInterval);
    addMetric(1, 0, "协议 / 固定30FPS", &m_captureProtocol);
    addMetric(1, 1, "源锁定 / 自动恢复", &m_captureRecovery);
    addMetric(1, 2, "完整帧 / 丢弃帧", &m_captureFrames);
    addMetric(2, 0, "DMA / 等待 / 拼帧 / 用户拷贝", &m_captureDma);
    addMetric(2, 1, "DMA 配置", &m_captureConfig);
    vl->addWidget(captureBox);

    QHBoxLayout *hl = new QHBoxLayout();
    hl->setContentsMargins(0, 0, 0, 4);
    m_refreshBtn = new QPushButton("刷新", this);
    m_refreshBtn->setFixedWidth(90);
    hl->addStretch();
    hl->addWidget(m_refreshBtn);
    vl->addLayout(hl);

    m_table = new QTableWidget(this);
    m_table->setColumnCount(4);
    m_table->setHorizontalHeaderLabels(QStringList() << "分类" << "项目" << "当前值" << "详情");
    m_table->setShowGrid(true);
    m_table->setGridStyle(Qt::SolidLine);
    m_table->setAlternatingRowColors(true);
    m_table->setWordWrap(true);
    m_table->setEditTriggers(QAbstractItemView::NoEditTriggers);
    m_table->setSelectionBehavior(QAbstractItemView::SelectRows);
    m_table->setSelectionMode(QAbstractItemView::SingleSelection);
    m_table->verticalHeader()->setVisible(false);
    m_table->verticalHeader()->setDefaultSectionSize(36);
    m_table->horizontalHeader()->setSectionResizeMode(0, QHeaderView::ResizeToContents);
    m_table->horizontalHeader()->setSectionResizeMode(1, QHeaderView::ResizeToContents);
    m_table->horizontalHeader()->setSectionResizeMode(2, QHeaderView::ResizeToContents);
    m_table->horizontalHeader()->setSectionResizeMode(3, QHeaderView::Stretch);
    m_table->setStyleSheet(
        "QTableWidget {"
        "  border: 1px solid #b8bec8;"
        "  gridline-color: #c6ccd5;"
        "  background: #ffffff;"
        "  alternate-background-color: #f8fafc;"
        "  selection-background-color: #d9ebff;"
        "  selection-color: #111827;"
        "}"
        "QTableWidget::item {"
        "  padding: 6px 10px;"
        "}"
        "QHeaderView::section {"
        "  padding: 8px 10px;"
        "  background: #edf1f5;"
        "  border: 1px solid #c6ccd5;"
        "  font-weight: 600;"
        "}"
    );
    vl->addWidget(m_table, 1);

    m_timer = new QTimer(this);
    m_timer->setInterval(1000);
    connect(m_timer, &QTimer::timeout, this, &DriverStatusDialog::refreshNow);
    connect(m_refreshBtn, &QPushButton::clicked, this, &DriverStatusDialog::refreshNow);
    m_timer->start();

    refreshNow();
}

void DriverStatusDialog::addRow(const QString &group, const QString &item, const QString &value, const QString &detail) {
    if (!m_table) return;
    if (m_currentGroup.isEmpty()) {
        m_currentGroup = group;
        m_groupStartRow = m_table->rowCount();
    } else if (group != m_currentGroup) {
        finishGroupSpan();
        m_currentGroup = group;
        m_groupStartRow = m_table->rowCount();
    }

    const int row = m_table->rowCount();
    m_table->insertRow(row);

    const QStringList cols = QStringList() << group << item << value << detail;
    for (int col = 0; col < cols.size(); ++col) {
        QTableWidgetItem *cell = new QTableWidgetItem(cols[col]);
        cell->setFlags(cell->flags() & ~Qt::ItemIsEditable);
        cell->setTextAlignment(col == 0 ? Qt::AlignCenter : (Qt::AlignLeft | Qt::AlignVCenter));
        if (col == 0) {
            QFont f = cell->font();
            f.setBold(true);
            cell->setFont(f);
            cell->setBackground(QColor(238, 244, 252));
        }
        m_table->setItem(row, col, cell);
    }
}

void DriverStatusDialog::finishGroupSpan() {
    if (!m_table || m_groupStartRow < 0) return;
    const int rows = m_table->rowCount() - m_groupStartRow;
    if (rows > 1) m_table->setSpan(m_groupStartRow, 0, rows, 1);
}

void DriverStatusDialog::updateCaptureMetrics(const DriverCaptureMetrics &metrics) {
    if (!m_captureStatus) return;
    QString statusText;
    if (metrics.running) {
        statusText = metrics.v1FallbackActive
            ? QStringLiteral("运行中（V1回退）")
            : metrics.lastError.isEmpty() ? QStringLiteral("运行中") : QStringLiteral("运行中（曾异常）");
    } else if (!metrics.lastError.isEmpty()) {
        statusText = metrics.pcie && metrics.targetFpsMilli > 0 &&
                !metrics.rateControlSupported
            ? QStringLiteral("固定30FPS不可用") : QStringLiteral("异常停止");
    } else {
        statusText = metrics.framesTotal > 0 ? QStringLiteral("已停止") : QStringLiteral("未采集");
    }
    m_captureStatus->setText(statusText);
    m_captureStatus->setToolTip(metrics.lastError);
    m_captureFps->setText(metrics.metricValid
                              ? QString("%1 FPS").arg(metrics.actualRxFps, 0, 'f', 2)
                              : "等待第二个完整帧");
    m_captureInterval->setText(metrics.metricValid
                                     ? QString("%1 ms").arg(metrics.frameIntervalMs, 0, 'f', 2)
                                     : "N/A");
    const QString protocol = metrics.protocol.isEmpty()
        ? QStringLiteral("N/A") : metrics.protocol;
    const QString target = metrics.targetFpsMilli > 0
        ? QString("%1 FPS").arg(metrics.targetFpsMilli / 1000.0, 0, 'f', 3)
        : QStringLiteral("N/A");
    const QString fixedState = !metrics.pcie
        ? QStringLiteral("N/A")
        : metrics.fixed30FpsActive
            ? QStringLiteral("生效")
            : metrics.rateControlSupported ? QStringLiteral("未运行")
                                           : QStringLiteral("不可用");
    m_captureProtocol->setText(QString("%1 | %2 | %3")
                                   .arg(protocol, target, fixedState));
    m_captureProtocol->setStyleSheet(!metrics.pcie
        ? QStringLiteral("color: #0f172a; font-weight: 600;")
        : metrics.fixed30FpsActive
            ? QStringLiteral("color: #166534; font-weight: 600;")
            : QStringLiteral("color: #b42318; font-weight: 600;"));
    m_captureRecovery->setText(QString("%1 | 恢复 %2 | 超时 %3")
        .arg(metrics.frameV2
                 ? (metrics.sourceLocked ? QStringLiteral("已锁定")
                                         : QStringLiteral("未锁定"))
                 : QStringLiteral("N/A"))
        .arg(metrics.recoveryCount)
        .arg(metrics.consecutiveTimeouts));
    m_captureRecovery->setToolTip(metrics.recoveryState);
    m_captureDma->setText(metrics.metricValid
                              ? metrics.frameV2
                                  ? QString("N/A / %1 / %2 / %3 ms")
                                        .arg(metrics.dmaWaitMs, 0, 'f', 2)
                                        .arg(metrics.kernelStagingMs, 0, 'f', 2)
                                        .arg(metrics.userCopyMs, 0, 'f', 2)
                                  : QString("%1 / %2 / %3 / %4 ms")
                                        .arg(metrics.dmaTransferMs, 0, 'f', 2)
                                        .arg(metrics.dmaWaitMs, 0, 'f', 2)
                                        .arg(metrics.kernelStagingMs, 0, 'f', 2)
                                        .arg(metrics.userCopyMs, 0, 'f', 2)
                              : "N/A");
    m_captureDma->setToolTip(metrics.frameV2
        ? QStringLiteral("V2元数据没有DMA完成时间戳；依次为DMA搬运/DQBUF等待/内核拼帧/用户拷贝")
        : QStringLiteral("依次为DMA搬运/等待/内核拼帧/用户拷贝"));
    m_captureFrames->setText(QString("%1 / %2")
                                 .arg(metrics.framesTotal)
                                 .arg(metrics.droppedFrames));
    m_captureConfig->setText(metrics.frameV2
        ? QString("%1x%2 | %3B | ring %4 | mmap %5 | %6")
              .arg(metrics.frameWidth).arg(metrics.frameHeight)
              .arg(metrics.frameBytes).arg(metrics.ringCount)
              .arg(metrics.mmapEnabled ? "是" : "否")
              .arg(metrics.irqMode.isEmpty() ? QStringLiteral("unknown") : metrics.irqMode)
        : QString("%1B x %2 | batch %3 | staged %4 | IRQ %5")
              .arg(metrics.dmaUnitBytes)
              .arg(metrics.dmaUnitCount)
              .arg(metrics.batchIoctl ? "是" : "否")
              .arg(metrics.stagedCopy ? "是" : "否")
              .arg(metrics.irqWait ? "是" : "否"));
    QString fallbackTip;
    if (!metrics.batchFallbackReason.isEmpty()) {
        fallbackTip += "batch: " + metrics.batchFallbackReason;
    }
    if (!metrics.irqFallbackReason.isEmpty()) {
        if (!fallbackTip.isEmpty()) fallbackTip += "\n";
        fallbackTip += "IRQ: " + metrics.irqFallbackReason;
    }
    if (!metrics.recoveryState.isEmpty()) {
        if (!fallbackTip.isEmpty()) fallbackTip += "\n";
        fallbackTip += "recovery: " + metrics.recoveryState;
    }
    if (metrics.frameV2) {
        if (!fallbackTip.isEmpty()) fallbackTip += "\n";
        fallbackTip += QString("BAR0(read)=%1B, BAR1(write)=%2B, source_mask=0x%3\n"
                               "build=0x%4 debug=0x%5 fifo01=0x%6 fifo23=0x%7 handshake=0x%8")
            .arg(metrics.readBarBytes).arg(metrics.writeBarBytes)
            .arg(metrics.sourceMask, 1, 16)
            .arg(metrics.fpgaBuildId, 8, 16, QLatin1Char('0'))
            .arg(metrics.fpgaDebugState, 8, 16, QLatin1Char('0'))
            .arg(metrics.fifoLevel01, 8, 16, QLatin1Char('0'))
            .arg(metrics.fifoLevel23, 8, 16, QLatin1Char('0'))
            .arg(metrics.fpgaHandshakeState, 8, 16, QLatin1Char('0'));
    }
    m_captureConfig->setToolTip(fallbackTip);
}

void DriverStatusDialog::refreshNow() {
    if (!m_table) return;

    const DriverStatusSnapshot snap = collectDriverStatus(&m_collectorState);
    updateCaptureMetrics(currentDriverCaptureMetrics());

    m_table->setUpdatesEnabled(false);
    m_table->clearSpans();
    m_table->clearContents();
    m_table->setRowCount(0);
    m_currentGroup.clear();
    m_groupStartRow = -1;

    for (const DriverStatusRow &row : snap.rows) {
        addRow(row.group, row.item, row.value, row.detail);
    }

    finishGroupSpan();
    m_table->resizeRowsToContents();
    for (int row = 0; row < m_table->rowCount(); ++row) {
        if (m_table->rowHeight(row) < 34) m_table->setRowHeight(row, 34);
    }
    m_table->setUpdatesEnabled(true);
}
