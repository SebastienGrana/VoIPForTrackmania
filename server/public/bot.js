// OnZVoIP calibration bot: a fake player that shadows a real in-game player at
// a chosen distance and publishes a test sound, so distance/volume settings can
// be tuned by ear solo (you can't judge falloff with only your own voice).
//
// Lives in the browser rather than in tools/simulate-positions.js because
// publishing an audio track into Livekit from Node needs a native SDK
// (@livekit/rtc-node) and hand-built audio frames; in a browser it's a few
// lines of WebAudio. The Node simulator is still the headless
// positions-only path.

const BOT_IDENTITY = 'CalibBot';
const SEND_INTERVAL_MS = 200;

const targetInput = document.getElementById('target');
const rangeSlider = document.getElementById('range');
const rangeVal = document.getElementById('rangeVal');
const offsetXSlider = document.getElementById('offsetX');
const offsetXVal = document.getElementById('offsetXVal');
const offsetYSlider = document.getElementById('offsetY');
const offsetYVal = document.getElementById('offsetYVal');
const startBtn = document.getElementById('startBtn');
const statusEl = document.getElementById('status');
const readoutEl = document.getElementById('readout');
const diagEl = document.getElementById('diag');
const monitorCheckbox = document.getElementById('monitor');

let targetPos = null; // last known position of the player we're shadowing
let monitorGain = null; // wired to speakers only when the checkbox is on
let analyser = null; // taps the signal regardless of monitor/publish state

function updateRange() {
  const range = Number(rangeSlider.value);
  rangeVal.textContent = range;
  for (const slider of [offsetXSlider, offsetYSlider]) {
    slider.min = -range;
    slider.max = range;
    if (Number(slider.value) > range) slider.value = range;
    if (Number(slider.value) < -range) slider.value = -range;
  }
  offsetXVal.textContent = offsetXSlider.value;
  offsetYVal.textContent = offsetYSlider.value;
}
rangeSlider.addEventListener('input', updateRange);
offsetXSlider.addEventListener('input', () => { offsetXVal.textContent = offsetXSlider.value; });
offsetYSlider.addEventListener('input', () => { offsetYVal.textContent = offsetYSlider.value; });
updateRange();

// A steady sine would be the easy thing to generate, but it's the wrong test
// signal: a narrowband tone stays audible far past where speech becomes
// unintelligible, so thresholds tuned against it wouldn't transfer to voice.
// This approximates voice instead - noise limited to the telephone band,
// amplitude-pulsed at a syllable-like rate.
function createVoiceLikeSource(audioCtx) {
  const bufferSize = audioCtx.sampleRate * 2;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  const noise = audioCtx.createBufferSource();
  noise.buffer = buffer;
  noise.loop = true;

  const bandpass = audioCtx.createBiquadFilter();
  bandpass.type = 'bandpass';
  bandpass.frequency.value = 1000; // centre of the 300-3400 Hz speech band
  bandpass.Q.value = 0.7;

  // Syllable-rate amplitude modulation, ~4 Hz.
  const syllableGain = audioCtx.createGain();
  syllableGain.gain.value = 0.5;
  const lfo = audioCtx.createOscillator();
  lfo.frequency.value = 4;
  const lfoDepth = audioCtx.createGain();
  lfoDepth.gain.value = 0.5;
  lfo.connect(lfoDepth).connect(syllableGain.gain);

  // Tapped off regardless of monitor/publish state, so the level meter proves
  // the source itself is live even if publishing or routing is what's broken.
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;

  // Only connected to speakers when the "Monitor locally" checkbox is on - this
  // path never touches Livekit, so hearing it here isolates the WebAudio
  // graph from anything network/publish related.
  monitorGain = audioCtx.createGain();
  monitorGain.gain.value = monitorCheckbox.checked ? 1 : 0;

  const dest = audioCtx.createMediaStreamDestination();
  syllableGain.connect(analyser);
  noise.connect(bandpass).connect(syllableGain).connect(dest);
  syllableGain.connect(monitorGain).connect(audioCtx.destination);

  monitorCheckbox.addEventListener('change', () => {
    monitorGain.gain.value = monitorCheckbox.checked ? 1 : 0;
  });

  const levels = new Uint8Array(analyser.fftSize);
  setInterval(() => {
    analyser.getByteTimeDomainData(levels);
    let sumSquares = 0;
    for (const v of levels) { const centred = (v - 128) / 128; sumSquares += centred * centred; }
    const rms = Math.sqrt(sumSquares / levels.length);
    diagEl.textContent = `generated audio level (RMS): ${rms.toFixed(3)}`
      + (rms < 0.01 ? ' — near silence, WebAudio graph produces nothing' : ' — bot is generating sound');
  }, 300);

  noise.start();
  lfo.start();
  return dest.stream.getAudioTracks()[0];
}

function currentOffset() {
  return { x: Number(offsetXSlider.value), y: Number(offsetYSlider.value), z: 0 };
}

async function start() {
  const target = targetInput.value.trim();
  if (!target) {
    statusEl.textContent = 'enter the login of the player to follow';
    return;
  }
  startBtn.disabled = true;
  targetInput.disabled = true;
  statusEl.textContent = 'connecting...';

  const res = await fetch(`/token?identity=${encodeURIComponent(BOT_IDENTITY)}`);
  if (!res.ok) {
    statusEl.textContent = `token error: ${res.status}`;
    startBtn.disabled = false;
    return;
  }
  const { token, wsUrl, room: roomName } = await res.json();

  const audioCtx = new AudioContext();
  const room = new LivekitClient.Room();

  room.on(LivekitClient.RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
    if (topic !== 'position') return;
    let positions;
    try {
      positions = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }
    // Audit #27: the relay now broadcasts an array of positions per tick.
    if (!Array.isArray(positions)) return;
    for (const msg of positions) {
      if (msg.pseudo === target) targetPos = { x: msg.x, y: msg.y, z: msg.z || 0 };
    }
  });

  await room.connect(wsUrl, token);
  try {
    const publication = await room.localParticipant.publishTrack(createVoiceLikeSource(audioCtx), {
      source: LivekitClient.Track.Source.Microphone,
    });
    diagEl.textContent += ` | publishTrack OK (sid=${publication.trackSid}, muted=${publication.isMuted})`;
  } catch (err) {
    statusEl.textContent = `publishTrack failed: ${err.message}`;
    console.error('OnZVoIP bot: publishTrack failed', err);
    return;
  }

  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ingestWs = new WebSocket(`${wsProto}//${location.host}/ingest`);
  ingestWs.addEventListener('open', () => {
    statusEl.textContent = `bot active in room "${roomName}", following "${target}"`;
    setInterval(() => {
      if (ingestWs.readyState !== WebSocket.OPEN) return;
      if (targetPos === null) {
        readoutEl.textContent = `waiting for a position from "${target}" (are you in a race?)`;
        return;
      }
      const offset = currentOffset();
      const pos = {
        x: targetPos.x + offset.x,
        y: targetPos.y + offset.y,
        z: targetPos.z + offset.z,
      };
      ingestWs.send(JSON.stringify({ type: 'position', pseudo: BOT_IDENTITY, ...pos }));
      readoutEl.textContent =
        `target: ${targetPos.x.toFixed(0)}, ${targetPos.y.toFixed(0)}, ${targetPos.z.toFixed(0)}`
        + ` | bot: ${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)}`
        + ` | offset: X ${offset.x} / Y ${offset.y} m`;
    }, SEND_INTERVAL_MS);
  });
}

startBtn.addEventListener('click', start);
