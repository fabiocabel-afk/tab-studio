/* Tab Studio — acabamento da bateria, o mesmo no 2D e no 3D (para parecer a mesma bateria):
 * pratos de bronze torneados e martelados, peles porosas com marcas de baqueta,
 * casco de laca vinho (combina com a Les Paul) e o nome da peça impresso, em português.
 * Tudo é desenhado por código (sem fotos): fica leve e nítido em qualquer tamanho. */

export const SHELL = { base: '#5a0c12', light: '#9a2630', dark: '#240406' };

// tons de bronze: [centro/cúpula, meio, borda]
const CYM_TONES = {
  crash1: ['#f4d28c', '#d29d49', '#93601f'],
  crash2: ['#f1c67c', '#cb8e40', '#8a561c'],
  splash: ['#f7dc9c', '#d9aa55', '#9c6a24'],
  ride: ['#e6c37c', '#b98a3d', '#6e4a1a'],
  hihat: ['#ecca86', '#c5944b', '#80561f'],
  china: ['#dba566', '#a96d33', '#5d3514']
};
// tamanho relativo da cúpula
const BELL = { crash1: 0.22, crash2: 0.22, splash: 0.25, ride: 0.21, hihat: 0.23, china: 0.17 };

const cache = new Map();
function mk(px) { const c = document.createElement('canvas'); c.width = c.height = px; return c; }
function pow2(px) { return Math.max(64, Math.min(1024, 1 << Math.ceil(Math.log2(Math.max(1, px))))); }
function seed(str) { let h = 2166136261; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(s) { return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function circle(g, x, y, r) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); }

/** texto curvo na parte de baixo do círculo, de pé para quem olha de baixo (o baterista) */
export function arcText(g, text, r, fs, color, mid) {
  if (!text) return;
  mid = mid == null ? Math.PI / 2 : mid;
  g.save();
  g.font = '900 ' + fs + 'px "Arial Narrow", "Roboto Condensed", "Helvetica Neue", system-ui, sans-serif';
  try { g.fontStretch = 'condensed'; } catch (e) { /* sem suporte */ }
  g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
  const sp = fs * 0.1, chars = [...text], ws = chars.map(c => g.measureText(c).width + sp);
  const tot = ws.reduce((a, b) => a + b, 0) - sp;
  let a = mid + tot / 2 / r;
  chars.forEach((c, i) => {
    const w = ws[i], th = a - (w - sp) / 2 / r;
    g.save(); g.translate(Math.cos(th) * r, Math.sin(th) * r); g.rotate(th - Math.PI / 2); g.fillText(c, 0, 0); g.restore();
    a -= w / r;
  });
  g.restore();
}

/** prato visto de cima (textura quadrada, prato ocupando o círculo inteiro) */
export function cymbalCanvas(kind, label, px) {
  px = pow2(px);
  const key = 'c|' + kind + '|' + (label || '') + '|' + px;
  if (cache.has(key)) return cache.get(key);
  const cv = mk(px), g = cv.getContext('2d'), R = px / 2, T = CYM_TONES[kind] || CYM_TONES.crash1, bell = BELL[kind] || 0.22, rnd = rng(seed(kind));
  g.translate(R, R);
  // bronze
  let gr = g.createRadialGradient(0, 0, R * 0.02, 0, 0, R);
  gr.addColorStop(0, T[0]); gr.addColorStop(bell, T[0]); gr.addColorStop(bell + 0.05, T[1]); gr.addColorStop(0.82, T[1]); gr.addColorStop(1, T[2]);
  g.fillStyle = gr; circle(g, 0, 0, R * 0.995); g.fill();
  // torneado: sulcos finos em volta (o que dá aquele brilho em anéis)
  const step = Math.max(0.65, R / 240);
  for (let r = bell * R * 0.92; r < R * 0.985; r += step) {
    const light = rnd() < 0.5;
    g.strokeStyle = light ? 'rgba(255,240,205,' + (0.04 + rnd() * 0.1).toFixed(3) + ')' : 'rgba(58,28,4,' + (0.05 + rnd() * 0.12).toFixed(3) + ')';
    g.lineWidth = Math.max(0.5, R / 320); circle(g, 0, 0, r); g.stroke();
  }
  // martelado: pequenas marcas espalhadas
  const n = Math.round(R * (kind === 'china' ? 1.4 : 2.4));
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, rr = R * (bell + 0.03 + rnd() * (0.93 - bell)), s = R * (0.01 + rnd() * 0.016);
    g.save(); g.translate(Math.cos(a) * rr, Math.sin(a) * rr); g.rotate(a);
    g.fillStyle = 'rgba(70,35,6,' + (0.08 + rnd() * 0.1).toFixed(3) + ')'; g.beginPath(); g.ellipse(0, 0, s * 1.7, s, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,236,190,' + (0.06 + rnd() * 0.08).toFixed(3) + ')'; g.beginPath(); g.ellipse(-s * 0.4, -s * 0.25, s * 0.8, s * 0.45, 0, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  // china: a aba virada na borda é mais escura e lisa
  if (kind === 'china') {
    g.strokeStyle = 'rgba(45,20,4,.38)'; g.lineWidth = R * 0.12; circle(g, 0, 0, R * 0.93); g.stroke();
    g.strokeStyle = 'rgba(255,220,170,.18)'; g.lineWidth = R * 0.01; circle(g, 0, 0, R * 0.87); g.stroke();
  }
  // cúpula: lisa, com um degrau de sombra e luz na volta
  gr = g.createRadialGradient(-R * bell * 0.35, -R * bell * 0.35, 0, 0, 0, R * bell);
  gr.addColorStop(0, 'rgba(255,246,220,.55)'); gr.addColorStop(0.7, 'rgba(255,230,180,.08)'); gr.addColorStop(1, 'rgba(60,30,5,.12)');
  g.fillStyle = gr; circle(g, 0, 0, R * bell); g.fill();
  g.strokeStyle = 'rgba(55,27,4,.4)'; g.lineWidth = R * 0.014; circle(g, 0, 0, R * bell); g.stroke();
  g.strokeStyle = 'rgba(255,238,200,.35)'; g.lineWidth = R * 0.008; circle(g, 0, 0, R * (bell + 0.018)); g.stroke();
  // borda
  g.strokeStyle = 'rgba(45,22,4,.55)'; g.lineWidth = R * 0.014; circle(g, 0, 0, R * 0.985); g.stroke();
  // nome gravado
  if (label) arcText(g, label.toUpperCase(), R * 0.68, R * 0.2, 'rgba(30,12,0,.9)');
  // furo do centro
  g.fillStyle = '#1b140f'; circle(g, 0, 0, R * 0.03); g.fill();
  cache.set(key, cv);
  return cv;
}

/** direção do "torneado" para o reflexo anisotrópico do 3D (RG = direção, B = força) */
export function anisoCanvas(kind, px) {
  px = pow2(px);
  const key = 'a|' + kind + '|' + px;
  if (cache.has(key)) return cache.get(key);
  const cv = mk(px), g = cv.getContext('2d'), img = g.createImageData(px, px), d = img.data, bell = BELL[kind] || 0.22;
  for (let j = 0; j < px; j++) for (let i = 0; i < px; i++) {
    const u = (i + 0.5) / px - 0.5, v = 0.5 - (j + 0.5) / px, len = Math.hypot(u, v) || 1;
    const tx = -v / len, ty = u / len, k = (j * px + i) * 4;
    d[k] = Math.round((tx * 0.5 + 0.5) * 255); d[k + 1] = Math.round((ty * 0.5 + 0.5) * 255);
    d[k + 2] = len * 2 < bell ? 70 : 255; d[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  cache.set(key, cv);
  return cv;
}

/** pele porosa (vista de cima) com a borda que dobra sobre o casco e marcas de baqueta */
export function headCanvas(kind, label, px) {
  px = pow2(px);
  const key = 'h|' + kind + '|' + (label || '') + '|' + px;
  if (cache.has(key)) return cache.get(key);
  const cv = mk(px), g = cv.getContext('2d'), R = px / 2, rnd = rng(seed('head' + kind)), snare = kind === 'snare';
  // base com a textura do revestimento (granulado fino)
  const base = snare ? [246, 242, 232] : [236, 230, 214];
  const img = g.createImageData(px, px), d = img.data;
  for (let k = 0; k < d.length; k += 4) {
    const nz = (rnd() - 0.5) * 14 + (rnd() < 0.02 ? -12 : 0);
    d[k] = base[0] + nz; d[k + 1] = base[1] + nz; d[k + 2] = base[2] + nz * 1.1; d[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  g.translate(R, R);
  // um leve tom amarelado de uso e sombra na borda (a pele dobra sobre o casco)
  let gr = g.createRadialGradient(0, R * 0.08, 0, 0, 0, R);
  gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.8, 'rgba(160,140,100,.06)'); gr.addColorStop(0.9, 'rgba(110,95,70,.22)'); gr.addColorStop(1, 'rgba(60,50,40,.55)');
  g.fillStyle = gr; g.fillRect(-R, -R, px, px);
  g.strokeStyle = 'rgba(90,78,60,.35)'; g.lineWidth = R * 0.008; circle(g, 0, 0, R * 0.885); g.stroke();
  // marcas de baqueta, perto do centro e um pouco para o lado do baterista
  const marks = snare ? 120 : kind === 'kick' ? 50 : 60;
  for (let i = 0; i < marks; i++) {
    const a = rnd() * Math.PI * 2, rr = R * Math.sqrt(rnd()) * (snare ? 0.28 : 0.22), x = Math.cos(a) * rr, y = Math.sin(a) * rr + R * 0.08, s = R * (0.006 + rnd() * 0.014);
    g.fillStyle = 'rgba(70,64,58,' + (0.05 + rnd() * 0.1).toFixed(3) + ')';
    g.beginPath(); g.ellipse(x, y, s * 1.6, s, rnd() * Math.PI, 0, Math.PI * 2); g.fill();
  }
  // nome impresso
  if (label) arcText(g, label.toUpperCase(), R * 0.64, R * 0.25, 'rgba(22,16,14,.92)');
  cache.set(key, cv);
  return cv;
}

/** tapete: tecido escuro com borda, igual no 2D e no 3D */
export function rugCanvas(px) {
  px = pow2(px);
  const key = 'r|' + px;
  if (cache.has(key)) return cache.get(key);
  const cv = mk(px), g = cv.getContext('2d'), R = px / 2, rnd = rng(seed('rug'));
  const img = g.createImageData(px, px), d = img.data;
  for (let j = 0; j < px; j++) for (let i = 0; i < px; i++) {
    const k = (j * px + i) * 4, weave = ((i + j) % 4 < 2 ? 4 : -4), nz = (rnd() - 0.5) * 10 + weave;
    d[k] = 30 + nz; d[k + 1] = 24 + nz; d[k + 2] = 38 + nz; d[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  g.translate(R, R);
  const gr = g.createRadialGradient(0, 0, R * 0.3, 0, 0, R);
  gr.addColorStop(0, 'rgba(255,255,255,.04)'); gr.addColorStop(1, 'rgba(0,0,0,.35)');
  g.fillStyle = gr; g.fillRect(-R, -R, px, px);
  g.strokeStyle = 'rgba(100,42,144,.55)'; g.lineWidth = R * 0.025; circle(g, 0, 0, R * 0.95); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,.06)'; g.lineWidth = R * 0.006; circle(g, 0, 0, R * 0.92); g.stroke();
  cache.set(key, cv);
  return cv;
}

/** fundo do palco: preto com frisos diagonais (padrão repetido) */
export function stageTile() {
  const key = 'stage';
  if (cache.has(key)) return cache.get(key);
  const cv = mk(16), g = cv.getContext('2d');
  g.fillStyle = '#0c0b10'; g.fillRect(0, 0, 16, 16);
  g.strokeStyle = 'rgba(255,255,255,.035)'; g.lineWidth = 3;
  for (let o = -16; o <= 32; o += 8) { g.beginPath(); g.moveTo(o, 16); g.lineTo(o + 16, 0); g.stroke(); }
  g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 1;
  for (let o = -16; o <= 32; o += 8) { g.beginPath(); g.moveTo(o + 2.5, 16); g.lineTo(o + 18.5, 0); g.stroke(); }
  cache.set(key, cv);
  return cv;
}
