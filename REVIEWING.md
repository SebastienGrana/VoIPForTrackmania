# Notes for reviewers

This document exists so a reviewer doesn't have to reverse-engineer the plugin's
intent from its source. It covers what the plugin talks to, what it sends, what
it deliberately does *not* do, and where the weak points are.

Everything here is checkable against the source — file and function names are
given so you can jump straight to the code rather than take this on faith.

---

## 1. What it is, in one paragraph

`OnZVoIP` is proximity voice chat for **Trackmania² Stadium (ManiaPlanet)**. The
plugin does one job: read the local player's position and send it to a relay
server. It contains no audio code at all. Voice happens in a **browser tab** the
player opens via a link the plugin generates; that page joins a
[LiveKit](https://livekit.io) room and applies per-player gain and stereo pan in
WebAudio based on the positions the relay broadcasts.

The split matters for review: the in-game plugin is ~670 lines of AngelScript
with **no audio, no file I/O, and no game-state writes**. It reads position and
writes to one TCP socket.

---

## 2. Prior art — how this differs from XertroV's plugin

There is already an excellent proximity voice chat plugin on Openplanet:
[**Proximity Voice Chat** by XertroV](https://openplanet.dev/plugin/proximity-voice-chat),
which supports both Trackmania and ManiaPlanet 4. It is more mature than this
one and covers more games. **This plugin is not a replacement for it** — it's a
different trade-off, and if XertroV's setup works for you, use it.

The difference is where the audio stack lives:

| | Proximity Voice Chat (XertroV) | OnZVoIP (this plugin) |
|---|---|---|
| Voice transport | Mumble | WebRTC in a browser tab |
| Player must install | Mumble client + TM-to-Mumble Link bridge app | nothing beyond the plugin |
| Player must configure | Mumble positional audio, audio devices, setup wizard | click **Copy URL**, allow the mic |
| Spatialization | Mumble positional audio | WebAudio, computed per-listener in the page |
| Server operator runs | Mumble server | relay + LiveKit SFU |

The design goal here was **zero client-side setup**: no second application to
install, no positional-audio checkbox to find, nothing to configure per-player.
The cost is that voice lives in a browser tab instead of a native client, and
the server side is heavier to self-host. That's the whole trade.

---

## 3. Network behaviour — exactly what leaves the machine

The plugin talks to **one host**, the relay, configured by the player in
*Settings → Plugins → OnZVoIP*. There are **no third-party endpoints, no
analytics, no telemetry, and no hardcoded phone-home**. The default host points
at the ONZSM community relay and can be changed to any self-hosted one.

Two connections, both to that same configured host:

**a) TCP to `S_RelayHost:S_RelayPort`** (default port 8081) — opened in
`TryConnect()` (`Network.as`). Newline-delimited JSON, plaintext. Three message
types go out:

```jsonc
// every 200 ms while in a race (Main.as, SEND_INTERVAL_MS)
{"type":"position","pseudo":"<your TM login>","server":"<server login>",
 "serverName":"<server display name>","x":..,"y":..,"z":..}

// on connect / server change / every 9 min (Network.as, SendNonce)
{"type":"nonce","nonce":"<8 hex chars>","login":"..","server":"..","serverName":".."}

// only when the relay requires a token (Main.as)
{"type":"auth","token":"<one-time token>"}
```

**b) HTTPS `POST /tcp-auth`** to `S_VoipUrl` — `FetchAuthToken()`
(`Network.as`). Only fires if the player has filled in a relay secret. Sends
`{"secret": "..."}`, receives a single-use token. See §5 for why.

The relay pushes back one message type, read in `Main.as`:
`{"type":"state","players":N,"web":bool,"mic":bool}` — used to render the
player count in the widget. Nothing in that path is executed or written to disk;
it's parsed with `Json::Parse` and three fields are read.

**Data sent about you:** your Trackmania login, your in-game XYZ position, and
the login + display name of the server you're on. Nothing else. No IP beyond the
one the TCP connection inherently reveals, no hardware info, no map, no inputs.

---

## 4. OpenPlanet API surface

The complete list of what the plugin touches:

- **`Net::Socket`** — the TCP connection. The only socket the plugin opens.
- **`Net::HttpPost`** — the `/tcp-auth` call, only when a secret is configured.
- **`Json::Parse`** — parsing relay replies.
- **`IO::SetClipboard`** — *only* inside the **Copy URL** button handler
  (`Interface.as`). Never called automatically, never reads the clipboard.
- **`UI::` / `nvg::`** — the settings window and the compact status pill.
- **`Display::GetWidth()`** — positioning that pill relative to the right edge.
- **Game reads** (`GameState.as`): `CGameManiaPlanet`, `CGamePlayground`,
  `CGameTerminal.GUIPlayer` / `.ControlledPlayer`, `CGamePlayer.User.Login`,
  `CGameCtnNetServerInfo.ServerLogin` / `.ServerName`, and the position —
  `CTrackManiaPlayer.Position` on ManiaPlanet 4, or
  `CSmPlayer.ScriptAPI` → `CSmScriptPlayer.Position` under `#if TMNEXT`, since
  `CTrackManiaPlayer` does not exist in TM2020 and an unknown type name is a
  compile error rather than a null cast.

**Not used:** no file I/O, no `IO::` beyond the clipboard write, no process
spawning, no DLL loading, no memory patching, no writes to any game object, no
`Dev::` calls. `info.toml` declares no special permissions beyond the default.

---

## 5. Security model

Be clear on what's protected and what isn't — the honest summary is that this is
**community-scoped access control, not per-player authentication**.

**There is no verifiable Trackmania identity to bind to.** A client can claim any
login over the TCP port. The relay validates the *shape* of a login
(`validateLogin`, `relay.js` — non-empty, ≤64 chars) and of a server login
(`validateServer` — `^[a-z0-9_-]+$`, ≤64 chars) but cannot prove either. So:
**someone who can reach the ingest port can impersonate a login and inject a
fake position.** This is a known, accepted limitation, not an oversight.

What the relay *does* enforce:

- **Optional shared secret** (`TCP_SHARED_SECRET`). Raises the bar from "anyone
  on the internet" to "anyone the community gave the token to". Off by default,
  so self-hosters aren't forced into it.
- **The plugin never puts the permanent secret on the plaintext TCP port.** It
  POSTs it over HTTPS to `/tcp-auth` and gets back a **single-use token with a
  30 s TTL** (`TCP_AUTH_TOKEN_TTL_MS`), and only that disposable token goes over
  TCP. Sniffing port 8081 for plugin traffic yields a value that's already
  spent. Port 8081 has no TLS — this is the mitigation for that, not a claim
  that it's encrypted. A legacy path still lets a TCP client authenticate with
  the raw secret directly (kept for `simulate-positions.js` and older plugin
  builds); it isn't free to brute-force — it shares the same 20/min/IP limiter
  as `/tcp-auth` — but a reviewer should know the raw secret *can* still cross
  port 8081 on that path, just not from the plugin itself.
- **`/tcp-auth` 404s when no secret is configured**, so an unauthenticated prober
  can't tell whether a relay has the feature on.
- **Rate limits**: `/token` 30/min/IP, `/tcp-auth` 20/min/IP, 30 msg/s per TCP
  connection and per WebSocket, plus a cap on concurrent TCP connections and an
  idle timeout.
- **One-time nonces** for the join link. The plugin generates a nonce via
  `Crypto::RandomBase64` (`GenerateNonce`, `Network.as`) — 6 bytes from
  OpenPlanet's CSPRNG, URL-safe base64-encoded; the relay exchanges it for a
  LiveKit JWT bound to the right room and identity, then deletes it. TTL is
  short and it is single-use, so a leaked URL is useless once opened.
- **LiveKit grants are minimal**: `canPublishData: false`, so a browser client
  can publish audio but cannot inject position packets into the data channel.
- **No caller-supplied room id anywhere.** A room is only ever derived from the
  nonce or from the validated server login. Neither `GET /token` nor an ingest
  `position` message accepts a raw room override — honouring one would let an
  unauthenticated caller mint a publish-capable token for, or inject positions
  into, an arbitrary community's room. (An earlier debug override existed for
  local testing and was removed.)
- **`bot.html`** (a solo-calibration tool that publishes a fake audio track) is
  **404'd unless `ENABLE_CALIBRATION_BOT=true`**, off by default — and so is the
  legacy `GET /token?identity=<name>` path, its only consumer. That path is
  unauthenticated and takes the identity straight from the query string, so on a
  public relay it would hand anyone a publish-capable token under any name.
  Real players never touch it; they arrive with a nonce. It 404s rather than
  403s so it doesn't advertise its own existence.

**Privacy — who sees what.** Anyone holding a room's URL sees every player in
that room: their Trackmania login and their live in-game position. Rooms are
per-game-server, so this is scoped to people you're playing with, but there is
no per-player access control beyond the one-time link. Players should know their
login and position are visible to whoever is in the room. This is stated in the
README too, not buried here.

---

## 6. On the use of AI

**This project was written with substantial AI assistance (Claude).** Per
Openplanet's terms this is declared in `info.toml` as well.

Being upfront about what that means for a reviewer:

- **Every line has been read, run, and tested in-game by a human** before
  submission. The plugin has been through real multi-player sessions on a live
  ManiaPlanet server, not just compiled.
- **The comments are denser than typical.** That's deliberate: they explain
  *why* a non-obvious choice was made (why `listRooms` before `sendData`, why a
  one-time token instead of the raw secret, why `continue` and not `return` in
  the TCP read loop) rather than restating what the line does. If a comment
  looks like it's over-explaining, it's usually marking a bug that was actually
  hit. Trim them freely if that's not the house style.
- **The server side has 102 tests** across `audio-math.test.js` (26),
  `relay.test.js` (49), and `room-name.test.js` (27), run with `npm test` in
  `server/`. Coverage is measured, not assumed — `npm run coverage` prints it:

  | File | Line | Branch |
  |---|---|---|
  | `src/relay.js` | 95.3 % | 80.8 % |
  | `src/room-name.js` | 100 % | 95.5 % |
  | `public/audio-math.js` | 100 % | 100 % |

  Every security-relevant path is exercised: nonce single-use and expiry, the
  `/tcp-auth` token exchange *and* its 404-when-unconfigured behaviour, all four
  rate limiters, the calibration-bot gate in its default-off state, login and
  server-login validation (including path-traversal-shaped input), and both
  ingest transports (TCP and the `/ingest` WebSocket) with malformed input and
  flood cases. What the remaining ~5 % is: periodic GC timer callbacks and
  `catch` arms for LiveKit RPC failures. These were written against real bugs
  found in review, not retrofitted for the number.
- **Known limitations are documented rather than hidden** — see §5, which
  leads with what this design *cannot* protect against rather than burying it.

If something looks wrong, it's a genuine mistake and not something to be polite
about — please flag it.

---

## 7. Where to look

Plugin (AngelScript, ~670 lines total — OpenPlanet compiles all `.as` in the
folder as one module, hence no includes):

| File | Lines | Contents |
|---|---|---|
| `Main.as` | 224 | State, main loop, connect/auth/reconnect, relay reply parsing |
| `Interface.as` | 174 | ImGui window, menu entry, NanoVG status pill |
| `GameState.as` | 107 | Reading player position / server info from the game, `#if TMNEXT` branch for TM2020 |
| `Network.as` | 75 | Socket connect, `/tcp-auth` exchange, nonce generation |
| `Strings.as` | 59 | JSON escaping, Trackmania `$`-code stripping |
| `Settings.as` | 32 | The seven user-facing settings |

Server (Node.js, MIT, in the same repo under `server/`) — `relay.js` holds all
the logic and is where the security-relevant code lives; `index.js` is only env
wiring. Run it locally with `docker compose up` from the repo root.

Repo: <https://github.com/SebastienGrana/VoIPForTrackmania>
