/* Tab Studio — teclado 3D (three.js): tecla afunda e acende, com a cor da mão. */
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { RoomEnvironment } from '../vendor/RoomEnvironment.js';
import { LOW, HIGH, WHITE_COUNT, isBlack, noteName, whiteIndex, clampPitch, HandTracker, HAND_COLORS } from './pianokeys.js';

const KW = 2.35, KL = 14, BL = 9;
const keyX = m => (whiteIndex(m) - WHITE_COUNT / 2 + (isBlack(m) ? 1 : 0.5)) * KW;

function label(text, color, size) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 64;
  const g = c.getContext('2d'); g.fillStyle = color; g.font = 'bold 40px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 64, 34);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  s.scale.set(size * 2, size, 1); return s;
}

export class Keyboard3D {
  constructor(canvas, opts) {
    this.canvas = canvas; this.opts = opts || {};
    this.visible = true; this.dirty = true; this.view = 'player'; this.follow = true; this.focusX = keyX(60);
    this.hands = new HandTracker();
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.25;
    const sc = this.scene = new THREE.Scene(); sc.background = new THREE.Color('#0d0c12');
    // reflexos para metais (ponte, knobs, captadores) brilharem
    try { const pm = new THREE.PMREMGenerator(r); sc.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; sc.environmentIntensity = 0.55; pm.dispose(); } catch (e) { /* sem reflexos */ }
    this.camera = new THREE.PerspectiveCamera(32, 2, 0.5, 800);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true; this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.controls.addEventListener('start', () => { this.follow = false; });
    sc.add(new THREE.HemisphereLight('#d8d2ff', '#1a1210', 1.0));
    const dl = new THREE.DirectionalLight('#ffffff', 1.5); dl.position.set(-20, 50, 40); sc.add(dl);
    this._build();
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas.parentElement || canvas);
    this.resize(); this.setView('player');
    this._loop = this._loop.bind(this); requestAnimationFrame(this._loop);
  }
  _build() {
    this.keys = new Map();
    const whiteMat = () => new THREE.MeshStandardMaterial({ color: '#f3efe6', roughness: 0.38 });
    const blackMat = () => new THREE.MeshStandardMaterial({ color: '#141317', roughness: 0.28, metalness: 0.1 });
    const wGeo = new THREE.BoxGeometry(KW - 0.12, 1.4, KL); wGeo.translate(0, 0, KL / 2);
    const bGeo = new THREE.BoxGeometry(KW * 0.58, 1.1, BL); bGeo.translate(0, 0, BL / 2);
    for (let m = LOW; m <= HIGH; m++) {
      const black = isBlack(m);
      const pivot = new THREE.Group();
      pivot.position.set(keyX(m), black ? 1.05 : 0, -KL / 2);
      const mesh = new THREE.Mesh(black ? bGeo : wGeo, black ? blackMat() : whiteMat());
      pivot.add(mesh); this.scene.add(pivot);
      this.keys.set(m, { m, black, pivot, mat: mesh.material, active: false, static: false, release: 0, hand: null, t0: 0 });
      if (m % 12 === 0) { const l = label(noteName(m), '#8a8494', 1.1); l.position.set(keyX(m), 0.3, KL / 2 + 1.6); this.scene.add(l); }
    }
    const span = WHITE_COUNT * KW + 6;
    const caseMat = new THREE.MeshStandardMaterial({ color: '#17151c', roughness: 0.3 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(span, 2.2, KL + 6), caseMat); base.position.set(0, -1.9, 0.6); this.scene.add(base);
    const back = new THREE.Mesh(new THREE.BoxGeometry(span, 4.5, 4), caseMat); back.position.set(0, 0.6, -KL / 2 - 2.2); this.scene.add(back);
    const felt = new THREE.Mesh(new THREE.BoxGeometry(span - 4, 0.3, 0.6), new THREE.MeshStandardMaterial({ color: '#6a0f17', roughness: 0.9 })); felt.position.set(0, 0.85, -KL / 2 - 0.1); this.scene.add(felt);
    [-1, 1].forEach(sg => { const cheek = new THREE.Mesh(new THREE.BoxGeometry(2.4, 4.0, KL + 6), caseMat); cheek.position.set(sg * (span / 2 - 1.2), 0.2, 0.6); this.scene.add(cheek); });
    this.tags = new Map();
  }
  setView(v) {
    this.view = ['player', 'top', 'full'].includes(v) ? v : 'player';
    const dirs = { player: new THREE.Vector3(0, 0.86, 0.5), top: new THREE.Vector3(0, 1, 0.06), full: new THREE.Vector3(0, 0.7, 0.72) };
    const dir = dirs[this.view].clone().normalize();
    const full = this.view === 'full'; this.follow = !full;
    const aspect = this.camera.aspect || 2;
    const wantW = full ? WHITE_COUNT * KW + 10 : (aspect < 1.3 ? 26 : 54);
    const vfov = THREE.MathUtils.degToRad(this.camera.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    const d = Math.max((wantW / 2) / Math.tan(hfov / 2), (KL + 8) / 2 / Math.tan(vfov / 2));
    this.offset = dir.multiplyScalar(d);
    const tx = full ? 0 : this.focusX;
    const target = new THREE.Vector3(tx, 0, 0);
    this.camera.position.copy(target).add(this.offset); this.controls.target.copy(target); this.camera.lookAt(target); this.controls.update();
    this.dirty = true;
  }
  setCamera(v) { this.setView(v); }
  setTrack() { this.hands.reset(); this.stopAll(); for (const k of this.keys.values()) k.static = false; this.dirty = true; }
  setInstrument() { }
  setFlip() { }
  setVisible(v) { this.visible = v; if (v) { this.dirty = true; requestAnimationFrame(this._loop); } }
  resize() {
    const w = this.canvas.clientWidth || 300, h = this.canvas.clientHeight || 150;
    if (w === this._w && h === this._h) return; this._w = w; this._h = h;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.setView(this.view);
  }
  dispose() { this.visible = false; this.ro.disconnect(); this.controls.dispose(); this.renderer.dispose(); }

  _prep(notes) { const l = (notes || []).filter(n => n.pitch != null && !n.dead).map(n => ({ pitch: clampPitch(n.pitch), hand: n.hand || null, tie: n.tie })); this.hands.assign(l); return l; }
  play(notes, durMs) {
    const now = performance.now(), hit = new Set();
    for (const n of this._prep(notes)) {
      const k = this.keys.get(n.pitch); if (!k) continue;
      if (!(n.tie && k.active)) k.t0 = now;
      k.active = true; k.static = false; k.release = 0; k.hand = n.hand; hit.add(n.pitch);
    }
    for (const k of this.keys.values()) if (k.active && !hit.has(k.m)) { k.active = false; k.release = now; }
    this.dirty = true;
  }
  stopAll() { const now = performance.now(); for (const k of this.keys.values()) if (k.active) { k.active = false; k.release = now; } this.dirty = true; }
  showStatic(notes) {
    for (const k of this.keys.values()) { k.static = false; k.active = false; k.release = 0; }
    const t = new HandTracker(); t.c = Object.assign({}, this.hands.c);
    const l = (notes || []).filter(n => n.pitch != null).map(n => ({ pitch: clampPitch(n.pitch), hand: n.hand || null })); t.assign(l);
    for (const n of l) { const k = this.keys.get(n.pitch); if (k) { k.static = true; k.hand = n.hand; } }
    this.dirty = true;
  }
  _tag(k, on) {
    let t = this.tags.get(k.m);
    if (on && !t) { t = label(noteName(k.m), '#ffffff', 1.3); t.position.set(keyX(k.m), k.black ? 4.2 : 3.4, k.black ? -1 : 3); this.scene.add(t); this.tags.set(k.m, t); }
    if (t) t.visible = on;
  }
  _update(now) {
    let anim = false, sum = 0, cnt = 0;
    for (const k of this.keys.values()) {
      let lv = 0;
      if (k.static) lv = 0.8;
      else if (k.active) { lv = 0.6 + 0.4 * Math.exp(-(now - k.t0) / 400); anim = true; }
      else if (k.release) { const d = now - k.release; lv = d < 220 ? 0.6 * (1 - d / 220) : 0; if (d < 240) anim = true; else k.release = 0; }
      if (lv > 0 || k.lv > 0) {
        k.pivot.rotation.x = 0.075 * Math.min(1, lv * 1.4);
        // a tecla inteira ganha a cor da mão (branca e preta), não só afunda
        const col = new THREE.Color(HAND_COLORS[k.hand || 'X']);
        const base = new THREE.Color(k.black ? '#141317' : '#f3efe6');
        k.mat.color.copy(base).lerp(col, lv > 0 ? Math.min(1, 0.55 + lv) : 0);
        k.mat.emissive = col; k.mat.emissiveIntensity = lv * (k.black ? 0.9 : 0.3);
        this._tag(k, lv > 0.3);
        k.lv = lv;
      }
      if (lv > 0) { sum += keyX(k.m); cnt++; }
    }
    if (this.follow && cnt) {
      const goal = sum / cnt, cur = this.controls.target.x, nx = cur + (goal - cur) * 0.05;
      if (Math.abs(nx - cur) > 0.01) { const dx = nx - cur; this.controls.target.x += dx; this.camera.position.x += dx; this.focusX = this.controls.target.x; this.dirty = true; }
    }
    return anim;
  }
  /** aparelho lento: reduz a resolução do 3D para não atrasar a música */
  _adapt(now) {
    if (this._lastR) {
      const dt = now - this._lastR;
      if (dt < 400) { this._acc = (this._acc || 0) + dt; this._n = (this._n || 0) + 1; }
      if (this._n >= 45) {
        const avg = this._acc / this._n; this._acc = 0; this._n = 0;
        const pr = this.renderer.getPixelRatio();
        if (avg > 34 && pr > 0.6) { this.renderer.setPixelRatio(Math.max(0.6, pr * 0.75)); this.renderer.setSize(this._w || this.canvas.clientWidth, this._h || this.canvas.clientHeight, false); }
      }
    }
    this._lastR = now;
  }
  _loop(now) {
    if (!this.visible) return;
    const anim = this._update(now);
    this.controls.update();
    if (anim || this.dirty) { this.renderer.render(this.scene, this.camera); this.dirty = false; this._adapt(now); }
    requestAnimationFrame(this._loop);
  }
}
