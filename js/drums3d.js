/* Tab Studio — bateria em 3D (three.js).
 * Modelo: "Rack Drum Set" (Blend Swap #85792, licença CC0), só a geometria;
 * cores próprias do app (casco vermelho como a Les Paul, pratos de bronze, ferragens cromadas).
 * A peça tocada acende na cor de quem bate (mãos = laranja, pés = verde),
 * a pele recebe a "baqueta" e os pratos balançam. */
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { RoomEnvironment } from '../vendor/RoomEnvironment.js';
import { mergeGeometries } from '../vendor/BufferGeometryUtils.js';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { pieceOf, buildKit, velocityOf, LIMB_COLORS, BASE_NAMES, CYM_HIT } from './drumkit.js';
import { SHELL as LAC, cymbalCanvas, anisoCanvas, headCanvas, rugCanvas } from './drumlook.js';

const DR_URL = new URL('../models/drums.glb', import.meta.url).href;
// nome do material no modelo → [cor, metal, aspereza]
const DR_COLORS = {
  oil_finnish: [LAC.base, 0.1, 0.32], head_beat: ['#ebe5d6', 0, 0.75], head_snare: ['#f4f0e6', 0, 0.7], bd_head_beat: ['#ebe5d6', 0, 0.75],
  head_res: ['#d9d2c0', 0, 0.8], bd_reshead: [LAC.base, 0.1, 0.32],
  cymbal_01: ['#c9a04a', 1, 0.3], cymbal_01_brand: ['#c9a04a', 1, 0.3], cymbal_02: ['#c49a45', 1, 0.34], cymbal_03: ['#b8733a', 1, 0.32],
  chrome: ['#e2e4ea', 1, 0.12], thread: ['#c9ccd3', 1, 0.3], rough_chrome: ['#c9ccd3', 1, 0.35], alu: ['#c8ccd2', 1, 0.3],
  bras: ['#b5913a', 1, 0.3], ruthenium: ['#3c3d43', 1, 0.28], metal_dark: ['#2a2b30', 0.8, 0.4], metal: ['#9a9da5', 1, 0.3],
  brushed_finnish: ['#8d9098', 1, 0.42], finnish: ['#8d9098', 1, 0.42], bd_pedal_brand: ['#2c2c31', 0.7, 0.45],
  rubber: ['#151517', 0, 0.9], rubber_red: ['#8a1a1a', 0, 0.8], felt: ['#6b1a1a', 0, 1], plastic: ['#1c1c1e', 0.1, 0.5], leather: ['#141416', 0.05, 0.55]
};
let DR_PROMISE = null;
function loadDrums() {
  if (!DR_PROMISE) {
    const loader = new GLTFLoader();
    // no link de visualização o modelo vem embutido num .js (o servidor de lá não entrega .glb),
    // carregado só quando a bateria 3D é aberta
    const embedded = window.TABSTUDIO_DR_SRC && !window.TABSTUDIO_DR_B64
      ? new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = window.TABSTUDIO_DR_SRC; sc.onload = res; sc.onerror = () => rej(new Error('não foi possível baixar a bateria 3D')); document.head.appendChild(sc); })
      : Promise.resolve();
    const src = embedded.then(() => window.TABSTUDIO_DR_B64
      ? loader.parseAsync(Uint8Array.from(atob(window.TABSTUDIO_DR_B64), c => c.charCodeAt(0)).buffer, '')
      : loader.loadAsync(DR_URL));
    DR_PROMISE = src.then(g => g.scene);
    DR_PROMISE.catch(() => { DR_PROMISE = null; });
  }
  return DR_PROMISE;
}

// tambores do modelo, do mais agudo ao mais grave
const TOMS_3D = ['tt10', 'tt12', 'ft14', 'ft16'];
const TOM_NAMES = { tt10: 'Tom 1', tt12: 'Tom 2', ft14: 'Surdo', ft16: 'Surdo 2' };
const DRUMS_3D = new Set(['kick', 'snare', 'tt10', 'tt12', 'ft14', 'ft16']);   // tambores: casco + pele + ferragens vibram juntos
const CYM_IDS = ['hihat', 'crash1', 'crash2', 'ride', 'china', 'splash'];

export class Drums3D {
  constructor(canvas, opts) {
    this.canvas = canvas; this.opts = opts || {};
    this.visible = true; this.dirty = true; this.view = 'player';
    this.hits = new Map(); this.preview = new Map();
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, matchMedia('(pointer: coarse)').matches ? 1.25 : 1.5)); r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.2;
    const sc = this.scene = new THREE.Scene(); sc.background = new THREE.Color('#0d0c12');
    try { const pm = new THREE.PMREMGenerator(r); sc.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; sc.environmentIntensity = 0.6; pm.dispose(); } catch (e) { /* sem reflexos */ }
    this.camera = new THREE.PerspectiveCamera(38, 2, 0.05, 50);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true; this.controls.maxPolarAngle = Math.PI * 0.495; this.controls.minDistance = 0.6; this.controls.maxDistance = 8;
    this.controls.addEventListener('change', () => { this.dirty = true; });
    sc.add(new THREE.HemisphereLight('#e2dcff', '#1a1210', 0.9));
    const dl = new THREE.DirectionalLight('#ffffff', 1.6); dl.position.set(1.5, 3.5, 2.5); sc.add(dl);
    const dl2 = new THREE.DirectionalLight('#ffe2c0', 0.6); dl2.position.set(-2, 2, -2); sc.add(dl2);
    // chão
    const rugTex = new THREE.CanvasTexture(rugCanvas(512)); rugTex.colorSpace = THREE.SRGBColorSpace;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(1.9, 64), new THREE.MeshStandardMaterial({ map: rugTex, roughness: 0.97 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.002; sc.add(floor);
    this.kitGroup = new THREE.Group(); sc.add(this.kitGroup);
    this.setKit([]);
    this.ready = loadDrums().then(model => { this._build(model); this.dirty = true; }).catch(e => { this.loadError = e; if (this.opts.onError) this.opts.onError(e); });
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas.parentElement || canvas);
    this.resize(); this.setView('player');
    this._loop = this._loop.bind(this); requestAnimationFrame(this._loop);
  }

  _mat(name) {
    const C = DR_COLORS[name] || ['#888888', 0.5, 0.5];
    // casco: laca com verniz por cima (o brilho "molhado" de bateria de verdade)
    if (name === 'oil_finnish' || name === 'bd_reshead') return new THREE.MeshPhysicalMaterial({ color: C[0], metalness: C[1], roughness: C[2], clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 0.8 });
    return new THREE.MeshStandardMaterial({ color: C[0], metalness: C[1], roughness: C[2], envMapIntensity: name === 'oil_finnish' || name === 'bd_reshead' ? 0.55 : 1 });
  }
  _build(model) {
    model = model.clone(true);
    model.updateMatrixWorld(true);
    const shared = new Map(); const getShared = n => { if (!shared.has(n)) shared.set(n, this._mat(n)); return shared.get(n); };
    this.parts = new Map();   // id → { meshes, mats, center, normal, base }
    const statics = [];
    model.traverse(o => {
      if (!o.isMesh) return;
      const tag = (o.parent && o.parent.name && !o.parent.isScene && o.parent.name !== 'Scene' ? o.parent.name : o.name).split('.')[0];
      const m = /^(HEAD|CYM|PEDAL|SHELL|HW|RES|RESHEAD)_(.+)$/.exec(tag);
      const matName = o.material && o.material.name;
      const body = m && ['SHELL', 'HW', 'RES', 'RESHEAD'].includes(m[1]);
      if (m && (!body || DRUMS_3D.has(m[2]))) {
        const id = m[1] === 'PEDAL' ? 'pedal_' + m[2] : m[2];
        if (!this.parts.has(id)) this.parts.set(id, { meshes: [], lit: [], kind: m[1] === 'CYM' ? 'CYM' : m[1] === 'PEDAL' ? 'PEDAL' : 'HEAD' });
        const part = this.parts.get(id);
        if (body) { o.material = getShared(matName); part.meshes.push(o); }
        else {
          // peças que acendem: material próprio para poder brilhar sozinho
          o.material = this._mat(matName); o.material.emissive = new THREE.Color('#000000');
          part.meshes.push(o); part.lit.push(o);
        }
      } else { o.material = getShared(matName); statics.push(o); }
    });
    // junta as peças fixas por material (poucas chamadas de desenho = leve no celular)
    const byMat = new Map();
    for (const o of statics) {
      let geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
      for (const name of Object.keys(geo.attributes)) if (!['position', 'normal'].includes(name)) geo.deleteAttribute(name);
      if (geo.index) geo = geo.toNonIndexed();
      const k = o.material.uuid; if (!byMat.has(k)) byMat.set(k, { mat: o.material, geos: [] }); byMat.get(k).geos.push(geo);
    }
    for (const { mat, geos } of byMat.values()) { const g = mergeGeometries(geos, false); if (g) this.kitGroup.add(new THREE.Mesh(g, mat)); }
    // peças animadas: ficam num "pivô" no centro delas (os pratos giram em volta do próprio centro)
    for (const [id, p] of this.parts) {
      // centro e tamanho pela pele/prato (as ferragens não contam)
      const box = new THREE.Box3(); p.lit.forEach(o => box.expandByObject(o));
      const center = box.getCenter(new THREE.Vector3());
      const pivot = new THREE.Group(); pivot.position.copy(center); this.kitGroup.add(pivot);
      // normal da pele/prato: média das normais da malha
      const nrm = new THREE.Vector3();
      for (const o of p.meshes) {
        const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
        if (p.lit.includes(o)) { const tmp = geo.clone(); tmp.computeVertexNormals(); const na = tmp.attributes.normal; for (let i = 0; i < na.count; i += 3) nrm.add(new THREE.Vector3(na.getX(i), na.getY(i), na.getZ(i))); }
        o.geometry = geo; o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1);
        o.geometry.translate(-center.x, -center.y, -center.z);
        pivot.add(o);
      }
      if (nrm.lengthSq() < 1e-6 || Math.abs(nrm.normalize().y) < 0.2) nrm.set(0, 1, 0);
      if (nrm.y < 0) nrm.negate();
      // o bumbo fica de pé: a "frente" da pele é virada para o baterista (-z)
      if (id === 'kick') nrm.set(0, 0, -1);
      const size = box.getSize(new THREE.Vector3());
      p.pivot = pivot; p.center = center; p.normal = nrm; p.radius = Math.max(size.x, size.z, id === 'kick' ? size.y : 0) / 2;
      this._finish(id, p);
      p.mats = p.lit.map(o => o.material); p.base = p.mats.map(m => m.color.clone());
    }
    // ponta da baqueta (uma por peça) e anel da prévia
    this.sticks = new Map(); this.rings = new Map();
    const sGeo = new THREE.SphereGeometry(1, 20, 14), rGeo = new THREE.TorusGeometry(1, 0.12, 8, 32);
    for (const [id, p] of this.parts) {
      if (id.startsWith('pedal_')) continue;
      const sm = new THREE.Mesh(sGeo, new THREE.MeshBasicMaterial({ color: LIMB_COLORS.hand, transparent: true }));
      sm.visible = false; this.scene.add(sm); this.sticks.set(id, sm);
      const rm = new THREE.Mesh(rGeo, new THREE.MeshBasicMaterial({ color: LIMB_COLORS.hand }));
      rm.visible = false; this.scene.add(rm); this.rings.set(id, rm);
      // onde a baqueta bate: perto do centro, um pouco para o lado do baterista
      const hit = p.center.clone();
      if (id === 'kick') hit.add(new THREE.Vector3(0, -p.radius * 0.25, -0.24));
      else if (id.startsWith('CYM') || CYM_IDS.includes(id)) hit.add(new THREE.Vector3(0, 0, -p.radius * 0.55)).add(p.normal.clone().multiplyScalar(0.02));
      else hit.add(new THREE.Vector3(0, 0, -p.radius * 0.25)).add(p.normal.clone().multiplyScalar(0.015));
      p.hitPoint = hit;
      const r = Math.max(0.018, Math.min(0.03, p.radius * 0.14));
      sm.scale.setScalar(r); sm.position.copy(hit);
      rm.scale.setScalar(r * 1.1); rm.position.copy(hit).add(p.normal.clone().multiplyScalar(0.01));
      rm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), p.normal);
    }
    this.built = true; this.dirty = true;
  }

  /* acabamento igual ao do 2D: textura do prato (torneado + martelado + nome) e da pele.
     As coordenadas da textura são uma projeção plana sobre a pele/prato,
     com o "pé" do texto virado para o baterista (no bumbo, para o chão). */
  _finish(id, p) {
    const cym = p.kind === 'CYM', head = p.kind === 'HEAD';
    if (!cym && !head) return;
    const n = p.normal.clone().normalize();
    const D = (id === 'kick' ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(0, 0, -1));
    D.addScaledVector(n, -n.dot(D)).normalize();
    const Rt = new THREE.Vector3().crossVectors(n, D).normalize();
    const R = Math.max(1e-4, p.radius);
    const label = TOM_NAMES[id] || BASE_NAMES[id] || '';
    let map, aniso = null;
    if (cym) {
      map = new THREE.CanvasTexture(cymbalCanvas(id, label, 512));
      aniso = new THREE.CanvasTexture(anisoCanvas(id, 256)); aniso.colorSpace = THREE.NoColorSpace;
    } else map = new THREE.CanvasTexture(headCanvas(id === 'snare' ? 'snare' : id === 'kick' ? 'kick' : 'tom', id === 'kick' ? '' : label, 512));
    map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
    const v = new THREE.Vector3();
    for (const o of p.lit) {
      const pos = o.geometry.attributes.position, uv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        uv[i * 2] = 0.5 + v.dot(Rt) / (2 * R); uv[i * 2 + 1] = 0.5 - v.dot(D) / (2 * R);
      }
      o.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      const old = o.material;
      o.material = cym
        ? new THREE.MeshPhysicalMaterial({ color: '#ffffff', map, metalness: 1, roughness: 0.3, anisotropy: 0.8, anisotropyMap: aniso, envMapIntensity: 1.15 })
        : new THREE.MeshStandardMaterial({ color: '#ffffff', map, metalness: 0, roughness: 0.78 });
      o.material.emissive = new THREE.Color('#000000');
      if (old && old.dispose) old.dispose();
    }
  }

  /* kit da música → peça do modelo 3D */
  setKit(midis) {
    this.kit = buildKit(midis);
    const toms = this.kit.pieces.filter(p => p.tom).map(p => p.id);       // já vem agudo → grave
    this.map3d = new Map();
    toms.forEach((id, i) => this.map3d.set(id, TOMS_3D[Math.min(TOMS_3D.length - 1, Math.round(i * (TOMS_3D.length - 1) / Math.max(1, toms.length - 1)))]));
    if (toms.length <= TOMS_3D.length) toms.forEach((id, i) => this.map3d.set(id, TOMS_3D[i]));
    this.hits.clear(); this.dirty = true;
  }
  setTrack(o) { if (o && o.drums) this.setKit(o.drums); }
  setInstrument() { }
  setFlip() { }
  _info(n) {
    if (n.drum == null) return null;
    const p = pieceOf(n.drum);
    let id = p.id;
    if (id.startsWith('tom')) id = this.map3d.get(id) || (this.kit.byId.has(id) ? 'tt12' : 'tt12');
    else if (id === 'cowbell' || id === 'tamb' || id === 'perc') id = null;   // sem peça no modelo (aparecem no 2D)
    if (!id) return null;
    return { id, v: p.v, limb: p.limb, vel: velocityOf(n) };
  }
  play(notes, durMs, upcoming, preview) {
    const now = performance.now();
    for (const n of notes || []) {
      if (n.tie) continue;
      const i = this._info(n); if (!i) continue;
      if (i.v === 'pedal') { this.hits.set('hihat:p', { t0: now, vel: i.vel, limb: 'foot', v: 'pedal' }); continue; }
      this.hits.set(i.id, { t0: now, vel: i.vel, limb: i.limb, v: i.v });
      if (i.id === 'kick') this.hits.set('pedal_kick', { t0: now, vel: i.vel, limb: 'foot' });
    }
    this.setPreview(preview);
    this.dirty = true;
  }
  setPreview(list) {
    this.preview = new Map();
    for (const n of list || []) { const i = this._info(n); if (i && i.v !== 'pedal' && !this.preview.has(i.id)) this.preview.set(i.id, i.limb); }
    this.dirty = true;
  }
  stopAll() { this.preview = new Map(); this.dirty = true; }
  showStatic(notes) {
    this.hits.clear();
    for (const n of notes || []) { const i = this._info(n); if (i) this.hits.set(i.v === 'pedal' ? 'hihat:p' : i.id, { t0: 0, vel: i.vel, limb: i.limb, v: i.v, static: true }); }
    this.dirty = true;
  }
  level(key, now) {
    const h = this.hits.get(key); if (!h) return 0;
    if (h.static) return 0.8;
    const d = (now || performance.now()) - h.t0; if (d < 0) return 0;
    return h.vel * Math.exp(-d / (CYM_IDS.includes(key) ? 520 : 240));
  }

  setView(v) {
    this.view = ['player', 'front', 'top'].includes(v) ? v : 'player';
    const aspect = this.camera.aspect || 2, narrow = aspect < 1.1;
    // distâncias pensadas para o kit inteiro caber (≈ 2,3 m de largura com o rack)
    const P = {
      player: { pos: [0, narrow ? 2.25 : 1.78, narrow ? -3.15 : -2.05], tgt: [0, 0.6, 0.3] },
      front: { pos: [narrow ? 0.45 : 0.65, 1.2, narrow ? 3.3 : 2.55], tgt: [0, 0.55, 0.2] },
      top: { pos: [0, narrow ? 4.2 : 3.4, narrow ? -1.3 : -1.05], tgt: [0, 0.3, 0.28] }
    }[this.view];
    this.camera.position.set(...P.pos); this.controls.target.set(...P.tgt); this.camera.lookAt(this.controls.target); this.controls.update();
    this.dirty = true;
  }
  setCamera(v) { this.setView(v); }
  setVisible(v) { this.visible = v; if (v) { this.dirty = true; requestAnimationFrame(this._loop); } }
  resize() {
    const c = this.canvas, w = c.clientWidth || 300, h = c.clientHeight || 150;
    this._w = w; this._h = h;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.setView(this.view);
  }
  dispose() { this.visible = false; this.ro.disconnect(); this.controls.dispose(); this.renderer.dispose(); }

  _update(now) {
    if (!this.built) return false;
    let anim = false;
    for (const [id, p] of this.parts) {
      const key = id;
      let lv = this.level(key, now);
      const h = this.hits.get(key);
      let col = h ? LIMB_COLORS[h.limb] : LIMB_COLORS.hand;
      if (p.kind === 'CYM' && col === LIMB_COLORS.hand) col = CYM_HIT;   // laranja some no bronze: roxo
      // chimbal de pé: o prato fecha e acende em verde
      if (id === 'hihat') { const lp = this.level('hihat:p', now); if (lp > lv) { lv = lp; col = LIMB_COLORS.foot; } }
      if (lv > 0.004 || p._lit) {
        // a pele/prato tinge com a cor de quem bate (pele branca só com brilho não mostrava a cor)
        const c = this._tmp || (this._tmp = new THREE.Color()); c.set(col);
        p.mats.forEach((m, i) => { m.color.copy(p.base[i]).lerp(c, Math.min(0.95, lv * 1.3)); m.emissive.copy(c); m.emissiveIntensity = Math.min(0.9, lv * 0.9); });
        p._lit = lv > 0.004; anim = true;
      }
      // pratos balançam; peles afundam um pouquinho
      if (p.kind === 'CYM') {
        let hh = h;
        if (id === 'hihat') { const hp = this.hits.get('hihat:p'); if (hp && !hp.static && (!hh || hp.t0 > hh.t0)) hh = hp; }
        const t = hh && !hh.static ? (now - hh.t0) / 1000 : 0;
        const a = (hh && !hh.static ? 0.55 + 0.45 * hh.vel : 0) * Math.exp(-t / 0.75);
        if (a > 0.002 || p._mov) {
          // a borda perto do baterista desce primeiro (como uma baquetada de verdade), depois balança
          p.pivot.rotation.x = -a * 0.3 * Math.sin(t * 16 + 0.4); p.pivot.rotation.z = a * 0.17 * Math.sin(t * 11 + 1);
          const hp = this.hits.get('hihat:p');
          p.pivot.position.y = p.center.y - (id === 'hihat' && hp && !hp.static ? 0.012 * Math.exp(-(now - hp.t0) / 120) : 0);
          p._mov = a > 0.002; anim = true;
        }
      } else if (p.kind === 'HEAD') {
        // tambor inteiro: encolhe/cresce rápido e dá um "pulinho" na direção da pele (exagerado de propósito)
        const t = h && !h.static ? now - h.t0 : 1e9;
        if (t < 500 || p._mov) {
          const e = t < 500 ? (0.55 + 0.45 * h.vel) * Math.exp(-t / 140) : 0, osc = Math.sin(t * 0.07);
          p.pivot.scale.setScalar(1 - 0.12 * e * osc);
          p.pivot.position.copy(p.center).addScaledVector(p.normal, (id === 'kick' ? 0.015 : 0.025) * e * Math.abs(osc));
          p._mov = e > 0.003; anim = true;
        }
      }
      // baqueta e prévia
      const st = this.sticks.get(id), rg = this.rings.get(id);
      if (st) {
        const show = lv > 0.05 || (h && h.static);
        st.visible = !!show;
        if (show) { st.material.color.set(col); st.material.opacity = Math.min(1, 0.4 + lv); const grow = h && h.t0 && !h.static ? Math.min(1, 0.6 + 0.4 * (now - h.t0) / 110) : 1; st.scale.setScalar(Math.max(0.018, Math.min(0.03, p.radius * 0.14)) * grow); }
      }
      if (rg) { const pv = this.preview.get(id); rg.visible = !!pv && lv < 0.3; if (pv) rg.material.color.set(p.kind === 'CYM' && pv === 'hand' ? CYM_HIT : LIMB_COLORS[pv]); }
    }
    return anim;
  }
  _adapt(now) {
    if (this._lastR) {
      const dt = now - this._lastR;
      if (dt < 400) { this._acc = (this._acc || 0) + dt; this._n = (this._n || 0) + 1; }
      if (this._n >= 45) {
        const avg = this._acc / this._n; this._acc = 0; this._n = 0;
        const pr = this.renderer.getPixelRatio();
        if (avg > 52 && pr > 0.6) { this.renderer.setPixelRatio(Math.max(0.6, pr * 0.75)); this.renderer.setSize(this._w, this._h, false); }
      }
    }
    this._lastR = now;
  }
  _loop(now) {
    if (!this.visible) return;
    const anim = this._update(now);
    this.controls.update();
    if (this.dirty || (anim && now - (this._lf || 0) >= 31)) { this.renderer.render(this.scene, this.camera); this.dirty = false; this._lf = now; this._adapt(now); }
    requestAnimationFrame(this._loop);
  }
}
