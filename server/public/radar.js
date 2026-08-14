// The canvas radar: sizing the bitmap to its CSS box, drawing the rings/sweep/
// blips/tooltip each frame, and hit-testing hover/tap against the dots it just
// drew. hoveredPseudo and lastDrawnPeers stay fully internal here rather than
// shared module-level state, because nothing outside draw() and the mouse
// handlers in app.js needs to see them - app.js talks to this module only
// through hitTestPeer()/setHovered()/clearHoveredIfNot().
import { distance } from './audio-math.js';

const MIN_EMOJI_PX = 11;
const MAX_EMOJI_PX = 18;

export function createRadar({
  canvas, ctx, onzRoot,
  getPeers, getGains, getMe, getMaxDist,
  getRotateRadar, getShowEmoji, getReduceMotion,
  offsetInEarFrame, headingForView, projectToRadar,
  avatarFor, flagImage, flagReady, emojiForPseudo,
  // Team colour for a dot, or null when the player is in no team - which is
  // every player until an organiser makes teams. Defaulted so a caller that
  // does not know about teams (tests, older embeds) still works.
  getTeamColor = () => null,
}) {
  function cssVar(name, fallback) {
    try {
      const v = getComputedStyle(onzRoot).getPropertyValue(name).trim();
      return v || fallback;
    } catch {
      return fallback;
    }
  }

  // Hover/tap-to-reveal state for radar dots, refreshed each draw() so the
  // canvas mousemove/click handlers in app.js can hit-test against where
  // things actually got drawn instead of duplicating the projection math.
  let hoveredPseudo = null;
  let lastDrawnPeers = []; // [{ pseudo, x, y, r }]

  function hitTestPeer(x, y) {
    for (const p of lastDrawnPeers) {
      if (Math.hypot(x - p.x, y - p.y) <= p.r) return p.pseudo;
    }
    return null;
  }

  // The canvas box is sized by CSS (a letterbox on mobile, near-square on
  // desktop — see the aspect-ratio rules in index.html). Match the bitmap to
  // that box so the radar is drawn at native resolution instead of being
  // stretched, and so draw() picks up the new proportions when the viewport
  // crosses the breakpoint.
  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    // Guard for the headless test stub, whose getBoundingClientRect has no
    // size: fall back to whatever the bitmap already is rather than writing NaN.
    const w = Math.round(rect.width) || canvas.width;
    const h = Math.round(rect.height) || canvas.height;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  }

  // Our own blip. An arrow whenever the game tells us which way the car
  // points, so "why do I hear him on my right" is answerable at a glance in
  // both modes: with the radar turned it always points up (the confirmation
  // that up *is* the bonnet), and with it pinned to the map it points
  // wherever we are driving. Falls back to the plain dot when there is no
  // heading - an arrow aimed at a direction we do not know would be a lie,
  // and a confident-looking one.
  function drawMeMarker(cx, cy, color) {
    const h = headingForView();
    ctx.fillStyle = color;
    if (!h) {
      ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
      return;
    }
    // Screen direction of the car: the same (x across, z down) mapping the
    // peers are plotted with, so the arrow and the dots cannot disagree.
    // Rotating the radar puts the car's forward straight up by construction.
    const rotateRadar = getRotateRadar();
    const len = Math.hypot(h.fx, h.fz);
    const ux = rotateRadar ? 0 : h.fx / len;
    const uy = rotateRadar ? -1 : h.fz / len;
    // Perpendicular on screen, for the two back corners.
    const px = -uy, py = ux;
    const NOSE = 8, TAIL = 5, HALF = 4.5;
    ctx.beginPath();
    ctx.moveTo(cx + ux * NOSE, cy + uy * NOSE);
    ctx.lineTo(cx - ux * TAIL + px * HALF, cy - uy * TAIL + py * HALF);
    ctx.lineTo(cx - ux * TAIL - px * HALF, cy - uy * TAIL - py * HALF);
    ctx.closePath();
    ctx.fill();
  }

  function draw() {
    resizeCanvas();

    // While the "Advanced settings" panel is still collapsed the canvas has no
    // laid-out size, so the ring radius below comes out negative and every
    // ctx.arc() throws IndexSizeError. That throw escapes the interval callback
    // and takes the peer table and the follow chips down with it, so bail out
    // quietly: at that size there is nothing to show anyway. Checked before
    // clearing, since a canvas with no area has nothing to clear either.
    // lastDrawnPeers is emptied so no stale blip stays clickable at
    // coordinates nothing was drawn at.
    if (!(Math.min(canvas.width, canvas.height) / 2 - 20 > 0)) {
      lastDrawnPeers = [];
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const me = getMe();
    const peers = getPeers();
    const gains = getGains();
    const reduceMotion = getReduceMotion();
    const showEmoji = getShowEmoji();
    const rotateRadar = getRotateRadar();

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const R = Math.min(canvas.width, canvas.height) / 2 - 20;
    // Chosen so MAX_DIST lands at ~70% of the radar radius (atan(2)*2/pi),
    // leaving room for farther peers to keep compressing toward the rim
    // instead of piling up exactly on the MAX_DIST ring.
    const k = 2 / Math.max(getMaxDist(), 1);

    const gridColor = cssVar('--onz-canvas-grid', '#2a2a2a');
    const accentColor = cssVar('--onz-accent', '#4aa8ff');
    const meColor = cssVar('--onz-accent', '#4aa8ff');
    const sweepColor = cssVar('--onz-sweep', 'rgba(74,168,255,0.18)');
    const tooltipBg = cssVar('--onz-tooltip-bg', '#000');
    const tooltipText = cssVar('--onz-tooltip-text', '#fff');

    // Fixed reference grid at 33/66/100% of the radar radius - purely visual
    // spacing, independent of MIN_DIST/MAX_DIST (those are shown via each
    // peer's projected distance, not a dedicated ring).
    ctx.strokeStyle = gridColor;
    for (const frac of [0.33, 0.66, 1]) {
      ctx.beginPath(); ctx.arc(cx, cy, R * frac, 0, Math.PI * 2); ctx.stroke();
    }

    // Animated sweep wedge, disabled under reduced motion.
    if (!reduceMotion) {
      const sweepAngle = (Date.now() / 3000) % 1 * Math.PI * 2;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, sweepAngle, sweepAngle + Math.PI / 6);
      ctx.closePath();
      ctx.fillStyle = sweepColor;
      ctx.fill();
      ctx.restore();
    }

    lastDrawnPeers = [];
    let activePeer = null; // hovered/tapped dot, drawn last so its tooltip sits on top
    for (const [pseudo, pos] of peers) {
      const gain = gains.get(pseudo)?.current ?? 0;
      // With rotation on, the radar is drawn in the car's frame: right of the
      // car goes right on screen, ahead of the car goes up - hence the minus,
      // screen Y growing downward. With it off, or with no heading to rotate
      // by, the world axes are plotted exactly as they always were.
      const off = offsetInEarFrame(pos);
      const turned = rotateRadar && headingForView();
      const proj = turned
        ? projectToRadar(off.right, -off.front, R, k)
        : projectToRadar(pos.x - me.x, pos.z - me.z, R, k);
      const px = cx + proj.x_display;
      const py = cy + proj.y_display;
      const size = Math.min(MAX_EMOJI_PX, Math.max(MIN_EMOJI_PX, 20 * proj.scale));
      const teamColor = getTeamColor(pseudo);

      if (pseudo === hoveredPseudo) {
        ctx.beginPath(); ctx.arc(px, py, size / 2 + 4, 0, Math.PI * 2);
        ctx.strokeStyle = accentColor; ctx.lineWidth = 1.5; ctx.stroke();
        activePeer = { pseudo, px, py, dist: distance(me, pos) };
      }

      if (showEmoji) {
        const av = avatarFor(pseudo);
        // Same fade-with-distance as the emoji had: how solid a blip looks is
        // how well you can hear that player, and a flag must not opt out of that.
        ctx.globalAlpha = 0.35 + 0.65 * gain;
        const img = av.kind === 'flag' ? flagImage(av.code) : null;
        if (flagReady(img)) {
          // 4:3, the aspect the SVGs are authored at - stretching them to a
          // square makes Germany and Belgium look like each other's cousins.
          const w = size, h = size * 0.75;
          ctx.drawImage(img, px - w / 2, py - h / 2, w, h);
          // Several flags are mostly white (Japan, Poland, Finland...), and
          // on a dark radar they read as a hole rather than a shape. A
          // hairline edge costs nothing and gives every flag the same silhouette.
          ctx.strokeStyle = 'rgba(0,0,0,0.45)';
          ctx.lineWidth = 1;
          ctx.strokeRect(px - w / 2 + 0.5, py - h / 2 + 0.5, w - 1, h - 1);
        } else {
          // Covers both "no flag chosen" and "the SVG has not decoded yet",
          // which is at most the first frame after a player appears. Drawing
          // the hashed emoji there beats leaving a gap where a car is.
          ctx.font = `${size}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(av.kind === 'emoji' ? av.value : emojiForPseudo(pseudo), px, py);
          ctx.textAlign = 'start';
          ctx.textBaseline = 'alphabetic';
        }
        ctx.globalAlpha = 1;
        // Ring rather than a tint: the flag or emoji still has to be readable,
        // and it is drawn at full opacity on purpose - which team someone is on
        // should stay legible at the far edge of the radar, where the avatar
        // itself has already faded out with the voice.
        if (teamColor) {
          ctx.beginPath(); ctx.arc(px, py, size / 2 + 2, 0, Math.PI * 2);
          ctx.strokeStyle = teamColor; ctx.lineWidth = 2; ctx.stroke();
        }
      } else {
        // Same fade as before, written with globalAlpha so the team colour can
        // be dropped in as-is instead of parsing a hex into rgba() components.
        ctx.globalAlpha = 0.25 + 0.75 * gain;
        ctx.fillStyle = teamColor || 'rgb(220,60,60)';
        ctx.beginPath(); ctx.arc(px, py, size / 2, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }

      lastDrawnPeers.push({ pseudo, x: px, y: py, r: size / 2 + 8 });
    }

    if (activePeer) {
      const label = `${activePeer.pseudo} · ${Math.round(activePeer.dist)} m`;
      ctx.font = '11px sans-serif';
      const w = ctx.measureText(label).width + 14;
      let tx = activePeer.px + 10, ty = activePeer.py - 22;
      if (tx + w > canvas.width) tx = activePeer.px - w - 10;
      if (ty < 0) ty = activePeer.py + 14;
      ctx.fillStyle = tooltipBg;
      ctx.beginPath(); ctx.roundRect(tx, ty, w, 20, 5); ctx.fill();
      ctx.fillStyle = tooltipText;
      ctx.fillText(label, tx + 7, ty + 14);
    }

    drawMeMarker(cx, cy, meColor);
  }

  return {
    draw,
    resizeCanvas,
    hitTestPeer,
    getHovered: () => hoveredPseudo,
    setHovered: (pseudo) => { hoveredPseudo = pseudo; },
  };
}
