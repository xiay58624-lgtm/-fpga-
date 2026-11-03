#pragma once

#include <QImage>
#include <QString>
#include <QWidget>

class QPainter;
class QPaintEvent;
class QResizeEvent;

// Prefer an OpenGL child canvas for video scaling, but keep a raster QWidget
// fallback. Some RK images ship an xcb plugin built without GLX/EGL; creating
// QOpenGLWidget directly on those images prevents the entire window from
// composing, so availability must be proven before the child is constructed.
class GpuVideoWidget final : public QWidget {
public:
    explicit GpuVideoWidget(QWidget *parent = nullptr);

    void setFrame(QImage image);
    void clearFrame();
    void setStatusText(const QString &text);

    bool glInitialized() const { return m_glInitialized; }
    bool hardwareAccelerated() const { return m_hardwareAccelerated; }
    QString rendererName() const { return m_rendererName; }
    QString rendererBackend() const { return m_rendererBackend; }

protected:
    void paintEvent(QPaintEvent *event) override;
    void resizeEvent(QResizeEvent *event) override;

private:
    class OpenGlCanvas;
    friend class OpenGlCanvas;

    void paintFrame(QPainter &painter, const QRect &bounds) const;
    void handleOpenGlInitialized();
    void requestRepaint();

    QImage m_frame;
    QString m_statusText;
    QString m_rendererBackend = QStringLiteral("qt_raster_widget");
    QString m_rendererName = QStringLiteral("raster-fallback");
    OpenGlCanvas *m_glCanvas = nullptr;
    bool m_glInitialized = false;
    bool m_hardwareAccelerated = false;
};
