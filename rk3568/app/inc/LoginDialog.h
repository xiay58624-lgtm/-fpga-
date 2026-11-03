#ifndef LOGIN_DIALOG_H
#define LOGIN_DIALOG_H

#include <QDialog>

class QLineEdit;
class QLabel;
class QPushButton;
class QCheckBox;
class QComboBox;
class QWidget;

class LoginDialog : public QDialog {
    Q_OBJECT
public:
    enum class System { Parking = 0, Etc = 1 };
    enum class Role { User = 0, Admin = 1, Developer = 2 };

    explicit LoginDialog(QWidget *parent = nullptr);
    System selectedSystem() const;
    Role selectedRole() const;

private slots:
    void onPrimary();
    void onToggleShow(int state);
    void onEnterReset();
    void onRoleChanged(int index);

private:
    enum class Mode { Login, Reset };

    bool ensureAuthDir();
    QString authDir() const;
    QString authPath() const;
    void ensureAuthFile();
    struct Cred {
        QString username;
        QByteArray salt;
        QByteArray hash;
    };
    bool loadAuth(Cred &admin, Cred &user, Cred &dev) const;
    bool saveAuth(const Cred &admin, const Cred &user, const Cred &dev) const;
    QByteArray hashPassword(const QByteArray& salt, const QString& password) const;
    void applyMode(Mode mode);
    Role currentRole() const;
    void applyRoleUi(Role role);

    QLabel *m_appName;
    QLabel *m_modeTitle;
    QLabel *m_userLabel;
    QLabel *m_hint;
    QComboBox *m_roleBox;
    QWidget *m_systemRowWidget;
    QComboBox *m_systemBox;
    QLineEdit *m_accountEdit;
    QLineEdit *m_pass1;
    QLineEdit *m_pass2;
    QLineEdit *m_pass3;
    QCheckBox *m_show;
    QPushButton *m_primary;
    QPushButton *m_reset;
    QPushButton *m_cancel;
    Mode m_mode;
};

#endif

