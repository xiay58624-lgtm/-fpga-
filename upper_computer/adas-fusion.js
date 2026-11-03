(function (root) {
  "use strict";
  // Port of surround_view_pipeline.py + pano_to_surround_ring.py, two passes.
  // The handoff document's confirmed far_row is .45, not the CLI default .38.
  const defaults = Object.freeze({ size: 1024, panoWidth: 1024, panoHeight: 512,
    verticalFov: 110, fov: 190, pitchDown: 28, sectorHalf: 60, sectorFeather: 5,
    inner: .17, outer: .49, nearRow: .68, farRow: .45,
    layout: Object.freeze([0, 3, 1, 2]) }); // front, right, rear, left; existing UI channel order.
  const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
  const radians = (x) => x * Math.PI / 180;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
  function validate(options = {}) {
    const c = { ...defaults, ...options, layout: [...(options.layout || defaults.layout)] };
    for (const key of Object.keys(defaults).filter((key) => key !== "layout")) {
      if (!Number.isFinite(c[key])) throw new Error(`Invalid fusion parameter: ${key}`);
    }
    if (![c.size, c.panoWidth, c.panoHeight].every((n) => Number.isInteger(n) && n >= 32 && n <= 2048)
      || c.inner <= 0 || c.outer <= c.inner || c.outer > .5
      || c.fov < 90 || c.fov > 220 || c.verticalFov <= 0 || c.verticalFov >= 180
      || c.sectorHalf <= 45 || c.sectorHalf > 90 || c.sectorFeather <= 0
      || c.pitchDown < -60 || c.pitchDown > 60 || c.nearRow <= c.farRow
      || c.farRow < 0 || c.nearRow > 1 || c.layout.length !== 4
      || new Set(c.layout).size !== 4 || c.layout.some((n) => !Number.isInteger(n) || n < 0 || n > 3)) {
      throw new Error("Invalid fusion dimensions, projection, or camera mapping");
    }
    return c;
  }
  async function buildMaps(options = {}, yieldRows = true) {
    const c = validate(options), { panoWidth: w, panoHeight: h, size: n } = c;
    const maps = Array.from({ length: 4 }, () => new Float32Array(w * h * 4));
    const ring = new Float32Array(n * n * 4);
    const cp = Math.cos(radians(c.pitchDown)), sp = Math.sin(radians(c.pitchDown));
    const axes = [0, 90, 180, -90].map((yaw) => [Math.sin(radians(yaw)), Math.cos(radians(yaw))]);
    const halfFov = radians(c.fov * .5), halfSector = radians(c.sectorHalf), feather = radians(c.sectorFeather);
    for (let y = 0; y < h; y++) {
      const latitude = (.5 - (y + .5) / h) * radians(c.verticalFov);
      const cosLat = Math.cos(latitude), wy = Math.sin(latitude);
      for (let x = 0; x < w; x++) {
        const longitude = (x + .5) / w * Math.PI * 2 - Math.PI;
        const wx = cosLat * Math.sin(longitude), wz = cosLat * Math.cos(longitude), offset = (y * w + x) * 4;
        axes.forEach(([sinYaw, cosYaw], camera) => {
          const a = wx * cosYaw - wz * sinYaw, horizontalForward = wx * sinYaw + wz * cosYaw;
          const b = horizontalForward * sp + wy * cp, forward = horizontalForward * cp - wy * sp;
          const around = Math.hypot(a, b), rnorm = Math.atan2(around, forward) / halfFov;
          const map = maps[camera];
          map[offset] = .5 + .5 * rnorm * (around > 1e-7 ? a / around : 0);
          map[offset + 1] = .5 - .5 * rnorm * (around > 1e-7 ? b / around : 0);
          const sector = clamp((halfSector - Math.abs(Math.atan2(a, horizontalForward))) / feather);
          map[offset + 2] = rnorm <= .985 ? (.06 + .94 * clamp((.985 - rnorm) / .20)) * sector : 0;
        });
      }
      if (yieldRows && y % 64 === 63) await pause();
    }
    const center = (n - 1) * .5, inner = c.inner * n, outer = c.outer * n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = x - center, dy = y - center, radius = Math.hypot(dx, dy), offset = (y * n + x) * 4;
        const radial = clamp((radius - inner) / Math.max(outer - inner, 1));
        const angle = .5 + Math.atan2(dx, -dy) / (Math.PI * 2);
        ring[offset] = ((angle % 1) + 1) % 1;
        ring[offset + 1] = c.nearRow + (c.farRow - c.nearRow) * radial;
        ring[offset + 2] = radius >= inner && radius <= outer ? 1 : 0;
      }
      if (yieldRows && y % 64 === 63) await pause();
    }
    return { config: c, cameras: maps, ring };
  }
  const vertex = `#version 300 es
  void main(){ vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2); gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;
  const panorama = `#version 300 es
  precision highp float; precision highp int;
  uniform sampler2D videoTexture, map0, map1, map2, map3;
  uniform ivec2 sourceSize; uniform int cameraTiles[4]; out vec4 color;
  vec3 atPixel(ivec2 p,ivec2 origin,ivec2 size){
    if(any(lessThan(p,ivec2(0)))||any(greaterThanEqual(p,size))) return vec3(0.0);
    return texelFetch(videoTexture,origin+p,0).rgb*255.0;
  }
  vec3 sampleView(vec2 uv,int tile){
    ivec2 halfSize=sourceSize/2;
    ivec2 origin=ivec2((tile%2)*halfSize.x,(tile/2)*halfSize.y);
    ivec2 size=ivec2(tile%2==1?sourceSize.x-halfSize.x:halfSize.x,tile>1?sourceSize.y-halfSize.y:halfSize.y);
    // OpenCV INTER_LINEAR uses a 1/32-pixel interpolation table.
    vec2 q=floor(uv*vec2(size)*32.0+0.5)/32.0;
    ivec2 p=ivec2(floor(q)); vec2 f=fract(q);
    if(all(greaterThanEqual(p,ivec2(0)))&&all(lessThan(p+1,size)))
      return texture(videoTexture,(vec2(origin)+q+0.5)/vec2(sourceSize)).rgb*255.0;
    return mix(mix(atPixel(p,origin,size),atPixel(p+ivec2(1,0),origin,size),f.x),
      mix(atPixel(p+ivec2(0,1),origin,size),atPixel(p+1,origin,size),f.x),f.y);
  }
  void addView(vec4 m,int tile,inout vec3 acc,inout float weights){
    if(m.z>0.0){ acc+=floor(sampleView(m.xy,tile)+0.5)*m.z; weights+=m.z; }
  }
  void main(){
    ivec2 p=ivec2(gl_FragCoord.xy); vec3 acc=vec3(0.0); float weights=0.0;
    addView(texelFetch(map0,p,0),cameraTiles[0],acc,weights); addView(texelFetch(map1,p,0),cameraTiles[1],acc,weights);
    addView(texelFetch(map2,p,0),cameraTiles[2],acc,weights); addView(texelFetch(map3,p,0),cameraTiles[3],acc,weights);
    color=vec4(weights>1e-5?floor(clamp(acc/weights,0.0,255.0)+0.00001)/255.0:vec3(0.0),1.0);
  }`;
  const ringShader = `#version 300 es
  precision highp float; precision highp int;
  uniform sampler2D panoramaTexture, ringMap; uniform ivec2 panoSize; uniform int outputSize; out vec4 color;
  void main(){
    // Map arrays and intermediate panorama are top-down; flip only at display.
    ivec2 p=ivec2(int(gl_FragCoord.x),outputSize-1-int(gl_FragCoord.y)); vec4 m=texelFetch(ringMap,p,0);
    if(m.z<0.5){ color=vec4(24.0/255.0,19.0/255.0,15.0/255.0,1.0); return; }
    vec2 q=floor(m.xy*vec2(panoSize)*32.0+0.5)/32.0;
    color=vec4(texture(panoramaTexture,(q+0.5)/vec2(panoSize)).rgb,1.0);
  }`;
  function program(gl, fragment) {
    const shaders = [gl.VERTEX_SHADER, gl.FRAGMENT_SHADER].map((type, index) => {
      const s = gl.createShader(type); gl.shaderSource(s, index ? fragment : vertex); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const error = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error(error); }
      return s;
    });
    const p = gl.createProgram(); shaders.forEach((s) => gl.attachShader(p, s)); gl.linkProgram(p);
    shaders.forEach((s) => gl.deleteShader(s));
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { const error = gl.getProgramInfoLog(p); gl.deleteProgram(p); throw new Error(error); }
    return p;
  }
  function overlay(c) {
    const canvas = document.createElement("canvas"), n = c.size, mid = n / 2;
    canvas.width = canvas.height = n;
    const ctx = canvas.getContext("2d"), inner = Math.floor(c.inner * n);
    ctx.fillStyle = "#16100a"; ctx.beginPath(); ctx.arc(mid, mid, inner + 5, 0, Math.PI * 2); ctx.fill();
    const points = [[-.075,-.14],[.075,-.14],[.112,-.09],[.112,.13],[.07,.17],[-.07,.17],[-.112,.13],[-.112,-.09]];
    ctx.beginPath(); points.forEach(([x, y], i) => ctx[i ? "lineTo" : "moveTo"](mid + x * n, mid + y * n)); ctx.closePath();
    ctx.fillStyle = "#1d160d"; ctx.fill(); ctx.strokeStyle = "#e8dcc3"; ctx.lineWidth = 3; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(mid, mid - 20); ctx.lineTo(mid, mid + 28); ctx.stroke();
    const arrow = mid - inner - 55; ctx.strokeStyle = "#facd5a"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(mid, arrow + 40); ctx.lineTo(mid, arrow); ctx.moveTo(mid - 10, arrow + 15); ctx.lineTo(mid, arrow); ctx.lineTo(mid + 10, arrow + 15); ctx.stroke();
    ctx.font = `${Math.max(18, n * .024)}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    [["FRONT",mid,50],["RIGHT",n-72,mid],["REAR",mid,n-52],["LEFT",72,mid]].forEach(([text,x,y]) => {
      const width = ctx.measureText(text).width + 26; ctx.fillStyle = "#181109"; ctx.fillRect(x-width/2,y-21,width,42);
      ctx.strokeStyle = "#d7af78"; ctx.lineWidth = 2; ctx.strokeRect(x-width/2,y-21,width,42); ctx.fillStyle = "#f8f5f0"; ctx.fillText(text,x,y);
    });
    ctx.strokeStyle = "#aa916e"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(mid,mid,Math.floor(c.outer*n),0,Math.PI*2); ctx.stroke();
    return canvas;
  }
  class Renderer {
    static async create(options = {}) {
      const config = validate(options), renderer = new Renderer(config);
      try { renderer.initialize(await buildMaps(config)); return renderer; }
      catch (error) { renderer.destroy(); throw error; }
    }
    constructor(config) {
      this.config = config; this.surface = document.createElement("canvas"); this.surface.width = this.surface.height = config.size;
      this.gl = this.surface.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "high-performance" });
      if (!this.gl) throw new Error("浏览器不支持 WebGL2");
      this.textures = []; this.programs = []; this.frames = 0;
    }
    initialize(maps) {
      const gl = this.gl, c = this.config;
      this.panoProgram = program(gl, panorama); this.programs.push(this.panoProgram);
      this.ringProgram = program(gl, ringShader); this.programs.push(this.ringProgram);
      this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
      this.sourceTexture = this.texture(null, 1, 1, false, true);
      this.cameraMaps = maps.cameras.map((data) => this.texture(data, c.panoWidth, c.panoHeight, true));
      this.ringMap = this.texture(maps.ring, c.size, c.size, true);
      this.panoTexture = this.texture(null, c.panoWidth, c.panoHeight, false, true);
      gl.bindTexture(gl.TEXTURE_2D, this.panoTexture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      this.framebuffer = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.panoTexture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("融合帧缓冲不可用");
      this.overlay = overlay(c);
      if (gl.getError() !== gl.NO_ERROR) throw new Error("融合映射纹理初始化失败");
    }
    texture(data, width, height, floating, linear = false) {
      const gl = this.gl, texture = gl.createTexture(); this.textures.push(texture); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, floating ? gl.RGBA32F : gl.RGBA8, width, height, 0, gl.RGBA, floating ? gl.FLOAT : gl.UNSIGNED_BYTE, data);
      return texture;
    }
    bind(p, name, texture, unit) {
      const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture); gl.uniform1i(gl.getUniformLocation(p, name), unit);
    }
    render(source, canvas, withOverlay = true) {
      const gl = this.gl, c = this.config, width = source.videoWidth || source.width, height = source.videoHeight || source.height;
      if (gl.isContextLost()) throw new Error("GPU 上下文已丢失");
      if (width < 2 || height < 2) throw new Error("融合输入尺寸无效");
      gl.bindVertexArray(this.vao); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      // Set uniforms only after selecting the corresponding program.
      gl.useProgram(this.panoProgram); this.bind(this.panoProgram, "videoTexture", this.sourceTexture, 0);
      if (this.sourceWidth !== width || this.sourceHeight !== height) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        this.sourceWidth = width; this.sourceHeight = height;
      } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.uniform2i(gl.getUniformLocation(this.panoProgram, "sourceSize"), width, height);
      gl.uniform1iv(gl.getUniformLocation(this.panoProgram, "cameraTiles[0]"), new Int32Array(c.layout));
      this.cameraMaps.forEach((texture, i) => this.bind(this.panoProgram, `map${i}`, texture, i + 1));
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer); gl.viewport(0, 0, c.panoWidth, c.panoHeight); gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.useProgram(this.ringProgram); this.bind(this.ringProgram, "panoramaTexture", this.panoTexture, 0); this.bind(this.ringProgram, "ringMap", this.ringMap, 1);
      gl.uniform2i(gl.getUniformLocation(this.ringProgram, "panoSize"), c.panoWidth, c.panoHeight); gl.uniform1i(gl.getUniformLocation(this.ringProgram, "outputSize"), c.size);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, c.size, c.size); gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (gl.getError() !== gl.NO_ERROR) throw new Error("GPU 融合渲染失败");
      if (canvas.width !== c.size || canvas.height !== c.size) canvas.width = canvas.height = c.size;
      const ctx = canvas.getContext("2d"); ctx.setTransform(1,0,0,1,0,0); ctx.drawImage(this.surface,0,0);
      if (withOverlay) ctx.drawImage(this.overlay,0,0);
      this.frames += 1;
    }
    destroy() {
      const gl = this.gl;
      this.textures?.forEach((t) => gl.deleteTexture(t)); this.programs?.forEach((p) => gl.deleteProgram(p));
      if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer); if (this.vao) gl.deleteVertexArray(this.vao);
      const lose = gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext();
    }
  }
  function createController({ video, canvas, state, metrics, start, stop, inputState, placeholder }) {
    let config = validate(), visible = false, status = {}, renderer = null, building = null, generation = 0, error = "";
    let frameId = 0, frameMode = "", lastTime = -1, frames = 0, sampleAt = 0, sampleFrames = 0;
    let inputSampleAt = -Infinity, inputSampleCanvas = null;
    const available = () => visible && !document.hidden && status.connectionState === "connected" && status.receivingNow === true
      && video.srcObject && video.readyState >= 2 && video.videoWidth > 1 && video.videoHeight > 1;
    const cancel = () => {
      if (frameMode === "video") video.cancelVideoFrameCallback?.(frameId); else if (frameId) cancelAnimationFrame(frameId);
      frameId = 0; frameMode = "";
    };
    function showPlaceholder() {
      if (canvas.dataset.fusionMode !== "placeholder") placeholder();
      canvas.dataset.fusionMode = "placeholder"; delete canvas.dataset.fusionFrame;
      metrics.textContent = `— FPS · ${config.size} × ${config.size}`; sampleAt = 0; lastTime = -1;
      inputSampleAt = -Infinity;
      if (inputState) { inputState.hidden = true; inputState.textContent = ""; }
    }
    function inspectInput(now) {
      if (!inputState || now - inputSampleAt < 1000) return;
      inputSampleAt = now;
      if (!inputSampleCanvas) {
        inputSampleCanvas = document.createElement("canvas"); inputSampleCanvas.width = 64; inputSampleCanvas.height = 36;
      }
      const ctx = inputSampleCanvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(video,0,0,64,36);
      const pixels = ctx.getImageData(0,0,64,36).data, dark = [];
      for (let tile = 0; tile < 4; tile++) {
        let black = 0;
        for (let y = 0; y < 18; y++) for (let x = 0; x < 32; x++) {
          const i = ((y+Math.floor(tile/2)*18)*64+x+tile%2*32)*4;
          if (Math.max(pixels[i],pixels[i+1],pixels[i+2]) < 12) black++;
        }
        if (black / (32*18) >= .92) dark.push(tile+1);
      }
      inputState.hidden = !dark.length;
      inputState.textContent = dark.length ? `通道 ${dark.join(" / ")} 近全黑 · 请检查视频输入` : "";
    }
    function refresh(force = false) {
      const connected = status.connectionState === "connected", connecting = status.connectionState === "connecting";
      start.disabled = connected || connecting; stop.disabled = !connected && !connecting;
      if (!visible) { cancel(); return; }
      if (!available()) {
        cancel(); if (force) delete canvas.dataset.fusionMode; showPlaceholder();
        state.textContent = connected ? "等待实时帧" : "等待视频连接"; return;
      }
      if (error) { cancel(); showPlaceholder(); state.textContent = error; return; }
      if (!renderer) {
        state.textContent = "正在建立融合映射";
        if (!building) {
          const attempt = generation;
          building = Renderer.create(config).then((result) => {
            if (attempt !== generation) { result.destroy(); return; }
            renderer = result; building = null; refresh();
          }).catch((reason) => {
            if (attempt !== generation) return;
            building = null; error = reason.message || "融合初始化失败"; refresh();
          });
        }
        return;
      }
      if (video.currentTime !== lastTime || canvas.dataset.fusionMode !== "live") {
        try { renderer.render(video, canvas); }
        catch (reason) { error = reason.message || "融合渲染失败"; refresh(); return; }
        lastTime = video.currentTime; frames += 1; canvas.dataset.fusionMode = "live"; canvas.dataset.fusionFrame = String(frames);
        state.textContent = "实时融合中";
        const now = performance.now();
        try { inspectInput(now); } catch { if (inputState) inputState.hidden = true; }
        if (!sampleAt) { sampleAt = now; sampleFrames = frames; }
        if (now - sampleAt >= 1000) {
          metrics.textContent = `${((frames-sampleFrames)*1000/(now-sampleAt)).toFixed(1)} FPS · ${config.size} × ${config.size}`;
          sampleAt = now; sampleFrames = frames;
        }
      }
      if (!frameId) {
        frameMode = video.requestVideoFrameCallback ? "video" : "animation";
        const tick = () => { frameId = 0; refresh(); };
        frameId = frameMode === "video" ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
      }
    }
    const controller = {
      setVisible(value) { visible = value; refresh(true); }, updateStatus(value) { status = value || {}; refresh(); }, refresh,
      configure(value) {
        const next = validate(value); generation += 1; cancel(); renderer?.destroy(); renderer = null; building = null; config = next; error = ""; lastTime = -1;
        frames = 0; sampleAt = 0; delete canvas.dataset.fusionMode; refresh(true);
      },
      destroy() { visible = false; generation += 1; cancel(); renderer?.destroy(); },
    };
    ["playing", "loadeddata", "resize"].forEach((event) => video.addEventListener(event, () => refresh()));
    document.addEventListener("visibilitychange", () => refresh());
    window.addEventListener("beforeunload", () => controller.destroy());
    return controller;
  }
  const api = { defaults, validate, buildMaps, Renderer, createController };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AdasFusion = api;
})(typeof window === "object" ? window : globalThis);
