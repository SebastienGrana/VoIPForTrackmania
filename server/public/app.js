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
// against "me" - so it must run first. X/Y map directly onto the fields the
// canvas plots (worldToScreen uses pos.x/pos.y) and the ones distance()/panning
// use, so dragging these sliders moves the dot exactly where you'd expect on
// screen - lets a second tab shadow another tracked player at a known offset
// instead of a mouse-dragged position in an unrelated coordinate space, so
// testing with 2 tabs doesn't need a 2nd TM account.
function applyRelativeMode() {
  if (!relativeModeCheckbox.checked) return;
  const target = peers.get(relativeTargetInput.value.trim());
  if (!target) return; // no position received yet for that login
  me.x = target.x + Number(relativeOffsetXSlider.value);
  me.y = target.y + Number(relativeOffsetYSlider.value);
  me.z = target.z;
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
// Debug-only: room this tab joined via the manual "Room à rejoindre" override,
// so our own position broadcasts land in the same room instead of the default
// one. Remove along with the rest of the debug scaffolding before publication.
let debugJoinedRoom = null;

const me = { x: canvas.width / 2, y: canvas.height / 2, z: 0 };
// pseudo -> { x, y, lastSeen }
const peers = new Map();
// pseudo -> { current, target } (gain, mirrored into the debug table)
const gains = new Map();
// pseudo -> { source, panner, gainNode, el } - the actual WebAudio graph per remote player
const audioNodes = new Map();

// Calibration sliders: each one writes its live value straight into the
// matching constant above, and remembers it in localStorage so a page reload
// mid-calibration doesn't lose the setting you were converging on.
function setupCalibration() {
  const controls = [
    { id: 'minDist', get: () => MIN_DIST, set: (v) => { MIN_DIST = v; } },
    { id: 'maxDist', get: () => MAX_DIST, set: (v) => { MAX_DIST = v; } },
    { id: 'panRange', get: () => PAN_RANGE, set: (v) => { PAN_RANGE = v; } },
  ];

  for (const { id, get, set } of controls) {
    const slider = document.getElementById(id);
    const label = document.getElementById(`${id}Val`);
    const saved = Number(localStorage.getItem(`onzvoip.${id}`));
    if (saved > 0) set(saved);

    const sync = () => { label.textContent = get(); };
    slider.value = get();
    sync();

    slider.addEventListener('input', () => {
      set(Number(slider.value));
      localStorage.setItem(`onzvoip.${id}`, slider.value);
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
function worldToScreen(pos, scale) {
  return {
    x: canvas.width / 2 + (pos.x - me.x) * scale,
    y: canvas.height / 2 + (pos.y - me.y) * scale,
  };
}

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
  ctx.fillText(myIdentity ? `${myIdentity} (toi)` : 'toi', cx + 12, cy + 4);

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

function tickGains() {
  applyRelativeMode();
  for (const [pseudo, pos] of peers) {
    const stale = Date.now() - pos.lastSeen > 3000;
    const target = stale ? 0 : gainForDistance(distance(me, pos), MIN_DIST, MAX_DIST);
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
  }
  renderPeerTable();
  renderPlayerList();
  requestAnimationFrame(tickGains);
}
requestAnimationFrame(tickGains);

function gainLabel(g) {
  if (g > 0.8) return 'Very close';
  if (g > 0.5) return 'Close';
  if (g > 0.15) return 'Nearby';
  if (g > 0.01) return 'Far away';
  return 'Out of range';
}

function renderPlayerList() {
  const list = document.getElementById('playerList');
  if (peers.size === 0) {
    list.innerHTML = '<li class="pl-empty">No other players in the room yet</li>';
    return;
  }
  list.innerHTML = '';
  for (const [pseudo] of peers) {
    const g = gains.get(pseudo)?.current ?? 0;
    const hasAudio = audioNodes.has(pseudo);
    const pct = Math.round(g * 100);
    const icon = !hasAudio ? '👤' : g > 0.5 ? '🔊' : g > 0.05 ? '🔉' : '🔈';
    const li = document.createElement('li');
    const iconEl = document.createElement('span'); iconEl.className = 'pl-icon'; iconEl.textContent = icon;
    const nameEl = document.createElement('span'); nameEl.className = 'pl-name'; nameEl.textContent = pseudo;
    const labelEl = document.createElement('span'); labelEl.className = 'pl-label'; labelEl.textContent = gainLabel(g);
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
  me.y += (y - lastMouse.y) / scale;
  lastMouse = { x, y };
});

function decodePosition(payload) {
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
}

// Étape 6: update the server name banner above the player list.
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
    const msg = decodePosition(payload);
    if (!msg) return;
    if (msg.pseudo === myIdentity) {
      // Our own position coming back from the game: in follow mode this is
      // where "me" comes from (the car), instead of the dragged canvas dot.
      if (followGameCheckbox.checked) {
        const x = Number(msg.x), y = Number(msg.y), z = Number(msg.z ?? 0);
        if (isFinite(x) && isFinite(y) && isFinite(z)
            && Math.abs(x) < 1e6 && Math.abs(y) < 1e6 && Math.abs(z) < 1e6) {
          me.x = x; me.y = y; me.z = z;
        }
      }
      return;
    }
    const px = Number(msg.x), py = Number(msg.y), pz = Number(msg.z ?? 0);
    if (!isFinite(px) || !isFinite(py) || !isFinite(pz)
        || Math.abs(px) >= 1e6 || Math.abs(py) >= 1e6 || Math.abs(pz) >= 1e6) return;
    const pseudo = typeof msg.pseudo === 'string' && msg.pseudo.length <= 64 ? msg.pseudo : null;
    if (!pseudo) return;
    peers.set(pseudo, { x: px, y: py, z: pz, lastSeen: Date.now() });
  });

  newRoom.on(LivekitClient.RoomEvent.ParticipantConnected, (p) => logEvent(`participant joined: ${p.identity}`));
  newRoom.on(LivekitClient.RoomEvent.ParticipantDisconnected, (p) => logEvent(`participant left: ${p.identity}`));

  // Routes each remote player's mic through its own WebAudio graph instead of
  // a plain <audio> element, so gain AND stereo pan can be driven per-peer
  // from tickGains() (a plain <audio> only gives a single overall volume via
  // setVolume() - no left/right). See context.txt ARCHITECTURE AUDIO.
  newRoom.on(LivekitClient.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    logEvent(`TrackSubscribed: ${participant.identity} (kind=${track.kind})`);
    if (track.kind !== LivekitClient.Track.Kind.Audio) return;

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
// serverName is the human-readable display name for Étape 6, or null for legacy joins.
async function connectLiveKit({ token, wsUrl, roomName, login, serverName }) {
  if (!audioCtx) {
    // Created here for auto-join (no click handler). May start suspended — the
    // mic button click will resume it (audioCtx.resume() in the mic handler).
    audioCtx = new AudioContext();
    logEvent(`AudioContext créé, state=${audioCtx.state}`);
  }

  const newRoom = new LivekitClient.Room();
  attachRoomEvents(newRoom);
  await newRoom.connect(wsUrl, token);
  await newRoom.localParticipant.setMicrophoneEnabled(false);

  room = newRoom;
  updateServerDisplay(serverName ?? null);
  const debugRoomVal = document.getElementById('debugRoomVal');
  if (debugRoomVal) debugRoomVal.textContent = roomName;
  statusEl.textContent = `✅ Connecté — tu entends les joueurs proches automatiquement`;
  statusEl.className = 'ok';
  micBtn.disabled = false;
  micBtn.textContent = '🎤 Activer le microphone';
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
    const msg = { type: 'position', pseudo: myIdentity, x: me.x, y: me.y, z: me.z };
    if (debugJoinedRoom) msg.room = debugJoinedRoom;
    ingestWs.send(JSON.stringify(msg));
  }, SEND_INTERVAL_MS);
}

// Étape 4/5: the relay pushes this when the plugin sends a new nonce.
async function handleRoomPush(msg) {
  if (!msg.name) {
    // Étape 5: player left the server — disconnect and show waiting state.
    await disconnectLiveKit();
    updateServerDisplay(null);
    statusEl.textContent = 'Plus sur un serveur — vocal en attente';
    statusEl.className = '';
    micBtn.disabled = true;
    micBtn.className = 'idle';
    micEnabled = false;
    return;
  }
  // Étape 4: server changed — swap to the new room using the provided nonce.
  if (!msg.nonce) return;
  const res = await fetch(`/token?t=${encodeURIComponent(msg.nonce)}`);
  if (!res.ok) return; // nonce expired or already consumed — ignore
  const { token, wsUrl, room: roomName, login, serverName } = await res.json();
  const wasMicEnabled = micEnabled;
  await disconnectLiveKit();
  await connectLiveKit({ token, wsUrl, roomName, login, serverName });
  // Restore mic state in the new room.
  if (wasMicEnabled && room) {
    await room.localParticipant.setMicrophoneEnabled(true, {
      autoGainControl: true,
      noiseSuppression: false,
      echoCancellation: false,
    });
    micEnabled = true;
    micBtn.textContent = '🔴 Couper le microphone';
    micBtn.className = 'live';
  }
}

// Auto-join from a ?t=<nonce> URL (placed there by the in-game plugin).
async function connectViaNonce(nonce) {
  statusEl.textContent = 'Connexion...';
  if (expiredMsgEl) expiredMsgEl.style.display = 'none';

  const res = await fetch(`/token?t=${encodeURIComponent(nonce)}`);
  if (!res.ok) {
    statusEl.textContent = '';
    // Show a friendly message if the nonce expired (e.g. user opened an old link).
    if (res.status === 401 && expiredMsgEl) expiredMsgEl.style.display = '';
    else statusEl.textContent = `Erreur token: ${res.status}`;
    return;
  }
  const { token, wsUrl, room: roomName, login, serverName } = await res.json();
  myIdentity = login;
  await connectLiveKit({ token, wsUrl, roomName, login, serverName });
  startIngestWs(login);
}

// Legacy manual join (identity input + Join button).
async function join() {
  const identity = identityInput.value.trim();
  if (!identity) return;
  myIdentity = identity;
  joinBtn.disabled = true;
  identityInput.disabled = true;
  statusEl.textContent = 'Connexion...';

  // Debug-only: joins the exact same room as a real player (copied from
  // their own Debug readout), so a second tab can test follow-mode against
  // them. Remove with the debug section before publication.
  const debugRoomEl = document.getElementById('debugRoom');
  const debugRoom = debugRoomEl ? debugRoomEl.value.trim() : '';
  debugJoinedRoom = debugRoom || null;
  const params = new URLSearchParams({ identity });
  if (debugRoom) params.set('room', debugRoom);

  const res = await fetch(`/token?${params.toString()}`);
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
  logEvent(`AudioContext créé, state=${audioCtx.state}`);
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().then(() => logEvent(`AudioContext.resume() -> ${audioCtx.state}`));
  }

  await connectLiveKit({ token, wsUrl, roomName, login: identity, serverName: null });
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
  micBtn.textContent = micEnabled ? '🔴 Couper le microphone' : '🎤 Activer le microphone';
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
