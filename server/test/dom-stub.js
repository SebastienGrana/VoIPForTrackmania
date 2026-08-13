// Minimal browser-globals stub so server/public/app.js (a straight browser
// script, not a DI-friendly module like relay.js) can be imported and driven
// headless under node:test. No jsdom dependency: app.js only ever touches a
// small, fixed surface of DOM/WebAudio/LiveKit/WebSocket APIs, so a hand-rolled
// fake for exactly that surface is far cheaper than a full DOM implementation.
//
// Usage (must run BEFORE `await import('../public/app.js')`, since the module
// executes its DOM lookups and event wiring at top level on import):
//   const stub = installDomStubs();
//   const app = await import('../public/app.js');

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this._listeners = {};
    this.value = '';
    this.checked = false;
    this.textContent = '';
    this.innerHTML = '';
    this.className = '';
    this.disabled = false;
    this.parentNode = null;
  }
  addEventListener(type, cb) { (this._listeners[type] ??= []).push(cb); }
  removeEventListener() {}
  dispatch(type, evt = {}) { for (const cb of (this._listeners[type] || []).slice()) cb(evt); }
  appendChild(child) { this._adopt(child); this.children.push(child); return child; }
  append(...nodes) { for (const n of nodes) this._adopt(n); this.children.push(...nodes); }
  prepend(node) { this._adopt(node); this.children.unshift(node); }
  _adopt(node) { if (node instanceof FakeElement) node.parentNode = this; }
  // Really detaches, instead of being a no-op: logEvent() trims its journal
  // with `while (childElementCount > 20) lastChild.remove()`, so a remove()
  // that removed nothing spun forever the moment the suite logged 21 lines.
  remove() {
    const parent = this.parentNode;
    if (!parent) return;
    const i = parent.children.indexOf(this);
    if (i !== -1) parent.children.splice(i, 1);
    this.parentNode = null;
  }
  // A real setter, not a plain field: app.js empties containers with
  // `el.innerHTML = ''` before rebuilding them, and a stub that kept the old
  // children around let a test read rows from a previous render.
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) {
    this._innerHTML = String(value);
    for (const child of this.children) child.parentNode = null;
    this.children.length = 0;
  }
  setAttribute(name, value) { (this._attrs ??= {})[name] = String(value); }
  getAttribute(name) { return this._attrs?.[name] ?? null; }
  get lastChild() { return this.children[this.children.length - 1]; }
  get childElementCount() { return this.children.length; }
  // What the user would actually read, own text plus descendants'. Needed since
  // elements built from a mix of appendChild and text nodes (the follow chips)
  // have an empty textContent of their own and say nothing without it.
  get renderedText() {
    return this.textContent + this.children.map((c) => c.renderedText ?? '').join('');
  }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
}

// Every drawing call is recorded, with its arguments. The radar's entire job is
// putting a blip in the right place, and a context of empty functions can only
// ever prove that draw() did not throw - not that it drew the right picture.
// Tests clear this array themselves before the draw they care about.
const canvasOps = [];
const record = (op) => (...args) => { canvasOps.push({ op, args }); };

const fakeCtx = {
  clearRect: record('clearRect'), beginPath: record('beginPath'), arc: record('arc'),
  stroke: record('stroke'), fill: record('fill'), fillText: record('fillText'),
  moveTo: record('moveTo'), lineTo: record('lineTo'), closePath: record('closePath'),
  save: record('save'), restore: record('restore'), roundRect: record('roundRect'),
  drawImage: record('drawImage'), strokeRect: record('strokeRect'),
  measureText: (text) => ({ width: text.length * 6 }),
  strokeStyle: '', fillStyle: '', font: '', lineWidth: 1, globalAlpha: 1,
  textAlign: 'start', textBaseline: 'alphabetic',
};

class FakeGainParam {
  constructor(v = 0) { this.value = v; }
  setTargetAtTime(v) { this.value = v; }
  // The doppler code schedules a ramp instead of setting a value, so the
  // double has to remember where the ramp was heading: the value at the end
  // of the ramp is what the next frame reads back as "the current delay".
  cancelScheduledValues() {}
  setValueAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v, t) { this.value = v; this.rampEndsAt = t; }
}
class FakeAudioNode { connect(n) { return n; } disconnect() {} }
class FakeGainNode extends FakeAudioNode { constructor() { super(); this.gain = new FakeGainParam(0); } }
class FakeStereoPannerNode extends FakeAudioNode { constructor() { super(); this.pan = new FakeGainParam(0); } }
class FakeBiquadFilterNode extends FakeAudioNode {
  constructor() { super(); this.type = ''; this.frequency = new FakeGainParam(0); }
}
class FakeDelayNode extends FakeAudioNode {
  constructor(max) { super(); this.maxDelayTime = max; this.delayTime = new FakeGainParam(0); }
}
class FakeAudioContext {
  constructor() { this.state = 'running'; this.currentTime = 0; this.destination = new FakeAudioNode(); }
  createMediaStreamSource() { return new FakeAudioNode(); }
  createStereoPanner() { return new FakeStereoPannerNode(); }
  createBiquadFilter() { return new FakeBiquadFilterNode(); }
  createDelay(max) { return new FakeDelayNode(max); }
  createGain() { return new FakeGainNode(); }
  async resume() { this.state = 'running'; }
}
class FakeMediaStream { constructor(tracks) { this.tracks = tracks; } }

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this._listeners = {};
    this.sentMessages = [];
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, cb) { (this._listeners[type] ??= []).push(cb); }
  send(data) { this.sentMessages.push(data); }
  close() { this.readyState = FakeWebSocket.CLOSED; this._emit('close'); }
  _emit(type, ...args) { for (const cb of (this._listeners[type] || []).slice()) cb(...args); }
}
FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1; FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
FakeWebSocket.instances = [];

// Test double for LivekitClient.Room: mirrors the handful of members
// attachRoomEvents()/connectLiveKit() actually use (on/connect/disconnect/
// remoteParticipants/localParticipant), plus an emit() helper for tests to
// fire the events app.js registered.
class FakeRoom {
  constructor() {
    this._listeners = {};
    this.remoteParticipants = new Map();
    this.localParticipant = { setMicrophoneEnabled: async () => {} };
    FakeRoom.instances.push(this);
  }
  on(event, cb) { (this._listeners[event] ??= []).push(cb); return this; }
  emit(event, ...args) { for (const cb of (this._listeners[event] || []).slice()) cb(...args); }
  async connect(wsUrl, token, opts) { this._connectArgs = { wsUrl, token, opts }; }
  // The real client fires Disconnected on an explicit disconnect() too, so the
  // fake does the same. Without it, a teardown wrongly treated as a dropped
  // connection would pass the tests and only show up in front of a player.
  async disconnect() { this.emit('disconnected'); }
}
FakeRoom.instances = [];

const RoomEvent = {
  DataReceived: 'dataReceived',
  ParticipantConnected: 'participantConnected',
  ParticipantDisconnected: 'participantDisconnected',
  TrackPublished: 'trackPublished',
  TrackUnpublished: 'trackUnpublished',
  TrackSubscribed: 'trackSubscribed',
  TrackUnsubscribed: 'trackUnsubscribed',
  ActiveSpeakersChanged: 'activeSpeakersChanged',
  // Connection-lifecycle events: the page has to stop claiming to be connected
  // when the room dies under it.
  Reconnecting: 'reconnecting',
  Reconnected: 'reconnected',
  Disconnected: 'disconnected',
};
const Track = { Kind: { Audio: 'audio', Video: 'video' } };

// A fake RemoteTrack, good enough for the TrackSubscribed/Unsubscribed
// handlers: attach()/detach() plus a settable .kind and .mediaStreamTrack.
class FakeTrack {
  constructor(kind = Track.Kind.Audio) { this.kind = kind; this.mediaStreamTrack = {}; this._attached = []; }
  attach() { const el = new FakeElement('audio'); this._attached.push(el); return el; }
  detach() { const attached = this._attached; this._attached = []; return attached; }
}

export function installDomStubs() {
  FakeWebSocket.instances.length = 0;
  FakeRoom.instances.length = 0;

  const elementsById = new Map();
  function el(id, tag = 'div') {
    const e = new FakeElement(tag);
    e.id = id;
    elementsById.set(id, e);
    return e;
  }

  const canvas = el('canvas', 'canvas');
  canvas.width = 400;
  canvas.height = 400;
  canvas.getContext = () => fakeCtx;

  el('onzRoot', 'div');
  const themeToggle = el('themeToggle', 'button'); themeToggle.setAttribute('aria-checked', 'true');
  el('joinSection', 'div');
  el('tagline', 'p');
  el('roomStats', 'span');
  el('peerCount', 'span');
  el('roomTime', 'span');
  el('toast', 'div');
  el('toastText', 'span');
  el('micMeter', 'div');
  el('reduceMotionToggle', 'input');
  el('highContrastToggle', 'input');
  const showEmojiToggle = el('showEmojiToggle', 'input'); showEmojiToggle.setAttribute('aria-checked', 'true');
  const realisticAudioToggle = el('realisticAudioToggle', 'input'); realisticAudioToggle.setAttribute('aria-checked', 'true');
  const rotateRadarToggle = el('rotateRadarToggle', 'input'); rotateRadarToggle.setAttribute('aria-checked', 'true');
  // The three doppler strengths behave as one radio group: all three start off,
  // which is the "no doppler" baseline.
  const dopplerSubtleToggle = el('dopplerSubtleToggle', 'input'); dopplerSubtleToggle.setAttribute('aria-checked', 'false');
  const dopplerStrongToggle = el('dopplerStrongToggle', 'input'); dopplerStrongToggle.setAttribute('aria-checked', 'false');
  const dopplerExactToggle = el('dopplerExactToggle', 'input'); dopplerExactToggle.setAttribute('aria-checked', 'false');

  el('identity', 'input');
  el('followGame', 'input');
  el('relativeMode', 'input');
  el('relativeTarget', 'input');
  el('relativeTargetChips', 'div');
  const relativeRange = el('relativeRange', 'input'); relativeRange.value = '10';
  el('relativeRangeVal', 'span');
  const relativeOffsetX = el('relativeOffsetX', 'input'); relativeOffsetX.value = '0';
  el('relativeOffsetXVal', 'span');
  const relativeOffsetY = el('relativeOffsetY', 'input'); relativeOffsetY.value = '0';
  el('relativeOffsetYVal', 'span');
  el('joinBtn', 'button');
  el('micBtn', 'button');
  el('leaveBtn', 'button');
  // Avatar picker (Advanced settings > My avatar).
  el('avatarPreview', 'span');
  el('avatarPreviewName', 'span');
  el('avatarToggle', 'button');
  el('avatarPicker', 'div');
  el('avatarSearch', 'input');
  el('avatarFlagGrid', 'div');
  el('avatarEmojiGrid', 'div');
  el('status', 'div');
  el('expiredMsg', 'div');
  el('serverName', 'div');
  el('meReadout', 'div');
  el('eventLog', 'div');
  el('playerList', 'ul');
  const optBody = el('optBody', 'div'); optBody.style.display = 'none';
  el('debugRoomVal', 'span');
  // Debug-only room picker (only rendered when the relay allows debug, but the
  // stub always provides it so the picker's own logic stays testable).
  el('debugRoom', 'input');
  el('debugRoomJoin', 'button');
  el('debugRoomMsg', 'div');
  // Shown to someone who opened the site without coming from the game; the
  // bootstrap in index.html hides the rest of the page behind it.
  el('noGameMsg', 'div');
  el('appBody', 'div');
  const maxDist = el('maxDist', 'input'); maxDist.value = '150';
  el('maxDistVal', 'span');
  el('calibMaxLabel', 'span');
  const minDist = el('minDist', 'input'); minDist.value = '1';
  el('minDistVal', 'span');
  el('calibMinLabel', 'span');
  const panRange = el('panRange', 'input'); panRange.value = '10';
  el('panRangeVal', 'span');
  el('calibReset', 'button');

  const peersTable = new FakeElement('table');
  const peersTbody = new FakeElement('tbody');
  peersTable.appendChild(peersTbody);

  const body = new FakeElement('body');
  const documentElement = new FakeElement('html');

  global.document = {
    getElementById: (id) => elementsById.get(id) ?? null,
    querySelector: (sel) => (sel === '#peers tbody' ? peersTbody : null),
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (data) => {
      const node = new FakeElement('#text');
      node.textContent = String(data);
      return node;
    },
    body,
    documentElement,
  };
  // A real listener registry, not a no-op pair: the radar's drag ends on
  // window's 'mouseup' (the mouse often leaves the canvas first), so a window
  // that swallowed its listeners left every simulated drag stuck down.
  const fakeWindow = new FakeElement('window');
  global.window = fakeWindow;

  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };

  global.location = { protocol: 'http:', host: 'localhost:8080', search: '' };

  global.AudioContext = FakeAudioContext;
  global.MediaStream = FakeMediaStream;
  global.WebSocket = FakeWebSocket;
  global.LivekitClient = { Room: FakeRoom, RoomEvent, Track };

  global.fetch = async () => { throw new Error('fetch not mocked for this test'); };

  // requestAnimationFrame/setInterval/setTimeout are captured, not scheduled,
  // so tests control exactly when app.js's timers fire instead of racing real
  // ones (and so node:test's process can exit instead of hanging on an
  // un-unref'd interval).
  let rafCallback = null;
  global.requestAnimationFrame = (cb) => { rafCallback = cb; return 1; };
  let intervalCallback = null;
  global.setInterval = (cb) => { intervalCallback = cb; return 1; };
  global.clearInterval = () => {};
  const pendingTimeouts = [];
  global.setTimeout = (cb) => { pendingTimeouts.push(cb); return pendingTimeouts.length; };
  global.clearTimeout = () => {};

  return {
    elements: {
      canvas, relativeRange, relativeOffsetX, relativeOffsetY, optBody, window: fakeWindow,
      realisticAudio: realisticAudioToggle,
      rotateRadar: rotateRadarToggle,
      dopplerSubtle: dopplerSubtleToggle,
      dopplerStrong: dopplerStrongToggle,
      dopplerExact: dopplerExactToggle,
      maxDist, minDist, panRange, peersTbody, body, documentElement,
      ...Object.fromEntries(elementsById),
    },
    fakeCtx,
    canvasOps,
    FakeTrack,
    runRaf: () => rafCallback?.(),
    runInterval: () => intervalCallback?.(),
    flushTimeouts: () => { const cbs = pendingTimeouts.splice(0); for (const cb of cbs) cb(); },
    lastWebSocket: () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1],
    lastRoom: () => FakeRoom.instances[FakeRoom.instances.length - 1],
    setFetch: (fn) => { global.fetch = fn; },
  };
}
