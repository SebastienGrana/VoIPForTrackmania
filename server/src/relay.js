// Relay server logic — extracted from index.js to be testable.
// createRelay() accepts an injected roomService so tests can pass a mock
// without touching a real LiveKit server.

import express from 'express';
import http from 'http';
import net from 'net';
import { WebSocketServer } from 'ws';
import { AccessToken } from 'livekit-server-sdk';
import { DataPacket_Kind } from '@livekit/protocol';

export function createRelay({
  roomService,
  apiKey,
  apiSecret,
  liveKitPublicWsUrl,
  roomName,
  staticDir = 'public',
}) {
  const encoder = new TextEncoder();
  const app = express();
  app.use(express.static(staticDir));

  app.get('/token', async (req, res) => {
    const identity = String(req.query.identity || '').trim();
    if (!identity) {
      res.status(400).json({ error: 'missing identity query param' });
      return;
    }
    const at = new AccessToken(apiKey, apiSecret, { identity });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
    const token = await at.toJwt();
    res.json({ token, wsUrl: liveKitPublicWsUrl, room: roomName });
  });

  const server = http.createServer(app);

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
      await roomService.sendData(roomName, encoder.encode(payload), DataPacket_Kind.LOSSY, {
        topic: 'position',
      });
    } catch (err) {
      console.error('sendData failed:', err.message);
    }
  }

  const wss = new WebSocketServer({ server, path: '/ingest' });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      try { broadcastPosition(JSON.parse(raw.toString())); } catch {}
    });
  });

  const tcpServer = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try { broadcastPosition(JSON.parse(line)); }
        catch (err) { console.error('TCP ingest: parse error:', err.message); }
      }
    });
    socket.on('error', (err) => console.error('TCP ingest: socket error:', err.message));
  });

  return { app, server, tcpServer };
}
