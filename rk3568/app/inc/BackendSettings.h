#pragma once

#include <QJsonObject>
#include <QProcessEnvironment>
#include <QString>
#include <QUrl>

struct BackendSettingsData {
    QString backendBase;
    QString backendSource = "empty";
    QString updatedAt;
};

QString backendSettingsPath();
QString defaultBackendBase();
QString backendBaseToString(const QUrl &url);
QUrl normalizeBackendBase(const QString &input, QString *error = nullptr);
BackendSettingsData loadBackendSettings();
BackendSettingsData loadEffectiveBackendSettings(const QProcessEnvironment &env = QProcessEnvironment::systemEnvironment());
bool saveBackendSettings(const BackendSettingsData &settings, QString *error = nullptr);
QJsonObject backendSettingsToJson(const BackendSettingsData &settings);
