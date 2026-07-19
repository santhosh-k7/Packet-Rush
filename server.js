/**
 * PACKET RUSH — Expo booth game server
 * ------------------------------------
 * One active phone controller at a time steers a "data packet" through a
 * fixed procedurally-generated network track. The server is fully authoritative:
 * it simulates the race, records every run, and replays the current all-time
 * best run as a live "ghost" opponent that the display and controller can see
 * in real time.
 *
 * Run:  npm install && npm start
 * Then open http://<your-LAN-IP>:3000/display.html on the big screen,
 * and let attendees scan the QR code shown there to join as the controller.
 */

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");
const { Server } = require("socket.io");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;

const TRACK_LENGTH = 6000; // distance units for a full lap
const LANE_HALF_WIDTH = 150; // steering range is -150 (far left) .. +150 (far right)
const SAFE_ZONE = 50; // |x| <= SAFE_ZONE is the safe/center lane
const SAFE_SPEED = 90; // units/sec in the safe lane (~66s lap if never boosting)
const BOOST_SPEED = 150; // units/sec in the outer "fast lane" (~40s if never hit)
const HAZARD_KNOCKBACK = 300; // distance units lost on hazard collision
const STEER_SMOOTHING = 0.2; // how quickly the packet catches up to the tilt target
const TICK_MS = 50; // server simulation tick (20Hz)
const TRACK_SEED = 1337; // fixed seed so hazards never move between restarts
const SPEED_DEMON_MS = 45000; // finish under this time to earn the Speed Demon badge
const COUNTDOWN_SECONDS = 3; // pre-race countdown shown on both screens

// ---------------------------------------------------------------------------
// Persistence (simple JSON files — no DB needed for a single-booth event)
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const GHOST_FILE = path.join(DATA_DIR, "ghost.json");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");

function loadGhost() {
  try {
    return JSON.parse(fs.readFileSync(GHOST_FILE, "utf8"));
  } catch (e) {
    return null;
  }
}
function saveGhost(ghost) {
  try {
    fs.writeFileSync(GHOST_FILE, JSON.stringify(ghost));
  } catch (e) {
    console.error("Failed to save ghost:", e);
  }
}
function loadLeaderboard() {
  try {
    return JSON.parse(fs.readFileSync(LEADERBOARD_FILE, "utf8"));
  } catch (e) {
    return [];
  }
}
function saveLeaderboard(lb) {
  try {
    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(lb));
  } catch (e) {
    console.error("Failed to save leaderboard:", e);
  }
}

// ---------------------------------------------------------------------------
// Deterministic hazard generation (mulberry32 seeded PRNG)
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateHazards(trackLength, seed) {
  const rand = mulberry32(seed);
  const count = 8;
  const segment = trackLength / (count + 1);
  const hazards = [];
  for (let i = 1; i <= count; i++) {
    const base = segment * i;
    const jitter = (rand() - 0.5) * segment * 0.4;
    const distanceStart = Math.max(300, base + jitter);
    const length = 150 + rand() * 100;
    const side = i % 2 === 0 ? 1 : -1; // alternate which fast lane the hazard sits in
    const xStart = side === 1 ? SAFE_ZONE : -LANE_HALF_WIDTH;
    const xEnd = side === 1 ? LANE_HALF_WIDTH : -SAFE_ZONE;
    hazards.push({
      id: i,
      distanceStart,
      distanceEnd: distanceStart + length,
      xStart,
      xEnd,
    });
  }
  return hazards;
}

const HAZARDS = generateHazards(TRACK_LENGTH, TRACK_SEED);

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
let ghostBest = loadGhost(); // { finishTime, samples: [{t,d,x}], playerName } | null
let leaderboard = loadLeaderboard(); // [{ name, time, date }]

let activeControllerId = null;
let queue = []; // [{ id, name }]
let raceActive = false;
let raceTimer = null;
let currentRun = null; // { name, elapsed, x, targetX, distance, samples, hitHazards }
let countdownActive = false;
let countdownTimer = null;

function sampleGhost(samples, t, finishTime) {
  if (!samples || samples.length === 0) return null;
  if (t >= finishTime) {
    const last = samples[samples.length - 1];
    return { distance: last.d, x: last.x };
  }
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    if (a.t <= t && b.t >= t) {
      const span = b.t - a.t || 1;
      const f = (t - a.t) / span;
      return { distance: a.d + (b.d - a.d) * f, x: a.x + (b.x - a.x) * f };
    }
  }
  return { distance: samples[0].d, x: samples[0].x };
}

function beginCountdown(name) {
  countdownActive = true;
  let n = COUNTDOWN_SECONDS;
  io.emit("race:countdown", { seconds: n, name });
  countdownTimer = setInterval(() => {
    n--;
    if (n > 0) {
      io.emit("race:countdown", { seconds: n, name });
    } else {
      clearInterval(countdownTimer);
      countdownTimer = null;
      countdownActive = false;
      startRace(name);
    }
  }, 1000);
}

function startRace(name) {
  raceActive = true;
  currentRun = {
    name,
    elapsed: 0,
    x: 0,
    targetX: 0,
    distance: 0,
    samples: [],
    hitHazards: new Set(),
  };
  io.emit("race:start", { name, hazards: HAZARDS, trackLength: TRACK_LENGTH });
  clearInterval(raceTimer);
  raceTimer = setInterval(tick, TICK_MS);
}

function tick() {
  const dt = TICK_MS / 1000;
  const run = currentRun;
  run.elapsed += TICK_MS;

  // Smoothly steer toward the latest tilt target
  run.x += (run.targetX - run.x) * STEER_SMOOTHING;
  run.x = Math.max(-LANE_HALF_WIDTH, Math.min(LANE_HALF_WIDTH, run.x));

  const inBoostLane = Math.abs(run.x) > SAFE_ZONE;
  const speed = inBoostLane ? BOOST_SPEED : SAFE_SPEED;
  run.distance += speed * dt;

  // Hazard collisions (each hazard can only hit you once per lap)
  for (const hz of HAZARDS) {
    if (run.hitHazards.has(hz.id)) continue;
    if (run.distance >= hz.distanceStart && run.distance <= hz.distanceEnd) {
      if (run.x >= hz.xStart && run.x <= hz.xEnd) {
        run.hitHazards.add(hz.id);
        run.distance = Math.max(0, run.distance - HAZARD_KNOCKBACK);
        if (activeControllerId) {
          io.to(activeControllerId).emit("controller:hazardHit"); // triggers phone vibration
        }
        io.emit("race:hazardHit"); // triggers the display's hazard SFX
      }
    }
  }

  run.samples.push({ t: run.elapsed, d: run.distance, x: run.x });

  const ghostState = ghostBest
    ? sampleGhost(ghostBest.samples, run.elapsed, ghostBest.finishTime)
    : null;

  io.emit("race:tick", {
    elapsed: run.elapsed,
    player: { distance: run.distance, x: run.x },
    ghost: ghostState,
    bestTime: ghostBest ? ghostBest.finishTime : null,
  });

  if (run.distance >= TRACK_LENGTH) {
    finishRace();
  }
}

function finishRace() {
  clearInterval(raceTimer);
  raceActive = false;

  const run = currentRun;
  const finalTime = run.elapsed;
  const isNewRecord = !ghostBest || finalTime < ghostBest.finishTime;

  if (isNewRecord) {
    ghostBest = { finishTime: finalTime, samples: run.samples, playerName: run.name };
    saveGhost(ghostBest);
  }

  leaderboard.push({ name: run.name, time: finalTime, date: Date.now() });
  leaderboard.sort((a, b) => a.time - b.time);
  leaderboard = leaderboard.slice(0, 10);
  saveLeaderboard(leaderboard);

  const achievements = [];
  if (run.hitHazards.size === 0) {
    achievements.push({ id: "clean", label: "CLEAN RUN", desc: "No hazards hit" });
  }
  if (finalTime < SPEED_DEMON_MS) {
    achievements.push({ id: "speed", label: "SPEED DEMON", desc: "Sub 45s lap" });
  }
  if (isNewRecord) {
    achievements.push({ id: "record", label: "RECORD BREAKER", desc: "New all-time best" });
  }

  io.emit("race:finished", {
    name: run.name,
    finalTime,
    isNewRecord,
    leaderboard,
    bestTime: ghostBest.finishTime,
    achievements,
  });

  currentRun = null;
}

function promoteNextInQueue() {
  if (queue.length === 0) {
    activeControllerId = null;
    return;
  }
  const next = queue.shift();
  const socket = io.sockets.sockets.get(next.id);
  if (!socket) {
    promoteNextInQueue(); // that player already disconnected, try the next one
    return;
  }
  activeControllerId = next.id;
  socket.data.name = next.name;
  socket.emit("controller:joined");
  io.emit("display:playerJoined", { name: next.name });
}

// ---------------------------------------------------------------------------
// Express + Socket.io wiring
// ---------------------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.redirect("/display.html"));

// QR code that always points at whatever host/IP was used to load THIS page,
// so it works automatically over the venue's LAN without hardcoding an IP.
app.get("/qr", async (req, res) => {
  try {
    const host = req.headers.host;
    const joinUrl = `http://${host}/controller.html`;
    const buffer = await QRCode.toBuffer(joinUrl, { width: 320, margin: 1 });
    res.type("png").send(buffer);
  } catch (e) {
    console.error(e);
    res.status(500).send("QR generation failed");
  }
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  socket.emit("state:init", {
    leaderboard,
    bestTime: ghostBest ? ghostBest.finishTime : null,
    trackLength: TRACK_LENGTH,
    hazards: HAZARDS,
  });

  socket.on("controller:join", ({ name } = {}) => {
    const cleanName = (name || "Player").toString().trim().slice(0, 16) || "Player";
    if (!activeControllerId) {
      activeControllerId = socket.id;
      socket.data.name = cleanName;
      socket.emit("controller:joined");
      io.emit("display:playerJoined", { name: cleanName });
    } else {
      queue.push({ id: socket.id, name: cleanName });
      socket.emit("controller:queued", { position: queue.length });
    }
  });

  socket.on("controller:start", () => {
    if (socket.id !== activeControllerId || raceActive || countdownActive) return;
    beginCountdown(socket.data.name || "Player");
  });

  socket.on("controller:steer", (value) => {
    if (socket.id !== activeControllerId || !raceActive || !currentRun) return;
    const v = Math.max(-1, Math.min(1, Number(value) || 0));
    currentRun.targetX = v * LANE_HALF_WIDTH;
  });

  socket.on("controller:leave", () => {
    handleControllerLeave(socket);
  });

  socket.on("disconnect", () => {
    handleControllerLeave(socket);
  });

  function handleControllerLeave(socket) {
    if (socket.id === activeControllerId) {
      clearInterval(raceTimer);
      clearInterval(countdownTimer);
      countdownTimer = null;
      countdownActive = false;
      raceActive = false;
      currentRun = null;
      io.emit("display:playerLeft");
      promoteNextInQueue();
    } else {
      queue = queue.filter((q) => q.id !== socket.id);
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\nPacket Rush is running!`);
  console.log(`  Big screen:  http://localhost:${PORT}/display.html`);
  console.log(`  (Open the big-screen URL using your machine's LAN IP so`);
  console.log(`   the QR code resolves correctly for phones on the same WiFi.)\n`);
});
