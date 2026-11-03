#include "UserBusinessStore.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSet>
#include <QStringList>
#include <algorithm>
#include <cstdlib>

QTimeZone UserBusinessStore::bjTz() { return QTimeZone("Asia/Shanghai"); }

UserBusinessStore::UserBusinessStore() {
    loadConfig();
}

void UserBusinessStore::refreshIfChanged() {
    QString p = configPath();
    QFileInfo fi(p);
    if (!fi.exists()) return;
    QDateTime mt = fi.lastModified();
    if (m_lastConfigMTime.isValid() && mt <= m_lastConfigMTime) return;
    loadConfig();
}

QString UserBusinessStore::configPath() const {
    const char *p = std::getenv("RK3568_BUSINESS_PATH");
    QString base = (p && *p) ? QString::fromLocal8Bit(p) : (QDir::homePath() + "/.rk3568_business.json");
    QString profile = QString::fromUtf8(qgetenv("RK3568_BUSINESS_PROFILE")).trimmed();
    if (profile.isEmpty()) return base;
    QFileInfo fi(base);
    if (fi.suffix().toLower() == "json") {
        QString name = fi.completeBaseName() + "." + profile + ".json";
        QString target = QDir(fi.absolutePath()).filePath(name);
        if (!QFile::exists(target) && (profile == "parking" || profile == "etc")) {
            QStringList legacy = (profile == "parking") ? QStringList{"admin", "developer", "user_parking"} : QStringList{"admin", "developer", "user_etc"};
            QString best;
            QDateTime bestTime;
            for (const QString &lp : legacy) {
                QString legacyName = fi.completeBaseName() + "." + lp + ".json";
                QString cand = QDir(fi.absolutePath()).filePath(legacyName);
                QFileInfo cfi(cand);
                if (!cfi.exists()) continue;
                if (best.isEmpty() || cfi.lastModified() > bestTime) { best = cand; bestTime = cfi.lastModified(); }
            }
            if (!best.isEmpty()) {
                QDir().mkpath(QFileInfo(target).absolutePath());
                QFile::copy(best, target);
            }
        }
        return target;
    }
    return base + "." + profile;
}

void UserBusinessStore::loadConfig() {
    QString p = configPath();
    QFileInfo fi(p);
    if (!fi.exists()) return;
    m_lastConfigMTime = fi.lastModified();
    QFile f(p);
    if (!f.exists()) return;
    if (!f.open(QIODevice::ReadOnly)) return;
    QJsonParseError err;
    QJsonDocument doc = QJsonDocument::fromJson(f.readAll(), &err);
    if (err.error != QJsonParseError::NoError) return;
    if (!doc.isObject()) return;
    QJsonObject o = doc.object();

    QJsonObject pc = o.value("parking").toObject();
    m_parkingCfg.freeMinutes = pc.value("freeMinutes").toInt(m_parkingCfg.freeMinutes);
    bool hasMode = pc.contains("mode");
    QString mode = pc.value("mode").toString();
    if (hasMode) {
        m_parkingCfg.mode = (mode == "custom") ? ParkingBillingMode::Custom : ParkingBillingMode::Hourly;
    } else {
        m_parkingCfg.mode = (pc.contains("unitMinutes") || pc.contains("pricePerUnit")) ? ParkingBillingMode::Custom : m_parkingCfg.mode;
    }
    QString rounding = pc.value("rounding").toString();
    if (rounding == "truncate") m_parkingCfg.rounding = ParkingRoundingPolicy::Truncate;
    else if (rounding == "round_up") m_parkingCfg.rounding = ParkingRoundingPolicy::RoundUp;
    m_parkingCfg.pricePerHour = pc.value("pricePerHour").toDouble(m_parkingCfg.pricePerHour);
    m_parkingCfg.unitMinutes = pc.value("unitMinutes").toInt(m_parkingCfg.unitMinutes);
    m_parkingCfg.pricePerUnit = pc.value("pricePerUnit").toDouble(m_parkingCfg.pricePerUnit);

    QJsonObject ec = o.value("etc").toObject();
    m_etcCfg.tollYuan = ec.value("tollYuan").toDouble(m_etcCfg.tollYuan);

    QJsonObject acc = o.value("etcAccounts").toObject();
    for (auto it = acc.begin(); it != acc.end(); ++it) {
        if (it.value().isDouble()) m_etcAccounts[it.key()] = it.value().toDouble(0.0);
        else if (it.value().isObject()) m_etcAccounts[it.key()] = it.value().toObject().value("balance").toDouble(0.0);
    }
    QJsonObject arr = o.value("etcArrears").toObject();
    for (auto it = arr.begin(); it != arr.end(); ++it) {
        if (it.value().isDouble()) m_etcArrears[it.key()] = it.value().toDouble(0.0);
        else if (it.value().isObject()) m_etcArrears[it.key()] = it.value().toObject().value("arrears").toDouble(0.0);
    }

    m_etcRecords.clear();
    QJsonArray ers = o.value("etcRecords").toArray();
    for (const auto &rv : ers) {
        QJsonObject r = rv.toObject();
        EtcRecord er;
        QDateTime tt = QDateTime::fromString(r.value("time").toString(), "yyyy-MM-dd HH:mm:ss");
        tt.setTimeZone(bjTz());
        if (!tt.isValid()) continue;
        er.time = tt;
        er.plate = r.value("plate").toString();
        er.source = r.value("source").toInt(0);
        er.amount = r.value("amount").toDouble(0.0);
        er.balanceAfter = r.value("balanceAfter").toDouble(0.0);
        er.arrearsAfter = r.value("arrearsAfter").toDouble(0.0);
        er.result = r.value("result").toString();
        if (!er.plate.isEmpty()) m_etcRecords.push_back(er);
    }
    while (m_etcRecords.size() > 500) m_etcRecords.removeFirst();

    QJsonObject pacc = o.value("parkingAccounts").toObject();
    for (auto it = pacc.begin(); it != pacc.end(); ++it) {
        if (it.value().isDouble()) m_parkingAccounts[it.key()] = it.value().toDouble(0.0);
        else if (it.value().isObject()) m_parkingAccounts[it.key()] = it.value().toObject().value("balance").toDouble(0.0);
    }
    QJsonObject parr = o.value("parkingArrears").toObject();
    for (auto it = parr.begin(); it != parr.end(); ++it) {
        if (it.value().isDouble()) m_parkingArrears[it.key()] = it.value().toDouble(0.0);
        else if (it.value().isObject()) m_parkingArrears[it.key()] = it.value().toObject().value("arrears").toDouble(0.0);
    }

    m_activeCars.clear();
    QJsonObject pa = o.value("parkingActive").toObject();
    for (auto it = pa.begin(); it != pa.end(); ++it) {
        QJsonObject v = it.value().toObject();
        QString ts = v.value("entryTime").toString();
        QDateTime dt = QDateTime::fromString(ts, "yyyy-MM-dd HH:mm:ss");
        dt.setTimeZone(bjTz());
        if (!dt.isValid()) continue;
        ParkingActive a;
        a.entryTime = dt;
        a.entrySource = v.value("entrySource").toInt(0);
        m_activeCars.insert(it.key(), a);
    }

    m_parkingRecords.clear();
    QJsonArray prs = o.value("parkingRecords").toArray();
    for (const auto &rv : prs) {
        QJsonObject r = rv.toObject();
        ParkingRecord pr;
        pr.plate = r.value("plate").toString();
        QDateTime et = QDateTime::fromString(r.value("entryTime").toString(), "yyyy-MM-dd HH:mm:ss");
        et.setTimeZone(bjTz());
        QDateTime xt = QDateTime::fromString(r.value("exitTime").toString(), "yyyy-MM-dd HH:mm:ss");
        xt.setTimeZone(bjTz());
        if (!pr.plate.isEmpty() && et.isValid() && xt.isValid()) {
            pr.entryTime = et;
            pr.exitTime = xt;
            pr.minutes = r.value("minutes").toInt(0);
            pr.fee = r.value("fee").toDouble(0.0);
            pr.entrySource = r.value("entrySource").toInt(0);
            pr.exitSource = r.value("exitSource").toInt(0);
            m_parkingRecords.push_back(pr);
        }
    }
    while (m_parkingRecords.size() > 500) m_parkingRecords.removeFirst();

    m_parkingTxns.clear();
    QJsonArray pts = o.value("parkingTxns").toArray();
    for (const auto &tv : pts) {
        QJsonObject t = tv.toObject();
        ParkingTxn tx;
        QDateTime tt = QDateTime::fromString(t.value("time").toString(), "yyyy-MM-dd HH:mm:ss");
        tt.setTimeZone(bjTz());
        if (!tt.isValid()) continue;
        tx.time = tt;
        tx.plate = t.value("plate").toString();
        tx.source = t.value("source").toInt(0);
        tx.amount = t.value("amount").toDouble(0.0);
        tx.balanceAfter = t.value("balanceAfter").toDouble(0.0);
        tx.arrearsAfter = t.value("arrearsAfter").toDouble(0.0);
        tx.result = t.value("result").toString();
        if (!tx.plate.isEmpty()) m_parkingTxns.push_back(tx);
    }
    while (m_parkingTxns.size() > 500) m_parkingTxns.removeFirst();
}

void UserBusinessStore::saveConfig() {
    QJsonObject root;
    QJsonObject pc;
    pc.insert("freeMinutes", m_parkingCfg.freeMinutes);
    pc.insert("mode", m_parkingCfg.mode == ParkingBillingMode::Custom ? "custom" : "hourly");
    pc.insert("rounding", m_parkingCfg.rounding == ParkingRoundingPolicy::Truncate ? "truncate" : "round_up");
    pc.insert("pricePerHour", m_parkingCfg.pricePerHour);
    pc.insert("unitMinutes", m_parkingCfg.unitMinutes);
    pc.insert("pricePerUnit", m_parkingCfg.pricePerUnit);
    root.insert("parking", pc);

    QJsonObject ec;
    ec.insert("tollYuan", m_etcCfg.tollYuan);
    root.insert("etc", ec);

    QJsonObject acc;
    for (auto it = m_etcAccounts.begin(); it != m_etcAccounts.end(); ++it) {
        acc.insert(it.key(), it.value());
    }
    root.insert("etcAccounts", acc);

    QJsonObject arr;
    for (auto it = m_etcArrears.begin(); it != m_etcArrears.end(); ++it) {
        if (it.value() > 1e-6) arr.insert(it.key(), it.value());
    }
    root.insert("etcArrears", arr);

    QJsonArray ers;
    int erStart = std::max(0, m_etcRecords.size() - 500);
    for (int i = erStart; i < m_etcRecords.size(); ++i) {
        const EtcRecord &r = m_etcRecords[i];
        QJsonObject o;
        o.insert("time", r.time.toString("yyyy-MM-dd HH:mm:ss"));
        o.insert("plate", r.plate);
        o.insert("source", r.source);
        o.insert("amount", r.amount);
        o.insert("balanceAfter", r.balanceAfter);
        o.insert("arrearsAfter", r.arrearsAfter);
        o.insert("result", r.result);
        ers.push_back(o);
    }
    root.insert("etcRecords", ers);

    QJsonObject pacc;
    for (auto it = m_parkingAccounts.begin(); it != m_parkingAccounts.end(); ++it) {
        pacc.insert(it.key(), it.value());
    }
    root.insert("parkingAccounts", pacc);

    QJsonObject parr;
    for (auto it = m_parkingArrears.begin(); it != m_parkingArrears.end(); ++it) {
        if (it.value() > 1e-6) parr.insert(it.key(), it.value());
    }
    root.insert("parkingArrears", parr);

    QJsonObject pa;
    for (auto it = m_activeCars.begin(); it != m_activeCars.end(); ++it) {
        QJsonObject v;
        v.insert("entryTime", it->entryTime.toString("yyyy-MM-dd HH:mm:ss"));
        v.insert("entrySource", it->entrySource);
        pa.insert(it.key(), v);
    }
    root.insert("parkingActive", pa);

    QJsonArray prs;
    int prStart = std::max(0, m_parkingRecords.size() - 500);
    for (int i = prStart; i < m_parkingRecords.size(); ++i) {
        const ParkingRecord &r = m_parkingRecords[i];
        QJsonObject o;
        o.insert("plate", r.plate);
        o.insert("entryTime", r.entryTime.toString("yyyy-MM-dd HH:mm:ss"));
        o.insert("exitTime", r.exitTime.toString("yyyy-MM-dd HH:mm:ss"));
        o.insert("minutes", r.minutes);
        o.insert("fee", r.fee);
        o.insert("entrySource", r.entrySource);
        o.insert("exitSource", r.exitSource);
        prs.push_back(o);
    }
    root.insert("parkingRecords", prs);

    QJsonArray pts;
    int txStart = std::max(0, m_parkingTxns.size() - 500);
    for (int i = txStart; i < m_parkingTxns.size(); ++i) {
        const ParkingTxn &t = m_parkingTxns[i];
        QJsonObject o;
        o.insert("time", t.time.toString("yyyy-MM-dd HH:mm:ss"));
        o.insert("plate", t.plate);
        o.insert("source", t.source);
        o.insert("amount", t.amount);
        o.insert("balanceAfter", t.balanceAfter);
        o.insert("arrearsAfter", t.arrearsAfter);
        o.insert("result", t.result);
        pts.push_back(o);
    }
    root.insert("parkingTxns", pts);

    QString p = configPath();
    QDir().mkpath(QFileInfo(p).absolutePath());
    QFile f(p);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) return;
    f.write(QJsonDocument(root).toJson(QJsonDocument::Indented));
    m_lastConfigMTime = QDateTime::currentDateTimeUtc();
}

QDateTime UserBusinessStore::parseBjTime(const QString &timeBj) {
    QDateTime dt = QDateTime::fromString(timeBj, "yyyy-MM-dd HH:mm:ss");
    dt.setTimeZone(bjTz());
    if (!dt.isValid()) {
        dt = QDateTime::currentDateTimeUtc().toTimeZone(bjTz());
    }
    return dt;
}

double UserBusinessStore::calcParkingFeeMinutes(int minutes, const ParkingConfig &cfg) {
    if (minutes <= cfg.freeMinutes) return 0.0;
    int chargeMin = minutes - cfg.freeMinutes;
    int unitMinutes = 1;
    double pricePerUnit = 0.0;
    if (cfg.mode == ParkingBillingMode::Custom) {
        unitMinutes = std::max(1, cfg.unitMinutes);
        pricePerUnit = cfg.pricePerUnit;
    } else {
        unitMinutes = 60;
        pricePerUnit = cfg.pricePerHour;
    }

    int units = 0;
    if (cfg.rounding == ParkingRoundingPolicy::Truncate) units = chargeMin / unitMinutes;
    else units = (chargeMin + unitMinutes - 1) / unitMinutes;
    if (units <= 0) return 0.0;
    return units * pricePerUnit;
}

UserBusinessStore::ParkingOutcome UserBusinessStore::onParkingPlate(const QString &plate, const QString &timeBj, int source) {
    refreshIfChanged();
    ParkingOutcome out;
    QString p = plate.trimmed();
    if (p.isEmpty()) return out;
    QDateTime t = parseBjTime(timeBj);
    out.plate = p;
    out.time = t;

    auto it = m_activeCars.find(p);
    if (it == m_activeCars.end()) {
        ParkingActive a;
        a.entryTime = t;
        a.entrySource = source;
        m_activeCars.insert(p, a);
        out.type = ParkingEventType::Entry;
        {
            double bal = m_parkingAccounts.value(p, 0.0);
            double arrears = m_parkingArrears.value(p, 0.0);
            ParkingTxn tx;
            tx.time = t;
            tx.plate = p;
            tx.source = source;
            tx.amount = 0.0;
            tx.balanceAfter = bal;
            tx.arrearsAfter = arrears;
            tx.result = "驶入";
            m_parkingTxns.push_front(tx);
            while (m_parkingTxns.size() > 500) m_parkingTxns.removeLast();
        }
        saveConfig();
        return out;
    }

    qint64 secs = it->entryTime.secsTo(t);
    if (secs < 0) secs = 0;

    int mins = std::max(1, (int)((secs + 59) / 60));
    double fee = calcParkingFeeMinutes(mins, m_parkingCfg);
    out.type = ParkingEventType::Exit;
    out.minutes = mins;
    out.fee = fee;

    QDateTime entryTime = it->entryTime;
    int entrySource = it->entrySource;
    m_activeCars.erase(it);

    double bal = m_parkingAccounts.value(p, 0.0);
    double arrears = m_parkingArrears.value(p, 0.0);
    bool hasAcc = m_parkingAccounts.contains(p);
    double need = fee;

    double use = std::min(bal, need);
    bal -= use;
    need -= use;
    if (need > 1e-6) arrears += need;

    if (hasAcc) m_parkingAccounts[p] = bal;
    if (arrears > 1e-6 || m_parkingArrears.contains(p)) m_parkingArrears[p] = arrears;
    else m_parkingArrears.remove(p);

    out.paidFromBalance = use;
    out.needPay = need;
    out.balanceAfter = bal;
    out.arrearsAfter = arrears;
    if (fee <= 1e-6) out.payStatus = PayStatus::None;
    else if (!hasAcc) out.payStatus = PayStatus::NotOpened;
    else if (need > 1e-6) out.payStatus = PayStatus::Insufficient;
    else out.payStatus = PayStatus::Deducted;

    {
        ParkingRecord r;
        r.plate = p;
        r.entryTime = entryTime;
        r.exitTime = t;
        r.minutes = mins;
        r.fee = fee;
        r.entrySource = entrySource;
        r.exitSource = source;
        m_parkingRecords.push_front(r);
        while (m_parkingRecords.size() > 500) m_parkingRecords.removeLast();
    }

    {
        ParkingTxn tx;
        tx.time = t;
        tx.plate = p;
        tx.source = source;
        tx.amount = -fee;
        tx.balanceAfter = bal;
        tx.arrearsAfter = arrears;
        if (fee <= 1e-6) tx.result = "免费驶离";
        else if (!hasAcc) tx.result = QString("未办卡(欠费%1元)").arg(arrears, 0, 'f', 2);
        else if (need > 1e-6) tx.result = QString("余额不足(欠费%1元)").arg(arrears, 0, 'f', 2);
        else tx.result = "扣费成功";
        m_parkingTxns.push_front(tx);
        while (m_parkingTxns.size() > 500) m_parkingTxns.removeLast();
    }

    saveConfig();
    return out;
}

UserBusinessStore::EtcOutcome UserBusinessStore::onEtcPlate(const QString &plate, const QString &timeBj, int source) {
    refreshIfChanged();
    EtcOutcome out;
    QString p = plate.trimmed();
    if (p.isEmpty()) return out;
    QDateTime t = parseBjTime(timeBj);
    out.plate = p;
    out.time = t;
    out.fee = m_etcCfg.tollYuan;

    EtcRecord rec;
    rec.time = t;
    rec.plate = p;
    rec.source = source;
    rec.amount = -m_etcCfg.tollYuan;

    double bal = m_etcAccounts.value(p, 0.0);
    double arrears = m_etcArrears.value(p, 0.0);
    bool hasAcc = m_etcAccounts.contains(p);
    double toll = m_etcCfg.tollYuan;

    if (hasAcc && bal + 1e-6 >= toll) {
        bal -= toll;
        m_etcAccounts[p] = bal;
        out.balanceAfter = bal;
        out.arrearsAfter = arrears;
        out.payStatus = PayStatus::Deducted;
        out.paidFromBalance = toll;
        out.needPay = 0.0;
        rec.balanceAfter = bal;
        rec.arrearsAfter = arrears;
        rec.result = "扣费成功";
    } else {
        double need = toll;
        double use = hasAcc ? std::min(bal, need) : 0.0;
        bal -= use;
        need -= use;
        if (hasAcc) m_etcAccounts[p] = bal;
        arrears += need;
        m_etcArrears[p] = arrears;
        out.balanceAfter = bal;
        out.arrearsAfter = arrears;
        out.paidFromBalance = use;
        out.needPay = need;
        if (!hasAcc) out.payStatus = PayStatus::NotOpened;
        else out.payStatus = PayStatus::Insufficient;
        rec.balanceAfter = bal;
        rec.arrearsAfter = arrears;
        if (!hasAcc) rec.result = QString("未开通(欠费%1元)").arg(arrears, 0, 'f', 2);
        else rec.result = QString("余额不足(欠费%1元)").arg(arrears, 0, 'f', 2);
    }

    m_etcRecords.push_front(rec);
    while (m_etcRecords.size() > 500) m_etcRecords.removeLast();
    saveConfig();
    return out;
}

QString UserBusinessStore::formatDurationMinutes(int minutes) {
    if (minutes <= 0) return "0分钟";
    if (minutes < 60) {
        return QString("%1分钟").arg(minutes);
    }
    if (minutes < 24 * 60) {
        int hours = minutes / 60;
        int mins = minutes % 60;
        return QString("%1小时%2分钟").arg(hours).arg(mins);
    }
    int days = minutes / (24 * 60);
    int rem = minutes % (24 * 60);
    int hours = rem / 60;
    int mins = rem % 60;
    return QString("%1天%2小时%3分钟").arg(days).arg(hours).arg(mins);
}

QJsonObject UserBusinessStore::buildBizReport() const {
    QJsonObject root;
    QDateTime now = QDateTime::currentDateTimeUtc().toTimeZone(bjTz());
    root.insert("time_bj", now.toString("yyyy-MM-dd HH:mm:ss"));

    QJsonObject parking;
    {
        QSet<QString> keySet;
        for (auto it = m_parkingAccounts.begin(); it != m_parkingAccounts.end(); ++it) keySet.insert(it.key());
        for (auto it = m_parkingArrears.begin(); it != m_parkingArrears.end(); ++it) keySet.insert(it.key());
        QStringList plates = keySet.values();
        std::sort(plates.begin(), plates.end());
        QJsonArray accounts;
        for (const QString &plate : plates) {
            QJsonObject a;
            a.insert("plate", plate);
            a.insert("balance", m_parkingAccounts.value(plate, 0.0));
            a.insert("arrears", m_parkingArrears.value(plate, 0.0));
            a.insert("status", "active");
            a.insert("updated_at", now.toString("yyyy-MM-dd HH:mm:ss"));
            accounts.push_back(a);
        }
        parking.insert("accounts", accounts);

        QJsonArray records;
        int start = std::max(0, m_parkingTxns.size() - 2000);
        for (int i = start; i < m_parkingTxns.size(); ++i) {
            const ParkingTxn &t = m_parkingTxns[i];
            if (t.plate.trimmed().isEmpty()) continue;
            QJsonObject r;
            r.insert("time_bj", t.time.toTimeZone(bjTz()).toString("yyyy-MM-dd HH:mm:ss"));
            r.insert("plate", t.plate);
            r.insert("source", QString("src%1").arg(t.source));
            r.insert("delta", t.amount);
            r.insert("balance", t.balanceAfter);
            r.insert("arrears", t.arrearsAfter);
            r.insert("result", t.result);
            records.push_back(r);
        }
        parking.insert("records", records);
    }
    root.insert("parking", parking);

    QJsonObject etc;
    {
        QSet<QString> keySet;
        for (auto it = m_etcAccounts.begin(); it != m_etcAccounts.end(); ++it) keySet.insert(it.key());
        for (auto it = m_etcArrears.begin(); it != m_etcArrears.end(); ++it) keySet.insert(it.key());
        QStringList plates = keySet.values();
        std::sort(plates.begin(), plates.end());
        QJsonArray accounts;
        for (const QString &plate : plates) {
            QJsonObject a;
            a.insert("plate", plate);
            a.insert("balance", m_etcAccounts.value(plate, 0.0));
            a.insert("arrears", m_etcArrears.value(plate, 0.0));
            a.insert("status", "active");
            a.insert("updated_at", now.toString("yyyy-MM-dd HH:mm:ss"));
            accounts.push_back(a);
        }
        etc.insert("accounts", accounts);

        QJsonArray records;
        int start = std::max(0, m_etcRecords.size() - 2000);
        for (int i = start; i < m_etcRecords.size(); ++i) {
            const EtcRecord &t = m_etcRecords[i];
            if (t.plate.trimmed().isEmpty()) continue;
            QJsonObject r;
            r.insert("time_bj", t.time.toTimeZone(bjTz()).toString("yyyy-MM-dd HH:mm:ss"));
            r.insert("plate", t.plate);
            r.insert("source", QString("src%1").arg(t.source));
            r.insert("delta", t.amount);
            r.insert("balance", t.balanceAfter);
            r.insert("arrears", t.arrearsAfter);
            r.insert("result", t.result);
            records.push_back(r);
        }
        etc.insert("records", records);
    }
    root.insert("etc", etc);

    return root;
}

