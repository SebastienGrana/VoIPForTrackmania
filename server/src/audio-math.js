// Pure spatial-audio math — no DOM, no WebAudio, no globals.
// Used by the browser client (inlined in public/app.js) and tested here.

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Linear falloff: full volume within minDist, silent at or beyond maxDist.
export function gainForDistance(d, minDist, maxDist) {
  if (d <= minDist) return 1;
  if (d >= maxDist) return 0;
  return 1 - (d - minDist) / (maxDist - minDist);
}

// Stereo pan in [-1, 1] for a horizontal offset dx in game units.
export function panForOffset(dx, panRange) {
  return clamp(dx / panRange, -1, 1);
}
