const statusEl = document.getElementById("status");
const runBtn = document.getElementById("runBtn");
const stopBtn = document.getElementById("stopBtn");
const refreshBtn = document.getElementById("refreshBtn");

const speedInput = document.getElementById("speed");
const durationInput = document.getElementById("duration");
const rampInput = document.getElementById("ramp");
const microstepsInput = document.getElementById("microsteps");

const displayUrlEl = document.getElementById("displayUrl");
const copyDisplayUrlBtn = document.getElementById("copyDisplayUrl");
const modelFileInput = document.getElementById("modelFile");
const uploadStatusEl = document.getElementById("uploadStatus");
const displayPreviewIframe = document.getElementById("displayPreview");
const reloadPreviewBtn = document.getElementById("reloadPreview");
const zoomValueEl = document.getElementById("zoomValue");
const rotSliderX = document.getElementById("rotSliderX");
const rotSliderY = document.getElementById("rotSliderY");
const rotSliderZ = document.getElementById("rotSliderZ");
const rotDegXEl = document.getElementById("rotDegX");
const rotDegYEl = document.getElementById("rotDegY");
const rotDegZEl = document.getElementById("rotDegZ");

const PAN_STEP = 0.08;
const ZOOM_STEP = 0.25;

const displayPageUrl = `${window.location.origin}/display`;
displayUrlEl.textContent = displayPageUrl;

function reloadDisplayPreview() {
  if (!displayPreviewIframe) return;
  displayPreviewIframe.src = `${window.location.origin}/display?embed=1&t=${Date.now()}`;
}

function syncZoomLabel(data) {
  if (zoomValueEl && data && typeof data.zoom === "number" && Number.isFinite(data.zoom)) {
    zoomValueEl.textContent = `Zoom: ${data.zoom.toFixed(2)}×`;
  }
}

function degFromRad(r) {
  return Math.round((r * 180) / Math.PI);
}

function clampDeg(d) {
  return Math.max(-180, Math.min(180, d));
}

function syncRotationSlidersFromState(data) {
  if (!data) return;
  const rx = data.rotX;
  const ry = data.rotY;
  const rz = data.rotZ;
  if (![rx, ry, rz].every((v) => typeof v === "number" && Number.isFinite(v))) return;
  const dx = clampDeg(degFromRad(rx));
  const dy = clampDeg(degFromRad(ry));
  const dz = clampDeg(degFromRad(rz));
  if (rotSliderX && document.activeElement !== rotSliderX) rotSliderX.value = String(dx);
  if (rotSliderY && document.activeElement !== rotSliderY) rotSliderY.value = String(dy);
  if (rotSliderZ && document.activeElement !== rotSliderZ) rotSliderZ.value = String(dz);
  updateRotationDegLabelsOnly();
}

function updateRotationDegLabelsOnly() {
  if (rotSliderX && rotDegXEl) rotDegXEl.textContent = `${rotSliderX.value}°`;
  if (rotSliderY && rotDegYEl) rotDegYEl.textContent = `${rotSliderY.value}°`;
  if (rotSliderZ && rotDegZEl) rotDegZEl.textContent = `${rotSliderZ.value}°`;
}

function rotSlidersToSetPayload() {
  const rx = (Number(rotSliderX.value) * Math.PI) / 180;
  const ry = (Number(rotSliderY.value) * Math.PI) / 180;
  const rz = (Number(rotSliderZ.value) * Math.PI) / 180;
  return { mode: "set", rx, ry, rz };
}

let rotSendTimer = null;
function scheduleRotationSendFromSliders() {
  if (rotSendTimer != null) clearTimeout(rotSendTimer);
  rotSendTimer = setTimeout(() => {
    rotSendTimer = null;
    postRotate(rotSlidersToSetPayload()).catch((e) => {
      uploadStatusEl.textContent = e.message;
    });
  }, 45);
}

function syncViewLabels(data) {
  syncZoomLabel(data);
  syncRotationSlidersFromState(data);
}

reloadPreviewBtn.addEventListener("click", () => {
  reloadDisplayPreview();
});

fetch("/api/display/state")
  .then((r) => r.json())
  .then((s) => syncViewLabels(s))
  .catch(() => {});

copyDisplayUrlBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(displayPageUrl);
    copyDisplayUrlBtn.textContent = "Copied";
    setTimeout(() => {
      copyDisplayUrlBtn.textContent = "Copy URL";
    }, 2000);
  } catch {
    copyDisplayUrlBtn.textContent = "Copy failed";
    setTimeout(() => {
      copyDisplayUrlBtn.textContent = "Copy URL";
    }, 2000);
  }
});

async function postPan(body) {
  const res = await fetch("/api/display/pan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Pan failed: ${res.status}`);
  syncViewLabels(data);
  return data;
}

async function postZoom(body) {
  const res = await fetch("/api/display/zoom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Zoom failed: ${res.status}`);
  syncViewLabels(data);
  return data;
}

async function postRotate(body) {
  const res = await fetch("/api/display/rotate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Rotate failed: ${res.status}`);
  syncViewLabels(data);
  return data;
}

function wireRotationSliders() {
  const onInput = () => {
    updateRotationDegLabelsOnly();
    scheduleRotationSendFromSliders();
  };
  for (const el of [rotSliderX, rotSliderY, rotSliderZ]) {
    if (el) el.addEventListener("input", onInput);
  }
  document.getElementById("rotReset").addEventListener("click", async () => {
    try {
      await postRotate({ reset: true });
      if (rotSliderX) rotSliderX.value = "0";
      if (rotSliderY) rotSliderY.value = "0";
      if (rotSliderZ) rotSliderZ.value = "0";
      updateRotationDegLabelsOnly();
    } catch (e) {
      uploadStatusEl.textContent = e.message;
    }
  });
}

wireRotationSliders();

document.getElementById("panUp").addEventListener("click", async () => {
  try {
    await postPan({ dy: PAN_STEP });
  } catch (e) {
    uploadStatusEl.textContent = e.message;
  }
});
document.getElementById("panDown").addEventListener("click", async () => {
  try {
    await postPan({ dy: -PAN_STEP });
  } catch (e) {
    uploadStatusEl.textContent = e.message;
  }
});
document.getElementById("panLeft").addEventListener("click", async () => {
  try {
    await postPan({ dx: -PAN_STEP });
  } catch (e) {
    uploadStatusEl.textContent = e.message;
  }
});
document.getElementById("panRight").addEventListener("click", async () => {
  try {
    await postPan({ dx: PAN_STEP });
  } catch (e) {
    uploadStatusEl.textContent = e.message;
  }
});
document.getElementById("panReset").addEventListener("click", async () => {
  try {
    await postPan({ reset: true });
  } catch (e) {
    uploadStatusEl.textContent = e.message;
  }
});

document.getElementById("resetView").addEventListener("click", async () => {
  try {
    await postPan({ resetView: true });
  } catch (e) {
    uploadStatusEl.textContent = e.message;
  }
});

document.getElementById("zoomIn").addEventListener("click", async () => {
  try {
    await postZoom({ delta: ZOOM_STEP });
  } catch (e) {
    uploadStatusEl.textContent = e.message;
  }
});
document.getElementById("zoomOut").addEventListener("click", async () => {
  try {
    await postZoom({ delta: -ZOOM_STEP });
  } catch (e) {
    uploadStatusEl.textContent = e.message;
  }
});
document.getElementById("zoomReset").addEventListener("click", async () => {
  try {
    await postZoom({ reset: true });
  } catch (e) {
    uploadStatusEl.textContent = e.message;
  }
});

modelFileInput.addEventListener("change", async () => {
  const file = modelFileInput.files && modelFileInput.files[0];
  if (!file) return;
  uploadStatusEl.textContent = "Uploading STL…";
  const fd = new FormData();
  fd.append("model", file);
  try {
    const res = await fetch("/api/display/upload-model", {
      method: "POST",
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Upload failed: ${res.status}`);
    uploadStatusEl.textContent = `STL uploaded: ${data.modelUrl}`;
    modelFileInput.value = "";
    reloadDisplayPreview();
  } catch (e) {
    uploadStatusEl.textContent = e.message;
  }
});

function formatStatus(status) {
  return JSON.stringify(status, null, 2);
}

async function fetchStatus() {
  const res = await fetch("/api/motor/status");
  if (!res.ok) throw new Error(`Status request failed: ${res.status}`);
  return res.json();
}

async function runMotor() {
  const payload = {
    speed: Number(speedInput.value),
    duration: Number(durationInput.value),
    ramp: Number(rampInput.value),
    microsteps: Number(microstepsInput.value),
  };
  const res = await fetch("/api/motor/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Run request failed: ${res.status}`);
  statusEl.textContent = formatStatus(body.status);
}

async function stopMotor() {
  const res = await fetch("/api/motor/stop", { method: "POST" });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Stop request failed: ${res.status}`);
  statusEl.textContent = formatStatus(body.status);
}

runBtn.addEventListener("click", async () => {
  try {
    await runMotor();
  } catch (error) {
    statusEl.textContent = `Run error: ${error.message}`;
  }
});

stopBtn.addEventListener("click", async () => {
  try {
    await stopMotor();
  } catch (error) {
    statusEl.textContent = `Stop error: ${error.message}`;
  }
});

refreshBtn.addEventListener("click", async () => {
  try {
    const status = await fetchStatus();
    statusEl.textContent = formatStatus(status);
  } catch (error) {
    statusEl.textContent = `Status error: ${error.message}`;
  }
});

async function pollStatus() {
  try {
    const status = await fetchStatus();
    statusEl.textContent = formatStatus(status);
  } catch (error) {
    statusEl.textContent = `Status error: ${error.message}`;
  } finally {
    setTimeout(pollStatus, 2000);
  }
}

pollStatus();
