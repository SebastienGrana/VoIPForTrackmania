// 16-bar mic level meter. audioCtx and room are re-created across reconnects
// (see connectLiveKit()/rejoinVoice() in app.js), so they're read through
// getters rather than captured once — after a rejoin the meter must pick up
// the new ones, not keep talking to a disconnected room's dead track.

const MIC_METER_BARS = 16;

export function createMicMeter({ el, getAudioCtx, getRoom, getReduceMotion }) {
  const bars = [];
  if (el) {
    for (let i = 0; i < MIC_METER_BARS; i++) {
      const bar = document.createElement('div');
      bar.className = 'mic-bar';
      // Arc-shaped base height (short at the edges, tall in the middle) so an
      // idle meter reads as an EQ strip rather than a flat row of ticks.
      bar.style.height = `${Math.round(25 + 55 * Math.sin((i + 1) / (MIC_METER_BARS + 1) * Math.PI))}%`;
      bars.push(bar);
      el.appendChild(bar);
    }
  }

  let analyser = null;
  let analyserData = null;
  let raf = null;

  function findLocalAudioTrack() {
    const room = getRoom();
    if (!room || !room.localParticipant || !room.localParticipant.trackPublications) return null;
    for (const pub of room.localParticipant.trackPublications.values()) {
      if (pub.kind === LivekitClient.Track.Kind.Audio && pub.track) return pub.track.mediaStreamTrack;
    }
    return null;
  }

  function tick() {
    if (!analyser || getReduceMotion()) return; // reduced motion: meter stays visible but static
    analyser.getByteFrequencyData(analyserData);
    const avg = analyserData.reduce((a, b) => a + b, 0) / analyserData.length;
    // Same 1.6x headroom the old 5-bar meter used (8/5), scaled to bar count,
    // so an average speaking voice still lights most of the strip.
    const level = Math.min(MIC_METER_BARS, Math.round((avg / 255) * MIC_METER_BARS * 1.6));
    bars.forEach((bar, i) => { bar.className = 'mic-bar' + (i < level ? ' on' : ''); });
    raf = requestAnimationFrame(tick);
  }

  function start(track) {
    stop();
    const audioCtx = getAudioCtx();
    if (!track || !audioCtx || typeof audioCtx.createAnalyser !== 'function') return;
    try {
      const source = audioCtx.createMediaStreamSource(new MediaStream([track]));
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 32;
      source.connect(analyser);
      analyserData = new Uint8Array(analyser.frequencyBinCount);
      tick();
    } catch {}
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    analyser = null;
    for (const bar of bars) bar.className = 'mic-bar';
  }

  return { start, stop, findLocalAudioTrack };
}
