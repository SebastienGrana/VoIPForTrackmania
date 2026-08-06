import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { distance, clamp, gainForDistance, panForOffset } from '../src/audio-math.js';

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
