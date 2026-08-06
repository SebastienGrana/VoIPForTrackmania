import express from 'express';
import http from 'http';
import net from 'net';
import { WebSocketServer } from 'ws';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { DataPacket_Kind } from '@livekit/protocol';

const {
  LIVEKIT_INTERNAL_URL,
  LIVEKIT_PUBLIC_WS_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  ROOM_NAME = 'onzsm',
  PORT = 8080,
  INGEST_TCP_PORT = 8081,
} = process.env;

if (!LIVEKIT_INTERNAL_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  throw new Error('Missing LIVEKIT_INTERNAL_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET env vars');
}

const roomService = new RoomServiceClient(LIVEKIT_INTERNAL_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
const encoder = new TextEncoder();

const app = express();
app.use(express.static('public'));

// Issues a Livekit join token for a player identity. The web client (or,
// eventually, the OpenPlanet plugin's in-game link) calls this before
// connecting to the room.
app.get('/token', async (req, res) => {
  const identity = String(req.query.identity || '').trim();
  if (!identity) {
    res.status(400).json({ error: 'missing identity query param' });
    return;
  }
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity });
  at.addGrant({ roomJoin: true, room: ROOM_NAME, canPublish: true, canSubscribe: true, canPublishData: true });
  const token = await at.toJwt();
  res.json({ token, wsUrl: LIVEKIT_PUBLIC_WS_URL, room: ROOM_NAME });
});

const server = http.createServer(app);

// Shared by both ingest transports below (WS for the web test client/simulator,
// raw TCP for the OpenPlanet plugin - see broadcastPosition callers).
async function broadcastPosition(msg) {
  if (msg.type !== 'position') return;
  const { pseudo, x, y, z } = msg;
  if (typeof pseudo !== 'string' || pseudo.length === 0) return;

  const payload = JSON.stringify({
    pseudo,
    x: Number(x) || 0,
    y: Number(y) || 0,
    z: Number(z) || 0,
    ts: Date.now(),
  });

  try {
    // Broadcast to every participant in the room via Livekit's data channel.
    // No distance/volume math here - each client computes that itself
    // from the stream of positions it receives (see context.txt ARCHITECTURE AUDIO).
    await roomService.sendData(ROOM_NAME, encoder.encode(payload), DataPacket_Kind.LOSSY, {
      topic: 'position',
    });
  } catch (err) {
    console.error('sendData failed:', err.message);
  }
}

// Position ingestion over WebSocket: used by the web test client and
// tools/simulate-positions.js. One JSON message per position update.
const wss = new WebSocketServer({ server, path: '/ingest' });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      broadcastPosition(JSON.parse(raw.toString()));
    } catch {
      // ignore malformed frame
    }
  });
});

// Position ingestion over raw TCP, newline-delimited JSON: used by the
// OpenPlanet plugin (see openplanet-plugin/). OpenPlanet's built-in
// Net::Socket is a plain TCP socket with no WebSocket handshake/framing, and
// unlike the third-party WebSockets plugin it needs no extra dependency and
// is guaranteed present on the ManiaPlanet build - see todo.txt ETAPE 3.
const tcpServer = net.createServer((socket) => {
  console.log(`TCP ingest: connection from ${socket.remoteAddress}:${socket.remotePort}`);
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        broadcastPosition(JSON.parse(line));
      } catch (err) {
        console.error('TCP ingest: failed to parse line', JSON.stringify(line), err.message);
      }
    }
  });
  socket.on('close', () => console.log('TCP ingest: connection closed'));
  socket.on('error', (err) => console.error('TCP ingest: socket error', err.message));
});

tcpServer.listen(INGEST_TCP_PORT, () => {
  console.log(`onzvoip relay TCP ingest listening on :${INGEST_TCP_PORT}`);
});

server.listen(PORT, () => {
  console.log(`onzvoip relay listening on :${PORT} (room "${ROOM_NAME}", livekit at ${LIVEKIT_INTERNAL_URL})`);
});
