# VoIPForTrackmania — Proximity Voice Chat

Proximity voice chat for **Trackmania² Stadium (ManiaPlanet)**. Players who are close to each other hear each other loudly; players far away hear each other faintly or not at all.

> **Live server:** `https://62.238.61.115.sslip.io` — hosted by the ONZSM community.

---

## For players — Quick install

### 1. Install the OpenPlanet plugin

1. Open your ManiaPlanet `Openplanet4` folder (usually `C:\Users\<you>\Openplanet4\Plugins`)
2. Create a subfolder named `OnZVoIP`
3. Copy [`openplanet-plugin/Main.as`](openplanet-plugin/Main.as) and [`openplanet-plugin/info.toml`](openplanet-plugin/info.toml) into it
4. In-game: open the OpenPlanet overlay → Plugin Manager → **Reload plugins**

The plugin window **OnZVoIP** will appear. It shows your relay connection status and your Trackmania login.

### 2. Join the voice room

While in a race, click **Copy URL** in the plugin window (or copy the URL from the field below it), paste it into your browser, and click **Join**.  
Enable your microphone when prompted. That's it — you'll hear nearby players automatically.

---

## Architecture overview

```
OpenPlanet plugin  ──TCP──▶  Node.js relay  ──data channel──▶  LiveKit SFU
  (position)                  (position fan-out)                (audio streams)
                                                                      │
                                                              Browser web client
                                                         (computes gain + pan per player)
```

- **OpenPlanet plugin** (`openplanet-plugin/`) — reads the local player's position every 200 ms and sends it to the relay over a raw TCP socket (no extra plugin dependency).
- **Node.js relay** (`server/`) — fans out positions to all room participants via LiveKit data channels; also issues LiveKit join tokens.
- **Web client** (`server/public/`) — receives positions, computes distance and stereo pan for each remote player in WebAudio, and plays their audio stream accordingly. Includes a calibration bot (`bot.html`) for solo testing, served only when `ENABLE_CALIBRATION_BOT=true` (off by default — see `server/.env.example`).

Volume and panning are computed **client-side** — LiveKit (an SFU) distributes the same encoded audio stream to all subscribers; per-pair attenuation must happen at the listener's end.

---

## Local development

```bash
cp .env.example .env   # set LIVEKIT_NODE_IP to your LAN IP if testing from another device
docker compose up
```

Runs a dev LiveKit server + the relay locally. `LIVEKIT_NODE_IP` (default `127.0.0.1`) is the address LiveKit advertises to WebRTC clients for media — only needed if you're joining from a device other than the one running docker compose.

## Self-hosting

### Requirements

- A VPS with a public IP (tested on Hetzner)
- [LiveKit](https://github.com/livekit/livekit) v1.13+ (self-hosted or LiveKit Cloud)
- Node.js 18+
- A domain or [sslip.io](https://sslip.io) hostname + [Caddy](https://caddyserver.com) for HTTPS (microphone requires HTTPS)

### Relay server

```bash
cd server
npm install
cp .env.example .env   # fill in your LiveKit credentials
npm start
```

### LiveKit + Caddy + systemd

Config templates for running LiveKit and the relay as systemd services behind a Caddy HTTPS reverse proxy live in [`deploy/`](deploy/) — see [`deploy/README.md`](deploy/README.md) for install steps.

### Update the plugin to point to your server

Edit the constants at the top of `openplanet-plugin/Main.as`:

```angelscript
const string RELAY_HOST = "your.vps.ip";   // TCP ingest
const string VOIP_URL   = "https://your.domain.example";
```

---

## OpenPlanet compatibility

| Game | Build | Status |
|------|-------|--------|
| Trackmania² Stadium (ManiaPlanet) | OpenPlanet 1.29.5 | ✅ Tested |
| TM2020 | OpenPlanet next | ⬜ Not yet (different position API) |
| ShootMania | ManiaPlanet build | ⬜ Untested |

---

## Distance calibration defaults

| Parameter | Value | Meaning |
|-----------|-------|---------|
| `MIN_DIST` | 1 m | Full volume within this range |
| `MAX_DIST` | 150 m | Silent beyond this range |
| `PAN_RANGE` | 10 m | Full stereo pan at this side offset |

Adjust in the web client's calibration section.
