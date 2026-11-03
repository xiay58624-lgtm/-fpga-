#include "BackendSettings.h"
#include "UserWindow.h"
#include "PlateCategory.h"
#include "yolo.h"

#include "ApiServer.h"
#include "BackendClient.h"
#include "VehicleClient.h"
#include "DriverStatusCollector.h"
#include "LatestFramePolicy.h"
#include "RuntimeSettings.h"
#include "TtsWavPlayer.h"
#include "UserMessageCloudSync.h"
#include "UiSizing.h"
#include "GpuVideoWidget.h"

#include <QComboBox>
#include <QBuffer>
#include <QDateTime>
#include <QDialog>
#include <QDir>
#include <QFileInfo>
#include <QFileDialog>
#include <QGridLayout>
#include <QHBoxLayout>
#include <QJsonObject>
#include <QJsonArray>
#include <QJsonValue>
#include <QLabel>
#include <QFont>
#include <QMenu>
#include <QMessageBox>
#include <QPixmap>
#include <QPoint>
#include <QProcessEnvironment>
#include <QPushButton>
#include <QAction>
#include <QStringList>
#include <QTabWidget>
#include <QUrl>
#include <QVBoxLayout>
#include <QVector>
#include <QtGlobal>
#include <algorithm>
#include <cmath>
#include <algorithm>
#include <cstdlib>

static QString moneyText(double v) {
    return QString::number(v, 'f', 2);
}

static QString payStatusCode(UserBusinessStore::PayStatus status, double fee) {
    if (fee <= 1e-6 || status == UserBusinessStore::PayStatus::None) return "free";
    if (status == UserBusinessStore::PayStatus::Deducted) return "deducted";
    if (status == UserBusinessStore::PayStatus::Insufficient) return "insufficient";
    if (status == UserBusinessStore::PayStatus::NotOpened) return "not_opened";
    return "unknown";
}

static QString currentTargetDeviceId() {
    const QString runtime = loadRuntimeSettings().targetDeviceId.trimmed();
    return runtime.isEmpty() ? QStringLiteral("esp32-servo-01") : runtime;
}

UserWindow::UserWindow(SystemPage onlyPage, QWidget *parent) : QMainWindow(parent), m_onlyPage(onlyPage) {
    const bool compact720 = UiSizing::isCompact720(this);
    setWindowTitle(onlyPage == SystemPage::Etc ? "普通用户模式(ETC系统)" : "普通用户模式(停车场系统)");

    QWidget *central = new QWidget(this);
    QVBoxLayout *root = new QVBoxLayout(central);
    root->setContentsMargins(compact720 ? 6 : 10, compact720 ? 6 : 10,
                             compact720 ? 6 : 10, compact720 ? 6 : 10);
    root->setSpacing(compact720 ? 6 : 10);

    QWidget *top = new QWidget(central);
    QHBoxLayout *topL = new QHBoxLayout(top);
    topL->setContentsMargins(0, 0, 0, 0);
    topL->setSpacing(compact720 ? 4 : 8);

    QLabel *title = new QLabel(onlyPage == SystemPage::Etc ? "普通用户 - ETC系统" : "普通用户 - 停车场系统", top);
    QFont tf = title->font();
    tf.setPixelSize(compact720 ? 16 : 18);
    tf.setBold(true);
    title->setFont(tf);

    QLabel *inputLabel = new QLabel("输入:", top);
    m_inputModeBox = new QComboBox(top);
    m_inputModeBox->addItems({"PCIE", "SD卡"});
    m_inputModeBox->setFixedWidth(compact720 ? 72 : 88);
    m_sdImportBtn = new QPushButton("SD导入", top);
    m_sdImportBtn->setFixedWidth(compact720 ? 72 : 88);
    m_inputInfoLabel = new QLabel("PCIe实时采集", top);
    m_inputInfoLabel->setMinimumWidth(compact720 ? 90 : 180);
    if (compact720) m_inputInfoLabel->setMaximumWidth(130);
    m_inputInfoLabel->setToolTip("PCIe实时采集");
    m_backendCommLabel = new QLabel("后端：未连接", top);
    m_backendCommLabel->setFixedWidth(compact720 ? 125 : 160);
    m_backendCommLabel->setAlignment(Qt::AlignRight | Qt::AlignVCenter);
    m_controlBtn = new QPushButton("开始采集", top);
    m_controlBtn->setFixedWidth(compact720 ? 95 : 110);
    m_switchBtn = new QPushButton("切换账号", top);
    m_switchBtn->setFixedWidth(compact720 ? 90 : 110);

    topL->addWidget(title);
    topL->addStretch();
    topL->addWidget(inputLabel);
    topL->addWidget(m_inputModeBox);
    topL->addWidget(m_sdImportBtn);
    topL->addWidget(m_inputInfoLabel);
    topL->addWidget(m_backendCommLabel);
    topL->addWidget(m_controlBtn);
    topL->addWidget(m_switchBtn);
    root->addWidget(top);

    m_tabs = new QTabWidget(central);
    if (onlyPage == SystemPage::Etc) {
        m_tabs->addTab(buildEtcPage(), "ETC");
    } else {
        m_tabs->addTab(buildParkingPage(), "停车场");
    }
    root->addWidget(m_tabs, 1);
    setCentralWidget(central);
    UiSizing::fitWindow(this, QSize(1280, 720), compact720 ? 0 : 24);

    m_captureThread = new CaptureThread(this);
    m_captureThread->setInputMode(m_inputMode);
    const RuntimeSettingsData runtimeSettings = loadRuntimeSettings();
    m_captureThread->setSdImageIntervalSeconds(runtimeSettings.sdImageIntervalSec);
    m_captureThread->setGlobalInferenceEnabled(
        runtimeSettings.globalInferenceEnabled);
    // The desktop launcher can enter UserWindow directly when the login module
    // is absent. Keep that path aligned with the persisted runtime mode instead
    // of silently forcing the legacy plate-recognition pipeline.
    const auto runtimeAlgoMode = runtimeSettings.algoMode == 1
        ? CaptureThread::AlgoMode::EnvOnly
        : runtimeSettings.algoMode == 2
            ? CaptureThread::AlgoMode::Overlay
            : CaptureThread::AlgoMode::PlateOnly;
    m_captureThread->setAlgoMode(runtimeAlgoMode);
    m_expectedDisplayConfigVersion = m_captureThread->displayConfigVersion();
    connect(m_captureThread, &CaptureThread::frameReady, this, &UserWindow::updateFrame);
    connect(m_captureThread, &CaptureThread::captureFailed, this,
            [this](const QString &error) {
        m_isCapturing = false;
        if (m_controlBtn) {
            m_controlBtn->setEnabled(true);
            m_controlBtn->setText("开始采集");
        }
        const QString text = QString("采集失败\n%1").arg(error);
        if (m_parkingVideoLabel) {
            m_parkingVideoLabel->setStatusText(text);
        }
        if (m_etcVideoLabel) {
            m_etcVideoLabel->setStatusText(text);
        }
        postStatus(true);
    });
    connect(m_captureThread, &QThread::finished, this, [this]() {
        if (m_captureThread && m_captureThread->isRunning()) return;
        m_isCapturing = false;
        if (m_controlBtn) {
            m_controlBtn->setEnabled(true);
            m_controlBtn->setText("开始采集");
        }
        postStatus(true);
    });
    connect(m_captureThread, &CaptureThread::plateReport, this, &UserWindow::onPlateReport);
    connect(m_captureThread, &CaptureThread::perfDetRuntime, this,
            [this](const QJsonObject &metrics) {
        m_lastDetRuntimeMetrics = metrics;
        if (m_isCapturing) postStatus(false);
    });
    m_ttsPlayer = new TtsWavPlayer(this);

    connect(m_controlBtn, &QPushButton::clicked, this, &UserWindow::handleStartStop);
    connect(m_inputModeBox, qOverload<int>(&QComboBox::currentIndexChanged), this, &UserWindow::handleInputModeChanged);
    connect(m_tabs, &QTabWidget::currentChanged, this, &UserWindow::onTabChanged);
    connect(m_switchBtn, &QPushButton::clicked, this, &UserWindow::requestSwitchAccount);
    connect(m_sdImportBtn, &QPushButton::clicked, this, [this]() {
        QMenu menu(this);
        QAction *actImage = menu.addAction("导入图片");
        QAction *actVideo = menu.addAction("导入视频");
        QAction *actFolder = menu.addAction("导入图片文件夹(支持4路)");
        QAction *picked = menu.exec(m_sdImportBtn->mapToGlobal(QPoint(0, m_sdImportBtn->height())));
        QString path;
        if (picked == actImage) {
            path = QFileDialog::getOpenFileName(this, "选择图片", "", "图片 (*.jpg *.jpeg *.png *.bmp *.webp)");
        } else if (picked == actVideo) {
            path = QFileDialog::getOpenFileName(this, "选择视频", "", "视频 (*.mp4 *.avi *.mov *.mkv *.ts *.m4v)");
        } else if (picked == actFolder) {
            path = QFileDialog::getExistingDirectory(this, "选择图片文件夹", QDir::homePath());
        }
        applySdSourcePath(path);
    });

    setupBackend();
    applyInputModeUi();
    postStatus(true);
}

UserWindow::~UserWindow() {
    if (m_captureThread) {
        m_captureThread->stop();
        m_captureThread->wait(500);
    }
}

void UserWindow::setupBackend() {
    m_backendClient = new BackendClient(this);
    connect(m_backendClient, &BackendClient::statusChanged, this, [this](bool ok, const QString &err) {
        if (!m_backendCommLabel) return;
        m_backendCommLabel->setText(ok ? "后端：已连接" : "后端：未连接");
        m_backendCommLabel->setToolTip(ok ? "" : err);
        if (ok) {
            postStatus(true);
            postBusinessSnapshot();
        }
    });

    const BackendSettingsData bs = loadEffectiveBackendSettings();
    if (!bs.backendBase.isEmpty()) {
        QString err;
        QUrl base = normalizeBackendBase(bs.backendBase, &err);
        if (base.isValid()) {
            m_backendClient->setBaseUrl(base, bs.backendSource);
            m_backendClient->start();
        }
    }

    m_vehicleClient = new VehicleClient(this);
    m_apiServer = new ApiServer(m_backendClient, nullptr, &m_userMessageConfig,
                                m_vehicleClient, nullptr, this);
    m_apiServer->listen(3000);
    connect(m_apiServer, &ApiServer::userMessageConfigChanged, this, [this]() {
        postStatus(true);
    });
    m_userMessageCloudSync = new UserMessageCloudSync(m_backendClient, &m_userMessageConfig, this);
    connect(m_userMessageCloudSync, &UserMessageCloudSync::configChanged, this, [this]() {
        postStatus(true);
    });
    m_userMessageCloudSync->start();
    connect(m_apiServer, &ApiServer::peerDiscovered, this, [this](const QString &ip) {
        if (!m_backendClient || m_backendClient->ok() || !m_backendClient->autoDiscoveryAllowed()) return;
        const QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
        const QString portsCsv = env.value("PC_BACKEND_PORTS").trimmed();
        const QString portSingle = env.value("PC_BACKEND_PORT").trimmed();

        QList<int> ports;
        auto addPort = [&ports](int p) {
            if (p <= 0 || p > 65535 || ports.contains(p)) return;
            ports.append(p);
        };
        if (!portsCsv.isEmpty()) {
            const QStringList ps = portsCsv.split(',', Qt::SkipEmptyParts);
            for (const QString &s0 : ps) {
                const QString s = s0.trimmed();
                const int dash = s.indexOf('-');
                if (dash > 0) {
                    const int a = s.left(dash).trimmed().toInt();
                    const int b = s.mid(dash + 1).trimmed().toInt();
                    const int lo = qMin(a, b);
                    const int hi = qMax(a, b);
                    for (int p = lo; p <= hi; ++p) addPort(p);
                } else {
                    addPort(s.toInt());
                }
            }
        } else if (!portSingle.isEmpty()) {
            addPort(portSingle.toInt());
        }
        if (ports.isEmpty()) {
            for (int p = 8080; p <= 8092; ++p) addPort(p);
        }

        QVector<QUrl> candidates;
        candidates.reserve(ports.size());
        for (int p : ports) candidates.append(QUrl(QString("http://%1:%2/").arg(ip).arg(p)));
        m_backendClient->setBaseUrlCandidates(candidates);
        m_backendClient->start();
    });
}

QWidget* UserWindow::buildParkingPage() {
    QWidget *w = new QWidget(this);
    QVBoxLayout *l = new QVBoxLayout(w);
    l->setContentsMargins(0, 0, 0, 0);
    l->setSpacing(10);

    QWidget *tools = new QWidget(w);
    QHBoxLayout *tl = new QHBoxLayout(tools);
    tl->setContentsMargins(0, 0, 0, 0);
    QLabel *viewL = new QLabel("视频源:", tools);
    m_parkingViewModeBox = new QComboBox(tools);
    m_parkingViewModeBox->addItems({"拼接-原始(4路)", "单路-源1", "单路-源2", "单路-源3", "单路-源4", "拼接-自定义"});
    m_parkingMosaicCfgBtn = new QPushButton("拼接设置", tools);
    m_parkingMosaicCfgBtn->setFixedWidth(90);
    m_parkingMosaicCfgBtn->setEnabled(false);
    tl->addWidget(viewL);
    tl->addWidget(m_parkingViewModeBox, 1);
    tl->addWidget(m_parkingMosaicCfgBtn);
    l->addWidget(tools);

    m_parkingVideoLabel = new GpuVideoWidget(w);
    m_parkingVideoLabel->setStatusText("等待采集...");
    m_parkingVideoLabel->setMinimumHeight(UiSizing::isCompact720(this) ? 300 : 420);
    l->addWidget(m_parkingVideoLabel, 1);

    m_parkingMsg = new QLabel("识别后将在此显示提示信息", w);
    m_parkingMsg->setWordWrap(true);
    QFont mf = m_parkingMsg->font();
    mf.setPixelSize(16);
    mf.setBold(true);
    m_parkingMsg->setFont(mf);
    l->addWidget(m_parkingMsg);

    connect(m_parkingViewModeBox, qOverload<int>(&QComboBox::currentIndexChanged), this, &UserWindow::handleViewModeChanged);
    connect(m_parkingMosaicCfgBtn, &QPushButton::clicked, this, &UserWindow::openMosaicConfig);
    return w;
}

QWidget* UserWindow::buildEtcPage() {
    QWidget *w = new QWidget(this);
    QVBoxLayout *l = new QVBoxLayout(w);
    l->setContentsMargins(0, 0, 0, 0);
    l->setSpacing(10);

    QWidget *tools = new QWidget(w);
    QHBoxLayout *tl = new QHBoxLayout(tools);
    tl->setContentsMargins(0, 0, 0, 0);
    QLabel *viewL = new QLabel("视频源:", tools);
    m_etcViewModeBox = new QComboBox(tools);
    m_etcViewModeBox->addItems({"拼接-原始(4路)", "单路-源1", "单路-源2", "单路-源3", "单路-源4", "拼接-自定义"});
    m_etcMosaicCfgBtn = new QPushButton("拼接设置", tools);
    m_etcMosaicCfgBtn->setFixedWidth(90);
    m_etcMosaicCfgBtn->setEnabled(false);
    tl->addWidget(viewL);
    tl->addWidget(m_etcViewModeBox, 1);
    tl->addWidget(m_etcMosaicCfgBtn);
    l->addWidget(tools);

    m_etcVideoLabel = new GpuVideoWidget(w);
    m_etcVideoLabel->setStatusText("等待采集...");
    m_etcVideoLabel->setMinimumHeight(UiSizing::isCompact720(this) ? 300 : 420);
    l->addWidget(m_etcVideoLabel, 1);

    m_etcMsg = new QLabel("识别后将在此显示提示信息", w);
    m_etcMsg->setWordWrap(true);
    QFont mf = m_etcMsg->font();
    mf.setPixelSize(16);
    mf.setBold(true);
    m_etcMsg->setFont(mf);
    l->addWidget(m_etcMsg);

    connect(m_etcViewModeBox, qOverload<int>(&QComboBox::currentIndexChanged), this, &UserWindow::handleViewModeChanged);
    connect(m_etcMosaicCfgBtn, &QPushButton::clicked, this, &UserWindow::openMosaicConfig);
    return w;
}

void UserWindow::updateFrame(QImage img, quint64 displayConfigVersion) {
    if (!latest_frame::displayFrameUsable(
            displayConfigVersion, m_expectedDisplayConfigVersion)) {
        if (m_captureThread) m_captureThread->acknowledgeFrameDelivery();
        return;
    }
    m_expectedDisplayConfigVersion = displayConfigVersion;
    if (img.width() > 0 && img.height() > 0) {
        if (m_parkingVideoLabel) {
            m_parkingVideoLabel->setFrame(img);
        }
        if (m_etcVideoLabel) {
            m_etcVideoLabel->setFrame(img);
        }
    }
    if (m_captureThread) m_captureThread->acknowledgeFrameDelivery();
}

void UserWindow::applyInputModeUi() {
    const bool isPcie = (m_inputMode == CaptureThread::InputMode::Pcie);
    if (m_inputModeBox && m_inputModeBox->currentIndex() != (isPcie ? 0 : 1)) {
        m_inputModeBox->blockSignals(true);
        m_inputModeBox->setCurrentIndex(isPcie ? 0 : 1);
        m_inputModeBox->blockSignals(false);
    }
    if (m_sdImportBtn) m_sdImportBtn->setEnabled(!isPcie);
    if (m_parkingViewModeBox) m_parkingViewModeBox->setEnabled(true);
    if (m_etcViewModeBox) m_etcViewModeBox->setEnabled(true);
    if (m_parkingMosaicCfgBtn) m_parkingMosaicCfgBtn->setEnabled(m_parkingViewModeBox && m_parkingViewModeBox->currentIndex() == 5);
    if (m_etcMosaicCfgBtn) m_etcMosaicCfgBtn->setEnabled(m_etcViewModeBox && m_etcViewModeBox->currentIndex() == 5);
    if (m_inputInfoLabel) {
        const QString text = isPcie ? QString("PCIe实时采集")
                                    : (m_sdSourcePath.isEmpty() ? QString("未选择SD卡文件/目录") : m_sdSourcePath);
        m_inputInfoLabel->setText(text);
        m_inputInfoLabel->setToolTip(text);
    }
}

bool UserWindow::ensureSdSourceReady() {
    if (m_inputMode != CaptureThread::InputMode::SdCard) return true;
    if (!m_sdSourcePath.isEmpty()) return true;
    QMessageBox::information(this, "提示", "当前为SD卡输入，请先导入图片、视频或图片文件夹。");
    return false;
}

void UserWindow::applySdSourcePath(const QString &path) {
    const QString trimmed = path.trimmed();
    if (trimmed.isEmpty()) return;
    m_sdSourcePath = trimmed;
    if (m_captureThread) m_captureThread->setSdSourcePath(m_sdSourcePath);
    if (m_inputMode != CaptureThread::InputMode::SdCard) {
        m_inputMode = CaptureThread::InputMode::SdCard;
        if (m_captureThread) m_captureThread->setInputMode(m_inputMode);
    }
    if (m_captureThread) {
        m_expectedDisplayConfigVersion = m_captureThread->displayConfigVersion();
    }
    if (m_parkingVideoLabel) {
        m_parkingVideoLabel->setStatusText("正在切换输入...");
    }
    if (m_etcVideoLabel) {
        m_etcVideoLabel->setStatusText("正在切换输入...");
    }
    applyInputModeUi();
    if (m_isCapturing && m_captureThread) {
        m_captureThread->stop();
        m_captureThread->wait();
        m_captureThread->startCapture();
    }
    postStatus(true);
}

void UserWindow::handleStartStop() {
    if (!m_captureThread) return;
    if (!m_isCapturing) {
        if (!ensureSdSourceReady()) return;
        m_captureThread->startCapture();
        m_isCapturing = true;
        if (m_controlBtn) m_controlBtn->setText("停止采集");
        if (m_onlyPage == SystemPage::Etc) {
            if (m_etcViewModeBox) handleViewModeChanged(m_etcViewModeBox->currentIndex());
        } else {
            if (m_parkingViewModeBox) handleViewModeChanged(m_parkingViewModeBox->currentIndex());
        }
    } else {
        m_captureThread->stop();
        if (m_controlBtn) {
            m_controlBtn->setEnabled(false);
            m_controlBtn->setText("正在停止...");
        }
    }
    postStatus(true);
}

void UserWindow::handleInputModeChanged(int index) {
    const CaptureThread::InputMode next = (index == 1) ? CaptureThread::InputMode::SdCard : CaptureThread::InputMode::Pcie;
    if (m_inputMode == next) {
        applyInputModeUi();
        return;
    }
    m_inputMode = next;
    if (m_captureThread) m_captureThread->setInputMode(m_inputMode);
    if (m_captureThread) {
        m_expectedDisplayConfigVersion = m_captureThread->displayConfigVersion();
    }
    if (m_parkingVideoLabel) {
        m_parkingVideoLabel->setStatusText("正在切换输入...");
    }
    if (m_etcVideoLabel) {
        m_etcVideoLabel->setStatusText("正在切换输入...");
    }
    applyInputModeUi();
    if (m_isCapturing && m_captureThread) {
        m_captureThread->stop();
        m_captureThread->wait();
        if (m_inputMode == CaptureThread::InputMode::SdCard && !ensureSdSourceReady()) {
            m_isCapturing = false;
            if (m_controlBtn) m_controlBtn->setText("开始采集");
        } else {
            m_captureThread->startCapture();
        }
    }
    postStatus(true);
}

void UserWindow::applyViewSelection(QComboBox *changedBox, int index) {
    QComboBox *other = (changedBox == m_parkingViewModeBox) ? m_etcViewModeBox : m_parkingViewModeBox;
    if (other && other->currentIndex() != index) {
        other->blockSignals(true);
        other->setCurrentIndex(index);
        other->blockSignals(false);
    }
}

void UserWindow::handleViewModeChanged(int index) {
    if (!m_captureThread) return;
    QComboBox *senderBox = qobject_cast<QComboBox*>(sender());
    if (senderBox) applyViewSelection(senderBox, index);

    QPushButton *cfgBtn = (m_onlyPage == SystemPage::Etc) ? m_etcMosaicCfgBtn : m_parkingMosaicCfgBtn;
    if (index == 0) {
        m_captureThread->setDisplayMode(CaptureThread::DisplayMode::FpgaMosaic);
        if (cfgBtn) cfgBtn->setEnabled(false);
    } else if (index >= 1 && index <= 4) {
        m_captureThread->setDisplayMode(CaptureThread::DisplayMode::SingleSource);
        m_captureThread->setSingleSource(index);
        if (cfgBtn) cfgBtn->setEnabled(false);
    } else if (index == 5) {
        m_captureThread->setDisplayMode(CaptureThread::DisplayMode::CustomMosaic);
        m_captureThread->setMosaicMapping(m_mosaicMapping);
        if (cfgBtn) cfgBtn->setEnabled(true);
    }
    m_expectedDisplayConfigVersion = m_captureThread->displayConfigVersion();
    if (m_parkingVideoLabel) {
        m_parkingVideoLabel->setStatusText("正在切换画面...");
    }
    if (m_etcVideoLabel) {
        m_etcVideoLabel->setStatusText("正在切换画面...");
    }
    postStatus(false);
}

void UserWindow::openMosaicConfig() {
    QDialog dialog(this);
    dialog.setWindowTitle("拼接设置");
    dialog.setFixedWidth(420);

    auto createSourceBox = [&dialog](int current) {
        QComboBox *box = new QComboBox(&dialog);
        box->addItems({"无", "源1", "源2", "源3", "源4"});
        int idx = qBound(0, current, 4);
        box->setCurrentIndex(idx);
        box->setFixedWidth(120);
        return box;
    };

    QVBoxLayout *mainLayout = new QVBoxLayout(&dialog);
    QGridLayout *grid = new QGridLayout();
    QLabel *tl = new QLabel("左上", &dialog);
    QLabel *tr = new QLabel("右上", &dialog);
    QLabel *bl = new QLabel("左下", &dialog);
    QLabel *br = new QLabel("右下", &dialog);

    QComboBox *boxTL = createSourceBox(m_mosaicMapping[0]);
    QComboBox *boxTR = createSourceBox(m_mosaicMapping[1]);
    QComboBox *boxBL = createSourceBox(m_mosaicMapping[2]);
    QComboBox *boxBR = createSourceBox(m_mosaicMapping[3]);

    grid->addWidget(tl, 0, 0);
    grid->addWidget(boxTL, 0, 1);
    grid->addWidget(tr, 0, 2);
    grid->addWidget(boxTR, 0, 3);
    grid->addWidget(bl, 1, 0);
    grid->addWidget(boxBL, 1, 1);
    grid->addWidget(br, 1, 2);
    grid->addWidget(boxBR, 1, 3);
    mainLayout->addLayout(grid);

    QHBoxLayout *bottom = new QHBoxLayout();
    bottom->addStretch();
    QPushButton *btnOk = new QPushButton("应用", &dialog);
    QPushButton *btnCancel = new QPushButton("取消", &dialog);
    bottom->addWidget(btnOk);
    bottom->addWidget(btnCancel);
    mainLayout->addLayout(bottom);

    connect(btnOk, &QPushButton::clicked, &dialog, &QDialog::accept);
    connect(btnCancel, &QPushButton::clicked, &dialog, &QDialog::reject);

    if (dialog.exec() == QDialog::Accepted) {
        m_mosaicMapping = {boxTL->currentIndex(), boxTR->currentIndex(), boxBL->currentIndex(), boxBR->currentIndex()};
        if (m_captureThread) {
            m_captureThread->setMosaicMapping(m_mosaicMapping);
            m_expectedDisplayConfigVersion = m_captureThread->displayConfigVersion();
        }
        if (m_parkingVideoLabel) {
            m_parkingVideoLabel->setStatusText("正在切换画面...");
        }
        if (m_etcVideoLabel) {
            m_etcVideoLabel->setStatusText("正在切换画面...");
        }
        postStatus(true);
    }
}

QString UserWindow::showParkingMessage(const UserBusinessStore::ParkingOutcome &out, QString *templateKey) {
    if (!m_parkingMsg) return QString();
    if (out.type == UserBusinessStore::ParkingEventType::Ignored) return QString();

    QMap<QString, QString> vars;
    vars.insert("plate", out.plate);
    vars.insert("duration", UserBusinessStore::formatDurationMinutes(out.minutes));
    vars.insert("minutes", QString::number(out.minutes));
    vars.insert("fee", moneyText(out.fee));
    vars.insert("paid", moneyText(out.paidFromBalance));
    vars.insert("need_pay", moneyText(out.needPay));
    vars.insert("balance", moneyText(out.balanceAfter));
    vars.insert("arrears", moneyText(out.arrearsAfter));

    QString key;
    if (out.type == UserBusinessStore::ParkingEventType::Entry) {
        key = "entry";
    } else if (out.fee <= 1e-6 || out.payStatus == UserBusinessStore::PayStatus::None) {
        key = "exit_free";
    } else if (out.payStatus == UserBusinessStore::PayStatus::Deducted) {
        key = "exit_deducted";
    } else if (out.payStatus == UserBusinessStore::PayStatus::Insufficient) {
        key = "exit_insufficient";
    } else {
        key = "exit_not_opened";
    }

    QString msg = m_userMessageConfig.render("parking", key, vars);
    if (out.type == UserBusinessStore::ParkingEventType::Exit && out.arrearsAfter > 1e-6) {
        msg += m_userMessageConfig.render("parking", "arrears_suffix", vars);
    }
    if (templateKey) *templateKey = key;
    m_parkingMsg->setText(msg);
    m_parkingMsg->setToolTip(msg);
    return msg;
}

QString UserWindow::showEtcMessage(const UserBusinessStore::EtcOutcome &out, QString *templateKey) {
    if (!m_etcMsg) return QString();

    QMap<QString, QString> vars;
    vars.insert("plate", out.plate);
    vars.insert("fee", moneyText(out.fee));
    vars.insert("paid", moneyText(out.paidFromBalance));
    vars.insert("need_pay", moneyText(out.needPay));
    vars.insert("balance", moneyText(out.balanceAfter));
    vars.insert("arrears", moneyText(out.arrearsAfter));

    QString key;
    if (out.payStatus == UserBusinessStore::PayStatus::Deducted) key = "pass_deducted";
    else if (out.payStatus == UserBusinessStore::PayStatus::Insufficient) key = "pass_insufficient";
    else key = "pass_not_opened";

    QString msg = m_userMessageConfig.render("etc", key, vars);
    if (out.arrearsAfter > 1e-6) msg += m_userMessageConfig.render("etc", "arrears_suffix", vars);
    if (templateKey) *templateKey = key;
    m_etcMsg->setText(msg);
    m_etcMsg->setToolTip(msg);
    return msg;
}

void UserWindow::postStatus(bool force) {
    if (!m_backendClient) return;
    const qint64 nowMs = QDateTime::currentMSecsSinceEpoch();
    if (!force && m_lastStatusPostMs > 0 && nowMs - m_lastStatusPostMs < 2000) return;
    m_lastStatusPostMs = nowMs;

    QString view;
    QComboBox *box = (m_onlyPage == SystemPage::Etc) ? m_etcViewModeBox : m_parkingViewModeBox;
    if (box) {
        const int idx = box->currentIndex();
        if (idx == 0) view = "mosaic_raw";
        else if (idx >= 1 && idx <= 4) view = QString("src%1").arg(idx);
        else if (idx == 5) view = "mosaic_custom";
    }

    QJsonObject o;
    o.insert("device", "rk3568");
    o.insert("role", "user");
    o.insert("user_state", "normal");
    o.insert("ui_mode", "user");
    o.insert("account_mode", "user");
    GpuVideoWidget *activeVideo = m_onlyPage == SystemPage::Etc
        ? m_etcVideoLabel : m_parkingVideoLabel;
    o.insert("gui_render_backend", activeVideo
        ? activeVideo->rendererBackend() : QStringLiteral("unavailable"));
    o.insert("gui_gl_initialized", activeVideo && activeVideo->glInitialized());
    o.insert("gui_gpu_active", activeVideo && activeVideo->glInitialized() &&
        activeVideo->hardwareAccelerated());
    o.insert("gui_gl_renderer", activeVideo
        ? activeVideo->rendererName() : QStringLiteral("unavailable"));
    o.insert("biz_system", m_onlyPage == SystemPage::Etc ? "etc" : "parking");
    o.insert("input_mode", m_inputMode == CaptureThread::InputMode::SdCard ? "sdcard" : "pcie");
    if (m_inputMode == CaptureThread::InputMode::SdCard && !m_sdSourcePath.isEmpty()) o.insert("sd_source_path", m_sdSourcePath);
    o.insert("infer_mode", "plate");
    o.insert("capture_running", m_isCapturing);
    if (!view.isEmpty()) o.insert("view", view);
    o.insert("user_message_config", m_userMessageConfig.toJson(false));
    o.insert("user_message_config_path", m_userMessageConfig.configPath());
    if (m_userMessageCloudSync) o.insert("user_message_config_sync", m_userMessageCloudSync->statusJson());
    if (m_ttsPlayer) {
        QJsonObject tts;
        tts.insert("enabled", m_ttsPlayer->isEnabled());
        tts.insert("ready", m_ttsPlayer->isReady());
        tts.insert("base_dir", m_ttsPlayer->baseDir());
        tts.insert("output_device", m_ttsPlayer->outputDevice());
        tts.insert("last_error", m_ttsPlayer->lastError());
        o.insert("tts_wav", tts);
    }
    const RuntimeSettingsData runtimeSettings = loadRuntimeSettings();
    o.insert("runtime_settings", runtimeSettingsToJson(runtimeSettings));
    o.insert("runtime_settings_path", runtimeSettingsPath());
    o.insert("global_inference_enabled", runtimeSettings.globalInferenceEnabled);
    o.insert("display_only", !runtimeSettings.globalInferenceEnabled);
    o.insert("target_device_id", runtimeSettings.targetDeviceId.trimmed());
    const char *detModelRaw = yolo_detection_model_path();
    const char *recModelRaw = yolo_recognition_model_path();
    const QString detModelPath = detModelRaw
        ? QString::fromLocal8Bit(detModelRaw) : QString();
    const QString recModelPath = recModelRaw
        ? QString::fromLocal8Bit(recModelRaw) : QString();
    o.insert("plate_detector_model_path", detModelPath);
    o.insert("plate_detector_model_name", QFileInfo(detModelPath).fileName());
    o.insert("detector_profile", yolo_current_detector_profile_key());
    o.insert("detector_profile_id", yolo_current_detector_profile());
    o.insert("detector_family", yolo_current_detector_family());
    o.insert("detector_model_name", yolo_current_detector_model_name());
    o.insert("detector_input_width", yolo_current_detector_input_width());
    o.insert("detector_input_height", yolo_current_detector_input_height());
    o.insert("detector_input_type", "RGB_UINT8_NHWC");
    o.insert("detector_output_contract",
             yolo_current_detector_output_contract());
    o.insert("detector_runtime_backend", "cpp_rknn_npu");
    o.insert("plate_recognizer_model_path", recModelPath);
    o.insert("plate_recognizer_model_name", QFileInfo(recModelPath).fileName());
    o.insert("recognizer_profile", yolo_current_recognizer_profile_key());
    o.insert("recognizer_profile_id", yolo_current_recognizer_profile());
    o.insert("recognizer_output_contract",
             yolo_current_recognizer_output_contract());
    o.insert("recognizer_input_width",
             yolo_current_recognizer_input_width());
    o.insert("recognizer_input_height",
             yolo_current_recognizer_input_height());
    o.insert("recognizer_input_format",
             yolo_current_recognizer_input_format());
    o.insert("recognizer_model_input_type",
             yolo_current_recognizer_model_input_type());
    o.insert("recognizer_text_layout",
             yolo_current_recognizer_text_layout());
    o.insert("recognizer_runtime_backend", "cpp_rknn_npu");
    o.insert("plate_model_input_width", yolo_current_detector_input_width());
    o.insert("plate_model_input_height", yolo_current_detector_input_height());
    o.insert("plate_model_input_format", "RGB888");
    QString detectorStrategy = "inactive";
    if (m_isCapturing &&
        m_inputMode == CaptureThread::InputMode::Pcie) {
        detectorStrategy = view == "mosaic_raw" || view == "mosaic_custom"
            ? (runtimeSettings.pcieInferenceStrategy == 1
                   ? "per_source_full" : "mosaic_single")
            : "single_source";
    }
    if (!runtimeSettings.globalInferenceEnabled) {
        detectorStrategy = "disabled";
    }
    QJsonObject detRuntime = m_lastDetRuntimeMetrics;
    const QString reportedStrategy =
        detRuntime.value("strategy").toString();
    const bool runtimeMatchesInput = !runtimeSettings.globalInferenceEnabled
        ? reportedStrategy == "disabled"
        : (m_inputMode == CaptureThread::InputMode::Pcie
               ? reportedStrategy == detectorStrategy
               : reportedStrategy == "sd_static" ||
                     reportedStrategy == "single_source");
    if (!m_isCapturing ||
        (!detRuntime.isEmpty() && !runtimeMatchesInput)) {
        detRuntime = QJsonObject();
    }
    if (detRuntime.isEmpty()) {
        detRuntime.insert("executed", false);
        detRuntime.insert("inference_enabled",
                          runtimeSettings.globalInferenceEnabled);
        detRuntime.insert("display_only",
                          !runtimeSettings.globalInferenceEnabled);
        detRuntime.insert("capture_async", false);
        detRuntime.insert("latest_only", false);
        detRuntime.insert("overlay_max_age_ms", 0.0);
        detRuntime.insert("display_cycle_ms", 0.0);
        detRuntime.insert("display_fps", 0.0);
        detRuntime.insert("capture_dropped_frames", 0.0);
        detRuntime.insert("strategy", detectorStrategy);
        detRuntime.insert("pipeline_enabled", runtimeSettings.detPipelineEnabled);
        detRuntime.insert("pipeline_active", false);
        detRuntime.insert("quantized_output",
                          yolo_current_detector_profile() == 0 &&
                              runtimeSettings.detQuantizedOutput);
        detRuntime.insert("preprocess_backend", "uninitialized");
        detRuntime.insert("preprocess_requested",
                          runtimeSettings.detPreprocessBackend == 1
                              ? "opencv"
                              : runtimeSettings.detPreprocessBackend == 2
                                  ? "rga" : "auto");
        detRuntime.insert("preprocess_fallback_reason", "");
        detRuntime.insert("task_count", 0);
        detRuntime.insert("score_candidates", 0);
        detRuntime.insert("decoded_candidates", 0);
        detRuntime.insert("final_candidates", 0);
        detRuntime.insert("configured_stride",
                          std::max(1, runtimeSettings.plateInferStride));
        detRuntime.insert("source_frame_sequence", 0.0);
        detRuntime.insert("last_detection_source_sequence", 0.0);
        detRuntime.insert("queue_depth", 0);
        detRuntime.insert("dropped_tasks", 0);
        detRuntime.insert("pre_ms", 0.0);
        detRuntime.insert("npu_wall_ms", 0.0);
        detRuntime.insert("npu_hw_ms", 0.0);
        detRuntime.insert("post_ms", 0.0);
        detRuntime.insert("e2e_ms", 0.0);
        detRuntime.insert("overlap_saved_ms", 0.0);
        detRuntime.insert("worker_ms", 0.0);
        detRuntime.insert("overlay_ms", 0.0);
        detRuntime.insert("task_fps", 0.0);
        detRuntime.insert("cycle_fps", 0.0);
        detRuntime.insert("fps_basis", "completed_detection_cycles");
        detRuntime.insert("fps_window_ms", 0.0);
        detRuntime.insert("result_age_ms", 0.0);
    }
    o.insert("plate_detector_runtime", detRuntime);
    const bool pcieFourSourceView =
        m_inputMode == CaptureThread::InputMode::Pcie &&
        (view == "mosaic_raw" || view == "mosaic_custom");
    const int detectorInputWidth = yolo_current_detector_input_width();
    const int detectorInputHeight = yolo_current_detector_input_height();
    const bool detectorLegacy = yolo_current_detector_profile() == 0;
    auto makeLetterbox = [detectorInputWidth, detectorInputHeight,
                          detectorLegacy](int sourceWidth, int sourceHeight) {
        const double gain = std::min(
            (double)detectorInputWidth / std::max(1, sourceWidth),
            (double)detectorInputHeight / std::max(1, sourceHeight));
        const int contentWidth = std::max(
            1, (int)std::lround(sourceWidth * std::min(1.0, gain)));
        const int contentHeight = std::max(
            1, (int)std::lround(sourceHeight * std::min(1.0, gain)));
        const int padLeft = (detectorInputWidth - contentWidth) / 2;
        const int padTop = (detectorInputHeight - contentHeight) / 2;
        QJsonObject value;
        value.insert("source_width", sourceWidth);
        value.insert("source_height", sourceHeight);
        value.insert("model_width", detectorInputWidth);
        value.insert("model_height", detectorInputHeight);
        value.insert("content_width", contentWidth);
        value.insert("content_height", contentHeight);
        value.insert("pad_left", padLeft);
        value.insert("pad_right", detectorInputWidth - contentWidth - padLeft);
        value.insert("pad_top", padTop);
        value.insert("pad_bottom", detectorInputHeight - contentHeight - padTop);
        value.insert("pad_value_rgb", detectorLegacy ? 0 : 114);
        value.insert("scaleup", false);
        return value;
    };
    const QJsonObject mosaicLetterbox = makeLetterbox(1280, 720);
    const QJsonObject sourceLetterbox = makeLetterbox(640, 360);
    QJsonObject pcieInference;
    pcieInference.insert("schema", "rk3568_pcie_plate_inference_v2");
    pcieInference.insert("applicable", pcieFourSourceView);
    pcieInference.insert("capture_running", m_isCapturing);
    pcieInference.insert("input_mode",
                         m_inputMode == CaptureThread::InputMode::Pcie
                             ? "pcie" : "sdcard");
    pcieInference.insert("view", view);
    pcieInference.insert("strategy", detectorStrategy);
    pcieInference.insert("configured_strategy",
                         runtimeSettings.pcieInferenceStrategy);
    pcieInference.insert("fixed_roi_enabled", false);
    pcieInference.insert("pcie_sliding_enabled", false);
    pcieInference.insert(
        "calls_per_cycle",
        pcieFourSourceView && runtimeSettings.pcieInferenceStrategy == 1
            ? 4 : 1);
    pcieInference.insert("pipeline_enabled",
                         runtimeSettings.detPipelineEnabled);
    pcieInference.insert("preprocess_backend_configured",
                         runtimeSettings.detPreprocessBackend);
    pcieInference.insert("rga_compiled", yolo_rga_available());
    pcieInference.insert("quantized_output",
                         yolo_current_detector_profile() == 0 &&
                             runtimeSettings.detQuantizedOutput);
    pcieInference.insert("source_count", 4);
    pcieInference.insert("active_source_count", pcieFourSourceView ? 4 : 1);
    pcieInference.insert("source_mask", pcieFourSourceView ? 0x0f : 0x01);
    pcieInference.insert("source_layout", "2x2");
    pcieInference.insert("inference_unit", "source");
    pcieInference.insert("source_frame_width", 640);
    pcieInference.insert("source_frame_height", 360);
    pcieInference.insert("source_frame_format", "BGR888");
    pcieInference.insert("source_indices", QJsonArray{1, 2, 3, 4});
    pcieInference.insert("sliding_disabled_for_pcie", true);
    pcieInference.insert("source_width", 640);
    pcieInference.insert("source_height", 360);
    pcieInference.insert("mosaic_width", 1280);
    pcieInference.insert("mosaic_height", 720);
    pcieInference.insert("model_input_width",
                         yolo_current_detector_input_width());
    pcieInference.insert("model_input_height",
                         yolo_current_detector_input_height());
    pcieInference.insert("detector_profile",
                         yolo_current_detector_profile_key());
    pcieInference.insert("detector_family",
                         yolo_current_detector_family());
    pcieInference.insert("detector_output_contract",
                         yolo_current_detector_output_contract());
    pcieInference.insert("detector_runtime", detRuntime);
    pcieInference.insert("single_pass_letterbox", mosaicLetterbox);
    pcieInference.insert("per_source_letterbox", sourceLetterbox);
    o.insert("pcie_plate_inference", pcieInference);
    o.insert("pcie_four_source_sliding_configured", false);
    o.insert("pcie_four_source_fixed_roi_enabled", false);
    o.insert("pcie_inference_strategy_configured",
             runtimeSettings.pcieInferenceStrategy);
    o.insert("pcie_plate_inference_strategy", detectorStrategy);
    o.insert("plate_inference_strategy", detRuntime.value("strategy"));
    o.insert("plate_inference_enabled",
             detRuntime.value("inference_enabled"));
    o.insert("plate_display_only", detRuntime.value("display_only"));
    o.insert("plate_inference_pipeline_enabled", detRuntime.value("pipeline_enabled"));
    o.insert("plate_inference_pipeline_active", detRuntime.value("pipeline_active"));
    o.insert("plate_preprocess_backend", detRuntime.value("preprocess_backend"));
    o.insert("plate_preprocess_requested", detRuntime.value("preprocess_requested"));
    o.insert("plate_preprocess_fallback_reason", detRuntime.value("preprocess_fallback_reason"));
    o.insert("plate_det_quantized_output", detRuntime.value("quantized_output"));
    o.insert("plate_inference_calls_per_cycle", detRuntime.value("task_count"));
    o.insert("perf_det_pre_ms", detRuntime.value("pre_ms"));
    o.insert("perf_det_npu_wall_ms", detRuntime.value("npu_wall_ms"));
    o.insert("perf_det_npu_hw_ms", detRuntime.value("npu_hw_ms"));
    o.insert("perf_det_post_ms", detRuntime.value("post_ms"));
    o.insert("perf_det_e2e_ms", detRuntime.value("e2e_ms"));
    o.insert("perf_det_overlap_saved_ms", detRuntime.value("overlap_saved_ms"));
    o.insert("perf_det_worker_ms", detRuntime.value("worker_ms"));
    o.insert("perf_det_overlay_ms", detRuntime.value("overlay_ms"));
    o.insert("perf_det_task_fps", detRuntime.value("task_fps"));
    o.insert("perf_det_cycle_fps", detRuntime.value("cycle_fps"));
    o.insert("perf_det_fps_basis", detRuntime.value("fps_basis"));
    o.insert("perf_det_fps_window_ms", detRuntime.value("fps_window_ms"));
    o.insert("plate_infer_configured_stride",
             detRuntime.value("configured_stride"));
    o.insert("plate_source_frame_sequence",
             detRuntime.value("source_frame_sequence"));
    o.insert("plate_last_detection_source_sequence",
             detRuntime.value("last_detection_source_sequence"));
    o.insert("perf_det_result_age_ms", detRuntime.value("result_age_ms"));
    o.insert("perf_det_task_count", detRuntime.value("task_count"));
    o.insert("perf_det_score_candidates",
             detRuntime.value("score_candidates"));
    o.insert("perf_det_decoded_candidates",
             detRuntime.value("decoded_candidates"));
    o.insert("perf_det_final_candidates",
             detRuntime.value("final_candidates"));
    o.insert("perf_det_queue_depth", detRuntime.value("queue_depth"));
    o.insert("perf_det_dropped_tasks", detRuntime.value("dropped_tasks"));
    o.insert("plate_capture_async", detRuntime.value("capture_async"));
    o.insert("plate_latest_only", detRuntime.value("latest_only"));
    o.insert("plate_overlay_max_age_ms",
             detRuntime.value("overlay_max_age_ms"));
    o.insert("perf_display_cycle_ms", detRuntime.value("display_cycle_ms"));
    o.insert("perf_display_fps", detRuntime.value("display_fps"));
    o.insert("perf_capture_dropped_frames",
             detRuntime.value("capture_dropped_frames"));
    const DriverStatusSnapshot driverStatus = collectDriverStatus(&m_driverStatusState);
    o.insert("driver_status", driverStatus.json);
    o.insert("pcie_dma_memory", driverStatus.json.value("dma_memory"));
    const QJsonValue captureMetricsValue = driverStatus.json.value("capture_metrics");
    o.insert("driver_capture_metrics", captureMetricsValue);
    if (captureMetricsValue.isObject()) {
        const QJsonObject cm = captureMetricsValue.toObject();
        o.insert("pcie_protocol", cm.value("protocol"));
        o.insert("pcie_driver_abi_version", cm.value("driver_abi_version"));
        o.insert("pcie_driver_features", cm.value("driver_features"));
        o.insert("pcie_fpga_protocol_version", cm.value("fpga_protocol_version"));
        o.insert("pcie_fpga_capabilities", cm.value("fpga_capabilities"));
        o.insert("pcie_target_fps_milli", cm.value("target_fps_milli"));
        o.insert("pcie_fpga_target_fps_milli", cm.value("fpga_target_fps_milli"));
        o.insert("pcie_bar0_read_bytes", cm.value("bar0_read_bytes"));
        o.insert("pcie_bar1_write_bytes", cm.value("bar1_write_bytes"));
        o.insert("pcie_bar_contract_ok", cm.value("bar_contract_ok"));
        o.insert("pcie_interrupt_mode", cm.value("interrupt_mode"));
        o.insert("pcie_source_mask", cm.value("source_mask"));
        o.insert("pcie_all_four_sources_valid", cm.value("all_four_sources_valid"));
        o.insert("pcie_rate_control_supported", cm.value("rate_control_supported"));
        o.insert("pcie_fixed_30fps_active", cm.value("fixed_30fps_active"));
        o.insert("pcie_v1_fallback_allowed", cm.value("v1_fallback_allowed"));
        o.insert("pcie_v1_fallback_active", cm.value("v1_fallback_active"));
        o.insert("pcie_source_locked", cm.value("source_locked"));
        o.insert("pcie_recovery_count", cm.value("recovery_count"));
        o.insert("pcie_consecutive_timeouts", cm.value("consecutive_timeouts"));
        o.insert("pcie_recovery_state", cm.value("recovery_state"));
        o.insert("pcie_rx_fps", cm.value("actual_rx_fps"));
        o.insert("pcie_frame_interval_ms", cm.value("frame_interval_ms"));
        o.insert("pcie_dma_ms", cm.value("dma_transfer_ms"));
        o.insert("pcie_dma_wait_ms", cm.value("dma_wait_ms"));
        o.insert("pcie_kernel_staging_ms", cm.value("kernel_staging_ms"));
        o.insert("pcie_user_copy_ms", cm.value("user_copy_ms"));
        o.insert("pcie_batch_ioctl", cm.value("batch_ioctl"));
        o.insert("pcie_staged_copy", cm.value("staged_copy"));
        o.insert("pcie_irq_wait", cm.value("irq_wait"));
        if (cm.contains("batch_fallback_reason")) {
            o.insert("pcie_batch_fallback_reason", cm.value("batch_fallback_reason"));
        }
        if (cm.contains("irq_fallback_reason")) {
            o.insert("pcie_irq_fallback_reason", cm.value("irq_fallback_reason"));
        }
        o.insert("pcie_protocol_errors", cm.value("protocol_errors"));
        o.insert("pcie_rx_frames", cm.value("frames_total"));
        o.insert("pcie_dropped_frames", cm.value("dropped_frames"));
    }
    o.insert("driver", driverStatus.json.value("mounted").toBool(false) ? "mounted" : "not_mounted");
    o.insert("pcie_driver_mounted", driverStatus.json.value("mounted").toBool(false));
    if (m_backendClient) {
        const QJsonObject backendStatus = m_backendClient->statusJson();
        for (auto it = backendStatus.begin(); it != backendStatus.end(); ++it) {
            o.insert(it.key(), it.value());
        }
    }
    if (m_apiServer) {
        o.insert("rk_api_listening", m_apiServer->isListening());
        o.insert("rk_api_port", (int)m_apiServer->port());
        o.insert("rk_api_bind", m_apiServer->serverAddress());
        o.insert("rk_api_error", m_apiServer->errorString());
    }
    if (m_vehicleClient) {
        const QJsonObject vehicleStatus = m_vehicleClient->statusJson();
        for (auto it = vehicleStatus.begin(); it != vehicleStatus.end(); ++it) {
            o.insert(it.key(), it.value());
        }
    }
    o.insert("time_bj", QDateTime::currentDateTime().toString("yyyy-MM-dd HH:mm:ss"));
    m_backendClient->postJson("/api/rk/report/status", o);
}

void UserWindow::postUserMessage(const QJsonObject &payload) {
    if (!m_backendClient) return;
    m_backendClient->postJson("/api/rk/report/user-message", payload);
}

void UserWindow::postBusinessSnapshot() {
    if (!m_backendClient) return;
    m_backendClient->postJson("/api/rk/report/business", m_store.buildBizReport());
}

void UserWindow::onPlateReport(QImage thumb, QString plate, QString color, QString time, int source, double recConf, double detConf) {
    if (plate.trimmed().isEmpty()) return;
    const QString targetDeviceId = currentTargetDeviceId();
    const PlateCategoryInfo plateCategory = classifyPlateCategory(plate, color);

    if (m_backendClient) {
        QJsonObject plateEvent;
        plateEvent.insert("device", "rk3568");
        plateEvent.insert("role", "user");
        plateEvent.insert("time_bj", time);
        plateEvent.insert("source", QString("src%1").arg(source));
        plateEvent.insert("source_index", source);
        plateEvent.insert("plate", plate);
        plateEvent.insert("color", color);
        insertPlateCategoryFields(plateEvent, plate, plateCategory);
        plateEvent.insert("det_conf", detConf);
        plateEvent.insert("rec_conf", recConf);
        plateEvent.insert("conf", recConf);
        plateEvent.insert("input_mode", m_inputMode == CaptureThread::InputMode::SdCard ? "sdcard" : "pcie");
        plateEvent.insert("event_schema", "rk3568_plate_event_v2");
        plateEvent.insert("detector_model_name",
                          QFileInfo(QString::fromLocal8Bit(yolo_detection_model_path())).fileName());
        plateEvent.insert("detector_profile",
                          yolo_current_detector_profile_key());
        plateEvent.insert("detector_profile_id",
                          yolo_current_detector_profile());
        plateEvent.insert("detector_family",
                          yolo_current_detector_family());
        plateEvent.insert("detector_output_contract",
                          yolo_current_detector_output_contract());
        plateEvent.insert("detector_runtime_backend", "cpp_rknn_npu");
        plateEvent.insert("recognizer_model_name",
                          QFileInfo(QString::fromLocal8Bit(yolo_recognition_model_path())).fileName());
        plateEvent.insert("recognizer_profile",
                          yolo_current_recognizer_profile_key());
        plateEvent.insert("recognizer_profile_id",
                          yolo_current_recognizer_profile());
        plateEvent.insert("recognizer_output_contract",
                          yolo_current_recognizer_output_contract());
        plateEvent.insert("recognizer_input_width",
                          yolo_current_recognizer_input_width());
        plateEvent.insert("recognizer_input_height",
                          yolo_current_recognizer_input_height());
        plateEvent.insert("recognizer_input_format",
                          yolo_current_recognizer_input_format());
        plateEvent.insert("recognizer_model_input_type",
                          yolo_current_recognizer_model_input_type());
        plateEvent.insert("recognizer_text_layout",
                          yolo_current_recognizer_text_layout());
        plateEvent.insert("recognizer_runtime_backend", "cpp_rknn_npu");
        plateEvent.insert("model_input_width",
                          yolo_current_detector_input_width());
        plateEvent.insert("model_input_height",
                          yolo_current_detector_input_height());
        plateEvent.insert("model_input_format", "RGB888");
        plateEvent.insert("inference_strategy",
                          m_lastDetRuntimeMetrics.value("strategy").toString());
        plateEvent.insert("inference_task_count",
                          m_lastDetRuntimeMetrics.value("task_count"));
        plateEvent.insert("inference_pipeline_active",
                          m_lastDetRuntimeMetrics.value("pipeline_active"));
        plateEvent.insert("inference_capture_async",
                          m_lastDetRuntimeMetrics.value("capture_async"));
        plateEvent.insert("inference_latest_only",
                          m_lastDetRuntimeMetrics.value("latest_only"));
        plateEvent.insert("inference_queue_depth",
                          m_lastDetRuntimeMetrics.value("queue_depth"));
        plateEvent.insert("inference_dropped_tasks",
                          m_lastDetRuntimeMetrics.value("dropped_tasks"));
        plateEvent.insert("inference_result_age_ms",
                          m_lastDetRuntimeMetrics.value("result_age_ms"));
        plateEvent.insert("display_fps",
                          m_lastDetRuntimeMetrics.value("display_fps"));
        plateEvent.insert("inference_pre_ms", m_lastDetRuntimeMetrics.value("pre_ms"));
        plateEvent.insert("inference_npu_ms", m_lastDetRuntimeMetrics.value("npu_wall_ms"));
        plateEvent.insert("inference_post_ms", m_lastDetRuntimeMetrics.value("post_ms"));
        plateEvent.insert("inference_score_candidates",
                          m_lastDetRuntimeMetrics.value("score_candidates"));
        plateEvent.insert("inference_decoded_candidates",
                          m_lastDetRuntimeMetrics.value("decoded_candidates"));
        plateEvent.insert("inference_final_candidates",
                          m_lastDetRuntimeMetrics.value("final_candidates"));
        plateEvent.insert("source_frame_width", m_inputMode == CaptureThread::InputMode::Pcie ? 640 : 0);
        plateEvent.insert("source_frame_height", m_inputMode == CaptureThread::InputMode::Pcie ? 360 : 0);
        plateEvent.insert("source_frame_format", "BGR888");
        plateEvent.insert("source_layout", m_inputMode == CaptureThread::InputMode::Pcie ? "2x2" : "single");
        plateEvent.insert("source_mask", m_inputMode == CaptureThread::InputMode::Pcie ? 0x0f : 0x01);
        plateEvent.insert("pcie_sliding_enabled", false);
        if (m_inputMode == CaptureThread::InputMode::SdCard && !m_sdSourcePath.isEmpty()) {
            plateEvent.insert("sd_source_path", m_sdSourcePath);
        }
        if (!targetDeviceId.isEmpty()) plateEvent.insert("target_device_id", targetDeviceId);

        int uploadThumb = 1;
        if (const char *s = std::getenv("RK3568_PLATE_UPLOAD_THUMB")) uploadThumb = std::atoi(s);
        if (uploadThumb != 0 && !thumb.isNull()) {
            QByteArray bytes;
            QBuffer buffer(&bytes);
            buffer.open(QIODevice::WriteOnly);
            thumb.save(&buffer, "JPG", 80);
            if (!bytes.isEmpty()) {
                plateEvent.insert("thumb_jpeg_base64", QString::fromLatin1(bytes.toBase64()));
            }
        }
        m_backendClient->postJson("/api/rk/report/plate", plateEvent);
    }

    if (m_onlyPage == SystemPage::Etc) {
        auto out = m_store.onEtcPlate(plate, time, source);
        postBusinessSnapshot();
        QString templateKey;
        const QString msg = showEtcMessage(out, &templateKey);
        if (!msg.isEmpty()) {
            if (m_ttsPlayer) m_ttsPlayer->enqueueByTemplate("etc", templateKey, out.plate, out.fee, out.needPay);
            QJsonObject o;
            o.insert("device", "rk3568");
            o.insert("role", "user");
            o.insert("user_state", "normal");
            o.insert("biz_system", "etc");
            o.insert("event_type", "etc_pass");
            o.insert("template_key", templateKey);
            o.insert("template_version", m_userMessageConfig.version());
            o.insert("config_version", m_userMessageConfig.version());
            o.insert("display_text", msg);
            o.insert("broadcast_text", msg);
            o.insert("time_bj", time);
            o.insert("source", QString("src%1").arg(source));
            o.insert("source_index", source);
            o.insert("plate", out.plate);
            o.insert("color", color);
            insertPlateCategoryFields(o, out.plate, plateCategory);
            o.insert("det_conf", detConf);
            o.insert("rec_conf", recConf);
            o.insert("conf", recConf);
            if (!targetDeviceId.isEmpty()) o.insert("target_device_id", targetDeviceId);
            o.insert("pay_status", payStatusCode(out.payStatus, out.fee));
            o.insert("fee", out.fee);
            o.insert("paid_from_balance", out.paidFromBalance);
            o.insert("need_pay", out.needPay);
            o.insert("balance_after", out.balanceAfter);
            o.insert("arrears_after", out.arrearsAfter);
            postUserMessage(o);
        }
    } else {
        auto out = m_store.onParkingPlate(plate, time, source);
        postBusinessSnapshot();
        QString templateKey;
        const QString msg = showParkingMessage(out, &templateKey);
        if (!msg.isEmpty()) {
            if (m_ttsPlayer) m_ttsPlayer->enqueueByTemplate("parking", templateKey, out.plate, out.fee, out.needPay);
            QJsonObject o;
            o.insert("device", "rk3568");
            o.insert("role", "user");
            o.insert("user_state", "normal");
            o.insert("biz_system", "parking");
            o.insert("event_type", out.type == UserBusinessStore::ParkingEventType::Entry ? "parking_entry" : "parking_exit");
            o.insert("template_key", templateKey);
            o.insert("template_version", m_userMessageConfig.version());
            o.insert("config_version", m_userMessageConfig.version());
            o.insert("display_text", msg);
            o.insert("broadcast_text", msg);
            o.insert("time_bj", time);
            o.insert("source", QString("src%1").arg(source));
            o.insert("source_index", source);
            o.insert("plate", out.plate);
            o.insert("color", color);
            insertPlateCategoryFields(o, out.plate, plateCategory);
            o.insert("det_conf", detConf);
            o.insert("rec_conf", recConf);
            o.insert("conf", recConf);
            if (!targetDeviceId.isEmpty()) o.insert("target_device_id", targetDeviceId);
            o.insert("duration_minutes", out.minutes);
            o.insert("duration_text", UserBusinessStore::formatDurationMinutes(out.minutes));
            o.insert("pay_status", payStatusCode(out.payStatus, out.fee));
            o.insert("fee", out.fee);
            o.insert("paid_from_balance", out.paidFromBalance);
            o.insert("need_pay", out.needPay);
            o.insert("balance_after", out.balanceAfter);
            o.insert("arrears_after", out.arrearsAfter);
            postUserMessage(o);
        }
    }
    postStatus(false);
}

void UserWindow::onTabChanged(int index) {
    (void)index;
    if (m_onlyPage == SystemPage::Etc) {
        if (m_etcViewModeBox) handleViewModeChanged(m_etcViewModeBox->currentIndex());
        return;
    }
    if (m_parkingViewModeBox) handleViewModeChanged(m_parkingViewModeBox->currentIndex());
}

void UserWindow::requestSwitchAccount() {
    if (m_isCapturing && m_captureThread) {
        m_captureThread->stop();
        m_captureThread->wait(500);
        m_isCapturing = false;
        if (m_controlBtn) m_controlBtn->setText("开始采集");
    }
    postStatus(true);
    emit switchAccountRequested();
}
