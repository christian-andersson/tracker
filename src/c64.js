// SPDX-License-Identifier: GPL-3.0-only
// A Commodore 64, as far as a SID tune needs one: the 6510 with every
// opcode (the undocumented ones too, which many music players use), 64 KB
// of RAM banked by the $01 port, the VIC's raster counter and interrupt,
// the two CIAs' timers (CIA 1 on IRQ, CIA 2 on NMI) and a stand-in KERNAL
// of a few bytes (the interrupt entry and exit code only, no ROM).
//
// The SID is not emulated: its registers are a store, every write is
// handed to onSid(address, value, cycle) with the cycle it happens on, and
// only voice 3's oscillator and envelope can be read back (tunes use them
// for random numbers). The machine runs as fast as it can; its clock is the
// cycle count, so the timing of every write is a C64's.

// ---------------------------------------------------------------- the 6510

export const CPU_OPS = ('BRK imp,ORA izx,JAM imp,SLO izx,NOP zp,ORA zp,ASL zp,SLO zp,PHP imp,ORA imm,ASL acc,ANC imm,NOP abs,ORA abs,ASL abs,SLO abs,' +
  'BPL rel,ORA izy,JAM imp,SLO izy,NOP zpx,ORA zpx,ASL zpx,SLO zpx,CLC imp,ORA aby,NOP imp,SLO aby,NOP abx,ORA abx,ASL abx,SLO abx,' +
  'JSR abs,AND izx,JAM imp,RLA izx,BIT zp,AND zp,ROL zp,RLA zp,PLP imp,AND imm,ROL acc,ANC imm,BIT abs,AND abs,ROL abs,RLA abs,' +
  'BMI rel,AND izy,JAM imp,RLA izy,NOP zpx,AND zpx,ROL zpx,RLA zpx,SEC imp,AND aby,NOP imp,RLA aby,NOP abx,AND abx,ROL abx,RLA abx,' +
  'RTI imp,EOR izx,JAM imp,SRE izx,NOP zp,EOR zp,LSR zp,SRE zp,PHA imp,EOR imm,LSR acc,ALR imm,JMP abs,EOR abs,LSR abs,SRE abs,' +
  'BVC rel,EOR izy,JAM imp,SRE izy,NOP zpx,EOR zpx,LSR zpx,SRE zpx,CLI imp,EOR aby,NOP imp,SRE aby,NOP abx,EOR abx,LSR abx,SRE abx,' +
  'RTS imp,ADC izx,JAM imp,RRA izx,NOP zp,ADC zp,ROR zp,RRA zp,PLA imp,ADC imm,ROR acc,ARR imm,JMP ind,ADC abs,ROR abs,RRA abs,' +
  'BVS rel,ADC izy,JAM imp,RRA izy,NOP zpx,ADC zpx,ROR zpx,RRA zpx,SEI imp,ADC aby,NOP imp,RRA aby,NOP abx,ADC abx,ROR abx,RRA abx,' +
  'NOP imm,STA izx,NOP imm,SAX izx,STY zp,STA zp,STX zp,SAX zp,DEY imp,NOP imm,TXA imp,ANE imm,STY abs,STA abs,STX abs,SAX abs,' +
  'BCC rel,STA izy,JAM imp,SHA izy,STY zpx,STA zpx,STX zpy,SAX zpy,TYA imp,STA aby,TXS imp,TAS aby,SHY abx,STA abx,SHX aby,SHA aby,' +
  'LDY imm,LDA izx,LDX imm,LAX izx,LDY zp,LDA zp,LDX zp,LAX zp,TAY imp,LDA imm,TAX imp,LXA imm,LDY abs,LDA abs,LDX abs,LAX abs,' +
  'BCS rel,LDA izy,JAM imp,LAX izy,LDY zpx,LDA zpx,LDX zpy,LAX zpy,CLV imp,LDA aby,TSX imp,LAS aby,LDY abx,LDA abx,LDX aby,LAX aby,' +
  'CPY imm,CMP izx,NOP imm,DCP izx,CPY zp,CMP zp,DEC zp,DCP zp,INY imp,CMP imm,DEX imp,SBX imm,CPY abs,CMP abs,DEC abs,DCP abs,' +
  'BNE rel,CMP izy,JAM imp,DCP izy,NOP zpx,CMP zpx,DEC zpx,DCP zpx,CLD imp,CMP aby,NOP imp,DCP aby,NOP abx,CMP abx,DEC abx,DCP abx,' +
  'CPX imm,SBC izx,NOP imm,ISC izx,CPX zp,SBC zp,INC zp,ISC zp,INX imp,SBC imm,NOP imp,SBC imm,CPX abs,SBC abs,INC abs,ISC abs,' +
  'BEQ rel,SBC izy,JAM imp,ISC izy,NOP zpx,SBC zpx,INC zpx,ISC zpx,SED imp,SBC aby,NOP imp,ISC aby,NOP abx,SBC abx,INC abx,ISC abx')
  .split(',').map((s) => s.split(' '));
// base cycles; reads through abx, aby and izy take one more across a page, branches one more taken and one more across a page
export const CPU_CYCLES = [
  7, 6, 0, 8, 3, 3, 5, 5, 3, 2, 2, 2, 4, 4, 6, 6, 2, 5, 0, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  6, 6, 0, 8, 3, 3, 5, 5, 4, 2, 2, 2, 4, 4, 6, 6, 2, 5, 0, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  6, 6, 0, 8, 3, 3, 5, 5, 3, 2, 2, 2, 3, 4, 6, 6, 2, 5, 0, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  6, 6, 0, 8, 3, 3, 5, 5, 4, 2, 2, 2, 5, 4, 6, 6, 2, 5, 0, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4, 2, 6, 0, 6, 4, 4, 4, 4, 2, 5, 2, 5, 5, 5, 5, 5,
  2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4, 2, 5, 0, 5, 4, 4, 4, 4, 2, 4, 2, 4, 4, 4, 4, 4,
  2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6, 2, 5, 0, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6, 2, 5, 0, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7];
export const CPU_PAGE_READS = new Set(['ORA', 'AND', 'EOR', 'ADC', 'SBC', 'CMP', 'LDA', 'LDX', 'LDY', 'LAX', 'LAS', 'NOP']);
export const CPU_C = 1, CPU_Z = 2, CPU_I = 4, CPU_D = 8, CPU_B = 16, CPU_V = 64, CPU_N = 128;

// The processor alone, on a memory of read(address) and write(address, value).
export class Cpu6510 {
  constructor(read, write) {
    this.read = read; this.write = write;
    this.a = 0; this.x = 0; this.y = 0; this.s = 0xFD; this.p = 0x24; this.pc = 0;
    this.jammed = 0;                                   // JAM opcodes met (the processor stops on them)
  }
  read16(a) { return this.read(a) | this.read((a + 1) & 0xFFFF) << 8; }
  push(v) { this.write(0x100 | this.s, v & 0xFF); this.s = (this.s - 1) & 0xFF; }
  pull() { this.s = (this.s + 1) & 0xFF; return this.read(0x100 | this.s); }
  nz(v) { this.p = (this.p & 0x7D) | (v & 0x80) | (v ? 0 : CPU_Z); return v; }
  // an interrupt (IRQ, NMI, or BRK with `brk`): 7 cycles
  interrupt(vector, brk = false) {
    this.push(this.pc >> 8); this.push(this.pc);
    this.push(brk ? this.p | 0x30 : (this.p & ~CPU_B) | 0x20);
    this.p |= CPU_I;
    this.pc = this.read16(vector);
    return 7;
  }
  adc(v) {
    const c = this.p & CPU_C, a = this.a;
    if (this.p & CPU_D) {
      let lo = (a & 15) + (v & 15) + c, hi = (a >> 4) + (v >> 4);
      if (lo > 9) { lo += 6; }
      if (lo > 15) hi++;
      const bin = (a + v + c) & 0xFF;
      this.p = (this.p & ~(CPU_Z | CPU_N | CPU_V | CPU_C)) | (bin ? 0 : CPU_Z) | ((hi << 4) & 0x80) |
        (~(a ^ v) & (a ^ (hi << 4)) & 0x80 ? CPU_V : 0);
      if (hi > 9) hi += 6;
      if (hi > 15) this.p |= CPU_C;
      this.a = ((hi << 4) | (lo & 15)) & 0xFF;
      return;
    }
    const t = a + v + c;
    this.p = (this.p & ~(CPU_V | CPU_C)) | (t > 0xFF ? CPU_C : 0) | (~(a ^ v) & (a ^ t) & 0x80 ? CPU_V : 0);
    this.a = this.nz(t & 0xFF);
  }
  sbc(v) {
    const c = this.p & CPU_C, a = this.a, t = a - v - (1 - c);
    this.p = (this.p & ~(CPU_V | CPU_C)) | (t >= 0 ? CPU_C : 0) | ((a ^ v) & (a ^ t) & 0x80 ? CPU_V : 0);
    this.nz(t & 0xFF);
    if (this.p & CPU_D) {
      let lo = (a & 15) - (v & 15) - (1 - c), hi = (a >> 4) - (v >> 4);
      if (lo & 0x10) { lo -= 6; hi--; }
      if (hi & 0x10) hi -= 6;
      this.a = ((hi << 4) | (lo & 15)) & 0xFF;
    } else this.a = t & 0xFF;
  }
  cmp(r, v) { const t = r - v; this.p = (this.p & ~CPU_C) | (t >= 0 ? CPU_C : 0); this.nz(t & 0xFF); }
  asl(v) { this.p = (this.p & ~CPU_C) | (v >> 7); return this.nz((v << 1) & 0xFF); }
  lsr(v) { this.p = (this.p & ~CPU_C) | (v & 1); return this.nz(v >> 1); }
  rol(v) { const t = ((v << 1) | (this.p & CPU_C)) & 0xFF; this.p = (this.p & ~CPU_C) | (v >> 7); return this.nz(t); }
  ror(v) { const t = (v >> 1) | ((this.p & CPU_C) << 7); this.p = (this.p & ~CPU_C) | (v & 1); return this.nz(t); }

  // One instruction; returns its cycles.
  step() {
    const pc0 = this.pc, op = this.read(pc0), [mn, mode] = CPU_OPS[op];
    let cyc = CPU_CYCLES[op], addr = 0, cross = false, pc = (pc0 + 1) & 0xFFFF;
    switch (mode) {
      case 'imm': addr = pc; pc = (pc + 1) & 0xFFFF; break;
      case 'zp': addr = this.read(pc); pc = (pc + 1) & 0xFFFF; break;
      case 'zpx': addr = (this.read(pc) + this.x) & 0xFF; pc = (pc + 1) & 0xFFFF; break;
      case 'zpy': addr = (this.read(pc) + this.y) & 0xFF; pc = (pc + 1) & 0xFFFF; break;
      case 'abs': addr = this.read16(pc); pc = (pc + 2) & 0xFFFF; break;
      case 'abx': case 'aby': {
        const base = this.read16(pc);
        addr = (base + (mode === 'abx' ? this.x : this.y)) & 0xFFFF; cross = ((base ^ addr) & 0xFF00) !== 0;
        pc = (pc + 2) & 0xFFFF; break;
      }
      case 'ind': { const p = this.read16(pc); addr = this.read(p) | this.read((p & 0xFF00) | ((p + 1) & 0xFF)) << 8; pc = (pc + 2) & 0xFFFF; break; }
      case 'izx': { const z = (this.read(pc) + this.x) & 0xFF; addr = this.read(z) | this.read((z + 1) & 0xFF) << 8; pc = (pc + 1) & 0xFFFF; break; }
      case 'izy': {
        const z = this.read(pc), base = this.read(z) | this.read((z + 1) & 0xFF) << 8;
        addr = (base + this.y) & 0xFFFF; cross = ((base ^ addr) & 0xFF00) !== 0; pc = (pc + 1) & 0xFFFF; break;
      }
      case 'rel': { const o = this.read(pc); pc = (pc + 1) & 0xFFFF; addr = (pc + (o < 128 ? o : o - 256)) & 0xFFFF; break; }
      default: break;
    }
    if (cross && CPU_PAGE_READS.has(mn)) cyc++;
    this.pc = pc;
    const rmw = (f) => { const v = this.read(addr); this.write(addr, v); const t = f(v); this.write(addr, t); return t; };
    const branch = (taken) => { if (taken) { cyc += 1 + (((pc ^ addr) & 0xFF00) ? 1 : 0); this.pc = addr; } };
    const hi1 = ((addr >> 8) + 1) & 0xFF;
    switch (mn) {
      case 'LDA': this.a = this.nz(this.read(addr)); break;
      case 'LDX': this.x = this.nz(this.read(addr)); break;
      case 'LDY': this.y = this.nz(this.read(addr)); break;
      case 'STA': this.write(addr, this.a); break;
      case 'STX': this.write(addr, this.x); break;
      case 'STY': this.write(addr, this.y); break;
      case 'ORA': this.a = this.nz(this.a | this.read(addr)); break;
      case 'AND': this.a = this.nz(this.a & this.read(addr)); break;
      case 'EOR': this.a = this.nz(this.a ^ this.read(addr)); break;
      case 'ADC': this.adc(this.read(addr)); break;
      case 'SBC': this.sbc(this.read(addr)); break;
      case 'CMP': this.cmp(this.a, this.read(addr)); break;
      case 'CPX': this.cmp(this.x, this.read(addr)); break;
      case 'CPY': this.cmp(this.y, this.read(addr)); break;
      case 'BIT': { const v = this.read(addr); this.p = (this.p & 0x3D) | (v & 0xC0) | ((this.a & v) ? 0 : CPU_Z); break; }
      case 'ASL': if (mode === 'acc') this.a = this.asl(this.a); else rmw((v) => this.asl(v)); break;
      case 'LSR': if (mode === 'acc') this.a = this.lsr(this.a); else rmw((v) => this.lsr(v)); break;
      case 'ROL': if (mode === 'acc') this.a = this.rol(this.a); else rmw((v) => this.rol(v)); break;
      case 'ROR': if (mode === 'acc') this.a = this.ror(this.a); else rmw((v) => this.ror(v)); break;
      case 'INC': rmw((v) => this.nz((v + 1) & 0xFF)); break;
      case 'DEC': rmw((v) => this.nz((v - 1) & 0xFF)); break;
      case 'INX': this.x = this.nz((this.x + 1) & 0xFF); break;
      case 'INY': this.y = this.nz((this.y + 1) & 0xFF); break;
      case 'DEX': this.x = this.nz((this.x - 1) & 0xFF); break;
      case 'DEY': this.y = this.nz((this.y - 1) & 0xFF); break;
      case 'TAX': this.x = this.nz(this.a); break;
      case 'TAY': this.y = this.nz(this.a); break;
      case 'TXA': this.a = this.nz(this.x); break;
      case 'TYA': this.a = this.nz(this.y); break;
      case 'TSX': this.x = this.nz(this.s); break;
      case 'TXS': this.s = this.x; break;
      case 'PHA': this.push(this.a); break;
      case 'PHP': this.push(this.p | 0x30); break;
      case 'PLA': this.a = this.nz(this.pull()); break;
      case 'PLP': this.p = (this.pull() & ~CPU_B) | 0x20; break;
      case 'CLC': this.p &= ~CPU_C; break;
      case 'SEC': this.p |= CPU_C; break;
      case 'CLI': this.p &= ~CPU_I; break;
      case 'SEI': this.p |= CPU_I; break;
      case 'CLD': this.p &= ~CPU_D; break;
      case 'SED': this.p |= CPU_D; break;
      case 'CLV': this.p &= ~CPU_V; break;
      case 'BPL': branch(!(this.p & CPU_N)); break;
      case 'BMI': branch(!!(this.p & CPU_N)); break;
      case 'BVC': branch(!(this.p & CPU_V)); break;
      case 'BVS': branch(!!(this.p & CPU_V)); break;
      case 'BCC': branch(!(this.p & CPU_C)); break;
      case 'BCS': branch(!!(this.p & CPU_C)); break;
      case 'BNE': branch(!(this.p & CPU_Z)); break;
      case 'BEQ': branch(!!(this.p & CPU_Z)); break;
      case 'JMP': this.pc = addr; break;
      case 'JSR': { const r = (pc - 1) & 0xFFFF; this.push(r >> 8); this.push(r); this.pc = addr; break; }
      case 'RTS': this.pc = ((this.pull() | this.pull() << 8) + 1) & 0xFFFF; break;
      case 'RTI': this.p = (this.pull() & ~CPU_B) | 0x20; this.pc = this.pull() | this.pull() << 8; break;
      case 'BRK': this.pc = (this.pc + 1) & 0xFFFF; this.interrupt(0xFFFE, true); break;
      case 'NOP': if (mode !== 'imp') this.read(addr); break;
      // the undocumented ones
      case 'SLO': this.a = this.nz(this.a | rmw((v) => this.asl(v))); break;
      case 'RLA': this.a = this.nz(this.a & rmw((v) => this.rol(v))); break;
      case 'SRE': this.a = this.nz(this.a ^ rmw((v) => this.lsr(v))); break;
      case 'RRA': this.adc(rmw((v) => this.ror(v))); break;
      case 'SAX': this.write(addr, this.a & this.x); break;
      case 'LAX': this.a = this.x = this.nz(this.read(addr)); break;
      case 'DCP': this.cmp(this.a, rmw((v) => (v - 1) & 0xFF)); break;
      case 'ISC': this.sbc(rmw((v) => (v + 1) & 0xFF)); break;
      case 'ANC': this.a = this.nz(this.a & this.read(addr)); this.p = (this.p & ~CPU_C) | (this.a >> 7); break;
      case 'ALR': this.a = this.lsr(this.a & this.read(addr)); break;
      case 'ARR': {
        const t = ((this.a & this.read(addr)) >> 1) | ((this.p & CPU_C) << 7);
        this.a = this.nz(t);
        this.p = (this.p & ~(CPU_C | CPU_V)) | ((t >> 6) & 1) | (((t >> 6) ^ (t >> 5)) & 1 ? CPU_V : 0);
        break;
      }
      case 'ANE': this.a = this.nz((this.a | 0xEE) & this.x & this.read(addr)); break;
      case 'LXA': this.a = this.x = this.nz((this.a | 0xEE) & this.read(addr)); break;
      case 'SBX': { const t = (this.a & this.x) - this.read(addr); this.p = (this.p & ~CPU_C) | (t >= 0 ? CPU_C : 0); this.x = this.nz(t & 0xFF); break; }
      case 'SHA': this.write(addr, this.a & this.x & hi1); break;
      case 'SHX': this.write(addr, this.x & hi1); break;
      case 'SHY': this.write(addr, this.y & hi1); break;
      case 'TAS': this.s = this.a & this.x; this.write(addr, this.s & hi1); break;
      case 'LAS': this.a = this.x = this.s = this.nz(this.read(addr) & this.s); break;
      case 'JAM': this.pc = pc0; this.jammed++; cyc = 2; break;
      default: break;
    }
    return cyc;
  }
}

// ---------------------------------------------------------------- the C64 around it

export const C64_SENTINEL = 0x0000;                    // a call returns here; the machine idles
// the stand-in KERNAL: interrupt entry (IRQ through $0314, BRK through $0316, NMI through $0318) and exit
export const C64_KERNAL = {
  0xFF48: [0x48, 0x8A, 0x48, 0x98, 0x48, 0xBA, 0xBD, 0x04, 0x01, 0x29, 0x10, 0xF0, 0x03, 0x6C, 0x16, 0x03, 0x6C, 0x14, 0x03],
  0xEA31: [0xAD, 0x0D, 0xDC, 0x68, 0xA8, 0x68, 0xAA, 0x68, 0x40],
  0xEA7E: [0xAD, 0x0D, 0xDC, 0x68, 0xA8, 0x68, 0xAA, 0x68, 0x40],
  0xEA81: [0x68, 0xA8, 0x68, 0xAA, 0x68, 0x40],
  0xFE43: [0x78, 0x6C, 0x18, 0x03],
  0xFE47: [0x40],
  0xFE66: [0x68, 0xA8, 0x68, 0xAA, 0x68, 0x40],
  0xFFFA: [0x43, 0xFE, 0xE2, 0xFC, 0x48, 0xFF],
};
export const C64_PAL = { clock: 985248, lines: 312, lineCycles: 63 };
export const C64_NTSC = { clock: 1022727, lines: 263, lineCycles: 65 };

// One of the two CIAs: timers A and B and the interrupt control register.
export class C64Cia {
  constructor() { this.ta = this.tb = this.la = this.lb = 0xFFFF; this.cra = this.crb = 0; this.icr = 0; this.mask = 0; }
  line() { return this.icr & this.mask & 0x1F; }
  advance(n) {
    let under = 0;
    if (this.cra & 1 && !(this.cra & 0x20)) {
      this.ta -= n;
      while (this.ta < 0) {
        under++; this.icr |= 1;
        if (this.cra & 8) { this.cra &= ~1; this.ta = this.la; break; }
        this.ta += this.la + 1;
      }
    }
    if (this.crb & 1) {
      const mode = (this.crb >> 5) & 3, dec = mode === 0 ? n : mode === 2 ? under : 0;
      if (dec) {
        this.tb -= dec;
        while (this.tb < 0) {
          this.icr |= 2;
          if (this.crb & 8) { this.crb &= ~1; this.tb = this.lb; break; }
          this.tb += this.lb + 1;
        }
      }
    }
    return under;
  }
  toEvent() {
    let c = 1 << 30;
    if (this.cra & 1 && !(this.cra & 0x20)) c = this.ta + 1;
    if (this.crb & 1 && !((this.crb >> 5) & 3)) c = Math.min(c, this.tb + 1);
    return c;
  }
  read(r) {
    switch (r) {
      case 4: return this.ta & 0xFF;
      case 5: return (this.ta >> 8) & 0xFF;
      case 6: return this.tb & 0xFF;
      case 7: return (this.tb >> 8) & 0xFF;
      case 0xD: { const v = this.icr | (this.line() ? 0x80 : 0); this.icr = 0; return v; }
      case 0xE: return this.cra;
      case 0xF: return this.crb;
      default: return r < 2 ? 0xFF : 0;
    }
  }
  write(r, v) {
    switch (r) {
      case 4: this.la = (this.la & 0xFF00) | v; break;
      case 5: this.la = (this.la & 0xFF) | v << 8; if (!(this.cra & 1)) this.ta = this.la; break;
      case 6: this.lb = (this.lb & 0xFF00) | v; break;
      case 7: this.lb = (this.lb & 0xFF) | v << 8; if (!(this.crb & 1)) this.tb = this.lb; break;
      case 0xD: if (v & 0x80) this.mask |= v & 0x1F; else this.mask &= ~v & 0x1F; break;
      case 0xE: this.cra = v & ~0x10; if (v & 0x10) this.ta = this.la; break;
      case 0xF: this.crb = v & ~0x10; if (v & 0x10) this.tb = this.lb; break;
      default: break;
    }
  }
}

// The machine. `sids`: the SID base addresses ($D400 first; a second or
// third SID elsewhere in $D400-$DFFF). onSid(sid, register, value, cycle).
export class C64 {
  constructor({ ntsc = false, sids = [0xD400], onSid = () => {} } = {}) {
    this.video = ntsc ? C64_NTSC : C64_PAL;
    this.frameCycles = this.video.lines * this.video.lineCycles;
    this.ram = new Uint8Array(0x10000);
    this.rom = new Uint8Array(0x2000);
    for (const [a, bytes] of Object.entries(C64_KERNAL)) this.rom.set(bytes, +a - 0xE000);
    this.sids = sids; this.onSid = onSid;
    this.sidRegs = sids.map(() => new Uint8Array(32));
    this.cpu = new Cpu6510((a) => this.read(a), (a, v) => this.write(a, v));
    this.cia = [new C64Cia(), new C64Cia()];
    this.d011 = 0x1B; this.d012 = 0; this.d019 = 0; this.d01a = 0;
    this.cyc = 0; this.line = 0; this.nmiLine = 0;
    this.onUnderflow = null;                           // called on each CIA 1 timer A underflow
    this.osc3 = 0; this.osc3At = 0; this.noise = 0x7FFFF8;
    // the KERNAL's start state: CIA 1 timer A at its 60 Hz rate on IRQ, the vectors, PAL or NTSC
    const c1 = this.cia[0];
    c1.la = c1.ta = ntsc ? 0x4295 : 0x4025; c1.cra = 1; c1.mask = 1;
    this.ram[0] = 0x2F; this.ram[1] = 0x37;
    for (const [a, v] of [[0x314, 0xEA31], [0x316, 0xFE66], [0x318, 0xFE47]]) { this.ram[a] = v & 0xFF; this.ram[a + 1] = v >> 8; }
    this.ram[0x2A6] = ntsc ? 0 : 1;
  }
  io() { const p = this.ram[1]; return (p & 3) !== 0 && (p & 4) !== 0; }
  read(a) {
    if (a < 0xD000) return this.ram[a];
    if (a >= 0xE000) return this.ram[1] & 2 ? this.rom[a - 0xE000] : this.ram[a];
    return this.io() ? this.ioRead(a) : this.ram[a];
  }
  write(a, v) {
    if (a >= 0xD000 && a < 0xE000 && this.io()) this.ioWrite(a, v);
    else this.ram[a] = v;
  }
  sidAt(a) {
    const base = a & ~0x1F, k = this.sids.indexOf(base);
    return k >= 0 ? k : a >= 0xD400 && a < 0xD800 ? 0 : -1;
  }
  ioRead(a) {
    if (a < 0xD400) {
      switch (a & 0x3F) {
        case 0x11: return (this.d011 & 0x7F) | ((this.line >> 1) & 0x80);
        case 0x12: return this.line & 0xFF;
        case 0x19: return this.d019 | 0x70 | (this.d019 & this.d01a & 0xF ? 0x80 : 0);
        case 0x1A: return this.d01a | 0xF0;
        default: return 0;
      }
    }
    if (a < 0xDC00 && a >= 0xD800) return this.ram[a];
    if (a >= 0xDC00 && a < 0xDD00) return this.cia[0].read(a & 0xF);
    if (a >= 0xDD00 && a < 0xDE00) return this.cia[1].read(a & 0xF);
    const k = this.sidAt(a);
    if (k < 0) return 0;
    const r = a & 0x1F, regs = this.sidRegs[k];
    if (r === 0x1B || r === 0x1C) return this.voice3(regs, r);
    return r === 0x19 || r === 0x1A ? 0xFF : 0;
  }
  // voice 3's oscillator ($D41B) and envelope ($D41C), roughly
  voice3(regs, r) {
    const ctrl = regs[0x12], freq = regs[0x0E] | regs[0x0F] << 8;
    this.osc3 = (this.osc3 + freq * (this.cyc - this.osc3At)) % 0x1000000; this.osc3At = this.cyc;
    if (r === 0x1C) return ctrl & 1 ? (regs[0x14] >> 4) * 17 : 0;
    const acc = this.osc3;
    if (ctrl & 0x80) {                                 // noise: a shift register
      const b = ((this.noise >> 22) ^ (this.noise >> 17)) & 1;
      this.noise = ((this.noise << 1) | b) & 0x7FFFFF;
      return (this.noise >> 15) & 0xFF;
    }
    if (ctrl & 0x40) return ((acc >> 12) & 0xFFF) >= ((regs[0x10] | regs[0x11] << 8) & 0xFFF) ? 0xFF : 0;
    if (ctrl & 0x20) return (acc >> 16) & 0xFF;
    if (ctrl & 0x10) return ((acc & 0x800000 ? ~acc : acc) >> 15) & 0xFF;
    return 0;
  }
  ioWrite(a, v) {
    if (a < 0xD400) {
      switch (a & 0x3F) {
        case 0x11: this.d011 = v; break;
        case 0x12: this.d012 = v; break;
        case 0x19: this.d019 &= ~v & 0xF; break;
        case 0x1A: this.d01a = v & 0xF; break;
        default: break;
      }
      return;
    }
    if (a >= 0xD800 && a < 0xDC00) { this.ram[a] = v; return; }
    if (a >= 0xDC00 && a < 0xDD00) { this.cia[0].write(a & 0xF, v); return; }
    if (a >= 0xDD00 && a < 0xDE00) { this.cia[1].write(a & 0xF, v); return; }
    const k = this.sidAt(a);
    if (k < 0) return;
    if ((a & 0x1F) === 0x12 && k === 0) this.voice3(this.sidRegs[0], 0x1B);   // keep voice 3's phase up to date
    this.sidRegs[k][a & 0x1F] = v;
    this.onSid(k, a & 0x1F, v, this.cyc);
  }
  load(addr, bytes) { for (let i = 0; i < bytes.length; i++) this.ram[(addr + i) & 0xFFFF] = bytes[i]; }
  // Start a subroutine call (init or play): it returns to the sentinel, where the machine idles.
  call(addr, a = 0) {
    const cpu = this.cpu, ret = (C64_SENTINEL - 1) & 0xFFFF;
    cpu.s = 0xFF; cpu.push(ret >> 8); cpu.push(ret);
    cpu.a = a & 0xFF; cpu.x = 0; cpu.y = 0; cpu.p |= CPU_I; cpu.pc = addr;
  }
  idle() { return this.cpu.pc === C64_SENTINEL; }
  tick(n) {
    this.cyc += n;
    if (this.cia[0].advance(n) && this.onUnderflow) this.onUnderflow();
    this.cia[1].advance(n);
    const { lines, lineCycles } = this.video, line = Math.floor(this.cyc / lineCycles) % lines;
    if (line !== this.line) {
      const cmp = this.d012 | ((this.d011 & 0x80) << 1);
      for (let l = this.line; l !== line;) { l = (l + 1) % lines; if (l === cmp) this.d019 |= 1; }
      this.line = line;
    }
  }
  // Run until the cycle count reaches `until`.
  run(until) {
    const cpu = this.cpu, [c1, c2] = this.cia;
    while (this.cyc < until) {
      const nl = c2.line();
      if (nl && !this.nmiLine) { this.nmiLine = nl; this.tick(cpu.interrupt(0xFFFA)); continue; }
      this.nmiLine = nl;
      if (!(cpu.p & CPU_I) && ((this.d019 & this.d01a & 0xF) || c1.line())) { this.tick(cpu.interrupt(0xFFFE)); continue; }
      if (cpu.pc === C64_SENTINEL) {                   // idle after a call: skip ahead to the next event
        cpu.p &= ~CPU_I;
        const lc = this.video.lineCycles;
        this.tick(Math.max(1, Math.min(lc - (this.cyc % lc), c1.toEvent(), c2.toEvent(), until - this.cyc)));
        continue;
      }
      this.tick(cpu.step());
    }
  }
}
