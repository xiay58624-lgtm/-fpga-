#pragma once

#include <QObject>
#include <QQueue>
#include <QString>
#include <QStringList>

class QProcess;

class TtsWavPlayer : public QObject {
    Q_OBJECT
public:
    explicit TtsWavPlayer(QObject *parent = nullptr);

    bool isEnabled() const { return m_enabled; }
    bool isReady() const { return m_ready; }
    QString baseDir() const { return m_baseDir; }
    QString lastError() const { return m_lastError; }
    QString outputDevice() const;

    void enqueueByTemplate(const QString &system,
                           const QString &templateKey,
                           const QString &plate,
                           double fee = 0.0,
                           double needPay = 0.0);
    void enqueuePlateDetected(const QString &plate);

private:
    void resolveBaseDir();
    QString wavPath(const QString &relative) const;
    bool exists(const QString &relative) const;
    QStringList plateParts(const QString &plate) const;
    QStringList moneyParts(double amount) const;
    QStringList templateParts(const QString &system,
                              const QString &templateKey,
                              const QString &plate,
                              double fee,
                              double needPay) const;
    void enqueueParts(const QStringList &parts);
    void playNextSequence();
    void playNextFile();

    bool m_enabled = true;
    bool m_ready = false;
    QString m_baseDir;
    QString m_player = "aplay";
    QString m_lastError;
    int m_maxQueueSize = 6;
    QQueue<QStringList> m_queue;
    QStringList m_current;
    QProcess *m_process = nullptr;
};
