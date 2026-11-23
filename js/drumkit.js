/* Tab Studio — bateria: peças, mapa General MIDI (canal 10) e montagem do kit.
 * Cada nota de bateria do Guitar Pro aponta para um número padrão (35–81):
 * 36 = bumbo, 38 = caixa, 42 = chimbal fechado etc. A partir dele sabemos a peça,
 * a variação (aro, aberto, cúpula…) e se é tocada com a mão ou com o pé. */
import { HAND_COLORS } from './pianokeys.js';

// mãos = laranja, pés = verde (mesma identidade visual das mãos do teclado)
export const LIMB_COLORS = { hand: HAND_COLORS.R, foot: HAND_COLORS.L };

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

const BASE_NAMES = {
  kick: 'Bumbo', snare: 'Caixa', hihat: 'Chimbal', crash1: 'Ataque', crash2: 'Ataque 2', ride: 'Condução',
  china: 'China', splash: 'Splash', cowbell: 'Cowbell', tamb: 'Pandeirola', perc: 'Percussão'
};
export const CYMBALS = new Set(['hihat', 'crash1', 'crash2', 'ride', 'china', 'splash']);

/** Monta o kit a partir das notas usadas na trilha.
 * Base: chimbal, caixa, bumbo, 2 tons, surdo, ataque e condução.
 * Peças extras (ataque 2, china, splash, mais tons…) só entram se a música usar. */
export function buildKit(usedMidis) {
  const used = new Set(usedMidis || []);
  const ids = new Set();
  for (const m of used) ids.add(pieceOf(m).id);
  let rack = RACK.filter(m => used.has(m));
  for (const d of [48, 45, 50, 47]) { if (rack.length >= 2) break; if (!rack.includes(d)) rack.push(d); }
  rack.sort((a, b) => b - a);
  let floor = FLOOR.filter(m => used.has(m)); if (!floor.length) floor = [43];
  floor.sort((a, b) => b - a);
  const pieces = [];
  const add = (id, name, extra) => pieces.push(Object.assign({ id, name, cymbal: CYMBALS.has(id) }, extra || {}));
  add('hihat', BASE_NAMES.hihat); add('snare', BASE_NAMES.snare); add('kick', BASE_NAMES.kick, { foot: true });
  rack.forEach((m, i) => add('tom' + m, 'Tom ' + (i + 1), { tom: 'rack', order: i, of: rack.length }));
  floor.forEach((m, i) => add('tom' + m, floor.length > 1 ? 'Surdo ' + (i + 1) : 'Surdo', { tom: 'floor', order: i, of: floor.length }));
  add('crash1', BASE_NAMES.crash1); add('ride', BASE_NAMES.ride);
  for (const x of ['crash2', 'splash', 'china', 'cowbell', 'tamb', 'perc']) if (ids.has(x)) add(x, BASE_NAMES[x]);
  return { pieces, byId: new Map(pieces.map(p => [p.id, p])) };
}

/* Posições na vista de cima (baterista embaixo, plateia em cima), numa área de 100 × 62.
   Pratos ficam por cima dos tambores (como no kit de verdade), mas sem esconder o centro deles. */
export function layoutTop(kit) {
  const P = new Map();
  const put = (id, x, y, r) => { if (kit.byId.has(id)) P.set(id, { x, y, r }); };
  put('kick', 50, 41, 11);
  put('snare', 31, 46, 7);
  put('hihat', 15, 41, 7.4);
  const rack = kit.pieces.filter(p => p.tom === 'rack'), n = rack.length;
  rack.forEach((p, i) => {
    const x = 50 + (i - (n - 1) / 2) * 12.5, y = 26 - (n > 2 ? Math.sin((i + 0.5) / n * Math.PI) * 2.5 : 0);
    P.set(p.id, { x, y, r: 5.8 + i * 0.35 });
  });
  const floor = kit.pieces.filter(p => p.tom === 'floor');
  floor.forEach((p, i) => P.set(p.id, { x: 68 + i * 16, y: 47 + i * 5, r: 7.8 + i * 0.4 }));
  put('crash1', 18, 17, 9);
  put('ride', 87, 25, 10);
  put('crash2', 76, 7.5, 7.5);
  put('splash', 32, 8, 5.5);
  put('china', 93, 8, 7);
  put('cowbell', 62, 33.5, 3.2);
  put('tamb', 5, 25, 4.5);
  put('perc', 5, 55, 4.5);
  return P;
}

/** Faixas das pistas (esquerda → direita); o bumbo vira uma barra larga atravessando todas. */
export function laneOrder(kit) {
  const order = ['hihat', 'snare'];
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
