// OnZVoIP local prototype client.
// Owns: (1) a draggable canvas dot standing in for "my own position" (what the
// OpenPlanet plugin will eventually report), (2) rendering of other players'
// positions received over Livekit's data channel, and (3) the actual
// proximity-audio math: distance -> gain, applied locally per remote track.
// See ../../context.txt "ARCHITECTURE AUDIO" for why this lives client-side.

import {
  distance, gainForDistance, gainForDistanceRealistic, panForDirection,
  lowpassForDistance, LOWPASS_NEAR_HZ, toCarFrame,
  dopplerDelayFor, DOPPLER_BASE_SEC, DOPPLER_MAX_DELAY_SEC,
  velocityFrom, extrapolatedPosition,
} from './audio-math.js';
import { validateAvatar, emojiForPseudo } from './avatar.js';
import { setupToast, showToast } from './toast.js';
import { createMicMeter } from './mic-meter.js';
import { createAvatarPicker, AVATAR_TOPIC } from './avatar-picker.js';
import { createRadar } from './radar.js';
import { createReporter } from './report.js';

// Live-tunable from the calibration sliders (see index.html #calib) because
// these are in *game* units now that real positions come from the OpenPlanet
// plugin, and the right values can only be found by ear while driving.
// Defaults below are the old canvas-test values, i.e. NOT yet calibrated -
// once good values are found in game they should be pasted back here.
let MIN_DIST = 1;    // full volume within this radius
let MAX_DIST = 150;  // silence beyond this radius
// How wide the stereo image is, 0 (mono) to 1 (a voice abeam sits entirely in
// one ear). Not a distance: the pan follows the direction a voice comes from,
// so there is no number of metres to agree on - see panForDirection().
let PAN_STRENGTH = 0.9;

const SEND_INTERVAL_MS = 200;
const LERP_FACTOR = 0.15; // per animation-frame smoothing towards target gain (canvas/debug table)
const AUDIO_SMOOTHING_SEC = 0.05; // WebAudio setTargetAtTime time constant for gain/pan

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const identityInput = document.getElementById('identity');
const followGameCheckbox = document.getElementById('followGame');
const relativeModeCheckbox = document.getElementById('relativeMode');
const relativeTargetInput = document.getElementById('relativeTarget');
const relativeTargetChipsEl = document.getElementById('relativeTargetChips');
const calibMinLabel = document.getElementById('calibMinLabel');
const calibMaxLabel = document.getElementById('calibMaxLabel');
const relativeRangeSlider = document.getElementById('relativeRange');
const relativeRangeVal = document.getElementById('relativeRangeVal');
const relativeOffsetXSlider = document.getElementById('relativeOffsetX');
const relativeOffsetXVal = document.getElementById('relativeOffsetXVal');
const relativeOffsetYSlider = document.getElementById('relativeOffsetY');
const relativeOffsetYVal = document.getElementById('relativeOffsetYVal');
const joinBtn = document.getElementById('joinBtn');
const micBtn = document.getElementById('micBtn');
const leaveBtn = document.getElementById('leaveBtn');
const statusEl = document.getElementById('status');
const expiredMsgEl = document.getElementById('expiredMsg');
const serverNameEl = document.getElementById('serverName');
const peersBody = document.querySelector('#peers tbody');
const meReadoutEl = document.getElementById('meReadout');
const eventLogEl = document.getElementById('eventLog');
const onzRoot = document.getElementById('onzRoot');
const themeToggle = document.getElementById('themeToggle');
const joinSectionEl = document.getElementById('joinSection');
const taglineEl = document.getElementById('tagline');
const roomStatsEl = document.getElementById('roomStats');
const peerCountEl = document.getElementById('peerCount');
const roomTimeEl = document.getElementById('roomTime');
const toastEl = document.getElementById('toast');
const toastTextEl = document.getElementById('toastText');
const micMeterEl = document.getElementById('micMeter');
const reduceMotionToggle = document.getElementById('reduceMotionToggle');
const highContrastToggle = document.getElementById('highContrastToggle');
const showEmojiToggle = document.getElementById('showEmojiToggle');
const realisticAudioToggle = document.getElementById('realisticAudioToggle');
const rotateRadarToggle = document.getElementById('rotateRadarToggle');
const dopplerToggle = document.getElementById('dopplerToggle');
const dopplerLevels = document.getElementById('dopplerLevels');
const dopplerLevelSubtle = document.getElementById('dopplerLevelSubtle');
const dopplerLevelStrong = document.getElementById('dopplerLevelStrong');

// The 9 boolean settings (followGame, relativeMode, themeToggle,
// reduceMotionToggle, highContrastToggle, showEmojiToggle,
// realisticAudioToggle, rotateRadarToggle and dopplerToggle) are
// <button role="switch"> elements,
// not native checkboxes - state lives in aria-checked instead of .checked.
function isSwitchOn(btn) { return btn.getAttribute('aria-checked') === 'true'; }
function setSwitchOn(btn, on) { btn.setAttribute('aria-checked', on ? 'true' : 'false'); }

function updateRelativeRange() {
  const range = Number(relativeRangeSlider.value);
  relativeRangeVal.textContent = range;
  for (const slider of [relativeOffsetXSlider, relativeOffsetYSlider]) {
    slider.min = -range;
    slider.max = range;
    if (Number(slider.value) > range) slider.value = range;
    if (Number(slider.value) < -range) slider.value = -range;
  }
  relativeOffsetXVal.textContent = relativeOffsetXSlider.value;
  relativeOffsetYVal.textContent = relativeOffsetYSlider.value;
}
relativeRangeSlider.addEventListener('input', updateRelativeRange);
relativeOffsetXSlider.addEventListener('input', () => { relativeOffsetXVal.textContent = relativeOffsetXSlider.value; });
relativeOffsetYSlider.addEventListener('input', () => { relativeOffsetYVal.textContent = relativeOffsetYSlider.value; });
updateRelativeRange();

// Applied once per frame from tickGains(), before distance/gain are computed
// against "me" - so it must run first. X/Z map directly onto the fields the
// canvas plots (worldToScreen uses pos.x/pos.z - ManiaPlanet's horizontal
// plane, Y being altitude, audit #4) and the ones distance()/panning use, so
// dragging these sliders moves the dot exactly where you'd expect on screen -
// lets a second tab shadow another tracked player at a known offset instead
// of a mouse-dragged position in an unrelated coordinate space, so testing
// with 2 tabs doesn't need a 2nd TM account.
function applyRelativeMode() {
  if (!isSwitchOn(relativeModeCheckbox)) return;
  const target = peers.get(relativeTargetInput.value.trim());
  if (!target) return; // no position received yet for that login
  me.x = target.x + Number(relativeOffsetXSlider.value);
  me.z = target.z + Number(relativeOffsetYSlider.value); // "front/back" is depth (Z), not altitude
  me.y = target.y;
}

// "Follow another player" target picker: chips instead of a free-text field,
// populated from whoever currently has a known position - clicking one just
// writes into the same #relativeTarget value applyRelativeMode() already reads.
// Rebuilding the chips throws away the actual <button> the mouse is over, so
// doing it on every render tick (10Hz) made them flicker and swallowed clicks:
// mousedown landed on a button that was gone before mouseup, and no mouseup on
// the same element means no click event at all. So redraw only when the list
// or the selection really changed.
let lastChipsKey = null;

function renderFollowChips() {
  if (!relativeTargetChipsEl) return;
  const identities = [...peers.keys()].filter((p) => p !== myIdentity).sort();
  const selected = relativeTargetInput.value.trim();
  // The avatar belongs in the key too: it arrives in a data message some time
  // after the player does, so keying on the names alone froze every chip on the
  // hashed fallback emoji and never repainted it as the real flag.
  const avatars = identities.map((p) => {
    const av = avatarFor(p);
    return `${av.kind}:${av.kind === 'flag' ? av.code : av.value}`;
  });
  const key = JSON.stringify([identities, avatars, selected]);
  if (key === lastChipsKey) return;
  lastChipsKey = key;

  if (identities.length === 0) {
    relativeTargetChipsEl.innerHTML = '<span class="chip-empty">No other players with a known position yet</span>';
    return;
  }
  relativeTargetChipsEl.innerHTML = '';
  for (const pseudo of identities) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (pseudo === selected ? ' selected' : '');
    // Same picture as the list row and the radar blip, via the same painter -
    // a chip showing a different face than the blip is worse than no face.
    const face = document.createElement('span');
    face.className = 'chip-avatar';
    paintAvatar(face, avatarFor(pseudo), pseudo);
    chip.appendChild(face);
    chip.appendChild(document.createTextNode(` ${pseudo}`));
    chip.addEventListener('click', () => {
      relativeTargetInput.value = relativeTargetInput.value.trim() === pseudo ? '' : pseudo;
      renderFollowChips();
    });
    relativeTargetChipsEl.appendChild(chip);
  }
}

function logEvent(msg) {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  eventLogEl.prepend(line);
  while (eventLogEl.childElementCount > 20) eventLogEl.lastChild.remove();
}

// Appearance settings (theme / reduce motion / high contrast / emoji avatars)
// live on #onzRoot as data attributes so CSS alone can react to them - this
// mirrors setupCalibration()'s "read localStorage, wire a listener, persist
// on change" shape below.
let reduceMotion = false;
let showEmoji = true;

function applyTheme(theme) {
  document.documentElement.setAttribute('data-onz-theme', theme);
  setSwitchOn(themeToggle, theme === 'dark');
  localStorage.setItem('onzvoip.v2.theme', theme);
}

function setupAppearance() {
  applyTheme(localStorage.getItem('onzvoip.v2.theme') === 'light' ? 'light' : 'dark');
  themeToggle.addEventListener('click', () => {
    applyTheme(document.documentElement.getAttribute('data-onz-theme') === 'dark' ? 'light' : 'dark');
  });

  reduceMotion = localStorage.getItem('onzvoip.v2.reduceMotion') === '1';
  setSwitchOn(reduceMotionToggle, reduceMotion);
  document.documentElement.setAttribute('data-onz-motion', reduceMotion ? 'reduced' : 'normal');
  reduceMotionToggle.addEventListener('click', () => {
    reduceMotion = !isSwitchOn(reduceMotionToggle);
    setSwitchOn(reduceMotionToggle, reduceMotion);
    document.documentElement.setAttribute('data-onz-motion', reduceMotion ? 'reduced' : 'normal');
    localStorage.setItem('onzvoip.v2.reduceMotion', reduceMotion ? '1' : '0');
  });

  const highContrast = localStorage.getItem('onzvoip.v2.highContrast') === '1';
  setSwitchOn(highContrastToggle, highContrast);
  document.documentElement.setAttribute('data-onz-contrast', highContrast ? 'high' : 'normal');
  highContrastToggle.addEventListener('click', () => {
    const on = !isSwitchOn(highContrastToggle);
    setSwitchOn(highContrastToggle, on);
    document.documentElement.setAttribute('data-onz-contrast', on ? 'high' : 'normal');
    localStorage.setItem('onzvoip.v2.highContrast', on ? '1' : '0');
  });

  // Default on: emoji avatars are the more legible look for most players;
  // stored value only overrides once someone has actually flipped it.
  const savedShowEmoji = localStorage.getItem('onzvoip.v2.showEmoji');
  showEmoji = savedShowEmoji === null ? true : savedShowEmoji === '1';
  setSwitchOn(showEmojiToggle, showEmoji);
  showEmojiToggle.addEventListener('click', () => {
    showEmoji = !isSwitchOn(showEmojiToggle);
    setSwitchOn(showEmojiToggle, showEmoji);
    localStorage.setItem('onzvoip.v2.showEmoji', showEmoji ? '1' : '0');
  });
}
setupAppearance();

setupToast(toastEl, toastTextEl);

let room = null;
let roomConnectedAt = null;
let ingestWs = null;
let myIdentity = null;
let dragging = false;
let audioCtx = null;
let micEnabled = false;
let wsPositionInterval = null;
// Audit #6: in follow-game mode, "me" starts at the canvas-centre default
// (below) interpreted as real game coordinates until the first DataReceived
// for our own identity lands - without this flag that window would compute
// fantasy distances to real peers and could make someone briefly audible who
// shouldn't be.
let meKnown = false;
// Which way our car points, as { fx, fz } — the horizontal part of the game's
// own direction vector, never an angle we reconstructed. null means "we have no
// idea", which is the honest state for a browser with no plugin, for a car that
// has not spawned, and for the moment right after the switch flips.
let myHeading = null;
// A <button role="switch"> does not toggle itself the way a checkbox did: the
// migration away from native checkboxes has to hand every switch its own
// listener, and this one was left without. Nothing read the switch as broken -
// isSwitchOn() simply kept answering false forever.
// Free-position mode broadcasts whatever "me" happens to hold. Right after
// leaving follow-a-player mode that is the followed player's last position -
// a coordinate we never chose, which other players would keep seeing as ours.
// So turning the switch off drops us back to "no position yet" for everyone
// until we actually drag our own dot (see the canvas mousemove handler).
let freePosChosen = true;

// The two position sources are mutually exclusive: you cannot be driving and
// shadowing someone else at the same time. The code already knew it - every
// reader below puts follow-game first and only then looks at follow-a-player -
// but the switches let both sit on, and then the panel claimed something the
// ear was not doing. Whichever one was just turned on wins; the other goes
// down through its own path, so its side effects (a stale heading, a position
// we never chose) are dropped exactly as they are when it is clicked off.
function setFollowGame(on) {
  setSwitchOn(followGameCheckbox, on);
  if (on) meKnown = false;
  // Dropped in both directions. Turning the switch on, we have not received a
  // heading yet; turning it off, we are back to a dot dragged with the mouse,
  // which does not point anywhere. Keeping the last one would silently rotate
  // everything around a direction the player is no longer facing.
  myHeading = null;
  if (on && isSwitchOn(relativeModeCheckbox)) setRelativeMode(false);
}

function setRelativeMode(on) {
  setSwitchOn(relativeModeCheckbox, on);
  if (!on) freePosChosen = false;
  if (on && isSwitchOn(followGameCheckbox)) setFollowGame(false);
}

// Each turns the other off, never back on, so the pair settles in one hop.
followGameCheckbox.addEventListener('click', () => setFollowGame(!isSwitchOn(followGameCheckbox)));
relativeModeCheckbox.addEventListener('click', () => setRelativeMode(!isSwitchOn(relativeModeCheckbox)));

// Whether our own position is worth putting on the wire. In follow-game mode
// the OpenPlanet plugin already publishes this identity's position - sending
// ours too would fight with it.
function shouldSendOwnPosition() {
  if (isSwitchOn(followGameCheckbox)) return false;
  if (isSwitchOn(relativeModeCheckbox)) return true;
  return freePosChosen;
}

const me = { x: canvas.width / 2, y: 0, z: canvas.height / 2 };
// pseudo -> { x, y, lastSeen }
const peers = new Map();
// pseudo -> { current, target } (gain, mirrored into the debug table)
const gains = new Map();
// pseudo -> { source, panner, gainNode, el } - the actual WebAudio graph per remote player
const audioNodes = new Map();
// Audit #31: with autoSubscribe:false, LiveKit no longer subscribes us to every
// participant's mic automatically - we do it ourselves based on distance, so a
// room with many far-away players doesn't cost bandwidth/CPU for audio nobody
// will hear. pseudo -> RemoteTrackPublication (audio only).
const audioPublications = new Map();
// pseudos we're currently subscribed to, so tickGains only calls
// setSubscribed() on an actual state change instead of every frame.
const subscribedPeers = new Set();
// pseudo -> Date.now() of the last time LiveKit reported them as an active
// speaker, fed by RoomEvent.ActiveSpeakersChanged (see attachRoomEvents()) -
// purely a "how long since they last talked" readout, independent of the
// gain-based distance tiers above. currentSpeakers mirrors the event's most
// recent snapshot so renderPlayerList() can show "speaking" instead.
const lastSpokenAt = new Map();
let currentSpeakers = new Set();
// Unsubscribe only once meaningfully past MAX_DIST (20% margin) so a player
// hovering right at the edge doesn't cause rapid subscribe/unsubscribe
// thrashing (each toggle re-negotiates the WebRTC track).
const UNSUBSCRIBE_MARGIN = 1.2;
// Safety net: a peer whose position hasn't been re-broadcast in this
// long is treated as gone for good (server crash, alt-tab, network cut) -
// past the ordinary 3s "stale" mute, its entry is dropped from peers/gains
// instead of sitting in the Map for the rest of the session.
const PEER_GC_MS = 60_000;

// Calibration sliders: each one writes its live value straight into the
// matching constant above, and remembers it in localStorage so a page reload
// mid-calibration doesn't lose the setting you were converging on.
// Audit #38: minDist and maxDist are independent sliders with overlapping
// ranges — without a floor between them, dragging
// minDist past maxDist doesn't error, it just makes gainForDistance() treat
// maxDist as unreachable and hard-cut at minDist instead of fading. MIN_GAP
// keeps a slice of falloff always audible between the two.
const MIN_DIST_MAX_DIST_GAP = 1;

// min/max are absent under the test stub, where the sliders are bare elements;
// an absent bound means "no bound" rather than NaN swallowing the value.
function clampToSlider(slider, v) {
  const lo = Number(slider.min), hi = Number(slider.max);
  let out = v;
  if (isFinite(lo)) out = Math.max(lo, out);
  if (isFinite(hi)) out = Math.min(hi, out);
  return out;
}

// v2: bumped from the unversioned `onzvoip.${id}` key so a browser that
// calibrated against old defaults doesn't silently keep overriding new ones
// after a code change (audit #5) - old keys are simply orphaned.
//
// Returns null for "nothing stored", which is NOT the same as a stored 0. Zero
// is a legitimate setting on two of the three sliders - no full-volume bubble,
// no stereo at all - and treating it as absent used to hand the default back on
// the next reload, silently undoing a choice the player had made.
function storedCalibration(id) {
  const raw = localStorage.getItem(`onzvoip.v2.${id}`);
  if (raw === null || raw === '') return null;
  const v = Number(raw);
  return isFinite(v) ? v : null;
}

function setupCalibration() {
  const controls = [
    // maxDist first: on load, saved values are applied in this order, and
    // minDist's clamp below reads the (by-then-current) MAX_DIST.
    { id: 'maxDist', get: () => MAX_DIST, set: (v) => { MAX_DIST = Math.max(v, MIN_DIST + MIN_DIST_MAX_DIST_GAP); } },
    { id: 'minDist', get: () => MIN_DIST, set: (v) => { MIN_DIST = Math.min(v, MAX_DIST - MIN_DIST_MAX_DIST_GAP); } },
    // Stored and shown as a percentage, kept as a 0-1 factor: the slider says
    // "how much left/right", which is a taste, not "how many metres", which was
    // a question with no honest answer.
    { id: 'panStrength', get: () => Math.round(PAN_STRENGTH * 100), set: (v) => { PAN_STRENGTH = Math.min(100, Math.max(0, v)) / 100; } },
  ];

  // Captured before any stored value is applied, so "back to default" means the
  // values this build ships with rather than whatever the browser remembers.
  const defaults = Object.fromEntries(controls.map(({ id, get }) => [id, get()]));
  const syncs = [];

  const resetBtn = document.getElementById('calibReset');
  // The button is the only remaining way back: the sliders that produced a
  // custom range are behind ?debug=1, so a player who inherits one from an old
  // session cannot undo it. Showing the button only when it applies keeps the
  // screen identical to the approved render for everyone else, and makes its
  // appearance the signal that the sound range is not the stock one.
  const refreshResetBtn = () => {
    if (!resetBtn) return;
    const custom = controls.some(({ id }) => storedCalibration(id) !== null);
    resetBtn.style.display = custom ? '' : 'none';
  };

  for (const { id, get, set } of controls) {
    const slider = document.getElementById(id);
    const label = document.getElementById(`${id}Val`);
    const saved = storedCalibration(id);
    // Clamped to the slider's own bounds, because a stored value can predate a
    // change to them. Applied as it stands, a leftover 500 would drive the audio
    // while the slider - which the browser clamps to its own max on its own -
    // showed 200: the number on screen would stop describing what you hear.
    if (saved !== null) set(clampToSlider(slider, saved));

    const sync = () => {
      label.textContent = get();
      if (id === 'minDist' && calibMinLabel) calibMinLabel.textContent = get();
      if (id === 'maxDist' && calibMaxLabel) calibMaxLabel.textContent = get();
    };
    syncs.push(() => { slider.value = get(); sync(); });
    slider.value = get();
    sync();

    slider.addEventListener('input', () => {
      set(Number(slider.value));
      slider.value = get(); // reflects clamping (e.g. minDist stopped short of maxDist)
      localStorage.setItem(`onzvoip.v2.${id}`, slider.value);
      sync();
      refreshResetBtn();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      // Applied twice, and that is not redundant. Each setter clamps against
      // the OTHER value's current state, so one pass starting from a stale
      // MIN_DIST of 200 leaves MAX_DIST stuck at 201 instead of 150. The second
      // pass runs once both sides hold their defaults, where no clamp bites.
      for (let pass = 0; pass < 2; pass++) {
        for (const { id, set } of controls) set(defaults[id]);
      }
      for (const { id } of controls) localStorage.removeItem(`onzvoip.v2.${id}`);
      for (const s of syncs) s();
      refreshResetBtn();
      logEvent('calibration reset to defaults');
    });
  }
  refreshResetBtn();
}
setupCalibration();

// A/B switch between the original linear falloff and the perceptual one plus
// air absorption. Which of the two actually sounds right is settled by ear on
// a server with someone else driving - not by a test and not by reading the
// curve. So both stay in the build and this flips between them live, without a
// reload, mid-conversation.
let realisticAudio = true;
function setupRealisticAudio() {
  if (!realisticAudioToggle) return;
  const saved = localStorage.getItem('onzvoip.v2.realisticAudio');
  realisticAudio = saved === null ? true : saved === '1';
  setSwitchOn(realisticAudioToggle, realisticAudio);
  realisticAudioToggle.addEventListener('click', () => {
    realisticAudio = !isSwitchOn(realisticAudioToggle);
    setSwitchOn(realisticAudioToggle, realisticAudio);
    localStorage.setItem('onzvoip.v2.realisticAudio', realisticAudio ? '1' : '0');
    logEvent(`realistic audio ${realisticAudio ? 'on' : 'off'}`);
  });
}
setupRealisticAudio();

// Whether the radar turns with the car (top of the radar = the bonnet) or stays
// pinned to the map. The *sound* always turns - that is the whole point of
// having a heading - so this only decides whether the picture agrees with the
// ears or whether the player would rather read a stable map and reconstruct it
// themselves. Sitting in Accessibility rather than next to the radar is
// deliberate: a decor that swings every time you steer is a motion-sickness
// question before it is a display preference. Not wired to "Reduce motion"
// automatically, though - somebody who dislikes an animated sweep does not
// necessarily want a north-up radar, and guessing that for them would take away
// the choice this switch exists to give.
let rotateRadar = true;
function setupRotateRadar() {
  if (!rotateRadarToggle) return;
  const saved = localStorage.getItem('onzvoip.v2.rotateRadar');
  rotateRadar = saved === null ? true : saved === '1';
  setSwitchOn(rotateRadarToggle, rotateRadar);
  rotateRadarToggle.addEventListener('click', () => {
    rotateRadar = !isSwitchOn(rotateRadarToggle);
    setSwitchOn(rotateRadarToggle, rotateRadar);
    localStorage.setItem('onzvoip.v2.rotateRadar', rotateRadar ? '1' : '0');
    logEvent(`radar rotation ${rotateRadar ? 'on' : 'off'}`);
  });
}
setupRotateRadar();

// Doppler strength, or null when the effect is off. Two settings, not one: the
// switch says whether you want the effect at all, and the strength is a
// preference you keep even while it is off - so turning it back on restores the
// dosage you had chosen instead of resetting you to the gentle one. The gentle
// one is on by default: it was compared against silence and won, so it is what
// the room should sound like without anyone having to go and find a switch.
const DOPPLER_LEVELS = ['subtle', 'strong'];
let dopplerPreset = null;
let dopplerLevel = 'subtle';
let dopplerWired = false;
function paintDoppler() {
  if (dopplerToggle) setSwitchOn(dopplerToggle, dopplerPreset !== null);
  // The strength row is hidden while the effect is off: a player who only wants
  // "on" should not have to form an opinion about what "subtle" means.
  if (dopplerLevels) dopplerLevels.style.display = dopplerPreset ? '' : 'none';
  if (dopplerLevelSubtle) dopplerLevelSubtle.className = 'chip' + (dopplerLevel === 'subtle' ? ' selected' : '');
  if (dopplerLevelStrong) dopplerLevelStrong.className = 'chip' + (dopplerLevel === 'strong' ? ' selected' : '');
}
function setupDoppler() {
  // 'exact' was a third strength, kept only for the comparison that chose
  // between them. A browser still holding it lands on the strongest one that
  // survives, rather than having the effect silently switched off.
  const saved = localStorage.getItem('onzvoip.v2.doppler');
  const savedLevel = localStorage.getItem('onzvoip.v2.dopplerLevel') ?? saved;
  const asLevel = (v) => (v === 'exact' ? 'strong' : (DOPPLER_LEVELS.includes(v) ? v : null));
  dopplerLevel = asLevel(savedLevel) ?? 'subtle';
  // A missing key and an empty one are NOT the same thing: nothing stored means
  // nobody has had an opinion yet, and gets the effect on; an empty string is
  // someone who switched it off on purpose, and that has to survive a reload.
  dopplerPreset = saved === null ? dopplerLevel : (asLevel(saved) ? dopplerLevel : null);
  paintDoppler();

  // Wired once. Everything above re-reads what is stored, which is what a reload
  // does and what the tests replay; a second copy of the listener below would
  // flip the effect twice per click, which is to say never.
  if (dopplerWired) return;
  dopplerWired = true;

  const store = () => {
    localStorage.setItem('onzvoip.v2.doppler', dopplerPreset ?? '');
    localStorage.setItem('onzvoip.v2.dopplerLevel', dopplerLevel);
  };
  if (dopplerToggle) {
    dopplerToggle.addEventListener('click', () => {
      dopplerPreset = isSwitchOn(dopplerToggle) ? null : dopplerLevel;
      paintDoppler();
      store();
      logEvent(`doppler ${dopplerPreset ?? 'off'}`);
    });
  }
  for (const [level, el] of [['subtle', dopplerLevelSubtle], ['strong', dopplerLevelStrong]]) {
    if (!el) continue;
    el.addEventListener('click', () => {
      dopplerLevel = level;
      // The row is only reachable while the effect is on, so picking a strength
      // is a change of dosage and never a way of turning it on.
      if (dopplerPreset) dopplerPreset = level;
      paintDoppler();
      store();
      logEvent(`doppler ${dopplerPreset ?? 'off'}`);
    });
  }
}
setupDoppler();

// The heading to look at the world through, or null to stay in world space.
//
// Follow-a-player mode is the one case where we have a heading and must not use
// it: "me" is then parked on somebody else's coordinates, so our own car points
// somewhere unrelated to the vantage point being rendered. Rotating by it would
// spin the radar around a car that is not where the view is.
function headingForView() {
  if (isSwitchOn(relativeModeCheckbox)) return null;
  return myHeading;
}

// Where a peer sits as the ear hears it: how far to our right, how far ahead.
// Falls back to raw world offsets with no heading, which is exactly what
// shipped before - so a player without the plugin loses nothing.
function offsetInEarFrame(pos) {
  const dx = pos.x - me.x, dz = pos.z - me.z;
  const h = headingForView();
  if (!h) return { right: dx, front: dz };
  return toCarFrame(dx, dz, h.fx, h.fz);
}

// The two knobs the switch above actually moves, kept together so they can
// never drift apart: gain law and low-pass cutoff always come from the same
// mode. LOWPASS_NEAR_HZ sits above hearing, so "off" is a genuinely
// transparent filter rather than a bypass the graph would have to rewire.
function gainForCurrentMode(dist) {
  return realisticAudio
    ? gainForDistanceRealistic(dist, MIN_DIST, MAX_DIST)
    : gainForDistance(dist, MIN_DIST, MAX_DIST);
}
function cutoffForCurrentMode(dist) {
  return realisticAudio ? lowpassForDistance(dist, MIN_DIST, MAX_DIST) : LOWPASS_NEAR_HZ;
}

// distance / clamp / gainForDistance / panForOffset used to be inlined here;
// they now live in ./audio-math.js (imported at the top) so the tests in
// server/test/audio-math.test.js actually protect the code the browser runs.

// The view is always centred on "me" and scaled so the MAX_DIST ring just
// fits, so it stays readable whether positions are canvas-sized (drag mode)
// or real game coordinates in the hundreds (follow mode).
// Audit #4: this is a top-down radar, so screen-Y must come from game-Z
// (ManiaPlanet's horizontal plane is X/Z; Y is altitude) — plotting pos.y
// here made the dot drift with elevation instead of staying put on flat turns.
function worldToScreen(pos, scale) {
  return {
    x: canvas.width / 2 + (pos.x - me.x) * scale,
    y: canvas.height / 2 + (pos.z - me.z) * scale,
  };
}

// Asymptotic radar projection: real distance never actually reaches the edge
// of the canvas, it just compresses harder the farther out a peer is, so
// someone 10x MAX_DIST away is still visible near the rim instead of clipped
// off-screen or overlapping someone at 2x MAX_DIST. scale shrinks the glyph
// as it approaches the rim so far-away peers read as visually smaller too.
function projectToRadar(x, y, R, k) {
  const d = Math.hypot(x, y);
  const theta = Math.atan2(y, x);
  const dRadar = R * (2 / Math.PI) * Math.atan(d * k);
  const scale = Math.max(0.2, 2 * (1 - dRadar / R));
  return { x_display: Math.cos(theta) * dRadar, y_display: Math.sin(theta) * dRadar, scale };
}

// The palette, the country guess and the validation of a chosen avatar live in
// ./avatar.js, DOM-free so the tests can hit it directly. Everything that
// needs the page - what this player picked, what others announced, the
// picker UI - lives in ./avatar-picker.js instead.
const avatarPicker = createAvatarPicker({
  getRoom: () => room,
  getMyIdentity: () => myIdentity,
});
const {
  peerAvatars, avatarFor, paintAvatar, flagImage, flagReady,
  setMyAvatar, myEffectiveAvatar, announceAvatar, renderAvatarPreview,
} = avatarPicker;

// Audit #21: redrawing the radar/tables at the 60Hz of requestAnimationFrame
// burned CPU on DOM work nobody could see. draw()/renderPlayerList() run from
// the throttled RENDER_INTERVAL_MS timer below instead; the debug peer table
// and follow-chips are additionally skipped outright while the
// collapsed-by-default Advanced panel (#optBody) is closed, since nothing
// there is visible either way.
const RENDER_INTERVAL_MS = 100; // ~10Hz, plenty for a status readout
const optBody = document.getElementById('optBody');

// --- Equipes ---------------------------------------------------------------
// Pushed by the relay over the ingest WebSocket every time the organiser
// changes something in /admin, and once on connect. Inert until a team exists:
// an empty roster leaves every dot its usual colour and every voice on plain
// distance, so nothing here changes an evening nobody organised.
let teamList = [];    // [{ id, name, color, voice }]
let teamMembers = {}; // login -> team id

function teamOf(pseudo) {
  const id = teamMembers[pseudo];
  if (id == null) return null;
  return teamList.find((t) => t.id === id) ?? null;
}

function teamColorFor(pseudo) {
  const team = teamOf(pseudo);
  return team ? team.color : null;
}

// A teammate stays audible across the whole map, as long as the organiser left
// voice on for that team. Same room, same published track - only the distance
// rules are skipped. That is why this needs no second LiveKit room: a browser
// can only be in one at a time, and leaving the map room to talk to your team
// would take you out of everyone else's earshot.
function sameVoiceTeam(pseudo) {
  const mine = teamOf(myIdentity);
  return !!mine && mine.voice === true && teamMembers[pseudo] === mine.id;
}

// Same extrapolation the audio uses, for everything that *draws* a peer: a dot
// that steps once per packet while the voice slides would look broken next to
// it. Rebuilt per call rather than cached - it depends on the current time, and
// the map is a handful of entries.
function peersSnapshot(nowMs = Date.now()) {
  const out = new Map();
  for (const [pseudo, raw] of peers) {
    out.set(pseudo, { ...raw, ...extrapolatedPosition(raw, nowMs) });
  }
  return out;
}

const radar = createRadar({
  canvas, ctx, onzRoot,
  getTeamColor: teamColorFor,
  getPeers: () => peersSnapshot(),
  getGains: () => gains,
  getMe: () => me,
  getMaxDist: () => MAX_DIST,
  getRotateRadar: () => rotateRadar,
  getShowEmoji: () => showEmoji,
  getReduceMotion: () => reduceMotion,
  offsetInEarFrame, headingForView, projectToRadar,
  avatarFor, flagImage, flagReady, emojiForPseudo,
});
const draw = radar.draw;
const resizeCanvas = radar.resizeCanvas;
const hitTestPeer = radar.hitTestPeer;

// Doppler, driven one peer at a time. No pitch ratio is ever computed here:
// the delay line holds the sound's travel time, and moving that time is what
// bends the pitch - shorter delay means the sound arrives sooner, which is a
// higher note, in the right direction, for both cars moving at once, for free.
//
// The ramp has to be linear: a linear slide of the delay is a constant playback
// rate, so a constant interval. setTargetAtTime would curve the pitch instead.
// Feature-detected, because the test double for AudioContext has no delay node.
//
// The queue is built AHEAD of the audio clock in fixed segments and nothing
// already queued is ever rewritten. Re-issuing the ramp every animation frame
// looks equivalent and is not: frames land early (rAF jitters, and currentTime
// only moves a render quantum at a time), so cancelling would drop a ramp
// mid-flight and the following setValueAtTime would jerk the parameter to an
// end value it had not reached yet. A jump in a delay line is a click, and
// sixty of those a second is a crackle over every voice.
const DOPPLER_SEGMENT_SEC = 0.05; // length of one queued ramp
const DOPPLER_HORIZON_SEC = 0.1;  // how far ahead of the clock the queue may run
function driveDoppler(nodes, dist, now) {
  const p = nodes.delay?.delayTime;
  if (!p || !p.linearRampToValueAtTime) return;
  const preset = dopplerPreset ?? 'subtle';
  // With the effect off we aim at distance zero, i.e. back to base - but still
  // through the glide, because dropping the delay in one step is a click too.
  const wanted = dopplerPreset ? dist : 0;

  // Re-anchor only when the clock has caught up with everything we queued: the
  // very first frame, or a tab returning from the background. By definition the
  // last ramp has finished by then, so the parameter is already sitting on
  // dopplerSec and writing it again moves nothing.
  if (!(nodes.dopplerUntil > now)) {
    if (nodes.dopplerSec === undefined) nodes.dopplerSec = dopplerDelayFor(wanted, NaN, 0, preset);
    p.cancelScheduledValues(now);
    p.setValueAtTime(nodes.dopplerSec, now);
    nodes.dopplerUntil = now;
  }
  if (nodes.dopplerUntil - now >= DOPPLER_HORIZON_SEC) return;

  const next = dopplerDelayFor(wanted, nodes.dopplerSec, DOPPLER_SEGMENT_SEC, preset);
  nodes.dopplerUntil += DOPPLER_SEGMENT_SEC;
  p.linearRampToValueAtTime(next, nodes.dopplerUntil);
  nodes.dopplerSec = next;
}

function tickGains() {
  applyRelativeMode();
  // Audit #6: while waiting for our first real in-game position, force
  // silence instead of computing distance from the placeholder "me".
  const meReady = !isSwitchOn(followGameCheckbox) || meKnown;
  for (const [pseudo, raw] of peers) {
    const nowMs = Date.now();
    const stale = nowMs - raw.lastSeen > 3000;
    // Between two packets, carry the peer forward at the speed they were last
    // seen moving: the gain/pan/filter then slide the way the car does instead
    // of stepping once per packet. Beyond EXTRAPOLATION_MAX_MS this is a no-op,
    // so a peer who stopped sending still freezes and then goes stale exactly
    // as before.
    const pos = extrapolatedPosition(raw, nowMs);
    const dist = distance(me, pos);
    // A teammate is heard at full volume wherever they are - including while
    // their positions are stale or before we know our own, since team voice is
    // deliberately not a function of distance.
    const mate = sameVoiceTeam(pseudo);
    const target = mate ? 1 : ((!meReady || stale) ? 0 : gainForCurrentMode(dist));
    const g = gains.get(pseudo) ?? { current: target, target };
    g.target = target;
    g.current += (g.target - g.current) * LERP_FACTOR; // drives the canvas dot opacity / debug table only
    gains.set(pseudo, g);

    const nodes = audioNodes.get(pseudo);
    if (nodes && audioCtx) {
      const now = audioCtx.currentTime;
      nodes.gainNode.gain.setTargetAtTime(target, now, AUDIO_SMOOTHING_SEC);
      // Right of the *car*, not right of the map: turning the wheel moves the
      // voices, which is the difference between a stereo image and a compass.
      // Both components go in, not just the sideways one - which way a voice
      // comes from is an angle, and an angle needs to know what is ahead.
      const ear = offsetInEarFrame(pos);
      nodes.panner.pan.setTargetAtTime(panForDirection(ear.right, ear.front, PAN_STRENGTH), now, AUDIO_SMOOTHING_SEC);
      // Smoothed like the others: a cutoff jumping per frame rings the filter.
      // Teammates keep the direction cue above, but not the distance muffling:
      // a radio voice is not filtered by how far away the other car is.
      nodes.filter.frequency.setTargetAtTime(mate ? 20000 : cutoffForCurrentMode(dist), now, AUDIO_SMOOTHING_SEC);
      driveDoppler(nodes, dist, now);
    }

    // Audit #31: subscribe/unsubscribe from this peer's audio based on distance.
    const pub = audioPublications.get(pseudo);
    if (pub) {
      const inRange = mate || (meReady && !stale && dist <= MAX_DIST);
      const wellOutOfRange = !mate && (stale || !meReady || dist > MAX_DIST * UNSUBSCRIBE_MARGIN);
      if (inRange && !subscribedPeers.has(pseudo)) {
        pub.setSubscribed(true);
        subscribedPeers.add(pseudo);
      } else if (wellOutOfRange && subscribedPeers.has(pseudo)) {
        pub.setSubscribed(false);
        subscribedPeers.delete(pseudo);
      }
    }
  }
  requestAnimationFrame(tickGains);
}
requestAnimationFrame(tickGains);

function updateRoomStats() {
  if (!roomStatsEl || !room || roomConnectedAt === null) return;
  if (peerCountEl) peerCountEl.textContent = String(room.remoteParticipants.size + 1);
  if (roomTimeEl) {
    const elapsedSec = Math.max(0, Math.floor((Date.now() - roomConnectedAt) / 1000));
    const mm = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
    const ss = String(elapsedSec % 60).padStart(2, '0');
    roomTimeEl.textContent = `${mm}:${ss}`;
  }
}

setInterval(() => {
  renderPlayerList();
  updateRoomStats();
  draw();
  if (optBody.style.display !== 'none') {
    renderPeerTable();
    renderFollowChips();
  }

  // Safety net: drop peers that stopped broadcasting a long time ago -
  // tickGains() only mutes/unsubscribes stale peers, it never removes them,
  // so without this the Maps grow for the rest of the session as players
  // come and go on a busy server.
  const now = Date.now();
  for (const [pseudo, pos] of peers) {
    if (now - pos.lastSeen > PEER_GC_MS) {
      peers.delete(pseudo);
      gains.delete(pseudo);
    }
  }
}, RENDER_INTERVAL_MS);

function gainLabel(g) {
  if (g > 0.8) return 'Very close';
  if (g > 0.5) return 'Close';
  if (g > 0.15) return 'Nearby';
  if (g > 0.01) return 'Far away';
  return 'Out of range';
}

// Shared teal/accent/warn/muted tiers used to color the avatar ring, the
// trailing dot, the zone-bar fill and the status text consistently — one
// gain value drives four visual cues instead of each rolling its own bucketing.
function gainTierColorVar(g) {
  if (g > 0.5) return '--onz-teal';
  if (g > 0.15) return '--onz-accent';
  if (g > 0.01) return '--onz-warn';
  return '--onz-muted3';
}

function renderPlayerList() {
  const list = document.getElementById('playerList');
  // Audit #9: union of peers (have a position) and audioNodes (have a
  // subscribed track) — a player who's connected with mic open but still in
  // the menus has audio and no position yet, and must still show up.
  // Plus everyone LiveKit says is in the room, even with neither: the header
  // counts exactly those, so anything narrower here means the page claims
  // "2 in the room" over an empty list. Happens for real in the ~200 ms before
  // a first position arrives, when a plugin drops, and for anyone on the page
  // without the game running.
  const identities = new Set([
    ...peers.keys(),
    ...audioNodes.keys(),
    ...(room ? room.remoteParticipants.keys() : []),
  ]);
  if (identities.size === 0) {
    list.innerHTML = '<li class="pl-empty">No other players in the room yet</li>';
    return;
  }

  // Closest-first: players without a position yet (audio-only) sort after
  // everyone we can actually place, since "distance" is meaningless for them.
  const withPos = [];
  const withoutPos = [];
  for (const pseudo of identities) (peers.has(pseudo) ? withPos : withoutPos).push(pseudo);
  withPos.sort((a, b) => distance(me, peers.get(a)) - distance(me, peers.get(b)));
  const ordered = [...withPos, ...withoutPos];

  const fullPct = Math.min(100, (MIN_DIST / Math.max(MAX_DIST, 1)) * 100);

  list.innerHTML = '';
  ordered.forEach((pseudo, idx) => {
    const hasPosition = peers.has(pseudo);
    const g = hasPosition ? (gains.get(pseudo)?.current ?? 0) : 0;
    const hasAudio = audioNodes.has(pseudo);
    const stale = hasPosition && Date.now() - peers.get(pseudo).lastSeen > 3000;
    // Same emoji the radar draws for this player, so a blip and a row are
    // obviously the same person. It replaced a 🔊/🔉/🔈 volume icon: the ring
    // colour, the trailing dot and the zone bar already say how loud they are,
    // and none of them said *who* they are.
    const av = avatarFor(pseudo);
    const isSpeaking = currentSpeakers.has(pseudo);
    const dist = hasPosition ? distance(me, peers.get(pseudo)) : null;

    const tierVar = hasPosition ? gainTierColorVar(g) : '--onz-muted3';

    const outOfRange = hasPosition && g <= 0.01;

    const li = document.createElement('li');
    li.className = 'pl-row' + (outOfRange ? ' out' : '');

    if (idx === 0 && hasPosition) {
      const badge = document.createElement('div');
      badge.className = 'pl-badge';
      badge.innerHTML = '<svg class="ti"><use href="#ti-focus-2"></use></svg> Closest to you';
      li.appendChild(badge);
    }

    const card = document.createElement('div');
    card.className = 'pl-card';

    const top = document.createElement('div');
    top.className = 'pl-top';
    const avatar = document.createElement('span');
    avatar.className = 'pl-avatar' + (isSpeaking ? ' onzPulse' : '');
    avatar.style.background = `color-mix(in srgb, var(${tierVar}) 25%, transparent)`;
    paintAvatar(avatar, av, pseudo);
    const nameEl = document.createElement('span'); nameEl.className = 'pl-name'; nameEl.textContent = pseudo;
    const dot = document.createElement('span');
    dot.className = 'pl-dot';
    dot.style.background = `var(${tierVar})`;
    top.append(avatar, nameEl, dot);

    const bottom = document.createElement('div');
    bottom.className = 'pl-bottom';
    const labelEl = document.createElement('span');
    labelEl.className = 'pl-label';
    labelEl.textContent = !hasPosition ? 'no position yet' : stale ? 'quiet — no recent update' : (isSpeaking ? 'speaking' : gainLabel(g));
    if (!isSpeaking && lastSpokenAt.has(pseudo)) {
      const minutesAgo = Math.floor((Date.now() - lastSpokenAt.get(pseudo)) / 60000);
      labelEl.textContent += ` · silent ${minutesAgo}m ago`;
    }
    // Distance last, as in the render. The zone bar gives an impression; the
    // number tells you how much closer you have to get to hear someone.
    if (dist !== null) labelEl.textContent += ` · ${Math.round(dist)} m`;
    labelEl.style.color = hasPosition ? `var(${tierVar})` : '';
    const zonebar = document.createElement('div');
    zonebar.className = 'pl-zonebar';
    if (hasPosition) {
      const d = distance(me, peers.get(pseudo));
      const distPct = Math.min(100, (d / Math.max(MAX_DIST, 1)) * 100);
      zonebar.style.background = `linear-gradient(to right, var(--onz-teal) 0%, var(--onz-teal) ${fullPct}%, var(--onz-border) ${fullPct}%, var(--onz-border) 100%)`;
      const marker = document.createElement('div');
      marker.className = 'pl-marker';
      marker.style.left = `${distPct}%`;
      zonebar.appendChild(marker);
    }
    bottom.append(labelEl, zonebar);

    card.append(top, bottom);
    li.appendChild(card);
    list.appendChild(li);
  });
}

function renderPeerTable() {
  const mode = isSwitchOn(followGameCheckbox)
    ? 'from game'
    : isSwitchOn(relativeModeCheckbox)
      ? `relative to "${relativeTargetInput.value.trim()}"`
      : 'mouse';
  meReadoutEl.textContent = `me: x=${me.x.toFixed(0)} y=${me.y.toFixed(0)} z=${me.z.toFixed(0)} (${mode})`;

  peersBody.innerHTML = '';
  for (const [pseudo, pos] of peers) {
    const d = distance(me, pos);
    const g = gains.get(pseudo)?.current ?? 0;
    const ear = offsetInEarFrame(pos);
    const pan = panForDirection(ear.right, ear.front, PAN_STRENGTH);
    const hasAudio = audioNodes.has(pseudo);
    const tr = document.createElement('tr');
    for (const [i, val] of [pseudo, d.toFixed(0), g.toFixed(2), pan.toFixed(2), hasAudio ? 'OK' : 'no track'].entries()) {
      const td = document.createElement('td');
      td.textContent = val;
      if (i === 4) td.style.color = hasAudio ? '#4c8' : '#a44';
      tr.appendChild(td);
    }
    peersBody.appendChild(tr);
  }
}

// "Me" is drawn at the centre of the view, so dragging moves the world under
// it: we accumulate mouse deltas into me, converted back to world units.
// Disabled in follow mode, where the game owns our position.
let lastMouse = null;

canvas.addEventListener('mousedown', (e) => {
  if (isSwitchOn(followGameCheckbox) || isSwitchOn(relativeModeCheckbox)) return;
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (Math.hypot(x - canvas.width / 2, y - canvas.height / 2) < 20) {
    dragging = true;
    lastMouse = { x, y };
  }
});
window.addEventListener('mouseup', () => { dragging = false; lastMouse = null; });
canvas.addEventListener('mousemove', (e) => {
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;

  if (dragging && lastMouse !== null) {
    const scale = (Math.min(canvas.width, canvas.height) / 2 - 20) / Math.max(MAX_DIST, 1);
    me.x += (x - lastMouse.x) / scale;
    me.z += (y - lastMouse.y) / scale; // screen-Y drives depth (Z), matching worldToScreen
    lastMouse = { x, y };
    freePosChosen = true; // this dot is now where we put it, worth broadcasting
  }

  // Independent of dragging: hovering a radar dot reveals its name (see draw()).
  radar.setHovered(hitTestPeer(x, y));
  canvas.style.cursor = radar.getHovered()
    ? 'pointer'
    : (isSwitchOn(followGameCheckbox) || isSwitchOn(relativeModeCheckbox) ? 'default' : 'grab');
});
// Touch devices don't hover: tapping a dot toggles its name label instead.
canvas.addEventListener('click', (e) => {
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const hit = hitTestPeer(x, y);
  radar.setHovered((hit && hit === radar.getHovered()) ? null : hit);
});

function decodePosition(payload) {
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
}

// Update the server name banner above the player list.
function updateServerDisplay(name) {
  if (!serverNameEl) return;
  if (name) {
    serverNameEl.textContent = name;
    serverNameEl.style.display = '';
  } else {
    serverNameEl.style.display = 'none';
  }
}

// Clean up all per-peer audio state before reconnecting to a new room.
function purgeAll() {
  peers.clear();
  gains.clear();
  lastSpokenAt.clear();
  currentSpeakers = new Set();
  for (const nodes of audioNodes.values()) {
    try { nodes.source.disconnect(); } catch {}
    try { nodes.delay?.disconnect(); } catch {}
    try { nodes.filter.disconnect(); } catch {}
    try { nodes.panner.disconnect(); } catch {}
    try { nodes.gainNode.disconnect(); } catch {}
    if (nodes.el) nodes.el.remove();
  }
  audioNodes.clear();
  audioPublications.clear();
  subscribedPeers.clear();
  // Avatars are announcements made *inside* a room, so they do not survive it:
  // keeping them would paint a stale flag on a same-named player in the next
  // server before that player has said anything.
  peerAvatars.clear();
}

async function disconnectLiveKit() {
  if (!room) return;
  // Cleared BEFORE disconnecting, not after: room.disconnect() fires
  // RoomEvent.Disconnected, and that handler must be able to tell an
  // intentional teardown (server change, leaving) from a connection that died
  // on its own. It checks `room !== newRoom`, so the field has to be released
  // first or a normal server change would show "Disconnected from the voice
  // room" to a player who did nothing wrong.
  const old = room;
  room = null;
  try { await old.disconnect(); } catch {}
  roomConnectedAt = null;
  if (roomStatsEl) roomStatsEl.style.display = 'none';
  purgeAll();
}

// Wire up all LiveKit room events. Called once per LiveKit room instance.
function attachRoomEvents(newRoom) {
  // The room can drop long after a successful connect - server restart, wifi
  // dying, laptop waking from sleep. Without these three the page kept showing
  // "Connected, you'll hear nearby players automatically" over a dead room,
  // which is the worst possible failure: it tells the player the silence is
  // normal. Each one is ignored if it arrives from a room we already replaced
  // (a server change disconnects the old room on purpose).
  newRoom.on(LivekitClient.RoomEvent.Reconnecting, () => {
    if (room !== newRoom) return;
    showFailure('Connection lost', 'reconnecting, hang on…');
  });
  newRoom.on(LivekitClient.RoomEvent.Reconnected, () => {
    if (room !== newRoom) return;
    statusEl.textContent = `✅ Connected — you'll hear nearby players automatically`;
    statusEl.className = 'ok';
  });
  newRoom.on(LivekitClient.RoomEvent.Disconnected, () => {
    if (room !== newRoom) return;
    room = null;
    roomConnectedAt = null;
    if (roomStatsEl) roomStatsEl.style.display = 'none';
    purgeAll();
    micEnabled = false;
    micBtn.disabled = true;
    micBtn.className = 'idle';
    stopMicMeter();
    // The room dropped on its own, so the button becomes the cheap way back:
    // the cached token is usually still valid, and trying it costs one click
    // instead of a round trip through the game.
    showLeaveBtn('rejoin');
    showFailure('Disconnected from the voice room',
      'click Rejoin below, or reload this page.');
  });

  newRoom.on(LivekitClient.RoomEvent.DataReceived, (payload, participant, kind, topic) => {
    if (topic === AVATAR_TOPIC) {
      // The key is participant.identity, which LiveKit takes from the signed
      // token, and never a name inside the payload - otherwise announcing an
      // avatar "for" another player would be a one-liner. validateAvatar() then
      // reduces the body to a flag we ship or an emoji from our own palette, so
      // the worst a hostile participant can do to someone else's screen is pick
      // an ugly flag for themselves.
      if (!participant || !participant.identity) return;
      const decoded = decodePosition(payload);
      const av = validateAvatar(decoded);
      if (av) peerAvatars.set(participant.identity, av);
      else peerAvatars.delete(participant.identity);
      renderPlayerList();
      return;
    }
    if (topic !== 'position') return;
    // Positions come from the relay, which speaks through the LiveKit server
    // API - so they arrive with NO participant attached. A 'position' packet
    // that has one was published by somebody's browser, and since positions
    // decide who you can hear, honouring it would let a participant place
    // themselves next to anyone. Browsers can publish data now (they announce
    // their avatar), so this line is what stops that door being open.
    if (participant) return;
    // Audit #27: the relay now aggregates every player's latest position into
    // one array per broadcast instead of one message per player, so this
    // handler runs the same per-position logic in a loop instead of once.
    const positions = decodePosition(payload);
    if (!Array.isArray(positions)) return;
    for (const msg of positions) {
      if (!msg) continue;
      if (msg.pseudo === myIdentity) {
        // Our own position coming back from the game: in follow mode this is
        // where "me" comes from (the car), instead of the dragged canvas dot.
        if (isSwitchOn(followGameCheckbox)) {
          const x = Number(msg.x), y = Number(msg.y), z = Number(msg.z ?? 0);
          if (isFinite(x) && isFinite(y) && isFinite(z)
              && Math.abs(x) < 1e6 && Math.abs(y) < 1e6 && Math.abs(z) < 1e6) {
            me.x = x; me.y = y; me.z = z;
            meKnown = true;
          }
          // Heading rides along with our own position and is validated
          // separately: a plugin too old to send one, or a car between
          // respawns, still gives a perfectly good position. Keeping the
          // previous heading in that case would be worse than having none —
          // it would rotate the world around a direction we stopped facing.
          const fx = Number(msg.fx), fz = Number(msg.fz);
          myHeading = (isFinite(fx) && isFinite(fz) && (fx !== 0 || fz !== 0))
            ? { fx, fz } : null;
        }
        continue;
      }
      const px = Number(msg.x), py = Number(msg.y), pz = Number(msg.z ?? 0);
      if (!isFinite(px) || !isFinite(py) || !isFinite(pz)
          || Math.abs(px) >= 1e6 || Math.abs(py) >= 1e6 || Math.abs(pz) >= 1e6) continue;
      const pseudo = typeof msg.pseudo === 'string' && msg.pseudo.length <= 64 ? msg.pseudo : null;
      if (!pseudo) continue;
      // Keep the velocity implied by the previous packet so tickGains() and the
      // radar can carry this peer forward between packets instead of freezing
      // them (see extrapolatedPosition). Derived here, where we know the exact
      // arrival time of both samples; never sent over the wire.
      const prev = peers.get(pseudo);
      const next = { x: px, y: py, z: pz, lastSeen: Date.now() };
      const vel = velocityFrom(prev, next, prev);
      peers.set(pseudo, { ...next, ...vel });
    }
  });

  // Audit #31: with autoSubscribe:false, tickGains() decides when to subscribe
  // to a participant's mic, but it needs the RemoteTrackPublication to call
  // setSubscribed() on - TrackPublished is how we learn it exists. registerPublications()
  // also covers participants who published before we joined (their publications
  // are already present on the RemoteParticipant, no separate event fires for those).
  function registerPublications(participant) {
    for (const pub of participant.trackPublications.values()) {
      if (pub.kind === LivekitClient.Track.Kind.Audio) audioPublications.set(participant.identity, pub);
    }
  }

  newRoom.on(LivekitClient.RoomEvent.ParticipantConnected, (p) => {
    logEvent(`participant joined: ${p.identity}`);
    showToast(`${p.identity} joined`);
    registerPublications(p);
    // Data packets are not replayed to latecomers, so someone joining an
    // established room would otherwise see everyone wearing a hashed animal.
    // Aimed at them specifically rather than broadcast, so a join does not
    // trigger n announcements to n players.
    announceAvatar(p.identity);
  });
  newRoom.on(LivekitClient.RoomEvent.ParticipantDisconnected, (p) => {
    logEvent(`participant left: ${p.identity}`);
    showToast(`${p.identity} left`);
    audioPublications.delete(p.identity);
    subscribedPeers.delete(p.identity);

    // Safety net: don't rely on TrackUnsubscribed to also fire here -
    // on an abrupt network loss it sometimes doesn't, which would otherwise
    // leak this participant's WebAudio graph and hidden <audio> element for
    // the rest of the session.
    const nodes = audioNodes.get(p.identity);
    if (nodes) {
      try { nodes.source.disconnect(); } catch {}
      try { nodes.delay?.disconnect(); } catch {}
      try { nodes.filter.disconnect(); } catch {}
      try { nodes.panner.disconnect(); } catch {}
      try { nodes.gainNode.disconnect(); } catch {}
      if (nodes.el) nodes.el.remove();
      audioNodes.delete(p.identity);
    }
  });
  newRoom.on(LivekitClient.RoomEvent.TrackPublished, (pub, participant) => {
    if (pub.kind === LivekitClient.Track.Kind.Audio) audioPublications.set(participant.identity, pub);
  });
  newRoom.on(LivekitClient.RoomEvent.TrackUnpublished, (pub, participant) => {
    audioPublications.delete(participant.identity);
    subscribedPeers.delete(participant.identity);
  });

  // Routes each remote player's mic through its own WebAudio graph instead of
  // a plain <audio> element, so gain AND stereo pan can be driven per-peer
  // from tickGains() (a plain <audio> only gives a single overall volume via
  // setVolume() - no left/right). See context.txt ARCHITECTURE AUDIO.
  newRoom.on(LivekitClient.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    logEvent(`TrackSubscribed: ${participant.identity} (kind=${track.kind})`);
    if (track.kind !== LivekitClient.Track.Kind.Audio) return;

    // Audit #10: a re-subscription (mic republish after a network hiccup or
    // device change) must not leave the previous WebAudio graph dangling -
    // audioNodes.set() below would otherwise just overwrite the map entry,
    // leaking the old nodes and doubling the audio at whatever gain they were
    // last set to.
    const existing = audioNodes.get(participant.identity);
    if (existing) {
      try { existing.source.disconnect(); } catch {}
      try { existing.delay?.disconnect(); } catch {}
      try { existing.filter.disconnect(); } catch {}
      try { existing.panner.disconnect(); } catch {}
      try { existing.gainNode.disconnect(); } catch {}
      if (existing.el) existing.el.remove();
      audioNodes.delete(participant.identity);
    }

    // Chrome quirk: a remote WebRTC audio track that's only ever fed into Web
    // Audio (createMediaStreamSource) and never actually "played" through a
    // media element does not get its RTP frames decoded/pulled at all - the
    // whole graph below silently processes zeroes. attach() creates that
    // element for us; muting it stops its own output so there's no double
    // playback, while it keeps the track flowing into the WebAudio graph,
    // which is the only path that's actually audible.
    const el = track.attach();
    el.muted = true;
    el.volume = 0;
    el.style.display = 'none';
    document.body.appendChild(el);

    if (!audioCtx) return; // audioCtx is created at join time, should always exist here
    const stream = new MediaStream([track.mediaStreamTrack]);
    const source = audioCtx.createMediaStreamSource(stream);
    // Air absorption, ahead of the panner so both ears get the same colour.
    // Starts wide open: tickGains() closes it down as the distance comes in,
    // and a peer whose first frames arrive before their first position should
    // not be muffled by a filter that defaulted to "far".
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = LOWPASS_NEAR_HZ;
    const panner = audioCtx.createStereoPanner();
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = 0;
    // Doppler: the sound's travel time, ahead of everything else because that
    // is the order the physics happens in. Always in the graph, even with the
    // effect off - it then just sits at DOPPLER_BASE_SEC and does nothing, which
    // is cheaper and far less clicky than rewiring the chain mid-conversation.
    // Feature-detected because the test double for AudioContext has no delay.
    const delay = audioCtx.createDelay ? audioCtx.createDelay(DOPPLER_MAX_DELAY_SEC) : null;
    if (delay) {
      delay.delayTime.value = DOPPLER_BASE_SEC;
      source.connect(delay).connect(filter);
    } else {
      source.connect(filter);
    }
    filter.connect(panner).connect(gainNode).connect(audioCtx.destination);
    audioNodes.set(participant.identity, { source, delay, filter, panner, gainNode, el });
  });

  // LiveKit's SFU computes active speakers for every connected client
  // regardless of subscriptions, so listening here costs nothing extra in
  // server load or bandwidth - it's already flowing to us.
  newRoom.on(LivekitClient.RoomEvent.ActiveSpeakersChanged, (speakers) => {
    const now = Date.now();
    currentSpeakers = new Set(speakers.map((s) => s.identity));
    for (const identity of currentSpeakers) lastSpokenAt.set(identity, now);
  });

  newRoom.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
    logEvent(`TrackUnsubscribed: ${participant.identity}`);
    track.detach().forEach((el) => el.remove());
    const nodes = audioNodes.get(participant.identity);
    if (!nodes) return;
    nodes.source.disconnect();
    nodes.delay?.disconnect();
    nodes.filter.disconnect();
    nodes.panner.disconnect();
    nodes.gainNode.disconnect();
    audioNodes.delete(participant.identity);
  });
}

// Personal mic level meter: builds its bars once, then is started/stopped
// around the local mic actually being enabled/disabled. The row itself stays
// visible either way (bars just idle at their base height).
// Feature-detected (createAnalyser) rather than assumed, since the test
// double for AudioContext doesn't implement it and this must stay a no-op
// there - the meter is a pure visual nicety, never load-bearing.
const micMeter = createMicMeter({
  el: micMeterEl,
  getAudioCtx: () => audioCtx,
  getRoom: () => room,
  getReduceMotion: () => reduceMotion,
});
const findLocalAudioTrack = micMeter.findLocalAudioTrack;
const startMicMeter = micMeter.start;
const stopMicMeter = micMeter.stop;

// Every failure path ends here, and every message has to answer "what do I do
// now?". A player who sees a raw "Connection error: NetworkError when attempting
// to fetch resource" learns nothing and reloads at random; the second half of
// each sentence is the part that actually helps.
function showFailure(what, whatToDo) {
  statusEl.textContent = `${what} — ${whatToDo}`;
  statusEl.className = 'err';
  logEvent(`failure shown: ${what}`);
}

// Reaching the relay at all. Distinguished from a room failure because the
// remedies differ: here nothing on the page works, so there is no point telling
// someone to click a button in the game.
function showRelayUnreachable() {
  showFailure("Can't reach the OnZVoIP server",
    'check your internet connection, then reload this page.');
}

// Wraps fetch so a dead relay produces a message instead of an unhandled
// rejection. Without this the ?t= flow left the page frozen on "Connecting…"
// and the manual flow left the Join button greyed out for good: the audit's
// try/catch (#7) only ever covered room.connect(), not the token request that
// runs before it.
async function fetchToken(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    logEvent(`token fetch failed: ${err.message}`);
    return { ok: false, unreachable: true };
  }
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, data: await res.json() };
}

// --- Leaving the voice chat, and coming back ---
//
// Kept in memory only, never in localStorage. That is the whole security
// design: a resume credential written to disk would turn the relay's
// single-use, 12-minute nonce - which proves you are on that server *right
// now*, because the in-game plugin is what issues it - into something
// replayable from a machine that left the game hours ago. In a tab, it dies
// with the tab, so leaving and returning costs nothing while the risk window
// stays exactly as long as the session the player is already sitting in.
let lastRoomCredentials = null;
// Set only by the Leave button. Distinguishes "I chose to step out" from "the
// connection died", which need opposite handling: the second is a failure to
// report, the first must not be undone behind the player's back.
let leftVoluntarily = false;
// If the player changes server while out, the relay pushes a fresh nonce. It is
// parked here rather than acted on, so Rejoin lands in the room they are
// actually on instead of the one they left.
let pendingRoomNonce = null;

function showLeaveBtn(mode) {
  if (!leaveBtn) return;
  if (!mode) { leaveBtn.style.display = 'none'; return; }
  leaveBtn.style.display = '';
  const rejoin = mode === 'rejoin';
  leaveBtn.textContent = rejoin ? '↩ Rejoin voice chat' : 'Leave voice chat';
  leaveBtn.className = rejoin ? 'leave-btn rejoin' : 'leave-btn';
}

async function leaveVoice() {
  if (!room) return;
  leftVoluntarily = true;
  micEnabled = false;
  stopMicMeter();
  await disconnectLiveKit();
  micBtn.disabled = true;
  micBtn.className = 'idle';
  micBtn.textContent = '🎤 Enable microphone';
  statusEl.textContent = "You left the voice chat — nobody can hear you";
  statusEl.className = '';
  showLeaveBtn('rejoin');
  logEvent('left voice chat');
}

async function rejoinVoice() {
  if (room) return;
  statusEl.textContent = 'Connecting...';
  statusEl.className = '';
  // A parked nonce wins over the cached token: it is newer, and it is the only
  // one pointing at the server the player moved to while they were out.
  let creds = lastRoomCredentials;
  if (pendingRoomNonce) {
    const res = await fetchToken(`/token?t=${encodeURIComponent(pendingRoomNonce)}`);
    pendingRoomNonce = null;
    if (!res.ok) {
      if (res.unreachable) showRelayUnreachable();
      else showFailure('Could not rejoin the voice room',
        'click Copy URL in the game to get a fresh link.');
      showLeaveBtn('rejoin');
      return;
    }
    const { token, wsUrl, room: roomName, login, serverName } = res.data;
    creds = { token, wsUrl, roomName, login, serverName };
  }
  if (!creds) {
    showFailure('Could not rejoin the voice room',
      'click Copy URL in the game to get a fresh link.');
    showLeaveBtn('rejoin');
    return;
  }
  leftVoluntarily = false;
  try {
    await connectLiveKit(creds);
  } catch {
    // The cached token outlives the tab's usefulness only if the room is still
    // there; when it is not, the way back is the game, not a retry loop.
    leftVoluntarily = true;
    showFailure('Could not rejoin the voice room',
      'click Copy URL in the game to get a fresh link.');
    showLeaveBtn('rejoin');
    return;
  }
  logEvent('rejoined voice chat');
}

if (leaveBtn) {
  leaveBtn.addEventListener('click', () => {
    if (room) leaveVoice(); else rejoinVoice();
  });
}

// Connect (or reconnect) to a LiveKit room using an already-fetched token.
// serverName is the human-readable display name shown in that banner, or null for legacy joins.
async function connectLiveKit({ token, wsUrl, roomName, login, serverName }) {
  if (!audioCtx) {
    // Created here for auto-join (no click handler). May start suspended — the
    // mic button click will resume it (audioCtx.resume() in the mic handler).
    audioCtx = new AudioContext();
    logEvent(`AudioContext created, state=${audioCtx.state}`);
  }

  const newRoom = new LivekitClient.Room();
  attachRoomEvents(newRoom);
  try {
    // Audit #31: don't auto-subscribe to every participant's audio - tickGains()
    // subscribes/unsubscribes per peer based on distance instead.
    await newRoom.connect(wsUrl, token, { autoSubscribe: false });
  } catch (err) {
    // Audit #7: let callers reset their own UI (join button, identity field,
    // status text) instead of leaving them stuck on "Connexion...".
    logEvent(`LiveKit connect failed: ${err.message}`);
    throw err;
  }
  // Participants already in the room published their tracks before we connected,
  // so no TrackPublished event fires for them - register directly.
  for (const participant of newRoom.remoteParticipants.values()) {
    for (const pub of participant.trackPublications.values()) {
      if (pub.kind === LivekitClient.Track.Kind.Audio) audioPublications.set(participant.identity, pub);
    }
  }
  await newRoom.localParticipant.setMicrophoneEnabled(false);

  room = newRoom;
  roomConnectedAt = Date.now();
  if (roomStatsEl) roomStatsEl.style.display = '';
  // Once we're in a room the join row and the tagline have done their job, and
  // the approved render shows neither. The ?t= flow hides the join row up front
  // (see the head script in index.html); this covers the manual flow too.
  if (joinSectionEl) joinSectionEl.style.display = 'none';
  if (taglineEl) taglineEl.style.display = 'none';
  updateServerDisplay(serverName ?? null);
  const debugRoomVal = document.getElementById('debugRoomVal');
  if (debugRoomVal) debugRoomVal.textContent = roomName;
  statusEl.textContent = `✅ Connected — you'll hear nearby players automatically`;
  statusEl.className = 'ok';
  micBtn.disabled = false;
  micBtn.textContent = '🎤 Enable microphone';
  micBtn.className = 'muted';
  if (expiredMsgEl) expiredMsgEl.style.display = 'none';
  // Remembered so the Leave button has something to come back to. Held in this
  // variable and nowhere else - see the note above its declaration.
  lastRoomCredentials = { token, wsUrl, roomName, login, serverName };
  leftVoluntarily = false;
  pendingRoomNonce = null;
  showLeaveBtn('leave');
  // Tell whoever is already here. Not awaited: a flag is not worth delaying the
  // moment the player can start talking.
  announceAvatar();
  // The login is only known now, so an Auto preview drawn at page load was
  // hashing the empty string. This settles it on the real one.
  renderAvatarPreview();
}

// Start the persistent /ingest WebSocket. Stays alive across room changes.
// Re-registers login on reconnect so the relay keeps its browserSockets entry.
function startIngestWs(identity) {
  if (ingestWs && ingestWs.readyState !== WebSocket.CLOSED) return;
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ingestWs = new WebSocket(`${wsProto}//${location.host}/ingest`);

  ingestWs.addEventListener('open', () => {
    // Register this browser with the relay so it can push room-change notifications.
    ingestWs.send(JSON.stringify({ type: 'hello', login: identity }));
    startPositionSend();
  });

  ingestWs.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'room') handleRoomPush(msg);
      else if (msg.type === 'teams' && Array.isArray(msg.teams)) {
        teamList = msg.teams;
        teamMembers = msg.members && typeof msg.members === 'object' ? msg.members : {};
      }
    } catch {}
  });

  ingestWs.addEventListener('close', () => {
    ingestWs = null;
    // Reconnect after a short delay; re-sends hello on open.
    setTimeout(() => { if (myIdentity) startIngestWs(myIdentity); }, 3000);
  });
}

function startPositionSend() {
  if (wsPositionInterval) return;
  wsPositionInterval = setInterval(() => {
    if (!ingestWs || ingestWs.readyState !== WebSocket.OPEN) return;
    if (!shouldSendOwnPosition()) return;
    ingestWs.send(JSON.stringify({ type: 'position', pseudo: myIdentity, x: me.x, y: me.y, z: me.z }));
  }, SEND_INTERVAL_MS);
}

// The relay pushes this when the plugin sends a new nonce.
async function handleRoomPush(msg) {
  // Someone who pressed Leave stays out. Without this the plugin's next push -
  // and it pushes on every server change - would drag them straight back into
  // a room they deliberately left, which makes the button useless. The nonce is
  // kept so Rejoin lands on the right server.
  if (leftVoluntarily) {
    pendingRoomNonce = msg.name ? (msg.nonce ?? null) : null;
    // The push carries the room's technical name, not the display one (that
    // comes back with the token), so the banner is only ever cleared here,
    // never rewritten with something a player would not recognise.
    if (!msg.name) updateServerDisplay(null);
    return;
  }
  if (!msg.name) {
    // Player left the server — disconnect and show waiting state.
    await disconnectLiveKit();
    updateServerDisplay(null);
    statusEl.textContent = 'Not on a server — voice on standby';
    statusEl.className = '';
    micBtn.disabled = true;
    micBtn.className = 'idle';
    micEnabled = false;
    stopMicMeter();
    // Nothing to go back to while off-server: the old room's token points at a
    // server this player is no longer on, so offering Rejoin would only fail.
    showLeaveBtn(null);
    lastRoomCredentials = null;
    return;
  }
  // Server changed — swap to the new room using the provided nonce.
  if (!msg.nonce) return;
  // ...unless it is the room we are already in. The plugin re-issues a nonce on
  // a timer, and every one of those pushes used to tear the LiveKit connection
  // down and rebuild it: a voice cut every 9 minutes, on a server nobody left.
  // It also has to stop here now that the relay asks the plugin for a fresh
  // nonce as soon as one is spent — consuming this one would trigger another
  // push, and the two would chase each other forever.
  if (room && lastRoomCredentials?.roomName === msg.name) return;
  const res = await fetchToken(`/token?t=${encodeURIComponent(msg.nonce)}`);
  if (!res.ok) {
    // This used to `return` silently: the player changed server, voice stopped
    // working, and the page still claimed to be connected to the old room.
    if (res.unreachable) showRelayUnreachable();
    else showFailure('You changed server, but the new room could not be opened',
      'click Copy URL in the game to join it.');
    return;
  }
  const { token, wsUrl, room: roomName, login, serverName } = res.data;
  const wasMicEnabled = micEnabled;
  await disconnectLiveKit();
  try {
    await connectLiveKit({ token, wsUrl, roomName, login, serverName });
  } catch {
    showFailure('Could not join the new server’s voice room',
      'click Copy URL in the game to try again.');
    return;
  }
  // Restore mic state in the new room.
  if (wasMicEnabled && room) {
    await room.localParticipant.setMicrophoneEnabled(true, {
      autoGainControl: true,
      noiseSuppression: false,
      echoCancellation: false,
    });
    micEnabled = true;
    micBtn.textContent = '🔴 Mute microphone';
    micBtn.className = 'live';
    startMicMeter(findLocalAudioTrack());
  }
}

// Auto-join from a ?t=<nonce> URL (placed there by the in-game plugin).
async function connectViaNonce(nonce) {
  statusEl.textContent = 'Connecting...';
  if (expiredMsgEl) expiredMsgEl.style.display = 'none';

  const res = await fetchToken(`/token?t=${encodeURIComponent(nonce)}`);
  if (!res.ok) {
    statusEl.textContent = '';
    if (res.unreachable) showRelayUnreachable();
    // An expired nonce is the common case (an old tab, a link kept around), and
    // it has its own panel spelling out the fix.
    else if (res.status === 401 && expiredMsgEl) expiredMsgEl.style.display = '';
    else showFailure(`The server refused this link (error ${res.status})`,
      'click Copy URL again in the game to get a fresh one.');
    return;
  }
  const { token, wsUrl, room: roomName, login, serverName } = res.data;
  myIdentity = login;
  try {
    await connectLiveKit({ token, wsUrl, roomName, login, serverName });
  } catch {
    showFailure('Could not join the voice room',
      'click Copy URL again in the game, or reload this page.');
    return;
  }
  startIngestWs(login);
}

// Manual join (identity input + Join button), and the debug room picker.
// Both are behind the relay's DEBUG_MODE: without it /token answers 404, which
// is exactly the "The server refused this name (error 404)" a player sees if
// they reach this on a published relay. That is intended - see .env.example.
// `roomOverride` names the room to land in; ignored by a relay with debug off.
async function join(roomOverride = null) {
  const identity = identityInput.value.trim();
  if (!identity) return;
  myIdentity = identity;
  joinBtn.disabled = true;
  identityInput.disabled = true;
  statusEl.textContent = 'Connecting...';

  let url = `/token?identity=${encodeURIComponent(identity)}`;
  if (roomOverride) url += `&room=${encodeURIComponent(roomOverride)}`;
  const res = await fetchToken(url);
  if (!res.ok) {
    if (res.unreachable) showRelayUnreachable();
    else showFailure(`The server refused this name (error ${res.status})`,
      'try a different name, or reload the page.');
    joinBtn.disabled = false;
    identityInput.disabled = false;
    return;
  }
  const { token, wsUrl, room: roomName } = res.data;

  // Created inside this click handler so the browser's autoplay policy
  // treats it as user-initiated and doesn't leave it suspended.
  audioCtx = new AudioContext();
  logEvent(`AudioContext created, state=${audioCtx.state}`);
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().then(() => logEvent(`AudioContext.resume() -> ${audioCtx.state}`));
  }

  try {
    await connectLiveKit({ token, wsUrl, roomName, login: identity, serverName: null });
  } catch {
    showFailure('Could not join the voice room',
      'check your internet connection and press Join again.');
    joinBtn.disabled = false;
    identityInput.disabled = false;
    return;
  }
  startIngestWs(identity);
}

// Wrapped, not passed directly: a listener is called with the click event, and
// join() now takes a room name as its first argument - handing it a MouseEvent
// would put "[object MouseEvent]" in the query string.
joinBtn.addEventListener('click', () => join());

// Debug-only room picker. Rendered only when the relay allows debug (see the
// bootstrap script in index.html), and refused server-side otherwise, so the
// guard here is about the element being absent, not about permission.
const debugRoomInput = document.getElementById('debugRoom');
const debugRoomJoinBtn = document.getElementById('debugRoomJoin');
const debugRoomMsgEl = document.getElementById('debugRoomMsg');
if (debugRoomJoinBtn) {
  debugRoomJoinBtn.addEventListener('click', async () => {
    const target = debugRoomInput.value.trim();
    if (debugRoomMsgEl) debugRoomMsgEl.textContent = '';
    if (!target) {
      if (debugRoomMsgEl) debugRoomMsgEl.textContent = 'Type a room name first';
      return;
    }
    // Same character set the relay accepts (validateServer in relay.js). A
    // rejected name there silently falls back to the default room, which would
    // look like the picker did nothing - so say it here instead.
    if (!/^[a-z0-9_-]{1,64}$/i.test(target)) {
      if (debugRoomMsgEl) debugRoomMsgEl.textContent = 'Letters, digits, - and _ only';
      return;
    }
    if (!identityInput.value.trim()) {
      if (debugRoomMsgEl) debugRoomMsgEl.textContent = 'Type a login above first';
      return;
    }
    // Leave whatever room we are in first: connectLiveKit() would otherwise
    // hand `room` a second connection and the first one would keep playing.
    if (room) await disconnectLiveKit();
    await join(target);
  });
}

micBtn.addEventListener('click', async () => {
  if (!room) return;
  micEnabled = !micEnabled;
  // Resume AudioContext if it was created outside a user gesture (auto-join).
  if (audioCtx && audioCtx.state === 'suspended') {
    await audioCtx.resume();
    logEvent(`AudioContext resumed: ${audioCtx.state}`);
  }
  // noiseSuppression/echoCancellation off: confirmed culprit for a slow
  // (~1-2s) volume "breathing" baked into the captured signal itself (the
  // debug table's gain column stayed stable while it happened, ruling out
  // our distance math). autoGainControl left on - it wasn't the cause here.
  await room.localParticipant.setMicrophoneEnabled(micEnabled, {
    autoGainControl: true,
    noiseSuppression: false,
    echoCancellation: false,
  });
  micBtn.textContent = micEnabled ? '🔴 Mute microphone' : '🎤 Enable microphone';
  micBtn.className = micEnabled ? 'live' : 'muted';
  if (micEnabled) startMicMeter(findLocalAudioTrack());
  else stopMicMeter();
});

// --- Report a problem ------------------------------------------------------
// The snapshot answers the questions we would otherwise have to ask back over
// Discord one at a time — is the tab in a room, is the mic actually publishing,
// is the plugin feeding positions — while the tester still has the problem in
// front of them. Everything in it is read off state the page already holds.
function reportSnapshot() {
  const bits = [];
  bits.push(`voice=${room ? `in ${lastRoomCredentials?.roomName ?? '?'}` : 'not connected'}`);
  if (room && roomConnectedAt) bits.push(`for=${Math.round((Date.now() - roomConnectedAt) / 1000)}s`);
  // micBtn's class is the same three-state the player is looking at, so a
  // report can never disagree with the button they are describing.
  bits.push(`mic=${micBtn.className || 'idle'}`);
  bits.push(`peers=${peers.size}`);
  // The two that separate "the voice half broke" from "the game half broke".
  bits.push(`plugin=${ingestWs && ingestWs.readyState === 1 ? 'linked' : 'no'}`);
  bits.push(`myPos=${isSwitchOn(followGameCheckbox) ? (meKnown ? 'from game' : 'waiting') : 'manual'}`);
  bits.push(`audio=${audioCtx ? audioCtx.state : 'none'}`);
  bits.push(`link=${new URLSearchParams(location.search).get('t') ? 'from game' : 'typed'}`);

  // The last few client-side log lines, newest first — they are already
  // timestamped and they are usually where the actual failure is named.
  const recent = Array.from(eventLogEl.children).slice(0, 3).map((el) => el.textContent);
  // 500 is the relay's clamp on this field; cutting here means the snapshot
  // shown in the panel is exactly the snapshot that gets stored.
  return `${bits.join(' ')}\n${recent.join('\n')}`.slice(0, 500);
}

createReporter({
  toggle: document.getElementById('reportToggle'),
  panel: document.getElementById('reportPanel'),
  text: document.getElementById('reportText'),
  send: document.getElementById('reportSend'),
  cancel: document.getElementById('reportCancel'),
  msg: document.getElementById('reportMsg'),
  onToast: showToast,
  getSnapshot: () => ({
    // myIdentity is set by the manual join; the nonce path knows the login
    // only through the credentials the relay handed back.
    login: lastRoomCredentials?.login ?? myIdentity ?? null,
    room: lastRoomCredentials?.roomName ?? null,
    state: reportSnapshot(),
  }),
});

// Auto-join: if URL contains ?t=<nonce>, skip the form and join immediately.
// The join form is hidden by inline script in index.html (before this module
// loads) to avoid flash of the form.
const urlNonce = new URLSearchParams(location.search).get('t');
if (urlNonce) {
  connectViaNonce(urlNonce);
} else {
  // Pre-fill the identity from ?identity= so the in-game button (which opens
  // the URL with the TM login already appended) saves the player a manual step.
  const urlIdentity = new URLSearchParams(location.search).get('identity');
  if (urlIdentity) identityInput.value = urlIdentity;
}

// Exported for server/test/app.test.js only — a <script type="module"> ignores
// unused exports, so this has no effect on the browser build.
export {
  tickGains, applyRelativeMode, gainLabel, decodePosition, worldToScreen,
  purgeAll, disconnectLiveKit, attachRoomEvents, connectLiveKit,
  startIngestWs, startPositionSend, shouldSendOwnPosition, handleRoomPush,
  connectViaNonce, join,
  renderPlayerList, renderPeerTable, renderFollowChips, draw,
  projectToRadar, emojiForPseudo, setupCalibration,
  gainForCurrentMode, cutoffForCurrentMode, offsetInEarFrame, headingForView,
  driveDoppler, dopplerPreset, setupDoppler,
  leaveVoice, rejoinVoice,
  avatarFor, setMyAvatar, myEffectiveAvatar, announceAvatar, peerAvatars,
  me, peers, gains, audioNodes, audioPublications, subscribedPeers, room,
  MIN_DIST, MAX_DIST, PAN_STRENGTH, PEER_GC_MS,
};
