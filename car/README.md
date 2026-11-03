# ESP32 小车

源码来自本地 `WifiCar_ESP32_Cloud`，使用 ESP32 Arduino Core 和 WebSockets 库（WebSocketsClient.h）。
将 `cloud_secrets.h.example` 复制为 `cloud_secrets.h`，填写 Wi-Fi 和设备令牌后编译。令牌须与云端 WIFICAR_DEVICE_TOKEN 相同。
真实 Wi-Fi 字符串已从 ino 移到私有配置；电机、路线、灯和报警处理逻辑未更改。
使用 Arduino IDE 选择实际 ESP32 板型和当前串口；本次未连接串口、未重新烧录，无法用该副本证明车上固件版本。
不发布旧编译固件，因为其可能嵌入 Wi-Fi 密码和设备令牌。
云端通过 WSS `adas.wmnnj.top:443/device/wifi-car` 连接；K 停车，H 停车并报警，P1–P6 为当前路线动作，具体参数以 ino 为准。
