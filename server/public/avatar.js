// Who's who on the radar: the little picture drawn next to (and instead of) a
// player's name.
//
// It used to be a pure function of the pseudo - hash it, index a fixed emoji
// list, done. That is still the floor, and it still matters: it needs no server
// round trip, no storage, and no way for a player to inject anything into
// anyone else's screen. What sits on top of it now is a *chosen* avatar, because
// in Trackmania a player is inseparable from their country flag, and a hash
// cannot know a country.
//
// This module is deliberately DOM-free so the tests can exercise it directly.

// ---------------------------------------------------------------------------
// The emoji palette (the fallback, and half the picker)
// ---------------------------------------------------------------------------

// 115 entries, and the size is the whole point: when nothing has been chosen the
// avatar is picked by hashing the pseudo, so the only lever on two players
// sharing one is how many there are to choose from. At the previous 40 there was
// a 53% chance of a duplicate on an 8-player server; at 115 it drops to 22%.
//
// Every entry was checked rendering on Windows/Chrome at 15px - the size they
// actually appear at on the radar - and three families were deliberately left
// out after that check:
//   - country flags (🇫🇷, 🇩🇪...): Windows ships no glyphs for them at all, so
//     they come out as the literal letters "FR", "DE". That is exactly why real
//     country flags below are SVG images and not emoji. The six generic flags
//     in this list do render.
//   - gender-neutral professions (🧑‍🚀, 🧑‍🍳...): the ZWJ sequence falls apart
//     into two side-by-side glyphs, twice the width, which breaks the radar.
//   - realistic professions (👮, 👷, 👨‍🚀...): they render fine, but at 15px
//     thirty of them are thirty near-identical beige smudges. Adding them would
//     have moved the collision rate from 22% to 18% while making two *different*
//     avatars indistinguishable, which is the same problem wearing a hat.
export const AVATAR_EMOJI = [
  // Animals (84) - the best performers small: strong flat colours, varied outlines.
  '🐸', '🐙', '🦊', '🐢', '🐝', '🦉', '🐳', '🦋', '🐿️', '🐧', '🦔', '🐨', '🐬', '🦁',
  '🦈', '🐼', '🐺', '🦅', '🦄', '🐴', '🦖', '🦕', '🐌', '🦂', '🐞', '🦆', '🦒', '🦓',
  '🐮', '🐷', '🐔', '🦩', '🦡', '🦦', '🦥', '🐊', '🦎', '🦇', '🐡', '🐵', '🦍', '🦧',
  '🐶', '🦝', '🐱', '🐯', '🐆', '🦌', '🐐', '🐪', '🦙', '🐘', '🦏', '🦛', '🐭', '🐹',
  '🐰', '🐻', '🦘', '🦃', '🐓', '🐣', '🐦', '🕊️', '🦢', '🦚', '🦜', '🐍', '🐲', '🐋',
  '🐟', '🐠', '🐚', '🐛', '🐜', '🦗', '🕷️', '🦟', '🐑', '🐗', '🐄', '🦨', '🦠', '🐾',
  // Costumed characters (25) - each has its own dominant colour, so they stay
  // apart from one another and from the animals even at 15px.
  '🧙', '🧛', '🧜', '🧟', '🧚', '🦸', '🦹', '🎅', '👽', '🤖', '🤡', '👻', '🧝', '🧞',
  '👼', '🤶', '😈', '💀', '👹', '👺', '🎃', '🧙‍♀️', '🧛‍♀️', '🦸‍♀️', '🦹‍♀️',
  // Generic flags (6) - the only flags Windows actually draws.
  '🏁', '🚩', '🏴', '🎌', '🏳️', '🏴‍☠️',
];

// Same hash on every machine, so a given pseudo looks the same on everyone's
// screen without anyone having to agree on anything.
export function emojiForPseudo(pseudo) {
  let h = 0;
  for (let i = 0; i < pseudo.length; i++) h = (h * 31 + pseudo.charCodeAt(i)) >>> 0;
  return AVATAR_EMOJI[h % AVATAR_EMOJI.length];
}

// ---------------------------------------------------------------------------
// The flags
// ---------------------------------------------------------------------------

// Every file actually shipped in public/flags (flag-icons 7.5.0, MIT). Kept as a
// literal rather than probed at runtime for two reasons: a chosen code arrives
// over the network from another player, so it has to be checked against a closed
// list before it is ever concatenated into a URL, and an unknown code must fail
// as "no flag" rather than as a 404 and a broken image on the radar.
// Includes the UK nations (gb-eng, gb-sct...) and a few organisations (eu, un),
// which players do use as an identity.
const FLAG_CODES = new Set(`
ad ae af ag ai al am ao aq ar arab as asean at au aw ax az ba bb bd be bf bg bh
bi bj bl bm bn bo bq br bs bt bv bw by bz ca cc cd cefta cf cg ch ci ck cl cm cn
co cp cr cu cv cw cx cy cz de dg dj dk dm do dz eac ec ee eg eh er es-ct es-ga
es-pv es et eu fi fj fk fm fo fr ga gb-eng gb-nir gb-sct gb-wls gb gd ge gf gg
gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu ic id ie il im in io iq
ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu
lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc
ne nf ng ni nl no np nr nu nz om pa pc pe pf pg ph pk pl pm pn pr ps pt pw py qa
re ro rs ru rw sa sb sc sd se sg sh-ac sh-hl sh-ta sh si sj sk sl sm sn so sr ss
st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug um un us uy
uz va vc ve vg vi vn vu wf ws xk xx ye yt za zm zw
`.trim().split(/\s+/));

export function isFlagCode(code) {
  return typeof code === 'string' && FLAG_CODES.has(code);
}

export function allFlagCodes() {
  // 'xx' is flag-icons' placeholder for "unknown" - a grey rectangle. It is a
  // valid file, so it stays accepted over the wire, but offering it in the
  // picker would just be a worse version of the Auto button.
  return [...FLAG_CODES].filter((c) => c !== 'xx').sort();
}

export function flagUrl(code) {
  return `flags/${code}.svg`;
}

// English names, only for the picker's search box - the interface is in English
// and this is the one place a player types. Codes not listed here are still
// selectable, they just only match on their code.
// Kept to the countries a Trackmania server realistically sees; the list is a
// search aid, not a database, and an incomplete one costs nothing.
const FLAG_NAMES = {
  ad: 'Andorra', ae: 'United Arab Emirates', al: 'Albania', ar: 'Argentina',
  at: 'Austria', au: 'Australia', ba: 'Bosnia', be: 'Belgium', bg: 'Bulgaria',
  br: 'Brazil', by: 'Belarus', ca: 'Canada', ch: 'Switzerland', cl: 'Chile',
  cn: 'China', co: 'Colombia', cy: 'Cyprus', cz: 'Czechia', de: 'Germany',
  dk: 'Denmark', dz: 'Algeria', ee: 'Estonia', eg: 'Egypt', es: 'Spain',
  eu: 'European Union', fi: 'Finland', fo: 'Faroe Islands', fr: 'France',
  gb: 'United Kingdom', 'gb-eng': 'England', 'gb-nir': 'Northern Ireland',
  'gb-sct': 'Scotland', 'gb-wls': 'Wales', ge: 'Georgia', gr: 'Greece',
  hk: 'Hong Kong', hr: 'Croatia', hu: 'Hungary', id: 'Indonesia', ie: 'Ireland',
  il: 'Israel', in: 'India', iq: 'Iraq', ir: 'Iran', is: 'Iceland', it: 'Italy',
  jp: 'Japan', kr: 'South Korea', kz: 'Kazakhstan', lt: 'Lithuania',
  lu: 'Luxembourg', lv: 'Latvia', ma: 'Morocco', mc: 'Monaco', md: 'Moldova',
  me: 'Montenegro', mk: 'North Macedonia', mt: 'Malta', mx: 'Mexico',
  my: 'Malaysia', nl: 'Netherlands', no: 'Norway', nz: 'New Zealand',
  pe: 'Peru', ph: 'Philippines', pl: 'Poland', pt: 'Portugal', qa: 'Qatar',
  ro: 'Romania', rs: 'Serbia', ru: 'Russia', sa: 'Saudi Arabia', se: 'Sweden',
  sg: 'Singapore', si: 'Slovenia', sk: 'Slovakia', th: 'Thailand',
  tn: 'Tunisia', tr: 'Turkey', tw: 'Taiwan', ua: 'Ukraine', un: 'United Nations',
  us: 'United States', uy: 'Uruguay', ve: 'Venezuela', vn: 'Vietnam',
  za: 'South Africa',
};

export function flagName(code) {
  return FLAG_NAMES[code] || code.toUpperCase();
}

// ---------------------------------------------------------------------------
// Guessing the player's country
// ---------------------------------------------------------------------------

// The browser will not tell us where someone is, and we are not about to ask an
// IP geolocation service - that would mean shipping every player's address to a
// third party to decide which 20x15 picture to draw. So we guess from two things
// the browser already computed for its own purposes, and we make the guess
// trivially overridable, which is what actually makes it acceptable: nothing here
// has to be right, it only has to be right often enough that most players never
// touch the picker.
//
// The time zone is the better signal - someone running an English-language
// browser in Lyon still has Europe/Paris - so it is tried first. The table is
// curated rather than exhaustive: a wrong entry is worse than a missing one
// (a missing one falls through to the locale), so it only lists zones whose
// country is unambiguous.
const TZ_COUNTRY = {
  'Europe/Paris': 'fr', 'Europe/Brussels': 'be', 'Europe/Berlin': 'de',
  'Europe/Madrid': 'es', 'Europe/Rome': 'it', 'Europe/Amsterdam': 'nl',
  'Europe/Lisbon': 'pt', 'Europe/Warsaw': 'pl', 'Europe/Prague': 'cz',
  'Europe/Vienna': 'at', 'Europe/Zurich': 'ch', 'Europe/Stockholm': 'se',
  'Europe/Oslo': 'no', 'Europe/Copenhagen': 'dk', 'Europe/Helsinki': 'fi',
  'Europe/Dublin': 'ie', 'Europe/London': 'gb', 'Europe/Budapest': 'hu',
  'Europe/Bucharest': 'ro', 'Europe/Athens': 'gr', 'Europe/Sofia': 'bg',
  'Europe/Kyiv': 'ua', 'Europe/Kiev': 'ua', 'Europe/Moscow': 'ru',
  'Europe/Bratislava': 'sk', 'Europe/Ljubljana': 'si', 'Europe/Zagreb': 'hr',
  'Europe/Belgrade': 'rs', 'Europe/Sarajevo': 'ba', 'Europe/Skopje': 'mk',
  'Europe/Tirane': 'al', 'Europe/Podgorica': 'me', 'Europe/Chisinau': 'md',
  'Europe/Minsk': 'by', 'Europe/Tallinn': 'ee', 'Europe/Riga': 'lv',
  'Europe/Vilnius': 'lt', 'Europe/Luxembourg': 'lu', 'Europe/Malta': 'mt',
  'Europe/Monaco': 'mc', 'Europe/Andorra': 'ad', 'Europe/Istanbul': 'tr',
  'Atlantic/Reykjavik': 'is', 'Atlantic/Canary': 'es', 'Atlantic/Faroe': 'fo',
  'America/New_York': 'us', 'America/Chicago': 'us', 'America/Denver': 'us',
  'America/Los_Angeles': 'us', 'America/Phoenix': 'us', 'America/Anchorage': 'us',
  'America/Toronto': 'ca', 'America/Vancouver': 'ca', 'America/Edmonton': 'ca',
  'America/Winnipeg': 'ca', 'America/Halifax': 'ca', 'America/Montreal': 'ca',
  'America/Mexico_City': 'mx', 'America/Sao_Paulo': 'br', 'America/Bogota': 'co',
  'America/Lima': 'pe', 'America/Santiago': 'cl', 'America/Buenos_Aires': 'ar',
  'America/Argentina/Buenos_Aires': 'ar', 'America/Montevideo': 'uy',
  'America/Caracas': 've',
  'Africa/Casablanca': 'ma', 'Africa/Algiers': 'dz', 'Africa/Tunis': 'tn',
  'Africa/Cairo': 'eg', 'Africa/Johannesburg': 'za', 'Africa/Lagos': 'ng',
  'Asia/Tokyo': 'jp', 'Asia/Seoul': 'kr', 'Asia/Shanghai': 'cn',
  'Asia/Hong_Kong': 'hk', 'Asia/Taipei': 'tw', 'Asia/Singapore': 'sg',
  'Asia/Bangkok': 'th', 'Asia/Jakarta': 'id', 'Asia/Manila': 'ph',
  'Asia/Kolkata': 'in', 'Asia/Calcutta': 'in', 'Asia/Jerusalem': 'il',
  'Asia/Dubai': 'ae', 'Asia/Riyadh': 'sa', 'Asia/Qatar': 'qa',
  'Asia/Tehran': 'ir', 'Asia/Baghdad': 'iq', 'Asia/Almaty': 'kz',
  'Asia/Ho_Chi_Minh': 'vn', 'Asia/Kuala_Lumpur': 'my',
  'Australia/Sydney': 'au', 'Australia/Melbourne': 'au', 'Australia/Brisbane': 'au',
  'Australia/Perth': 'au', 'Australia/Adelaide': 'au', 'Pacific/Auckland': 'nz',
};

// `env` is injectable so the tests can pin a time zone and a language list
// instead of inheriting whatever the machine running them happens to be set to.
export function guessCountry(env = {}) {
  const tz = env.timeZone !== undefined ? env.timeZone : safeTimeZone();
  if (tz && TZ_COUNTRY[tz] && isFlagCode(TZ_COUNTRY[tz])) return TZ_COUNTRY[tz];

  const langs = env.languages !== undefined ? env.languages : safeLanguages();
  // An explicit region subtag ("fr-FR", "en-GB") is a statement; a bare language
  // ("en") is not, and expanding it would confidently hand every English-speaking
  // player a US flag. So take explicit regions first, across the whole list, and
  // only fall back to expansion if nobody stated one.
  for (const l of langs) {
    const code = regionOf(l);
    if (code && isFlagCode(code)) return code;
  }
  for (const l of langs) {
    const code = maximizedRegionOf(l);
    if (code && isFlagCode(code)) return code;
  }
  return null;
}

function safeTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

function safeLanguages() {
  try {
    const nav = globalThis.navigator;
    if (!nav) return [];
    return nav.languages && nav.languages.length ? [...nav.languages]
      : (nav.language ? [nav.language] : []);
  } catch { return []; }
}

function regionOf(tag) {
  // "fr-FR" -> fr, "zh-Hant-TW" -> tw. Only a 2-letter subtag is a region; a
  // 4-letter one ("Hant") is a script and a 3-digit one ("419") is a UN area
  // with no flag.
  const parts = String(tag).split('-');
  for (const p of parts.slice(1)) {
    if (/^[A-Za-z]{2}$/.test(p)) return p.toLowerCase();
  }
  return null;
}

function maximizedRegionOf(tag) {
  try {
    const r = new Intl.Locale(String(tag)).maximize().region;
    return r ? r.toLowerCase() : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// The avatar a player chose
// ---------------------------------------------------------------------------

// Shape: { kind: 'flag', code: 'fr' } or { kind: 'emoji', value: '🦊' }.
// `null` means "auto", which is not a third kind - it is the absence of a choice,
// resolved at draw time by resolveAvatar().
//
// This runs on values that arrived from another player's browser, so it is a
// whitelist and not a sanitiser: the code must be a file we ship, the emoji must
// be one from our own palette. Anything else becomes null, i.e. that player just
// keeps their hashed emoji. Without this, "avatar" would be a free-text field
// every participant can write onto everyone else's screen.
export function validateAvatar(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.kind === 'flag' && isFlagCode(a.code)) return { kind: 'flag', code: a.code };
  if (a.kind === 'emoji' && AVATAR_EMOJI.includes(a.value)) return { kind: 'emoji', value: a.value };
  return null;
}

// The single place that answers "what do I draw for this player". `chosen` is
// whatever validateAvatar() let through (or null), and the hashed emoji is the
// floor nobody can fall below - so there is never a blank spot on the radar.
export function resolveAvatar(pseudo, chosen) {
  const ok = validateAvatar(chosen);
  if (ok && ok.kind === 'flag') return { kind: 'flag', code: ok.code, url: flagUrl(ok.code) };
  if (ok && ok.kind === 'emoji') return { kind: 'emoji', value: ok.value };
  return { kind: 'emoji', value: emojiForPseudo(pseudo) };
}
