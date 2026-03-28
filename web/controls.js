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
const imageFileInput = document.getElementById("imageFile");
const uploadStatusEl = document.getElementById("uploadStatus");
const displayPreviewIframe = document.getElementById("displayPreview");
const reloadPreviewBtn = document.getElementById("reloadPreview");
const zoomValueEl = document.getElementById("zoomValue");

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

reloadPreviewBtn.addEventListener("click", () => {
  reloadDisplayPreview();
});

fetch("/api/display/state")
  .then((r) => r.json())
  .then((s) => syncZoomLabel(s))
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
  syncZoomLabel(data);
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
  syncZoomLabel(data);
  return data;
}

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
  uploadStatusEl.textContent = "Uploading 3D model…";
  const fd = new FormData();
  fd.append("model", file);
  try {
    const res = await fetch("/api/display/upload-model", {
      method: "POST",
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Model upload failed: ${res.status}`);
    uploadStatusEl.textContent = `Model uploaded. Display: ${data.modelUrl}`;
    modelFileInput.value = "";
    reloadDisplayPreview();
  } catch (e) {
    uploadStatusEl.textContent = e.message;
  }
});

imageFileInput.addEventListener("change", async () => {
  const file = imageFileInput.files && imageFileInput.files[0];
  if (!file) return;
  uploadStatusEl.textContent = "Uploading image…";
  const fd = new FormData();
  fd.append("image", file);
  try {
    const res = await fetch("/api/display/upload", {
      method: "POST",
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Upload failed: ${res.status}`);
    uploadStatusEl.textContent = `Image uploaded. Display will use: ${data.imageUrl} (3D model cleared)`;
    imageFileInput.value = "";
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
