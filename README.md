# Packet Rush

A booth game built for live expos: attendees scan a QR code, their phone becomes
a tilt controller, and they steer a "data packet" through a network track —
racing a live ghost replay of the current all-time booth record.

- **Session length:** ~45–90 seconds per lap, players naturally do 2–4 laps
- **One active controller at a time** (others auto-queue), so there's no
  complex live multiplayer networking to worry about on the day
- **Fully self-hosted** — no internet dependency once `npm install` is done

## Feature checklist

| Feature | Where it lives |
|---|---|
| Landing/onboarding | Display idle screen: QR code + a 3-line "how to play" panel |
| Smooth animations & transitions | Glass-panel pop-ins, badge stagger-in, countdown pulse, screen fades |
| Sound + music, with mute | Fully **synthesized** via the Web Audio API (see below) — mute button + `M` key on both screens, persisted in `localStorage` |
| Responsive design | Media queries for both the big screen and phone (incl. landscape phones) |
| Leaderboard & achievements | Top 10 board on the display; **Clean Run / Speed Demon / Record Breaker** badges awarded per-lap |
| Save progress / profile | Lightweight per-device profile in `localStorage` — remembers your name and personal best, no account needed |
| Dark mode, cohesive palette | One token system (`--bg`, `--cyan`, `--magenta`, etc.) shared by both screens |
| Polished loading & game-over screens | Branded splash on the display while it connects; countdown ("3‑2‑1‑GO") before every race; animated result screen with badges and confetti on a new record |
| Keyboard, mouse, touch | Phone: tilt, touch buttons, **and** arrow keys/mouse hold (handy for desk-testing without a phone). Display: `M` mute, `F` fullscreen |
| Fast loading, high frame rate | No external game assets; canvas rendering uses **client-side interpolation** to render smoothly at your display's refresh rate even though the server only sends state 20×/second |

### Why the audio is synthesized, not audio files
All sound effects and the background hum are generated live with the Web Audio
API (oscillators + envelopes) instead of loaded from `.mp3`/`.wav` files. That
means zero extra assets to bundle, zero load time for audio, and — most
importantly for a booth with unreliable venue WiFi — **zero dependency on
fetching audio over the network**. If you'd rather use real music/SFX files,
swap the `AudioEngine` calls for `<audio>` elements; everything routes through
one small object so it's a contained change.

---

## 1. Setup (do this before the expo, while you have internet)

```bash
cd packet-rush
npm install
```

This installs `express`, `socket.io`, and `qrcode`.

## 2. Run it

```bash
npm start
```

You'll see:

```
Packet Rush is running!
  Big screen:  http://localhost:3000/display.html
```

## 3. On expo day

1. **Connect your laptop to the venue WiFi**, or — much safer — **turn your
   laptop into its own WiFi hotspot** so the game doesn't depend on venue
   internet at all. Either way, everything (server + phones) just needs to be
   on the same local network.
2. Find your laptop's LAN IP address (e.g. `192.168.1.23`):
   - Mac: `ipconfig getifaddr en0`
   - Windows: `ipconfig` (look for IPv4 Address)
   - Linux: `hostname -I`
3. On the **big screen's browser**, open:
   ```
   http://<your-LAN-IP>:3000/display.html
   ```
   Using the LAN IP (not `localhost`) is important — the QR code embeds
   whatever host was used to load this page, so phones need it to already be
   the real network address.
4. Attendees scan the QR code shown on screen with their own phone camera —
   it opens `controller.html` directly in their mobile browser. No app install.

## 4. Playing

- Player enters a name and taps **JOIN**.
- If they're first in line, they become the active controller immediately;
  otherwise they see a queue position and are promoted automatically.
- On iOS, a **"ENABLE TILT CONTROL"** button appears first (iOS requires an
  explicit tap before it will share motion data). Android generally doesn't
  need this step.
- Tilt the phone left/right to steer. Center = safe lane (steady speed, no
  hazards). Either edge = fast lane (faster, but hazards may knock you back).
- On-screen ◀ ▶ buttons work as a backup at all times, in case tilt access is
  denied/unsupported — the game is fully playable by touch alone.
- Finishing shows the lap time, and whether it's a new all-time record. If it
  is, that run instantly becomes the new ghost every future player races against.

## 5. Important live-event note about tilt controls

Browsers increasingly require a **secure context (HTTPS)** to grant motion
sensor access, even on a local network. Two ways to handle this:

- **Easiest for a one-day booth:** rely on the built-in ◀ ▶ touch buttons —
  they work identically well over plain HTTP and require zero setup. The game
  is fully designed to be fun with touch alone.
- **If you want real tilt control guaranteed:** set up a local HTTPS
  certificate (e.g. with [mkcert](https://github.com/FiloSottile/mkcert)) and
  serve the app over `https://` instead. This is optional — do this ahead of
  time and test it on both an iPhone and an Android phone before the event,
  since browser behavior differs.

## 6. Tuning knobs (top of `server.js`)

| Constant | What it does |
|---|---|
| `TRACK_LENGTH` | Total lap distance — increase for longer laps |
| `SAFE_SPEED` / `BOOST_SPEED` | Speed in the center lane vs. the outer fast lanes |
| `HAZARD_KNOCKBACK` | How much distance a hazard collision costs you |
| `TRACK_SEED` | Change this to regenerate a different (but still fixed) hazard layout |
| `SPEED_DEMON_MS` | Finish under this time to earn the Speed Demon badge |
| `COUNTDOWN_SECONDS` | Length of the "3‑2‑1‑GO" pre-race countdown |

Data persists in `data/ghost.json` and `data/leaderboard.json` — delete both
before the event if you want to start with a clean slate, or keep them if
you've been testing and want to carry over a benchmark time.

## 7. Project structure

```
packet-rush/
├── package.json
├── server.js              # authoritative race simulation + Socket.io + QR endpoint
├── data/                  # auto-created: ghost.json, leaderboard.json
└── public/
    ├── display.html        # big-screen view: QR code, live canvas race, leaderboard
    └── controller.html      # phone view: join, tilt/touch steering, results
```
