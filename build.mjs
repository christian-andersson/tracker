#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Build the tracker as one self-contained page that opens straight from disk
// (where browsers load no module files and no worklet modules) or from any
// static host:
//
//     node build.mjs [player.wasm] [out dir]        (npm run build)
//
// dist/index.html is tracker.html with the audio worklet, the engine
// (engine/player.wasm, a prebuilt binary: engine/NOTICE.md), the song
// library and the General MIDI instrument bank inlined; the bank's licence
// is copied beside it. The song library is src/, ES modules: bundle() joins
// them, in the order index.js imports them, into one script that sets
// globalThis.RSNG. The modules keep to a form this can join without a
// bundler: one-line `import { ... } from './x.js'`, and `export` only in
// front of top-level declarations (names unique across src/).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const BANK_DIR = path.join(ROOT, 'banks', 'dmxopl3'), BANK = path.join(BANK_DIR, 'DMXOPL3-by-sneakernets-GS.wopl');

// src/ as one classic script: the modules in the order index.js imports them, then index.js.
export function bundle() {
  const index = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
  const order = [...index.matchAll(/^import \{[^}]*\} from '\.\/([\w-]+)\.js';$/gm)].map((m) => m[1]).concat('index');
  const parts = order.map((name) => {
    const text = fs.readFileSync(path.join(SRC, name + '.js'), 'utf8');
    for (const line of text.split('\n'))
      if (/^\s*(import|export)\b/.test(line) && !/^import \{[^}]*\} from '\.\/[\w-]+\.js';$/.test(line) &&
          !/^export (function|const|let|class) /.test(line) && line !== 'export default RSNG;')
        throw new Error(`src/${name}.js: "${line.trim()}" is not a form build.mjs can join`);
    const body = text.split('\n')
      .filter((l) => !/^import \{[^}]*\} from '\.\/[\w-]+\.js';$/.test(l) && l !== 'export default RSNG;')
      .map((l) => l.replace(/^export (function|const|let|class) /, '$1 '))
      .join('\n');
    return `// ---- src/${name}.js\n${body}`;
  });
  return `(function () {\n'use strict';\n${parts.join('\n')}\nglobalThis.RSNG = RSNG;\n})();\n`;
}

// The page with its placeholders filled; </ is written <\/ so nothing ends the script early.
function page(file, fills) {
  let html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const [marker, value] of fills) {
    if (html.split(marker).length !== 2) throw new Error(`${file} must hold ${marker} once`);
    html = html.replace(marker, () => value.replace(/<\//g, '<\\/'));
  }
  return html;
}

function main() {
  const wasm = process.argv[2] || path.join(ROOT, 'engine', 'player.wasm');
  const out = process.argv[3] || path.join(ROOT, 'dist');
  if (!fs.existsSync(wasm)) throw new Error(`${wasm} is missing`);
  const html = page('tracker.html', [
    ['/*WORKLET_SRC*/""', JSON.stringify(fs.readFileSync(path.join(ROOT, 'player-worklet.js'), 'utf8'))],
    ['/*WASM_B64*/""', JSON.stringify(fs.readFileSync(wasm).toString('base64'))],
    ['/*RSNG_JS*/', bundle()],
    ['/*BANK_B64*/""', JSON.stringify(fs.readFileSync(BANK).toString('base64'))]]);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'index.html'), html);
  fs.copyFileSync(path.join(BANK_DIR, 'LICENSE'), path.join(out, 'DMXOPL3-LICENSE.txt'));
  console.log(`${path.join(out, 'index.html')}: ${Buffer.byteLength(html)} bytes`);
}

const direct = (() => { try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (direct) {
  try { main(); } catch (e) { console.error('build.mjs: ' + e.message); process.exit(1); }
}
