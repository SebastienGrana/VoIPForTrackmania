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
const RECENT_MAX = 300;

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

    recent.push(entry);
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

  return { log, tail, get file() { return stream && !broken ? file : null; } };
}

// Used wherever no log was passed in, so call sites never need a null check.
export const nullEventLog = { log() {}, tail() { return []; }, file: null };
