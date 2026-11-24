/* Tab Studio — bateria: peças, mapa General MIDI (canal 10) e montagem do kit.
 * Cada nota de bateria do Guitar Pro aponta para um número padrão (35–81):
 * 36 = bumbo, 38 = caixa, 42 = chimbal fechado etc. A partir dele sabemos a peça,
 * a variação (aro, aberto, cúpula…) e se é tocada com a mão ou com o pé. */
import { HAND_COLORS } from './pianokeys.js';

// mãos = laranja, pés = verde (mesma identidade visual das mãos do teclado)
export const LIMB_COLORS = { hand: HAND_COLORS.R, foot: HAND_COLORS.L };
// nos pratos o laranja some no bronze: a batida das mãos neles fica roxa
export const CYM_HIT = '#b27cf2';
/** cor da batida: pratos tocados com a mão = roxo; tambores = laranja; pés = verde */
export function hitColor(id, limb) { return limb === 'foot' ? LIMB_COLORS.foot : CYMBALS.has(String(id).split(':')[0]) ? CYM_HIT : LIMB_COLORS.hand; }

const RACK = [50, 48, 47, 45];   // tons (agudo → grave)
const FLOOR = [43, 41];          // surdos

/** número GM → { id da peça, variação, membro } */
export function pieceOf(midi) {
  switch (midi) {
    case 35: case 36: return { id: 'kick', v: '', limb: 'foot' };
    case 37: return { id: 'snare', v: 'rim', limb: 'hand' };
    case 38: case 40: return { id: 'snare', v: '', limb: 'hand' };
    case 42: return { id: 'hihat', v: 'closed', limb: 'hand' };
    case 44: return { id: 'hihat', v: 'pedal', limb: 'foot' };
    case 46: return { id: 'hihat', v: 'open', limb: 'hand' };
    case 49: return { id: 'crash1', v: '', limb: 'hand' };
    case 57: return { id: 'crash2', v: '', limb: 'hand' };
    case 51: case 59: return { id: 'ride', v: '', limb: 'hand' };
    case 53: return { id: 'ride', v: 'bell', limb: 'hand' };
    case 52: return { id: 'china', v: '', limb: 'hand' };
    case 55: return { id: 'splash', v: '', limb: 'hand' };
    case 56: return { id: 'cowbell', v: '', limb: 'hand' };
    case 54: return { id: 'tamb', v: '', limb: 'hand' };
  }
  if (RACK.includes(midi) || FLOOR.includes(midi)) return { id: 'tom' + midi, v: '', limb: 'hand' };
  return { id: 'perc', v: '', limb: 'hand' };
}

export const BASE_NAMES = {
  kick: 'Bumbo', snare: 'Caixa', hihat: 'Chimbal', crash1: 'Ataque', crash2: 'Ataque 2', ride: 'Condução',
  china: 'China', splash: 'Splash', cowbell: 'Cowbell', tamb: 'Pandeirola', perc: 'Percussão'
};
export const CYMBALS = new Set(['hihat', 'crash1', 'crash2', 'ride', 'china', 'splash']);

/** Monta o kit só com as peças que a música usa (bateria sob medida).
 * Sem nenhuma nota (trilha vazia), mostra o kit básico: chimbal, caixa, bumbo, 2 tons, surdo, ataque e condução. */
export function buildKit(usedMidis) {
  let used = new Set(usedMidis || []);
  if (!used.size) used = new Set([42, 38, 36, 48, 45, 43, 49, 51]);
  const ids = new Set();
  for (const m of used) ids.add(pieceOf(m).id);
  const rack = RACK.filter(m => used.has(m)).sort((a, b) => b - a);
  const floor = FLOOR.filter(m => used.has(m)).sort((a, b) => b - a);
  const pieces = [];
  const add = (id, name, extra) => pieces.push(Object.assign({ id, name, cymbal: CYMBALS.has(id) }, extra || {}));
  for (const id of ['hihat', 'snare']) if (ids.has(id)) add(id, BASE_NAMES[id]);
  if (ids.has('kick')) add('kick', BASE_NAMES.kick, { foot: true });
  rack.forEach((m, i) => add('tom' + m, rack.length > 1 ? 'Tom ' + (i + 1) : 'Tom', { tom: 'rack', order: i, of: rack.length }));
  floor.forEach((m, i) => add('tom' + m, floor.length > 1 ? 'Surdo ' + (i + 1) : 'Surdo', { tom: 'floor', order: i, of: floor.length }));
  for (const x of ['crash1', 'ride', 'crash2', 'splash', 'china', 'cowbell', 'tamb', 'perc']) if (ids.has(x)) add(x, BASE_NAMES[x]);
  return { pieces, byId: new Map(pieces.map(p => [p.id, p])) };
}

/* Posições na vista de cima (baterista embaixo, plateia em cima).
   As peças são montadas encostadas umas nas outras a partir do bumbo, como um baterista arma o kit:
   caixa e chimbal à esquerda, tons em arco por cima, surdos à direita e os pratos por cima de tudo.
   Peça que a música não usa não entra, e as outras chegam mais perto (sem buracos).
   Quem desenha ajusta a escala para o conjunto ocupar a tela (ver bounds). */
export function layoutTop(kit) {
  const P = new Map(), has = id => kit.byId.has(id);
  const KX = 50, KY = 41, KR = 11;
  if (has('kick')) P.set('kick', { x: KX, y: KY, r: KR });
  const tops = [];   // topo de cada tambor (para os pratos ficarem por cima sem tapar o centro)
  // esquerda
  let left = has('kick') ? KX - KR + 0.5 : KX;
  // peças grandes (enchem a tela); os pratos passam por cima da borda dos tambores, como num kit de verdade
  const SN = 8, HH = 9.4;
  if (has('snare')) { const x = left - SN - 0.3; P.set('snare', { x, y: 46, r: SN }); left = x - SN; tops.push(46 - SN); }
  let hhTop = null;
  if (has('hihat')) { const x = left - HH + 2; P.set('hihat', { x, y: 41, r: HH }); left = x - HH; hhTop = 41 - HH; }
  // direita
  let right = has('kick') ? KX + KR - 0.5 : KX, firstFloorRight = null, floorTop = null;
  kit.pieces.filter(p => p.tom === 'floor').forEach((p, i) => {
    const r = 9 + i * 0.4, x = right + r + (i ? 0.4 : -0.3), y = 47 + i * 5;
    P.set(p.id, { x, y, r }); right = x + r; tops.push(y - r);
    if (i === 0) { firstFloorRight = right; floorTop = y - r; }
  });
  // tons por cima do bumbo
  const rack = kit.pieces.filter(p => p.tom === 'rack'), n = rack.length;
  rack.forEach((p, i) => {
    const r = 6.8 + i * 0.35, x = KX + (i - (n - 1) / 2) * 14.4, y = 25 - (n > 2 ? Math.sin((i + 0.5) / n * Math.PI) * 2.5 : 0);
    P.set(p.id, { x, y, r }); tops.push(y - r);
  });
  if (has('kick')) tops.push(KY - KR * 0.625);
  const top = tops.length ? Math.min(...tops) : 30;
  const leftTop = Math.min(hhTop == null ? 99 : hhTop, has('snare') ? 46 - SN : 99);
  // pratos
  const c1 = { x: left + 11, y: Math.min(top - 1, leftTop - 6), r: 11.5 };
  if (has('crash1')) P.set('crash1', c1);
  // condução à direita do surdo, sem tapar o último tom
  const lastRack = rack.length ? P.get(rack[rack.length - 1].id) : null;
  const rideX = Math.max((firstFloorRight != null ? firstFloorRight : right) + 11, lastRack ? lastRack.x + lastRack.r + 7 : -99);
  const ride = { x: rideX, y: Math.min(top + 6, floorTop != null ? floorTop - 4 : 99), r: 12.5 };
  if (has('ride')) P.set('ride', ride);
  if (has('crash2')) P.set('crash2', { x: rideX - 12, y: top - 9, r: 10 });
  if (has('splash')) P.set('splash', { x: c1.x + 15, y: top - 8.5, r: 7 });
  if (has('china')) P.set('china', { x: rideX + 7, y: top - 9, r: 9 });
  uncover(P);
  // percussão
  if (has('cowbell')) P.set('cowbell', { x: KX + 12, y: KY - 7.5, r: 3.2 });
  if (has('tamb')) P.set('tamb', { x: left - 3.5, y: top + 5.5, r: 4.5 });
  if (has('perc')) P.set('perc', { x: left - 3.5, y: 55, r: 4.5 });
  // banco do baterista, atrás do bumbo
  P.set('_bench', { x: has('kick') ? KX : (left + right) / 2, y: 66, r: 4.6 });
  return P;
}

/* prato nunca tapa o centro de um tambor (é onde aparece a batida): se tapar, sobe um pouco */
function uncover(P) {
  const drums = [...P].filter(([id]) => !CYMBALS.has(id) && id !== '_bench');
  const hh = P.get('hihat');
  for (const [id, c] of P) {
    if (!CYMBALS.has(id) || id === 'hihat') continue;
    const under = hh ? drums.concat([['hihat', hh]]) : drums;
    for (let k = 0; k < 40; k++) {
      const bad = under.some(([did, d]) => Math.hypot(c.x - d.x, c.y - d.y) < c.r + (did === 'kick' ? 2 : d.r * 0.55));
      if (!bad) break;
      c.y -= 0.6;
    }
  }
}

/** caixa que envolve tudo (com pedais, banco e nomes), para ajustar a escala.
 *  items: centro e quanto cada peça ocupa para cada lado (em unidades do tamanho das peças) */
export function boundsOf(P) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const items = [];
  for (const [id, q] of P) {
    let t = q.r, b = q.r;
    if (id === 'kick') { t = q.r * 0.625; b = q.r * 0.625 + 9; }
    else if (id === 'hihat') b = q.r + 9;
    if (id === 'kick' || id === 'hihat') b += 4;   // nome embaixo do pedal (visão com nomes)
    else if (id !== '_bench') b += 3.2;
    else if (id === 'cowbell' || id === 'tamb' || id === 'perc') b += 4;
    t += 1.2; b += 1.2; const h = q.r + 1.2;
    items.push({ x: q.x, y: q.y, h, t, b });
    x0 = Math.min(x0, q.x - h); x1 = Math.max(x1, q.x + h); y0 = Math.min(y0, q.y - t); y1 = Math.max(y1, q.y + b);
  }
  if (!isFinite(x0)) return { x0: 0, y0: 0, x1: 100, y1: 62, items };
  return { x0, y0, x1, y1, items };
}

/** Faixas das pistas (esquerda → direita); o bumbo vira uma barra larga atravessando todas. */
export function laneOrder(kit) {
  const order = ['hihat', 'snare'].filter(id => kit.byId.has(id));
  for (const p of kit.pieces) if (p.tom === 'rack') order.push(p.id);
  for (const p of kit.pieces) if (p.tom === 'floor') order.push(p.id);
  for (const id of ['crash1', 'splash', 'crash2', 'china', 'ride', 'cowbell', 'tamb', 'perc']) if (kit.byId.has(id)) order.push(id);
  return order;
}

/** força da batida 0..1 (dinâmica do Guitar Pro, ghost note e acento) */
export function velocityOf(n) {
  let v = 0.42 + (n.dyn == null ? 5 : n.dyn) * 0.075; // ppp=0 … fff=7
  if (n.ghost) v *= 0.45;
  if (n.accent) v = Math.min(1, v + (n.accent > 1 ? 0.3 : 0.18));
  return Math.max(0.15, Math.min(1, v));
}
