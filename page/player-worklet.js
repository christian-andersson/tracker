// SPDX-License-Identifier: GPL-3.0-only
// The audio thread of the RetCon tracker (page/tracker.html): runs
// player.wasm, the console's audio driver and mixer, one block of
// RETCON_AUDIO_FRAMES frames at a time, and hands the browser 128 at a time.

class RsngPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.e = null;           // the wasm exports
    this.block = null;       // the current block: interleaved L, R
    this.pos = 0;            // frames of it already played
    this.frames = 0;
    this.sinceStatus = 0;
    this.port.onmessage = (ev) => this.message(ev.data);
  }

  async message(m) {
    if (m.type === 'wasm') {
      const { instance } = await WebAssembly.instantiate(m.bytes, {});
      this.e = instance.exports;
      if (this.e._initialize) this.e._initialize();
      const r = this.e.rp_init();
      this.frames = this.e.rp_frames();
      this.pos = this.frames;
      this.port.postMessage({ type: 'ready', ok: r === 0 });
    } else if (!this.e) {
      return;
    } else if (m.type === 'load') {
      const bytes = new Uint8Array(m.bytes);
      const p = this.e.rp_file(bytes.length);
      let err = 9;                                  // too big
      if (p) {
        new Uint8Array(this.e.memory.buffer, p, bytes.length).set(bytes);
        err = m.start === false ? this.e.rp_prepare(bytes.length) : this.e.rp_load(bytes.length);
      }
      this.pos = this.frames;
      this.port.postMessage({ type: 'loaded', err, id: m.id });
    } else if (m.type === 'command') {
      this.e.rp_command(m.command);
    } else if (m.type === 'set') {
      this.e.rp_set(m.volume, m.tempo);
    } else if (m.type === 'note') {                 // the tracker's preview: key a voice by hand
      this.e.rp_note(m.voice, m.instrument, m.note, m.volume, m.on ? 1 : 0);
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const left = out[0], right = out[1] || out[0];
    if (!this.e) {
      left.fill(0);
      right.fill(0);
      return true;
    }
    for (let i = 0; i < left.length; i++) {
      if (this.pos >= this.frames) {
        this.block = new Float32Array(this.e.memory.buffer, this.e.rp_render(), this.frames * 2);
        this.pos = 0;
      }
      left[i] = this.block[this.pos * 2];
      right[i] = this.block[this.pos * 2 + 1];
      this.pos++;
    }
    this.sinceStatus += left.length;
    if (this.sinceStatus >= 2400) {                 // 20 times a second
      this.sinceStatus = 0;
      this.port.postMessage({ type: 'status', state: this.e.rp_state(), tick: this.e.rp_tick() });
    }
    return true;
  }
}

registerProcessor('rsng-player', RsngPlayer);
