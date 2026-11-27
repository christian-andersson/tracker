# RetCon tracker

A pattern tracker for RetCon songs (`.rsng`) that runs in the browser: write,
open, play and save songs, and open MIDI files and tracker modules (MOD, S3M,
XM, IT), converted on opening. Files are read in the browser and never
uploaded.

**Live:** https://christian-andersson.github.io/tracker/

The page runs the RetCon console's own audio engine (its built-in audio
driver, synth and song player, and its stereo mixer) as WebAssembly
(`engine/player.wasm`), so songs sound as they do on the console. Served over
http the engine runs in an `AudioWorklet` (`player-worklet.js`); opened from
disk, where browsers refuse worklet modules, the same code runs on the page
through a `ScriptProcessorNode`.

## The project

A Node project with no dependencies (Node 24.22.1 or later):

| Path | What it is |
| --- | --- |
| `tracker.html`, `player-worklet.js` | the page and the audio thread |
| `src/` | the song library, ES modules: the chunk container and song commands (`format.js`), samples and wavetables (`waves.js`), tracker songs, compiling and reading back (`song.js`), the start state of a position (`chase.js`), ProTracker modules (`mod.js`), Scream Tracker 3, FastTracker 2 and Impulse Tracker modules (`tracked.js`), the General MIDI bank (`wopl.js`), MIDI files (`midi.js`); `index.js` gathers them as one object |
| `converters/` | `midi2rsng.js` and `mod2rsng.js`: MIDI files and modules (MOD, S3M, XM, IT) to `.rsng` from the command line, on the same library |
| `engine/player.wasm` | the audio engine, prebuilt (see [Licences](#licences)) |
| `banks/dmxopl3/` | the General MIDI instruments (DMXOPL3, MIT) |
| `build.mjs` | builds `dist/index.html`: the page with the engine, the worklet, the library (its modules joined into one script) and the bank inlined |
| `serve.mjs` | serves `dist/` on `127.0.0.1` to try the page over http |
| `test/` | the tests, with the Martin Galway songs they read (`test/fixtures/martin-galway/`) |
| `.github/workflows/pages.yml` | tests every push and pull request; on `main`, builds the page and publishes it to GitHub Pages |

```sh
npm test                                     # the tests
npm run build                                # dist/index.html, which opens straight from disk
npm run serve                                # http://127.0.0.1:8000/
npm run midi2rsng -- tune.mid -o tune.rsng   # a MIDI file to a song
npm run mod2rsng -- tune.it -o tune.rsng     # a module (MOD, S3M, XM, IT) to a song; --exact plays it tick by tick
```

The library's modules keep to a form `build.mjs` joins without a bundler:
one-line `import { ... } from './x.js'`, `export` only in front of
top-level declarations, and top-level names unique across `src/`.

## The tracker

- **Songs are ordinary `.rsng` files.** A tracker song is written in a fixed
  shape: each pattern of each channel is one phrase (rows of commands and
  waits, then `CH_RETURN`), and each channel's stream calls them in the order
  list's order, with `CH_LOOP` / `CH_LOOP_END` around the part that loops.
  Every player plays it like any other song.
- **`xTRK`** is the tracker's private chunk (in the RetCon chunk container, tags
  starting with `x` are private, and readers skip them). It holds what the
  song data cannot: ticks per row, rows per beat, each pattern's rows and
  name, the order list, the loop position and the instruments' names, as
  JSON. With it, opening a song is exact.
- **Songs without `xTRK`** (made by the converters) open best effort: their
  commands laid on the largest row grid nearly every note falls on, in
  patterns of 64 rows, equal patterns shared. A command between rows moves
  to the nearest one. **Exact import** lays them on one tick a row instead,
  so they sound exactly as before, in long patterns.
- **ProTracker modules** (`.mod`, 1 to 99 channels) open too, converted
  on opening. Best effort keeps the module's patterns, order and loop
  (`Bxx`), its effects on the effect column where there is one or as extra
  commands (`8xx`, `9xx`), and lists the ones it cannot carry over. Exact
  import plays it as ProTracker does, tick by tick, on one tick a row.
  `converters/mod2rsng.js` converts modules with the same
  code. Each sample is an instrument playing it on Op 4, without
  smoothing as on the Amiga. A converted song is saved as a new `.rsng`.
- **Scream Tracker 3** (`.s3m`) and **FastTracker 2** (`.xm`) modules open
  the same way (`src/tracked.js`), S3M's effects read as their XM equals.
  Each sample is an instrument (an XM instrument with several samples,
  one each, the key map picking the right one per note); 8- and 16-bit
  samples, XM's ping-pong loops unrolled forward. Best effort keeps the
  patterns and order, fits an XM instrument's volume envelope to the
  operator's attack, decay, sustain and release, and lists what it cannot
  carry over; exact import plays the module tick by tick, envelopes,
  fade-out, linear or Amiga pitch, global volume and panning included.
- **More than 16 channels** (common in XM and IT, and in MOD's `xxCH`): the song player has
  16, but a module rarely plays on all of its channels at once. Chords,
  doubled notes and echoes (the same note a few rows later on the next
  channel, quieter) each take a channel that is idle most of the time.
  So each pattern is cut into notes, from a note to the next note, note
  off or volume 0 on its channel, or to the end of a sample that does not
  loop, and the notes are packed onto 16 channels where they do not
  overlap, each with its own channel's pan and volume. Where more than 16
  sound at once, a note that has sounded a while gives way to a new one,
  and echoes, doubled notes and the inner voices of chords go before an
  instrument's leading note. Speed, tempo, breaks and jumps are kept.
- **Left out:** when an import cannot keep all of the music (module
  notes where more than 16 sound at once, MIDI notes beyond 16 channels,
  drums the kit has no sound for), the tracker says so in a notice on opening, and the converters
  print a warning for each.
- **Impulse Tracker** (`.it`) modules open the same way, in sample or
  instrument mode, with IT 2.14 and 2.15 compressed samples unpacked on
  opening, linear or Amiga pitch, volume and panning envelopes, sample and
  channel volumes. Not carried over, and listed: new note actions (a note
  cuts the one before), pitch and filter envelopes, sustain loops (held at
  their start), surround, panbrello and MIDI macros.
- **MIDI files** (`.mid`, type 0 and 1) open too. The instruments are
  always the 128 General MIDI programs (00-7F, by name) and then the drum
  kit, from DMXOPL3, an OPL3 bank (`banks/dmxopl3/`, MIT licence),
  which the page carries and `gmBank` turns into this synth's instruments.
  A part plays its program (a program 0 gives way to a track name that
  says "bass", "pad", ...), with its volume and expression, on as many
  channels as it has notes at once; then the notes are laid on rows like
  any song without tracker data. `converters/midi2rsng.js`
  converts MIDI files with the same code.
- **Columns:** note (or release), instrument, volume, one effect:
  `0xy` arpeggio, `1xx` / `2xx` pitch slide, `3xx` slide to the note,
  `4xy` vibrato, `Axy` volume slide, `Fxx` tempo. 0, 1, 2, 4 and A last for
  their row: the tracker writes a stop on the next row without them.
- **Extra commands:** commands a cell carries besides its columns: pitch
  bends and slides, vibrato, sweeps of an instrument byte or of the 16-bit
  width, patches, tuning, legato, position, a second note. An imported song
  keeps the ones no column holds this way, before or after the note as they
  were; the grid marks such a cell with a pink `*`. **Shift+Enter** or a
  double click opens the cell's extras: each command with named fields,
  placed before or after the note, to change, add, remove or reorder. Unlike
  the effect column, they last until changed, as in the song data.
- **Wavetables and samples:** an operator with wave `wavetable` or
  `sample` plays one of the song's waves (`SMPL`). The box under its
  fields picks one, draws a wavetable with the mouse (shapes, length,
  rounding to a chip's bits, smooth) or shows a sample with its loop (rate,
  root note, loop), and loads a sound file as a new sample. While a song is
  open, `src/waves.js` keeps the waves as a list and an operator's `data_offset`
  as the number of its wave; saving lays them out in `SMPL` again.
- **Help** (`? Help`, <kbd>F1</kbd>): what every instrument field does
  (also on hover over its name), the eight routing algorithms drawn from the
  synth's own table (click one to use it), and the columns, keys and play
  modes.
- **Playing from the middle** starts at once: the tracker works out what
  each channel has in force where each order position starts (`chase` in
  `src/chase.js`), the way the song player gets there: instrument, volume (with
  volume slides), note length, legato, tuning, position, vibrato, arpeggio,
  patches, running sweeps with their value and direction, a pending sample
  start, and the tempo. A play from a position begins each channel with the
  commands that set that up. **Play pattern** repeats the position with the
  same commands at the top of every turn (and stops the sweeps the pattern
  started), so every turn starts the same. A position's start is the end of
  the one before; it is worked out on loading and again only for positions
  whose pattern, or one before them, has changed. A note still sounding
  from the position before is not heard, as in other trackers.
  Changing BPM, ticks per beat or ticks per row while a song plays starts
  it again at the next row the same way, with the new timing (the notes
  sounding then are cut).

## Tests

`npm test` checks the library: a random song with every column and effect
is read back cell for cell and written again byte for byte the same, and
every song in `test/fixtures/martin-galway/` opens, best effort and exact,
and stays the same when written and read again; its chase, after a pattern
is edited, matches one worked out from scratch, and a play from every
position is a valid song. Modules made in the test (MOD, S3M, XM, IT, with
compressed IT samples) open with their patterns, order, loop and samples,
and best effort and exact import play the same notes at the same times;
modules with more than 16 channels are packed onto 16. The DMXOPL3 bank
converts to the 128 programs and the kit, and a MIDI file made in the test
opens with them. Both command-line converters give the same songs, and the
page's joined copy of the library has the same names and writes the same
bytes as the modules.

## Publishing

Every push to `main` runs the tests, builds `dist/` and deploys it to GitHub
Pages (`.github/workflows/pages.yml`). Pull requests run the tests only.

## Licences

- **The tracker, the library, the converters and the tests:** GPL-3.0-only
  (`LICENSE`).
- **`engine/player.wasm`:** a prebuilt binary of the RetCon audio engine,
  under its own terms (`engine/NOTICE.md`); its source is not published,
  and the GPL does not cover it.
- **`banks/dmxopl3/`:** DMXOPL3 by Shannon Freeman, MIT
  (`banks/dmxopl3/LICENSE`). A song converted from MIDI carries the bank's
  notice in its `LICN`.
- **`test/fixtures/martin-galway/`:** Martin Galway's music, GPL-3.0
  (`test/fixtures/martin-galway/README.md`).
