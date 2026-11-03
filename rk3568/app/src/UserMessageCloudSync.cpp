#include "UserMessageCloudSync.h"

#include "BackendClient.h"
#include "UserMessageConfig.h"

#include <QDateTime>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QProcessEnvironment>
#include <QTimeZone>
#include <QUrl>
#include <QUrlQuery>
#include <algorithm>

namespace {

QString nowBjSyncText() {
    QTimeZone tz("Asia/Shanghai");
    return QDateTime::currentDateTimeUtc().toTimeZone(tz).toString("yyyy-MM-dd HH:mm:ss");
}

int envIntSync(const char *name, int def, int lo, int hi) {
    const QByteArray raw = qgetenv(name).trimmed();
    if (raw.isEmpty()) return def;
    bool ok = false;
    const int v = raw.toInt(&ok);
    if (!ok) return def;
    return std::max(lo, std::min(hi, v));
}

bool envBoolSync(const char *name, bool def) {
    const QByteArray raw = qgetenv(name).trimmed().toLower();
    if (raw.isEmpty()) return def;
    return !(raw == "0" || raw == "false" || raw == "off" || raw == "no");
}

} // namespace

UserMessageCloudSync::UserMessageCloudSync(BackendClient *backendClient,
                                           UserMessageConfig *config,
                                           QObject *parent)
    : QObject(parent),
      m_backendClient(backendClient),
      m_config(config) {
    const QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    m_enabled = envBoolSync("RK3568_USER_MESSAGE_CLOUD_SYNC", true);
    m_path = env.value("RK3568_USER_MESSAGE_PULL_PATH").trimmed();
    if (m_path.isEmpty()) m_path = "/api/rk/user-message/config";
    if (!m_path.startsWith("/")) m_path.prepend("/");
    m_intervalMs = envIntSync("RK3568_USER_MESSAGE_PULL_INTERVAL_MS", 10000, 1000, 3600000);
    m_timeoutMs = envIntSync("RK3568_USER_MESSAGE_PULL_TIMEOUT_MS", 5000, 1000, 60000);
    m_timer.setInterval(m_intervalMs);
    connect(&m_timer, &QTimer::timeout, this, &UserMessageCloudSync::syncOnce);
}

void UserMessageCloudSync::start() {
    if (!m_enabled) {
        m_lastResult = "disabled";
        return;
    }
    if (!m_timer.isActive()) m_timer.start();
    syncOnce();
}

void UserMessageCloudSync::stop() {
    m_timer.stop();
}

QUrl UserMessageCloudSync::buildPullUrl() const {
    if (!m_backendClient) return QUrl();
    QUrl u = m_backendClient->baseUrl();
    if (!u.isValid() || u.host().isEmpty()) return QUrl();
    QString basePath = u.path();
    if (!basePath.endsWith("/")) basePath += "/";
    QString merged = basePath;
    merged += m_path.startsWith("/") ? m_path.mid(1) : m_path;
    u.setPath(merged);
    QUrlQuery q;
    q.addQueryItem("device", "rk3568");
    if (m_config) q.addQueryItem("version", QString::number(m_config->version()));
    q.addQueryItem("ts", QString::number(QDateTime::currentMSecsSinceEpoch()));
    u.setQuery(q);
    return u;
}

void UserMessageCloudSync::syncOnce() {
    if (!m_enabled) return;
    if (m_inFlight) return;
    if (!m_backendClient || !m_config) {
        m_lastOk = false;
        m_lastResult = "not_ready";
        m_lastError = "no_backend_or_config";
        return;
    }
    const QUrl u = buildPullUrl();
    if (!u.isValid() || u.host().isEmpty()) {
        m_lastOk = false;
        m_lastResult = "no_backend_base";
        m_lastError = "no_backend_base";
        return;
    }

    QNetworkRequest req(u);
    req.setHeader(QNetworkRequest::UserAgentHeader, "rk3568-gui");
    const qint64 startedMs = QDateTime::currentMSecsSinceEpoch();
    QNetworkReply *rep = m_nam.get(req);
    rep->setParent(this);
    m_inFlight = true;
    QTimer::singleShot(m_timeoutMs, rep, [rep]() {
        if (rep && rep->isRunning()) rep->abort();
    });
    connect(rep, &QNetworkReply::finished, this, [this, rep, startedMs]() {
        finishReply(rep, startedMs);
    });
}

void UserMessageCloudSync::finishReply(QNetworkReply *rep, qint64 startedMs) {
    m_inFlight = false;
    m_lastSyncAt = nowBjSyncText();
    m_lastLatencyMs = (int)std::max<qint64>(0, QDateTime::currentMSecsSinceEpoch() - startedMs);

    const int httpCode = rep->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    const QByteArray data = rep->isOpen() ? rep->readAll() : QByteArray();
    const QString netError = rep->error() == QNetworkReply::NoError ? QString() : rep->errorString();
    rep->deleteLater();

    if (!netError.isEmpty()) {
        m_lastOk = false;
        m_lastResult = "network_error";
        m_lastError = netError;
        return;
    }
    if (httpCode == 204 || data.trimmed().isEmpty()) {
        m_lastOk = true;
        m_lastResult = "no_update";
        m_lastError.clear();
        return;
    }
    if (httpCode < 200 || httpCode >= 300) {
        m_lastOk = false;
        m_lastResult = "http_error";
        m_lastError = QString("HTTP %1").arg(httpCode);
        return;
    }

    QJsonParseError pe;
    QJsonDocument doc = QJsonDocument::fromJson(data, &pe);
    if (pe.error != QJsonParseError::NoError || !doc.isObject()) {
        m_lastOk = false;
        m_lastResult = "bad_json";
        m_lastError = pe.errorString();
        return;
    }

    QJsonObject root = doc.object();
    if (root.contains("ok") && !root.value("ok").toBool(true)) {
        m_lastOk = false;
        m_lastResult = "remote_error";
        m_lastError = root.value("error").toString("remote_error");
        return;
    }

    QJsonObject cfg = root.value("config").isObject() ? root.value("config").toObject() : root;
    const int remoteVersion = cfg.value("version").toInt(0);
    m_lastRemoteVersion = remoteVersion;
    if (remoteVersion > 0 && m_config && remoteVersion <= m_config->version()) {
        m_lastOk = true;
        m_lastResult = "already_latest";
        m_lastError.clear();
        return;
    }

    QString applyError;
    const bool applied = m_config->applyJson(cfg, &applyError);
    if (!applied) {
        m_lastOk = false;
        m_lastResult = "apply_failed";
        m_lastError = applyError.isEmpty() ? "apply_failed" : applyError;
        return;
    }

    m_lastOk = true;
    m_lastResult = "applied";
    m_lastError.clear();
    m_lastAppliedAt = m_lastSyncAt;
    emit configChanged();
}

QJsonObject UserMessageCloudSync::statusJson() const {
    QJsonObject o;
    o.insert("enabled", m_enabled);
    o.insert("path", m_path);
    o.insert("interval_ms", m_intervalMs);
    o.insert("timeout_ms", m_timeoutMs);
    o.insert("syncing", m_inFlight);
    o.insert("last_ok", m_lastOk);
    o.insert("last_result", m_lastResult);
    o.insert("last_error", m_lastError);
    if (m_lastLatencyMs >= 0) o.insert("last_latency_ms", m_lastLatencyMs);
    if (!m_lastSyncAt.isEmpty()) o.insert("last_sync_at", m_lastSyncAt);
    if (!m_lastAppliedAt.isEmpty()) o.insert("last_applied_at", m_lastAppliedAt);
    if (m_lastRemoteVersion > 0) o.insert("last_remote_version", m_lastRemoteVersion);
    return o;
}
