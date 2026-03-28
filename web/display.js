import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js";

const container = document.getElementById("three-container");

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 3));
renderer.setSize(container.clientWidth, container.clientHeight);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05080c);

const camera = new THREE.PerspectiveCamera(
  50,
  container.clientWidth / container.clientHeight,
  0.1,
  100
);
camera.position.set(0, 0, 3.2);

const discGroup = new THREE.Group();
scene.add(discGroup);

const PLANE_SIZE = 2.4;
const fallbackMaterial = new THREE.MeshBasicMaterial({
  color: 0x3cc0ff,
  side: THREE.DoubleSide,
});
const imageMesh = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE), fallbackMaterial);
discGroup.add(imageMesh);

let panX = 0;
let panY = 0;

function applyPanToTexture() {
  const map = imageMesh.material && imageMesh.material.map;
  if (map) {
    map.offset.set(panX, panY);
  }
}

let currentTexture = null;
let loadedImageUrl = "";

const loader = new THREE.TextureLoader();

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

  const aspect = texture.image && texture.image.width && texture.image.height
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
  applyPanToTexture();
}

function loadImageFromUrl(url) {
  if (!url || url === loadedImageUrl) return;
  loader.load(
    url,
    (tex) => applyTextureToMesh(tex, url),
    undefined,
    () => {
      loadedImageUrl = "";
    }
  );
}

function setFallbackMaterial() {
  disposeCurrentTexture();
  imageMesh.geometry.dispose();
  imageMesh.geometry = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE);
  imageMesh.material.dispose();
  imageMesh.material = fallbackMaterial.clone();
  loadedImageUrl = "";
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

    if (typeof msg.panX === "number") panX = msg.panX;
    if (typeof msg.panY === "number") panY = msg.panY;

    if (msg.imageUrl) {
      loadImageFromUrl(msg.imageUrl);
    } else {
      setFallbackMaterial();
    }
    applyPanToTexture();

    desiredSpinRate = recomputeDesiredSpinRate(msg.motorVisual);
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

fetch("/api/display/state")
  .then((r) => r.json())
  .then((s) => {
    panX = s.panX ?? 0;
    panY = s.panY ?? 0;
    if (s.imageUrl) loadImageFromUrl(s.imageUrl);
    else setFallbackMaterial();
    applyPanToTexture();
    desiredSpinRate = recomputeDesiredSpinRate(s.motorVisual);
  })
  .catch(() => {
    setFallbackMaterial();
  })
  .finally(() => {
    connectWebSocket();
  });

function animate(now) {
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;

  const blend = Math.min(1, dt * 6);
  spinRateRadPerSec += (desiredSpinRate - spinRateRadPerSec) * blend;

  imageMesh.rotation.z += spinRateRadPerSec * dt;

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

window.addEventListener("resize", () => {
  const w = container.clientWidth;
  const h = container.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
});

requestAnimationFrame(animate);
