# RK3568 板端源码与权重

本次 SSH 连接 192.168.100.105 超时，以下内容来自本地正式源码和既往部署记录，并非本次从运行板完整读回的镜像。
`app/src`、`app/inc`、`app/tests`、CMakeLists.txt 来自 `rk_formal_source_20261024/app`。
BackendClient.cpp 已包含 15000 ms 默认 HTTP 超时；RoadInferenceWorker.cpp 已包含 ADAS 禁止时保留方向的修改。
驱动来自既有交付目录；两个启动脚本来自既往板端快照，其哈希与 11 月 3 日基线记录一致。当前板端仍需重新核验。

## 模型

ADAS 三个模型由 model_manifest_adas.json 记录文件、类别顺序和输出约定，本次已核对本地文件哈希。
导航模型采用 `_board_deploy_fp16.py` 指向的 FP16 新导出文件，部署名保留 `nav_video7_v4_rk3568_w8a8.rknn`；这个历史文件名不代表它是 INT8。本次未核实其与板端当前文件一致。
原始早期 W8A8 文件没有混入此交付。不要因文件名相同而忽略精度和输出属性。

## 恢复前需核对

这是源码归档，不能当作已核验的一键安装包。
1. 先从实际板端核对程序、模型、驱动和启动脚本 SHA-256，保留其现有运行配置。
2. 旧 run.sh 仍检查 `bdd100k_yolo11n_640_7class_split_rk3568_int8.rknn`；本地没有这个完全相同文件，因此未伪造或随意重命名另一权重。该启动依赖尚待板端核实。
3. `/userdata/rk3568/backend_config.json`、runtime_settings.json 和认证配置不随源码包发布；前者必须指向当前上位机并配置对应设备令牌。
4. 编译需要兼容的 aarch64 工具链或板端编译器、Qt5 Widgets/Gui/Core/Network、OpenCV、RKNN Runtime 开发文件以及匹配的 sysroot；可选 RGA，具体依赖以 CMakeLists.txt 为准。
5. 驱动需要与 RK 实际内核匹配的 headers；包内历史 ko 未在本轮验证，不能对任意内核直接替换。
6. 本次不包含板端应用二进制；最近 HTTP 超时修正的安装后持续上报与界面恢复验证没有完整完成，不标记为已解决。

启动入口和采集逻辑保持原源码，本次未在真实设备停止、重启或修改任何服务。
