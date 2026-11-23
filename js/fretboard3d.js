/* Tab Studio — braço de guitarra/baixo em 3D (three.js).
 * Mostra a casa pressionada, acende a corda da casa até a ponte,
 * balança a corda no vibrato e estica lateralmente no bend. */
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { RoomEnvironment } from '../vendor/RoomEnvironment.js';
import { mergeGeometries } from '../vendor/BufferGeometryUtils.js';
import { GLTFLoader } from '../vendor/GLTFLoader.js';

/* Les Paul 3D: modelo "Generic Les Paul Guitar" de simonrepp (Blend Swap, licença CC0),
 * convertido para o sistema do app (x: pestana 0 → ponte 100, y: para cima, z: graves em +z). */
const LP_URL = new URL('../models/lespaul.glb', import.meta.url).href;
const LP_COLORS = {
  'Finish': ['#45070b', 0.05, 0.32], 'Golden Metal': ['#d4a943', 1, 0.22], 'Silver Metal': ['#d8d8de', 1, 0.22],
  'Fretboard Wood': ['#1a0e08', 0, 0.8], 'Ivory': ['#e8dcc0', 0, 0.4], 'Plastic': ['#0c0b0d', 0.1, 0.3],
  'Knobs': ['#b8862e', 0.75, 0.28], 'Pickup Wrap Fabric': ['#2a1a10', 0.3, 0.6], 'Pickup Bobbin': ['#5c3519', 0.85, 0.35]
};
let LP_PROMISE = null;
function loadLesPaul() {
  if (!LP_PROMISE) {
    const loader = new GLTFLoader();
    // versão do link de visualização: o modelo vem embutido num .js (o servidor de lá não entrega .glb)
    const src = window.TABSTUDIO_LP_B64
      ? loader.parseAsync(Uint8Array.from(atob(window.TABSTUDIO_LP_B64), c => c.charCodeAt(0)).buffer, '')
      : loader.loadAsync(LP_URL);
    LP_PROMISE = src.then(gltf => {
      const scene = gltf.scene;
      scene.traverse(o => {
        if (!o.isMesh) return;
        const C = LP_COLORS[o.material.name];
        if (C) o.material = new THREE.MeshStandardMaterial({ color: C[0], metalness: C[1], roughness: C[2], envMapIntensity: o.material.name === 'Finish' ? 0.4 : 1 });
        o.userData.shared = true;
      });
      scene.updateMatrixWorld(true);
      // altura da escala (para as marcações ficarem rentes à madeira)
      // a escala é abaulada: pega o ponto mais alto (centro) em algumas casas
      let top = -Infinity;
      for (const n of [3, 7, 12, 17]) for (const z of [-1.5, -0.5, 0, 0.5, 1.5]) {
        const ray = new THREE.Raycaster(new THREE.Vector3((fretX(n - 1) + fretX(n)) / 2, 10, z), new THREE.Vector3(0, -1, 0));
        const hit = ray.intersectObject(scene, true).find(h => h.object.material && h.object.material.color && h.object.material.color.getHexString() === '1a0e08');
        if (hit) top = Math.max(top, hit.point.y);
      }
      scene.userData.boardY = isFinite(top) ? top : 0;
      return scene;
    });
    LP_PROMISE.catch(() => { LP_PROMISE = null; });
  }
  return LP_PROMISE;
}

const L = 100;            // comprimento de escala (pestana → ponte)
const FRETS = 22;          // Les Paul
const MARKS = [3, 5, 7, 9, 12, 15, 17, 19, 21];
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
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.1;

    const sc = this.scene = new THREE.Scene();
    sc.background = new THREE.Color('#0d0c12');
    // reflexos para metais (ponte, knobs, captadores) brilharem
    try { const pm = new THREE.PMREMGenerator(r); sc.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; sc.environmentIntensity = 0.55; pm.dispose(); } catch (e) { /* sem reflexos */ }
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
    loadLesPaul().then(model => { this.model = model; this.setInstrument(this.tuning); }).catch(() => { /* fica a guitarra desenhada por código */ });
    this.resize();
    this.setCamera('player');
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  /* ---------- geometria ---------- */
  /* espaçamento real (escala 100 = 628 mm): guitarra 35 mm na pestana e 52 mm na ponte */
  spacingAt(x) { const n = this.N; const s0 = n > 6 ? 1.27 : (n <= 5 ? 1.75 : 1.115), s1 = n > 6 ? 1.67 : (n <= 5 ? 2.6 : 1.655); return s0 + (s1 - s0) * (x / L); }
  // corda interna (1 = mais grave) → coordenada z
  stringZ(s, x) {
    const n = this.N; const off = (s - (n + 1) / 2) * this.spacingAt(x);
    return this.flip ? off : -off;
  }
  halfWidth(x) { return this.spacingAt(x) * (this.N - 1) / 2 + 0.6; }

  setFlip(v) { this.flip = !!v; this.setInstrument(this.tuning); }

  setInstrument(tuning) {
    this.tuning = (tuning && tuning.length) ? tuning.slice() : [64, 59, 55, 50, 45, 40];
    this.N = this.tuning.length;
    this._clearGroup(this.static); this._clearGroup(this.dyn);
    this.strings = [];
    this._buildNeck();
    this._mergeStatic();
    this._buildStrings();
    this.hover = this._makeMarker('#ffffff', 0.35); this.hover.visible = false; this.dyn.add(this.hover);
    this.cursorLine = null;
    this.dirty = true;
  }
  _clearGroup(g, keepMaterials) {
    while (g.children.length) {
      const o = g.children.pop();
      o.traverse(c => { if (c.userData.shared) return; if (c.geometry && !c.isSprite) c.geometry.dispose(); if (!keepMaterials && c.material) { const ms = Array.isArray(c.material) ? c.material : [c.material]; ms.forEach(m => { if (m.map) m.map.dispose(); m.dispose(); }); } });
    }
  }
  /* ---------- Les Paul (contorno tirado das fotos de referência) ---------- */
  _buildNeck() {
    if (this.model) { this._buildFromModel(); return; }
    const g = this.static;
    const bass = this.flip ? -1 : 1;            // lado das cordas graves (+z quando não invertido)
    const GOLD = new THREE.MeshStandardMaterial({ color: '#d4a943', metalness: 1.0, roughness: 0.22 });
    const DARKGOLD = new THREE.MeshStandardMaterial({ color: '#9a7330', metalness: 0.95, roughness: 0.25 });
    const COPPER = new THREE.MeshStandardMaterial({ color: '#5c3519', metalness: 0.85, roughness: 0.38, envMapIntensity: 0.6 });
    const BLACK = new THREE.MeshStandardMaterial({ color: '#0c0b0d', roughness: 0.3, metalness: 0.1 });
    const CREAM = new THREE.MeshStandardMaterial({ color: '#e3d6b8', roughness: 0.4 });
    const FINISH = new THREE.MeshStandardMaterial({ color: '#4a070c', roughness: 0.32, metalness: 0.05, envMapIntensity: 0.5 });
    const lastFret = fretX(FRETS);
    // escala (rosewood)
    const boardEnd = lastFret + 1.3;
    const board = new THREE.BoxGeometry(boardEnd + 0.3, 0.6, 2, 48, 1, 1);
    board.translate((boardEnd - 0.3) / 2, -0.3, 0);
    const bp = board.attributes.position;
    for (let i = 0; i < bp.count; i++) bp.setZ(i, bp.getZ(i) * this.halfWidth(Math.max(0, bp.getX(i))));
    board.computeVertexNormals();
    const rosewood = makeCanvasTexture(1024, 128, (c, w, h) => {
      c.fillStyle = '#140a05'; c.fillRect(0, 0, w, h);
      for (let i = 0; i < 180; i++) { c.strokeStyle = `rgba(${40 + Math.random() * 35},${18 + Math.random() * 14},${8 + Math.random() * 8},${0.25 + Math.random() * 0.4})`; c.lineWidth = 0.6 + Math.random() * 1.8; c.beginPath(); const y = Math.random() * h; c.moveTo(0, y); c.bezierCurveTo(w * 0.3, y + Math.random() * 8 - 4, w * 0.6, y + Math.random() * 8 - 4, w, y + Math.random() * 5 - 2.5); c.stroke(); }
    });
    const boardMesh = new THREE.Mesh(board, new THREE.MeshStandardMaterial({ map: rosewood, roughness: 0.85, envMapIntensity: 0.3 }));
    g.add(boardMesh);
    this.pickPlane = boardMesh;

    // contorno do corpo: pontos medidos na foto frontal (px), convertidos para o braço (s = unidades/px)
    const S = 0.098, PX0 = 290, PY0 = 236;
    const X0 = L - (628 - PY0) * S;              // a ponte da foto (y=628) cai exatamente na ponte do braço
    const W = (px, py) => [X0 + (py - PY0) * S, (PX0 - px) * S * bass];
    const OUT = [[248, 236], [205, 225], [160, 226], [125, 240], [106, 265], [100, 300], [101, 360], [98, 420], [88, 480], [66, 540], [42, 610], [32, 690], [42, 770], [78, 840], [140, 900], [220, 940], [300, 955], [380, 945], [460, 915], [525, 860], [568, 790], [584, 710], [578, 630], [552, 560], [515, 505], [480, 470], [467, 430], [470, 385], [484, 340], [497, 306], [494, 292], [478, 291], [450, 300], [415, 316], [378, 330], [342, 340], [338, 300], [336, 236]];
    const curve = new THREE.SplineCurve(OUT.map(p => new THREE.Vector2(...W(p[0], p[1]))));
    curve.closed = true;
    const pts = curve.getSpacedPoints(220);
    const shape = new THREE.Shape(pts);
    const bevT = 1.6, depth = 5.6, topY = -1.95;
    const bodyGeo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevT, bevelSize: 1.2, bevelSegments: 3, curveSegments: 4 });
    bodyGeo.rotateX(Math.PI / 2);
    bodyGeo.translate(0, topY - bevT, 0);
    const burst = makeCanvasTexture(512, 512, (c, w, h) => {
      const gr = c.createRadialGradient(w * 0.46, h * 0.5, 10, w * 0.5, h * 0.5, w * 0.62);
      gr.addColorStop(0, '#6a0b12'); gr.addColorStop(0.55, '#45060b'); gr.addColorStop(1, '#1a0204');
      c.fillStyle = gr; c.fillRect(0, 0, w, h);
      // flame do tampo de maple
      for (let i = 0; i < 90; i++) { c.strokeStyle = `rgba(255,${50 + Math.random() * 40},${50 + Math.random() * 30},${0.02 + Math.random() * 0.035})`; c.lineWidth = 2 + Math.random() * 7; c.beginPath(); const y = Math.random() * h; c.moveTo(0, y); for (let x = 0; x <= w; x += 24) c.lineTo(x, y + Math.sin(x / 30 + i) * 12); c.stroke(); }
    });
    burst.repeat.set(1 / 72, 1 / 58);
    burst.offset.set(0.5 - (X0 + 36) / 72, 0.5);
    const bodyMat = new THREE.MeshStandardMaterial({ map: burst, roughness: 0.36, metalness: 0.05, envMapIntensity: 0.25 });
    g.add(new THREE.Mesh(bodyGeo, bodyMat));
    // friso creme (binding) na borda do tampo
    const bind = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p.x, topY - 0.05, p.y)), true);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(bind, 400, 0.32, 6, true), CREAM));

    // braço (mogno com o mesmo acabamento vermelho do verso)
    const neckGeo = new THREE.BoxGeometry(X0 + 8, 2.4, 2, 40, 1, 1);
    neckGeo.translate((X0 + 8) / 2 - 0.6, -1.8, 0);
    const np = neckGeo.attributes.position;
    for (let i = 0; i < np.count; i++) { const x = np.getX(i), y = np.getY(i); const k = y < -2.4 ? 0.8 : 0.98; np.setZ(i, np.getZ(i) * this.halfWidth(Math.max(0, x)) * k); }
    neckGeo.computeVertexNormals();
    g.add(new THREE.Mesh(neckGeo, FINISH));

    // captadores humbucker (capa cobre escuro, moldura preta)
    const humbucker = (cx) => {
      const ring = new THREE.Mesh(new THREE.BoxGeometry(7.0, 0.6, 14.2), BLACK); ring.position.set(cx, topY + 0.25, 0); g.add(ring);
      const cover = new THREE.Mesh(new THREE.BoxGeometry(5.6, 1.1, 12.4), COPPER); cover.position.set(cx, topY + 0.85, 0); g.add(cover);
      for (let st = 1; st <= this.N; st++) {
        const z = this.stringZ(st, cx);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.16, 12), DARKGOLD); pole.position.set(cx - 1.3, topY + 1.45, z); g.add(pole);
        const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.16, 12), DARKGOLD); screw.position.set(cx + 1.3, topY + 1.45, z); g.add(screw);
      }
    };
    humbucker(Math.max(W(0, 382)[0], lastFret + 4.4));
    humbucker(W(0, 562)[0]);
    // ponte tune-o-matic dourada
    const strW = this.halfWidth(L) * 2;
    const brW = strW + 2.6;
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.9, brW), GOLD); bridge.position.set(L + 0.3, 0.0, 0); g.add(bridge);
    for (let st = 1; st <= this.N; st++) { const sd = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.35, 0.6), GOLD); sd.position.set(L + 0.3, 0.42, this.stringZ(st, L)); g.add(sd); }
    [-1, 1].forEach(sg => { const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.5, 20), GOLD); wheel.position.set(L + 0.3, topY + 0.6, sg * (brW / 2 + 0.2)); g.add(wheel);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 2.0, 10), GOLD); post.position.set(L + 0.3, topY + 1.0, sg * (brW / 2 + 0.2)); g.add(post); });
    // cordal (stopbar)
    const tpX = W(0, 690)[0], tpY = topY + 1.0;
    const tail = new THREE.Mesh(new THREE.CapsuleGeometry(0.75, strW + 2.2, 6, 16), GOLD); tail.rotation.x = Math.PI / 2; tail.position.set(tpX, tpY, 0); g.add(tail);
    [-1, 1].forEach(sg => { const stud = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.3, 16), GOLD); stud.position.set(tpX, topY + 0.4, sg * (strW / 2 + 1.4)); g.add(stud); });
    const strMat = new THREE.MeshStandardMaterial({ color: '#c9c9cf', metalness: 1, roughness: 0.3 });
    for (let st = 1; st <= this.N; st++) {
      const a = new THREE.Vector3(L + 0.3, 0.55, this.stringZ(st, L)), b = new THREE.Vector3(tpX - 0.3, tpY + 0.55, this.stringZ(st, L) * 0.95);
      g.add(this._segment(a, b, 0.06, strMat));
    }
    // knobs dourados: 3 no lado agudo e 1 no lado grave, chave seletora no ombro (como na foto)
    const knob = (px, py) => {
      const k = new THREE.Group();
      const skirt = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.55, 0.35, 28), GOLD); skirt.position.y = 0.18; k.add(skirt);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.15, 1.25, 28), new THREE.MeshStandardMaterial({ color: '#b8862e', metalness: 0.75, roughness: 0.28 })); cap.position.y = 0.95; k.add(cap);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.95, 0.3, 28), GOLD); top.position.y = 1.7; k.add(top);
      const [x, z] = W(px, py); k.position.set(x, topY, z); g.add(k);
    };
    knob(455, 627); knob(482, 697); knob(455, 770); knob(158, 312);
    const sw = new THREE.Group();
    const swRing = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.2, 28), BLACK); swRing.position.y = 0.1; sw.add(swRing);
    const swNut = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.5, 6), GOLD); swNut.position.y = 0.45; sw.add(swNut);
    const lever = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 2.4, 8), GOLD); lever.position.set(-0.3, 1.5, 0); lever.rotation.z = 0.3; sw.add(lever);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 12), BLACK); tip.position.set(-0.65, 2.7, 0); sw.add(tip);
    const [swx, swz] = W(178, 240); sw.position.set(swx + 0.6, topY, swz); g.add(sw);

    // trastes (22) e marcações trapezoidais
    const fretMat = new THREE.MeshStandardMaterial({ color: '#d8d8de', metalness: 1.0, roughness: 0.22 });
    for (let n = 1; n <= FRETS; n++) {
      const x = fretX(n);
      const f = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, this.halfWidth(x) * 2 - 0.1, 8), fretMat);
      f.rotation.x = Math.PI / 2; f.position.set(x, 0.02, 0); g.add(f);
      if (MARKS.includes(n)) {
        const lab = textSprite(String(n), n === 12 ? '#f2a33a' : '#cfc8dc', 1.9);
        lab.position.set((fretX(n - 1) + x) / 2, 0.3, bass * (this.halfWidth(x) + 1.3)); g.add(lab);
      }
    }
    const inlayMat = new THREE.MeshStandardMaterial({ color: '#8a8170', roughness: 0.45, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
    MARKS.forEach(n => {
      const x1 = fretX(n - 1), x2 = fretX(n), sp = x2 - x1, xm = (x1 + x2) / 2, hw = this.halfWidth(xm);
      const a = sp * 0.22, wNut = hw * 0.6, wBody = hw * 0.78;
      const tr = new THREE.Shape();
      tr.moveTo(xm - a, -wNut); tr.lineTo(xm + a, -wBody); tr.lineTo(xm + a, wBody); tr.lineTo(xm - a, wNut); tr.closePath();
      const geo = new THREE.ShapeGeometry(tr); geo.rotateX(Math.PI / 2);
      const m = new THREE.Mesh(geo, inlayMat); m.position.y = 0.012; g.add(m);
    });
    // pestana
    const nut = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, this.halfWidth(0) * 2), new THREE.MeshStandardMaterial({ color: '#e8dcc0', roughness: 0.4 }));
    nut.position.set(-0.3, 0.1, 0); g.add(nut);

    // cabeça (frente preta, verso vermelho), inclinada 14°: lados côncavos e topo "livro aberto"
    const hs = new THREE.Group(); hs.position.set(-0.6, -0.35, 0); hs.rotation.z = THREE.MathUtils.degToRad(14);
    const hw0 = this.halfWidth(0) - 0.15;
    const side = [[0, hw0], [-5, hw0 + 0.25], [-11, hw0 + 1.3], [-17, hw0 + 2.9], [-23, hw0 + 4.4], [-26.6, hw0 + 4.9], [-28.4, hw0 + 3.6], [-28.0, 2.4], [-27.0, 0]];
    const half = side.map(([u, v]) => new THREE.Vector2(u, v));
    const outline = half.concat(half.slice(0, -1).reverse().map(p => new THREE.Vector2(p.x, -p.y)));
    const hsCurve = new THREE.SplineCurve(outline); hsCurve.closed = true;
    const hsPts = hsCurve.getSpacedPoints(120);
    const hsShape = new THREE.Shape(hsPts);
    const hsGeo = new THREE.ExtrudeGeometry(hsShape, { depth: 1.2, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.2, bevelSegments: 2, curveSegments: 4 });
    hsGeo.rotateX(Math.PI / 2); hsGeo.translate(0, 0.2, 0);
    hs.add(new THREE.Mesh(hsGeo, FINISH));
    const face = new THREE.ShapeGeometry(hsShape); face.rotateX(Math.PI / 2);
    const faceMesh = new THREE.Mesh(face, new THREE.MeshStandardMaterial({ color: '#09080a', roughness: 0.2, side: THREE.DoubleSide })); faceMesh.position.y = 0.42; hs.add(faceMesh);
    // tampa do tensor (sino preto com friso)
    const trc = new THREE.Shape(); trc.moveTo(-1.2, 0); trc.quadraticCurveTo(-1.6, 1.1, -3.6, 1.0); trc.quadraticCurveTo(-4.6, 0, -3.6, -1.0); trc.quadraticCurveTo(-1.6, -1.1, -1.2, 0);
    const trcG = new THREE.ShapeGeometry(trc); trcG.rotateX(Math.PI / 2);
    const trcM = new THREE.Mesh(trcG, new THREE.MeshStandardMaterial({ color: '#1a1a1d', roughness: 0.35, side: THREE.DoubleSide })); trcM.position.y = 0.45; hs.add(trcM);
    const posts = [];
    [-9.5, -15.5, -21.5].forEach((u, i) => {
      [-1, 1].forEach(sg => {
        const vEdge = hw0 + [1.6, 2.9, 4.2][i];
        const v = sg * (vEdge - 1.5);
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 1.4, 14), GOLD); post.position.set(u, 1.1, v); hs.add(post);
        const bush = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.12, 16), GOLD); bush.position.set(u, 0.48, v); hs.add(bush);
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 2.6, 8), GOLD); shaft.rotation.x = Math.PI / 2; shaft.position.set(u, -0.5, sg * (vEdge + 1.0)); hs.add(shaft);
        const btn = new THREE.Mesh(new THREE.SphereGeometry(0.9, 18, 12), new THREE.MeshStandardMaterial({ color: '#141316', metalness: 0.6, roughness: 0.3 }));
        btn.scale.set(0.95, 0.38, 1.15); btn.position.set(u, -0.5, sg * (vEdge + 2.5)); hs.add(btn);
        posts.push({ u, v });
      });
    });
    g.add(hs);
    hs.updateMatrixWorld(true);
    for (let st = 1; st <= this.N; st++) {
      const z0 = this.stringZ(st, 0);
      const onBass = st <= Math.ceil(this.N / 2);
      const i = onBass ? st - 1 : this.N - st;
      const pool = posts.filter(q => (q.v * bass > 0) === onBass).sort((p1, p2) => p2.u - p1.u);
      const p = pool[Math.min(pool.length - 1, i)];
      const wp = new THREE.Vector3(p.u, 1.7, p.v).applyMatrix4(hs.matrixWorld);
      g.add(this._segment(new THREE.Vector3(0, 0.55, z0), wp, 0.05, strMat));
    }
    // nomes das cordas soltas
    for (let st = 1; st <= this.N; st++) {
      const m = this.tuning[this.N - st];
      const name = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][m % 12];
      const lab = textSprite(name, STRING_COLORS[(this.N - st) % STRING_COLORS.length], 1.5);
      lab.position.set(-2.4, 1.2, this.stringZ(st, 0)); g.add(lab);
    }
  }
  /** guitarra a partir do modelo 3D (Les Paul real) + marcações e números do app */
  _buildFromModel() {
    const g = this.static;
    const bass = this.flip ? -1 : 1;
    const inst = this.model.clone();
    inst.traverse(o => { if (o.isMesh) o.userData.shared = true; });
    inst.scale.z = bass * (this.N >= 7 ? 1.25 : 1);     // canhoto espelha; 7 cordas alarga um pouco o braço
    inst.userData.noMerge = true;
    g.add(inst);
    const by = this.model.userData.boardY || 0;
    // marcações trapezoidais (a Les Paul original não tem no modelo)
    const inlayMat = new THREE.MeshStandardMaterial({ color: '#8a8170', roughness: 0.45, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    MARKS.forEach(n => {
      const x1 = fretX(n - 1), x2 = fretX(n), sp = x2 - x1, xm = (x1 + x2) / 2, hw = this.halfWidth(xm);
      const a = sp * 0.22, wNut = hw * 0.6, wBody = hw * 0.78;
      const tr = new THREE.Shape();
      tr.moveTo(xm - a, -wNut); tr.lineTo(xm + a, -wBody); tr.lineTo(xm + a, wBody); tr.lineTo(xm - a, wNut); tr.closePath();
      const geo = new THREE.ShapeGeometry(tr); geo.rotateX(Math.PI / 2);
      const m = new THREE.Mesh(geo, inlayMat); m.position.y = by + 0.03; g.add(m);
      const lab = textSprite(String(n), n === 12 ? '#f2a33a' : '#cfc8dc', 1.9);
      lab.position.set(xm, 0.3, bass * (this.halfWidth(x2) + 1.3)); g.add(lab);
    });
    for (let st = 1; st <= this.N; st++) {
      const m = this.tuning[this.N - st];
      const name = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][m % 12];
      const lab = textSprite(name, STRING_COLORS[(this.N - st) % STRING_COLORS.length], 1.5);
      lab.position.set(-2.4, 1.2, this.stringZ(st, 0)); g.add(lab);
    }
    this.pickPlane = inst;
  }
  /** junta as peças fixas por material: poucas chamadas de desenho = 3D leve no celular */
  _mergeStatic() {
    const g = this.static; g.updateMatrixWorld(true);
    const byMat = new Map(), keep = [];
    const models = g.children.filter(o => o.userData.noMerge);
    g.traverse(o => {
      if (!o.isMesh) return;
      let p = o; while (p && p !== g) { if (p.userData.noMerge) return; p = p.parent; }
      if (o.material.map) { keep.push(o); return; }
      const key = o.material.uuid;
      if (!byMat.has(key)) byMat.set(key, { mat: o.material, geos: [] });
      let geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
      geo = geo.index ? geo.toNonIndexed() : geo;
      for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name);
      if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
      byMat.get(key).geos.push(geo);
    });
    const sprites = []; g.traverse(o => { if (o.isSprite) sprites.push(o); });
    const merged = [];
    for (const { mat, geos } of byMat.values()) { const m = mergeGeometries(geos, false); if (m) merged.push(new THREE.Mesh(m, mat)); }
    keep.forEach(o => { o.updateMatrixWorld(true); const geo = o.geometry.clone().applyMatrix4(o.matrixWorld); merged.push(new THREE.Mesh(geo, o.material)); });
    const pick = this.pickPlane;
    sprites.forEach(sp => { sp.updateMatrixWorld(true); sp.getWorldPosition(sp.position); });
    models.forEach(m => g.remove(m));
    this._clearGroup(g, true);
    models.forEach(m => g.add(m));
    merged.forEach(m => g.add(m)); sprites.forEach(sp => g.add(sp));
    this.pickPlane = pick;
  }
  _segment(a, b, r, mat) {
    const len = a.distanceTo(b);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 6), mat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    return m;
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
          dz = dir * semis * this.spacingAt(fingerX) * 0.35;
        }
        // vibração da corda
        vib = n && !n.dead ? 0.09 * Math.exp(-sinceHit / 1400) * rel : 0;
        phase = 2 * Math.PI * 17 * el / 1000;
      } else if (st.static) {
        level = 0.7; fingerX = fret > 0 ? fretX(fret) - (fretX(fret) - fretX(fret - 1)) * 0.3 : 0;
        if (n && n.bend) { const semis = Math.max(...n.bend.map(b => b.value)) / 2; const towardLow = (this.N - s) < this.N / 2; dz = (towardLow ? -1 : 1) * (this.flip ? -1 : 1) * semis * this.spacingAt(fingerX) * 0.35; }
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
    const dirs = { player: new THREE.Vector3(0, 0.86, 0.5), top: new THREE.Vector3(0, 1, 0.04), full: new THREE.Vector3(0, 0.72, 0.68) };
    const dir = (dirs[this.camPreset] || dirs.player).clone().normalize();
    const full = this.camPreset === 'full';
    this.follow = !full;
    const aspect = this.camera.aspect || 2;
    const wantW = full ? 168 : (aspect < 1.3 ? 30 : 50);
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    // distância que enquadra a largura desejada e também a largura do braço
    const dW = (wantW / 2) / Math.tan(hfov / 2);
    const dH = (this.halfWidth(L) * 2 + 6) / 2 / Math.tan(vfov / 2);
    const d = Math.max(dW, dH);
    this.camOffset = dir.multiplyScalar(d);
    const tx = full ? 59 : (this.focusX != null ? this.focusX : 24);
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
    const animating = this._update(now);
    this._follow();
    this.controls.update();
    if (animating || this.dirty) { this.renderer.render(this.scene, this.camera); this.dirty = false; this._adapt(now); }
    requestAnimationFrame(this._loop);
  }
  dispose() { this.visible = false; this.ro.disconnect(); this.controls.dispose(); this.renderer.dispose(); }
}
