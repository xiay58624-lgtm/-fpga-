#include "GpuVideoWidget.h"

#include <QDebug>
#include <QGuiApplication>
#include <QOffscreenSurface>
#include <QOpenGLContext>
#include <QOpenGLFunctions>
#include <QOpenGLWidget>
#include <QPainter>
#include <QPaintEvent>
#include <QResizeEvent>
#include <QSizePolicy>
#include <QSurfaceFormat>
#include <utility>

namespace {

bool isSoftwareRenderer(const QString &renderer) {
    const QString value = renderer.toLower();
    return value.contains(QStringLiteral("llvmpipe")) ||
           value.contains(QStringLiteral("softpipe")) ||
           value.contains(QStringLiteral("software rasterizer")) ||
           value.contains(QStringLiteral("swrast"));
}

struct OpenGlProbeResult {
    bool hardwareAvailable = false;
    QString renderer;
    QString version;
    QString reason;
};

const OpenGlProbeResult &openGlProbeResult() {
    static const OpenGlProbeResult result = []() {
        OpenGlProbeResult probe;
        const QByteArray setting = qgetenv("RK3568_GUI_OPENGL").trimmed();
        if (setting == "0") {
            probe.reason = QStringLiteral("disabled-by-RK3568_GUI_OPENGL");
            return probe;
        }

        QOpenGLContext context;
        context.setFormat(QSurfaceFormat::defaultFormat());
        if (!context.create() || !context.isValid()) {
            probe.reason = QStringLiteral("context-create-failed");
            return probe;
        }

        QOffscreenSurface surface;
        surface.setFormat(context.format());
        surface.create();
        if (!surface.isValid()) {
            probe.reason = QStringLiteral("offscreen-surface-failed");
            return probe;
        }
        if (!context.makeCurrent(&surface)) {
            probe.reason = QStringLiteral("make-current-failed");
            return probe;
        }

        QOpenGLFunctions *functions = context.functions();
        const GLubyte *renderer = functions
            ? functions->glGetString(GL_RENDERER) : nullptr;
        const GLubyte *version = functions
            ? functions->glGetString(GL_VERSION) : nullptr;
        probe.renderer = renderer
            ? QString::fromLatin1(reinterpret_cast<const char *>(renderer))
            : QStringLiteral("unknown");
        probe.version = version
            ? QString::fromLatin1(reinterpret_cast<const char *>(version))
            : QStringLiteral("unknown");
        context.doneCurrent();

        if (probe.renderer.isEmpty() || isSoftwareRenderer(probe.renderer)) {
            probe.reason = QStringLiteral("software-renderer:%1")
                .arg(probe.renderer.isEmpty()
                         ? QStringLiteral("unknown") : probe.renderer);
            return probe;
        }
        probe.hardwareAvailable = true;
        return probe;
    }();
    return result;
}

} // namespace

class GpuVideoWidget::OpenGlCanvas final : public QOpenGLWidget {
public:
    explicit OpenGlCanvas(GpuVideoWidget *owner)
        : QOpenGLWidget(owner), m_owner(owner) {
        setObjectName(QStringLiteral("gpuVideoCanvas"));
        setUpdateBehavior(QOpenGLWidget::NoPartialUpdate);
        setAutoFillBackground(false);
        setAttribute(Qt::WA_OpaquePaintEvent, true);
        setAttribute(Qt::WA_TransparentForMouseEvents, true);
    }

protected:
    void initializeGL() override {
        if (m_owner) m_owner->handleOpenGlInitialized();
    }

    void paintGL() override {
        if (!m_owner) return;
        QPainter painter(this);
        m_owner->paintFrame(painter, rect());
    }

private:
    GpuVideoWidget *m_owner = nullptr;
};

GpuVideoWidget::GpuVideoWidget(QWidget *parent)
    : QWidget(parent), m_statusText(QStringLiteral("等待采集...")) {
    setObjectName(QStringLiteral("gpuVideoWidget"));
    setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Expanding);
    setMinimumSize(160, 90);
    setAutoFillBackground(false);
    setAttribute(Qt::WA_OpaquePaintEvent, true);

    const OpenGlProbeResult &probe = openGlProbeResult();
    if (probe.hardwareAvailable) {
        m_rendererBackend = QStringLiteral("qt_opengl_widget");
        m_rendererName = probe.renderer;
        m_glCanvas = new OpenGlCanvas(this);
        m_glCanvas->setGeometry(rect());
        m_glCanvas->show();
    } else {
        m_rendererBackend = QStringLiteral("qt_raster_widget");
        m_rendererName = QStringLiteral("fallback:%1").arg(probe.reason);
        qWarning().noquote() << QString(
            "GUI_RENDER fallback backend=qt_raster_widget platform=%1 reason=%2")
            .arg(QGuiApplication::platformName(), probe.reason);
    }
}

void GpuVideoWidget::setFrame(QImage image) {
    m_frame = std::move(image);
    m_statusText.clear();
    requestRepaint();
}

void GpuVideoWidget::clearFrame() {
    m_frame = QImage();
    requestRepaint();
}

void GpuVideoWidget::setStatusText(const QString &text) {
    m_frame = QImage();
    m_statusText = text;
    requestRepaint();
}

void GpuVideoWidget::handleOpenGlInitialized() {
    m_glInitialized = true;
    QOpenGLContext *ctx = QOpenGLContext::currentContext();
    if (!ctx || !ctx->functions()) {
        m_rendererName = QStringLiteral("context-unavailable");
        m_hardwareAccelerated = false;
        qWarning().noquote() << "GUI_GPU init_failed context-unavailable";
        return;
    }

    const GLubyte *renderer = ctx->functions()->glGetString(GL_RENDERER);
    const GLubyte *version = ctx->functions()->glGetString(GL_VERSION);
    m_rendererName = renderer
        ? QString::fromLatin1(reinterpret_cast<const char *>(renderer))
        : QStringLiteral("unknown");
    const QString versionName = version
        ? QString::fromLatin1(reinterpret_cast<const char *>(version))
        : QStringLiteral("unknown");
    m_hardwareAccelerated = !m_rendererName.isEmpty() &&
                            !isSoftwareRenderer(m_rendererName);
    qInfo().noquote() << QString(
        "GUI_GPU initialized backend=qt_opengl_widget hardware=%1 renderer=%2 version=%3")
        .arg(m_hardwareAccelerated ? 1 : 0)
        .arg(m_rendererName, versionName);
}

void GpuVideoWidget::requestRepaint() {
    if (m_glCanvas) m_glCanvas->update();
    else update();
}

void GpuVideoWidget::paintEvent(QPaintEvent *event) {
    if (m_glCanvas) {
        event->accept();
        return;
    }
    QPainter painter(this);
    paintFrame(painter, rect());
}

void GpuVideoWidget::resizeEvent(QResizeEvent *event) {
    QWidget::resizeEvent(event);
    if (m_glCanvas) m_glCanvas->setGeometry(rect());
}

void GpuVideoWidget::paintFrame(QPainter &painter, const QRect &bounds) const {
    painter.setCompositionMode(QPainter::CompositionMode_Source);
    painter.fillRect(bounds, Qt::black);
    painter.setCompositionMode(QPainter::CompositionMode_SourceOver);

    if (!m_frame.isNull()) {
        QSize targetSize = m_frame.size();
        targetSize.scale(bounds.size(), Qt::KeepAspectRatio);
        const QRect target(
            bounds.x() + (bounds.width() - targetSize.width()) / 2,
            bounds.y() + (bounds.height() - targetSize.height()) / 2,
            targetSize.width(), targetSize.height());
        painter.setRenderHint(QPainter::SmoothPixmapTransform, true);
        painter.drawImage(target, m_frame);
        return;
    }

    painter.setPen(Qt::white);
    painter.drawText(bounds.adjusted(16, 16, -16, -16),
                     Qt::AlignCenter | Qt::TextWordWrap,
                     m_statusText);
}
