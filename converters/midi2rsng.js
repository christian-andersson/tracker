#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Convert a Standard MIDI File (.mid, type 0 or 1) into a RetCon song
// (.rsng, the RetCon song format), with the same code the web tracker opens
// MIDI files with (src/midi.js):
//
//     node converters/midi2rsng.js tune.mid [-o tune.rsng] [--name TEXT] [--auth TEXT]
//          [--licn TEXT] [--desc TEXT] [--tver TEXT] [--loop] [--exact]
//          [--patch TRACK=PROGRAM ...] [--drop TRACK ...] [--list]
//
// How it converts:
//   - Each track (and MIDI channel within it) with notes is a part. Its
//     General MIDI program comes from --patch, else from its program change,
//     else from its track name ("bass", "pad", "lead", ...); a program 0
//     gives way to the name, as some generators (AIVA) leave every track on
//     0. MIDI channel 10 is drums, each note the bank's drum for it.
//     --patch 3=48 sets one, --patch 3=drums plays a track as drums.
//   - The instruments are DMXOPL3's (banks/dmxopl3/, MIT licence): the
//     song holds the ones it uses, and the bank's notice goes into LICN.
//   - A song channel plays one note at a time, so a part gets as many
//     channels as it has notes sounding at once, drums a channel per kind
//     (kick, snare, hats, toms, cymbals, percussion). At most 16 channels;
//     what does not fit is dropped, fewest notes first, and listed. Tracks
//     with the same notes as an earlier one are dropped as duplicates.
//   - Velocity (plus the instrument's offset) times the channel's volume
//     (CC 7) and expression (CC 11) sets a note's volume, and a change of
//     those while it sounds changes it; pan (CC 10) sets the channel's
//     position. Pitch bend, sustain pedal and later pan changes are counted
//     and left out.
//   - Time: ticks per beat is the smallest of 24, 48 or 96 that holds every
//     note exactly (else 96, rounded); tempo changes are kept. The song is
//     laid out as the tracker's patterns: on the row grid nearly every note
//     falls on, or with --exact one tick a row.
//   - The song plays once; --loop plays it again from the start.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import R from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const BANK = path.join(HERE, '..', 'banks', 'dmxopl3', 'DMXOPL3-by-sneakernets-GS.wopl');
const USAGE = 'usage: node converters/midi2rsng.js tune.mid [-o tune.rsng] [--name TEXT] [--auth TEXT]\n' +
  '       [--licn TEXT] [--desc TEXT] [--tver TEXT] [--loop] [--exact] [--patch TRACK=PROGRAM ...] [--drop TRACK ...] [--list]';

function main(argv) {
  const opt = { patch: {}, drop: [] };
  let input = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], val = () => { if (i + 1 >= argv.length) die(`${a} needs a value`); return argv[++i]; };
    if (a === '-h' || a === '--help') { console.log(USAGE); return; }
    else if (a === '-o' || a === '--output') opt.output = val();
    else if (['--name', '--auth', '--licn', '--desc', '--tver'].includes(a)) opt[a.slice(2)] = val();
    else if (a === '--loop') opt.loop = true;
    else if (a === '--exact') opt.exact = true;
    else if (a === '--list') opt.list = true;
    else if (a === '--patch') {
      const [k, v] = val().split('=');
      if (!/^\d+$/.test(k) || !(v === 'drums' || (/^\d+$/.test(v) && +v < 128)))
        die('--patch: expected TRACK=PROGRAM (0-127, General MIDI) or TRACK=drums');
      opt.patch[+k] = v === 'drums' ? v : +v;
    } else if (a === '--drop') opt.drop.push(+val());
    else if (a.startsWith('-')) die(`unknown option ${a}\n${USAGE}`);
    else if (input === null) input = a;
    else die(USAGE);
  }
  if (input === null) die(USAGE);
  const ab = (f) => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
  const bank = R.gmBank(ab(BANK)), mid = ab(input);
  const m = R.midiChannels(mid, bank, opt);
  const seconds = (() => {                       // the length, following the tempo changes
    let s = 0, at = 0, bpm = m.tempos[0][1];
    const end = Math.max(...m.flat.map((f) => f.endTick));
    for (const [mt, b] of m.tempos.slice(1)) {
      const t = Math.round(mt * m.tpb / m.div);
      if (t >= end) break;
      s += (t - at) * 60 / (bpm * m.tpb); at = t; bpm = b;
    }
    return s + (end - at) * 60 / (bpm * m.tpb);
  })();
  console.log(`${input}: ${Math.round(m.bpm)} bpm, ${m.div} MIDI ticks a beat -> ${m.tpb} song ticks` +
    `${m.rounded ? ' (rounded)' : ''}, ${seconds.toFixed(1)} s`);
  for (const p of m.parts) {
    const n = p.channels.reduce((k, c) => k + c.length, 0);
    console.log(`  ${p.label}: ${p.insts.map((i) => bank.instruments[i].name).join(', ')}, ${n} notes on ${p.channels.length} channel(s)`);
  }
  for (const x of m.msgs) console.log('  ' + x);
  const ignored = Object.entries(m.ignored);
  if (ignored.length) console.log('  ignored: ' + ignored.sort().map(([k, v]) => `${k} x${v}`).join(', '));
  if (opt.list) return;

  const song = R.keepUsedInstruments(R.readMidi(mid, Object.assign({}, opt, { bank })));
  song.name = opt.name || path.basename(input).replace(/\.[^.]+$/, '');
  song.auth = opt.auth || '';
  song.desc = opt.desc || song.desc;
  song.tver = opt.tver || '';
  song.licn = (opt.licn ? opt.licn + '\n' : '') + R.BANK_NOTICE;
  if (opt.loop) song.loop = 0;
  const out = opt.output || input.replace(/\.[^.]+$/, '') + '.rsng';
  const bytes = R.writeSong(song);
  R.readContainer(bytes.buffer, 'RSNG');           // a valid container, or it throws
  fs.writeFileSync(out, bytes);
  for (const line of song.lost || []) console.error(`warning: ${line}`);
  console.log(`  ${out}: ${bytes.length} bytes (${song.channels} channels, ${song.instruments.length} instruments, ` +
    `${song.patterns.length} patterns, ${song.ticksPerRow} ticks a row)`);
}

function die(msg) { console.error('midi2rsng: ' + msg); process.exit(1); }

try { main(process.argv.slice(2)); } catch (e) { die(e.message); }
