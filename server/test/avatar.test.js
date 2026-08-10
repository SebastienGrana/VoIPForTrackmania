// avatar.js is deliberately DOM-free, so it can be tested straight - no stub
// harness, no import-order dance. Two things are worth guarding here: the
// country guess (it decides what most players see without ever being asked), and
// validateAvatar(), which is the boundary every value coming from another
// player's browser has to cross.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AVATAR_EMOJI, emojiForPseudo, guessCountry, validateAvatar, resolveAvatar,
  isFlagCode, allFlagCodes, flagUrl, flagName,
} from '../public/avatar.js';

describe('the emoji palette', () => {
  test('has no duplicates, since the whole point is telling players apart', () => {
    assert.strictEqual(new Set(AVATAR_EMOJI).size, AVATAR_EMOJI.length);
  });

  test('the same pseudo always gets the same emoji, on every machine', () => {
    assert.strictEqual(emojiForPseudo('velp'), emojiForPseudo('velp'));
    assert.ok(AVATAR_EMOJI.includes(emojiForPseudo('velp')));
  });

  test('an empty pseudo still yields an emoji rather than undefined', () => {
    assert.ok(AVATAR_EMOJI.includes(emojiForPseudo('')));
  });
});

describe('the flag catalogue', () => {
  test('only codes we actually ship are accepted', () => {
    assert.ok(isFlagCode('fr'));
    assert.ok(isFlagCode('gb-sct'));
    assert.ok(!isFlagCode('zz'));
    // The one that matters: a code becomes part of a URL, so anything that could
    // walk out of public/flags must not get through.
    assert.ok(!isFlagCode('../../etc/passwd'));
    assert.ok(!isFlagCode('fr/../../secret'));
  });

  test('the picker never offers the "unknown" placeholder', () => {
    assert.ok(!allFlagCodes().includes('xx'));
    // ...but it stays valid over the wire, so an old client sending it does not
    // get its avatar wiped.
    assert.ok(isFlagCode('xx'));
  });

  test('a code with no English name falls back to the code itself', () => {
    assert.strictEqual(flagName('fr'), 'France');
    assert.strictEqual(flagName('tv'), 'TV');
  });

  test('the URL stays inside the flags folder', () => {
    assert.strictEqual(flagUrl('fr'), 'flags/fr.svg');
  });
});

describe('guessing the country', () => {
  test('the time zone wins, because it survives an English-language browser', () => {
    assert.strictEqual(guessCountry({ timeZone: 'Europe/Paris', languages: ['en-US'] }), 'fr');
  });

  test('an explicit region in the locale is used when the zone is unknown', () => {
    assert.strictEqual(guessCountry({ timeZone: 'Antarctica/Troll', languages: ['fr-BE', 'fr'] }), 'be');
  });

  test('a bare language is only expanded once nobody has stated a region', () => {
    // 'en' alone would expand to US; 'en-GB' further down the list is a
    // statement and must win over the expansion of the one before it.
    assert.strictEqual(guessCountry({ timeZone: null, languages: ['en', 'en-GB'] }), 'gb');
  });

  test('script and area subtags are not mistaken for countries', () => {
    // 'Hant' is a script and '419' is a UN region; neither is a flag.
    const got = guessCountry({ timeZone: null, languages: ['zh-Hant-TW'] });
    assert.strictEqual(got, 'tw');
    assert.notStrictEqual(guessCountry({ timeZone: null, languages: ['es-419'] }), '41');
  });

  test('no signal at all is a null, not a wrong flag', () => {
    assert.strictEqual(guessCountry({ timeZone: null, languages: [] }), null);
  });
});

describe('validating an avatar that arrived from another player', () => {
  test('a shipped flag and a palette emoji get through', () => {
    assert.deepStrictEqual(validateAvatar({ kind: 'flag', code: 'de' }), { kind: 'flag', code: 'de' });
    assert.deepStrictEqual(validateAvatar({ kind: 'emoji', value: '🦊' }), { kind: 'emoji', value: '🦊' });
  });

  test('anything else becomes null instead of reaching the screen', () => {
    for (const bad of [
      null, undefined, 'fr', 42, {},
      { kind: 'flag', code: 'zz' },
      { kind: 'flag', code: '../secret' },
      { kind: 'emoji', value: '<img onerror=alert(1)>' },
      { kind: 'emoji', value: '🦄'.repeat(500) },
      { kind: 'image', url: 'https://example.com/a.png' },
    ]) {
      assert.strictEqual(validateAvatar(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('extra fields are dropped rather than carried along', () => {
    const out = validateAvatar({ kind: 'flag', code: 'it', onerror: 'boom', size: 9999 });
    assert.deepStrictEqual(out, { kind: 'flag', code: 'it' });
  });
});

describe('resolving what to draw', () => {
  test('a chosen flag wins', () => {
    assert.deepStrictEqual(
      resolveAvatar('velp', { kind: 'flag', code: 'fr' }),
      { kind: 'flag', code: 'fr', url: 'flags/fr.svg' },
    );
  });

  test('nothing chosen falls back to the hashed emoji, never to blank', () => {
    assert.deepStrictEqual(resolveAvatar('velp', null), { kind: 'emoji', value: emojiForPseudo('velp') });
  });

  test('a rejected choice falls back too, so a bad packet cannot blank a blip', () => {
    assert.deepStrictEqual(
      resolveAvatar('velp', { kind: 'flag', code: 'zz' }),
      { kind: 'emoji', value: emojiForPseudo('velp') },
    );
  });
});
