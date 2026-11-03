#ifndef VEHICLECLIENT_H
#define VEHICLECLIENT_H

#include <QObject>
#include <QHostAddress>
#include <QJsonObject>
#include <QTcpSocket>

class VehicleClient : public QObject {
    Q_OBJECT
public:
    explicit VehicleClient(QObject *parent = nullptr);
    ~VehicleClient() override;

    bool sendCommand(const QString &command, QString *error = nullptr);
    bool stop(QString *error = nullptr);
    QJsonObject statusJson() const;
    QString host() const { return m_host; }
    quint16 port() const { return m_port; }

private:
    bool ensureConnected(QString *error);
    QString normalizeCommand(const QString &command) const;
    void setError(const QString &error);

    QTcpSocket m_socket;
    QString m_host;
    quint16 m_port = 8888;
    bool m_connected = false;
    QString m_lastCommand;
    QString m_lastAck;
    QString m_lastError;
    qint64 m_lastCommandAtMs = 0;
};

#endif
