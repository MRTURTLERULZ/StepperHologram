const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const app = express();
const port = Number(process.env.PORT || 3000);

const projectRoot = path.resolve(__dirname, "..");
const webDir = path.join(projectRoot, "web");
const stepperSourcePath = path.join(projectRoot, "stepper.c");
const stepperBinaryPath = path.join(projectRoot, "stepper");

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

let activeRun = null;
let lastResult = null;
let lastCommand = null;

app.use(express.json());
app.use(express.static(webDir));

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

  proc.on("close", (code, signal) => {
    lastResult = {
      endedAt: new Date().toISOString(),
      exitCode: code,
      signal: signal || null,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
    activeRun = null;
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
  return res.status(202).json({ message: "Stop signal sent", status: motorStatus() });
});

app.get("/*splat", (req, res) => {
  res.sendFile(path.join(webDir, "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Stepper web server running on http://0.0.0.0:${port}`);
});
