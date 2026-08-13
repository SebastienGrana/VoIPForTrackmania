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

import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDomStubs } from './dom-stub.js';
import { DOPPLER_PRESETS } from '../public/audio-math.js';

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
  // MAX_DIST/PAN_STRENGTH are live-bound exports, read-only from here).
  stub.elements.maxDist.value = '150'; stub.elements.maxDist.dispatch('input');
  stub.elements.minDist.value = '1'; stub.elements.minDist.dispatch('input');
  stub.elements.panStrength.value = '90'; stub.elements.panStrength.dispatch('input');

  stub.elements.relativeMode.setAttribute('aria-checked', 'false');
  stub.elements.relativeTarget.value = '';
  stub.elements.relativeOffsetX.value = '0';
  stub.elements.relativeOffsetY.value = '0';
  // These three own module state in their click listeners (meKnown/myHeading,
  // realisticAudio, rotateRadar), so writing aria-checked directly would desync
  // the flag from the switch — and for followGame it would leave a heading from
  // a previous test rotating this one's audio. Reached through a click, and
  // only when the state actually needs to change.
  if (stub.elements.followGame.getAttribute('aria-checked') !== 'false') {
    stub.elements.followGame.dispatch('click');
  }
  if (stub.elements.realisticAudio.getAttribute('aria-checked') !== 'true') {
    stub.elements.realisticAudio.dispatch('click');
  }
  if (stub.elements.rotateRadar.getAttribute('aria-checked') !== 'true') {
    stub.elements.rotateRadar.dispatch('click');
  }
  // Same reason for doppler, which owns dopplerPreset: off is the baseline
  // every strength is judged against. The strength itself is left alone - it
  // survives being switched off on purpose.
  if (stub.elements.doppler.getAttribute('aria-checked') === 'true') {
    stub.elements.doppler.dispatch('click');
  }

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
    stub.elements.relativeMode.setAttribute('aria-checked', 'true');
    stub.elements.relativeTarget.value = 'ghost';
    app.applyRelativeMode();
    assert.strictEqual(app.me.x, 200);
  });

  test('follows the target plus the configured offset', () => {
    stub.elements.relativeMode.setAttribute('aria-checked', 'true');
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

describe('switch wiring', () => {
  // A <button role="switch"> has no built-in toggle: whoever moved these off
  // native checkboxes had to give each one a listener. #relativeMode never got
  // it, so "Follow instead of free position" was simply dead to the click and
  // nothing else in the app could notice - isSwitchOn() just kept saying false.
  test('clicking #relativeMode flips it both ways', () => {
    const btn = stub.elements.relativeMode;
    assert.strictEqual(btn.getAttribute('aria-checked'), 'false');
    btn.dispatch('click');
    assert.strictEqual(btn.getAttribute('aria-checked'), 'true');
    btn.dispatch('click');
    assert.strictEqual(btn.getAttribute('aria-checked'), 'false');
  });

  test('and it really drives relative mode, not just the pill', () => {
    stub.elements.relativeMode.dispatch('click');
    stub.elements.relativeTarget.value = 'bob';
    stub.elements.relativeOffsetX.value = '3';
    app.peers.set('bob', { x: 50, y: 5, z: 60, lastSeen: Date.now() });
    app.applyRelativeMode();
    assert.strictEqual(app.me.x, 53);
  });

  // You cannot be driving and shadowing someone else at the same time. Every
  // reader has always put follow-game first, so with both switches on it was
  // the panel that lied, not the audio.
  test('turning follow-game on drops follow-a-player', () => {
    stub.elements.relativeMode.dispatch('click');
    assert.strictEqual(stub.elements.relativeMode.getAttribute('aria-checked'), 'true');
    stub.elements.followGame.dispatch('click');
    assert.strictEqual(stub.elements.followGame.getAttribute('aria-checked'), 'true');
    assert.strictEqual(stub.elements.relativeMode.getAttribute('aria-checked'), 'false');
  });

  test('turning follow-a-player on drops follow-game', () => {
    stub.elements.followGame.dispatch('click');
    assert.strictEqual(stub.elements.followGame.getAttribute('aria-checked'), 'true');
    stub.elements.relativeMode.dispatch('click');
    assert.strictEqual(stub.elements.relativeMode.getAttribute('aria-checked'), 'true');
    assert.strictEqual(stub.elements.followGame.getAttribute('aria-checked'), 'false');
  });

  // The switch that gets dropped has to go down the same path a click takes.
  // Leaving follow-a-player strands "me" on the followed player's coordinates,
  // and only that path knows to stop broadcasting them - flipping aria-checked
  // alone would keep sending a position we never chose.
  test('the dropped switch still runs its own off path', () => {
    stub.elements.relativeMode.dispatch('click');   // shadowing someone
    stub.elements.followGame.dispatch('click');     // back in the car, drops it
    stub.elements.followGame.dispatch('click');     // and back out to free position
    assert.strictEqual(app.shouldSendOwnPosition(), false);
  });
});

describe('shouldSendOwnPosition()', () => {
  // Leaving "Follow instead of free position" strands "me" on the followed
  // player's last coordinates. Broadcasting those would show us to everyone at
  // a spot we never chose, so we go quiet until the dot is dragged - the other
  // players' radars drop us back to "no position yet".
  const drag = () => {
    stub.elements.canvas.dispatch('mousedown', { clientX: 200, clientY: 200 });
    stub.elements.canvas.dispatch('mousemove', { clientX: 210, clientY: 200 });
    stub.elements.window.dispatch('mouseup', {});
  };

  beforeEach(() => {
    // Reach a known state through the real listeners: on, then dragged.
    if (stub.elements.relativeMode.getAttribute('aria-checked') === 'false') {
      stub.elements.relativeMode.dispatch('click');
    }
    stub.elements.relativeMode.dispatch('click');
    drag();
  });

  test('free position with a dot we placed ourselves is sent', () => {
    assert.strictEqual(app.shouldSendOwnPosition(), true);
  });

  test('unchecking relative mode stops the broadcast', () => {
    stub.elements.relativeMode.dispatch('click');  // on
    stub.elements.relativeMode.dispatch('click');  // off again
    assert.strictEqual(app.shouldSendOwnPosition(), false);
  });

  test('dragging the dot resumes it', () => {
    stub.elements.relativeMode.dispatch('click');
    stub.elements.relativeMode.dispatch('click');
    assert.strictEqual(app.shouldSendOwnPosition(), false);
    drag();
    assert.strictEqual(app.shouldSendOwnPosition(), true);
  });

  test('relative mode itself keeps broadcasting - the position is chosen', () => {
    stub.elements.relativeMode.dispatch('click');
    assert.strictEqual(app.shouldSendOwnPosition(), true);
  });

  test('follow-game mode never sends: the plugin already does', () => {
    stub.elements.followGame.setAttribute('aria-checked', 'true');
    assert.strictEqual(app.shouldSendOwnPosition(), false);
  });
});

describe('renderFollowChips()', () => {
  // The chips are redrawn from the 10Hz render tick. Rebuilding them destroys
  // the <button> the mouse is on: it flickers, and a click never completes
  // because mousedown and mouseup land on two different elements. So an
  // unchanged list has to leave the existing buttons alone.
  test('a redraw with the same players and the same selection touches nothing', () => {
    app.peers.set('chipA', { x: 0, y: 0, z: 0, lastSeen: Date.now() });
    app.renderFollowChips();
    const before = stub.elements.relativeTargetChips.children.length;
    assert.ok(before > 0);

    app.renderFollowChips();
    assert.strictEqual(stub.elements.relativeTargetChips.children.length, before);
  });

  test('a new player does cause a redraw', () => {
    app.peers.set('chipB', { x: 0, y: 0, z: 0, lastSeen: Date.now() });
    app.renderFollowChips();
    const before = stub.elements.relativeTargetChips.children.length;

    app.peers.set('chipC', { x: 0, y: 0, z: 0, lastSeen: Date.now() });
    app.renderFollowChips();
    assert.ok(stub.elements.relativeTargetChips.children.length > before);
  });

  // The chip used to hard-code the hashed fallback emoji, so a player flying a
  // French flag on the radar and in the list showed up as a random face in the
  // picker - three names for the same person on one screen.
  test('a chip shows the same avatar the radar and the list show', () => {
    app.peers.set('chipFlag', { x: 0, y: 0, z: 0, lastSeen: Date.now() });
    app.peerAvatars.set('chipFlag', { kind: 'flag', code: 'fr' });
    app.renderFollowChips();

    const chip = stub.elements.relativeTargetChips.children
      .find((c) => c.renderedText.includes('chipFlag'));
    assert.ok(chip, 'no chip for chipFlag');
    const img = chip.children.flatMap((c) => c.children).find((c) => c.tagName === 'IMG');
    assert.ok(img, 'the chip should carry the flag image, not a fallback glyph');
    assert.ok(img.src.includes('fr'), `unexpected flag src: ${img.src}`);
    assert.ok(!chip.renderedText.includes(app.emojiForPseudo('chipFlag')));
  });

  // The avatar arrives in a data message a moment after the player does. Keyed
  // on the names alone, the cache declared "nothing changed" and the chip stayed
  // frozen on the fallback emoji for the rest of the session.
  test('an avatar arriving after the player repaints the chip', () => {
    app.peers.set('chipLate', { x: 0, y: 0, z: 0, lastSeen: Date.now() });
    app.renderFollowChips();
    const before = stub.elements.relativeTargetChips.children
      .find((c) => c.renderedText.includes('chipLate'));
    assert.ok(before.renderedText.includes(app.emojiForPseudo('chipLate')));

    app.peerAvatars.set('chipLate', { kind: 'flag', code: 'de' });
    app.renderFollowChips();
    const after = stub.elements.relativeTargetChips.children
      .find((c) => c.renderedText.includes('chipLate'));
    assert.ok(!after.renderedText.includes(app.emojiForPseudo('chipLate')));
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

  test('drives an active WebAudio node toward the target gain, pan and cutoff', () => {
    const gainCalls = [];
    const panCalls = [];
    const cutoffCalls = [];
    app.peers.set('alice', { x: app.me.x + 5, y: 0, z: app.me.z, lastSeen: Date.now() });
    app.audioNodes.set('alice', {
      gainNode: { gain: { value: 0, setTargetAtTime: (v) => gainCalls.push(v) } },
      panner: { pan: { value: 0, setTargetAtTime: (v) => panCalls.push(v) } },
      filter: { frequency: { value: 0, setTargetAtTime: (v) => cutoffCalls.push(v) } },
      source: { disconnect() {} },
      el: null,
    });
    app.tickGains();
    assert.strictEqual(gainCalls.length, 1);
    assert.ok(gainCalls[0] > 0.85, `expected near-full gain close up, got ${gainCalls[0]}`);
    assert.strictEqual(panCalls.length, 1);
    // 5 m out of 150 is essentially on top of you: barely any air to absorb.
    assert.strictEqual(cutoffCalls.length, 1);
    assert.ok(cutoffCalls[0] > 15000, `expected an open filter close up, got ${cutoffCalls[0]}`);
  });
});

describe('realistic audio switch', () => {
  const MID = 75.5; // halfway between the default MIN_DIST 1 and MAX_DIST 150
  const off = () => stub.elements.realisticAudio.dispatch('click');

  test('defaults to on', () => {
    assert.strictEqual(stub.elements.realisticAudio.getAttribute('aria-checked'), 'true');
  });

  test('on: the perceptual curve is far quieter mid-range than linear', () => {
    assert.ok(app.gainForCurrentMode(MID) < 0.12, `got ${app.gainForCurrentMode(MID)}`);
  });

  test('off: falls back to the original linear curve', () => {
    off();
    assert.ok(Math.abs(app.gainForCurrentMode(MID) - 0.5) < 0.01, `got ${app.gainForCurrentMode(MID)}`);
  });

  test('off: the filter is pinned wide open, not merely wide', () => {
    // Above hearing, so "off" is transparent without rewiring the graph -
    // the node stays in the chain either way.
    off();
    assert.strictEqual(app.cutoffForCurrentMode(MID), 20000);
    assert.strictEqual(app.cutoffForCurrentMode(149), 20000);
  });

  test('on: the cutoff closes down with distance', () => {
    assert.ok(app.cutoffForCurrentMode(149) < app.cutoffForCurrentMode(MID));
    assert.ok(app.cutoffForCurrentMode(MID) < app.cutoffForCurrentMode(2));
  });

  test('flipping it changes what tickGains pushes into the audio graph', () => {
    const gainCalls = [];
    const cutoffCalls = [];
    app.peers.set('alice', { x: app.me.x + MID, y: 0, z: app.me.z, lastSeen: Date.now() });
    app.audioNodes.set('alice', {
      gainNode: { gain: { value: 0, setTargetAtTime: (v) => gainCalls.push(v) } },
      panner: { pan: { value: 0, setTargetAtTime: () => {} } },
      filter: { frequency: { value: 0, setTargetAtTime: (v) => cutoffCalls.push(v) } },
      source: { disconnect() {} },
      el: null,
    });

    app.tickGains();
    off();
    app.tickGains();

    assert.ok(gainCalls[0] < gainCalls[1], `expected louder once linear, got ${gainCalls}`);
    assert.ok(cutoffCalls[0] < cutoffCalls[1], `expected the filter to open, got ${cutoffCalls}`);
    assert.strictEqual(cutoffCalls[1], 20000);
  });

  test('the choice survives a reload', () => {
    off();
    assert.strictEqual(localStorage.getItem('onzvoip.v2.realisticAudio'), '0');
    stub.elements.realisticAudio.dispatch('click');
    assert.strictEqual(localStorage.getItem('onzvoip.v2.realisticAudio'), '1');
  });
});

describe('car heading (radar rotation + rotating stereo)', () => {
  // Everything here goes through the real path: the heading only ever enters
  // the client attached to our own position, on a relay packet, in follow-game
  // mode. There is no setter to poke.
  function emitOwnPosition(extra) {
    const payload = new TextEncoder().encode(JSON.stringify([{ pseudo: 'me', x: 200, y: 0, z: 200, ...extra }]));
    stub.lastRoom().emit('dataReceived', payload, undefined, undefined, 'position');
  }
  function followGameOn() {
    stub.elements.followGame.dispatch('click');
  }

  // The suite's opening connectLiveKit() never sets myIdentity - only the two
  // real entry points do - and without it the client cannot recognise its own
  // position coming back from the game, which is the only packet a heading ever
  // rides on. So join the way a player does, through a ?t= link.
  before(async () => {
    stub.setFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ token: 'tok', wsUrl: 'ws://fake', room: 'r-heading', login: 'me', serverName: null }),
    }));
    await app.connectViaNonce('heading-nonce');
  });

  beforeEach(() => {
    // The peer blip is only a fillText call while emoji avatars are on, and
    // that switch persists to localStorage - so an earlier test turning it off
    // would otherwise change what this whole block is reading.
    if (stub.elements.showEmojiToggle.getAttribute('aria-checked') !== 'true') {
      stub.elements.showEmojiToggle.dispatch('click');
    }
  });

  test('no heading until the game sends one', () => {
    assert.strictEqual(app.headingForView(), null);
  });

  test('a position without a heading leaves us in world space', () => {
    // Older plugin builds, and every browser publishing its own dragged dot.
    followGameOn();
    emitOwnPosition({});
    assert.strictEqual(app.headingForView(), null);
    const off = app.offsetInEarFrame({ x: app.me.x + 10, y: 0, z: app.me.z });
    assert.strictEqual(off.right, 10);
  });

  test('a heading arrives with our own position and rotates the offset', () => {
    followGameOn();
    emitOwnPosition({ fx: 0, fz: 1 });
    assert.deepStrictEqual(app.headingForView(), { fx: 0, fz: 1 });
    // Peer 10 m ahead along +Z: dead ahead once rotated, so nothing either side.
    const off = app.offsetInEarFrame({ x: app.me.x, y: 0, z: app.me.z + 10 });
    assert.ok(Math.abs(off.right) < 1e-9, `expected centred, got ${off.right}`);
    assert.ok(Math.abs(off.front - 10) < 1e-9);
  });

  test('turning the car swaps which ear a stationary peer comes from', () => {
    followGameOn();
    const peer = { x: app.me.x + 10, y: 0, z: app.me.z };
    emitOwnPosition({ fx: 0, fz: 1 });
    const before = app.offsetInEarFrame(peer).right;
    emitOwnPosition({ fx: 0, fz: -1 }); // U-turn, peer has not moved
    const after = app.offsetInEarFrame(peer).right;
    assert.ok(Math.abs(before) > 1, 'the peer should be off to one side');
    assert.ok(Math.abs(before + after) < 1e-9, `expected mirrored, got ${before} then ${after}`);
  });

  test('a heading that stops arriving is dropped, not held on to', () => {
    // A respawn or a plugin reload can interrupt it. Steering the world by the
    // last direction we happened to see would be worse than not steering it.
    followGameOn();
    emitOwnPosition({ fx: 1, fz: 0 });
    assert.ok(app.headingForView());
    emitOwnPosition({});
    assert.strictEqual(app.headingForView(), null);
  });

  test('a zero-length heading carries no direction and is refused', () => {
    followGameOn();
    emitOwnPosition({ fx: 0, fz: 0 });
    assert.strictEqual(app.headingForView(), null);
  });

  test('leaving follow-game mode drops the heading', () => {
    followGameOn();
    emitOwnPosition({ fx: 1, fz: 0 });
    assert.ok(app.headingForView());
    stub.elements.followGame.dispatch('click'); // back to the mouse-dragged dot
    assert.strictEqual(app.headingForView(), null);
  });

  test('follow-a-player mode ignores the heading: "me" is not our car', () => {
    followGameOn();
    emitOwnPosition({ fx: 1, fz: 0 });
    stub.elements.relativeMode.dispatch('click');
    assert.strictEqual(app.headingForView(), null);
  });

  test('the pan tickGains pushes is the one from the car frame', () => {
    const panCalls = [];
    followGameOn();
    const peer = { x: app.me.x + 5, y: 0, z: app.me.z, lastSeen: Date.now() };
    app.peers.set('alice', peer);
    app.audioNodes.set('alice', {
      gainNode: { gain: { value: 0, setTargetAtTime: () => {} } },
      panner: { pan: { value: 0, setTargetAtTime: (v) => panCalls.push(v) } },
      filter: { frequency: { value: 0, setTargetAtTime: () => {} } },
      source: { disconnect() {} },
      el: null,
    });

    emitOwnPosition({ fx: 0, fz: 1 });
    app.tickGains();
    emitOwnPosition({ fx: 0, fz: -1 });
    app.tickGains();

    assert.strictEqual(panCalls.length, 2);
    assert.ok(Math.abs(panCalls[0]) > 0.1, `expected an off-centre pan, got ${panCalls[0]}`);
    assert.ok(Math.abs(panCalls[0] + panCalls[1]) < 1e-9,
      `the U-turn should mirror the pan, got ${panCalls}`);
  });

  test('the radar switch defaults to on and survives a reload', () => {
    assert.strictEqual(stub.elements.rotateRadar.getAttribute('aria-checked'), 'true');
    stub.elements.rotateRadar.dispatch('click');
    assert.strictEqual(localStorage.getItem('onzvoip.v2.rotateRadar'), '0');
    stub.elements.rotateRadar.dispatch('click');
    assert.strictEqual(localStorage.getItem('onzvoip.v2.rotateRadar'), '1');
  });

  test('freezing the radar does not stop the sound from turning', () => {
    // The switch is a display preference. The stereo image is the feature.
    followGameOn();
    emitOwnPosition({ fx: 0, fz: 1 });
    stub.elements.rotateRadar.dispatch('click'); // radar pinned to the map
    const off = app.offsetInEarFrame({ x: app.me.x, y: 0, z: app.me.z + 10 });
    assert.ok(Math.abs(off.right) < 1e-9, `still rotated for the ears, got ${off.right}`);
  });

  // Where the peer's blip lands on the canvas: with emoji avatars on (the
  // default) that is the fillText call, whose args are (glyph, x, y).
  function blipXY() {
    const op = stub.canvasOps.filter((o) => o.op === 'fillText').pop();
    return op ? { x: op.args[1], y: op.args[2] } : null;
  }

  test('draw() plots a peer somewhere else once the radar is frozen', () => {
    // The peer sits due +X while the car faces +X too, so rotated they belong
    // straight ahead - at the top of the radar. Pinned to the map they go to
    // the right instead. Same peer, same position, two different pictures.
    followGameOn();
    app.peers.set('alice', { x: app.me.x + 20, y: 0, z: app.me.z, lastSeen: Date.now() });
    emitOwnPosition({ fx: 1, fz: 0 });

    stub.canvasOps.length = 0;
    app.draw();
    const rotated = blipXY();

    stub.elements.rotateRadar.dispatch('click');
    stub.canvasOps.length = 0;
    app.draw();
    const pinned = blipXY();

    assert.ok(rotated && pinned, 'expected the peer blip to be drawn both times');
    const cx = stub.elements.canvas.width / 2, cy = stub.elements.canvas.height / 2;
    assert.ok(Math.abs(rotated.x - cx) < 1 && rotated.y < cy - 1,
      `rotated blip should be straight up, got ${JSON.stringify(rotated)}`);
    assert.ok(Math.abs(pinned.y - cy) < 1 && pinned.x > cx + 1,
      `pinned blip should be off to the right, got ${JSON.stringify(pinned)}`);
  });

  test('our own blip is an arrow once we have a heading, a dot before', () => {
    // An arrow pointing at a direction we do not know would be a confident lie,
    // so the plain dot has to survive for browsers with no plugin.
    stub.canvasOps.length = 0;
    app.draw();
    assert.strictEqual(stub.canvasOps.filter((o) => o.op === 'lineTo').length, 0);

    followGameOn();
    emitOwnPosition({ fx: 1, fz: 0 });
    stub.canvasOps.length = 0;
    app.draw();
    assert.strictEqual(stub.canvasOps.filter((o) => o.op === 'lineTo').length, 2,
      'expected the two back corners of the arrow');
  });

  test('the arrow points up while the radar turns, and along the car once frozen', () => {
    followGameOn();
    emitOwnPosition({ fx: 1, fz: 0 }); // driving along +X, i.e. to the right of the map
    const cx = stub.elements.canvas.width / 2, cy = stub.elements.canvas.height / 2;

    stub.canvasOps.length = 0;
    app.draw();
    let nose = stub.canvasOps.filter((o) => o.op === 'moveTo').pop();
    assert.ok(Math.abs(nose.args[0] - cx) < 1e-9 && nose.args[1] < cy,
      `rotating: the nose is the top of the radar, got ${JSON.stringify(nose.args)}`);

    stub.elements.rotateRadar.dispatch('click');
    stub.canvasOps.length = 0;
    app.draw();
    nose = stub.canvasOps.filter((o) => o.op === 'moveTo').pop();
    assert.ok(nose.args[0] > cx && Math.abs(nose.args[1] - cy) < 1e-9,
      `pinned: the nose follows the car, got ${JSON.stringify(nose.args)}`);
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
      filter: { disconnect: () => disconnectCalls.push('filter') },
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
    assert.deepStrictEqual(disconnectCalls.sort(), ['el', 'filter', 'gainNode', 'panner', 'source']);
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
  // The relay sends positions through the LiveKit *server* API, so they reach
  // the client with no publishing participant. That absence is not incidental:
  // it is how the client tells a relay packet from one a browser made up.
  const fromRelay = undefined;
  function emitPositions(positions, topic = 'position') {
    const payload = new TextEncoder().encode(JSON.stringify(positions));
    stub.lastRoom().emit('dataReceived', payload, fromRelay, undefined, topic);
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
    stub.lastRoom().emit('dataReceived', payload, fromRelay, undefined, 'position');
    assert.strictEqual(app.peers.size, 0);
  });

  test('a position published by a participant is refused, whoever they claim to be', () => {
    // Browsers can publish data since avatars shipped. A well-formed position
    // is now something any participant can put on the wire, and positions are
    // what decide who you hear - so this one has to be dropped on the fact
    // that it came from a participant at all, not on its contents.
    const payload = new TextEncoder().encode(JSON.stringify([{ pseudo: 'victim', x: 0, y: 0, z: 0 }]));
    stub.lastRoom().emit('dataReceived', payload, { identity: 'attacker' }, undefined, 'position');
    assert.strictEqual(app.peers.has('victim'), false);
    assert.strictEqual(app.peers.size, 0);
  });
});

// The avatar a player picked travels browser-to-browser over the room's data
// channel, which means it is the one piece of another participant's input that
// ends up drawn on your screen. These tests pin the two properties that make
// that safe: it is filed under the identity LiveKit signed, and a rejected
// payload degrades to the hashed emoji rather than to nothing.
describe('DataReceived avatar announcements (attachRoomEvents)', () => {
  function emitAvatar(body, identity, topic = 'avatar') {
    const payload = new TextEncoder().encode(JSON.stringify(body));
    stub.lastRoom().emit('dataReceived', payload, { identity }, undefined, topic);
  }

  test('a flag announced by a player is what gets drawn for them', () => {
    emitAvatar({ kind: 'flag', code: 'fr' }, 'frenchy');
    assert.deepStrictEqual(app.avatarFor('frenchy'), { kind: 'flag', code: 'fr', url: 'flags/fr.svg' });
  });

  // The whole reason the map is keyed on participant.identity: a pseudo inside
  // the body would let anyone repaint anyone.
  test('a payload cannot set the avatar of a player other than its sender', () => {
    emitAvatar({ kind: 'flag', code: 'de', pseudo: 'victim', identity: 'victim' }, 'attacker');
    assert.strictEqual(app.avatarFor('victim').kind, 'emoji');
    assert.strictEqual(app.avatarFor('attacker').kind, 'flag');
  });

  test('a rejected payload leaves the player on their hashed emoji', () => {
    emitAvatar({ kind: 'flag', code: '../../../etc/passwd' }, 'sneaky');
    assert.strictEqual(app.avatarFor('sneaky').kind, 'emoji');
    assert.strictEqual(app.peerAvatars.has('sneaky'), false);
  });

  test('an empty body means "back to Auto" and clears a previous choice', () => {
    emitAvatar({ kind: 'flag', code: 'it' }, 'flipflop');
    assert.strictEqual(app.avatarFor('flipflop').kind, 'flag');
    emitAvatar({}, 'flipflop');
    assert.strictEqual(app.avatarFor('flipflop').kind, 'emoji');
  });

  test('another topic is ignored, and a sender with no identity is dropped', () => {
    emitAvatar({ kind: 'flag', code: 'es' }, 'wrongtopic', 'position');
    assert.strictEqual(app.avatarFor('wrongtopic').kind, 'emoji');
    const payload = new TextEncoder().encode(JSON.stringify({ kind: 'flag', code: 'es' }));
    stub.lastRoom().emit('dataReceived', payload, {}, undefined, 'avatar');
    assert.strictEqual(app.peerAvatars.has(undefined), false);
  });

  // Avatars are announcements made inside a room; keeping them across a server
  // change would paint a stale flag on a same-named player who has said nothing.
  test('leaving the room forgets everyone\'s avatar', () => {
    emitAvatar({ kind: 'flag', code: 'pl' }, 'transient');
    app.purgeAll();
    assert.strictEqual(app.peerAvatars.size, 0);
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

  test('other token errors name the code AND say what to do about it', async () => {
    stub.setFetch(async () => ({ ok: false, status: 500 }));
    await app.connectViaNonce('whatever');
    assert.match(stub.elements.status.textContent, /error 500/);
    assert.match(stub.elements.status.textContent, /Copy URL/);
    assert.strictEqual(stub.elements.status.className, 'err');
  });

  // The relay being unreachable used to escape as an unhandled rejection and
  // leave the page frozen on "Connecting…" with no explanation at all.
  test('an unreachable relay is reported, not thrown', async () => {
    stub.setFetch(async () => { throw new TypeError('Failed to fetch'); });
    await app.connectViaNonce('whatever');
    assert.match(stub.elements.status.textContent, /Can't reach the OnZVoIP server/);
    assert.match(stub.elements.status.textContent, /internet connection/);
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

  // Previously a bare `return`: voice stopped working on the new server while
  // the page still claimed to be connected to the old room.
  test('an expired/consumed nonce leaves the room untouched but says so', async () => {
    const before = app.room;
    stub.setFetch(async () => ({ ok: false, status: 401 }));
    await app.handleRoomPush({ name: 'ServerZ', nonce: 'stale' });
    assert.strictEqual(app.room, before);
    assert.match(stub.elements.status.textContent, /changed server/);
    assert.match(stub.elements.status.textContent, /Copy URL/);
  });

  // The plugin re-issues a nonce on a timer, and now also every time one gets
  // spent. Acting on a push for the room we are already in rebuilt the LiveKit
  // connection for nothing — a voice cut every 9 minutes — and, with the
  // spent-nonce push, the reconnect would spend another nonce and loop.
  test('a push for the room we are already in changes nothing', async () => {
    stub.setFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ token: 't5', wsUrl: 'ws://fake', room: 'SameRoom', login: 'z', serverName: 'Server Same' }),
    }));
    await app.handleRoomPush({ name: 'SameRoom', nonce: 'nonce5' });
    const connected = app.room;
    assert.ok(connected !== null);

    stub.setFetch(async () => { throw new Error('should not spend another nonce'); });
    await app.handleRoomPush({ name: 'SameRoom', nonce: 'nonce6' });
    assert.strictEqual(app.room, connected, 'the live room must survive a redundant push');
  });
});

describe('join() (legacy manual join)', () => {
  test('a token fetch failure re-enables the join form', async () => {
    stub.elements.identity.value = 'legacyuser';
    stub.elements.joinBtn.disabled = false;
    stub.elements.identity.disabled = false;
    stub.setFetch(async () => ({ ok: false, status: 500 }));
    await app.join();
    assert.match(stub.elements.status.textContent, /error 500/);
    assert.match(stub.elements.status.textContent, /try a different name/);
    assert.strictEqual(stub.elements.joinBtn.disabled, false);
    assert.strictEqual(stub.elements.identity.disabled, false);
  });

  test('an unreachable relay re-enables the join form instead of locking it', async () => {
    stub.elements.identity.value = 'legacyuser';
    stub.elements.joinBtn.disabled = false;
    stub.elements.identity.disabled = false;
    stub.setFetch(async () => { throw new TypeError('Failed to fetch'); });
    await app.join();
    assert.match(stub.elements.status.textContent, /Can't reach the OnZVoIP server/);
    assert.strictEqual(stub.elements.joinBtn.disabled, false);
    assert.strictEqual(stub.elements.identity.disabled, false);
  });

  test('a blank identity is a no-op (no fetch)', async () => {
    stub.elements.identity.value = '   ';
    stub.setFetch(async () => { throw new Error('should not fetch for a blank identity'); });
    await app.join();
  });

  test('a room override is passed to the relay, and encoded', async () => {
    stub.elements.identity.value = 'legacyuser';
    let asked = null;
    stub.setFetch(async (url) => { asked = url; return { ok: false, status: 500 }; });
    await app.join('other room');
    assert.match(asked, /[?&]room=other%20room/);
  });

  test('no override means no room param at all — the relay picks its default', async () => {
    stub.elements.identity.value = 'legacyuser';
    let asked = null;
    stub.setFetch(async (url) => { asked = url; return { ok: false, status: 500 }; });
    await app.join();
    assert.ok(!asked.includes('room='), `expected no room param, got ${asked}`);
  });
});

// The picker is only rendered when the relay allows debug, and the relay
// refuses the room anyway when it doesn't — so what matters here is that a
// name the relay would silently drop is caught in front of the user instead of
// looking like the button did nothing.
describe('debug room picker', () => {
  test('an empty name says so and never calls the relay', () => {
    stub.elements.debugRoom.value = '  ';
    stub.setFetch(async () => { throw new Error('should not fetch'); });
    stub.elements.debugRoomJoin.dispatch('click');
    assert.match(stub.elements.debugRoomMsg.textContent, /Type a room name/);
  });

  test('a name the relay would reject is refused here, with the rule spelled out', () => {
    stub.elements.debugRoom.value = '../evil room';
    stub.setFetch(async () => { throw new Error('should not fetch'); });
    stub.elements.debugRoomJoin.dispatch('click');
    assert.match(stub.elements.debugRoomMsg.textContent, /Letters, digits/);
  });

  test('a valid room with no login asks for the login first', () => {
    stub.elements.debugRoom.value = 'other-room_1';
    stub.elements.identity.value = '';
    stub.setFetch(async () => { throw new Error('should not fetch'); });
    stub.elements.debugRoomJoin.dispatch('click');
    assert.match(stub.elements.debugRoomMsg.textContent, /login/);
  });
});

// The page used to keep showing "Connected — you'll hear nearby players
// automatically" over a room that had died, which tells a player the silence is
// normal. These cover the three lifecycle events that say otherwise.
describe('losing the room after a successful connect', () => {
  async function connectFresh(login = 'droptest') {
    stub.setFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ token: 't', wsUrl: 'ws://fake', room: 'r', login, serverName: 'S' }),
    }));
    await app.connectViaNonce('n');
    return app.room;
  }

  test('Disconnected stops claiming to be connected and disables the mic', async () => {
    const r = await connectFresh();
    r.emit('disconnected');
    assert.strictEqual(app.room, null);
    assert.strictEqual(stub.elements.status.className, 'err');
    assert.match(stub.elements.status.textContent, /Disconnected from the voice room/);
    assert.match(stub.elements.status.textContent, /Rejoin/);
    assert.strictEqual(stub.elements.micBtn.disabled, true);
    // The cached token usually still works, so the way back is one click here
    // rather than a round trip through the game.
    assert.strictEqual(stub.elements.leaveBtn.style.display, '');
    assert.match(stub.elements.leaveBtn.textContent, /Rejoin/);
  });

  test('Reconnecting says so, and Reconnected puts the connected state back', async () => {
    const r = await connectFresh();
    r.emit('reconnecting');
    assert.strictEqual(stub.elements.status.className, 'err');
    assert.match(stub.elements.status.textContent, /Connection lost/);
    r.emit('reconnected');
    assert.strictEqual(stub.elements.status.className, 'ok');
    assert.match(stub.elements.status.textContent, /Connected/);
  });

  // Guards the ordering in disconnectLiveKit(): it clears `room` before calling
  // disconnect() precisely so this teardown isn't mistaken for a dropped link.
  test('an intentional server change does NOT show a disconnection error', async () => {
    await connectFresh('switcher');
    stub.setFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ token: 't2', wsUrl: 'ws://fake', room: 'r2', login: 'switcher', serverName: 'Server B' }),
    }));
    await app.handleRoomPush({ name: 'ServerB', nonce: 'n2' });
    assert.strictEqual(stub.elements.status.className, 'ok');
    assert.match(stub.elements.status.textContent, /Connected/);
  });

  // A stale room object must not be able to overwrite the live room's status.
  test('an event from a room we already replaced is ignored', async () => {
    const old = await connectFresh('stale');
    stub.setFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ token: 't3', wsUrl: 'ws://fake', room: 'r3', login: 'stale', serverName: 'Server C' }),
    }));
    await app.handleRoomPush({ name: 'ServerC', nonce: 'n3' });
    old.emit('disconnected');
    assert.ok(app.room !== null);
    assert.strictEqual(stub.elements.status.className, 'ok');
  });
});

// Before the Leave button the only exit was closing the tab, and the only way
// back was going into the game to click Copy URL. The credential that makes the
// return cheap lives in memory only — see the note in app.js — so these tests
// guard the two behaviours that make that safe: the plugin must not drag anyone
// back in, and a server change while out must not send them to the wrong room.
describe('leaving the voice chat and coming back', () => {
  async function connectFresh(login = 'leaver') {
    stub.setFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ token: 't', wsUrl: 'ws://fake', room: 'r', login, serverName: 'S' }),
    }));
    await app.connectViaNonce('n');
  }

  test('joining shows the button in its Leave state', async () => {
    await connectFresh();
    assert.strictEqual(stub.elements.leaveBtn.style.display, '');
    assert.match(stub.elements.leaveBtn.textContent, /Leave/);
  });

  test('leaving drops the room, mutes the mic, and offers the way back', async () => {
    await connectFresh();
    await app.leaveVoice();
    assert.strictEqual(app.room, null);
    assert.strictEqual(stub.elements.micBtn.disabled, true);
    // Not an error state: stepping out on purpose is not a failure.
    assert.notStrictEqual(stub.elements.status.className, 'err');
    assert.match(stub.elements.leaveBtn.textContent, /Rejoin/);
  });

  test('rejoining reconnects with the remembered credentials', async () => {
    await connectFresh('backagain');
    await app.leaveVoice();
    // No fetch: the point of the cached credentials is that coming back needs
    // no new nonce, and a nonce is single-use anyway.
    stub.setFetch(async () => { throw new Error('should not fetch'); });
    await app.rejoinVoice();
    assert.ok(app.room !== null);
    assert.match(stub.elements.status.textContent, /Connected/);
    assert.match(stub.elements.leaveBtn.textContent, /Leave/);
  });

  // Without the leftVoluntarily guard the plugin's next push would silently
  // reconnect someone who just left, making the button useless.
  test('a room push does not drag a player who left back in', async () => {
    await connectFresh('stubborn');
    await app.leaveVoice();
    stub.setFetch(async () => { throw new Error('should not fetch'); });
    await app.handleRoomPush({ name: 'ServerB', nonce: 'n2' });
    assert.strictEqual(app.room, null);
    assert.match(stub.elements.leaveBtn.textContent, /Rejoin/);
  });

  test('a server change while out sends the rejoin to the NEW room', async () => {
    await connectFresh('mover');
    await app.leaveVoice();
    await app.handleRoomPush({ name: 'ServerB', nonce: 'n2' });

    let asked = null;
    stub.setFetch(async (url) => {
      asked = url;
      return {
        ok: true, status: 200,
        json: async () => ({ token: 't2', wsUrl: 'ws://fake', room: 'r2', login: 'mover', serverName: 'Server B' }),
      };
    });
    await app.rejoinVoice();
    assert.match(asked, /t=n2/);
    assert.ok(app.room !== null);
  });

  test('leaving the server entirely withdraws the rejoin offer', async () => {
    await connectFresh('quitter');
    await app.handleRoomPush({ name: null });
    assert.strictEqual(app.room, null);
    assert.strictEqual(stub.elements.leaveBtn.style.display, 'none');
  });
});

// A calibration stored by an earlier session keeps overriding the shipped
// defaults, and the sliders that produced it now live behind ?debug=1 — so
// without this button a player has no way back to a working sound range.
describe('calibration reset', () => {
  test('the button stays hidden when nothing was ever calibrated', () => {
    localStorage.clear();
    app.setupCalibration();
    assert.strictEqual(stub.elements.calibReset.style.display, 'none');
  });

  test('a stored value reveals the button and clicking it restores the defaults', () => {
    localStorage.clear();
    app.setupCalibration();
    const defMin = app.MIN_DIST, defMax = app.MAX_DIST, defPan = app.PAN_STRENGTH;

    // A stale minDist LARGER than the default maxDist: the setters clamp
    // against each other, so a single-pass reset would leave maxDist stranded
    // at minDist+1 instead of its default.
    localStorage.setItem('onzvoip.v2.minDist', '200');
    localStorage.setItem('onzvoip.v2.maxDist', '400');
    app.setupCalibration();
    assert.strictEqual(stub.elements.calibReset.style.display, '');
    assert.notStrictEqual(app.MAX_DIST, defMax);

    stub.elements.calibReset.dispatch('click');
    assert.strictEqual(app.MIN_DIST, defMin);
    assert.strictEqual(app.MAX_DIST, defMax);
    assert.strictEqual(app.PAN_STRENGTH, defPan);
    assert.strictEqual(localStorage.getItem('onzvoip.v2.minDist'), null);
    assert.strictEqual(stub.elements.calibReset.style.display, 'none');
  });

  // The sliders were given tighter bounds once it was clear nobody ever picked
  // the far end. A value stored under the old ones is still in localStorage, and
  // a browser silently clamps the slider to its own max - so applied as it
  // stands, the audio would run at 500 while the slider showed 200 and the
  // number on screen would stop describing what you hear.
  test('a stored value from wider sliders is pulled back inside the bounds', () => {
    localStorage.clear();
    const slider = stub.elements.maxDist;
    slider.min = '20';
    slider.max = '200';
    try {
      localStorage.setItem('onzvoip.v2.maxDist', '500');
      app.setupCalibration();
      assert.strictEqual(app.MAX_DIST, 200);
      assert.strictEqual(Number(slider.value), 200);
    } finally {
      delete slider.min;
      delete slider.max;
      localStorage.clear();
      app.setupCalibration();
    }
  });

  // Zero is a real answer on two of these sliders - no full-volume bubble, no
  // stereo at all - and it used to be indistinguishable from "nothing stored",
  // so the default came back on the next reload and quietly undid the choice.
  test('a stored zero is a choice, not an empty slot', () => {
    localStorage.clear();
    try {
      localStorage.setItem('onzvoip.v2.panStrength', '0');
      app.setupCalibration();
      assert.strictEqual(app.PAN_STRENGTH, 0);
      assert.strictEqual(stub.elements.calibReset.style.display, '');
    } finally {
      // Back to the shipped value BEFORE re-running setup, which reads whatever
      // is live as its idea of "default".
      stub.elements.panStrength.value = '90';
      stub.elements.panStrength.dispatch('input');
      localStorage.clear();
      app.setupCalibration();
    }
  });
});

describe('renderPlayerList() (who the list shows)', () => {
  // Earlier suites deliberately lose the room, and app.room stays null after
  // them — reconnect so this one runs against a live room like the page does.
  before(async () => {
    await app.connectLiveKit({ token: 'tok', wsUrl: 'ws://fake', roomName: 'listRoom', login: 'me', serverName: null });
  });

  // Walks the fake DOM because the assertion has to be about what a player
  // actually reads, not about the Set the function built internally.
  function rowTexts() {
    // Starts from innerHTML because the empty state is written as markup
    // rather than built out of elements.
    const out = [stub.elements.playerList.innerHTML];
    (function walk(node, acc) {
      if (node.textContent) acc.push(node.textContent);
      for (const child of node.children) walk(child, acc);
    })(stub.elements.playerList, out);
    return out.join(' | ');
  }

  test('a participant with neither a position nor audio is still listed', () => {
    // Exactly the case that made the page lie: someone on the web page with no
    // game running (a debug tab) and the mic still off. The header counts them
    // from remoteParticipants, so the list has to as well.
    app.room.remoteParticipants.set('totor', { identity: 'totor' });
    try {
      app.renderPlayerList();
      const text = rowTexts();
      assert.ok(text.includes('totor'), `expected totor in the list, got: ${text}`);
      assert.ok(text.includes('no position yet'), `expected the no-position label, got: ${text}`);
      assert.ok(!/\d+ m/.test(text), `a player we cannot place must not get a distance: ${text}`);
    } finally {
      app.room.remoteParticipants.delete('totor');
    }
  });

  test('the list stays empty when nobody else is in the room', () => {
    app.renderPlayerList();
    assert.ok(rowTexts().includes('No other players in the room yet'));
  });

  test('a participant who does have a position is placed, not listed as unknown', () => {
    app.room.remoteParticipants.set('velp', { identity: 'velp' });
    app.peers.set('velp', { x: app.me.x + 10, y: 0, z: app.me.z, lastSeen: Date.now() });
    try {
      app.renderPlayerList();
      const text = rowTexts();
      assert.ok(text.includes('velp'));
      assert.ok(!text.includes('no position yet'), `expected a real distance, got: ${text}`);
    } finally {
      app.room.remoteParticipants.delete('velp');
    }
  });
});

describe('doppler switch and strength', () => {
  const el = (n) => stub.elements[n];

  // Re-runs the module's own load path against a chosen stored state, which is
  // the only way to see what a fresh browser gets: beforeEach switches the
  // effect off, so the import-time default cannot be read off module state.
  const reload = () => app.setupDoppler();
  const restore = () => { localStorage.clear(); reload(); };

  test('on at the gentle strength for a browser that has never seen it', () => {
    localStorage.clear();
    try {
      reload();
      assert.strictEqual(app.dopplerPreset, 'subtle');
      assert.strictEqual(el('doppler').getAttribute('aria-checked'), 'true');
      assert.strictEqual(el('dopplerLevels').style.display, '');
    } finally {
      restore();
    }
  });

  // Nothing stored and "stored as off" are different people: one has never had
  // an opinion, the other has already said no. Reading both as "no value" would
  // switch the effect back on under someone who turned it off on purpose.
  test('switched off on purpose, it stays off across a reload', () => {
    localStorage.clear();
    try {
      localStorage.setItem('onzvoip.v2.doppler', '');
      localStorage.setItem('onzvoip.v2.dopplerLevel', 'strong');
      reload();
      assert.strictEqual(app.dopplerPreset, null);
      assert.strictEqual(el('doppler').getAttribute('aria-checked'), 'false');
      assert.strictEqual(el('dopplerLevels').style.display, 'none');
      // ...and the strength it was left at is still the one waiting for it.
      el('doppler').dispatch('click');
      assert.strictEqual(app.dopplerPreset, 'strong');
    } finally {
      restore();
    }
  });

  // One switch, not two: someone who wants the effect should not have to form
  // an opinion about what "subtle" means before hearing anything.
  test('turning it on picks the gentle strength and unfolds the row', () => {
    el('doppler').dispatch('click');
    assert.strictEqual(app.dopplerPreset, 'subtle');
    assert.strictEqual(el('dopplerLevels').style.display, '');
    assert.match(el('dopplerSubtle').className, /selected/);
    assert.doesNotMatch(el('dopplerStrong').className, /selected/);
  });

  test('picking a strength while it is on changes the dose', () => {
    el('doppler').dispatch('click');
    el('dopplerStrong').dispatch('click');
    assert.strictEqual(app.dopplerPreset, 'strong');
    assert.match(el('dopplerStrong').className, /selected/);
    assert.doesNotMatch(el('dopplerSubtle').className, /selected/);
  });

  // The strength is a preference, not part of the on/off state: coming back to
  // the effect should give you the dose you chose, not reset you to the gentle
  // one you already rejected.
  test('the strength is remembered across an off/on round trip', () => {
    el('doppler').dispatch('click');
    el('dopplerStrong').dispatch('click');
    el('doppler').dispatch('click');
    assert.strictEqual(app.dopplerPreset, null);
    assert.strictEqual(localStorage.getItem('onzvoip.v2.doppler'), '');
    assert.strictEqual(localStorage.getItem('onzvoip.v2.dopplerLevel'), 'strong');
    el('doppler').dispatch('click');
    assert.strictEqual(app.dopplerPreset, 'strong');
    assert.strictEqual(localStorage.getItem('onzvoip.v2.doppler'), 'strong');
  });
});

describe('driveDoppler()', () => {
  // Records every ramp the delay line is asked for; the value at the end of the
  // ramp is what the ear hears as a pitch, so that is what the tests look at.
  const fakeNode = () => ({
    delay: {
      delayTime: {
        value: 0,
        ramps: [],
        cancelScheduledValues() {},
        setValueAtTime(v) { this.value = v; },
        linearRampToValueAtTime(v, t) { this.value = v; this.ramps.push([v, t]); },
      },
    },
  });

  // The switch owns on/off and the chips own the dose, so a test that wants a
  // named strength has to say both - and the chips are only live while it is on.
  const dopplerOn = (level) => {
    if (stub.elements.doppler.getAttribute('aria-checked') !== 'true') {
      stub.elements.doppler.dispatch('click');
    }
    stub.elements[level].dispatch('click');
  };
  const dopplerOff = () => {
    if (stub.elements.doppler.getAttribute('aria-checked') === 'true') {
      stub.elements.doppler.dispatch('click');
    }
  };

  test('a graph with no delay node is left alone rather than crashing', () => {
    const n = { gainNode: {}, panner: {} };
    app.driveDoppler(n, 100, 1);
    assert.strictEqual(n.dopplerSec, undefined);
  });

  test('with the effect off the line sits at the base headroom', () => {
    const n = fakeNode();
    app.driveDoppler(n, 500, 10);
    assert.ok(Math.abs(n.dopplerSec - 0.01) < 1e-9, `got ${n.dopplerSec}`);
  });

  test('on: the first frame snaps to the real travel time, no swoop', () => {
    dopplerOn('dopplerSubtle');
    const n = fakeNode();
    app.driveDoppler(n, 343, 10); // one second of travel, dosed to 0.3
    assert.ok(Math.abs(n.dopplerSec - 0.31) < 1e-9, `got ${n.dopplerSec}`);
    assert.deepStrictEqual(n.delay.delayTime.ramps.length, 1);
  });

  // Closing the gap shortens the delay: the sound arrives sooner every frame,
  // which IS the pitch going up. Nothing in the code computes a ratio.
  test('on: closing the gap shortens the delay, opening it lengthens it', () => {
    dopplerOn('dopplerSubtle');
    const n = fakeNode();
    app.driveDoppler(n, 343, 10);
    const far = n.dopplerSec;
    app.driveDoppler(n, 0, 10.5);
    const near = n.dopplerSec;
    assert.ok(near < far, `expected the delay to shrink, ${far} -> ${near}`);
    app.driveDoppler(n, 343, 11);
    assert.ok(n.dopplerSec > near);
  });

  test('on: a teleporting peer is rate limited, not pitched into a squeak', () => {
    dopplerOn('dopplerStrong');
    const n = fakeNode();
    app.driveDoppler(n, 0, 10);
    app.driveDoppler(n, 20000, 10.5); // half a second later, kilometres away
    // Two frames, each capped at the preset rate over one segment.
    const ceiling = 0.01 + 2 * DOPPLER_PRESETS.strong.maxRate * 0.05;
    assert.ok(n.dopplerSec <= ceiling + 1e-9, `got ${n.dopplerSec}`);
  });

  test('turning the effect off walks the delay home instead of snapping', () => {
    dopplerOn('dopplerStrong');
    const n = fakeNode();
    app.driveDoppler(n, 1000, 10);
    const held = n.dopplerSec;
    // A kilometre away, dosed by the preset: seconds of delay, not milliseconds.
    assert.ok(held > 1.5, `got ${held}`);
    dopplerOff();
    app.driveDoppler(n, 1000, 10.1);
    assert.ok(n.dopplerSec < held, 'should be heading home');
    assert.ok(n.dopplerSec > 1, `snapped instead of walking: ${n.dopplerSec}`);
  });

  test('a frame from a backgrounded tab does not move the line for seconds', () => {
    dopplerOn('dopplerStrong');
    const n = fakeNode();
    app.driveDoppler(n, 0, 10);
    app.driveDoppler(n, 20000, 400); // tab was hidden for six minutes
    // The schedule advances one segment per frame however late the frame is, so
    // the gap between two frames can never become a leap in the delay.
    assert.ok(n.dopplerSec <= 0.01 + DOPPLER_PRESETS.strong.maxRate * 0.05 + 1e-9, `got ${n.dopplerSec}`);
  });

  // The crackle regression. The first version cancelled and re-issued the ramp
  // on every animation frame; frames land early, so a ramp still in flight got
  // dropped and the parameter was jerked to an end value it had not reached.
  // That jump is a click, and at frame rate it is a continuous crackle. The
  // queue must therefore only ever be appended to.
  const drivenNode = () => {
    const n = fakeNode();
    const p = n.delay.delayTime;
    p.sets = 0; p.cancels = 0;
    p.setValueAtTime = function (v) { this.value = v; this.sets++; };
    p.cancelScheduledValues = function () { this.cancels++; };
    return n;
  };

  const irregularFrames = (n, dist, from, count) => {
    // Deliberately uneven, the way requestAnimationFrame really behaves.
    const gaps = [0.017, 0.009, 0.024, 0.016, 0.033, 0.008];
    let t = from;
    for (let i = 0; i < count; i++) {
      app.driveDoppler(n, dist, t);
      t += gaps[i % gaps.length];
    }
    return t;
  };

  test('a queued ramp is never cancelled or rewritten in flight', () => {
    dopplerOn('dopplerSubtle');
    const n = drivenNode();
    irregularFrames(n, 300, 10, 120);
    const p = n.delay.delayTime;
    assert.strictEqual(p.sets, 1, `the parameter was jumped ${p.sets} times`);
    assert.strictEqual(p.cancels, 1, `the queue was cancelled ${p.cancels} times`);
    assert.ok(p.ramps.length > 10, `nothing was scheduled: ${p.ramps.length}`);
    for (let i = 1; i < p.ramps.length; i++) {
      assert.ok(p.ramps[i][1] > p.ramps[i - 1][1], `ramp ${i} does not follow the last one`);
    }
  });

  test('the queue stays close to the audio clock instead of running away', () => {
    dopplerOn('dopplerSubtle');
    const n = drivenNode();
    const end = irregularFrames(n, 300, 10, 120);
    assert.ok(n.dopplerUntil - end < 0.16, `queued ${n.dopplerUntil - end}s ahead`);
    assert.ok(n.dopplerUntil > end, 'the queue ran dry');
  });

  test('a stalled tab re-anchors once rather than scheduling into the past', () => {
    dopplerOn('dopplerSubtle');
    const n = drivenNode();
    app.driveDoppler(n, 300, 10);
    app.driveDoppler(n, 300, 400); // six minutes in the background
    const p = n.delay.delayTime;
    assert.strictEqual(p.sets, 2, 'should re-anchor exactly once per stall');
    assert.ok(n.dopplerUntil > 400, `queued in the past: ${n.dopplerUntil}`);
  });

  test('tickGains drives it for every peer that has a delay node', () => {
    dopplerOn('dopplerSubtle');
    const n = fakeNode();
    n.gainNode = { gain: { value: 0, setTargetAtTime() {} } };
    n.panner = { pan: { value: 0, setTargetAtTime() {} } };
    n.filter = { frequency: { value: 0, setTargetAtTime() {} } };
    app.peers.set('alice', { x: app.me.x + 100, y: 0, z: app.me.z, lastSeen: Date.now() });
    app.audioNodes.set('alice', n);
    app.tickGains();
    assert.ok(n.delay.delayTime.ramps.length > 0, 'tickGains never touched the delay');
    assert.ok(n.dopplerSec > 0.01, `100 m should be an audible travel time, got ${n.dopplerSec}`);
  });
});
