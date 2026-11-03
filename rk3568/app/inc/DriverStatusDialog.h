#pragma once

#include "DriverStatusCollector.h"

#include <QDialog>
#include <QString>

class QPushButton;
class QTableWidget;
class QTimer;
class QLabel;

class DriverStatusDialog : public QDialog {
    Q_OBJECT
public:
    explicit DriverStatusDialog(QWidget *parent = nullptr);

private slots:
    void refreshNow();

private:
    void addRow(const QString &group, const QString &item, const QString &value, const QString &detail = QString());
    void finishGroupSpan();
    void updateCaptureMetrics(const DriverCaptureMetrics &metrics);

    QTableWidget *m_table = nullptr;
    QPushButton *m_refreshBtn = nullptr;
    QTimer *m_timer = nullptr;
    QLabel *m_captureStatus = nullptr;
    QLabel *m_captureFps = nullptr;
    QLabel *m_captureInterval = nullptr;
    QLabel *m_captureProtocol = nullptr;
    QLabel *m_captureRecovery = nullptr;
    QLabel *m_captureDma = nullptr;
    QLabel *m_captureFrames = nullptr;
    QLabel *m_captureConfig = nullptr;

    DriverStatusCollectorState m_collectorState;
    QString m_currentGroup;
    int m_groupStartRow = -1;
};
