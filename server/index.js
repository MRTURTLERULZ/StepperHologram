const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const multer = require("multer");
const { WebSocketServer } = require("ws");

const app = express();
const port = Number(process.env.PORT || 3000);

const projectRoot = path.resolve(__dirname, "..");
const webDir = path.join(projectRoot, "web");
const uploadsDir = path.join(webDir, "uploads");
const stepperSourcePath = path.join(projectRoot, "stepper.c");
const stepperBinaryPath = path.join(projectRoot, "stepper");

fs.mkdirSync(uploadsDir, { recursive: true });

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
const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

let activeRun = null;
let lastResult = null;
let lastCommand = null;

let displayState = {
  panX: 0,
  panY: 0,
  imageUrl: "",
  motorVisual: {
    running: false,
    speed: 0,
    duration: 0,
    ramp: 0,
    microsteps: 16,
    startedAt: null,
  },
};

let imageVersion = 0;

/** @type {import("ws").WebSocket[]} */
const wsClients = [];

function clampPan(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, value));
}

function buildStateMessage() {
  return {
    type: "state",
    panX: displayState.panX,
    panY: displayState.panY,
    imageUrl: displayState.imageUrl,
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
    default:
      break;
  }
}

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, uploadsDir);
  },
  filename(_req, file, cb) {
    const ext = ALLOWED_MIME[file.mimetype] || path.extname(file.originalname) || ".png";
    cb(null, `display-image${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: UPLOAD_MAX_BYTES },
  fileFilter(_req, file, cb) {
    if (ALLOWED_MIME[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error("Only PNG, JPEG, and WebP images are allowed"));
    }
  },
});

app.use(express.json());

app.get("/api/display/state", (_req, res) => {
  res.json({
    panX: displayState.panX,
    panY: displayState.panY,
    imageUrl: displayState.imageUrl,
    motorVisual: displayState.motorVisual,
  });
});

app.post("/api/display/pan", (req, res) => {
  const body = req.body || {};
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

app.post("/api/display/upload", (req, res) => {
  upload.single("image")(req, res, (err) => {
    if (err) {
      const message = err.message || "Upload failed";
      return res.status(400).json({ error: message });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file field 'image'" });
    }
    imageVersion += 1;
    const publicPath = `/uploads/${req.file.filename}?v=${imageVersion}`;
    displayState.imageUrl = publicPath;
    broadcastState();
    return res.json({ ok: true, imageUrl: publicPath });
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

  return res.status(202).json({
    message: "Motor run started",
    status: motorStatus(),
  });
});

app.post("/api/motor/stop", (req, res) => {
  if (!activeRun) {
    return res.status(200).json({ message: "Motor is not running", status: motorStatus() });
  }

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

app.use(express.static(webDir));

app.get("/*splat", (req, res) => {
  res.sendFile(path.join(webDir, "index.html"));
});

const server = http.createServer(app);

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  wsClients.push(ws);
  ws.send(JSON.stringify(buildStateMessage()));

  ws.on("message", (data) => {
    handleWsMessage(data);
  });

  ws.on("close", () => {
    const i = wsClients.indexOf(ws);
    if (i !== -1) wsClients.splice(i, 1);
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Stepper web server running on http://0.0.0.0:${port}`);
});
