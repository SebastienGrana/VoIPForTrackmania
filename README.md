# VoIPForTrackmania — Proximity Voice Chat

Proximity voice chat for **Trackmania² Stadium (ManiaPlanet)**. Players who are close to each other hear each other loudly; players far away hear each other faintly or not at all.

> **Live server:** `https://62.238.61.115.sslip.io` — hosted by the ONZSM community.

---

## For players — Quick install

### 1. Install the OpenPlanet plugin

1. Open your ManiaPlanet `Openplanet4` folder (usually `C:\Users\<you>\Openplanet4\Plugins`)
2. Create a subfolder named `OnZVoIP`
3. Copy every file from [`openplanet-plugin/`](openplanet-plugin/) into it — `Main.as`, `Interface.as`, `GameState.as`, `Network.as`, `Strings.as`, `Settings.as`, and `info.toml`. OpenPlanet compiles every `.as` file in the folder as one module, so a partial copy won't compile.
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

## Privacy

**Each game server gets its own voice room**, and the link the plugin gives you carries a **single-use nonce** rather than your login: the relay exchanges it for a LiveKit token bound to the right room and identity, then discards it. A link that has already been opened is useless to anyone else.

Inside a room, though, there is no per-player access control: **anyone who is in it sees every participant's Trackmania login and exact in-game position**, broadcast in real time, and hears/can be heard by them. That is scoped to the people playing on the same server, but be aware of it.

Two limits worth stating plainly:

- **There is no verifiable Trackmania identity** to bind a connection to. Anyone who can reach the relay's TCP ingest port can claim a login and inject a position. Admins can set `TCP_SHARED_SECRET` to raise that from "anyone on the internet" to "anyone our community gave the token to" — it is access control for the community, not authentication of individual players.
- **The ingest port is plaintext.** The permanent secret never travels on it: the plugin exchanges it over HTTPS for a 30-second single-use token, and only that token goes over TCP.

Reviewers and self-hosters: [`REVIEWING.md`](REVIEWING.md) has the full threat model.

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

### Point the plugin at your server

No rebuild needed — in-game, open the OpenPlanet overlay → Settings → Plugins → **OnZVoIP** and set:

- **Relay host** / **Relay port** — TCP ingest address of your relay
- **Voice chat URL** — your web client's URL (must point at the same relay)
- **Relay secret** — only needed if your relay sets `TCP_SHARED_SECRET` (see `server/.env.example`); leave blank otherwise. The plugin's own window (not just the Settings panel) shows this field and flags in red when the relay is rejecting the connection because one is required — no need to hunt for it in advance.

---

## OpenPlanet compatibility

| Game | Build | Status |
|------|-------|--------|
| Trackmania² Stadium (ManiaPlanet) | OpenPlanet 1.29.5 | ✅ Tested in-game |
| Trackmania (2020) | OpenPlanet next | 🟨 Code path written, **not yet tested in-game** |
| ShootMania | ManiaPlanet build | ⬜ Untested |

The two games disagree on exactly one thing: how you read the local player's
position. ManiaPlanet 4 casts the player to `CTrackManiaPlayer` and reads
`.Position`; TM2020 has no such type and goes through
`CSmPlayer.ScriptAPI` → `CSmScriptPlayer.Position`. Everything else — the app,
network, playground and server-info objects — is identical across both.

Because OpenPlanet's AngelScript rejects an unknown type name at *compile*
time, this cannot be a runtime check; `GameState.as` branches on the `TMNEXT`
preprocessor define instead. See `TryGetLocalPlayerPosition()`.

One thing to watch on TM2020: rooms are derived from the server login
(`CGameCtnNetServerInfo.ServerLogin`). That is reliable on dedicated servers,
but has not been verified on club rooms or Nadeo matchmaking — if a server
reports no login there, everyone on it falls back to the default room.

---

## Distance calibration defaults

| Parameter | Value | Meaning |
|-----------|-------|---------|
| `MIN_DIST` | 1 m | Full volume within this range |
| `MAX_DIST` | 150 m | Silent beyond this range |
| `PAN_STRENGTH` | 90 % | Width of the stereo image (the pan follows the direction a voice comes from, not a number of metres) |

Adjust in the web client's calibration section.
