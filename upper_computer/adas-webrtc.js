(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const video = $("webrtcVideo");
  const state = $("webrtcState");
  const metrics = $("webrtcMetrics");
  const connectButton = $("whepConnect");
  const disconnectButton = $("whepDisconnect");
  const endpoint = new URL("/watch/adas/vehicle-01/whep", window.location.origin).href;
  let peer = null;
  let sessionUrl = "";
  let statsTimer = 0;
  let retryTimer = 0;
  let disconnectedTimer = 0;
  let retryCount = 0;
  let generation = 0;
  let manualDisconnect = true;
  let lastStats = null;
  let statusSnapshot = {};

  const finiteNumber = (value) => typeof value === "number" && Number.isFinite(value) ? value : NaN;

  function publishStatus(detail = {}) {
    const { reset, ...update } = detail;
    if (reset) statusSnapshot = {};
    statusSnapshot = { ...statusSnapshot, ...update,
      connectionState: detail.connectionState || peer?.connectionState || (manualDisconnect ? "closed" : "connecting") };
    window.dispatchEvent(new CustomEvent("adas-webrtc-status", {
      detail: { ...statusSnapshot, reset: Boolean(reset) },
    }));
  }

  function setState(message, kind = "pending", detail = {}) {
    state.textContent = message;
    state.className = `webrtc-state ${kind}`;
    publishStatus({ ...detail, message, kind });
  }

  function setMetrics({ width, height, fps, bitrate } = {}) {
    const resolution = width && height ? `${width}×${height}` : "—";
    const fpsText = Number.isFinite(fps) ? `${fps.toFixed(1)} FPS` : "— FPS";
    const rateText = Number.isFinite(bitrate) ? `${bitrate < 1000 ? Math.round(bitrate) + " kb/s" : (bitrate / 1000).toFixed(2) + " Mb/s"}` : "—";
    metrics.textContent = `分辨率 ${resolution} · ${fpsText} · 码率 ${rateText}`;
  }

  function waitForIce(peerConnection, timeoutMs = 5000) {
    if (peerConnection.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        peerConnection.removeEventListener("icegatheringstatechange", changed);
        resolve();
      };
      const timeout = setTimeout(finish, timeoutMs);
      const changed = () => {
        if (peerConnection.iceGatheringState === "complete") finish();
      };
      peerConnection.addEventListener("icegatheringstatechange", changed);
    });
  }

  async function removeSession(url) {
    if (!url) return;
    try {
      await fetch(url, { method: "DELETE", keepalive: true, signal: AbortSignal.timeout(3000) });
    } catch {}
  }

  function closePeer({ deleteResource = true } = {}) {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = 0;
    if (disconnectedTimer) clearTimeout(disconnectedTimer);
    disconnectedTimer = 0;
    const oldPeer = peer;
    peer = null;
    video.srcObject = null;
    $("webrtcPlaceholder").hidden = false;
    const oldSession = sessionUrl;
    sessionUrl = "";
    if (deleteResource && oldSession) {
      void removeSession(oldSession).finally(() => oldPeer?.close());
    } else if (oldPeer) oldPeer.close();
    lastStats = null;
    setMetrics();
    disconnectButton.disabled = true;
    publishStatus({ reset: true, connectionState: "closed", message: "已断开", receivingNow: false });
  }

  function startStats(peerConnection, attemptGeneration) {
    if (statsTimer) return;
    void updateStats(peerConnection, attemptGeneration);
    statsTimer = window.setInterval(() => updateStats(peerConnection, attemptGeneration), 1000);
  }

  function scheduleReconnect(message) {
    if (manualDisconnect || retryTimer) return;
    closePeer();
    retryCount += 1;
    const delay = Math.min(15000, 1000 * (2 ** Math.min(retryCount - 1, 4)));
    setState(`${message} · ${Math.ceil(delay / 1000)} 秒后重连（第 ${retryCount} 次）`, "bad");
    retryTimer = window.setTimeout(() => {
      retryTimer = 0;
      connectAttempt(generation);
    }, delay);
  }

  async function connectAttempt(attemptGeneration) {
    if (!/^https:\/\//i.test(endpoint)) {
      manualDisconnect = true;
      setState("WHEP 地址必须使用 HTTPS", "bad");
      connectButton.disabled = false;
      return;
    }

    closePeer();
    connectButton.disabled = true;
    setState(retryCount ? "正在重新协商 WebRTC 视频…" : "正在协商 WebRTC 视频…");
    const peerConnection = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
    peer = peerConnection;
    disconnectButton.disabled = false;
    peerConnection.addTransceiver("video", { direction: "recvonly" });
    peerConnection.ontrack = (event) => {
      if (attemptGeneration !== generation || peer !== peerConnection) return;
      event.track.onended = () => {
        if (attemptGeneration === generation && peer === peerConnection) scheduleReconnect("视频轨道已结束");
      };
      video.srcObject = event.streams[0] || new MediaStream([event.track]);
      $("webrtcPlaceholder").hidden = true;
      video.play().catch(() => setState("已连接 · 点击视频区域开始播放", "good"));
    };
    peerConnection.onconnectionstatechange = () => {
      if (attemptGeneration !== generation || peer !== peerConnection) return;
      if (disconnectedTimer) clearTimeout(disconnectedTimer);
      disconnectedTimer = 0;
      if (peerConnection.connectionState === "connected") {
        retryCount = 0;
        setState("已连接 · 等待视频帧");
        disconnectButton.disabled = false;
        startStats(peerConnection, attemptGeneration);
      } else if (peerConnection.connectionState === "disconnected") {
        setState("视频连接中断 · 正在尝试恢复…", "bad");
        disconnectedTimer = window.setTimeout(() => {
          if (peerConnection.connectionState === "disconnected") scheduleReconnect("视频已断开");
        }, 3500);
      } else if (peerConnection.connectionState === "failed") {
        scheduleReconnect("WebRTC 连接失败");
      }
    };

    try {
      await peerConnection.setLocalDescription(await peerConnection.createOffer());
      await waitForIce(peerConnection);
      if (attemptGeneration !== generation || peer !== peerConnection) return;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/sdp",
          Accept: "application/sdp",
        },
        body: peerConnection.localDescription.sdp,
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error(`WHEP HTTP ${response.status}`);
      const answer = await response.text();
      if (!answer.trim()) throw new Error("WHEP 未返回 SDP Answer");
      const resourceLocation = response.headers.get("Location");
      const resource = resourceLocation ? new URL(resourceLocation, endpoint) : null;
      if (resource && (resource.origin !== window.location.origin || !resource.pathname.startsWith("/watch/adas/vehicle-01/whep/"))) {
        throw new Error("视频会话地址异常");
      }
      if (attemptGeneration !== generation || peer !== peerConnection) {
        if (resource) void removeSession(resource.href);
        return;
      }
      sessionUrl = resource?.href || "";
      await peerConnection.setRemoteDescription({ type: "answer", sdp: answer });
      disconnectButton.disabled = false;
      if (peerConnection.connectionState === "connected") {
        setState("已连接 · 等待视频帧");
        startStats(peerConnection, attemptGeneration);
      } else {
        setState("已收到媒体服务应答 · 等待视频连接");
      }
    } catch (error) {
      if (attemptGeneration !== generation || manualDisconnect) return;
      closePeer();
      scheduleReconnect(`连接失败：${error.message || error}`);
    } finally {
      if (attemptGeneration === generation) connectButton.disabled = false;
    }
  }

  async function updateStats(peerConnection, attemptGeneration) {
    try {
      const report = await peerConnection.getStats();
      if (attemptGeneration !== generation || peer !== peerConnection) return;
      const inbound = [...report.values()].find((item) => item.type === "inbound-rtp" && (item.kind === "video" || item.mediaType === "video"));
      if (!inbound) {
        setState("已连接 · 等待视频帧", "pending", { receivingNow: false });
        return;
      }
      const now = finiteNumber(inbound.timestamp) || performance.now();
      if (lastStats?.id !== inbound.id) lastStats = null;
      const bytes = finiteNumber(inbound.bytesReceived);
      const frames = finiteNumber(inbound.framesReceived);
      const decodedFrames = finiteNumber(inbound.framesDecoded);
      const elapsed = lastStats ? (now - lastStats.at) / 1000 : 0;
      const rate = (value, previous) => elapsed > 0 && Number.isFinite(value) && Number.isFinite(previous) && value >= previous
        ? (value - previous) / elapsed : NaN;
      const fps = rate(frames, lastStats?.frames);
      const decodeRate = rate(decodedFrames, lastStats?.decodedFrames);
      const decodeFps = Number.isFinite(decodeRate) ? decodeRate : finiteNumber(inbound.framesPerSecond);
      const receivingNow = (Number.isFinite(frames) && frames > 0 && (!lastStats || frames > lastStats.frames))
        || (Number.isFinite(decodedFrames) && decodedFrames > 0 && (!lastStats || decodedFrames > lastStats.decodedFrames));
      const bitrate = rate(bytes, lastStats?.bytes) * 8 / 1000;
      lastStats = { id: inbound.id, at: now, bytes, frames, decodedFrames };
      const width = Number(inbound.frameWidth || video.videoWidth) || 0;
      const height = Number(inbound.frameHeight || video.videoHeight) || 0;
      setMetrics({ width, height, fps, bitrate });
      const transport = [...report.values()].find((item) => item.type === "transport" && item.selectedCandidatePairId);
      const pair = transport ? report.get(transport.selectedCandidatePairId) : null;
      setState(receivingNow ? "正在接收视频帧" : "已连接 · 当前无新帧", receivingNow ? "good" : "pending", {
        sampleId: `${inbound.id}:${now}`,
        hasVideoTrack: Boolean(video.srcObject),
        receivingNow,
        framesReceived: Number.isFinite(frames) ? frames : null,
        framesDecoded: Number.isFinite(decodedFrames) ? decodedFrames : null,
        fps: Number.isFinite(fps) ? fps : null,
        decodeFps: Number.isFinite(decodeFps) ? decodeFps : null,
        bitrateKbps: Number.isFinite(bitrate) ? bitrate : null,
        width: width || null,
        height: height || null,
        packetsLost: finiteNumber(inbound.packetsLost),
        framesDropped: finiteNumber(inbound.framesDropped),
        freezeCount: finiteNumber(inbound.freezeCount),
        jitterMs: finiteNumber(inbound.jitter) * 1000,
        rttMs: finiteNumber(pair?.currentRoundTripTime) * 1000,
      });
    } catch {}
  }

  function connect() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = 0;
    generation += 1;
    retryCount = 0;
    manualDisconnect = false;
    void connectAttempt(generation);
  }

  function disconnect() {
    manualDisconnect = true;
    generation += 1;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = 0;
    closePeer();
    connectButton.disabled = false;
    setState("已断开");
  }

  connectButton.addEventListener("click", connect);
  disconnectButton.addEventListener("click", disconnect);
  window.addEventListener("beforeunload", () => {
    manualDisconnect = true;
    if (retryTimer) clearTimeout(retryTimer);
    closePeer();
  });
})();
