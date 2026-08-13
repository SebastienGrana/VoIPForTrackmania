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
