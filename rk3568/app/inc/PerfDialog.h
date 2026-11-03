#pragma once

#include <QDialog>
#include <QtGlobal>
#include <QJsonObject>
#include <array>

class QLabel;
class QWidget;

class PerfDialog : public QDialog {
    Q_OBJECT
public:
    explicit PerfDialog(QWidget *parent = nullptr);
    void setParts(double capMs, double convMs, double viewMs, double detBoxMs,
                  double detOcrMs, double envMs, double uiMs, double totalMs,
                  bool slidingEnabled, int slidingWindowCount);
    void setDetParts(double preMs, double npuMs, double postMs);
    void setDetRuntime(const QJsonObject &metrics);
    void setPcieMetrics(quint64 frames, double rxFps, double frameIntervalMs,
                        double dqWaitMs, bool frameV2);

private:
    class DonutWidget;
    DonutWidget *m_donut = nullptr;
    std::array<QWidget*, 7> m_legSwatch{};
    std::array<QLabel*, 7> m_legText{};
    QLabel *m_detPartsLabel = nullptr;
    QLabel *m_pcieFramesLabel = nullptr;
};

