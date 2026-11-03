#pragma once

#include <QJsonObject>
#include <QMap>
#include <QString>
#include <QStringList>

class UserMessageConfig {
public:
    UserMessageConfig();

    QString configPath() const;
    void load();
    bool save() const;

    QJsonObject toJson(bool includeTemplates = true) const;
    bool applyJson(const QJsonObject &obj, QString *error = nullptr);

    QString render(const QString &system, const QString &key, const QMap<QString, QString> &vars) const;
    int version() const { return m_version; }
    QString updatedAt() const { return m_updatedAt; }

    static QStringList parkingKeys();
    static QStringList etcKeys();
    static QString defaultTemplate(const QString &system, const QString &key);

private:
    static QString nowBjText();
    static QString cleanTemplate(QString text);
    static void putDefaults(QMap<QString, QString> &target, const QString &system, const QStringList &keys);
    static QString normalizeSystem(const QString &system);
    static bool isAllowedKey(const QString &system, const QString &key);

    int m_version = 1;
    QString m_updatedAt;
    QMap<QString, QString> m_parking;
    QMap<QString, QString> m_etc;
};
