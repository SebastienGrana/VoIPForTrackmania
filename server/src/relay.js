// Relay server logic — extracted from index.js to be testable.
// createRelay() accepts an injected roomService so tests can pass a mock
// without touching a real LiveKit server.

import crypto from 'crypto';
import express from 'express';
import http from 'http';
import net from 'net';
import { WebSocketServer } from 'ws';
import { AccessToken } from 'livekit-server-sdk';
import { DataPacket_Kind } from '@livekit/protocol';
import { roomNameFor, displayNameFor } from './room-name.js';

// A-bis: one-time nonce store.
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
  positionBroadcastIntervalMs = 100,
  // Sécurité restante (ORDRE D'IMPLÉMENTATION point 6): port 8081 accepts any
  // raw TCP connection with zero authentication — anyone on the internet can
  // inject positions/nonces for any pseudo. There's no verifiable Trackmania
  // identity to bind to (ManiaPlanet exposes no signed identity API to
  // plugins), so this can't become real per-player auth — but a fixed
  // community secret still raises the bar from "anyone on the internet" to
  // "someone who has the community's token", which stops opportunistic
  // scanners/bots cold. Empty string (default) disables the check entirely,
  // which keeps local dev and the test suite working without configuring one.
  tcpSharedSecret = '',
}) {
  const encoder = new TextEncoder();
  // Audit #27: broadcastPosition() used to call roomService.sendData() once
  // per incoming position (one HTTP call to the LiveKit API per player per
  // tick — at 5Hz/10 players that's 50 req/s and grows linearly with room
  // size). Instead, incoming positions just update the latest-known map below;
  // a single timer per relay flushes each room's pending positions as ONE
  // aggregated sendData() call at positionBroadcastIntervalMs (5-10Hz is
  // plenty for audio panning). The map is cleared after each flush so a
  // player who stops sending (disconnect) simply stops appearing in future
  // broadcasts, instead of their last position being resent forever.
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
  // Étape 4/5: track which WebSocket belongs to which browser login so the
  // relay can push room-change notifications when the plugin sends a new nonce.
  const browserSockets = new Map(); // login → WebSocket

  // Rate-limiting (ORDRE D'IMPLÉMENTATION point 4): a handful of token
  // requests per join is normal, dozens per second is a scripted attack.
  // Ingestion is per-connection since positions are unauthenticated (per
  // socket, not per login, since the login itself isn't verified yet).
  const tokenLimiter = createRateLimiter({ windowMs: 60_000, max: 30 }); // per IP
  // Sécurité restante v2: lets the plugin exchange the permanent community
  // secret for a short-lived, single-use token over HTTPS (same host as
  // S_VoipUrl, already behind a real TLS cert via Caddy in production)
  // instead of writing the permanent secret in cleartext onto the raw TCP
  // port (8081, no TLS support — see todo.txt). The token is what actually
  // travels over that plaintext socket; sniffing it only yields a value
  // that's useless after one connection and expires in seconds either way.
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

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/token', async (req, res) => {
    if (!tokenLimiter.allow(req.ip)) {
      res.status(429).json({ error: 'too many requests' });
      return;
    }
    // --- A-bis path: token derived from one-time nonce ---
    const t = String(req.query.t || '').trim();
    if (t) {
      const entry = nonces.get(t);
      if (!entry || entry.expiry < Date.now()) {
        res.status(401).json({ error: 'invalid or expired nonce' });
        return;
      }
      nonces.delete(t); // single-use
      const room = entry.server
        ? (roomNameFor(entry.server, entry.serverName) ?? roomName)
        : roomName;
      const at = new AccessToken(apiKey, apiSecret, { identity: entry.login });
      at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: false });
      const token = await at.toJwt();
      // Return login + human-readable server name so the browser can skip the
      // identity form and show which server you're on (Étape 6).
      const serverName = displayNameFor(entry.server, entry.serverName);
      res.json({ token, wsUrl: liveKitPublicWsUrl, room, login: entry.login, serverName });
      return;
    }

    // --- Legacy path: manual identity for bot.html / testing ---
    const identity = String(req.query.identity || '').trim();
    if (!identity) {
      res.status(400).json({ error: 'missing identity query param' });
      return;
    }
    // Debug-only: an optional raw room override lets a manually-joined test
    // tab (e.g. the "follow another player" bot) land in the exact same
    // LiveKit room as a real in-game player — copied from that player's own
    // Debug readout, since reconstructing it from just a server login would
    // need the exact server display name too (label is part of the room id).
    // Remove this param along with the debug section before publication.
    const debugRoom = validateServer(req.query.room);
    const room = debugRoom || roomName;
    const at = new AccessToken(apiKey, apiSecret, { identity });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: false });
    const token = await at.toJwt();
    res.json({ token, wsUrl: liveKitPublicWsUrl, room });
  });

  // Sécurité restante v2: POST { secret } over HTTPS, get back a one-time
  // token good for a single TCP connection. 404s when no secret is
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

  function broadcastPosition(msg) {
    if (msg.type !== 'position') return;
    const { pseudo } = msg;
    if (typeof pseudo !== 'string' || pseudo.length === 0 || pseudo.length > 64) return;
    const x = Number(msg.x), y = Number(msg.y), z = Number(msg.z);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return;
    if (Math.abs(x) >= 1e6 || Math.abs(y) >= 1e6 || Math.abs(z) >= 1e6) return;

    // Route to the server-specific room (Étape 3).
    // Falls back to the default roomName for positions without a server field
    // (backward-compatible with older plugin versions and simulate-positions.js).
    // Debug-only: a raw `room` override lets a manually-joined test tab's own
    // position updates land in the same room it joined via the debug room
    // field (bot.html has no "server" to derive a room from). Remove along
    // with the rest of the debug scaffolding before publication.
    const debugRoom = validateServer(msg.room);
    const serverLogin = validateServer(msg.server);
    const targetRoom = debugRoom
      ? debugRoom
      : serverLogin
        ? (roomNameFor(serverLogin, msg.serverName) ?? roomName)
        : roomName;

    let posMap = pendingPositions.get(targetRoom);
    if (!posMap) {
      posMap = new Map();
      pendingPositions.set(targetRoom, posMap);
    }
    posMap.set(pseudo, { x, y, z, ts: Date.now() });
  }

  function handleMessage(msg) {
    if (msg.type === 'nonce') {
      // A-bis: plugin registers a nonce so the browser can later call /token?t=
      const nonce = String(msg.nonce ?? '').trim();
      if (nonce.length < 4 || nonce.length > 64) return;
      const login = validateLogin(msg.login);
      if (!login) return;
      const server = validateServer(msg.server) ?? '';
      const serverName = typeof msg.serverName === 'string'
        ? msg.serverName.slice(0, 256) : '';
      nonces.set(nonce, { login, server, serverName, expiry: Date.now() + NONCE_TTL_MS });

      // Étape 4/5: push room change to the browser that owns this login.
      // Includes the nonce so the browser can call /token?t= for the new room.
      const ws = browserSockets.get(login);
      if (ws && ws.readyState === 1 /* WebSocket.OPEN */) {
        const targetRoom = server ? (roomNameFor(server, serverName) ?? roomName) : null;
        const push = targetRoom
          ? { type: 'room', name: targetRoom, nonce }
          : { type: 'room', name: null }; // Étape 5: left server
        try { ws.send(JSON.stringify(push)); } catch {}
      }
      return;
    }
    broadcastPosition(msg);
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
        // room-change notifications to (Étape 4/5).
        if (msg.type === 'hello') {
          const login = validateLogin(msg.login);
          if (login) {
            if (wsLogin && browserSockets.get(wsLogin) === ws) browserSockets.delete(wsLogin);
            wsLogin = login;
            browserSockets.set(login, ws);
          }
          return;
        }
        handleMessage(msg);
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
    socket.setEncoding('utf8');
    socket.setTimeout(TCP_IDLE_TIMEOUT_MS);
    socket.on('timeout', () => socket.destroy());
    socket.on('close', () => { tcpConnectionCount--; });
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
        // Sécurité restante: the first message on a gated connection must be a
        // matching auth — anything else (including a well-formed nonce/position
        // sent without one) closes the socket immediately. Accepts either a
        // one-time token from POST /tcp-auth (preferred — see Sécurité
        // restante v2 above) or the raw secret directly (legacy path, kept for
        // simulate-positions.js and older plugin builds that never fetch a
        // token).
        if (!authenticated) {
          if (msg.type === 'auth' && typeof msg.token === 'string'
              && tcpAuthTokens.has(msg.token) && tcpAuthTokens.get(msg.token) >= Date.now()) {
            tcpAuthTokens.delete(msg.token); // single-use
            authenticated = true;
          } else if (msg.type === 'auth' && msg.secret === tcpSharedSecret) {
            authenticated = true;
          } else {
            // Lets the plugin widget tell "wrong/missing secret" apart from a
            // generic network hiccup, instead of retrying blind forever.
            try { socket.write('{"type":"authError"}\n'); } catch {}
            socket.destroy();
          }
          return;
        }
        handleMessage(msg);
      }
    });
    socket.on('error', (err) => console.error('TCP ingest: socket error:', err.message));
  });

  return { app, server, tcpServer, nonces, flushPositions, positionFlushTimer };
}
