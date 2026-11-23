/* Tab Studio — braço de guitarra/baixo em 3D (three.js).
 * Mostra a casa pressionada, acende a corda da casa até a ponte,
 * balança a corda no vibrato e estica lateralmente no bend. */
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

const L = 100;            // comprimento de escala (pestana → ponte)
const FRETS = 24;
const SEG = 180;          // segmentos ao longo da corda
const RING = 6;           // lados do tubo da corda
const STRING_COLORS = ['#b066ff', '#2fd36b', '#ff9a2e', '#3aa0ff', '#ffd23a', '#ff3b4f', '#26d9d9', '#ff66c4'];

export function fretX(n) { return n <= 0 ? 0 : L * (1 - Math.pow(2, -n / 12)); }

function makeCanvasTexture(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
function textSprite(text, color, size) {
  const tex = makeCanvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = color || '#cfc8dc'; g.font = 'bold 72px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, w / 2, h / 2 + 4);
  });
  const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const s = new THREE.Sprite(m); s.scale.set(size || 2, size || 2, 1);
  return s;
}

const GLOW_VS = `
attribute float u;
varying float vU;
void main(){ vU = u; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const GLOW_FS = `
uniform vec3 color; uniform float litFrom; uniform float intensity; uniform float base; uniform float time;
varying float vU;
void main(){
  float lit = smoothstep(litFrom - 0.004, litFrom + 0.004, vU);
  float pulse = 0.85 + 0.15 * sin(time * 9.0 - vU * 40.0);
  float a = base + lit * intensity * pulse;
  gl_FragColor = vec4(color * (0.6 + lit * intensity), clamp(a, 0.0, 1.0));
}`;

export class Fretboard3D {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.opts = opts || {};
    this.flip = !!this.opts.flip;
    this.visible = true;
    this.strings = [];
    this.tuning = [64, 59, 55, 50, 45, 40];
    this.dirty = true;
    this.camPreset = 'player';

    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.1;

    const sc = this.scene = new THREE.Scene();
    sc.background = new THREE.Color('#0d0c12');
    sc.fog = new THREE.Fog('#0d0c12', 140, 260);

    this.camera = new THREE.PerspectiveCamera(32, 2, 0.5, 600);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
    this.controls.target.set(50, 0, 0);
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 12; this.controls.maxDistance = 260;
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.controls.addEventListener('start', () => { this.follow = false; });

    sc.add(new THREE.HemisphereLight('#bfb8ff', '#20140c', 0.9));
    const dl = new THREE.DirectionalLight('#ffffff', 1.6); dl.position.set(30, 60, 40); sc.add(dl);
    const pl = new THREE.PointLight('#ffb36b', 40, 120, 1.6); pl.position.set(60, 18, 18); sc.add(pl);

    this.static = new THREE.Group(); sc.add(this.static);
    this.dyn = new THREE.Group(); sc.add(this.dyn);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._bindPointer();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement || canvas);

    this.setInstrument(this.tuning);
    this.resize();
    this.setCamera('player');
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  /* ---------- geometria ---------- */
  spacingAt(x) { const n = this.N; const s0 = n > 6 ? 0.78 : (n <= 4 ? 1.05 : 0.86), s1 = n > 6 ? 1.0 : (n <= 4 ? 1.45 : 1.08); return s0 + (s1 - s0) * (x / L); }
  // corda interna (1 = mais grave) → coordenada z
  stringZ(s, x) {
    const n = this.N; const off = (s - (n + 1) / 2) * this.spacingAt(x);
    return this.flip ? off : -off;
  }
  halfWidth(x) { return this.spacingAt(x) * (this.N - 1) / 2 + 0.75; }

  setFlip(v) { this.flip = !!v; this.setInstrument(this.tuning); }

  setInstrument(tuning) {
    this.tuning = (tuning && tuning.length) ? tuning.slice() : [64, 59, 55, 50, 45, 40];
    this.N = this.tuning.length;
    this._clearGroup(this.static); this._clearGroup(this.dyn);
    this.strings = [];
    this._buildNeck();
    this._buildStrings();
    this.hover = this._makeMarker('#ffffff', 0.35); this.hover.visible = false; this.dyn.add(this.hover);
    this.cursorLine = null;
    this.dirty = true;
  }
  _clearGroup(g) {
    while (g.children.length) {
      const o = g.children.pop();
      o.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) { const ms = Array.isArray(c.material) ? c.material : [c.material]; ms.forEach(m => { if (m.map) m.map.dispose(); m.dispose(); }); } });
    }
  }
  _buildNeck() {
    const g = this.static;
    const x0 = -4, x1 = fretX(FRETS) + 3.5;
    // braço (escala) — caixa afinando em direção à pestana
    const neckGeo = new THREE.BoxGeometry(x1 - x0, 1.2, 2, 48, 1, 1);
    neckGeo.translate((x0 + x1) / 2, -0.6, 0);
    const p = neckGeo.attributes.position;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i); p.setZ(i, p.getZ(i) / 1 * this.halfWidth(Math.max(0, x))); }
    neckGeo.computeVertexNormals();
    const wood = makeCanvasTexture(1024, 128, (c, w, h) => {
      c.fillStyle = '#3a2216'; c.fillRect(0, 0, w, h);
      for (let i = 0; i < 160; i++) { c.strokeStyle = `rgba(${20 + Math.random() * 40},${10 + Math.random() * 20},${5 + Math.random() * 10},${0.25 + Math.random() * 0.35})`; c.lineWidth = 1 + Math.random() * 2; c.beginPath(); const y = Math.random() * h; c.moveTo(0, y); c.bezierCurveTo(w * 0.3, y + Math.random() * 10 - 5, w * 0.6, y + Math.random() * 10 - 5, w, y + Math.random() * 6 - 3); c.stroke(); }
    });
    const neck = new THREE.Mesh(neckGeo, new THREE.MeshStandardMaterial({ map: wood, roughness: 0.75, metalness: 0.0 }));
    g.add(neck);
    this.pickPlane = neck;
    // corpo
    const shape = new THREE.Shape();
    const bx = x1 - 2, bl = 44, bw = 13;
    shape.moveTo(bx, -bw * 0.62);
    shape.bezierCurveTo(bx + 8, -bw * 1.05, bx + 16, -bw * 0.55, bx + 22, -bw * 0.9);
    shape.bezierCurveTo(bx + 34, -bw * 1.4, bx + bl, -bw * 0.9, bx + bl, 0);
    shape.bezierCurveTo(bx + bl, bw * 0.9, bx + 34, bw * 1.4, bx + 22, bw * 0.9);
    shape.bezierCurveTo(bx + 16, bw * 0.55, bx + 8, bw * 1.05, bx, bw * 0.62);
    shape.closePath();
    const bodyGeo = new THREE.ExtrudeGeometry(shape, { depth: 3.2, bevelEnabled: true, bevelThickness: 0.6, bevelSize: 0.6, bevelSegments: 3, curveSegments: 32 });
    bodyGeo.rotateX(Math.PI / 2); bodyGeo.translate(0, -1.4, 0);
    const burst = makeCanvasTexture(512, 512, (c, w, h) => {
      const gr = c.createRadialGradient(w * 0.55, h / 2, 20, w * 0.55, h / 2, w * 0.62);
      gr.addColorStop(0, '#e0a040'); gr.addColorStop(0.55, '#9c3f12'); gr.addColorStop(1, '#1a0a05');
      c.fillStyle = gr; c.fillRect(0, 0, w, h);
    });
    const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({ map: burst, roughness: 0.35, metalness: 0.05 }));
    g.add(body);
    // captadores
    const pickMat = new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.5 });
    [x1 + 6, L - 6].forEach(px => { const pk = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.6, this.halfWidth(L) * 2 + 0.8), pickMat); pk.position.set(px, -0.1, 0); g.add(pk);
      for (let s = 1; s <= this.N; s++) { const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.1, 10), new THREE.MeshStandardMaterial({ color: '#bbb', metalness: 0.9, roughness: 0.3 })); pole.position.set(px, 0.22, this.stringZ(s, px)); g.add(pole); } });
    // ponte
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.8, this.halfWidth(L) * 2 + 0.6), new THREE.MeshStandardMaterial({ color: '#9a9aa2', metalness: 0.9, roughness: 0.25 }));
    bridge.position.set(L + 0.9, -0.05, 0); g.add(bridge);
    // pestana
    const nut = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, this.halfWidth(0) * 2), new THREE.MeshStandardMaterial({ color: '#efe7d2', roughness: 0.4 }));
    nut.position.set(-0.3, 0.05, 0); g.add(nut);
    // trastes
    const fretMat = new THREE.MeshStandardMaterial({ color: '#d8d8de', metalness: 1.0, roughness: 0.22 });
    for (let n = 1; n <= FRETS; n++) {
      const x = fretX(n);
      const f = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, this.halfWidth(x) * 2 - 0.1, 8), fretMat);
      f.rotation.x = Math.PI / 2; f.position.set(x, 0.02, 0); g.add(f);
      // número da casa
      const lab = textSprite(String(n), [3, 5, 7, 9, 12, 15, 17, 19, 21, 24].includes(n) ? '#f2a33a' : '#8d86a0', 1.7);
      const xm = (fretX(n - 1) + x) / 2;
      lab.position.set(xm, 0.3, (this.flip ? -1 : 1) * (this.halfWidth(x) + 1.2)); g.add(lab);
    }
    // marcações
    const inlayMat = new THREE.MeshStandardMaterial({ color: '#f3ead8', roughness: 0.3, emissive: '#2a2520' });
    const inlay = (x, z) => { const d = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 20), inlayMat); d.position.set(x, 0.005, z); g.add(d); };
    [3, 5, 7, 9, 15, 17, 19, 21].forEach(n => inlay((fretX(n - 1) + fretX(n)) / 2, 0));
    [12, 24].forEach(n => { const x = (fretX(n - 1) + fretX(n)) / 2, hw = this.halfWidth(x); inlay(x, -hw * 0.45); inlay(x, hw * 0.45); });
    // cabeça (headstock)
    const head = new THREE.Mesh(new THREE.BoxGeometry(14, 0.9, this.halfWidth(0) * 2 + 1.6), new THREE.MeshStandardMaterial({ color: '#1d120c', roughness: 0.6 }));
    head.position.set(-11, -0.9, 0); g.add(head);
    // nomes das cordas soltas
    for (let s = 1; s <= this.N; s++) {
      const m = this.tuning[this.N - s];
      const name = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][m % 12];
      const lab = textSprite(name, STRING_COLORS[(this.N - s) % STRING_COLORS.length], 1.5);
      lab.position.set(-2.6, 0.5, this.stringZ(s, 0)); g.add(lab);
    }
  }
  _buildStrings() {
    for (let s = 1; s <= this.N; s++) {
      const tabIdx = this.N - s;                 // 0 = corda mais aguda (topo da tablatura)
      const r = (0.045 + 0.065 * ((this.N - s) / Math.max(1, this.N - 1))) * (this.N <= 5 ? 1.35 : 1);
      const color = new THREE.Color(STRING_COLORS[tabIdx % STRING_COLORS.length]);
      const geo = this._tubeGeometry(r);
      const metal = new THREE.MeshStandardMaterial({ color: s <= this.N / 2 ? '#c9a86a' : '#d9dbe2', metalness: 1.0, roughness: 0.28 });
      const mesh = new THREE.Mesh(geo, metal);
      const glowGeo = this._tubeGeometry(r * 3.2);
      const glowMat = new THREE.ShaderMaterial({
        vertexShader: GLOW_VS, fragmentShader: GLOW_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { color: { value: color }, litFrom: { value: 2 }, intensity: { value: 0 }, base: { value: 0 }, time: { value: 0 } }
      });
      const glow = new THREE.Mesh(glowGeo, glowMat);
      const marker = this._makeMarker(color.getStyle(), 0.55); marker.visible = false;
      const label = textSprite('0', '#ffffff', 2.2); label.visible = false;
      this.dyn.add(mesh, glow, marker, label);
      const st = { s, r, mesh, glow, marker, label, color, active: false, fret: 0, t0: 0, dur: 1, note: null, level: 0, release: 0, labelText: '' };
      this.strings[s] = st;
      this._shapeString(st, 0, 0, 0, 0);
    }
  }
  _makeMarker(color, rad) {
    const grp = new THREE.Group();
    const core = new THREE.Mesh(new THREE.SphereGeometry(rad, 20, 14), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.6, roughness: 0.3 }));
    const halo = new THREE.Mesh(new THREE.SphereGeometry(rad * 2.2, 20, 14), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending }));
    grp.add(core, halo);
    return grp;
  }
  _tubeGeometry(r) {
    const verts = (SEG + 1) * RING;
    const pos = new Float32Array(verts * 3), u = new Float32Array(verts), idx = [];
    for (let i = 0; i <= SEG; i++) for (let j = 0; j < RING; j++) u[i * RING + j] = i / SEG;
    for (let i = 0; i < SEG; i++) for (let j = 0; j < RING; j++) {
      const a = i * RING + j, b = i * RING + (j + 1) % RING, c = (i + 1) * RING + j, d = (i + 1) * RING + (j + 1) % RING;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('u', new THREE.BufferAttribute(u, 1));
    g.setIndex(idx);
    g.userData.r = r;
    return g;
  }
  /** Calcula a forma da corda: dz = deslocamento lateral (bend/vibrato), vib = amplitude da vibração */
  _shapeString(st, fingerX, dz, vibAmp, phase) {
    const geos = [st.mesh.geometry, st.glow.geometry];
    const yBase = 0.55;
    for (const g of geos) {
      const r = g.userData.r, p = g.attributes.position.array;
      for (let i = 0; i <= SEG; i++) {
        const x = (i / SEG) * L;
        let shape = 0;
        if (dz !== 0 && fingerX > 0) shape = x <= fingerX ? x / fingerX : (L - x) / (L - fingerX);
        let vy = 0;
        if (vibAmp > 0 && x > fingerX) { const uu = (x - fingerX) / (L - fingerX); vy = vibAmp * Math.sin(Math.PI * uu) * Math.sin(phase) + vibAmp * 0.35 * Math.sin(2 * Math.PI * uu) * Math.sin(phase * 2.03); }
        const cz = this.stringZ(st.s, x) + dz * shape;
        const cy = yBase + vy - (fingerX > 0 && x <= fingerX ? 0 : 0);
        for (let j = 0; j < RING; j++) {
          const a = (j / RING) * Math.PI * 2;
          const k = (i * RING + j) * 3;
          p[k] = x; p[k + 1] = cy + Math.cos(a) * r; p[k + 2] = cz + Math.sin(a) * r;
        }
      }
      g.attributes.position.needsUpdate = true;
      g.computeBoundingSphere();
    }
  }

  /* ---------- reprodução ---------- */
  play(notes, durMs) {
    const now = performance.now();
    const hit = new Set();
    for (const n of notes) {
      const st = this.strings[n.string]; if (!st) continue;
      hit.add(n.string);
      const sameTie = n.tie && st.active && st.fret === n.fret;
      st.note = n; st.fret = n.fret; st.dur = Math.max(60, durMs);
      if (!sameTie) { st.t0 = now; st.hitT = now; }
      else st.t0 = now;
      st.active = true; st.release = 0; st.static = false;
    }
    for (let s = 1; s <= this.N; s++) {
      const st = this.strings[s];
      if (st && st.active && !hit.has(s)) { st.active = false; st.release = now; }
    }
    this.dirty = true;
  }
  stopAll() {
    const now = performance.now();
    for (let s = 1; s <= this.N; s++) { const st = this.strings[s]; if (st && st.active) { st.active = false; st.release = now; } }
    this.dirty = true;
  }
  /** Mostra notas paradas (modo edição) e destaca a corda do cursor */
  showStatic(notes, cursorString) {
    const map = new Map(); (notes || []).forEach(n => map.set(n.string, n));
    for (let s = 1; s <= this.N; s++) {
      const st = this.strings[s]; if (!st) continue;
      const n = map.get(s);
      st.static = !!n; st.active = false; st.release = 0;
      st.note = n || null; st.fret = n ? n.fret : 0; st.staticCursor = cursorString === s;
    }
    this.cursorString = cursorString;
    this.dirty = true;
  }

  _bendAt(points, p) {
    if (!points || !points.length) return 0;
    const o = p * 60;
    if (o <= points[0].offset) return points[0].value;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (o <= b.offset) { const k = (o - a.offset) / Math.max(1, b.offset - a.offset); return a.value + (b.value - a.value) * k; }
    }
    return points[points.length - 1].value;
  }

  _update(now) {
    let animating = false;
    const t = now / 1000;
    for (let s = 1; s <= this.N; s++) {
      const st = this.strings[s]; if (!st) continue;
      const mat = st.glow.material.uniforms;
      mat.time.value = t;
      const n = st.note;
      let level = 0, fingerX = 0, dz = 0, vib = 0, phase = 0, fret = st.fret;
      if (st.active || (st.release && now - st.release < 260)) {
        animating = true;
        const el = now - st.t0, p = Math.min(1, el / st.dur);
        const rel = st.active ? 1 : Math.max(0, 1 - (now - st.release) / 260);
        const sinceHit = now - (st.hitT || st.t0);
        level = (n && n.dead ? Math.max(0, 1 - sinceHit / 160) : (0.55 + 0.45 * Math.exp(-sinceHit / 350))) * rel;
        // slide
        if (n && n.slideTo != null && p > 0.45) { const k = Math.min(1, (p - 0.45) / 0.5); fret = Math.round(st.fret + (n.slideTo - st.fret) * k); }
        fingerX = fret > 0 ? fretX(fret) - (fretX(fret) - fretX(fret - 1)) * 0.3 : 0;
        // bend (quartos de tom → semitons)
        let semis = n && n.bend ? this._bendAt(n.bend, p) / 2 : 0;
        // vibrato
        if (n && n.vibrato) semis += (n.vibrato === 2 ? 0.5 : 0.25) * (0.5 - 0.5 * Math.cos(2 * Math.PI * 5.5 * el / 1000));
        if (fret > 0 && semis > 0) {
          const towardLow = (this.N - s) < this.N / 2; // cordas agudas empurram em direção às graves
          const dir = (towardLow ? -1 : 1) * (this.flip ? -1 : 1);
          dz = dir * semis * this.spacingAt(fingerX) * 0.55;
        }
        // vibração da corda
        vib = n && !n.dead ? 0.09 * Math.exp(-sinceHit / 1400) * rel : 0;
        phase = 2 * Math.PI * 17 * el / 1000;
      } else if (st.static) {
        level = 0.7; fingerX = fret > 0 ? fretX(fret) - (fretX(fret) - fretX(fret - 1)) * 0.3 : 0;
        if (n && n.bend) { const semis = Math.max(...n.bend.map(b => b.value)) / 2; const towardLow = (this.N - s) < this.N / 2; dz = (towardLow ? -1 : 1) * (this.flip ? -1 : 1) * semis * this.spacingAt(fingerX) * 0.55; }
      }
      const changed = level > 0 || st.lastLevel > 0 || dz !== st.lastDz;
      if (changed) this._shapeString(st, fingerX, dz, vib, phase);
      st.lastLevel = level; st.lastDz = dz;
      mat.litFrom.value = level > 0 ? fingerX / L : 2;
      mat.intensity.value = level;
      mat.base.value = st.staticCursor ? 0.18 : (level > 0 ? 0.05 : 0);
      // marcador da casa
      if (level > 0) {
        st.marker.visible = true;
        const mx = fret > 0 ? fingerX : -1.0;
        st.marker.position.set(mx, 0.75, this.stringZ(s, mx) + (fret > 0 ? dz : 0));
        st.marker.scale.setScalar(0.75 + 0.45 * level);
        const txt = n && n.dead ? 'x' : String(fret);
        if (st.labelText !== txt) { st.labelText = txt; this._setLabel(st.label, txt); }
        st.label.visible = true;
        st.label.position.set(mx, 2.4, this.stringZ(s, mx) + (fret > 0 ? dz : 0));
      } else { st.marker.visible = false; st.label.visible = false; }
    }
    return animating;
  }
  _setLabel(sprite, txt) {
    const old = sprite.material.map;
    sprite.material.map = makeCanvasTexture(128, 128, (g, w, h) => {
      g.fillStyle = 'rgba(10,8,16,0.75)'; g.beginPath(); g.arc(w / 2, h / 2, 50, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.font = 'bold 64px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, w / 2, h / 2 + 3);
    });
    sprite.material.needsUpdate = true;
    if (old) old.dispose();
  }

  /* ---------- câmera / tela ---------- */
  setCamera(preset) {
    this.camPreset = preset || 'player';
    const dirs = { player: new THREE.Vector3(0, 0.86, 0.5), top: new THREE.Vector3(0, 1, 0.04), full: new THREE.Vector3(0, 0.62, 0.78) };
    const dir = (dirs[this.camPreset] || dirs.player).clone().normalize();
    const full = this.camPreset === 'full';
    this.follow = !full;
    const aspect = this.camera.aspect || 2;
    const wantW = full ? 122 : (aspect < 1.3 ? 30 : 50);
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    // distância que enquadra a largura desejada e também a largura do braço
    const dW = (wantW / 2) / Math.tan(hfov / 2);
    const dH = (this.halfWidth(L) * 2 + 6) / 2 / Math.tan(vfov / 2);
    const d = Math.max(dW, dH);
    this.camOffset = dir.multiplyScalar(d);
    const tx = full ? 52 : (this.focusX != null ? this.focusX : 24);
    const target = new THREE.Vector3(tx, 0, 0);
    this.camera.position.copy(target).add(this.camOffset);
    this.controls.target.copy(target);
    this.camera.lookAt(target);
    this.controls.update();
    this.dirty = true;
  }
  /** câmera acompanha a região do braço onde as notas estão */
  _follow() {
    if (!this.follow) return;
    let sum = 0, cnt = 0;
    for (let s = 1; s <= this.N; s++) { const st = this.strings[s]; if (st && st.marker.visible && st.fret > 0) { sum += st.marker.position.x; cnt++; } }
    if (!cnt) return;
    const aspect = this.camera.aspect || 2;
    const half = (aspect < 1.3 ? 30 : 50) / 2 - 4;
    const goal = Math.max(half - 4, Math.min(fretX(FRETS) - half + 8, sum / cnt));
    const cur = this.controls.target.x;
    const nx = cur + (goal - cur) * 0.06;
    if (Math.abs(nx - cur) < 0.01) return;
    const dx = nx - cur;
    this.controls.target.x += dx; this.camera.position.x += dx;
    this.focusX = this.controls.target.x;
    this.dirty = true;
  }
  resize() {
    const el = this.canvas;
    const w = el.clientWidth || 300, h = el.clientHeight || 150;
    if (w === this._w && h === this._h) return;
    this._w = w; this._h = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.setCamera(this.camPreset);
  }
  setVisible(v) { this.visible = v; if (v) { this.dirty = true; requestAnimationFrame(this._loop); } }

  /* ---------- toque / clique para escrever ---------- */
  _bindPointer() {
    let down = null;
    const toNdc = e => { const r = this.canvas.getBoundingClientRect(); this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
    this.canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
    this.canvas.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      toNdc(e); const hit = this._pick();
      if (hit) { const x = hit.fret > 0 ? fretX(hit.fret) - (fretX(hit.fret) - fretX(hit.fret - 1)) * 0.3 : -1.0; this.hover.visible = true; this.hover.position.set(x, 0.75, this.stringZ(hit.string, x)); }
      else this.hover.visible = false;
      this.dirty = true;
    });
    this.canvas.addEventListener('pointerleave', () => { this.hover.visible = false; this.dirty = true; });
    this.canvas.addEventListener('pointerup', e => {
      if (!down) return; const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null;
      if (moved > 6) return;
      toNdc(e); const hit = this._pick();
      if (hit && this.opts.onPick) this.opts.onPick(hit.string, hit.fret);
    });
  }
  _pick() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    // interseção com o plano da escala (y = 0.55, altura das cordas)
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.55);
    const pt = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, pt)) return null;
    if (pt.x < -5 || pt.x > fretX(FRETS) + 1) return null;
    if (Math.abs(pt.z) > this.halfWidth(Math.max(0, pt.x)) + 0.4) return null;
    let fret = 0;
    if (pt.x > 0) { for (let n = 1; n <= FRETS; n++) { if (pt.x <= fretX(n)) { fret = n; break; } } if (!fret) fret = FRETS; }
    let best = 1, bd = Infinity;
    for (let s = 1; s <= this.N; s++) { const d = Math.abs(this.stringZ(s, Math.max(0, pt.x)) - pt.z); if (d < bd) { bd = d; best = s; } }
    return { string: best, fret };
  }

  _loop(now) {
    if (!this.visible) return;
    const animating = this._update(now);
    this._follow();
    this.controls.update();
    if (animating || this.dirty) { this.renderer.render(this.scene, this.camera); this.dirty = false; }
    requestAnimationFrame(this._loop);
  }
  dispose() { this.visible = false; this.ro.disconnect(); this.controls.dispose(); this.renderer.dispose(); }
}
