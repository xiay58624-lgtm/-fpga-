import * as THREE from "./assets/deployment/three.module.js";
import { OrbitControls } from "./assets/deployment/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "./assets/deployment/addons/renderers/CSS2DRenderer.js";

const host = document.getElementById("deploymentScene");
const fallback = document.getElementById("deploymentSceneFallback");

if (host) {
  try {
    const width = host.clientWidth || 1000;
    const height = host.clientHeight || 660;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.8));
    renderer.setSize(width, height);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const labels = new CSS2DRenderer();
    labels.setSize(width, height);
    labels.domElement.className = "deployment-label-layer";
    host.appendChild(labels.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(31, width / height, 0.1, 100);
    camera.position.set(8.7, 8.2, 15.8);
    camera.lookAt(0.8, 1.4, 0);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0.8, 1.35, 0);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 10;
    controls.maxDistance = 22;
    controls.minPolarAngle = 0.52;
    controls.maxPolarAngle = 1.48;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.42;
    controls.update();

    scene.add(new THREE.HemisphereLight(0xbfd8e0, 0x101820, 2.2));
    const keyLight = new THREE.DirectionalLight(0xb5f4ff, 3.4);
    keyLight.position.set(-5, 11, 9);
    scene.add(keyLight);
    const warmLight = new THREE.PointLight(0xffc875, 22, 20);
    warmLight.position.set(5, 4, 1);
    scene.add(warmLight);

    const root = new THREE.Group();
    scene.add(root);
    const material = (color, metalness = 0.25, roughness = 0.48) => new THREE.MeshStandardMaterial({ color, metalness, roughness });
    const boardMaterial = material(0x102f32, 0.45, 0.5);
    const blackBoard = material(0x11191d, 0.32, 0.42);
    const blueBoard = material(0x075cae, 0.35, 0.4);
    const edge = material(0x71838b, 0.7, 0.28);
    const dark = material(0x121c22, 0.55, 0.3);
    const gold = material(0xd3a951, 0.74, 0.25);
    const cyan = material(0x58dce4, 0.35, 0.28);

    const box = (parent, size, mat, position, rotation = [0, 0, 0]) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
      mesh.position.set(...position);
      mesh.rotation.set(...rotation);
      parent.add(mesh);
      return mesh;
    };
    const textureLoader = new THREE.TextureLoader();
    const surface = (parent, file, size, position, rotation = [-Math.PI / 2, 0, 0]) => {
      const texture = textureLoader.load(`./assets/deployment/${file}`);
      texture.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(...size),
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.97, side: THREE.DoubleSide })
      );
      mesh.position.set(...position);
      mesh.rotation.set(...rotation);
      parent.add(mesh);
      return mesh;
    };
    const cyl = (parent, radius, depth, mat, position, rotation = [0, 0, 0], segments = 20) => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, depth, segments), mat);
      mesh.position.set(...position);
      mesh.rotation.set(...rotation);
      parent.add(mesh);
      return mesh;
    };
    const label = (parent, key, id, title, note, position) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "device-label";
      button.dataset.device = key;
      button.innerHTML = `<span>${id}</span><b>${title}</b><small>${note}</small>`;
      button.addEventListener("click", () => window.dispatchEvent(new CustomEvent("deployment-device-select", { detail: key })));
      const object = new CSS2DObject(button);
      object.position.set(...position);
      parent.add(object);
      return object;
    };

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(23, 15), material(0x08131b, 0.05, 0.94));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.45;
    root.add(floor);
    const grid = new THREE.GridHelper(23, 38, 0x245362, 0x17313c);
    grid.position.y = -0.43;
    root.add(grid);

    // One physical 100H board contains both FPGA and RK3568.
    // X: board left/right; -Z: rear FMC edge; Y: height above the PCB.
    const assembly = new THREE.Group();
    assembly.position.set(-2.7, 0, 0.1);
    root.add(assembly);
    const base = new THREE.Group();
    base.name = "100h-mainboard";
    const fmc = new THREE.Group();
    const secondary = new THREE.Group();
    const cameraModule = new THREE.Group();
    const gpioCamera = new THREE.Group();
    fmc.name = "horizontal-fmc-adapter";
    secondary.name = "secondary-adapter";
    cameraModule.name = "vertical-fmc-stereo";
    gpioCamera.name = "vertical-fgpio-stereo";
    fmc.position.set(-1.2, 0.5, -1.62);
    secondary.position.set(-0.68, 0.73, -1.62);
    // Both sensor PCBs stand vertically and physically meet their mounting surfaces.
    cameraModule.position.set(-0.22, 1.27, -1.62);
    cameraModule.rotation.y = Math.PI / 2;
    gpioCamera.position.set(-2.58, 0.66, 0.35);
    gpioCamera.rotation.y = Math.PI / 2;
    assembly.add(base, fmc, secondary, cameraModule, gpioCamera);

    box(base, [5.4, 0.28, 3.8], boardMaterial, [0, 0, 0]);
    surface(base, "pg2l100h-surface.webp", [4.95, 3.38], [0, 0.151, 0]);
    // Shared heatsink visible on the actual board; both processors are on this PCB.
    box(base, [2.1, 0.14, 1.62], dark, [0.05, 0.28, -0.05]);
    for (let i = 0; i < 18; i += 1) {
      box(base, [2.1, 0.24, 0.034], dark, [0.05, 0.46, -0.81 + i * 0.089]);
    }
    box(base, [1.48, 0.18, 0.25], dark, [-1.2, 0.27, -1.62]);
    box(base, [0.22, 0.18, 1.48], dark, [-2.52, 0.27, 0.35]);
    for (const x of [-2.25, 2.25]) for (const z of [-1.5, 1.5]) {
      cyl(base, 0.16, 0.06, gold, [x, 0.19, z]);
      cyl(base, 0.08, 0.06, dark, [x, 0.22, z]);
    }
    for (let i = 0; i < 12; i += 1) {
      box(base, [0.11, 0.08, 0.14], gold, [-1.65 + i * 0.3, 0.2, -1.36]);
      box(base, [0.11, 0.08, 0.14], gold, [-1.65 + i * 0.3, 0.2, 1.36]);
    }
    label(base, "fpga", "02", "PG2L100H", "FMC 主板 / FPGA", [-2.35, 0.78, 1.55]);

    box(fmc, [1.9, 0.065, 1.7], blackBoard, [0, 0, 0]);
    surface(fmc, "fmc-adapter-back.webp", [1.9, 1.7], [0, 0.034, 0]);
    surface(fmc, "fmc-adapter-front.webp", [1.9, 1.7], [0, -0.034, 0], [Math.PI / 2, 0, 0]);
    for (const z of [-0.62, 0.62]) box(fmc, [1.54, 0.12, 0.13], dark, [0, 0.09, z]);
    for (const x of [-0.72, -0.32, 0.08]) for (const z of [-0.24, 0.24]) cyl(fmc, 0.065, 0.14, gold, [x, 0.12, z]);
    // Header columns join the flat FMC adapter to the 100H board surface.
    for (const x of [-0.72, 0.72]) for (const z of [-0.56, 0.56]) {
      cyl(fmc, 0.055, 0.31, gold, [x, -0.19, z]);
    }
    label(fmc, "fmc", "02A", "FMC 转接板", "平放 · 100H 主板上", [-1.0, 0.3, -0.9]);

    box(secondary, [0.9, 0.045, 1.34], blackBoard, [0, 0, 0]);
    surface(secondary, "secondary-adapter-front.webp", [0.9, 1.34], [0, 0.025, 0]);
    surface(secondary, "secondary-adapter-back.webp", [0.9, 1.34], [0, -0.025, 0], [Math.PI / 2, 0, 0]);
    box(secondary, [0.13, 0.14, 1.23], dark, [0.4, 0.085, 0]);
    // Second-level interface card rests horizontally on the FMC card.
    for (const x of [-0.3, 0.3]) for (const z of [-0.55, 0.55]) {
      cyl(secondary, 0.045, 0.175, gold, [x, -0.11, z]);
    }
    label(secondary, "adapter", "02B", "第二级接口板", "平放 · 安装在 FMC 上", [0.62, 0.22, 0.7]);

    const makeStereo = (parent, key, id, title, note) => {
      // Camera PCB is vertical (XY), unlike the horizontal adapters (XZ).
      box(parent, [1.64, 1.04, 0.055], blackBoard, [0, 0, 0]);
      surface(parent, "dual-ov5640-surface.webp", [1.64, 1.04], [0, 0, 0.03], [0, 0, 0]);
      box(parent, [1.48, 0.12, 0.11], dark, [0, -0.47, -0.03]);
      for (const x of [-0.46, 0.46]) {
        box(parent, [0.24, 0.22, 0.12], edge, [x, 0.35, 0.09]);
        cyl(parent, 0.105, 0.12, dark, [x, 0.35, 0.16], [Math.PI / 2, 0, 0]);
        cyl(parent, 0.064, 0.125, cyan, [x, 0.35, 0.17], [Math.PI / 2, 0, 0]);
      }
      label(parent, key, id, title, note, [0, 0.87, 0]);
    };
    makeStereo(cameraModule, "cameras", "01A", "FMC 双目摄像头", "竖立 · FMC 上层接口");
    makeStereo(gpioCamera, "gpioCameras", "01B", "F_GPIO 双目摄像头", "竖立 · 100H 左侧接口");

    const rk = new THREE.Group();
    rk.name = "onboard-rk3568";
    // The RK3568 module is mounted on the 100H PCB, at the module area shown in its top-side reference.
    rk.position.set(1.2, 0, -0.85);
    base.add(rk);
    box(rk, [0.72, 0.08, 0.46], blackBoard, [0, 0.19, 0]);
    box(rk, [0.34, 0.045, 0.27], dark, [0, 0.25, 0]);
    label(rk, "rk", "03", "板载 RK3568", "100H 主板上的 RK 模组", [0.65, 0.48, 0.1]);

    const makeScreen = (parent, size, local = false) => {
      const canvas = document.createElement("canvas");
      canvas.width = 800; canvas.height = 480;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#0a141e"; ctx.fillRect(0, 0, 800, 480);
      ctx.fillStyle = "#6de5ee"; ctx.font = "bold 20px sans-serif";
      ctx.fillText(local ? "RK3568  /  FOUR CAMERA OUTPUT" : "ADAS  /  CONTROL WORKSTATION", 24, 32);
      for (let i = 0; i < 4; i++) {
        const x = 20 + (i % 2) * 390, y = 56 + Math.floor(i / 2) * 208;
        ctx.fillStyle = ["#16303d", "#213b42", "#1c3447", "#213948"][i]; ctx.fillRect(x, y, 370, 190);
        ctx.fillStyle = "#263e49"; ctx.fillRect(x, y + 70, 370, 120);
        ctx.strokeStyle = "#819d9d"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(x + 20, y + 190); ctx.lineTo(x + 164, y + 70); ctx.lineTo(x + 206, y + 70); ctx.lineTo(x + 350, y + 190); ctx.stroke();
        ctx.strokeStyle = "#62e3be"; ctx.lineWidth = 2; ctx.strokeRect(x + 160, y + 95, 52, 40);
        ctx.fillStyle = "#bdf7ff"; ctx.font = "18px sans-serif"; ctx.fillText("CH" + (i + 1), x + 12, y + 27);
        ctx.fillStyle = "#77c8b5"; ctx.font = "12px sans-serif"; ctx.fillText("LAYOUT PREVIEW", x + 230, y + 175);
      }
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(...size), new THREE.MeshBasicMaterial({ map: texture }));
      screen.position.set(0, 0.7, 0.13); parent.add(screen);
    };
    // RK-side four-view monitor and remote upper computer are separate endpoints.
    const localDisplay = new THREE.Group();
    localDisplay.name = "rk-four-channel-display";
    localDisplay.position.set(-3.3, 0.6, -4.7);
    root.add(localDisplay);
    box(localDisplay, [3.5, 2.17, 0.16], dark, [0, 0.7, 0]);
    makeScreen(localDisplay, [3.25, 1.95], true);
    box(localDisplay, [0.23, 0.9, 0.2], edge, [0, -0.62, -0.05]);
    box(localDisplay, [1.3, 0.1, 0.8], edge, [0, -1.0, 0]);
    label(localDisplay, "display", "03A", "RK 四路显示器", "板端 2 × 2 画面", [0, 2.05, 0]);

    const display = new THREE.Group();
    display.position.set(6.3, 1.15, -2.1);
    root.add(display);
    box(display, [2.5, 1.58, 0.14], edge, [0, 0.7, 0]);
    box(display, [2.25, 1.32, 0.05], dark, [0, 0.7, 0.1]);
    makeScreen(display, [2.25, 1.32]);
    box(display, [0.55, 0.15, 0.52], edge, [0, -0.12, 0]);
    label(display, "upper", "05", "上位机", "四路结果 / 字符遥测", [0, 1.65, 0]);

    const cloud = new THREE.Group();
    cloud.position.set(1.4, 3.9, -2.8);
    root.add(cloud);
    for (const [x, y, radius] of [[-0.55, 0, 0.55], [0.1, 0.24, 0.72], [0.68, 0, 0.52], [0, -0.2, 0.58]]) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 18), material(0x3d6d87, 0.35, 0.38));
      puff.scale.y = 0.72;
      puff.position.set(x, y, 0);
      cloud.add(puff);
    }
    label(cloud, "cloud", "04", "云端中继", "HTTPS / WSS", [0, 1.0, 0]);

    const car = new THREE.Group();
    car.name = "photo-reference-esp32-four-wheel-car";
    car.position.set(5.9, 0.12, 2.55);
    root.add(car);
    // Layout from the supplied side and top photos: blue chassis, yellow hubs,
    // front perfboard/buzzer, ESP32 at center, rear motor driver and power board.
    const chassisBlue = new THREE.MeshPhysicalMaterial({ color: 0x078ab5, metalness: 0.3, roughness: 0.24, transparent: true, opacity: 0.82, depthWrite: false, side: THREE.DoubleSide });
    const pcbGreen = material(0x08713d, 0.22, 0.55);
    const pcbBlue = material(0x095a9e, 0.3, 0.4);
    const hubYellow = material(0xf2d416, 0.05, 0.4);
    const nylon = material(0xd9e0d8, 0.05, 0.65);
    const rubber = material(0x111519, 0.05, 0.88);
    box(car, [1.87, 0.07, 3.1], chassisBlue, [0, 0.29, 0]);
    for (const z of [-1.44, 1.44]) {
      box(car, [1.9, 0.06, 0.19], chassisBlue, [0, 0.29, z]);
      for (const x of [-0.73, 0.73]) cyl(car, 0.065, 0.075, edge, [x, 0.33, z]);
    }
    box(car, [1.42, 0.28, 0.7], rubber, [0, 0.5, 0.95]);
    for (const x of [-0.88, 0.88]) for (const z of [-0.95, 0.95]) {
      box(car, [0.23, 0.28, 0.52], hubYellow, [x * 0.79, 0.12, z]);
      box(car, [0.055, 0.35, 0.28], edge, [x * 0.73, 0.19, z]);
    }
    const makeWheel = (x, z) => {
      const wheel = new THREE.Group(); wheel.name = "yellow-hub-rubber-wheel";
      wheel.position.set(x, 0.04, z); car.add(wheel);
      cyl(wheel, 0.49, 0.35, rubber, [0, 0, 0], [0, 0, Math.PI / 2], 40);
      const side = Math.sign(x), outside = side * 0.184;
      cyl(wheel, 0.36, 0.024, hubYellow, [outside, 0, 0], [0, 0, Math.PI / 2], 40);
      cyl(wheel, 0.10, 0.055, hubYellow, [outside + side * 0.02, 0, 0], [0, 0, Math.PI / 2]);
      for (let i = 0; i < 6; i++) {
        const angle = i * Math.PI / 3;
        box(wheel, [0.045, 0.08, 0.23], hubYellow, [outside + side * 0.016, Math.sin(angle) * 0.20, Math.cos(angle) * 0.20], [angle, 0, 0]);
      }
      for (let i = 0; i < 24; i++) {
        const angle = i * Math.PI / 12;
        box(wheel, [0.34, 0.035, 0.095], rubber, [0, Math.cos(angle) * 0.49, Math.sin(angle) * 0.49], [angle, 0, 0]);
      }
      cyl(wheel, 0.043, 0.065, edge, [outside + side * 0.035, 0, 0], [0, 0, Math.PI / 2]);
    };
    for (const x of [-1.04, 1.04]) for (const z of [-1.0, 1.0]) makeWheel(x, z);

    const standoffs = (cx, cz, w, d, top) => {
      for (const x of [-w / 2 + 0.06, w / 2 - 0.06]) for (const z of [-d / 2 + 0.06, d / 2 - 0.06]) {
        cyl(car, 0.035, top - 0.33, nylon, [cx + x, (top + 0.33) / 2, cz + z]);
        cyl(car, 0.05, 0.018, edge, [cx + x, top + 0.025, cz + z]);
      }
    };
    standoffs(0, 0.98, 1.7, 0.94, 0.84);
    box(car, [1.7, 0.035, 0.94], pcbGreen, [0, 0.84, 0.98]);
    const perfCanvas = document.createElement("canvas"); perfCanvas.width = 680; perfCanvas.height = 376;
    const perf = perfCanvas.getContext("2d"); perf.fillStyle = "#126844"; perf.fillRect(0, 0, 680, 376);
    for (let x = 16; x < 680; x += 20) for (let y = 16; y < 376; y += 20) {
      perf.fillStyle = "#d0bc7e"; perf.beginPath(); perf.arc(x, y, 3, 0, Math.PI * 2); perf.fill();
      perf.fillStyle = "#153529"; perf.beginPath(); perf.arc(x, y, 1.5, 0, Math.PI * 2); perf.fill();
    }
    const ledColors = [0x245dd3, 0x20b268, 0xe7bf19, 0xdb243b];
    const ledText = ["左", "直行", "右", "报警"];
    for (let i = 0; i < 4; i++) {
      const x = 65 + i * 150;
      perf.fillStyle = "#d8d5bc"; perf.fillRect(x - 12, 110, 110, 70);
      perf.strokeStyle = "#ba4247"; perf.lineWidth = 5; perf.strokeRect(x - 12, 110, 110, 70);
      perf.fillStyle = "#2e312e"; perf.font = "30px Microsoft YaHei, sans-serif"; perf.fillText(ledText[i], x, 158);
      const lx = -0.64 + i * 0.42;
      cyl(car, 0.047, 0.10, material(ledColors[i], 0.15, 0.24), [lx, 0.94, 1.19]);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.047, 12, 8), material(ledColors[i], 0.15, 0.2));
      cap.position.set(lx, 1.0, 1.19); car.add(cap);
      box(car, [0.13, 0.026, 0.04], pcbBlue, [lx, 0.884, 0.78]);
    }
    const perfTexture = new THREE.CanvasTexture(perfCanvas); perfTexture.colorSpace = THREE.SRGBColorSpace;
    const perfSurface = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.94), new THREE.MeshBasicMaterial({ map: perfTexture }));
    perfSurface.rotation.x = -Math.PI / 2; perfSurface.position.set(0, 0.86, 0.98); car.add(perfSurface);
    box(car, [0.48, 0.035, 0.25], pcbBlue, [-0.52, 0.90, 1.32]);
    cyl(car, 0.105, 0.15, rubber, [-0.63, 0.99, 1.32]);
    cyl(car, 0.025, 0.012, dark, [-0.63, 1.071, 1.32]);

    standoffs(0, -0.02, 0.62, 0.95, 0.78);
    box(car, [0.62, 0.035, 0.95], blackBoard, [0, 0.78, -0.02]);
    box(car, [0.43, 0.06, 0.42], edge, [0, 0.83, -0.12]);
    const espMark = document.createElement("canvas"); espMark.width = 256; espMark.height = 256;
    const espInk = espMark.getContext("2d"); espInk.fillStyle = "#9eabaa"; espInk.fillRect(0, 0, 256, 256);
    espInk.fillStyle = "#354444"; espInk.font = "bold 34px sans-serif"; espInk.fillText("ESP32", 24, 98);
    espInk.font = "22px sans-serif"; espInk.fillText("WROOM", 24, 136); espInk.fillText("Wi-Fi + BT", 24, 173);
    const espTexture = new THREE.CanvasTexture(espMark); espTexture.colorSpace = THREE.SRGBColorSpace;
    const espMarkSurface = new THREE.Mesh(new THREE.PlaneGeometry(0.41, 0.40), new THREE.MeshBasicMaterial({ map: espTexture }));
    espMarkSurface.rotation.x = -Math.PI / 2; espMarkSurface.position.set(0, 0.862, -0.12); car.add(espMarkSurface);
    box(car, [0.45, 0.01, 0.20], blackBoard, [0, 0.806, -0.36]);
    box(car, [0.19, 0.075, 0.12], edge, [0, 0.827, 0.48]);
    for (const x of [-0.25, 0.25]) for (let i = 0; i < 12; i++) box(car, [0.035, 0.12, 0.022], gold, [x, 0.72, -0.40 + i * 0.069]);
    for (let i = 0; i < 5; i++) box(car, [0.31, 0.10, 0.024], cyan, [0, 0.64, -0.32 + i * 0.11]);

    standoffs(-0.46, -0.99, 0.74, 0.70, 0.80);
    box(car, [0.74, 0.035, 0.70], pcbBlue, [-0.46, 0.8, -0.99]);
    for (const x of [-0.73, -0.19]) {
      box(car, [0.14, 0.18, 0.53], pcbBlue, [x, 0.91, -0.99]);
      for (let i = 0; i < 4; i++) cyl(car, 0.024, 0.018, edge, [x, 1.01, -1.18 + i * 0.13]);
    }
    box(car, [0.25, 0.12, 0.42], dark, [-0.46, 0.89, -0.99]);
    standoffs(0.55, -1.02, 0.63, 0.58, 0.52);
    box(car, [0.63, 0.035, 0.58], pcbGreen, [0.55, 0.52, -1.02]);
    box(car, [0.23, 0.16, 0.20], dark, [0.68, 0.61, -1.04]);
    box(car, [0.20, 0.02, 0.15], edge, [0.68, 0.70, -1.04]);
    cyl(car, 0.07, 0.27, dark, [0.39, 0.63, -0.84], [Math.PI / 2, 0, 0]);

    const wire = (color, points) => {
      const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
      const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.013, 6, false), material(color, 0.05, 0.6));
      car.add(cable);
    };
    [0xd52d40, 0xf1d249, 0x2ab085, 0x145aa4, 0xe5e2d3, 0x7d3b8b, 0x22252a].forEach((color, i) => {
      wire(color, [[-0.20 + i * 0.065, 0.80, -0.30], [-0.05 + i * 0.10, 1.17 + (i % 3) * 0.06, -0.60], [-0.25 + i * 0.075, 1.30, -1.03], [-0.69 + (i % 2) * 0.47, 1.0, -1.22 + i * 0.07]]);
    });
    wire(0xcc2e3e, [[0.55, 0.6, -0.8], [0.9, 0.9, 0.25], [0.55, 1.04, 0.73], [0.60, 0.88, 1.10]]);
    wire(0x191c22, [[0.30, 0.65, -0.77], [0.74, 0.75, 0.15], [0.8, 0.87, 0.60], [0.58, 0.88, 1.18]]);
    wire(0x994d91, [[-0.25, 0.81, 0.25], [-0.84, 1.15, 0.52], [-0.85, 1.04, 0.95], [-0.5, 0.89, 1.2]]);
    label(car, "car", "06", "ESP32 四驱实物小车", "蓝色底盘 / 黄轮毂 / 灯板蜂鸣器", [0, 1.58, 0]);

    const curves = [
      new THREE.CatmullRomCurve3([new THREE.Vector3(-3.2, 0.67, 0.3), new THREE.Vector3(-2.6, 0.84, 0.7), new THREE.Vector3(-2.08, 0.67, 0.45)]),
      new THREE.CatmullRomCurve3([new THREE.Vector3(-2.08, 0.8, 0.45), new THREE.Vector3(-0.4, 2.6, -1.9), new THREE.Vector3(1.4, 3.9, -2.8)]),
      new THREE.CatmullRomCurve3([new THREE.Vector3(1.4, 3.9, -2.8), new THREE.Vector3(4.0, 3.4, -2.0), new THREE.Vector3(6.1, 1.8, -1.85)]),
      new THREE.CatmullRomCurve3([new THREE.Vector3(1.4, 3.9, -2.8), new THREE.Vector3(4.8, 2.1, 0.5), new THREE.Vector3(5.9, 0.75, 2.15)]),
      new THREE.CatmullRomCurve3([new THREE.Vector3(-1.5, 0.3, -0.75), new THREE.Vector3(-0.8, 0.7, -3.3), new THREE.Vector3(-3.3, 0.5, -4.6)])
    ];
    const routes = curves.map((curve, index) => {
      const color = index === 3 ? 0xe7b75f : 0x59dce4;
      const line = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.025, 7, false), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.68 }));
      root.add(line);
      const bead = new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 12), new THREE.MeshBasicMaterial({ color, toneMapped: false }));
      root.add(bead);
      return { curve, line, bead, offset: index * 0.28 };
    });

    const assemblyParts = [
      { object: base, assembled: new THREE.Vector3(0, 0, 0), exploded: new THREE.Vector3(0, 0, 0) },
      { object: fmc, assembled: new THREE.Vector3(-1.2, 0.5, -1.62), exploded: new THREE.Vector3(-1.2, 1.2, -1.62) },
      { object: secondary, assembled: new THREE.Vector3(-0.68, 0.73, -1.62), exploded: new THREE.Vector3(-0.68, 2.0, -1.62) },
      { object: cameraModule, assembled: new THREE.Vector3(-0.22, 1.27, -1.62), exploded: new THREE.Vector3(-0.22, 2.7, -1.62) },
      { object: gpioCamera, assembled: new THREE.Vector3(-2.58, 0.66, 0.35), exploded: new THREE.Vector3(-2.58, 1.65, 0.35) }
    ];
    const devices = { fpga: base, rk, fmc, adapter: secondary, cameras: cameraModule, gpioCameras: gpioCamera, display: localDisplay, cloud, upper: display, car };
    Object.entries(devices).forEach(([key, object]) => { object.userData.deviceKey = key; });
    const systemNodes = [assembly, localDisplay, display, cloud, car];
    const selectionBox = new THREE.Box3Helper(new THREE.Box3(), 0x7effde);
    selectionBox.material.depthTest = false;
    selectionBox.material.transparent = true;
    selectionBox.material.opacity = 0.95;
    selectionBox.renderOrder = 100;
    selectionBox.visible = false;
    scene.add(selectionBox);
    let manualAssemblyFocus = false;
    let selectedKey = null;
    let materialRestores = [];
    let cameraGoal = null;
    let targetGoal = null;
    const boundsOf = (objects) => {
      scene.updateMatrixWorld(true);
      const bounds = new THREE.Box3();
      objects.forEach((object) => bounds.union(new THREE.Box3().setFromObject(object)));
      return bounds;
    };
    const frameObjects = (objects, immediate = false) => {
      const bounds = boundsOf(objects);
      const center = bounds.getCenter(new THREE.Vector3());
      const vFov = THREE.MathUtils.degToRad(camera.fov);
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
      const direction = new THREE.Vector3(0.68, 0.72, 1.35).normalize();
      const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize();
      const up = new THREE.Vector3().crossVectors(direction, right).normalize();
      let distance = 2.4;
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        const offset = new THREE.Vector3(x, y, z).sub(center);
        const depth = offset.dot(direction);
        distance = Math.max(distance, depth + Math.abs(offset.dot(right)) * 1.22 / Math.tan(hFov / 2), depth + Math.abs(offset.dot(up)) * 1.3 / Math.tan(vFov / 2));
      }
      cameraGoal = center.clone().addScaledVector(direction, distance);
      targetGoal = center;
      if (immediate) { camera.position.copy(cameraGoal); controls.target.copy(center); cameraGoal = null; targetGoal = null; }
    };
    const restoreHighlight = () => {
      materialRestores.forEach(({ mesh, original, tinted }) => {
        mesh.material = original;
        (Array.isArray(tinted) ? tinted : [tinted]).forEach((mat) => mat.dispose());
      });
      materialRestores = [];
    };
    const applyViewport = () => {
      const narrowScreen = window.matchMedia("(max-width: 760px)").matches;
      camera.fov = narrowScreen ? 45 : 36;
      controls.minDistance = 1.6; controls.maxDistance = 120;
      controls.autoRotate = !selectedKey;
      controls.enableRotate = !selectedKey;
      systemNodes.forEach((object) => { object.visible = !manualAssemblyFocus || object === assembly; });
      routes.forEach(({ line, bead }) => { line.visible = bead.visible = !manualAssemblyFocus && !selectedKey; });
      const focusButton = document.getElementById("deploymentFocus");
      if (focusButton) {
        focusButton.classList.toggle("active", manualAssemblyFocus);
        focusButton.textContent = manualAssemblyFocus ? "系统全景" : "板卡细节";
      }
      camera.updateProjectionMatrix();
      frameObjects(selectedKey ? [devices[selectedKey]] : manualAssemblyFocus ? [assembly] : systemNodes, true);
      camera.lookAt(controls.target);
      controls.update();
    };
    const selectDevice = (key) => {
      const object = devices[key];
      if (!object) return;
      restoreHighlight();
      selectedKey = key;
      manualAssemblyFocus = false;
      systemNodes.forEach((node) => { node.visible = true; });
      object.traverse((mesh) => {
        if (!mesh.isMesh) return;
        const original = mesh.material;
        const tint = (mat) => {
          const clone = mat.clone();
          if (clone.emissive) { clone.emissive.setHex(0x32c6b7); clone.emissiveIntensity = 0.045; }
          return clone;
        };
        const tinted = Array.isArray(original) ? original.map(tint) : tint(original);
        mesh.material = tinted;
        materialRestores.push({ mesh, original, tinted });
      });
      controls.autoRotate = false;
      // Flush the previous orbit's damping before fixing the inspection view.
      controls.enableDamping = false; controls.update();
      controls.enableRotate = false;
      camera.fov = window.matchMedia("(max-width: 760px)").matches ? 45 : 36;
      camera.updateProjectionMatrix();
      frameObjects([object]);
      selectionBox.box.copy(boundsOf([object])).expandByScalar(0.06);
      selectionBox.visible = true;
      document.body.dataset.deploymentSelected = key;
      document.body.dataset.deploymentLocked = "true";
      routes.forEach(({ line, bead }) => { line.visible = bead.visible = false; });
      document.getElementById("deploymentFocus")?.classList.remove("active");
      if (document.getElementById("deploymentFocus")) document.getElementById("deploymentFocus").textContent = "板卡细节";
    };
    const clearSelection = () => {
      restoreHighlight(); selectedKey = null; selectionBox.visible = false;
      cameraGoal = null; targetGoal = null;
      document.body.dataset.deploymentSelected = "";
      document.body.dataset.deploymentLocked = "false";
      controls.enableDamping = true; controls.enableRotate = true;
      applyViewport();
    };
    window.addEventListener("deployment-device-select", (event) => selectDevice(event.detail));
    window.addEventListener("deployment-selection-clear", () => { manualAssemblyFocus = false; clearSelection(); });

    const raycaster = new THREE.Raycaster();
    let pointerDown = null;
    renderer.domElement.addEventListener("pointerdown", (event) => { pointerDown = [event.clientX, event.clientY]; });
    renderer.domElement.addEventListener("pointerup", (event) => {
      if (!pointerDown || Math.hypot(event.clientX - pointerDown[0], event.clientY - pointerDown[1]) > 6) return;
      pointerDown = null;
      const rect = renderer.domElement.getBoundingClientRect();
      const point = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(point, camera);
      const hit = raycaster.intersectObjects(systemNodes, true).find(({ object }) => {
        let parent = object;
        while (parent) { if (!parent.visible) return false; parent = parent.parent; }
        return object.isMesh;
      });
      if (!hit) return;
      let node = hit.object;
      while (node && !node.userData.deviceKey) node = node.parent;
      if (node) window.dispatchEvent(new CustomEvent("deployment-device-select", { detail: node.userData.deviceKey }));
    });
    applyViewport();
    document.getElementById("deploymentFocus")?.addEventListener("click", () => {
      manualAssemblyFocus = !manualAssemblyFocus;
      clearSelection();
      document.getElementById("deploymentSelectionState").textContent = manualAssemblyFocus ? "板卡细节 · 点击部件锁定" : "自由浏览 · 点击部件锁定";
      document.querySelectorAll("[data-deployment-target],.device-label").forEach((button) => { button.classList.remove("selected"); button.setAttribute("aria-pressed", "false"); });
    });
    let explodedProgress = 0;
    function updateAssembly(target, immediate = false) {
      explodedProgress = immediate ? target : THREE.MathUtils.lerp(explodedProgress, target, 0.075);
      assemblyParts.forEach(({ object, assembled, exploded }) => object.position.lerpVectors(assembled, exploded, explodedProgress));
    }
    window.addEventListener("deployment-assembly", (event) => updateAssembly(event.detail ? 1 : 0));

    const resize = new ResizeObserver(() => {
      const nextWidth = Math.max(1, host.clientWidth);
      const nextHeight = Math.max(1, host.clientHeight);
      renderer.setSize(nextWidth, nextHeight, false);
      labels.setSize(nextWidth, nextHeight);
      camera.aspect = nextWidth / nextHeight;
      applyViewport();
    });
    resize.observe(host);
    let visible = true;
    document.addEventListener("visibilitychange", () => { visible = !document.hidden; });
    const clock = new THREE.Clock();
    function animate() {
      requestAnimationFrame(animate);
      if (!visible) return;
      const t = clock.getElapsedTime();
      if (cameraGoal && targetGoal) {
        camera.position.lerp(cameraGoal, 0.12);
        controls.target.lerp(targetGoal, 0.12);
        if (camera.position.distanceTo(cameraGoal) < 0.005) { camera.position.copy(cameraGoal); controls.target.copy(targetGoal); cameraGoal = targetGoal = null; }
      }
      controls.update();
      updateAssembly(document.body.dataset.deploymentAssembly === "exploded" ? 1 : 0);
      if (selectedKey) selectionBox.box.copy(boundsOf([devices[selectedKey]])).expandByScalar(0.06);
      cloud.position.y = 3.9 + Math.sin(t * 0.8) * 0.08;
      routes.forEach(({ curve, line, bead, offset }, index) => {
        const control = document.body.dataset.deploymentFlow === "control";
        line.material.opacity = (index === 3) === control ? 0.9 : 0.2;
        const progress = (t * 0.18 + offset) % 1;
        bead.position.copy(curve.getPointAt(progress));
      });
      renderer.render(scene, camera);
      labels.render(scene, camera);
    }
    host.classList.add("scene-ready");
    animate();
    window.addEventListener("adas-page-change", (event) => { visible = event.detail === "deployment" && !document.hidden; });
  } catch (error) {
    if (fallback) fallback.hidden = false;
    console.error("Deployment 3D scene unavailable", error);
  }
}
