#pragma once

#include <QDialog>
#include <QDateTime>
#include <QImage>
#include <QMap>
#include <QTableWidget>
#include <QLineEdit>
#include <QDoubleSpinBox>
#include <QSpinBox>
#include <QComboBox>
#include <QPushButton>
#include <QStackedWidget>
#include <QTabWidget>
#include <QTimeZone>
#include <QJsonObject>
#include <QTimer>

class BusinessDialog : public QDialog {
    Q_OBJECT

public:
    enum class Page { Parking = 0, Etc = 1 };

    explicit BusinessDialog(QWidget *parent = nullptr);
    explicit BusinessDialog(Page onlyPage, QWidget *parent = nullptr);
    void setPage(Page page);
    QJsonObject handlePlateEvent(const QImage &thumb, const QString &plate, const QString &timeBj, int source, double conf);
    QJsonObject applyRemoteOp(const QString &system, const QString &op, const QString &plate, double amount);
    QJsonObject buildBizReport() const;

signals:
    void bizReportReady(const QJsonObject &payload);

private:
    enum class ParkingBillingMode { Hourly = 0, Custom = 1 };
    enum class ParkingRoundingPolicy { RoundUp = 0, Truncate = 1 };

    struct ParkingConfig {
        int freeMinutes = 15;
        ParkingBillingMode mode = ParkingBillingMode::Hourly;
        ParkingRoundingPolicy rounding = ParkingRoundingPolicy::RoundUp;
        double pricePerHour = 10.0;
        int unitMinutes = 30;
        double pricePerUnit = 5.0;
    };

    struct ParkingActive {
        QDateTime entryTime;
        int entrySource = 0;
    };

    struct ParkingRecord {
        QString plate;
        QDateTime entryTime;
        QDateTime exitTime;
        int minutes = 0;
        double fee = 0.0;
        int entrySource = 0;
        int exitSource = 0;
    };

    struct ParkingTxn {
        QDateTime time;
        QString plate;
        int source = 0;
        double amount = 0.0;
        double balanceAfter = 0.0;
        double arrearsAfter = 0.0;
        QString result;
    };

    struct EtcConfig {
        double tollYuan = 10.0;
    };

    struct EtcRecord {
        QDateTime time;
        QString plate;
        int source = 0;
        double amount = 0.0;
        double balanceAfter = 0.0;
        double arrearsAfter = 0.0;
        QString result;
    };

    QString configPath() const;
    void loadConfig();
    void saveConfig();
    void maybeEmitBizReport(bool force);

    static QDateTime parseBjTime(const QString &timeBj);
    static double calcParkingFeeMinutes(int minutes, const ParkingConfig &cfg);

    void buildUi();
    QWidget* buildParkingPage();
    QWidget* buildEtcPage();

    void refreshParkingTables();
    void refreshEtcTables();

    void applyParkingConfigFromUi();
    void applyEtcConfigFromUi();
    void updateParkingModeUi();

    void addParkingRecord(const ParkingRecord &r);
    void addParkingTxn(const ParkingTxn &r);
    void addEtcRecord(const EtcRecord &r);
    QString etcPlateFromUi() const;
    QString parkingPlateFromUi() const;
    void settleEtcArrears(const QString &plate, const QDateTime &t, int source, const QString &reason);
    void settleParkingArrears(const QString &plate, const QDateTime &t, int source, const QString &reason);

    QStackedWidget *m_stack = nullptr;
    QPushButton *m_parkingBtn = nullptr;
    QPushButton *m_etcBtn = nullptr;
    bool m_singleMode = false;
    Page m_onlyPage = Page::Parking;
    QTimer *m_reportTimer = nullptr;
    qint64 m_lastReportAtMs = 0;
    int m_reportMinIntervalMs = 2000;

    ParkingConfig m_parkingCfg;
    QMap<QString, ParkingActive> m_activeCars;
    QList<ParkingRecord> m_parkingRecords;
    QMap<QString, double> m_parkingAccounts;
    QMap<QString, double> m_parkingArrears;
    QList<ParkingTxn> m_parkingTxns;

    EtcConfig m_etcCfg;
    QMap<QString, double> m_etcAccounts;
    QMap<QString, double> m_etcArrears;
    QList<EtcRecord> m_etcRecords;

    QSpinBox *m_freeMinutes = nullptr;
    QComboBox *m_parkingModeBox = nullptr;
    QComboBox *m_parkingRoundingBox = nullptr;
    QWidget *m_hourlyCfgWidget = nullptr;
    QWidget *m_customCfgWidget = nullptr;
    QDoubleSpinBox *m_pricePerHour = nullptr;
    QSpinBox *m_unitMinutes = nullptr;
    QDoubleSpinBox *m_pricePerUnit = nullptr;
    QPushButton *m_parkingClearBtn = nullptr;
    QPushButton *m_parkingExportBtn = nullptr;
    QPushButton *m_parkingAccOpenBtn = nullptr;
    QComboBox *m_parkingProvBox = nullptr;
    QLineEdit *m_parkingPlateEdit = nullptr;
    QDoubleSpinBox *m_parkingRechargeAmt = nullptr;
    QDoubleSpinBox *m_parkingDeductAmt = nullptr;
    QPushButton *m_parkingAccRechargeBtn = nullptr;
    QPushButton *m_parkingManualDeductBtn = nullptr;
    QPushButton *m_parkingAccCancelBtn = nullptr;
    QPushButton *m_parkingAccImportBtn = nullptr;
    QPushButton *m_parkingAccExportBtn = nullptr;
    QTableWidget *m_parkingActiveTable = nullptr;
    QTableWidget *m_parkingRecordsTable = nullptr;
    QTableWidget *m_parkingAccountsTable = nullptr;
    QPushButton *m_parkingTxnClearBtn = nullptr;
    QPushButton *m_parkingTxnExportBtn = nullptr;
    QTableWidget *m_parkingTxnTable = nullptr;

    QDoubleSpinBox *m_etcToll = nullptr;
    QComboBox *m_etcProvBox = nullptr;
    QLineEdit *m_etcPlateEdit = nullptr;
    QDoubleSpinBox *m_etcRechargeAmt = nullptr;
    QDoubleSpinBox *m_etcDeductAmt = nullptr;
    QPushButton *m_etcAddBtn = nullptr;
    QPushButton *m_etcRechargeBtn = nullptr;
    QPushButton *m_etcManualDeductBtn = nullptr;
    QPushButton *m_etcCancelBtn = nullptr;
    QPushButton *m_etcClearBtn = nullptr;
    QPushButton *m_etcExportBtn = nullptr;
    QPushButton *m_etcAccImportBtn = nullptr;
    QPushButton *m_etcAccExportBtn = nullptr;
    QTableWidget *m_etcAccountsTable = nullptr;
    QTableWidget *m_etcRecordsTable = nullptr;
};
