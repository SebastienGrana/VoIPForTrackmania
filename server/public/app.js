// OnZVoIP local prototype client.
// Owns: (1) a draggable canvas dot standing in for "my own position" (what the
// OpenPlanet plugin will eventually report), (2) rendering of other players'
// positions received over Livekit's data channel, and (3) the actual
// proximity-audio math: distance -> gain, applied locally per remote track.
// See ../../context.txt "ARCHITECTURE AUDIO" for why this lives client-side.

// Live-tunable from the calibration sliders (see index.html #calib) because
// these are in *game* units now that real positions come from the OpenPlanet
// plugin, and the right values can only be found by ear while driving.
// Defaults below are the old canvas-test values, i.e. NOT yet calibrated -
// once good values are found in game they should be pasted back here.
let MIN_DIST = 5;    // full volume within this radius
let MAX_DIST = 300;  // silence beyond this radius
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

// Pre-fill the identity from ?identity= so the in-game button (which opens
// the URL with the TM login already appended) saves the player a manual step.
const urlIdentity = new URLSearchParams(location.search).get('identity');
if (urlIdentity) identityInput.value = urlIdentity;

let room = null;
let ingestWs = null;
let myIdentity = null;
let dragging = false;
let audioCtx = null;

const me = { x: canvas.width / 2, y: canvas.height / 2, z: 0 };
// pseudo -> { x, y, lastSeen }
const peers = new Map();
// pseudo -> { current, target } (gain, mirrored into the debug table)
const gains = new Map();
// pseudo -> { source, panner, gainNode } - the actual WebAudio graph per remote player
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

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function gainForDistance(d) {
  if (d <= MIN_DIST) return 1;
  if (d >= MAX_DIST) return 0;
  return 1 - (d - MIN_DIST) / (MAX_DIST - MIN_DIST);
}

function panForOffset(dx) {
  return clamp(dx / PAN_RANGE, -1, 1);
}

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
    const target = gainForDistance(distance(me, pos));
    const g = gains.get(pseudo) ?? { current: target, target };
    g.target = target;
    g.current += (g.target - g.current) * LERP_FACTOR; // drives the canvas dot opacity / debug table only
    gains.set(pseudo, g);

    const nodes = audioNodes.get(pseudo);
    if (nodes && audioCtx) {
      const now = audioCtx.currentTime;
      nodes.gainNode.gain.setTargetAtTime(target, now, AUDIO_SMOOTHING_SEC);
      nodes.panner.pan.setTargetAtTime(panForOffset(pos.x - me.x), now, AUDIO_SMOOTHING_SEC);
    }
  }
  renderPeerTable();
  requestAnimationFrame(tickGains);
}
requestAnimationFrame(tickGains);

function renderPeerTable() {
  // Direct visibility into what "distance" is actually computed against - the
  // #1 way this silently breaks is "me" still sitting near the canvas-drag
  // default (~240,240,0) instead of real game coordinates, because "position
  // depuis le jeu" wasn't checked or the identity didn't match the plugin's
  // login, which makes every distance huge and every gain 0 with no error.
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
    const pan = panForOffset(pos.x - me.x);
    const hasAudio = audioNodes.has(pseudo);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${pseudo}</td><td>${d.toFixed(0)}</td><td>${g.toFixed(2)}</td><td>${pan.toFixed(2)}</td>`
      + `<td style="color:${hasAudio ? '#4c8' : '#a44'}">${hasAudio ? 'OK' : 'no track'}</td>`;
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

async function join() {
  const identity = identityInput.value.trim();
  if (!identity) return;
  myIdentity = identity;
  joinBtn.disabled = true;
  identityInput.disabled = true;
  statusEl.textContent = 'connexion...';

  const res = await fetch(`/token?identity=${encodeURIComponent(identity)}`);
  if (!res.ok) {
    statusEl.textContent = `token error: ${res.status}`;
    joinBtn.disabled = false;
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

  room = new LivekitClient.Room();
  room.on(LivekitClient.RoomEvent.DataReceived, (payload, participant, kind, topic) => {
    if (topic !== 'position') return;
    const msg = decodePosition(payload);
    if (!msg) return;
    if (msg.pseudo === myIdentity) {
      // Our own position coming back from the game: in follow mode this is
      // where "me" comes from (the car), instead of the dragged canvas dot.
      // Requires joining with the in-game login as identity so the position
      // stream and the Livekit participant line up.
      if (followGameCheckbox.checked) {
        me.x = msg.x;
        me.y = msg.y;
        me.z = msg.z || 0;
      }
      return;
    }
    peers.set(msg.pseudo, { x: msg.x, y: msg.y, z: msg.z || 0, lastSeen: Date.now() });
  });

  // Routes each remote player's mic through its own WebAudio graph instead of
  // a plain <audio> element, so gain AND stereo pan can be driven per-peer
  // from tickGains() (a plain <audio> only gives a single overall volume via
  // setVolume() - no left/right). See context.txt ARCHITECTURE AUDIO.
  room.on(LivekitClient.RoomEvent.ParticipantConnected, (p) => logEvent(`participant joined: ${p.identity}`));
  room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (p) => logEvent(`participant left: ${p.identity}`));
  room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
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
    el.style.display = 'none';
    document.body.appendChild(el);

    const stream = new MediaStream([track.mediaStreamTrack]);
    const source = audioCtx.createMediaStreamSource(stream);
    const panner = audioCtx.createStereoPanner();
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = 0;
    source.connect(panner).connect(gainNode).connect(audioCtx.destination);
    audioNodes.set(participant.identity, { source, panner, gainNode, el });
  });
  room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
    logEvent(`TrackUnsubscribed: ${participant.identity}`);
    track.detach().forEach((el) => el.remove());
    const nodes = audioNodes.get(participant.identity);
    if (!nodes) return;
    nodes.source.disconnect();
    nodes.panner.disconnect();
    nodes.gainNode.disconnect();
    audioNodes.delete(participant.identity);
  });

  await room.connect(wsUrl, token);
  await room.localParticipant.setMicrophoneEnabled(false);

  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ingestWs = new WebSocket(`${wsProto}//${location.host}/ingest`);
  ingestWs.addEventListener('open', () => {
    setInterval(() => {
      if (ingestWs.readyState !== WebSocket.OPEN) return;
      // In follow mode the OpenPlanet plugin is already publishing this
      // identity's position - sending ours too would fight with it.
      if (followGameCheckbox.checked) return;
      ingestWs.send(JSON.stringify({ type: 'position', pseudo: identity, x: me.x, y: me.y, z: me.z }));
    }, SEND_INTERVAL_MS);
  });

  statusEl.textContent = `connected to room "${roomName}"`;
  micBtn.disabled = false;
  micBtn.textContent = 'Enable mic';
  micBtn.classList.add('mute');
}

joinBtn.addEventListener('click', join);

let micEnabled = false;
micBtn.addEventListener('click', async () => {
  if (!room) return;
  micEnabled = !micEnabled;
  // noiseSuppression/echoCancellation off: confirmed culprit for a slow
  // (~1-2s) volume "breathing" baked into the captured signal itself (the
  // debug table's gain column stayed stable while it happened, ruling out
  // our distance math). autoGainControl left on - it wasn't the cause here.
  await room.localParticipant.setMicrophoneEnabled(micEnabled, {
    autoGainControl: true,
    noiseSuppression: false,
    echoCancellation: false,
  });
  micBtn.textContent = micEnabled ? 'Mute mic' : 'Enable mic';
  micBtn.classList.toggle('mute', !micEnabled);
});
