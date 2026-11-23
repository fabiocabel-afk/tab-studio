/* Tab Studio — bateria 2D (canvas).
 * Duas visões:
 *  · "De cima": o kit visto de cima, com o baterista embaixo. A peça tocada acende na cor
 *    de quem bate (mãos = laranja, pés = verde); tambores pulsam e pratos balançam.
 *  · "Pistas": uma faixa por peça, as notas descem até a linha de batida
 *    (o bumbo é uma barra que atravessa todas as faixas). */
import { pieceOf, buildKit, layoutTop, laneOrder, velocityOf, LIMB_COLORS } from './drumkit.js';

const LOOK = 2400;          // ms de antecedência visíveis nas pistas
const SHELL = '#5c1218';    // casco vermelho escuro (combina com a Les Paul)
const SHELL_D = '#2e080c';
const CHROME = '#b9bcc6';

export class Drums2D {
  constructor(canvas, opts) {
    this.canvas = canvas; this.opts = opts || {};
    this.g = canvas.getContext('2d');
    this.view = 'kit';
    this.hits = new Map();       // id → { t0, vel, limb, v, static }
    this.future = [];            // pistas: { id, v, limb, vel, when }
    this.preview = new Map();    // id → limb
    this.setKit([]);
    this.visible = true; this.dirty = true;
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas.parentElement || canvas);
    this.resize();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }
  setView(v) { this.view = v === 'lanes' ? 'lanes' : 'kit'; this.dirty = true; }
  setCamera(v) { this.setView(v); }
  setKit(midis) { this.kit = buildKit(midis); this.pos = layoutTop(this.kit); this.lanes = laneOrder(this.kit); this.hits.clear(); this.future = []; this.dirty = true; }
  setTrack(o) { if (o && o.drums) this.setKit(o.drums); }
  setInstrument() { }
  setFlip() { }
  setVisible(v) { this.visible = v; if (v) { this.dirty = true; requestAnimationFrame(this._loop); } }
  resize() {
    const c = this.canvas, dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = c.clientWidth || 300; this.H = c.clientHeight || 150;
    c.width = Math.round(this.W * dpr); c.height = Math.round(this.H * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0); this.dirty = true;
  }
  dispose() { this.visible = false; this.ro.disconnect(); }

  _info(n) {
    if (n.drum == null) return null;
    const p = pieceOf(n.drum);
    // peça que o kit não tem (ex.: tom fora do mapa) vai para a mais parecida
    let id = p.id;
    if (!this.kit.byId.has(id)) id = id.startsWith('tom') ? (this.kit.pieces.find(x => x.tom) || {}).id : 'snare';
    return { id, v: p.v, limb: p.limb, vel: velocityOf(n) };
  }
  setPreview(list) {
    this.preview = new Map();
    for (const n of list || []) { const i = this._info(n); if (i && !this.preview.has(i.id + (i.v === 'pedal' ? ':p' : ''))) this.preview.set(i.id + (i.v === 'pedal' ? ':p' : ''), i.limb); }
    this.dirty = true;
  }
  play(notes, durMs, upcoming, preview) {
    const now = performance.now();
    for (const n of notes || []) {
      if (n.tie) continue;
      const i = this._info(n); if (!i) continue;
      const key = i.v === 'pedal' ? i.id + ':p' : i.id;
      this.hits.set(key, { t0: now, vel: i.vel, limb: i.limb, v: i.v });
    }
    // pistas: troca o futuro pelo planejado agora (mantém as que já passaram, para sumirem suaves)
    this.future = this.future.filter(f => f.when < now - 1);
    for (const n of notes || []) { if (n.tie) continue; const i = this._info(n); if (i) this.future.push(Object.assign(i, { when: now })); }
    for (const n of upcoming || []) { if (n.tie || n.at == null) continue; const i = this._info(n); if (i) this.future.push(Object.assign(i, { when: now + n.at })); }
    this.setPreview(preview);
    this.dirty = true;
  }
  stopAll() { this.future = []; this.preview = new Map(); for (const h of this.hits.values()) h.static = false; this.dirty = true; }
  showStatic(notes) {
    this.hits.clear(); this.future = [];
    for (const n of notes || []) { const i = this._info(n); if (i) this.hits.set(i.v === 'pedal' ? i.id + ':p' : i.id, { t0: 0, vel: i.vel, limb: i.limb, v: i.v, static: true }); }
    this.dirty = true;
  }
  /** quanto a peça está "acesa" (0..1) */
  level(key, now) {
    const h = this.hits.get(key); if (!h) return 0;
    if (h.static) return 0.8;
    const d = (now || performance.now()) - h.t0; if (d < 0) return 0;
    const cym = /hihat|crash|ride|china|splash/.test(key);
    return h.vel * Math.exp(-d / (cym ? 520 : 240));
  }

  /** vibração da batida: a peça encolhe e cresce rápido (≈10 vezes por segundo) e para em ~0,4 s.
   *  Com batidas seguidas ela fica "tremendo", então dá para ver o que está tocando mesmo em música rápida. */
  pulse(key, now, amp) {
    const h = this.hits.get(key); if (!h || h.static) return 1;
    const t = now - h.t0; if (t < 0 || t > 450) return 1;
    return 1 - (amp || 0.09) * (0.5 + 0.5 * h.vel) * Math.exp(-t / 150) * Math.sin(t * 0.066);
  }
  _scaled(x, y, k, draw) {
    if (k === 1) { draw(); return; }
    const g = this.g; g.save(); g.translate(x, y); g.scale(k, k); g.translate(-x, -y); draw(); g.restore();
  }
  /* ---------------- vista de cima ---------------- */
  /* escala: em painel largo e baixo o kit se espalha na horizontal (até 1,7×), para não ficar miúdo */
  _fit() {
    const pad = 8, sy = Math.min((this.H - pad * 2) / 64, (this.W - pad * 2) / 100);
    const sx = Math.min((this.W - pad * 2) / 100, sy * 1.7);
    const s = sy * Math.min(1.2, 1 + (sx / sy - 1) * 0.3);   // tamanho das peças
    return { s, sx, sy, ox: (this.W - 100 * sx) / 2, oy: (this.H - 64 * sy) / 2 + sy };
  }
  _glow(x, y, r, color, a) {
    const g = this.g; if (a <= 0.01) return;
    const gr = g.createRadialGradient(x, y, r * 0.6, x, y, r * 1.45);
    gr.addColorStop(0, color); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = Math.min(1, a * 0.9); g.fillStyle = gr; g.beginPath(); g.arc(x, y, r * 1.45, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
  }
  _stick(x, y, r, color, lv, t0, now) {
    // "ponta da baqueta": esfera na cor de quem bate, cresce ao bater
    const g = this.g, grow = t0 ? Math.min(1, 0.6 + 0.4 * (now - t0) / 110) : 1, rr = r * grow * (0.75 + 0.35 * lv);
    g.save(); g.globalAlpha = Math.min(1, 0.35 + lv); g.shadowColor = color; g.shadowBlur = 12;
    const gr = g.createRadialGradient(x - rr * 0.35, y - rr * 0.4, rr * 0.1, x, y, rr);
    gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.2, color); gr.addColorStop(1, color);
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill(); g.restore();
  }
  _ring(x, y, r, color) { const g = this.g; g.strokeStyle = color; g.lineWidth = Math.max(2, r * 0.2); g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke(); }
  _label(text, x, y, on, size) {
    const g = this.g; g.font = (on ? 'bold ' : '') + size + 'px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'top';
    const w = g.measureText(text).width + 8;
    y = Math.min(y, this.H - size - 4);
    g.fillStyle = 'rgba(13,12,18,.72)'; g.beginPath(); g.roundRect(x - w / 2, y - 1, w, size + 4, 4); g.fill();
    g.fillStyle = on ? '#ffffff' : '#a9a3b8'; g.fillText(text, x, y + 1);
  }
  _drum(p, x, y, r, now) { this._scaled(x, y, this.pulse(p.id, now), () => this._drum0(p, x, y, r, now)); }
  _drum0(p, x, y, r, now) {
    const g = this.g, key = p.id, lv = this.level(key, now), h = this.hits.get(key);
    const col = h ? LIMB_COLORS[h.limb] : LIMB_COLORS.hand;
    this._glow(x, y, r, col, lv);
    // casco e aro
    g.fillStyle = SHELL_D; g.beginPath(); g.arc(x, y + r * 0.06, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = SHELL; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = CHROME; g.lineWidth = Math.max(1.5, r * 0.09); g.beginPath(); g.arc(x, y, r * 0.93, 0, Math.PI * 2); g.stroke();
    // pele (afunda um pouco ao bater)
    const hr = r * 0.86 * (1 - 0.05 * lv);
    const gr = g.createRadialGradient(x - hr * 0.3, y - hr * 0.3, hr * 0.1, x, y, hr);
    gr.addColorStop(0, key === 'snare' ? '#fbf8f1' : '#ece5d4'); gr.addColorStop(1, key === 'snare' ? '#d9d3c5' : '#c9c0aa');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, hr, 0, Math.PI * 2); g.fill();
    if (lv > 0.01) { g.globalAlpha = Math.min(0.6, lv * 0.65); g.fillStyle = col; g.beginPath(); g.arc(x, y, hr, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; }
    // afinadores
    g.fillStyle = CHROME; const nl = key === 'snare' ? 10 : 8;
    for (let i = 0; i < nl; i++) { const a = i / nl * Math.PI * 2; g.beginPath(); g.arc(x + Math.cos(a) * r * 0.985, y + Math.sin(a) * r * 0.985, Math.max(1, r * 0.06), 0, Math.PI * 2); g.fill(); }
    if (h && h.v === 'rim' && lv > 0.05) { g.strokeStyle = col; g.lineWidth = Math.max(2, r * 0.14); g.beginPath(); g.arc(x, y, r * 0.93, Math.PI * 0.55, Math.PI * 1.05); g.stroke(); }
    else if (lv > 0.05 || (h && h.static)) this._stick(x, y + r * 0.25, Math.max(5, r * 0.26), col, lv, h.static ? 0 : h.t0, now);
    if (this.preview.has(key) && lv < 0.3) this._ring(x, y + r * 0.25, Math.max(4, r * 0.2), LIMB_COLORS[this.preview.get(key)]);
  }
  _cymbal(p, x, y, r, now) {
    const k = Math.min(this.pulse(p.id, now, 0.07), p.id === 'hihat' ? this.pulse('hihat:p', now, 0.07) : 1);
    this._scaled(x, y, k, () => this._cymbal0(p, x, y, r, now));
  }
  _cymbal0(p, x, y, r, now) {
    const g = this.g, key = p.id, lv = this.level(key, now), h = this.hits.get(key);
    const col = h ? LIMB_COLORS[h.limb] : LIMB_COLORS.hand;
    this._glow(x, y, r, col, lv * 0.8);
    // balanço: a elipse oscila quando o prato é batido
    const t = h && !h.static ? (now - h.t0) / 1000 : 0;
    const wob = lv * 0.13 * Math.sin(t * 28), ang = lv * 0.16 * Math.sin(t * 17);
    g.save(); g.translate(x, y); g.rotate(ang); g.scale(1 + wob, 1 - wob);
    const gr = g.createRadialGradient(-r * 0.25, -r * 0.25, r * 0.05, 0, 0, r);
    gr.addColorStop(0, '#f1d38a'); gr.addColorStop(0.55, '#c99a3c'); gr.addColorStop(1, '#8c6420');
    if (key === 'china') { gr.addColorStop(0, '#d7b56a'); }
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(80,50,10,.28)'; g.lineWidth = 0.8;
    for (let k = 0.35; k < 0.98; k += 0.12) { g.beginPath(); g.arc(0, 0, r * k, 0, Math.PI * 2); g.stroke(); }
    g.fillStyle = '#e6c477'; g.beginPath(); g.arc(0, 0, r * 0.22, 0, Math.PI * 2); g.fill();
    if (lv > 0.01) { g.globalAlpha = Math.min(0.55, lv * 0.6); g.fillStyle = col; g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; }
    // chimbal aberto: o prato de cima "se separa"
    if (key === 'hihat' && h && h.v === 'open' && lv > 0.05) { g.strokeStyle = '#f6e2a6'; g.lineWidth = 2; g.beginPath(); g.arc(-r * 0.08, -r * 0.1, r * 0.98, 0, Math.PI * 2); g.stroke(); }
    g.fillStyle = '#3b3a40'; g.beginPath(); g.arc(0, 0, Math.max(1.5, r * 0.06), 0, Math.PI * 2); g.fill();
    g.restore();
    if (lv > 0.05 || (h && h.static)) {
      const bell = h && h.v === 'bell';
      this._stick(x + (bell ? 0 : r * 0.45), y + (bell ? 0 : r * 0.35), Math.max(5, r * 0.2), col, lv, h.static ? 0 : h.t0, now);
    }
    if (this.preview.has(key) && lv < 0.3) this._ring(x + r * 0.45, y + r * 0.35, Math.max(4, r * 0.16), LIMB_COLORS[this.preview.get(key)]);
  }
  _drawKit(now) {
    const g = this.g, { s, sx, sy, ox, oy } = this._fit();
    const X = v => ox + v * sx, Y = v => oy + v * sy;
    const labels = [];
    // tapete
    g.fillStyle = '#17131f'; g.beginPath(); g.ellipse(X(50), Y(33), 53 * sx, 34 * sy, 0, 0, Math.PI * 2); g.fill();
    // banco do baterista
    g.fillStyle = '#26232d'; g.beginPath(); g.arc(X(50), Y(61), 4.6 * s, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#34303d'; g.beginPath(); g.arc(X(50), Y(61), 3.5 * s, 0, Math.PI * 2); g.fill();
    const fs = Math.max(9, Math.min(13, s * 2.4));
    // bumbo (visto de cima é um "retângulo": o tambor está deitado)
    const kp = this.pos.get('kick');
    if (kp) {
      const lv = this.level('kick', now), h = this.hits.get('kick');
      const kk = this.pulse('kick', now, 0.08);
      const w = kp.r * 2 * s * kk, d = kp.r * 1.25 * s * kk, x = X(kp.x) - w / 2, y = Y(kp.y) - d / 2;
      this._glow(X(kp.x), Y(kp.y), kp.r * s * 1.05, LIMB_COLORS.foot, lv);
      g.fillStyle = SHELL; g.fillRect(x, y, w, d);
      const sh = g.createLinearGradient(x, 0, x + w, 0); sh.addColorStop(0, 'rgba(0,0,0,.45)'); sh.addColorStop(0.5, 'rgba(255,255,255,.08)'); sh.addColorStop(1, 'rgba(0,0,0,.45)');
      g.fillStyle = sh; g.fillRect(x, y, w, d);
      g.fillStyle = CHROME; g.fillRect(x - 2, y - 2, w + 4, Math.max(2, 0.9 * s)); g.fillRect(x - 2, y + d, w + 4, Math.max(2, 0.9 * s));
      if (lv > 0.01) { g.globalAlpha = Math.min(0.6, lv * 0.65); g.fillStyle = LIMB_COLORS.foot; g.fillRect(x, y, w, d); g.globalAlpha = 1; }
      // pedal
      const px = X(kp.x), py = Y(kp.y) + d / 2 + 1.5 * s;
      g.fillStyle = '#3a3840'; g.fillRect(px - 2.2 * s, py, 4.4 * s, 6 * s);
      g.fillStyle = '#8d8f98'; g.fillRect(px - 1.6 * s, py + 0.6 * s, 3.2 * s, 4.6 * s);
      if (lv > 0.05 || (h && h.static)) this._stick(px, py + 2.6 * s, Math.max(5, 2.2 * s), LIMB_COLORS.foot, lv, h.static ? 0 : h.t0, now);
      else if (this.preview.has('kick')) this._ring(px, py + 2.6 * s, Math.max(4, 1.6 * s), LIMB_COLORS.foot);
      labels.push(['Bumbo', X(kp.x), Y(kp.y) - fs / 2, lv > 0.25]);
    }
    // pedal do chimbal
    const hp = this.pos.get('hihat');
    if (hp) {
      const lv = this.level('hihat:p', now), h = this.hits.get('hihat:p');
      const px = X(hp.x + 1), py = Y(hp.y + hp.r + 3);
      g.fillStyle = '#3a3840'; g.fillRect(px - 2 * s, py, 4 * s, 5.5 * s);
      g.fillStyle = '#8d8f98'; g.fillRect(px - 1.4 * s, py + 0.6 * s, 2.8 * s, 4 * s);
      if (lv > 0.05 || (h && h.static)) this._stick(px, py + 2.4 * s, Math.max(5, 2 * s), LIMB_COLORS.foot, lv, h.static ? 0 : h.t0, now);
      else if (this.preview.has('hihat:p')) this._ring(px, py + 2.4 * s, Math.max(4, 1.5 * s), LIMB_COLORS.foot);
    }
    // tambores primeiro, pratos por cima (como na vida real, ficam mais altos)
    const order = this.kit.pieces.filter(p => p.id !== 'kick').sort((a, b) => (a.cymbal ? 1 : 0) - (b.cymbal ? 1 : 0));
    for (const p of order) {
      const q = this.pos.get(p.id); if (!q) continue;
      const x = X(q.x), y = Y(q.y), r = q.r * s;
      if (p.cymbal) this._cymbal(p, x, y, r, now);
      else if (p.id === 'cowbell' || p.id === 'tamb' || p.id === 'perc') this._small(p, x, y, r, now);
      else this._drum(p, x, y, r, now);
      labels.push([p.name, x, y + r + 2, this.level(p.id, now) > 0.25]);
    }
    // nomes por último, com fundo, para não sumirem embaixo dos pratos
    for (const [t, x, y, on] of labels) this._label(t, x, y, on, fs);
  }
  _small(p, x, y, r, now) { this._scaled(x, y, this.pulse(p.id, now, 0.12), () => this._small0(p, x, y, r, now)); }
  _small0(p, x, y, r, now) {
    const g = this.g, lv = this.level(p.id, now), h = this.hits.get(p.id), col = LIMB_COLORS.hand;
    this._glow(x, y, r, col, lv);
    if (p.id === 'cowbell') { g.fillStyle = '#9ea1aa'; g.beginPath(); g.moveTo(x - r, y - r * 0.6); g.lineTo(x + r, y - r * 0.9); g.lineTo(x + r, y + r * 0.9); g.lineTo(x - r, y + r * 0.6); g.closePath(); g.fill(); }
    else if (p.id === 'tamb') { g.strokeStyle = '#c8a14a'; g.lineWidth = Math.max(2, r * 0.3); g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke(); }
    else { g.fillStyle = '#6b4a2b'; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.fillStyle = '#e8dcc0'; g.beginPath(); g.arc(x, y, r * 0.8, 0, Math.PI * 2); g.fill(); }
    if (lv > 0.01) { g.globalAlpha = Math.min(0.6, lv * 0.7); g.fillStyle = col; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; }
    if (lv > 0.05 || (h && h.static)) this._stick(x, y, Math.max(5, r * 0.6), col, lv, h.static ? 0 : h.t0, now);
    else if (this.preview.has(p.id)) this._ring(x, y, Math.max(4, r * 0.5), col);
  }

  /* ---------------- pistas ---------------- */
  _drawLanes(now) {
    const g = this.g, W = this.W, H = this.H;
    const lanes = this.lanes, n = lanes.length;
    const left = 8, lw = (W - 16) / n, top = 6, hitY = H - 30, pps = (hitY - top) / LOOK;
    const fs = Math.max(9, Math.min(12, lw * 0.22));
    for (let i = 0; i < n; i++) {
      const id = lanes[i], p = this.kit.byId.get(id), x = left + i * lw;
      g.fillStyle = i % 2 ? '#14111b' : '#18141f'; g.fillRect(x, top, lw, hitY - top + 2);
      // alvo na linha de batida
      const lv = Math.max(this.level(id, now), id === 'hihat' ? this.level('hihat:p', now) : 0);
      const h = this.hits.get(id) || this.hits.get(id + ':p');
      const cx = x + lw / 2, rr = Math.min(lw * 0.36, 16) * Math.min(this.pulse(id, now, 0.16), id === 'hihat' ? this.pulse('hihat:p', now, 0.16) : 1);
      if (lv > 0.01) { this._glow(cx, hitY, rr, h ? LIMB_COLORS[h.limb] : LIMB_COLORS.hand, lv); }
      g.strokeStyle = p && p.cymbal ? '#c99a3c' : '#d8d1c0'; g.lineWidth = 2;
      if (p && p.cymbal) { g.beginPath(); g.arc(cx, hitY, rr, 0, Math.PI * 2); g.stroke(); }
      else { g.beginPath(); g.roundRect(cx - rr * 1.1, hitY - rr * 0.6, rr * 2.2, rr * 1.2, 5); g.stroke(); }
      // nome da peça
      g.font = (lv > 0.25 ? 'bold ' : '') + fs + 'px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'top';
      g.fillStyle = lv > 0.25 ? '#fff' : '#9a94aa';
      g.fillText(p ? p.name : id, cx, hitY + rr * 0.6 + 4, lw - 2);
      g.fillStyle = '#2a2534'; g.fillRect(x + lw - 0.5, top, 1, hitY - top);
    }
    // linha de batida
    g.fillStyle = '#e9e3f5'; g.globalAlpha = 0.8; g.fillRect(left, hitY - 1, W - 16, 2); g.globalAlpha = 1;
    // notas descendo (bumbo primeiro, por baixo das outras)
    const list = this.future.slice().sort((a, b) => (a.id === 'kick' ? 0 : 1) - (b.id === 'kick' ? 0 : 1));
    for (const f of list) {
      const dt = f.when - now;
      if (dt > LOOK || dt < -260) continue;
      let y = hitY - dt * pps; const fade = dt < 0 ? Math.max(0, 1 + dt / 260) : 1;
      g.globalAlpha = fade * (0.55 + 0.45 * f.vel);
      const col = LIMB_COLORS[f.limb];
      if (f.id === 'kick') { g.globalAlpha *= 0.85; g.fillStyle = col; g.beginPath(); g.roundRect(left + 2, y - 2.5, W - 20, 5, 2.5); g.fill(); g.globalAlpha = 1; continue; }
      const i = lanes.indexOf(f.id); if (i < 0) { g.globalAlpha = 1; continue; }
      const cx = left + i * lw + lw / 2, rr = Math.min(lw * 0.36, 16) * (0.55 + 0.45 * f.vel);
      const p = this.kit.byId.get(f.id);
      if (f.v === 'pedal') { g.fillStyle = col; g.beginPath(); g.moveTo(cx - rr * 0.7, y - 3); g.lineTo(cx, y + 4); g.lineTo(cx + rr * 0.7, y - 3); g.closePath(); g.fill(); }
      else if (p && p.cymbal) {
        g.fillStyle = col; g.beginPath(); g.arc(cx, y, rr * 0.75, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#e6c477'; g.lineWidth = 2; g.beginPath(); g.arc(cx, y, rr * 0.75, 0, Math.PI * 2); g.stroke();
        if (f.v === 'open') { g.strokeStyle = '#ffffff'; g.lineWidth = 1.6; g.beginPath(); g.arc(cx, y, rr * 0.35, 0, Math.PI * 2); g.stroke(); }
        if (f.v === 'bell') { g.fillStyle = '#ffffff'; g.beginPath(); g.arc(cx, y, rr * 0.22, 0, Math.PI * 2); g.fill(); }
      } else {
        g.fillStyle = col; g.beginPath(); g.roundRect(cx - rr, y - rr * 0.42, rr * 2, rr * 0.84, 4); g.fill();
        if (f.v === 'rim') { g.strokeStyle = '#ffffff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(cx - rr * 0.8, y); g.lineTo(cx + rr * 0.8, y); g.stroke(); }
      }
      g.globalAlpha = 1;
    }
  }

  _draw(now) {
    const g = this.g, W = this.W, H = this.H; if (!W || !H) return;
    g.clearRect(0, 0, W, H); g.fillStyle = '#0d0c12'; g.fillRect(0, 0, W, H);
    if (this.view === 'lanes') this._drawLanes(now); else this._drawKit(now);
  }
  _loop(now) {
    if (!this.visible) return;
    let anim = this.future.length > 0 && this.view === 'lanes';
    if (!anim) for (const [k, h] of this.hits) if (!h.static && now - h.t0 < 1800) { anim = true; break; }
    if (this.dirty || anim) { this._draw(now); this.dirty = false; }
    if (this.future.length && !this.future.some(f => f.when > now - 400)) this.future = [];
    requestAnimationFrame(this._loop);
  }
}
