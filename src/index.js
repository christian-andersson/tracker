// SPDX-License-Identifier: GPL-3.0-only
// RetCon songs: the library of the web tracker and the converters (tracker.html): the chunk container
// (the RetCon chunk container), and a tracker song (patterns, an order list,
// instruments) compiled to and read back from a .rsng (the RetCon song format,
// the song section of RetCon's console_sys.h).
//
// A tracker song is written in a fixed shape: every pattern of every
// channel is one phrase (rows of commands and waits, then CH_RETURN), and
// each channel's stream calls those phrases in the order list's order. The
// private chunk xTRK keeps what the song data cannot: rows per pattern, the
// order list, the names. With it, reading a song back is exact. A song
// without it (made by a converter) is read best effort: its notes laid on a
// row grid, and every command that has no column kept in the cell as it is.
//
// The modules of src/ as one object: `import RSNG from` this file (Node),
// or the pages' inlined copy (build.mjs), which sets globalThis.RSNG.

import { CH, COMMAND_NAMES, FILTERS, FX_LETTERS, INSTRUMENT_SIZE, INST_FIELDS, NO_LOOP, OP_FIELDS, WAVES, crc32, defaultInstruments, envMs, getField, hex2, makeInstrument, msEnv, noteName, rawName, readContainer, setField, writeContainer } from './format.js';
import { NO_WAVE, OP_TABLE_SMOOTH, SAMPLE_FORMATS, TABLE_SHAPES, WAVE_SAMPLE, WAVE_TABLE, getU32, newSample, newTable, quantizeTable, sampleFrame, setTableLength, setU32, shapeTable, waveUsers } from './waves.js';
import { EXTRA, PATCH_FIELDS, SWEEP_MODES, cellEmpty, compileSong, decodeExtra, defaultExtra, emptyCell, encodeExtra, flattenChannel, newPattern, newSong, playOrder, readSong, setChannels, setRows, tickMs, writeSong } from './song.js';
import { chase, entryBytes, writePlay } from './chase.js';
import { isMod, readMod } from './mod.js';
import { isIt, isS3m, isXm, readTracked } from './tracked.js';
import { BANK_NOTICE, gmBank } from './wopl.js';
import { isMidi, keepUsedInstruments, midiChannels, readMidi } from './midi.js';

const RSNG = {
  CH, COMMAND_NAMES, crc32, readContainer, writeContainer, readSong, readMod, isMod, readTracked, isS3m, isXm, isIt, readMidi, isMidi, midiChannels, gmBank, keepUsedInstruments, BANK_NOTICE, writeSong, writePlay, playOrder, compileSong, tickMs, chase, entryBytes, newSong, newPattern, emptyCell, cellEmpty, setChannels, setRows, defaultInstruments, makeInstrument, OP_FIELDS, INST_FIELDS, WAVES, WAVE_SAMPLE, WAVE_TABLE, OP_TABLE_SMOOTH, NO_WAVE, SAMPLE_FORMATS, TABLE_SHAPES, newTable, newSample, shapeTable, quantizeTable, setTableLength, sampleFrame, waveUsers, getU32, setU32, FILTERS, getField, setField, envMs, msEnv, noteName, hex2, rawName, FX_LETTERS, flattenChannel, NO_LOOP, INSTRUMENT_SIZE, EXTRA, SWEEP_MODES, PATCH_FIELDS, decodeExtra, encodeExtra, defaultExtra,
};
export default RSNG;
