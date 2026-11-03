#ifndef MAINWINDOW_H
#define MAINWINDOW_H

#include <QMainWindow>
#include <QLabel>
#include <QPushButton>
#include <QSlider>
#include <QTabWidget>
#include <QComboBox>
#include <QLineEdit>
#include <QList>
#include <QScrollArea>
#include <QVBoxLayout>
#include <QTimer>
#include <QDir>
#include <QDate>
#include <QJsonObject>
#include <array>
#include <QStringList>
#include "CaptureThread.h"
#include "BusinessDialog.h"
#include "DriverStatusCollector.h"
#include "PerfDialog.h"
#include "RuntimeSettings.h"
#include "UserMessageConfig.h"
class ApiServer;
class BackendClient;
class DriverStatusDialog;
class UserMessageCloudSync;
class TtsWavPlayer;
class GpuVideoWidget;
class QCheckBox;

enum class AppTheme { Dark, Light, OceanBlue, Lavender };

class MainWindow : public QMainWindow {
    Q_OBJECT

public:
    enum class BusinessSystem { Parking = 0, Etc = 1 };
    enum class TurnDirection {
        None = -1, Straight = 0, Left = 1, Right = 2, Stop = 3,
        LaneLeft = 4, LaneRight = 5
    };

    MainWindow(BusinessSystem system, bool developerMode = true, QWidget *parent = nullptr);
    ~MainWindow();
    void setTurnCardDirection(TurnDirection direction);

signals:
    void switchAccountRequested();

protected:
    void resizeEvent(QResizeEvent *event) override;

private slots:
    void updateFrame(QImage img, quint64 displayConfigVersion);
    void updateRoadInference(int direction, bool forbidden, bool slow, QString status);
    void handleRoadInferenceTelemetry(QJsonObject payload);
    void updateFps(double fps);
    void handleStartStop();
    void openSettings();
    void handleViewModeChanged(int index);
    void handleInputModeChanged(int index);
    void openMosaicConfig();
    void onPlateReport(QImage thumb, QString plate, QString color, QString time, int source, double recConf, double detConf);
    void applyTheme(AppTheme theme);
    void openParking();
    void openEtc();
    void openPerf();
    void openDriverStatus();

private:
    void configureRoadMode();
    void applyInputModeUi();
    bool ensureSdSourceReady();
    void applySdSourcePath(const QString &path);
    void applySdVideoPaths(const QStringList &paths);
    void postStatus(const QString &view, bool force = false);
    void postRoadInferenceTelemetry(const QJsonObject &payload);
    void postBusinessSnapshot();

    struct PlateItem {
        QImage thumb;
        QString plate;
        QString color;
        QString time;
        int source;
        double recConf;
        double detConf;
        QWidget *widget;
    };

    GpuVideoWidget *m_videoLabel = nullptr;
    QLabel *m_fpsLabel = nullptr;
    QLabel *m_statusLabel = nullptr;
    QLabel *m_modelLabel = nullptr;
    QLabel *m_clockLabel = nullptr;
    QLabel *m_backendCommLabel = nullptr;
    QPushButton *m_controlBtn = nullptr;
    QPushButton *m_settingsBtn = nullptr;
    QPushButton *m_parkingBtn = nullptr;
    QPushButton *m_etcBtn = nullptr;
    QPushButton *m_perfBtn = nullptr;
    QPushButton *m_switchBtn = nullptr;
    QPushButton *m_driverBtn = nullptr;
    QComboBox *m_inputModeBox = nullptr;
    QPushButton *m_sdImportBtn = nullptr;
    QPushButton *m_videoImportBtn = nullptr;
    QLabel *m_inputInfoLabel = nullptr;
    QComboBox *m_viewModeBox = nullptr;
    QPushButton *m_mosaicCfgBtn = nullptr;
    QScrollArea *m_plateScroll = nullptr;
    QWidget *m_plateContainer = nullptr;
    QVBoxLayout *m_plateListLayout = nullptr;
    QTimer *m_clockTimer = nullptr;
    QComboBox *m_plateSourceFilter = nullptr;
    QComboBox *m_plateProvBox = nullptr;
    QLineEdit *m_plateSearch = nullptr;
    QPushButton *m_plateQueryBtn = nullptr;
    QPushButton *m_plateChooseDirBtn = nullptr;
    QPushButton *m_plateSaveBtn = nullptr;
    QLabel *m_plateDirLabel = nullptr;
    QString m_plateSaveDir;
    QList<PlateItem> m_plateItems;

    CaptureThread *m_captureThread = nullptr;
    QCheckBox *m_adasModelBox = nullptr;
    QCheckBox *m_navigationModelBox = nullptr;
    QWidget *m_adasOptionsPanel = nullptr;
    QCheckBox *m_adasLightsBox = nullptr;
    QCheckBox *m_adasLinesBox = nullptr;
    QCheckBox *m_adasVehiclesBox = nullptr;
    QCheckBox *m_adasAllBox = nullptr;
    QLabel *m_roadModelStatusLabel = nullptr;
    QLabel *m_roadDecisionLabel = nullptr;
    TurnDirection m_turnCardDirection = TurnDirection::None;
    int m_inferredDirection = -1;
    bool m_inferredForbidden = false;
    bool m_inferredSlow = false;
    int m_selectedRoadMode = 0;
    quint64 m_expectedDisplayConfigVersion = 0;
    ApiServer *m_apiServer = nullptr;
    BackendClient *m_backendClient = nullptr;
    UserMessageCloudSync *m_userMessageCloudSync = nullptr;
    TtsWavPlayer *m_ttsPlayer = nullptr;
    bool m_isCapturing = false;
    AppTheme m_currentTheme;
    float m_currentConf;
    CaptureThread::InputMode m_inputMode = CaptureThread::InputMode::Pcie;
    QString m_sdSourcePath;
    QStringList m_sdVideoPaths;
    std::array<int, 4> m_mosaicMapping;
    QList<QStringList> m_reportRows;
    BusinessDialog *m_businessDlg = nullptr;
    bool m_bizReportConnected = false;
    PerfDialog *m_perfDlg = nullptr;
    DriverStatusDialog *m_driverDlg = nullptr;
    BusinessSystem m_businessSystem;
    bool m_developerMode = true;
    CaptureThread::AlgoMode m_algoMode = CaptureThread::AlgoMode::PlateOnly;

    bool m_plateFilterActive = false;
    int m_plateFilterSourceSel = 0;
    QString m_plateFilterProv;
    QString m_plateFilterRest;

    double m_lastFps = 0.0;
    double m_lastCaptureMs = 0.0;
    double m_lastConvMs = 0.0;
    double m_lastViewMs = 0.0;
    double m_lastDetMs = 0.0;
    double m_lastOcrMs = 0.0;
    double m_lastEnvMs = 0.0;
    double m_lastInferMs = 0.0;
    double m_lastUiMs = 0.0;
    double m_lastDispMs = 0.0;
    double m_lastTotalMs = 0.0;
    QJsonObject m_lastDetRuntimeMetrics;
    qint64 m_lastRoadTelemetryPostMs = 0;
    QString m_lastRoadTelemetryFingerprint;
    quint64 m_lastPcieRxFrames = 0;
    qint64 m_lastStatusPostMs = 0;
    DriverStatusCollectorState m_driverStatusState;
    UserMessageConfig m_userMessageConfig;
    RuntimeSettingsData m_runtimeSettings;
};

#endif
