// Append-only event log.
//
// The relay used to print nothing but errors, which meant that after a test
// evening the only record of what happened was what the testers remembered.
// This writes one JSON object per line — greppable, and `jq` reads it without
// a parser — covering the handful of moments that explain a bad session:
// who connected, from which build, to which room, and when it dropped.
//
// Three properties matter more than features here:
//   - it must never take the relay down. Every write is wrapped; a full disk
//     or a bad path degrades to "no log", not "no voice chat".
//   - it must not become the thing that fills the disk. Lines are capped and
//     the file rotates once past a size limit, keeping one previous file.
//   - it must not quietly hoard personal data. Logins and room names are in
//     here by design (they are the whole point), positions are not — see the
//     privacy note in README.

import fs from 'node:fs';
import path from 'node:path';

const MAX_LINE = 4096;
const MAX_BYTES = 32 * 1024 * 1024; // rotate at 32 MB, keep one .1 behind

// Kept in memory alongside the file so the admin page can show a live feed
// without re-reading (and re-parsing, and re-permissioning) the log from disk
// every couple of seconds.
//
// Sized for an evening rather than for a glance: the admin page filters this
// window client-side, and a window of a few hundred lines covers minutes, not
// hours, on a busy night — which is exactly when someone asks what happened
// twenty minutes ago. It is only affordable because the page fetches the
// window once and then asks for new lines by sequence number (see `since`).
const RECENT_MAX = 1000;

export function createEventLog({ file, echo = true } = {}) {
  let stream = null;
  let written = 0;
  let broken = false;
  const recent = [];

  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      written = fs.existsSync(file) ? fs.statSync(file).size : 0;
      stream = fs.createWriteStream(file, { flags: 'a' });
      // Without this, an EACCES or ENOSPC on the stream is an unhandled 'error'
      // event, which in Node takes the whole process down — the exact opposite
      // of what a logging subsystem should do to a live voice relay.
      stream.on('error', (err) => {
        broken = true;
        console.error('event-log: write failed, logging to file disabled:', err.message);
      });
    } catch (err) {
      console.error('event-log: cannot open', file, '-', err.message);
      stream = null;
    }
  }

  function rotate() {
    if (!stream || broken) return;
    try {
      stream.end();
      fs.renameSync(file, `${file}.1`); // replaces any previous .1
      stream = fs.createWriteStream(file, { flags: 'a' });
      stream.on('error', (err) => {
        broken = true;
        console.error('event-log: write failed, logging to file disabled:', err.message);
      });
      written = 0;
    } catch (err) {
      broken = true;
      console.error('event-log: rotation failed, logging to file disabled:', err.message);
    }
  }

  // Monotonic, per-process, never reused. It is what lets a reader say "give me
  // what I have not seen" without comparing timestamps — two events inside the
  // same millisecond are common here, so `ts` cannot play that role.
  let seq = 0;

  // log('plugin.connect', { login, room, version })
  function log(event, fields = {}) {
    const entry = { ts: new Date().toISOString(), event, ...fields };
    let line;
    try {
      line = JSON.stringify(entry);
    } catch {
      return; // a circular or unserialisable field is not worth a throw
    }
    if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE - 20)}…","truncated":true}`;

    // The sequence number is attached to the in-memory copy only, never to the
    // written line: it is a cursor for one running process, and a number that
    // restarts at 1 on every boot would be a lie in a file that outlives them.
    recent.push({ ...entry, seq: ++seq });
    if (recent.length > RECENT_MAX) recent.shift();

    if (echo) console.log(line);
    if (!stream || broken) return;
    try {
      stream.write(`${line}\n`);
      written += line.length + 1;
      if (written >= MAX_BYTES) rotate();
    } catch (err) {
      broken = true;
      console.error('event-log: write threw, logging to file disabled:', err.message);
    }
  }

  // Newest last, matching how the file reads.
  function tail(n = 100) {
    return recent.slice(Math.max(0, recent.length - n));
  }

  // Everything newer than a cursor the caller already holds. Returns null when
  // the caller is too far behind for this to be an answer — the window has
  // scrolled past their cursor and handing back what is left would silently
  // lose the lines in between. The caller is expected to fall back to tail().
  //
  // `after` of 0 (or anything below the oldest line held) is that same case
  // once the window has filled, which is why a first load must use tail().
  function since(after) {
    if (!recent.length) return [];
    if (after >= seq) return [];
    if (after < recent[0].seq - 1) return null;
    return recent.filter((e) => e.seq > after);
  }

  return { log, tail, since, get seq() { return seq; },
    get file() { return stream && !broken ? file : null; } };
}

// Used wherever no log was passed in, so call sites never need a null check.
export const nullEventLog = { log() {}, tail() { return []; }, since() { return []; }, seq: 0, file: null };
