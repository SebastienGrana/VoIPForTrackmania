// Tests for server/public/app.js — the browser client's spatial-audio math
// wiring, calibration UI, and LiveKit/ingest reconnection flows.
//
// app.js is a plain browser script (not a DI-friendly factory like relay.js):
// it wires up DOM listeners and starts timers as side effects at import time.
// installDomStubs() (./dom-stub.js) installs a minimal global environment
// covering exactly the DOM/WebAudio/WebSocket/LiveKit surface it touches, then
// this file imports app.js once (module caching means it can only run its
// top-level code once per process) and drives it through its exported
// internals for the rest of the suite.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDomStubs } from './dom-stub.js';

const stub = installDomStubs();
const app = await import('../public/app.js');

// Establishes room/audioCtx once for the whole suite; DataReceived tests rely
// on this room instance still being the one attachRoomEvents() wired up.
await app.connectLiveKit({ token: 'tok', wsUrl: 'ws://fake', roomName: 'room1', login: 'me', serverName: null });

beforeEach(() => {
  app.peers.clear();
  app.gains.clear();
  app.audioNodes.clear();
  app.audioPublications.clear();
  app.subscribedPeers.clear();
  app.me.x = 200; app.me.y = 0; app.me.z = 200;

  // Reset calibration back through the app's own slider-clamp path (MIN_DIST/
  // MAX_DIST/PAN_RANGE are live-bound exports, read-only from here).
  stub.elements.maxDist.value = '150'; stub.elements.maxDist.dispatch('input');
  stub.elements.minDist.value = '1'; stub.elements.minDist.dispatch('input');
  stub.elements.panRange.value = '10'; stub.elements.panRange.dispatch('input');

  stub.elements.relativeMode.checked = false;
  stub.elements.relativeTarget.value = '';
  stub.elements.relativeOffsetX.value = '0';
  stub.elements.relativeOffsetY.value = '0';
  stub.elements.followGame.checked = false;

  stub.setFetch(async () => { throw new Error('fetch not mocked for this test'); });
});

describe('gainLabel()', () => {
  test('very close', () => assert.strictEqual(app.gainLabel(0.9), 'Very close'));
  test('boundary 0.8 is exclusive -> Close', () => assert.strictEqual(app.gainLabel(0.8), 'Close'));
  test('close', () => assert.strictEqual(app.gainLabel(0.6), 'Close'));
  test('boundary 0.5 is exclusive -> Nearby', () => assert.strictEqual(app.gainLabel(0.5), 'Nearby'));
  test('nearby', () => assert.strictEqual(app.gainLabel(0.2), 'Nearby'));
  test('boundary 0.15 is exclusive -> Far away', () => assert.strictEqual(app.gainLabel(0.15), 'Far away'));
  test('far away', () => assert.strictEqual(app.gainLabel(0.05), 'Far away'));
  test('boundary 0.01 is exclusive -> Out of range', () => assert.strictEqual(app.gainLabel(0.01), 'Out of range'));
  test('out of range', () => assert.strictEqual(app.gainLabel(0), 'Out of range'));
});

describe('decodePosition()', () => {
  test('valid JSON payload round-trips', () => {
    const data = [{ pseudo: 'bob', x: 1, y: 2, z: 3 }];
    const payload = new TextEncoder().encode(JSON.stringify(data));
    assert.deepStrictEqual(app.decodePosition(payload), data);
  });

  test('malformed payload -> null', () => {
    const payload = new TextEncoder().encode('not valid json{{{');
    assert.strictEqual(app.decodePosition(payload), null);
  });
});

describe('worldToScreen()', () => {
  test('a peer at "me"\'s position maps to canvas centre', () => {
    const p = app.worldToScreen({ x: app.me.x, z: app.me.z }, 1);
    assert.strictEqual(p.x, 200);
    assert.strictEqual(p.y, 200);
  });

  test('offset from "me" scales by the given factor', () => {
    const p = app.worldToScreen({ x: app.me.x + 10, z: app.me.z - 5 }, 2);
    assert.strictEqual(p.x, 220);
    assert.strictEqual(p.y, 190);
  });
});

describe('applyRelativeMode()', () => {
  test('no-op when relative mode is off', () => {
    stub.elements.relativeTarget.value = 'bob';
    app.peers.set('bob', { x: 999, y: 9, z: 999, lastSeen: Date.now() });
    app.applyRelativeMode();
    assert.strictEqual(app.me.x, 200);
    assert.strictEqual(app.me.z, 200);
  });

  test('no-op when the target has no known position yet', () => {
    stub.elements.relativeMode.checked = true;
    stub.elements.relativeTarget.value = 'ghost';
    app.applyRelativeMode();
    assert.strictEqual(app.me.x, 200);
  });

  test('follows the target plus the configured offset', () => {
    stub.elements.relativeMode.checked = true;
    stub.elements.relativeTarget.value = 'bob';
    stub.elements.relativeOffsetX.value = '3';
    stub.elements.relativeOffsetY.value = '-4';
    app.peers.set('bob', { x: 50, y: 5, z: 60, lastSeen: Date.now() });
    app.applyRelativeMode();
    assert.strictEqual(app.me.x, 53);
    assert.strictEqual(app.me.z, 56);
    assert.strictEqual(app.me.y, 5);
  });
});

describe('tickGains()', () => {
  test('first observation snaps current gain straight to target', () => {
    app.peers.set('alice', { x: app.me.x + 0.5, y: 0, z: app.me.z, lastSeen: Date.now() });
    app.tickGains();
    const g = app.gains.get('alice');
    assert.strictEqual(g.target, 1); // within MIN_DIST -> full volume
    assert.strictEqual(g.current, 1);
  });

  test('later ticks lerp current toward a changed target instead of snapping', () => {
    app.peers.set('alice', { x: app.me.x + 0.5, y: 0, z: app.me.z, lastSeen: Date.now() });
    app.tickGains(); // current snaps to 1
    app.peers.set('alice', { x: app.me.x + 150, y: 0, z: app.me.z, lastSeen: Date.now() }); // now at MAX_DIST -> target 0
    app.tickGains();
    const g = app.gains.get('alice');
    assert.strictEqual(g.target, 0);
    assert.ok(g.current > 0 && g.current < 1, `expected a partial lerp, got ${g.current}`);
    assert.ok(Math.abs(g.current - 0.85) < 1e-9, `expected ~0.85 (LERP_FACTOR=0.15), got ${g.current}`);
  });

  test('a stale peer (no update in over 3s) is forced silent regardless of distance', () => {
    app.peers.set('alice', { x: app.me.x + 0.5, y: 0, z: app.me.z, lastSeen: Date.now() - 4000 });
    app.tickGains();
    const g = app.gains.get('alice');
    assert.strictEqual(g.target, 0);
    assert.strictEqual(g.current, 0);
  });

  test('subscribes to a peer\'s audio once it comes into range', () => {
    const calls = [];
    app.peers.set('alice', { x: app.me.x + 10, y: 0, z: app.me.z, lastSeen: Date.now() });
    app.audioPublications.set('alice', { setSubscribed: (v) => calls.push(v) });
    app.tickGains();
    assert.deepStrictEqual(calls, [true]);
    assert.ok(app.subscribedPeers.has('alice'));
  });

  test('unsubscribes once well past MAX_DIST * UNSUBSCRIBE_MARGIN', () => {
    const calls = [];
    app.peers.set('alice', { x: app.me.x + 10, y: 0, z: app.me.z, lastSeen: Date.now() });
    app.audioPublications.set('alice', { setSubscribed: (v) => calls.push(v) });
    app.tickGains(); // subscribes (dist=10, well inside range)
    app.peers.set('alice', { x: app.me.x + 500, y: 0, z: app.me.z, lastSeen: Date.now() });
    app.tickGains(); // dist=500 >> 150*1.2 -> unsubscribes
    assert.deepStrictEqual(calls, [true, false]);
    assert.ok(!app.subscribedPeers.has('alice'));
  });

  test('drives an active WebAudio node toward the target gain and pan', () => {
    const gainCalls = [];
    const panCalls = [];
    app.peers.set('alice', { x: app.me.x + 5, y: 0, z: app.me.z, lastSeen: Date.now() });
    app.audioNodes.set('alice', {
      gainNode: { gain: { value: 0, setTargetAtTime: (v) => gainCalls.push(v) } },
      panner: { pan: { value: 0, setTargetAtTime: (v) => panCalls.push(v) } },
      source: { disconnect() {} },
      el: null,
    });
    app.tickGains();
    assert.strictEqual(gainCalls.length, 1);
    assert.ok(gainCalls[0] > 0.9, `expected near-full gain close up, got ${gainCalls[0]}`);
    assert.strictEqual(panCalls.length, 1);
  });
});

describe('purgeAll()', () => {
  test('clears every peer/audio Map and Set, disconnecting WebAudio nodes', () => {
    app.peers.set('a', { x: 0, y: 0, z: 0, lastSeen: Date.now() });
    app.gains.set('a', { current: 1, target: 1 });
    app.audioPublications.set('a', { setSubscribed() {} });
    app.subscribedPeers.add('a');
    const disconnectCalls = [];
    app.audioNodes.set('a', {
      source: { disconnect: () => disconnectCalls.push('source') },
      panner: { disconnect: () => disconnectCalls.push('panner') },
      gainNode: { disconnect: () => disconnectCalls.push('gainNode') },
      el: { remove: () => disconnectCalls.push('el') },
    });

    app.purgeAll();

    assert.strictEqual(app.peers.size, 0);
    assert.strictEqual(app.gains.size, 0);
    assert.strictEqual(app.audioNodes.size, 0);
    assert.strictEqual(app.audioPublications.size, 0);
    assert.strictEqual(app.subscribedPeers.size, 0);
    assert.deepStrictEqual(disconnectCalls.sort(), ['el', 'gainNode', 'panner', 'source']);
  });
});

describe('calibration clamp (AUDIT #38)', () => {
  test('dragging minDist past maxDist stops MIN_DIST_MAX_DIST_GAP short', () => {
    stub.elements.minDist.value = '999';
    stub.elements.minDist.dispatch('input');
    assert.ok(app.MAX_DIST - app.MIN_DIST >= 1);
    assert.strictEqual(app.MIN_DIST, app.MAX_DIST - 1);
  });

  test('dragging maxDist below minDist stops MIN_DIST_MAX_DIST_GAP short', () => {
    stub.elements.maxDist.value = '0';
    stub.elements.maxDist.dispatch('input');
    assert.ok(app.MAX_DIST - app.MIN_DIST >= 1);
    assert.strictEqual(app.MAX_DIST, app.MIN_DIST + 1);
  });
});

describe('DataReceived position validation (attachRoomEvents)', () => {
  const fakeParticipant = {};
  function emitPositions(positions, topic = 'position') {
    const payload = new TextEncoder().encode(JSON.stringify(positions));
    stub.lastRoom().emit('dataReceived', payload, fakeParticipant, undefined, topic);
  }

  test('ignores payloads on a topic other than "position"', () => {
    emitPositions([{ pseudo: 'x', x: 1, y: 1, z: 1 }], 'chat');
    assert.strictEqual(app.peers.has('x'), false);
  });

  test('accepts a valid position', () => {
    emitPositions([{ pseudo: 'newguy', x: 10, y: 0, z: 20 }]);
    assert.ok(app.peers.has('newguy'));
    assert.strictEqual(app.peers.get('newguy').x, 10);
  });

  test('rejects non-finite coordinates', () => {
    emitPositions([{ pseudo: 'bad', x: 'NaN', y: 0, z: 0 }]);
    assert.strictEqual(app.peers.has('bad'), false);
  });

  test('rejects absurdly large coordinates', () => {
    emitPositions([{ pseudo: 'huge', x: 1e9, y: 0, z: 0 }]);
    assert.strictEqual(app.peers.has('huge'), false);
  });

  test('rejects a non-string or too-long pseudo', () => {
    emitPositions([{ pseudo: 123, x: 1, y: 1, z: 1 }]);
    assert.strictEqual(app.peers.size, 0);
    emitPositions([{ pseudo: 'x'.repeat(65), x: 1, y: 1, z: 1 }]);
    assert.strictEqual(app.peers.size, 0);
  });

  test('ignores malformed (non-array) payloads', () => {
    const payload = new TextEncoder().encode(JSON.stringify({ not: 'an array' }));
    stub.lastRoom().emit('dataReceived', payload, fakeParticipant, undefined, 'position');
    assert.strictEqual(app.peers.size, 0);
  });
});

describe('interval tick: stale-peer garbage collection', () => {
  test('drops peers not seen in over PEER_GC_MS, keeps fresh ones', () => {
    app.peers.set('gone', { x: 0, y: 0, z: 0, lastSeen: Date.now() - (app.PEER_GC_MS + 1000) });
    app.gains.set('gone', { current: 0, target: 0 });
    app.peers.set('fresh', { x: 0, y: 0, z: 0, lastSeen: Date.now() });
    stub.runInterval();
    assert.strictEqual(app.peers.has('gone'), false);
    assert.strictEqual(app.gains.has('gone'), false);
    assert.strictEqual(app.peers.has('fresh'), true);
  });
});

describe('connectViaNonce() (auto-join from a ?t= URL)', () => {
  test('on success, connects to the room and updates the UI', async () => {
    stub.setFetch(async (url) => {
      assert.ok(String(url).startsWith('/token?t='));
      return {
        ok: true, status: 200,
        json: async () => ({ token: 'tok', wsUrl: 'ws://fake', room: 'r2', login: 'nonceuser', serverName: 'Server X' }),
      };
    });
    await app.connectViaNonce('abc123');
    assert.ok(stub.elements.status.textContent.includes('Connected'));
    assert.strictEqual(stub.elements.serverName.textContent, 'Server X');
  });

  test('expired nonce (401) shows the expired message instead of an error', async () => {
    stub.setFetch(async () => ({ ok: false, status: 401 }));
    await app.connectViaNonce('expired');
    assert.strictEqual(stub.elements.expiredMsg.style.display, '');
  });

  test('other token errors surface the status code', async () => {
    stub.setFetch(async () => ({ ok: false, status: 500 }));
    await app.connectViaNonce('whatever');
    assert.strictEqual(stub.elements.status.textContent, 'Token error: 500');
  });
});

describe('handleRoomPush() (server-switch pushed over /ingest)', () => {
  test('no name -> disconnects and resets to the waiting state', async () => {
    stub.setFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ token: 't', wsUrl: 'ws://fake', room: 'r3', login: 'x', serverName: 'S' }),
    }));
    await app.connectViaNonce('n1');

    await app.handleRoomPush({});

    assert.strictEqual(app.room, null);
    assert.strictEqual(stub.elements.status.textContent, 'Not on a server — voice on standby');
    assert.strictEqual(stub.elements.micBtn.disabled, true);
  });

  test('a pushed nonce swaps to the new room', async () => {
    stub.setFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ token: 't2', wsUrl: 'ws://fake2', room: 'r4', login: 'y', serverName: 'Server Y' }),
    }));
    await app.handleRoomPush({ name: 'ServerY', nonce: 'nonce2' });
    assert.strictEqual(stub.elements.serverName.textContent, 'Server Y');
    assert.ok(app.room !== null);
  });

  test('an expired/consumed nonce is silently ignored, leaving the room untouched', async () => {
    const before = app.room;
    stub.setFetch(async () => ({ ok: false, status: 401 }));
    await app.handleRoomPush({ name: 'ServerZ', nonce: 'stale' });
    assert.strictEqual(app.room, before);
  });
});

describe('join() (legacy manual join)', () => {
  test('a token fetch failure re-enables the join form', async () => {
    stub.elements.identity.value = 'legacyuser';
    stub.elements.joinBtn.disabled = false;
    stub.elements.identity.disabled = false;
    stub.setFetch(async () => ({ ok: false, status: 500 }));
    await app.join();
    assert.strictEqual(stub.elements.status.textContent, 'token error: 500');
    assert.strictEqual(stub.elements.joinBtn.disabled, false);
    assert.strictEqual(stub.elements.identity.disabled, false);
  });

  test('a blank identity is a no-op (no fetch)', async () => {
    stub.elements.identity.value = '   ';
    stub.setFetch(async () => { throw new Error('should not fetch for a blank identity'); });
    await app.join();
  });
});
