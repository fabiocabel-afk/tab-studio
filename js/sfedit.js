/* Tab Studio — ajuste do timbre por grupo de instrumento, direto no banco de sons (SF2/SF3).
   O tocador mistura tudo antes de sair; por isso o ajuste por instrumento é feito nas "regiões" de cada
   instrumento do banco, antes de carregá-lo:
   - agudos mais suaves = filtro passa-baixa (initialFilterFc, gerador 8), só abaixa, nunca aumenta;
   - bumbo mais leve    = atenuação (initialAttenuation, gerador 48) nas notas 35 e 36 dos kits de bateria;
   - pratos mais suaves = filtro + um pouco de atenuação nas notas de prato / chimbal.
   Nada muda se todos os valores forem 0 (devolve o próprio arquivo). */
(function (root) {
  'use strict';
  const FC = 8, ATT = 48, KEYS = 43, INSTR = 41, SAMPLE = 53;
  const GROUPS = {
    dist: p => p >= 29 && p <= 31,
    clean: p => p >= 24 && p <= 28,
    bass: p => p >= 32 && p <= 39,
    keys: p => p <= 23 || (p >= 40 && p <= 103)
  };
  const KICK = [35, 36], CYM = [42, 44, 46, 49, 51, 52, 53, 55, 57, 59];
  const cents = hz => Math.round(1200 * Math.log2(hz / 8.176));
  // corte RELATIVO: parte do filtro que o próprio instrumento já tem (ou de "top" Hz, se ele não tem nenhum)
  // e abaixa "oct" oitavas no máximo (100%). Assim funciona igual em bancos que já filtram o som (GeneralUser) e nos que não filtram (Sonivox).
  // a curva começa a agir logo no início da régua (o filtro quase não se ouve nas frequências mais altas)
  const ease = a => 1 - (1 - a) * (1 - a);
  const lower = (eff, a, top, oct) => Math.max(1500, Math.round(Math.min(eff, cents(top)) - ease(a) * oct * 1200));

  function riff(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const id = o => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
    if (id(0) !== 'RIFF' || id(8) !== 'sfbk') throw new Error('não é um banco de sons');
    const lists = {}, pd = {};
    let o = 12;
    while (o + 8 <= u8.length) {
      const cid = id(o), sz = dv.getUint32(o + 4, true);
      if (cid === 'LIST') {
        const lt = id(o + 8); lists[lt] = { start: o, end: o + 8 + sz };
        if (lt === 'pdta') {
          let q = o + 12;
          while (q + 8 <= o + 8 + sz) { const c = id(q), s = dv.getUint32(q + 4, true); pd[c] = { off: q + 8, size: s }; q += 8 + s + (s & 1); }
        }
      }
      o += 8 + sz + (sz & 1);
    }
    return { dv, lists, pd };
  }

  function apply(u8, cfg) {
    cfg = cfg || {};
    const amt = k => Math.max(0, Math.min(100, +cfg[k] || 0)) / 100;
    if (!['dist', 'clean', 'bass', 'keys', 'kick', 'cym'].some(k => amt(k) > 0)) return u8;
    const { dv, lists, pd } = riff(u8);
    const u16 = o => dv.getUint16(o, true), s16 = o => dv.getInt16(o, true);
    // presets → instrumentos (e de que grupo cada instrumento é)
    const nP = pd.phdr.size / 38, nI = pd.inst.size / 22;
    const pbag = i => u16(pd.pbag.off + i * 4), pgenOp = i => u16(pd.pgen.off + i * 4), pgenAmt = i => u16(pd.pgen.off + i * 4 + 2);
    const instGroup = new Map();   // instrumento -> grupo ('drum' ou nome do grupo)
    for (let p = 0; p < nP - 1; p++) {
      const b = pd.phdr.off + p * 38, prog = u16(b + 20), bank = u16(b + 22), b0 = u16(b + 24), b1 = u16(b + 38 + 24);
      let g = null;
      if (bank === 128) g = 'drum';
      else for (const k in GROUPS) if (GROUPS[k](prog)) { g = k; break; }
      if (!g) continue;
      for (let z = b0; z < b1; z++) for (let gi = pbag(z); gi < pbag(z + 1); gi++) if (pgenOp(gi) === INSTR) { const ii = pgenAmt(gi); if (!instGroup.has(ii)) instGroup.set(ii, g); }
    }
    // reescreve ibag/igen com os geradores ajustados
    const ibag = i => u16(pd.ibag.off + i * 4), ibagMod = i => u16(pd.ibag.off + i * 4 + 2);
    const nB = pd.ibag.size / 4, nG = pd.igen.size / 4;
    const igen = i => [u16(pd.igen.off + i * 4), u16(pd.igen.off + i * 4 + 2)];
    const zoneInst = new Int32Array(nB).fill(-1);
    for (let i = 0; i < nI - 1; i++) { const a = u16(pd.inst.off + i * 22 + 20), e = u16(pd.inst.off + (i + 1) * 22 + 20); for (let z = a; z < e; z++) zoneInst[z] = i; }
    const firstZone = new Map(); for (let i = 0; i < nI - 1; i++) firstZone.set(i, u16(pd.inst.off + i * 22 + 20));
    const out = []; const newBag = new Uint16Array(nB * 2);
    const gget = (list, op) => { const g = list.find(x => x[0] === op); return g ? g[1] : null; };
    const asS16 = v => (v << 16) >> 16;
    for (let z = 0; z < nB; z++) {
      newBag[z * 2] = out.length; newBag[z * 2 + 1] = ibagMod(z);
      const list = [];
      if (z < nB - 1) for (let gi = ibag(z); gi < ibag(z + 1); gi++) list.push(igen(gi));
      const inst = zoneInst[z], grp = inst >= 0 ? instGroup.get(inst) : null;
      const isLocal = list.length && list[list.length - 1][0] === SAMPLE;
      if (grp && isLocal) {
        // valor efetivo = o da zona, senão o da zona global do instrumento, senão o padrão
        const fz = firstZone.get(inst); let glob = [];
        if (fz !== z) { const gl = []; for (let gi = ibag(fz); gi < ibag(fz + 1); gi++) gl.push(igen(gi)); if (!gl.length || gl[gl.length - 1][0] !== SAMPLE) glob = gl; }
        const eff = (op, def) => { const v = gget(list, op); if (v !== null) return asS16(v); const g = gget(glob, op); return g !== null ? asS16(g) : def; };
        const set = (op, val) => { const v = val & 0xffff, i = list.findIndex(x => x[0] === op); if (i >= 0) list[i][1] = v; else list.splice(list.length - 1, 0, [op, v]); };
        const kr = gget(list, KEYS), lo = kr === null ? 0 : kr & 255, hi = kr === null ? 127 : kr >> 8;
        const narrow = hi - lo <= 4, hits = keys => keys.some(k => k >= lo && k <= hi);
        if (grp === 'drum') {
          if (amt('kick') > 0 && narrow && hits(KICK)) set(ATT, Math.min(1440, eff(ATT, 0) + Math.round(amt('kick') * 150)));
          if (amt('cym') > 0 && narrow && hits(CYM)) {
            set(FC, lower(eff(FC, 13500), amt('cym'), 14000, 2.5));
            set(ATT, Math.min(1440, eff(ATT, 0) + Math.round(amt('cym') * 40)));
          }
        } else if (amt(grp) > 0) {
          // baixo: no máximo 1,5 oitava (mais que isso ele some, principalmente no alto-falante do celular)
          set(FC, lower(eff(FC, 13500), amt(grp), grp === 'bass' ? 6000 : 9000, grp === 'bass' ? 1.5 : 3));
        }
      }
      out.push(...list);
    }
    out.push([0, 0]);   // registro final do igen
    if (out.length > 65535) throw new Error('banco de sons grande demais para ajustar');
    // monta o arquivo de novo: INFO e sdta iguais; pdta com ibag/igen novos
    const ck = (cid, data) => { const pad = data.length & 1; const b = new Uint8Array(8 + data.length + pad); for (let i = 0; i < 4; i++) b[i] = cid.charCodeAt(i); new DataView(b.buffer).setUint32(4, data.length, true); b.set(data, 8); return b; };
    const ibagBytes = new Uint8Array(nB * 4); { const d = new DataView(ibagBytes.buffer); for (let z = 0; z < nB; z++) { d.setUint16(z * 4, newBag[z * 2], true); d.setUint16(z * 4 + 2, newBag[z * 2 + 1], true); } }
    const igenBytes = new Uint8Array(out.length * 4); { const d = new DataView(igenBytes.buffer); out.forEach((g, i) => { d.setUint16(i * 4, g[0], true); d.setUint16(i * 4 + 2, g[1], true); }); }
    const parts = ['phdr', 'pbag', 'pmod', 'pgen', 'inst', 'ibag', 'imod', 'igen', 'shdr'].map(c =>
      ck(c, c === 'ibag' ? ibagBytes : c === 'igen' ? igenBytes : u8.subarray(pd[c].off, pd[c].off + pd[c].size)));
    const pdLen = 4 + parts.reduce((a, p) => a + p.length, 0);
    const info = u8.subarray(lists.INFO.start, lists.INFO.end), sdta = u8.subarray(lists.sdta.start, lists.sdta.end);
    const total = 12 + info.length + sdta.length + 8 + pdLen;
    const res = new Uint8Array(total), rd = new DataView(res.buffer);
    res.set([82, 73, 70, 70], 0); rd.setUint32(4, total - 8, true); res.set([115, 102, 98, 107], 8);
    let o = 12; res.set(info, o); o += info.length; res.set(sdta, o); o += sdta.length;
    res.set([76, 73, 83, 84], o); rd.setUint32(o + 4, pdLen, true); res.set([112, 100, 116, 97], o + 8); o += 12;
    for (const p of parts) { res.set(p, o); o += p.length; }
    return res;
  }
  root.TabSfEdit = { apply, GROUPS };
})(typeof window !== 'undefined' ? window : globalThis);
