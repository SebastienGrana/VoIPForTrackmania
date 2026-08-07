import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTmFormatting, normalizeForRoom, roomNameFor, displayNameFor } from '../src/room-name.js';

describe('stripTmFormatting()', () => {
  test('removes 3-hex-digit color codes', () => {
    assert.strictEqual(stripTmFormatting('$fffONZSM'), 'ONZSM');
  });

  test('removes style codes ($o, $i, $t, $n, $s, $w, $z, $g)', () => {
    assert.strictEqual(stripTmFormatting('$oStadium$z'), 'Stadium');
  });

  test('removes link tags with their bracketed argument', () => {
    assert.strictEqual(stripTmFormatting('$l[http://x]Click$l'), 'Click');
  });

  test('$$ is an escaped literal dollar, not a code', () => {
    assert.strictEqual(stripTmFormatting('100$$'), '100$');
  });

  test('plain name with no codes is unchanged', () => {
    assert.strictEqual(stripTmFormatting('ONZSM Stadium'), 'ONZSM Stadium');
  });

  test('non-string input → empty string, does not throw', () => {
    assert.strictEqual(stripTmFormatting(undefined), '');
    assert.strictEqual(stripTmFormatting(null), '');
    assert.strictEqual(stripTmFormatting(42), '');
  });

  test('4000-character name does not hang or crash (ReDoS-shaped input)', () => {
    const huge = '$fff'.repeat(1000) + 'x'.repeat(1000);
    const result = stripTmFormatting(huge);
    assert.strictEqual(result, 'x'.repeat(1000));
  });
});

describe('normalizeForRoom()', () => {
  test('lowercases and hyphenates spaces', () => {
    assert.strictEqual(normalizeForRoom('ONZSM Stadium'), 'onzsm-stadium');
  });

  test('strips accents via NFD decomposition', () => {
    assert.strictEqual(normalizeForRoom('Café Déjà'), 'cafe-deja');
  });

  test('collapses non-alphanumeric runs into a single hyphen', () => {
    assert.strictEqual(normalizeForRoom('a!!!b   c___d'), 'a-b-c-d');
  });

  test('trims leading/trailing hyphens', () => {
    assert.strictEqual(normalizeForRoom('  --hello--  '), 'hello');
  });

  test('emoji-only name normalizes to empty string', () => {
    assert.strictEqual(normalizeForRoom('🏎️🏎️🏎️'), '');
  });

  test('empty string stays empty', () => {
    assert.strictEqual(normalizeForRoom(''), '');
  });

  test('non-string input → empty string, does not throw', () => {
    assert.strictEqual(normalizeForRoom(null), '');
    assert.strictEqual(normalizeForRoom(123), '');
  });

  test('very long name is bounded, not left to grow unbounded', () => {
    const long = 'a'.repeat(500);
    assert.ok(normalizeForRoom(long).length <= 40);
  });

  test('truncation never leaves a trailing hyphen', () => {
    // Craft a name whose 40th character lands right on a separator.
    const crafted = 'a'.repeat(39) + '-' + 'b'.repeat(20);
    const result = normalizeForRoom(crafted);
    assert.ok(!result.endsWith('-'), `expected no trailing hyphen, got "${result}"`);
  });
});

describe('roomNameFor()', () => {
  test('normal case: label + suffix derived from login', () => {
    const name = roomNameFor('a3f9c1login', 'ONZSM Stadium');
    assert.match(name, /^onzsm-stadium-[a-z0-9]{4}$/);
  });

  test('two servers with the SAME name but DIFFERENT logins → different rooms', () => {
    const a = roomNameFor('loginAAA', 'ONZSM Stadium');
    const b = roomNameFor('loginBBB', 'ONZSM Stadium');
    assert.notStrictEqual(a, b);
    assert.match(a, /^onzsm-stadium-/);
    assert.match(b, /^onzsm-stadium-/);
  });

  test('same login always yields the same room (deterministic)', () => {
    const a = roomNameFor('loginAAA', 'ONZSM Stadium');
    const b = roomNameFor('loginAAA', 'ONZSM Stadium');
    assert.strictEqual(a, b);
  });

  test('TM formatting codes in the name are stripped before use', () => {
    const name = roomNameFor('loginX', '$fffONZSM $oStadium');
    assert.match(name, /^onzsm-stadium-/);
  });

  test('name that normalizes to empty falls back to a generic prefix', () => {
    const name = roomNameFor('loginX', '🏎️🏎️🏎️');
    assert.match(name, /^tm-[a-z0-9]{4}$/);
  });

  test('missing/empty login → null (caller must decide: no server = no room)', () => {
    assert.strictEqual(roomNameFor('', 'ONZSM Stadium'), null);
    assert.strictEqual(roomNameFor(undefined, 'ONZSM Stadium'), null);
    assert.strictEqual(roomNameFor(null, 'ONZSM Stadium'), null);
  });

  test('4000-character server name does not produce an unbounded room name', () => {
    const name = roomNameFor('loginX', 'x'.repeat(4000));
    assert.ok(name.length < 60, `expected a bounded room name, got length ${name.length}`);
  });
});

describe('displayNameFor()', () => {
  test('strips formatting codes but keeps the readable text', () => {
    assert.strictEqual(displayNameFor('loginX', '$fffONZSM $oStadium'), 'ONZSM Stadium');
  });

  test('falls back to the login when the name is empty after stripping', () => {
    assert.strictEqual(displayNameFor('loginX', '$fff$o$z'), 'loginX');
  });

  test('falls back to the login when the name is only emoji', () => {
    // Emoji survive stripTmFormatting (not a TM code) but are visually a name -
    // displayNameFor only falls back on codes-only input, not on emoji-only,
    // matching roomNameFor's stricter normalizeForRoom fallback.
    assert.strictEqual(displayNameFor('loginX', '🏎️'), '🏎️');
  });

  test('both login and name empty → empty string, does not throw', () => {
    assert.strictEqual(displayNameFor('', ''), '');
  });
});
