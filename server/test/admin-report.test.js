// Tests for the three pieces added for the first public test evening: the
// event log, the /admin dashboard behind Basic auth, and the /report endpoint
// the web client's "Report a problem" button posts to.
//
// The security-shaped assertions here are the point of the file. An admin page
// is only as good as its lock, and a lock nobody tests is a lock nobody knows
// is open.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRelay } from '../src/relay.js';
import { createEventLog, nullEventLog } from '../src/event-log.js';

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

// Opens a TCP socket and leaves it open, so the login stays in the relay's
// connected map while HTTP assertions run against /admin/state.json.
function openTcp(port, lines) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, '127.0.0.1', () => {
      for (const line of lines) socket.write(`${line}\n`);
      // One tick of slack so the relay has parsed the lines before the caller
      // asks the admin route what it knows.
      setTimeout(() => resolve(socket), 100);
    });
    socket.resume(); // drain the state push, or 'close' never fires later
    socket.on('error', reject);
  });
}

const nonce = (fields) => JSON.stringify({ type: 'nonce', nonce: 'n-1', ...fields });

describe('event log', () => {
  let dir;

  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onzvoip-log-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('writes one JSON object per line, with a timestamp and the event name', () => {
    const file = path.join(dir, 'events.log');
    const log = createEventLog({ file, echo: false });
    log.log('plugin.connect', { login: 'velp', version: '0.3.1' });
    log.log('plugin.disconnect', { login: 'velp', heldSeconds: 12 });

    // The stream is async; the tail is not, and it is what /admin reads.
    const entries = log.tail(10);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].event, 'plugin.connect');
    assert.strictEqual(entries[0].login, 'velp');
    assert.ok(!Number.isNaN(Date.parse(entries[0].ts)), 'ts must parse as a date');
    assert.strictEqual(entries[1].heldSeconds, 12);
  });

  test('tail(n) returns the newest n, oldest first', () => {
    const log = createEventLog({ file: null, echo: false });
    for (let i = 0; i < 10; i++) log.log('tick', { i });
    const last3 = log.tail(3);
    assert.deepStrictEqual(last3.map(e => e.i), [7, 8, 9]);
  });

  test('an unwritable path degrades to "no log" instead of throwing', () => {
    // A path whose parent is an existing FILE cannot be created as a directory.
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const log = createEventLog({ file: path.join(blocker, 'events.log'), echo: false });
    log.log('plugin.connect', { login: 'velp' }); // must not throw
    assert.strictEqual(log.file, null, 'file getter must report the log as inactive');
    assert.strictEqual(log.tail(1).length, 1, 'in-memory tail still works without a file');
  });

  test('an unserialisable field is dropped, not thrown', () => {
    const log = createEventLog({ file: null, echo: false });
    const circular = {}; circular.self = circular;
    log.log('weird', { circular });
    assert.strictEqual(log.tail(10).length, 0, 'the entry is skipped');
    log.log('after', {});
    assert.strictEqual(log.tail(10)[0].event, 'after', 'the log keeps working');
  });

  test('nullEventLog swallows everything and tails empty', () => {
    nullEventLog.log('anything', { a: 1 });
    assert.deepStrictEqual(nullEventLog.tail(5), []);
    assert.strictEqual(nullEventLog.file, null);
  });
});

describe('/admin — not configured (own relay instance)', () => {
  let relay;
  let PORT;

  before(async () => {
    relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY, apiSecret: API_SECRET, liveKitPublicWsUrl: WS_URL, roomName: ROOM,
      // adminUser / adminPassword deliberately omitted.
    });
    await new Promise(r => relay.server.listen(0, r));
    PORT = relay.server.address().port;
  });

  after(async () => { await new Promise(r => relay.server.close(r)); });

  test('→ 404, never 401: an unconfigured page must not confirm it exists', async () => {
    for (const url of ['/admin', '/admin/state.json']) {
      const res = await fetch(`http://localhost:${PORT}${url}`);
      assert.strictEqual(res.status, 404, `${url} should 404`);
      assert.strictEqual(res.headers.get('www-authenticate'), null,
        `${url} must not send a challenge — that is a "yes, this exists"`);
    }
  });

  test('valid credentials do not open it either', async () => {
    const res = await fetch(`http://localhost:${PORT}/admin/state.json`, {
      headers: { authorization: basic(ADMIN_USER, ADMIN_PASS) },
    });
    assert.strictEqual(res.status, 404);
  });
});

describe('/admin and /report (own relay instance)', () => {
  let relay;
  let PORT;
  let TCP_PORT;
  let eventLog;
  const sockets = [];

  before(async () => {
    eventLog = createEventLog({ file: null, echo: false });
    relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY, apiSecret: API_SECRET, liveKitPublicWsUrl: WS_URL, roomName: ROOM,
      statePushIntervalMs: 3_600_000, // no timer-driven pushes mid-test
      eventLog,
      adminUser: ADMIN_USER,
      adminPassword: ADMIN_PASS,
      // The real ceiling is 5/min per IP, and every test here posts from
      // 127.0.0.1 — the setup alone would spend it. The limit itself gets its
      // own relay instance below, at its real value.
      reportRateLimit: { windowMs: 60_000, max: 1000 },
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

  const state = async (headers = { authorization: basic(ADMIN_USER, ADMIN_PASS) }) =>
    fetch(`http://localhost:${PORT}/admin/state.json`, { headers });

  describe('Basic auth', () => {
    test('no header → 401 with a challenge', async () => {
      const res = await state({});
      assert.strictEqual(res.status, 401);
      assert.match(res.headers.get('www-authenticate') ?? '', /^Basic realm=/);
    });

    test('wrong password → 401', async () => {
      const res = await state({ authorization: basic(ADMIN_USER, 'wrong') });
      assert.strictEqual(res.status, 401);
    });

    test('wrong user, right password → 401', async () => {
      const res = await state({ authorization: basic('someone', ADMIN_PASS) });
      assert.strictEqual(res.status, 401);
    });

    test('a password that is a prefix of the real one → 401', async () => {
      // Guards the hash-then-timingSafeEqual comparison: a naive
      // startsWith/slice implementation would let this through.
      const res = await state({ authorization: basic(ADMIN_USER, ADMIN_PASS.slice(0, 4)) });
      assert.strictEqual(res.status, 401);
    });

    test('malformed header → 401, not a crash', async () => {
      for (const header of ['Basic', 'Basic !!!not-base64!!!', 'Bearer abc', basic('nocolon', '').replace(/=+$/, '')]) {
        const res = await state({ authorization: header });
        assert.strictEqual(res.status, 401, `header ${header}`);
      }
      // The relay is still alive after all of that.
      assert.strictEqual((await fetch(`http://localhost:${PORT}/health`)).status, 200);
    });

    test('correct credentials → 200 JSON, and /admin serves the page', async () => {
      const res = await state();
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(body.counts, 'state.json must carry counts');

      const page = await fetch(`http://localhost:${PORT}/admin`, {
        headers: { authorization: basic(ADMIN_USER, ADMIN_PASS) },
      });
      assert.strictEqual(page.status, 200);
      const html = await page.text();
      assert.match(html, /OnZVoIP/, 'the admin page should actually be the admin page');
    });

    test('the admin page is not reachable through the static file server', async () => {
      // It lives in src/, not public/, precisely so express.static cannot
      // serve it without a password. If this ever 200s, it moved.
      const res = await fetch(`http://localhost:${PORT}/admin.html`);
      assert.notStrictEqual(res.status, 200);
    });

    test('a refused attempt is logged', async () => {
      await state({});
      assert.ok(eventLog.tail(50).some(e => e.event === 'admin.denied'));
    });
  });

  describe('plugin version reporting', () => {
    test('a nonce carrying a version shows up in the admin state', async () => {
      const socket = await openTcp(TCP_PORT, [
        nonce({ login: 'velp', server: 'srv-1', serverName: 'ONZ #1', version: '0.3.1' }),
      ]);
      sockets.push(socket);

      const body = await (await state()).json();
      const row = body.plugins.find(p => p.login === 'velp');
      assert.ok(row, 'the connected plugin should be listed');
      assert.strictEqual(row.version, '0.3.1');
      assert.strictEqual(row.serverName, 'ONZ #1');
      // Connected, but no position sent yet — the distinction the dashboard
      // uses to tell "in a menu" from "actually driving".
      assert.strictEqual(row.positionAgeSeconds, null);
      assert.strictEqual(typeof row.connectedSeconds, 'number');
    });

    test('a junk version is dropped rather than displayed', async () => {
      const socket = await openTcp(TCP_PORT, [
        nonce({ login: 'junkver', server: 'srv-1', version: '<script>alert(1)</script>' }),
      ]);
      sockets.push(socket);

      const body = await (await state()).json();
      const row = body.plugins.find(p => p.login === 'junkver');
      assert.ok(row);
      assert.strictEqual(row.version, null, 'anything outside [a-z0-9._+-] must not reach the page');
    });

    test('an over-long version is dropped', async () => {
      const socket = await openTcp(TCP_PORT, [
        nonce({ login: 'longver', server: 'srv-1', version: '1'.repeat(64) }),
      ]);
      sockets.push(socket);

      const body = await (await state()).json();
      assert.strictEqual(body.plugins.find(p => p.login === 'longver').version, null);
    });

    test('an old plugin that sends no version is listed with version null', async () => {
      const socket = await openTcp(TCP_PORT, [
        nonce({ login: 'oldbuild', server: 'srv-1' }),
      ]);
      sockets.push(socket);

      const body = await (await state()).json();
      const row = body.plugins.find(p => p.login === 'oldbuild');
      assert.ok(row, 'an old build must still connect and still be visible');
      assert.strictEqual(row.version, null);
    });

    test('changing server keeps the version and the original connect time', async () => {
      const socket = await openTcp(TCP_PORT, [
        nonce({ login: 'mover', server: 'srv-1', version: '0.3.1' }),
      ]);
      sockets.push(socket);
      const before = (await (await state()).json()).plugins.find(p => p.login === 'mover');

      // Same socket, new room, and — as an old build would — no version this
      // time. The row must not lose what it already knew.
      socket.write(`${JSON.stringify({ type: 'nonce', nonce: 'n-2', login: 'mover', server: 'srv-2' })}\n`);
      await new Promise(r => setTimeout(r, 100));

      const after = (await (await state()).json()).plugins.find(p => p.login === 'mover');
      assert.strictEqual(after.version, '0.3.1', 'version must survive a room change');
      assert.ok(after.connectedSeconds >= before.connectedSeconds,
        'connectedAt must not reset when the player merely changes server');
      assert.ok(eventLog.tail(100).some(e => e.event === 'plugin.room' && e.login === 'mover'));
    });

    test('connecting is logged with the version', async () => {
      assert.ok(eventLog.tail(100).some(
        e => e.event === 'plugin.connect' && e.login === 'velp' && e.version === '0.3.1'));
    });
  });

  describe('POST /report', () => {
    const post = (body, headers = {}) => fetch(`http://localhost:${PORT}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    test('an empty message → 400', async () => {
      assert.strictEqual((await post({ message: '   ' })).status, 400);
      assert.strictEqual((await post({})).status, 400);
    });

    test('a report reaches the admin page and the event log', async () => {
      const res = await post({ message: 'I hear Bob but Bob cannot hear me', login: 'velp', room: 'srv-1' });
      assert.strictEqual(res.status, 200);

      const body = await (await state()).json();
      const report = body.reports.find(r => r.message.startsWith('I hear Bob'));
      assert.ok(report, 'the report should be on the dashboard');
      assert.strictEqual(report.login, 'velp');
      assert.strictEqual(report.room, 'srv-1');
      assert.ok(eventLog.tail(100).some(e => e.event === 'report'));
    });

    test('the version comes from the plugin connection, not from the browser', async () => {
      // "velp" is connected above on 0.3.1. A browser claiming otherwise must
      // not be believed — a wrong version is the likeliest cause of a report.
      await post({ message: 'version check', login: 'velp', version: '9.9.9-lies' });
      const body = await (await state()).json();
      const report = body.reports.find(r => r.message === 'version check');
      assert.strictEqual(report.version, '0.3.1');
    });

    test('an unknown login reports no version rather than a made-up one', async () => {
      await post({ message: 'nobody here', login: 'ghostplayer' });
      const body = await (await state()).json();
      assert.strictEqual(body.reports.find(r => r.message === 'nobody here').version, null);
    });

    test('oversized fields are clamped, not rejected', async () => {
      await post({ message: 'x'.repeat(5000), login: 'velp', room: 'r'.repeat(500), state: 's'.repeat(2000) });
      const body = await (await state()).json();
      const report = body.reports.find(r => r.message.startsWith('xxxx'));
      assert.strictEqual(report.message.length, 1000);
      assert.strictEqual(report.room.length, 128);
      assert.strictEqual(report.state.length, 500);
    });

    test('an unusable login is dropped, and the report is still kept', async () => {
      // validateLogin() only clamps length — the relay does not claim to know
      // what a TM login may contain, and the field is escaped where it is
      // rendered. What must not get through is a login used as a storage trick.
      await post({ message: 'bad login test', login: 'x'.repeat(200) });
      const body = await (await state()).json();
      const report = body.reports.find(r => r.message === 'bad login test');
      assert.ok(report, 'a report is worth keeping even when we cannot say who sent it');
      assert.strictEqual(report.login, null);
    });

    test('the report list is not reachable without the admin password', async () => {
      const res = await fetch(`http://localhost:${PORT}/admin/state.json`);
      assert.strictEqual(res.status, 401);
    });
  });

  describe('POST /report — the real rate limit (own relay instance)', () => {
    let limited;
    let LIMITED_PORT;

    before(async () => {
      limited = createRelay({
        roomService: makeMockRoomService(),
        apiKey: API_KEY, apiSecret: API_SECRET, liveKitPublicWsUrl: WS_URL, roomName: ROOM,
        // Default reportRateLimit on purpose: this is the shipped value.
      });
      await new Promise(r => limited.server.listen(0, r));
      LIMITED_PORT = limited.server.address().port;
    });

    after(async () => { await new Promise(r => limited.server.close(r)); });

    test('a flood is cut off at 429, and the relay stays up', async () => {
      const codes = [];
      for (let i = 0; i < 12; i++) {
        const res = await fetch(`http://localhost:${LIMITED_PORT}/report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: `flood ${i}` }),
        });
        codes.push(res.status);
      }
      assert.strictEqual(codes.filter(c => c === 200).length, 5, 'exactly the allowance gets through');
      assert.ok(codes.includes(429), 'the rest are refused');
      assert.strictEqual((await fetch(`http://localhost:${LIMITED_PORT}/health`)).status, 200);
    });
  });

  describe('state.json counts', () => {
    test('counts pair the game half with the browser half', async () => {
      const body = await (await state()).json();
      const c = body.counts;
      assert.strictEqual(c.plugins, body.plugins.length);
      assert.strictEqual(c.browsers, body.browsers.length);
      // Several plugins connected above, no browser at all in this suite.
      assert.ok(c.plugins > 0);
      assert.strictEqual(c.paired, 0);
      assert.strictEqual(c.pluginOnly, c.plugins);
      assert.strictEqual(typeof body.uptimeSeconds, 'number');
      assert.strictEqual(body.debugMode, false);
    });
  });
});
