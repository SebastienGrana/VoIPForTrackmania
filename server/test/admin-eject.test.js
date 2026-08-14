// Ejecting a *named* player, as opposed to a LiveKit ghost.
//
// The reason this is not one line calling removeParticipant: a player is three
// things at once — a plugin on TCP, a tab on the WebSocket, and a participant
// in LiveKit — plus a pending nonce that mints a fresh publish-capable token on
// demand. Cutting only the LiveKit half is undone in about two seconds, because
// the plugin reconnects on its own and hands the tab a new link.
//
// So the assertions that matter here are the ones about coming *back*: that
// after an eject every door says no for the duration, that a zero-minute eject
// really does let the player return at once, and that unblocking works — a
// player silently unable to join for the rest of the evening is a worse bug
// than one who was never ejected.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRelay } from '../src/relay.js';
import { nullEventLog } from '../src/event-log.js';

const API_KEY    = 'testApiKey1234567890';
const API_SECRET = 'testApiSecret12345678901234567890';
const WS_URL     = 'wss://test.example.com';
const ROOM       = 'testroom';
const ADMIN_USER = 'onz';
const ADMIN_PASS = 'sup3r-secret';

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

function makeMockRoomService(removed) {
  return {
    async listRooms(names) { return names.map(name => ({ name })); },
    async sendData() {},
    async listParticipants() { return []; },
    async removeParticipant(room, identity) { removed.push(`${room}/${identity}`); },
  };
}

function openTcp(port, lines) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, '127.0.0.1', () => {
      for (const line of lines) socket.write(`${line}\n`);
      setTimeout(() => resolve(socket), 100);
    });
    socket.resume();
    socket.on('error', () => {}); // an ejected socket is destroyed under us
    socket.on('connect', () => {});
    setTimeout(() => reject(new Error('tcp connect timeout')), 2000).unref?.();
  });
}

const nonceMsg = (nonce, login) => JSON.stringify({ type: 'nonce', nonce, login });

const closed = (socket) => new Promise((resolve) => {
  if (socket.destroyed) { resolve(true); return; }
  socket.once('close', () => resolve(true));
  setTimeout(() => resolve(socket.destroyed), 500);
});

describe('/admin/actions/eject (own relay instance)', () => {
  let relay;
  let PORT;
  let TCP_PORT;
  let removed;
  const sockets = [];

  before(async () => {
    removed = [];
    relay = createRelay({
      roomService: makeMockRoomService(removed),
      apiKey: API_KEY, apiSecret: API_SECRET, liveKitPublicWsUrl: WS_URL, roomName: ROOM,
      statePushIntervalMs: 3_600_000,
      eventLog: nullEventLog,
      adminUser: ADMIN_USER,
      adminPassword: ADMIN_PASS,
      adminActions: true,
      // The event runs with debug on, so the query-string path is a real door
      // and not a hypothetical one.
      debugMode: true,
    });
    await new Promise(r => relay.server.listen(0, r));
    await new Promise(r => relay.tcpServer.listen(0, r));
    PORT = relay.server.address().port;
    TCP_PORT = relay.tcpServer.address().port;
  });

  after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise(r => relay.server.close(r));
    await new Promise(r => relay.tcpServer.close(r));
  });

  const auth = { authorization: basic(ADMIN_USER, ADMIN_PASS) };
  const post = (path, body, headers = auth) =>
    fetch(`http://localhost:${PORT}/admin/actions/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const token = (qs) => fetch(`http://localhost:${PORT}/token${qs}`);
  const state = async () =>
    (await fetch(`http://localhost:${PORT}/admin/state.json`, { headers: auth })).json();

  test('a link that worked a second ago is refused once its owner is ejected', async () => {
    const plugin = await openTcp(TCP_PORT, [nonceMsg('nonce-ok-1', 'shouty')]);
    sockets.push(plugin);

    const before = await token('?t=nonce-ok-1');
    assert.strictEqual(before.status, 200, 'baseline: the normal path works');

    const plugin2 = await openTcp(TCP_PORT, [nonceMsg('nonce-ok-2', 'shouty')]);
    sockets.push(plugin2);

    const res = await post('eject', { login: 'shouty', minutes: 15 });
    assert.strictEqual(res.status, 200);

    // The nonce the game is showing right now is part of the eject: leaving it
    // alive would hand out a fresh token to a player we just cut off.
    const after = await token('?t=nonce-ok-2');
    assert.strictEqual(after.status, 401, 'the pending nonce must be gone');

    // And the plugin's own socket goes with it, so it stops publishing positions.
    assert.ok(await closed(plugin2), 'the plugin socket must be cut');

    // The LiveKit half too, in the room the relay knew about.
    assert.ok(removed.some(r => r.endsWith('/shouty')), 'removeParticipant was never called');
  });

  test('the debug path cannot be used to walk back in under the same name', async () => {
    // This is the door DEBUG_MODE opens: identity straight from the query
    // string. Without the check it is the obvious way around an eject.
    const res = await token('?identity=shouty');
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(await res.json(), { error: 'blocked' });
  });

  test('a fresh nonce for a blocked login is refused as well', async () => {
    const plugin = await openTcp(TCP_PORT, [nonceMsg('nonce-after', 'shouty')]);
    sockets.push(plugin);
    const res = await token('?t=nonce-after');
    assert.strictEqual(res.status, 403, 'reconnecting must not clear the block');
  });

  test('nobody else is caught by the block', async () => {
    const res = await token('?identity=quiet');
    assert.strictEqual(res.status, 200);
  });

  test('the block is visible on the admin page, with a countdown', async () => {
    // A block nobody can see is a player mysteriously unable to join half an
    // hour later, with no way to tell why.
    const body = await state();
    const row = (body.blocked || []).find(b => b.login === 'shouty');
    assert.ok(row, 'the blocked login is missing from state.json');
    assert.ok(row.secondsLeft > 0 && row.secondsLeft <= 15 * 60, `odd countdown: ${row.secondsLeft}`);
  });

  test('unblocking lets the player straight back in', async () => {
    const res = await post('unblock', { login: 'shouty' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await token('?identity=shouty')).status, 200);
    const body = await state();
    assert.deepStrictEqual((body.blocked || []).map(b => b.login), []);
  });

  test('minutes: 0 ejects without blocking', async () => {
    // "Get out of that room" without "sit out the next quarter of an hour":
    // the common case of someone in the wrong team's channel.
    const res = await post('eject', { login: 'quiet', minutes: 0 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await token('?identity=quiet')).status, 200, 'a 0-minute eject must not block');
  });

  test('a missing or junk login is refused, not blocked', async () => {
    for (const body of [{}, { login: '' }, { login: 42 }]) {
      const res = await post('eject', body);
      assert.strictEqual(res.status, 400, `accepted: ${JSON.stringify(body)}`);
    }
    assert.deepStrictEqual((await state()).blocked, []);
  });

  test('without the admin password it is not an endpoint at all', async () => {
    const res = await post('eject', { login: 'shouty' }, { authorization: basic(ADMIN_USER, 'wrong') });
    assert.strictEqual(res.status, 401);
  });
});

describe('/admin/actions/eject without ADMIN_ACTIONS', () => {
  let relay;
  let PORT;

  before(async () => {
    relay = createRelay({
      roomService: makeMockRoomService([]),
      apiKey: API_KEY, apiSecret: API_SECRET, liveKitPublicWsUrl: WS_URL, roomName: ROOM,
      statePushIntervalMs: 3_600_000,
      eventLog: nullEventLog,
      adminUser: ADMIN_USER,
      adminPassword: ADMIN_PASS,
      // adminActions left off: the read-only deployment.
    });
    await new Promise(r => relay.server.listen(0, r));
    PORT = relay.server.address().port;
  });

  after(async () => { await new Promise(r => relay.server.close(r)); });

  test('both routes are 404, matching every other action', async () => {
    for (const path of ['eject', 'unblock']) {
      const res = await fetch(`http://localhost:${PORT}/admin/actions/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: basic(ADMIN_USER, ADMIN_PASS) },
        body: JSON.stringify({ login: 'shouty' }),
      });
      assert.strictEqual(res.status, 404, path);
    }
  });
});
