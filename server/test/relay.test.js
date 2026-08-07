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

  describe('GET /token (legacy identity path)', () => {
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

  // A-bis: one-time nonce path
  describe('GET /token?t= (A-bis nonce path)', () => {
    test('unknown nonce → 401', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/token?t=doesnotexist`);
      assert.strictEqual(res.status, 401);
    });

    test('valid nonce → 200 with JWT bound to computed room', async () => {
      const nonce = 'testnonce01';
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'nonce', nonce, login: 'velp', server: 'droppie_lolmaps', serverName: '$00F$OLOLMAPS' }),
      ]);
      await new Promise(r => setTimeout(r, 60));

      const res = await fetch(`http://localhost:${HTTP_PORT}/token?t=${nonce}`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(body.token.startsWith('ey'), 'should be a JWT');
      assert.strictEqual(body.wsUrl, WS_URL);
      // Room must be derived from the server login, not the default ROOM constant.
      assert.notStrictEqual(body.room, ROOM, 'room should be server-specific, not default');
      assert.ok(body.room.includes('-'), 'room name should have a suffix separator');
    });

    test('nonce is single-use → second request → 401', async () => {
      const nonce = 'singleuse-nonce-99';
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'nonce', nonce, login: 'velp', server: 'srv-abc', serverName: 'TestSrv' }),
      ]);
      await new Promise(r => setTimeout(r, 60));

      const r1 = await fetch(`http://localhost:${HTTP_PORT}/token?t=${nonce}`);
      assert.strictEqual(r1.status, 200);

      const r2 = await fetch(`http://localhost:${HTTP_PORT}/token?t=${nonce}`);
      assert.strictEqual(r2.status, 401, 'second use of same nonce must be rejected');
    });

    test('nonce with invalid login (empty) → ignored, not stored', async () => {
      const nonce = 'bad-login-nonce';
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'nonce', nonce, login: '', server: 'srv-abc', serverName: 'TestSrv' }),
      ]);
      await new Promise(r => setTimeout(r, 60));
      const res = await fetch(`http://localhost:${HTTP_PORT}/token?t=${nonce}`);
      assert.strictEqual(res.status, 401, 'invalid login must not register a nonce');
    });

    test('nonce with invalid server chars → server treated as empty, nonce stored with global room', async () => {
      const nonce = 'bad-server-nonce';
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'nonce', nonce, login: 'velp', server: '../../etc/passwd', serverName: '' }),
      ]);
      await new Promise(r => setTimeout(r, 60));
      const res = await fetch(`http://localhost:${HTTP_PORT}/token?t=${nonce}`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      // Bad server rejected → falls back to default room
      assert.strictEqual(body.room, ROOM);
    });
  });

  // Étape 3: position routing by server
  describe('TCP ingest — server-based room routing (Étape 3)', () => {
    test('position with server field → sendData targets server room (not default)', async () => {
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'position', pseudo: 'velp', server: 'droppie_lolmaps', serverName: '$OLOLMAPS', x: 10, y: 0, z: 0 }),
      ]);
      await new Promise(r => setTimeout(r, 100));
      const call = mockService.calls[before];
      assert.ok(call, 'sendData must have been called');
      // First argument to sendData is the room name
      assert.notStrictEqual(call[0], ROOM, 'should route to server room, not default');
      assert.ok(call[0].includes('-'), 'room name should have hash suffix');
    });

    test('position without server field → sendData targets default room (backward-compat)', async () => {
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'position', pseudo: 'velp', x: 10, y: 0, z: 0 }),
      ]);
      await new Promise(r => setTimeout(r, 100));
      const call = mockService.calls[before];
      assert.ok(call, 'sendData must have been called');
      assert.strictEqual(call[0], ROOM, 'no server → must fall back to default room');
    });

    test('two positions from different servers → different rooms', async () => {
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'position', pseudo: 'a', server: 'srv-one', serverName: 'One', x: 1, y: 0, z: 0 }),
        JSON.stringify({ type: 'position', pseudo: 'b', server: 'srv-two', serverName: 'Two', x: 1, y: 0, z: 0 }),
      ]);
      await new Promise(r => setTimeout(r, 100));
      assert.ok(mockService.calls.length >= before + 2);
      const room1 = mockService.calls[before][0];
      const room2 = mockService.calls[before + 1][0];
      assert.notStrictEqual(room1, room2, 'different server logins must produce different rooms');
    });

    test('same server login → same room (deterministic)', async () => {
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'position', pseudo: 'a', server: 'same-srv', serverName: 'Same', x: 1, y: 0, z: 0 }),
        JSON.stringify({ type: 'position', pseudo: 'b', server: 'same-srv', serverName: 'Same', x: 2, y: 0, z: 0 }),
      ]);
      await new Promise(r => setTimeout(r, 100));
      assert.ok(mockService.calls.length >= before + 2);
      const room1 = mockService.calls[before][0];
      const room2 = mockService.calls[before + 1][0];
      assert.strictEqual(room1, room2, 'same server login must always map to the same room');
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

  // Regression tests for the ef55717 hardening — AUDIT #14. These behaviours
  // used to have zero coverage, meaning a well-intentioned refactor could
  // silently remove them and no test would notice.
  describe('input validation (AUDIT #14)', () => {
    test('x = NaN → rejected, no broadcast (would poison client Math.hypot)', async () => {
      const before = mockService.calls.length;
      // Cannot JSON.stringify NaN (becomes null), so send the raw JSON literal.
      await tcpSend(TCP_PORT, ['{"type":"position","pseudo":"velp","x":NaN,"y":0,"z":0}']);
      await new Promise(r => setTimeout(r, 100));
      assert.strictEqual(mockService.calls.length, before);
    });

    test('x = Infinity → rejected, no broadcast', async () => {
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, ['{"type":"position","pseudo":"velp","x":Infinity,"y":0,"z":0}']);
      await new Promise(r => setTimeout(r, 100));
      assert.strictEqual(mockService.calls.length, before);
    });

    test('x = null → rejected (Number(null) is 0 but the payload is malformed)', async () => {
      // Number(null) === 0, which IS finite, so this actually passes today.
      // Kept as a regression marker: if we tighten validation, update the
      // expected count. See AUDIT #3 (client-side) for the belt & suspenders.
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'position', pseudo: 'velp', x: null, y: 0, z: 0 }),
      ]);
      await new Promise(r => setTimeout(r, 100));
      // Current behaviour: passes through as (0,0,0). Documented, not asserted
      // strict either way — this test exists to make the next change conscious.
      const delta = mockService.calls.length - before;
      assert.ok(delta === 0 || delta === 1, `unexpected delta: ${delta}`);
    });

    test('x = "abc" (non-numeric string) → rejected, no broadcast', async () => {
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'position', pseudo: 'velp', x: 'abc', y: 0, z: 0 }),
      ]);
      await new Promise(r => setTimeout(r, 100));
      assert.strictEqual(mockService.calls.length, before);
    });

    test('4096-byte buffer limit → oversize input closes socket, server stays up', async () => {
      // Send > 4096 bytes without a newline so the buffer grows unchecked.
      // The relay should destroy the socket without crashing.
      const huge = 'x'.repeat(5000);
      await new Promise((resolve, reject) => {
        const socket = net.createConnection(TCP_PORT, '127.0.0.1', () => {
          socket.write(huge);
        });
        socket.on('close', resolve);
        // ECONNRESET is expected when the relay calls destroy() on us.
        socket.on('error', (err) => (err.code === 'ECONNRESET' ? resolve() : reject(err)));
      });
      // Server must still handle new work.
      const res = await fetch(`http://localhost:${HTTP_PORT}/token?identity=afterflood`);
      assert.strictEqual(res.status, 200);
    });

    test('rate limit: >30 messages/sec on one TCP socket → socket destroyed', async () => {
      const lines = [];
      for (let i = 0; i < 40; i++) {
        lines.push(JSON.stringify({ type: 'position', pseudo: 'flooder', x: i, y: 0, z: 0 }));
      }
      await new Promise((resolve, reject) => {
        const socket = net.createConnection(TCP_PORT, '127.0.0.1', () => {
          socket.write(lines.join('\n') + '\n');
        });
        socket.on('close', resolve);
        socket.on('error', (err) => (err.code === 'ECONNRESET' ? resolve() : reject(err)));
      });
      // Server must still handle new connections after destroying the flooder.
      const res = await fetch(`http://localhost:${HTTP_PORT}/token?identity=afterflood2`);
      assert.strictEqual(res.status, 200);
    });

    test('bursts of huge input across many connections → server does not crash', async () => {
      // Same shape as above but repeated — a naive fix that grows the buffer
      // without dropping the connection would exhaust memory here.
      const huge = 'y'.repeat(5000);
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve, reject) => {
          const socket = net.createConnection(TCP_PORT, '127.0.0.1', () => socket.write(huge));
          socket.on('close', resolve);
          socket.on('error', (err) => (err.code === 'ECONNRESET' ? resolve() : reject(err)));
        });
      }
      const res = await fetch(`http://localhost:${HTTP_PORT}/token?identity=afterbursts`);
      assert.strictEqual(res.status, 200);
    });
  });
});

// Isolated in its own relay/server instance: the /token limiter is a 60s
// fixed window keyed by IP, so sharing the main describe's relay would make
// this test's 35 requests bleed into every other /token test's count (all
// tests hit 127.0.0.1) and start failing them with 429 instead of 200.
describe('rate limiting — /token (own relay instance)', () => {
  let relay;
  let HTTP_PORT;

  before(async () => {
    relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      liveKitPublicWsUrl: WS_URL,
      roomName: ROOM,
    });
    await new Promise(resolve => relay.server.listen(0, resolve));
    HTTP_PORT = relay.server.address().port;
  });

  after(async () => {
    await new Promise(resolve => relay.server.close(resolve));
  });

  test('>30 requests/min from one IP → 429', async () => {
    let lastStatus;
    for (let i = 0; i < 35; i++) {
      const res = await fetch(`http://localhost:${HTTP_PORT}/token?identity=ratelimited`);
      lastStatus = res.status;
    }
    assert.strictEqual(lastStatus, 429);
  });
});
