#include <QApplication>
#include <QImageReader>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMessageBox>
#include <QPointer>
#include <QTextStream>
#include <QTimer>
#include <QtGlobal>
#include <exception>
#include <opencv2/imgproc.hpp>
#include "MainWindow.h"
#include "LoginDialog.h"
#include "UserWindow.h"
#include "RuntimeSettings.h"
#include "UiSizing.h"
#include "yolo.h"

namespace {

int evaluatePlateImage(const QString &path) {
    QJsonObject output;
    output.insert("image", path);

    QImageReader reader(path);
    reader.setAutoTransform(true);
    const QImage image = reader.read();
    if (image.isNull()) {
        output.insert("ok", false);
        output.insert("error", reader.errorString().trimmed());
        QTextStream(stdout) << QJsonDocument(output).toJson(QJsonDocument::Compact) << '\n';
        return 2;
    }

    const QImage rgb = image.convertToFormat(QImage::Format_RGB888);
    cv::Mat rgbMat(rgb.height(), rgb.width(), CV_8UC3,
                   const_cast<uchar *>(rgb.constBits()), rgb.bytesPerLine());
    cv::Mat bgr;
    cv::cvtColor(rgbMat, bgr, cv::COLOR_RGB2BGR);

    std::vector<PlateEvaluationResult> results;
    std::string error;
    const bool ok = yolo_evaluate_image(bgr, results, error);
    output.insert("ok", ok);
    output.insert("width", image.width());
    output.insert("height", image.height());
    output.insert("inference_strategy", "single_full_frame");
    output.insert("sliding_enabled", false);
    output.insert("model_call_count", 1);
    output.insert("detection_count", static_cast<int>(results.size()));

    int accepted = 0;
    QJsonArray detections;
    for (const PlateEvaluationResult &result : results) {
        if (result.ocr_accepted) ++accepted;
        QJsonObject item;
        item.insert("plate", QString::fromUtf8(result.plate_no.c_str()));
        item.insert("plate_type", result.plate_type_idx == 1 ? "double" : "single");
        item.insert("color", QString::fromUtf8(yolo_color_name(result.color_idx)));
        item.insert("det_conf", result.det_conf);
        item.insert("ocr_conf", result.ocr_conf);
        item.insert("ocr_accepted", result.ocr_accepted);
        item.insert("left", result.bbox_left);
        item.insert("top", result.bbox_top);
        item.insert("right", result.bbox_right);
        item.insert("bottom", result.bbox_bottom);
        item.insert("status", QString::fromLatin1(result.status.c_str()));
        item.insert("error", QString::fromLocal8Bit(result.error.c_str()));
        detections.append(item);
    }
    output.insert("ocr_accepted_count", accepted);
    output.insert("detections", detections);
    if (!error.empty()) output.insert("error", QString::fromLocal8Bit(error.c_str()));

    QTextStream stream(stdout);
    stream.setCodec("UTF-8");
    stream << QJsonDocument(output).toJson(QJsonDocument::Compact) << '\n';
    stream.flush();
    return ok ? 0 : 3;
}

} // namespace

class AppController : public QObject {
public:
    explicit AppController(QApplication &app) : QObject(nullptr), m_app(app) {
        m_app.setQuitOnLastWindowClosed(false);
    }

    void start() {
        // Embedded deployments can start directly in the operator window after
        // boot. The normal login flow remains the default unless the launcher
        // explicitly enables auto-login.
        const QByteArray autoLogin = qgetenv("RK3568_AUTO_LOGIN").trimmed();
        if (!autoLogin.isEmpty() && autoLogin != "0" && autoLogin != "false") {
            QTimer::singleShot(0, this, [this]() {
                showRoleWindow(LoginDialog::Role::Developer,
                               LoginDialog::System::Parking);
            });
            return;
        }
        QTimer::singleShot(0, this, [this]() { showLogin(); });
    }

private:
    void showLogin() {
        if (m_login) {
            m_login->show();
            m_login->raise();
            m_login->activateWindow();
            return;
        }

        m_switching = true;
        LoginDialog *login = new LoginDialog();
        m_login = login;
        login->setAttribute(Qt::WA_DeleteOnClose);
        login->setWindowModality(Qt::ApplicationModal);

        QWidget *previous = m_window.data();
        m_window = nullptr;
        if (previous) {
            previous->hide();
            previous->deleteLater();
        }

        connect(login, &QDialog::accepted, this, [this, login]() {
            const LoginDialog::Role role = login->selectedRole();
            const LoginDialog::System system = login->selectedSystem();
            if (m_login == login) m_login = nullptr;
            login->deleteLater();
            QTimer::singleShot(0, this, [this, role, system]() {
                showRoleWindow(role, system);
            });
        });
        connect(login, &QDialog::rejected, this, [this, login]() {
            if (m_login == login) m_login = nullptr;
            login->deleteLater();
            m_app.quit();
        });
        connect(login, &QObject::destroyed, this, [this, login]() {
            if (m_login == login) m_login = nullptr;
        });

        login->show();
        login->raise();
        login->activateWindow();
        m_switching = false;
    }

    void showRoleWindow(LoginDialog::Role role, LoginDialog::System system) {
        m_switching = true;
        try {
            if (role == LoginDialog::Role::User) {
                qputenv("RK3568_BUSINESS_PROFILE", QByteArray(
                    system == LoginDialog::System::Etc ? "etc" : "parking"));
                const UserWindow::SystemPage page =
                    system == LoginDialog::System::Etc
                        ? UserWindow::SystemPage::Etc
                        : UserWindow::SystemPage::Parking;
                UserWindow *window = new UserWindow(page);
                window->setWindowTitle("RK3568 智能驾驶视觉系统(普通用户)");
                connect(window, &UserWindow::switchAccountRequested,
                        this, [this]() { showLogin(); });
                attachWindow(window);
                return;
            }

            const MainWindow::BusinessSystem businessSystem =
                system == LoginDialog::System::Etc
                    ? MainWindow::BusinessSystem::Etc
                    : MainWindow::BusinessSystem::Parking;
            const bool developerMode = role == LoginDialog::Role::Developer;
            qputenv("RK3568_BUSINESS_PROFILE", QByteArray(
                system == LoginDialog::System::Etc ? "etc" : "parking"));
            MainWindow *window = new MainWindow(businessSystem, developerMode);
            if (developerMode) {
                window->setWindowTitle(businessSystem == MainWindow::BusinessSystem::Parking
                    ? "RK3568 智能驾驶视觉系统(开发者)"
                    : "RK3568 智能驾驶视觉系统(开发者)");
            } else {
                window->setWindowTitle(businessSystem == MainWindow::BusinessSystem::Parking
                    ? "RK3568 智能驾驶视觉系统(管理员)"
                    : "RK3568 智能驾驶视觉系统(管理员)");
            }
            connect(window, &MainWindow::switchAccountRequested,
                    this, [this]() { showLogin(); });
            attachWindow(window);
        } catch (const std::exception &error) {
            m_switching = false;
            QMessageBox::critical(nullptr, "启动失败",
                QString("主界面初始化失败：%1").arg(
                    QString::fromLocal8Bit(error.what())));
            showLogin();
        } catch (...) {
            m_switching = false;
            QMessageBox::critical(nullptr, "启动失败",
                                  "主界面初始化发生未知异常。");
            showLogin();
        }
    }

    void attachWindow(QWidget *w) {
        m_window = w;
        m_window->setAttribute(Qt::WA_DeleteOnClose);
        connect(m_window, &QObject::destroyed, this, [this]() {
            if (!m_switching && !m_login && !m_window) m_app.quit();
        });
        if (UiSizing::isCompact720(m_window)) {
            m_window->resize(UiSizing::availableGeometry(m_window).size());
            m_window->showMaximized();
        } else {
            UiSizing::fitWindow(m_window, QSize(1600, 900), 32);
            m_window->show();
        }
        m_switching = false;
    }

    QApplication &m_app;
    QPointer<QWidget> m_window;
    QPointer<LoginDialog> m_login;
    bool m_switching = false;
};

int main(int argc, char *argv[]) {
    const bool imageEvaluation = argc >= 3 &&
        QString::fromLocal8Bit(argv[1]) == "--plate-eval-image";
    if (imageEvaluation && qEnvironmentVariableIsEmpty("QT_QPA_PLATFORM")) {
        qputenv("QT_QPA_PLATFORM", "offscreen");
    }
    QApplication a(argc, argv);
    const RuntimeSettingsData runtimeSettings = loadRuntimeSettings();
    applyRuntimeSettingsToProcess(runtimeSettings);
    saveRuntimeSettings(runtimeSettings);
    if (imageEvaluation) {
        return evaluatePlateImage(QString::fromLocal8Bit(argv[2]));
    }
    AppController c(a);
    c.start();
    return a.exec();
}
