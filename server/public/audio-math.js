// Pure spatial-audio math — no DOM, no WebAudio, no globals.
// Lives under public/ (not src/) because the browser imports it directly
// via <script type="module"> — a previous copy inlined in app.js drifted
// out of sync with the tests, hence the extraction into its own module.

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Linear falloff: full volume within minDist, silent at or beyond maxDist.
// Kept alongside gainForDistanceRealistic() below so the two can be A/B'd in
// game - which curve sounds right is an ear judgement, not a code one.
export function gainForDistance(d, minDist, maxDist) {
  if (d <= minDist) return 1;
  if (d >= maxDist) return 0;
  return 1 - (d - minDist) / (maxDist - minDist);
}

// Stereo pan in [-1, 1] for a horizontal offset dx in game units.
export function panForOffset(dx, panRange) {
  return clamp(dx / panRange, -1, 1);
}

// Turns a world-space offset into "how far to my right" and "how far ahead of
// me", given where the car is pointing. Without this the pan is computed on the
// world X axis, so doing a U-turn leaves the player who was on your right still
// on your right - the one thing no amount of volume shaping can fix.
//
// The heading arrives as a vector straight from the game (AimDirection with its
// altitude component dropped), not as an angle, so there is nothing to agree on
// about where "yaw = 0" points or which way angles grow.
//
// What "right" means is fixed by the radar rather than by a handedness rule:
// the radar has always drawn world X across the screen and world Z down it, and
// on that picture the car's right is its forward turned a quarter turn
// clockwise, which in (x, z) is (-fz, fx). Deriving both the sound and the
// display from that one statement is what makes them agree - whatever the
// game's axes happen to be called.
export function toCarFrame(dx, dz, fx, fz) {
  const len = Math.hypot(fx, fz);
  // No heading (browser-only player, or the car is not spawned yet): stay in
  // world space, which is exactly what shipped before the car frame existed.
  if (!len || !isFinite(len)) return { right: dx, front: dz };
  const ux = fx / len, uz = fz / len;
  return { right: dz * ux - dx * uz, front: dx * ux + dz * uz };
}

// How many dB the realistic curve sheds between minDist and maxDist. 40 dB is
// the usual "present -> barely there" span; past ~60 the far half is inaudible
// long before the radar edge, below ~20 it barely differs from linear.
export const FALLOFF_DB = 40;

// Perceptual falloff, the alternative to the linear one above.
//
// Loudness is judged on a log scale, so a linear gain ramp sounds wrong in a
// specific way: the first half of the trip is near-silent change (halfway is
// still -6 dB, barely quieter) and then everything vanishes at the end. Here
// the *decibels* fall linearly with distance instead, so halfway out really
// sounds halfway out.
//
// Not the textbook inverse-square law, deliberately. That law is referenced at
// minDist, which defaults to 1 m - it would put a player 10 m away at 10% gain
// and make the whole radar useless. Games dodge this by pushing the reference
// distance out; we get the same perceptual shape from one honest knob instead.
export function gainForDistanceRealistic(d, minDist, maxDist, falloffDb = FALLOFF_DB) {
  if (d <= minDist) return 1;
  if (d >= maxDist) return 0;
  const t = (d - minDist) / (maxDist - minDist);
  const g = Math.pow(10, (-falloffDb * t) / 20);
  // Without this the curve stops at 10^(-falloffDb/20), not 0, and a player
  // parked at maxDist would stay faintly audible forever. Slide the whole
  // curve down so the far end lands exactly on silence.
  const floor = Math.pow(10, -falloffDb / 20);
  return (g - floor) / (1 - floor);
}

// Air absorption. High frequencies lose energy to the air far faster than low
// ones, which is most of what makes a sound read as "far away" rather than
// "quiet" - every game engine models it as a low-pass whose cutoff drops with
// distance. Returns that cutoff in Hz.
export const LOWPASS_NEAR_HZ = 20000; // above hearing: effectively no filtering
export const LOWPASS_FAR_HZ = 1200;   // muffled, but speech is still followable

export function lowpassForDistance(d, minDist, maxDist, nearHz = LOWPASS_NEAR_HZ, farHz = LOWPASS_FAR_HZ) {
  if (d <= minDist) return nearHz;
  if (d >= maxDist) return farHz;
  const t = (d - minDist) / (maxDist - minDist);
  // Geometric, not linear: pitch is logarithmic too. A linear sweep would burn
  // the first half of the distance falling through octaves nobody can hear.
  return nearHz * Math.pow(farHz / nearHz, t);
}

// ---------------------------------------------------------------------------
// Doppler.
//
// Web Audio used to do this for us; the W3C removed it, so it is rebuilt by
// hand. The trick is to never compute a pitch ratio at all: feed the voice
// through a delay line whose length is the sound's travel time, and the pitch
// shift falls out of the resampling for free, in the right direction, for both
// of you moving at once. Shortening delay = arriving sooner = higher.
//
// The catch is that Trackmania is not a physics demo. Two cars crossing at
// 300 km/h each give a real shift of nearly an octave at the moment they pass,
// which is unintelligible, so the effect is dosed: `scale` is the fraction of
// the true travel time that reaches the delay line, and since the pitch shift
// is the *rate of change* of that delay, a scale of 0.3 is 30 % of the physics.
export const SPEED_OF_SOUND = 343; // m/s, sea level, the one real constant here

// A delay line sitting at exactly zero has no samples to interpolate between,
// and a fast move away from it clicks. 10 ms of headroom, inaudible on voice.
export const DOPPLER_BASE_SEC = 0.01;

// The three settings offered side by side, because which one sounds right is an
// ear judgement. `maxRate` caps how fast the delay may move, which is the same
// thing as capping the pitch: a rate of r while approaching gives 1/(1 - r).
export const DOPPLER_PRESETS = {
  // ~1.3 semitones behind a car at 300 km/h, ~2.7 head-on, capped at ~3.
  subtle: { scale: 0.3, maxRate: 0.16 },
  // Twice the physics of `subtle`, hard to miss even at moderate speed, and
  // starting to sound like an effect rather than like a road.
  strong: { scale: 0.6, maxRate: 0.32 },
  // A third preset, `exact` (the real formula at scale 1.0), existed only for
  // the comparison that chose between these two. It won nothing - honest and
  // close to unusable at the moment of crossing - and comparing against it is
  // over, so it is gone rather than left behind as a setting nobody should pick.
};

// Long enough for the far edge of any calibration at full scale (1000 m of
// travel is 2.9 s) without allocating an absurd buffer per participant.
export const DOPPLER_MAX_DELAY_SEC = 3.5;

// Positions land five times a second, so the distance we are handed is a
// staircase, not a slide. Running at the target at full speed and then waiting
// for the next step gives a sprint-freeze-sprint five times a second, and since
// the pitch IS the speed of the delay, that is a pitch flicking on and off at
// 5 Hz - roughness, not a car going past. Easing toward the target over roughly
// one packet period turns the staircase back into the steady slide it stands
// for: at a constant speed the delay settles into a constant rate, which is a
// constant interval, which is what a real Doppler sounds like.
export const DOPPLER_GLIDE_SEC = 0.25;

// Next delay-line length, in seconds. `prevDelay` is what we asked for last
// tick (not what the node reports), so the rate cap is exact and testable;
// pass a non-finite value the first time to snap straight to the target rather
// than swooping in from zero, which would pitch a newcomer's first word.
export function dopplerDelayFor(dist, prevDelay, dtSec, preset = 'subtle') {
  const p = DOPPLER_PRESETS[preset] || DOPPLER_PRESETS.subtle;
  const d = Math.max(0, Number(dist) || 0);
  // Capped at the buffer we actually allocated: a peer two kilometres away is
  // silent anyway, and letting the target run past the node's maxDelayTime
  // would leave our bookkeeping believing a delay the node never applied.
  const target = Math.min(DOPPLER_MAX_DELAY_SEC, DOPPLER_BASE_SEC + (d / SPEED_OF_SOUND) * p.scale);
  if (!isFinite(prevDelay)) return target;
  const dt = Math.max(Number(dtSec) || 0, 0.001);
  // Two limits, in this order: close a fraction of the remaining gap (the glide,
  // which kills the staircase), then cap the absolute speed (the rate limit,
  // which is what keeps a teleporting peer from turning into a squeak).
  const eased = (target - prevDelay) * Math.min(1, dt / DOPPLER_GLIDE_SEC);
  const cap = p.maxRate * dt;
  return prevDelay + clamp(eased, -cap, cap);
}
