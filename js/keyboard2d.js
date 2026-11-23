/* Tab Studio — teclado 2D (canvas).
 * Modos: faixa tocada (só as teclas que vêm a seguir), duas mãos (janela de ~10 teclas
 * brancas para cada mão) e teclado inteiro. Referência: só os Dós (C3, C4…). */
import { LOW, HIGH, WHITE_COUNT, isBlack, noteName, whiteIndex, whiteToMidi, clampPitch, HandTracker, HAND_COLORS } from './pianokeys.js';

const HAND_SPAN = 10;      // teclas brancas que uma mão alcança com conforto (≈ uma décima)
const RANGE_MIN = 15;      // mínimo de teclas brancas no modo faixa

export class Keyboard2D {
  constructor(canvas, opts) {
    this.canvas = canvas; this.opts = opts || {};
    this.g = canvas.getContext('2d');
    this.view = 'range';
    this.keys = new Map();
    this.hands = new HandTracker();
    this.win = { range: { s: whiteIndex(48), c: 22, gs: whiteIndex(48), gc: 22 }, L: { s: whiteIndex(43), gs: whiteIndex(43) }, R: { s: whiteIndex(60), gs: whiteIndex(60) } };
    this.visible = true; this.dirty = true;
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas.parentElement || canvas);
    this.resize();
    this._loop = this._loop.bind(this); this._last = performance.now();
    requestAnimationFrame(this._loop);
  }
  setView(v) { this.view = ['range', 'hands', 'full'].includes(v) ? v : 'range'; this.dirty = true; }
  setCamera(v) { this.setView(v); }
  setTrack() { this.hands.reset(); this.keys.clear(); this.dirty = true; }
  setInstrument() { /* teclado não depende de afinação */ }
  setFlip() { }
  setVisible(v) { this.visible = v; if (v) { this.dirty = true; this._last = performance.now(); requestAnimationFrame(this._loop); } }
  resize() {
    const c = this.canvas, dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = c.clientWidth || 300; this.H = c.clientHeight || 150;
    c.width = Math.round(this.W * dpr); c.height = Math.round(this.H * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0); this.dirty = true;
  }
  dispose() { this.visible = false; this.ro.disconnect(); }

  _prep(notes, learn) {
    const list = (notes || []).filter(n => n.pitch != null && !n.dead).map(n => ({ pitch: clampPitch(n.pitch), hand: n.hand || null, tie: n.tie }));
    if (learn) this.hands.assign(list);
    else { const t = new HandTracker(); t.c = Object.assign({}, this.hands.c); t.assign(list); }
    return list;
  }
  /** notas que ainda vão tocar (anel vazado, menor) */
  setPreview(list) {
    this.preview = new Map();
    for (const n of this._prep(list || [], false)) if (!this.preview.has(n.pitch)) this.preview.set(n.pitch, n.hand);
    this.dirty = true;
  }
  play(notes, durMs, upcoming, preview) {
    const now = performance.now();
    const cur = this._prep(notes, true), up = this._prep(upcoming, false);
    this.setPreview(preview);
    const hit = new Set();
    for (const n of cur) {
      const k = this.keys.get(n.pitch) || {};
      const same = n.tie && k.active;
      Object.assign(k, { active: true, static: false, release: 0, hand: n.hand, dur: Math.max(60, durMs), t0: same ? k.t0 : now });
      this.keys.set(n.pitch, k); hit.add(n.pitch);
    }
    for (const [p, k] of this.keys) if (k.active && !hit.has(p)) { k.active = false; k.release = now; }
    this._plan(cur, up);
    this.dirty = true;
  }
  stopAll() { const now = performance.now(); for (const k of this.keys.values()) if (k.active) { k.active = false; k.release = now; } this.preview = new Map(); this.dirty = true; }
  showStatic(notes) {
    this.keys.clear();
    const cur = this._prep(notes, false);
    for (const n of cur) this.keys.set(n.pitch, { static: true, hand: n.hand, active: false });
    if (cur.length) this._plan(cur, []);
    this.dirty = true;
  }
  /* janelas: só andam quando a nota não cabe, já olhando as próximas */
  _plan(cur, up) {
    // faixa tocada
    const all = cur.concat(up);
    if (all.length) {
      const R = this.win.range;
      const inR = n => { const w = whiteIndex(n.pitch); return w >= R.gs && w < R.gs + R.gc; };
      if (!cur.every(inR) || !up.slice(0, 8).every(inR)) {
        let lo = Math.min(...all.map(n => whiteIndex(n.pitch))) - 2, hi = Math.max(...all.map(n => whiteIndex(n.pitch))) + 2;
        if (hi - lo + 1 < RANGE_MIN) { const mid = (lo + hi) / 2; lo = Math.round(mid - RANGE_MIN / 2); hi = lo + RANGE_MIN - 1; }
        lo = Math.max(0, lo); hi = Math.min(WHITE_COUNT - 1, hi);
        R.gs = lo; R.gc = hi - lo + 1;
      }
    }
    // duas mãos
    for (const h of ['L', 'R']) {
      const W = this.win[h];
      const c = cur.filter(n => n.hand === h).map(n => whiteIndex(n.pitch));
      const u = up.filter(n => n.hand === h).map(n => whiteIndex(n.pitch));
      if (!c.length && !u.length) continue;
      const inside = w => w >= W.gs && w < W.gs + HAND_SPAN;
      if (c.every(inside) && u.slice(0, 6).every(inside)) continue;
      let set = c.length ? c : [u[0]];
      let lo = Math.min(...set), hi = Math.max(...set);
      for (const w of u) { const l2 = Math.min(lo, w), h2 = Math.max(hi, w); if (h2 - l2 < HAND_SPAN) { lo = l2; hi = h2; } else break; }
      let s = lo - Math.max(0, Math.floor((HAND_SPAN - (hi - lo + 1)) / 2));
      if (hi >= s + HAND_SPAN) s = hi - HAND_SPAN + 1;
      W.gs = Math.max(0, Math.min(WHITE_COUNT - HAND_SPAN, s));
    }
  }

  _level(k, now) {
    if (k.static) return 0.8;
    if (k.active) { const since = now - k.t0; return 0.6 + 0.4 * Math.exp(-since / 400); }
    if (k.release) { const d = now - k.release; return d < 220 ? 0.6 * (1 - d / 220) : 0; }
    return 0;
  }
  /* esfera do dedo: cor forte da mão, nota em branco; cresce ao apertar */
  _finger(cx, cy, r, color, name, k, now) {
    const g = this.g;
    const grow = k && k.t0 && !k.static ? Math.min(1, 0.62 + 0.38 * (now - k.t0) / 130) : 1;
    const rr = r * grow;
    g.save(); g.shadowColor = color; g.shadowBlur = 14;
    const gr = g.createRadialGradient(cx - rr * 0.35, cy - rr * 0.4, rr * 0.1, cx, cy, rr);
    gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.18, color); gr.addColorStop(1, color);
    g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, rr, 0, Math.PI * 2); g.fill(); g.restore();
    g.fillStyle = '#ffffff'; g.font = 'bold ' + Math.max(8, Math.round(rr * (name.length > 2 ? 0.62 : 0.78))) + 'px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(name, cx, cy + 1);
  }
  _ring(cx, cy, r, color) {
    const g = this.g; g.strokeStyle = color; g.lineWidth = Math.max(2, r * 0.18);
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  }
  _region(x, y, w, h, ws, wc, label) {
    const g = this.g, now = this._now;
    const ww = w / wc;
    const fingers = [], rings = [];
    const pv = this.preview || new Map();
    g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
    const first = Math.max(0, Math.floor(ws)), last = Math.min(WHITE_COUNT - 1, Math.ceil(ws + wc));
    const rW = Math.max(7, Math.min(ww * 0.42, 22));
    // teclas brancas
    for (let wi = first; wi <= last; wi++) {
      const m = whiteToMidi(wi); const kx = x + (wi - ws) * ww;
      const k = this.keys.get(m); const lv = k ? this._level(k, now) : 0;
      g.fillStyle = '#f4f1ea'; g.fillRect(kx + 0.5, y, ww - 1, h);
      if (lv > 0) {
        const col = HAND_COLORS[k.hand || 'X'];
        g.globalAlpha = Math.min(0.45, lv * 0.5); g.fillStyle = col; g.fillRect(kx + 0.5, y, ww - 1, h); g.globalAlpha = 1;
        fingers.push([kx + ww / 2, y + h * 0.74, rW, col, noteName(m), k]);
      } else if (pv.has(m)) rings.push([kx + ww / 2, y + h * 0.74, rW * 0.62, HAND_COLORS[pv.get(m) || 'X']]);
      g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(kx + ww - 1, y, 1, h);
      if (m % 12 === 0 && lv <= 0) { const fs = Math.max(9, Math.min(13, ww * 0.42)); g.fillStyle = '#8a8494'; g.font = 'bold ' + fs + 'px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillText(noteName(m), kx + ww / 2, y + h - 6); }
    }
    // teclas pretas
    const bw = ww * 0.6, bh = h * 0.62;
    const rB = Math.max(6, Math.min(bw * 0.5, 18));
    for (let wi = first - 1; wi <= last; wi++) {
      if (wi < 0) continue;
      const m = whiteToMidi(wi) + 1; if (m > HIGH || !isBlack(m)) continue;
      const bx = x + (wi + 1 - ws) * ww - bw / 2;
      const k = this.keys.get(m); const lv = k ? this._level(k, now) : 0;
      const gr = g.createLinearGradient(0, y, 0, y + bh); gr.addColorStop(0, '#2a2730'); gr.addColorStop(1, '#0b0a0d');
      g.fillStyle = gr; g.fillRect(bx, y, bw, bh);
      if (lv > 0) {
        const col = HAND_COLORS[k.hand || 'X'];
        g.globalAlpha = Math.min(0.55, lv * 0.6); g.fillStyle = col; g.fillRect(bx + 1, y, bw - 2, bh - 2); g.globalAlpha = 1;
        fingers.push([bx + bw / 2, y + bh * 0.72, rB, col, noteName(m), k]);
      } else if (pv.has(m)) rings.push([bx + bw / 2, y + bh * 0.72, rB * 0.62, HAND_COLORS[pv.get(m) || 'X']]);
    }
    for (const rg of rings) this._ring(...rg);
    for (const f of fingers) this._finger(f[0], f[1], f[2], f[3], f[4], f[5], now);
    g.restore();
    g.strokeStyle = '#3a3546'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    if (label) { g.fillStyle = '#a9a3b8'; g.font = '11px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(label, x + 2, y - 8); }
  }
  _mini(y, wins) {
    const g = this.g, x0 = 10, x1 = this.W - 10, w = x1 - x0, ww = w / WHITE_COUNT;
    g.fillStyle = '#2a2634'; g.fillRect(x0, y, w, 6);
    for (const [s, c, col] of wins) { g.fillStyle = col; g.globalAlpha = 0.55; g.fillRect(x0 + s * ww, y - 2, Math.max(3, c * ww), 10); g.globalAlpha = 1; }
    for (const [p, k] of this.keys) { const lv = this._level(k, this._now); if (lv <= 0) continue; g.fillStyle = HAND_COLORS[k.hand || 'X']; g.beginPath(); g.arc(x0 + (whiteIndex(p) + (isBlack(p) ? 1 : 0.5)) * ww, y + 3, 2.5, 0, Math.PI * 2); g.fill(); }
    // Dós de referência no minimapa
    g.fillStyle = '#5a5470'; for (let m = 24; m <= HIGH; m += 12) g.fillRect(x0 + whiteIndex(m) * ww, y + 1, 1, 4);
  }
  _draw(now) {
    this._now = now;
    const g = this.g, W = this.W, H = this.H; if (!W || !H) return;
    g.clearRect(0, 0, W, H); g.fillStyle = '#0d0c12'; g.fillRect(0, 0, W, H);
    const top = 20, kh = H - top - 6;
    if (this.view === 'full') { this._mini(6, [[0, WHITE_COUNT, '#f2a33a']]); this._region(6, top, W - 12, kh, 0, WHITE_COUNT); return; }
    if (this.view === 'range') { const R = this.win.range; this._mini(6, [[R.s, R.c, '#f2a33a']]); this._region(6, top, W - 12, kh, R.s, R.c); return; }
    // duas mãos
    const gap = 14, half = (W - 12 - gap) / 2, L = this.win.L, R = this.win.R;
    this._mini(6, [[L.s, HAND_SPAN, HAND_COLORS.L], [R.s, HAND_SPAN, HAND_COLORS.R]]);
    this._region(6, top + 14, half, kh - 14, L.s, HAND_SPAN, 'Mão esquerda');
    this._region(6 + half + gap, top + 14, half, kh - 14, R.s, HAND_SPAN, 'Mão direita');
    g.fillStyle = '#3a3546'; g.fillRect(6 + half + gap / 2 - 1, top + 6, 2, kh - 6);
  }
  _loop(now) {
    if (!this.visible) return;
    const dt = Math.min(100, now - this._last); this._last = now;
    const k = 1 - Math.exp(-dt / 160);
    let moving = false;
    const ease = (o, a, b) => { if (Math.abs(o[b] - o[a]) > 0.002) { o[a] += (o[b] - o[a]) * k; moving = true; } else o[a] = o[b]; };
    ease(this.win.range, 's', 'gs'); ease(this.win.range, 'c', 'gc'); ease(this.win.L, 's', 'gs'); ease(this.win.R, 's', 'gs');
    let anim = false; for (const kk of this.keys.values()) if (kk.active || (kk.release && now - kk.release < 260)) { anim = true; break; }
    if (this.dirty || moving || anim) { this._draw(now); this.dirty = false; }
    requestAnimationFrame(this._loop);
  }
}
export { LOW, HIGH };
