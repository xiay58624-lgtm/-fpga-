#include "ApiServer.h"
#include "BackendSettings.h"
#include "BackendClient.h"
#include "BusinessDialog.h"
#include "UserMessageConfig.h"
#include "VehicleClient.h"
#include "CaptureThread.h"
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QPointer>
#include <QTcpSocket>
#include <QTimer>
#include <QDateTime>
#include <QJsonDocument>
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QAbstractSocket>
#include <QUrl>
#include <QUrlQuery>
#include <QtGlobal>
#include <QCoreApplication>
#include <QThread>
#include <QDebug>

static QByteArray httpStatusText(int code) {
    if (code == 200) return "OK";
    if (code == 204) return "No Content";
    if (code == 400) return "Bad Request";
    if (code == 403) return "Forbidden";
    if (code == 404) return "Not Found";
    if (code == 405) return "Method Not Allowed";
    if (code == 503) return "Service Unavailable";
    return "Error";
}

static QUrl backendPingUrl(QUrl base) {
    QString path = base.path();
    if (!path.endsWith("/")) path += "/";
    path += "api/ping";
    base.setPath(path);
    base.setQuery(QString("ts=%1").arg(QDateTime::currentMSecsSinceEpoch()));
    return base;
}

static QJsonObject backendConfigReply(BackendClient *client) {
    QJsonObject o;
    o.insert("ok", true);
    o.insert("config_path", backendSettingsPath());
    if (client) {
        const QJsonObject st = client->statusJson();
        for (auto it = st.begin(); it != st.end(); ++it) o.insert(it.key(), it.value());
    } else {
        o.insert("backend_base", "");
        o.insert("backend_source", "empty");
        o.insert("backend_ok", false);
        o.insert("backend_error", "no_backend_client");
    }
    const BackendSettingsData saved = loadBackendSettings();
    if (!saved.backendBase.isEmpty()) {
        o.insert("saved_backend_base", saved.backendBase);
        o.insert("saved_backend_source", saved.backendSource);
        o.insert("saved_updated_at", saved.updatedAt);
    }
    const BackendSettingsData effective = loadEffectiveBackendSettings();
    if (!effective.backendBase.isEmpty()) {
        o.insert("effective_backend_base", effective.backendBase);
        o.insert("effective_backend_source", effective.backendSource);
    }
    return o;
}

ApiServer::ApiServer(BackendClient *backendClient,
                     BusinessDialog *businessDialog,
                     UserMessageConfig *userMessageConfig,
                     VehicleClient *vehicleClient,
                     CaptureThread *captureThread,
                     QObject *parent)
    : QObject(parent),
      m_backendClient(backendClient),
      m_businessDialog(businessDialog),
      m_userMessageConfig(userMessageConfig),
      m_vehicleClient(vehicleClient),
      m_captureThread(captureThread) {
    connect(&m_srv, &QTcpServer::newConnection, this, &ApiServer::onNewConn);
    if (auto *application = QCoreApplication::instance()) {
        connect(application, &QCoreApplication::aboutToQuit,
                this, &ApiServer::stopRawFrameServer);
    }
}

ApiServer::~ApiServer() {
    stopRawFrameServer();
}

void ApiServer::stopRawFrameServer() {
    if (m_rawFrameThread && m_rawFrameThread->isRunning()) {
        m_rawFrameThread->quit();
        m_rawFrameThread->wait();
    }
}

void ApiServer::startRawFrameServer() {
    if (!m_captureThread || m_rawFrameThread) return;
    bool configured = false;
    const int requestedPort = qEnvironmentVariableIntValue("RK3568_RAW_HTTP_PORT", &configured);
    const int rawPort = configured ? requestedPort : 3001;
    if (rawPort <= 0 || rawPort > 65535) return;

    CaptureThread *capture = m_captureThread;
    m_rawFrameThread = new QThread(this);
    m_rawFrameThread->setObjectName("RawFrameHttp");
    QObject *worker = new QObject;
    worker->moveToThread(m_rawFrameThread);
    connect(m_rawFrameThread, &QThread::finished, worker, &QObject::deleteLater);
    connect(m_rawFrameThread, &QThread::started, worker, [worker, capture, rawPort]() {
        auto *server = new QTcpServer(worker);
        server->setMaxPendingConnections(4);
        QObject::connect(server, &QTcpServer::newConnection, server, [server, capture]() {
            while (server->hasPendingConnections()) {
                QTcpSocket *socket = server->nextPendingConnection();
                socket->setSocketOption(QAbstractSocket::LowDelayOption, 1);
                QObject::connect(socket, &QTcpSocket::disconnected,
                                 socket, &QObject::deleteLater);
                QTimer::singleShot(2000, socket, [socket]() {
                    if (socket->state() != QAbstractSocket::UnconnectedState) socket->abort();
                });
                QObject::connect(socket, &QTcpSocket::readyRead, socket, [socket, capture]() {
                    if (socket->property("frame_reply_started").toBool()) return;
                    QByteArray request = socket->property("frame_request").toByteArray();
                    request += socket->readAll();
                    if (request.size() > 8192) {
                        socket->abort();
                        return;
                    }
                    if (!request.contains("\r\n\r\n")) {
                        socket->setProperty("frame_request", request);
                        return;
                    }
                    socket->setProperty("frame_reply_started", true);
                    const QList<QByteArray> parts = request.left(request.indexOf('\n')).trimmed().split(' ');
                    const auto fail = [socket](int code, const QByteArray &body) {
                        const QByteArray reply = "HTTP/1.1 " + QByteArray::number(code) + " " +
                            httpStatusText(code) + "\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: " +
                            QByteArray::number(body.size()) + "\r\n\r\n" + body;
                        socket->write(reply);
                        socket->disconnectFromHost();
                    };
                    if (parts.size() != 3 || parts.at(0) != "GET" ||
                        parts.at(1) != "/api/adas/frame/raw") {
                        fail(404, "not_found");
                        return;
                    }
                    QImage frame;
                    QJsonObject metadata;
                    // This accessor takes the capture mutex and shares an immutable QImage.
                    if (!capture->latestFrameRgb24(frame, metadata)) {
                        fail(503, "frame_not_ready");
                        return;
                    }
                    const qint64 bytes = qint64(frame.width()) * frame.height() * 3;
                    QByteArray headers = "HTTP/1.1 200 OK\r\nConnection: close\r\nCache-Control: no-store\r\n";
                    headers += "Content-Type: application/octet-stream\r\nContent-Length: " + QByteArray::number(bytes) + "\r\n";
                    headers += "X-RK-Frame-Sequence: " + QByteArray::number(metadata.value("frame_sequence").toDouble(), 'f', 0) + "\r\n";
                    headers += "X-RK-Frame-Width: " + QByteArray::number(frame.width()) + "\r\n";
                    headers += "X-RK-Frame-Height: " + QByteArray::number(frame.height()) + "\r\n";
                    headers += "X-RK-Pixel-Format: RGB24\r\nX-RK-Captured-At: " + metadata.value("captured_at").toString().toLatin1() + "\r\n\r\n";
                    socket->write(headers);
                    socket->write(reinterpret_cast<const char *>(frame.constBits()), bytes);
                    socket->disconnectFromHost();
                });
            }
        });
        if (server->listen(QHostAddress::LocalHost, quint16(rawPort))) {
            qInfo() << "RK_RAW_FRAME_HTTP listening on loopback port" << rawPort;
        } else {
            qWarning() << "RK_RAW_FRAME_HTTP listen failed:" << server->errorString();
        }
    });
    m_rawFrameThread->start();
}

bool ApiServer::listen(quint16 port, const QHostAddress &addr) {
    if (m_srv.isListening()) m_srv.close();
    const bool ok = m_srv.listen(addr, port);
    if (ok) m_port = m_srv.serverPort();
    else m_port = 0;
    if (ok) startRawFrameServer();
    return ok;
}

bool ApiServer::isListening() const {
    return m_srv.isListening();
}

QString ApiServer::serverAddress() const {
    return m_srv.isListening() ? m_srv.serverAddress().toString() : QString();
}

QString ApiServer::errorString() const {
    return m_srv.errorString();
}

void ApiServer::onNewConn() {
    while (m_srv.hasPendingConnections()) {
        QTcpSocket *s = m_srv.nextPendingConnection();
        s->setParent(this);
        handleSocket(s);
    }
}

void ApiServer::handleSocket(QTcpSocket *s) {
    connect(s, &QTcpSocket::readyRead, this, [this, s]() {
        QByteArray buf = s->property("rx_buf").toByteArray();
        buf += s->readAll();
        s->setProperty("rx_buf", buf);
        if (buf.isEmpty()) return;
        const int headEnd = buf.indexOf("\r\n\r\n");
        if (headEnd < 0) return;
        const QByteArray head = buf.left(headEnd);
        const QList<QByteArray> lines = head.split('\n');
        if (lines.isEmpty()) {
            replyText(s, 400, "bad_request");
            return;
        }
        int contentLength = 0;
        for (const QByteArray &line0 : lines) {
            const QByteArray line = line0.trimmed();
            const int colon = line.indexOf(':');
            if (colon <= 0) continue;
            const QByteArray key = line.left(colon).trimmed().toLower();
            if (key == "content-length") contentLength = qMax(0, line.mid(colon + 1).trimmed().toInt());
        }
        const int bodyStart = headEnd + 4;
        if (buf.size() < bodyStart + contentLength) return;
        const QByteArray body = contentLength > 0 ? buf.mid(bodyStart, contentLength) : buf.mid(bodyStart);
        const QList<QByteArray> parts = lines[0].trimmed().split(' ');
        if (parts.size() < 2) {
            replyText(s, 400, "bad_request_line");
            return;
        }
        const QByteArray method = parts[0].trimmed();
        const QByteArray rawPath = parts[1].trimmed();
        const QByteArray path = rawPath.split('?').value(0);
        const QUrl reqUrl(QString("http://x%1").arg(QString::fromUtf8(rawPath)));
        const QUrlQuery q(reqUrl);

        if (method == "OPTIONS") {
            replyText(s, 204, QByteArray(), "text/plain; charset=utf-8");
            return;
        }

        if (method == "GET" && path == "/api/adas/frame/raw") {
            if (!m_captureThread) {
                replyJson(s, 503, QJsonDocument(QJsonObject{{"ok", false}, {"error", "no_capture_thread"}}).toJson(QJsonDocument::Compact));
                return;
            }
            QImage frame;
            QJsonObject meta;
            if (m_captureThread->latestFrameRgb24(frame, meta)) {
                QByteArray headers = "X-RK-Frame-Sequence: " +
                    QByteArray::number(meta.value("frame_sequence").toDouble()) + "\r\n";
                headers += "X-RK-Frame-Width: " + QByteArray::number(meta.value("width").toInt()) + "\r\n";
                headers += "X-RK-Frame-Height: " + QByteArray::number(meta.value("height").toInt()) + "\r\n";
                headers += "X-RK-Pixel-Format: RGB24\r\n";
                const int pixelBytes = frame.width() * frame.height() * 3;
                const QByteArray pixels = QByteArray::fromRawData(
                    reinterpret_cast<const char *>(frame.constBits()), pixelBytes);
                replyBinary(s, 200, pixels, "application/octet-stream", headers);
            } else {
                replyJson(s, 503, QJsonDocument(QJsonObject{{"ok", false}, {"error", "frame_not_ready"}}).toJson(QJsonDocument::Compact));
            }
            return;
        }

        if (method == "GET" && path == "/api/adas/frame/nv12") {
            if (!m_captureThread) {
                replyJson(s, 503, QJsonDocument(QJsonObject{{"ok", false}, {"error", "no_capture_thread"}}).toJson(QJsonDocument::Compact));
                return;
            }
            QByteArray pixels;
            QJsonObject meta;
            if (m_captureThread->latestFrameNv12(pixels, meta)) {
                QByteArray headers = "X-RK-Frame-Sequence: " +
                    QByteArray::number(meta.value("frame_sequence").toDouble()) + "\r\n";
                headers += "X-RK-Frame-Width: " + QByteArray::number(meta.value("width").toInt()) + "\r\n";
                headers += "X-RK-Frame-Height: " + QByteArray::number(meta.value("height").toInt()) + "\r\n";
                headers += "X-RK-Pixel-Format: NV12\r\n";
                replyBinary(s, 200, pixels, "application/octet-stream", headers);
            } else {
                replyJson(s, 503, QJsonDocument(QJsonObject{{"ok", false}, {"error", "nv12_conversion_failed"}}).toJson(QJsonDocument::Compact));
            }
            return;
        }

        if (method == "GET" && path == "/api/adas/frame") {
            if (!m_captureThread) {
                replyJson(s, 503, QJsonDocument(QJsonObject{{"ok", false}, {"error", "no_capture_thread"}}).toJson(QJsonDocument::Compact));
                return;
            }
            bool sourceOk = false;
            const int source = q.queryItemValue("source").toInt(&sourceOk);
            const int selectedSource = sourceOk ? source : 0;
            if (selectedSource < 0 || selectedSource > 4) {
                replyJson(s, 400, QJsonDocument(QJsonObject{{"ok", false}, {"error", "invalid_source"}}).toJson(QJsonDocument::Compact));
                return;
            }
            QByteArray jpeg;
            QJsonObject meta;
            if (m_captureThread->latestFrameJpeg(selectedSource, jpeg, meta)) {
                replyBinary(s, 200, jpeg, "image/jpeg",
                            "X-RK-Frame-Sequence: " +
                                QByteArray::number(meta.value("frame_sequence").toDouble()) +
                                "\r\n");
            } else {
                replyJson(s, 503, QJsonDocument(QJsonObject{{"ok", false}, {"error", "frame_not_ready"}}).toJson(QJsonDocument::Compact));
            }
            return;
        }
        if (method == "GET" && path == "/api/adas/snapshot") {
            if (!m_captureThread) {
                replyJson(s, 503, QJsonDocument(QJsonObject{{"ok", false}, {"error", "no_capture_thread"}}).toJson(QJsonDocument::Compact));
                return;
            }
            bool sourceOk = false;
            const int source = q.queryItemValue("source").toInt(&sourceOk);
            const int selectedSource = sourceOk ? source : 0;
            if (selectedSource < 0 || selectedSource > 4) {
                replyJson(s, 400, QJsonDocument(QJsonObject{{"ok", false}, {"error", "invalid_source"}}).toJson(QJsonDocument::Compact));
                return;
            }
            QByteArray jpeg;
            QJsonObject meta;
            QJsonObject detections;
            if (!m_captureThread->latestFrameJpeg(selectedSource, jpeg, meta)) {
                replyJson(s, 503, QJsonDocument(QJsonObject{{"ok", false}, {"error", "frame_not_ready"}}).toJson(QJsonDocument::Compact));
                return;
            }
            if (!m_captureThread->latestDetections(detections)) {
                detections.insert("ok", true);
                detections.insert("frame_sequence", meta.value("frame_sequence"));
                detections.insert("width", 1280);
                detections.insert("height", 720);
                detections.insert("detections", QJsonArray());
                detections.insert("status", "not_ready");
            }
            QJsonArray outputDetections;
            const QJsonArray mosaicDetections = detections.value("detections").toArray();
            const int frameWidth = meta.value("width").toInt(1280);
            const int frameHeight = meta.value("height").toInt(720);
            if (selectedSource == 0) {
                outputDetections = mosaicDetections;
            } else {
                // The detector works on the 1280x720 2x2 mosaic.  When a
                // caller asks for one 640x360 tile, crop/translate the same
                // boxes so the image and overlay remain in one coordinate
                // system.  This also keeps legacy four-tile viewers usable.
                const int mosaicWidth = qMax(1, frameWidth * 2);
                const int mosaicHeight = qMax(1, frameHeight * 2);
                const int halfW = qMax(1, mosaicWidth / 2);
                const int halfH = qMax(1, mosaicHeight / 2);
                const int originX = (selectedSource == 2 || selectedSource == 4) ? halfW : 0;
                const int originY = selectedSource >= 3 ? halfH : 0;
                const int tileRight = originX + halfW;
                const int tileBottom = originY + halfH;
                for (const QJsonValue &value : mosaicDetections) {
                    if (!value.isObject()) continue;
                    QJsonObject item = value.toObject();
                    const int left = item.value("left").toInt();
                    const int top = item.value("top").toInt();
                    const int right = item.value("right").toInt();
                    const int bottom = item.value("bottom").toInt();
                    const int clippedLeft = qMax(left, originX);
                    const int clippedTop = qMax(top, originY);
                    const int clippedRight = qMin(right, tileRight);
                    const int clippedBottom = qMin(bottom, tileBottom);
                    if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) continue;
                    item.insert("left", clippedLeft - originX);
                    item.insert("top", clippedTop - originY);
                    item.insert("right", clippedRight - originX);
                    item.insert("bottom", clippedBottom - originY);
                    outputDetections.append(item);
                }
            }
            QJsonObject out = meta;
            out.insert("ok", true);
            out.insert("control_owner", "external_upper_computer");
            out.insert("coordinate_space", selectedSource == 0 ? "mosaic_1280x720" : "source_640x360");
            out.insert("detections", outputDetections);
            out.insert("detection_frame_sequence", detections.value("frame_sequence"));
            const qint64 frameSequence = static_cast<qint64>(meta.value("frame_sequence").toDouble());
            const qint64 detectionSequence = static_cast<qint64>(detections.value("frame_sequence").toDouble());
            out.insert("detections_stale", frameSequence != detectionSequence);
            out.insert("detection_age_frames", frameSequence >= detectionSequence
                ? frameSequence - detectionSequence : 0);
            out.insert("image_base64", QString::fromLatin1(jpeg.toBase64()));
            replyJson(s, 200, QJsonDocument(out).toJson(QJsonDocument::Compact));
            return;
        }
        if (method == "GET" && path == "/api/detections/latest") {
            if (!m_captureThread) {
                replyJson(s, 503, QJsonDocument(QJsonObject{{"ok", false}, {"error", "no_capture_thread"}}).toJson(QJsonDocument::Compact));
                return;
            }
            QJsonObject payload;
            if (m_captureThread->latestDetections(payload)) {
                replyJson(s, 200, QJsonDocument(payload).toJson(QJsonDocument::Compact));
            } else {
                replyJson(s, 503, QJsonDocument(QJsonObject{{"ok", false}, {"error", "detections_not_ready"}}).toJson(QJsonDocument::Compact));
            }
            return;
        }

        const QHostAddress peerAddr = s->peerAddress();
        QString ip;
        if (peerAddr.protocol() == QAbstractSocket::IPv6Protocol) {
            bool ok = false;
            const quint32 v4 = peerAddr.toIPv4Address(&ok);
            if (ok) ip = QHostAddress(v4).toString();
        } else {
            ip = peerAddr.toString();
        }
        if (!ip.isEmpty() && ip != "127.0.0.1" && ip != "::1") {
            m_lastPeerIp = ip;
            emit peerDiscovered(m_lastPeerIp);
        }

        if (method == "GET" && path == "/api/ping") {
            QJsonObject o;
            o.insert("ok", true);
            o.insert("device", "rk3568");
            o.insert("role", "adas_perception_display");
            o.insert("display_only", true);
            o.insert("control_owner", "external_upper_computer");
            o.insert("frame_api", "/api/adas/frame?source=0..4");
            o.insert("snapshot_api", "/api/adas/snapshot?source=0");
            o.insert("detection_api", "/api/detections/latest");
            o.insert("time_bj", QDateTime::currentDateTime().toString("yyyy-MM-dd HH:mm:ss"));
            if (!m_lastPeerIp.isEmpty()) o.insert("peer_ip", m_lastPeerIp);
            if (m_userMessageConfig) {
                o.insert("user_message_config", m_userMessageConfig->toJson(false));
            }
            if (m_backendClient) {
                const QString backendPortRaw = q.queryItemValue("backend_port").trimmed();
                const int backendPort = backendPortRaw.isEmpty() ? 0 : backendPortRaw.toInt();
                if (backendPort > 0 && backendPort <= 65535 && !ip.isEmpty() &&
                    m_backendClient->autoDiscoveryAllowed()) {
                    QUrl base(QString("http://%1:%2/").arg(ip).arg(backendPort));
                    m_backendClient->setBaseUrl(base, "auto");
                    m_backendClient->start();
                }
                const QJsonObject st = m_backendClient->statusJson();
                for (auto it = st.begin(); it != st.end(); ++it) o.insert(it.key(), it.value());
            } else {
                o.insert("backend_ok", false);
                o.insert("backend_base", "");
                o.insert("backend_error", "no_backend_client");
            }
            if (m_vehicleClient) {
                const QJsonObject vehicle = m_vehicleClient->statusJson();
                for (auto it = vehicle.begin(); it != vehicle.end(); ++it) o.insert(it.key(), it.value());
            }
            const QByteArray json = QJsonDocument(o).toJson(QJsonDocument::Compact);
            replyJson(s, 200, json);
            return;
        }
        if (path == "/api/vehicle/status") {
            if (!m_vehicleClient) {
                replyJson(s, 503, QJsonDocument(QJsonObject{{"ok", false}, {"error", "no_vehicle_client"}}).toJson(QJsonDocument::Compact));
                return;
            }
            if (method != "GET") {
                replyText(s, 405, "method_not_allowed");
                return;
            }
            QJsonObject out = m_vehicleClient->statusJson();
            out.insert("ok", true);
            out.insert("display_only", true);
            out.insert("control_owner", "external_upper_computer");
            replyJson(s, 200, QJsonDocument(out).toJson(QJsonDocument::Compact));
            return;
        }
        if (path == "/api/vehicle/command" || path == "/api/vehicle/stop") {
            QJsonObject out;
            out.insert("ok", false);
            out.insert("error", "vehicle_control_delegated");
            out.insert("message", "小车指令由外部上位机发送，RK3568 感知端不接受遥控指令");
            out.insert("control_owner", "external_upper_computer");
            out.insert("display_only", true);
            replyJson(s, 403, QJsonDocument(out).toJson(QJsonDocument::Compact));
            return;
        }
        if (path == "/api/backend/config") {
            if (!m_backendClient) {
                replyJson(s, 503, QJsonDocument(QJsonObject{{"ok", false}, {"error", "no_backend_client"}}).toJson(QJsonDocument::Compact));
                return;
            }
            if (method == "GET") {
                replyJson(s, 200, QJsonDocument(backendConfigReply(m_backendClient)).toJson(QJsonDocument::Compact));
                return;
            }
            if (method == "POST") {
                QJsonParseError err;
                const QJsonDocument doc = QJsonDocument::fromJson(body, &err);
                if (err.error != QJsonParseError::NoError || !doc.isObject()) {
                    replyJson(s, 400, QJsonDocument(QJsonObject{{"ok", false}, {"error", "bad_json"}}).toJson(QJsonDocument::Compact));
                    return;
                }
                const QJsonObject in = doc.object();
                QString normError;
                QUrl base = normalizeBackendBase(in.value("backend_base").toString(), &normError);
                if (!base.isValid()) {
                    replyJson(s, 400, QJsonDocument(QJsonObject{{"ok", false}, {"error", "bad_backend_base"}, {"message", normError}}).toJson(QJsonDocument::Compact));
                    return;
                }
                const bool save = !in.contains("save") || in.value("save").toBool(true);
                const bool apply = !in.contains("apply") || in.value("apply").toBool(true);
                const bool test = in.value("test").toBool(false);
                bool saved = false;
                if (save) {
                    BackendSettingsData bs;
                    bs.backendBase = backendBaseToString(base);
                    bs.backendSource = "settings";
                    QString saveError;
                    saved = saveBackendSettings(bs, &saveError);
                    if (!saved) {
                        replyJson(s, 500, QJsonDocument(QJsonObject{{"ok", false}, {"error", "save_failed"}, {"message", saveError}}).toJson(QJsonDocument::Compact));
                        return;
                    }
                }
                if (apply) {
                    m_backendClient->setBaseUrl(base, save ? "settings" : "api");
                    m_backendClient->start();
                }
                if (!test) {
                    QJsonObject o = backendConfigReply(m_backendClient);
                    o.insert("saved", saved);
                    o.insert("applied", apply);
                    replyJson(s, 200, QJsonDocument(o).toJson(QJsonDocument::Compact));
                    return;
                }

                const qint64 startedMs = QDateTime::currentMSecsSinceEpoch();
                QNetworkRequest req(backendPingUrl(base));
                req.setHeader(QNetworkRequest::UserAgentHeader, "rk3568-gui");
                QNetworkReply *rep = m_nam.get(req);
                rep->setParent(this);
                QTimer::singleShot(5000, rep, [rep]() { rep->abort(); });
                QPointer<QTcpSocket> sock(s);
                connect(rep, &QNetworkReply::finished, this, [this, sock, rep, saved, apply, startedMs]() {
                    const int httpCode = rep->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
                    const QByteArray data = rep->isOpen() ? rep->readAll() : QByteArray();
                    const QString netError = rep->error() == QNetworkReply::NoError ? QString() : rep->errorString();
                    rep->deleteLater();
                    QJsonObject testObj;
                    testObj.insert("status", httpCode);
                    testObj.insert("latency_ms", (int)qMax<qint64>(0, QDateTime::currentMSecsSinceEpoch() - startedMs));
                    if (!netError.isEmpty()) {
                        testObj.insert("ok", false);
                        testObj.insert("error", netError);
                    } else {
                        QJsonParseError pe;
                        const QJsonDocument jd = QJsonDocument::fromJson(data, &pe);
                        const bool okJson = pe.error == QJsonParseError::NoError && jd.isObject() && jd.object().value("ok").toBool(false);
                        testObj.insert("ok", httpCode >= 200 && httpCode < 300 && okJson);
                        if (!okJson) testObj.insert("error", "bad_response");
                    }
                    QJsonObject o = backendConfigReply(m_backendClient);
                    o.insert("saved", saved);
                    o.insert("applied", apply);
                    o.insert("test", testObj);
                    if (sock) replyJson(sock, 200, QJsonDocument(o).toJson(QJsonDocument::Compact));
                });
                return;
            }
            replyText(s, 405, "method_not_allowed");
            return;
        }
        if (path == "/api/user-message/config" || path == "/api/rk/user-message/config") {
            if (!m_userMessageConfig) {
                replyJson(s, 503, QJsonDocument(QJsonObject{{"ok", false}, {"error", "no_user_message_config"}}).toJson(QJsonDocument::Compact));
                return;
            }
            if (method == "GET") {
                QJsonObject o;
                o.insert("ok", true);
                o.insert("config_path", m_userMessageConfig->configPath());
                o.insert("config", m_userMessageConfig->toJson(true));
                replyJson(s, 200, QJsonDocument(o).toJson(QJsonDocument::Compact));
                return;
            }
            if (method == "POST") {
                QJsonParseError err;
                const QJsonDocument doc = QJsonDocument::fromJson(body, &err);
                if (err.error != QJsonParseError::NoError || !doc.isObject()) {
                    replyJson(s, 400, QJsonDocument(QJsonObject{{"ok", false}, {"error", "bad_json"}}).toJson(QJsonDocument::Compact));
                    return;
                }
                QString applyError;
                const bool ok = m_userMessageConfig->applyJson(doc.object(), &applyError);
                QJsonObject o;
                o.insert("ok", ok);
                o.insert("config_path", m_userMessageConfig->configPath());
                o.insert("config", m_userMessageConfig->toJson(true));
                if (!ok) o.insert("error", applyError.isEmpty() ? "save_failed" : applyError);
                replyJson(s, ok ? 200 : 400, QJsonDocument(o).toJson(QJsonDocument::Compact));
                if (ok) emit userMessageConfigChanged();
                return;
            }
            replyText(s, 405, "method_not_allowed");
            return;
        }
        if (method == "POST" && (path.startsWith("/api/business/parking/") || path.startsWith("/api/business/etc/"))) {
            if (!m_businessDialog) {
                replyJson(s, 503, QJsonDocument(QJsonObject{{"ok", false}, {"error", "no_business"}}).toJson(QJsonDocument::Compact));
                return;
            }
            const QList<QByteArray> seg = path.split('/');
            if (seg.size() < 5) {
                replyJson(s, 400, QJsonDocument(QJsonObject{{"ok", false}, {"error", "bad_path"}}).toJson(QJsonDocument::Compact));
                return;
            }
            const QString system = QString::fromUtf8(seg[3]);
            const QString op = QString::fromUtf8(seg[4]);

            QJsonObject in;
            if (!body.isEmpty()) {
                QJsonParseError err;
                const QJsonDocument doc = QJsonDocument::fromJson(body, &err);
                if (err.error == QJsonParseError::NoError && doc.isObject()) in = doc.object();
            }
            const QString plate = in.value("plate").toString().trimmed();
            const double amount = in.contains("amount") ? in.value("amount").toDouble() : 0.0;
            const QJsonObject out = m_businessDialog->applyRemoteOp(system, op, plate, amount);
            const QByteArray json = QJsonDocument(out).toJson(QJsonDocument::Compact);
            replyJson(s, out.value("ok").toBool(false) ? 200 : 400, json);
            return;
        }
        if (method != "GET") {
            replyText(s, 405, "method_not_allowed");
            return;
        }
        replyText(s, 404, "not_found");
    });

    connect(s, &QTcpSocket::disconnected, s, &QObject::deleteLater);
}

void ApiServer::replyJson(QTcpSocket *s, int code, const QByteArray &json) {
    QByteArray out;
    out += "HTTP/1.1 ";
    out += QByteArray::number(code);
    out += " ";
    out += httpStatusText(code);
    out += "\r\n";
    out += "Content-Type: application/json; charset=utf-8\r\n";
    out += "Cache-Control: no-store\r\n";
    out += "Access-Control-Allow-Origin: *\r\n";
    out += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n";
    out += "Access-Control-Allow-Headers: Content-Type, Authorization\r\n";
    out += "Connection: close\r\n";
    out += "Content-Length: ";
    out += QByteArray::number(json.size());
    out += "\r\n\r\n";
    out += json;
    s->write(out);
    s->disconnectFromHost();
}

void ApiServer::replyText(QTcpSocket *s, int code, const QByteArray &text, const QByteArray &ct) {
    QByteArray out;
    out += "HTTP/1.1 ";
    out += QByteArray::number(code);
    out += " ";
    out += httpStatusText(code);
    out += "\r\n";
    out += "Content-Type: ";
    out += ct;
    out += "\r\n";
    out += "Cache-Control: no-store\r\n";
    out += "Access-Control-Allow-Origin: *\r\n";
    out += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n";
    out += "Access-Control-Allow-Headers: Content-Type, Authorization\r\n";
    out += "Connection: close\r\n";
    out += "Content-Length: ";
    out += QByteArray::number(text.size());
    out += "\r\n\r\n";
    out += text;
    s->write(out);
    s->disconnectFromHost();
}

void ApiServer::replyBinary(QTcpSocket *s, int code, const QByteArray &body,
                            const QByteArray &ct,
                            const QByteArray &extraHeaders) {
    QByteArray out;
    out += "HTTP/1.1 ";
    out += QByteArray::number(code);
    out += " ";
    out += httpStatusText(code);
    out += "\r\nContent-Type: ";
    out += ct;
    out += "\r\n";
    out += extraHeaders;
    out += "Cache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Authorization\r\nConnection: close\r\nContent-Length: ";
    out += QByteArray::number(body.size());
    out += "\r\n\r\n";
    s->write(out);
    s->write(body);
    s->disconnectFromHost();
}

