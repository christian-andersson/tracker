#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Serve the built pages over http on this computer only, to try them as a
// web server delivers them (audio in an AudioWorklet rather than the page
// fallback used from disk):
//
//     node scripts/serve.mjs [dir] [port]        (npm run serve)
//
// dir defaults to dist, port to 8000: http://127.0.0.1:8000/

import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));   // scripts/ is one below the root
const dir = path.resolve(process.argv[2] || path.join(ROOT, 'dist'));
const port = +(process.argv[3] || 8000);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json', '.rsng': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8' };

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(dir, url.endsWith('/') ? url + 'index.html' : url);
  if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`serving ${dir} at http://127.0.0.1:${port}/`));
