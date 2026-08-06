import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRelay } from '../src/relay.js';

// Minimal creds — no real LiveKit needed: token generation is local JWT signing,
// and sendData is injected as a mock.
const API_KEY    = 'testApiKey1234567890';
const API_SECRET = 'testApiSecret12345678901234567890'; // ≥32 chars for HS256
const WS_URL     = 'wss://test.example.com';
const ROOM       = 'testroom';

function makeMockRoomService() {
  const calls = [];
  return {
    calls,
    async sendData(...args) { calls.push(args); },
  };
}

// Connects a TCP socket to TCP_PORT, sends the given lines (joined by \n),
// then closes. Resolves when the socket is fully closed.
function tcpSend(port, lines) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, '127.0.0.1', () => {
      socket.write(lines.join('\n') + '\n');
      socket.end();
    });
    socket.on('close', resolve);
    socket.on('error', reject);
  });
}

describe('OnZVoIP relay', () => {
  let relay;
  let mockService;
  let HTTP_PORT;
  let TCP_PORT;

  before(async () => {
    mockService = makeMockRoomService();
    relay = createRelay({
      roomService: mockService,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      liveKitPublicWsUrl: WS_URL,
      roomName: ROOM,
    });
    // Port 0 → OS picks a free port, avoids conflicts in CI
    await new Promise(resolve => relay.server.listen(0, resolve));
    HTTP_PORT = relay.server.address().port;
    await new Promise(resolve => relay.tcpServer.listen(0, resolve));
    TCP_PORT = relay.tcpServer.address().port;
  });

  after(async () => {
    await new Promise(resolve => relay.server.close(resolve));
    await new Promise(resolve => relay.tcpServer.close(resolve));
  });

  describe('GET /token', () => {
    test('missing identity → 400 with error message', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/token`);
      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.strictEqual(body.error, 'missing identity query param');
    });

    test('whitespace-only identity → 400', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/token?identity=%20%20`);
      assert.strictEqual(res.status, 400);
    });

    test('valid identity → 200 with JWT, wsUrl and room', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/token?identity=velp`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(typeof body.token === 'string' && body.token.length > 0);
      assert.ok(body.token.startsWith('ey'), 'token should be a JWT');
      assert.strictEqual(body.wsUrl, WS_URL);
      assert.strictEqual(body.room, ROOM);
    });

    test('identity is URL-decoded', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/token?identity=player%20one`);
      assert.strictEqual(res.status, 200);
    });
  });

  describe('TCP ingest', () => {
    test('valid position → broadcasts to LiveKit room', async () => {
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'position', pseudo: 'velp', x: 10, y: 20, z: 0 }),
      ]);
      await new Promise(r => setTimeout(r, 100));
      assert.ok(mockService.calls.length > before, 'sendData should have been called');
    });

    test('broadcast payload contains correct pseudo and coords', async () => {
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'position', pseudo: 'testplayer', x: 42, y: 7, z: 3 }),
      ]);
      await new Promise(r => setTimeout(r, 100));
      const call = mockService.calls[before];
      assert.ok(call, 'sendData should have been called');
      const payload = JSON.parse(new TextDecoder().decode(call[1]));
      assert.strictEqual(payload.pseudo, 'testplayer');
      assert.strictEqual(payload.x, 42);
      assert.strictEqual(payload.y, 7);
      assert.strictEqual(payload.z, 3);
      assert.ok(typeof payload.ts === 'number');
    });

    test('non-position type → ignored, no broadcast', async () => {
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'ping', pseudo: 'velp', x: 0, y: 0, z: 0 }),
      ]);
      await new Promise(r => setTimeout(r, 100));
      assert.strictEqual(mockService.calls.length, before);
    });

    test('empty pseudo → ignored, no broadcast', async () => {
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'position', pseudo: '', x: 0, y: 0, z: 0 }),
      ]);
      await new Promise(r => setTimeout(r, 100));
      assert.strictEqual(mockService.calls.length, before);
    });

    test('malformed JSON → does not crash server', async () => {
      await tcpSend(TCP_PORT, ['this is not json', '{ broken']);
      // Server should still handle new requests
      const res = await fetch(`http://localhost:${HTTP_PORT}/token?identity=postcrash`);
      assert.strictEqual(res.status, 200);
    });

    test('multiple positions in one TCP chunk → all broadcast', async () => {
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'position', pseudo: 'a', x: 1, y: 2, z: 0 }),
        JSON.stringify({ type: 'position', pseudo: 'b', x: 3, y: 4, z: 0 }),
        JSON.stringify({ type: 'position', pseudo: 'c', x: 5, y: 6, z: 0 }),
      ]);
      await new Promise(r => setTimeout(r, 150));
      assert.ok(
        mockService.calls.length >= before + 3,
        `expected ≥3 new calls, got ${mockService.calls.length - before}`,
      );
    });
  });
});
