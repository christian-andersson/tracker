#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Convert a tracker module into a RetCon song (.rsng, the RetCon song format),
// with the same code the web tracker opens modules with: a ProTracker-style
// .mod (M.K., M!K!, FLT4, xCHN, xxCH; src/mod.js), a Scream Tracker 3 .s3m, a
// FastTracker 2 .xm or an Impulse Tracker .it (src/tracked.js); a module with more than 16 channels is packed onto 16:
//
//     node converters/mod2rsng.js tune.mod [-o tune.rsng] [--exact]
//          [--name TEXT] [--auth TEXT] [--licn TEXT] [--desc TEXT]
//
// Each sample becomes an instrument playing it (without smoothing, as the
// trackers did; an XM or IT instrument with several samples becomes one each). By default the module's own patterns and order are kept,
// its effects on the tracker's effect column where there is one (the ones
// that cannot be are listed). --exact plays it the way ProTracker does, tick
// by tick (speed, tempo, breaks, jumps, loops, delays, slides, vibrato,
// arpeggio, finetune...), on one tick a row. The module's loop (a jump back)
// is the song's loop.
//
// A converted song keeps the licence of the music it came from: pass it with
// --licn so it ends up in the song's LICN chunk.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import R from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const USAGE = 'usage: node converters/mod2rsng.js tune.mod [-o tune.rsng] [--exact]\n' +
  '       [--name TEXT] [--auth TEXT] [--licn TEXT] [--desc TEXT]';

function main(argv) {
  const opt = {};
  let input = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], val = () => { if (i + 1 >= argv.length) die(`${a} needs a value`); return argv[++i]; };
    if (a === '-h' || a === '--help') { console.log(USAGE); return; }
    else if (a === '-o' || a === '--output') opt.output = val();
    else if (['--name', '--auth', '--licn', '--desc'].includes(a)) opt[a.slice(2)] = val();
    else if (a === '--exact') opt.exact = true;
    else if (a.startsWith('-')) die(`unknown option ${a}\n${USAGE}`);
    else if (input === null) input = a;
    else die(USAGE);
  }
  if (input === null) die(USAGE);
  const b = fs.readFileSync(input);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length), head = new Uint8Array(ab);
  const read = R.isXm(head) || R.isS3m(head) || R.isIt(head) ? R.readTracked : R.isMod(head) ? R.readMod : null;
  if (!read) die(`${input}: not a module this reads (MOD, S3M, XM or IT)`);
  const song = read(ab, { exact: !!opt.exact });
  song.name = opt.name || song.name || path.basename(input).replace(/\.[^.]+$/, '');
  if (opt.auth) song.auth = opt.auth;
  if (opt.licn) song.licn = opt.licn;
  if (opt.desc) song.desc = opt.desc;
  const out = opt.output || input.replace(/\.[^.]+$/, '') + '.rsng';
  const bytes = R.writeSong(song);
  R.readContainer(bytes.buffer, 'RSNG');           // a valid container, or it throws
  fs.writeFileSync(out, bytes);
  for (const line of song.lost || []) console.error(`warning: ${line}`);
  const used = song.waves.filter((w) => w.frames).length;
  console.log(`${input}: ${song.channels} channels, ${song.order.length} positions, ${song.patterns.length} patterns` +
    `${song.loop >= 0 ? `, loops to position ${song.loop}` : ''}`);
  for (const n of song.notes) console.log('  ' + n);
  console.log(`  ${out}: ${bytes.length} bytes (${used} samples, ${song.ticksPerRow} ticks a row)`);
}

function die(msg) { console.error('mod2rsng: ' + msg); process.exit(1); }

try { main(process.argv.slice(2)); } catch (e) { die(e.message); }
