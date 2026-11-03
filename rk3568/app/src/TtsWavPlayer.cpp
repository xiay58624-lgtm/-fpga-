#include "TtsWavPlayer.h"

#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QProcess>
#include <QProcessEnvironment>
#include <QtGlobal>
#include <algorithm>
#include <cmath>

namespace {

bool envBoolTts(const char *name, bool def) {
    const QByteArray raw = qgetenv(name).trimmed().toLower();
    if (raw.isEmpty()) return def;
    return !(raw == "0" || raw == "false" || raw == "off" || raw == "no");
}

int envIntTts(const char *name, int def, int lo, int hi) {
    const QByteArray raw = qgetenv(name).trimmed();
    if (raw.isEmpty()) return def;
    bool ok = false;
    const int v = raw.toInt(&ok);
    if (!ok) return def;
    return std::max(lo, std::min(hi, v));
}

QString provinceFile(const QChar &ch) {
    switch (ch.unicode()) {
    case 0x4EAC: return "province/jing.wav";
    case 0x6D25: return "province/jin_tianjin.wav";
    case 0x6CAA: return "province/hu.wav";
    case 0x6E1D: return "province/yu_chongqing.wav";
    case 0x5180: return "province/ji_hebei.wav";
    case 0x8C6B: return "province/yu_henan.wav";
    case 0x4E91: return "province/yun.wav";
    case 0x8FBD: return "province/liao.wav";
    case 0x9ED1: return "province/hei.wav";
    case 0x6E58: return "province/xiang.wav";
    case 0x7696: return "province/wan.wav";
    case 0x9C81: return "province/lu.wav";
    case 0x65B0: return "province/xin.wav";
    case 0x82CF: return "province/su.wav";
    case 0x6D59: return "province/zhe.wav";
    case 0x8D63: return "province/gan_jiangxi.wav";
    case 0x9102: return "province/e.wav";
    case 0x6842: return "province/gui_guangxi.wav";
    case 0x7518: return "province/gan_gansu.wav";
    case 0x664B: return "province/jin_shanxi.wav";
    case 0x8499: return "province/meng.wav";
    case 0x9655: return "province/shan.wav";
    case 0x5409: return "province/ji_jilin.wav";
    case 0x95FD: return "province/min.wav";
    case 0x8D35: return "province/gui_guizhou.wav";
    case 0x7CA4: return "province/yue.wav";
    case 0x9752: return "province/qing.wav";
    case 0x85CF: return "province/zang.wav";
    case 0x5DDD: return "province/chuan.wav";
    case 0x5B81: return "province/ning.wav";
    case 0x743C: return "province/qiong.wav";
    default: return QString();
    }
}

QString specialFile(const QChar &ch) {
    switch (ch.unicode()) {
    case 0x4F7F: return "special/shi.wav";
    case 0x9886: return "special/ling.wav";
    case 0x8B66: return "special/jing_police.wav";
    case 0x5B66: return "special/xue.wav";
    case 0x6E2F: return "special/gang.wav";
    case 0x6FB3: return "special/ao.wav";
    case 0x6302: return "special/gua.wav";
    case 0x4E34: return "special/lin.wav";
    default: return QString();
    }
}

QString specialPairFile(const QChar &a, const QChar &b) {
    const uint pair = (uint(a.unicode()) << 16) | uint(b.unicode());
    switch (pair) {
    case 0x5E946025u: return "special/yingji.wav";
    case 0x6C11822Au: return "special/minhang.wav";
    default: return QString();
    }
}

} // namespace

TtsWavPlayer::TtsWavPlayer(QObject *parent) : QObject(parent) {
    m_enabled = envBoolTts("RK3568_TTS_WAV_ENABLE", true);
    m_player = QString::fromLocal8Bit(qgetenv("RK3568_TTS_PLAYER")).trimmed();
    if (m_player.isEmpty()) m_player = "aplay";
    m_maxQueueSize = envIntTts("RK3568_TTS_MAX_QUEUE", 6, 1, 50);
    resolveBaseDir();
}

QString TtsWavPlayer::outputDevice() const {
    const QString dev = QString::fromLocal8Bit(qgetenv("RK3568_TTS_DEVICE")).trimmed();
    return dev.isEmpty() ? QStringLiteral("default") : dev;
}

void TtsWavPlayer::resolveBaseDir() {
    const QString envDir = QString::fromLocal8Bit(qgetenv("RK3568_TTS_WAV_DIR")).trimmed();
    QStringList candidates;
    if (!envDir.isEmpty()) candidates << envDir;
    candidates << QDir(QCoreApplication::applicationDirPath()).filePath("tts_wav_templates/output");
    candidates << QDir(QCoreApplication::applicationDirPath()).filePath("../tts_wav_templates/output");
    candidates << "/home/linaro/Desktop/rk3568/tts_wav_templates/output";
    candidates << "/userdata/rk3568/tts_wav_templates/output";
    candidates << "/opt/rk-http/audio_templates";

    for (const QString &dir : candidates) {
        if (QFileInfo::exists(QDir(dir).filePath("fixed/welcome.wav"))) {
            m_baseDir = QDir(dir).absolutePath();
            m_ready = true;
            m_lastError.clear();
            return;
        }
    }
    m_ready = false;
    m_lastError = "tts_wav_templates output not found";
}

QString TtsWavPlayer::wavPath(const QString &relative) const {
    return QDir(m_baseDir).filePath(relative);
}

bool TtsWavPlayer::exists(const QString &relative) const {
    return m_ready && QFileInfo::exists(wavPath(relative));
}

QStringList TtsWavPlayer::plateParts(const QString &plateIn) const {
    const QString plate = plateIn.trimmed().toUpper();
    QStringList parts;
    if (plate.isEmpty()) return parts;

    for (int i = 0; i < plate.size(); ++i) {
        const QChar ch = plate.at(i);
        QString rel;

        if (i + 1 < plate.size()) {
            rel = specialPairFile(ch, plate.at(i + 1));
            if (!rel.isEmpty()) ++i;
        }
        if (rel.isEmpty() && i == 0) rel = provinceFile(ch);
        if (rel.isEmpty()) rel = specialFile(ch);
        if (rel.isEmpty() && ch.isDigit()) rel = QString("digit/%1.wav").arg(ch);
        if (rel.isEmpty() && ch >= QChar('A') && ch <= QChar('Z')) rel = QString("letter/%1.wav").arg(ch);
        if (!rel.isEmpty() && exists(rel)) parts << rel;
    }
    return parts;
}

QStringList TtsWavPlayer::moneyParts(double amount) const {
    const int centsRounded = (int)std::round(std::max(0.0, amount) * 100.0);
    const int yuan = centsRounded / 100;
    const QString text = QString::number(yuan);
    QStringList parts;
    for (const QChar &ch : text) {
        const QString rel = QString("digit/%1.wav").arg(ch);
        if (exists(rel)) parts << rel;
    }
    return parts;
}

QStringList TtsWavPlayer::templateParts(const QString &system,
                                        const QString &templateKey,
                                        const QString &plate,
                                        double fee,
                                        double needPay) const {
    QStringList parts;
    auto add = [&parts, this](const QString &rel) {
        if (exists(rel)) parts << rel;
    };

    if (system == "etc") {
        parts << plateParts(plate);
        if (templateKey == "pass_deducted") {
            add("fixed/etc_pass.wav");
            add("fixed/please_pass.wav");
        } else if (templateKey == "pass_insufficient") {
            add("fixed/etc_balance_low.wav");
            add("fixed/please_pay.wav");
        } else {
            add("fixed/etc_not_opened.wav");
            add("fixed/please_pay.wav");
        }
        return parts;
    }

    if (templateKey == "entry_owner") {
        parts << plateParts(plate);
        if (exists("fixed/welcome_owner_home.wav")) {
            add("fixed/welcome_owner_home.wav");
        } else {
            add("fixed/welcome.wav");
            add("fixed/owner_home.wav");
        }
        add("fixed/please_pass.wav");
    } else if (templateKey == "entry") {
        add("fixed/welcome.wav");
        parts << plateParts(plate);
        add("fixed/entry_success.wav");
        add("fixed/please_pass.wav");
    } else if (templateKey == "exit_free") {
        parts << plateParts(plate);
        add("fixed/exit_success.wav");
        add("fixed/parking_free.wav");
        add("fixed/safe_trip.wav");
    } else if (templateKey == "exit_deducted") {
        parts << plateParts(plate);
        add("fixed/exit_success.wav");
        add("fixed/paid.wav");
        parts << moneyParts(fee);
        add("fixed/yuan.wav");
        add("fixed/safe_trip.wav");
    } else if (templateKey == "exit_insufficient") {
        parts << plateParts(plate);
        add("fixed/balance_low.wav");
        add("fixed/please_pay.wav");
        parts << moneyParts(needPay > 0.0 ? needPay : fee);
        add("fixed/yuan.wav");
    } else if (templateKey == "exit_not_opened") {
        parts << plateParts(plate);
        add("fixed/account_not_opened.wav");
        add("fixed/please_pay.wav");
        parts << moneyParts(fee);
        add("fixed/yuan.wav");
    } else {
        parts << plateParts(plate);
    }
    return parts;
}

void TtsWavPlayer::enqueueByTemplate(const QString &system,
                                     const QString &templateKey,
                                     const QString &plate,
                                     double fee,
                                     double needPay) {
    if (!m_enabled) return;
    if (!m_ready) resolveBaseDir();
    if (!m_ready) return;
    const QStringList parts = templateParts(system.trimmed().toLower(), templateKey.trimmed(), plate, fee, needPay);
    enqueueParts(parts);
}

void TtsWavPlayer::enqueuePlateDetected(const QString &plate) {
    if (!m_enabled) return;
    if (!m_ready) resolveBaseDir();
    QStringList parts = plateParts(plate);
    enqueueParts(parts);
}

void TtsWavPlayer::enqueueParts(const QStringList &parts) {
    if (parts.isEmpty()) return;
    while (m_queue.size() >= m_maxQueueSize) m_queue.dequeue();
    m_queue.enqueue(parts);
    if (!m_process && m_current.isEmpty()) playNextSequence();
}

void TtsWavPlayer::playNextSequence() {
    if (m_queue.isEmpty()) return;
    m_current = m_queue.dequeue();
    playNextFile();
}

void TtsWavPlayer::playNextFile() {
    if (m_current.isEmpty()) {
        playNextSequence();
        return;
    }

    const QString rel = m_current.takeFirst();
    const QString full = wavPath(rel);
    if (!QFileInfo::exists(full)) {
        playNextFile();
        return;
    }

    QProcess *p = new QProcess(this);
    m_process = p;
    connect(p, static_cast<void(QProcess::*)(int, QProcess::ExitStatus)>(&QProcess::finished),
            this, [this, p](int, QProcess::ExitStatus) {
        if (m_process == p) m_process = nullptr;
        p->deleteLater();
        playNextFile();
    });

    QStringList args;
    const QString dev = outputDevice();
    if (!dev.isEmpty() && dev != "default") {
        args << "-D" << dev;
    }
    args << full;
    p->start(m_player, args);
    if (!p->waitForStarted(50)) {
        m_lastError = QString("failed to start player: %1").arg(m_player);
        m_current.clear();
        m_queue.clear();
        if (m_process == p) m_process = nullptr;
        p->deleteLater();
    } else {
        m_lastError.clear();
    }
}
