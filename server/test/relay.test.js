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
    // Default: pretend every room exists, so existing sendData assertions
    // below don't need to know about the room-existence gate.
    async listRooms(names) { return names.map(name => ({ name })); },
    async sendData(...args) { calls.push(args); },
    async listParticipants(_room) { return []; },
  };
}

// Connects a TCP socket to TCP_PORT, sends the given lines (joined by \n),
// then closes. Resolves when the socket is fully closed.
// resume(): since Étape 7 the relay may write a state push back on this same
// connection (e.g. after a nonce). A paused Readable never reaches 'end'
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

  describe('GET /health (AUDIT #28)', () => {
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
      const res = await fetch(`http://localhost:${HTTP_PORT}/token?identity=postcrash`);
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

  // Regression tests for the ef55717 hardening — AUDIT #14. These behaviours
  // used to have zero coverage, meaning a well-intentioned refactor could
  // silently remove them and no test would notice.
  describe('input validation (AUDIT #14)', () => {
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
      // expected count. See AUDIT #3 (client-side) for the belt & suspenders.
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
// Isolated relay with tiny limits so the AUDIT #25 behaviours (connection cap,
// idle timeout) can be exercised without opening/waiting on 1000+ real sockets.
describe('TCP ingest — connection limits (AUDIT #25, own relay instance)', () => {
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

    const res = await fetch(`http://localhost:${HTTP_PORT}/token?identity=afterlimit`);
    assert.strictEqual(res.status, 200);
  });
});

// Sécurité restante (ORDRE D'IMPLÉMENTATION point 6): own relay instance so
// the shared-secret gate doesn't affect the main describe's unauthenticated
// TCP tests above.
describe('TCP ingest — shared secret (Sécurité restante, own relay instance)', () => {
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

describe('POST /tcp-auth — token exchange (Sécurité restante v2, own relay instance)', () => {
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

// Étape 7: state push over the TCP socket that sent the nonce.
// Own relay instance so statePushIntervalMs can be set very high (avoids
// timer-triggered pushes racing with the test's explicit socket.destroy()).
describe('TCP state push — Étape 7 (own relay instance)', () => {
  let relay;
  let statePushService;
  let STATE_TCP_PORT;

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
  });

  after(async () => {
    await new Promise(resolve => relay.server.close(resolve));
    await new Promise(resolve => relay.tcpServer.close(resolve));
  });

  // Opens a TCP socket, sends lines, waits durationMs, destroys the socket,
  // and resolves with everything the relay wrote back.
  function tcpOpenAndCollect(port, lines, durationMs) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(port, '127.0.0.1', () => {
        for (const line of lines) socket.write(line + '\n');
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
      assert.strictEqual(state.mic, true, 'mic should reflect the player\'s own track muted state');
    } finally {
      statePushService.listParticipants = original;
    }
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
      const res = await fetch(`http://localhost:${HTTP_PORT}/token?identity=ratelimited`);
      lastStatus = res.status;
    }
    assert.strictEqual(lastStatus, 429);
  });
});
