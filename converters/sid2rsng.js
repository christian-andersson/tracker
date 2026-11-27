#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Convert a C64 SID tune (.sid, PSID or RSID) into a RetCon song (.rsng, the
// RetCon song format), with the same code the web tracker opens SID tunes
// with (src/sid.js, src/c64.js):
//
//     node converters/sid2rsng.js tune.sid [-o tune.rsng] [--song N] [--seconds S] [--exact]
//          [--name TEXT] [--auth TEXT] [--licn TEXT] [--desc TEXT]
//
// The tune runs on an emulated C64 and what it writes to the SID chip is
// turned into a song: each voice a channel, each note struck at the nearest
// pitch with bends for what the pitch does after, each sound an instrument,
// and samples played through the volume register on a channel of their own.
// Unless --seconds is given, the tune runs for up to 10 minutes and ends
// where it starts repeating itself (the song's loop) or falls silent.
// --song picks a subtune (1-based; the file's start song by default).
//
// The SID header names the author, not a licence: pass the composer's terms
// with --licn so they end up in the song's LICN chunk.

import fs from 'fs';
import R from '../src/index.js';

const USAGE = 'usage: node converters/sid2rsng.js tune.sid [-o tune.rsng] [--song N] [--seconds S] [--exact]\n' +
  '       [--name TEXT] [--auth TEXT] [--licn TEXT] [--desc TEXT]';

function main(argv) {
  const opt = {};
  let input = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], val = () => { if (i + 1 >= argv.length) die(`${a} needs a value`); return argv[++i]; };
    const num = () => { const v = Number(val()); if (!(v > 0)) die(`${a} needs a number above 0`); return v; };
    if (a === '-h' || a === '--help') { console.log(USAGE); return; }
    else if (a === '-o' || a === '--output') opt.output = val();
    else if (['--name', '--auth', '--licn', '--desc'].includes(a)) opt[a.slice(2)] = val();
    else if (a === '--song') opt.song = Math.round(num());
    else if (a === '--seconds') opt.seconds = num();
    else if (a === '--exact') opt.exact = true;
    else if (a.startsWith('-')) die(`unknown option ${a}\n${USAGE}`);
    else if (input === null) input = a;
    else die(USAGE);
  }
  if (input === null) die(USAGE);
  const b = fs.readFileSync(input);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
  if (!R.isSid(new Uint8Array(ab))) die(`${input}: not a SID tune (PSID or RSID)`);
  const tune = R.readSidFile(ab);
  if (opt.song && opt.song > tune.songs) die(`${input} has ${tune.songs} songs`);
  const song = R.readSid(ab, { exact: !!opt.exact, song: opt.song, seconds: opt.seconds });
  if (opt.name) song.name = opt.name;
  if (opt.auth) song.auth = opt.auth;
  if (opt.licn) song.licn = opt.licn;
  if (opt.desc) song.desc = opt.desc;
  const out = opt.output || input.replace(/\.[^.]+$/, '') + '.rsng';
  const bytes = R.writeSong(song);
  R.readContainer(bytes.buffer, 'RSNG');           // a valid container, or it throws
  fs.writeFileSync(out, bytes);
  for (const line of song.lost || []) console.error(`warning: ${line}`);
  console.log(`${input}: ${song.name || '(no name)'}${song.auth ? ' by ' + song.auth : ''}, ${song.channels} channels, ` +
    `${song.order.length} positions, ${song.patterns.length} patterns${song.loop >= 0 ? `, loops to position ${song.loop}` : ''}`);
  for (const n of song.notes) console.log('  ' + n);
  console.log(`  ${out}: ${bytes.length} bytes (${song.instruments.length} instruments, ${song.waves.length} samples, ${song.ticksPerRow} ticks a row)`);
}

function die(msg) { console.error('sid2rsng: ' + msg); process.exit(1); }

try { main(process.argv.slice(2)); } catch (e) { die(e.message); }
