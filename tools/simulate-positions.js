// Fakes the OpenPlanet plugin: speaks the exact same ingest protocol
// (plain WebSocket, {type:"position", pseudo, x, y, z} every 200ms) so the
// relay -> Livekit data channel -> web client pipeline can be proven without
// the game or the real plugin. See ../server/src/index.js for the receiving
// end and ../context.txt for why this protocol looks the way it does.
import { WebSocket } from 'ws';

const RELAY_WS_URL = process.env.RELAY_WS_URL || 'ws://localhost:8080/ingest';
const SEND_INTERVAL_MS = 200;
const PERIOD_MS = 10_000; // one full sweep every 10s

// Matches the web client's 480x480 canvas so distances/gains are meaningful
// to watch side by side with a real browser tab.
const CENTER_X = 240;
const RANGE_X = 200; // oscillates between 40 and 440
const Y = 240;

const ws = new WebSocket(RELAY_WS_URL);

ws.on('open', () => {
  console.log(`simulator connected to ${RELAY_WS_URL}, sending "Bot1" positions every ${SEND_INTERVAL_MS}ms`);
  const start = Date.now();
  setInterval(() => {
    const t = (Date.now() - start) / PERIOD_MS;
    const x = CENTER_X + RANGE_X * Math.sin(t * 2 * Math.PI);
    ws.send(JSON.stringify({ type: 'position', pseudo: 'Bot1', x, y: Y, z: 0 }));
  }, SEND_INTERVAL_MS);
});

ws.on('error', (err) => {
  console.error('simulator websocket error:', err.message);
});
