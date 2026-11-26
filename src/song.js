// SPDX-License-Identifier: GPL-3.0-only
// Tracker songs: cells, patterns and the order list; compiling them to a
// SONG chunk and an .rsng file; reading a song back (exactly from xTRK, or
// best effort); the extra commands a cell carries.

import { ARG_BYTES, CH, FX_KINDS, INSTRUMENT_SIZE, INST_FIELDS, NO_LOOP, OP_FIELDS, SONG_DATA_VERSION, SONG_MAGIC, SONG_VERSION, defaultInstruments, readContainer, td, te, writeContainer } from './format.js';
import { readWaves, writeWaves } from './waves.js';

// ---------------------------------------------------------------- tracker songs

// A cell: note (MIDI) or off, instrument, volume, one effect, and the
// commands that have no column (kept from imported songs): `raw` before
// the note, `post` after it, each in their original order.
export function emptyCell() { return { note: null, off: false, inst: null, vol: null, fx: null, param: 0, raw: [], post: [] }; }
export const cellEmpty = (c) => !c || (c.note === null && !c.off && c.inst === null && c.vol === null && c.fx === null &&
                                 !c.raw.length && !(c.post && c.post.length));

export function newPattern(rows, channels) {
  return { name: '', rows, cells: Array.from({ length: channels }, () => Array.from({ length: rows }, () => null)) };
}

export function newSong(channels = 4) {
  return { name: 'New song', auth: '', licn: '', desc: '', date: '', bpm: 125, tpb: 24, ticksPerRow: 6,
    rowsPerBeat: 4, channels, voices: Array.from({ length: 16 }, (_, i) => (i < channels ? i : 0)),
    instruments: defaultInstruments(), waves: [], patterns: [newPattern(64, channels)], order: [0], loop: 0,
    notes: [] };
}

export function setChannels(song, n) {
  n = Math.max(1, Math.min(16, n | 0));
  for (const p of song.patterns) {
    while (p.cells.length < n) p.cells.push(Array.from({ length: p.rows }, () => null));
    p.cells.length = n;
  }
  for (let i = song.channels; i < n; i++) song.voices[i] = i;
  song.channels = n;
}

export function setRows(pattern, rows) {
  rows = Math.max(1, Math.min(256, rows | 0));
  for (const col of pattern.cells) {
    while (col.length < rows) col.push(null);
    col.length = rows;
  }
  pattern.rows = rows;
}

// ---------------------------------------------------------------- compiling

export function waitBytes(n) {
  const out = [];
  while (n > 0) {
    if (n <= 127) { out.push(0x80 | n); break; }
    const k = Math.min(n, 0xFFFF);
    out.push(CH.WAIT16, k & 0xFF, k >> 8);
    n -= k;
  }
  return out;
}

export const u16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
export const s16 = (v) => u16(v < 0 ? v + 0x10000 : v);

export function fxKind(c) { return c && c.fx !== null && c.fx !== undefined ? FX_KINDS[c.fx] || null : null; }

export function stopBytes(kind) {
  return kind === 'arp' ? [CH.ARPEGGIO, 0] : kind === 'slide' ? [CH.PITCH_SLIDE, 0, 0]
    : kind === 'vib' ? [CH.VIBRATO, 0, 0, 0] : [CH.VOLUME_SLIDE, 0];
}

// One cell's commands, in the order the player needs: instrument and volume,
// the kept commands, the note (which resets bend, slide and arpeggio phase),
// then the effect.
export function cellBytes(c) {
  const out = [];
  if (c.inst !== null) out.push(CH.INSTRUMENT, c.inst & 0xFF);
  if (c.vol !== null) out.push(CH.VOLUME, c.vol & 0xFF);
  for (const r of c.raw) out.push(...r);
  const p = c.param & 0xFF;
  if (c.fx === 3 && c.note !== null) out.push(CH.SLIDE_TO, c.note, ...u16(Math.max(1, p) * 16));
  else if (c.note !== null) out.push(CH.NOTE, c.note);
  else if (c.off) out.push(CH.OFF);
  for (const r of c.post || []) out.push(...r);
  switch (c.fx) {
    case 0: out.push(CH.ARPEGGIO, 3, 1, 0, p >> 4, p & 15); break;
    case 1: out.push(CH.PITCH_SLIDE, ...s16(p * 16)); break;
    case 2: out.push(CH.PITCH_SLIDE, ...s16(-p * 16)); break;
    case 4: out.push(CH.VIBRATO, (p >> 4) * 8, (p & 15) * 10, 0); break;
    case 10: out.push(CH.VOLUME_SLIDE, (p >> 4 ? p >> 4 : -(p & 15)) & 0xFF); break;
    case 15: if (p) out.push(CH.TEMPO, ...u16(p)); break;
    default: break;
  }
  return out;
}

// One channel of a pattern as a phrase, or from row `from` on (a play
// that starts in the middle of it): an effect of the row before is then
// running already, so the rows from there stop it as they would.
export function phraseBytes(song, pattern, ch, from = 0) {
  const out = [], col = pattern.cells[ch] || [];
  let wait = 0;
  const active = new Set();
  if (from > 0 && fxKind(col[from - 1])) active.add(fxKind(col[from - 1]));
  for (let r = from; r < pattern.rows; r++) {
    const c = col[r], kind = fxKind(c), cmds = [];
    for (const k of [...active]) if (k !== kind) { cmds.push(...stopBytes(k)); active.delete(k); }
    if (!cellEmpty(c)) cmds.push(...cellBytes(c));
    if (kind) active.add(kind);
    if (cmds.length) { out.push(...waitBytes(wait), ...cmds); wait = 0; }
    wait += song.ticksPerRow;
  }
  out.push(...waitBytes(wait));
  for (const k of active) out.push(...stopBytes(k));
  out.push(CH.RETURN);
  return out;
}

// The order positions a play runs through, and where its loop starts in
// them: the whole song (from 0), the song from an order position on (the
// loop, when it lies before that position, follows the run to the end), or
// one position on repeat.
export function playOrder(song, from = 0, only = false) {
  const end = song.order.length, loop = song.loop >= 0 && song.loop < end ? song.loop : -1;
  const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
  if (only) return { seq: [from], loopAt: 0 };
  if (loop < 0) return { seq: range(from, end), loopAt: -1 };
  if (loop >= from) return { seq: range(from, end), loopAt: loop - from };
  return { seq: range(from, end).concat(range(loop, end)), loopAt: end - from };
}

// The SONG chunk, and the song's length and loop point in ticks. `play`
// ({ from, only, entry, row, rowEntry }) compiles a play from an order
// position instead: each channel's stream starts with `entry[ch]`, the
// commands that set up what the rows before had in force there (chase),
// and with `only` plays that one position on repeat, the entry commands
// again at each turn. With `row`, the play starts at that row of the
// position: `rowEntry[ch]` sets up the state there, the rest of the
// pattern plays, and the song (or the repeat) goes on from there.
export function compileSong(song, play = {}) {
  const n = song.channels, from = play.from || 0, row = play.row || 0;
  const { seq, loopAt } = row && !play.only ? playOrder(song, from + 1) : playOrder(song, from, !!play.only);
  const head = 28 + 4 * n;
  const phrases = new Map(), phraseList = [];
  let at = head;
  const calls = Array.from({ length: n }, () => []);
  const first = row ? Array.from({ length: n }, (_, ch) => {
    const bytes = phraseBytes(song, song.patterns[song.order[from]], ch, row);
    phraseList.push(bytes); at += bytes.length;
    return at - bytes.length;
  }) : null;
  for (const oi of seq) {
    const p = song.patterns[song.order[oi]];
    for (let ch = 0; ch < n; ch++) {
      const bytes = phraseBytes(song, p, ch), key = bytes.join(',');
      if (!phrases.has(key)) { phrases.set(key, at); phraseList.push(bytes); at += bytes.length; }
      calls[ch].push(phrases.get(key));
    }
  }
  const call = (s, o) => {
    if (o <= 0xFFFF) s.push(CH.CALL16, ...u16(o));
    else s.push(CH.CALL, o & 0xFF, (o >> 8) & 0xFF, (o >> 16) & 0xFF, o >>> 24);
  };
  const streams = calls.map((offs, ch) => {
    const s = [CH.LENGTH, 0, 0], entry = play.entry ? play.entry[ch] : [];
    if (first) { s.push(...play.rowEntry[ch]); call(s, first[ch]); }
    else if (!play.only) s.push(...entry);
    offs.forEach((o, k) => {
      if (k === loopAt) s.push(CH.LOOP, 0);
      if (play.only) s.push(...entry);
      call(s, o);
    });
    if (loopAt >= 0) s.push(CH.LOOP_END);
    s.push(CH.END);
    return s;
  });
  const chanAt = [];
  for (const s of streams) { chanAt.push(at); at += s.length; }
  const out = new Uint8Array(at + (-at & 3)), dv = new DataView(out.buffer);
  dv.setUint32(0, SONG_MAGIC, true);
  dv.setUint16(4, SONG_VERSION, true);
  dv.setUint16(6, Math.max(1, Math.min(65535, song.bpm | 0)), true);
  out[8] = Math.max(1, Math.min(255, song.tpb | 0));
  out[9] = n;
  for (let i = 0; i < 16; i++) out[12 + i] = song.voices[i] & 15;
  chanAt.forEach((o, i) => dv.setUint32(28 + 4 * i, o, true));
  let w = head;
  for (const p of phraseList) { out.set(p, w); w += p.length; }
  for (const s of streams) { out.set(s, w); w += s.length; }
  let ticks = row ? (song.patterns[song.order[from]].rows - row) * song.ticksPerRow : 0, loopTick = -1;
  seq.forEach((oi, k) => { if (k === loopAt) loopTick = ticks; ticks += song.patterns[song.order[oi]].rows * song.ticksPerRow; });
  return { song: out, ticks, loopTick, seq, loopAt };
}

// Milliseconds at tick t of a run through the order positions seq,
// following Fxx tempo changes on the way.
export function tickMs(song, t, seq = song.order.map((_, i) => i)) {
  const tempos = [];
  let row0 = 0;
  for (const oi of seq) {
    const p = song.patterns[song.order[oi]];
    for (let r = 0; r < p.rows; r++)
      for (const col of p.cells) { const c = col[r]; if (c && c.fx === 15 && c.param) tempos.push([(row0 + r) * song.ticksPerRow, c.param]); }
    row0 += p.rows;
  }
  tempos.sort((a, b) => a[0] - b[0]);
  let ms = 0, at = 0, bpm = song.bpm;
  for (const [tk, b] of tempos) { if (tk >= t) break; ms += (tk - at) * 60000 / (bpm * song.tpb); at = tk; bpm = b; }
  return ms + (t - at) * 60000 / (bpm * song.tpb);
}


// The .rsng file; `play` as for compileSong.
export function writeSong(song, play = {}) {
  const { song: data, ticks, loopTick, seq: played } = compileSong(song, play), waves = writeWaves(song);
  const seq = play.row && !play.only ? [play.from, ...played] : played;   // close enough for a play
  const text = (s, max) => { let b = te.encode(s || ''); if (b.length > max) b = b.slice(0, max); return b; };
  const durn = new Uint8Array(8), dv = new DataView(durn.buffer);
  dv.setUint32(0, Math.round(tickMs(song, ticks, seq)), true);
  dv.setUint32(4, loopTick >= 0 ? Math.round(tickMs(song, loopTick, seq)) : NO_LOOP, true);
  const trk = { v: 1, ticksPerRow: song.ticksPerRow, rowsPerBeat: song.rowsPerBeat,
    patterns: song.patterns.map((p) => ({ rows: p.rows, name: p.name })), order: song.order, loop: song.loop,
    instruments: song.instruments.map((i) => i.name), waves: waves.list };
  const dver = new Uint8Array(4); dver[0] = SONG_DATA_VERSION;
  const chunks = [{ tag: 'NAME', data: text(song.name || 'Untitled', 64) }];
  if (song.auth) chunks.push({ tag: 'AUTH', data: text(song.auth, 256) });
  if (song.desc) chunks.push({ tag: 'DESC', data: text(song.desc, 1024) });
  if (song.licn) chunks.push({ tag: 'LICN', data: text(song.licn, 1024) });
  if (song.tver) chunks.push({ tag: 'TVER', data: text(song.tver, 64) });
  const date = writeDate(song.date);
  if (date) chunks.push({ tag: 'DATE', data: date });
  chunks.push({ tag: 'DVER', data: dver }, { tag: 'DURN', data: durn },
    { tag: 'xTRK', data: te.encode(JSON.stringify(trk)) }, { tag: 'SONG', data }, { tag: 'INST', data: waves.inst });
  if (waves.smpl) chunks.push({ tag: 'SMPL', data: waves.smpl });
  return writeContainer('RSNG', chunks);
}

// DATE is Unix time, int64 (file-chunks.md 2.6). The tracker shows and
// takes it as YYYY, YYYY-MM or YYYY-MM-DD (UTC); a bare year is 1 January.
export function readDate(d) {
  if (!d || d.length < 8) return '';
  const t = Number(new DataView(d.buffer, d.byteOffset, 8).getBigInt64(0, true));
  if (!t) return '';
  const iso = new Date(t * 1000).toISOString().slice(0, 10);
  return iso.endsWith('-01-01') ? iso.slice(0, 4) : iso;
}

export function writeDate(s) {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec((s || '').trim());
  if (!m) return null;
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(Date.UTC(+m[1], m[2] ? m[2] - 1 : 0, m[3] ? +m[3] : 1) / 1000), true);
  return out;
}


// ---------------------------------------------------------------- reading songs back

// One pass of a channel: its commands by tick (calls and finite repeats
// followed, a forever loop noted), the loop's start and the end.
export function flattenChannel(s, start) {
  const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
  const events = new Map(), stack = [];
  let pc = start, tick = 0, loopTick = -1, steps = 0;
  const add = (op, args) => { if (!events.has(tick)) events.set(tick, []); events.get(tick).push({ op, args }); };
  while (pc < s.length && steps++ < 4000000) {
    const c = s[pc++];
    if (c & 0x80) { tick += c & 0x7F; continue; }
    let n = c < ARG_BYTES.length ? ARG_BYTES[c] : -2;
    if (c === CH.ARPEGGIO) n = s[pc] ? 2 + s[pc] : 1;
    if (n < 0 || pc + n > s.length) break;
    const args = s.slice(pc, pc + n);
    pc += n;
    if (c === CH.END || c === CH.JUMP) break;
    if (c === CH.WAIT16) tick += args[0] | args[1] << 8;
    else if (c === CH.CALL || c === CH.CALL16) {
      if (stack.length >= 8) break;
      stack.push({ ret: pc });
      pc = c === CH.CALL ? dv.getUint32(pc - 4, true) : args[0] | args[1] << 8;
    } else if (c === CH.RETURN) {
      while (stack.length && stack[stack.length - 1].loop) stack.pop();
      if (!stack.length) break;
      pc = stack.pop().ret;
    } else if (c === CH.LOOP) {
      if (args[0] === 0) { if (!stack.length && loopTick < 0) loopTick = tick; }
      else if (stack.length < 8) stack.push({ loop: true, at: pc, left: args[0] });
    } else if (c === CH.LOOP_END) {
      const top = stack[stack.length - 1];
      if (top && top.loop) { if (--top.left > 0) pc = top.at; else stack.pop(); }
    } else add(c, args);
  }
  return { events, loopTick, endTick: tick };
}

// The phrases a tracker-written channel calls, in order (null if it is not one).
export function channelCalls(s, pc) {
  const out = [];
  for (let steps = 0; pc < s.length && steps < 100000; steps++) {
    const c = s[pc];
    if (c === CH.END) return out;
    if (c === CH.LENGTH) pc += 3;
    else if (c === CH.LOOP) pc += 2;
    else if (c === CH.LOOP_END) pc += 1;
    else if (c === CH.CALL16) { out.push(s[pc + 1] | s[pc + 2] << 8); pc += 3; }
    else if (c === CH.CALL) { out.push((s[pc + 1] | s[pc + 2] << 8 | s[pc + 3] << 16 | s[pc + 4] << 24) >>> 0); pc += 5; }
    else return null;
  }
  return null;
}

// One phrase's commands by tick, up to its CH_RETURN.
export function phraseEvents(s, pc) {
  const events = new Map();
  let tick = 0;
  while (pc < s.length) {
    const c = s[pc++];
    if (c & 0x80) { tick += c & 0x7F; continue; }
    if (c === CH.RETURN || c === CH.END) break;
    let n = c < ARG_BYTES.length ? ARG_BYTES[c] : -2;
    if (c === CH.ARPEGGIO) n = s[pc] ? 2 + s[pc] : 1;
    if (n < 0 || pc + n > s.length) break;
    const args = s.slice(pc, pc + n);
    pc += n;
    if (c === CH.WAIT16) { tick += args[0] | args[1] << 8; continue; }
    if (!events.has(tick)) events.set(tick, []);
    events.get(tick).push({ op: c, args });
  }
  return events;
}

export const i16 = (a, k) => { const v = a[k] | a[k + 1] << 8; return v >= 0x8000 ? v - 0x10000 : v; };

// Lay one channel's commands at one row into a cell. `active` maps each
// effect running from the rows before to the cell that set it, so the
// stop commands that end it are recognised as the tracker's own. An effect
// the next row neither repeats nor stops ran on in the original (the song
// data's effects last until changed): its cell keeps it as a command
// instead, which lasts as well.
export function unmap(c) {
  const p = c.param & 0xFF, bytes = cellBytes(Object.assign(emptyCell(), { fx: c.fx, param: p }));
  c.fx = null;
  c.param = 0;
  if (bytes.length) ((c.note !== null || c.off) ? c.post : c.raw).push(Uint8Array.from(bytes));
}

export function toCell(cmds, active) {
  const c = emptyCell();
  // the note column takes the row's last note, or its release if no note
  // follows it; any other notes and releases are kept as commands
  let key = -1;
  cmds.forEach((x, i) => { if (x.op === CH.NOTE || (x.op === CH.SLIDE_TO && key < 0)) key = i; });
  if (key < 0) cmds.forEach((x, i) => { if (x.op === CH.OFF) key = i; });
  if (key >= 0 && cmds.slice(0, key).some((x) => x.op === CH.NOTE)) key = -1;   // two notes: keep both as they are
  const pending = [];
  cmds.forEach(({ op, args }, i) => {
    const after = key >= 0 && i > key;
    if (i === key) {
      if (op === CH.NOTE) c.note = args[0];
      else if (op === CH.OFF) c.off = true;
      else pending.push({ op, args, after: true, key: true });
    } else if (op === CH.OFF && i < key && cmds[key].op === CH.NOTE) { /* released, then struck again: the note does both */ }
    else if (op === CH.INSTRUMENT && c.inst === null && !after) c.inst = args[0];
    else if (op === CH.VOLUME && c.vol === null && !after) c.vol = args[0];
    else if (op === CH.LENGTH && args[0] === 0 && args[1] === 0) { /* the tracker's own: notes hold */ }
    else pending.push({ op, args, after: after || key < 0 });
  });
  const stopped = new Set();
  pending.forEach(({ op, args, after, key: isKey }, j) => {
    // only the row's last command can become the effect column: the
    // column is written last, so the order stays as it was
    const free = c.fx === null && after && j === pending.length - 1;
    if (isKey) {                                  // a slide to a note in the note column's place
      if ((args[1] | args[2] << 8) % 16 === 0 && (args[1] | args[2] << 8) <= 255 * 16) {
        c.note = args[0]; c.fx = 3; c.param = (args[1] | args[2] << 8) / 16;
      } else c.raw.push(Uint8Array.from([op, ...args]));
      return;
    }
    if (op === CH.ARPEGGIO && args[0] === 0 && active.has('arp')) { active.delete('arp'); stopped.add('arp'); }
    else if (op === CH.PITCH_SLIDE && !args[0] && !args[1] && active.has('slide')) { active.delete('slide'); stopped.add('slide'); }
    else if (op === CH.VIBRATO && !args[0] && active.has('vib')) { active.delete('vib'); stopped.add('vib'); }
    else if (op === CH.VOLUME_SLIDE && !args[0] && active.has('vslide')) { active.delete('vslide'); stopped.add('vslide'); }
    else if (free && op === CH.ARPEGGIO && args[0] === 3 && args[1] === 1 && args[2] === 0 && args[3] < 16 && args[4] < 16)
      { c.fx = 0; c.param = args[3] << 4 | args[4]; }
    else if (free && op === CH.PITCH_SLIDE && i16(args, 0) % 16 === 0 && Math.abs(i16(args, 0)) <= 255 * 16 && i16(args, 0))
      { const v = i16(args, 0) / 16; c.fx = v > 0 ? 1 : 2; c.param = Math.abs(v); }
    else if (free && op === CH.VIBRATO && args[0] && args[0] % 8 === 0 && args[0] <= 120 && args[1] % 10 === 0 && args[1] <= 150 && !args[2])
      { c.fx = 4; c.param = (args[0] / 8) << 4 | (args[1] / 10); }
    else if (free && op === CH.VOLUME_SLIDE && args[0] && (args[0] < 16 || args[0] > 240))
      { c.fx = 10; c.param = args[0] < 16 ? args[0] << 4 : 256 - args[0]; }
    else if (free && op === CH.TEMPO && (args[0] | args[1] << 8) >= 1 && (args[0] | args[1] << 8) <= 255)
      { c.fx = 15; c.param = args[0] | args[1] << 8; }
    else (after && key >= 0 ? c.post : c.raw).push(Uint8Array.from([op, ...args]));
  });
  const kind = fxKind(c);
  for (const [k, from] of [...active]) if (k !== kind) { unmap(from); active.delete(k); }
  if (kind) active.set(kind, c);
  return cellEmpty(c) ? null : c;
}

// Ticks per row for a song without xTRK: the largest grid that nearly
// every note falls on, and the tick the grid starts at.
export function chooseGrid(noteTicks, tpb) {
  if (!noteTicks.length) return { tpr: Math.max(1, tpb / 4 | 0), phase: 0, on: 1 };
  const cands = new Set([1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 48]);
  for (let d = 1; d <= tpb; d++) if (tpb % d === 0) cands.add(d);
  let best = { tpr: 1, phase: 0, on: 1 };
  for (const d of [...cands].sort((a, b) => b - a)) {
    const counts = new Map();
    for (const t of noteTicks) counts.set(t % d, (counts.get(t % d) || 0) + 1);
    let phase = 0, n = 0;
    for (const [k, v] of counts) if (v > n) { n = v; phase = k; }
    if (n / noteTicks.length >= 0.97) return { tpr: d, phase, on: n / noteTicks.length };
  }
  return best;
}

// A .rsng as a tracker song. options.exact: lay a song without xTRK on a
// grid of one tick a row, so it sounds exactly as it did (long patterns).
export function readSong(buf, options = {}) {
  const chunks = readContainer(buf, 'RSNG');
  const get = (tag) => { const c = chunks.find((x) => x.tag === tag); return c ? c.data : null; };
  const text = (tag) => { const d = get(tag); return d ? td.decode(d).replace(/\0+$/, '') : ''; };
  const dver = get('DVER');
  if (!dver || dver.length < 4 || dver[0] !== SONG_DATA_VERSION || dver[1] || dver[2] || dver[3])
    throw new Error('unsupported song version (this tracker reads version ' + SONG_DATA_VERSION + ')');
  const s = get('SONG');
  if (!s || s.length < 28) throw new Error('no SONG chunk');
  const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
  if (dv.getUint32(0, true) !== SONG_MAGIC || dv.getUint16(4, true) !== SONG_VERSION) throw new Error('SONG is not a RetCon song');
  const n = Math.max(1, Math.min(16, s[9]));
  const inst = get('INST') || new Uint8Array(0);
  if (inst.length % INSTRUMENT_SIZE) throw new Error('bad INST chunk');
  let trk = null;
  try { const t = get('xTRK'); if (t) trk = JSON.parse(td.decode(t)); } catch (e) { trk = null; }

  const song = { name: text('NAME'), auth: text('AUTH'), licn: text('LICN'), desc: text('DESC'), tver: text('TVER'), date: readDate(get('DATE')),
    bpm: dv.getUint16(6, true), tpb: s[8], channels: n, voices: Array.from(s.subarray(12, 28)),
    instruments: [], waves: [], patterns: [], order: [], loop: -1, notes: [] };
  for (let i = 0; i < inst.length / INSTRUMENT_SIZE; i++)
    song.instruments.push({ name: (trk && trk.instruments && trk.instruments[i]) || `Instrument ${i + 1}`,
      bytes: inst.slice(i * INSTRUMENT_SIZE, (i + 1) * INSTRUMENT_SIZE) });
  song.waves = readWaves(song.instruments, get('SMPL'), trk && trk.waves);
  const flat = [];
  for (let ch = 0; ch < n; ch++) flat.push(flattenChannel(s, dv.getUint32(28 + 4 * ch, true)));

  const calls = trk ? Array.from({ length: n }, (_, ch) => channelCalls(s, dv.getUint32(28 + 4 * ch, true))) : null;
  if (trk && trk.v === 1 && trk.ticksPerRow > 0 && Array.isArray(trk.patterns) && Array.isArray(trk.order) &&
      trk.order.every((pi) => trk.patterns[pi]) && calls.every((c) => c && c.length === trk.order.length)) {
    // the tracker's own: each pattern of each channel is the phrase its call names
    song.ticksPerRow = trk.ticksPerRow;
    song.rowsPerBeat = trk.rowsPerBeat || 4;
    song.patterns = trk.patterns.map((p) => Object.assign(newPattern(p.rows, n), { name: p.name || '' }));
    song.order = trk.order.slice();
    song.loop = typeof trk.loop === 'number' ? trk.loop : -1;
    const done = new Set();
    song.order.forEach((pi, k) => {
      if (done.has(pi)) return;
      done.add(pi);
      const p = song.patterns[pi];
      for (let ch = 0; ch < n; ch++) {
        const events = phraseEvents(s, calls[ch][k]), active = new Map();
        for (let r = 0; r < p.rows; r++) p.cells[ch][r] = toCell(events.get(r * song.ticksPerRow) || [], active);
        // what follows the last row: the stops of effects that end with the
        // pattern; an effect at the last row without one is a kept command
        toCell(events.get(p.rows * song.ticksPerRow) || [], active);
      }
    });
    return song;
  }
  return bestEffort(song, flat, !!options.exact);
}

// A song from elsewhere: lay its commands on a row grid. Looping channels
// are repeated to the longest one's end, so the whole song loops together.
export function bestEffort(song, flat, exact) {
  const n = song.channels;
  const loops = flat.filter((f) => f.loopTick >= 0);
  const loopTick = loops.length ? Math.max(...loops.map((f) => f.loopTick)) : -1;
  let end = Math.max(1, ...flat.map((f) => f.endTick));
  if (loops.length) end = Math.max(end, loopTick + 1);
  for (const f of flat) {
    if (f.loopTick < 0 || f.endTick <= f.loopTick || f.endTick >= end) continue;
    const len = f.endTick - f.loopTick, body = [...f.events].filter(([t]) => t >= f.loopTick && t < f.endTick);
    for (let k = 1; f.endTick + (k - 1) * len < end; k++)
      for (const [t, cmds] of body) {
        const tt = t + k * len;
        if (tt < end) f.events.set(tt, (f.events.get(tt) || []).concat(cmds));
      }
  }
  const notes = [];
  for (const f of flat) for (const [t, cmds] of f.events) if (cmds.some((c) => c.op === CH.NOTE)) notes.push(t);
  const { tpr, phase, on } = exact ? { tpr: 1, phase: 0, on: 1 } : chooseGrid(notes, song.tpb);
  const rowOf = (t) => Math.max(0, Math.round((t - phase) / tpr));
  const rows = rowOf(end - 1) + 1, loopRow = loopTick >= 0 ? rowOf(loopTick) : -1;
  const grid = Array.from({ length: n }, () => new Map());
  let moved = 0, merged = 0;
  flat.forEach((f, ch) => {
    for (const [t, cmds] of [...f.events].sort((a, b) => a[0] - b[0])) {
      const r = rowOf(t);
      if ((t - phase) % tpr) moved += cmds.length;
      if (!grid[ch].has(r)) grid[ch].set(r, []);
      else if (cmds.some((c) => c.op === CH.NOTE) && grid[ch].get(r).some((c) => c.op === CH.NOTE)) merged++;
      grid[ch].get(r).push(...cmds);
    }
  });
  // patterns of 64 rows, one starting at the loop row; equal ones shared
  const starts = new Set([0]);
  for (let r = 0; r < rows; r += 64) starts.add(r);
  if (loopRow > 0) for (let r = loopRow; r < rows; r += 64) starts.add(r);
  const cuts = [...starts].filter((r) => r < rows).sort((a, b) => a - b);
  const keyOf = new Map();
  song.ticksPerRow = tpr;
  song.rowsPerBeat = Math.max(1, Math.round(song.tpb / tpr));
  const cells = grid.map((g) => {
    const active = new Map(), col = new Array(rows);
    for (let r = 0; r < rows; r++) col[r] = toCell(g.get(r) || [], active);
    return col;
  });
  cuts.forEach((r0, k) => {
    const r1 = k + 1 < cuts.length ? cuts[k + 1] : rows;
    const p = newPattern(r1 - r0, n);
    for (let ch = 0; ch < n; ch++) p.cells[ch] = cells[ch].slice(r0, r1);
    const key = JSON.stringify(p.cells, (k2, v) => (v instanceof Uint8Array ? Array.from(v) : v));
    if (!keyOf.has(key)) { keyOf.set(key, song.patterns.length); song.patterns.push(p); }
    if (r0 === loopRow) song.loop = song.order.length;
    song.order.push(keyOf.get(key));
  });
  if (loopRow === 0) song.loop = 0;
  song.notes = [exact ? 'Imported with exact timing: one tick a row.' :
    `Imported best effort: ${tpr} ticks a row${phase ? `, starting at tick ${phase}` : ''}` +
    ` (${Math.round(on * 100)}% of the notes on the grid).`];
  if (moved) song.notes.push(`${moved} commands between rows were moved to the nearest row.`);
  if (merged) song.notes.push(`${merged} rows had two notes on one channel; both are kept.`);
  return song;
}

// ---------------------------------------------------------------- extra commands

// The commands a cell can carry besides its columns, with their arguments
// (console_sys.h). Structural commands (calls, loops, jumps, waits, the
// end) are the tracker's own and cannot be added.
export const EXTRA = {
  [CH.NOTE]: { label: 'Note', args: [['note', 'u8', 'MIDI note']] },
  [CH.OFF]: { label: 'Release', args: [] },
  [CH.INSTRUMENT]: { label: 'Instrument', args: [['index', 'u8', '']] },
  [CH.VOLUME]: { label: 'Volume', args: [['volume', 'u8', '0-255']] },
  [CH.LENGTH]: { label: 'Note length', args: [['ticks', 'u16', 'ticks before release, 0 = hold']] },
  [CH.LEGATO]: { label: 'Legato', args: [['on', 'u8', '1 = notes change pitch without restarting']] },
  [CH.SLIDE_TO]: { label: 'Slide to note', args: [['note', 'u8', 'MIDI note'], ['speed', 'u16', '1/16 cent a tick']] },
  [CH.PITCH_SLIDE]: { label: 'Pitch slide', args: [['speed', 'i16', '1/16 cent a tick, 0 = stop']] },
  [CH.VIBRATO]: { label: 'Vibrato', args: [['depth', 'u8', 'cents, 0 = off'], ['rate', 'u8', '0.1 Hz'], ['delay', 'u8', 'ticks after the note']] },
  [CH.VOLUME_SLIDE]: { label: 'Volume slide', args: [['step', 'i8', 'volume a tick, 0 = stop']] },
  [CH.POSITION]: { label: 'Position', args: [['x', 'i8', 'left -128 … right 127'], ['y', 'i8', 'behind -128 … in front 127']] },
  [CH.FINE]: { label: 'Fine tune', args: [['cents', 'i8', 'added to the pitch from now on']] },
  [CH.TEMPO]: { label: 'Tempo', args: [['bpm', 'u16', 'whole song']] },
  [CH.MARKER]: { label: 'Marker', args: [['id', 'u8', 'copied to MusicControl.marker']] },
  [CH.BEND]: { label: 'Pitch bend', args: [['cents', 'i16', 'a note resets it']] },
  [CH.PATCH]: { label: 'Patch', args: [['field', 'field', 'instrument byte'], ['value', 'u8', '']] },
  [CH.SWEEP]: { label: 'Sweep', args: [['field', 'field', 'instrument byte or 16-bit width'], ['start', 'u16', '8.8; a 16-bit field: the value'],
    ['step', 'i16', 'a tick, 8.8'], ['low', 'u8', 'lowest (high byte)'], ['high', 'u8', 'highest (high byte)'], ['mode', 'mode', '']] },
  [CH.ARPEGGIO]: { label: 'Arpeggio', args: [['rate', 'u8', 'ticks a step'], ['steps', 'steps', 'semitones, e.g. 0 4 7; none = off']] },
  [CH.SAMPLE_START]: { label: 'Sample start', args: [['offset', 'u16', '256 frames, next note only']] },
};
export const SWEEP_MODES = ['stop', 'wrap', 'bounce'];

// The instrument bytes a patch or sweep can change, by offset.
export const PATCH_FIELDS = (() => {
  const out = [];
  for (let o = 0; o < 4; o++) for (const [n, off, t] of OP_FIELDS) {
    if (t === 'u16') out.push({ off: 20 * o + off, name: `op ${o + 1} ${n} (16-bit)`, word: true });
    out.push({ off: 20 * o + off, name: `op ${o + 1} ${n}${t === 'u16' ? ' low byte' : ''}` });
    if (t === 'u16') out.push({ off: 20 * o + off + 1, name: `op ${o + 1} ${n} high byte` });
  }
  for (const [n, off] of INST_FIELDS) out.push({ off, name: n.replace(/_/g, ' ') });
  return out;
})();

export const extraRead = (b, k, t) => (t === 'u8' ? b[k] : t === 'i8' ? (b[k] << 24) >> 24 : t === 'u16' ? b[k] | b[k + 1] << 8
  : ((b[k] | b[k + 1] << 8) << 16) >> 16);
export const extraSize = (t) => (t === 'u16' || t === 'i16' ? 2 : 1);

// bytes -> { op, values } (values by argument name), or null for one this cannot show
export function decodeExtra(r) {
  const op = r[0], d = EXTRA[op];
  if (!d) return null;
  const v = {};
  if (op === CH.ARPEGGIO) {
    v.rate = r[1] ? r[2] : 1;
    v.steps = r[1] ? Array.from(r.subarray(3, 3 + r[1]), (x) => (x << 24) >> 24) : [];
    return { op, values: v };
  }
  let k = 1;
  for (const [name, t] of d.args) {
    if (t === 'field') { v[name] = r[k]; k += 1; }
    else if (t === 'mode') { v.mode = r[k] & 0x7F; v.word = !!(r[k] & 0x80); k += 1; }
    else { v[name] = extraRead(r, k, t); k += extraSize(t); }
  }
  return { op, values: v };
}

// { op, values } -> bytes
export function encodeExtra(op, v) {
  const d = EXTRA[op], out = [op];
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, Math.round(+x || 0)));
  if (op === CH.ARPEGGIO) {
    const steps = (v.steps || []).slice(0, 8).map((x) => clamp(x, -128, 127) & 0xFF);
    if (!steps.length) return Uint8Array.from([op, 0]);
    return Uint8Array.from([op, steps.length, clamp(v.rate, 1, 255), ...steps]);
  }
  for (const [name, t] of d.args) {
    const x = v[name];
    if (t === 'u8' || t === 'field') out.push(clamp(x, 0, 255));
    else if (t === 'i8') out.push(clamp(x, -128, 127) & 0xFF);
    else if (t === 'u16') { const y = clamp(x, 0, 65535); out.push(y & 0xFF, y >> 8); }
    else if (t === 'i16') { const y = clamp(x, -32768, 32767) & 0xFFFF; out.push(y & 0xFF, y >> 8); }
    else if (t === 'mode') out.push((clamp(v.mode, 0, 2) | (v.word ? 0x80 : 0)) & 0xFF);
  }
  return Uint8Array.from(out);
}

// A new command, with values that do something audible to start from.
export const DEFAULTS = {
  [CH.NOTE]: { note: 60 }, [CH.INSTRUMENT]: { index: 0 }, [CH.VOLUME]: { volume: 200 }, [CH.LENGTH]: { ticks: 12 },
  [CH.LEGATO]: { on: 1 }, [CH.SLIDE_TO]: { note: 72, speed: 320 }, [CH.PITCH_SLIDE]: { speed: 160 },
  [CH.VIBRATO]: { depth: 25, rate: 55, delay: 0 }, [CH.VOLUME_SLIDE]: { step: -2 }, [CH.POSITION]: { x: 0, y: 0 },
  [CH.FINE]: { cents: 0 }, [CH.TEMPO]: { bpm: 125 }, [CH.MARKER]: { id: 1 }, [CH.BEND]: { cents: 100 },
  [CH.PATCH]: { field: 23, value: 128 }, [CH.SAMPLE_START]: { offset: 0 }, [CH.ARPEGGIO]: { rate: 2, steps: [0, 4, 7] },
  [CH.SWEEP]: { field: 24, start: 32768, step: -64, low: 0, high: 255, mode: 2, word: true },   // op 2 width, a pulse sweep
};
export function defaultExtra(op) { return encodeExtra(op, Object.assign({}, DEFAULTS[op] || {})); }
