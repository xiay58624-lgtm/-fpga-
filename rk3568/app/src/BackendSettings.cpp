#include "BackendSettings.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QSaveFile>
#include <QStandardPaths>
#include <QTimeZone>

namespace {

QString nowBjTextBackend() {
    QTimeZone tz("Asia/Shanghai");
    return QDateTime::currentDateTimeUtc().toTimeZone(tz).toString("yyyy-MM-dd HH:mm:ss");
}

QString stripTrailingSlash(QString s) {
    while (s.endsWith("/") && s.size() > QString("http://x").size()) s.chop(1);
    return s;
}

} // namespace

QString defaultBackendBase() {
    const QByteArray disabled = qgetenv("RK3568_DISABLE_DEFAULT_BACKEND").trimmed().toLower();
    if (disabled == "1" || disabled == "true" || disabled == "yes" || disabled == "on") return QString();
    const QByteArray envDefault = qgetenv("RK3568_DEFAULT_BACKEND_BASE");
    if (!envDefault.trimmed().isEmpty()) return QString::fromUtf8(envDefault).trimmed();
    return QString("http://101.201.76.16");
}

QString backendBaseToString(const QUrl &url) {
    if (!url.isValid()) return QString();
    return stripTrailingSlash(url.toString());
}

QString backendSettingsPath() {
    const QByteArray envPath = qgetenv("RK3568_BACKEND_CONFIG_PATH");
    if (!envPath.isEmpty()) return QString::fromUtf8(envPath);
    if (QDir("/userdata").exists()) return QString("/userdata/rk3568/backend_config.json");
    QString base = QStandardPaths::writableLocation(QStandardPaths::AppConfigLocation);
    if (base.isEmpty()) base = QDir::homePath();
    return QDir(base).filePath("backend_config.json");
}

QUrl normalizeBackendBase(const QString &input, QString *error) {
    if (error) error->clear();
    QString s = stripTrailingSlash(input.trimmed());
    if (s.isEmpty()) {
        if (error) *error = "后端地址不能为空";
        return QUrl();
    }

    QUrl u(s);
    const QString scheme = u.scheme().toLower();
    if (!u.isValid() || (scheme != "http" && scheme != "https") || u.host().trimmed().isEmpty()) {
        if (error) *error = "后端地址必须是 http:// 或 https:// 开头的基础地址";
        return QUrl();
    }
    if (u.hasQuery() || u.hasFragment()) {
        if (error) *error = "后端基础地址不能包含 query 或 fragment";
        return QUrl();
    }
    const QString path = u.path().trimmed();
    if (!path.isEmpty() && path != "/") {
        if (error) *error = "后端基础地址不能包含 /api/... 接口路径";
        return QUrl();
    }

    const QString host = u.host().trimmed().toLower();
    if (host == "127.0.0.1" || host == "localhost" || host == "::1") {
        if (error) *error = "127.0.0.1/localhost 表示 RK3568 自己，不能作为云后端地址";
        return QUrl();
    }

    if (host == "101.201.76.16" && u.port(-1) == 8080) {
        if (error) *error = "cloud public backend should use http://101.201.76.16, not internal port 8080";
        return QUrl();
    }

    u.setScheme(scheme);
    u.setPath("");
    u.setQuery(QString());
    u.setFragment(QString());
    return u;
}

BackendSettingsData loadBackendSettings() {
    BackendSettingsData s;
    QFile f(backendSettingsPath());
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text)) return s;
    const QJsonObject o = QJsonDocument::fromJson(f.readAll()).object();
    s.backendBase = o.value("backend_base").toString().trimmed();
    s.backendSource = o.value("backend_source").toString("settings").trimmed();
    if (s.backendSource.isEmpty()) s.backendSource = "settings";
    s.updatedAt = o.value("updated_at").toString();
    QString err;
    QUrl u = normalizeBackendBase(s.backendBase, &err);
    if (!u.isValid()) {
        s.backendBase.clear();
        s.backendSource = "empty";
    } else {
        s.backendBase = backendBaseToString(u);
    }
    return s;
}

BackendSettingsData loadEffectiveBackendSettings(const QProcessEnvironment &env) {
    BackendSettingsData saved = loadBackendSettings();
    if (!saved.backendBase.isEmpty()) return saved;

    const QString v1 = env.value("PC_BACKEND_BASE").trimmed();
    const QString v2 = env.value("BACKEND_BASE_URL").trimmed();
    const QString v3 = env.value("RK3568_DEFAULT_BACKEND_BASE").trimmed();
    const QString baseStr = !v1.isEmpty() ? v1 : (!v2.isEmpty() ? v2 : (!v3.isEmpty() ? v3 : defaultBackendBase()));
    QString err;
    QUrl u = normalizeBackendBase(baseStr, &err);
    if (u.isValid()) {
        BackendSettingsData s;
        s.backendBase = backendBaseToString(u);
        if (!v1.isEmpty()) s.backendSource = "env:PC_BACKEND_BASE";
        else if (!v2.isEmpty()) s.backendSource = "env:BACKEND_BASE_URL";
        else if (!v3.isEmpty()) s.backendSource = "env:RK3568_DEFAULT_BACKEND_BASE";
        else s.backendSource = "default";
        return s;
    }
    return BackendSettingsData{};
}

bool saveBackendSettings(const BackendSettingsData &settings, QString *error) {
    if (error) error->clear();
    QString err;
    QUrl u = normalizeBackendBase(settings.backendBase, &err);
    if (!u.isValid()) {
        if (error) *error = err;
        return false;
    }

    BackendSettingsData out = settings;
    out.backendBase = backendBaseToString(u);
    if (out.backendSource.isEmpty() || out.backendSource == "empty") out.backendSource = "settings";
    out.updatedAt = nowBjTextBackend();

    const QString p = backendSettingsPath();
    QDir().mkpath(QFileInfo(p).absolutePath());
    QSaveFile f(p);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        if (error) *error = f.errorString();
        return false;
    }
    f.write(QJsonDocument(backendSettingsToJson(out)).toJson(QJsonDocument::Indented));
    if (!f.commit()) {
        if (error) *error = f.errorString();
        return false;
    }
    return true;
}

QJsonObject backendSettingsToJson(const BackendSettingsData &settings) {
    QJsonObject o;
    o.insert("schema", "rk3568.backend_config.v1");
    o.insert("backend_base", settings.backendBase);
    o.insert("backend_source", settings.backendSource.isEmpty() ? "settings" : settings.backendSource);
    o.insert("updated_at", settings.updatedAt.isEmpty() ? nowBjTextBackend() : settings.updatedAt);
    return o;
}
