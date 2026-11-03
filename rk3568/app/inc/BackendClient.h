#ifndef BACKENDCLIENT_H
#define BACKENDCLIENT_H

#include <QObject>
#include <QUrl>
#include <QTimer>
#include <QNetworkAccessManager>
#include <QVector>
#include <QList>
#include <QJsonObject>

class QNetworkReply;

class BackendClient : public QObject {
    Q_OBJECT
public:
    explicit BackendClient(QObject *parent = nullptr);
    ~BackendClient() override;

    void setBaseUrl(const QUrl &baseUrl);
    void setBaseUrl(const QUrl &baseUrl, const QString &source);
    void setBaseUrlCandidates(const QVector<QUrl> &candidates);
    QUrl baseUrl() const { return m_baseUrl; }
    QString source() const { return m_source; }
    bool ok() const { return m_ok; }
    QString lastError() const { return m_lastError; }
    int lastLatencyMs() const { return m_lastLatencyMs; }
    QString lastOkAt() const { return m_lastOkAt; }
    QString lastTestAt() const { return m_lastTestAt; }
    bool autoDiscoveryAllowed() const;
    QString reportQueuePath() const { return m_reportQueuePath; }
    QJsonObject statusJson() const;
    bool postJson(const QString &path, const QJsonObject &body);

public slots:
    void start();
    void stop();
    void pingOnce();

signals:
    void statusChanged(bool ok, QString error);
    void baseUrlChanged(QUrl url);

private:
    struct QueuedReport {
        QString id;
        QString path;
        QJsonObject body;
        int attempts = 0;
        qint64 createdAtMs = 0;
        qint64 nextAttemptMs = 0;
        QString lastError;
    };

    void setOk(bool ok, const QString &err);
    void rotateCandidate();
    bool enqueueReport(const QString &path, const QJsonObject &body);
    void processReportQueue();
    void finishReportReply(QNetworkReply *reply, const QString &reportId);
    void moveToRejected(QueuedReport report, const QString &error);
    void loadReportQueue();
    qint64 queuedReportBytes(const QueuedReport &report) const;
    bool trimPendingReportsToByteLimit();
    void scheduleReportQueueSave();
    void saveReportQueue();
    QJsonObject reportDeliveryJson() const;

    QUrl m_baseUrl;
    QVector<QUrl> m_candidates;
    int m_candidateIndex = 0;
    bool m_baseLocked = false;
    QString m_source = "empty";
    bool m_ok = false;
    QString m_lastError;
    int m_lastLatencyMs = -1;
    QString m_lastOkAt;
    QString m_lastTestAt;
    int m_failStreak = 0;
    bool m_pingInFlight = false;
    QTimer m_timer;
    QTimer m_reportTimer;
    QTimer m_reportSaveTimer;
    QNetworkAccessManager m_nam;

    QList<QueuedReport> m_pendingReports;
    QList<QueuedReport> m_rejectedReports;
    bool m_reportInFlight = false;
    bool m_reportQueueDirty = false;
    bool m_reportQueuePersistOk = true;
    QString m_reportQueuePersistError;
    QString m_reportQueuePath;
    QString m_deviceId;
    int m_reportTimeoutMs = 5000;
    int m_maxPendingReports = 512;
    // A report may contain base64-encoded JPEGs. Count limits alone allow a
    // few hundred large violation reports to consume the whole eMMC.
    qint64 m_maxPendingReportBytes = 32LL * 1024LL * 1024LL;
    int m_maxRejectedReports = 64;
    qint64 m_reportAcceptedTotal = 0;
    qint64 m_reportRetryTotal = 0;
    qint64 m_reportRejectedTotal = 0;
    qint64 m_reportDroppedTotal = 0;
    int m_lastReportHttpStatus = 0;
    QString m_lastReportId;
    QString m_lastReportPath;
    QString m_lastReportResult;
    QString m_lastReportError;
    QString m_lastReportAttemptAt;
    QString m_lastReportOkAt;
    QString m_lastReportAckId;
};

#endif

