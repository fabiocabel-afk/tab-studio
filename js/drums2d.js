/* Tab Studio — bateria 2D (canvas).
 * Duas visões:
 *  · "De cima": o kit visto de cima, com o baterista embaixo. A peça tocada acende na cor
 *    de quem bate (mãos = laranja, pés = verde); tambores pulsam e pratos balançam.
 *  · "Pistas": uma faixa por peça, as notas descem até a linha de batida
 *    (o bumbo é uma barra que atravessa todas as faixas). */
import { pieceOf, buildKit, layoutTop, boundsOf, laneOrder, velocityOf, LIMB_COLORS, hitColor } from './drumkit.js';
import { SHELL as LAC, cymbalCanvas, headCanvas, rugCanvas, stageTile } from './drumlook.js';

const LOOK = 2400;          // ms de antecedência visíveis nas pistas
const CHROME = '#c9ccd4';
// cromado: degradê com reflexo (aros, garras, pedais)
function chrome(g, x0, y0, x1, y1) {
  const c = g.createLinearGradient(x0, y0, x1, y1);
  c.addColorStop(0, '#f6f7fa'); c.addColorStop(0.35, '#9a9ea8'); c.addColorStop(0.55, '#eef0f4'); c.addColorStop(0.8, '#6d717b'); c.addColorStop(1, '#c5c8d0');
  return c;
}

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
  // kit = de cima (nome impresso na peça); kitnames = de cima com o nome numa caixinha embaixo de cada peça
  setView(v) { this.view = v === 'lanes' || v === 'kitnames' ? v : 'kit'; this.dirty = true; }
  get names() { return this.view === 'kitnames'; }
  setCamera(v) { this.setView(v); }
  setKit(midis) { this.kit = buildKit(midis); this.pos = layoutTop(this.kit); this.box = boundsOf(this.pos); this.lanes = laneOrder(this.kit); this.hits.clear(); this.future = []; this.dirty = true; }
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
  /* escala: o conjunto de peças (só as usadas) ocupa o painel; em painel largo ou alto
     as posições se espalham um pouco (até 1,3×) sem esticar as peças */
  _fit() {
    const b = this.box, pad = 8, aw = this.W - pad * 2, ah = this.H - pad * 2;
    const s0 = Math.max(0.5, Math.min(aw / (b.x1 - b.x0), ah / (b.y1 - b.y0)));
    const xc = (b.x0 + b.x1) / 2, yc = (b.y0 + b.y1) / 2;
    // espalha as posições até onde cabe (peças maiores só se sobrar espaço)
    const spread = s => {
      let sx = s * 1.2, sy = s * 1.15;
      for (const it of b.items) {
        const dx = it.x - xc, dy = it.y - yc;
        if (Math.abs(dx) > 0.01) sx = Math.min(sx, (aw / 2 - it.h * s) / Math.abs(dx));
        if (dy < -0.01) sy = Math.min(sy, (ah / 2 - it.t * s) / -dy);
        if (dy > 0.01) sy = Math.min(sy, (ah / 2 - it.b * s) / dy);
      }
      return { sx, sy };
    };
    let s = s0, f = spread(s0);
    for (let k = 1.5; k > 1.001; k -= 0.05) { const t = spread(s0 * k); if (t.sx >= s0 * k && t.sy >= s0 * k * 0.97) { s = s0 * k; f = t; break; } }
    const { sx, sy } = f;
    return { s, sx, sy, ox: this.W / 2 - xc * sx, oy: this.H / 2 - yc * sy };
  }
  _tex(r) { return Math.min(512, Math.max(128, r * 2 * Math.min(window.devicePixelRatio || 1, 2))); }
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
  /* caixinha com o nome embaixo da peça; acende em laranja quando a peça é tocada (lv 0..1) */
  _label(text, x, y, lv, size) {
    const g = this.g; g.font = '800 ' + size + 'px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const w = g.measureText(text).width + size * 1.1, h = size * 1.6;
    x = Math.max(w / 2 + 2, Math.min(this.W - w / 2 - 2, x)); y = Math.min(y, this.H - h - 2);
    (this.labRects || (this.labRects = [])).push({ text, x, y, w, h });
    const on = Math.min(1, lv * 1.6);
    g.save();
    if (on > 0.05) { g.shadowColor = 'rgba(255,153,1,' + (0.9 * on).toFixed(2) + ')'; g.shadowBlur = 14 * on; }
    g.fillStyle = 'rgba(12,10,18,.88)'; g.beginPath(); g.roundRect(x - w / 2, y, w, h, h / 2); g.fill();
    if (on > 0.02) { g.globalAlpha = on; g.fillStyle = '#FF9901'; g.fill(); g.globalAlpha = 1; }
    g.restore();
    g.strokeStyle = on > 0.3 ? '#ffd08a' : 'rgba(255,255,255,.22)'; g.lineWidth = 1; g.beginPath(); g.roundRect(x - w / 2 + 0.5, y + 0.5, w - 1, h - 1, h / 2); g.stroke();
    g.fillStyle = on > 0.45 ? '#1a1020' : '#ffffff'; g.fillText(text, x, y + h / 2 + 0.5);
  }
  _drum(p, x, y, r, now) { this._scaled(x, y, this.pulse(p.id, now), () => this._drum0(p, x, y, r, now)); }
  _drum0(p, x, y, r, now) {
    const g = this.g, key = p.id, lv = this.level(key, now), h = this.hits.get(key);
    const col = h ? LIMB_COLORS[h.limb] : LIMB_COLORS.hand;
    this._glow(x, y, r, col, lv);
    // sombra no tapete
    g.save(); g.shadowColor = 'rgba(0,0,0,.65)'; g.shadowBlur = r * 0.4; g.shadowOffsetY = r * 0.14;
    g.fillStyle = '#000'; g.beginPath(); g.arc(x, y + r * 0.05, r * 1.01, 0, Math.PI * 2); g.fill(); g.restore();
    // casco de laca vinho aparecendo embaixo (o tambor fica um pouco inclinado)
    const sg = g.createLinearGradient(x - r, 0, x + r, 0);
    sg.addColorStop(0, LAC.dark); sg.addColorStop(0.3, LAC.light); sg.addColorStop(0.45, LAC.base); sg.addColorStop(1, LAC.dark);
    g.fillStyle = sg; g.beginPath(); g.arc(x, y + r * 0.11, r * 0.98, 0, Math.PI * 2); g.fill();
    // pele (afunda um pouco ao bater)
    const hr = r * 0.9;
    g.save(); g.beginPath(); g.arc(x, y, hr, 0, Math.PI * 2); g.clip();
    g.drawImage(headCanvas(key === 'snare' ? 'snare' : 'tom', this.names ? '' : p.name, this._tex(hr)), x - hr, y - hr, hr * 2, hr * 2);
    const lg = g.createRadialGradient(x - hr * 0.45, y - hr * 0.55, 0, x, y, hr * 1.15);
    lg.addColorStop(0, 'rgba(255,255,255,.22)'); lg.addColorStop(0.55, 'rgba(255,255,255,0)'); lg.addColorStop(1, 'rgba(0,0,0,.22)');
    g.fillStyle = lg; g.fillRect(x - hr, y - hr, hr * 2, hr * 2);
    if (lv > 0.01) {
      g.globalAlpha = Math.min(0.6, lv * 0.65); g.fillStyle = col; g.fillRect(x - hr, y - hr, hr * 2, hr * 2);
      const dg = g.createRadialGradient(x, y + hr * 0.1, 0, x, y, hr); dg.addColorStop(0, 'rgba(0,0,0,.35)'); dg.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalAlpha = Math.min(1, lv); g.fillStyle = dg; g.fillRect(x - hr, y - hr, hr * 2, hr * 2); g.globalAlpha = 1;
    }
    g.restore();
    // aro cromado
    g.lineWidth = r * 0.085; g.strokeStyle = chrome(g, x - r, y - r, x + r, y + r);
    g.beginPath(); g.arc(x, y, r * 0.935, 0, Math.PI * 2); g.stroke();
    g.lineWidth = Math.max(0.6, r * 0.012); g.strokeStyle = 'rgba(0,0,0,.4)'; g.beginPath(); g.arc(x, y, r * 0.89, 0, Math.PI * 2); g.stroke();
    // garras e parafusos de afinação
    const nl = key === 'snare' ? 10 : p.tom === 'floor' ? 8 : 6;
    for (let i = 0; i < nl; i++) {
      const a = (i + 0.5) / nl * Math.PI * 2;
      g.save(); g.translate(x + Math.cos(a) * r * 0.95, y + Math.sin(a) * r * 0.95); g.rotate(a);
      g.fillStyle = chrome(g, -r * 0.07, -r * 0.05, r * 0.07, r * 0.05);
      g.beginPath(); g.roundRect(-r * 0.075, -r * 0.05, r * 0.15, r * 0.1, r * 0.02); g.fill();
      g.fillStyle = '#4a4d55'; g.beginPath(); g.arc(0, 0, Math.max(0.8, r * 0.025), 0, Math.PI * 2); g.fill();
      g.restore();
    }
    // caixa: alavanca da esteira na lateral
    if (key === 'snare') {
      g.fillStyle = chrome(g, x + r * 0.95, y - r * 0.1, x + r * 1.12, y + r * 0.1);
      g.beginPath(); g.roundRect(x + r * 0.96, y - r * 0.09, r * 0.16, r * 0.18, r * 0.03); g.fill();
    }
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
    const col = hitColor(key, h ? h.limb : 'hand');
    this._glow(x, y, r, col, lv * 0.8);
    // balanço: o prato oscila quando é batido
    const t = h && !h.static ? (now - h.t0) / 1000 : 0;
    const wob = lv * 0.13 * Math.sin(t * 28), ang = lv * 0.16 * Math.sin(t * 17);
    const open = key === 'hihat' && h && h.v === 'open' && lv > 0.05;
    g.save(); g.translate(x, y);
    // sombra (o prato fica alto: sombra mais longe e difusa)
    g.save(); g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = r * 0.35; g.shadowOffsetX = r * 0.05; g.shadowOffsetY = r * (open ? 0.3 : 0.18);
    g.fillStyle = '#000'; g.beginPath(); g.arc(0, 0, r * 0.98, 0, Math.PI * 2); g.fill(); g.restore();
    // chimbal aberto: aparece a borda do prato de baixo
    if (open) g.drawImage(cymbalCanvas('hihat', '', this._tex(r)), -r * 1.06, -r * 0.94, r * 2, r * 2);
    g.rotate(ang); g.scale(1 + wob, 1 - wob);
    g.drawImage(cymbalCanvas(key, this.names ? '' : p.name, this._tex(r)), -r, -r, r * 2, r * 2);
    // brilho do bronze: a "cruz" de luz do torneado, que gira com o balanço
    g.save(); g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.clip();
    if (g.createConicGradient) {
      const cg = g.createConicGradient(-0.75 + ang * 4, 0, 0);
      for (let k = 0; k < 2; k++) {
        const b = k * 0.5;
        cg.addColorStop(b, 'rgba(255,250,230,.7)'); cg.addColorStop(b + 0.05, 'rgba(255,248,222,0)');
        cg.addColorStop(b + 0.2, 'rgba(0,0,0,.3)'); cg.addColorStop(b + 0.3, 'rgba(0,0,0,.3)');
        cg.addColorStop(b + 0.45, 'rgba(255,248,222,0)'); cg.addColorStop(b + 0.5 - 0.0001, 'rgba(255,250,230,.7)');
      }
      g.globalCompositeOperation = 'overlay'; g.fillStyle = cg; g.fillRect(-r, -r, r * 2, r * 2); g.globalCompositeOperation = 'source-over';
    }
    if (lv > 0.01) { g.globalAlpha = Math.min(0.55, lv * 0.6); g.fillStyle = col; g.fillRect(-r, -r, r * 2, r * 2); g.globalAlpha = 1; }
    g.restore();
    // feltro e porca no centro
    g.fillStyle = '#5b1a1a'; g.beginPath(); g.arc(0, 0, Math.max(1.5, r * 0.09), 0, Math.PI * 2); g.fill();
    g.fillStyle = chrome(g, -r * 0.06, -r * 0.06, r * 0.06, r * 0.06); g.beginPath(); g.arc(0, 0, Math.max(1.2, r * 0.055), 0, Math.PI * 2); g.fill();
    g.restore();
    if (lv > 0.05 || (h && h.static)) {
      const bell = h && h.v === 'bell';
      this._stick(x + (bell ? 0 : r * 0.45), y + (bell ? 0 : r * 0.35), Math.max(5, r * 0.2), col, lv, h.static ? 0 : h.t0, now);
    }
    if (this.preview.has(key) && lv < 0.3) this._ring(x + r * 0.45, y + r * 0.35, Math.max(4, r * 0.16), hitColor(key, this.preview.get(key)));
  }
  /* pedal visto de cima: base, plataforma com frisos e o batedor */
  _pedal(px, py, w, len, s) {
    const g = this.g;
    g.save(); g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = s * 1.2; g.shadowOffsetY = s * 0.4;
    g.fillStyle = '#2b2c32'; g.beginPath(); g.roundRect(px - w * 0.62, py, w * 1.24, len, s * 0.6); g.fill(); g.restore();
    g.fillStyle = chrome(g, px - w / 2, py, px + w / 2, py + len);
    g.beginPath(); g.roundRect(px - w / 2, py + len * 0.12, w, len * 0.78, s * 0.5); g.fill();
    g.strokeStyle = 'rgba(40,42,48,.55)'; g.lineWidth = Math.max(0.6, s * 0.12);
    for (let k = 0.2; k < 0.85; k += 0.08) { g.beginPath(); g.moveTo(px - w * 0.38, py + len * k); g.lineTo(px + w * 0.38, py + len * k); g.stroke(); }
    g.fillStyle = '#1d1e22'; g.beginPath(); g.roundRect(px - w * 0.55, py + len * 0.88, w * 1.1, len * 0.14, s * 0.3); g.fill();
  }
  _drawKit(now) {
    const g = this.g, { s, sx, sy, ox, oy } = this._fit();
    const X = v => ox + v * sx, Y = v => oy + v * sy;
    const labels = [];
    // tapete
    const b = this.box, cx = X((b.x0 + b.x1) / 2), cy = Y((b.y0 + b.y1) / 2);
    let rw = 0, rh = 0;
    for (const it of b.items) { rw = Math.max(rw, Math.abs(X(it.x) - cx) + it.h * s); rh = Math.max(rh, Math.abs(Y(it.y) - cy) + Math.max(it.t, it.b) * s); }
    rw = Math.min(this.W / 2, rw * 1.1); rh = Math.min(this.H / 2, rh * 1.08);
    g.save(); g.beginPath(); g.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2); g.clip();
    g.drawImage(rugCanvas(512), cx - rw, cy - rh, rw * 2, rh * 2); g.restore();
    // banco do baterista (couro preto)
    const bq = this.pos.get('_bench');
    if (bq) {
      const bx = X(bq.x), by = Y(bq.y), br = bq.r * s;
      g.save(); g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = br * 0.5; g.shadowOffsetY = br * 0.15;
      const lg = g.createRadialGradient(bx - br * 0.3, by - br * 0.35, br * 0.1, bx, by, br);
      lg.addColorStop(0, '#4a4650'); lg.addColorStop(0.6, '#1f1d24'); lg.addColorStop(1, '#0d0c10');
      g.fillStyle = lg; g.beginPath(); g.arc(bx, by, br, 0, Math.PI * 2); g.fill(); g.restore();
      g.setLineDash([Math.max(1, br * 0.08), Math.max(1, br * 0.08)]); g.strokeStyle = 'rgba(255,255,255,.18)'; g.lineWidth = Math.max(0.6, br * 0.03);
      g.beginPath(); g.arc(bx, by, br * 0.82, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    }
    const fs = Math.max(11, Math.min(15, s * 2.2));
    // bumbo (visto de cima é um "retângulo": o tambor está deitado)
    const kp = this.pos.get('kick');
    if (kp) {
      const lv = this.level('kick', now), h = this.hits.get('kick');
      const kk = this.pulse('kick', now, 0.08);
      const w = kp.r * 2 * s * kk, d = kp.r * 1.25 * s * kk, x = X(kp.x) - w / 2, y = Y(kp.y) - d / 2;
      this._glow(X(kp.x), Y(kp.y), kp.r * s * 1.05, LIMB_COLORS.foot, lv);
      g.save(); g.shadowColor = 'rgba(0,0,0,.65)'; g.shadowBlur = w * 0.12; g.shadowOffsetY = w * 0.04;
      g.fillStyle = LAC.dark; g.fillRect(x, y, w, d); g.restore();
      // casco deitado: laca com o reflexo do cilindro
      const sh = g.createLinearGradient(x, 0, x + w, 0);
      sh.addColorStop(0, LAC.dark); sh.addColorStop(0.28, LAC.light); sh.addColorStop(0.36, '#c4505a'); sh.addColorStop(0.44, LAC.base); sh.addColorStop(0.85, LAC.dark); sh.addColorStop(1, '#160203');
      g.fillStyle = sh; g.fillRect(x, y, w, d);
      // aros das duas pontas (madeira laqueada com friso cromado)
      const hoop = Math.max(2, d * 0.09);
      for (const yy of [y - hoop * 0.4, y + d - hoop * 0.6]) {
        g.fillStyle = sh; g.fillRect(x - hoop * 0.3, yy, w + hoop * 0.6, hoop);
        g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(x - hoop * 0.3, yy, w + hoop * 0.6, Math.max(0.6, hoop * 0.18));
      }
      // garras de afinação nas duas pontas e no meio
      for (const fx of [0.18, 0.5, 0.82]) {
        const lx = x + w * fx;
        for (const yy of [y + hoop * 0.9, y + d - hoop * 1.9]) { g.fillStyle = chrome(g, lx - w * 0.03, 0, lx + w * 0.03, 0); g.beginPath(); g.roundRect(lx - w * 0.022, yy, w * 0.044, hoop, w * 0.01); g.fill(); }
        g.fillStyle = chrome(g, lx - w * 0.03, 0, lx + w * 0.03, 0); g.beginPath(); g.roundRect(lx - w * 0.018, y + d * 0.4, w * 0.036, d * 0.2, w * 0.012); g.fill();
      }
      // nome no casco
      g.save(); g.font = '900 ' + Math.max(10, d * 0.22) + 'px "Arial Narrow", "Roboto Condensed", system-ui, sans-serif'; try { g.fontStretch = 'condensed'; } catch (e) { /* sem suporte */ }
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = 'rgba(255,238,230,.92)';
      if (!this.names) g.fillText('BUMBO', X(kp.x), Y(kp.y) - d * 0.2);
      g.restore();
      if (lv > 0.01) { g.globalAlpha = Math.min(0.6, lv * 0.65); g.fillStyle = LIMB_COLORS.foot; g.fillRect(x, y, w, d); g.globalAlpha = 1; }
      // pedal com o batedor encostado na pele
      const px = X(kp.x), py = Y(kp.y) + d / 2 + 1.2 * s;
      g.fillStyle = '#5b1a1a'; g.beginPath(); g.ellipse(px, y + d + hoop * 0.2, 1.6 * s, 0.8 * s, 0, 0, Math.PI * 2); g.fill();
      this._pedal(px, py, 4.2 * s, 7 * s, s);
      if (lv > 0.05 || (h && h.static)) this._stick(px, py + 3 * s, Math.max(5, 2.2 * s), LIMB_COLORS.foot, lv, h.static ? 0 : h.t0, now);
      else if (this.preview.has('kick')) this._ring(px, py + 3 * s, Math.max(4, 1.6 * s), LIMB_COLORS.foot);
      if (this.names) labels.push(['Bumbo', px, py + 7.6 * s, lv]);
    }
    // pedal do chimbal
    const hp = this.pos.get('hihat');
    if (hp) {
      const lv = this.level('hihat:p', now), h = this.hits.get('hihat:p');
      const px = X(hp.x + 1), py = Y(hp.y + hp.r + 2.5);
      this._pedal(px, py, 3.6 * s, 6 * s, s);
      if (lv > 0.05 || (h && h.static)) this._stick(px, py + 2.6 * s, Math.max(5, 2 * s), LIMB_COLORS.foot, lv, h.static ? 0 : h.t0, now);
      else if (this.preview.has('hihat:p')) this._ring(px, py + 2.6 * s, Math.max(4, 1.5 * s), LIMB_COLORS.foot);
      this._hhName = [px, py + 6.6 * s, lv];
    } else this._hhName = null;
    // tambores primeiro, pratos por cima (como na vida real, ficam mais altos)
    const order = this.kit.pieces.filter(p => p.id !== 'kick').sort((a, b) => (a.cymbal ? 1 : 0) - (b.cymbal ? 1 : 0));
    for (const p of order) {
      const q = this.pos.get(p.id); if (!q) continue;
      const x = X(q.x), y = Y(q.y), r = q.r * s;
      if (p.cymbal) this._cymbal(p, x, y, r, now);
      else if (p.id === 'cowbell' || p.id === 'tamb' || p.id === 'perc') this._small(p, x, y, r, now);
      else this._drum(p, x, y, r, now);
      const lv = this.level(p.id, now);
      if (p.id === 'hihat' && this._hhName && this.names) labels.push([p.name, this._hhName[0], this._hhName[1], Math.max(lv, this._hhName[2])]);
      else if (p.id === 'cowbell' || p.id === 'tamb' || p.id === 'perc' || (this.names && p.id !== 'hihat')) labels.push([p.name, x, y + r + 3, lv]);
    }
    // nomes embaixo das peças, por cima de tudo (só na visão "com nomes"; percussão pequena sempre)
    this.labRects = [];
    for (const [t, x, y, lv] of labels) this._label(t, x, y, lv, fs);
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
      if (lv > 0.01) { this._glow(cx, hitY, rr, hitColor(id, h ? h.limb : 'hand'), lv); }
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
      const col = hitColor(f.id, f.limb);
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
    g.clearRect(0, 0, W, H); g.fillStyle = this.view === 'lanes' ? '#0d0c12' : (this._stage || (this._stage = g.createPattern(stageTile(), 'repeat'))); g.fillRect(0, 0, W, H);
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
