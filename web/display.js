import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js";
import { GLTFLoader } from "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/loaders/GLTFLoader.js";
import { STLLoader } from "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/loaders/STLLoader.js";

const urlParams = new URLSearchParams(window.location.search);
const isEmbedPreview = urlParams.get("embed") === "1";

/**
 * Turn API paths like /uploads/foo.stl or uploads/foo.stl into a full URL from the site origin.
 * Relative paths without a leading slash would otherwise resolve under /display/... and 404.
 */
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

function normalizeAssetRef(v) {
  if (v == null) return "";
  return String(v).trim();
}

const container = document.getElementById("three-container");

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isEmbedPreview ? 2 : 3));
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0c1520);

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

const ambient = new THREE.AmbientLight(0xffffff, 0.82);
scene.add(ambient);
const keyLight = new THREE.DirectionalLight(0xffffff, 1.25);
keyLight.position.set(4, 6, 5);
scene.add(keyLight);
const fill = new THREE.DirectionalLight(0xb8c8e0, 0.55);
fill.position.set(-4, 2, -3);
scene.add(fill);
const rim = new THREE.DirectionalLight(0x7090b0, 0.45);
rim.position.set(-2, 3, -5);
scene.add(rim);

const spinGroup = new THREE.Group();
scene.add(spinGroup);

const contentHolder = new THREE.Group();
spinGroup.add(contentHolder);

const PLANE_SIZE = 2.4;
const TARGET_MODEL_SIZE = 2.35;
const PAN_POSITION_SCALE = 0.55;

const fallbackMaterial = new THREE.MeshBasicMaterial({
  color: 0x3cc0ff,
  side: THREE.DoubleSide,
});
const imageMesh = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE), fallbackMaterial.clone());

let panX = 0;
let panY = 0;

function applyPanToSubject() {
  spinGroup.position.set(panX * PAN_POSITION_SCALE, panY * PAN_POSITION_SCALE, 0);
}

function applyPanToTexture() {
  const map = imageMesh.material && imageMesh.material.map;
  if (map) {
    map.offset.set(panX, panY);
  }
}

let currentTexture = null;
let loadedImageUrl = "";
let loadedModelUrl = "";
let useModel = false;

const texLoader = new THREE.TextureLoader();
const gltfLoader = new GLTFLoader();
const stlLoader = new STLLoader();

const hintEl = document.getElementById("display-hint");

function setLoadHint(text) {
  if (hintEl) hintEl.textContent = text || "";
}

/** Binary STL: 80-byte header + uint32 triangle count + 50 bytes per triangle */
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
    if (obj.geometry) {
      obj.geometry.dispose();
    }
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m.map) m.map.dispose();
        if (m.lightMap) m.lightMap.dispose();
        if (m.aoMap) m.aoMap.dispose();
        if (m.emissiveMap) m.emissiveMap.dispose();
        if (m.normalMap) m.normalMap.dispose();
        if (m.bumpMap) m.bumpMap.dispose();
        if (m.displacementMap) m.displacementMap.dispose();
        if (m.roughnessMap) m.roughnessMap.dispose();
        if (m.metalnessMap) m.metalnessMap.dispose();
        m.dispose();
      }
    }
  });
}

function clearContentHolder() {
  while (contentHolder.children.length > 0) {
    const ch = contentHolder.children[0];
    contentHolder.remove(ch);
    if (ch !== imageMesh) {
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

function showImageMode() {
  useModel = false;
  spinGroup.rotation.y = 0;
  clearContentHolder();
  contentHolder.add(imageMesh);
  applyPanToTexture();
}

function disposeCurrentTexture() {
  if (currentTexture) {
    currentTexture.dispose();
    currentTexture = null;
  }
}

function applyTextureToMesh(texture, url) {
  disposeCurrentTexture();
  currentTexture = texture;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.center.set(0.5, 0.5);

  const aspect =
    texture.image && texture.image.width && texture.image.height
      ? texture.image.width / texture.image.height
      : 1;
  let w = PLANE_SIZE;
  let h = PLANE_SIZE;
  if (aspect >= 1) {
    h = PLANE_SIZE / aspect;
  } else {
    w = PLANE_SIZE * aspect;
  }

  imageMesh.geometry.dispose();
  imageMesh.geometry = new THREE.PlaneGeometry(w, h);

  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.DoubleSide,
    transparent: true,
  });
  imageMesh.material.dispose();
  imageMesh.material = mat;
  loadedImageUrl = url;
  showImageMode();
  applyPanToTexture();
}

function loadImageFromUrl(url) {
  const absUrl = resolveSiteUrl(url);
  if (!absUrl || absUrl === loadedImageUrl) return;
  texLoader.load(
    absUrl,
    (tex) => applyTextureToMesh(tex, absUrl),
    undefined,
    () => {
      loadedImageUrl = "";
    }
  );
}

function setFallbackImagePlane() {
  const alreadyFallback =
    !useModel &&
    loadedImageUrl === "" &&
    !currentTexture &&
    contentHolder.children.length === 1 &&
    contentHolder.children[0] === imageMesh &&
    imageMesh.material &&
    !imageMesh.material.map;
  if (alreadyFallback) {
    applyPanToTexture();
    return;
  }
  disposeCurrentTexture();
  imageMesh.geometry.dispose();
  imageMesh.geometry = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE);
  imageMesh.material.dispose();
  imageMesh.material = fallbackMaterial.clone();
  loadedImageUrl = "";
  showImageMode();
}

function loadModelFromUrl(url) {
  const absUrl = resolveSiteUrl(url);
  if (!absUrl) {
    if (normalizeAssetRef(url) !== "") {
      loadedModelUrl = "";
      useModel = false;
      setFallbackImagePlane();
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
    setFallbackImagePlane();
  };

  if (pathname.endsWith(".stl")) {
    setLoadHint("Loading STL…");
    fetch(absUrl, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buffer) => {
        const geometry = parseStlArrayBuffer(buffer);
        geometry.computeBoundingBox();
        const bb = geometry.boundingBox;
        if (!bb || bb.isEmpty()) {
          throw new Error("STL has empty bounds");
        }
        const mat = new THREE.MeshBasicMaterial({
          color: 0x7fd8ff,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, mat);
        mesh.rotation.x = -Math.PI / 2;
        const fitted = wrapFittedModel(mesh);
        useModel = true;
        loadedModelUrl = absUrl;
        loadedImageUrl = "";
        disposeCurrentTexture();
        clearContentHolder();
        spinGroup.rotation.y = 0;
        contentHolder.add(fitted);
        imageMesh.rotation.set(0, 0, 0);
        setLoadHint("");
      })
      .catch((err) => {
        setLoadHint(`STL error: ${err && err.message ? err.message : "load failed"} — open /uploads/display-model.stl in the browser`);
        onFail();
      });
    return;
  }

  if (pathname.endsWith(".glb") || pathname.endsWith(".gltf")) {
    gltfLoader.load(
      absUrl,
      (gltf) => {
        const root = gltf.scene;
        root.traverse((child) => {
          if (!child.isMesh || !child.material) return;
          child.castShadow = false;
          child.receiveShadow = false;
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          for (const m of mats) {
            if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
            if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
              m.envMapIntensity = 0;
              m.emissiveIntensity = Math.max(m.emissiveIntensity || 0, 0.2);
            }
          }
        });
        const fitted = wrapFittedModel(root);
        useModel = true;
        loadedModelUrl = absUrl;
        loadedImageUrl = "";
        disposeCurrentTexture();
        clearContentHolder();
        spinGroup.rotation.y = 0;
        contentHolder.add(fitted);
        imageMesh.rotation.set(0, 0, 0);
        setLoadHint("");
      },
      undefined,
      () => {
        setLoadHint("GLB/GLTF load failed");
        onFail();
      }
    );
    return;
  }

  setLoadHint("Unknown model type (use .stl or .glb)");
  onFail();
}

function applyDisplayState(state) {
  if (!state || typeof state !== "object") return;

  if (typeof state.panX === "number") panX = state.panX;
  if (typeof state.panY === "number") panY = state.panY;
  if (typeof state.zoom === "number" && Number.isFinite(state.zoom)) {
    zoomLevel = clampClientZoom(state.zoom);
  }
  applyPanToSubject();
  applyCameraZoom();

  const modelRef = normalizeAssetRef(state.modelUrl);
  const imageRef = normalizeAssetRef(state.imageUrl);

  if (modelRef) {
    loadModelFromUrl(modelRef);
  } else {
    loadedModelUrl = "";
    useModel = false;
    if (imageRef) {
      setLoadHint("");
      loadImageFromUrl(imageRef);
    } else {
      setLoadHint("");
      setFallbackImagePlane();
    }
  }

  applyPanToTexture();
  desiredSpinRate = recomputeDesiredSpinRate(state.motorVisual);
}

let spinRateRadPerSec = 0;
let desiredSpinRate = 0;
let lastFrame = performance.now();

function recomputeDesiredSpinRate(motorVisual) {
  if (!motorVisual || !motorVisual.running) return 0;
  const speed = Number(motorVisual.speed);
  if (!Number.isFinite(speed)) return 0;
  return speed * Math.PI * 2;
}

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

setFallbackImagePlane();

fetchDisplayStateJson()
  .then((s) => applyDisplayState(s))
  .catch(() => {
    setFallbackImagePlane();
  })
  .finally(() => {
    connectWebSocket();
    startDisplayStatePolling();
  });

function animate(now) {
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;

  const blend = Math.min(1, dt * 6);
  spinRateRadPerSec += (desiredSpinRate - spinRateRadPerSec) * blend;

  if (useModel) {
    spinGroup.rotation.y += spinRateRadPerSec * dt;
  } else {
    spinGroup.rotation.y = 0;
    imageMesh.rotation.z += spinRateRadPerSec * dt;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

window.addEventListener("resize", () => {
  const w = container.clientWidth;
  const h = container.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  applyCameraZoom();
});

requestAnimationFrame(animate);
