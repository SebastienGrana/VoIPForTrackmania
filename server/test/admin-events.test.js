// The admin page holds a long window of the log so its filter can reach back
// over an evening. Shipping that window on every 2 s poll would be hundreds of
// megabytes an hour to a phone, so the page sends the cursor it already holds
// and the relay answers with new lines only.
//
// The assertion that actually matters here is the unpleasant one: a cursor the
// ring has scrolled past must produce a *full* window, never the remaining
// tail. Answering with the tail would leave a hole in the middle of the log
// exactly where something went wrong, and nothing on the page would say so.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../src/relay.js';
import { createEventLog } from '../src/event-log.js';

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

describe('event-log since()', () => {
  test('returns only what is newer than the cursor', () => {
    const log = createEventLog({ file: null, echo: false });
    log.log('a'); log.log('b'); log.log('c');
    assert.deepStrictEqual(log.since(1).map(e => e.event), ['b', 'c']);
    assert.deepStrictEqual(log.since(3), []);
  });

  test('a cursor ahead of the log is treated as up to date, not as an error', () => {
    // Happens when the relay restarts under a page that is still open: its
    // cursor outruns a counter that started again at zero.
    const log = createEventLog({ file: null, echo: false });
    log.log('a');
    assert.deepStrictEqual(log.since(500), []);
  });

  test('an empty log answers every cursor with nothing', () => {
    const log = createEventLog({ file: null, echo: false });
    assert.deepStrictEqual(log.since(0), []);
  });

  test('seq is in memory only and never written to the line', () => {
    const log = createEventLog({ file: null, echo: false });
    log.log('plugin.connect', { login: 'zi' });
    const [entry] = log.tail(1);
    assert.strictEqual(entry.seq, 1);
    assert.strictEqual(entry.login, 'zi');
    assert.strictEqual(log.seq, 1);
  });
});

describe('/admin/state.json?sinceEvent (own relay instance)', () => {
  let relay;
  let PORT;
  let eventLog;

  before(async () => {
    eventLog = createEventLog({ file: null, echo: false });
    relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY, apiSecret: API_SECRET, liveKitPublicWsUrl: WS_URL, roomName: ROOM,
      statePushIntervalMs: 3_600_000,
      eventLog,
      adminUser: ADMIN_USER,
      adminPassword: ADMIN_PASS,
    });
    await new Promise(r => relay.server.listen(0, r));
    PORT = relay.server.address().port;
  });

  after(async () => { await new Promise(r => relay.server.close(r)); });

  const auth = { authorization: basic(ADMIN_USER, ADMIN_PASS) };
  const state = async (qs = '') =>
    (await fetch(`http://localhost:${PORT}/admin/state.json${qs}`, { headers: auth })).json();

  test('a first load gets the whole window, newest first', async () => {
    eventLog.log('one'); eventLog.log('two');
    const body = await state();
    assert.strictEqual(body.eventsFull, true);
    assert.deepStrictEqual(body.events.map(e => e.event), ['two', 'one']);
    assert.strictEqual(body.eventSeq, 2);
  });

  test('a following poll gets the new lines only', async () => {
    const first = await state();
    eventLog.log('three');
    const body = await state(`?sinceEvent=${first.eventSeq}`);
    assert.strictEqual(body.eventsFull, false);
    assert.deepStrictEqual(body.events.map(e => e.event), ['three']);
  });

  test('a quiet poll costs an empty array, not a window', async () => {
    const first = await state();
    const body = await state(`?sinceEvent=${first.eventSeq}`);
    assert.deepStrictEqual(body.events, []);
    assert.strictEqual(body.eventsFull, false);
  });

  test('a junk cursor falls back to the full window rather than 400ing', async () => {
    // The page is the only caller, but a stale tab or a hand-typed URL must not
    // be able to make the admin page show an empty log.
    for (const qs of ['?sinceEvent=abc', '?sinceEvent=-1', '?sinceEvent=1.5']) {
      const body = await state(qs);
      assert.strictEqual(body.eventsFull, true, `bad cursor accepted: ${qs}`);
      assert.ok(body.events.length > 0);
    }
  });
});

describe('/admin/state.json?sinceEvent — cursor scrolled out of the ring', () => {
  let relay;
  let PORT;
  let eventLog;

  before(async () => {
    eventLog = createEventLog({ file: null, echo: false });
    relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY, apiSecret: API_SECRET, liveKitPublicWsUrl: WS_URL, roomName: ROOM,
      statePushIntervalMs: 3_600_000,
      eventLog,
      adminUser: ADMIN_USER,
      adminPassword: ADMIN_PASS,
    });
    await new Promise(r => relay.server.listen(0, r));
    PORT = relay.server.address().port;
  });

  after(async () => { await new Promise(r => relay.server.close(r)); });

  const auth = { authorization: basic(ADMIN_USER, ADMIN_PASS) };

  test('a page left behind gets a full window, never a tail with a hole in it', async () => {
    // 1200 lines through a 1000-line ring: cursor 1 is long gone.
    for (let i = 0; i < 1200; i += 1) eventLog.log(`e${i}`);
    const res = await fetch(`http://localhost:${PORT}/admin/state.json?sinceEvent=1`, { headers: auth });
    const body = await res.json();
    assert.strictEqual(body.eventsFull, true, 'the page must be told to replace its window');
    assert.strictEqual(body.events.length, 1000);
    assert.strictEqual(body.events[0].event, 'e1199', 'newest first');
    assert.strictEqual(body.eventSeq, 1200);
  });
});
