#pragma once

#include <QMainWindow>
#include <QImage>
#include <QJsonObject>
#include <array>

#include "CaptureThread.h"
#include "DriverStatusCollector.h"
#include "UserBusinessStore.h"
#include "UserMessageConfig.h"

class QLabel;
class QPushButton;
class QComboBox;
class QTabWidget;
class ApiServer;
class BackendClient;
class VehicleClient;
class UserMessageCloudSync;
class TtsWavPlayer;
class GpuVideoWidget;

class UserWindow : public QMainWindow {
    Q_OBJECT
public:
    enum class SystemPage { Parking = 0, Etc = 1 };

    explicit UserWindow(SystemPage onlyPage, QWidget *parent = nullptr);
    ~UserWindow();

signals:
    void switchAccountRequested();

private slots:
    void updateFrame(QImage img, quint64 displayConfigVersion);
    void handleStartStop();
    void handleViewModeChanged(int index);
    void handleInputModeChanged(int index);
    void openMosaicConfig();
    void onPlateReport(QImage thumb, QString plate, QString color, QString time, int source, double recConf, double detConf);
    void onTabChanged(int index);
    void requestSwitchAccount();

private:
    QWidget* buildParkingPage();
    QWidget* buildEtcPage();
    void setupBackend();
    void applyInputModeUi();
    bool ensureSdSourceReady();
    void applySdSourcePath(const QString &path);
    void applyViewSelection(QComboBox *changedBox, int index);
    QString showParkingMessage(const UserBusinessStore::ParkingOutcome &out, QString *templateKey);
    QString showEtcMessage(const UserBusinessStore::EtcOutcome &out, QString *templateKey);
    void postStatus(bool force = false);
    void postUserMessage(const QJsonObject &payload);
    void postBusinessSnapshot();

    QTabWidget *m_tabs = nullptr;
    bool m_singleMode = true;
    SystemPage m_onlyPage = SystemPage::Parking;

    GpuVideoWidget *m_parkingVideoLabel = nullptr;
    QComboBox *m_parkingViewModeBox = nullptr;
    QPushButton *m_parkingMosaicCfgBtn = nullptr;
    QLabel *m_parkingMsg = nullptr;

    GpuVideoWidget *m_etcVideoLabel = nullptr;
    QComboBox *m_etcViewModeBox = nullptr;
    QPushButton *m_etcMosaicCfgBtn = nullptr;
    QLabel *m_etcMsg = nullptr;

    QPushButton *m_controlBtn = nullptr;
    QPushButton *m_switchBtn = nullptr;
    QComboBox *m_inputModeBox = nullptr;
    QPushButton *m_sdImportBtn = nullptr;
    QLabel *m_inputInfoLabel = nullptr;
    QLabel *m_backendCommLabel = nullptr;

    CaptureThread *m_captureThread = nullptr;
    quint64 m_expectedDisplayConfigVersion = 0;
    ApiServer *m_apiServer = nullptr;
    BackendClient *m_backendClient = nullptr;
    VehicleClient *m_vehicleClient = nullptr;
    UserMessageCloudSync *m_userMessageCloudSync = nullptr;
    TtsWavPlayer *m_ttsPlayer = nullptr;
    bool m_isCapturing = false;
    CaptureThread::InputMode m_inputMode = CaptureThread::InputMode::Pcie;
    QString m_sdSourcePath;
    std::array<int, 4> m_mosaicMapping{1, 2, 3, 4};

    UserBusinessStore m_store;
    UserMessageConfig m_userMessageConfig;
    qint64 m_lastStatusPostMs = 0;
    DriverStatusCollectorState m_driverStatusState;
    QJsonObject m_lastDetRuntimeMetrics;
};

