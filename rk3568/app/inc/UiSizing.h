#pragma once

#include <QGuiApplication>
#include <QRect>
#include <QScreen>
#include <QSize>
#include <QWidget>
#include <QtGlobal>

namespace UiSizing {

inline QRect availableGeometry(const QWidget *widget = nullptr) {
    QScreen *screen = widget ? widget->screen() : nullptr;
    if (!screen) screen = QGuiApplication::primaryScreen();
    return screen ? screen->availableGeometry() : QRect(0, 0, 1280, 720);
}

inline bool isCompact720(const QWidget *widget = nullptr) {
    const QByteArray forced = qgetenv("RK3568_UI_720P").trimmed().toLower();
    if (forced == "1" || forced == "true" || forced == "yes") return true;
    if (forced == "0" || forced == "false" || forced == "no") return false;
    const QRect geometry = availableGeometry(widget);
    return geometry.width() <= 1366 || geometry.height() <= 768;
}

inline QSize boundedWindowSize(const QWidget *widget, const QSize &preferred, int margin = 24) {
    const QRect geometry = availableGeometry(widget);
    const int maxWidth = qMax(320, geometry.width() - margin);
    const int maxHeight = qMax(240, geometry.height() - margin);
    return QSize(qMin(preferred.width(), maxWidth), qMin(preferred.height(), maxHeight));
}

inline void fitWindow(QWidget *widget, const QSize &preferred, int margin = 24) {
    if (!widget) return;
    widget->resize(boundedWindowSize(widget, preferred, margin));
}

} // namespace UiSizing
