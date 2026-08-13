import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distance, clamp, gainForDistance, panForOffset,
  gainForDistanceRealistic, lowpassForDistance, LOWPASS_NEAR_HZ, LOWPASS_FAR_HZ,
  toCarFrame,
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
