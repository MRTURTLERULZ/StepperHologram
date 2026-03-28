import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js";

const container = document.getElementById("three-container");
const statusEl = document.getElementById("status");
const runBtn = document.getElementById("runBtn");
const stopBtn = document.getElementById("stopBtn");
const refreshBtn = document.getElementById("refreshBtn");

const speedInput = document.getElementById("speed");
const durationInput = document.getElementById("duration");
const rampInput = document.getElementById("ramp");
const microstepsInput = document.getElementById("microsteps");

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(container.clientWidth, container.clientHeight);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x081019);

const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 100);
camera.position.set(0, 1.5, 4.4);

const ambient = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambient);

const key = new THREE.DirectionalLight(0x70c7ff, 1.2);
key.position.set(3, 4, 2);
scene.add(key);

const fill = new THREE.DirectionalLight(0x6d7a8a, 0.4);
fill.position.set(-3, 2, -2);
scene.add(fill);

const motorGroup = new THREE.Group();
scene.add(motorGroup);

const base = new THREE.Mesh(
  new THREE.CylinderGeometry(1.1, 1.1, 0.8, 48),
  new THREE.MeshStandardMaterial({ color: 0x1a2a38, metalness: 0.5, roughness: 0.55 })
);
base.position.y = -0.35;
motorGroup.add(base);

const rotor = new THREE.Mesh(
  new THREE.CylinderGeometry(0.72, 0.72, 0.46, 48),
  new THREE.MeshStandardMaterial({ color: 0x3cc0ff, metalness: 0.8, roughness: 0.2 })
);
rotor.rotation.z = Math.PI / 2;
motorGroup.add(rotor);

const shaft = new THREE.Mesh(
  new THREE.CylinderGeometry(0.15, 0.15, 1.45, 24),
  new THREE.MeshStandardMaterial({ color: 0xced6de, metalness: 1.0, roughness: 0.14 })
);
shaft.rotation.z = Math.PI / 2;
motorGroup.add(shaft);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(5, 48),
  new THREE.MeshStandardMaterial({ color: 0x0d1520, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -1.15;
scene.add(ground);

let spinRateRadPerSec = 0;
let desiredSpinRate = 0;
let isRunning = false;
let lastFrame = performance.now();

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

  desiredSpinRate = payload.speed * Math.PI * 2;
  isRunning = true;
  statusEl.textContent = formatStatus(body.status);
}

async function stopMotor() {
  const res = await fetch("/api/motor/stop", { method: "POST" });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Stop request failed: ${res.status}`);

  desiredSpinRate = 0;
  isRunning = false;
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
    if (status.state !== "running") {
      isRunning = false;
      desiredSpinRate = 0;
    }
  } catch (error) {
    statusEl.textContent = `Status error: ${error.message}`;
  }
});

async function pollStatus() {
  try {
    const status = await fetchStatus();
    statusEl.textContent = formatStatus(status);
    if (status.state !== "running") {
      isRunning = false;
      desiredSpinRate = 0;
    }
  } catch (error) {
    statusEl.textContent = `Status error: ${error.message}`;
  } finally {
    setTimeout(pollStatus, 1000);
  }
}

function animate(now) {
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;

  const blend = Math.min(1, dt * 6);
  spinRateRadPerSec += (desiredSpinRate - spinRateRadPerSec) * blend;

  rotor.rotation.x += spinRateRadPerSec * dt;
  shaft.rotation.x += spinRateRadPerSec * dt;
  motorGroup.rotation.y += (isRunning ? 0.2 : 0.04) * dt;

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

pollStatus();
requestAnimationFrame(animate);
