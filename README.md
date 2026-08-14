# VoIPForTrackmania — Proximity Voice Chat

Proximity voice chat for **Trackmania² Stadium (ManiaPlanet)**. Players who are close to each other hear each other loudly; players far away hear each other faintly or not at all.

> **Live server:** `https://onzvoip.com` — hosted by the ONZSM community.

---

## For players — Quick install

### 1. Install the OpenPlanet plugin

1. Download **`OnZVoIP.op`** — one file. An `.op` is OpenPlanet's own plugin format; do **not** unzip it or rename it.
2. Drop it into `C:\Users\<you>\Openplanet4\Plugins\`.
3. In-game: open the OpenPlanet overlay → Plugin Manager → **Reload plugins**.

The plugin window **OnZVoIP** appears in the overlay.

> Already installed it as a *folder* named `OnZVoIP`? Delete that folder before dropping the `.op` in, or OpenPlanet loads the plugin twice.

### 2. Join the voice room

Enter a race, then click **Open in browser** in the plugin window. That link is what proves to the relay which player you are — which is why the page never asks you to type a name. Allow the microphone when the tab asks for it, and you're in: nearby players are loud, distant ones faint.

If the button can't reach your browser, **Copy URL** under *Advanced* gives you the same link to paste by hand.

### 3. If something doesn't work — `/check`

`https://<server>/check` is a self-test page: HTTPS, relay reachable, voice server reachable, WebSocket, WebRTC, in-game plugin, microphone. Every failure comes with what to *do* about it, not an error code, and a **Copy diagnostic** button produces a block to paste in the Discord help channel. No password.

It is in English by default, and in French if your browser asks for French.

To have it check the **plugin** too, open it from the game: take the plugin's link and change `/?t=` to `/check?t=` in the address bar. Opened without that, the plugin test simply reads *not tested* — never a failure.

---

## Architecture overview

```
OpenPlanet plugin  ──TCP──▶  Node.js relay  ──data channel──▶  LiveKit SFU
  (position)                  (position fan-out)                (audio streams)
                                                                      │
                                                              Browser web client
                                                         (computes gain + pan per player)
```

- **OpenPlanet plugin** (`OnZVoIP/`) — reads the local player's position every 200 ms and sends it to the relay over a raw TCP socket (no extra plugin dependency).
- **Node.js relay** (`server/`) — fans out positions to all room participants via LiveKit data channels; also issues LiveKit join tokens.
- **Web client** (`server/public/`) — receives positions, computes distance and stereo pan for each remote player in WebAudio, and plays their audio stream accordingly. Also serves `/check`, the player-facing self-test page. Includes a calibration bot (`bot.html`) for solo testing, served only when `ENABLE_CALIBRATION_BOT=true` (off by default — see `server/.env.example`).

Volume and panning are computed **client-side** — LiveKit (an SFU) distributes the same encoded audio stream to all subscribers; per-pair attenuation must happen at the listener's end.

---

## Privacy

**Each game server gets its own voice room**, and the link the plugin gives you carries a **single-use nonce** rather than your login: the relay exchanges it for a LiveKit token bound to the right room and identity, then discards it. A link that has already been opened is useless to anyone else.

Inside a room, though, there is no per-player access control: **anyone who is in it sees every participant's Trackmania login and exact in-game position**, broadcast in real time, and hears/can be heard by them. That is scoped to the people playing on the same server, but be aware of it.

The web client also guesses a **country** from your browser's timezone and language (never your IP, nothing sent to a third party) and shows it as a flag next to your name; anyone in the room can see it, and you can change or remove it from Settings at any time.

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

While working on the plugin itself, copy `OnZVoIP/` into `Openplanet4\Plugins\OnZVoIP\` as loose files and use *Reload plugins* — an `.op` is only for distribution. To build the one players download:

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-op.ps1   # -> dist/OnZVoIP.op
```

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

### Running an event

Three optional variables turn the relay into something you can watch during a session (all in `server/.env.example`):

- `EVENT_LOG_FILE` — appends one JSON object per line for each connect, disconnect, room change, rejected link and problem report. Logins, rooms and timestamps only: no positions, no audio.
- `ADMIN_USER` + `ADMIN_PASSWORD` — serve `/admin`, a live page listing who has the plugin running, on which version, who is missing their browser half, and the reports players sent. Both must be set or the page does not exist at all (404, not 401). Basic auth, so put it behind HTTPS.
- `ADMIN_ACTIONS` — additionally enables the tabs of `/admin` that *act* on the session (test bots, teams). With it off, those routes 404 and `/admin` stays read-only.

`/admin` is in French, and has a **Liens** tab listing every address of the running deployment — built from the page's own origin, so they are correct whatever the domain — with each one labelled public or private, because the point is that the public ones get copied into Discord and the others do not.

**Teams** (`ADMIN_ACTIONS`): group players by hand or split them automatically into 2–8 teams. Each team gets a colour, drawn as a ring around its members on everyone's radar, and can be given a *voice* flag — its members then hear each other anywhere on the map instead of only within earshot, still panned in the right direction. There is no second LiveKit room involved: a browser can only be in one room at a time, and leaving the map's room would remove that player from everyone else's proximity chat. Teams live in memory only and a relay restart clears them — they belong to one evening.

Players report problems from the web client itself — a **Report a problem** button at the bottom of the page sends their message with a short snapshot of their session (which they can read before sending), so a report arrives with the state that produced it instead of a "it doesn't work" in chat. Point them at `/check` first: it usually answers the question without anyone reading a log.

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
