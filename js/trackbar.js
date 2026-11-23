/* Tab Studio — barra de trilhas estilo Guitar Pro:
 * nomes dos instrumentos + quadradinhos dos compassos, com o compasso atual,
 * as trilhas visíveis e o trecho selecionado. Retrai para uma linha fina. */
(function (root) {
  'use strict';
  const CELL = 16, ROW = 24, HEAD = 18;
  const COLORS = ['#f2a33a', '#8a5cf6', '#2fd36b', '#3aa0ff', '#ef5b6b', '#ffd23a', '#26d9d9', '#ff66c4', '#b5e05a', '#ff8a5c'];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  class TrackBar {
    constructor(rootEl, cb) {
      this.el = rootEl; this.cb = cb || {};
      this.score = null; this.occ = []; this.visible = []; this.primary = 0; this.mix = {};
      this.cur = 0; this.range = null; this.editBar = null; this.playing = false;
      rootEl.innerHTML =
        '<div class="tbar-line" role="button" tabindex="0" title="Mostrar / esconder as trilhas">' +
          '<span class="tl-arrow">▸</span><span class="tl-dot"></span><span class="tl-name">—</span>' +
          '<span class="tl-bar">Compasso – / –</span>' +
          '<div class="tl-strip"><canvas></canvas></div>' +
        '</div>' +
        '<div class="tbar-body"><div class="tb-inner">' +
          '<div class="tb-head"><div class="tb-corner">Trilhas</div><canvas class="tb-ruler"></canvas></div>' +
          '<div class="tb-rows"><div class="tb-names"></div><canvas class="tb-grid"></canvas></div>' +
        '</div></div>';
      this.line = rootEl.querySelector('.tbar-line');
      this.body = rootEl.querySelector('.tbar-body');
      this.names = rootEl.querySelector('.tb-names');
      this.grid = rootEl.querySelector('.tb-grid');
      this.ruler = rootEl.querySelector('.tb-ruler');
      this.strip = rootEl.querySelector('.tl-strip canvas');
      this.line.addEventListener('click', () => this.toggle());
      this.line.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggle(); } });
      this._bindGrid();
      this.ro = new ResizeObserver(() => this.drawStrip());
      this.ro.observe(this.line);
    }

    toggle() { this.setCollapsed(!this.collapsed); if (this.cb.onCollapse) this.cb.onCollapse(this.collapsed); }
    setCollapsed(c) {
      this.collapsed = !!c;
      this.el.classList.toggle('collapsed', this.collapsed);
      this.line.querySelector('.tl-arrow').textContent = this.collapsed ? '▸' : '▾';
      if (!this.collapsed) { this.draw(); this.scrollToBar(this.cur, true); }
      this.drawStrip();
    }

    setScore(score) {
      this.score = score;
      this.occ = score ? score.tracks.map(t => {
        const st = t.staves; const n = score.masterBars.length; const a = new Uint8Array(n);
        for (const s of st) s.bars.forEach((b, i) => { if (a[i]) return; for (const v of b.voices) { for (const bt of v.beats) { if (bt.notes.length) { a[i] = 1; break; } } if (a[i]) break; } });
        return a;
      }) : [];
      this.cur = Math.min(this.cur, score ? score.masterBars.length - 1 : 0);
      this.buildNames(); this.draw(); this.drawStrip(); this.updateLine();
    }
    setState(s) {
      if (s.visible) this.visible = s.visible.slice();
      if (s.primary !== undefined) this.primary = s.primary;
      if (s.mix) this.mix = s.mix;
      this.buildNames(); this.draw(); this.drawStrip(); this.updateLine();
    }
    setPos(bar, playing) {
      if (!this.score) return;
      bar = Math.max(0, Math.min(bar | 0, this.score.masterBars.length - 1));
      const changed = bar !== this.cur;
      this.cur = bar; this.playing = !!playing;
      if (!changed) return;
      this.updateLine(); this.drawStrip();
      if (!this.collapsed) { this.draw(); this.scrollToBar(bar); }
    }
    setRange(r) { this.range = r; this.draw(); this.drawStrip(); }
    setEditBar(b) { this.editBar = b; this.draw(); }

    color(i) { return COLORS[i % COLORS.length]; }

    updateLine() {
      const s = this.score;
      const t = s && s.tracks[this.primary];
      this.line.querySelector('.tl-name').textContent = t ? (t.name || ('Trilha ' + (t.index + 1))) : '—';
      this.line.querySelector('.tl-dot').style.background = this.color(this.primary);
      this.line.querySelector('.tl-bar').textContent = s ? ('Compasso ' + (this.cur + 1) + ' / ' + s.masterBars.length) : 'Compasso – / –';
    }

    buildNames() {
      const box = this.names; box.innerHTML = '';
      const s = this.score; if (!s) return;
      s.tracks.forEach((t, i) => {
        const m = this.mix[i] || {};
        const row = document.createElement('div');
        row.className = 'tb-name' + (this.visible.includes(i) ? ' vis' : '') + (i === this.primary ? ' prim' : '');
        row.style.setProperty('--tc', this.color(i));
        row.innerHTML = '<span class="tn-dot"></span><span class="tn-txt" title="Clique: ver esta trilha · Ctrl/Shift+clique: ver junto">' + esc(t.name || ('Trilha ' + (i + 1))) + '</span>' +
          '<button class="tn-b m' + (m.mute ? ' on' : '') + '" title="Mudo">M</button><button class="tn-b s' + (m.solo ? ' on' : '') + '" title="Solo">S</button>';
        row.querySelector('.tn-txt').addEventListener('click', e => { if (this.cb.onSelect) this.cb.onSelect(i, e.ctrlKey || e.metaKey || e.shiftKey); });
        row.querySelector('.m').addEventListener('click', e => { e.stopPropagation(); if (this.cb.onMute) this.cb.onMute(i); });
        row.querySelector('.s').addEventListener('click', e => { e.stopPropagation(); if (this.cb.onSolo) this.cb.onSolo(i); });
        box.appendChild(row);
      });
    }

    _ctx(canvas, w, h) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
      return g;
    }
    draw() {
      const s = this.score; if (!s || this.collapsed) return;
      const nb = s.masterBars.length, nt = s.tracks.length;
      const w = nb * CELL + 8, h = nt * ROW;
      // régua com números dos compassos
      const r = this._ctx(this.ruler, w, HEAD);
      r.fillStyle = '#a9a3b8'; r.font = '10px system-ui, sans-serif'; r.textBaseline = 'middle';
      for (let b = 0; b < nb; b++) {
        if (b === 0 || (b + 1) % 4 === 0) r.fillText(String(b + 1), b * CELL + 2, HEAD / 2);
        if (s.masterBars[b].isRepeatStart || s.masterBars[b].repeatCount > 0) { r.fillStyle = '#f2a33a'; r.fillRect(b * CELL + (s.masterBars[b].isRepeatStart ? 0 : CELL - 2), HEAD - 4, 2, 4); r.fillStyle = '#a9a3b8'; }
      }
      if (this.range) { r.fillStyle = 'rgba(138,92,246,.6)'; r.fillRect(this.range[0] * CELL, HEAD - 3, (this.range[1] - this.range[0] + 1) * CELL, 3); }
      // grade
      const g = this._ctx(this.grid, w, h);
      for (let t = 0; t < nt; t++) {
        const vis = this.visible.includes(t), prim = t === this.primary;
        if (vis) { g.fillStyle = prim ? 'rgba(138,92,246,.20)' : 'rgba(138,92,246,.10)'; g.fillRect(0, t * ROW, w, ROW); }
        const occ = this.occ[t]; const col = this.color(t);
        for (let b = 0; b < nb; b++) {
          const x = b * CELL + 2, y = t * ROW + 5, cw = CELL - 3, ch = ROW - 10;
          if (occ && occ[b]) { g.globalAlpha = vis ? 0.95 : 0.5; g.fillStyle = col; g.fillRect(x, y, cw, ch); g.globalAlpha = 1; }
          else { g.strokeStyle = '#3a3546'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1); }
        }
      }
      if (this.range) { g.fillStyle = 'rgba(138,92,246,.28)'; g.fillRect(this.range[0] * CELL, 0, (this.range[1] - this.range[0] + 1) * CELL, h); }
      if (this.editBar != null) { g.strokeStyle = '#c4a8ff'; g.lineWidth = 2; g.strokeRect(this.editBar * CELL + 1, this.primary * ROW + 2, CELL - 1, ROW - 4); }
      // compasso atual
      g.fillStyle = 'rgba(242,163,58,.30)'; g.fillRect(this.cur * CELL, 0, CELL, h);
      g.fillStyle = '#f2a33a'; g.fillRect(this.cur * CELL, 0, 2, h);
      r.fillStyle = '#f2a33a'; r.fillRect(this.cur * CELL, 0, CELL, 3);
    }
    /* linha fina: faixa da trilha selecionada correndo */
    drawStrip() {
      const s = this.score; const cv = this.strip; const host = cv.parentElement;
      const w = Math.max(10, host.clientWidth), h = 10;
      const g = this._ctx(cv, w, h);
      if (!s) return;
      const nb = s.masterBars.length, cw = 9;
      const occ = this.occ[this.primary] || [];
      const total = nb * cw;
      let off = 0;
      if (total > w) off = Math.max(0, Math.min(total - w, this.cur * cw - w * 0.35));
      for (let b = 0; b < nb; b++) {
        const x = b * cw - off; if (x < -cw || x > w) continue;
        if (occ[b]) { g.fillStyle = this.color(this.primary); g.globalAlpha = b < this.cur ? 0.45 : 0.9; g.fillRect(x + 1, 2, cw - 2, h - 4); g.globalAlpha = 1; }
        else { g.fillStyle = '#3a3546'; g.fillRect(x + 1, 4, cw - 2, h - 8); }
      }
      if (this.range) { g.fillStyle = 'rgba(138,92,246,.45)'; g.fillRect(this.range[0] * cw - off, 0, (this.range[1] - this.range[0] + 1) * cw, h); }
      g.fillStyle = '#ffffff'; g.fillRect(this.cur * cw - off, 0, cw, 2); g.fillRect(this.cur * cw - off, h - 2, cw, 2);
      g.strokeStyle = '#f2a33a'; g.lineWidth = 2; g.strokeRect(this.cur * cw - off + 0.5, 0.5, cw - 1, h - 1);
    }
    scrollToBar(bar, center) {
      const body = this.body; const namesW = this.names.offsetWidth || 160;
      const x = namesW + bar * CELL; const view = body.clientWidth;
      if (center) { body.scrollLeft = Math.max(0, x - namesW - (view - namesW) / 2); return; }
      if (x < body.scrollLeft + namesW + CELL) body.scrollLeft = Math.max(0, x - namesW - CELL * 2);
      else if (x + CELL > body.scrollLeft + view - CELL) body.scrollLeft = x - view + CELL * 6;
    }

    _hit(e) {
      const r = this.grid.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (!this.score) return null;
      const bar = Math.floor(x / CELL), track = Math.floor(y / ROW);
      if (bar < 0 || bar >= this.score.masterBars.length || track < 0 || track >= this.score.tracks.length) return null;
      return { bar, track };
    }
    _bindGrid() {
      let down = null, dragging = false;
      this.grid.addEventListener('pointerdown', e => {
        const h = this._hit(e); if (!h) return;
        down = { h, x: e.clientX, mouse: e.pointerType === 'mouse' }; dragging = false;
        if (down.mouse) this.grid.setPointerCapture(e.pointerId);
      });
      this.grid.addEventListener('pointermove', e => {
        if (!down || !down.mouse) return;
        if (!dragging && Math.abs(e.clientX - down.x) > 6) dragging = true;
        if (dragging) { const h = this._hit(e) || down.h; const a = Math.min(down.h.bar, h.bar), b = Math.max(down.h.bar, h.bar); this.setRange([a, b]); }
      });
      this.grid.addEventListener('pointerup', e => {
        if (!down) return;
        const start = down; down = null;
        if (dragging) { dragging = false; if (this.range && this.cb.onRange) this.cb.onRange(this.range[0], this.range[1], start.h.track); return; }
        if (Math.abs(e.clientX - start.x) > 8) return; // rolagem com o dedo
        const h = this._hit(e) || start.h;
        if (this.cb.onBar) this.cb.onBar(h.track, h.bar);
      });
      this.grid.addEventListener('pointercancel', () => { down = null; dragging = false; });
    }
  }
  root.TrackBar = TrackBar;
})(window);
