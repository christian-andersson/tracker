# DMXOPL3

The General MIDI instruments of the tracker and `converters/midi2rsng.js`: an OPL3 (YMF262) instrument bank, 128 melodic programs and a drum kit, by Shannon Freeman ("sneakernets"), 2017, under the MIT licence (`LICENSE`).

- **File:** `DMXOPL3-by-sneakernets-GS.wopl`, as published in libADLMIDI (https://github.com/Wohlstand/libADLMIDI, `fm_banks/wopl_files/`, commit `7e6e045d4e3f2614963a545e4bdfc95677e32673`), SHA-256 `57f96bb2b5947a21e9af8febc2a318e9374af3cc7b0700832404af94567edfc5`. `LICENSE` is libADLMIDI's `fm_banks/LICENSE-DMXOPL.txt` from the same commit.
- **Used:** melodic bank 0 and percussion bank 0, the General MIDI sets; the file's other (GS) banks are not read.
- **How:** `gmBank` in `src/wopl.js` turns each OPL voice into a RetCon instrument when a MIDI file is opened or converted. The tracker page carries this file; a converted song carries the instruments it uses and the bank's notice in its `LICN`.
