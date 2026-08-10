// Relay server logic — extracted from index.js to be testable.
// createRelay() accepts an injected roomService so tests can pass a mock
// without touching a real LiveKit server.

import crypto from 'crypto';
import express from 'express';
import http from 'http';
import net from 'net';
import { WebSocketServer } from 'ws';
import { AccessToken } from 'livekit-server-sdk';
import { DataPacket_Kind, TrackType } from '@livekit/protocol';
import { roomNameFor, displayNameFor } from './room-name.js';

// One-time nonce store.
// nonce → { login, server, serverName, expiry }
// The plugin generates a nonce and sends it over TCP alongside login+server.
// The browser then uses GET /token?t=<nonce> to get a token already bound to
// the right room — no identity or room param needed from the user.
const nonces = new Map();
const NONCE_TTL_MS = 12 * 60 * 1000;

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
}) {
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

      const payload = JSON.stringify(positions);
      try {
        await roomService.sendData(room, encoder.encode(payload), DataPacket_Kind.LOSSY, {
          topic: 'position',
        });
      } catch (err) {
        console.error('sendData failed:', err.message);
      }
    }
  }
  const positionFlushTimer = setInterval(flushPositions, positionBroadcastIntervalMs).unref();
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
  // Pushes relay state (player count, web connected, mic muted) back to
  // the plugin over its existing TCP connection.
  const tcpSocketsByLogin = new Map(); // login → { socket, room }

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
    res.send(`window.ONZ_DEBUG_ALLOWED=${debugMode ? 'true' : 'false'};\n`);
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
      res.json({ token, wsUrl: liveKitPublicWsUrl, room, login: entry.login, serverName });
      return;
    }

    // --- Manual path: caller-supplied identity, for bot.html and debugging ---
    // Unauthenticated by construction: the identity comes straight from the
    // query string, so on a public relay this lets anyone join under any name
    // they like. Real players never come through here — they arrive with a
    // nonce, handled above. 404 rather than 403 so it looks like an endpoint
    // that simply isn't there, matching the bot.html gate.
    if (!enableCalibrationBot && !debugMode) {
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
    if (debugMode) {
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
    posMap.set(pseudo, { x, y, z, ts: Date.now() });
  }

  function handleMessage(msg, fallbackRoom) {
    if (msg.type === 'nonce') {
      // Plugin registers a nonce so the browser can later call /token?t=
      const nonce = String(msg.nonce ?? '').trim();
      if (nonce.length < 4 || nonce.length > 64) return;
      const login = validateLogin(msg.login);
      if (!login) return;
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
      return;
    }
    broadcastPosition(msg, fallbackRoom);
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
          }
          return;
        }
        handleMessage(msg, wsLogin ? browserRooms.get(wsLogin) : undefined);
      } catch {}
    });
    ws.on('close', () => {
      if (wsLogin && browserSockets.get(wsLogin) === ws) browserSockets.delete(wsLogin);
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
        tcpSocketsByLogin.delete(tcpLogin);
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
            try { socket.write('{"type":"authError"}\n'); } catch {}
            socket.destroy();
            return;
          }
        }
        handleMessage(msg);
        // Associate this socket with the player's login after a valid
        // nonce so pushStateToSocket can write back over the same connection.
        if (msg.type === 'nonce') {
          const login = validateLogin(msg.login);
          if (login) {
            if (tcpLogin && tcpSocketsByLogin.get(tcpLogin)?.socket === socket) {
              tcpSocketsByLogin.delete(tcpLogin);
            }
            const srv = validateServer(msg.server) ?? '';
            const sName = typeof msg.serverName === 'string' ? msg.serverName.slice(0, 256) : '';
            tcpLogin = login;
            tcpRoom = srv ? (roomNameFor(srv, sName) ?? roomName) : null;
            tcpSocketsByLogin.set(login, { socket, room: tcpRoom });
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

  return { app, server, tcpServer, nonces, flushPositions, positionFlushTimer, statePushTimer };
}
