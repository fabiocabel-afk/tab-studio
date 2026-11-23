/* Tab Studio — utilidades de teclado (piano 88 teclas, A0=21 … C8=108). */
export const LOW = 21, HIGH = 108;
const BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// identidade visual: laranja (mão direita) e verde (mão esquerda)
export const HAND_COLORS = { L: '#99CC33', R: '#FF9901', X: '#FF9901' };

export function isBlack(m) { return BLACK[((m % 12) + 12) % 12]; }
export function noteName(m) { return NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }
/** índice da tecla branca (0 = A0). Para preta, a branca à esquerda. */
export function whiteIndex(m) {
  let n = 0;
  for (let k = LOW; k < m; k++) if (!isBlack(k)) n++;
  return isBlack(m) ? n - 1 : n;
}
export const WHITE_COUNT = whiteIndex(HIGH) + 1; // 52
export function whiteToMidi(w) { let n = -1; for (let k = LOW; k <= HIGH; k++) { if (!isBlack(k)) { n++; if (n === w) return k; } } return HIGH; }
export function clampPitch(m) { while (m < LOW) m += 12; while (m > HIGH) m -= 12; return m; }

/** Separa as notas entre mão esquerda (L) e direita (R).
 * Usa a pauta quando o arquivo tem duas (sol = direita, fá = esquerda);
 * senão, decide pela altura, com centros que acompanham cada mão. */
export class HandTracker {
  constructor() { this.reset(); }
  reset() { this.c = { L: 50, R: 67 }; }
  assign(notes) {
    const free = notes.filter(n => !n.hand).sort((a, b) => a.pitch - b.pitch);
    if (free.length) {
      // acorde largo: divide no maior intervalo
      let cut = -1;
      if (free.length > 1 && free[free.length - 1].pitch - free[0].pitch > 14) {
        let best = 0;
        for (let i = 1; i < free.length; i++) { const gap = free[i].pitch - free[i - 1].pitch; if (gap > best) { best = gap; cut = i; } }
      }
      free.forEach((n, i) => {
        if (cut > 0) n.hand = i < cut ? 'L' : 'R';
        else n.hand = Math.abs(n.pitch - this.c.L) < Math.abs(n.pitch - this.c.R) ? 'L' : 'R';
      });
    }
    for (const h of ['L', 'R']) {
      const ps = notes.filter(n => n.hand === h).map(n => n.pitch);
      if (ps.length) { const avg = ps.reduce((a, b) => a + b, 0) / ps.length; this.c[h] += (avg - this.c[h]) * 0.35; }
    }
    if (this.c.R - this.c.L < 7) { const mid = (this.c.R + this.c.L) / 2; this.c.L = mid - 4; this.c.R = mid + 4; }
    return notes;
  }
}
