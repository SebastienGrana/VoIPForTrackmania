// "Report a problem" — the tester's half of the feedback loop.
//
// During a test evening the useful report is not "it didn't work", it is "it
// didn't work AND here is what the tab thought was happening at that second".
// Nobody types the second part, so the panel collects it: the snapshot below
// is built from state the page already holds and is shown to the sender before
// it leaves, because a diagnostic quietly attached to a message is a thing you
// have to trust rather than read.
//
// Deliberately dependency-free and outside the voice path: this is the button
// people reach for when the rest is broken, so it must not need a LiveKit room,
// a microphone, or a working plugin to work.

const MAX_MESSAGE = 1000; // matches the relay's own clamp in /report

export function createReporter({ toggle, panel, text, send, cancel, msg, getSnapshot, onToast }) {
  if (!toggle || !panel || !text || !send) return { open() {} };

  let busy = false;

  function setMsg(html, cls) {
    if (!msg) return;
    msg.textContent = html;
    msg.className = `report-msg${cls ? ` ${cls}` : ''}`;
  }

  function open() {
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    setMsg('', '');
    // The snapshot is written into the panel at open time rather than at send
    // time so that what the sender reads is what the sender sends.
    const snap = getSnapshot();
    const detailsEl = panel.querySelector('#reportState');
    if (detailsEl) detailsEl.textContent = snap.state;
    text.focus();
  }

  function close() {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }

  toggle.addEventListener('click', () => (panel.hidden ? open() : close()));
  if (cancel) cancel.addEventListener('click', close);

  // Ctrl+Enter sends, Escape closes: the two things anyone typing in a
  // textarea tries without being told.
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
  });

  async function submit() {
    if (busy) return;
    const message = text.value.trim().slice(0, MAX_MESSAGE);
    if (!message) {
      setMsg('Write a line about what went wrong first.', 'bad');
      text.focus();
      return;
    }
    busy = true;
    send.disabled = true;
    setMsg('Sending…', '');

    const snap = getSnapshot();
    try {
      const res = await fetch('/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, login: snap.login, room: snap.room, state: snap.state }),
      });
      if (!res.ok) {
        // 429 is the one failure worth naming: it is not a bug, it is the
        // relay saying "you already sent five, we heard you".
        setMsg(res.status === 429
          ? 'Too many reports in the last minute — wait a bit, then send again.'
          : `The relay refused the report (HTTP ${res.status}). Tell us on Discord instead.`, 'bad');
        return;
      }
      text.value = '';
      close();
      if (onToast) onToast('Problem reported — thanks');
    } catch {
      // Offline, or the relay is the thing that broke. Either way the report
      // is lost, and saying so beats a spinner that never resolves.
      setMsg('Could not reach the relay — report it on Discord instead.', 'bad');
    } finally {
      busy = false;
      send.disabled = false;
    }
  }

  send.addEventListener('click', submit);

  return { open };
}
