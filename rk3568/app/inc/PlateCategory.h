#pragma once

#include <QJsonObject>
#include <QString>

struct PlateCategoryInfo {
    QString code;
    QString name;
    QString rule;
};

QString normalizePlateForProtocol(const QString &plate);
QString plateCategoryRuleVersion();
PlateCategoryInfo classifyPlateCategory(const QString &plate, const QString &color);
void insertPlateCategoryFields(QJsonObject &object,
                               const QString &plate,
                               const PlateCategoryInfo &category);
