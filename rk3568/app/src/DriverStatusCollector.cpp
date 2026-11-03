#include "DriverStatusCollector.h"

#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QFileDevice>
#include <QFileInfo>
#include <QJsonArray>
#include <QMutex>
#include <QMutexLocker>
#include <QRegularExpression>
#include <QStringList>
#include <QVector>
#include <algorithm>

namespace {
QMutex g_captureMetricsMutex;
DriverCaptureMetrics g_captureMetrics;
}

void updateDriverCaptureMetrics(const DriverCaptureMetrics &metrics) {
    QMutexLocker locker(&g_captureMetricsMutex);
    g_captureMetrics = metrics;
}

DriverCaptureMetrics currentDriverCaptureMetrics() {
    QMutexLocker locker(&g_captureMetricsMutex);
    return g_captureMetrics;
}

static QString readTextFile(const QString &path, int maxBytes = 256 * 1024) {
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) return QString();
    return QString::fromUtf8(f.read(maxBytes));
}

static QString oneLine(const QString &s) {
    QString t = s;
    t.replace("\r", "");
    t.replace("\n", " ");
    t = t.trimmed();
    while (t.contains("  ")) t.replace("  ", " ");
    return t;
}

static QString nonEmpty(const QString &s, const QString &fallback = "N/A") {
    QString t = oneLine(s);
    return t.isEmpty() ? fallback : t;
}

static qlonglong parseInteger(const QString &raw, bool *okOut = nullptr) {
    bool ok = false;
    const qlonglong v = raw.trimmed().toLongLong(&ok);
    if (okOut) *okOut = ok;
    return ok ? v : 0;
}

static QString formatKHz(const QString &raw) {
    bool ok = false;
    qlonglong khz = parseInteger(raw, &ok);
    if (!ok || khz <= 0) return raw.trimmed().isEmpty() ? "N/A" : raw.trimmed();
    return QString("%1 MHz").arg(khz / 1000.0, 0, 'f', 0);
}

static QString formatHz(const QString &raw) {
    bool ok = false;
    qlonglong hz = parseInteger(raw, &ok);
    if (!ok || hz <= 0) return raw.trimmed().isEmpty() ? "N/A" : raw.trimmed();
    return QString("%1 MHz").arg(hz / 1000000.0, 0, 'f', 0);
}

static QString permissionString(const QFileInfo &info) {
    QString perm;
    perm += info.permission(QFileDevice::ReadUser) ? "r" : "-";
    perm += info.permission(QFileDevice::WriteUser) ? "w" : "-";
    perm += info.permission(QFileDevice::ExeUser) ? "x" : "-";
    perm += info.permission(QFileDevice::ReadGroup) ? "r" : "-";
    perm += info.permission(QFileDevice::WriteGroup) ? "w" : "-";
    perm += info.permission(QFileDevice::ExeGroup) ? "x" : "-";
    perm += info.permission(QFileDevice::ReadOther) ? "r" : "-";
    perm += info.permission(QFileDevice::WriteOther) ? "w" : "-";
    perm += info.permission(QFileDevice::ExeOther) ? "x" : "-";
    return perm;
}

static void addRow(DriverStatusSnapshot &snap, const QString &group, const QString &item,
                   const QString &value, const QString &detail = QString()) {
    snap.rows.push_back({group, item, value, detail});
}

static void addJsonRow(QJsonArray &rows, const QString &group, const QString &item,
                       const QString &value, const QString &detail = QString()) {
    QJsonObject row;
    row.insert("category", group);
    row.insert("item", item);
    row.insert("value", value);
    row.insert("detail", detail);
    rows.append(row);
}

struct CpuTimes {
    quint64 total = 0;
    quint64 idle = 0;
    bool valid = false;
};

static CpuTimes readCpuTimes() {
    CpuTimes out;
    const QString stat = readTextFile("/proc/stat", 8192);
    for (QString line : stat.split('\n')) {
        if (!line.startsWith("cpu ")) continue;
        line.replace('\t', ' ');
        const QStringList toks = line.split(' ', Qt::SkipEmptyParts);
        if (toks.size() < 5) return out;

        QVector<quint64> vals;
        for (int i = 1; i < toks.size(); ++i) {
            bool ok = false;
            quint64 v = toks[i].toULongLong(&ok);
            if (!ok) break;
            vals.push_back(v);
        }
        if (vals.size() < 4) return out;

        quint64 total = 0;
        for (quint64 v : vals) total += v;
        out.total = total;
        out.idle = vals[3] + (vals.size() > 4 ? vals[4] : 0);
        out.valid = true;
        return out;
    }
    return out;
}

static QStringList collectCpuPolicies() {
    QStringList paths;
    QDir base("/sys/devices/system/cpu/cpufreq");
    if (!base.exists()) return paths;
    const QStringList policies = base.entryList(QStringList() << "policy*", QDir::Dirs | QDir::NoDotAndDotDot, QDir::Name);
    for (const QString &policy : policies) paths << base.filePath(policy);
    return paths;
}

static QStringList devfreqPaths(const QStringList &keywords) {
    QStringList paths;
    QDir base("/sys/class/devfreq");
    if (!base.exists()) return paths;

    const QFileInfoList infos = base.entryInfoList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::System, QDir::Name);
    for (const QFileInfo &fi : infos) {
        if (!fi.isDir() && !fi.isSymLink()) continue;

        const QString path = fi.absoluteFilePath();
        QString name = readTextFile(path + "/name", 4096).trimmed();
        if (name.isEmpty()) name = fi.fileName();
        const QString hay = (fi.fileName() + " " + name).toLower();

        bool match = false;
        for (const QString &kw : keywords) {
            if (hay.contains(kw.toLower())) {
                match = true;
                break;
            }
        }
        if (match) paths << path;
    }
    paths.removeDuplicates();
    paths.sort();
    return paths;
}

static QString devfreqName(const QString &path) {
    QString name = readTextFile(path + "/name", 4096).trimmed();
    if (name.isEmpty()) name = QFileInfo(path).fileName();
    return name;
}

static bool readUnsigned(const QString &path, qulonglong &value) {
    bool ok = false;
    value = readTextFile(path, 4096).trimmed().toULongLong(&ok);
    return ok;
}

struct UsageValue {
    QString text = "N/A";
    bool hasPercent = false;
    double percent = 0.0;
    QString raw;
};

static UsageValue parseLoadValue(const QString &raw) {
    UsageValue out;
    const QString compact = oneLine(raw);
    out.raw = compact;
    if (compact.isEmpty()) return out;

    QRegularExpression percentRe("([0-9]+(?:\\.[0-9]+)?)\\s*%");
    QRegularExpressionMatchIterator pit = percentRe.globalMatch(compact);
    double pctSum = 0.0;
    int pctCount = 0;
    while (pit.hasNext()) {
        bool ok = false;
        double v = pit.next().captured(1).toDouble(&ok);
        if (ok) {
            pctSum += v;
            ++pctCount;
        }
    }
    if (pctCount > 0) {
        out.hasPercent = true;
        out.percent = pctSum / pctCount;
        out.text = QString("%1%").arg(out.percent, 0, 'f', 1);
        if (pctCount > 1) out.text += QString("  raw: %1").arg(compact);
        return out;
    }

    QRegularExpression numberRe("(-?[0-9]+(?:\\.[0-9]+)?)");
    QRegularExpressionMatch m = numberRe.match(compact);
    if (m.hasMatch()) {
        bool ok = false;
        double v = m.captured(1).toDouble(&ok);
        if (ok && v >= 0.0) {
            if (v <= 100.0) {
                out.percent = v;
                out.text = QString("%1%").arg(out.percent, 0, 'f', 1);
            } else if (v <= 1000.0) {
                out.percent = v / 10.0;
                out.text = QString("%1%  raw: %2").arg(out.percent, 0, 'f', 1).arg(compact);
            } else if (v <= 10000.0) {
                out.percent = v / 100.0;
                out.text = QString("%1%  raw: %2").arg(out.percent, 0, 'f', 1).arg(compact);
            } else {
                out.text = compact;
                return out;
            }
            out.hasPercent = true;
            return out;
        }
    }

    out.text = compact;
    return out;
}

static UsageValue cpuUsageValue(DriverStatusCollectorState *state, quint64 total, quint64 idle) {
    UsageValue out;
    out.text = "采样中";
    if (!state) return out;
    if (state->lastCpuTotal > 0 && total > state->lastCpuTotal && idle >= state->lastCpuIdle) {
        const quint64 totalDelta = total - state->lastCpuTotal;
        const quint64 idleDelta = idle - state->lastCpuIdle;
        if (totalDelta > 0 && idleDelta <= totalDelta) {
            out.percent = 100.0 * double(totalDelta - idleDelta) / double(totalDelta);
            out.hasPercent = true;
            out.text = QString("%1%").arg(out.percent, 0, 'f', 1);
        }
    }
    state->lastCpuTotal = total;
    state->lastCpuIdle = idle;
    return out;
}

static UsageValue devfreqUsageValue(const QString &path, DriverStatusCollectorState *state) {
    const UsageValue load = parseLoadValue(readTextFile(path + "/load", 4096));
    if (!load.raw.isEmpty()) return load;

    UsageValue out;
    qulonglong busy = 0;
    qulonglong total = 0;
    if (!readUnsigned(path + "/busy_time", busy) || !readUnsigned(path + "/total_time", total) || total == 0) {
        return out;
    }

    out.text = "采样中";
    if (!state) return out;

    const QPair<qulonglong, qulonglong> last = state->lastDevfreqUsage.value(path);
    if (last.second > 0 && total > last.second && busy >= last.first) {
        const qulonglong busyDelta = busy - last.first;
        const qulonglong totalDelta = total - last.second;
        if (totalDelta > 0 && busyDelta <= totalDelta) {
            out.percent = 100.0 * double(busyDelta) / double(totalDelta);
            out.hasPercent = true;
            out.text = QString("%1%").arg(out.percent, 0, 'f', 1);
        }
    }
    state->lastDevfreqUsage.insert(path, qMakePair(busy, total));
    return out;
}

static QStringList listBoundPciDevices(const QString &driverName) {
    QString dirPath = QString("/sys/bus/pci/drivers/%1").arg(driverName);
    QDir d(dirPath);
    if (!d.exists()) return {};
    QStringList out;
    QFileInfoList infos = d.entryInfoList(QDir::Dirs | QDir::NoDotAndDotDot | QDir::System);
    for (const auto &fi : infos) {
        QString n = fi.fileName();
        if (n.contains(':') && n.contains('.')) out << n;
    }
    out.sort();
    return out;
}

static QString sysfsDevicePath(const QString &deviceBdf) {
    QString p0 = QString("/sys/bus/pci/devices/%1").arg(deviceBdf);
    if (QFileInfo::exists(p0)) return p0;
    QString p1 = QString("/sys/bus/pci/devices/0000:%1").arg(deviceBdf);
    if (QFileInfo::exists(p1)) return p1;
    return QString();
}

static QString readSysfs(const QString &deviceBdf, const QString &file) {
    const QString devPath = sysfsDevicePath(deviceBdf);
    if (devPath.isEmpty()) return QString();
    QString base = QString("%1/%2").arg(devPath, file);
    if (QFileInfo::exists(base)) {
        QString v = readTextFile(base, 4096).trimmed();
        if (!v.isEmpty()) return v;
    }
    return QString();
}

static QByteArray readSysfsBin(const QString &deviceBdf, const QString &file, int maxBytes = 4096) {
    const QString devPath = sysfsDevicePath(deviceBdf);
    if (devPath.isEmpty()) return {};
    QString base = QString("%1/%2").arg(devPath, file);
    if (QFileInfo::exists(base)) {
        QFile f(base);
        if (f.open(QIODevice::ReadOnly)) return f.read(maxBytes);
    }
    return {};
}

static inline quint16 le16(const QByteArray& b, int off) {
    if (off + 1 >= b.size()) return 0;
    return (quint16)((quint8)b[off] | ((quint16)((quint8)b[off + 1]) << 8));
}

static int mpsBytes(int mps) {
    return 128 << std::max(0, std::min(5, mps));
}

static QString bytesText(int bytes) {
    return QString("%1B").arg(bytes);
}

static int findCapOffset(const QByteArray& cfg, int capId) {
    if (cfg.size() < 0x40) return 0;
    int ptr = (int)(quint8)cfg[0x34];
    ptr &= ~3;
    int guard = 0;
    while (ptr >= 0x40 && ptr + 1 < cfg.size() && guard++ < 48) {
        int id = (int)(quint8)cfg[ptr];
        int next = (int)(quint8)cfg[ptr + 1];
        next &= ~3;
        if (id == capId) return ptr;
        if (next == 0 || next == ptr) break;
        ptr = next;
    }
    return 0;
}

struct PcieCaps {
    bool hasPcie = false;
    int mpsBytes = 0;
    int mrrsBytes = 0;
    bool hasMsi = false;
    bool msiEnabled = false;
    int msiMmc = 0;
    int msiMme = 0;
};

static PcieCaps readPcieCaps(const QString& bdf) {
    PcieCaps out;
    QByteArray cfg = readSysfsBin(bdf, "config", 512);
    if (cfg.isEmpty()) return out;

    int pcieOff = findCapOffset(cfg, 0x10);
    if (pcieOff > 0) {
        quint16 devCtl = le16(cfg, pcieOff + 0x08);
        int mps = (devCtl >> 5) & 0x7;
        int mrrs = (devCtl >> 12) & 0x7;
        out.hasPcie = true;
        out.mpsBytes = mpsBytes(mps);
        out.mrrsBytes = mpsBytes(mrrs);
    }

    int msiOff = findCapOffset(cfg, 0x05);
    if (msiOff > 0) {
        quint16 msgCtl = le16(cfg, msiOff + 0x02);
        out.hasMsi = true;
        out.msiEnabled = (msgCtl & 0x0001) != 0;
        out.msiMmc = (msgCtl >> 1) & 0x7;
        out.msiMme = (msgCtl >> 4) & 0x7;
    }
    return out;
}

static qint64 parseIrqSum(const QString& intrLine) {
    if (intrLine.isEmpty()) return -1;
    QString s = intrLine;
    s.replace("\t", " ");
    QStringList toks = s.split(' ', Qt::SkipEmptyParts);
    qint64 sum = 0;
    for (int i = 1; i < toks.size(); ++i) {
        bool ok = false;
        qlonglong v = toks[i].toLongLong(&ok);
        if (!ok) break;
        sum += v;
    }
    return sum;
}

struct IrqParsed {
    int irq = -1;
    QVector<qint64> perCpu;
    QString controller;
    QString hwirq;
    QString trigger;
    QString name;
};

static IrqParsed parseInterruptLine(const QString& intrLine) {
    IrqParsed out;
    if (intrLine.isEmpty()) return out;
    QString s = intrLine;
    s.replace("\t", " ");
    QStringList toks = s.split(' ', Qt::SkipEmptyParts);
    if (toks.isEmpty()) return out;
    QString t0 = toks[0];
    if (t0.endsWith(':')) t0.chop(1);
    out.irq = t0.toInt();

    int i = 1;
    for (; i < toks.size(); ++i) {
        bool ok = false;
        qlonglong v = toks[i].toLongLong(&ok);
        if (!ok) break;
        out.perCpu.push_back(v);
    }
    if (i < toks.size()) out.controller = toks[i++];
    if (i < toks.size()) out.hwirq = toks[i++];
    if (i < toks.size()) out.trigger = toks[i++];
    if (i < toks.size()) out.name = toks.mid(i).join(' ');
    return out;
}

static QJsonObject devfreqJson(const QString &path, const QString &kind, DriverStatusCollectorState *state,
                               DriverStatusSnapshot &snap, QJsonArray &rows) {
    const QString name = devfreqName(path);
    const QString gov = nonEmpty(readTextFile(path + "/governor", 4096));
    const QString curRaw = readTextFile(path + "/cur_freq", 4096).trimmed();
    bool freqOk = false;
    const qlonglong curHz = parseInteger(curRaw, &freqOk);
    const UsageValue usage = devfreqUsageValue(path, state);

    QJsonObject o;
    o.insert("name", name);
    o.insert("sysfs", path);
    o.insert("governor", gov);
    if (freqOk) {
        o.insert("cur_freq_hz", double(curHz));
        o.insert("cur_freq_mhz", curHz / 1000000.0);
    }
    o.insert("cur_freq_text", formatHz(curRaw));
    o.insert("usage_text", usage.text);
    if (usage.hasPercent) o.insert("usage_percent", usage.percent);
    if (!usage.raw.isEmpty()) o.insert("load_raw", usage.raw);

    const QString group = kind.toUpper();
    addRow(snap, group, name + " 当前频率", formatHz(curRaw), QString("governor=%1  sysfs=%2").arg(gov, path));
    addJsonRow(rows, group, name + " 当前频率", formatHz(curRaw), QString("governor=%1  sysfs=%2").arg(gov, path));
    addRow(snap, group, name + " 运行占比", usage.text, QString("sysfs=%1").arg(path));
    addJsonRow(rows, group, name + " 运行占比", usage.text, QString("sysfs=%1").arg(path));
    return o;
}

DriverStatusSnapshot collectDriverStatus(DriverStatusCollectorState *state) {
    DriverStatusSnapshot snap;
    QJsonArray rows;

    const QString devName = "pango_pci_driver";
    const QString devPath = "/dev/pango_pci_driver";
    const QDateTime now = QDateTime::currentDateTime();

    QJsonObject root;
    root.insert("schema", "rk3568_driver_status_v1");
    root.insert("time_local", now.toString("yyyy-MM-dd HH:mm:ss"));
    root.insert("module_name", devName);

    const QString meminfo = readTextFile("/proc/meminfo", 64 * 1024);
    const auto meminfoKb = [&meminfo](const QString &name) -> qlonglong {
        const QRegularExpression re(QString("^%1:\\s+(\\d+)\\s+kB")
                                        .arg(QRegularExpression::escape(name)),
                                    QRegularExpression::MultilineOption);
        const QRegularExpressionMatch match = re.match(meminfo);
        if (!match.hasMatch()) return -1;
        bool ok = false;
        const qlonglong value = match.captured(1).toLongLong(&ok);
        return ok ? value : -1;
    };
    const qlonglong cmaTotalKb = meminfoKb("CmaTotal");
    const qlonglong cmaFreeKb = meminfoKb("CmaFree");
    const QString kernelCmdline = oneLine(readTextFile("/proc/cmdline", 16 * 1024));
    constexpr qlonglong kCmaMinimumKb = 64 * 1024;
    constexpr qlonglong kCmaRecommendedKb = 128 * 1024;
    QJsonObject dmaMemoryJson;
    dmaMemoryJson.insert("cma_total_kb", static_cast<double>(cmaTotalKb));
    dmaMemoryJson.insert("cma_free_kb", static_cast<double>(cmaFreeKb));
    dmaMemoryJson.insert("cma_minimum_kb", static_cast<double>(kCmaMinimumKb));
    dmaMemoryJson.insert("cma_recommended_kb", static_cast<double>(kCmaRecommendedKb));
    dmaMemoryJson.insert("cma_sufficient", cmaTotalKb >= kCmaMinimumKb);
    dmaMemoryJson.insert("cma_recommended", cmaTotalKb >= kCmaRecommendedKb);
    dmaMemoryJson.insert("kernel_cmdline", kernelCmdline);
    root.insert("dma_memory", dmaMemoryJson);

    const DriverCaptureMetrics capture = currentDriverCaptureMetrics();
    QJsonObject captureJson;
    captureJson.insert("running", capture.running);
    captureJson.insert("pcie", capture.pcie);
    captureJson.insert("metric_valid", capture.metricValid);
    captureJson.insert("mode", capture.mode);
    captureJson.insert("protocol", capture.protocol);
    captureJson.insert("driver_abi_version", static_cast<double>(capture.driverAbiVersion));
    captureJson.insert("driver_abi_hex", QString("0x%1").arg(
        capture.driverAbiVersion, 8, 16, QLatin1Char('0')));
    captureJson.insert("driver_features", static_cast<double>(capture.driverFeatures));
    captureJson.insert("driver_features_hex", QString("0x%1").arg(
        capture.driverFeatures, 8, 16, QLatin1Char('0')));
    captureJson.insert("fpga_protocol_version", static_cast<double>(capture.fpgaProtocolVersion));
    captureJson.insert("fpga_protocol_hex", QString("0x%1").arg(
        capture.fpgaProtocolVersion, 8, 16, QLatin1Char('0')));
    captureJson.insert("fpga_capabilities", static_cast<double>(capture.fpgaCapabilities));
    captureJson.insert("fpga_capabilities_hex", QString("0x%1").arg(
        capture.fpgaCapabilities, 8, 16, QLatin1Char('0')));
    captureJson.insert("target_fps_milli", static_cast<double>(capture.targetFpsMilli));
    captureJson.insert("fpga_target_fps_milli", static_cast<double>(capture.fpgaTargetFpsMilli));
    captureJson.insert("bar0_read_bytes", static_cast<double>(capture.readBarBytes));
    captureJson.insert("bar1_write_bytes", static_cast<double>(capture.writeBarBytes));
    captureJson.insert("bar_contract_ok",
                       capture.readBarBytes >= 0x2c0u && capture.writeBarBytes >= 0x2c0u);
    captureJson.insert("interrupt_mode", capture.irqMode);
    captureJson.insert("source_mask", static_cast<double>(capture.sourceMask));
    captureJson.insert("source_mask_hex", QString("0x%1").arg(
        capture.sourceMask, 8, 16, QLatin1Char('0')));
    captureJson.insert("all_four_sources_valid", capture.sourceMask == 0x0fu);
    captureJson.insert("fpga_build_id", static_cast<double>(capture.fpgaBuildId));
    captureJson.insert("fpga_build_id_hex", QString("0x%1").arg(
        capture.fpgaBuildId, 8, 16, QLatin1Char('0')));
    captureJson.insert("fpga_debug_state_hex", QString("0x%1").arg(
        capture.fpgaDebugState, 8, 16, QLatin1Char('0')));
    captureJson.insert("fifo_level_01_hex", QString("0x%1").arg(
        capture.fifoLevel01, 8, 16, QLatin1Char('0')));
    captureJson.insert("fifo_level_23_hex", QString("0x%1").arg(
        capture.fifoLevel23, 8, 16, QLatin1Char('0')));
    captureJson.insert("fpga_handshake_state_hex", QString("0x%1").arg(
        capture.fpgaHandshakeState, 8, 16, QLatin1Char('0')));
    captureJson.insert("rate_control_supported", capture.rateControlSupported);
    captureJson.insert("fixed_30fps_active", capture.fixed30FpsActive);
    captureJson.insert("v1_fallback_allowed", capture.v1FallbackAllowed);
    captureJson.insert("v1_fallback_active", capture.v1FallbackActive);
    captureJson.insert("source_locked", capture.sourceLocked);
    captureJson.insert("recovery_count", static_cast<double>(capture.recoveryCount));
    captureJson.insert("consecutive_timeouts", capture.consecutiveTimeouts);
    captureJson.insert("recovery_state", capture.recoveryState);
    captureJson.insert("metric_basis", capture.frameV2
        ? "fpga_sof_sequence" : "complete_frame_delivery");
    captureJson.insert("frames_total", static_cast<double>(capture.framesTotal));
    captureJson.insert("dropped_frames", static_cast<double>(capture.droppedFrames));
    captureJson.insert("fpga_dropped_frames", static_cast<double>(capture.fpgaDroppedFrames));
    captureJson.insert("host_dropped_frames", static_cast<double>(capture.hostDroppedFrames));
    captureJson.insert("sequence_gaps", static_cast<double>(capture.sequenceGaps));
    captureJson.insert("protocol_errors", static_cast<double>(capture.protocolErrors));
    captureJson.insert("actual_rx_fps", capture.actualRxFps);
    captureJson.insert("frame_interval_ms", capture.frameIntervalMs);
    captureJson.insert("last_capture_ms", capture.lastCaptureMs);
    captureJson.insert("last_capture_basis", capture.frameV2
        ? "dqbuf_wait" : capture.pcie ? "dma_total" : "source_read");
    captureJson.insert("dma_wait_ms", capture.dmaWaitMs);
    captureJson.insert("dma_transfer_ms", capture.dmaTransferMs);
    captureJson.insert("kernel_staging_ms", capture.kernelStagingMs);
    captureJson.insert("user_copy_ms", capture.userCopyMs);
    captureJson.insert("dma_unit_bytes", capture.dmaUnitBytes);
    captureJson.insert("dma_unit_count", capture.dmaUnitCount);
    captureJson.insert("batch_ioctl", capture.batchIoctl);
    captureJson.insert("irq_wait", capture.irqWait);
    captureJson.insert("staged_copy", capture.stagedCopy);
    captureJson.insert("frame_v2", capture.frameV2);
    captureJson.insert("mmap_enabled", capture.mmapEnabled);
    captureJson.insert("frame_width", capture.frameWidth);
    captureJson.insert("frame_height", capture.frameHeight);
    captureJson.insert("frame_stride_bytes", capture.frameStrideBytes);
    captureJson.insert("frame_bytes", capture.frameBytes);
    captureJson.insert("ring_count", capture.ringCount);
    if (!capture.lastError.isEmpty()) captureJson.insert("last_error", capture.lastError);
    if (!capture.batchFallbackReason.isEmpty()) {
        captureJson.insert("batch_fallback_reason", capture.batchFallbackReason);
    }
    if (!capture.irqFallbackReason.isEmpty()) {
        captureJson.insert("irq_fallback_reason", capture.irqFallbackReason);
    }
    if (capture.lastFrameAt.isValid()) {
        captureJson.insert("last_frame_at", capture.lastFrameAt.toString("yyyy-MM-dd HH:mm:ss.zzz"));
    }
    root.insert("capture_metrics", captureJson);

    const QString targetFpsText = capture.targetFpsMilli > 0
        ? QString("%1 FPS").arg(capture.targetFpsMilli / 1000.0, 0, 'f', 3)
        : QStringLiteral("N/A");
    const QString fixedRateText = !capture.pcie
        ? QStringLiteral("N/A")
        : !capture.frameV2
            ? QStringLiteral("V1模式")
            : capture.fixed30FpsActive
                ? QStringLiteral("已生效")
                : capture.rateControlSupported
                    ? QStringLiteral("未运行") : QStringLiteral("固定30FPS不可用");
    const QString protocolValue = capture.protocol.isEmpty()
        ? QStringLiteral("N/A") : capture.protocol;
    const QString protocolDetail = capture.frameV2
        ? QString(
            "目标=%1，FPGA寄存器=%2 milli-FPS，固定帧率=%3，driver ABI=0x%4，FPGA=0x%5，caps=0x%6")
            .arg(targetFpsText)
            .arg(capture.fpgaTargetFpsMilli)
            .arg(fixedRateText)
            .arg(capture.driverAbiVersion, 8, 16, QLatin1Char('0'))
            .arg(capture.fpgaProtocolVersion, 8, 16, QLatin1Char('0'))
            .arg(capture.fpgaCapabilities, 8, 16, QLatin1Char('0'))
        : QString(
            "V1 DMA；目标=%1；V2 driver ABI/FPGA/caps 不适用（未执行 V2 能力查询）")
            .arg(targetFpsText);
    addRow(snap, "实时采集", "协议 / 固定30FPS", protocolValue, protocolDetail);
    addJsonRow(rows, "实时采集", "协议 / 固定30FPS", protocolValue, protocolDetail);

    const QString sourceValue = capture.frameV2
        ? (capture.sourceLocked ? QStringLiteral("已锁定") : QStringLiteral("未锁定"))
        : QStringLiteral("N/A");
    const QString recoveryDetail = QString("状态=%1，恢复次数=%2，连续超时=%3，V1回退=%4")
        .arg(capture.recoveryState.isEmpty() ? QStringLiteral("N/A") : capture.recoveryState)
        .arg(capture.recoveryCount)
        .arg(capture.consecutiveTimeouts)
        .arg(capture.v1FallbackActive ? QStringLiteral("已启用")
                                      : capture.v1FallbackAllowed ? QStringLiteral("允许但未启用")
                                                                  : QStringLiteral("禁止"));
    addRow(snap, "实时采集", "输入源 / 自动恢复", sourceValue, recoveryDetail);
    addJsonRow(rows, "实时采集", "输入源 / 自动恢复", sourceValue, recoveryDetail);

    const QString receiveBasis = capture.frameV2
        ? QStringLiteral("由 FPGA 帧序号和 SOF 时间戳计算，不是推理 FPS")
        : QStringLiteral("仅统计应用收到的完整帧，不是推理 FPS");
    addRow(snap, "实时采集", "PCIe 实际收帧率",
           capture.metricValid ? QString("%1 FPS").arg(capture.actualRxFps, 0, 'f', 2) : "N/A",
           receiveBasis);
    addJsonRow(rows, "实时采集", "PCIe 实际收帧率",
               capture.metricValid ? QString("%1 FPS").arg(capture.actualRxFps, 0, 'f', 2) : "N/A",
               receiveBasis);
    addRow(snap, "实时采集", "实际帧间隔",
           capture.metricValid ? QString("%1 ms").arg(capture.frameIntervalMs, 0, 'f', 2) : "N/A",
           capture.frameV2 ? "基于 FPGA SOF 时间戳及帧序号差分" :
                             "基于完整帧完成时间的单调时钟差分");
    addJsonRow(rows, "实时采集", "实际帧间隔",
               capture.metricValid ? QString("%1 ms").arg(capture.frameIntervalMs, 0, 'f', 2) : "N/A",
               capture.frameV2 ? "基于 FPGA SOF 时间戳及帧序号差分" :
                                 "基于完整帧完成时间的单调时钟差分");
    if (capture.frameV2) {
        const QString layout = QString("%1x%2 RGB565，stride=%3B，frame=%4B")
            .arg(capture.frameWidth).arg(capture.frameHeight)
            .arg(capture.frameStrideBytes).arg(capture.frameBytes);
        const QString detail = QString("V2 mmap=%1，ring=%2，物理布局=2x2，source_mask=0x%3")
            .arg(capture.mmapEnabled ? "是" : "否").arg(capture.ringCount)
            .arg(capture.sourceMask, 1, 16);
        addRow(snap, "实时采集", "V2 帧格式", layout, detail);
        addJsonRow(rows, "实时采集", "V2 帧格式", layout, detail);

        const QString barValue = QString("BAR0 %1B / BAR1 %2B / %3")
            .arg(capture.readBarBytes).arg(capture.writeBarBytes)
            .arg(capture.irqMode.isEmpty() ? QStringLiteral("unknown") : capture.irqMode);
        const QString barDetail = QStringLiteral(
            "寄存器读取固定走 BAR0，配置与控制写入固定走 BAR1；两侧至少覆盖 0x000~0x2BF");
        addRow(snap, "实时采集", "V2 BAR / 中断", barValue, barDetail);
        addJsonRow(rows, "实时采集", "V2 BAR / 中断", barValue, barDetail);
    }
    const QString timingItem = capture.frameV2
        ? QStringLiteral("源帧间隔/DQ 等待/用户拷贝")
        : QStringLiteral("最近 DMA/等待/拼帧/用户拷贝");
    const QString timingValue = !capture.metricValid ? QStringLiteral("N/A")
        : capture.frameV2
            ? QString("%1 / %2 / %3 ms")
                  .arg(capture.frameIntervalMs, 0, 'f', 2)
                  .arg(capture.dmaWaitMs, 0, 'f', 2)
                  .arg(capture.userCopyMs, 0, 'f', 2)
            : QString("%1 / %2 / %3 / %4 ms")
                  .arg(capture.dmaTransferMs, 0, 'f', 2)
                  .arg(capture.dmaWaitMs, 0, 'f', 2)
                  .arg(capture.kernelStagingMs, 0, 'f', 2)
                  .arg(capture.userCopyMs, 0, 'f', 2);
    const QString timingDetail = capture.frameV2
        ? QStringLiteral("V2 DMA 异步完成，不伪造 DMA 时长；依次为 SOF 帧周期 / DQBUF 阻塞 / raw copy_to_user")
        : QStringLiteral("顺序为 DMA 总耗时 / 等待耗时 / 内核整帧暂存 memcpy / copy_to_user 耗时");
    addRow(snap, "实时采集", timingItem, timingValue, timingDetail);
    addJsonRow(rows, "实时采集", timingItem, timingValue, timingDetail);

    QString fallbackDetail;
    if (!capture.batchFallbackReason.isEmpty()) {
        fallbackDetail += "batch: " + capture.batchFallbackReason;
    }
    if (!capture.irqFallbackReason.isEmpty()) {
        if (!fallbackDetail.isEmpty()) fallbackDetail += "；";
        fallbackDetail += "IRQ: " + capture.irqFallbackReason;
    }
    if (fallbackDetail.isEmpty()) fallbackDetail = QStringLiteral("无回退");
    const QString optimizationValue = capture.frameV2
        ? QString("V2 mmap=%1，ring=%2，IRQ DQ=%3")
              .arg(capture.mmapEnabled ? "是" : "否")
              .arg(capture.ringCount)
              .arg(capture.irqWait ? "是" : "否")
        : QString("batch=%1，整帧复制=%2，IRQ=%3")
              .arg(capture.batchIoctl ? "是" : "否")
              .arg(capture.stagedCopy ? "是" : "否")
              .arg(capture.irqWait ? "是" : "否");
    addRow(snap, "实时采集", "优化路径", optimizationValue, fallbackDetail);
    addJsonRow(rows, "实时采集", "优化路径", optimizationValue, fallbackDetail);
    addRow(snap, "实时采集", "完整帧/丢弃帧",
           QString("%1 / %2").arg(capture.framesTotal).arg(capture.droppedFrames),
           capture.frameV2
               ? QString("FPGA 丢帧=%1，主机丢帧=%2，序号跳变=%3，协议错误=%4")
                     .arg(capture.fpgaDroppedFrames)
                     .arg(capture.hostDroppedFrames)
                     .arg(capture.sequenceGaps)
                     .arg(capture.protocolErrors)
               : QString("DMA 单元=%1B x %2，批量 ioctl=%3，整帧复制=%4，IRQ 等待=%5")
                     .arg(capture.dmaUnitBytes)
                     .arg(capture.dmaUnitCount)
                     .arg(capture.batchIoctl ? "是" : "否")
                     .arg(capture.stagedCopy ? "是" : "否")
                     .arg(capture.irqWait ? "是" : "否"));
    addJsonRow(rows, "实时采集", "完整帧/丢弃帧",
               QString("%1 / %2").arg(capture.framesTotal).arg(capture.droppedFrames),
               capture.frameV2
                   ? QString("FPGA 丢帧=%1，主机丢帧=%2，序号跳变=%3，协议错误=%4")
                         .arg(capture.fpgaDroppedFrames)
                         .arg(capture.hostDroppedFrames)
                         .arg(capture.sequenceGaps)
                         .arg(capture.protocolErrors)
                   : QString("DMA 单元=%1B x %2，批量 ioctl=%3，整帧复制=%4，IRQ 等待=%5")
                         .arg(capture.dmaUnitBytes)
                         .arg(capture.dmaUnitCount)
                         .arg(capture.batchIoctl ? "是" : "否")
                          .arg(capture.stagedCopy ? "是" : "否")
                          .arg(capture.irqWait ? "是" : "否"));

    const QString cmaValue = cmaTotalKb >= 0
        ? QString("%1 MiB / %2 MiB")
              .arg(cmaTotalKb / 1024.0, 0, 'f', 0)
              .arg(std::max<qlonglong>(0, cmaFreeKb) / 1024.0, 0, 'f', 0)
        : QStringLiteral("未报告");
    const QString cmaDetail = QString("总量 / 当前空闲；最低 64 MiB，推荐 128 MiB；cmdline: %1")
        .arg(kernelCmdline.isEmpty() ? QStringLiteral("N/A") : kernelCmdline);
    addRow(snap, "DMA内存", "CMA 总量 / 空闲", cmaValue, cmaDetail);
    addJsonRow(rows, "DMA内存", "CMA 总量 / 空闲", cmaValue, cmaDetail);

    addRow(snap, "驱动概览", "刷新时间", now.toString("yyyy-MM-dd HH:mm:ss"));
    addJsonRow(rows, "驱动概览", "刷新时间", now.toString("yyyy-MM-dd HH:mm:ss"));

    QFileInfo nodeInfo(devPath);
    QJsonObject node;
    node.insert("path", devPath);
    node.insert("exists", nodeInfo.exists());
    if (nodeInfo.exists()) {
        const QString perm = permissionString(nodeInfo);
        node.insert("permissions", perm);
        addRow(snap, "驱动概览", "设备节点", "存在", QString("%1  权限=%2").arg(devPath, perm));
        addJsonRow(rows, "驱动概览", "设备节点", "存在", QString("%1  权限=%2").arg(devPath, perm));
    } else {
        addRow(snap, "驱动概览", "设备节点", "不存在", devPath);
        addJsonRow(rows, "驱动概览", "设备节点", "不存在", devPath);
    }
    root.insert("device_node", node);

    const QString modules = readTextFile("/proc/modules", 512 * 1024);
    const bool loaded = modules.contains(devName + " ");
    const QString moduleVersionRaw = readTextFile("/sys/module/" + devName + "/version", 4096).trimmed();
    const QString moduleVersion = moduleVersionRaw.isEmpty() ? QStringLiteral("legacy/unknown") : moduleVersionRaw;
    QJsonObject module;
    module.insert("name", devName);
    module.insert("loaded", loaded);
    module.insert("version", moduleVersion);
    root.insert("module", module);
    addRow(snap, "驱动概览", "驱动模块", loaded ? "已加载" : "未加载",
           QString("%1，版本=%2").arg(devName, moduleVersion));
    addJsonRow(rows, "驱动概览", "驱动模块", loaded ? "已加载" : "未加载",
               QString("%1，版本=%2").arg(devName, moduleVersion));

    QJsonObject cpuJson;
    QJsonArray cpuPoliciesJson;
    const QStringList cpuPolicies = collectCpuPolicies();
    if (cpuPolicies.isEmpty()) {
        addRow(snap, "CPU", "当前频率", "N/A", "未找到 /sys/devices/system/cpu/cpufreq/policy*");
        addJsonRow(rows, "CPU", "当前频率", "N/A", "未找到 /sys/devices/system/cpu/cpufreq/policy*");
    } else {
        for (const QString &path : cpuPolicies) {
            const QString policy = QFileInfo(path).fileName();
            const QString gov = nonEmpty(readTextFile(path + "/scaling_governor", 4096));
            const QString curRaw = readTextFile(path + "/scaling_cur_freq", 4096).trimmed();
            bool curOk = false;
            const qlonglong curKHz = parseInteger(curRaw, &curOk);

            QJsonObject p;
            p.insert("policy", policy);
            p.insert("sysfs", path);
            p.insert("governor", gov);
            p.insert("cur_freq_text", formatKHz(curRaw));
            if (curOk) {
                p.insert("cur_freq_khz", double(curKHz));
                p.insert("cur_freq_hz", double(curKHz) * 1000.0);
                p.insert("cur_freq_mhz", curKHz / 1000.0);
            }
            cpuPoliciesJson.append(p);
            addRow(snap, "CPU", policy + " 当前频率", formatKHz(curRaw), QString("governor=%1  sysfs=%2").arg(gov, path));
            addJsonRow(rows, "CPU", policy + " 当前频率", formatKHz(curRaw), QString("governor=%1  sysfs=%2").arg(gov, path));
        }
    }
    cpuJson.insert("policies", cpuPoliciesJson);
    const CpuTimes cpu = readCpuTimes();
    const UsageValue cpuUsage = cpu.valid ? cpuUsageValue(state, cpu.total, cpu.idle) : UsageValue();
    cpuJson.insert("usage_text", cpu.valid ? cpuUsage.text : "N/A");
    if (cpu.valid && cpuUsage.hasPercent) cpuJson.insert("usage_percent", cpuUsage.percent);
    addRow(snap, "CPU", "运行占比", cpu.valid ? cpuUsage.text : "N/A", "全 CPU 平均，按 /proc/stat 两次刷新差分计算");
    addJsonRow(rows, "CPU", "运行占比", cpu.valid ? cpuUsage.text : "N/A", "全 CPU 平均，按 /proc/stat 两次刷新差分计算");
    root.insert("cpu", cpuJson);

    QJsonObject gpuJson;
    QJsonArray gpuDevices;
    const QStringList gpuPaths = devfreqPaths(QStringList() << "gpu" << "mali");
    if (gpuPaths.isEmpty()) {
        addRow(snap, "GPU", "devfreq 节点", "N/A", "未找到 /sys/class/devfreq 中的 GPU/Mali 节点");
        addJsonRow(rows, "GPU", "devfreq 节点", "N/A", "未找到 /sys/class/devfreq 中的 GPU/Mali 节点");
    } else {
        for (const QString &path : gpuPaths) gpuDevices.append(devfreqJson(path, "gpu", state, snap, rows));
    }
    gpuJson.insert("devices", gpuDevices);
    root.insert("gpu", gpuJson);

    QJsonObject npuJson;
    QJsonArray npuDevices;
    const QStringList npuPaths = devfreqPaths(QStringList() << "npu" << "rknpu");
    if (npuPaths.isEmpty()) {
        addRow(snap, "NPU", "devfreq 节点", "N/A", "未找到 /sys/class/devfreq 中的 NPU/RKNPU 节点");
        addJsonRow(rows, "NPU", "devfreq 节点", "N/A", "未找到 /sys/class/devfreq 中的 NPU/RKNPU 节点");
    } else {
        for (const QString &path : npuPaths) npuDevices.append(devfreqJson(path, "npu", state, snap, rows));
    }
    npuJson.insert("devices", npuDevices);
    root.insert("npu", npuJson);

    QJsonObject irqJson;
    const QString intr = readTextFile("/proc/interrupts", 512 * 1024);
    QString intrLine;
    for (const QString &line : intr.split('\n')) {
        if (line.contains(devName)) {
            intrLine = line.trimmed();
            break;
        }
    }
    irqJson.insert("found", !intrLine.isEmpty());
    if (intrLine.isEmpty()) {
        addRow(snap, "中断", "驱动条目", "未找到", "/proc/interrupts 中没有 pango_pci_driver");
        addJsonRow(rows, "中断", "驱动条目", "未找到", "/proc/interrupts 中没有 pango_pci_driver");
    } else {
        irqJson.insert("raw", oneLine(intrLine));
        addRow(snap, "中断", "原始条目", oneLine(intrLine));
        addJsonRow(rows, "中断", "原始条目", oneLine(intrLine));

        const qint64 sum = parseIrqSum(intrLine);
        const IrqParsed ip = parseInterruptLine(intrLine);
        if (ip.irq >= 0) {
            irqJson.insert("irq", ip.irq);
            addRow(snap, "中断", "IRQ", QString::number(ip.irq), "冒号后各列为每个 CPU 的中断计数");
            addJsonRow(rows, "中断", "IRQ", QString::number(ip.irq), "冒号后各列为每个 CPU 的中断计数");
        }

        if (!ip.perCpu.isEmpty()) {
            QStringList parts;
            QJsonArray perCpu;
            qint64 cpuSum = 0;
            for (int c = 0; c < ip.perCpu.size(); ++c) {
                parts << QString("CPU%1=%2").arg(c).arg(ip.perCpu[c]);
                perCpu.append(double(ip.perCpu[c]));
                cpuSum += ip.perCpu[c];
            }
            irqJson.insert("sum", double(cpuSum));
            irqJson.insert("per_cpu", perCpu);
            addRow(snap, "中断", "计数", QString::number(cpuSum), parts.join("  "));
            addJsonRow(rows, "中断", "计数", QString::number(cpuSum), parts.join("  "));
        }

        if (!ip.controller.isEmpty() || !ip.trigger.isEmpty() || !ip.name.isEmpty()) {
            const QString type = intrLine.contains("MSI", Qt::CaseInsensitive) ? "MSI" : "可能为 INTx/共享";
            irqJson.insert("type", type);
            irqJson.insert("controller", nonEmpty(ip.controller));
            irqJson.insert("hwirq", nonEmpty(ip.hwirq));
            irqJson.insert("trigger", nonEmpty(ip.trigger));
            irqJson.insert("name", nonEmpty(ip.name));
            const QString detail = QString("controller=%1  hwirq=%2  trigger=%3  name=%4")
                                       .arg(nonEmpty(ip.controller), nonEmpty(ip.hwirq), nonEmpty(ip.trigger), nonEmpty(ip.name));
            addRow(snap, "中断", "类型", type, detail);
            addJsonRow(rows, "中断", "类型", type, detail);
        }

        if (state && state->lastIrqSum >= 0 && state->lastTick.isValid()) {
            const double dt = state->lastTick.msecsTo(now) / 1000.0;
            if (dt > 1e-6 && sum >= 0) {
                const qint64 delta = sum - state->lastIrqSum;
                const double rate = delta / dt;
                irqJson.insert("delta", double(delta));
                irqJson.insert("rate_per_sec", rate);
                addRow(snap, "中断", "中断速率", QString("%1 /s").arg(rate, 0, 'f', 1), QString("本次增量=%1").arg(delta));
                addJsonRow(rows, "中断", "中断速率", QString("%1 /s").arg(rate, 0, 'f', 1), QString("本次增量=%1").arg(delta));
            }
        } else {
            addRow(snap, "中断", "中断速率", "采样中", "下一次刷新后显示 /s");
            addJsonRow(rows, "中断", "中断速率", "采样中", "下一次刷新后显示 /s");
        }
        if (state) {
            state->lastIrqSum = sum;
            state->lastTick = now;
        }
    }
    root.insert("interrupt", irqJson);

    QJsonObject pcieJson;
    QJsonArray devicesJson;
    pcieJson.insert("capture_metrics", captureJson);
    const QStringList bdfs = listBoundPciDevices(devName);
    pcieJson.insert("bound_count", bdfs.size());
    if (bdfs.isEmpty()) {
        addRow(snap, "PCIe", "绑定设备", "0", "/sys/bus/pci/drivers/pango_pci_driver 下未找到已绑定设备");
        addJsonRow(rows, "PCIe", "绑定设备", "0", "/sys/bus/pci/drivers/pango_pci_driver 下未找到已绑定设备");
    } else {
        addRow(snap, "PCIe", "绑定设备", QString::number(bdfs.size()));
        addJsonRow(rows, "PCIe", "绑定设备", QString::number(bdfs.size()));
        for (const QString &bdf : bdfs) {
            const QString vendor = readSysfs(bdf, "vendor");
            const QString device = readSysfs(bdf, "device");
            const QString irq = readSysfs(bdf, "irq");
            const QString cls = readSysfs(bdf, "class");
            const QString enable = readSysfs(bdf, "enable");
            const QString curSpd = readSysfs(bdf, "current_link_speed");
            const QString curW = readSysfs(bdf, "current_link_width");
            const QString maxSpd = readSysfs(bdf, "max_link_speed");
            const QString maxW = readSysfs(bdf, "max_link_width");

            QJsonObject dev;
            dev.insert("bdf", bdf);
            dev.insert("vendor", nonEmpty(vendor));
            dev.insert("device", nonEmpty(device));
            dev.insert("class", nonEmpty(cls));
            dev.insert("irq", nonEmpty(irq));
            dev.insert("enable", nonEmpty(enable));

            QJsonObject link;
            link.insert("current_speed", nonEmpty(curSpd));
            link.insert("current_width", nonEmpty(curW));
            link.insert("max_speed", nonEmpty(maxSpd));
            link.insert("max_width", nonEmpty(maxW));
            dev.insert("link", link);

            addRow(snap, "PCIe", bdf, QString("irq=%1").arg(nonEmpty(irq)),
                   QString("vendor=%1  device=%2  class=%3  enable=%4")
                       .arg(nonEmpty(vendor), nonEmpty(device), nonEmpty(cls), nonEmpty(enable)));
            addJsonRow(rows, "PCIe", bdf, QString("irq=%1").arg(nonEmpty(irq)),
                       QString("vendor=%1  device=%2  class=%3  enable=%4")
                           .arg(nonEmpty(vendor), nonEmpty(device), nonEmpty(cls), nonEmpty(enable)));

            if (!curSpd.isEmpty() || !curW.isEmpty()) {
                addRow(snap, "PCIe", bdf + " 当前链路", QString("%1 x%2").arg(nonEmpty(curSpd), nonEmpty(curW)));
                addJsonRow(rows, "PCIe", bdf + " 当前链路", QString("%1 x%2").arg(nonEmpty(curSpd), nonEmpty(curW)));
            }
            if (!maxSpd.isEmpty() || !maxW.isEmpty()) {
                addRow(snap, "PCIe", bdf + " 最大链路", QString("%1 x%2").arg(nonEmpty(maxSpd), nonEmpty(maxW)));
                addJsonRow(rows, "PCIe", bdf + " 最大链路", QString("%1 x%2").arg(nonEmpty(maxSpd), nonEmpty(maxW)));
            }

            const PcieCaps caps = readPcieCaps(bdf);
            QJsonObject capJson;
            capJson.insert("pcie_present", caps.hasPcie);
            if (caps.hasPcie) {
                capJson.insert("mps_bytes", caps.mpsBytes);
                capJson.insert("mps", bytesText(caps.mpsBytes));
                capJson.insert("mrrs_bytes", caps.mrrsBytes);
                capJson.insert("mrrs", bytesText(caps.mrrsBytes));
                addRow(snap, "PCIe", bdf + " PCIe Cap", QString("MPS=%1").arg(bytesText(caps.mpsBytes)),
                       QString("MRRS=%1").arg(bytesText(caps.mrrsBytes)));
                addJsonRow(rows, "PCIe", bdf + " PCIe Cap", QString("MPS=%1").arg(bytesText(caps.mpsBytes)),
                           QString("MRRS=%1").arg(bytesText(caps.mrrsBytes)));
            }
            QJsonObject msiJson;
            msiJson.insert("present", caps.hasMsi);
            if (caps.hasMsi) {
                msiJson.insert("enabled", caps.msiEnabled);
                msiJson.insert("mmc", caps.msiMmc);
                msiJson.insert("mme", caps.msiMme);
                addRow(snap, "PCIe", bdf + " MSI Cap", caps.msiEnabled ? "Enable=1" : "Enable=0",
                       QString("MMC=%1  MME=%2").arg(caps.msiMmc).arg(caps.msiMme));
                addJsonRow(rows, "PCIe", bdf + " MSI Cap", caps.msiEnabled ? "Enable=1" : "Enable=0",
                           QString("MMC=%1  MME=%2").arg(caps.msiMmc).arg(caps.msiMme));
            }
            dev.insert("capability", capJson);
            dev.insert("msi", msiJson);
            devicesJson.append(dev);
        }
    }
    pcieJson.insert("devices", devicesJson);
    root.insert("pcie", pcieJson);
    root.insert("mounted", nodeInfo.exists() || loaded || !bdfs.isEmpty());

    QJsonArray suggestions;
    if (!nodeInfo.exists()) {
        const QString h = "设备节点不存在，先执行 driver/mount_pango_pci_driver.sh 或确认驱动已创建设备";
        suggestions.append(h);
        addRow(snap, "建议", "设备节点", "需要检查", h);
        addJsonRow(rows, "建议", "设备节点", "需要检查", h);
    }
    if (!loaded) {
        const QString h = "驱动未加载，先 insmod pango_pci_driver.ko";
        suggestions.append(h);
        addRow(snap, "建议", "驱动模块", "需要加载", h);
        addJsonRow(rows, "建议", "驱动模块", "需要加载", h);
    }
    if (cmaTotalKb < kCmaMinimumKb) {
        const QString h = cmaTotalKb < 0
            ? QStringLiteral("内核未报告 CMA；V2 三缓冲需要至少 64 MiB，建议启动参数设置 cma=128M")
            : QString("CMA 仅 %1 MiB；V2 三缓冲最低 64 MiB，建议启动参数设置 cma=128M")
                  .arg(cmaTotalKb / 1024.0, 0, 'f', 0);
        suggestions.append(h);
        addRow(snap, "建议", "CMA", "不足", h);
        addJsonRow(rows, "建议", "CMA", "不足", h);
    } else if (cmaTotalKb < kCmaRecommendedKb) {
        const QString h = QString("CMA 为 %1 MiB，可运行但建议提高到 128 MiB 以覆盖显示和 DMA 峰值")
            .arg(cmaTotalKb / 1024.0, 0, 'f', 0);
        suggestions.append(h);
        addRow(snap, "建议", "CMA", "可用但偏低", h);
        addJsonRow(rows, "建议", "CMA", "可用但偏低", h);
    }
    root.insert("suggestions", suggestions);

    root.insert("rows", rows);
    snap.json = root;
    return snap;
}
