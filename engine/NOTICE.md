# player.wasm

`player.wasm` is a prebuilt WebAssembly build of the RetCon audio engine:
the console's built-in audio driver (synth and song player) and its stereo
mixer. The tracker page runs it to play songs.

- **Source:** not published. The engine's source is part of the RetCon
  console project and is not open source yet.
- **Terms:** `player.wasm` is not covered by this repository's GPL-3.0
  licence. It may be used, and redistributed unmodified, as part of this
  tracker or of a modified version of it. All other rights are reserved.
  Copyright the RetCon authors.
- **This build:** SHA-256 `7ee0958ee7f0a714a43a751e54543ec435f5b809fafd02aacf585cdada6099d8`. It exports `rp_init`, `rp_render` and
  the rest of the calls `page/player-worklet.js` makes, which shows how it is
  driven.

To update it, replace this file with a newer build from RetCon and run
`npm test` and `npm run build`.
