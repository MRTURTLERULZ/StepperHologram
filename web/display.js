import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

window.addEventListener("error", (ev) => {
  setLoadHint(`Script error: ${ev.message || "see console"}`);
});

window.addEventListener("unhandledrejection", (ev) => {
  setLoadHint(`Load error: ${ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason)}`);
});

const urlParams = new URLSearchParams(window.location.search);
const isEmbedPreview = urlParams.get("embed") === "1";

/** Lower = higher FPS (fewer pixels). Default 1 targets 120 Hz displays; add ?dpr=2 for sharper. */
const dprParam = urlParams.get("dpr");
const maxDevicePixelRatio =
  dprParam != null && dprParam !== ""
    ? Math.min(3, Math.max(0.5, Number(dprParam)))
    : 1;

function resolveSiteUrl(u) {
  if (u == null) return "";
  const t = String(u).trim();
  if (!t) return "";
  try {
    if (/^https?:\/\//i.test(t)) return new URL(t).href;
    const path = t.startsWith("/") ? t : `/${t.replace(/^\/+/, "")}`;
    return new URL(path, window.location.origin).href;
  } catch {
    return "";
  }
}

function normalizeModelUrl(v) {
  if (v == null) return "";
  return String(v).trim();
}

const container = document.getElementById("three-container");

const renderer = new THREE.WebGLRenderer({
  antialias: false,
  alpha: false,
  depth: true,
  stencil: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDevicePixelRatio));
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0c1520);

scene.add(new THREE.AmbientLight(0x7a8fa8, 0.58));
const keyLight = new THREE.DirectionalLight(0xf2f6ff, 1);
keyLight.position.set(2.6, 4.8, 3.6);
scene.add(keyLight);

const camera = new THREE.PerspectiveCamera(
  50,
  container.clientWidth / container.clientHeight,
  0.05,
  500
);

const BASE_CAM_X = 0;
const BASE_CAM_Y = 0.35;
const BASE_CAM_Z = 3.6;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 6;

let zoomLevel = 1;

function clampClientZoom(z) {
  if (!Number.isFinite(z)) return 1;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
}

function applyCameraZoom() {
  const z = clampClientZoom(zoomLevel);
  camera.position.set(BASE_CAM_X, BASE_CAM_Y, BASE_CAM_Z / z);
  camera.lookAt(0, 0, 0);
}

applyCameraZoom();

const spinGroup = new THREE.Group();
scene.add(spinGroup);

const contentHolder = new THREE.Group();
spinGroup.add(contentHolder);

const PLANE_SIZE = 2.4;
const TARGET_MODEL_SIZE = 2.35;
const PAN_POSITION_SCALE = 0.55;

/** Must match `stepper.c`: STEPS_PER_REV and f_start for ramp math. */
const MOTOR_STEPS_PER_REV = 200;
const MOTOR_F_START_HZ = 1.0;
/** Visual spin is opposite to the motor’s signed speed direction. */
const DISPLAY_SPIN_SIGN = -1;

/**
 * Instantaneous angular velocity (rad/s) matching the stepper trapezoid in stepper.c:
 * pulse frequency ramps linearly from f_start to f_max over ramp_sec, flat, then down.
 */
function motorTrapezoidOmegaRadPerSec(mv, tSec) {
  if (!mv || !mv.running) return 0;
  const speedRevPerSec = Number(mv.speed);
  const duration = Number(mv.duration);
  const rampIn = Number(mv.ramp);
  const microsteps = Number.isFinite(Number(mv.microsteps)) ? Math.max(1, Math.floor(Number(mv.microsteps))) : 16;
  if (!Number.isFinite(speedRevPerSec) || speedRevPerSec === 0) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (!Number.isFinite(tSec) || tSec < 0) return 0;
  if (tSec >= duration) return 0;

  const sign = Math.sign(speedRevPerSec);
  const speedMag = Math.abs(speedRevPerSec);
  const pulsesPerRev = MOTOR_STEPS_PER_REV * microsteps;
  const fMax = speedMag * pulsesPerRev;
  const omegaFromF = (fHz) => sign * (fHz / pulsesPerRev) * (Math.PI * 2);

  let rampSec = Math.max(0, rampIn);
  if (2 * rampSec > duration) rampSec = duration / 2;
  const flatSec = Math.max(0, duration - 2 * rampSec);

  if (rampSec <= 0 || fMax <= MOTOR_F_START_HZ) {
    return omegaFromF(fMax);
  }

  if (tSec < rampSec) {
    const f = MOTOR_F_START_HZ + ((fMax - MOTOR_F_START_HZ) * tSec) / rampSec;
    return omegaFromF(f);
  }
  if (tSec < rampSec + flatSec) {
    return omegaFromF(fMax);
  }
  const td = tSec - rampSec - flatSec;
  if (td < rampSec) {
    const f = fMax - ((fMax - MOTOR_F_START_HZ) * td) / rampSec;
    return omegaFromF(f);
  }
  return 0;
}

function displaySpinOmegaRadPerSec(mv) {
  if (!mv || !mv.running) return 0;
  const startedMs = mv.startedAt ? Date.parse(mv.startedAt) : NaN;
  if (!Number.isFinite(startedMs)) return 0;
  const tSec = (Date.now() - startedMs) / 1000;
  return DISPLAY_SPIN_SIGN * motorTrapezoidOmegaRadPerSec(mv, tSec);
}

let motorVisualForSpin = {
  running: false,
  speed: 0,
  duration: 0,
  ramp: 0,
  microsteps: 16,
  startedAt: null,
};

const placeholderMaterial = new THREE.MeshLambertMaterial({
  color: 0x5cb0e8,
  side: THREE.DoubleSide,
  precision: "mediump",
});
const placeholderMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE),
  placeholderMaterial.clone()
);

let panX = 0;
let panY = 0;
let rotX = 0;
let rotY = 0;
let rotZ = 0;

function applyPanToSubject() {
  spinGroup.position.set(panX * PAN_POSITION_SCALE, panY * PAN_POSITION_SCALE, 0);
}

function applyRotationToSubject() {
  contentHolder.rotation.set(rotX, rotY, rotZ);
}

let loadedModelUrl = "";
let useModel = false;

const stlLoader = new STLLoader();

const hintEl = document.getElementById("display-hint");

function setLoadHint(text) {
  if (hintEl) hintEl.textContent = text || "";
}

function isLikelyBinaryStl(buffer) {
  const len = buffer.byteLength;
  if (len < 84) return false;
  const view = new DataView(buffer);
  const nTri = view.getUint32(80, true);
  if (!Number.isFinite(nTri) || nTri < 1 || nTri > 20_000_000) return false;
  const need = 84 + nTri * 50;
  return need <= len;
}

function parseBinaryStlGeometry(buffer) {
  const ab = buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const view = new DataView(ab);
  const len = ab.byteLength;
  if (len < 84) return null;
  const nTri = view.getUint32(80, true);
  const need = 84 + nTri * 50;
  if (nTri < 1 || need > len) return null;
  const positions = new Float32Array(nTri * 9);
  let pi = 0;
  let off = 84;
  for (let i = 0; i < nTri; i++) {
    off += 12;
    for (let j = 0; j < 3; j++) {
      positions[pi++] = view.getFloat32(off, true);
      off += 4;
      positions[pi++] = view.getFloat32(off, true);
      off += 4;
      positions[pi++] = view.getFloat32(off, true);
      off += 4;
    }
    off += 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return geo;
}

function parseStlArrayBuffer(buffer) {
  if (isLikelyBinaryStl(buffer)) {
    const g = parseBinaryStlGeometry(buffer);
    const pos = g?.getAttribute("position");
    if (pos && pos.count > 0) return g;
  }
  try {
    const g = stlLoader.parse(buffer);
    const pos = g.getAttribute("position");
    if (pos && pos.count > 0) return g;
  } catch {
    /* continue */
  }
  const g2 = parseBinaryStlGeometry(buffer);
  const pos2 = g2?.getAttribute("position");
  if (g2 && pos2 && pos2.count > 0) return g2;
  throw new Error("STL parse failed");
}

function disposeObjectTree(root) {
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m.map) m.map.dispose();
        m.dispose();
      }
    }
  });
}

function clearContentHolder() {
  while (contentHolder.children.length > 0) {
    const ch = contentHolder.children[0];
    contentHolder.remove(ch);
    if (ch !== placeholderMesh) {
      disposeObjectTree(ch);
    }
  }
}

function wrapFittedModel(object3D) {
  const wrap = new THREE.Group();
  wrap.add(object3D);
  const box = new THREE.Box3().setFromObject(wrap);
  if (!box.isEmpty()) {
    const center = new THREE.Vector3();
    box.getCenter(center);
    object3D.position.sub(center);
    box.setFromObject(wrap);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
    if (Number.isFinite(maxDim) && maxDim > 1e-9) {
      wrap.scale.setScalar(TARGET_MODEL_SIZE / maxDim);
    }
  }
  return wrap;
}

function setPlaceholderPlane() {
  const already =
    !useModel &&
    contentHolder.children.length === 1 &&
    contentHolder.children[0] === placeholderMesh &&
    placeholderMesh.material &&
    !placeholderMesh.material.map;
  if (already) return;

  clearContentHolder();
  placeholderMesh.geometry.dispose();
  placeholderMesh.geometry = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE);
  placeholderMesh.material.dispose();
  placeholderMesh.material = placeholderMaterial.clone();
  useModel = false;
  spinGroup.rotation.y = 0;
  contentHolder.add(placeholderMesh);
}

function loadStlFromUrl(url) {
  const absUrl = resolveSiteUrl(url);
  if (!absUrl) {
    if (normalizeModelUrl(url) !== "") {
      loadedModelUrl = "";
      useModel = false;
      setPlaceholderPlane();
    }
    return;
  }
  if (absUrl === loadedModelUrl) return;

  let pathname = "";
  try {
    pathname = new URL(absUrl).pathname.toLowerCase();
  } catch {
    pathname = absUrl.split("?")[0].toLowerCase();
  }

  const onFail = () => {
    loadedModelUrl = "";
    useModel = false;
    setPlaceholderPlane();
  };

  if (!pathname.endsWith(".stl")) {
    setLoadHint("Server model URL must end with .stl");
    onFail();
    return;
  }

  setLoadHint("Loading STL…");
  fetch(absUrl, { cache: "no-store" })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (ct.includes("text/html")) {
        throw new Error("STL URL returned HTML (wrong path or 404)");
      }
      return res.arrayBuffer();
    })
    .then((buffer) => {
      const geometry = parseStlArrayBuffer(buffer);
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      const bb = geometry.boundingBox;
      if (!bb || bb.isEmpty()) {
        throw new Error("STL has empty bounds");
      }
      const mat = new THREE.MeshLambertMaterial({
        color: 0xc8dce8,
        side: THREE.DoubleSide,
        precision: "mediump",
      });
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.rotation.x = -Math.PI / 2;
      const fitted = wrapFittedModel(mesh);
      useModel = true;
      loadedModelUrl = absUrl;
      clearContentHolder();
      spinGroup.rotation.y = 0;
      contentHolder.add(fitted);
      placeholderMesh.rotation.set(0, 0, 0);
      setLoadHint("");
    })
    .catch((err) => {
      setLoadHint(
        `STL error: ${err && err.message ? err.message : "load failed"} — try opening /uploads/display-model.stl`
      );
      onFail();
    });
}

function applyDisplayState(state) {
  if (!state || typeof state !== "object") return;

  if (typeof state.panX === "number") panX = state.panX;
  if (typeof state.panY === "number") panY = state.panY;
  if (typeof state.rotX === "number" && Number.isFinite(state.rotX)) rotX = state.rotX;
  if (typeof state.rotY === "number" && Number.isFinite(state.rotY)) rotY = state.rotY;
  if (typeof state.rotZ === "number" && Number.isFinite(state.rotZ)) rotZ = state.rotZ;
  if (typeof state.zoom === "number" && Number.isFinite(state.zoom)) {
    zoomLevel = clampClientZoom(state.zoom);
  }
  applyPanToSubject();
  applyRotationToSubject();
  applyCameraZoom();

  const modelRef = normalizeModelUrl(state.modelUrl);
  if (modelRef) {
    loadStlFromUrl(modelRef);
  } else {
    loadedModelUrl = "";
    useModel = false;
    setLoadHint("");
    setPlaceholderPlane();
  }

  if (state.motorVisual && typeof state.motorVisual === "object") {
    const mv = state.motorVisual;
    motorVisualForSpin = {
      running: !!mv.running,
      speed: Number(mv.speed),
      duration: Number(mv.duration),
      ramp: Number(mv.ramp),
      microsteps: Number.isFinite(Number(mv.microsteps)) ? Number(mv.microsteps) : 16,
      startedAt: mv.startedAt != null ? String(mv.startedAt) : null,
    };
  }
}

let lastFrame = performance.now();

function fetchDisplayStateJson() {
  return fetch(`/api/display/state?_=${Date.now()}`, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error(`state ${r.status}`);
    return r.json();
  });
}

function startDisplayStatePolling() {
  setInterval(() => {
    fetchDisplayStateJson()
      .then((s) => applyDisplayState(s))
      .catch(() => {});
  }, 2500);
}

function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}`);

  ws.addEventListener("open", () => {
    fetchDisplayStateJson()
      .then((s) => applyDisplayState(s))
      .catch(() => {});
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type !== "state") return;
    applyDisplayState(msg);
  });

  ws.addEventListener("close", () => {
    setTimeout(connectWebSocket, 1500);
  });

  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });
}

setPlaceholderPlane();

fetchDisplayStateJson()
  .then((s) => applyDisplayState(s))
  .catch(() => {
    setPlaceholderPlane();
  })
  .finally(() => {
    connectWebSocket();
    startDisplayStatePolling();
  });

function animate(now) {
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;

  const omega = displaySpinOmegaRadPerSec(motorVisualForSpin);

  if (useModel) {
    spinGroup.rotation.y += omega * dt;
  } else {
    spinGroup.rotation.y = 0;
    placeholderMesh.rotation.z += omega * dt;
  }

  renderer.render(scene, camera);
}

renderer.setAnimationLoop(animate);

window.addEventListener("resize", () => {
  const w = container.clientWidth;
  const h = container.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  applyCameraZoom();
});

