#pragma once

#include <QObject>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QTimer>

class BackendClient;
class QNetworkReply;
class UserMessageConfig;

class UserMessageCloudSync : public QObject {
    Q_OBJECT
public:
    explicit UserMessageCloudSync(BackendClient *backendClient,
                                  UserMessageConfig *config,
                                  QObject *parent = nullptr);

    void start();
    void stop();
    QJsonObject statusJson() const;

public slots:
    void syncOnce();

signals:
    void configChanged();

private:
    QUrl buildPullUrl() const;
    void finishReply(QNetworkReply *rep, qint64 startedMs);

    BackendClient *m_backendClient = nullptr;
    UserMessageConfig *m_config = nullptr;
    QNetworkAccessManager m_nam;
    QTimer m_timer;
    bool m_inFlight = false;
    bool m_enabled = true;
    QString m_path;
    int m_timeoutMs = 5000;
    int m_intervalMs = 10000;
    bool m_lastOk = false;
    QString m_lastResult = "idle";
    QString m_lastError;
    int m_lastLatencyMs = -1;
    QString m_lastSyncAt;
    QString m_lastAppliedAt;
    int m_lastRemoteVersion = 0;
};
