// Turns a TM server's identity into a LiveKit room name — pure, no I/O.
// See todo.txt "Step 3b" for the design decision: the room is named after the
// server so a player sees "ONZSM Stadium" rather than "room-a3f9c1".
//
// Three constraints make this less trivial than a slugify():
//   - TM server names carry formatting codes ($fff, $o, $l[url]...) that must
//     be stripped before the name is shown or used anywhere;
//   - after stripping there are still accents, spaces and emoji, so the result
//     has to be normalised into a safe room identifier;
//   - two servers CAN share a name, but never a login — so the name alone would
//     merge two servers into one room, recreating the exact bug we're fixing.
//     Hence: normalised name + a short suffix derived from the login.
//
// The suffix is NOT a secret and is not meant to be one: server logins are
// public, so room names are guessable by design. Isolation comes from the
// one-time token (todo.txt A-bis), never from the room name being hard to
// guess. See todo.txt "RECOMMENDED IMPLEMENTATION ORDER".

// $$ is an escaped literal dollar and must win over the code patterns; the
// bracketed link tags ($l[url]) must be tried before the bare-letter form,
// since "l" also matches [a-zA-Z].
const TM_FORMAT_CODE = /\$(\$)|\$[0-9a-fA-F]{3}|\$[lhp]\[[^\]]*\]|\$[a-zA-Z<>]/g;

const MAX_LABEL_LENGTH = 40;

/** Strips Trackmania formatting codes, keeping the visible text. */
export function stripTmFormatting(name) {
  if (typeof name !== 'string') return '';
  return name.replace(TM_FORMAT_CODE, (_match, escapedDollar) => (escapedDollar ? '$' : ''));
}

/**
 * Reduces arbitrary text to a lowercase ASCII slug safe to use as a room name.
 * Returns '' when nothing usable survives (e.g. a name made only of emoji).
 * Known limitation: NFD only decomposes combining accents (é → e), not letters
 * that are ASCII-foreign by design (ø, ß, æ) — those fall through to '-'.
 * Acceptable here: worst case is a slightly uglier room name, never a crash or
 * a collision (the login-derived suffix still guarantees uniqueness).
 */
export function normalizeForRoom(text) {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // drop combining accents left by NFD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LABEL_LENGTH)
    .replace(/-+$/g, ''); // slice() may have cut mid-separator
}

// FNV-1a, 32-bit. Chosen over a crypto hash because this only needs to be
// deterministic and collision-resistant enough to separate two same-named
// servers — not unpredictable. Keeps the module dependency-free.
function shortHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0').slice(-4);
}

/**
 * The LiveKit room name for a server.
 * Returns null when there is no login — no login means no identifiable server,
 * and the caller must decide what that means (solo, editor, menus).
 */
export function roomNameFor(serverLogin, serverName) {
  const login = typeof serverLogin === 'string' ? serverLogin.trim() : '';
  if (login === '') return null;

  const label = normalizeForRoom(stripTmFormatting(serverName));
  const suffix = shortHash(login);
  // A name of only emoji/punctuation normalises to '' — fall back to a generic
  // prefix so the room is still uniquely identified by the login's suffix.
  return label === '' ? `tm-${suffix}` : `${label}-${suffix}`;
}

/**
 * The server name to show a human (web UI, in-game widget).
 * Falls back to the login so there is always something to display.
 */
export function displayNameFor(serverLogin, serverName) {
  const stripped = stripTmFormatting(serverName).trim();
  if (stripped !== '') return stripped;
  return typeof serverLogin === 'string' ? serverLogin.trim() : '';
}
