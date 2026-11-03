#include "VehicleClient.h"

#include <QDateTime>
#include <QSet>

namespace {

const QSet<QString> kCommands = {
    "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K",
    "P1", "P2", "P3", "P4", "P5", "T3", "T5", "F10", "B5",
    "LT", "RT", "LC", "RC", "UT"
};

}

VehicleClient::VehicleClient(QObject *parent) : QObject(parent) {
    m_host = QString::fromLocal8Bit(qgetenv("RK3568_CAR_HOST")).trimmed();
    if (m_host.isEmpty()) m_host = "192.168.4.1";
    bool ok = false;
    const int configuredPort = qEnvironmentVariableIntValue("RK3568_CAR_PORT", &ok);
    if (ok && configuredPort > 0 && configuredPort <= 65535) {
        m_port = static_cast<quint16>(configuredPort);
    }
    connect(&m_socket, &QTcpSocket::disconnected, this, [this]() {
        m_connected = false;
    });
    connect(&m_socket, QOverload<QAbstractSocket::SocketError>::of(&QTcpSocket::error),
            this, [this](QAbstractSocket::SocketError) {
        m_connected = false;
        setError(m_socket.errorString());
    });
}

VehicleClient::~VehicleClient() {
    if (m_socket.state() == QAbstractSocket::ConnectedState) {
        m_socket.write("K\n");
        m_socket.waitForBytesWritten(150);
        m_socket.disconnectFromHost();
        m_socket.waitForDisconnected(150);
    }
}

void VehicleClient::setError(const QString &error) {
    m_lastError = error.trimmed();
    if (m_lastError.isEmpty()) m_lastError = "vehicle_error";
}

QString VehicleClient::normalizeCommand(const QString &command) const {
    QString value = command.trimmed().toUpper();
    if (value == "FORWARD") value = "A";
    else if (value == "BACK" || value == "BACKWARD") value = "B";
    else if (value == "LEFT_SHIFT" || value == "CHANGE_LEFT") value = "C";
    else if (value == "RIGHT_SHIFT" || value == "CHANGE_RIGHT") value = "D";
    else if (value == "LEFT" || value == "TURN_LEFT") value = "E";
    else if (value == "RIGHT" || value == "TURN_RIGHT") value = "F";
    else if (value == "STOP") value = "K";
    else if (value == "FORWARD10" || value == "ROUTE1") value = "F10";
    else if (value == "BACK5" || value == "ROUTE2") value = "B5";
    else if (value == "LEFT_TURN" || value == "ROUTE3") value = "LT";
    else if (value == "RIGHT_TURN" || value == "ROUTE4") value = "RT";
    else if (value == "LEFT_CHANGE" || value == "ROUTE5") value = "LC";
    else if (value == "RIGHT_CHANGE" || value == "ROUTE6") value = "RC";
    else if (value == "U_TURN" || value == "UTURN") value = "UT";
    return value;
}

bool VehicleClient::ensureConnected(QString *error) {
    if (m_socket.state() == QAbstractSocket::ConnectedState) {
        m_connected = true;
        return true;
    }
    m_socket.abort();
    m_socket.connectToHost(m_host, m_port);
    if (!m_socket.waitForConnected(800)) {
        m_connected = false;
        setError(m_socket.errorString());
        if (error) *error = m_lastError;
        return false;
    }
    m_connected = true;
    // The ESP8266 sends a short READY banner. Drain it so the next response
    // belongs to the command just sent.
    m_socket.waitForReadyRead(120);
    m_socket.readAll();
    return true;
}

bool VehicleClient::sendCommand(const QString &command, QString *error) {
    const QString normalized = normalizeCommand(command);
    if (!kCommands.contains(normalized)) {
        setError("unsupported_vehicle_command");
        if (error) *error = m_lastError;
        return false;
    }
    if (!ensureConnected(error)) return false;

    const QByteArray wire = normalized.toLatin1() + "\n";
    if (m_socket.write(wire) != wire.size() || !m_socket.waitForBytesWritten(500)) {
        m_connected = false;
        setError(m_socket.errorString());
        if (error) *error = m_lastError;
        return false;
    }
    m_socket.waitForReadyRead(100);
    const QByteArray ack = m_socket.readAll().trimmed();
    m_lastCommand = normalized;
    m_lastAck = QString::fromUtf8(ack);
    m_lastError.clear();
    m_lastCommandAtMs = QDateTime::currentMSecsSinceEpoch();
    if (error) error->clear();
    return true;
}

bool VehicleClient::stop(QString *error) {
    return sendCommand("K", error);
}

QJsonObject VehicleClient::statusJson() const {
    QJsonObject out;
    out.insert("vehicle_configured", true);
    out.insert("vehicle_host", m_host);
    out.insert("vehicle_port", static_cast<int>(m_port));
    out.insert("vehicle_connected", m_connected &&
                m_socket.state() == QAbstractSocket::ConnectedState);
    out.insert("vehicle_last_command", m_lastCommand);
    out.insert("vehicle_last_ack", m_lastAck);
    out.insert("vehicle_error", m_lastError);
    if (m_lastCommandAtMs > 0) {
        out.insert("vehicle_last_command_at_ms", static_cast<double>(m_lastCommandAtMs));
    }
    return out;
}
