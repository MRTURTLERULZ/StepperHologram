import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js";
import { GLTFLoader } from "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/loaders/GLTFLoader.js";
import { STLLoader } from "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/loaders/STLLoader.js";

const container = document.getElementById("three-container");

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 3));
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05080c);

const camera = new THREE.PerspectiveCamera(
  50,
  container.clientWidth / container.clientHeight,
  0.1,
  100
);
camera.position.set(0, 0.35, 3.6);

const ambient = new THREE.AmbientLight(0xffffff, 0.55);
scene.add(ambient);
const keyLight = new THREE.DirectionalLight(0xe8f0ff, 1.1);
keyLight.position.set(3, 5, 4);
scene.add(keyLight);
const rim = new THREE.DirectionalLight(0x406080, 0.35);
rim.position.set(-3, 2, -4);
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
    wrap.scale.setScalar(TARGET_MODEL_SIZE / maxDim);
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
  if (!url || url === loadedImageUrl) return;
  texLoader.load(
    url,
    (tex) => applyTextureToMesh(tex, url),
    undefined,
    () => {
      loadedImageUrl = "";
    }
  );
}

function setFallbackImagePlane() {
  disposeCurrentTexture();
  imageMesh.geometry.dispose();
  imageMesh.geometry = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE);
  imageMesh.material.dispose();
  imageMesh.material = fallbackMaterial.clone();
  loadedImageUrl = "";
  showImageMode();
}

function loadModelFromUrl(url) {
  if (!url || url === loadedModelUrl) return;

  const pathOnly = url.split("?")[0];
  const lower = pathOnly.toLowerCase();

  const onFail = () => {
    loadedModelUrl = "";
    useModel = false;
    setFallbackImagePlane();
  };

  if (lower.endsWith(".stl")) {
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buffer) => {
        const geometry = stlLoader.parse(buffer);
        const pos = geometry.getAttribute("position");
        if (!pos || pos.count === 0) {
          throw new Error("STL has no vertices");
        }
        geometry.rotateX(-Math.PI / 2);
        geometry.computeBoundingBox();
        geometry.computeVertexNormals();
        const mat = new THREE.MeshLambertMaterial({
          color: 0xc5d4e3,
          emissive: 0x1a2832,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, mat);
        const fitted = wrapFittedModel(mesh);
        useModel = true;
        loadedModelUrl = url;
        loadedImageUrl = "";
        disposeCurrentTexture();
        clearContentHolder();
        spinGroup.rotation.y = 0;
        contentHolder.add(fitted);
        imageMesh.rotation.set(0, 0, 0);
      })
      .catch(() => onFail());
    return;
  }

  if (lower.endsWith(".glb") || lower.endsWith(".gltf")) {
    gltfLoader.load(
      url,
      (gltf) => {
        const root = gltf.scene;
        root.traverse((child) => {
          if (child.isMesh) {
            child.castShadow = false;
            child.receiveShadow = false;
            if (child.material && child.material.map) {
              child.material.map.colorSpace = THREE.SRGBColorSpace;
            }
          }
        });
        const fitted = wrapFittedModel(root);
        useModel = true;
        loadedModelUrl = url;
        loadedImageUrl = "";
        disposeCurrentTexture();
        clearContentHolder();
        spinGroup.rotation.y = 0;
        contentHolder.add(fitted);
        imageMesh.rotation.set(0, 0, 0);
      },
      undefined,
      onFail
    );
    return;
  }

  onFail();
}

function applyDisplayState(state) {
  if (typeof state.panX === "number") panX = state.panX;
  if (typeof state.panY === "number") panY = state.panY;
  applyPanToSubject();

  if (state.modelUrl) {
    loadModelFromUrl(state.modelUrl);
  } else {
    loadedModelUrl = "";
    useModel = false;
    if (state.imageUrl) {
      loadImageFromUrl(state.imageUrl);
    } else {
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

fetch("/api/display/state")
  .then((r) => r.json())
  .then((s) => applyDisplayState(s))
  .catch(() => {
    setFallbackImagePlane();
  })
  .finally(() => {
    connectWebSocket();
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
});

requestAnimationFrame(animate);
