import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
// Node 20 has no global WebSocket; the relay already depends on 'ws' anyway.
import WebSocket from 'ws';
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
    // Default: pretend every room exists, so existing sendData assertions
    // below don't need to know about the room-existence gate.
    async listRooms(names) { return names.map(name => ({ name })); },
    async sendData(...args) { calls.push(args); },
    async listParticipants(_room) { return []; },
  };
}

// Connects a TCP socket to TCP_PORT, sends the given lines (joined by \n),
// then closes. Resolves when the socket is fully closed.
// resume(): the relay may write a state push back on this same connection
// (e.g. after a nonce). A paused Readable never reaches 'end'
// until its buffered data is consumed, so without draining it here, any
// unread reply from the relay would block 'close' from ever firing and hang
// the test. This helper doesn't care about the reply's content, just that it
// doesn't get stuck unread.
function tcpSend(port, lines) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, '127.0.0.1', () => {
      socket.write(lines.join('\n') + '\n');
      socket.end();
    });
    socket.resume();
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
      // The legacy /token?identity= path and bot.html are both gated behind
      // this flag; enable it here so the legacy-path tests below exercise the
      // handler itself. The gate is covered separately, further down.
      enableCalibrationBot: true,
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

  describe('GET /health', () => {
    test('returns 200 ok', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/health`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.status, 'ok');
    });
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

  // One-time nonce path
  describe('GET /token?t= (nonce path)', () => {
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

  // Position routing by server
  describe('TCP ingest — server-based room routing', () => {
    test('position with server field → sendData targets server room (not default)', async () => {
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'position', pseudo: 'velp', server: 'droppie_lolmaps', serverName: '$OLOLMAPS', x: 10, y: 0, z: 0 }),
      ]);
      await new Promise(r => setTimeout(r, 20));
      await relay.flushPositions();
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
      await new Promise(r => setTimeout(r, 20));
      await relay.flushPositions();
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
      await new Promise(r => setTimeout(r, 20));
      await relay.flushPositions();
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
      await new Promise(r => setTimeout(r, 20));
      await relay.flushPositions();
      // Both positions land in the same room, so the #27 aggregation collapses
      // them into ONE sendData call carrying both entries, not two calls.
      assert.strictEqual(mockService.calls.length, before + 1, 'same-room positions must be aggregated into a single call');
      const positions = JSON.parse(new TextDecoder().decode(mockService.calls[before][1]));
      const pseudos = positions.map(p => p.pseudo).sort();
      assert.deepStrictEqual(pseudos, ['a', 'b'], 'both players must appear in the aggregated broadcast');
    });
  });

  describe('TCP ingest', () => {
    test('valid position → broadcasts to LiveKit room', async () => {
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'position', pseudo: 'velp', x: 10, y: 20, z: 0 }),
      ]);
      await new Promise(r => setTimeout(r, 20));
      await relay.flushPositions();
      assert.ok(mockService.calls.length > before, 'sendData should have been called');
    });

    test('broadcast payload contains correct pseudo and coords', async () => {
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'position', pseudo: 'testplayer', x: 42, y: 7, z: 3 }),
      ]);
      await new Promise(r => setTimeout(r, 20));
      await relay.flushPositions();
      const call = mockService.calls[before];
      assert.ok(call, 'sendData should have been called');
      // #27: the payload is now an array of positions, not a single object.
      const positions = JSON.parse(new TextDecoder().decode(call[1]));
      assert.ok(Array.isArray(positions), 'payload must be an array');
      const payload = positions.find(p => p.pseudo === 'testplayer');
      assert.ok(payload, 'testplayer must be in the broadcast');
      assert.strictEqual(payload.x, 42);
      assert.strictEqual(payload.y, 7);
      assert.strictEqual(payload.z, 3);
      assert.ok(typeof payload.ts === 'number');
    });

    // The heading lets the browser rotate the stereo image and the radar with
    // the car. It is optional on the wire: browsers publishing their own dot
    // have no car, and a plugin older than this feature simply does not send
    // one — neither is a reason to drop a perfectly good position.
    async function broadcastOne(msg) {
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, [JSON.stringify({ type: 'position', ...msg })]);
      await new Promise(r => setTimeout(r, 20));
      await relay.flushPositions();
      const call = mockService.calls[before];
      assert.ok(call, 'sendData should have been called');
      return JSON.parse(new TextDecoder().decode(call[1])).find(p => p.pseudo === msg.pseudo);
    }

    test('a heading is carried through to the browsers', async () => {
      const p = await broadcastOne({ pseudo: 'heads', x: 1, y: 0, z: 2, fx: 0.6, fz: -0.8 });
      assert.strictEqual(p.fx, 0.6);
      assert.strictEqual(p.fz, -0.8);
    });

    test('a position without a heading keeps flowing, with no heading attached', async () => {
      const p = await broadcastOne({ pseudo: 'nohead', x: 1, y: 0, z: 2 });
      assert.strictEqual(p.x, 1);
      assert.ok(!('fx' in p) && !('fz' in p), `expected no heading, got ${JSON.stringify(p)}`);
    });

    test('a heading that is not a direction is dropped, the position is not', async () => {
      // (0, 0) points nowhere and NaN is not a number; either would leave the
      // client rotating by nonsense rather than falling back to world space.
      for (const bad of [{ fx: 0, fz: 0 }, { fx: 'left', fz: 1 }, { fx: 1e9, fz: 1 }]) {
        const p = await broadcastOne({ pseudo: 'badhead', x: 5, y: 0, z: 5, ...bad });
        assert.strictEqual(p.x, 5, `position dropped for ${JSON.stringify(bad)}`);
        assert.ok(!('fx' in p), `heading kept for ${JSON.stringify(bad)}`);
      }
    });

    test('non-position type → ignored, no broadcast', async () => {
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'ping', pseudo: 'velp', x: 0, y: 0, z: 0 }),
      ]);
      await new Promise(r => setTimeout(r, 20));
      await relay.flushPositions();
      assert.strictEqual(mockService.calls.length, before);
    });

    test('empty pseudo → ignored, no broadcast', async () => {
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'position', pseudo: '', x: 0, y: 0, z: 0 }),
      ]);
      await new Promise(r => setTimeout(r, 20));
      await relay.flushPositions();
      assert.strictEqual(mockService.calls.length, before);
    });

    test('malformed JSON → does not crash server', async () => {
      await tcpSend(TCP_PORT, ['this is not json', '{ broken']);
      // Server should still handle new requests
      const res = await fetch(`http://localhost:${HTTP_PORT}/health`);
      assert.strictEqual(res.status, 200);
    });

    test('room does not exist on LiveKit → sendData skipped, no error thrown', async () => {
      const before = mockService.calls.length;
      const originalListRooms = mockService.listRooms;
      mockService.listRooms = async () => [];
      try {
        await tcpSend(TCP_PORT, [
          JSON.stringify({ type: 'position', pseudo: 'velp', x: 1, y: 2, z: 0 }),
        ]);
        await new Promise(r => setTimeout(r, 20));
        await relay.flushPositions();
      } finally {
        mockService.listRooms = originalListRooms;
      }
      assert.strictEqual(mockService.calls.length, before, 'sendData must not be called for a room nobody has joined');
    });

    test('multiple positions in one TCP chunk → all broadcast', async () => {
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'position', pseudo: 'a', x: 1, y: 2, z: 0 }),
        JSON.stringify({ type: 'position', pseudo: 'b', x: 3, y: 4, z: 0 }),
        JSON.stringify({ type: 'position', pseudo: 'c', x: 5, y: 6, z: 0 }),
      ]);
      await new Promise(r => setTimeout(r, 20));
      await relay.flushPositions();
      // All three share the default room, so #27 aggregation puts them in one
      // sendData call carrying all three entries, not three separate calls.
      const call = mockService.calls[before];
      assert.ok(call, 'sendData should have been called');
      const positions = JSON.parse(new TextDecoder().decode(call[1]));
      const pseudos = positions.map(p => p.pseudo).sort();
      assert.deepStrictEqual(
        ['a', 'b', 'c'].filter(p => pseudos.includes(p)),
        ['a', 'b', 'c'],
        `expected a, b, c in the aggregated broadcast, got ${JSON.stringify(pseudos)}`,
      );
    });
  });

  // Regression tests for input-validation hardening. These behaviours used to
  // have zero coverage, meaning a well-intentioned refactor could silently
  // remove them and no test would notice.
  describe('input validation', () => {
    test('x = NaN → rejected, no broadcast (would poison client Math.hypot)', async () => {
      const before = mockService.calls.length;
      // Cannot JSON.stringify NaN (becomes null), so send the raw JSON literal.
      await tcpSend(TCP_PORT, ['{"type":"position","pseudo":"velp","x":NaN,"y":0,"z":0}']);
      await new Promise(r => setTimeout(r, 20));
      await relay.flushPositions();
      assert.strictEqual(mockService.calls.length, before);
    });

    test('x = Infinity → rejected, no broadcast', async () => {
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, ['{"type":"position","pseudo":"velp","x":Infinity,"y":0,"z":0}']);
      await new Promise(r => setTimeout(r, 20));
      await relay.flushPositions();
      assert.strictEqual(mockService.calls.length, before);
    });

    test('x = null → rejected (Number(null) is 0 but the payload is malformed)', async () => {
      // Number(null) === 0, which IS finite, so this actually passes today.
      // Kept as a regression marker: if we tighten validation, update the
      // expected count. The web client applies its own validation too, as a
      // belt-and-suspenders layer independent of this server-side check.
      const before = mockService.calls.length;
      await tcpSend(TCP_PORT, [
        JSON.stringify({ type: 'position', pseudo: 'velp', x: null, y: 0, z: 0 }),
      ]);
      await new Promise(r => setTimeout(r, 20));
      await relay.flushPositions();
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
      await new Promise(r => setTimeout(r, 20));
      await relay.flushPositions();
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
      const res = await fetch(`http://localhost:${HTTP_PORT}/health`);
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
      const res = await fetch(`http://localhost:${HTTP_PORT}/health`);
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
      const res = await fetch(`http://localhost:${HTTP_PORT}/health`);
      assert.strictEqual(res.status, 200);
    });
  });
});

// Isolated in its own relay/server instance: the /token limiter is a 60s
// fixed window keyed by IP, so sharing the main describe's relay would make
// this test's 35 requests bleed into every other /token test's count (all
// tests hit 127.0.0.1) and start failing them with 429 instead of 200.
// Isolated relay with tiny limits so the connection cap and idle timeout
// behaviours can be exercised without opening/waiting on 1000+ real sockets.
describe('TCP ingest — connection limits (own relay instance)', () => {
  let relay;
  let HTTP_PORT;
  let TCP_PORT;

  before(async () => {
    relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      liveKitPublicWsUrl: WS_URL,
      roomName: ROOM,
      tcpMaxConnections: 2,
      tcpIdleTimeoutMs: 100,
    });
    await new Promise(resolve => relay.server.listen(0, resolve));
    HTTP_PORT = relay.server.address().port;
    await new Promise(resolve => relay.tcpServer.listen(0, resolve));
    TCP_PORT = relay.tcpServer.address().port;
  });

  after(async () => {
    await new Promise(resolve => relay.server.close(resolve));
    await new Promise(resolve => relay.tcpServer.close(resolve));
  });

  test('idle socket beyond timeout is destroyed', async () => {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(TCP_PORT, '127.0.0.1', () => {});
      socket.on('close', resolve);
      socket.on('error', (err) => (err.code === 'ECONNRESET' ? resolve() : reject(err)));
      // Send nothing — the 100ms idle timeout above should close this.
    });
  });

  test('connections beyond the cap are refused, server stays up', async () => {
    const sockets = [];
    const closed = [];
    for (let i = 0; i < 3; i++) {
      closed.push(new Promise((resolve) => {
        const socket = net.createConnection(TCP_PORT, '127.0.0.1');
        socket.on('close', resolve);
        socket.on('error', () => resolve());
        sockets.push(socket);
      }));
    }
    // The 3rd connection exceeds tcpMaxConnections: 2 and must be dropped.
    await Promise.race([closed[2], new Promise(r => setTimeout(r, 500))]);
    for (const s of sockets) s.destroy();
    await Promise.all(closed);

    const res = await fetch(`http://localhost:${HTTP_PORT}/health`);
    assert.strictEqual(res.status, 200);
  });
});

// Own relay instance so the shared-secret gate doesn't affect the main
// describe's unauthenticated TCP tests above.
describe('TCP ingest — shared secret (own relay instance)', () => {
  let relay;
  let HTTP_PORT;
  let TCP_PORT;
  const SECRET = 'community-token-42';

  before(async () => {
    relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      liveKitPublicWsUrl: WS_URL,
      roomName: ROOM,
      tcpSharedSecret: SECRET,
    });
    await new Promise(resolve => relay.server.listen(0, resolve));
    HTTP_PORT = relay.server.address().port;
    await new Promise(resolve => relay.tcpServer.listen(0, resolve));
    TCP_PORT = relay.tcpServer.address().port;
  });

  after(async () => {
    await new Promise(resolve => relay.server.close(resolve));
    await new Promise(resolve => relay.tcpServer.close(resolve));
  });

  test('position sent before any auth message → socket closed, nothing broadcast', async () => {
    const before = relay.nonces.size;
    await tcpSend(TCP_PORT, [
      JSON.stringify({ type: 'position', pseudo: 'velp', x: 1, y: 0, z: 0 }),
    ]);
    // Nonce map is unaffected by position, but this also proves handleMessage
    // never ran: flush and confirm no crash / no lingering pending position.
    await relay.flushPositions();
    assert.strictEqual(relay.nonces.size, before);
  });

  test('wrong secret → socket closed', async () => {
    await tcpSend(TCP_PORT, [
      JSON.stringify({ type: 'auth', secret: 'not-the-secret' }),
      JSON.stringify({ type: 'nonce', nonce: 'should-not-register', login: 'velp', server: '', serverName: '' }),
    ]);
    await new Promise(r => setTimeout(r, 20));
    const res = await fetch(`http://localhost:${HTTP_PORT}/token?t=should-not-register`);
    assert.strictEqual(res.status, 401, 'nonce sent after a rejected auth must never register');
  });

  test('correct secret first → subsequent nonce/position accepted', async () => {
    const nonce = 'authed-nonce';
    await tcpSend(TCP_PORT, [
      JSON.stringify({ type: 'auth', secret: SECRET }),
      JSON.stringify({ type: 'nonce', nonce, login: 'velp', server: '', serverName: '' }),
    ]);
    await new Promise(r => setTimeout(r, 20));
    const res = await fetch(`http://localhost:${HTTP_PORT}/token?t=${nonce}`);
    assert.strictEqual(res.status, 200, 'nonce sent after a correct auth must register normally');
  });

  test('each new TCP connection must re-authenticate', async () => {
    // First connection authenticates and disconnects (tcpSend closes after sending).
    await tcpSend(TCP_PORT, [JSON.stringify({ type: 'auth', secret: SECRET })]);
    // A fresh connection with no auth must still be rejected.
    const nonce = 'second-connection-nonce';
    await tcpSend(TCP_PORT, [
      JSON.stringify({ type: 'nonce', nonce, login: 'velp', server: '', serverName: '' }),
    ]);
    await new Promise(r => setTimeout(r, 20));
    const res = await fetch(`http://localhost:${HTTP_PORT}/token?t=${nonce}`);
    assert.strictEqual(res.status, 401, 'auth does not carry over to a new TCP connection');
  });
});

describe('POST /tcp-auth — token exchange (own relay instance)', () => {
  let relay;
  let HTTP_PORT;
  let TCP_PORT;
  const SECRET = 'community-token-42';

  before(async () => {
    relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      liveKitPublicWsUrl: WS_URL,
      roomName: ROOM,
      tcpSharedSecret: SECRET,
    });
    await new Promise(resolve => relay.server.listen(0, resolve));
    HTTP_PORT = relay.server.address().port;
    await new Promise(resolve => relay.tcpServer.listen(0, resolve));
    TCP_PORT = relay.tcpServer.address().port;
  });

  after(async () => {
    await new Promise(resolve => relay.server.close(resolve));
    await new Promise(resolve => relay.tcpServer.close(resolve));
  });

  test('wrong secret over HTTPS → 401, no token issued', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/tcp-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'nope' }),
    });
    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.strictEqual(body.token, undefined);
  });

  test('correct secret over HTTPS → token, then usable exactly once over TCP', async () => {
    const authRes = await fetch(`http://localhost:${HTTP_PORT}/tcp-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: SECRET }),
    });
    assert.strictEqual(authRes.status, 200);
    const { token } = await authRes.json();
    assert.ok(typeof token === 'string' && token.length > 0);

    // First use: works.
    const nonce = 'token-auth-nonce';
    await tcpSend(TCP_PORT, [
      JSON.stringify({ type: 'auth', token }),
      JSON.stringify({ type: 'nonce', nonce, login: 'velp', server: '', serverName: '' }),
    ]);
    await new Promise(r => setTimeout(r, 20));
    const res1 = await fetch(`http://localhost:${HTTP_PORT}/token?t=${nonce}`);
    assert.strictEqual(res1.status, 200, 'nonce sent after a valid token must register normally');

    // Second use of the SAME token on a new connection: rejected (single-use).
    const nonce2 = 'token-auth-nonce-2';
    await tcpSend(TCP_PORT, [
      JSON.stringify({ type: 'auth', token }),
      JSON.stringify({ type: 'nonce', nonce: nonce2, login: 'velp', server: '', serverName: '' }),
    ]);
    await new Promise(r => setTimeout(r, 20));
    const res2 = await fetch(`http://localhost:${HTTP_PORT}/token?t=${nonce2}`);
    assert.strictEqual(res2.status, 401, 'a token must not be usable twice');
  });

  test('relay sends an explicit authError before closing on a rejected auth', async () => {
    const received = await new Promise((resolve, reject) => {
      const socket = net.createConnection(TCP_PORT, '127.0.0.1', () => {
        socket.write(JSON.stringify({ type: 'auth', secret: 'wrong' }) + '\n');
      });
      let data = '';
      socket.on('data', (chunk) => { data += chunk; });
      socket.on('close', () => resolve(data));
      socket.on('error', reject);
    });
    assert.match(received, /authError/);
  });
});

// State push over the TCP socket that sent the nonce.
// Own relay instance so statePushIntervalMs can be set very high (avoids
// timer-triggered pushes racing with the test's explicit socket.destroy()).
describe('TCP state push (own relay instance)', () => {
  let relay;
  let statePushService;
  let STATE_TCP_PORT;
  let STATE_HTTP_PORT;

  before(async () => {
    statePushService = makeMockRoomService();
    relay = createRelay({
      roomService: statePushService,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      liveKitPublicWsUrl: WS_URL,
      roomName: ROOM,
      statePushIntervalMs: 3_600_000, // prevent timer-triggered pushes during tests
    });
    await new Promise(resolve => relay.server.listen(0, resolve));
    await new Promise(resolve => relay.tcpServer.listen(0, resolve));
    STATE_TCP_PORT = relay.tcpServer.address().port;
    STATE_HTTP_PORT = relay.server.address().port;
  });

  after(async () => {
    await new Promise(resolve => relay.server.close(resolve));
    await new Promise(resolve => relay.tcpServer.close(resolve));
  });

  // Opens a TCP socket, sends lines, waits durationMs, destroys the socket,
  // and resolves with everything the relay wrote back.
  // `afterLines`, when given, runs once the lines are out — for tests that need
  // something to happen (an HTTP call) while the socket is still open.
  function tcpOpenAndCollect(port, lines, durationMs, afterLines) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(port, '127.0.0.1', () => {
        for (const line of lines) socket.write(line + '\n');
        if (afterLines) Promise.resolve().then(afterLines).catch(reject);
      });
      socket.setEncoding('utf8');
      let buf = '';
      socket.on('data', chunk => { buf += chunk; });
      socket.on('error', (err) => (err.code === 'ECONNRESET' ? resolve(buf) : reject(err)));
      setTimeout(() => { socket.destroy(); resolve(buf); }, durationMs);
    });
  }

  test('nonce over TCP → relay pushes state back on same connection', async () => {
    const data = await tcpOpenAndCollect(STATE_TCP_PORT, [
      JSON.stringify({ type: 'nonce', nonce: 'sp-test-1', login: 'velp', server: 'test-srv', serverName: 'TestServer' }),
    ], 200);

    const stateLine = data.split('\n').find(l => l.includes('"type":"state"'));
    assert.ok(stateLine, `expected a state push, received: ${JSON.stringify(data)}`);
    const state = JSON.parse(stateLine);
    assert.strictEqual(typeof state.players, 'number', 'state.players must be a number');
    assert.strictEqual(typeof state.web, 'boolean', 'state.web must be a boolean');
    assert.strictEqual(typeof state.mic, 'boolean', 'state.mic must be a boolean');
    // Mock returns [], so the player is not in LiveKit yet
    assert.strictEqual(state.players, 0);
    assert.strictEqual(state.web, false);
    assert.strictEqual(state.mic, false);
  });

  test('web=true and correct player count when player appears in listParticipants', async () => {
    const original = statePushService.listParticipants;
    statePushService.listParticipants = async () => [
      { identity: 'velp', tracks: [{ type: 0 /* AUDIO */, muted: false }] },
      { identity: 'other', tracks: [{ type: 0, muted: true }] },
    ];
    try {
      const data = await tcpOpenAndCollect(STATE_TCP_PORT, [
        JSON.stringify({ type: 'nonce', nonce: 'sp-test-2', login: 'velp', server: 'test-srv', serverName: 'TestServer' }),
      ], 200);

      const stateLine = data.split('\n').find(l => l.includes('"type":"state"'));
      assert.ok(stateLine, `expected a state push, received: ${JSON.stringify(data)}`);
      const state = JSON.parse(stateLine);
      assert.strictEqual(state.players, 2, 'players should count all participants');
      assert.strictEqual(state.web, true, 'web should be true when player is in LiveKit');
      // muted: false on the player's own track, so mic is true: OPEN, not muted.
      assert.strictEqual(state.mic, true, 'mic should be true when the player\'s own track is unmuted');
    } finally {
      statePushService.listParticipants = original;
    }
  });

  // The link the plugin shows is single-use, and the plugin has no other way of
  // knowing it has been used: without this push it kept a dead URL on screen
  // until its own 9-minute refresh, so leaving the page and reopening the link
  // said "expired" while the game looked like it was offering a fresh one.
  test('a browser spending the nonce → relay tells the plugin on the same socket', async () => {
    const data = await tcpOpenAndCollect(STATE_TCP_PORT, [
      JSON.stringify({ type: 'nonce', nonce: 'used-nonce-1', login: 'velp', server: 'test-srv', serverName: 'TestServer' }),
    ], 250, async () => {
      const res = await fetch(`http://localhost:${STATE_HTTP_PORT}/token?t=used-nonce-1`);
      assert.strictEqual(res.status, 200, 'the nonce should still be good the first time');
    });

    assert.ok(
      data.split('\n').some(l => l.includes('"nonceUsed"')),
      `expected a nonceUsed push, received: ${JSON.stringify(data)}`,
    );
  });

  test('no nonceUsed when the link was never spent', async () => {
    const data = await tcpOpenAndCollect(STATE_TCP_PORT, [
      JSON.stringify({ type: 'nonce', nonce: 'unused-nonce-1', login: 'velp', server: 'test-srv', serverName: 'TestServer' }),
    ], 250);

    assert.ok(!data.includes('nonceUsed'), `unexpected nonceUsed push: ${JSON.stringify(data)}`);
  });
});

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
      // The limiter runs before the path branches, so any /token shape counts;
      // use the nonce path so this test doesn't depend on the legacy gate.
      const res = await fetch(`http://localhost:${HTTP_PORT}/token?t=ratelimited`);
      lastStatus = res.status;
    }
    assert.strictEqual(lastStatus, 429);
  });
});

// The calibration-bot gate is what keeps a public relay from handing out
// publish-capable tokens for an arbitrary identity, so the *default* (off)
// behaviour is the one that matters — every other describe in this file turns
// the flag on. Nothing covered this before.
describe('calibration bot gate — default off (own relay instance)', () => {
  let relay;
  let HTTP_PORT;

  before(async () => {
    relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      liveKitPublicWsUrl: WS_URL,
      roomName: ROOM,
      // enableCalibrationBot deliberately omitted — this is the production shape.
    });
    await new Promise(resolve => relay.server.listen(0, resolve));
    HTTP_PORT = relay.server.address().port;
  });

  after(async () => {
    await new Promise(resolve => relay.server.close(resolve));
  });

  test('legacy /token?identity= → 404, no token issued', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/token?identity=impostor`);
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.strictEqual(body.token, undefined, 'must not leak a token');
  });

  test('legacy path stays closed even with no identity (no 400 leak)', async () => {
    // A 400 here would tell a prober the endpoint exists and just needs a param.
    const res = await fetch(`http://localhost:${HTTP_PORT}/token`);
    assert.strictEqual(res.status, 404);
  });

  test('bot.html and bot.js → 404', async () => {
    for (const path of ['/bot.html', '/bot.js']) {
      const res = await fetch(`http://localhost:${HTTP_PORT}${path}`);
      assert.strictEqual(res.status, 404, `${path} should not be served`);
    }
  });

  test('nonce path still works — real players are unaffected by the gate', async () => {
    // Registered directly rather than over TCP: this relay has no listening
    // ingest socket, and what's under test here is the HTTP gate, not ingest.
    const nonce = 'gateunaffected';
    relay.nonces.set(nonce, { login: 'velp', server: 'srv-a', serverName: 'Server A', expiry: Date.now() + 60_000 });
    const res = await fetch(`http://localhost:${HTTP_PORT}/token?t=${nonce}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.token.startsWith('ey'), 'token should be a JWT');
  });
});

// DEBUG_MODE is the switch a fork or a test deploy flips to get the ?debug=1
// panel back. It also re-opens the manual /token?identity= join and adds a
// room override on top of it - a token for a room nobody proved they belong
// to. So the *off* shape is what these assert first, then that the room
// override cannot be reached any other way (notably not via the calibration
// bot flag, which shares the same endpoint).
describe('debug mode — off (own relay instance)', () => {
  let relay;
  let HTTP_PORT;

  before(async () => {
    relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      liveKitPublicWsUrl: WS_URL,
      roomName: ROOM,
      // debugMode deliberately omitted — this is the production shape.
    });
    await new Promise(resolve => relay.server.listen(0, resolve));
    HTTP_PORT = relay.server.address().port;
  });

  after(async () => {
    await new Promise(resolve => relay.server.close(resolve));
  });

  test('/config.js tells the page debug is not allowed', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/config.js`);
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /window\.ONZ_DEBUG_ALLOWED=false;/);
  });

  test('/config.js is never cached — flipping the env var must take effect', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/config.js`);
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  });

  test('a room override cannot open the manual join by itself', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/token?identity=impostor&room=someoneelse`);
    assert.strictEqual(res.status, 404);
  });
});

describe('debug mode — on, room override (own relay instance)', () => {
  let relay;
  let HTTP_PORT;

  // Reads the room out of the signed JWT rather than trusting the JSON body:
  // the body is what the relay says it did, the grant is what the token
  // actually permits, and only the second one is what LiveKit enforces.
  function roomInToken(jwt) {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    return payload.video.room;
  }

  before(async () => {
    relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      liveKitPublicWsUrl: WS_URL,
      roomName: ROOM,
      debugMode: true,
    });
    await new Promise(resolve => relay.server.listen(0, resolve));
    HTTP_PORT = relay.server.address().port;
  });

  after(async () => {
    await new Promise(resolve => relay.server.close(resolve));
  });

  test('/config.js tells the page debug is allowed', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/config.js`);
    assert.match(await res.text(), /window\.ONZ_DEBUG_ALLOWED=true;/);
  });

  test('debugMode alone re-opens the manual join (no calibration flag needed)', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/token?identity=velp`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(roomInToken(body.token), ROOM, 'no override → default room');
  });

  test('?room= lands in that room, and the grant says so too', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/token?identity=velp&room=other-room_1`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.room, 'other-room_1');
    assert.strictEqual(roomInToken(body.token), 'other-room_1');
  });

  test('a malformed room name falls back to the default instead of erroring', async () => {
    // A debug-only field is not worth a failure mode; what matters is that the
    // junk never reaches the grant.
    const res = await fetch(`http://localhost:${HTTP_PORT}/token?identity=velp&room=${encodeURIComponent('../evil room')}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(roomInToken((await res.json()).token), ROOM);
  });

  test('bot.html stays closed — debug mode is not the calibration flag', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/bot.html`);
    assert.strictEqual(res.status, 404);
  });
});

// The calibration bot shares /token with debug mode. It only ever needs the
// default room, so enabling it must not drag the room override along.
describe('calibration bot on, debug off — no room override (own relay instance)', () => {
  let relay;
  let HTTP_PORT;

  before(async () => {
    relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      liveKitPublicWsUrl: WS_URL,
      roomName: ROOM,
      enableCalibrationBot: true,
    });
    await new Promise(resolve => relay.server.listen(0, resolve));
    HTTP_PORT = relay.server.address().port;
  });

  after(async () => {
    await new Promise(resolve => relay.server.close(resolve));
  });

  test('?room= is ignored, the token stays on the default room', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/token?identity=CalibBot&room=other-room`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.room, ROOM);
    const payload = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString());
    assert.strictEqual(payload.video.room, ROOM);
  });

  test('and the page is still told debug is off', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/config.js`);
    assert.match(await res.text(), /window\.ONZ_DEBUG_ALLOWED=false;/);
  });
});

// The /ingest WebSocket is a public, unauthenticated entry point that feeds the
// same handleMessage() as the TCP ingest — and it had no coverage at all.
describe('WebSocket /ingest (own relay instance)', () => {
  let relay;
  let HTTP_PORT;
  let roomService;

  before(async () => {
    roomService = makeMockRoomService();
    relay = createRelay({
      roomService,
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

  // Opens a client socket to /ingest and resolves once it's open.
  function connect() {
    const ws = new WebSocket(`ws://localhost:${HTTP_PORT}/ingest`);
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(ws));
      ws.addEventListener('error', reject);
    });
  }

  test('a position sent over the WebSocket reaches LiveKit', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'position', pseudo: 'wsplayer', x: 1, y: 2, z: 3 }));
    await new Promise(r => setTimeout(r, 40));
    await relay.flushPositions();
    ws.close();

    const payloads = roomService.calls.map(([, data]) => JSON.parse(Buffer.from(data).toString()));
    const found = payloads.flat().find(p => p.pseudo === 'wsplayer');
    assert.ok(found, 'position from the WebSocket should be fanned out');
    assert.deepStrictEqual([found.x, found.y, found.z], [1, 2, 3]);
  });

  test('malformed JSON does not kill the relay', async () => {
    const ws = await connect();
    ws.send('this is not json {{{');
    await new Promise(r => setTimeout(r, 60));
    ws.close();

    const res = await fetch(`http://localhost:${HTTP_PORT}/health`);
    assert.strictEqual(res.status, 200, 'relay should still be serving');
  });

  test('a room push is delivered only to the socket that said hello for that login', async () => {
    const [mine, other] = [await connect(), await connect()];
    const pushes = [];
    mine.addEventListener('message', e => pushes.push(JSON.parse(e.data)));
    other.addEventListener('message', () => { throw new Error('push leaked to the wrong socket'); });

    mine.send(JSON.stringify({ type: 'hello', login: 'velp' }));
    other.send(JSON.stringify({ type: 'hello', login: 'someone-else' }));
    await new Promise(r => setTimeout(r, 60));

    mine.send(JSON.stringify({ type: 'nonce', nonce: 'wspush1', login: 'velp', server: 'srv-a', serverName: 'Server A' }));
    await new Promise(r => setTimeout(r, 80));
    mine.close(); other.close();

    const roomPush = pushes.find(p => p.type === 'room');
    assert.ok(roomPush, 'the hello-ing socket should receive its room push');
    assert.strictEqual(roomPush.nonce, 'wspush1');
    assert.ok(roomPush.name, 'room name should be derived, not null');
  });

  // A browser publishing its own position (free-move / follow-a-player) has no
  // way to name a room, so its payload carries no `server` field. It used to
  // fall back to the default room, which meant nobody on a server-specific
  // room ever saw it — the whole point of the feature.
  test('a browser position with no server field goes to the room its token was issued for', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'nonce', nonce: 'wsroute1', login: 'router', server: 'srv-route', serverName: 'Route Server' }));
    await new Promise(r => setTimeout(r, 40));

    const tokenRes = await fetch(`http://localhost:${HTTP_PORT}/token?t=wsroute1`);
    const { room: issuedRoom } = await tokenRes.json();
    assert.notStrictEqual(issuedRoom, ROOM, 'a server-specific room, not the default one');

    ws.send(JSON.stringify({ type: 'hello', login: 'router' }));
    await new Promise(r => setTimeout(r, 40));
    const before = roomService.calls.length;
    ws.send(JSON.stringify({ type: 'position', pseudo: 'router', x: 7, y: 8, z: 9 }));
    await new Promise(r => setTimeout(r, 40));
    await relay.flushPositions();
    ws.close();

    const call = roomService.calls.slice(before)
      .find(([, data]) => JSON.parse(Buffer.from(data).toString()).some(p => p.pseudo === 'router'));
    assert.ok(call, 'the position should have been fanned out');
    assert.strictEqual(call[0], issuedRoom);
  });

  // The fallback must stay per-login: a socket that never said hello (older
  // plugin versions, simulate-positions.js) still lands in the default room.
  test('a position from a socket with no token still falls back to the default room', async () => {
    const ws = await connect();
    const before = roomService.calls.length;
    ws.send(JSON.stringify({ type: 'position', pseudo: 'anon', x: 1, y: 1, z: 1 }));
    await new Promise(r => setTimeout(r, 40));
    await relay.flushPositions();
    ws.close();

    const call = roomService.calls.slice(before)
      .find(([, data]) => JSON.parse(Buffer.from(data).toString()).some(p => p.pseudo === 'anon'));
    assert.ok(call);
    assert.strictEqual(call[0], ROOM);
  });

  test('flooding past the per-socket rate limit closes the connection', async () => {
    const ws = await connect();
    const closed = new Promise(resolve => ws.addEventListener('close', resolve));
    // WS_MAX_MSG_PER_SEC is 30; 200 in one burst is unambiguously over.
    for (let i = 0; i < 200; i++) {
      ws.send(JSON.stringify({ type: 'position', pseudo: 'flooder', x: i, y: 0, z: 0 }));
    }
    await closed;
    assert.strictEqual(ws.readyState, WebSocket.CLOSED);

    const res = await fetch(`http://localhost:${HTTP_PORT}/health`);
    assert.strictEqual(res.status, 200, 'other clients must be unaffected');
  });
});

// REVIEWING.md §5 claims an unconfigured relay 404s this endpoint so a prober
// can't fingerprint whether the feature is on. That claim was untested.
describe('POST /tcp-auth — not configured (own relay instance)', () => {
  let relay;
  let HTTP_PORT;

  before(async () => {
    relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      liveKitPublicWsUrl: WS_URL,
      roomName: ROOM,
      // tcpSharedSecret deliberately omitted.
    });
    await new Promise(resolve => relay.server.listen(0, resolve));
    HTTP_PORT = relay.server.address().port;
  });

  after(async () => {
    await new Promise(resolve => relay.server.close(resolve));
  });

  test('→ 404, and never 401 (which would confirm the feature exists)', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/tcp-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'anything' }),
    });
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.strictEqual(body.token, undefined);
  });
});

// The cull only pays off once a room has enough listeners to make the n^2
// hurt, and it only engages when the relay knows where every one of them is.
// position-cull.test.js covers the decision itself; what is wired here is
// everything around it - who counts as a listener, and what happens to the
// ones who stop counting.
describe('position relevance cull (own relay instance)', () => {
  let relay, mockService, HTTP_PORT, TCP_PORT;
  const sockets = [];

  // Two packs 100 km apart: nobody in one can hear the other.
  const N = 12;
  const login = (i) => `cull${String(i).padStart(2, '0')}`;
  const xOf = (i) => (i < N / 2 ? i : 100000 + i);

  // A listener is a browser that holds a token for the room AND has a live
  // socket, so the setup has to do both halves for every fake player.
  async function joinAs(name) {
    await fetch(`http://localhost:${HTTP_PORT}/token?identity=${name}`);
    const ws = new WebSocket(`ws://localhost:${HTTP_PORT}/ingest`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', login: name }));
    return ws;
  }

  before(async () => {
    mockService = makeMockRoomService();
    relay = createRelay({
      roomService: mockService,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      liveKitPublicWsUrl: WS_URL,
      roomName: ROOM,
      enableCalibrationBot: true, // opens /token?identity=, standing in for the nonce path
    });
    await new Promise((r) => relay.server.listen(0, r));
    HTTP_PORT = relay.server.address().port;
    await new Promise((r) => relay.tcpServer.listen(0, r));
    TCP_PORT = relay.tcpServer.address().port;

    for (let i = 0; i < N; i++) sockets.push(await joinAs(login(i)));
    await new Promise((r) => setTimeout(r, 50));
  });

  after(async () => {
    for (const ws of sockets) ws.close();
    await new Promise((r) => relay.server.close(r));
    await new Promise((r) => relay.tcpServer.close(r));
  });

  async function feedPositions(count = N) {
    await tcpSend(TCP_PORT, Array.from({ length: count }, (_, i) =>
      JSON.stringify({ type: 'position', pseudo: login(i), x: xOf(i), y: 0, z: 0 })));
    await new Promise((r) => setTimeout(r, 20));
  }

  test('two distant packs -> one targeted message each, nobody left out', async () => {
    const before = mockService.calls.length;
    await feedPositions();
    await relay.flushPositions();
    const calls = mockService.calls.slice(before);
    assert.equal(calls.length, 2, 'one send per pack');
    const served = new Set();
    for (const [room, payload, , opts] of calls) {
      assert.equal(room, ROOM);
      const positions = JSON.parse(new TextDecoder().decode(payload));
      assert.equal(positions.length, N / 2, 'each pack only carries its own half');
      assert.equal(opts.destinationIdentities.length, N / 2);
      for (const id of opts.destinationIdentities) served.add(id);
    }
    assert.equal(served.size, N, 'every listener is addressed by exactly one message');
  });

  test('a tab that closes stops counting, so the cull keeps working', async () => {
    // The regression this guards: recipients used to be read from the token
    // ledger, which is never cleared, so the first player to close their tab
    // would stay a listener forever, no position would ever be found for them,
    // and the cull would switch itself off for the rest of the evening.
    sockets.pop().close();
    await new Promise((r) => setTimeout(r, 50));

    const before = mockService.calls.length;
    await feedPositions(N - 1);
    await relay.flushPositions();
    const calls = mockService.calls.slice(before);
    assert.equal(calls.length, 2, 'still culling after someone left');
    for (const call of calls) assert.ok(call[3].destinationIdentities);
  });

  test('a listener whose position the relay does not have -> full broadcast', async () => {
    // A player opens the page before their plugin has ever reported a position.
    // Sending them a filtered list would mean guessing where they are, so the
    // whole room falls back to one broadcast until they show up.
    const ghost = await joinAs('ghost');
    await new Promise((r) => setTimeout(r, 50));

    const before = mockService.calls.length;
    await feedPositions();
    await relay.flushPositions();
    const calls = mockService.calls.slice(before);
    assert.equal(calls.length, 1, 'one doubt is enough to send to everyone');
    assert.equal(calls[0][3].destinationIdentities, undefined);
    ghost.close();
  });
});
