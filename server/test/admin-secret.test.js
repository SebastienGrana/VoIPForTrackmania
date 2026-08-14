// The TCP shared secret used to be settable only through TCP_SHARED_SECRET in
// the environment, which meant closing port 8081 during an evening cost a
// restart — and a restart drops every plugin in the room. This file covers the
// admin lever that replaces it.
//
// The assertions worth having are the unpleasant ones: that the value never
// comes back out of the relay, that turning it on does not disconnect the
// people already playing, and that turning it off really does reopen the port
// (a lever that silently does nothing is worse than no lever).

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

function makeMockRoomService() {
  return {
    async listRooms(names) { return names.map(name => ({ name })); },
    async sendData() {},
    async listParticipants() { return []; },
  };
}

function openTcp(port, lines) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, '127.0.0.1', () => {
      for (const line of lines) socket.write(`${line}\n`);
      setTimeout(() => resolve(socket), 100);
    });
    socket.resume();
    socket.on('error', reject);
  });
}

const nonce = (fields) => JSON.stringify({ type: 'nonce', nonce: 'n-1', ...fields });

describe('/admin/actions/secret (own relay instance)', () => {
  let relay;
  let PORT;
  let TCP_PORT;
  const sockets = [];

  before(async () => {
    relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY, apiSecret: API_SECRET, liveKitPublicWsUrl: WS_URL, roomName: ROOM,
      statePushIntervalMs: 3_600_000,
      eventLog: nullEventLog,
      adminUser: ADMIN_USER,
      adminPassword: ADMIN_PASS,
      adminActions: true,
      // Boots with no secret, which is how the relay actually runs today.
      tcpSharedSecret: '',
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
  const setSecret = (body, headers = auth) =>
    fetch(`http://localhost:${PORT}/admin/actions/secret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const state = async () =>
    (await fetch(`http://localhost:${PORT}/admin/state.json`, { headers: auth })).json();

  test('needs the admin password', async () => {
    assert.strictEqual((await setSecret({ secret: 'hunter2hunter2' }, {})).status, 401);
  });

  test('refuses a secret that the plugin field or the line protocol would mangle', async () => {
    for (const bad of ['short', 'with space here', 'line\nbreak', 'x'.repeat(129), 'accentué-ok?']) {
      assert.strictEqual((await setSecret({ secret: bad })).status, 400, `accepted: ${JSON.stringify(bad)}`);
    }
    const body = await state();
    assert.strictEqual(body.actions.tcpSecret, false, 'nothing was set by the refused calls');
  });

  test('state.json says whether a secret is in force, never what it is', async () => {
    assert.ok((await setSecret({ secret: 'onz-2026-secret' })).ok);
    const body = await state();
    assert.strictEqual(body.actions.tcpSecret, true);
    assert.ok(!JSON.stringify(body).includes('onz-2026-secret'), 'the value must not appear anywhere in the payload');
  });

  test('a new plugin connection is gated once the secret is set', async () => {
    // Already set by the test above; set it again so this test does not depend
    // on the order the runner picks.
    await setSecret({ secret: 'onz-2026-secret' });

    const rejected = await openTcp(TCP_PORT, [nonce({ login: 'noauth', server: 'srv', serverName: 'Srv' })]);
    sockets.push(rejected);
    await new Promise(r => setTimeout(r, 100));
    const body = await state();
    assert.ok(!body.plugins.some(p => p.login === 'noauth'), 'a connection without the secret must not register');

    const ok = await openTcp(TCP_PORT, [
      JSON.stringify({ type: 'auth', secret: 'onz-2026-secret' }),
      nonce({ login: 'withauth', server: 'srv', serverName: 'Srv' }),
    ]);
    sockets.push(ok);
    const after = await state();
    assert.ok(after.plugins.some(p => p.login === 'withauth'), 'the secret still lets a plugin in');
  });

  test('changing the secret does not disconnect the plugins already in', async () => {
    // This is the whole reason the lever exists instead of a restart: the
    // socket decided it was authenticated at connect time and keeps its place.
    await setSecret({ secret: 'a-brand-new-secret' });
    await new Promise(r => setTimeout(r, 100));
    const body = await state();
    assert.ok(body.plugins.some(p => p.login === 'withauth'), 'the connected plugin stayed');
    assert.strictEqual(body.actions.tcpSecret, true);
  });

  test('/tcp-auth follows the live secret, not the boot one', async () => {
    // The relay booted with no secret at all, so this route 404ed until the
    // admin set one; it must now answer to the current value and reject the old.
    const post = (secret) => fetch(`http://localhost:${PORT}/tcp-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret }),
    });
    assert.strictEqual((await post('onz-2026-secret')).status, 401, 'the replaced secret is dead');
    const res = await post('a-brand-new-secret');
    assert.strictEqual(res.status, 200);
    assert.match((await res.json()).token, /^[0-9a-f]{32}$/);
  });

  test('clearing it reopens the port and hides /tcp-auth again', async () => {
    assert.ok((await setSecret({ secret: '' })).ok);
    assert.strictEqual((await state()).actions.tcpSecret, false);

    const res = await fetch(`http://localhost:${PORT}/tcp-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'a-brand-new-secret' }),
    });
    assert.strictEqual(res.status, 404, 'no secret configured → the route does not exist');

    const plain = await openTcp(TCP_PORT, [nonce({ login: 'plain', server: 'srv', serverName: 'Srv' })]);
    sockets.push(plain);
    assert.ok((await state()).plugins.some(p => p.login === 'plain'), 'the port takes plain connections again');
  });
});

// Same rule as every other lever: without ADMIN_ACTIONS the route must not
// exist, so holding the admin password alone cannot close the port on everyone.
describe('/admin/actions/secret — actions disabled (own relay instance)', () => {
  let relay;
  let PORT;

  before(async () => {
    relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY, apiSecret: API_SECRET, liveKitPublicWsUrl: WS_URL, roomName: ROOM,
      statePushIntervalMs: 3_600_000,
      eventLog: nullEventLog,
      adminUser: ADMIN_USER,
      adminPassword: ADMIN_PASS,
    });
    await new Promise(r => relay.server.listen(0, r));
    PORT = relay.server.address().port;
  });

  after(async () => { await new Promise(r => relay.server.close(r)); });

  test('404 even with the right password', async () => {
    const res = await fetch(`http://localhost:${PORT}/admin/actions/secret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: basic(ADMIN_USER, ADMIN_PASS) },
      body: JSON.stringify({ secret: 'hunter2hunter2' }),
    });
    assert.strictEqual(res.status, 404);
  });
});
