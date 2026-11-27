// SPDX-License-Identifier: GPL-3.0-only
// Tests for the song library (src/), run by `npm test`, with Node:
//   1. a random tracker song, every column and effect, written and read back
//      cell for cell, and written again byte for byte the same;
//   2. every song in the given folders opened best effort and with exact
//      timing, written, and read back to the same song (stable), each
//      written file a valid container;
//   3. the chase (each order position's start state): after an edit it
//      matches one worked out from scratch, and a play from each position,
//      or of it on repeat, is a valid container;
//   4. samples and wavetables: a song's waves written and read back the
//      same, shared by two operators, and the Galway songs' SMPL and INST
//      written back byte for byte;
//   5. a ProTracker module, made here: best effort keeps its patterns, order,
//      loop and samples; exact import plays the same notes at the same ticks;
//      both written stably; a copy with its bytes swapped in pairs reads the same.
//   6. the DMXOPL3 bank as General MIDI instruments, and a MIDI file made
//      here: a program over a track name, a name over program 0, the kit,
//      volume and expression, the notes at their times, written stably;
//   7. the converters midi2rsng.js and mod2rsng.js: the same songs from the
//      command line, with only the instruments used and the licences;
//   8. the pages' copy of the library (scripts/build.mjs): the same names, the same
//      bytes.

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import RSNG from '../src/index.js';
import { bundle } from '../scripts/build.mjs';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = process.argv.length > 2 ? process.argv.slice(2) : [path.join(WEB, 'test', 'fixtures', 'martin-galway')];
const R = RSNG;
let checks = 0, failed = 0;
const check = (ok, what) => { checks++; if (!ok) { failed++; console.log('FAIL', what); } };
const json = (x) => JSON.stringify(x, (k, v) => (v instanceof Uint8Array ? Array.from(v) : v));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// 1. a random song
let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const song = R.newSong(6);
Object.assign(song, { name: 'Round trip', auth: 'Test', licn: 'CC0', date: '2026-11-25', ticksPerRow: 3, loop: 2 });
song.patterns.push(R.newPattern(32, 6), R.newPattern(48, 6));
song.order = [0, 1, 2, 1, 0, 2];
for (const p of song.patterns) for (let ch = 0; ch < 6; ch++) for (let r = 0; r < p.rows; r++) {
  if (rnd(3)) continue;
  const c = R.emptyCell(), k = rnd(10);
  if (k < 6) c.note = 24 + rnd(60); else if (k < 7) c.off = true;
  if (!rnd(3)) c.inst = rnd(song.instruments.length);
  if (!rnd(4)) c.vol = rnd(256);
  if (!rnd(3) && !c.off) {
    c.fx = [0, 1, 2, 3, 4, 10, 15][rnd(7)];
    c.param = c.fx === 10 ? (rnd(2) ? (1 + rnd(15)) << 4 : 1 + rnd(15)) : c.fx === 4 ? (1 + rnd(15)) << 4 | rnd(16) : 1 + rnd(255);
    if (c.fx === 3 && c.note === null) c.note = 40;
  }
  if (!R.cellEmpty(c)) p.cells[ch][r] = c;
}
const a = R.writeSong(song), back = R.readSong(a.buffer);
check(json(back.patterns) === json(song.patterns), 'random song: patterns read back');
check(json([back.order, back.loop, back.ticksPerRow, back.name, back.date]) === json([song.order, song.loop, song.ticksPerRow, song.name, song.date]),
  'random song: order, loop, timing and metadata read back');
check(same(R.writeSong(back), a), 'random song: written again the same');
check(R.readContainer(a.buffer, 'RSNG').length >= 6, 'random song: a valid container');

// 2. songs from elsewhere
for (const dir of dirs) for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.rsng')).sort()) {
  const buf = fs.readFileSync(path.join(dir, f));
  for (const exact of [false, true]) {
    const what = `${f} (${exact ? 'exact' : 'best effort'})`;
    try {
      const s = R.readSong(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), { exact });
      const out = R.writeSong(s);
      R.readContainer(out.buffer, 'RSNG');
      check(same(R.writeSong(R.readSong(out.buffer)), out), what + ': stable');
    } catch (e) { check(false, what + ': ' + e.message); }
  }
}
// 3. the chase
for (const f of ['wizball_title.rsng', 'gameover_title.rsng', 'arkanoid_title.rsng'].filter((x) => dirs.length && fs.existsSync(path.join(dirs[0], x)))) {
  const buf = fs.readFileSync(path.join(dirs[0], f));
  const s = R.readSong(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const cache = {};
  R.chase(s, cache);
  const k = s.order.length >> 1, p = s.patterns[s.order[k]];
  const c = R.emptyCell(); c.vol = 17; c.raw = [Uint8Array.of(R.CH.FINE, 9)];
  p.cells[0][0] = c;                                 // an edit in the middle
  check(json(R.chase(s, cache)) === json(R.chase(s)), f + ': chase after an edit matches a fresh one');
  check(R.chase(s)[k + 1].ch[0].fine === 9, f + ': the edit carries to the next position');
  let valid = true;
  for (let i = 0; i < s.order.length; i++)
    for (const only of [false, true])
      try { R.readContainer(R.writePlay(s, i, only, cache).buffer, 'RSNG'); } catch (e) { valid = false; }
  check(valid, f + ': a play from every position is a valid song');
}
// 4. samples and wavetables
{
  const w = R.newSong(2), t = R.newTable(48, 'saw'), sm = R.newSample(Array.from({ length: 1001 }, (_, i) => Math.sin(i / 7)), 22050, 57);
  R.quantizeTable(t, 4);
  Object.assign(t, { name: 'buzz' }); Object.assign(sm, { name: 'tone', loopStart: 100, loopLength: 800 });
  const spare = Object.assign(R.newTable(16, 'triangle'), { name: 'spare' });   // used by no operator
  w.waves.push(t, sm, spare);
  const a = w.instruments[0].bytes, b = w.instruments[1].bytes;
  a[20] = R.WAVE_TABLE; R.setU32(a, 36, 0); a[40] = R.WAVE_TABLE; R.setU32(a, 56, 0);   // two operators share the table
  b[20] = R.WAVE_SAMPLE; R.setU32(b, 36, 1);
  w.instruments[2].bytes[20] = R.WAVE_TABLE; R.setU32(w.instruments[2].bytes, 36, R.NO_WAVE);   // none: a plain one is written
  const out = R.writeSong(w), back = R.readSong(out.buffer);
  check(json(back.waves.slice(0, 3)) === json(w.waves), 'waves: read back the same, with their names, used or not');
  check(R.getU32(back.instruments[0].bytes, 16 + 20) === R.getU32(back.instruments[0].bytes, 16 + 40), 'waves: a shared table stays shared');
  check(back.waves[R.getU32(back.instruments[2].bytes, 36)].kind === 'table', 'waves: an operator without a table gets one');
  check(same(R.writeSong(back), out), 'waves: written again the same');
  let exact = 0, all = 0;
  for (const f of fs.readdirSync(dirs[0] || '.').filter((x) => x.endsWith('.rsng'))) {
    const buf = fs.readFileSync(path.join(dirs[0], f)), ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    const hex = (c, tag) => { const x = c.find((y) => y.tag === tag); return x ? Buffer.from(x.data).toString('hex') : ''; };
    const orig = R.readContainer(ab, 'RSNG'), again = R.readContainer(R.writeSong(R.readSong(ab)).buffer, 'RSNG');
    all++; if (hex(orig, 'SMPL') === hex(again, 'SMPL') && hex(orig, 'INST') === hex(again, 'INST')) exact++;
  }
  check(all > 0 && exact === all, `waves: SMPL and INST of ${exact}/${all} songs written back byte for byte`);
}
// each channel's notes of a song, in milliseconds (a speed change can be a tempo change)
function moduleNotes(s, ms) {
  const song = R.compileSong(s).song, dvs = new DataView(song.buffer);
  const flats = Array.from({ length: s.channels }, (_, ch) => R.flattenChannel(song, dvs.getUint32(28 + 4 * ch, true)));
  const tempos = [...flats[0].events].flatMap(([t, c]) => c.filter((e) => e.op === R.CH.TEMPO).map((e) => [t, e.args[0] | e.args[1] << 8])).sort((a, b) => a[0] - b[0]);
  const at = (t) => { let m = 0, t0 = 0, bpm = s.bpm; for (const [tt, b] of tempos) { if (tt >= t) break; m += (tt - t0) * 60000 / (bpm * s.tpb); t0 = tt; bpm = b; } return m + (t - t0) * 60000 / (bpm * s.tpb); };
  return flats.map((f) => [...f.events].filter(([t, c]) => at(t) < ms && c.some((e) => e.op === R.CH.NOTE))
    .map(([t, c]) => Math.round(at(t)) + ':' + c.find((e) => e.op === R.CH.NOTE).args[0]).sort());
}

// 5. a ProTracker module
let modBytes = null, modBest = null;
{
  const nch = 4, mod = new Uint8Array(1084 + 2 * 64 * 4 * nch + 2 * 64);
  const put16 = (o, v) => { mod[o] = v >> 8; mod[o + 1] = v & 255; };
  mod.set(Buffer.from('Test module'), 0);
  for (let i = 0; i < 2; i++) {                          // two 64-byte samples, the second looping
    const o = 20 + 30 * i;
    mod.set(Buffer.from('smp ' + (i + 1)), o);
    put16(o + 22, 32); mod[o + 25] = 48 - 16 * i; put16(o + 26, 0); put16(o + 28, i ? 32 : 1);
  }
  mod[950] = 3; mod.set([0, 1, 0], 952); mod.set(Buffer.from('M.K.'), 1080);
  const cell = (p, r, c, smp, per, fx, prm) => {
    const o = 1084 + p * 1024 + (r * nch + c) * 4;
    mod[o] = (smp & 0xF0) | per >> 8; mod[o + 1] = per & 255; mod[o + 2] = (smp & 15) << 4 | fx; mod[o + 3] = prm;
  };
  for (let r = 0; r < 64; r += 4) cell(0, r, 0, 1, [428, 381, 339, 320][r / 4 % 4], 0, 0);
  cell(0, 8, 1, 2, 214, 0xC, 32); cell(0, 9, 1, 0, 0, 0xA, 0x02); cell(0, 16, 2, 1, 856, 0x0, 0x37);
  cell(1, 0, 0, 2, 254, 0xF, 0x05); cell(1, 4, 3, 1, 302, 0x4, 0x44); cell(1, 31, 0, 0, 0, 0xB, 0x01);   // Bxx: the loop
  for (let i = 0; i < 128; i++) mod[1084 + 2048 + i] = Math.round(100 * Math.sin(i / 5)) & 255;
  const ab = mod.buffer.slice(0), be = R.readMod(ab), ex = R.readMod(ab, { exact: true });
  modBytes = mod; modBest = R.readSong(R.writeSong(be).buffer);
  check(R.isMod(mod) && be.channels === 4 && be.name === 'Test module', 'module: recognised, 4 channels, its name');
  check(json([be.order, be.loop, be.patterns.map((p) => p.rows)]) === json([[0, 1], 1, [64, 64]]),
    'module: order, loop at Bxx, patterns kept');
  const c0 = be.patterns[0].cells[0][0], c1 = be.patterns[0].cells[1][8];
  check(c0.note === 60 && c0.inst === 0 && c1.note === 72 && c1.vol === Math.round(255 * Math.sqrt(32 / 64)),
    'module: notes, instruments and Cxx volume on the columns');
  check(be.patterns[0].cells[2][16].fx === 0 && be.patterns[0].cells[2][16].param === 0x37 && be.patterns[0].cells[1][9].fx === 10,
    'module: arpeggio and volume slide on the effect column');
  check(be.waves.length === 31 && be.waves[1].loopLength === 64 && be.waves[0].format === 1, 'module: samples, 8-bit, with loops');
  // each channel's notes in milliseconds (a speed change is a tempo change in best effort)
  const notes = (s, ms) => {
    const song = R.compileSong(s).song, dvs = new DataView(song.buffer);
    const flats = Array.from({ length: 4 }, (_, ch) => R.flattenChannel(song, dvs.getUint32(28 + 4 * ch, true)));
    const tempos = [...flats[0].events].flatMap(([t, c]) => c.filter((e) => e.op === R.CH.TEMPO).map((e) => [t, e.args[0] | e.args[1] << 8])).sort((a, b) => a[0] - b[0]);
    const at = (t) => { let m = 0, t0 = 0, bpm = s.bpm; for (const [tt, b] of tempos) { if (tt >= t) break; m += (tt - t0) * 60000 / (bpm * s.tpb); t0 = tt; bpm = b; } return m + (t - t0) * 60000 / (bpm * s.tpb); };
    return flats.map((f) => [...f.events].filter(([t, c]) => at(t) < ms && c.some((e) => e.op === R.CH.NOTE))
      .map(([t, c]) => Math.round(at(t)) + ':' + c.find((e) => e.op === R.CH.NOTE).args[0]).sort());
  };
  check(json(notes(be, 9000)) === json(notes(ex, 9000)), 'module: best effort and exact play the same notes at the same times');
  for (const [s, what] of [[be, 'best effort'], [ex, 'exact']]) {
    const out = R.writeSong(s);
    check(same(R.writeSong(R.readSong(out.buffer)), out), `module (${what}): written and read back stably`);
  }
  const sw = mod.slice();
  for (let i = 0; i + 1 < 1084 + 1024; i += 2) { const t = sw[i]; sw[i] = sw[i + 1]; sw[i + 1] = t; }   // header and pattern 0
  check(json(R.readMod(sw.buffer).patterns) === json(be.patterns), 'module: bytes swapped in pairs read back the same');
  // a 20-channel module (20CH), one pattern, one looping sample: packed onto 16 or fewer
  const wide = (cellsAt) => {
    const n = 20, w = new Uint8Array(1084 + 64 * 4 * n + 64);
    const p16 = (o, v) => { w[o] = v >> 8; w[o + 1] = v & 255; };
    w.set(Buffer.from('Wide module'), 0); w.set(Buffer.from('loop'), 20); p16(42, 32); w[45] = 64; p16(46, 0); p16(48, 32);
    w[950] = 1; w.set(Buffer.from('20CH'), 1080);
    for (let r = 0; r < 64; r++) for (const [c, per, fx, prm] of cellsAt(r)) {
      const o = 1084 + (r * n + c) * 4, smp = per ? 1 : 0;
      w[o] = (smp & 0xF0) | per >> 8; w[o + 1] = per & 255; w[o + 2] = (smp & 15) << 4 | fx; w[o + 3] = prm;
    }
    for (let i = 0; i < 64; i++) w[1084 + 64 * 4 * n + i] = i % 16 < 8 ? 64 : 192;
    return w.buffer;
  };
  const per = (k) => [856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453, 428, 404, 381, 360, 339, 320, 302, 285, 269][k];
  // taking turns: a note on channel r at row r, then off (EC0) on the row after
  const tb = wide((r) => (r < 20 ? [[r, per(r), 0, 0]] : []).concat(r && r <= 20 ? [[r - 1, 0, 0xE, 0xC0]] : []));
  const tp = R.readMod(tb), tpx = R.readMod(tb, { exact: true }), tn = [], tpan = [];
  tp.patterns[0].cells.forEach((col) => col.forEach((c, r) => { if (c && c.note !== null) { tn.push(c.note); if (r > 0 && c.raw.some((x) => x[0] === R.CH.POSITION)) tpan.push(r); } }));
  check(tp.channels < 16 && tp.lost.length === 1 && new RegExp(`^The song is rearranged .*20 channels are packed into ${tp.channels},`).test(tp.lost[0]) &&
    json(tn.sort((x, y) => x - y)) === json(Array.from({ length: 20 }, (_, k) => 48 + k)) &&
    tpan.length === 19 && /^A 20-channel module/.test(tp.notes[0]) && json(moduleNotes(tp, 4000)) === json(moduleNotes(tpx, 4000)),
    'module: 20 channels taking turns packed onto fewer, every note kept with its channel\'s pan, best effort and exact alike');
  // 20 notes at once: 16 kept, the rest told to the user
  const ab20 = wide((r) => (r === 0 ? Array.from({ length: 20 }, (_, c) => [c, per(c), 0, 0]) : []));
  const ap = R.readMod(ab20), apx = R.readMod(ab20, { exact: true });
  check(ap.channels === 16 && ap.lost.length === 2 && /^The song is rearranged/.test(ap.lost[0]) && /^4 notes left out where more than 16 sounded at once/.test(ap.lost[1]) &&
    json(apx.lost) === json(ap.lost), 'module: 20 notes at once on 20 channels: 16 kept, what is left out told to the user');
  for (const [sg, what] of [[tp, 'packed best effort'], [tpx, 'packed exact']]) {
    const out = R.writeSong(sg);
    check(same(R.writeSong(R.readSong(out.buffer)), out), `module (${what}): written and read back stably`);
  }
}
// 6. a MIDI file, with the General MIDI instruments of DMXOPL3
{
  const wb = fs.readFileSync(path.join(WEB, 'banks', 'dmxopl3', 'DMXOPL3-by-sneakernets-GS.wopl'));
  const bank = R.gmBank(wb.buffer.slice(wb.byteOffset, wb.byteOffset + wb.length));
  check(bank.instruments.length === 128 + Object.keys(bank.drums).length && bank.instruments[0].name === 'Acoustic Grand Piano' &&
    bank.instruments[127].name === 'Gunshot' && bank.instruments[128].name.startsWith('Drum: ') && bank.drums[36] && bank.drums[38] &&
    bank.instruments.every((i) => i.bytes.length === R.INSTRUMENT_SIZE), 'bank: 128 programs and the drum kit, by name');
  const vlq = (v) => { const b = [v & 127]; while ((v >>= 7)) b.unshift(128 | (v & 127)); return b; };
  const track = (events) => { const body = events.flat(); return [...Buffer.from('MTrk'), 0, 0, body.length >> 8, body.length & 255, ...body]; };
  const t1 = track([[0, 0xFF, 0x03, 5, ...Buffer.from('Piano')], [0, 0xC0, 48],           // program 48 (String Ensemble 1) beats the name
    [0, 0xB0, 7, 64],                                                                      // channel volume: half
    [0, 0x90, 60, 100], [0, 0x90, 64, 100], [0, 0x90, 67, 100], [...vlq(240), 0xB0, 11, 127 >> 1],   // expression halves it again
    [...vlq(240), 0x80, 60, 0], [0, 0x80, 64, 0], [0, 0x80, 67, 0], [0, 0xFF, 0x2F, 0]]);
  const t2 = track([[0, 0xFF, 0x03, 4, ...Buffer.from('Bass')], [0, 0x91, 40, 100], [...vlq(480), 0x81, 40, 0],   // program 0: the name says bass
    [0, 0xFF, 0x2F, 0]]);
  const t3 = track([[0, 0xFF, 0x51, 3, 0x07, 0xA1, 0x20], [0, 0x99, 36, 120], [...vlq(240), 0x89, 36, 0],   // 120 bpm; a kick
    [0, 0x99, 38, 90], [...vlq(240), 0x89, 38, 0], [0, 0xFF, 0x2F, 0]]);
  const mid = Uint8Array.from([...Buffer.from('MThd'), 0, 0, 0, 6, 0, 1, 0, 3, 480 >> 8, 480 & 255, ...t1, ...t2, ...t3]);
  const s = R.readMidi(mid.buffer, { bank, exact: true });
  check(R.isMidi(mid) && s.instruments.length === bank.instruments.length, 'MIDI: the song has the whole bank');
  check(s.channels === 6 && s.bpm === 120, 'MIDI: a chord on three channels, the bass, kick and snare on their own, the tempo');
  const song = R.compileSong(s).song, dvs = new DataView(song.buffer), heard = [], vols = [];
  for (let ch = 0; ch < s.channels; ch++) {
    const f = R.flattenChannel(song, dvs.getUint32(28 + 4 * ch, true));
    let inst = null;
    for (const [t, c] of [...f.events].sort((a, b) => a[0] - b[0])) for (const e of c) {
      if (e.op === R.CH.INSTRUMENT) inst = e.args[0];
      if (e.op === R.CH.NOTE) heard.push(`${t}:${e.args[0]}:${inst}`);
      if (e.op === R.CH.VOLUME && ch === 0) vols.push(`${t}:${e.args[0]}`);
    }
  }
  const k48 = bank.keyOffset[48], k33 = bank.keyOffset[33], [kick, kickNote] = bank.drums[36], [snare, snareNote] = bank.drums[38];
  const want = [`0:${60 + k48}:48`, `0:${64 + k48}:48`, `0:${67 + k48}:48`, `0:${40 + k33}:33`, `0:${kickNote}:${kick}`, `12:${snareNote}:${snare}`];
  check(json(heard.sort()) === json(want.sort()), 'MIDI: notes, times and instruments (program over name, name over program 0, the kit)');
  const v = (x) => Math.round(255 * 100 / 127 * x);
  check(json(vols) === json([`0:${v(64 / 127)}`, `12:${v(64 / 127 * 63 / 127)}`]), 'MIDI: volume and expression set and change the volume');
  const out = R.writeSong(s);
  check(same(R.writeSong(R.readSong(out.buffer)), out), 'MIDI: written and read back stably');
  check(json(s.lost) === json([]), 'MIDI: nothing left out of a song that fits');
  const wide = track([[0, 0xFF, 0x03, 4, ...Buffer.from('Wide')], ...Array.from({ length: 18 }, (_, k) => [0, 0x90, 40 + k, 100]),   // 18 notes at once
    [...vlq(480), 0x80, 40, 0], ...Array.from({ length: 17 }, (_, k) => [0, 0x80, 41 + k, 0]), [0, 0xFF, 0x2F, 0]]);
  const sw = R.readMidi(Uint8Array.from([...Buffer.from('MThd'), 0, 0, 0, 6, 0, 0, 0, 1, 480 >> 8, 480 & 255, ...wide]).buffer, { bank });
  check(sw.channels === 16 && sw.lost.length === 1 && /2 notes on 2 channels left out; the song player has 16 channels/.test(sw.lost[0]),
    'MIDI: a part with more notes at once than 16 channels: what is left out, for the user');

  // 7. the converters: the same code from the command line
  const { execFileSync } = await import('child_process');
  const os = await import('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsng-'));
  try {
    fs.writeFileSync(path.join(tmp, 't.mid'), mid);
    const tool = (name, args) => execFileSync('node', [path.join(WEB, 'converters', name), ...args], { encoding: 'utf8' });
    const log = tool('midi2rsng.js', [path.join(tmp, 't.mid'), '-o', path.join(tmp, 't.rsng'), '--licn', 'CC0', '--exact']);
    const conv = R.readSong(new Uint8Array(fs.readFileSync(path.join(tmp, 't.rsng'))).buffer);
    check(/6 channels, 4 instruments/.test(log) && conv.licn.startsWith('CC0\n') && conv.licn.includes('DMXOPL3'),
      'midi2rsng.js: a song with the licence given and the bank\'s notice');
    check(json(conv.instruments.map((i) => i.name)) === json([33, 48, kick, snare].map((i) => bank.instruments[i].name)) &&
      conv.instruments.every((i, k) => same(i.bytes, bank.instruments[[33, 48, kick, snare][k]].bytes)),
      'midi2rsng.js: only the instruments it uses, the bank\'s own');
    fs.writeFileSync(path.join(tmp, 'm.mod'), modBytes);
    const mlog = tool('mod2rsng.js', [path.join(tmp, 'm.mod'), '-o', path.join(tmp, 'm.rsng')]);
    const mconv = R.readSong(new Uint8Array(fs.readFileSync(path.join(tmp, 'm.rsng'))).buffer);
    check(/4 channels, 2 positions, 2 patterns, loops to position 1/.test(mlog) && json(mconv.patterns) === json(modBest.patterns),
      'mod2rsng.js: the module as the tracker opens it');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
// 8. the pages' copy: the modules joined into one script (scripts/build.mjs) give the same library
{
  const box = { globalThis: null, TextDecoder, TextEncoder };   // what a page has
  box.globalThis = box;
  vm.runInNewContext(bundle(), box);
  const B = box.RSNG;
  check(B && json(Object.keys(B).sort()) === json(Object.keys(R).sort()), 'bundle: the same names as the modules');
  const song = R.newSong(3);
  song.patterns[0].cells[1][4] = Object.assign(R.emptyCell(), { note: 60, inst: 2, vol: 99, fx: 4, param: 0x34 });
  check(same(B.writeSong(song), R.writeSong(song)), 'bundle: writes a song byte for byte as the modules do');
}
// 9. Scream Tracker 3 and FastTracker 2 modules, made here
{
  // --- S3M: 2 channels (left, right), one unsigned 8-bit looping sample, two patterns
  const S = new Uint8Array(4096), sdv = new DataView(S.buffer);
  S.set(Buffer.from('S3M test'), 0); S[28] = 0x1A; S[29] = 16;
  sdv.setUint16(32, 3, true); sdv.setUint16(34, 1, true); sdv.setUint16(36, 2, true); sdv.setUint16(40, 0x1320, true); sdv.setUint16(42, 2, true);
  S.set(Buffer.from('SCRM'), 44); S[48] = 64; S[49] = 6; S[50] = 125; S[51] = 0x80 | 48;
  for (let c = 0; c < 32; c++) S[64 + c] = c === 0 ? 0 : c === 1 ? 8 : 255;
  S.set([0, 1, 0], 96);                                        // orders
  const insPara = 0x80 / 16, pat0 = 0x100 / 16, pat1 = 0x200 / 16, smpPara = 0x300 / 16;
  sdv.setUint16(99, insPara, true); sdv.setUint16(101, pat0, true); sdv.setUint16(103, pat1, true);
  const io = 0x80; S[io] = 1; S.set(Buffer.from('tone'), io + 1); S[io + 13] = 0; sdv.setUint16(io + 14, smpPara, true);
  sdv.setUint32(io + 16, 64, true); sdv.setUint32(io + 20, 16, true); sdv.setUint32(io + 24, 64, true); S[io + 28] = 40; S[io + 31] = 1;
  sdv.setUint32(io + 32, 16726, true); S.set(Buffer.from('square tone'), io + 48); S.set(Buffer.from('SCRS'), io + 76);
  for (let k = 0; k < 64; k++) S[0x300 + k] = k % 16 < 8 ? 0xC0 : 0x40;   // unsigned: 0xC0 is +64, 0x40 is -64
  const pattern = (at, rows) => {                              // rows: [[row, [[ch, note, inst, vol, cmd, prm], ...]]]
    let q = at + 2;
    for (let r = 0; r < 64; r++) {
      for (const [ch, n, ins, vol, cmd, prm] of (rows.find((x) => x[0] === r) || [0, []])[1]) {
        S[q++] = ch | (n !== null ? 32 : 0) | (vol !== null ? 64 : 0) | (cmd ? 128 : 0);
        if (n !== null) { S[q++] = n; S[q++] = ins; }
        if (vol !== null) S[q++] = vol;
        if (cmd) { S[q++] = cmd; S[q++] = prm; }
      }
      S[q++] = 0;
    }
    sdv.setUint16(at, q - at, true);
  };
  const L = (c) => c.charCodeAt(0) - 64;
  pattern(0x100, [[0, [[0, 0x40, 1, 48, L('A'), 6], [1, 0x44, 1, null, L('T'), 125]]], [4, [[0, 0x47, 1, null, L('J'), 0x37]]],
    [8, [[1, 0x52, 1, 20, L('D'), 0x04]]], [12, [[0, 254, 0, null, 0, 0]]], [16, [[0, 0x40, 1, null, L('C'), 0]]]]);
  pattern(0x200, [[0, [[0, 0x45, 1, null, 0, 0]]], [32, [[1, 0x49, 1, 64, 0, 0]]]]);
  const sb = S.buffer.slice(0), s3 = R.readTracked(sb), s3x = R.readTracked(sb, { exact: true });
  check(R.isS3m(S) && s3.channels === 2 && s3.name === 'S3M test' && json(s3.order) === json([0, 1, 0]) && s3.patterns[0].rows === 17,
    'S3M: channels, name, order, a pattern ending at its break');
  const c00 = s3.patterns[0].cells[0][0], c10 = s3.patterns[0].cells[1][0];
  check(c00.note === 60 && c00.inst === 0 && c00.vol === Math.round(255 * Math.sqrt(48 / 64)) && c10.note === 64 &&
    s3.patterns[0].cells[0][4].fx === 0 && s3.patterns[0].cells[0][4].param === 0x37 && s3.patterns[0].cells[1][8].fx === 10 &&
    s3.patterns[0].cells[0][12].off, 'S3M: notes, instrument, volume column, arpeggio, volume slide, note cut');
  const w3 = s3.waves[0];
  check(w3.format === 1 && w3.frames === 64 && w3.loopStart === 16 && w3.loopLength === 48 && w3.data[0] === 64 && w3.data[8] === 0xC0 &&
    w3.rate === Math.round(16726 * 14317056 / (8363 * 16 * 107)), 'S3M: an unsigned sample made signed, its loop and its C-4 rate');
  check(c00.raw.some((r) => r[0] === R.CH.POSITION && r[1] === ((0x30 - 128) & 255)) &&
    c10.raw.some((r) => r[0] === R.CH.POSITION && r[1] === ((0xC0 - 128) & 255)), 'S3M: the channels\' left and right');
  check(json(moduleNotes(s3, 7000)) === json(moduleNotes(s3x, 7000)), 'S3M: best effort and exact play the same notes at the same times');

  // --- XM: 2 channels, linear frequencies, one instrument with two samples (8-bit below C-4, 16-bit ping-pong from C-4)
  const parts = [], u8 = (...v) => parts.push(Uint8Array.from(v)), str = (t, n) => { const b = new Uint8Array(n); b.set(Buffer.from(t).subarray(0, n)); parts.push(b); };
  const le16 = (v) => u8(v & 255, v >> 8), le32 = (v) => u8(v & 255, v >> 8 & 255, v >> 16 & 255, v >>> 24);
  str('Extended Module: ', 17); str('XM test', 20); u8(0x1A); str('test', 20); le16(0x0104); le32(276);
  le16(2); le16(0); le16(2); le16(1); le16(1); le16(1); le16(6); le16(125);
  const ord = new Uint8Array(256); parts.push(ord);           // orders: 0, 0
  const rows = Array.from({ length: 32 }, () => [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]]);
  rows[0][0] = [37, 1, 0x10 + 50, 0, 0];                       // C-3 (MIDI 48): the 8-bit sample, volume column 50
  rows[0][1] = [49, 1, 0, 0x1, 2];                             // C-4: the 16-bit sample, slide up 2
  rows[8][0] = [97, 0, 0, 0, 0];                               // key off: the envelope releases and fades
  rows[16][1] = [53, 1, 0, 0, 0];
  const pdata = [];
  for (const r of rows) for (const [n, i, v, f, pp] of r) {
    if (!(n || i || v || f || pp)) { pdata.push(0x80); continue; }
    pdata.push(0x80 | (n ? 1 : 0) | (i ? 2 : 0) | (v ? 4 : 0) | (f ? 8 : 0) | (pp ? 16 : 0));
    if (n) pdata.push(n); if (i) pdata.push(i); if (v) pdata.push(v); if (f) pdata.push(f); if (pp) pdata.push(pp);
  }
  le32(9); u8(0); le16(32); le16(pdata.length); parts.push(Uint8Array.from(pdata));
  const ih = new Uint8Array(263), idv = new DataView(ih.buffer);   // instrument header (263 bytes) with its sample map and envelope
  idv.setUint32(0, 263, true); ih.set(Buffer.from('lead'), 4); idv.setUint16(27, 2, true); idv.setUint32(29, 40, true);
  for (let k = 48; k < 96; k++) ih[33 + k] = 1;                // C-4 and up: sample 1
  [[0, 64], [4, 48], [20, 0]].forEach(([x, y], k) => { idv.setUint16(129 + 4 * k, x, true); idv.setUint16(131 + 4 * k, y, true); });
  ih[225] = 3; ih[227] = 1; ih[233] = 1 | 2; idv.setUint16(239, 4096, true);   // 3 points, sustain at point 1, fade-out
  parts.push(ih);
  const sh = (len, ls, ll, vol, type, rel, name) => { le32(len); le32(ls); le32(ll); u8(vol, 0, type, 128, rel, 0); str(name, 22); };
  sh(8, 0, 0, 64, 0, 0, 'low'); sh(16, 4, 8, 48, 16 | 2, 0, 'high');
  const v8 = [0, 40, 80, 40, 0, -40, -80, -40], v16 = [0, 1000, 2000, 3000, 4000, 3000, 2000, 1000];
  let acc = 0; u8(...v8.map((v) => { const dlt = (v - acc) & 255; acc = v; return dlt; }));
  acc = 0; for (const v of v16) { const dlt = (v - acc) & 0xFFFF; acc = v; le16(dlt); }
  const X = Uint8Array.from(parts.flatMap((p) => [...p])), xb = X.buffer.slice(0);
  const xm = R.readTracked(xb), xmx = R.readTracked(xb, { exact: true });
  check(R.isXm(X) && xm.channels === 2 && xm.instruments.length === 2 && xm.instruments[0].name === 'lead: low' && xm.instruments[1].name === 'lead: high',
    'XM: an instrument with two samples is two instruments, by name');
  const x0 = xm.patterns[0].cells[0][0], x1 = xm.patterns[0].cells[1][0];
  check(x0.note === 48 && x0.inst === 0 && x0.vol === Math.round(255 * Math.sqrt(50 / 64)) && x1.note === 60 && x1.inst === 1 &&
    x1.fx === 1 && x1.param === Math.round(1200 * Math.log2(2 ** (8 / 768))) && xm.patterns[0].cells[0][8].off,
    'XM: the key map picks the sample, the volume column, a linear slide in cents, key off');
  const hw = xm.waves[1], hv = (k) => { const v = hw.data[2 * k] | hw.data[2 * k + 1] << 8; return v >= 0x8000 ? v - 0x10000 : v; };
  check(hw.format === 0 && hw.frames === 8 && hw.loopStart === 2 && hw.loopLength === 6 && json([0, 1, 2, 3, 4, 5, 6, 7].map(hv)) ===
    json([0, 1000, 2000, 3000, 4000, 3000, 4000, 3000]) && xm.waves[0].data[2] === 80,
    'XM: delta samples decoded, a ping-pong loop unrolled forward (2 3 4 5 4 3 …)');
  const fl = (s, ch) => { const song = R.compileSong(s).song; return R.flattenChannel(song, new DataView(song.buffer).getUint32(28 + 4 * ch, true)); };
  const e0 = [...fl(xmx, 0).events].sort((a, b) => a[0] - b[0]), vols = e0.flatMap(([t, c]) => c.filter((e) => e.op === R.CH.VOLUME).map((e) => [t, e.args[0]]));
  const after = vols.filter(([t]) => t > 48 && t < 192).map(([, v]) => v);   // the first pass (the order plays the pattern twice)
  check(vols.some(([t, v]) => t < 48 && v < vols[0][1]) && after.length > 3 && after.every((v, k) => !k || v <= after[k - 1]) && after[after.length - 1] < after[0],
    'XM exact: the envelope falls to its sustain, then after key off fades');
  const bends = [...fl(xmx, 1).events].filter(([t]) => t > 0 && t < 6).map(([t, c]) => [t, (c.find((e) => e.op === R.CH.BEND) || {}).args]);
  const cents = (a) => ((a[0] | a[1] << 8) << 16 >> 16);
  check(bends.length === 5 && bends.every(([t, a]) => a && Math.abs(cents(a) - Math.round(t * 1200 * 8 / 768)) <= 1),
    'XM exact: a linear slide of 2 rises 12.5 cents a tick');
  check(json(moduleNotes(xm, 4000)) === json(moduleNotes(xmx, 4000)), 'XM: best effort and exact play the same notes at the same times');
  for (const [sg, what] of [[s3, 'S3M best effort'], [s3x, 'S3M exact'], [xm, 'XM best effort'], [xmx, 'XM exact']]) {
    const out = R.writeSong(sg);
    check(same(R.writeSong(R.readSong(out.buffer)), out), `${what}: written and read back stably`);
  }
}
// 10. an Impulse Tracker module, made here: instrument mode, linear pitch, two compressed samples
{
  const I = new Uint8Array(4096), idv = new DataView(I.buffer), w16 = (o, v) => idv.setUint16(o, v, true), w32 = (o, v) => idv.setUint32(o, v, true);
  I.set(Buffer.from('IMPM'), 0); I.set(Buffer.from('IT test'), 4);
  w16(0x20, 2); w16(0x22, 1); w16(0x24, 2); w16(0x26, 1); w16(0x28, 0x0214); w16(0x2A, 0x0214); w16(0x2C, 1 | 4 | 8);
  I[0x30] = 128; I[0x31] = 48; I[0x32] = 6; I[0x33] = 125;
  for (let c = 0; c < 64; c++) { I[0x40 + c] = c === 0 ? 0 : c === 1 ? 64 : 128 | 32; I[0x80 + c] = 64; }
  I[0xC0] = 0; I[0xC1] = 255;
  const INS = 0x100, SMP1 = 0x400, SMP2 = 0x450, PAT = 0x500, DATA1 = 0x700, DATA2 = 0x780;
  w32(0xC2, INS); w32(0xC6, SMP1); w32(0xCA, SMP2); w32(0xCE, PAT);
  // the instrument: below C-5 sample 1, from C-5 sample 2; a volume envelope with a sustain point; fade-out
  I.set(Buffer.from('IMPI'), INS); w16(INS + 0x14, 64); I[INS + 0x18] = 128; I.set(Buffer.from('lead'), INS + 0x20);
  for (let n = 0; n < 120; n++) { I[INS + 0x40 + 2 * n] = n; I[INS + 0x41 + 2 * n] = n < 60 ? 1 : 2; }
  I[INS + 0x130] = 1 | 4; I[INS + 0x131] = 3; I[INS + 0x134] = 1; I[INS + 0x135] = 1;
  [[64, 0], [48, 4], [0, 20]].forEach(([v, t], k) => { I[INS + 0x136 + 3 * k] = v; w16(INS + 0x137 + 3 * k, t); });
  // sample 1: 8-bit IT 2.14, its stream switching width 9 -> 8 -> 7 -> 5 -> 4 (all three escape methods)
  const v8 = [0, 40, 80, 40, 0, -10, -20, -10, -5, 0];
  const bits = [], put = (v, n) => { for (let k = 0; k < n; k++) bits.push((v >> k) & 1); };
  put(0, 9); put(40, 9); put(0x107, 9);                          // width 9; then 0x100 | 7: width 8
  put(40, 8); put(216, 8); put(123 + 7, 8);                       // -40; then the band above 123: width 7
  put(88, 7); put(59 + 5, 7);                                     // -40; width 5
  put(22, 5); put(22, 5); put(10, 5); put(16, 5); put(3, 3);      // -10 -10 10; then 1 << 4 and 3 + 1: width 4
  put(5, 4); put(5, 4);
  const packed = Uint8Array.from({ length: Math.ceil(bits.length / 8) }, (_, k) => bits.slice(8 * k, 8 * k + 8).reduce((a, b, i) => a | b << i, 0));
  w16(DATA1, packed.length); I.set(packed, DATA1 + 2);
  const smp = (o, name, flg, cvt, vol, gvl, len, ls, le, c5, at) => {
    I.set(Buffer.from('IMPS'), o); I[o + 0x11] = gvl; I[o + 0x12] = flg; I[o + 0x13] = vol; I.set(Buffer.from(name), o + 0x14);
    I[o + 0x2E] = cvt; w32(o + 0x30, len); w32(o + 0x34, ls); w32(o + 0x38, le); w32(o + 0x3C, c5); w32(o + 0x48, at);
  };
  smp(SMP1, 'low', 1 | 8, 1, 64, 64, v8.length, 0, 0, 8363, DATA1);
  // sample 2: 16-bit IT 2.15 (deltas of deltas) at width 17, half its global volume, a ping-pong loop, twice the rate
  const v16 = [0, 1000, 2000, 3000, 4000, 3000, 2000, 1000], e16 = [0, 1000, 0, 0, 0, -2000, 0, 0];
  bits.length = 0; for (const e of e16) put(e & 0xFFFF, 17);
  const packed2 = Uint8Array.from({ length: Math.ceil(bits.length / 8) }, (_, k) => bits.slice(8 * k, 8 * k + 8).reduce((a, b, i) => a | b << i, 0));
  w16(DATA2, packed2.length); I.set(packed2, DATA2 + 2);
  smp(SMP2, 'high', 1 | 2 | 8 | 16 | 64, 1 | 4, 48, 32, v16.length, 2, 6, 16726, DATA2);
  // the pattern: 32 rows, 2 channels
  const cellsIt = { 0: [[48, 1, 50, 0, 0], [60, 1, 255, 6, 2]], 4: [null, null], 8: [[255, 0, 255, 0, 0], null], 12: [null, [254, 0, 255, 0, 0]], 16: [null, [64, 1, 255, 0, 0]] };
  cellsIt[4][0] = [-1, 0, 255, 22, 128];                         // V80: global volume (all of it)
  const pd = [];
  for (let r = 0; r < 32; r++) {
    (cellsIt[r] || []).forEach((cl, c) => {
      if (!cl) return;
      const [n, ins, vp, cmd, prm] = cl, mask = (n >= 0 ? 1 : 0) | (ins ? 2 : 0) | (vp !== 255 ? 4 : 0) | (cmd ? 8 : 0);
      pd.push((c + 1) | 128, mask);
      if (n >= 0) pd.push(n); if (ins) pd.push(ins); if (vp !== 255) pd.push(vp); if (cmd) pd.push(cmd, prm);
    });
    pd.push(0);
  }
  w16(PAT, pd.length); w16(PAT + 2, 32); I.set(pd, PAT + 8);
  const ib = I.buffer.slice(0), it = R.readTracked(ib), itx = R.readTracked(ib, { exact: true });
  check(R.isIt(I) && it.channels === 2 && it.name === 'IT test' && it.patterns[0].rows === 32 && json(it.order) === json([0]) &&
    it.instruments.length === 2 && it.instruments[0].name === 'lead: low' && it.instruments[1].name === 'lead: high',
    'IT: channels, name, order, an instrument with two samples is two instruments');
  const iw0 = it.waves[0], s8 = [...iw0.data].map((v) => (v << 24) >> 24);
  check(iw0.format === 1 && json(s8) === json(v8) && iw0.rate === 8363, 'IT: an IT 2.14 sample unpacked through all three width changes, its C-5 rate');
  const iw1 = it.waves[1], h16 = (k) => (iw1.data[2 * k] | iw1.data[2 * k + 1] << 8) << 16 >> 16;
  check(iw1.format === 0 && iw1.frames === 8 && iw1.loopStart === 2 && iw1.loopLength === 6 && iw1.rate === 16726 &&
    json([0, 1, 2, 3, 4, 5, 6, 7].map(h16)) === json([0, 500, 1000, 1500, 2000, 1500, 2000, 1500]),
    'IT: an IT 2.15 16-bit sample unpacked, its global volume applied, a ping-pong loop unrolled');
  const i0 = it.patterns[0].cells[0][0], i1 = it.patterns[0].cells[1][0], cut = it.patterns[0].cells[1][12];
  check(i0.note === 48 && i0.inst === 0 && i0.vol === Math.round(255 * Math.sqrt(50 / 64)) && i1.note === 60 && i1.inst === 1 &&
    i1.fx === 1 && i1.param === Math.round(1200 * Math.log2(2 ** (8 / 768))) && it.patterns[0].cells[0][8].off && cut.off && cut.vol === 0,
    'IT: the key map picks the sample, the volume column, a linear slide in cents, note off and note cut');
  check(i0.raw.some((r) => r[0] === R.CH.POSITION && r[1] === 0x80) && i1.raw.some((r) => r[0] === R.CH.POSITION && r[1] === 127),
    'IT: the channels\' pans');
  const flI = (s, ch) => { const song = R.compileSong(s).song; return R.flattenChannel(song, new DataView(song.buffer).getUint32(28 + 4 * ch, true)); };
  const ev = [...flI(itx, 0).events].sort((a, b) => a[0] - b[0]), iv = ev.flatMap(([t, c]) => c.filter((e) => e.op === R.CH.VOLUME).map((e) => [t, e.args[0]]));
  const rel = iv.filter(([t]) => t > 48).map(([, v]) => v);
  check(iv.some(([t, v]) => t < 48 && v < iv[0][1]) && rel.length > 3 && rel.every((v, k) => !k || v <= rel[k - 1]) && rel[rel.length - 1] < rel[0],
    'IT exact: the envelope falls to its sustain, then after note off fades');
  check(json(moduleNotes(it, 4000)) === json(moduleNotes(itx, 4000)), 'IT: best effort and exact play the same notes at the same times');
  check(json(it.lost) === json([]) && json(itx.lost) === json([]), 'IT: nothing left out of a module that fits');
  const wideIt = I.slice(), wd = new DataView(wideIt.buffer), wp = [];   // the same module with notes on 20 channels
  for (let c = 0; c < 64; c++) wideIt[0x40 + c] = c < 20 ? 32 : 128 | 32;
  for (let c = 0; c < 20; c++) wp.push((c + 1) | 128, 1 | 2, 48 + (c % 12), 1);
  wp.push(0); for (let r = 1; r < 32; r++) wp.push(0);
  wd.setUint16(PAT, wp.length, true); wideIt.set(wp, PAT + 8);
  const wi = R.readTracked(wideIt.buffer), wix = R.readTracked(wideIt.buffer, { exact: true });
  check(wi.channels === 16 && wi.lost.length === 2 && /^The song is rearranged/.test(wi.lost[0]) && /^4 notes left out where more than 16 sounded at once/.test(wi.lost[1]) &&
    json(wix.lost) === json(wi.lost), 'IT: 20 notes at once on 20 channels: 16 kept, what is left out told to the user');
  // 20 channels taking turns (a note each, then off): packed onto fewer channels, nothing lost, each note with its pan
  const turn = (cellsAt) => {
    const b = I.slice(), bd = new DataView(b.buffer), q = [];
    for (let c = 0; c < 64; c++) b[0x40 + c] = c < 20 ? (c * 3) % 65 : 128 | 32;
    for (let r = 0; r < 32; r++) { for (const [c, n, vp] of cellsAt(r)) q.push((c + 1) | 128, n === 255 ? 1 | 4 : 1 | 2 | 4, n, ...(n === 255 ? [64] : [1, vp])); q.push(0); }
    bd.setUint16(PAT, q.length, true); b.set(q, PAT + 8); return b.buffer;
  };
  const tb = turn((r) => (r < 20 ? [[r, 60 + r, 64]] : []).concat(r && r <= 20 ? [[r - 1, 255]] : []));
  const tp = R.readTracked(tb), tpx = R.readTracked(tb, { exact: true });
  const tn = [], tpan = [];
  tp.patterns[0].cells.forEach((col) => col.forEach((c, r) => { if (c && c.note !== null) { tn.push(c.note); const pr = c.raw.find((x) => x[0] === R.CH.POSITION && r > 0); if (pr) tpan.push(pr[1]); } }));
  check(tp.channels < 16 && tp.lost.length === 1 && new RegExp(`^The song is rearranged .*20 channels are packed into ${tp.channels},`).test(tp.lost[0]) &&
    json(tn.sort((x, y) => x - y)) === json(Array.from({ length: 20 }, (_, k) => 60 + k)) &&
    tpan.length >= 19 && json(moduleNotes(tp, 4000)) === json(moduleNotes(tpx, 4000)),
    'IT: 20 channels taking turns packed onto fewer, every note kept with its channel\'s pan, best effort and exact alike');
  // 16 held notes, then at row 2 an echo of one of them and a new note: the echo is the one left out
  const eb = turn((r) => (r === 0 ? Array.from({ length: 16 }, (_, c) => [c, 60 + c, 64]) : r === 2 ? [[16, 60, 32], [17, 90, 64]] : []));
  const ep = R.readTracked(eb), row2 = ep.patterns[0].cells.map((col) => col[2]).filter((c) => c && c.note !== null).map((c) => c.note);
  check(ep.channels === 16 && json(row2) === json([90]) && /^1 note left out/.test(ep.lost[1] || ''),
    'IT: with all 16 channels sounding, a new note takes a channel and the echo is left out');
  for (const [sg, what] of [[it, 'IT best effort'], [itx, 'IT exact']]) {
    const out = R.writeSong(sg);
    check(same(R.writeSong(R.readSong(out.buffer)), out), `${what}: written and read back stably`);
  }
}
console.log(`${checks - failed}/${checks} checks passed`);
process.exit(failed ? 1 : 0);
