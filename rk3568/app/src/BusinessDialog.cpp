#include "BusinessDialog.h"
#include "UiSizing.h"
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QHeaderView>
#include <QFileDialog>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QFile>
#include <QDir>
#include <QTextStream>
#include <QMessageBox>
#include <QSet>
#include <QtGlobal>
#include <algorithm>
#include <cstdlib>

static QTimeZone bjTz() { return QTimeZone("Asia/Shanghai"); }
static int envInt(const char *name, int defVal) {
    bool ok = false;
    int v = qEnvironmentVariableIntValue(name, &ok);
    return ok ? v : defVal;
}

BusinessDialog::BusinessDialog(QWidget *parent) : QDialog(parent) {
    setWindowTitle(QStringLiteral("业务功能"));
    setModal(false);
    UiSizing::fitWindow(this, QSize(980, 620), 24);
    setStyleSheet(R"(
        QDialog { background-color: #ffffff; color: #000000; }
        QLabel { color: #000000; }
        QPushButton { color: #000000; background: #f5f5f5; border: 1px solid #cccccc; border-radius: 4px; padding: 4px 10px; }
        QPushButton:hover { background: #ececec; }
        QPushButton:pressed { background: #e2e2e2; }
        QLineEdit, QComboBox, QSpinBox, QDoubleSpinBox { background: #ffffff; color: #000000; border: 1px solid #cccccc; border-radius: 4px; padding: 2px 6px; }
        QComboBox QAbstractItemView { background: #ffffff; color: #000000; selection-background-color: #d9d9d9; selection-color: #000000; outline: 0; }
        QHeaderView::section { background: #f2f2f2; color: #000000; border: 1px solid #d0d0d0; }
        QTableWidget { background: #ffffff; color: #000000; gridline-color: #dddddd; }
        QTabWidget::pane { border: 1px solid #cccccc; }
        QTabBar::tab { background: #f5f5f5; color: #444444; padding: 6px 12px; border: 1px solid #cccccc; border-bottom: none; }
        QTabBar::tab:selected { background: #ffffff; color: #000000; }
    )");
    buildUi();
    loadConfig();
    refreshParkingTables();
    refreshEtcTables();
    m_reportMinIntervalMs = std::max(200, envInt("BIZ_REPORT_MIN_INTERVAL_MS", 2000));
    const int intervalMs = std::max(0, envInt("BIZ_REPORT_INTERVAL_MS", 15000));
    if (intervalMs > 0) {
        m_reportTimer = new QTimer(this);
        m_reportTimer->setInterval(intervalMs);
        connect(m_reportTimer, &QTimer::timeout, this, [this](){ maybeEmitBizReport(true); });
        m_reportTimer->start();
    }
    maybeEmitBizReport(true);
}

BusinessDialog::BusinessDialog(Page onlyPage, QWidget *parent) : QDialog(parent) {
    m_singleMode = true;
    m_onlyPage = onlyPage;
    setWindowTitle(onlyPage == Page::Parking ? QStringLiteral("停车场系统") : QStringLiteral("ETC系统"));
    setModal(false);
    UiSizing::fitWindow(this, QSize(980, 620), 24);
    setStyleSheet(R"(
        QDialog { background-color: #ffffff; color: #000000; }
        QLabel { color: #000000; }
        QPushButton { color: #000000; background: #f5f5f5; border: 1px solid #cccccc; border-radius: 4px; padding: 4px 10px; }
        QPushButton:hover { background: #ececec; }
        QPushButton:pressed { background: #e2e2e2; }
        QLineEdit, QComboBox, QSpinBox, QDoubleSpinBox { background: #ffffff; color: #000000; border: 1px solid #cccccc; border-radius: 4px; padding: 2px 6px; }
        QComboBox QAbstractItemView { background: #ffffff; color: #000000; selection-background-color: #d9d9d9; selection-color: #000000; outline: 0; }
        QHeaderView::section { background: #f2f2f2; color: #000000; border: 1px solid #d0d0d0; }
        QTableWidget { background: #ffffff; color: #000000; gridline-color: #dddddd; }
        QTabWidget::pane { border: 1px solid #cccccc; }
        QTabBar::tab { background: #f5f5f5; color: #444444; padding: 6px 12px; border: 1px solid #cccccc; border-bottom: none; }
        QTabBar::tab:selected { background: #ffffff; color: #000000; }
    )");
    buildUi();
    loadConfig();
    refreshParkingTables();
    refreshEtcTables();
    m_reportMinIntervalMs = std::max(200, envInt("BIZ_REPORT_MIN_INTERVAL_MS", 2000));
    const int intervalMs = std::max(0, envInt("BIZ_REPORT_INTERVAL_MS", 15000));
    if (intervalMs > 0) {
        m_reportTimer = new QTimer(this);
        m_reportTimer->setInterval(intervalMs);
        connect(m_reportTimer, &QTimer::timeout, this, [this](){ maybeEmitBizReport(true); });
        m_reportTimer->start();
    }
    maybeEmitBizReport(true);
    if (onlyPage == Page::Parking) {
        if (m_etcBtn) m_etcBtn->hide();
    } else {
        if (m_parkingBtn) m_parkingBtn->hide();
    }
    setPage(onlyPage);
}

void BusinessDialog::setPage(Page page) {
    if (m_singleMode) page = m_onlyPage;
    m_stack->setCurrentIndex(page == Page::Parking ? 0 : 1);
    if (m_parkingBtn) m_parkingBtn->setChecked(page == Page::Parking);
    if (m_etcBtn) m_etcBtn->setChecked(page == Page::Etc);
}

QJsonObject BusinessDialog::handlePlateEvent(const QImage &, const QString &plate, const QString &timeBj, int source, double) {
    QJsonObject event;
    if (plate.trimmed().isEmpty()) return event;
    QDateTime t = parseBjTime(timeBj);

    bool doParking = !m_singleMode || m_onlyPage == Page::Parking;
    bool doEtc = !m_singleMode || m_onlyPage == Page::Etc;

    if (doParking) {
        auto it = m_activeCars.find(plate);
        if (it == m_activeCars.end()) {
            ParkingActive a;
            a.entryTime = t;
            a.entrySource = source;
            m_activeCars.insert(plate, a);
            {
                double bal = m_parkingAccounts.value(plate, 0.0);
                double arrears = m_parkingArrears.value(plate, 0.0);
                ParkingTxn tx;
                tx.time = t;
                tx.plate = plate;
                tx.source = source;
                tx.amount = 0.0;
                tx.balanceAfter = bal;
                tx.arrearsAfter = arrears;
                tx.result = QStringLiteral("入场");
                addParkingTxn(tx);
            }
            refreshParkingTables();
            event.insert("system", "parking");
            event.insert("template_key", m_parkingAccounts.contains(plate) ? "entry_owner" : "entry");
            event.insert("plate", plate);
            event.insert("fee", 0.0);
            event.insert("need_pay", 0.0);
        } else {
            qint64 secs = it->entryTime.secsTo(t);
            if (secs < 60) return event;
            int mins = (int)((secs + 59) / 60);
            ParkingRecord r;
            r.plate = plate;
            r.entryTime = it->entryTime;
            r.exitTime = t;
            r.minutes = mins;
            r.fee = calcParkingFeeMinutes(mins, m_parkingCfg);
            r.entrySource = it->entrySource;
            r.exitSource = source;
            m_activeCars.erase(it);
            addParkingRecord(r);

            double bal = m_parkingAccounts.value(plate, 0.0);
            double arrears = m_parkingArrears.value(plate, 0.0);
            bool hasAcc = m_parkingAccounts.contains(plate);
            double need = r.fee;

            double use = std::min(bal, need);
            bal -= use;
            need -= use;
            if (need > 1e-6) arrears += need;

            if (hasAcc) m_parkingAccounts[plate] = bal;
            if (arrears > 1e-6 || m_parkingArrears.contains(plate)) m_parkingArrears[plate] = arrears;
            else m_parkingArrears.remove(plate);

            ParkingTxn tx;
            tx.time = t;
            tx.plate = plate;
            tx.source = source;
            tx.amount = -r.fee;
            tx.balanceAfter = bal;
            tx.arrearsAfter = arrears;
            if (r.fee <= 1e-6) tx.result = QStringLiteral("免费出场");
            else if (!hasAcc) tx.result = QStringLiteral("未办卡，欠费%1元").arg(arrears, 0, 'f', 2);
            else if (need > 1e-6) tx.result = QStringLiteral("余额不足，欠费%1元").arg(arrears, 0, 'f', 2);
            else tx.result = QStringLiteral("扣费成功");
            addParkingTxn(tx);
            refreshParkingTables();
            saveConfig();
            event.insert("system", "parking");
            if (r.fee <= 1e-6) event.insert("template_key", "exit_free");
            else if (!hasAcc) event.insert("template_key", "exit_not_opened");
            else if (need > 1e-6) event.insert("template_key", "exit_insufficient");
            else event.insert("template_key", "exit_deducted");
            event.insert("plate", plate);
            event.insert("fee", r.fee);
            event.insert("need_pay", need);
        }
    }

    if (doEtc) {
        EtcRecord er;
        er.time = t;
        er.plate = plate;
        er.source = source;
        er.amount = -m_etcCfg.tollYuan;
        double bal = m_etcAccounts.value(plate, 0.0);
        double arrears = m_etcArrears.value(plate, 0.0);
        bool hasAcc = m_etcAccounts.contains(plate);
        double toll = m_etcCfg.tollYuan;

        if (hasAcc && bal + 1e-6 >= toll) {
            bal -= toll;
            m_etcAccounts[plate] = bal;
            er.balanceAfter = bal;
            er.arrearsAfter = arrears;
            event.insert("template_key", "pass_deducted");
            event.insert("need_pay", 0.0);
            er.result = QStringLiteral("扣费成功");
        } else {
            double need = toll;
            double use = hasAcc ? std::min(bal, need) : 0.0;
            bal -= use;
            need -= use;
            if (hasAcc) m_etcAccounts[plate] = bal;
            arrears += need;
            m_etcArrears[plate] = arrears;
            er.balanceAfter = bal;
            er.arrearsAfter = arrears;
            if (!hasAcc) er.result = QStringLiteral("未开通，欠费%1元").arg(arrears, 0, 'f', 2);
            else er.result = QStringLiteral("余额不足，欠费%1元").arg(arrears, 0, 'f', 2);
            event.insert("template_key", hasAcc ? "pass_insufficient" : "pass_not_opened");
            event.insert("need_pay", need);
        }
        addEtcRecord(er);
        refreshEtcTables();
        saveConfig();
        event.insert("system", "etc");
        event.insert("plate", plate);
        event.insert("fee", toll);
    }
    maybeEmitBizReport(false);
    return event;
}

void BusinessDialog::maybeEmitBizReport(bool force) {
    const qint64 nowMs = QDateTime::currentMSecsSinceEpoch();
    if (!force && (nowMs - m_lastReportAtMs) < (qint64)m_reportMinIntervalMs) return;
    m_lastReportAtMs = nowMs;
    emit bizReportReady(buildBizReport());
}

QJsonObject BusinessDialog::applyRemoteOp(const QString &system, const QString &op, const QString &plate, double amount) {
    const QString sys = system.trimmed().toLower();
    const QString kind = op.trimmed().toLower();
    const QString p = plate.trimmed();
    if (p.isEmpty()) return QJsonObject{{"ok", false}, {"error", "bad_plate"}};

    if (m_singleMode) {
        const bool sysOk = (m_onlyPage == Page::Parking && sys == "parking") || (m_onlyPage == Page::Etc && sys == "etc");
        if (!sysOk) return QJsonObject{{"ok", false}, {"error", "system_not_supported"}};
    } else {
        if (sys != "parking" && sys != "etc") return QJsonObject{{"ok", false}, {"error", "bad_system"}};
    }

    const QDateTime t = QDateTime::currentDateTimeUtc().toTimeZone(bjTz());

    if (sys == "parking") {
        if (kind == "open") {
            if (!m_parkingAccounts.contains(p)) m_parkingAccounts[p] = 0.0;
            settleParkingArrears(p, t, 0, QStringLiteral("开通停车卡"));
            saveConfig();
            refreshParkingTables();
            maybeEmitBizReport(true);
            return QJsonObject{{"ok", true}, {"system", "parking"}, {"op", "open"}, {"report", buildBizReport()}};
        }
        if (kind == "recharge") {
            if (!qIsFinite(amount) || amount <= 0.0) return QJsonObject{{"ok", false}, {"error", "bad_params"}};
            if (!m_parkingAccounts.contains(p)) return QJsonObject{{"ok", false}, {"error", "no_account"}};
            m_parkingAccounts[p] = m_parkingAccounts.value(p, 0.0) + amount;
            ParkingTxn tx;
            tx.time = t;
            tx.plate = p;
            tx.source = 0;
            tx.amount = amount;
            tx.balanceAfter = m_parkingAccounts.value(p, 0.0);
            tx.arrearsAfter = m_parkingArrears.value(p, 0.0);
            tx.result = QStringLiteral("充值");
            addParkingTxn(tx);
            settleParkingArrears(p, t, 0, QStringLiteral("充值后"));
            saveConfig();
            refreshParkingTables();
            maybeEmitBizReport(true);
            return QJsonObject{{"ok", true}, {"system", "parking"}, {"op", "recharge"}, {"report", buildBizReport()}};
        }
        if (kind == "debit") {
            if (!qIsFinite(amount) || amount <= 0.0) return QJsonObject{{"ok", false}, {"error", "bad_params"}};
            double bal = m_parkingAccounts.value(p, 0.0);
            double arr = m_parkingArrears.value(p, 0.0);
            const bool hasAcc = m_parkingAccounts.contains(p);
            double need = amount;
            const double use = hasAcc ? std::min(bal, need) : 0.0;
            bal -= use;
            need -= use;
            if (hasAcc) m_parkingAccounts[p] = bal;
            if (need > 1e-6) m_parkingArrears[p] = arr + need;
            else if (arr <= 1e-6) m_parkingArrears.remove(p);

            ParkingTxn tx;
            tx.time = t;
            tx.plate = p;
            tx.source = 0;
            tx.amount = -amount;
            tx.balanceAfter = bal;
            tx.arrearsAfter = m_parkingArrears.value(p, 0.0);
            tx.result = QStringLiteral("人工扣费");
            addParkingTxn(tx);
            saveConfig();
            refreshParkingTables();
            maybeEmitBizReport(true);
            return QJsonObject{{"ok", true}, {"system", "parking"}, {"op", "debit"}, {"report", buildBizReport()}};
        }
        if (kind == "close") {
            if (m_activeCars.contains(p)) return QJsonObject{{"ok", false}, {"error", "car_in_park"}};
            m_parkingAccounts.remove(p);
            m_parkingArrears.remove(p);
            ParkingTxn tx;
            tx.time = t;
            tx.plate = p;
            tx.source = 0;
            tx.amount = 0.0;
            tx.balanceAfter = 0.0;
            tx.arrearsAfter = 0.0;
            tx.result = QStringLiteral("销卡");
            addParkingTxn(tx);
            saveConfig();
            refreshParkingTables();
            maybeEmitBizReport(true);
            return QJsonObject{{"ok", true}, {"system", "parking"}, {"op", "close"}, {"report", buildBizReport()}};
        }
        return QJsonObject{{"ok", false}, {"error", "bad_op"}};
    }

    if (kind == "open") {
        if (!m_etcAccounts.contains(p)) m_etcAccounts[p] = 0.0;
        EtcRecord rec;
        rec.time = t;
        rec.plate = p;
        rec.source = 0;
        rec.amount = 0.0;
        rec.balanceAfter = m_etcAccounts.value(p, 0.0);
        rec.arrearsAfter = m_etcArrears.value(p, 0.0);
        rec.result = QStringLiteral("开通");
        addEtcRecord(rec);
        settleEtcArrears(p, t, 0, QStringLiteral("开通后"));
        saveConfig();
        refreshEtcTables();
        maybeEmitBizReport(true);
        return QJsonObject{{"ok", true}, {"system", "etc"}, {"op", "open"}, {"report", buildBizReport()}};
    }
    if (kind == "recharge") {
        if (!qIsFinite(amount) || amount <= 0.0) return QJsonObject{{"ok", false}, {"error", "bad_params"}};
        if (!m_etcAccounts.contains(p)) return QJsonObject{{"ok", false}, {"error", "no_account"}};
        m_etcAccounts[p] = m_etcAccounts.value(p, 0.0) + amount;
        EtcRecord rec;
        rec.time = t;
        rec.plate = p;
        rec.source = 0;
        rec.amount = amount;
        rec.balanceAfter = m_etcAccounts.value(p, 0.0);
        rec.arrearsAfter = m_etcArrears.value(p, 0.0);
        rec.result = QStringLiteral("充值");
        addEtcRecord(rec);
        settleEtcArrears(p, t, 0, QStringLiteral("充值后"));
        saveConfig();
        refreshEtcTables();
        maybeEmitBizReport(true);
        return QJsonObject{{"ok", true}, {"system", "etc"}, {"op", "recharge"}, {"report", buildBizReport()}};
    }
    if (kind == "debit") {
        if (!qIsFinite(amount) || amount <= 0.0) return QJsonObject{{"ok", false}, {"error", "bad_params"}};
        double bal = m_etcAccounts.value(p, 0.0);
        double arr = m_etcArrears.value(p, 0.0);
        const bool hasAcc = m_etcAccounts.contains(p);
        double need = amount;
        const double use = hasAcc ? std::min(bal, need) : 0.0;
        bal -= use;
        need -= use;
        if (hasAcc) m_etcAccounts[p] = bal;
        if (need > 1e-6) m_etcArrears[p] = arr + need;
        else if (arr <= 1e-6) m_etcArrears.remove(p);

        EtcRecord rec;
        rec.time = t;
        rec.plate = p;
        rec.source = 0;
        rec.amount = -amount;
        rec.balanceAfter = bal;
        rec.arrearsAfter = m_etcArrears.value(p, 0.0);
        rec.result = QStringLiteral("人工扣费");
        addEtcRecord(rec);
        saveConfig();
        refreshEtcTables();
        maybeEmitBizReport(true);
        return QJsonObject{{"ok", true}, {"system", "etc"}, {"op", "debit"}, {"report", buildBizReport()}};
    }
    if (kind == "close") {
        m_etcAccounts.remove(p);
        m_etcArrears.remove(p);
        EtcRecord rec;
        rec.time = t;
        rec.plate = p;
        rec.source = 0;
        rec.amount = 0.0;
        rec.balanceAfter = 0.0;
        rec.arrearsAfter = 0.0;
        rec.result = QStringLiteral("销卡");
        addEtcRecord(rec);
        saveConfig();
        refreshEtcTables();
        maybeEmitBizReport(true);
        return QJsonObject{{"ok", true}, {"system", "etc"}, {"op", "close"}, {"report", buildBizReport()}};
    }
    return QJsonObject{{"ok", false}, {"error", "bad_op"}};
}

QString BusinessDialog::configPath() const {
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
    QString target = base + "." + profile;
    return target;
}

void BusinessDialog::loadConfig() {
    QFile f(configPath());
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

    m_freeMinutes->setValue(m_parkingCfg.freeMinutes);
    m_parkingModeBox->setCurrentIndex(m_parkingCfg.mode == ParkingBillingMode::Hourly ? 0 : 1);
    m_parkingRoundingBox->setCurrentIndex(m_parkingCfg.rounding == ParkingRoundingPolicy::RoundUp ? 0 : 1);
    m_pricePerHour->setValue(m_parkingCfg.pricePerHour);
    m_unitMinutes->setValue(m_parkingCfg.unitMinutes);
    m_pricePerUnit->setValue(m_parkingCfg.pricePerUnit);
    updateParkingModeUi();
    m_etcToll->setValue(m_etcCfg.tollYuan);
}

void BusinessDialog::saveConfig() {
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
    maybeEmitBizReport(true);
}

QJsonObject BusinessDialog::buildBizReport() const {
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

QDateTime BusinessDialog::parseBjTime(const QString &timeBj) {
    QDateTime dt = QDateTime::fromString(timeBj, "yyyy-MM-dd HH:mm:ss");
    dt.setTimeZone(bjTz());
    if (!dt.isValid()) {
        dt = QDateTime::currentDateTimeUtc().toTimeZone(bjTz());
    }
    return dt;
}

double BusinessDialog::calcParkingFeeMinutes(int minutes, const ParkingConfig &cfg) {
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

void BusinessDialog::buildUi() {
    QVBoxLayout *root = new QVBoxLayout(this);
    root->setContentsMargins(10, 10, 10, 10);
    root->setSpacing(10);

    QWidget *top = new QWidget(this);
    QHBoxLayout *topL = new QHBoxLayout(top);
    topL->setContentsMargins(0, 0, 0, 0);
    topL->setSpacing(8);

    QLabel *title = new QLabel(QStringLiteral("业务功能"), top);
    QFont ft = title->font();
    ft.setPixelSize(16);
    ft.setBold(true);
    title->setFont(ft);

    m_parkingBtn = new QPushButton(QStringLiteral("停车场计费"), top);
    m_etcBtn = new QPushButton("ETC", top);
    m_parkingBtn->setCheckable(true);
    m_etcBtn->setCheckable(true);
    m_parkingBtn->setChecked(true);
    m_parkingBtn->setFixedWidth(120);
    m_etcBtn->setFixedWidth(120);

    topL->addWidget(title);
    topL->addStretch();
    topL->addWidget(m_parkingBtn);
    topL->addWidget(m_etcBtn);

    m_stack = new QStackedWidget(this);
    m_stack->addWidget(buildParkingPage());
    m_stack->addWidget(buildEtcPage());

    connect(m_parkingBtn, &QPushButton::clicked, this, [this](){ setPage(Page::Parking); });
    connect(m_etcBtn, &QPushButton::clicked, this, [this](){ setPage(Page::Etc); });

    root->addWidget(top);
    root->addWidget(m_stack, 1);
}

QWidget* BusinessDialog::buildParkingPage() {
    QWidget *w = new QWidget(this);
    QVBoxLayout *l = new QVBoxLayout(w);
    l->setContentsMargins(0, 0, 0, 0);
    l->setSpacing(10);

    QWidget *cfg = new QWidget(w);
    QVBoxLayout *cfgVL = new QVBoxLayout(cfg);
    cfgVL->setContentsMargins(0, 0, 0, 0);
    cfgVL->setSpacing(6);

    QWidget *row1 = new QWidget(cfg);
    QHBoxLayout *r1 = new QHBoxLayout(row1);
    r1->setContentsMargins(0, 0, 0, 0);
    r1->setSpacing(10);

    QLabel *modeLab = new QLabel(QStringLiteral("收费标准:"), row1);
    m_parkingModeBox = new QComboBox(row1);
    m_parkingModeBox->addItems({QStringLiteral("默认(按小时)"), QStringLiteral("自定义")});
    m_parkingModeBox->setFixedWidth(120);
    m_parkingModeBox->setCurrentIndex(m_parkingCfg.mode == ParkingBillingMode::Hourly ? 0 : 1);

    QLabel *freeLab = new QLabel(QStringLiteral("免费时长(分钟):"), row1);
    m_freeMinutes = new QSpinBox(row1);
    m_freeMinutes->setRange(0, 240);
    m_freeMinutes->setValue(m_parkingCfg.freeMinutes);

    QLabel *roundLab = new QLabel(QStringLiteral("不足一个单位时:"), row1);
    m_parkingRoundingBox = new QComboBox(row1);
    m_parkingRoundingBox->addItems({QStringLiteral("按单位计费"), QStringLiteral("舍去不计费")});
    m_parkingRoundingBox->setFixedWidth(120);
    m_parkingRoundingBox->setCurrentIndex(m_parkingCfg.rounding == ParkingRoundingPolicy::RoundUp ? 0 : 1);

    m_parkingExportBtn = new QPushButton(QStringLiteral("导出账单"), row1);
    m_parkingClearBtn = new QPushButton(QStringLiteral("清空记录"), row1);

    r1->addWidget(modeLab);
    r1->addWidget(m_parkingModeBox);
    r1->addSpacing(6);
    r1->addWidget(freeLab);
    r1->addWidget(m_freeMinutes);
    r1->addSpacing(6);
    r1->addWidget(roundLab);
    r1->addWidget(m_parkingRoundingBox);
    r1->addStretch();
    r1->addWidget(m_parkingExportBtn);
    r1->addWidget(m_parkingClearBtn);

    QWidget *row2 = new QWidget(cfg);
    QHBoxLayout *r2 = new QHBoxLayout(row2);
    r2->setContentsMargins(0, 0, 0, 0);
    r2->setSpacing(10);

    m_hourlyCfgWidget = new QWidget(row2);
    QHBoxLayout *hhl = new QHBoxLayout(m_hourlyCfgWidget);
    hhl->setContentsMargins(0, 0, 0, 0);
    hhl->setSpacing(10);
    QLabel *hourLab = new QLabel(QStringLiteral("每小时收费(元):"), m_hourlyCfgWidget);
    m_pricePerHour = new QDoubleSpinBox(m_hourlyCfgWidget);
    m_pricePerHour->setRange(0.0, 999.0);
    m_pricePerHour->setDecimals(2);
    m_pricePerHour->setSingleStep(1.0);
    m_pricePerHour->setValue(m_parkingCfg.pricePerHour);
    hhl->addWidget(hourLab);
    hhl->addWidget(m_pricePerHour);

    m_customCfgWidget = new QWidget(row2);
    QHBoxLayout *chl = new QHBoxLayout(m_customCfgWidget);
    chl->setContentsMargins(0, 0, 0, 0);
    chl->setSpacing(10);
    QLabel *unitLab = new QLabel(QStringLiteral("计费单位(分钟):"), m_customCfgWidget);
    m_unitMinutes = new QSpinBox(m_customCfgWidget);
    m_unitMinutes->setRange(1, 240);
    m_unitMinutes->setValue(m_parkingCfg.unitMinutes);
    QLabel *priceLab = new QLabel(QStringLiteral("每单位收费(元):"), m_customCfgWidget);
    m_pricePerUnit = new QDoubleSpinBox(m_customCfgWidget);
    m_pricePerUnit->setRange(0.0, 999.0);
    m_pricePerUnit->setDecimals(2);
    m_pricePerUnit->setSingleStep(1.0);
    m_pricePerUnit->setValue(m_parkingCfg.pricePerUnit);
    chl->addWidget(unitLab);
    chl->addWidget(m_unitMinutes);
    chl->addWidget(priceLab);
    chl->addWidget(m_pricePerUnit);

    r2->addWidget(m_hourlyCfgWidget);
    r2->addWidget(m_customCfgWidget);
    r2->addStretch();

    cfgVL->addWidget(row1);
    cfgVL->addWidget(row2);

    connect(m_parkingModeBox, QOverload<int>::of(&QComboBox::currentIndexChanged), this, [this](int){
        applyParkingConfigFromUi();
        updateParkingModeUi();
    });
    connect(m_parkingRoundingBox, QOverload<int>::of(&QComboBox::currentIndexChanged), this, [this](int){
        applyParkingConfigFromUi();
    });
    connect(m_freeMinutes, QOverload<int>::of(&QSpinBox::valueChanged), this, [this](int){ applyParkingConfigFromUi(); });
    connect(m_pricePerHour, QOverload<double>::of(&QDoubleSpinBox::valueChanged), this, [this](double){ applyParkingConfigFromUi(); });
    connect(m_unitMinutes, QOverload<int>::of(&QSpinBox::valueChanged), this, [this](int){ applyParkingConfigFromUi(); });
    connect(m_pricePerUnit, QOverload<double>::of(&QDoubleSpinBox::valueChanged), this, [this](double){ applyParkingConfigFromUi(); });

    connect(m_parkingClearBtn, &QPushButton::clicked, this, [this](){
        m_activeCars.clear();
        m_parkingRecords.clear();
        m_parkingTxns.clear();
        refreshParkingTables();
        maybeEmitBizReport(true);
    });

    connect(m_parkingExportBtn, &QPushButton::clicked, this, [this](){
        QString base = qEnvironmentVariable("RK3568_REPORT_DIR_CSV", QDir::homePath());
        QString dir = QFileDialog::getExistingDirectory(this, QStringLiteral("选择导出目录"), base);
        if (dir.isEmpty()) return;
        QDir d(dir);
        QString name = "parking_bill_" + QDate::currentDate().toString("yyyyMMdd") + ".csv";
        QString path = d.filePath(name);
        QFile f(path);
        if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) return;
        QTextStream ts(&f);
        ts.setCodec("UTF-8");
        ts << "plate,entry_time,exit_time,minutes,fee,entry_source,exit_source\n";
        for (const auto &r : m_parkingRecords) {
            ts << r.plate << ","
               << r.entryTime.toString("yyyy-MM-dd HH:mm:ss") << ","
               << r.exitTime.toString("yyyy-MM-dd HH:mm:ss") << ","
               << r.minutes << ","
               << QString::number(r.fee, 'f', 2) << ","
               << r.entrySource << ","
               << r.exitSource << "\n";
        }
        QMessageBox::information(this, QStringLiteral("导出完成"), QStringLiteral("已导出到:\n") + path);
    });

    QTabWidget *tabs = new QTabWidget(w);

    QWidget *tabActive = new QWidget(tabs);
    QVBoxLayout *taL = new QVBoxLayout(tabActive);
    taL->setContentsMargins(0, 0, 0, 0);
    taL->setSpacing(8);
    QLabel *activeTitle = new QLabel(QStringLiteral("在场车辆（首次识别为入场，再次识别为出场结算）"), tabActive);
    m_parkingActiveTable = new QTableWidget(tabActive);
    m_parkingActiveTable->setColumnCount(4);
    m_parkingActiveTable->setHorizontalHeaderLabels({
        QStringLiteral("车牌"),
        QStringLiteral("入场时间"),
        QStringLiteral("入场源"),
        QStringLiteral("已开通停车卡")
    });
    m_parkingActiveTable->horizontalHeader()->setSectionResizeMode(QHeaderView::Stretch);
    m_parkingActiveTable->setEditTriggers(QAbstractItemView::NoEditTriggers);
    m_parkingActiveTable->setSelectionBehavior(QAbstractItemView::SelectRows);
    taL->addWidget(activeTitle);
    taL->addWidget(m_parkingActiveTable, 1);

    QWidget *tabAcc = new QWidget(tabs);
    QVBoxLayout *paL = new QVBoxLayout(tabAcc);
    paL->setContentsMargins(0, 0, 0, 0);
    paL->setSpacing(8);
    QWidget *paTools = new QWidget(tabAcc);
    QHBoxLayout *paT = new QHBoxLayout(paTools);
    paT->setContentsMargins(0, 0, 0, 0);
    paT->setSpacing(10);
    QLabel *pPlateLab = new QLabel(QStringLiteral("车牌:"), paTools);
    m_parkingProvBox = new QComboBox(paTools);
    m_parkingProvBox->addItems({
        QStringLiteral("京"), QStringLiteral("津"), QStringLiteral("冀"), QStringLiteral("晋"), QStringLiteral("蒙"),
        QStringLiteral("辽"), QStringLiteral("吉"), QStringLiteral("黑"), QStringLiteral("沪"), QStringLiteral("苏"),
        QStringLiteral("浙"), QStringLiteral("皖"), QStringLiteral("闽"), QStringLiteral("赣"), QStringLiteral("鲁"),
        QStringLiteral("豫"), QStringLiteral("鄂"), QStringLiteral("湘"), QStringLiteral("粤"), QStringLiteral("桂"),
        QStringLiteral("琼"), QStringLiteral("渝"), QStringLiteral("川"), QStringLiteral("贵"), QStringLiteral("云"),
        QStringLiteral("陕"), QStringLiteral("甘"), QStringLiteral("青"), QStringLiteral("宁"), QStringLiteral("新"),
        QStringLiteral("藏")
    });
    m_parkingProvBox->setFixedWidth(70);
    m_parkingPlateEdit = new QLineEdit(paTools);
    m_parkingPlateEdit->setFixedWidth(120);
    m_parkingPlateEdit->setPlaceholderText("A12345");
    QLabel *pAmtLab = new QLabel(QStringLiteral("充值(元):"), paTools);
    m_parkingRechargeAmt = new QDoubleSpinBox(paTools);
    m_parkingRechargeAmt->setRange(0.0, 99999.0);
    m_parkingRechargeAmt->setDecimals(2);
    m_parkingRechargeAmt->setSingleStep(10.0);
    m_parkingRechargeAmt->setValue(100.0);
    QLabel *pDeductLab = new QLabel(QStringLiteral("扣费(元):"), paTools);
    m_parkingDeductAmt = new QDoubleSpinBox(paTools);
    m_parkingDeductAmt->setRange(0.0, 99999.0);
    m_parkingDeductAmt->setDecimals(2);
    m_parkingDeductAmt->setSingleStep(10.0);
    m_parkingDeductAmt->setValue(10.0);
    m_parkingAccOpenBtn = new QPushButton(QStringLiteral("开通停车卡"), paTools);
    m_parkingAccRechargeBtn = new QPushButton(QStringLiteral("充值"), paTools);
    m_parkingManualDeductBtn = new QPushButton(QStringLiteral("人工扣费"), paTools);
    m_parkingAccCancelBtn = new QPushButton(QStringLiteral("销卡"), paTools);
    m_parkingAccImportBtn = new QPushButton(QStringLiteral("导入账户"), paTools);
    m_parkingAccExportBtn = new QPushButton(QStringLiteral("导出账户"), paTools);
    paT->addWidget(pPlateLab);
    paT->addWidget(m_parkingProvBox);
    paT->addWidget(m_parkingPlateEdit);
    paT->addWidget(pAmtLab);
    paT->addWidget(m_parkingRechargeAmt);
    paT->addWidget(pDeductLab);
    paT->addWidget(m_parkingDeductAmt);
    paT->addWidget(m_parkingAccOpenBtn);
    paT->addWidget(m_parkingAccRechargeBtn);
    paT->addWidget(m_parkingManualDeductBtn);
    paT->addWidget(m_parkingAccCancelBtn);
    paT->addStretch();
    paT->addWidget(m_parkingAccImportBtn);
    paT->addWidget(m_parkingAccExportBtn);

    m_parkingAccountsTable = new QTableWidget(tabAcc);
    m_parkingAccountsTable->setColumnCount(3);
    m_parkingAccountsTable->setHorizontalHeaderLabels({
        QStringLiteral("车牌"),
        QStringLiteral("余额(元)"),
        QStringLiteral("欠费(元)")
    });
    m_parkingAccountsTable->horizontalHeader()->setSectionResizeMode(QHeaderView::Stretch);
    m_parkingAccountsTable->setEditTriggers(QAbstractItemView::NoEditTriggers);
    m_parkingAccountsTable->setSelectionBehavior(QAbstractItemView::SelectRows);
    paL->addWidget(paTools);
    paL->addWidget(m_parkingAccountsTable, 1);

    connect(m_parkingAccountsTable, &QTableWidget::cellClicked, this, [this](int row, int){
        if (!m_parkingAccountsTable) return;
        QTableWidgetItem *it = m_parkingAccountsTable->item(row, 0);
        if (!it) return;
        QString plate = it->text().trimmed();
        if (plate.isEmpty()) return;
        if (m_parkingProvBox) {
            int idx = m_parkingProvBox->findText(plate.left(1));
            if (idx >= 0) {
                m_parkingProvBox->setCurrentIndex(idx);
                if (m_parkingPlateEdit) m_parkingPlateEdit->setText(plate.mid(1));
            } else {
                m_parkingProvBox->setCurrentIndex(0);
                if (m_parkingPlateEdit) m_parkingPlateEdit->setText(plate);
            }
        } else {
            if (m_parkingPlateEdit) m_parkingPlateEdit->setText(plate);
        }
    });

    QWidget *tabTxn = new QWidget(tabs);
    QVBoxLayout *ptL = new QVBoxLayout(tabTxn);
    ptL->setContentsMargins(0, 0, 0, 0);
    ptL->setSpacing(8);
    QWidget *ptTools = new QWidget(tabTxn);
    QHBoxLayout *ptT = new QHBoxLayout(ptTools);
    ptT->setContentsMargins(0, 0, 0, 0);
    ptT->setSpacing(10);
    m_parkingTxnExportBtn = new QPushButton(QStringLiteral("导出流水"), ptTools);
    m_parkingTxnClearBtn = new QPushButton(QStringLiteral("清空流水"), ptTools);
    ptT->addStretch();
    ptT->addWidget(m_parkingTxnExportBtn);
    ptT->addWidget(m_parkingTxnClearBtn);
    m_parkingTxnTable = new QTableWidget(tabTxn);
    m_parkingTxnTable->setColumnCount(7);
    m_parkingTxnTable->setHorizontalHeaderLabels({
        QStringLiteral("时间"),
        QStringLiteral("车牌"),
        QStringLiteral("来源"),
        QStringLiteral("变动(元)"),
        QStringLiteral("余额(元)"),
        QStringLiteral("欠费(元)"),
        QStringLiteral("结果")
    });
    m_parkingTxnTable->horizontalHeader()->setSectionResizeMode(QHeaderView::Stretch);
    m_parkingTxnTable->setEditTriggers(QAbstractItemView::NoEditTriggers);
    m_parkingTxnTable->setSelectionBehavior(QAbstractItemView::SelectRows);
    ptL->addWidget(ptTools);
    ptL->addWidget(m_parkingTxnTable, 1);

    tabs->addTab(tabActive, QStringLiteral("在场车辆"));
    tabs->addTab(tabAcc, QStringLiteral("账户管理"));
    tabs->addTab(tabTxn, QStringLiteral("流水查询"));

    connect(m_parkingAccOpenBtn, &QPushButton::clicked, this, [this](){
        QString p = parkingPlateFromUi();
        if (p.isEmpty()) return;
        if (!m_parkingAccounts.contains(p)) m_parkingAccounts[p] = 0.0;
        QDateTime t = QDateTime::currentDateTimeUtc().toTimeZone(bjTz());
        settleParkingArrears(p, t, 0, QStringLiteral("开通停车卡"));
        saveConfig();
        refreshParkingTables();
        maybeEmitBizReport(true);
    });
    connect(m_parkingAccRechargeBtn, &QPushButton::clicked, this, [this](){
        QString p = parkingPlateFromUi();
        if (p.isEmpty()) return;
        if (!m_parkingAccounts.contains(p)) {
            QMessageBox::warning(this, QStringLiteral("提示"), QStringLiteral("请先开通停车卡，再进行充值。"));
            return;
        }
        double add = m_parkingRechargeAmt->value();
        if (add <= 0.0) return;
        m_parkingAccounts[p] = m_parkingAccounts.value(p, 0.0) + add;
        ParkingTxn tx;
        tx.time = QDateTime::currentDateTimeUtc().toTimeZone(bjTz());
        tx.plate = p;
        tx.source = 0;
        tx.amount = add;
        tx.balanceAfter = m_parkingAccounts.value(p, 0.0);
        tx.arrearsAfter = m_parkingArrears.value(p, 0.0);
        tx.result = QStringLiteral("充值");
        addParkingTxn(tx);
        settleParkingArrears(p, tx.time, 0, QStringLiteral("充值后"));
        saveConfig();
        refreshParkingTables();
        maybeEmitBizReport(true);
    });

    connect(m_parkingManualDeductBtn, &QPushButton::clicked, this, [this](){
        QString p = parkingPlateFromUi();
        if (p.isEmpty()) return;
        double amt = m_parkingDeductAmt->value();
        if (amt <= 0.0) return;
        double bal = m_parkingAccounts.value(p, 0.0);
        double arr = m_parkingArrears.value(p, 0.0);
        bool hasAcc = m_parkingAccounts.contains(p);
        double need = amt;
        double use = hasAcc ? std::min(bal, need) : 0.0;
        bal -= use;
        need -= use;
        if (hasAcc) m_parkingAccounts[p] = bal;
        if (need > 1e-6) m_parkingArrears[p] = arr + need;
        else if (arr <= 1e-6) m_parkingArrears.remove(p);

        ParkingTxn tx;
        tx.time = QDateTime::currentDateTimeUtc().toTimeZone(bjTz());
        tx.plate = p;
        tx.source = 0;
        tx.amount = -amt;
        tx.balanceAfter = bal;
        tx.arrearsAfter = m_parkingArrears.value(p, 0.0);
        tx.result = QStringLiteral("人工扣费");
        addParkingTxn(tx);
        saveConfig();
        refreshParkingTables();
        maybeEmitBizReport(true);
    });

    connect(m_parkingAccCancelBtn, &QPushButton::clicked, this, [this](){
        QString p = parkingPlateFromUi();
        if (p.isEmpty()) return;
        if (m_activeCars.contains(p)) {
            QMessageBox::warning(this, QStringLiteral("提示"), QStringLiteral("该车辆当前在场，无法销卡。"));
            return;
        }
        m_parkingAccounts.remove(p);
        m_parkingArrears.remove(p);
        ParkingTxn tx;
        tx.time = QDateTime::currentDateTimeUtc().toTimeZone(bjTz());
        tx.plate = p;
        tx.source = 0;
        tx.amount = 0.0;
        tx.balanceAfter = 0.0;
        tx.arrearsAfter = 0.0;
        tx.result = QStringLiteral("销卡");
        addParkingTxn(tx);
        saveConfig();
        refreshParkingTables();
        maybeEmitBizReport(true);
    });
    connect(m_parkingAccExportBtn, &QPushButton::clicked, this, [this](){
        QString base = qEnvironmentVariable("RK3568_REPORT_DIR_CSV", QDir::homePath());
        QString dir = QFileDialog::getExistingDirectory(this, QStringLiteral("选择导出目录"), base);
        if (dir.isEmpty()) return;
        QDir d(dir);
        QString name = "parking_accounts_" + QDate::currentDate().toString("yyyyMMdd") + ".csv";
        QString path = d.filePath(name);
        QFile f(path);
        if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) return;
        QTextStream ts(&f);
        ts.setCodec("UTF-8");
        ts << "plate,balance,arrears\n";
        QSet<QString> keys;
        for (auto it = m_parkingAccounts.begin(); it != m_parkingAccounts.end(); ++it) keys.insert(it.key());
        for (auto it = m_parkingArrears.begin(); it != m_parkingArrears.end(); ++it) keys.insert(it.key());
        for (const auto &k : keys) {
            ts << k << "," << QString::number(m_parkingAccounts.value(k, 0.0), 'f', 2) << "," << QString::number(m_parkingArrears.value(k, 0.0), 'f', 2) << "\n";
        }
        QMessageBox::information(this, QStringLiteral("导出完成"), QStringLiteral("已导出到:\n") + path);
    });
    connect(m_parkingAccImportBtn, &QPushButton::clicked, this, [this](){
        QString base = qEnvironmentVariable("RK3568_REPORT_DIR_CSV", QDir::homePath());
        QString path = QFileDialog::getOpenFileName(this, QStringLiteral("选择账户报表"), base, "CSV (*.csv);;All Files (*)");
        if (path.isEmpty()) return;
        QFile f(path);
        if (!f.open(QIODevice::ReadOnly)) return;
        QTextStream ts(&f);
        ts.setCodec("UTF-8");
        int imported = 0;
        while (!ts.atEnd()) {
            QString line = ts.readLine().trimmed();
            if (line.isEmpty()) continue;
            if (line.contains("plate", Qt::CaseInsensitive) && line.contains("balance", Qt::CaseInsensitive)) continue;
            QStringList cols = line.split(',', Qt::KeepEmptyParts);
            if (cols.size() < 2) continue;
            QString plate = cols[0].trimmed();
            if (plate.isEmpty()) continue;
            bool ok1 = false, ok2 = true;
            double bal = cols[1].trimmed().toDouble(&ok1);
            double arr = 0.0;
            if (cols.size() >= 3) arr = cols[2].trimmed().toDouble(&ok2);
            if (!ok1) continue;
            m_parkingAccounts[plate] = bal;
            if (ok2 && arr > 1e-6) m_parkingArrears[plate] = arr;
            imported++;
        }
        saveConfig();
        refreshParkingTables();
        maybeEmitBizReport(true);
        QMessageBox::information(this, QStringLiteral("导入完成"), QStringLiteral("已导入 %1 条账户记录。").arg(imported));
    });
    connect(m_parkingTxnClearBtn, &QPushButton::clicked, this, [this](){
        m_parkingTxns.clear();
        refreshParkingTables();
        maybeEmitBizReport(true);
    });
    connect(m_parkingTxnExportBtn, &QPushButton::clicked, this, [this](){
        QString base = qEnvironmentVariable("RK3568_REPORT_DIR_CSV", QDir::homePath());
        QString dir = QFileDialog::getExistingDirectory(this, QStringLiteral("选择导出目录"), base);
        if (dir.isEmpty()) return;
        QDir d(dir);
        QString name = "parking_txns_" + QDate::currentDate().toString("yyyyMMdd") + ".csv";
        QString path = d.filePath(name);
        QFile f(path);
        if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) return;
        QTextStream ts(&f);
        ts.setCodec("UTF-8");
        ts << "time,plate,source,delta,balance,arrears,result\n";
        for (const auto &r : m_parkingTxns) {
            ts << r.time.toString("yyyy-MM-dd HH:mm:ss") << ","
               << r.plate << ","
               << r.source << ","
               << QString::number(r.amount, 'f', 2) << ","
               << QString::number(r.balanceAfter, 'f', 2) << ","
               << QString::number(r.arrearsAfter, 'f', 2) << ","
               << r.result << "\n";
        }
        QMessageBox::information(this, QStringLiteral("导出完成"), QStringLiteral("已导出到:\n") + path);
    });

    updateParkingModeUi();
    l->addWidget(cfg);
    l->addWidget(tabs, 1);
    return w;
}

QWidget* BusinessDialog::buildEtcPage() {
    QWidget *w = new QWidget(this);
    QVBoxLayout *l = new QVBoxLayout(w);
    l->setContentsMargins(0, 0, 0, 0);
    l->setSpacing(10);

    QWidget *cfg = new QWidget(w);
    QHBoxLayout *cfgL = new QHBoxLayout(cfg);
    cfgL->setContentsMargins(0, 0, 0, 0);
    cfgL->setSpacing(10);
    QLabel *tollLab = new QLabel(QStringLiteral("单次扣费(元):"), cfg);
    m_etcToll = new QDoubleSpinBox(cfg);
    m_etcToll->setRange(0.0, 999.0);
    m_etcToll->setDecimals(2);
    m_etcToll->setSingleStep(1.0);
    m_etcToll->setValue(m_etcCfg.tollYuan);
    cfgL->addWidget(tollLab);
    cfgL->addWidget(m_etcToll);
    cfgL->addStretch();
    connect(m_etcToll, QOverload<double>::of(&QDoubleSpinBox::valueChanged), this, [this](double){ applyEtcConfigFromUi(); });

    QTabWidget *tabs = new QTabWidget(w);

    QWidget *tabAcc = new QWidget(tabs);
    QVBoxLayout *eaL = new QVBoxLayout(tabAcc);
    eaL->setContentsMargins(0, 0, 0, 0);
    eaL->setSpacing(8);

    QWidget *tools = new QWidget(tabAcc);
    QHBoxLayout *tL = new QHBoxLayout(tools);
    tL->setContentsMargins(0, 0, 0, 0);
    tL->setSpacing(10);
    QLabel *plateLab = new QLabel(QStringLiteral("车牌:"), tools);
    m_etcProvBox = new QComboBox(tools);
    m_etcProvBox->addItems({
        QStringLiteral("京"), QStringLiteral("津"), QStringLiteral("冀"), QStringLiteral("晋"), QStringLiteral("蒙"),
        QStringLiteral("辽"), QStringLiteral("吉"), QStringLiteral("黑"), QStringLiteral("沪"), QStringLiteral("苏"),
        QStringLiteral("浙"), QStringLiteral("皖"), QStringLiteral("闽"), QStringLiteral("赣"), QStringLiteral("鲁"),
        QStringLiteral("豫"), QStringLiteral("鄂"), QStringLiteral("湘"), QStringLiteral("粤"), QStringLiteral("桂"),
        QStringLiteral("琼"), QStringLiteral("渝"), QStringLiteral("川"), QStringLiteral("贵"), QStringLiteral("云"),
        QStringLiteral("陕"), QStringLiteral("甘"), QStringLiteral("青"), QStringLiteral("宁"), QStringLiteral("新"),
        QStringLiteral("藏")
    });
    m_etcProvBox->setFixedWidth(70);
    m_etcPlateEdit = new QLineEdit(tools);
    m_etcPlateEdit->setFixedWidth(120);
    m_etcPlateEdit->setPlaceholderText("A12345");
    QLabel *amtLab = new QLabel(QStringLiteral("充值(元):"), tools);
    m_etcRechargeAmt = new QDoubleSpinBox(tools);
    m_etcRechargeAmt->setRange(0.0, 99999.0);
    m_etcRechargeAmt->setDecimals(2);
    m_etcRechargeAmt->setSingleStep(10.0);
    m_etcRechargeAmt->setValue(100.0);
    QLabel *dLab = new QLabel(QStringLiteral("扣费(元):"), tools);
    m_etcDeductAmt = new QDoubleSpinBox(tools);
    m_etcDeductAmt->setRange(0.0, 99999.0);
    m_etcDeductAmt->setDecimals(2);
    m_etcDeductAmt->setSingleStep(10.0);
    m_etcDeductAmt->setValue(10.0);
    m_etcAddBtn = new QPushButton(QStringLiteral("开通"), tools);
    m_etcRechargeBtn = new QPushButton(QStringLiteral("充值"), tools);
    m_etcManualDeductBtn = new QPushButton(QStringLiteral("人工扣费"), tools);
    m_etcCancelBtn = new QPushButton(QStringLiteral("销卡"), tools);
    m_etcAccImportBtn = new QPushButton(QStringLiteral("导入账户"), tools);
    m_etcAccExportBtn = new QPushButton(QStringLiteral("导出账户"), tools);
    tL->addWidget(plateLab);
    tL->addWidget(m_etcProvBox);
    tL->addWidget(m_etcPlateEdit);
    tL->addWidget(amtLab);
    tL->addWidget(m_etcRechargeAmt);
    tL->addWidget(dLab);
    tL->addWidget(m_etcDeductAmt);
    tL->addWidget(m_etcAddBtn);
    tL->addWidget(m_etcRechargeBtn);
    tL->addWidget(m_etcManualDeductBtn);
    tL->addWidget(m_etcCancelBtn);
    tL->addStretch();
    tL->addWidget(m_etcAccImportBtn);
    tL->addWidget(m_etcAccExportBtn);

    m_etcAccountsTable = new QTableWidget(tabAcc);
    m_etcAccountsTable->setColumnCount(3);
    m_etcAccountsTable->setHorizontalHeaderLabels({
        QStringLiteral("车牌"),
        QStringLiteral("余额(元)"),
        QStringLiteral("欠费(元)")
    });
    m_etcAccountsTable->horizontalHeader()->setSectionResizeMode(QHeaderView::Stretch);
    m_etcAccountsTable->setEditTriggers(QAbstractItemView::NoEditTriggers);
    m_etcAccountsTable->setSelectionBehavior(QAbstractItemView::SelectRows);
    eaL->addWidget(tools);
    eaL->addWidget(m_etcAccountsTable, 1);

    connect(m_etcAccountsTable, &QTableWidget::cellClicked, this, [this](int row, int){
        if (!m_etcAccountsTable) return;
        QTableWidgetItem *it = m_etcAccountsTable->item(row, 0);
        if (!it) return;
        QString plate = it->text().trimmed();
        if (plate.isEmpty()) return;
        if (m_etcProvBox) {
            int idx = m_etcProvBox->findText(plate.left(1));
            if (idx >= 0) {
                m_etcProvBox->setCurrentIndex(idx);
                if (m_etcPlateEdit) m_etcPlateEdit->setText(plate.mid(1));
            } else {
                m_etcProvBox->setCurrentIndex(0);
                if (m_etcPlateEdit) m_etcPlateEdit->setText(plate);
            }
        } else {
            if (m_etcPlateEdit) m_etcPlateEdit->setText(plate);
        }
    });

    QWidget *tabRec = new QWidget(tabs);
    QVBoxLayout *erL = new QVBoxLayout(tabRec);
    erL->setContentsMargins(0, 0, 0, 0);
    erL->setSpacing(8);
    QWidget *rTools = new QWidget(tabRec);
    QHBoxLayout *rt = new QHBoxLayout(rTools);
    rt->setContentsMargins(0, 0, 0, 0);
    rt->setSpacing(10);
    m_etcExportBtn = new QPushButton(QStringLiteral("导出流水"), rTools);
    m_etcClearBtn = new QPushButton(QStringLiteral("清空流水"), rTools);
    rt->addStretch();
    rt->addWidget(m_etcExportBtn);
    rt->addWidget(m_etcClearBtn);
    m_etcRecordsTable = new QTableWidget(tabRec);
    m_etcRecordsTable->setColumnCount(7);
    m_etcRecordsTable->setHorizontalHeaderLabels({
        QStringLiteral("时间"),
        QStringLiteral("车牌"),
        QStringLiteral("来源"),
        QStringLiteral("变动(元)"),
        QStringLiteral("余额(元)"),
        QStringLiteral("欠费(元)"),
        QStringLiteral("结果")
    });
    m_etcRecordsTable->horizontalHeader()->setSectionResizeMode(QHeaderView::Stretch);
    m_etcRecordsTable->setEditTriggers(QAbstractItemView::NoEditTriggers);
    m_etcRecordsTable->setSelectionBehavior(QAbstractItemView::SelectRows);
    erL->addWidget(rTools);
    erL->addWidget(m_etcRecordsTable, 1);

    tabs->addTab(tabAcc, QStringLiteral("账户管理"));
    tabs->addTab(tabRec, QStringLiteral("流水查询"));

    connect(m_etcAddBtn, &QPushButton::clicked, this, [this](){
        QString p = etcPlateFromUi();
        if (p.isEmpty()) return;
        if (!m_etcAccounts.contains(p)) m_etcAccounts[p] = 0.0;
        QDateTime t = QDateTime::currentDateTimeUtc().toTimeZone(bjTz());
        EtcRecord rec;
        rec.time = t;
        rec.plate = p;
        rec.source = 0;
        rec.amount = 0.0;
        rec.balanceAfter = m_etcAccounts.value(p, 0.0);
        rec.arrearsAfter = m_etcArrears.value(p, 0.0);
        rec.result = QStringLiteral("开通");
        addEtcRecord(rec);
        settleEtcArrears(p, t, 0, QStringLiteral("开通后"));
        saveConfig();
        refreshEtcTables();
        maybeEmitBizReport(true);
    });

    connect(m_etcRechargeBtn, &QPushButton::clicked, this, [this](){
        QString p = etcPlateFromUi();
        if (p.isEmpty()) return;
        if (!m_etcAccounts.contains(p)) {
            QMessageBox::warning(this, QStringLiteral("提示"), QStringLiteral("请先开通ETC卡，再进行充值。"));
            return;
        }
        double add = m_etcRechargeAmt->value();
        if (add <= 0.0) return;
        m_etcAccounts[p] = m_etcAccounts.value(p, 0.0) + add;
        QDateTime t = QDateTime::currentDateTimeUtc().toTimeZone(bjTz());
        EtcRecord rec;
        rec.time = t;
        rec.plate = p;
        rec.source = 0;
        rec.amount = add;
        rec.balanceAfter = m_etcAccounts.value(p, 0.0);
        rec.arrearsAfter = m_etcArrears.value(p, 0.0);
        rec.result = QStringLiteral("充值");
        addEtcRecord(rec);
        settleEtcArrears(p, t, 0, QStringLiteral("充值后"));
        saveConfig();
        refreshEtcTables();
        maybeEmitBizReport(true);
    });

    connect(m_etcManualDeductBtn, &QPushButton::clicked, this, [this](){
        QString p = etcPlateFromUi();
        if (p.isEmpty()) return;
        double amt = m_etcDeductAmt->value();
        if (amt <= 0.0) return;
        double bal = m_etcAccounts.value(p, 0.0);
        double arr = m_etcArrears.value(p, 0.0);
        bool hasAcc = m_etcAccounts.contains(p);
        double need = amt;
        double use = hasAcc ? std::min(bal, need) : 0.0;
        bal -= use;
        need -= use;
        if (hasAcc) m_etcAccounts[p] = bal;
        if (need > 1e-6) m_etcArrears[p] = arr + need;
        else if (arr <= 1e-6) m_etcArrears.remove(p);

        EtcRecord rec;
        rec.time = QDateTime::currentDateTimeUtc().toTimeZone(bjTz());
        rec.plate = p;
        rec.source = 0;
        rec.amount = -amt;
        rec.balanceAfter = bal;
        rec.arrearsAfter = m_etcArrears.value(p, 0.0);
        rec.result = QStringLiteral("人工扣费");
        addEtcRecord(rec);
        saveConfig();
        refreshEtcTables();
        maybeEmitBizReport(true);
    });

    connect(m_etcCancelBtn, &QPushButton::clicked, this, [this](){
        QString p = etcPlateFromUi();
        if (p.isEmpty()) return;
        m_etcAccounts.remove(p);
        m_etcArrears.remove(p);
        EtcRecord rec;
        rec.time = QDateTime::currentDateTimeUtc().toTimeZone(bjTz());
        rec.plate = p;
        rec.source = 0;
        rec.amount = 0.0;
        rec.balanceAfter = 0.0;
        rec.arrearsAfter = 0.0;
        rec.result = QStringLiteral("销卡");
        addEtcRecord(rec);
        saveConfig();
        refreshEtcTables();
        maybeEmitBizReport(true);
    });

    connect(m_etcAccExportBtn, &QPushButton::clicked, this, [this](){
        QString base = qEnvironmentVariable("RK3568_REPORT_DIR_CSV", QDir::homePath());
        QString dir = QFileDialog::getExistingDirectory(this, QStringLiteral("选择导出目录"), base);
        if (dir.isEmpty()) return;
        QDir d(dir);
        QString name = "etc_accounts_" + QDate::currentDate().toString("yyyyMMdd") + ".csv";
        QString path = d.filePath(name);
        QFile f(path);
        if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) return;
        QTextStream ts(&f);
        ts.setCodec("UTF-8");
        ts << "plate,balance,arrears\n";
        QSet<QString> keys;
        for (auto it = m_etcAccounts.begin(); it != m_etcAccounts.end(); ++it) keys.insert(it.key());
        for (auto it = m_etcArrears.begin(); it != m_etcArrears.end(); ++it) keys.insert(it.key());
        for (const auto &k : keys) {
            ts << k << "," << QString::number(m_etcAccounts.value(k, 0.0), 'f', 2) << "," << QString::number(m_etcArrears.value(k, 0.0), 'f', 2) << "\n";
        }
        QMessageBox::information(this, QStringLiteral("导出完成"), QStringLiteral("已导出到:\n") + path);
    });

    connect(m_etcAccImportBtn, &QPushButton::clicked, this, [this](){
        QString base = qEnvironmentVariable("RK3568_REPORT_DIR_CSV", QDir::homePath());
        QString path = QFileDialog::getOpenFileName(this, QStringLiteral("选择账户报表"), base, "CSV (*.csv);;All Files (*)");
        if (path.isEmpty()) return;
        QFile f(path);
        if (!f.open(QIODevice::ReadOnly)) return;
        QTextStream ts(&f);
        ts.setCodec("UTF-8");
        int imported = 0;
        while (!ts.atEnd()) {
            QString line = ts.readLine().trimmed();
            if (line.isEmpty()) continue;
            if (line.contains("plate", Qt::CaseInsensitive) && line.contains("balance", Qt::CaseInsensitive)) continue;
            QStringList cols = line.split(',', Qt::KeepEmptyParts);
            if (cols.size() < 2) continue;
            QString plate = cols[0].trimmed();
            if (plate.isEmpty()) continue;
            bool ok1 = false, ok2 = true;
            double bal = cols[1].trimmed().toDouble(&ok1);
            double arr = 0.0;
            if (cols.size() >= 3) arr = cols[2].trimmed().toDouble(&ok2);
            if (!ok1) continue;
            m_etcAccounts[plate] = bal;
            if (ok2 && arr > 1e-6) m_etcArrears[plate] = arr;
            imported++;
        }
        saveConfig();
        refreshEtcTables();
        maybeEmitBizReport(true);
        QMessageBox::information(this, QStringLiteral("导入完成"), QStringLiteral("已导入 %1 条账户记录。").arg(imported));
    });

    connect(m_etcClearBtn, &QPushButton::clicked, this, [this](){
        m_etcRecords.clear();
        saveConfig();
        refreshEtcTables();
        maybeEmitBizReport(true);
    });

    connect(m_etcExportBtn, &QPushButton::clicked, this, [this](){
        QString base = qEnvironmentVariable("RK3568_REPORT_DIR_CSV", QDir::homePath());
        QString dir = QFileDialog::getExistingDirectory(this, QStringLiteral("选择导出目录"), base);
        if (dir.isEmpty()) return;
        QDir d(dir);
        QString name = "etc_txns_" + QDate::currentDate().toString("yyyyMMdd") + ".csv";
        QString path = d.filePath(name);
        QFile f(path);
        if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) return;
        QTextStream ts(&f);
        ts.setCodec("UTF-8");
        ts << "time,plate,source,delta,balance,arrears,result\n";
        for (const auto &r : m_etcRecords) {
            ts << r.time.toString("yyyy-MM-dd HH:mm:ss") << ","
               << r.plate << ","
               << r.source << ","
               << QString::number(r.amount, 'f', 2) << ","
               << QString::number(r.balanceAfter, 'f', 2) << ","
               << QString::number(r.arrearsAfter, 'f', 2) << ","
               << r.result << "\n";
        }
        QMessageBox::information(this, QStringLiteral("导出完成"), QStringLiteral("已导出到:\n") + path);
    });

    l->addWidget(cfg);
    l->addWidget(tabs, 1);
    return w;
}

void BusinessDialog::refreshParkingTables() {
    if (m_parkingActiveTable) {
        m_parkingActiveTable->setRowCount(m_activeCars.size());
        int row = 0;
        for (auto it = m_activeCars.begin(); it != m_activeCars.end(); ++it) {
            const QString plate = it.key();
            const ParkingActive &a = it.value();
            m_parkingActiveTable->setItem(row, 0, new QTableWidgetItem(plate));
            m_parkingActiveTable->setItem(row, 1, new QTableWidgetItem(a.entryTime.toString("yyyy-MM-dd HH:mm:ss")));
            m_parkingActiveTable->setItem(row, 2, new QTableWidgetItem(QString::number(a.entrySource)));
            m_parkingActiveTable->setItem(row, 3, new QTableWidgetItem(m_parkingAccounts.contains(plate) ? QStringLiteral("是") : QStringLiteral("否")));
            row++;
        }
    }

    if (m_parkingAccountsTable) {
        QSet<QString> keys;
        for (auto it = m_parkingAccounts.begin(); it != m_parkingAccounts.end(); ++it) keys.insert(it.key());
        for (auto it = m_parkingArrears.begin(); it != m_parkingArrears.end(); ++it) keys.insert(it.key());
        QStringList list = keys.values();
        list.sort();
        m_parkingAccountsTable->setRowCount(list.size());
        for (int i = 0; i < list.size(); ++i) {
            const QString &k = list[i];
            m_parkingAccountsTable->setItem(i, 0, new QTableWidgetItem(k));
            m_parkingAccountsTable->setItem(i, 1, new QTableWidgetItem(QString::number(m_parkingAccounts.value(k, 0.0), 'f', 2)));
            m_parkingAccountsTable->setItem(i, 2, new QTableWidgetItem(QString::number(m_parkingArrears.value(k, 0.0), 'f', 2)));
        }
    }

    if (m_parkingTxnTable) {
        m_parkingTxnTable->setRowCount(m_parkingTxns.size());
        for (int i = 0; i < m_parkingTxns.size(); ++i) {
            const ParkingTxn &r = m_parkingTxns[i];
            m_parkingTxnTable->setItem(i, 0, new QTableWidgetItem(r.time.toString("yyyy-MM-dd HH:mm:ss")));
            m_parkingTxnTable->setItem(i, 1, new QTableWidgetItem(r.plate));
            m_parkingTxnTable->setItem(i, 2, new QTableWidgetItem(QString::number(r.source)));
            m_parkingTxnTable->setItem(i, 3, new QTableWidgetItem(QString::number(r.amount, 'f', 2)));
            m_parkingTxnTable->setItem(i, 4, new QTableWidgetItem(QString::number(r.balanceAfter, 'f', 2)));
            m_parkingTxnTable->setItem(i, 5, new QTableWidgetItem(QString::number(r.arrearsAfter, 'f', 2)));
            m_parkingTxnTable->setItem(i, 6, new QTableWidgetItem(r.result));
        }
    }
}

void BusinessDialog::refreshEtcTables() {
    if (m_etcAccountsTable) {
        QSet<QString> keys;
        for (auto it = m_etcAccounts.begin(); it != m_etcAccounts.end(); ++it) keys.insert(it.key());
        for (auto it = m_etcArrears.begin(); it != m_etcArrears.end(); ++it) keys.insert(it.key());
        QStringList list = keys.values();
        list.sort();
        m_etcAccountsTable->setRowCount(list.size());
        for (int i = 0; i < list.size(); ++i) {
            const QString &k = list[i];
            m_etcAccountsTable->setItem(i, 0, new QTableWidgetItem(k));
            m_etcAccountsTable->setItem(i, 1, new QTableWidgetItem(QString::number(m_etcAccounts.value(k, 0.0), 'f', 2)));
            m_etcAccountsTable->setItem(i, 2, new QTableWidgetItem(QString::number(m_etcArrears.value(k, 0.0), 'f', 2)));
        }
    }

    if (m_etcRecordsTable) {
        m_etcRecordsTable->setRowCount(m_etcRecords.size());
        for (int i = 0; i < m_etcRecords.size(); ++i) {
            const EtcRecord &r = m_etcRecords[i];
            m_etcRecordsTable->setItem(i, 0, new QTableWidgetItem(r.time.toString("yyyy-MM-dd HH:mm:ss")));
            m_etcRecordsTable->setItem(i, 1, new QTableWidgetItem(r.plate));
            m_etcRecordsTable->setItem(i, 2, new QTableWidgetItem(QString::number(r.source)));
            m_etcRecordsTable->setItem(i, 3, new QTableWidgetItem(QString::number(r.amount, 'f', 2)));
            m_etcRecordsTable->setItem(i, 4, new QTableWidgetItem(QString::number(r.balanceAfter, 'f', 2)));
            m_etcRecordsTable->setItem(i, 5, new QTableWidgetItem(QString::number(r.arrearsAfter, 'f', 2)));
            m_etcRecordsTable->setItem(i, 6, new QTableWidgetItem(r.result));
        }
    }
}

void BusinessDialog::applyParkingConfigFromUi() {
    m_parkingCfg.freeMinutes = m_freeMinutes->value();
    m_parkingCfg.mode = m_parkingModeBox->currentIndex() == 1 ? ParkingBillingMode::Custom : ParkingBillingMode::Hourly;
    m_parkingCfg.rounding = m_parkingRoundingBox->currentIndex() == 1 ? ParkingRoundingPolicy::Truncate : ParkingRoundingPolicy::RoundUp;
    m_parkingCfg.pricePerHour = m_pricePerHour->value();
    m_parkingCfg.unitMinutes = m_unitMinutes->value();
    m_parkingCfg.pricePerUnit = m_pricePerUnit->value();
    saveConfig();
}

void BusinessDialog::applyEtcConfigFromUi() {
    m_etcCfg.tollYuan = m_etcToll->value();
    saveConfig();
}

void BusinessDialog::updateParkingModeUi() {
    if (!m_hourlyCfgWidget || !m_customCfgWidget || !m_parkingModeBox) return;
    bool isCustom = (m_parkingModeBox->currentIndex() == 1);
    m_customCfgWidget->setVisible(isCustom);
    m_hourlyCfgWidget->setVisible(!isCustom);
}

void BusinessDialog::addParkingRecord(const ParkingRecord &r) {
    m_parkingRecords.push_front(r);
    while (m_parkingRecords.size() > 500) m_parkingRecords.removeLast();
}

void BusinessDialog::addParkingTxn(const ParkingTxn &r) {
    m_parkingTxns.push_front(r);
    while (m_parkingTxns.size() > 500) m_parkingTxns.removeLast();
}

void BusinessDialog::addEtcRecord(const EtcRecord &r) {
    m_etcRecords.push_front(r);
    while (m_etcRecords.size() > 500) m_etcRecords.removeLast();
}

QString BusinessDialog::etcPlateFromUi() const {
    if (!m_etcPlateEdit) return QString();
    QString rest = m_etcPlateEdit->text().trimmed();
    if (!m_etcProvBox) return rest;
    QString prov = m_etcProvBox->currentText().trimmed();
    if (prov.isEmpty() || prov == QStringLiteral("省份")) return rest;
    if (rest.startsWith(prov)) return rest;
    return prov + rest;
}

QString BusinessDialog::parkingPlateFromUi() const {
    if (!m_parkingPlateEdit) return QString();
    QString rest = m_parkingPlateEdit->text().trimmed();
    if (!m_parkingProvBox) return rest;
    QString prov = m_parkingProvBox->currentText().trimmed();
    if (prov.isEmpty() || prov == QStringLiteral("省份")) return rest;
    if (rest.startsWith(prov)) return rest;
    return prov + rest;
}

void BusinessDialog::settleEtcArrears(const QString &plate, const QDateTime &t, int source, const QString &reason) {
    double bal = m_etcAccounts.value(plate, 0.0);
    double arr = m_etcArrears.value(plate, 0.0);
    if (bal <= 1e-6 || arr <= 1e-6) return;
    double pay = std::min(bal, arr);
    bal -= pay;
    arr -= pay;
    m_etcAccounts[plate] = bal;
    if (arr <= 1e-6) m_etcArrears.remove(plate);
    else m_etcArrears[plate] = arr;

    EtcRecord rec;
    rec.time = t;
    rec.plate = plate;
    rec.source = source;
    rec.amount = -pay;
    rec.balanceAfter = bal;
    rec.arrearsAfter = arr;
    rec.result = QStringLiteral("%1自动补缴%2元").arg(reason).arg(pay, 0, 'f', 2);
    addEtcRecord(rec);
}

void BusinessDialog::settleParkingArrears(const QString &plate, const QDateTime &t, int source, const QString &reason) {
    double bal = m_parkingAccounts.value(plate, 0.0);
    double arr = m_parkingArrears.value(plate, 0.0);
    if (bal <= 1e-6 || arr <= 1e-6) return;
    double pay = std::min(bal, arr);
    bal -= pay;
    arr -= pay;
    m_parkingAccounts[plate] = bal;
    if (arr <= 1e-6) m_parkingArrears.remove(plate);
    else m_parkingArrears[plate] = arr;

    ParkingTxn rec;
    rec.time = t;
    rec.plate = plate;
    rec.source = source;
    rec.amount = -pay;
    rec.balanceAfter = bal;
    rec.arrearsAfter = arr;
    rec.result = QStringLiteral("%1自动补缴%2元").arg(reason).arg(pay, 0, 'f', 2);
    addParkingTxn(rec);
}

