// OnZVoIP local prototype client.
// Owns: (1) a draggable canvas dot standing in for "my own position" (what the
// OpenPlanet plugin will eventually report), (2) rendering of other players'
// positions received over Livekit's data channel, and (3) the actual
// proximity-audio math: distance -> gain, applied locally per remote track.
// See ../../context.txt "ARCHITECTURE AUDIO" for why this lives client-side.

import { distance, clamp, gainForDistance, panForOffset } from './audio-math.js';

// Live-tunable from the calibration sliders (see index.html #calib) because
// these are in *game* units now that real positions come from the OpenPlanet
// plugin, and the right values can only be found by ear while driving.
// Defaults below are the old canvas-test values, i.e. NOT yet calibrated -
// once good values are found in game they should be pasted back here.
let MIN_DIST = 1;    // full volume within this radius
let MAX_DIST = 150;  // silence beyond this radius
let PAN_RANGE = 10;  // horizontal offset for fully-panned left/right

const SEND_INTERVAL_MS = 200;
const LERP_FACTOR = 0.15; // per animation-frame smoothing towards target gain (canvas/debug table)
const AUDIO_SMOOTHING_SEC = 0.05; // WebAudio setTargetAtTime time constant for gain/pan

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const identityInput = document.getElementById('identity');
const followGameCheckbox = document.getElementById('followGame');
const relativeModeCheckbox = document.getElementById('relativeMode');
const relativeTargetInput = document.getElementById('relativeTarget');
const relativeRangeSlider = document.getElementById('relativeRange');
const relativeRangeVal = document.getElementById('relativeRangeVal');
const relativeOffsetXSlider = document.getElementById('relativeOffsetX');
const relativeOffsetXVal = document.getElementById('relativeOffsetXVal');
const relativeOffsetYSlider = document.getElementById('relativeOffsetY');
const relativeOffsetYVal = document.getElementById('relativeOffsetYVal');
const joinBtn = document.getElementById('joinBtn');
const micBtn = document.getElementById('micBtn');
const statusEl = document.getElementById('status');
const expiredMsgEl = document.getElementById('expiredMsg');
const serverNameEl = document.getElementById('serverName');
const peersBody = document.querySelector('#peers tbody');
const meReadoutEl = document.getElementById('meReadout');
const eventLogEl = document.getElementById('eventLog');

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
  if (!relativeModeCheckbox.checked) return;
  const target = peers.get(relativeTargetInput.value.trim());
  if (!target) return; // no position received yet for that login
  me.x = target.x + Number(relativeOffsetXSlider.value);
  me.z = target.z + Number(relativeOffsetYSlider.value); // "front/back" is depth (Z), not altitude
  me.y = target.y;
}

function logEvent(msg) {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  eventLogEl.prepend(line);
  while (eventLogEl.childElementCount > 20) eventLogEl.lastChild.remove();
}

let room = null;
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
followGameCheckbox.addEventListener('change', () => {
  if (followGameCheckbox.checked) meKnown = false;
});

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
// ranges (0-500 and 20-2000) — without a floor between them, dragging
// minDist past maxDist doesn't error, it just makes gainForDistance() treat
// maxDist as unreachable and hard-cut at minDist instead of fading. MIN_GAP
// keeps a slice of falloff always audible between the two.
const MIN_DIST_MAX_DIST_GAP = 1;

function setupCalibration() {
  const controls = [
    // maxDist first: on load, saved values are applied in this order, and
    // minDist's clamp below reads the (by-then-current) MAX_DIST.
    { id: 'maxDist', get: () => MAX_DIST, set: (v) => { MAX_DIST = Math.max(v, MIN_DIST + MIN_DIST_MAX_DIST_GAP); } },
    { id: 'minDist', get: () => MIN_DIST, set: (v) => { MIN_DIST = Math.min(v, MAX_DIST - MIN_DIST_MAX_DIST_GAP); } },
    { id: 'panRange', get: () => PAN_RANGE, set: (v) => { PAN_RANGE = v; } },
  ];

  for (const { id, get, set } of controls) {
    const slider = document.getElementById(id);
    const label = document.getElementById(`${id}Val`);
    // v2: bumped from the unversioned `onzvoip.${id}` key so a browser that
    // calibrated against old defaults doesn't silently keep overriding new
    // ones after a code change (audit #5) — old keys are simply orphaned.
    const saved = Number(localStorage.getItem(`onzvoip.v2.${id}`));
    if (saved > 0) set(saved);

    const sync = () => { label.textContent = get(); };
    slider.value = get();
    sync();

    slider.addEventListener('input', () => {
      set(Number(slider.value));
      slider.value = get(); // reflects clamping (e.g. minDist stopped short of maxDist)
      localStorage.setItem(`onzvoip.v2.${id}`, slider.value);
      sync();
    });
  }
}
setupCalibration();

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

// Audit #21: the canvas radar and the peer/player tables all live in either
// the always-visible player list or the collapsed-by-default Advanced panel.
// Redrawing them at the 60Hz of requestAnimationFrame burned CPU on DOM work
// nobody could see. draw()/renderPeerTable() only run from the throttled
// RENDER_INTERVAL_MS timer below, and are skipped outright while #optBody is
// collapsed; renderPlayerList() still runs there too since it's the one
// thing players actually look at, just no longer 60 times a second.
const RENDER_INTERVAL_MS = 100; // ~10Hz, plenty for a status readout
const optBody = document.getElementById('optBody');

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const scale = (Math.min(canvas.width, canvas.height) / 2 - 20) / Math.max(MAX_DIST, 1);
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  // range rings around me, for visual reference
  ctx.strokeStyle = '#333';
  ctx.beginPath(); ctx.arc(cx, cy, MIN_DIST * scale, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, MAX_DIST * scale, 0, Math.PI * 2); ctx.stroke();

  for (const [pseudo, pos] of peers) {
    const gain = gains.get(pseudo)?.current ?? 0;
    const p = worldToScreen(pos, scale);
    ctx.fillStyle = `rgba(220,60,60,${0.25 + 0.75 * gain})`;
    ctx.beginPath(); ctx.arc(p.x, p.y, 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ccc';
    ctx.font = '11px sans-serif';
    ctx.fillText(pseudo, p.x + 12, p.y + 4);
  }

  ctx.fillStyle = '#4aa8ff';
  ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#9cf';
  ctx.fillText(myIdentity ? `${myIdentity} (you)` : 'you', cx + 12, cy + 4);
}

function tickGains() {
  applyRelativeMode();
  // Audit #6: while waiting for our first real in-game position, force
  // silence instead of computing distance from the placeholder "me".
  const meReady = !followGameCheckbox.checked || meKnown;
  for (const [pseudo, pos] of peers) {
    const stale = Date.now() - pos.lastSeen > 3000;
    const dist = distance(me, pos);
    const target = (!meReady || stale) ? 0 : gainForDistance(dist, MIN_DIST, MAX_DIST);
    const g = gains.get(pseudo) ?? { current: target, target };
    g.target = target;
    g.current += (g.target - g.current) * LERP_FACTOR; // drives the canvas dot opacity / debug table only
    gains.set(pseudo, g);

    const nodes = audioNodes.get(pseudo);
    if (nodes && audioCtx) {
      const now = audioCtx.currentTime;
      nodes.gainNode.gain.setTargetAtTime(target, now, AUDIO_SMOOTHING_SEC);
      nodes.panner.pan.setTargetAtTime(panForOffset(pos.x - me.x, PAN_RANGE), now, AUDIO_SMOOTHING_SEC);
    }

    // Audit #31: subscribe/unsubscribe from this peer's audio based on distance.
    const pub = audioPublications.get(pseudo);
    if (pub) {
      const inRange = meReady && !stale && dist <= MAX_DIST;
      const wellOutOfRange = stale || !meReady || dist > MAX_DIST * UNSUBSCRIBE_MARGIN;
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

setInterval(() => {
  renderPlayerList();
  if (optBody.style.display !== 'none') {
    renderPeerTable();
    draw();
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

function renderPlayerList() {
  const list = document.getElementById('playerList');
  // Audit #9: union of peers (have a position) and audioNodes (have a
  // subscribed track) — a player who's connected with mic open but still in
  // the menus has audio and no position yet, and must still show up.
  const identities = new Set([...peers.keys(), ...audioNodes.keys()]);
  if (identities.size === 0) {
    list.innerHTML = '<li class="pl-empty">No other players in the room yet</li>';
    return;
  }
  list.innerHTML = '';
  for (const pseudo of identities) {
    const hasPosition = peers.has(pseudo);
    const g = hasPosition ? (gains.get(pseudo)?.current ?? 0) : 0;
    const hasAudio = audioNodes.has(pseudo);
    const pct = Math.round(g * 100);
    const icon = !hasAudio ? '👤' : g > 0.5 ? '🔊' : g > 0.05 ? '🔉' : '🔈';
    const li = document.createElement('li');
    const iconEl = document.createElement('span'); iconEl.className = 'pl-icon'; iconEl.textContent = icon;
    const nameEl = document.createElement('span'); nameEl.className = 'pl-name'; nameEl.textContent = pseudo;
    const labelEl = document.createElement('span'); labelEl.className = 'pl-label'; labelEl.textContent = hasPosition ? gainLabel(g) : 'no position yet';
    const barEl = document.createElement('div'); barEl.className = 'pl-bar';
    const fillEl = document.createElement('div'); fillEl.className = 'pl-fill'; fillEl.style.width = `${pct}%`;
    barEl.appendChild(fillEl);
    li.append(iconEl, nameEl, labelEl, barEl);
    list.appendChild(li);
  }
}

function renderPeerTable() {
  const mode = followGameCheckbox.checked
    ? 'from game'
    : relativeModeCheckbox.checked
      ? `relative to "${relativeTargetInput.value.trim()}"`
      : 'mouse';
  meReadoutEl.textContent = `me: x=${me.x.toFixed(0)} y=${me.y.toFixed(0)} z=${me.z.toFixed(0)} (${mode})`;

  peersBody.innerHTML = '';
  for (const [pseudo, pos] of peers) {
    const d = distance(me, pos);
    const g = gains.get(pseudo)?.current ?? 0;
    const pan = panForOffset(pos.x - me.x, PAN_RANGE);
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
  if (followGameCheckbox.checked || relativeModeCheckbox.checked) return;
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (Math.hypot(x - canvas.width / 2, y - canvas.height / 2) < 20) {
    dragging = true;
    lastMouse = { x, y };
  }
});
window.addEventListener('mouseup', () => { dragging = false; lastMouse = null; });
canvas.addEventListener('mousemove', (e) => {
  if (!dragging || lastMouse === null) return;
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const scale = (Math.min(canvas.width, canvas.height) / 2 - 20) / Math.max(MAX_DIST, 1);
  me.x += (x - lastMouse.x) / scale;
  me.z += (y - lastMouse.y) / scale; // screen-Y drives depth (Z), matching worldToScreen
  lastMouse = { x, y };
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
  for (const nodes of audioNodes.values()) {
    try { nodes.source.disconnect(); } catch {}
    try { nodes.panner.disconnect(); } catch {}
    try { nodes.gainNode.disconnect(); } catch {}
    if (nodes.el) nodes.el.remove();
  }
  audioNodes.clear();
  audioPublications.clear();
  subscribedPeers.clear();
}

async function disconnectLiveKit() {
  if (!room) return;
  try { await room.disconnect(); } catch {}
  room = null;
  purgeAll();
}

// Wire up all LiveKit room events. Called once per LiveKit room instance.
function attachRoomEvents(newRoom) {
  newRoom.on(LivekitClient.RoomEvent.DataReceived, (payload, participant, kind, topic) => {
    if (topic !== 'position') return;
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
        if (followGameCheckbox.checked) {
          const x = Number(msg.x), y = Number(msg.y), z = Number(msg.z ?? 0);
          if (isFinite(x) && isFinite(y) && isFinite(z)
              && Math.abs(x) < 1e6 && Math.abs(y) < 1e6 && Math.abs(z) < 1e6) {
            me.x = x; me.y = y; me.z = z;
            meKnown = true;
          }
        }
        continue;
      }
      const px = Number(msg.x), py = Number(msg.y), pz = Number(msg.z ?? 0);
      if (!isFinite(px) || !isFinite(py) || !isFinite(pz)
          || Math.abs(px) >= 1e6 || Math.abs(py) >= 1e6 || Math.abs(pz) >= 1e6) continue;
      const pseudo = typeof msg.pseudo === 'string' && msg.pseudo.length <= 64 ? msg.pseudo : null;
      if (!pseudo) continue;
      peers.set(pseudo, { x: px, y: py, z: pz, lastSeen: Date.now() });
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
    registerPublications(p);
  });
  newRoom.on(LivekitClient.RoomEvent.ParticipantDisconnected, (p) => {
    logEvent(`participant left: ${p.identity}`);
    audioPublications.delete(p.identity);
    subscribedPeers.delete(p.identity);

    // Safety net: don't rely on TrackUnsubscribed to also fire here -
    // on an abrupt network loss it sometimes doesn't, which would otherwise
    // leak this participant's WebAudio graph and hidden <audio> element for
    // the rest of the session.
    const nodes = audioNodes.get(p.identity);
    if (nodes) {
      try { nodes.source.disconnect(); } catch {}
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
    const panner = audioCtx.createStereoPanner();
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = 0;
    source.connect(panner).connect(gainNode).connect(audioCtx.destination);
    audioNodes.set(participant.identity, { source, panner, gainNode, el });
  });

  newRoom.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
    logEvent(`TrackUnsubscribed: ${participant.identity}`);
    track.detach().forEach((el) => el.remove());
    const nodes = audioNodes.get(participant.identity);
    if (!nodes) return;
    nodes.source.disconnect();
    nodes.panner.disconnect();
    nodes.gainNode.disconnect();
    audioNodes.delete(participant.identity);
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
  updateServerDisplay(serverName ?? null);
  const debugRoomVal = document.getElementById('debugRoomVal');
  if (debugRoomVal) debugRoomVal.textContent = roomName;
  statusEl.textContent = `✅ Connected — you'll hear nearby players automatically`;
  statusEl.className = 'ok';
  micBtn.disabled = false;
  micBtn.textContent = '🎤 Enable microphone';
  micBtn.className = 'muted';
  if (expiredMsgEl) expiredMsgEl.style.display = 'none';
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
    // In follow mode the OpenPlanet plugin is already publishing this
    // identity's position - sending ours too would fight with it.
    if (followGameCheckbox.checked) return;
    ingestWs.send(JSON.stringify({ type: 'position', pseudo: myIdentity, x: me.x, y: me.y, z: me.z }));
  }, SEND_INTERVAL_MS);
}

// The relay pushes this when the plugin sends a new nonce.
async function handleRoomPush(msg) {
  if (!msg.name) {
    // Player left the server — disconnect and show waiting state.
    await disconnectLiveKit();
    updateServerDisplay(null);
    statusEl.textContent = 'Not on a server — voice on standby';
    statusEl.className = '';
    micBtn.disabled = true;
    micBtn.className = 'idle';
    micEnabled = false;
    return;
  }
  // Server changed — swap to the new room using the provided nonce.
  if (!msg.nonce) return;
  const res = await fetch(`/token?t=${encodeURIComponent(msg.nonce)}`);
  if (!res.ok) return; // nonce expired or already consumed — ignore
  const { token, wsUrl, room: roomName, login, serverName } = await res.json();
  const wasMicEnabled = micEnabled;
  await disconnectLiveKit();
  try {
    await connectLiveKit({ token, wsUrl, roomName, login, serverName });
  } catch (err) {
    statusEl.textContent = `Connection error: ${err.message}`;
    statusEl.className = '';
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
  }
}

// Auto-join from a ?t=<nonce> URL (placed there by the in-game plugin).
async function connectViaNonce(nonce) {
  statusEl.textContent = 'Connecting...';
  if (expiredMsgEl) expiredMsgEl.style.display = 'none';

  const res = await fetch(`/token?t=${encodeURIComponent(nonce)}`);
  if (!res.ok) {
    statusEl.textContent = '';
    // Show a friendly message if the nonce expired (e.g. user opened an old link).
    if (res.status === 401 && expiredMsgEl) expiredMsgEl.style.display = '';
    else statusEl.textContent = `Token error: ${res.status}`;
    return;
  }
  const { token, wsUrl, room: roomName, login, serverName } = await res.json();
  myIdentity = login;
  try {
    await connectLiveKit({ token, wsUrl, roomName, login, serverName });
  } catch (err) {
    statusEl.textContent = `Connection error: ${err.message}`;
    statusEl.className = '';
    return;
  }
  startIngestWs(login);
}

// Legacy manual join (identity input + Join button).
async function join() {
  const identity = identityInput.value.trim();
  if (!identity) return;
  myIdentity = identity;
  joinBtn.disabled = true;
  identityInput.disabled = true;
  statusEl.textContent = 'Connecting...';

  const res = await fetch(`/token?identity=${encodeURIComponent(identity)}`);
  if (!res.ok) {
    statusEl.textContent = `token error: ${res.status}`;
    joinBtn.disabled = false;
    identityInput.disabled = false;
    return;
  }
  const { token, wsUrl, room: roomName } = await res.json();

  // Created inside this click handler so the browser's autoplay policy
  // treats it as user-initiated and doesn't leave it suspended.
  audioCtx = new AudioContext();
  logEvent(`AudioContext created, state=${audioCtx.state}`);
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().then(() => logEvent(`AudioContext.resume() -> ${audioCtx.state}`));
  }

  try {
    await connectLiveKit({ token, wsUrl, roomName, login: identity, serverName: null });
  } catch (err) {
    statusEl.textContent = `Connection error: ${err.message}`;
    statusEl.className = '';
    joinBtn.disabled = false;
    identityInput.disabled = false;
    return;
  }
  startIngestWs(identity);
}

joinBtn.addEventListener('click', join);

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
  startIngestWs, startPositionSend, handleRoomPush, connectViaNonce, join,
  renderPlayerList, renderPeerTable, draw,
  me, peers, gains, audioNodes, audioPublications, subscribedPeers, room,
  MIN_DIST, MAX_DIST, PAN_RANGE, PEER_GC_MS,
};
