// ESP32 WiFi car controller with four route lamps and an alarm buzzer.
// Commands: A=forward, B=back, E=left, F=right, K=stop,
//           P1..P6=stored routes, H=alarm on, L/S/R=lamp test.

#include <WiFi.h>
#include <WebServer.h>
#include <WebSocketsClient.h>
#include "cloud_secrets.h"

// Motor-driver inputs, mapped from the old controller's D2..D9 wires.
// Use the ESP32 GPIO numbers printed on an ESP32-WROOM-32 DevKit board.
const uint8_t pinLA1 = 16;  // old D2 / motor input A1
const uint8_t pinLA2 = 17;  // old D3 / motor input A2
const uint8_t pinLB1 = 18;  // old D4 / motor input B1
const uint8_t pinLB2 = 19;  // old D5 / motor input B2
const uint8_t pinRC1 = 21;  // old D6 / motor input C1
const uint8_t pinRC2 = 22;  // old D7 / motor input C2
const uint8_t pinRD1 = 23;  // old D8 / motor input D1
const uint8_t pinRD2 = 25;  // old D9 / motor input D2

// Active-high 3.3 V control outputs for indicator modules.
const uint8_t pinLeftLamp = 26;
const uint8_t pinStraightLamp = 27;
const uint8_t pinRightLamp = 32;
const uint8_t pinAlarmLamp = 33;
const uint8_t pinBuzzer = 13;  // active-low module: LOW=on, HIGH=off

const char* wifiSsid = WIFICAR_WIFI_SSID;
const char* wifiPassword = WIFICAR_WIFI_PASSWORD;
const int MOTOR_SPEED = 150;
const int SPEED_LF = 145;
const int SPEED_LB = 145;
const int SPEED_RF = 150;
const int SPEED_RB = 150;
const unsigned long CMD_TIMEOUT = 300;

String command = "K";
String serialCommand = "";
String tcpCommand = "";
String routeName = "";
String lampTest = "";
// A direction signal stays selected for the requested time, then changes to
// the straight lamp until a new movement command arrives.
String timedSignal = "";
unsigned long timedSignalUntil = 0;
unsigned long lastCmdTime = 0;
unsigned long routeStartTime = 0;
unsigned long routeStepStartTime = 0;
uint8_t routeStep = 0;
bool routeRunning = false;
bool alarmActive = false;
unsigned long lastWifiRetry = 0;

WebServer server(80);
WebSocketsClient cloudSocket;
bool cloudHoldActive = false;
unsigned long lastCloudHeartbeat = 0;
bool cloudReadyAnnouncePending = false;
const char letsEncryptRootCA[] PROGMEM = R"CERT(-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
)CERT";

void startTimedSignal(const String& signal, unsigned long durationMs) {
  timedSignal = signal;
  timedSignalUntil = millis() + durationMs;
}

void clearTimedSignal() {
  timedSignal = "";
  timedSignalUntil = 0;
}

void stopMotors() {
  analogWrite(pinLA1, 0);
  analogWrite(pinLA2, 0);
  analogWrite(pinLB1, 0);
  analogWrite(pinLB2, 0);
  analogWrite(pinRC1, 0);
  analogWrite(pinRC2, 0);
  analogWrite(pinRD1, 0);
  analogWrite(pinRD2, 0);
}

void advance() {
  analogWrite(pinLA1, SPEED_LF); analogWrite(pinLA2, 0);
  analogWrite(pinLB1, SPEED_LB); analogWrite(pinLB2, 0);
  analogWrite(pinRC1, SPEED_RF); analogWrite(pinRC2, 0);
  analogWrite(pinRD1, SPEED_RB); analogWrite(pinRD2, 0);
}

void back() {
  analogWrite(pinLA1, 0); analogWrite(pinLA2, SPEED_LF);
  analogWrite(pinLB1, 0); analogWrite(pinLB2, SPEED_LB);
  analogWrite(pinRC1, 0); analogWrite(pinRC2, SPEED_RF);
  analogWrite(pinRD1, 0); analogWrite(pinRD2, SPEED_RB);
}

void turnL() {
  analogWrite(pinLA1, 0); analogWrite(pinLA2, MOTOR_SPEED);
  analogWrite(pinLB1, 0); analogWrite(pinLB2, MOTOR_SPEED);
  analogWrite(pinRC1, MOTOR_SPEED); analogWrite(pinRC2, 0);
  analogWrite(pinRD1, MOTOR_SPEED); analogWrite(pinRD2, 0);
}

void turnR() {
  analogWrite(pinLA1, MOTOR_SPEED); analogWrite(pinLA2, 0);
  analogWrite(pinLB1, MOTOR_SPEED); analogWrite(pinLB2, 0);
  analogWrite(pinRC1, 0); analogWrite(pinRC2, MOTOR_SPEED);
  analogWrite(pinRD1, 0); analogWrite(pinRD2, MOTOR_SPEED);
}

// M: same left-bend action used by the confirmed P2/P4/P6 routes.
void forwardLeftCurve() {
  analogWrite(pinLA1, 0); analogWrite(pinLA2, 0);
  analogWrite(pinLB1, 0); analogWrite(pinLB2, 0);
  analogWrite(pinRC1, SPEED_RF); analogWrite(pinRC2, 0);
  analogWrite(pinRD1, SPEED_RB); analogWrite(pinRD2, 0);
}

// N: same right-bend action used by the confirmed P3/P4/P5 routes.
void forwardRightCurve() {
  analogWrite(pinLA1, SPEED_LF); analogWrite(pinLA2, 0);
  analogWrite(pinLB1, SPEED_LB); analogWrite(pinLB2, 0);
  analogWrite(pinRC1, 0); analogWrite(pinRC2, 0);
  analogWrite(pinRD1, 0); analogWrite(pinRD2, 0);
}

void runCommand() {
  if (command == "A") advance();
  else if (command == "B") back();
  else if (command == "E") turnL();
  else if (command == "F") turnR();
  else if (command == "M") forwardLeftCurve();
  else if (command == "N") forwardRightCurve();
  else stopMotors();
}

void updateSignalOutputs() {
  bool left = false;
  bool straight = false;
  bool right = false;

  if (alarmActive) {
    // Alarm mode has priority over route lamps.
  } else if (lampTest == "L") {
    left = true;
  } else if (lampTest == "S") {
    straight = true;
  } else if (lampTest == "R") {
    right = true;
  } else if (timedSignal == "L") {
    if (millis() < timedSignalUntil) left = true;
    else straight = true;
  } else if (timedSignal == "R") {
    if (millis() < timedSignalUntil) right = true;
    else straight = true;
  } else if (command == "A" || command == "B") {
    straight = true;
  } else if (command == "E" || command == "M") {
    left = true;
  } else if (command == "F" || command == "N") {
    right = true;
  }

  digitalWrite(pinLeftLamp, left ? HIGH : LOW);
  digitalWrite(pinStraightLamp, straight ? HIGH : LOW);
  digitalWrite(pinRightLamp, right ? HIGH : LOW);
  const bool alarmLampOn = alarmActive && ((millis() / 350) % 2 == 0);
  digitalWrite(pinAlarmLamp, alarmLampOn ? HIGH : LOW);
  digitalWrite(pinBuzzer, alarmActive ? LOW : HIGH);
}

bool isBasicCommand(const String& value) {
  return value == "A" || value == "B" || value == "E" ||
         value == "F" || value == "K";
}

bool isLampTestCommand(const String& value) {
  return value == "L" || value == "S" || value == "R";
}

bool isRouteCommand(const String& value) {
  return value == "P1" || value == "P2" || value == "P3" ||
         value == "P4" || value == "P5" || value == "P6";
}

void startRoute(const String& name) {
  routeName = name;
  routeRunning = true;
  routeStep = 0;
  routeStartTime = millis();
  routeStepStartTime = routeStartTime;
  command = "K";
  lampTest = "";
  alarmActive = false;
  clearTimedSignal();
  if (name == "P2") startTimedSignal("L", 3000);
  else if (name == "P3") startTimedSignal("R", 3000);
  else if (name == "P4") startTimedSignal("L", 2500);
  else if (name == "P5") startTimedSignal("R", 2500);
  lastCmdTime = millis();
  Serial.print("路线开始：");
  Serial.println(routeName);
}

void finishRoute() {
  routeRunning = false;
  command = "K";
  clearTimedSignal();
  lastCmdTime = millis();
  Serial.print("路线完成：");
  Serial.println(routeName);
}

void runRoute() {
  unsigned long elapsed = millis() - routeStartTime;
  unsigned long stepElapsed = millis() - routeStepStartTime;

  if (routeName == "P1") {
    command = "A";
    if (elapsed >= 5000) finishRoute();
    return;
  }

  if (routeName == "P2") {
    if (routeStep == 0) {
      command = "A";
      if (stepElapsed >= 2000) { routeStep = 1; routeStepStartTime = millis(); }
    } else if (routeStep == 1) {
      command = "M";
      if (stepElapsed >= 1000) { routeStep = 2; routeStepStartTime = millis(); }
    } else {
      command = "A";
      if (stepElapsed >= 2000) finishRoute();
    }
    return;
  }

  if (routeName == "P3") {
    if (routeStep == 0) {
      command = "A";
      if (stepElapsed >= 2000) { routeStep = 1; routeStepStartTime = millis(); }
    } else if (routeStep == 1) {
      command = "N";
      if (stepElapsed >= 1000) { routeStep = 2; routeStepStartTime = millis(); }
    } else {
      command = "A";
      if (stepElapsed >= 2000) finishRoute();
    }
    return;
  }

  if (routeName == "P4") {
    if (routeStep == 0) {
      command = "A";
      if (stepElapsed >= 1000) { routeStep = 1; routeStepStartTime = millis(); }
    } else if (routeStep == 1) {
      command = "M";
      if (stepElapsed >= 700) { routeStep = 2; routeStepStartTime = millis(); }
    } else if (routeStep == 2) {
      command = "N";
      if (stepElapsed >= 700) { routeStep = 3; routeStepStartTime = millis(); }
    } else {
      command = "A";
      if (stepElapsed >= 1000) finishRoute();
    }
    return;
  }

  if (routeName == "P5") {
    if (routeStep == 0) {
      command = "A";
      if (stepElapsed >= 1000) { routeStep = 1; routeStepStartTime = millis(); }
    } else if (routeStep == 1) {
      command = "N";
      if (stepElapsed >= 700) { routeStep = 2; routeStepStartTime = millis(); }
    } else if (routeStep == 2) {
      command = "M";
      if (stepElapsed >= 700) { routeStep = 3; routeStepStartTime = millis(); }
    } else {
      command = "A";
      if (stepElapsed >= 1000) finishRoute();
    }
    return;
  }

  if (routeName == "P6") {
    if (routeStep == 0) {
      command = "A";
      if (stepElapsed >= 2000) { routeStep = 1; routeStepStartTime = millis(); }
    } else if (routeStep == 1) {
      command = "M";
      if (stepElapsed >= 1600) { routeStep = 2; routeStepStartTime = millis(); }
    } else {
      command = "A";
      if (stepElapsed >= 2000) finishRoute();
    }
  }
}

void acceptCommand(String value, const char* source) {
  value.trim();
  value.toUpperCase();

  if (isRouteCommand(value)) {
    startRoute(value);
  } else if (value == "H") {
    routeRunning = false;
    command = "K";
    lampTest = "";
    clearTimedSignal();
    alarmActive = true;
    lastCmdTime = millis();
    Serial.print(source); Serial.println("：警报灯与蜂鸣器开启；发送 K 关闭");
  } else if (isLampTestCommand(value)) {
    routeRunning = false;
    command = "K";
    lampTest = value;
    clearTimedSignal();
    alarmActive = false;
    lastCmdTime = millis();
    Serial.print(source); Serial.print("：灯光测试 "); Serial.println(value);
  } else if (isBasicCommand(value)) {
    command = value;
    routeRunning = false;
    lampTest = "";
    alarmActive = false;
    clearTimedSignal();
    if (value == "E") startTimedSignal("L", 3000);
    else if (value == "F") startTimedSignal("R", 3000);
    lastCmdTime = millis();
    Serial.print(source); Serial.print("指令："); Serial.println(command);
  } else {
    Serial.print(source); Serial.print("指令错误："); Serial.println(value);
  }
}

void handleSerialCommand() {
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\r' || c == '\n') {
      serialCommand.trim();
      serialCommand.toUpperCase();
      if (serialCommand.length() > 0) acceptCommand(serialCommand, "串口");
      serialCommand = "";
    } else if (c >= 32 && c <= 126 && serialCommand.length() < 8) {
      serialCommand += c;
    }
  }
}

void handleCloudText(uint8_t *payload, size_t length) {
  for (size_t i = 0; i < length; ++i) {
    char c = static_cast<char>(payload[i]);
    if (c == '\r' || c == '\n') {
      tcpCommand.trim();
      tcpCommand.toUpperCase();
      if (isBasicCommand(tcpCommand) || isLampTestCommand(tcpCommand) ||
          isRouteCommand(tcpCommand) || tcpCommand == "H") {
        String accepted = tcpCommand;
        acceptCommand(accepted, "云端 WSS");
        cloudHoldActive = isBasicCommand(accepted) && accepted != "K";
        cloudSocket.sendTXT(String("TCP OK: ") + accepted);
      } else if (tcpCommand.length() > 0) {
        cloudSocket.sendTXT(String("TCP ERROR: ") + tcpCommand);
      }
      tcpCommand = "";
    } else if (c >= 32 && c <= 126 && tcpCommand.length() < 8) {
      tcpCommand += c;
    }
  }
}

void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  Serial.printf("WSS event=%d t=%lu len=%u\n", static_cast<int>(type), millis(), static_cast<unsigned>(length));
  if (type == WStype_CONNECTED) {
    Serial.println("云端 WSS 已连接");
    cloudHoldActive = false;
    lastCloudHeartbeat = millis();
    cloudReadyAnnouncePending = true;
    tcpCommand = "";
  } else if (type == WStype_TEXT) {
    Serial.printf("WSS text: %.*s\n", static_cast<int>(length), reinterpret_cast<char*>(payload));
    handleCloudText(payload, length);
  } else if (type == WStype_PING || type == WStype_PONG) {
    Serial.println(type == WStype_PING ? "WSS ping received" : "WSS pong received");
  } else if (type == WStype_DISCONNECTED) {
    if (length >= 2 && payload) {
      uint16_t closeCode = (static_cast<uint16_t>(payload[0]) << 8) | payload[1];
      Serial.printf("WSS close code=%u reason=%.*s\n", closeCode,
                    static_cast<int>(length - 2), reinterpret_cast<char*>(payload + 2));
    }
    {
      routeRunning = false;
      command = "K";
      cloudHoldActive = false;
      stopMotors();
      Serial.println("云端断开，小车已停止");
    }
    tcpCommand = "";
    Serial.println("云端 WSS 断开，等待自动重连");
  }
}

void handleRoot() {
  if (server.hasArg("State")) {
    acceptCommand(server.arg("State"), "网页");
    server.send(200, "text/plain; charset=utf-8", "OK");
    return;
  }

  const char page[] = R"HTML(
<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESP32 小车</title><style>body{font:18px sans-serif;max-width:480px;margin:24px auto;text-align:center}button{font-size:20px;padding:14px;margin:5px;min-width:92px}</style>
<h2>ESP32 WiFi 小车</h2><p><button onclick="go('A')">前进</button><br><button onclick="go('E')">左转</button><button onclick="go('K')">停止</button><button onclick="go('F')">右转</button><br><button onclick="go('B')">后退</button></p>
<p>路线：<button onclick="go('P1')">P1</button><button onclick="go('P2')">P2</button><button onclick="go('P3')">P3</button><button onclick="go('P4')">P4</button><button onclick="go('P5')">P5</button><button onclick="go('P6')">P6</button></p>
<p>灯测试：<button onclick="go('L')">左灯</button><button onclick="go('S')">直行灯</button><button onclick="go('R')">右灯</button><button onclick="go('H')">警报</button></p>
<script>function go(x){fetch('/?State='+x).catch(()=>{});}</script></html>
)HTML";
  server.send(200, "text/html; charset=utf-8", page);
}

void setup() {
  Serial.begin(9600);

  // Set the active-low module to its inactive level at startup.
  pinMode(pinBuzzer, OUTPUT);
  digitalWrite(pinBuzzer, HIGH);

  const uint8_t motorPins[] = {pinLA1, pinLA2, pinLB1, pinLB2,
                               pinRC1, pinRC2, pinRD1, pinRD2};
  for (uint8_t pin : motorPins) {
    pinMode(pin, OUTPUT);
    analogWrite(pin, 0);
  }
  pinMode(pinLeftLamp, OUTPUT);
  pinMode(pinStraightLamp, OUTPUT);
  pinMode(pinRightLamp, OUTPUT);
  pinMode(pinAlarmLamp, OUTPUT);
  updateSignalOutputs();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(wifiSsid, wifiPassword);

  Serial.println("======== ESP32 小车启动成功 ========");
  Serial.print("正在连接 WiFi："); Serial.println(wifiSsid);
  unsigned long connectStarted = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - connectStarted < 15000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi 已连接");
    Serial.print("小车控制 IP："); Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi 暂未连接，将在后台继续重试");
  }
  Serial.println("A=前进 B=后退 E=左转 F=右转 K=停止");
  Serial.println("P1-P6=路线 H=警报 L/S/R=灯测试");

  server.on("/", handleRoot);
  server.onNotFound(handleRoot);
  server.begin();
  configTime(0, 0, "ntp.aliyun.com", "pool.ntp.org");
  static char authHeader[128];
  snprintf(authHeader, sizeof(authHeader), "Authorization: Bearer %s", WIFICAR_DEVICE_TOKEN);
  cloudSocket.setExtraHeaders(authHeader);
  cloudSocket.setReconnectInterval(5000);
  cloudSocket.disableHeartbeat();
  cloudSocket.onEvent(webSocketEvent);
  cloudSocket.beginSslWithCA("adas.wmnnj.top", 443, "/device/wifi-car", letsEncryptRootCA);
  Serial.println("本地网页控制与云端 WSS 已就绪");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED && millis() - lastWifiRetry >= 10000) {
    lastWifiRetry = millis();
    Serial.println("WiFi 断开，尝试重新连接");
    WiFi.reconnect();
  }

  server.handleClient();
  cloudSocket.loop();
  if (cloudReadyAnnouncePending && cloudSocket.isConnected()) {
    bool sent = cloudSocket.sendTXT("WIFICAR READY");
    Serial.printf("WSS ready announce sent=%d t=%lu\n", sent, millis());
    cloudReadyAnnouncePending = false;
  }
  if (cloudSocket.isConnected() && millis() - lastCloudHeartbeat >= 20000) {
    bool sent = cloudSocket.sendTXT("WIFICAR READY");
    Serial.printf("WSS heartbeat sent=%d t=%lu\n", sent, millis());
    lastCloudHeartbeat = millis();
  }
  handleSerialCommand();

  if (routeRunning) runRoute();

  if (!routeRunning && !cloudHoldActive && command != "K" &&
      millis() - lastCmdTime > CMD_TIMEOUT) {
    command = "K";
  }

  runCommand();
  updateSignalOutputs();
  delay(15);
}
