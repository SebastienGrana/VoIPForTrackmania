import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { positionGroups, CULL_RADIUS_M } from '../src/position-cull.js';

const at = (pseudo, x, z = 0) => ({ pseudo, x, y: 0, z });
const known = (entries) => new Map(entries.map(([p, x, z = 0]) => [p, { x, y: 0, z }]));

// A dozen players in one spot: everyone is relevant to everyone, so culling
// must not turn one broadcast into twelve sends.
function packed(n) {
  const positions = [], listeners = [];
  for (let i = 0; i < n; i++) { positions.push(at(`p${i}`, i)); listeners.push([`p${i}`, i]); }
  return { positions, listeners: known(listeners) };
}

// Two clusters far enough apart that nobody in one can hear the other.
function split(n) {
  const positions = [], listeners = [];
  for (let i = 0; i < n; i++) {
    const x = i < n / 2 ? i : 100000 + i;
    positions.push(at(`p${i}`, x));
    listeners.push([`p${i}`, x]);
  }
  return { positions, listeners: known(listeners) };
}

describe('positionGroups()', () => {
  test('nothing to send → no messages at all', () => {
    assert.deepEqual(positionGroups([], known([['a', 0]])), []);
  });

  test('without listener positions → single broadcast (previous behaviour)', () => {
    const positions = [at('a', 0), at('b', 1)];
    const groups = positionGroups(positions, null);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].identities, null);
    assert.deepEqual(groups[0].positions, positions);
  });

  test('small room → single broadcast, culling is not worth it', () => {
    const { positions, listeners } = split(4);
    const groups = positionGroups(positions, listeners);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].identities, null);
  });

  test('big room, everyone packed together → still a single broadcast', () => {
    const { positions, listeners } = packed(12);
    const groups = positionGroups(positions, listeners);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].identities, null);
  });

  test('big room, two distant clusters → one targeted message per cluster', () => {
    const { positions, listeners } = split(12);
    const groups = positionGroups(positions, listeners);
    assert.equal(groups.length, 2);
    for (const g of groups) {
      assert.equal(g.identities.length, 6);
      assert.equal(g.positions.length, 6);
      // Nobody is handed a peer they could not possibly hear.
      assert.deepEqual([...g.identities].sort(), g.positions.map((p) => p.pseudo).sort());
    }
  });

  test('a listener always receives their own position (follow-game needs it)', () => {
    const positions = [at('lonely', 0), ...Array.from({ length: 11 }, (_, i) => at(`p${i}`, 100000 + i))];
    const listeners = known([['lonely', 0], ...Array.from({ length: 11 }, (_, i) => [`p${i}`, 100000 + i])]);
    const groups = positionGroups(positions, listeners);
    const mine = groups.find((g) => g.identities?.includes('lonely'));
    assert.ok(mine, 'the isolated listener still gets a message');
    assert.deepEqual(mine.positions.map((p) => p.pseudo), ['lonely']);
  });

  test('a peer just inside the radius is kept, just outside is dropped', () => {
    const positions = [at('me', 0), at('near', CULL_RADIUS_M - 1), at('far', CULL_RADIUS_M + 1)];
    const listeners = known([
      ['me', 0], ['near', CULL_RADIUS_M - 1], ['far', CULL_RADIUS_M + 1],
      ...Array.from({ length: 9 }, (_, i) => [`x${i}`, 500000 + i * 1000]),
    ]);
    const groups = positionGroups(positions, listeners);
    const mine = groups.find((g) => g.identities?.includes('me'));
    assert.deepEqual(mine.positions.map((p) => p.pseudo), ['me', 'near']);
  });

  test('too many distinct neighbourhoods → fall back to one broadcast', () => {
    const positions = [], listeners = [];
    for (let i = 0; i < 20; i++) { positions.push(at(`p${i}`, i * 100000)); listeners.push([`p${i}`, i * 100000]); }
    const groups = positionGroups(positions, known(listeners));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].identities, null);
  });

  test('a listener with a broken position → one broadcast rather than a guess', () => {
    const { positions, listeners } = split(12);
    listeners.set('p0', { x: NaN, y: 0, z: 0 });
    const groups = positionGroups(positions, listeners);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].identities, null);
  });
});
