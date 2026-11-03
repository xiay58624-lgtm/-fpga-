(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const details = {
    cameras: {
      title: "四路 OV5640 采集端", kicker: "节点 01 · 图像输入", state: "4 路输入",
      text: "FMC 支路的一块双 OV5640 模组竖立安装，经第二级接口板及横放的 FMC 转接板接入 100H。另一块双目模组位于主板 F_GPIO 接口，构成两块双目、四个镜头的采集结构。",
      facts: ["FMC 支路", "一块双目模组 / 竖立", "转接板", "水平安装"]
    },
    gpioCameras: {
      title: "F_GPIO 双 OV5640", kicker: "图像输入 · F_GPIO 支路", state: "竖立安装",
      text: "第二块双 OV5640 模组竖立接在 100H 主板左侧 F_GPIO 接口，与 FMC 支路的双目模组分别安装。两块模组共四个镜头，输入 FPGA 做采集与预处理。",
      facts: ["接口", "主板左侧 F_GPIO", "模组", "双 OV5640 / 竖立"]
    },
    adapter: {
      title: "第二级接口板", kicker: "成像接口 · 转接层 02", state: "插接于 FMC 板上",
      text: "图中第 3、4 张是安装在 FMC 转接板上方的第二级接口板正反面。场景根据照片外形制作立体示意；两块板之间的连接器型号、方向及具体信号映射请以实物和原理图核实。",
      facts: ["层级", "FMC 板上方", "参考", "正 / 反面实拍"]
    },
    fmc: {
      title: "FMC 转接板", kicker: "成像接口 · 转接层 01", state: "安装于 100H",
      text: "FMC 转接板横放，插在 100H 主板后侧偏左的 FMC 接口上；第二级接口板负责连接竖立的双目摄像头模组。板卡的水平与竖直关系在装配和爆炸视图中均保持一致。",
      facts: ["位置", "主板后侧 FMC", "上层", "第二级接口板"]
    },
    fpga: {
      title: "PG2L100H FPGA", kicker: "节点 02 · 采集与预处理", state: "采集中",
      text: "FPGA 接收四路 OV5640 像素流，完成时序整理、帧缓存和四路图像输出，再通过 PCIe 送到 RK3568。这里绘制的是系统连接关系，实际 FMC 信号以工程约束和原理图为准。",
      facts: ["输入", "F_GPIO + FMC", "输出", "PCIe 四路帧"]
    },
    rk: {
      title: "RK3568 边缘推理", kicker: "节点 03 · 识别与决策", state: "RKNN", 
      text: "RK3568 就在 100H 主板上，与 FPGA 属于同一块实体板卡。FPGA 与板载 RK3568 通过 PCIe 通信，RKNN 推理结果以字符 / JSON 上报云端。",
      facts: ["物理位置", "100H 板载", "板内通信", "PCIe", "推理", "RKNN / 4 路"]
    },
    display: {
      title: "RK 四路本地显示器", kicker: "本地输出 · 2 × 2 画面", state: "四路显示",
      text: "显示器连接 100H 板载 RK3568 的显示输出，呈现四路摄像头的 2 × 2 画面及板端识别叠加。它是 RK 侧本地屏幕；云端上位机通过字符遥测读取检测与动作状态。模型中的四宫格用于表示显示布局。",
      facts: ["画面布局", "CH1 / CH2 / CH3 / CH4", "连接端", "板载 RK3568", "用途", "本地识别显示"]
    },
    cloud: {
      title: "云端中继", kicker: "节点 04 · 公网通信", state: "HTTPS / WSS",
      text: "云端只承担中继与状态保存：接收 RK 的 JSON 遥测，将动作映射为 P1–P5、K 或 H，并把控制命令通过 WSS 发给 ESP32；识别决策仍来源于 RK。",
      facts: ["域名", "adas.wmnnj.top", "上行", "HTTPS JSON"]
    },
    upper: {
      title: "上位机可视化", kicker: "节点 05 · 结果呈现", state: "检测结果",
      text: "上位机从云端读取检测结果、箭头状态、动作命令和 ESP32 回执，展示四路识别效果与智驾行为日志。视频链路和字符遥测链路可以独立运行。",
      facts: ["页面", "检测结果", "数据", "字符遥测"]
    },
    car: {
      title: "ESP32 四驱小车", kicker: "节点 06 · 按实物照片建模", state: "WSS 控制",
      text: "蓝色底盘搭配四个黑色轮胎和黄色轮毂，中央安装 ESP32，灯板上设左、直行、右和报警四个指示灯及蜂鸣器；另一端安装驱动板与电源模块。ESP32 通过 WSS 接收云端指令，执行动作或蜂鸣、红灯报警。下方为本车侧面和俯视实拍，模型依据可见结构重建。",
      facts: ["控制", "中央 ESP32", "提示", "左 / 直行 / 右 / 报警", "声光", "蜂鸣器 + 指示灯", "底盘", "蓝色四轮 / 黄色轮毂"]
    }
  };

  let activeFlow = "data";
  let pollTimer = null;

  function backendBase() {
    const input = $("backendBase");
    return (input && input.value.trim().replace(/\/+$/, "")) || location.origin;
  }

  function setNode(id, state, text) {
    const dot = $("deployStatus" + id);
    const label = $("deployStatus" + id + "Text");
    if (!dot || !label) return;
    dot.className = "status-dot " + state;
    label.textContent = text;
  }

  function renderDetails(key) {
    const item = details[key] || details.rk;
    $("deploymentDetailTitle").textContent = item.title;
    $("deploymentDetailKicker").textContent = item.kicker;
    $("deploymentDetailState").textContent = item.state;
    $("deploymentDetailText").textContent = item.text;
    const facts = [];
    for (let index = 0; index < item.facts.length; index += 2) {
      facts.push(`<span>${item.facts[index]}<b>${item.facts[index + 1] || "—"}</b></span>`);
    }
    $("deploymentDetailFacts").innerHTML = facts.join("");
    document.querySelectorAll(".device-card,.device-label,[data-deployment-target]").forEach((card) => {
      const selected = (card.dataset.device || card.dataset.deploymentTarget) === key;
      card.classList.toggle("selected", selected);
      if (card.hasAttribute("data-deployment-target")) card.setAttribute("aria-pressed", String(selected));
    });
    const photo = $("deploymentSelectedPhoto");
    const photos = { cameras: "dual-ov5640-surface.webp", gpioCameras: "dual-ov5640-surface.webp", fpga: "pg2l100h-surface.webp", rk: "pg2l100h-surface.webp", fmc: "fmc-adapter-back.webp", adapter: "secondary-adapter-front.webp", display: "rk-display.jpg", upper: "upper-screen.jpg", car: "wifi-car-side-actual.webp" };
    if (photo) {
      photo.hidden = !photos[key];
      if (photos[key]) { photo.src = `./assets/deployment/${photos[key]}`; photo.alt = item.title + "实物参考"; }
    }
    let secondPhoto = $("deploymentSelectedPhotoSecondary");
    if (!secondPhoto && photo) {
      secondPhoto = document.createElement("img");
      secondPhoto.id = "deploymentSelectedPhotoSecondary";
      secondPhoto.className = "deployment-selected-photo";
      secondPhoto.alt = "ESP32 四驱小车俯视实拍";
      secondPhoto.loading = "lazy";
      secondPhoto.hidden = true;
      photo.after(secondPhoto);
    }
    if (secondPhoto) {
      secondPhoto.hidden = key !== "car";
      if (key === "car") secondPhoto.src = "./assets/deployment/wifi-car-top-actual.webp";
    }
    $("deploymentSelectionState").textContent = "已锁定 · " + item.title;
  }

  function selectDevice(key) {
    renderDetails(key);
    window.dispatchEvent(new CustomEvent("deployment-device-select", { detail: key }));
  }

  function setFlow(flow) {
    activeFlow = flow;
    document.body.dataset.deploymentFlow = flow;
    $("deploymentFlowData")?.classList.toggle("active", flow === "data");
    $("deploymentFlowControl")?.classList.toggle("active", flow === "control");
  }

  async function pollStatus() {
    try {
      const base = backendBase();
      const [visionResponse, carResponse] = await Promise.all([
        fetch(`${base}/api/rk/realtime/vision/latest`, { cache: "no-store", signal: AbortSignal.timeout(3500) }),
        fetch(`${base}/api/wifi-car/status`, { cache: "no-store", signal: AbortSignal.timeout(3500) })
      ]);
      const vision = visionResponse.ok ? await visionResponse.json() : null;
      const car = carResponse.ok ? await carResponse.json() : null;
      const fresh = vision && Number(vision.age_ms || 0) < 10000;
      setNode("Fpga", fresh ? "good" : "pending", fresh ? "四路帧已接入" : "等待采集");
      setNode("Rk", fresh ? "good" : "pending", fresh ? `${vision.inference_fps ? Number(vision.inference_fps).toFixed(1) : "—"} FPS · ${vision.arrow_state || "未知"}` : "等待遥测");
      setNode("Cloud", fresh ? "good" : "pending", fresh ? "已收到 RK JSON" : "等待连接");
      setNode("Car", car?.online ? "good" : "pending", car?.online ? (car.last_command || "WSS 在线") : "等待 WSS");
      $("deploymentUpdated").textContent = fresh ? `更新于 ${new Date(vision.received_at_ms || Date.now()).toLocaleTimeString("zh-CN", { hour12: false })}` : "等待状态";
    } catch (error) {
      setNode("Rk", "bad", "遥测不可用");
      setNode("Cloud", "bad", "接口不可用");
      $("deploymentUpdated").textContent = "状态读取失败";
    }
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollStatus();
    pollTimer = setInterval(pollStatus, 5000);
  }

  function init() {
    document.querySelectorAll(".device-card").forEach((card) => card.addEventListener("click", () => selectDevice(card.dataset.device)));
    document.querySelectorAll("[data-deployment-target]").forEach((button) => button.addEventListener("click", () => selectDevice(button.dataset.deploymentTarget)));
    window.addEventListener("deployment-device-select", (event) => renderDetails(event.detail));
    $("deploymentUnlock")?.addEventListener("click", () => {
      document.querySelectorAll(".device-label,[data-deployment-target]").forEach((button) => { button.classList.remove("selected"); button.setAttribute("aria-pressed", "false"); });
      $("deploymentSelectionState").textContent = "自由浏览 · 点击部件锁定";
      window.dispatchEvent(new CustomEvent("deployment-selection-clear"));
    });
    $("deploymentFlowData")?.addEventListener("click", () => setFlow("data"));
    $("deploymentFlowControl")?.addEventListener("click", () => setFlow("control"));
    $("deploymentExplode")?.addEventListener("click", (event) => {
      const exploded = document.body.dataset.deploymentAssembly !== "exploded";
      document.body.dataset.deploymentAssembly = exploded ? "exploded" : "assembled";
      event.currentTarget.classList.toggle("active", exploded);
      event.currentTarget.textContent = exploded ? "装配视图" : "爆炸视图";
    });
    window.addEventListener("adas-page-change", (event) => {
      if (event.detail === "deployment") startPolling();
      else clearInterval(pollTimer);
    });
    renderDetails("rk");
    $("deploymentSelectionState").textContent = "自由浏览 · 点击部件锁定";
    document.querySelectorAll("[data-deployment-target]").forEach((button) => { button.classList.remove("selected"); button.setAttribute("aria-pressed", "false"); });
    setFlow("data");
    if (document.body.dataset.activePage === "deployment") startPolling();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
