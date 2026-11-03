# 上传进度说明

五部分源码已上传。红绿灯权重 `traffic_rk3568_fp16.rknn` 仍在补传；最终校验清单将在完整发布时提供。下方是完整交付的来源说明，当前缺失项以上述进度为准。

# 智能驾驶全链路源码归档（2026-11-03）

包含 FPGA、小车、上位机、云服务器，以及连接它们的 RK3568 板端程序。
这是按来源分级的源码归档：**云端为本次在线抓取；RK 本次连接超时，不能将整个仓库称为五端当前运行镜像。**

| 目录 | 内容 | 本次核验范围 |
| --- | --- | --- |
| `fpga/` | four_camera_fmc_j2 的 RTL、PDS、FDC、IP 依赖 | 本地最新工程归档，未核实芯片烧录版本；历史 bitstream 未作为新版本发布 |
| `car/` | ESP32 电机、指示灯、报警、WSS 控制源码 | 本地云端版源码，Wi-Fi/令牌改为私有配置模板；未读回车上固件 |
| `upper_computer/` | 当前网页、检测结果、通信日志及 Node 后端 | 本次从 adas.wmnnj.top 抓取，逐文件校验原始 SHA-256 |
| `cloud/` | relay、systemd、Nginx、MediaMTX、环境配置模板 | 本次从线上抓取；抓取时四个服务 active；凭据已脱敏 |
| `rk3568/` | Qt/C++ 采集、推理、解码、画框、上报；驱动、启动脚本、四套 RKNN | 本地正式源码及既往部署快照；板端当前哈希待重新连接核验 |
| `tests/` | 连续指令单元测试、隔离 HTTP/WSS 集成测试 | 模拟设备，不代表真实小车动作通过 |
| `docs/` | 来源、哈希、测试及待核验事项 | 以记录内容为准 |

## 链路

摄像头 → FPGA 四路采集/预处理 → PCIe → RK3568 采集、显示、RKNN 推理 → HTTPS 上报画面与结果 → 云端/上位机仲裁 → WSS → ESP32。
网页和后端保留原目录结构：`upper_computer/backend` 是网页的配套后端；`cloud/` 放服务器服务与配置，不是另一套独立仲裁实现。

## 归档的控制逻辑

- 稳定有效指令按当前指令类型持续刷新；短暂漏检保持上一指令。
- 黄色箭头按同方向绿色处理。
- ADAS 禁止方向保留箭头方向并显示红色，云端重复发送 H 报警；恢复允许后先 K 清警，再发送动作。
- 导航红色仍按普通 K 停车处理。
- 超过 10 秒没有遥测，云端发 K 停车；本次没有放宽该保护。
- 转弯/变道刷新间隔与 ESP32 分段路线配合，不是所有动作都以 500 ms 刷新；具体值见 `upper_computer/backend/rk-vision-command.js`。

## 本地查看上位机与运行测试

需要 Node.js 20 或更新版本；线上快照版本为 v20.20.2。

```powershell
cd upper_computer/backend
npm ci
npm run check
cd ../..
node upper_computer/tests/adas-policy.test.js
node upper_computer/tests/wifi-car-bridge.test.js
node tests/continuous_commands.test.js
node tests/cloud-integration.test.js
```

集成测试在 `127.0.0.1:18903` 启动独立进程并模拟 ESP32，测试结束退出。测试令牌为固定假数据。不要把测试配置用于真实设备。
查看网页可在 backend 目录执行 `npm start`，浏览器访问 `http://127.0.0.1:8080/adas.html`。设备接入需要填入自己的环境配置。

## 各端恢复

- FPGA：阅读 `fpga/README.md`；打开 PDS 后重新综合、布局布线并核实引脚，不能直接用历史输出代表最新源码。
- 小车：阅读 `car/README.md`；复制 `cloud_secrets.h.example` 为 `cloud_secrets.h` 后填写配置并编译。
- RK：阅读 `rk3568/README.md`；目前是待现场核对的源码归档，不能直接当成已验证的一键安装包。
- 云端：阅读 `cloud/README.md`；保留原机凭据、数据库和上传数据，配置示例不能覆盖生产配置。

## 已知缺口

1. RK `192.168.100.105` 本次 TCP/SSH 重连超时，未取得板端当前完整镜像或应用二进制。
2. 本地 RK 源码含 15 秒 HTTP 超时修正，但此前安装后持续遥测和界面恢复没有完成完整验证。
3. 历史 RK 启动脚本仍引用一个本地缺失的 split INT8 文件，未用其他权重冒名替代。导航 FP16 文件保留历史 w8a8 部署名，仍须核对板端哈希。
4. 本地 RK CMake 中有 12 个历史单元测试源文件缺失；应用 src/inc 文件引用齐全。当前构建应用需要 `-DBUILD_TESTING=OFF`，缺失测试清单见核验报告。没有为使归档看似完整而删改原 CMake。
5. FPGA 烧录内容、ESP32 固件版本、本轮实车动作均未现场验证。
6. 线上原有 `npm run test:adas` 中的 `adas-status.test.js` 只复制旧后端模块到临时目录，漏掉新增的 rk-vision-command、rk-command-loop、communication-log，当前启动超时。保留原测试文件供后续修复；本包新增的隔离完整后端测试已通过。

## 凭据、数据和第三方内容

不发布真实密码、设备令牌、私钥、登录配置、数据库、上传图片、运行日志、编译缓存或 node_modules。
RKNN 模型包含在 `rk3568/app/model/`；不包含训练数据集或历史车牌权重。
ESP32 的旧固件二进制可能含凭据，未发布；FPGA 历史输出不对应后续源码，未作为可烧录产物发布。
保留第三方文件原有声明；本次归档没有为第三方 IP、库或模型重新授予许可证。

`docs/FILE_PROVENANCE.json` 记录原始来源和交付哈希；`docs/CLOUD_SOURCE_SNAPSHOT.json` 记录线上原始文件哈希（脱敏前）；`SHA256SUMS.txt` 记录最终交付文件哈希。
