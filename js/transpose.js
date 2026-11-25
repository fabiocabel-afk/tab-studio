/* Tab Studio — mudança de tom do conjunto (todos os instrumentos juntos).
 * Instrumentos de corda podem tocar o tom novo de 3 jeitos:
 *   capo   — capotraste (a tablatura fica igual; só sobe, até a casa CAPO_MAX)
 *   tuning — afinação das cordas (a tablatura fica igual; até TUNE_UP acima e TUNE_DOWN abaixo)
 *   shape  — mesmo instrumento e afinação, casas recalculadas (nota que não cabe muda de corda)
 *   auto   — subir: capotraste; descer: afinação; fora do limite: desenho
 * Teclado e outros: as notas são transpostas. Bateria: não muda.
 * Limites pensados para não arrebentar corda nem deixar a corda frouxa demais. */
(function (root) {
  'use strict';
  const CAPO_MAX = 7, TUNE_UP = 1, TUNE_DOWN = 5, MAX_FRET = 24, RANGE = 12;
  const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function makeTranspose(at) {
    const isPerc = t => t.staves.some(s => s.isPercussion) || t.playbackInfo.primaryChannel === 9;
    const isStr = t => !isPerc(t) && t.staves.some(s => s.tuning && s.tuning.length > 0);

    function tomText(n) {
      if (!n) return 'tom original';
      const a = Math.abs(n), t = Math.floor(a / 2), half = a % 2;
      const s = (t ? (t === 1 ? '1 tom' : t + ' tons') : '') + (half ? (t ? ' e meio' : 'meio tom') : '');
      return s + (n > 0 ? ' acima' : ' abaixo');
    }
    const tuningNames = tun => tun.slice().reverse().map(m => NOTE[((m % 12) + 12) % 12]).join(' ');

    /* desenho: recalcula as casas de uma pauta (dry = só verifica). Devolve {ok, bar} */
    function shapeStaff(staff, n, dry) {
      const tun = staff.tuning, N = tun.length, base = s => tun[N - s];  // corda 1 = mais grave
      const done = new Map();
      for (const bar of staff.bars) for (const v of bar.voices) for (const beat of v.beats) {
        if (!beat.notes.length) continue;
        const used = new Set(), plan = [], later = [];
        for (const note of beat.notes) {
          if (note.isTieDestination && note.tieOrigin && done.has(note.tieOrigin)) { const o = done.get(note.tieOrigin); plan.push([note, o.s, o.f]); used.add(o.s); continue; }
          const f = note.fret + n;
          if (f >= 0 && f <= MAX_FRET && !used.has(note.string)) { plan.push([note, note.string, f]); used.add(note.string); }
          else later.push(note);
        }
        for (const note of later) {
          const pitch = base(note.string) + note.fret + n;
          let best = null;
          for (let s = 1; s <= N; s++) {
            if (used.has(s)) continue;
            const f = pitch - base(s);
            if (f < 0 || f > MAX_FRET) continue;
            const cost = Math.abs(f - note.fret) + Math.abs(s - note.string) * 0.5;
            if (!best || cost < best.cost) best = { s, f, cost };
          }
          if (!best) return { ok: false, bar: bar.index };
          plan.push([note, best.s, best.f]); used.add(best.s);
        }
        for (const [note, s, f] of plan) {
          done.set(note, { s, f });
          if (!dry) { note.string = s; note.fret = f; }
        }
      }
      return { ok: true };
    }

    /* o que cada trilha de cordas consegue fazer com n meios tons */
    function trackOptions(track, n) {
      const tab = track.staves.filter(s => s.tuning && s.tuning.length);
      const capo = Math.max(...tab.map(s => s.capo || 0));
      const o = {};
      o.capo = n === 0 ? { ok: true } : (capo + n < 0 ? { ok: false, why: 'capotraste não desce o tom' } : capo + n > CAPO_MAX ? { ok: false, why: 'capotraste passaria da casa ' + CAPO_MAX } : { ok: true, capo: capo + n });
      o.tuning = n === 0 ? { ok: true } : (n > TUNE_UP ? { ok: false, why: 'afinar mais de meio tom acima pode arrebentar as cordas' } : n < -TUNE_DOWN ? { ok: false, why: 'mais de 2 tons e meio abaixo deixa as cordas frouxas demais' } : { ok: true });
      if (n === 0) o.shape = { ok: true };
      else {
        o.shape = { ok: true };
        for (const st of tab) { const r = shapeStaff(st, n, true); if (!r.ok) { o.shape = { ok: false, why: 'há notas que não cabem no braço (compasso ' + (r.bar + 1) + ')' }; break; } }
      }
      const pick = n > 0 ? ['capo', 'shape', 'tuning'] : ['tuning', 'capo', 'shape'];
      const a = n === 0 ? 'none' : pick.find(m => o[m].ok);
      o.auto = a ? { ok: true, uses: a } : { ok: false, why: 'nenhum jeito de tocar esse tom' };
      return o;
    }

    /** análise do conjunto: quais modos estão disponíveis e o que cada trilha vai fazer */
    // skip: conjunto de índices de trilhas que NÃO mudam (o usuário desmarcou)
    function analyze(score, n, mode, skip) {
      skip = skip || new Set();
      const tracks = score.tracks.map((t, i) => ({ i, t, kind: isPerc(t) ? 'perc' : skip.has(i) ? 'off' : isStr(t) ? 'str' : 'mel' }));
      const strs = tracks.filter(x => x.kind === 'str');
      const modes = {};
      for (const m of ['auto', 'capo', 'tuning', 'shape']) {
        const bad = strs.map(x => ({ x, r: trackOptions(x.t, n)[m] })).filter(y => !y.r.ok);
        modes[m] = bad.length ? { ok: false, why: bad[0].r.why + (strs.length > 1 ? ' (' + (bad[0].x.t.name || 'trilha ' + (bad[0].x.i + 1)) + ')' : '') } : { ok: true };
      }
      if (Math.abs(n) > RANGE) for (const m in modes) modes[m] = { ok: false, why: 'até ' + (RANGE / 2) + ' tons' };
      const plan = tracks.map(x => {
        if (x.kind !== 'str') return { i: x.i, kind: x.kind, name: x.t.name };
        const o = trackOptions(x.t, n), use = mode === 'auto' ? o.auto.uses : mode;
        const tab = x.t.staves.find(s => s.tuning && s.tuning.length);
        const r = { i: x.i, kind: 'str', name: x.t.name, use, ok: mode === 'auto' ? o.auto.ok : o[mode].ok };
        if (use === 'capo') r.capo = o.capo.capo;
        if (use === 'tuning') r.tuning = tab.tuning.map(m => m + n);
        return r;
      });
      return { n, mode, modes, plan, hasStr: strs.length > 0 };
    }

    /** aplica na partitura (muda a música). Devolve a análise usada. */
    function apply(score, n, mode, skip) {
      const a = analyze(score, n, mode, skip);
      if (!n) return a;
      if (!a.modes[mode].ok) throw new Error(a.modes[mode].why);
      for (const p of a.plan) {
        const t = score.tracks[p.i];
        if (p.kind === 'perc' || p.kind === 'off') continue;
        for (const st of t.staves) {
          if (p.kind === 'str' && st.tuning && st.tuning.length) {
            if (p.use === 'capo') st.capo = (st.capo || 0) + n;
            else if (p.use === 'tuning') { st.stringTuning.tunings = st.tuning.map(m => m + n); st.stringTuning.name = ''; }
            else if (p.use === 'shape') shapeStaff(st, n, false);
          } else {
            // teclado e outros: cada nota sobe/desce n meios tons
            for (const bar of st.bars) for (const v of bar.voices) for (const beat of v.beats) for (const note of beat.notes) {
              if (note.isPiano || (!note.isStringed && !note.isPercussion)) {
                const val = Math.max(0, Math.min(127, note.octave * 12 + note.tone + n));
                note.octave = Math.floor(val / 12); note.tone = val % 12;
              }
            }
          }
        }
      }
      // armadura de clave no tom novo (o menor número de sustenidos/bemóis).
      // Lê tudo antes e grava depois: em algumas versões o compasso repassa a armadura do "compasso mestre",
      // e mudar um por um somaria várias vezes.
      const keys = [];
      for (const p of a.plan) if (p.kind === 'str' || p.kind === 'mel') for (const st of score.tracks[p.i].staves) for (const bar of st.bars) if (typeof bar.keySignature === 'number') keys.push([bar, bar.keySignature]);
      // armadura geral só muda quando todos mudam (corrigir uma trilha não muda o tom da música)
      if (!a.plan.some(p => p.kind === 'off')) for (const mb of score.masterBars) if (typeof mb.keySignature === 'number') keys.push([mb, mb.keySignature]);
      for (const [o, k] of keys) o.keySignature = shiftKey(k, n);
      return a;
    }
    // armadura: -7..7 (bemóis/sustenidos). Subir meio tom = +7 no ciclo de quintas
    function shiftKey(k, n) {
      let v = ((k + 7 * n) % 12 + 12) % 12;   // 0..11
      if (v > 6) v -= 12;                       // -5..6 (prefere menos acidentes)
      return v;
    }

    function describe(a) {
      const out = [];
      for (const p of a.plan) {
        if (p.kind === 'perc') continue;
        const nm = p.name || ('Trilha ' + (p.i + 1));
        if (p.kind === 'off') { out.push({ i: p.i, name: nm, text: 'não muda (desmarcada)', off: true }); continue; }
        if (p.kind === 'mel') out.push({ i: p.i, name: nm, text: a.n ? 'notas transpostas' : 'sem mudança' });
        else if (!a.n) out.push({ i: p.i, name: nm, text: 'sem mudança' });
        else if (!p.ok) out.push({ i: p.i, name: nm, text: 'não dá para tocar nesse tom', bad: true });
        else if (p.use === 'capo') out.push({ i: p.i, name: nm, text: p.capo ? 'capotraste na casa ' + p.capo : 'sem capotraste' });
        else if (p.use === 'tuning') out.push({ i: p.i, name: nm, text: 'afinar ' + tomText(a.n) + ': ' + tuningNames(p.tuning) });
        else if (p.use === 'shape') out.push({ i: p.i, name: nm, text: 'mesma afinação, casas redesenhadas' });
      }
      return out;
    }
    // texto curto para nome de arquivo: "+1 tom", "-meio tom", "+1,5 tom", "-2 tons"
    function tomShort(n) {
      if (!n) return '';
      const a = Math.abs(n), sign = n > 0 ? '+' : '-';
      if (a === 1) return sign + 'meio tom';
      const t = a / 2;
      return sign + String(t).replace('.', ',') + (t >= 2 ? ' tons' : ' tom');
    }
    return { analyze, apply, describe, tomText, tomShort, tuningNames, shiftKey, LIMITS: { CAPO_MAX, TUNE_UP, TUNE_DOWN, MAX_FRET, RANGE } };
  }
  root.makeTranspose = makeTranspose;
  if (typeof module !== 'undefined' && module.exports) module.exports = makeTranspose;
})(typeof window !== 'undefined' ? window : globalThis);
