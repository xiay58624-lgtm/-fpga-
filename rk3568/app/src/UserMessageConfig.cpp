#include "UserMessageConfig.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QSaveFile>
#include <QStandardPaths>
#include <QTimeZone>

UserMessageConfig::UserMessageConfig() {
    m_updatedAt = nowBjText();
    putDefaults(m_parking, "parking", parkingKeys());
    putDefaults(m_etc, "etc", etcKeys());
    load();
}

QString UserMessageConfig::nowBjText() {
    QTimeZone tz("Asia/Shanghai");
    return QDateTime::currentDateTimeUtc().toTimeZone(tz).toString("yyyy-MM-dd HH:mm:ss");
}

QStringList UserMessageConfig::parkingKeys() {
    return {"entry", "exit_free", "exit_deducted", "exit_insufficient", "exit_not_opened", "arrears_suffix"};
}

QStringList UserMessageConfig::etcKeys() {
    return {"pass_deducted", "pass_insufficient", "pass_not_opened", "arrears_suffix"};
}

QString UserMessageConfig::defaultTemplate(const QString &systemIn, const QString &key) {
    const QString system = normalizeSystem(systemIn);
    if (system == "parking") {
        if (key == "entry") return "欢迎车牌{plate}驶入本停车场";
        if (key == "exit_free") return "车牌{plate}驶离本停车场，停车时间为{duration}，停车费为{fee}元，本次免费";
        if (key == "exit_deducted") return "车牌{plate}驶离本停车场，停车时间为{duration}，停车费为{fee}元，已扣费{paid}元";
        if (key == "exit_insufficient") return "车牌{plate}驶离本停车场，停车时间为{duration}，停车费为{fee}元，账户余额不足，请扫码支付{need_pay}元";
        if (key == "exit_not_opened") return "车牌{plate}驶离本停车场，停车时间为{duration}，停车费为{fee}元，未开卡，请扫码支付{fee}元";
        if (key == "arrears_suffix") return "（欠费{arrears}元）";
    }
    if (system == "etc") {
        if (key == "pass_deducted") return "车牌{plate}，ETC通行费为{fee}元，已扣费{paid}元";
        if (key == "pass_insufficient") return "车牌{plate}，ETC通行费为{fee}元，账户余额不足，请扫码支付{need_pay}元";
        if (key == "pass_not_opened") return "车牌{plate}，ETC通行费为{fee}元，未开卡，请扫码支付{fee}元";
        if (key == "arrears_suffix") return "（欠费{arrears}元）";
    }
    return "";
}

QString UserMessageConfig::normalizeSystem(const QString &system) {
    const QString s = system.trimmed().toLower();
    return s == "etc" ? "etc" : "parking";
}

bool UserMessageConfig::isAllowedKey(const QString &systemIn, const QString &key) {
    const QString system = normalizeSystem(systemIn);
    const QStringList keys = system == "etc" ? etcKeys() : parkingKeys();
    return keys.contains(key);
}

QString UserMessageConfig::cleanTemplate(QString text) {
    text = text.trimmed();
    text.replace('\r', ' ');
    text.replace('\n', ' ');
    while (text.contains("  ")) text.replace("  ", " ");
    if (text.size() > 300) text = text.left(300);
    return text;
}

void UserMessageConfig::putDefaults(QMap<QString, QString> &target, const QString &system, const QStringList &keys) {
    for (const QString &key : keys) {
        if (!target.contains(key) || target.value(key).trimmed().isEmpty()) {
            target[key] = defaultTemplate(system, key);
        }
    }
}

QString UserMessageConfig::configPath() const {
    const QByteArray envPath = qgetenv("RK3568_USER_MESSAGE_PATH");
    if (!envPath.isEmpty()) return QString::fromUtf8(envPath);

    const QByteArray authPath = qgetenv("RK3568_AUTH_PATH");
    if (!authPath.isEmpty()) {
        QFileInfo fi(QString::fromUtf8(authPath));
        return QDir(fi.absolutePath()).filePath("user_message_config.json");
    }

    if (QDir("/userdata").exists()) return QString("/userdata/rk3568/user_message_config.json");

    QString base = QStandardPaths::writableLocation(QStandardPaths::AppConfigLocation);
    if (base.isEmpty()) base = QDir::homePath();
    return QDir(base).filePath("user_message_config.json");
}

void UserMessageConfig::load() {
    QFile f(configPath());
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text)) return;
    QJsonParseError err;
    const QJsonDocument doc = QJsonDocument::fromJson(f.readAll(), &err);
    if (err.error != QJsonParseError::NoError || !doc.isObject()) return;
    QString ignored;
    applyJson(doc.object(), &ignored);
}

bool UserMessageConfig::save() const {
    const QString p = configPath();
    QDir().mkpath(QFileInfo(p).absolutePath());
    QSaveFile f(p);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) return false;
    f.write(QJsonDocument(toJson(true)).toJson(QJsonDocument::Indented));
    return f.commit();
}

QJsonObject UserMessageConfig::toJson(bool includeTemplates) const {
    QJsonObject root;
    root.insert("schema", "rk3568.user_message_config.v1");
    root.insert("version", m_version);
    root.insert("updated_at", m_updatedAt);
    if (!includeTemplates) return root;

    QJsonObject templates;
    QJsonObject parking;
    for (const QString &key : parkingKeys()) parking.insert(key, m_parking.value(key, defaultTemplate("parking", key)));
    QJsonObject etc;
    for (const QString &key : etcKeys()) etc.insert(key, m_etc.value(key, defaultTemplate("etc", key)));
    templates.insert("parking", parking);
    templates.insert("etc", etc);
    root.insert("templates", templates);
    return root;
}

bool UserMessageConfig::applyJson(const QJsonObject &objIn, QString *error) {
    QJsonObject obj = objIn;
    if (obj.contains("config") && obj.value("config").isObject()) obj = obj.value("config").toObject();
    QJsonObject templates = obj.value("templates").toObject();
    if (templates.isEmpty() && (obj.contains("parking") || obj.contains("etc"))) templates = obj;

    bool changed = false;
    auto applySystem = [&](const QString &system, QMap<QString, QString> &target) {
        const QJsonObject src = templates.value(system).toObject();
        if (src.isEmpty()) return;
        const QStringList keys = system == "etc" ? etcKeys() : parkingKeys();
        for (const QString &key : keys) {
            if (!src.contains(key)) continue;
            const QString next = cleanTemplate(src.value(key).toString());
            if (next.isEmpty()) continue;
            if (target.value(key) == next) continue;
            target[key] = next;
            changed = true;
        }
    };

    applySystem("parking", m_parking);
    applySystem("etc", m_etc);
    putDefaults(m_parking, "parking", parkingKeys());
    putDefaults(m_etc, "etc", etcKeys());

    const int incomingVersion = obj.value("version").toInt(m_version);
    if (incomingVersion > 0 && incomingVersion != m_version) {
        m_version = incomingVersion;
        changed = true;
    } else if (changed) {
        m_version += 1;
    }
    const QString incomingUpdated = obj.value("updated_at").toString().trimmed();
    m_updatedAt = incomingUpdated.isEmpty() ? nowBjText() : incomingUpdated;

    if (!changed && templates.isEmpty()) {
        if (error) *error = "no_valid_templates";
        return false;
    }
    return save();
}

QString UserMessageConfig::render(const QString &systemIn, const QString &key, const QMap<QString, QString> &vars) const {
    const QString system = normalizeSystem(systemIn);
    const QMap<QString, QString> &map = system == "etc" ? m_etc : m_parking;
    QString text = map.value(key);
    if (text.trimmed().isEmpty() || !isAllowedKey(system, key)) text = defaultTemplate(system, key);
    for (auto it = vars.begin(); it != vars.end(); ++it) {
        text.replace(QString("{%1}").arg(it.key()), it.value());
    }
    return text.trimmed();
}
