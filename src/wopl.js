// SPDX-License-Identifier: GPL-3.0-only
// General MIDI instruments from an OPL (YMF262) bank in WOPL format.

import { INSTRUMENT_SIZE } from './format.js';

// ---------------------------------------------------------------- General MIDI instruments (WOPL banks)

// An OPL (YMF262) instrument bank in WOPL format (libADLMIDI, OPL3 Bank
// Editor) as RetCon instruments: its 128 melodic programs (bank 0) and its
// drum kit (percussion bank 0). The tracker and the MIDI converter
// (converters/midi2rsng.js) use DMXOPL3,
// banks/dmxopl3/. How an OPL voice becomes a RetCon instrument (the
// scales of synth.c):
//   - wave select 0-7: sine, half, abs, quarter ("pulse"), alternating and
//     camel sine, square (a pulse of width 32768), and the derived square
//     as a saw (an approximation);
//   - MULT -> ratio (x2); total level, 0.75 dB a step -> level, the same
//     formula for carriers and modulators (both chips move the phase 4
//     cycles at full scale); feedback 1-7 -> 255 * 2^(fb - 7) (OPL's 4 pi
//     at 7 is the synth's 2 cycles at 255);
//   - envelope rates -> times from the YMF262 tables for a note near
//     middle C; sustain level 3 dB a step; a non-sustaining envelope fades
//     after its decay at the release rate (sustain_decay);
//   - 2-op FM and additive voices, layered (pseudo 4-op) voices and the
//     4-op connections -> algorithms 4, 6, 7 and 0; 4-op AM-AM keeps its
//     feedback or its inner FM pair, whichever matters more; AM-FM drops
//     its lone carrier;
//   - the chip's vibrato and tremolo bits -> LFO 1 on pitch, LFO 2 on volume.
// Not carried over: key scale level (quieter, duller high notes), the
// drivers' velocity curves, a second voice's note offset other than whole
// octaves.
export const pyRound = (x) => {                 // Python's round(): halves to even, so both give the same bytes
  const f = Math.floor(x), d = x - f;
  return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1);
};
export const GM_NAMES = ['Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano', 'Electric Piano 1',
  'Electric Piano 2', 'Harpsichord', 'Clavinet', 'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone',
  'Tubular Bells', 'Dulcimer', 'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion',
  'Harmonica', 'Tango Accordion', 'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)',
  'Electric Guitar (clean)', 'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass', 'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1',
  'Synth Bass 2', 'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2', 'Choir Aahs', 'Voice Oohs', 'Synth Voice',
  'Orchestra Hit', 'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet', 'Piccolo', 'Flute',
  'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina', 'Lead 1 (square)', 'Lead 2 (sawtooth)',
  'Lead 3 (calliope)', 'Lead 4 (chiff)', 'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)', 'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)',
  'Pad 8 (sweep)', 'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)', 'FX 5 (brightness)', 'FX 6 (goblins)',
  'FX 7 (echoes)', 'FX 8 (sci-fi)', 'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai', 'Tinkle Bell',
  'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal', 'Guitar Fret Noise',
  'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot'];
export const DRUM_NAMES = { 27: 'High Q', 28: 'Slap', 29: 'Scratch Push', 30: 'Scratch Pull', 31: 'Sticks', 32: 'Square Click',
  33: 'Metronome Click', 34: 'Metronome Bell', 35: 'Acoustic Bass Drum', 36: 'Bass Drum 1', 37: 'Side Stick', 38: 'Acoustic Snare',
  39: 'Hand Clap', 40: 'Electric Snare', 41: 'Low Floor Tom', 42: 'Closed Hi-Hat', 43: 'High Floor Tom', 44: 'Pedal Hi-Hat',
  45: 'Low Tom', 46: 'Open Hi-Hat', 47: 'Low-Mid Tom', 48: 'Hi-Mid Tom', 49: 'Crash Cymbal 1', 50: 'High Tom', 51: 'Ride Cymbal 1',
  52: 'Chinese Cymbal', 53: 'Ride Bell', 54: 'Tambourine', 55: 'Splash Cymbal', 56: 'Cowbell', 57: 'Crash Cymbal 2', 58: 'Vibraslap',
  59: 'Ride Cymbal 2', 60: 'Hi Bongo', 61: 'Low Bongo', 62: 'Mute Hi Conga', 63: 'Open Hi Conga', 64: 'Low Conga', 65: 'High Timbale',
  66: 'Low Timbale', 67: 'High Agogo', 68: 'Low Agogo', 69: 'Cabasa', 70: 'Maracas', 71: 'Short Whistle', 72: 'Long Whistle',
  73: 'Short Guiro', 74: 'Long Guiro', 75: 'Claves', 76: 'Hi Wood Block', 77: 'Low Wood Block', 78: 'Mute Cuica', 79: 'Open Cuica',
  80: 'Mute Triangle', 81: 'Open Triangle', 82: 'Shaker', 83: 'Jingle Bell', 84: 'Belltree', 85: 'Castanets', 86: 'Mute Surdo',
  87: 'Open Surdo' };
export const OPL_WAVES = [[0, 0], [7, 0], [8, 0], [9, 0], [10, 0], [11, 0], [3, 32768], [2, 0]];
export const OPL_MULT = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30];
export const KEY_CODE = 9;                      // block 4, upper half: near middle C
export const envByte = (ms) => (ms <= 1 ? 0 : Math.max(0, Math.min(255, pyRound(64 * Math.log10(ms)))));
export function oplRateMs(rate, ksr, attack) {  // YMF262 envelope time, ms (null: never)
  if (rate === 0) return null;
  const rof = ksr ? KEY_CODE : KEY_CODE >> 2, er = Math.min(63, 4 * rate + rof);
  if (er >= 60) return attack ? 0 : 2.40;
  return (attack ? 2826.24 : 39280.64) * 2 ** -(Math.floor(er / 4) - 1) * 4 / (4 + er % 4);
}
export function oplOperator(r) {                // -> [20 bytes, vibrato, tremolo]
  const [r20, r40, r60, r80, re0] = r, [wave, width] = OPL_WAVES[re0 & 7], ksr = !!(r20 & 0x10);
  let level = pyRound(255 * 10 ** (-0.75 * (r40 & 63) / 40));
  const attack = oplRateMs(r60 >> 4, ksr, true), decay = oplRateMs(r60 & 15, ksr, false), release = oplRateMs(r80 & 15, ksr, false);
  const sl = r80 >> 4, to43 = 43.4 / 96;
  let sustain = sl === 15 ? 0 : pyRound(255 * 10 ** (-3 * sl / 20));
  if (attack === null) level = 0;
  const a = attack === null ? 255 : envByte(attack), d = decay === null ? 255 : envByte(decay * to43);
  const rel = release === null ? 255 : envByte(release * to43), sdecay = r20 & 0x20 ? 0 : rel;
  if (decay === null) sustain = 255;
  const b = new Uint8Array(20);
  b[0] = wave; b[1] = OPL_MULT[r20 & 15]; b[3] = level; b[4] = width & 255; b[5] = width >> 8;
  b[8] = sdecay; b[12] = a; b[13] = d; b[14] = sustain; b[15] = rel;
  return [b, !!(r20 & 0x40), !!(r20 & 0x80)];
}
export const oplSilent = () => Uint8Array.of(0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0);
export const oplFeedback = (byte) => { const fb = (byte >> 1) & 7; return fb ? pyRound(255 * 2 ** (fb - 7)) : 0; };
export function oplInstrument(e, notes) {       // one WOPL entry -> [Instrument bytes, key offset]
  const note = (k) => { notes[k] = (notes[k] || 0) + 1; };
  const flags = e[39], fb1 = e[40], fb2 = e[41], dv = new DataView(e.buffer, e.byteOffset, e.byteLength);
  const ops = [0, 1, 2, 3].map((k) => oplOperator(e.subarray(42 + 5 * k, 47 + 5 * k)));   // carrier 1, modulator 1, carrier 2, modulator 2
  const key1 = dv.getInt16(32), key2 = dv.getInt16(34), detune2 = dv.getInt8(37);
  const [car1, mod1, car2, mod2] = ops;
  let slot = [oplSilent(), oplSilent(), oplSilent(), oplSilent()], algorithm, vib, trem;
  if (flags & 1) {                       // 4 operators: chip order 1-4 is entry 2, 1, 4, 3
    const c = [mod1, car1, mod2, car2], mode = [fb1 & 1, fb2 & 1].join('');
    let order, fbOp;
    if (mode === '00') { algorithm = 0; order = [0, 1, 2, 3]; fbOp = 0; }
    else if (mode === '01') { algorithm = 4; order = [0, 1, 2, 3]; fbOp = 0; }
    else if (mode === '11') {
      if (((fb1 >> 1) & 7) >= 4) { algorithm = 7; order = [0, 1, 2, 3]; fbOp = 0; note('4-op AM-AM: 2>3 played side by side'); }
      else { algorithm = 6; order = [1, 2, 0, 3]; fbOp = null; note('4-op AM-AM: feedback dropped'); }
    } else { algorithm = 0; order = [null, 1, 2, 3]; fbOp = null; note('4-op AM-FM: lone carrier dropped'); }
    order.forEach((src, k) => { if (src !== null) slot[k] = c[src][0]; });
    if (fbOp !== null) slot[fbOp][7] = oplFeedback(fb1);
    vib = c.some((x) => x[1]); trem = c.some((x) => x[2]);
  } else {
    const pseudo = !!(flags & 2);
    let fbFirst = fb1;
    if (!pseudo) { algorithm = fb1 & 1 ? 7 : 4; slot[0] = mod1[0]; slot[1] = car1[0]; }
    else {
      const fm1 = !(fb1 & 1), fm2 = !(fb2 & 1);
      let layout;
      if (fm1 && fm2) { algorithm = 4; layout = [mod1, car1, mod2, car2]; }
      else if (fm1) { algorithm = 6; layout = [mod1, car1, mod2, car2]; }
      else if (fm2) { algorithm = 6; layout = [mod2, car2, mod1, car1]; fbFirst = fb2; }
      else { algorithm = 7; layout = [mod1, car1, mod2, car2]; }
      slot = layout.map((x) => x[0]);
      let octaves = Math.floor((key2 - key1) / 12), rest = (key2 - key1) - 12 * octaves;
      if (rest > 6) { octaves++; rest -= 12; }
      const cents = rest * 100 + pyRound(detune2 * 1.5625);
      if (rest) note('second voice off by a part of an octave (as detune)');
      for (const k of [2, 3]) {
        slot[k][1] = Math.max(1, Math.min(255, pyRound(slot[k][1] * 2 ** octaves)));
        slot[k][2] = Math.max(-128, Math.min(127, cents)) & 0xFF;
      }
      if (((fbFirst === fb1 ? fb2 : fb1) >> 1) & 7) note("second voice's feedback dropped");
    }
    slot[0][7] = oplFeedback(fbFirst);
    vib = ops.some((x) => x[1]); trem = car1[2] || car2[2];
  }
  const b = new Uint8Array(INSTRUMENT_SIZE);
  slot.forEach((x, k) => b.set(x, 20 * k));
  b[80] = algorithm; b[82] = 255; b[90] = 255;
  if (vib) b.set([0, 1, 177, 19, 0], 92);                // LFO 1: pitch, 6.1 Hz, 7 cents
  if (trem) b.set([0, 2, 159, 28, 0], 100);              // LFO 2: volume, 3.7 Hz, 1 dB
  return [b, key1];
}
// A WOPL file -> { instruments: [{ name, bytes }], keyOffset, velocityOffset,
// drums: { note: [instrument, note played] }, notes: { approximation: count } }
export function gmBank(buf) {
  const d = new Uint8Array(buf);
  if (String.fromCharCode(...d.subarray(0, 11)) !== 'WOPL3-BANK\0') throw new Error('not a WOPL bank');
  const version = d[11] | d[12] << 8, mb = d[13] << 8 | d[14], pb = d[15] << 8 | d[16];
  const p = 19 + (version >= 2 ? 34 * (mb + pb) : 0), size = version >= 3 ? 66 : 62, entry = (k) => d.subarray(p + k * size, p + (k + 1) * size);
  if (p + (mb + pb) * 128 * size > d.length || !mb || !pb) throw new Error('a WOPL bank without its General MIDI sets');
  const notes = {}, bank = { instruments: [], keyOffset: [], velocityOffset: [], drums: {}, notes };
  for (let k = 0; k < 128; k++) {
    const e = entry(k), [b, key] = oplInstrument(e, notes);
    bank.instruments.push({ name: GM_NAMES[k], bytes: b }); bank.keyOffset.push(key); bank.velocityOffset.push(e[36] << 24 >> 24);
  }
  for (let n = 0; n < 128; n++) {
    const e = entry(mb * 128 + n);
    if (e[39] & 4) continue;            // blank: no sound for this note
    const [b, key] = oplInstrument(e, notes);
    bank.drums[n] = [bank.instruments.length, Math.max(0, Math.min(127, (e[38] || n) + key))];
    bank.instruments.push({ name: 'Drum: ' + (DRUM_NAMES[n] || 'note ' + n), bytes: b });
    bank.keyOffset.push(0); bank.velocityOffset.push(e[36] << 24 >> 24);
  }
  return bank;
}
export const BANK_NOTICE = 'Instruments: DMXOPL3 by Shannon Freeman (sneakernets), MIT licence.';
