import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distance, clamp, gainForDistance, panForOffset,
  gainForDistanceRealistic, lowpassForDistance, LOWPASS_NEAR_HZ, LOWPASS_FAR_HZ,
  toCarFrame,
  dopplerDelayFor, DOPPLER_PRESETS, DOPPLER_BASE_SEC, DOPPLER_MAX_DELAY_SEC, SPEED_OF_SOUND,
  DOPPLER_GLIDE_SEC,
} from '../public/audio-math.js';

describe('distance()', () => {
  test('same point → 0', () => {
    assert.strictEqual(distance({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), 0);
  });

  test('3-4-5 triangle (2D)', () => {
    assert.strictEqual(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  });

  test('z component counts', () => {
    assert.strictEqual(distance({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }), 10);
  });

  test('z defaults to 0 when absent', () => {
    assert.strictEqual(distance({ x: 3, y: 4 }, { x: 0, y: 0 }), 5);
  });

  test('symmetric', () => {
    const a = { x: 10, y: 20, z: 5 };
    const b = { x: -5, y: 8, z: 1 };
    assert.strictEqual(distance(a, b), distance(b, a));
  });

  test('always non-negative', () => {
    assert.ok(distance({ x: -100, y: -200, z: -50 }, { x: 50, y: 80, z: 30 }) >= 0);
  });
});

describe('clamp()', () => {
  test('below lo → lo', () => assert.strictEqual(clamp(-5, 0, 10), 0));
  test('above hi → hi', () => assert.strictEqual(clamp(15, 0, 10), 10));
  test('within range → unchanged', () => assert.strictEqual(clamp(5, 0, 10), 5));
  test('at lo boundary', () => assert.strictEqual(clamp(0, 0, 10), 0));
  test('at hi boundary', () => assert.strictEqual(clamp(10, 0, 10), 10));
});

describe('gainForDistance()', () => {
  const MIN = 1;
  const MAX = 150;

  test('below minDist → 1 (full volume)', () => {
    assert.strictEqual(gainForDistance(0, MIN, MAX), 1);
  });

  test('at minDist → 1', () => {
    assert.strictEqual(gainForDistance(MIN, MIN, MAX), 1);
  });

  test('at maxDist → 0 (silence)', () => {
    assert.strictEqual(gainForDistance(MAX, MIN, MAX), 0);
  });

  test('beyond maxDist → 0', () => {
    assert.strictEqual(gainForDistance(MAX + 100, MIN, MAX), 0);
    assert.strictEqual(gainForDistance(9999, MIN, MAX), 0);
  });

  test('midpoint → 0.5', () => {
    const mid = (MIN + MAX) / 2;
    const gain = gainForDistance(mid, MIN, MAX);
    assert.ok(Math.abs(gain - 0.5) < 1e-9, `expected ~0.5, got ${gain}`);
  });

  test('quarter range → 0.75', () => {
    const d = MIN + (MAX - MIN) * 0.25;
    const gain = gainForDistance(d, MIN, MAX);
    assert.ok(Math.abs(gain - 0.75) < 1e-9, `expected ~0.75, got ${gain}`);
  });

  test('gain strictly decreases with distance', () => {
    const g50  = gainForDistance(50,  MIN, MAX);
    const g100 = gainForDistance(100, MIN, MAX);
    const g120 = gainForDistance(120, MIN, MAX);
    assert.ok(g50 > g100, `g50 (${g50}) should be > g100 (${g100})`);
    assert.ok(g100 > g120, `g100 (${g100}) should be > g120 (${g120})`);
  });

  test('gain always in [0, 1]', () => {
    for (const d of [-10, 0, 1, 50, 100, 150, 200, 1000]) {
      const g = gainForDistance(d, MIN, MAX);
      assert.ok(g >= 0 && g <= 1, `gain out of [0,1] at d=${d}: ${g}`);
    }
  });
});

describe('gainForDistanceRealistic()', () => {
  const MIN = 1;
  const MAX = 150;
  const g = (d) => gainForDistanceRealistic(d, MIN, MAX);

  test('shares the endpoints with the linear curve', () => {
    assert.strictEqual(g(0), 1);
    assert.strictEqual(g(MIN), 1);
    assert.strictEqual(g(MAX), 0);
    assert.strictEqual(g(MAX + 1000), 0);
  });

  test('reaches exactly zero, not the -40 dB floor', () => {
    // The raw dB curve bottoms out at 0.01, which would leave someone parked
    // at the radar edge permanently, faintly audible. The renormalisation is
    // the whole point, so assert the approach to 0 and not just the endpoint.
    assert.ok(g(MAX - 0.5) < 0.001, `got ${g(MAX - 0.5)}`);
  });

  test('monotonically decreasing', () => {
    let prev = 1;
    for (let d = 0; d <= MAX + 20; d += 0.5) {
      const cur = g(d);
      assert.ok(cur <= prev, `rose at d=${d}: ${prev} -> ${cur}`);
      prev = cur;
    }
  });

  test('drops far faster than linear over the first half', () => {
    // This is the entire complaint being fixed: linear is still at half volume
    // halfway out, which is only -6 dB and reads as "nothing changed".
    const mid = (MIN + MAX) / 2;
    assert.ok(gainForDistance(mid, MIN, MAX) > 0.49);
    assert.ok(g(mid) < 0.12, `got ${g(mid)}`);
  });

  test('a louder falloffDb makes every intermediate point quieter', () => {
    const d = 40;
    assert.ok(gainForDistanceRealistic(d, MIN, MAX, 60) < gainForDistanceRealistic(d, MIN, MAX, 20));
  });
});

describe('lowpassForDistance()', () => {
  const MIN = 1;
  const MAX = 150;
  const f = (d) => lowpassForDistance(d, MIN, MAX);

  test('wide open up close, muffled at the edge', () => {
    assert.strictEqual(f(0), LOWPASS_NEAR_HZ);
    assert.strictEqual(f(MIN), LOWPASS_NEAR_HZ);
    assert.strictEqual(f(MAX), LOWPASS_FAR_HZ);
    assert.strictEqual(f(MAX + 500), LOWPASS_FAR_HZ);
  });

  test('monotonically decreasing', () => {
    let prev = Infinity;
    for (let d = 0; d <= MAX + 20; d += 0.5) {
      const cur = f(d);
      assert.ok(cur <= prev, `rose at d=${d}: ${prev} -> ${cur}`);
      prev = cur;
    }
  });

  test('interpolates geometrically, so halfway is the geometric mean', () => {
    // Linear interpolation would sit at ~10.6 kHz halfway out — inaudibly high,
    // i.e. no perceived change until very near the edge. Geometric spends the
    // sweep where hearing actually lives.
    const mid = (MIN + MAX) / 2;
    assert.ok(Math.abs(f(mid) - Math.sqrt(LOWPASS_NEAR_HZ * LOWPASS_FAR_HZ)) < 1);
  });

  test('stays above the speech band until well past halfway', () => {
    // Muffled must not mean unintelligible: consonants live up to ~4 kHz.
    assert.ok(f((MIN + MAX) / 2) > 4000, `got ${f((MIN + MAX) / 2)}`);
  });
});

describe('toCarFrame()', () => {
  // Heading pointing along +Z, which is the direction the radar draws downward.
  const FWD = { fx: 0, fz: 1 };
  const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

  test('no heading leaves the offset in world space', () => {
    // A browser with no plugin has no car; it must keep behaving exactly as it
    // did before headings existed rather than collapse to the centre.
    assert.deepStrictEqual(toCarFrame(7, -3, 0, 0), { right: 7, front: -3 });
    assert.deepStrictEqual(toCarFrame(7, -3, NaN, 1), { right: 7, front: -3 });
  });

  test('straight ahead reads as ahead, with nothing to either side', () => {
    const { right, front } = toCarFrame(0, 10, FWD.fx, FWD.fz);
    assert.ok(near(right, 0));
    assert.ok(near(front, 10));
  });

  test('turning the car around swaps left and right', () => {
    const a = toCarFrame(10, 0, FWD.fx, FWD.fz);
    const b = toCarFrame(10, 0, -FWD.fx, -FWD.fz);
    assert.ok(Math.abs(a.right) > 1, 'the peer should be off to one side');
    assert.ok(near(a.right, -b.right));
    assert.ok(near(a.front, -b.front));
    // The whole point of the car frame: this is the case a world-space pan gets
    // wrong, since dx never changes when only the heading does.
  });

  test('a quarter turn moves a peer from ahead of you to beside you', () => {
    const ahead = toCarFrame(0, 10, 0, 1);
    const beside = toCarFrame(0, 10, 1, 0); // same peer, car now facing +X
    assert.ok(near(ahead.front, 10));
    assert.ok(near(beside.front, 0));
    assert.ok(near(Math.abs(beside.right), 10));
  });

  test('the heading does not have to be a unit vector', () => {
    // AimDirection arrives with its altitude component dropped, so the
    // horizontal pair is shorter than 1 on any slope. Un-normalised it would
    // quietly scale the pan with the gradient of the track.
    const unit = toCarFrame(3, 4, 0.6, 0.8);
    const long = toCarFrame(3, 4, 6, 8);
    const short = toCarFrame(3, 4, 0.06, 0.08);
    assert.ok(near(unit.right, long.right) && near(unit.front, long.front));
    assert.ok(near(unit.right, short.right) && near(unit.front, short.front));
  });

  test('rotating never moves a peer closer or further away', () => {
    // The frame change must be a rotation and nothing else — distance is what
    // decides volume, and it is computed separately in 3D. If these two ever
    // disagreed, a peer would sound near while being drawn far.
    for (const [fx, fz] of [[0, 1], [1, 0], [-1, 0], [1, 1], [-2, 5], [0.3, -0.9]]) {
      const { right, front } = toCarFrame(12, -5, fx, fz);
      assert.ok(near(Math.hypot(right, front), Math.hypot(12, -5), 1e-9),
        `length changed with heading (${fx}, ${fz})`);
    }
  });
});

describe('panForOffset()', () => {
  const PAN = 10;

  test('center (dx=0) → 0', () => {
    assert.strictEqual(panForOffset(0, PAN), 0);
  });

  test('at panRange → +1 (full right)', () => {
    assert.strictEqual(panForOffset(PAN, PAN), 1);
  });

  test('at -panRange → -1 (full left)', () => {
    assert.strictEqual(panForOffset(-PAN, PAN), -1);
  });

  test('beyond panRange → clamped to +1', () => {
    assert.strictEqual(panForOffset(PAN * 100, PAN), 1);
  });

  test('beyond -panRange → clamped to -1', () => {
    assert.strictEqual(panForOffset(-PAN * 100, PAN), -1);
  });

  test('half panRange → 0.5', () => {
    assert.strictEqual(panForOffset(PAN / 2, PAN), 0.5);
  });

  test('pan always in [-1, 1]', () => {
    for (const dx of [-1000, -10, -5, 0, 5, 10, 1000]) {
      const pan = panForOffset(dx, PAN);
      assert.ok(pan >= -1 && pan <= 1, `pan out of [-1,1] at dx=${dx}: ${pan}`);
    }
  });
});

describe('dopplerDelayFor()', () => {
  test('first call snaps to the target instead of swooping in from zero', () => {
    const d = dopplerDelayFor(343, NaN, 0.016, 'exact');
    assert.ok(Math.abs(d - (DOPPLER_BASE_SEC + 1)) < 1e-9, `got ${d}`);
  });

  test('the target is the travel time, dosed by the preset scale', () => {
    for (const [name, p] of Object.entries(DOPPLER_PRESETS)) {
      const expected = DOPPLER_BASE_SEC + (686 / SPEED_OF_SOUND) * p.scale;
      const d = dopplerDelayFor(686, NaN, 0.016, name);
      assert.ok(Math.abs(d - expected) < 1e-9, `${name}: got ${d}, want ${expected}`);
    }
  });

  test('distance zero is the base headroom, never a delay of zero', () => {
    assert.strictEqual(dopplerDelayFor(0, NaN, 0.016, 'exact'), DOPPLER_BASE_SEC);
    assert.ok(DOPPLER_BASE_SEC > 0);
  });

  // The pitch shift IS the rate of change of the delay, so the rate cap is the
  // only thing standing between a teleporting peer and a chipmunk.
  test('the delay never moves faster than the preset allows', () => {
    for (const [name, p] of Object.entries(DOPPLER_PRESETS)) {
      const dt = 0.016;
      const up = dopplerDelayFor(20000, 0.5, dt, name);
      assert.ok(up - 0.5 <= p.maxRate * dt + 1e-12, `${name} ran away upward: ${up}`);
      const down = dopplerDelayFor(0, 0.5, dt, name);
      assert.ok(0.5 - down <= p.maxRate * dt + 1e-12, `${name} ran away downward: ${down}`);
    }
  });

  // A tab returning from the background hands us a huge dt; the caller clamps
  // it, but the cap must hold on its own terms too - rate times dt, no more.
  test('a long frame is allowed a proportionally longer move, not an unbounded one', () => {
    const p = DOPPLER_PRESETS.subtle;
    const moved = dopplerDelayFor(20000, 0.1, 1, 'subtle') - 0.1;
    assert.ok(Math.abs(moved - p.maxRate) < 1e-12, `got ${moved}`);
  });

  // The glide. Positions arrive five times a second, so without it the delay
  // would sprint at the cap for one tick and then sit still until the next
  // packet - a pitch flicking on and off, which is heard as roughness.
  test('a tick closes a fraction of the gap, not the whole gap', () => {
    // Small enough a gap that the glide, not the rate cap, is what bites.
    const target = DOPPLER_BASE_SEC + (343 / SPEED_OF_SOUND) * DOPPLER_PRESETS.subtle.scale;
    const moved = dopplerDelayFor(343, target - 0.01, 0.05, 'subtle') - (target - 0.01);
    assert.ok(moved > 0 && moved < 0.01, `should be part of the gap, got ${moved}`);
    assert.ok(Math.abs(moved - 0.01 * (0.05 / DOPPLER_GLIDE_SEC)) < 1e-12, `got ${moved}`);
  });

  test('a held target is approached in shrinking steps, never overshot', () => {
    const target = DOPPLER_BASE_SEC + (343 / SPEED_OF_SOUND) * DOPPLER_PRESETS.subtle.scale;
    // Started inside the rate cap on purpose: from far away the cap is what
    // governs, and equal capped steps would say nothing about the glide.
    let prev = target - 0.004;
    let last = Infinity;
    for (let i = 0; i < 8; i++) {
      const next = dopplerDelayFor(343, prev, 0.05, 'subtle');
      const step = next - prev;
      assert.ok(step > 0 && step < last, `step ${i} did not shrink: ${step}`);
      assert.ok(next <= target + 1e-12, 'overshot');
      last = step;
      prev = next;
    }
  });

  // The property the whole effect rests on: at a constant closing speed the
  // delay must move at a CONSTANT rate, because a constant rate is a constant
  // interval. If the glide left a wobble here, the pitch would wobble with it.
  test('a constant closing speed settles into a constant rate', () => {
    let dist = 400, prev = NaN;
    const steps = [];
    for (let i = 0; i < 120; i++) {
      const next = dopplerDelayFor(dist, prev, 0.05, 'subtle');
      if (isFinite(prev)) steps.push(next - prev);
      prev = next;
      dist -= 2; // 40 m/s, held steady
    }
    // The approach is exponential, so "settled" means settled to within a
    // rounding error of the true rate, not exactly equal to it.
    const settled = steps.slice(-20);
    const expected = -(2 / SPEED_OF_SOUND) * 0.3; // one tick of travel time, dosed
    for (const s of settled) assert.ok(Math.abs(s - expected) < 1e-6, `got ${s}, want ${expected}`);
  });

  // The staircase itself: the target only moves when a packet lands, so the
  // regression to guard against is all the motion piling into that one tick.
  test('a target that only moves every fourth tick still moves every tick', () => {
    let prev = NaN, dist = 800;
    const steps = [];
    for (let i = 0; i < 120; i++) {
      if (i % 4 === 0) dist -= 8; // one packet's worth of closing, 5 times a second
      const next = dopplerDelayFor(dist, prev, 0.05, 'subtle');
      if (isFinite(prev)) steps.push(Math.abs(next - prev));
      prev = next;
    }
    const settled = steps.slice(-20);
    const min = Math.min(...settled), max = Math.max(...settled);
    assert.ok(min > 0, 'the delay froze between packets');
    assert.ok(min > max * 0.4, `sprint-then-freeze is back: ${min} vs ${max}`);
  });

  test('an unknown preset name falls back to the gentlest one', () => {
    assert.strictEqual(
      dopplerDelayFor(500, 0.2, 0.016, 'nonsense'),
      dopplerDelayFor(500, 0.2, 0.016, 'subtle'),
    );
  });

  test('never exceeds the delay buffer we allocated', () => {
    for (const dist of [500, 5000, 1e9]) {
      assert.ok(dopplerDelayFor(dist, NaN, 0.016, 'exact') <= DOPPLER_MAX_DELAY_SEC);
    }
  });

  test('garbage distance is treated as zero, not as NaN', () => {
    assert.strictEqual(dopplerDelayFor(NaN, NaN, 0.016, 'exact'), DOPPLER_BASE_SEC);
    assert.strictEqual(dopplerDelayFor(-50, NaN, 0.016, 'exact'), DOPPLER_BASE_SEC);
  });

  // Approaching at rate r plays the sound back at 1/(1-r): the caps are chosen
  // so the worst case stays a recognisable voice rather than a squeak.
  test('the implied pitch stays under a factor of ten even at the exact preset', () => {
    for (const p of Object.values(DOPPLER_PRESETS)) {
      assert.ok(p.maxRate < 1, 'a rate of 1 would freeze the audio entirely');
      // 0.9 is exactly a factor of ten, and 1 - 0.9 in binary floating point is
      // a hair under 0.1, so the bound is written with room for that hair.
      assert.ok(1 / (1 - p.maxRate) <= 10.001, `${p.maxRate} -> ${1 / (1 - p.maxRate)}`);
    }
  });
});
