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
  }
  addEventListener(type, cb) { (this._listeners[type] ??= []).push(cb); }
  removeEventListener() {}
  dispatch(type, evt = {}) { for (const cb of (this._listeners[type] || []).slice()) cb(evt); }
  appendChild(child) { this.children.push(child); return child; }
  append(...nodes) { this.children.push(...nodes); }
  prepend(node) { this.children.unshift(node); }
  remove() {}
  get lastChild() { return this.children[this.children.length - 1]; }
  get childElementCount() { return this.children.length; }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
}

const fakeCtx = {
  clearRect() {}, beginPath() {}, arc() {}, stroke() {}, fill() {}, fillText() {},
  strokeStyle: '', fillStyle: '', font: '',
};

class FakeGainParam {
  constructor(v = 0) { this.value = v; }
  setTargetAtTime(v) { this.value = v; }
}
class FakeAudioNode { connect(n) { return n; } disconnect() {} }
class FakeGainNode extends FakeAudioNode { constructor() { super(); this.gain = new FakeGainParam(0); } }
class FakeStereoPannerNode extends FakeAudioNode { constructor() { super(); this.pan = new FakeGainParam(0); } }
class FakeAudioContext {
  constructor() { this.state = 'running'; this.currentTime = 0; this.destination = new FakeAudioNode(); }
  createMediaStreamSource() { return new FakeAudioNode(); }
  createStereoPanner() { return new FakeStereoPannerNode(); }
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
  async disconnect() {}
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

  el('identity', 'input');
  el('followGame', 'input');
  el('relativeMode', 'input');
  el('relativeTarget', 'input');
  const relativeRange = el('relativeRange', 'input'); relativeRange.value = '10';
  el('relativeRangeVal', 'span');
  const relativeOffsetX = el('relativeOffsetX', 'input'); relativeOffsetX.value = '0';
  el('relativeOffsetXVal', 'span');
  const relativeOffsetY = el('relativeOffsetY', 'input'); relativeOffsetY.value = '0';
  el('relativeOffsetYVal', 'span');
  el('joinBtn', 'button');
  el('micBtn', 'button');
  el('status', 'div');
  el('expiredMsg', 'div');
  el('serverName', 'div');
  el('meReadout', 'div');
  el('eventLog', 'div');
  el('playerList', 'ul');
  const optBody = el('optBody', 'div'); optBody.style.display = 'none';
  el('debugRoomVal', 'span');
  const maxDist = el('maxDist', 'input'); maxDist.value = '150';
  el('maxDistVal', 'span');
  const minDist = el('minDist', 'input'); minDist.value = '1';
  el('minDistVal', 'span');
  const panRange = el('panRange', 'input'); panRange.value = '10';
  el('panRangeVal', 'span');

  const peersTable = new FakeElement('table');
  const peersTbody = new FakeElement('tbody');
  peersTable.appendChild(peersTbody);

  const body = new FakeElement('body');

  global.document = {
    getElementById: (id) => elementsById.get(id) ?? null,
    querySelector: (sel) => (sel === '#peers tbody' ? peersTbody : null),
    createElement: (tag) => new FakeElement(tag),
    body,
  };
  global.window = { addEventListener() {}, removeEventListener() {} };

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
      canvas, relativeRange, relativeOffsetX, relativeOffsetY, optBody,
      maxDist, minDist, panRange, peersTbody, body,
      ...Object.fromEntries(elementsById),
    },
    fakeCtx,
    FakeTrack,
    runRaf: () => rafCallback?.(),
    runInterval: () => intervalCallback?.(),
    flushTimeouts: () => { const cbs = pendingTimeouts.splice(0); for (const cb of cbs) cb(); },
    lastWebSocket: () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1],
    lastRoom: () => FakeRoom.instances[FakeRoom.instances.length - 1],
    setFetch: (fn) => { global.fetch = fn; },
  };
}
