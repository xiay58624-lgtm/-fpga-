#pragma once

#include <QDateTime>
#include <QTimeZone>
#include <QList>
#include <QMap>
#include <QString>

class UserBusinessStore {
public:
    enum class ParkingEventType { Entry = 0, Exit = 1, Ignored = 2 };
    enum class PayStatus { None = 0, Deducted = 1, Insufficient = 2, NotOpened = 3 };

    struct ParkingOutcome {
        ParkingEventType type = ParkingEventType::Ignored;
        QString plate;
        QDateTime time;
        int minutes = 0;
        double fee = 0.0;
        PayStatus payStatus = PayStatus::None;
        double paidFromBalance = 0.0;
        double needPay = 0.0;
        double balanceAfter = 0.0;
        double arrearsAfter = 0.0;
    };

    struct EtcOutcome {
        QString plate;
        QDateTime time;
        double fee = 0.0;
        PayStatus payStatus = PayStatus::None;
        double paidFromBalance = 0.0;
        double needPay = 0.0;
        double balanceAfter = 0.0;
        double arrearsAfter = 0.0;
    };

    UserBusinessStore();

    ParkingOutcome onParkingPlate(const QString &plate, const QString &timeBj, int source);
    EtcOutcome onEtcPlate(const QString &plate, const QString &timeBj, int source);
    QJsonObject buildBizReport() const;

    static QString formatDurationMinutes(int minutes);

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

    static QTimeZone bjTz();
    static QDateTime parseBjTime(const QString &timeBj);
    static double calcParkingFeeMinutes(int minutes, const ParkingConfig &cfg);

    QString configPath() const;
    void loadConfig();
    void saveConfig();
    void refreshIfChanged();

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

    QDateTime m_lastConfigMTime;
};

