# 云服务器配置与恢复

线上来源：`adas.wmnnj.top`。快照记录见 `../docs/CLOUD_SOURCE_SNAPSHOT.json`。

| 仓库路径 | 服务器路径 |
| --- | --- |
| `../upper_computer/` | `/opt/adas-upper/html/` |
| `relay/` | `/opt/adas-relay/` |
| `config/systemd/` | `/etc/systemd/system/` |
| `config/nginx/` | `/etc/nginx/sites-available/` 并按需链接至 sites-enabled |
| `config/env/*.example` | 对应 `/etc/*.env`，填入真实值，权限 600 |
| `config/mediamtx.yml.example` | `/etc/mediamtx.yml` |

恢复前备份原服务器源码和配置。现有机器保留原 env、上传数据、数据库、证书与私钥，不用占位符覆盖。
源码复制后，在 `/opt/adas-upper/html/backend` 执行 `npm ci --omit=dev`、`npm run check`。
为 relay 创建 Python 虚拟环境，并安装 `relay/requirements.txt`。
MediaMTX 线上版本为 v1.21.2，服务使用 `/usr/local/bin/mediamtx`；该外部二进制不在源码包内。
Nginx 配置保留线上域名、端口和证书路径；迁移到新机器必须修改并准备相应证书。
配置完成后先运行 `nginx -t`，再 `systemctl daemon-reload`，按需启动服务。

设备认证：

- RK 检测上报令牌与 `RK_DETECTION_TOKEN` / `RK_VISION_TOKEN` 的实际接口配置一致。
- ESP32 使用 `WIFICAR_DEVICE_TOKEN`，经 WSS `/device/wifi-car` 接入。
- MediaMTX 发布/观看认证与 relay 的令牌独立配置，不相互替代。

服务 active 只证明进程状态；不等于 RK 正在持续上报或小车在线。本次打包没有重启或替换线上服务。
