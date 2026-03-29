const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const multer = require("multer");
const { WebSocketServer } = require("ws");

const app = express();
const port = Number(process.env.PORT || 3000);

function logDbg(...args) {
  console.log("[stepperholo]", new Date().toISOString(), ...args);
}

const projectRoot = path.resolve(__dirname, "..");
const webDir = path.join(projectRoot, "web");
const uploadsDir = path.join(webDir, "uploads");
const stepperSourcePath = path.join(projectRoot, "stepper.c");
const stepperBinaryPath = path.join(projectRoot, "stepper");

fs.mkdirSync(uploadsDir, { recursive: true });
logDbg("uploads directory:", uploadsDir, "exists:", fs.existsSync(uploadsDir));

const motorUseSudo =
  process.env.MOTOR_USE_SUDO === "1" || process.env.MOTOR_USE_SUDO === "true";

const LIMITS = {
  durationMin: 0.1,
  durationMax: 120,
  rampMin: 0,
  rampMax: 30,
  microstepsMin: 1,
  microstepsMax: 256,
};

const PAN_LIMIT = 2;
const ROT_LIMIT = 1.4;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 6;
const ZOOM_DEFAULT = 1;
const MODEL_UPLOAD_MAX_BYTES = 32 * 1024 * 1024;

const STL_MIMES = new Set([
  "model/stl",
  "application/sla",
  "application/vnd.ms-pki.stl",
  "application/octet-stream",
]);

function isStlUpload(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (ext === ".stl") return true;
  return STL_MIMES.has(file.mimetype);
}

let activeRun = null;
let lastResult = null;
let lastCommand = null;

let displayState = {
  panX: 0,
  panY: 0,
  rotX: 0,
  rotY: 0,
  rotZ: 0,
  zoom: ZOOM_DEFAULT,
  modelUrl: "",
  motorVisual: {
    running: false,
    speed: 0,
    duration: 0,
    ramp: 0,
    microsteps: 16,
    startedAt: null,
  },
};

let modelVersion = 0;

/** @type {import("ws").WebSocket[]} */
const wsClients = [];

function clampPan(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, value));
}

function clampZoom(value) {
  if (!Number.isFinite(value)) return ZOOM_DEFAULT;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value));
}

function clampRot(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-ROT_LIMIT, Math.min(ROT_LIMIT, value));
}

function buildStateMessage() {
  return {
    type: "state",
    panX: displayState.panX,
    panY: displayState.panY,
    rotX: displayState.rotX,
    rotY: displayState.rotY,
    rotZ: displayState.rotZ,
    zoom: displayState.zoom,
    modelUrl: displayState.modelUrl,
    motorVisual: { ...displayState.motorVisual },
  };
}

function broadcastState() {
  const payload = JSON.stringify(buildStateMessage());
  for (const client of wsClients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

function applyPanDelta(dx, dy) {
  const ddx = Number(dx);
  const ddy = Number(dy);
  if (!Number.isFinite(ddx) && !Number.isFinite(ddy)) return;
  displayState.panX = clampPan(displayState.panX + (Number.isFinite(ddx) ? ddx : 0));
  displayState.panY = clampPan(displayState.panY + (Number.isFinite(ddy) ? ddy : 0));
  broadcastState();
}

function setPan(x, y) {
  const nx = Number(x);
  const ny = Number(y);
  if (Number.isFinite(nx)) displayState.panX = clampPan(nx);
  if (Number.isFinite(ny)) displayState.panY = clampPan(ny);
  broadcastState();
}

function resetPan() {
  displayState.panX = 0;
  displayState.panY = 0;
  broadcastState();
}

function resetZoom() {
  displayState.zoom = ZOOM_DEFAULT;
  broadcastState();
}

function applyRotDelta(drx, dry, drz) {
  const a = Number(drx);
  const b = Number(dry);
  const c = Number(drz);
  if (!Number.isFinite(a) && !Number.isFinite(b) && !Number.isFinite(c)) return;
  displayState.rotX = clampRot(displayState.rotX + (Number.isFinite(a) ? a : 0));
  displayState.rotY = clampRot(displayState.rotY + (Number.isFinite(b) ? b : 0));
  displayState.rotZ = clampRot(displayState.rotZ + (Number.isFinite(c) ? c : 0));
  broadcastState();
}

function setRot(rx, ry, rz) {
  const x = Number(rx);
  const y = Number(ry);
  const z = Number(rz);
  if (Number.isFinite(x)) displayState.rotX = clampRot(x);
  if (Number.isFinite(y)) displayState.rotY = clampRot(y);
  if (Number.isFinite(z)) displayState.rotZ = clampRot(z);
  broadcastState();
}

function resetRot() {
  displayState.rotX = 0;
  displayState.rotY = 0;
  displayState.rotZ = 0;
  broadcastState();
}

function applyZoomDelta(delta) {
  const d = Number(delta);
  if (!Number.isFinite(d)) return;
  displayState.zoom = clampZoom(displayState.zoom + d);
  broadcastState();
}

function setZoom(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return;
  displayState.zoom = clampZoom(v);
  broadcastState();
}

function setMotorVisualRunning(params, startedAt) {
  displayState.motorVisual = {
    running: true,
    speed: params.speed,
    duration: params.duration,
    ramp: params.ramp,
    microsteps: params.microsteps,
    startedAt,
  };
  broadcastState();
}

function setMotorVisualIdle() {
  displayState.motorVisual = {
    running: false,
    speed: 0,
    duration: 0,
    ramp: 0,
    microsteps: displayState.motorVisual.microsteps,
    startedAt: null,
  };
  broadcastState();
}

function handleWsMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;

  switch (msg.type) {
    case "pan":
      applyPanDelta(msg.dx, msg.dy);
      break;
    case "panSet":
      setPan(msg.x, msg.y);
      break;
    case "resetPan":
      resetPan();
      break;
    case "zoomDelta":
      applyZoomDelta(msg.delta);
      break;
    case "zoomSet":
      setZoom(msg.value);
      break;
    case "resetZoom":
      resetZoom();
      break;
    case "rotateDelta":
      applyRotDelta(msg.drx, msg.dry, msg.drz);
      break;
    case "rotateSet":
      setRot(msg.rx, msg.ry, msg.rz);
      break;
    case "resetRotate":
      resetRot();
      break;
    default:
      break;
  }
}

const modelStorage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, uploadsDir);
  },
  filename(_req, _file, cb) {
    cb(null, "display-model.stl");
  },
});

const uploadModel = multer({
  storage: modelStorage,
  limits: { fileSize: MODEL_UPLOAD_MAX_BYTES },
  fileFilter(_req, file, cb) {
    if (isStlUpload(file)) {
      cb(null, true);
    } else {
      cb(new Error("Only STL files (.stl) are allowed"));
    }
  },
});

app.use(express.json());

app.get("/api/display/state", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  if (process.env.STEPPERHOLO_DEBUG_STATE === "1") {
    logDbg("GET /api/display/state", { modelUrl: displayState.modelUrl, zoom: displayState.zoom, ip: req.ip });
  }
  res.json({
    panX: displayState.panX,
    panY: displayState.panY,
    rotX: displayState.rotX,
    rotY: displayState.rotY,
    rotZ: displayState.rotZ,
    zoom: displayState.zoom,
    modelUrl: displayState.modelUrl,
    motorVisual: displayState.motorVisual,
  });
});

app.post("/api/display/pan", (req, res) => {
  const body = req.body || {};
  if (body.resetView === true) {
    resetPan();
    resetZoom();
    resetRot();
    return res.json({ ok: true, ...buildStateMessage() });
  }
  if (body.reset === true || body.action === "reset") {
    resetPan();
    return res.json({ ok: true, ...buildStateMessage() });
  }
  if (body.mode === "set") {
    setPan(body.x, body.y);
    return res.json({ ok: true, ...buildStateMessage() });
  }
  applyPanDelta(body.dx, body.dy);
  return res.json({ ok: true, ...buildStateMessage() });
});

app.post("/api/display/zoom", (req, res) => {
  const body = req.body || {};
  if (body.reset === true) {
    resetZoom();
    return res.json({ ok: true, ...buildStateMessage() });
  }
  if (body.mode === "set" && Number.isFinite(Number(body.value))) {
    setZoom(body.value);
    return res.json({ ok: true, ...buildStateMessage() });
  }
  applyZoomDelta(body.delta);
  return res.json({ ok: true, ...buildStateMessage() });
});

app.post("/api/display/rotate", (req, res) => {
  const body = req.body || {};
  if (body.reset === true || body.action === "reset") {
    resetRot();
    return res.json({ ok: true, ...buildStateMessage() });
  }
  if (body.mode === "set") {
    setRot(body.rx, body.ry, body.rz);
    return res.json({ ok: true, ...buildStateMessage() });
  }
  applyRotDelta(body.drx, body.dry, body.drz);
  return res.json({ ok: true, ...buildStateMessage() });
});

app.post("/api/display/upload-model", (req, res) => {
  uploadModel.single("model")(req, res, (err) => {
    if (err) {
      const message = err.message || "Upload failed";
      logDbg("STL upload rejected:", message);
      return res.status(400).json({ error: message });
    }
    if (!req.file) {
      logDbg("STL upload rejected: missing file field 'model'");
      return res.status(400).json({ error: "No file field 'model'" });
    }
    modelVersion += 1;
    const publicPath = `/uploads/${req.file.filename}?v=${modelVersion}`;
    displayState.modelUrl = publicPath;
    broadcastState();
    logDbg("STL upload OK", {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      savedAs: req.file.path,
      publicPath,
      wsClients: wsClients.length,
    });
    return res.json({ ok: true, modelUrl: publicPath });
  });
});

function withinRange(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function normalizeRunInput(body) {
  const speed = Number(body.speed);
  const duration = Number(body.duration);
  const ramp = Number(body.ramp);
  const microsteps = Number(body.microsteps);

  if (!Number.isFinite(speed) || speed === 0) {
    throw new Error("speed must be a non-zero finite number (rev/s; negative = reverse)");
  }
  if (!withinRange(duration, LIMITS.durationMin, LIMITS.durationMax)) {
    throw new Error(`duration must be in [${LIMITS.durationMin}, ${LIMITS.durationMax}]`);
  }
  if (!withinRange(ramp, LIMITS.rampMin, LIMITS.rampMax)) {
    throw new Error(`ramp must be in [${LIMITS.rampMin}, ${LIMITS.rampMax}]`);
  }
  if (!Number.isInteger(microsteps) || !withinRange(microsteps, LIMITS.microstepsMin, LIMITS.microstepsMax)) {
    throw new Error(`microsteps must be an integer in [${LIMITS.microstepsMin}, ${LIMITS.microstepsMax}]`);
  }
  if (2 * ramp > duration) {
    throw new Error("ramp must be <= duration / 2");
  }

  return { speed, duration, ramp, microsteps };
}

function motorStatus() {
  if (!activeRun) {
    return {
      state: "idle",
      lastCommand,
      lastResult,
    };
  }

  return {
    state: "running",
    pid: activeRun.proc.pid,
    startedAt: activeRun.startedAt,
    command: activeRun.args.join(" "),
    params: activeRun.params,
    lastCommand,
    lastResult,
  };
}

function ensureStepperBinaryExists() {
  if (!fs.existsSync(stepperBinaryPath)) {
    throw new Error("Stepper binary not found. Build it with: npm run build:stepper");
  }
  if (!fs.existsSync(stepperSourcePath)) {
    throw new Error("stepper.c not found in project root");
  }
}

app.get("/api/motor/status", (req, res) => {
  res.json(motorStatus());
});

app.post("/api/motor/run", (req, res) => {
  if (activeRun) {
    return res.status(409).json({ error: "Motor is already running", status: motorStatus() });
  }

  let params;
  try {
    params = normalizeRunInput(req.body || {});
    ensureStepperBinaryExists();
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const args = [
    params.speed.toString(),
    params.duration.toString(),
    params.ramp.toString(),
    params.microsteps.toString(),
  ];

  const spawnCmd = motorUseSudo ? "sudo" : stepperBinaryPath;
  const spawnArgs = motorUseSudo ? [stepperBinaryPath, ...args] : args;

  const proc = spawn(spawnCmd, spawnArgs, {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  proc.on("close", (_code, signal) => {
    lastResult = {
      endedAt: new Date().toISOString(),
      exitCode: _code,
      signal: signal || null,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
    logDbg("stepper process exited", { exitCode: _code, signal });
    activeRun = null;
    setMotorVisualIdle();
  });

  activeRun = {
    proc,
    startedAt: new Date().toISOString(),
    params,
    args: motorUseSudo ? ["sudo", stepperBinaryPath, ...args] : [stepperBinaryPath, ...args],
  };
  lastCommand = {
    startedAt: activeRun.startedAt,
    params,
  };

  setMotorVisualRunning(params, activeRun.startedAt);
  logDbg("POST /api/motor/run", params);

  return res.status(202).json({
    message: "Motor run started",
    status: motorStatus(),
  });
});

app.post("/api/motor/stop", (req, res) => {
  if (!activeRun) {
    return res.status(200).json({ message: "Motor is not running", status: motorStatus() });
  }

  logDbg("POST /api/motor/stop (SIGTERM)");
  activeRun.proc.kill("SIGTERM");
  setMotorVisualIdle();
  return res.status(202).json({ message: "Stop signal sent", status: motorStatus() });
});

app.get("/display", (_req, res) => {
  res.sendFile(path.join(webDir, "display.html"));
});

app.get("/controls", (_req, res) => {
  res.sendFile(path.join(webDir, "controls.html"));
});

const threeRoot = path.join(projectRoot, "node_modules", "three");
if (fs.existsSync(path.join(threeRoot, "build"))) {
  app.use("/vendor/three/build", express.static(path.join(threeRoot, "build")));
  app.use("/vendor/three/examples/jsm", express.static(path.join(threeRoot, "examples", "jsm")));
  logDbg("Serving Three.js from", threeRoot);
} else {
  logDbg("WARNING: run npm install — node_modules/three missing (display will fail to load)");
}

app.get("/uploads/display-model.stl", (req, res) => {
  const fp = path.join(uploadsDir, "display-model.stl");
  const exists = fs.existsSync(fp);
  const size = exists ? fs.statSync(fp).size : 0;
  logDbg("GET /uploads/display-model.stl", { v: req.query.v, exists, size, ip: req.ip });
  if (!exists) {
    return res.status(404).type("text/plain").send("STL not found on disk");
  }
  res.set("Cache-Control", "no-store, must-revalidate");
  res.type("application/octet-stream");
  res.sendFile(fp);
});

app.use(express.static(webDir));

app.get("/*splat", (req, res) => {
  res.sendFile(path.join(webDir, "index.html"));
});

const server = http.createServer(app);

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  wsClients.push(ws);
  logDbg("WebSocket connected; clients:", wsClients.length, req.socket?.remoteAddress || "");
  ws.send(JSON.stringify(buildStateMessage()));

  ws.on("message", (data) => {
    handleWsMessage(data);
  });

  ws.on("close", () => {
    const i = wsClients.indexOf(ws);
    if (i !== -1) wsClients.splice(i, 1);
    logDbg("WebSocket closed; clients:", wsClients.length);
  });
});

server.listen(port, "0.0.0.0", () => {
  logDbg(`HTTP+WS listening on http://0.0.0.0:${port} (web: ${webDir})`);
});
