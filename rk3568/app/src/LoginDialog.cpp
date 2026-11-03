#include "LoginDialog.h"
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QPushButton>
#include <QCheckBox>
#include <QComboBox>
#include <QCryptographicHash>
#include <QRandomGenerator>
#include <QStandardPaths>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QSaveFile>
#include <QJsonDocument>
#include <QJsonObject>

namespace {
const QString kLoginUsername = QStringLiteral("我们能拿奖");
}

LoginDialog::LoginDialog(QWidget *parent) : QDialog(parent),
    m_appName(nullptr),
    m_modeTitle(nullptr),
    m_userLabel(nullptr),
    m_hint(nullptr),
    m_roleBox(nullptr),
    m_systemRowWidget(nullptr),
    m_systemBox(nullptr),
    m_accountEdit(nullptr),
    m_pass1(nullptr),
    m_pass2(nullptr),
    m_pass3(nullptr),
    m_show(nullptr),
    m_primary(nullptr),
    m_reset(nullptr),
    m_cancel(nullptr),
    m_mode(Mode::Login) {

    setWindowTitle("用户登录");
    setModal(true);
    setFixedWidth(420);
    setStyleSheet(
        "QDialog{background:#121212;color:#ffffff;}"
        "QLabel{color:#ffffff;}"
        "QLineEdit{background:#1f1f1f;color:#ffffff;border:1px solid #333;border-radius:4px;padding:8px;}"
        "QPushButton{background:#2a2a2a;color:#ffffff;border:1px solid #3a3a3a;border-radius:4px;padding:6px 12px;}"
        "QPushButton:hover{background:#333;}"
        "QCheckBox{color:#ffffff;}"
    );

    QVBoxLayout *main = new QVBoxLayout(this);
    main->setContentsMargins(16, 16, 16, 16);
    main->setSpacing(10);

    m_appName = new QLabel("RK3568 PCIe 智能监控终端", this);
    QFont nameF = m_appName->font();
    nameF.setBold(true);
    nameF.setPixelSize(18);
    m_appName->setFont(nameF);

    m_modeTitle = new QLabel(this);
    QFont modeF = m_modeTitle->font();
    modeF.setBold(true);
    modeF.setPixelSize(14);
    m_modeTitle->setFont(modeF);

    m_userLabel = new QLabel(QString("统一用户名：%1").arg(kLoginUsername), this);

    m_hint = new QLabel(this);
    m_hint->setStyleSheet("color: rgba(255,255,255,180);");
    m_hint->setWordWrap(true);

    QLabel *roleLabel = new QLabel("登录：", this);
    m_roleBox = new QComboBox(this);
    m_roleBox->addItem("普通用户");
    m_roleBox->addItem("管理员");
    m_roleBox->addItem("开发者");
    m_roleBox->setCurrentIndex(0);
    QHBoxLayout *roleRow = new QHBoxLayout();
    roleRow->addWidget(roleLabel);
    roleRow->addWidget(m_roleBox, 1);
    connect(m_roleBox, qOverload<int>(&QComboBox::currentIndexChanged), this, &LoginDialog::onRoleChanged);

    m_systemRowWidget = new QWidget(this);
    QHBoxLayout *sysRow = new QHBoxLayout(m_systemRowWidget);
    sysRow->setContentsMargins(0, 0, 0, 0);
    QLabel *sysLabel = new QLabel("系统：", m_systemRowWidget);
    m_systemBox = new QComboBox(m_systemRowWidget);
    m_systemBox->addItem("停车场系统");
    m_systemBox->addItem("ETC系统");
    m_systemBox->setCurrentIndex(0);
    sysRow->addWidget(sysLabel);
    sysRow->addWidget(m_systemBox, 1);

    m_accountEdit = new QLineEdit(this);
    m_accountEdit->setPlaceholderText("用户名");

    m_pass1 = new QLineEdit(this);
    m_pass1->setEchoMode(QLineEdit::Password);
    m_pass1->setPlaceholderText("密码");

    m_pass2 = new QLineEdit(this);
    m_pass2->setEchoMode(QLineEdit::Password);
    m_pass2->setPlaceholderText("确认密码");

    m_pass3 = new QLineEdit(this);
    m_pass3->setEchoMode(QLineEdit::Password);
    m_pass3->setPlaceholderText("确认新密码");

    m_show = new QCheckBox("显示密码", this);
    connect(m_show, &QCheckBox::stateChanged, this, &LoginDialog::onToggleShow);

    QHBoxLayout *btns = new QHBoxLayout();
    m_primary = new QPushButton(this);
    m_primary->setFixedWidth(110);
    m_reset = new QPushButton("重置密码", this);
    m_reset->setFixedWidth(90);
    m_cancel = new QPushButton("退出", this);
    m_cancel->setFixedWidth(90);
    btns->addWidget(m_reset);
    btns->addStretch();
    btns->addWidget(m_primary);
    btns->addWidget(m_cancel);

    connect(m_primary, &QPushButton::clicked, this, &LoginDialog::onPrimary);
    connect(m_reset, &QPushButton::clicked, this, &LoginDialog::onEnterReset);
    connect(m_cancel, &QPushButton::clicked, this, &QDialog::reject);
    connect(m_pass1, &QLineEdit::returnPressed, this, &LoginDialog::onPrimary);
    connect(m_pass2, &QLineEdit::returnPressed, this, &LoginDialog::onPrimary);
    connect(m_pass3, &QLineEdit::returnPressed, this, &LoginDialog::onPrimary);
    connect(m_accountEdit, &QLineEdit::returnPressed, this, &LoginDialog::onPrimary);

    main->addWidget(m_appName);
    main->addWidget(m_modeTitle);
    main->addWidget(m_userLabel);
    main->addWidget(m_hint);
    main->addLayout(roleRow);
    main->addWidget(m_systemRowWidget);
    main->addWidget(m_accountEdit);
    main->addWidget(m_pass1);
    main->addWidget(m_pass2);
    main->addWidget(m_pass3);
    main->addWidget(m_show);
    main->addLayout(btns);

    ensureAuthFile();
    applyMode(Mode::Login);
    applyRoleUi(currentRole());
}

LoginDialog::System LoginDialog::selectedSystem() const {
    if (!m_systemBox) return System::Parking;
    return m_systemBox->currentIndex() == 1 ? System::Etc : System::Parking;
}

LoginDialog::Role LoginDialog::selectedRole() const {
    return currentRole();
}

bool LoginDialog::ensureAuthDir() {
    QString dirPath = authDir();
    if (dirPath.isEmpty()) return false;
    return QDir().mkpath(dirPath);
}

QString LoginDialog::authDir() const {
    const QByteArray envPath = qgetenv("RK3568_AUTH_PATH");
    if (!envPath.isEmpty()) {
        QFileInfo fi(QString::fromUtf8(envPath));
        return fi.absolutePath();
    }
    QString base = QStandardPaths::writableLocation(QStandardPaths::AppConfigLocation);
    return base;
}

QString LoginDialog::authPath() const {
    const QByteArray envPath = qgetenv("RK3568_AUTH_PATH");
    if (!envPath.isEmpty()) return QString::fromUtf8(envPath);
    QString base = QStandardPaths::writableLocation(QStandardPaths::AppConfigLocation);
    if (base.isEmpty()) return QString();
    return QDir(base).filePath("admin_auth.json");
}

QByteArray LoginDialog::hashPassword(const QByteArray& salt, const QString& password) const {
    QByteArray data = salt;
    data.append(password.toUtf8());
    return QCryptographicHash::hash(data, QCryptographicHash::Sha256);
}

bool LoginDialog::loadAuth(Cred &admin, Cred &user, Cred &dev) const {
    QFile f(authPath());
    if (!f.open(QFile::ReadOnly)) return false;
    QJsonObject obj = QJsonDocument::fromJson(f.readAll()).object();
    if (obj.isEmpty()) return false;

    if (obj.contains("version")) {
        QJsonObject a = obj.value("admin").toObject();
        QJsonObject u = obj.value("user").toObject();
        QJsonObject d = obj.value("dev").toObject();

        admin.username = a.value("username").toString();
        admin.salt = QByteArray::fromBase64(a.value("salt").toString().toUtf8());
        admin.hash = QByteArray::fromBase64(a.value("hash").toString().toUtf8());

        user.username = u.value("username").toString();
        user.salt = QByteArray::fromBase64(u.value("salt").toString().toUtf8());
        user.hash = QByteArray::fromBase64(u.value("hash").toString().toUtf8());

        dev.username = d.value("username").toString();
        dev.salt = QByteArray::fromBase64(d.value("salt").toString().toUtf8());
        dev.hash = QByteArray::fromBase64(d.value("hash").toString().toUtf8());

        return !admin.salt.isEmpty() && !admin.hash.isEmpty()
            && !user.salt.isEmpty() && !user.hash.isEmpty()
            && !dev.salt.isEmpty() && !dev.hash.isEmpty();
    }

    QByteArray legacySalt = QByteArray::fromBase64(obj.value("salt").toString().toUtf8());
    QByteArray legacyHash = QByteArray::fromBase64(obj.value("hash").toString().toUtf8());
    if (legacySalt.isEmpty() || legacyHash.isEmpty()) return false;
    admin.username.clear();
    admin.salt.clear();
    admin.hash.clear();
    user.username.clear();
    user.salt.clear();
    user.hash.clear();
    dev.username.clear();
    dev.salt = legacySalt;
    dev.hash = legacyHash;
    return true;
}

bool LoginDialog::saveAuth(const Cred &admin, const Cred &user, const Cred &dev) const {
    QString p = authPath();
    if (p.isEmpty()) return false;
    QSaveFile f(p);
    if (!f.open(QFile::WriteOnly | QFile::Truncate)) return false;
    QJsonObject obj;
    obj["version"] = 3;
    QJsonObject a;
    a["username"] = admin.username;
    a["salt"] = QString::fromUtf8(admin.salt.toBase64());
    a["hash"] = QString::fromUtf8(admin.hash.toBase64());
    obj["admin"] = a;

    QJsonObject u;
    u["username"] = user.username;
    u["salt"] = QString::fromUtf8(user.salt.toBase64());
    u["hash"] = QString::fromUtf8(user.hash.toBase64());
    obj["user"] = u;

    QJsonObject d;
    d["username"] = dev.username;
    d["salt"] = QString::fromUtf8(dev.salt.toBase64());
    d["hash"] = QString::fromUtf8(dev.hash.toBase64());
    obj["dev"] = d;
    f.write(QJsonDocument(obj).toJson(QJsonDocument::Compact));
    if (!f.commit()) return false;
    QFile::setPermissions(p, QFile::ReadOwner | QFile::WriteOwner);
    return true;
}

LoginDialog::Role LoginDialog::currentRole() const {
    if (!m_roleBox) return Role::User;
    int idx = m_roleBox->currentIndex();
    if (idx == 1) return Role::Admin;
    if (idx == 2) return Role::Developer;
    return Role::User;
}

void LoginDialog::ensureAuthFile() {
    if (!ensureAuthDir()) return;
    QString p = authPath();
    if (p.isEmpty()) return;

    Cred admin, user, dev;
    bool ok = loadAuth(admin, user, dev);

    if (!ok) {
        QByteArray legacySalt, legacyHash;
        QFile f(p);
        if (f.open(QFile::ReadOnly)) {
            QJsonObject obj = QJsonDocument::fromJson(f.readAll()).object();
            legacySalt = QByteArray::fromBase64(obj.value("salt").toString().toUtf8());
            legacyHash = QByteArray::fromBase64(obj.value("hash").toString().toUtf8());
        }

        auto mk = [this](const QString &pwd) -> Cred {
            Cred c;
            c.salt = QByteArray(16, Qt::Uninitialized);
            for (int i = 0; i < c.salt.size(); ++i) c.salt[i] = (char)QRandomGenerator::global()->generate();
            c.hash = hashPassword(c.salt, pwd);
            return c;
        };

        admin = mk("7777777");
        admin.username = kLoginUsername;
        user = mk("666666");
        user.username = kLoginUsername;
        dev = mk("7777777");
        dev.username = kLoginUsername;
        if (!legacySalt.isEmpty() && !legacyHash.isEmpty()) {
            dev.salt = legacySalt;
            dev.hash = legacyHash;
        }
        saveAuth(admin, user, dev);
        return;
    }

    bool nameChanged = false;
    if (admin.username != kLoginUsername) { admin.username = kLoginUsername; nameChanged = true; }
    if (user.username != kLoginUsername) { user.username = kLoginUsername; nameChanged = true; }
    if (dev.username != kLoginUsername) { dev.username = kLoginUsername; nameChanged = true; }
    if (admin.salt.isEmpty() || admin.hash.isEmpty() || user.salt.isEmpty() || user.hash.isEmpty() || dev.salt.isEmpty() || dev.hash.isEmpty()) {
        auto mk = [this](const QString &pwd) -> Cred {
            Cred c;
            c.salt = QByteArray(16, Qt::Uninitialized);
            for (int i = 0; i < c.salt.size(); ++i) c.salt[i] = (char)QRandomGenerator::global()->generate();
            c.hash = hashPassword(c.salt, pwd);
            return c;
        };
        if (admin.salt.isEmpty() || admin.hash.isEmpty()) { Cred a = mk("7777777"); a.username = kLoginUsername; admin = a; }
        if (user.salt.isEmpty() || user.hash.isEmpty()) { Cred u = mk("666666"); u.username = kLoginUsername; user = u; }
        if (dev.salt.isEmpty() || dev.hash.isEmpty()) { Cred d = mk("7777777"); d.username = kLoginUsername; dev = d; }
        saveAuth(admin, user, dev);
        return;
    }
    if (nameChanged) saveAuth(admin, user, dev);
}

void LoginDialog::applyMode(Mode mode) {
    m_mode = mode;
    m_pass1->clear();
    m_pass2->clear();
    m_pass3->clear();
    m_hint->setStyleSheet("color: rgba(255,255,255,180);");

    if (mode == Mode::Login) {
        m_modeTitle->setText("登录");
        m_hint->setText(QString("请选择登录身份，用户名统一为“%1”。").arg(kLoginUsername));
        m_primary->setText("登录");
        m_pass1->setPlaceholderText("密码");
        m_pass2->setVisible(false);
        m_pass3->setVisible(false);
        m_reset->setVisible(true);
        m_pass1->setFocus();
        return;
    }

    m_modeTitle->setText("重置密码");
    m_hint->setText("需要输入当前密码才允许重置。");
    m_primary->setText("确认重置");
    m_pass1->setPlaceholderText("当前密码");
    m_pass2->setPlaceholderText("新密码");
    m_pass3->setPlaceholderText("确认新密码");
    m_pass2->setVisible(true);
    m_pass3->setVisible(true);
    m_reset->setVisible(false);
    m_pass1->setFocus();
}

void LoginDialog::applyRoleUi(Role role) {
    if (m_systemRowWidget) m_systemRowWidget->setVisible(true);
    if (m_accountEdit) m_accountEdit->setVisible(true);
    if (m_accountEdit) {
        m_accountEdit->setText(kLoginUsername);
        if (role == Role::Admin) m_accountEdit->setPlaceholderText("管理员用户名");
        else if (role == Role::Developer) m_accountEdit->setPlaceholderText("开发者用户名");
        else m_accountEdit->setPlaceholderText("普通用户用户名");
    }

    if (m_mode == Mode::Login) {
        if (role == Role::Admin) m_pass1->setPlaceholderText("管理员密码");
        else if (role == Role::Developer) m_pass1->setPlaceholderText("开发者密码");
        else m_pass1->setPlaceholderText("普通用户密码");
    } else {
        m_pass1->setPlaceholderText("当前密码");
    }
}

void LoginDialog::onToggleShow(int state) {
    auto mode = state ? QLineEdit::Normal : QLineEdit::Password;
    m_pass1->setEchoMode(mode);
    m_pass2->setEchoMode(mode);
    m_pass3->setEchoMode(mode);
}

void LoginDialog::onEnterReset() {
    applyMode(Mode::Reset);
    applyRoleUi(currentRole());
}

void LoginDialog::onRoleChanged(int) {
    applyRoleUi(currentRole());
}

void LoginDialog::onPrimary() {
    if (!ensureAuthDir()) return;

    const QString p1 = m_pass1->text();
    const QString p2 = m_pass2->text();
    const QString p3 = m_pass3->text();

    Cred admin, user, dev;
    if (!loadAuth(admin, user, dev)) {
        ensureAuthFile();
        if (!loadAuth(admin, user, dev)) {
            const QString path = authPath();
            const QFileInfo info(path);
            m_hint->setStyleSheet("color:#ff5a5a;");
            if (info.exists() && !info.isReadable()) {
                m_hint->setText(QString("认证文件无读取权限：%1").arg(path));
            } else if (info.exists()) {
                m_hint->setText(QString("认证文件格式损坏：%1").arg(path));
            } else {
                m_hint->setText(QString("认证文件缺失且无法创建：%1").arg(path));
            }
            return;
        }
    }
    admin.username = kLoginUsername;
    user.username = kLoginUsername;
    dev.username = kLoginUsername;

    Role role = currentRole();
    Cred *target = nullptr;
    if (role == Role::Admin) target = &admin;
    else if (role == Role::Developer) target = &dev;
    else target = &user;

    if (m_mode == Mode::Login) {
        const QString account = m_accountEdit ? m_accountEdit->text().trimmed() : QString();
        if (account.isEmpty()) { m_hint->setStyleSheet("color:#ff5a5a;"); m_hint->setText("请输入用户名。"); return; }
        if (account != kLoginUsername) { m_hint->setStyleSheet("color:#ff5a5a;"); m_hint->setText("用户名错误。"); return; }

        QByteArray h = hashPassword(target->salt, p1);
        if (h != target->hash) { m_hint->setStyleSheet("color:#ff5a5a;"); m_hint->setText("密码错误。"); return; }
        accept();
        return;
    }

    QByteArray cur = hashPassword(target->salt, p1);
    if (cur != target->hash) { m_hint->setStyleSheet("color:#ff5a5a;"); m_hint->setText("当前密码错误。"); return; }
    if (p2.size() < 6) { m_hint->setStyleSheet("color:#ff5a5a;"); m_hint->setText("新密码长度至少 6 位。"); return; }
    if (p2 != p3) { m_hint->setStyleSheet("color:#ff5a5a;"); m_hint->setText("两次输入的新密码不一致。"); return; }

    QByteArray newSalt(16, Qt::Uninitialized);
    for (int i = 0; i < newSalt.size(); ++i) newSalt[i] = (char)QRandomGenerator::global()->generate();
    QByteArray newHash = hashPassword(newSalt, p2);
    target->salt = newSalt;
    target->hash = newHash;
    admin.username = kLoginUsername;
    user.username = kLoginUsername;
    dev.username = kLoginUsername;
    if (!saveAuth(admin, user, dev)) { m_hint->setStyleSheet("color:#ff5a5a;"); m_hint->setText("保存失败，请检查文件权限。"); return; }
    m_hint->setText("密码已更新，请重新登录。");
    applyMode(Mode::Login);
    applyRoleUi(currentRole());
}

