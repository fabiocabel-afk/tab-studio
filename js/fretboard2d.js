/* Tab Studio — braço 2D visto de cima (canvas).
 * Ocupa toda a altura do painel e mostra só 7 ou 10 casas por vez;
 * a janela anda sozinha, antecipando as próximas notas. */
const L = 100;
const MAXF = 22;
const MARKS = [3, 5, 7, 9, 12, 15, 17, 19, 21];
const STRING_COLORS = ['#b066ff', '#2fd36b', '#ff9a2e', '#3aa0ff', '#ffd23a', '#ff3b4f', '#26d9d9', '#ff66c4'];
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const fretX = n => L * (1 - Math.pow(2, -Math.max(0, n) / 12));

export class Fretboard2D {
  constructor(canvas, opts) {
    this.canvas = canvas; this.opts = opts || {};
    this.g = canvas.getContext('2d');
    this.flip = !!this.opts.flip;
    this.view = 'focus7';
    this.w = 0; this.goal = 0;
    this.strings = [];
    this.visible = true; this.dirty = true;
    this.hover = null;
    this.setInstrument([64, 59, 55, 50, 45, 40]);
    this._grain = this._makeGrain();
    this._bind();
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas.parentElement || canvas);
    this.resize();
    this._loop = this._loop.bind(this); this._last = performance.now();
    requestAnimationFrame(this._loop);
  }
  span() { return this.view === 'focus10' ? 10 : (this.view === 'full' ? MAXF : 7); }
  setView(v) {
    this.view = ['focus7', 'focus10', 'full'].includes(v) ? v : 'focus7';
    if (this.view === 'full') { this.goal = 0; this.w = 0; }
    else this.goal = Math.min(this.goal, MAXF - this.span());
    this.dirty = true;
  }
  setCamera(v) { this.setView(v); }
  setFlip(v) { this.flip = !!v; this.dirty = true; }
  setInstrument(tuning) {
    this.tuning = (tuning && tuning.length) ? tuning.slice() : [64, 59, 55, 50, 45, 40];
    this.N = this.tuning.length;
    this.strings = [];
    for (let s = 1; s <= this.N; s++) this.strings[s] = { s, active: false, static: false, note: null, fret: 0, t0: 0, dur: 1, level: 0, release: 0, color: STRING_COLORS[(this.N - s) % STRING_COLORS.length] };
    this.dirty = true;
  }
  setVisible(v) { this.visible = v; if (v) { this.dirty = true; this._last = performance.now(); requestAnimationFrame(this._loop); } }
  resize() {
    const c = this.canvas, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth || 300, h = c.clientHeight || 150;
    this.W = w; this.H = h;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
  }
  dispose() { this.visible = false; this.ro.disconnect(); }

  /* ---------- notas ---------- */
  play(notes, durMs, upcoming) {
    const now = performance.now(), hit = new Set();
    for (const n of notes) {
      const st = this.strings[n.string]; if (!st) continue;
      hit.add(n.string);
      const sameTie = n.tie && st.active && st.fret === n.fret;
      st.note = n; st.fret = n.fret; st.dur = Math.max(60, durMs);
      st.t0 = now; if (!sameTie) st.hitT = now;
      st.active = true; st.release = 0; st.static = false;
    }
    for (let s = 1; s <= this.N; s++) { const st = this.strings[s]; if (st && st.active && !hit.has(s)) { st.active = false; st.release = now; } }
    this._plan(notes.map(n => n.fret), (upcoming || []).map(n => n.fret));
    this.dirty = true;
  }
  stopAll() { const now = performance.now(); for (let s = 1; s <= this.N; s++) { const st = this.strings[s]; if (st && st.active) { st.active = false; st.release = now; } } this.dirty = true; }
  showStatic(notes, cursorString) {
    const map = new Map(); (notes || []).forEach(n => map.set(n.string, n));
    for (let s = 1; s <= this.N; s++) { const st = this.strings[s]; const n = map.get(s); st.static = !!n; st.active = false; st.release = 0; st.note = n || null; st.fret = n ? n.fret : 0; st.cursor = cursorString === s; }
    if (notes && notes.length) this._plan(notes.map(n => n.fret), []);
    this.dirty = true;
  }
  /** escolhe a janela de casas: só anda quando a nota sai dela, já olhando as próximas */
  _plan(cur, up) {
    if (this.view === 'full') { this.goal = 0; return; }
    const S = this.span();
    const fr = cur.filter(f => f > 0);
    const nxt = up.filter(f => f > 0);
    const inside = f => f >= this.goal + 1 && f <= this.goal + S;
    if (!fr.length && !nxt.length) return;
    const check = fr.concat(nxt.slice(0, 4));
    if (check.every(inside)) return;
    let set = fr.length ? fr.slice() : [nxt[0]];
    let lo = Math.min(...set), hi = Math.max(...set);
    for (const f of nxt) { const l2 = Math.min(lo, f), h2 = Math.max(hi, f); if (h2 - l2 <= S - 1) { lo = l2; hi = h2; } else break; }
    let w = lo - 1;
    if (hi - lo < S - 2) w = lo - 2;            // um respiro à esquerda
    w = Math.max(0, Math.min(MAXF - S, w));
    if (hi > w + S) w = Math.max(0, hi - S);
    this.goal = w;
  }

  /* ---------- desenho ---------- */
  _makeGrain() {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#24130b'; g.fillRect(0, 0, 512, 128);
    for (let i = 0; i < 140; i++) { g.strokeStyle = `rgba(${45 + Math.random() * 40},${20 + Math.random() * 15},${10 + Math.random() * 8},${0.25 + Math.random() * 0.35})`; g.lineWidth = 0.5 + Math.random() * 1.5; g.beginPath(); const y = Math.random() * 128; g.moveTo(0, y); g.bezierCurveTo(170, y + Math.random() * 6 - 3, 340, y + Math.random() * 6 - 3, 512, y + Math.random() * 4 - 2); g.stroke(); }
    return c;
  }
  _geom() {
    const S = this.span();
    const pad = 28 + 22 * Math.max(0, Math.min(1, 1 - this.w));
    const xa = fretX(this.w), xb = fretX(this.w + S);
    const top = 20, bot = this.H - 20;
    const sp = (bot - top) / this.N;
    return { S, pad, xa, xb, top, bot, sp, areaW: this.W - pad - 8 };
  }
  _px(x, G) { return G.pad + (x - G.xa) / (G.xb - G.xa) * G.areaW; }
  _xOf(px, G) { return G.xa + (px - G.pad) / G.areaW * (G.xb - G.xa); }
  _rowY(s, G) { const ti = this.flip ? s - 1 : this.N - s; return G.top + G.sp * (ti + 0.5); }
  _fingerX(f) { return f > 0 ? fretX(f) - (fretX(f) - fretX(f - 1)) * 0.32 : 0; }

  _state(st, now) {
    const n = st.note;
    let level = 0, fret = st.fret, semis = 0, vib = 0, phase = 0;
    if (st.active || (st.release && now - st.release < 260)) {
      const el = now - st.t0, p = Math.min(1, el / st.dur);
      const rel = st.active ? 1 : Math.max(0, 1 - (now - st.release) / 260);
      const since = now - (st.hitT || st.t0);
      level = (n && n.dead ? Math.max(0, 1 - since / 160) : 0.55 + 0.45 * Math.exp(-since / 350)) * rel;
      if (n && n.slideTo != null && p > 0.45) { const k = Math.min(1, (p - 0.45) / 0.5); fret = Math.round(st.fret + (n.slideTo - st.fret) * k); }
      if (n && n.bend) semis = this._bendAt(n.bend, p) / 2;
      if (n && n.vibrato) semis += (n.vibrato === 2 ? 0.5 : 0.25) * (0.5 - 0.5 * Math.cos(2 * Math.PI * 5.5 * el / 1000));
      vib = n && !n.dead ? 4 * Math.exp(-since / 1400) * rel : 0;
      phase = 2 * Math.PI * 17 * el / 1000;
      st.animating = level > 0;
    } else if (st.static) { level = 0.75; if (n && n.bend) semis = Math.max(...n.bend.map(b => b.value)) / 2; st.animating = false; }
    else st.animating = false;
    return { level, fret, semis, vib, phase };
  }
  _bendAt(points, p) {
    const o = p * 60;
    if (o <= points[0].offset) return points[0].value;
    for (let i = 1; i < points.length; i++) { const a = points[i - 1], b = points[i]; if (o <= b.offset) return a.value + (b.value - a.value) * (o - a.offset) / Math.max(1, b.offset - a.offset); }
    return points[points.length - 1].value;
  }

  _draw(now) {
    const g = this.g, W = this.W, H = this.H; if (!W || !H) return false;
    const G = this._geom();
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#0d0c12'; g.fillRect(0, 0, W, H);
    const x0 = Math.max(G.pad, this._px(0, G));
    // escala
    g.save(); g.beginPath(); g.rect(x0, G.top, W - x0, G.bot - G.top); g.clip();
    g.drawImage(this._grain, x0, G.top, W - x0 + 2, G.bot - G.top);
    const sh = g.createLinearGradient(0, G.top, 0, G.bot); sh.addColorStop(0, 'rgba(0,0,0,.35)'); sh.addColorStop(0.15, 'rgba(0,0,0,0)'); sh.addColorStop(0.85, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,.35)');
    g.fillStyle = sh; g.fillRect(x0, G.top, W - x0, G.bot - G.top);
    // marcações trapezoidais
    g.fillStyle = 'rgba(190,178,150,.32)';
    for (const m of MARKS) {
      const a = this._px(fretX(m - 1), G), b = this._px(fretX(m), G); if (b < x0 || a > W) continue;
      const xm = (a + b) / 2, half = (b - a) * 0.24, h = G.bot - G.top, cy = (G.top + G.bot) / 2;
      g.beginPath(); g.moveTo(xm - half, cy - h * 0.31); g.lineTo(xm + half, cy - h * 0.4); g.lineTo(xm + half, cy + h * 0.4); g.lineTo(xm - half, cy + h * 0.31); g.closePath(); g.fill();
    }
    // trastes
    for (let n = 1; n <= MAXF; n++) {
      const x = this._px(fretX(n), G); if (x < x0 - 4 || x > W + 4) continue;
      const fg = g.createLinearGradient(x - 2.5, 0, x + 2.5, 0); fg.addColorStop(0, '#7d7d86'); fg.addColorStop(0.5, '#f1f1f6'); fg.addColorStop(1, '#6e6e77');
      g.fillStyle = fg; g.fillRect(x - 2.5, G.top, 5, G.bot - G.top);
    }
    g.restore();
    // pestana
    const nutX = this._px(0, G);
    if (nutX >= G.pad - 2) { g.fillStyle = '#e8dcc0'; g.fillRect(nutX - 6, G.top - 2, 7, G.bot - G.top + 4); }
    // números só nas casas marcadas
    g.font = 'bold 13px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const m of MARKS) { const a = this._px(fretX(m - 1), G), b = this._px(fretX(m), G); const xm = (a + b) / 2; if (xm < G.pad || xm > W - 4) continue; g.fillStyle = m === 12 ? '#f2a33a' : '#cfc8dc'; g.fillText(String(m), xm, G.bot + 11); }
    // cordas
    let anim = false;
    const markers = [];
    for (let s = 1; s <= this.N; s++) {
      const st = this.strings[s]; if (!st) continue;
      const S = this._state(st, now); if (st.animating) anim = true;
      const y = this._rowY(s, G);
      const thick = 1.1 + 2.9 * ((this.N - s) / Math.max(1, this.N - 1));
      const fx = this._fingerX(S.fret);
      const fpx = S.fret > 0 ? this._px(fx, G) : nutX;
      // deslocamento lateral (bend) em px, forma triangular pestana→dedo→ponte
      const towardLow = (this.N - s) < this.N / 2;
      const dirY = (towardLow ? 1 : -1) * (this.flip ? -1 : 1);   // agudas vão em direção às graves
      const D = S.fret > 0 ? S.semis * G.sp * 0.35 * dirY : 0;
      const disp = (xr) => {
        let d = 0;
        if (D && fx > 0) d = xr <= fx ? D * xr / fx : D * (L - xr) / (L - fx);
        if (S.vib && xr > fx) { const u = (xr - fx) / (L - fx); d += S.vib * Math.sin(Math.PI * u) * Math.sin(S.phase) * 0.6; }
        return d;
      };
      const path = (from) => { g.beginPath(); let first = true; for (let px = from; px <= W; px += 3) { const yy = y + disp(this._xOf(px, G)); if (first) { g.moveTo(px, yy); first = false; } else g.lineTo(px, yy); } };
      // corda base
      const wound = this.N <= 5 ? true : s <= 3;
      g.strokeStyle = wound ? '#c9a86a' : '#dcdde4'; g.lineWidth = thick; g.globalAlpha = 0.9;
      path(Math.max(nutX, G.pad - 26)); g.stroke(); g.globalAlpha = 1;
      if (st.cursor && !S.level) { g.strokeStyle = 'rgba(196,168,255,.35)'; g.lineWidth = thick + 8; path(G.pad); g.stroke(); }
      // brilho do dedo até a ponte (sai pela borda direita)
      if (S.level > 0) {
        const from = Math.max(fpx, G.pad - 26);
        g.save(); g.shadowColor = st.color; g.shadowBlur = 18;
        g.strokeStyle = st.color; g.globalAlpha = 0.55 * S.level; g.lineWidth = thick + 7; path(from); g.stroke();
        g.shadowBlur = 0; g.globalAlpha = Math.min(1, 0.4 + S.level); g.strokeStyle = '#fff6e8'; g.lineWidth = Math.max(1.2, thick * 0.7); path(from); g.stroke();
        g.restore();
        // seta: a corda continua acesa até a ponte
        g.fillStyle = st.color; g.globalAlpha = 0.85 * S.level;
        g.beginPath(); g.moveTo(W - 2, y + disp(this._xOf(W - 2, G))); g.lineTo(W - 12, y - 6); g.lineTo(W - 12, y + 6); g.closePath(); g.fill(); g.globalAlpha = 1;
        markers.push({ x: S.fret > 0 ? fpx : Math.max(G.pad - 14, nutX - 14), y: y + (S.fret > 0 ? D : 0), fret: S.fret, color: st.color, level: S.level, dead: st.note && st.note.dead, open: S.fret === 0 });
      }
      // nome da corda solta
      if (G.pad > 34) { const m = this.tuning[this.N - s]; g.fillStyle = st.color; g.font = 'bold 12px system-ui, sans-serif'; g.textAlign = 'center'; g.fillText(NOTE[m % 12], 12, y); }
    }
    // marcadores (por cima das cordas)
    const r = Math.max(9, Math.min(G.sp * 0.42, 22));
    for (const mk of markers) {
      g.save(); g.shadowColor = mk.color; g.shadowBlur = 20 * mk.level;
      g.fillStyle = mk.color; g.beginPath(); g.arc(mk.x, mk.y, r, 0, Math.PI * 2); g.fill(); g.restore();
      g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.arc(mk.x, mk.y, r, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#120f18'; g.font = 'bold ' + Math.round(r * 1.05) + 'px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(mk.dead ? 'x' : String(mk.fret), mk.x, mk.y + 1);
    }
    // marcador de passagem do mouse
    if (this.hover) {
      const h = this.hover; const hx = h.fret > 0 ? this._px(this._fingerX(h.fret), G) : nutX - 14; const hy = this._rowY(h.string, G);
      g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = 2; g.setLineDash([4, 3]); g.beginPath(); g.arc(hx, hy, r, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    }
    // minimapa do braço inteiro com a janela
    const mx0 = G.pad, mx1 = W - 8, my = 6, mw = mx1 - mx0;
    const mpx = x => mx0 + x / fretX(MAXF + 0.6) * mw;
    g.fillStyle = '#2a2634'; g.fillRect(mx0, my, mw, 6);
    g.fillStyle = 'rgba(242,163,58,.55)'; const wa = mpx(fretX(this.w)), wb = mpx(fretX(this.w + G.S)); g.fillRect(wa, my - 2, Math.max(4, wb - wa), 10);
    g.fillStyle = '#5a5470'; for (const m of MARKS) { g.fillRect(mpx((fretX(m - 1) + fretX(m)) / 2) - 1, my + 1, 2, 4); }
    for (const mk of markers) { if (mk.open) continue; g.fillStyle = mk.color; g.beginPath(); g.arc(mpx(this._xOf(mk.x, G)), my + 3, 3, 0, Math.PI * 2); g.fill(); }
    return anim;
  }

  _loop(now) {
    if (!this.visible) return;
    const dt = Math.min(100, now - this._last); this._last = now;
    let moving = false;
    if (Math.abs(this.goal - this.w) > 0.002) { this.w += (this.goal - this.w) * (1 - Math.exp(-dt / 140)); moving = true; } else this.w = this.goal;
    let anim = false;
    for (let s = 1; s <= this.N; s++) { const st = this.strings[s]; if (st && (st.active || st.static || (st.release && now - st.release < 300))) anim = true; }
    if (this.dirty || moving || anim || this.hover) { this._draw(now); this.dirty = false; }
    requestAnimationFrame(this._loop);
  }

  /* ---------- toque para escrever ---------- */
  _hit(e) {
    const r = this.canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
    const G = this._geom(); if (py < G.top - 6 || py > G.bot + 6) return null;
    const xr = this._xOf(px, G);
    let fret = 0;
    if (px > G.pad && xr > 0) { for (let n = 1; n <= MAXF; n++) if (xr <= fretX(n)) { fret = n; break; } if (!fret) fret = MAXF; }
    let best = 1, bd = Infinity; for (let s = 1; s <= this.N; s++) { const d = Math.abs(this._rowY(s, G) - py); if (d < bd) { bd = d; best = s; } }
    return { string: best, fret };
  }
  _bind() {
    let down = null;
    this.canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
    this.canvas.addEventListener('pointerup', e => { if (!down) return; const m = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null; if (m > 8) return; const h = this._hit(e); if (h && this.opts.onPick) this.opts.onPick(h.string, h.fret); });
    this.canvas.addEventListener('pointermove', e => { if (e.pointerType !== 'mouse') return; this.hover = this._hit(e); this.dirty = true; });
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.dirty = true; });
  }
}
