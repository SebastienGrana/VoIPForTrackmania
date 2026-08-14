// Relay server logic — extracted from index.js to be testable.
// createRelay() accepts an injected roomService so tests can pass a mock
// without touching a real LiveKit server.

import crypto from 'crypto';
import express from 'express';
import http from 'http';
import net from 'net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { AccessToken } from 'livekit-server-sdk';
import { DataPacket_Kind, TrackType } from '@livekit/protocol';
import { roomNameFor, displayNameFor, stripTmFormatting } from './room-name.js';
import { positionGroups } from './position-cull.js';
import { nullEventLog } from './event-log.js';

// One-time nonce store.
// nonce → { login, server, serverName, expiry }
// The plugin generates a nonce and sends it over TCP alongside login+server.
// The browser then uses GET /token?t=<nonce> to get a token already bound to
// the right room — no identity or room param needed from the user.
const nonces = new Map();
const NONCE_TTL_MS = 12 * 60 * 1000;

// Resolved from this module rather than cwd: systemd starts the relay with
// WorkingDirectory=server, the tests run from the repo root, and sendFile
// needs an absolute path either way.
const ADMIN_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'admin.html');

// Prune expired nonces to avoid unbounded growth if a player never opens the URL.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of nonces) {
    if (v.expiry < now) nonces.delete(k);
  }
}, 30_000).unref();

// Simple fixed-window rate limiter, keyed by caller (IP for HTTP, socket for
// TCP/WS). Kept dependency-free since express-rate-limit isn't installed.
function createRateLimiter({ windowMs, max }) {
  const hits = new Map(); // key → { count, resetAt }
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) {
      if (v.resetAt < now) hits.delete(k);
    }
  }, windowMs).unref();
  return {
    allow(key) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.resetAt < now) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(key, entry);
      }
      entry.count++;
      return entry.count <= max;
    },
    stop() { clearInterval(interval); },
  };
}

function validateLogin(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return (s.length > 0 && s.length <= 64) ? s : null;
}

// Plugin version string from info.toml, e.g. "0.3.1". Purely informational —
// nothing branches on it — so the rule is only "safe to render on the admin
// page and short enough not to be a storage trick": anything unexpected is
// dropped rather than sanitised, which keeps "unknown" and "weird" the same
// case for the reader.
function validateVersion(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.length === 0 || s.length > 24) return null;
  if (!/^[a-z0-9._+-]+$/i.test(s)) return null;
  return s;
}

function validateServer(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  // TM server logins: alphanumeric, underscore, hyphen only
  if (s.length === 0 || s.length > 64) return null;
  if (!/^[a-z0-9_-]+$/i.test(s)) return null;
  return s;
}

export function createRelay({
  roomService,
  apiKey,
  apiSecret,
  liveKitPublicWsUrl,
  roomName,
  staticDir = 'public',
  tcpMaxConnections = 1000,
  tcpIdleTimeoutMs = 30_000,
  enableCalibrationBot = false,
  // Master switch for the whole debug surface: the ?debug=1 panel in the
  // browser, the manual "pick your own login" join, and the room picker that
  // comes with it. Off by default and meant to stay off once a relay is
  // published — it is kept in the code for the project's own testing and for
  // whoever forks it, not as a feature of the deployed site.
  //
  // Understand what turning it on does: it makes /token?identity=<anything>
  // answer, and lets that caller name the room. That is a publish-capable
  // token for an arbitrary room, minted from a query string, with no proof of
  // anything. On a public relay it means any visitor can walk into any
  // community's voice room under any name and listen. That is why the browser
  // asks the server (GET /config.js) whether debug is allowed instead of
  // deciding on its own: hiding the panel client-side would hide the buttons,
  // not close the door.
  debugMode = false,
  positionBroadcastIntervalMs = 100,
  // Port 8081 accepts any raw TCP connection with zero authentication —
  // anyone on the internet can inject positions/nonces for any pseudo.
  // There's no verifiable Trackmania identity to bind to (ManiaPlanet exposes
  // no signed identity API to plugins), so this can't become real per-player
  // auth — but a fixed community secret still raises the bar from "anyone on
  // the internet" to "someone who has the community's token", which stops
  // opportunistic scanners/bots cold. Empty string (default) disables the
  // check entirely, which keeps local dev and the test suite working without
  // configuring one.
  tcpSharedSecret = '',
  statePushIntervalMs = 5_000,
  // Where connect/disconnect/report events go. Defaults to a sink so tests and
  // local dev stay silent and no call site needs a null check.
  eventLog = nullEventLog,
  // Basic-auth credentials for /admin. Both empty (the default) means the page
  // does not exist at all — see the route for why that is not merely "hidden".
  adminUser = '',
  adminPassword = '',
  // A report is typed by a human, so five a minute per IP is already generous;
  // the ceiling exists to stop a script, not a tester. Overridable so tests can
  // exercise the endpoint without spending the whole allowance on setup.
  reportRateLimit = { windowMs: 60_000, max: 5 },
  // The admin page is read-only by design. This flag is the only thing that
  // adds buttons to it, and it is off by default: with it on, whoever holds
  // the admin password can flip DEBUG_MODE and disconnect players. Worth it
  // during an event you are running yourself, not worth it standing.
  adminActions = false,
  // Fake plugin connections, started from the admin page, to answer "does it
  // hold at 30 players" without 30 humans. Also off by default — it injects
  // positions under made-up logins, which is exactly what the TCP port is
  // meant to be protected against.
  enableTestBots = false,
  // Where those bots connect back to. Only used when enableTestBots is on.
  ingestTcpPort = 8081,
}) {
  // Mutable so the admin page can flip it mid-event; `debugMode` stays the
  // boot value nobody mutates by accident.
  let debugEnabled = debugMode;
  const encoder = new TextEncoder();
  // Positions are batched instead of sent one-by-one: calling
  // roomService.sendData() per incoming position would mean one HTTP call to
  // the LiveKit API per player per tick (at 5Hz/10 players that's 50 req/s
  // and grows linearly with room size). Instead, incoming positions just
  // update the latest-known map below; a single timer per relay flushes each
  // room's pending positions as ONE aggregated sendData() call at
  // positionBroadcastIntervalMs (5-10Hz is plenty for audio panning). The map
  // is cleared after each flush so a player who stops sending (disconnect)
  // simply stops appearing in future broadcasts, instead of their last
  // position being resent forever.
  const pendingPositions = new Map(); // room → Map(pseudo → {x, y, z, ts})
  // Same data, but NOT cleared on flush: the relevance cull needs to know where
  // every listener is, including the ones who sent nothing this tick because
  // they are parked (the plugin drops to a 1 Hz heartbeat when a car does not
  // move). Reading recipients out of pendingPositions instead would quietly
  // drop those players from the broadcast and freeze their screen.
  const knownPositions = new Map(); // room → Map(pseudo → {x, y, z, ts})
  // A player this quiet is gone, not parked - the plugin heartbeat is 1 s.
  const KNOWN_POSITION_TTL_MS = 15_000;
  // login -> last time a browser socket for it was seen alive. A tab that
  // reconnects stays a recipient across the gap; a tab that closed for good
  // ages out, and the cull can engage again. Kept under the position TTL above:
  // a grace longer than that would leave a closed tab counted as a listener
  // after its own position had already expired, and every one of those seconds
  // is a second the cull spends switched off.
  const browserSeen = new Map();
  const BROWSER_GRACE_MS = 10_000;

  // Who is actually listening in this room, and where they are - the input the
  // relevance cull needs. Returns null whenever we are not certain, and null
  // means "broadcast to everyone" (today's behaviour): sending a filtered
  // message to a listener we forgot about would freeze their radar, which is a
  // far worse failure than a few wasted bytes. The listener set comes from
  // live browser sockets rather than from the positions themselves, precisely
  // so a listener without a position is detected instead of silently skipped.
  //
  // Not browserRooms: that map is written at token issuance and never cleared,
  // so the first player to close their tab would stay a listener forever, no
  // position would ever be found for them, and the cull would switch itself
  // off for the rest of the evening. Live sockets churn, though - a tab whose
  // WebSocket reconnects would drop out of the set for a second and stop
  // receiving positions - hence the grace period.
  function listenersIn(room) {
    const knownMap = knownPositions.get(room);
    if (!knownMap) return null;
    const now = Date.now();
    for (const [pseudo, p] of knownMap) {
      if (now - p.ts > KNOWN_POSITION_TTL_MS) knownMap.delete(pseudo);
    }
    if (knownMap.size === 0) {
      knownPositions.delete(room);
      return null;
    }
    const listeners = new Map();
    for (const [login, seenAt] of browserSeen) {
      if (browserSockets.has(login)) browserSeen.set(login, now);
      else if (now - seenAt > BROWSER_GRACE_MS) { browserSeen.delete(login); continue; }
      if (browserRooms.get(login) !== room) continue;
      const at = knownMap.get(login);
      if (!at) return null; // someone is listening from a place we can't locate
      listeners.set(login, at);
    }
    return listeners.size > 0 ? listeners : null;
  }

  async function flushPositions() {
    for (const [room, posMap] of pendingPositions) {
      if (posMap.size === 0) continue;
      const positions = Array.from(posMap, ([pseudo, p]) => ({ pseudo, ...p }));
      posMap.clear();

      // A room only exists on LiveKit's side once someone has joined it via
      // the web client — the plugin sends positions the moment a player is on
      // a server, regardless of whether anyone opened that link. sendData()
      // to a room nobody has joined times out at LiveKit's psrpc layer (it
      // must reach the room's live process to broadcast on it), so check
      // first with listRooms(): unlike sendData/listParticipants, that call
      // is answered directly from LiveKit's room registry, not routed to a
      // live process, so it can't stall the same way on a room that doesn't
      // exist yet.
      let roomExists;
      try {
        const rooms = await roomService.listRooms([room]);
        roomExists = rooms.length > 0;
      } catch (err) {
        roomExists = false;
      }
      if (!roomExists) continue;

      for (const group of positionGroups(positions, listenersIn(room))) {
        const payload = JSON.stringify(group.positions);
        try {
          await roomService.sendData(room, encoder.encode(payload), DataPacket_Kind.LOSSY, {
            topic: 'position',
            ...(group.identities ? { destinationIdentities: group.identities } : {}),
          });
        } catch (err) {
          console.error('sendData failed:', err.message);
        }
      }
    }
  }
  const positionFlushTimer = setInterval(flushPositions, positionBroadcastIntervalMs).unref();

  // --- Equipes -------------------------------------------------------------
  // Event-night grouping: the organiser makes teams in /admin, every browser
  // colours its radar dots by team, and teammates on a team with voice on stay
  // audible anywhere on the map instead of only within earshot.
  //
  // Kept in memory on purpose. Teams belong to one evening and are rebuilt with
  // one click by the auto-split; persisting them would mean deciding when they
  // expire. A relay restart clears them, which is the wanted behavior.
  const TEAM_COLORS = ['#4aa8ff', '#4ade80', '#fbbf24', '#f87171', '#c084fc', '#22d3ee', '#fb923c', '#a3e635'];
  const TEAM_MAX = 8;
  const teams = new Map();       // id -> { id, name, color, voice }
  const teamByLogin = new Map(); // login -> team id
  let nextTeamId = 1;

  function teamsPayload() {
    return {
      type: 'teams',
      teams: Array.from(teams.values()),
      members: Object.fromEntries(teamByLogin),
    };
  }

  // Everyone receives the whole roster, not just their own team: the radar
  // colours every dot it draws, so a browser needs the colour of players it is
  // not grouped with. Nothing new leaks — these logins are already on the radar.
  function broadcastTeams() {
    const payload = JSON.stringify(teamsPayload());
    for (const ws of browserSockets.values()) {
      if (ws.readyState !== 1) continue;
      try { ws.send(payload); } catch {}
    }
  }
  // Tracks which WebSocket belongs to which browser login so the relay can
  // push room-change notifications when the plugin sends a new nonce.
  const browserSockets = new Map(); // login → WebSocket
  // Which room each browser was actually issued a token for. A browser can
  // send its own position (free-move / follow-a-player debug modes), but it
  // has no way to name the room: the /token response hands it a technical room
  // name, never the server login broadcastPosition() routes on. Without this
  // the position fell back to the default room and nobody on a server-specific
  // room ever saw it. Recorded here at token issuance, so it stays
  // server-derived — never a room id taken from the sender.
  const browserRooms = new Map(); // login → room
  const BROWSER_ROOMS_MAX = 5000;
  function rememberBrowserRoom(login, room) {
    if (!login || !room) return;
    browserRooms.delete(login); // re-insert to keep Map order = least-recent-first
    browserRooms.set(login, room);
    if (browserRooms.size > BROWSER_ROOMS_MAX) {
      const oldest = browserRooms.keys().next().value;
      browserRooms.delete(oldest);
    }
  }
  // Pushes relay state (player count, web connected, mic open) back to
  // the plugin over its existing TCP connection. Note the polarity of `mic`:
  // true means the microphone is OPEN. The plugin read it as "muted" once and
  // showed every player the opposite of their own state.
  // login → { socket, room, version, serverName, connectedAt, lastPositionAt,
  //           lastSeenAt }
  const tcpSocketsByLogin = new Map();

  // --- Login ownership on the ingest channels ---------------------------
  // Neither ingest channel is authenticated: TCP 8081 is open to the internet
  // and /ingest upgrades for anyone. Without a check, a stranger could send a
  // `nonce` carrying somebody else's login and push that player into a
  // different voice room — cutting them off from their team mid-event — or
  // publish positions under their name.
  //
  // So a login is owned by the connection that announced it, and messages
  // naming it from anywhere else are dropped. Ownership is PER CHANNEL: a
  // player legitimately holds the same login on both, their plugin over TCP
  // and their browser tab over the WebSocket, so the two are checked
  // separately and never against each other.
  //
  // This is a lock on the door, not authentication: whoever announces a login
  // first gets it. It stops a stranger from hijacking a player who is already
  // connected, which is the damage worth preventing tonight. Proper identity
  // on the ingest channel is a separate job — see todo.txt.
  //
  // Ownership normally ends with the socket's 'close'. This timeout covers the
  // case where it does not: a connection dropped without a FIN (power cut, Wi-Fi
  // loss) leaves an entry behind, and the player's own reconnect would be the
  // one refused. Well under the plugin's send interval — a plugin in game
  // reports at least once a second, so a live claim never goes stale — and
  // short enough that a real reconnect waits a few seconds at worst.
  const INGEST_CLAIM_IDLE_MS = 5_000;

  // Rejections are logged, but a flood must not be able to fill the disk
  // through the event log, so each login gets at most one line per minute.
  const claimRejectLogged = new Map(); // login → last logged at
  const CLAIM_REJECT_LOG_MS = 60_000;

  function claimRejected(login, kind, from) {
    const now = Date.now();
    if (now - (claimRejectLogged.get(login) ?? 0) < CLAIM_REJECT_LOG_MS) return;
    claimRejectLogged.set(login, now);
    eventLog.log('ingest.rejected', { login, kind, from: from ?? null });
  }

  // True when `login` belongs to a live connection other than `sender` on the
  // channel it arrived from, i.e. the message must be dropped.
  function ownedBySomeoneElse(login, sender) {
    if (!sender) return false; // internal callers (bots, tests) are not gated
    if (sender.kind === 'tcp') {
      const held = tcpSocketsByLogin.get(login);
      if (!held || held.socket === sender.socket) return false;
      if (held.socket.destroyed) return false;
      // Same machine, second connection: that is a player whose plugin
      // reconnected (game restarted, reloaded plugin) while the old socket
      // has not been reaped yet, so let it take its own login back. Port 8081
      // is spoken to directly, not through the reverse proxy, so this address
      // really is the client's — the check does not collapse the way it would
      // behind Caddy. It is a weak binding, but the attack it has to stop is
      // a stranger elsewhere on the internet naming somebody else's login.
      if (held.socket.remoteAddress === sender.socket.remoteAddress) return false;
      return Date.now() - (held.lastSeenAt ?? held.connectedAt ?? 0) < INGEST_CLAIM_IDLE_MS;
    }
    // No such leniency on the WebSocket side: /ingest arrives through Caddy,
    // where every connection reports 127.0.0.1 and comparing addresses would
    // let everyone through. A browser that reloads closes its socket, and the
    // 'close' handler frees the login, so strict ownership costs nothing here.
    const held = browserSockets.get(login);
    return held !== undefined && held !== sender.ws && held.readyState === 1;
  }

  async function pushStateToSocket(login, socket, room) {
    // readableEnded: the remote peer sent FIN (is closing). Writing back would
    // leave data in their paused-mode buffer and prevent their 'close' from
    // firing — see test-hang post-mortem in context.txt.
    if (socket.destroyed || socket.readableEnded) return;
    let players = 0, web = false, mic = false;
    if (room) {
      try {
        const rooms = await roomService.listRooms([room]);
        if (rooms.length > 0) {
          const participants = await roomService.listParticipants(room);
          players = participants.length;
          const me = participants.find(p => p.identity === login);
          if (me) {
            web = true;
            const audioTrack = (me.tracks || []).find(t => t.type === TrackType.AUDIO);
            mic = audioTrack ? !audioTrack.muted : false;
          }
        }
      } catch { return; }
    }
    try { socket.write(JSON.stringify({ type: 'state', players, web, mic }) + '\n'); } catch {}
  }

  const statePushTimer = setInterval(() => {
    for (const [login, { socket, room }] of tcpSocketsByLogin) {
      pushStateToSocket(login, socket, room).catch(() => {});
    }
  }, statePushIntervalMs).unref();

  // --- Observability, admin page only -----------------------------------
  // None of what follows feeds the voice path: every read is wrapped so a
  // failure here can only make the admin page emptier, never drop a player.

  // A login that reconnects eight times in five minutes is the actual problem
  // of the evening, but in a flat event feed it looks like eight ordinary
  // lines. Counted per login over a rolling window so it can be ranked.
  const RECONNECT_WINDOW_MS = 10 * 60 * 1000;
  const RECONNECT_LOGINS_MAX = 500;
  const reconnects = new Map(); // login → { plugin: [ts], browser: [ts] }

  function noteReconnect(kind, login) {
    const now = Date.now();
    let e = reconnects.get(login);
    if (!e) {
      e = { plugin: [], browser: [] };
      // Bounded like browserRooms: this is fed by unauthenticated connects.
      if (reconnects.size >= RECONNECT_LOGINS_MAX) {
        const oldest = reconnects.keys().next().value;
        reconnects.delete(oldest);
      }
      reconnects.set(login, e);
    }
    e[kind].push(now);
    if (e[kind].length > 100) e[kind].splice(0, e[kind].length - 100);
  }

  function reconnectRows() {
    const cutoff = Date.now() - RECONNECT_WINDOW_MS;
    const rows = [];
    for (const [login, e] of reconnects) {
      const plugin = e.plugin.filter((t) => t >= cutoff).length;
      const browser = e.browser.filter((t) => t >= cutoff).length;
      if (plugin + browser === 0) { reconnects.delete(login); continue; }
      rows.push({ login, plugin, browser, total: plugin + browser });
    }
    // Only the noisy ones are worth screen space; one reconnect is just a join.
    return rows.filter((r) => r.total >= 2).sort((a, b) => b.total - a.total).slice(0, 10);
  }

  function countsNow() {
    const inTab = new Set(browserSockets.keys());
    let paired = 0;
    for (const login of tcpSocketsByLogin.keys()) if (inTab.has(login)) paired++;
    return {
      plugins: tcpSocketsByLogin.size,
      browsers: browserSockets.size,
      paired,
      pluginOnly: tcpSocketsByLogin.size - paired,
      browserOnly: browserSockets.size - paired,
      nonces: nonces.size,
    };
  }

  // "It dropped — when?" is unanswerable from a live snapshot. 10 s samples
  // over 10 minutes, kept server-side so a page reload does not lose the dip.
  const HISTORY_INTERVAL_MS = 10_000;
  const HISTORY_MAX = 60;
  const history = [];
  function sampleHistory() {
    const c = countsNow();
    history.push({ t: Date.now(), paired: c.paired, plugins: c.plugins, browsers: c.browsers });
    if (history.length > HISTORY_MAX) history.shift();
  }
  const historyTimer = setInterval(sampleHistory, HISTORY_INTERVAL_MS).unref();

  // What the relay believes vs what LiveKit actually holds. The gap is where
  // ghosts live: a tab killed mid-session can leave a participant behind that
  // still occupies the login, and nothing in the relay's own state shows it.
  // Cached because the admin page polls every 2 s and this is a network call.
  const LIVEKIT_CACHE_MS = 5000;
  let livekitCache = { at: 0, value: null, pending: null };

  async function livekitSnapshot() {
    if (Date.now() - livekitCache.at < LIVEKIT_CACHE_MS && livekitCache.value) {
      return livekitCache.value;
    }
    if (livekitCache.pending) return livekitCache.pending;
    livekitCache.pending = (async () => {
      try {
        const rooms = await roomService.listRooms();
        const byRoom = new Map();
        for (const r of rooms) {
          let identities = [];
          try {
            identities = (await roomService.listParticipants(r.name)).map((p) => p.identity);
          } catch { /* room vanished between the two calls */ }
          byRoom.set(r.name, identities.sort());
        }
        return { ok: true, byRoom };
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err).slice(0, 200), byRoom: new Map() };
      }
    })();
    try {
      const value = await livekitCache.pending;
      livekitCache = { at: Date.now(), value, pending: null };
      return value;
    } finally {
      livekitCache.pending = null;
    }
  }

  // Rate-limiting: a handful of token requests per join is normal, dozens per
  // second is a scripted attack. Ingestion is per-connection since positions
  // are unauthenticated (per socket, not per login, since the login itself
  // isn't verified yet).
  const tokenLimiter = createRateLimiter({ windowMs: 60_000, max: 30 }); // per IP
  // Lets the plugin exchange the permanent community secret for a
  // short-lived, single-use token over HTTPS (same host as S_VoipUrl,
  // already behind a real TLS cert via Caddy in production) instead of
  // writing the permanent secret in cleartext onto the raw TCP port (8081,
  // no TLS support). The token is what actually travels over that plaintext
  // socket; sniffing it only yields a value that's useless after one
  // connection and expires in seconds either way.
  const tcpAuthTokens = new Map(); // token → expiry
  const TCP_AUTH_TOKEN_TTL_MS = 30_000;
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of tcpAuthTokens) if (v < now) tcpAuthTokens.delete(k);
  }, 30_000).unref();
  const tcpAuthLimiter = createRateLimiter({ windowMs: 60_000, max: 20 }); // per IP
  const TCP_MAX_MSG_PER_SEC = 30;
  const WS_MAX_MSG_PER_SEC = 30;
  const TCP_IDLE_TIMEOUT_MS = tcpIdleTimeoutMs;
  const TCP_MAX_CONNECTIONS = tcpMaxConnections;
  let tcpConnectionCount = 0;

  const app = express();
  // Real deploy always puts Caddy in front on the same host (see
  // deploy/Caddyfile) — trusting only loopback means req.ip resolves to the
  // client's real IP from X-Forwarded-For instead of always being Caddy's
  // own address, which would otherwise make every per-IP rate limiter below
  // (token, tcp-auth) count all callers as one shared budget.
  app.set('trust proxy', 'loopback');
  if (!enableCalibrationBot) {
    // bot.html lets anyone publish a fake "CalibBot" audio track into the
    // shared room; it's a solo-testing tool, not something to expose
    // publicly. Gated behind ENABLE_CALIBRATION_BOT instead of deleted so
    // it's still available for calibration on a dev/staging deploy.
    app.use((req, res, next) => {
      if (req.path === '/bot.html' || req.path === '/bot.js') {
        res.status(404).end();
        return;
      }
      next();
    });
  }
  app.use(express.static(staticDir));

  // The page has to know whether debug is allowed BEFORE it decides what to
  // render, so this is a tiny classic <script> in the head rather than a JSON
  // endpoint: it is fetched and executed before the inline bootstrap runs, and
  // there is no window where the debug panel flashes into view.
  app.get('/config.js', (req, res) => {
    res.type('application/javascript');
    // no-store: this answer flips when the operator flips the env var, and a
    // page cached from the debug era must not keep believing debug is allowed.
    res.set('Cache-Control', 'no-store');
    res.send(`window.ONZ_DEBUG_ALLOWED=${debugEnabled ? 'true' : 'false'};\n`);
  });

  app.get('/health', async (req, res) => {
    // Audit #37: this used to be a static 200 that only proved the Node
    // process was up, not that it could actually reach LiveKit — the one
    // dependency every other route needs. Reuses the same listRooms() call
    // already used to gate broadcasts, so it's exercising a real code path.
    try {
      await roomService.listRooms([roomName]);
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(503).json({ status: 'error', error: 'livekit unreachable' });
    }
  });

  // Player-facing self-test, feeding public/check.html. No password: every
  // fact here is either public (is the relay up) or already held by the
  // caller (their own nonce). Without a valid ?t= it says nothing at all
  // about who is connected, so it is not a roster in disguise.
  const checkLimiter = createRateLimiter({ windowMs: 60_000, max: 30 }); // per IP
  // Served at the bare path too: the link goes to players in a Discord
  // message, and "/check" is what someone types from memory when the vocal
  // is not working. express.static only maps /check.html.
  app.get('/check', (req, res) => {
    res.sendFile(path.resolve(staticDir, 'check.html'));
  });

  app.get('/check.json', async (req, res) => {
    if (!checkLimiter.allow(req.ip)) {
      res.status(429).json({ error: 'too many requests' });
      return;
    }
    // The whole point is a fresh answer; a cached one would tell a player
    // their plugin is fine minutes after it dropped.
    res.set('Cache-Control', 'no-store');
    let livekit = false;
    try {
      await roomService.listRooms([roomName]);
      livekit = true;
    } catch {}
    const out = { relay: true, livekit, plugin: { checked: false } };
    const t = String(req.query.t || '').trim();
    if (t) {
      // Peek, never consume. The same nonce still has to work for the real
      // join a few seconds later: a diagnostic that breaks the thing it is
      // diagnosing is worse than no diagnostic at all.
      const entry = nonces.get(t);
      if (!entry || entry.expiry < Date.now()) {
        out.plugin = { checked: true, ok: false, reason: entry ? 'expired' : 'unknown' };
      } else {
        const conn = tcpSocketsByLogin.get(entry.login);
        out.plugin = {
          checked: true,
          ok: true,
          login: entry.login,
          serverName: displayNameFor(entry.server, entry.serverName) || null,
          version: conn ? conn.version : null,
          // A valid nonce only proves the plugin was talking when it minted
          // one. This says whether it still is, which is the failure a player
          // actually hits: game closed, or the TCP socket dropped.
          connected: !!(conn && !conn.socket.destroyed),
          expiresInMs: Math.max(0, entry.expiry - Date.now()),
        };
      }
    }
    res.json(out);
  });

  app.get('/token', async (req, res) => {
    if (!tokenLimiter.allow(req.ip)) {
      res.status(429).json({ error: 'too many requests' });
      return;
    }
    // --- Token derived from a one-time nonce (normal player path) ---
    const t = String(req.query.t || '').trim();
    if (t) {
      const entry = nonces.get(t);
      if (!entry || entry.expiry < Date.now()) {
        // The single most likely thing a tester will hit: a link opened twice,
        // or opened long after the game handed it out. Worth a line so a "it
        // says expired" report can be matched to a moment.
        eventLog.log('voice.linkRejected', { reason: entry ? 'expired' : 'unknown', ip: req.ip });
        res.status(401).json({ error: 'invalid or expired nonce' });
        return;
      }
      nonces.delete(t); // single-use
      // Single-use also means the URL the plugin is showing in game is dead the
      // instant this runs, and the plugin would keep showing it until its own
      // 9-minute refresh — so leaving and reopening the link said "expired"
      // even though the game looked like it had just handed out a fresh one.
      // Telling it here makes it mint another within a tick.
      const pluginConn = tcpSocketsByLogin.get(entry.login);
      if (pluginConn && !pluginConn.socket.destroyed) {
        try { pluginConn.socket.write('{"type":"nonceUsed"}\n'); } catch {}
      }
      const room = entry.server
        ? (roomNameFor(entry.server, entry.serverName) ?? roomName)
        : roomName;
      const at = new AccessToken(apiKey, apiSecret, { identity: entry.login });
      // canPublishData is what lets a browser announce its own avatar to the
      // room (topic 'avatar'). It used to be false because positions came from
      // the relay alone and nothing in a browser had anything to say.
      //
      // Granting it means a participant can now put ANY packet on the room's
      // data channel, including one claiming to be a position update - and
      // positions drive the audio gain, so a forged one is a way to be heard
      // from across the map. What keeps that shut is on the receiving side:
      // the relay speaks through the server API, so its packets arrive with no
      // participant attached, and the client drops any 'position' packet that
      // HAS one. See the DataReceived handler in public/app.js.
      at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
      const token = await at.toJwt();
      // Return login + human-readable server name so the browser can skip the
      // identity form and show which server you're on.
      const serverName = displayNameFor(entry.server, entry.serverName);
      rememberBrowserRoom(entry.login, room);
      eventLog.log('voice.join', { login: entry.login, room, serverName });
      res.json({ token, wsUrl: liveKitPublicWsUrl, room, login: entry.login, serverName });
      return;
    }

    // --- Manual path: caller-supplied identity, for bot.html and debugging ---
    // Unauthenticated by construction: the identity comes straight from the
    // query string, so on a public relay this lets anyone join under any name
    // they like. Real players never come through here — they arrive with a
    // nonce, handled above. 404 rather than 403 so it looks like an endpoint
    // that simply isn't there, matching the bot.html gate.
    if (!enableCalibrationBot && !debugEnabled) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const identity = String(req.query.identity || '').trim();
    if (!identity) {
      res.status(400).json({ error: 'missing identity query param' });
      return;
    }
    // The room override is the sharpest edge in the whole file: it mints a
    // publish-capable token for a room the caller names. It rides on DEBUG_MODE
    // alone and never on ENABLE_CALIBRATION_BOT, so enabling the calibration
    // tool cannot drag it along — the bot only ever needs the default room.
    // Anything unparseable falls back to the default room instead of erroring:
    // a debug-only field is not worth a failure mode.
    let room = roomName;
    if (debugEnabled) {
      const requested = validateServer(req.query.room);
      if (requested) room = requested;
    }
    const at = new AccessToken(apiKey, apiSecret, { identity });
    // Same grant as the nonce path above, for the same reason (avatars), with
    // the same receiving-side guard. See the comment there.
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
    const token = await at.toJwt();
    rememberBrowserRoom(identity, room);
    res.json({ token, wsUrl: liveKitPublicWsUrl, room });
  });

  // POST { secret } over HTTPS, get back a one-time token good for a single
  // TCP connection. 404s when no secret is
  // configured at all, so it doesn't leak whether this relay has the
  // feature enabled to an unauthenticated prober.
  app.post('/tcp-auth', express.json(), (req, res) => {
    if (!tcpSharedSecret) {
      res.status(404).json({ error: 'not configured' });
      return;
    }
    if (!tcpAuthLimiter.allow(req.ip)) {
      res.status(429).json({ error: 'too many requests' });
      return;
    }
    const secret = typeof req.body?.secret === 'string' ? req.body.secret : '';
    if (secret !== tcpSharedSecret) {
      res.status(401).json({ error: 'invalid secret' });
      return;
    }
    const token = crypto.randomBytes(16).toString('hex');
    tcpAuthTokens.set(token, Date.now() + TCP_AUTH_TOKEN_TTL_MS);
    res.json({ token });
  });

  // --- Problem reports (web client "Signaler un problème") ---------------
  // Kept in memory only, newest last. They are also written to the event log,
  // which is the durable copy; this ring exists so the admin page can show
  // them without reading the file.
  const reports = [];
  const REPORTS_MAX = 100;
  const reportLimiter = createRateLimiter(reportRateLimit); // per IP

  app.post('/report', express.json({ limit: '16kb' }), (req, res) => {
    if (!reportLimiter.allow(req.ip)) {
      res.status(429).json({ error: 'too many requests' });
      return;
    }
    // Everything here is self-declared by the browser and none of it is
    // trusted: a report is a human note, not a fact about the relay. Cross-read
    // it against the plugin.* lines for the same login, which the relay wrote
    // itself. Fields are clamped so a report cannot be used to stuff the log.
    const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const report = {
      ts: new Date().toISOString(),
      message: str(req.body?.message, 1000),
      login: validateLogin(req.body?.login) ?? null,
      room: str(req.body?.room, 128) || null,
      state: str(req.body?.state, 500) || null,
      userAgent: str(req.headers['user-agent'], 200) || null,
    };
    if (!report.message) {
      res.status(400).json({ error: 'empty report' });
      return;
    }
    // The tab has no way of knowing which plugin build the player is running,
    // so the version is read off that login's live plugin connection — a fact
    // the relay recorded itself — rather than asked of the browser. "the
    // version is wrong" is the single likeliest cause of a report, which makes
    // it the one field that must not be self-declared.
    report.version = (report.login && tcpSocketsByLogin.get(report.login)?.version) || null;
    reports.push(report);
    if (reports.length > REPORTS_MAX) reports.shift();
    eventLog.log('report', report);
    res.json({ ok: true });
  });

  // --- Admin ------------------------------------------------------------
  // Not configured means not present: with no credentials set, both routes
  // 404 exactly like an unknown path. The alternative people reach for — a
  // hard-to-guess URL — is not access control, it is a password that gets
  // copied into Discord, logged by every proxy in between, and never rotated.
  const adminConfigured = adminUser !== '' && adminPassword !== '';

  // Every other public route is rate limited; this one was not, so a stranger
  // could try passwords as fast as the network allowed. Only *failed* attempts
  // are charged: the admin page polls /admin/state.json every 2 s with valid
  // credentials, and counting those would lock the admin out of their own page
  // within the first minute.
  const adminAuthLimiter = createRateLimiter({ windowMs: 60_000, max: 10 }); // per IP

  function adminAuthOk(req) {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Basic ')) return false;
    let decoded;
    try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); }
    catch { return false; }
    const sep = decoded.indexOf(':');
    if (sep === -1) return false;
    // timingSafeEqual throws on a length mismatch, so both sides are hashed to
    // a fixed width first — that also stops the comparison from leaking the
    // credentials' length, which a plain length check would.
    const digest = (s) => crypto.createHash('sha256').update(s).digest();
    const okUser = crypto.timingSafeEqual(digest(decoded.slice(0, sep)), digest(adminUser));
    const okPass = crypto.timingSafeEqual(digest(decoded.slice(sep + 1)), digest(adminPassword));
    return okUser && okPass;
  }

  function requireAdmin(req, res) {
    if (!adminConfigured) {
      res.status(404).json({ error: 'not found' });
      return false;
    }
    if (!adminAuthOk(req)) {
      // Wrong credentials that were actually sent are a guess. Past the budget
      // the answer stops being a challenge: a 401 with WWW-Authenticate invites
      // the next try, a 429 without it just costs the guesser a minute per ten.
      if ((req.headers.authorization ?? '') !== '' && !adminAuthLimiter.allow(req.ip)) {
        eventLog.log('admin.throttled', { ip: req.ip });
        res.status(429).json({ error: 'too many requests' });
        return false;
      }
      res.set('WWW-Authenticate', 'Basic realm="OnZVoIP admin", charset="UTF-8"');
      // Only credentials that were sent AND wrong are worth a line. Every
      // browser opens the page with no Authorization header, waits for the
      // challenge and then retries — logging that would put an admin.denied
      // next to each of the admin's own visits, and drown the one case the
      // line exists for: somebody guessing.
      if ((req.headers.authorization ?? '') !== '') {
        eventLog.log('admin.denied', { ip: req.ip });
      }
      res.status(401).json({ error: 'unauthorized' });
      return false;
    }
    return true;
  }

  app.get('/admin/state.json', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const now = Date.now();
    const plugins = Array.from(tcpSocketsByLogin, ([login, e]) => ({
      login,
      room: e.room,
      // Stripped, like every other place a server name is shown: a live server
      // sends it with its colour codes ("$00F$W$OLOLMAPS$FFF"), and the admin
      // page is where you read names quickly to match a player to a report.
      serverName: e.serverName ? (stripTmFormatting(e.serverName).trim() || null) : null,
      version: e.version ?? null,
      connectedSeconds: e.connectedAt ? Math.round((now - e.connectedAt) / 1000) : null,
      // null means "connected but has never sent a position" — the signature
      // of a player sitting in a menu, which looks identical to a working
      // player if you only count sockets.
      positionAgeSeconds: e.lastPositionAt ? Math.round((now - e.lastPositionAt) / 1000) : null,
    })).sort((a, b) => a.login.localeCompare(b.login));

    const browsers = Array.from(browserSockets.keys())
      .map((login) => ({ login, room: browserRooms.get(login) ?? null }))
      .sort((a, b) => a.login.localeCompare(b.login));

    // The number that actually predicts whether voice works: a player needs
    // BOTH halves. Plugin-only means they never clicked, browser-only means
    // they left the game.
    const inGame = new Set(plugins.map((p) => p.login));
    const inTab = new Set(browsers.map((b) => b.login));
    const paired = [...inGame].filter((l) => inTab.has(l));

    // Flagged per row, not just counted: during the evening the question is
    // never "how many are unpaired" but "who", so the name can be called out.
    for (const p of plugins) p.paired = inTab.has(p.login);
    for (const b of browsers) b.paired = inGame.has(b.login);

    // Per room, because "12 players connected" hides the case that actually
    // ruins an evening: four rooms of three who each think voice is broken.
    const live = await livekitSnapshot();
    const roomsMap = new Map();
    const roomEntry = (room) => {
      if (!roomsMap.has(room)) {
        roomsMap.set(room, { room, serverName: null, players: [], livekit: null, ghosts: [], missing: [] });
      }
      return roomsMap.get(room);
    };
    for (const p of plugins) {
      if (!p.room) continue;
      const e = roomEntry(p.room);
      if (!e.serverName) e.serverName = p.serverName;
      e.players.push({ login: p.login, paired: p.paired, half: p.paired ? 'both' : 'plugin' });
    }
    for (const b of browsers) {
      if (!b.room || inGame.has(b.login)) continue;
      roomEntry(b.room).players.push({ login: b.login, paired: false, half: 'browser' });
    }
    for (const [room, identities] of live.byRoom) {
      // A LiveKit room with nobody in it is normal housekeeping, not a room.
      if (identities.length === 0 && !roomsMap.has(room)) continue;
      roomEntry(room).livekit = identities.length;
    }
    for (const e of roomsMap.values()) {
      const identities = live.byRoom.get(e.room);
      if (identities) {
        const known = new Set(browsers.filter((b) => b.room === e.room).map((b) => b.login));
        // In LiveKit but not in our books: usually a tab closed the hard way,
        // still holding the login. Missing is the mirror case.
        e.ghosts = identities.filter((id) => !known.has(id));
        e.missing = [...known].filter((l) => !identities.includes(l));
      }
      e.players.sort((a, b) => a.login.localeCompare(b.login));
    }
    const rooms = [...roomsMap.values()]
      .sort((a, b) => b.players.length - a.players.length || a.room.localeCompare(b.room));

    res.json({
      now: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      debugMode: debugEnabled,
      // Lets the Liens tab hide the calibration bot link when the relay does
      // not serve it — a listed URL that 404s reads as a broken deploy.
      calibrationBot: enableCalibrationBot,
      teams: teamsPayload(),
      // Drives which buttons the page draws at all: a control that cannot work
      // should not be on screen looking like it could.
      actions: { enabled: adminActions, testBots: enableTestBots, autoKick, bots: botClients.size, botMax: BOT_MAX },
      livekitOk: live.ok,
      livekitError: live.ok ? null : live.error,
      rooms,
      history,
      reconnects: reconnectRows(),
      counts: {
        plugins: plugins.length,
        browsers: browsers.length,
        paired: paired.length,
        pluginOnly: plugins.length - paired.length,
        browserOnly: browsers.length - paired.length,
        nonces: nonces.size,
      },
      plugins,
      browsers,
      reports: reports.slice(-20).reverse(),
      events: eventLog.tail(120).reverse(),
    });
  });

  app.get('/admin', (req, res) => {
    if (!requireAdmin(req, res)) return;
    // Deliberately NOT in public/: anything under staticDir is served to
    // anyone, and a page whose whole job is to display logins should not be
    // one typo away from being public even if it is useless without the JSON.
    res.sendFile(ADMIN_HTML);
  });

  // The admin feed only keeps the last few hundred lines in memory, and they
  // vanish on restart. This hands over the whole file while the evening is
  // still running, so a post-mortem does not depend on SSH access.
  app.get('/admin/events.log', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const file = eventLog.file;
    if (!file) { res.status(404).json({ error: 'no log file' }); return; }
    res.download(file, 'onzvoip-events.log', (err) => {
      if (err && !res.headersSent) res.status(500).json({ error: 'log unavailable' });
    });
  });

  // ---------------------------------------------------------------------
  // Admin actions. Everything above this point is read-only — the page just
  // displays. What follows deliberately breaks that invariant, which is why
  // it is dead code unless ADMIN_ACTIONS=true was set at boot.
  // ---------------------------------------------------------------------

  const BOT_MAX = 40;
  const BOT_SERVER = 'onzbots';
  const BOT_SERVER_NAME = 'OnZ Test Bots';
  const botClients = new Map(); // login → { socket, timer }
  let autoKick = false;

  function stopBot(login) {
    const b = botClients.get(login);
    if (!b) return;
    botClients.delete(login);
    clearInterval(b.timer);
    try { b.socket.destroy(); } catch {}
  }

  function stopAllBots() {
    for (const login of [...botClients.keys()]) stopBot(login);
  }

  // A bot is a plugin, not a browser: it speaks the same TCP protocol on the
  // same port as the real game, so it exercises the actual ingest path rather
  // than a shortcut past it. It has no voice — pairing it needs a real tab.
  function startBot(login, index) {
    const socket = net.createConnection({ host: '127.0.0.1', port: ingestTcpPort });
    const entry = { socket, timer: null };
    botClients.set(login, entry);
    const send = (obj) => { try { socket.write(JSON.stringify(obj) + '\n'); } catch {} };
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      if (tcpSharedSecret) send({ type: 'auth', secret: tcpSharedSecret });
      send({ type: 'nonce', nonce: `bot-${login}-${Date.now()}`, login,
             server: BOT_SERVER, serverName: BOT_SERVER_NAME, version: 'bot' });
      // Circle of 60 m, one bot per slice: they spread out instead of piling
      // on the same point, so the radar and the distance maths get real work.
      let angle = (index / BOT_MAX) * Math.PI * 2;
      entry.timer = setInterval(() => {
        angle += 0.05;
        send({ type: 'position', pseudo: login,
               x: Math.cos(angle) * 60, y: 0, z: Math.sin(angle) * 60,
               fx: -Math.sin(angle), fz: Math.cos(angle) });
      }, 200).unref();
    });
    socket.on('error', () => stopBot(login));
    socket.on('close', () => { if (botClients.get(login) === entry) stopBot(login); });
  }

  function setBotCount(n) {
    const target = Math.max(0, Math.min(BOT_MAX, Math.floor(n)));
    const current = botClients.size;
    if (target < current) {
      for (const login of [...botClients.keys()].slice(target)) stopBot(login);
    } else {
      for (let i = current; i < target; i++) {
        startBot(`bot${String(i + 1).padStart(2, '0')}`, i);
      }
    }
    return botClients.size;
  }

  // Ghosts are identities LiveKit still holds for players the relay no longer
  // knows. They cost a slot and they show up in everyone's radar. Removing one
  // is safe (the client reconnects if it is actually alive), but only once it
  // has been a ghost for two consecutive sweeps — a browser that reconnects
  // between two polls would otherwise get kicked for existing.
  const ghostStreak = new Map(); // `${room} ${identity}` → sweeps seen
  async function sweepGhosts() {
    if (!autoKick || !roomService) return;
    const live = await livekitSnapshot();
    if (!live.ok) return;
    const seen = new Set();
    for (const [room, identities] of live.byRoom) {
      for (const identity of identities) {
        if (browserSockets.has(identity)) continue;
        const key = `${room} ${identity}`;
        seen.add(key);
        const n = (ghostStreak.get(key) ?? 0) + 1;
        ghostStreak.set(key, n);
        if (n < 2) continue;
        ghostStreak.delete(key);
        try {
          await roomService.removeParticipant(room, identity);
          eventLog.log('admin.autokick', { room, identity });
        } catch (err) {
          eventLog.log('admin.autokickFailed', { room, identity, error: err.message });
        }
      }
    }
    for (const key of [...ghostStreak.keys()]) if (!seen.has(key)) ghostStreak.delete(key);
  }
  const ghostSweepTimer = setInterval(() => { sweepGhosts().catch(() => {}); }, 20_000).unref();

  function requireActions(req, res) {
    if (!requireAdmin(req, res)) return false;
    if (!adminActions) {
      res.status(404).json({ error: 'not found' });
      return false;
    }
    return true;
  }

  app.post('/admin/actions/debug', express.json(), (req, res) => {
    if (!requireActions(req, res)) return;
    debugEnabled = req.body?.on === true;
    eventLog.log('admin.action', { action: 'debug', on: debugEnabled, ip: req.ip });
    res.json({ ok: true, debugMode: debugEnabled });
  });

  app.post('/admin/actions/autokick', express.json(), (req, res) => {
    if (!requireActions(req, res)) return;
    autoKick = req.body?.on === true;
    if (!autoKick) ghostStreak.clear();
    eventLog.log('admin.action', { action: 'autokick', on: autoKick, ip: req.ip });
    res.json({ ok: true, autoKick });
  });

  app.post('/admin/actions/kick', express.json(), async (req, res) => {
    if (!requireActions(req, res)) return;
    const room = String(req.body?.room ?? '').trim();
    const identity = String(req.body?.identity ?? '').trim();
    if (!room || !identity) { res.status(400).json({ error: 'room and identity required' }); return; }
    try {
      await roomService.removeParticipant(room, identity);
      eventLog.log('admin.action', { action: 'kick', room, identity, ip: req.ip });
      res.json({ ok: true });
    } catch (err) {
      eventLog.log('admin.actionFailed', { action: 'kick', room, identity, error: err.message });
      res.status(502).json({ error: err.message });
    }
  });

  app.post('/admin/actions/bots', express.json(), (req, res) => {
    if (!requireActions(req, res)) return;
    if (!enableTestBots) { res.status(404).json({ error: 'test bots disabled' }); return; }
    const count = Number(req.body?.count);
    if (!isFinite(count)) { res.status(400).json({ error: 'count required' }); return; }
    const now = setBotCount(count);
    eventLog.log('admin.action', { action: 'bots', count: now, ip: req.ip });
    res.json({ ok: true, bots: now, max: BOT_MAX });
  });

  app.post('/admin/actions/teams', express.json(), (req, res) => {
    if (!requireActions(req, res)) return;
    const op = String(req.body?.op ?? '');
    const fail = (msg) => { res.status(400).json({ error: msg }); return false; };

    if (op === 'create') {
      if (teams.size >= TEAM_MAX) return void fail('too many teams');
      const id = String(nextTeamId++);
      const name = String(req.body?.name ?? '').trim().slice(0, 32) || `Equipe ${id}`;
      // Colour by position in the list, so two teams created back to back never
      // land on the same one while there are unused colours left.
      teams.set(id, { id, name, color: TEAM_COLORS[teams.size % TEAM_COLORS.length], voice: true });
    } else if (op === 'remove') {
      const id = String(req.body?.id ?? '');
      if (!teams.delete(id)) return void fail('unknown team');
      for (const [login, tid] of teamByLogin) if (tid === id) teamByLogin.delete(login);
    } else if (op === 'assign') {
      const login = validateLogin(req.body?.login);
      if (!login) return void fail('bad login');
      const raw = req.body?.id;
      if (raw == null || raw === '') teamByLogin.delete(login);
      else if (teams.has(String(raw))) teamByLogin.set(login, String(raw));
      else return void fail('unknown team');
    } else if (op === 'voice') {
      const team = teams.get(String(req.body?.id ?? ''));
      if (!team) return void fail('unknown team');
      team.voice = req.body?.on === true;
    } else if (op === 'auto') {
      const count = Number(req.body?.count);
      if (!isFinite(count) || count < 2 || count > TEAM_MAX) return void fail('count must be 2..' + TEAM_MAX);
      teams.clear();
      teamByLogin.clear();
      const ids = [];
      for (let i = 0; i < count; i++) {
        const id = String(nextTeamId++);
        ids.push(id);
        teams.set(id, { id, name: `Equipe ${i + 1}`, color: TEAM_COLORS[i % TEAM_COLORS.length], voice: true });
      }
      // Splits whoever has a plugin connected right now. Sorted so the same set
      // of players always produces the same split — a re-run after a misclick
      // does not shuffle everyone into new teams.
      const logins = Array.from(tcpSocketsByLogin.keys()).sort();
      logins.forEach((login, i) => teamByLogin.set(login, ids[i % ids.length]));
    } else if (op === 'clear') {
      teams.clear();
      teamByLogin.clear();
    } else {
      return void fail('unknown op');
    }

    eventLog.log('admin.action', { action: 'teams', op, ip: req.ip });
    broadcastTeams();
    res.json({ ok: true, ...teamsPayload() });
  });

  const server = http.createServer(app);

  function broadcastPosition(msg, fallbackRoom) {
    if (msg.type !== 'position') return;
    const { pseudo } = msg;
    if (typeof pseudo !== 'string' || pseudo.length === 0 || pseudo.length > 64) return;
    const x = Number(msg.x), y = Number(msg.y), z = Number(msg.z);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return;
    if (Math.abs(x) >= 1e6 || Math.abs(y) >= 1e6 || Math.abs(z) >= 1e6) return;

    // Route to the server-specific room.
    // Without a server field, fall back to the room the sender's own token was
    // issued for (browsers publishing their own position — see browserRooms),
    // then to the default roomName (older plugin versions, simulate-positions.js).
    // The room is derived from the server the sender says it is on, never
    // taken as a raw room id from the message: a caller-supplied room would
    // let anyone inject positions into an arbitrary community's room.
    const serverLogin = validateServer(msg.server);
    const targetRoom = serverLogin
      ? (roomNameFor(serverLogin, msg.serverName) ?? roomName)
      : (fallbackRoom ?? roomName);

    let posMap = pendingPositions.get(targetRoom);
    if (!posMap) {
      posMap = new Map();
      pendingPositions.set(targetRoom, posMap);
    }
    // Heading, optional. Only the OpenPlanet plugin has one — a browser
    // publishing its own dragged position has no car and sends none, and older
    // plugin builds predate the field, so its absence is a normal state and not
    // a reason to drop the position. Two components of a direction vector
    // rather than an angle, so neither end has to agree on where zero points.
    // A zero-length pair carries no direction at all, so it is treated as
    // absent rather than forwarded for the client to puzzle over.
    const fx = Number(msg.fx), fz = Number(msg.fz);
    // Stamped on the connection record rather than in a map of its own so it
    // cannot grow: a pseudo nobody has an open plugin socket for simply never
    // gets a timestamp. It is what separates "connected" from "actually
    // sending" on the admin page — a plugin stuck on a menu keeps its socket.
    const conn = tcpSocketsByLogin.get(pseudo);
    if (conn) conn.lastPositionAt = Date.now();

    const entry = { x, y, z, ts: Date.now() };
    if (isFinite(fx) && isFinite(fz) && (fx !== 0 || fz !== 0)
        && Math.abs(fx) < 1e3 && Math.abs(fz) < 1e3) {
      entry.fx = fx;
      entry.fz = fz;
    }
    posMap.set(pseudo, entry);

    let knownMap = knownPositions.get(targetRoom);
    if (!knownMap) {
      knownMap = new Map();
      knownPositions.set(targetRoom, knownMap);
    }
    knownMap.set(pseudo, entry);
  }

  // `sender` describes the ingest connection the message came in on:
  // { kind: 'tcp', socket } or { kind: 'ws', ws }. Omitted by internal callers,
  // which are trusted and skip the ownership checks.
  // Returns false only when the message was refused as somebody else's login,
  // which the TCP handler needs to know so a refused nonce does not go on to
  // claim that login anyway. Every other outcome — including a malformed nonce
  // — returns true: those were already tolerated before this check existed,
  // and an old plugin with a short nonce string must keep connecting.
  function handleMessage(msg, fallbackRoom, sender) {
    if (msg.type === 'nonce') {
      // Plugin registers a nonce so the browser can later call /token?t=
      const nonce = String(msg.nonce ?? '').trim();
      if (nonce.length < 4 || nonce.length > 64) return true;
      const login = validateLogin(msg.login);
      if (!login) return true;
      // A nonce moves its login to another voice room. Coming from anywhere but
      // that player's own connection, it is someone kicking them out of their
      // team's room, so it is dropped.
      if (ownedBySomeoneElse(login, sender)) {
        claimRejected(login, 'nonce', sender?.kind);
        return false;
      }
      const server = validateServer(msg.server) ?? '';
      const serverName = typeof msg.serverName === 'string'
        ? msg.serverName.slice(0, 256) : '';
      nonces.set(nonce, { login, server, serverName, expiry: Date.now() + NONCE_TTL_MS });

      // Push room change to the browser that owns this login. Includes the
      // nonce so the browser can call /token?t= for the new room.
      const ws = browserSockets.get(login);
      if (ws && ws.readyState === 1 /* WebSocket.OPEN */) {
        const targetRoom = server ? (roomNameFor(server, serverName) ?? roomName) : null;
        const push = targetRoom
          ? { type: 'room', name: targetRoom, nonce }
          : { type: 'room', name: null }; // player left the server
        try { ws.send(JSON.stringify(push)); } catch {}
      }
      return true;
    }
    // Same rule for positions: a pseudo already announced on this channel can
    // only be moved by the connection that announced it. Sending a position
    // never takes ownership — only a `nonce` does — so tools that publish
    // positions for logins nobody claims (simulate-positions.js, the test
    // bots) keep working.
    const pseudo = validateLogin(msg.pseudo);
    if (pseudo && ownedBySomeoneElse(pseudo, sender)) {
      claimRejected(pseudo, 'position', sender?.kind);
      return false;
    }
    broadcastPosition(msg, fallbackRoom);
    return true;
  }

  const wss = new WebSocketServer({ server, path: '/ingest' });
  wss.on('connection', (ws) => {
    let wsLogin = null;
    let wsMsgCount = 0;
    let wsWindowStart = Date.now();
    ws.on('message', (raw) => {
      const now = Date.now();
      if (now - wsWindowStart >= 1000) { wsWindowStart = now; wsMsgCount = 0; }
      if (++wsMsgCount > WS_MAX_MSG_PER_SEC) { ws.close(); return; }
      try {
        const msg = JSON.parse(raw.toString());
        // Browser identifies itself so the relay knows which WebSocket to push
        // room-change notifications to.
        if (msg.type === 'hello') {
          const login = validateLogin(msg.login);
          if (login) {
            if (wsLogin && browserSockets.get(wsLogin) === ws) browserSockets.delete(wsLogin);
            wsLogin = login;
            browserSockets.set(login, ws);
            browserSeen.set(login, Date.now());
            noteReconnect('browser', login);
            eventLog.log('browser.connect', { login, room: browserRooms.get(login) ?? null });
            // Current teams straight away: a browser that joins mid-event would
            // otherwise draw grey dots until the next admin change. Skipped when
            // there are none, so an evening without teams puts no message on the
            // socket at all.
            if (teams.size) { try { ws.send(JSON.stringify(teamsPayload())); } catch {} }
          }
          return;
        }
        handleMessage(msg, wsLogin ? browserRooms.get(wsLogin) : undefined, { kind: 'ws', ws });
      } catch {}
    });
    ws.on('close', () => {
      if (wsLogin && browserSockets.get(wsLogin) === ws) {
        browserSockets.delete(wsLogin);
        // The tab closing is the most common "it stopped working" cause and the
        // one testers are least likely to report, so it gets its own line.
        eventLog.log('browser.disconnect', { login: wsLogin });
      }
    });
    ws.on('error', (err) => console.error('WS ingest: socket error:', err.message));
  });

  const tcpServer = net.createServer((socket) => {
    if (tcpConnectionCount >= TCP_MAX_CONNECTIONS) { socket.destroy(); return; }
    tcpConnectionCount++;

    let buffer = '';
    let tcpMsgCount = 0;
    let tcpWindowStart = Date.now();
    // No secret configured → nothing to check, same behavior as before this
    // feature existed (local dev / tests keep working unchanged).
    let authenticated = !tcpSharedSecret;
    let tcpLogin = null; // login associated with this socket, for state push-back
    let tcpRoom = null;  // current room for this socket
    socket.setEncoding('utf8');
    socket.setTimeout(TCP_IDLE_TIMEOUT_MS);
    socket.on('timeout', () => socket.destroy());
    socket.on('close', () => {
      tcpConnectionCount--;
      if (tcpLogin && tcpSocketsByLogin.get(tcpLogin)?.socket === socket) {
        const entry = tcpSocketsByLogin.get(tcpLogin);
        tcpSocketsByLogin.delete(tcpLogin);
        // Sockets that never sent a valid nonce have no login and are not
        // logged: port 8081 is open to the internet, so scanners would
        // otherwise be most of the file.
        eventLog.log('plugin.disconnect', {
          login: tcpLogin,
          room: entry.room,
          heldSeconds: Math.round((Date.now() - entry.connectedAt) / 1000),
        });
      }
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 4096) { socket.destroy(); return; }
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const now = Date.now();
        if (now - tcpWindowStart >= 1000) { tcpWindowStart = now; tcpMsgCount = 0; }
        if (++tcpMsgCount > TCP_MAX_MSG_PER_SEC) { socket.destroy(); return; }
        let msg;
        try { msg = JSON.parse(line); }
        catch (err) { console.error('TCP ingest: parse error:', err.message); continue; }
        // The first message on a gated connection must be a matching auth —
        // anything else (including a well-formed nonce/position sent without
        // one) closes the socket immediately. Accepts either a one-time token
        // from POST /tcp-auth (preferred) or the raw secret directly (legacy
        // path, kept for simulate-positions.js and older plugin builds that
        // never fetch a token).
        if (!authenticated) {
          // The raw-secret branch below has no per-attempt cost of its own
          // (unlike POST /tcp-auth, which is capped at 20/min/IP) — without
          // this, an attacker could open new TCP connections and guess the
          // shared secret directly, unrated. Shares tcpAuthLimiter's budget
          // with /tcp-auth since both are attempts to guess the same secret.
          if (msg.type !== 'auth' || !tcpAuthLimiter.allow(socket.remoteAddress)) {
            try { socket.write('{"type":"authError"}\n'); } catch {}
            socket.destroy();
            return;
          }
          if (typeof msg.token === 'string'
              && tcpAuthTokens.has(msg.token) && tcpAuthTokens.get(msg.token) >= Date.now()) {
            tcpAuthTokens.delete(msg.token); // single-use
            authenticated = true;
            continue; // a message right after auth in the same chunk (e.g. nonce) must still be processed below
          } else if (msg.secret === tcpSharedSecret) {
            authenticated = true;
            continue;
          } else {
            // Lets the plugin widget tell "wrong/missing secret" apart from a
            // generic network hiccup, instead of retrying blind forever.
            eventLog.log('plugin.authFailed', { ip: socket.remoteAddress });
            try { socket.write('{"type":"authError"}\n'); } catch {}
            socket.destroy();
            return;
          }
        }
        // Any traffic proves the connection is alive, which is what keeps its
        // login claim from being treated as stale leftovers.
        if (tcpLogin) {
          const held = tcpSocketsByLogin.get(tcpLogin);
          if (held && held.socket === socket) held.lastSeenAt = Date.now();
        }
        const accepted = handleMessage(msg, undefined, { kind: 'tcp', socket });
        // Associate this socket with the player's login after a valid
        // nonce so pushStateToSocket can write back over the same connection.
        // Only when the nonce was accepted: a nonce refused as someone else's
        // login must not take that login's entry either.
        if (msg.type === 'nonce' && accepted) {
          const login = validateLogin(msg.login);
          if (login) {
            // Read before the delete below: when the login is unchanged, that
            // delete targets this very entry, and reading after it would make
            // every nonce look like a brand-new connection.
            const prev = tcpSocketsByLogin.get(login);
            const sameSocket = prev !== undefined && prev.socket === socket;
            if (tcpLogin && tcpSocketsByLogin.get(tcpLogin)?.socket === socket) {
              tcpSocketsByLogin.delete(tcpLogin);
            }
            const srv = validateServer(msg.server) ?? '';
            const sName = typeof msg.serverName === 'string' ? msg.serverName.slice(0, 256) : '';
            tcpLogin = login;
            tcpRoom = srv ? (roomNameFor(srv, sName) ?? roomName) : null;
            // connectedAt is carried over while the same login stays on the same
            // socket: a room change re-sends the nonce, and resetting the clock
            // there would make every track change look like a reconnection on
            // the admin page, hiding the drops actually worth seeing.
            const version = validateVersion(msg.version) ?? (sameSocket ? prev.version : null);
            tcpSocketsByLogin.set(login, {
              socket,
              room: tcpRoom,
              version,
              serverName: sName || null,
              connectedAt: sameSocket ? prev.connectedAt : Date.now(),
              lastSeenAt: Date.now(),
            });
            // Two different events on purpose: "a player showed up" and "a
            // player changed server" answer different questions after the fact,
            // and collapsing them into one line makes the second invisible.
            if (!sameSocket) {
              noteReconnect('plugin', login);
              eventLog.log('plugin.connect', { login, room: tcpRoom, version, ip: socket.remoteAddress });
            } else if (prev.room !== tcpRoom) {
              eventLog.log('plugin.room', { login, from: prev.room, to: tcpRoom });
            }
            // setImmediate: defer to after the current poll phase so 'end'
            // fires first if the peer is already half-closing (tcpSend tests).
            // pushStateToSocket then sees readableEnded=true and skips the
            // write, preventing buffered-data from blocking 'close' on the test
            // socket. For the real plugin the socket stays open: no difference.
            setImmediate(() => pushStateToSocket(login, socket, tcpRoom).catch(() => {}));
          }
        }
      }
    });
    socket.on('error', (err) => console.error('TCP ingest: socket error:', err.message));
  });

  return { app, server, tcpServer, nonces, flushPositions, positionFlushTimer, statePushTimer,
           historyTimer, ghostSweepTimer, stopAllBots };
}
