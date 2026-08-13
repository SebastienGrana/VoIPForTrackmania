// This player's own avatar pick, everyone else's announced avatars, and the
// "Advanced settings > My avatar" picker UI that sets it. The palette, the
// country guess and the validation of a chosen avatar live in ./avatar.js,
// which is DOM-free so the tests can hit it directly; this module is
// everything that needs the page and the room.
import {
  AVATAR_EMOJI, emojiForPseudo, guessCountry, validateAvatar, resolveAvatar,
  flagUrl, flagName, allFlagCodes,
} from './avatar.js';

const AVATAR_STORAGE_KEY = 'onzvoip.avatar';
// The avatar travels player-to-player over the room's data channel, not
// through the relay: the relay only ever forwards what the game plugin
// tells it, and the plugin knows nothing about a picture chosen in a
// browser. This also means the feature needs no server or plugin change.
export const AVATAR_TOPIC = 'avatar';

export function createAvatarPicker({ getRoom, getMyIdentity }) {
  // pseudo -> avatar, as announced by that player. Populated only from
  // LiveKit data packets, and keyed on the *sender identity LiveKit signs
  // into the token* - never on a pseudo read out of the payload, which any
  // participant could set to someone else's and repaint a stranger's blip.
  const peerAvatars = new Map();

  // This player's own pick. null is not a third kind of avatar, it is the
  // absence of a pick: "Auto", resolved below to the guessed country and
  // failing that to the hashed emoji.
  let myAvatar = null;

  // Guessed once at startup rather than per draw: it reads the time zone and
  // the language list, neither of which changes mid-session, and both are
  // things the browser had already computed for itself - no geolocation
  // service is contacted, so no player's address leaves the machine.
  const guessedCountry = guessCountry();

  function myEffectiveAvatar() {
    if (myAvatar) return myAvatar;
    if (guessedCountry) return { kind: 'flag', code: guessedCountry };
    return null;
  }

  // `to` narrows the announcement to one participant - used when somebody
  // joins, so a newcomer learns everyone's avatar without the whole room
  // re-broadcasting to everyone else at the same time.
  async function announceAvatar(to) {
    const room = getRoom();
    if (!room || !room.localParticipant || !room.localParticipant.publishData) return;
    try {
      // An empty object where an avatar would be is how "I went back to Auto
      // and have nothing to announce" is said: it fails validation on the
      // other side, which deletes the entry and falls back to the hashed emoji.
      const body = new TextEncoder().encode(JSON.stringify(myEffectiveAvatar() ?? {}));
      // Reliable, unlike positions: this is sent a handful of times per
      // session and a lost packet would leave a wrong picture up until the
      // next join.
      const opts = { reliable: true, topic: AVATAR_TOPIC };
      if (to) opts.destinationIdentities = [to];
      await room.localParticipant.publishData(body, opts);
    } catch { /* a failed announcement costs a flag, not a connection */ }
  }

  function loadStoredAvatar() {
    try {
      const raw = globalThis.localStorage?.getItem(AVATAR_STORAGE_KEY);
      // A cosmetic preference, so localStorage is the right home - unlike
      // the room credentials, which are deliberately kept in memory only.
      // Nothing here grants access to anything.
      myAvatar = raw ? validateAvatar(JSON.parse(raw)) : null;
    } catch { myAvatar = null; }
  }

  function storeAvatar() {
    try {
      if (myAvatar) globalThis.localStorage?.setItem(AVATAR_STORAGE_KEY, JSON.stringify(myAvatar));
      else globalThis.localStorage?.removeItem(AVATAR_STORAGE_KEY);
    } catch { /* private mode, or storage full: the choice just won't survive a reload */ }
  }
  loadStoredAvatar();

  // Decoded SVGs, kept across draws because the radar redraws every frame
  // and re-decoding 8 flags 60 times a second would be absurd. The map holds
  // the element from the moment it is requested, still loading - drawImage
  // would throw on it, hence the readiness check in flagReady().
  const flagImages = new Map();

  function flagImage(code) {
    let img = flagImages.get(code);
    if (!img) {
      if (typeof Image === 'undefined') return null;
      img = new Image();
      img.src = flagUrl(code);
      flagImages.set(code, img);
    }
    return img;
  }

  function flagReady(img) {
    return !!img && img.complete && img.naturalWidth > 0;
  }

  // The one answer to "what do I draw for this player". Falls back through
  // the same chain everywhere - chosen flag, chosen emoji, hashed emoji - so
  // a blip and a list row are always the same picture, and neither is ever
  // blank.
  function avatarFor(pseudo) {
    return resolveAvatar(pseudo, peerAvatars.get(pseudo));
  }

  // Fills a DOM element with an avatar, in the list and in the picker alike,
  // so the two can never drift apart. Emoji stay text (they inherit the
  // row's font size and colour); flags become an <img>, since the browser
  // has no glyph for them. Written with textContent / createElement rather
  // than innerHTML because a flag code, though whitelisted, still
  // originates from another player.
  function paintAvatar(el, av, pseudo) {
    el.textContent = '';
    if (av.kind === 'flag') {
      const img = document.createElement('img');
      img.className = 'flag-img';
      img.src = flagUrl(av.code);
      img.alt = flagName(av.code);
      // Belt and braces: if the file ever fails to load, the row falls back
      // to the picture that needs no network at all rather than a broken icon.
      img.addEventListener('error', () => { el.textContent = emojiForPseudo(pseudo); }, { once: true });
      el.appendChild(img);
      return;
    }
    el.textContent = av.value;
  }

  // --- The picker: Advanced settings > My avatar ---
  //
  // It lives there rather than on the main screen so the default view still
  // matches the approved render, and it is also the only place a player can
  // see their own avatar at all - the player list deliberately shows
  // everyone else.
  const avatarPreview     = document.getElementById('avatarPreview');
  const avatarPreviewName = document.getElementById('avatarPreviewName');
  const avatarToggleBtn   = document.getElementById('avatarToggle');
  const avatarPickerPanel = document.getElementById('avatarPicker');
  const avatarSearch      = document.getElementById('avatarSearch');
  const avatarFlagGrid    = document.getElementById('avatarFlagGrid');
  const avatarEmojiGrid   = document.getElementById('avatarEmojiGrid');

  function avatarLabel() {
    if (myAvatar && myAvatar.kind === 'flag') return flagName(myAvatar.code);
    if (myAvatar) return 'Character';
    // Saying *where* the guess came from matters: a player handed the wrong
    // flag needs to understand it was inferred, not assigned, or the picker
    // below looks like a bug report rather than the fix.
    if (guessedCountry) return `Auto — ${flagName(guessedCountry)}, from your browser`;
    return 'Auto — from your name';
  }

  function renderAvatarPreview() {
    if (!avatarPreview) return;
    // Before a room is joined there is no login yet; '' still hashes to a
    // stable emoji, and the preview is refreshed on connect so it settles
    // on the real one.
    const who = getMyIdentity() || '';
    paintAvatar(avatarPreview, resolveAvatar(who, myEffectiveAvatar()), who);
    if (avatarPreviewName) avatarPreviewName.textContent = avatarLabel();
  }

  function markAvatarSelection() {
    const key = !myAvatar ? 'auto'
      : myAvatar.kind === 'flag' ? `flag:${myAvatar.code}` : `emoji:${myAvatar.value}`;
    for (const grid of [avatarFlagGrid, avatarEmojiGrid]) {
      if (!grid) continue;
      for (const cell of grid.children) cell.classList.toggle('selected', cell.dataset.key === key);
    }
  }

  function setMyAvatar(next) {
    myAvatar = next; // null means Auto
    storeAvatar();
    renderAvatarPreview();
    markAvatarSelection();
    announceAvatar();
  }

  function avatarCell(key, title, fill) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'avatar-cell';
    b.dataset.key = key;
    b.title = title;
    fill(b);
    return b;
  }

  // Sits under the flag grid rather than inside it, so an empty search reads
  // as a message and not as a cell you could click. Created next to the
  // grid only when the page actually gives it a parent to sit in.
  let avatarNoMatch = null;
  function ensureAvatarNoMatch() {
    if (avatarNoMatch || !avatarFlagGrid || !avatarFlagGrid.parentNode) return;
    avatarNoMatch = document.createElement('div');
    avatarNoMatch.className = 'avatar-empty';
    avatarNoMatch.textContent = 'No country matches that.';
    avatarNoMatch.style.display = 'none';
    avatarFlagGrid.parentNode.insertBefore(avatarNoMatch, avatarFlagGrid.nextSibling);
  }

  // Fetches the flags currently scrolled into view, one screen ahead in each
  // direction so scrolling never outruns the loading. Fetching all 270 up
  // front would be 2.3 MB the moment somebody opens the panel, most of it
  // for countries they will never scroll past.
  function revealVisibleFlags() {
    if (!avatarFlagGrid) return;
    // The `|| 168` matters: on the very first call the grid has just been
    // un-hidden and can still measure 0 tall, and a zero-height window
    // reveals nothing - which is exactly the blank grid this exists to avoid.
    // 168 is the max-height the stylesheet gives it.
    const h = avatarFlagGrid.clientHeight || 168;
    const top = avatarFlagGrid.scrollTop - h;
    const bottom = avatarFlagGrid.scrollTop + h * 2;
    for (const cell of avatarFlagGrid.children) {
      if (cell.style.display === 'none') continue;
      const img = cell.firstChild;
      if (!img || !img.dataset || !img.dataset.src) continue;
      if (cell.offsetTop < top || cell.offsetTop > bottom) continue;
      img.src = img.dataset.src;
      delete img.dataset.src;
    }
  }

  function buildAvatarPicker() {
    if (!avatarFlagGrid || !avatarEmojiGrid) return;
    ensureAvatarNoMatch();

    // Auto sits first and inside the grid rather than off to the side,
    // because going back to it is a choice like any other and should be in
    // the same place as the choices that replaced it.
    avatarFlagGrid.appendChild(avatarCell('auto', 'Automatic', (b) => { b.textContent = '✨'; }));
    for (const code of allFlagCodes()) {
      avatarFlagGrid.appendChild(avatarCell(`flag:${code}`, `${flagName(code)} (${code})`, (b) => {
        const img = document.createElement('img');
        // The src is parked in data-src and moved over by revealVisibleFlags().
        // loading="lazy" was tried first and left the grid blank: it is
        // driven by the rendering lifecycle, which a scrollable box the
        // browser has decided not to paint does not run. Reading offsetTop
        // instead depends only on layout, which always happens - so the
        // pictures are there whether or not the browser felt like
        // compositing that frame.
        img.dataset.src = flagUrl(code);
        img.alt = flagName(code);
        b.appendChild(img);
      }));
    }
    for (const value of AVATAR_EMOJI) {
      avatarEmojiGrid.appendChild(avatarCell(`emoji:${value}`, 'Character', (b) => { b.textContent = value; }));
    }

    avatarFlagGrid.addEventListener('scroll', revealVisibleFlags);
    revealVisibleFlags();

    for (const grid of [avatarFlagGrid, avatarEmojiGrid]) {
      grid.addEventListener('click', (e) => {
        const cell = e.target.closest ? e.target.closest('.avatar-cell') : null;
        if (!cell) return;
        const key = cell.dataset.key;
        if (key === 'auto') return setMyAvatar(null);
        const [kind, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
        setMyAvatar(kind === 'flag' ? { kind: 'flag', code: rest } : { kind: 'emoji', value: rest });
      });
    }

    if (avatarSearch) {
      avatarSearch.addEventListener('input', () => {
        const q = avatarSearch.value.trim().toLowerCase();
        let shown = 0;
        for (const cell of avatarFlagGrid.children) {
          // Auto always stays reachable: filtering the way back out of a
          // search is how someone ends up stuck with a flag they picked by
          // accident.
          const hit = cell.dataset.key === 'auto' || !q || cell.title.toLowerCase().includes(q);
          cell.style.display = hit ? '' : 'none';
          if (hit && cell.dataset.key !== 'auto') shown++;
        }
        if (avatarNoMatch) avatarNoMatch.style.display = (q && shown === 0) ? '' : 'none';
        // Filtering moves everything up: what was three screens down is now
        // the first row, and it has no picture yet.
        revealVisibleFlags();
      });
    }

    markAvatarSelection();
  }

  if (avatarToggleBtn && avatarPickerPanel) {
    avatarToggleBtn.addEventListener('click', () => {
      const open = avatarPickerPanel.style.display === 'none';
      avatarPickerPanel.style.display = open ? '' : 'none';
      avatarToggleBtn.setAttribute('aria-expanded', String(open));
      avatarToggleBtn.textContent = open ? 'Done' : 'Change';
      // Built on first open, not at load: 270 <button><img> is real work,
      // and most sessions never open this panel at all.
      if (open && !avatarFlagGrid.children.length) buildAvatarPicker();
    });
  }
  renderAvatarPreview();

  return {
    peerAvatars, avatarFor, paintAvatar, flagImage, flagReady,
    setMyAvatar, myEffectiveAvatar, announceAvatar, renderAvatarPreview,
  };
}
