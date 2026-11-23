/* Tab Studio — operações no modelo de partitura (alphaTab).
 * Todas as edições acontecem no modelo e depois passam por normalize()
 * (ida e volta em JSON), que recalcula tempos, ligações e índices. */
(function (root) {
  'use strict';

  function makeTabOps(at) {
    const M = at.model;

    const INSTRUMENTS = {
      'guitar-clean': { name: 'Guitarra limpa', program: 27, tuning: [64, 59, 55, 50, 45, 40] },
      'guitar-dist': { name: 'Guitarra distorcida', program: 30, tuning: [64, 59, 55, 50, 45, 40] },
      'guitar-overdrive': { name: 'Guitarra overdrive', program: 29, tuning: [64, 59, 55, 50, 45, 40] },
      'guitar-steel': { name: 'Violão aço', program: 25, tuning: [64, 59, 55, 50, 45, 40] },
      'guitar-nylon': { name: 'Violão nylon', program: 24, tuning: [64, 59, 55, 50, 45, 40] },
      'guitar7': { name: 'Guitarra 7 cordas', program: 30, tuning: [64, 59, 55, 50, 45, 40, 35] },
      'bass4': { name: 'Baixo 4 cordas', program: 33, tuning: [43, 38, 33, 28] },
      'bass5': { name: 'Baixo 5 cordas', program: 33, tuning: [43, 38, 33, 28, 23] }
    };

    function countNotes(score) {
      let n = 0;
      for (const t of score.tracks) for (const st of t.staves) for (const b of st.bars)
        for (const v of b.voices) for (const bt of v.beats) n += bt.notes.length;
      return n;
    }

    function settingsOrNew(settings) { return settings || new at.Settings(); }

    /** Recalcula o modelo inteiro (ida e volta em JSON). */
    function normalize(score, settings) {
      const js = M.JsonConverter.scoreToJsObject(score);
      return M.JsonConverter.jsObjectToScore(js, settingsOrNew(settings));
    }

    function snapshot(score) { return M.JsonConverter.scoreToJson(score); }
    function restore(json, settings) { return M.JsonConverter.jsonToScore(json, settingsOrNew(settings)); }

    function freeChannels(score) {
      const used = new Set();
      for (const t of score.tracks) { used.add(t.playbackInfo.primaryChannel); used.add(t.playbackInfo.secondaryChannel); }
      const free = [];
      for (let c = 0; c < 16; c++) if (c !== 9 && !used.has(c)) free.push(c);
      return free;
    }

    function restBeatsFor(mb) {
      // preenche o compasso com pausas da unidade do denominador
      const beats = [];
      const num = mb.timeSignatureNumerator, den = mb.timeSignatureDenominator;
      if (num === den) { const b = new M.Beat(); b.duration = M.Duration.Whole; b.isEmpty = false; beats.push(b); return beats; }
      for (let i = 0; i < num; i++) { const b = new M.Beat(); b.duration = den; b.isEmpty = false; beats.push(b); }
      return beats;
    }

    function makeBar(mb, voiceCount, clef) {
      const bar = new M.Bar();
      if (clef !== undefined) bar.clef = clef;
      const vc = Math.max(1, voiceCount || 1);
      for (let v = 0; v < vc; v++) {
        const voice = new M.Voice();
        if (v === 0) restBeatsFor(mb).forEach(b => voice.addBeat(b));
        else { const e = new M.Beat(); e.isEmpty = true; e.duration = M.Duration.Quarter; voice.addBeat(e); }
        bar.addVoice(voice);
      }
      return bar;
    }

    function makeTrack(score, instKey, name) {
      const inst = INSTRUMENTS[instKey] || INSTRUMENTS['guitar-clean'];
      const track = new M.Track();
      track.name = name || inst.name;
      track.shortName = track.name.split(' ')[0].substring(0, 8);
      const ch = freeChannels(score);
      if (ch.length < 2) throw new Error('Não há canais MIDI livres para mais uma trilha.');
      track.playbackInfo.program = inst.program;
      track.playbackInfo.primaryChannel = ch[0];
      track.playbackInfo.secondaryChannel = ch[1];
      track.playbackInfo.volume = 15;
      track.playbackInfo.balance = 8;
      track.ensureStaveCount(1);
      const staff = track.staves[0];
      staff.stringTuning.tunings = inst.tuning.slice();
      staff.showTablature = true;
      staff.showStandardNotation = true;
      const isBass = instKey.indexOf('bass') === 0;
      for (const mb of score.masterBars) staff.addBar(makeBar(mb, 1, isBass ? M.Clef.F4 : M.Clef.G2));
      // guitarra soa uma oitava abaixo do escrito
      staff.displayTranspositionPitch = -12;
      return track;
    }

    function newScore(opts, settings) {
      const o = Object.assign({ title: 'Nova música', artist: '', tempo: 120, num: 4, den: 4, bars: 8, instrument: 'guitar-clean' }, opts || {});
      const score = new M.Score();
      score.title = o.title; score.artist = o.artist;
      for (let i = 0; i < o.bars; i++) {
        const mb = new M.MasterBar();
        mb.timeSignatureNumerator = o.num; mb.timeSignatureDenominator = o.den;
        if (i === 0) mb.tempoAutomations.push(M.Automation.buildTempoAutomation(false, 0, o.tempo, 2));
        score.addMasterBar(mb);
      }
      score.addTrack(makeTrack(score, o.instrument));
      return normalize(score, settings);
    }

    function addTrack(score, instKey, settings) {
      score.addTrack(makeTrack(score, instKey));
      return normalize(score, settings);
    }

    function removeTrack(score, trackIndex, settings) {
      if (score.tracks.length <= 1) throw new Error('A música precisa ter pelo menos uma trilha.');
      score.tracks.splice(trackIndex, 1);
      return normalize(score, settings);
    }

    /* ---------- cursor ---------- */
    // cursor = { track, staff, bar, voice, beat, string }
    function getBeat(score, c) {
      const t = score.tracks[c.track]; if (!t) return null;
      const st = t.staves[c.staff || 0]; if (!st) return null;
      const b = st.bars[c.bar]; if (!b) return null;
      const v = b.voices[c.voice || 0]; if (!v) return null;
      return v.beats[c.beat] || null;
    }
    function stringCount(score, c) {
      const st = score.tracks[c.track].staves[c.staff || 0];
      return st.tuning.length || 6;
    }
    function clampCursor(score, c) {
      const t = score.tracks[Math.min(c.track, score.tracks.length - 1)];
      c.track = t.index;
      const st = t.staves[0]; c.staff = 0;
      c.bar = Math.max(0, Math.min(c.bar, st.bars.length - 1));
      const bar = st.bars[c.bar];
      c.voice = Math.max(0, Math.min(c.voice || 0, bar.voices.length - 1));
      const v = bar.voices[c.voice];
      c.beat = Math.max(0, Math.min(c.beat, v.beats.length - 1));
      const sc = st.tuning.length || 6;
      c.string = Math.max(1, Math.min(c.string || sc, sc));
      return c;
    }
    function cursorFromBeat(beat, string) {
      const v = beat.voice, b = v.bar, st = b.staff;
      return { track: st.track.index, staff: st.index, bar: b.index, voice: v.index, beat: beat.index, string: string || (st.tuning.length || 6) };
    }
    function moveBeat(score, c, dir) {
      const st = score.tracks[c.track].staves[0];
      let bar = c.bar, beat = c.beat + dir;
      const voiceBeats = i => st.bars[i].voices[Math.min(c.voice, st.bars[i].voices.length - 1)].beats.length;
      if (beat < 0) { if (bar > 0) { bar--; beat = voiceBeats(bar) - 1; } else beat = 0; }
      else if (beat >= voiceBeats(bar)) { if (bar < st.bars.length - 1) { bar++; beat = 0; } else beat = voiceBeats(bar) - 1; }
      c.bar = bar; c.beat = beat;
      return clampCursor(score, c);
    }

    function isStringedTrack(score, c) {
      const st = score.tracks[c.track].staves[0];
      return st.tuning.length > 0 && !st.isPercussion;
    }

    function findNote(beat, string) { return beat.notes.find(n => n.string === string) || null; }

    /* ---------- edições (alteram o modelo; quem chama faz normalize) ---------- */
    function setFret(score, c, fret) {
      const beat = getBeat(score, c); if (!beat) return false;
      fret = Math.max(0, Math.min(30, fret | 0));
      let n = findNote(beat, c.string);
      if (!n) { n = new M.Note(); n.string = c.string; beat.addNote(n); }
      n.fret = fret;
      n.isTieDestination = false;
      beat.isEmpty = false;
      return true;
    }
    function deleteNote(score, c) {
      const beat = getBeat(score, c); if (!beat) return false;
      const i = beat.notes.findIndex(n => n.string === c.string);
      if (i < 0) return false;
      beat.notes.splice(i, 1);
      return true;
    }
    function setDuration(score, c, d) { const b = getBeat(score, c); if (!b) return false; b.duration = d; return true; }
    function toggleDot(score, c) { const b = getBeat(score, c); if (!b) return false; b.dots = b.dots ? 0 : 1; return true; }
    function setTuplet(score, c, num, den) { const b = getBeat(score, c); if (!b) return false;
      if (b.tupletNumerator === num) { b.tupletNumerator = -1; b.tupletDenominator = -1; } else { b.tupletNumerator = num; b.tupletDenominator = den; } return true; }
    function makeRest(score, c) { const b = getBeat(score, c); if (!b) return false; b.notes.splice(0, b.notes.length); b.isEmpty = false; return true; }

    function getVoice(score, c) {
      const t = score.tracks[c.track]; if (!t) return null;
      const b = t.staves[c.staff || 0].bars[c.bar]; if (!b) return null;
      return b.voices[c.voice || 0] || null;
    }
    function newBeatLike(b, v) {
      const nb = new M.Beat(); nb.duration = b.duration; nb.dots = b.dots; nb.isEmpty = false; nb.voice = v; return nb;
    }
    function insertBeatAfter(score, c) {
      const b = getBeat(score, c), v = getVoice(score, c); if (!b || !v) return false;
      v.beats.splice(c.beat + 1, 0, newBeatLike(b, v));
      c.beat = c.beat + 1;
      return true;
    }
    function insertBeatBefore(score, c) {
      const b = getBeat(score, c), v = getVoice(score, c); if (!b || !v) return false;
      v.beats.splice(c.beat, 0, newBeatLike(b, v));
      return true;
    }
    function deleteBeat(score, c) {
      const b = getBeat(score, c), v = getVoice(score, c); if (!b || !v) return false;
      if (v.beats.length <= 1) { b.notes.splice(0, b.notes.length); b.isEmpty = false; return true; }
      v.beats.splice(c.beat, 1);
      if (c.beat >= v.beats.length) c.beat = v.beats.length - 1;
      return true;
    }

    function insertBar(score, afterIndex) {
      const ref = score.masterBars[afterIndex] || score.masterBars[score.masterBars.length - 1];
      const mb = new M.MasterBar();
      mb.timeSignatureNumerator = ref.timeSignatureNumerator;
      mb.timeSignatureDenominator = ref.timeSignatureDenominator;
      score.masterBars.splice(afterIndex + 1, 0, mb);
      for (const t of score.tracks) for (const st of t.staves) {
        const refBar = st.bars[afterIndex] || st.bars[st.bars.length - 1];
        const bar = makeBar(mb, refBar ? refBar.voices.length : 1, refBar ? refBar.clef : undefined);
        if (refBar) { bar.keySignature = refBar.keySignature; bar.keySignatureType = refBar.keySignatureType; }
        st.bars.splice(afterIndex + 1, 0, bar);
      }
      return true;
    }
    function deleteBar(score, index) {
      if (score.masterBars.length <= 1) throw new Error('A música precisa ter pelo menos um compasso.');
      const removed = score.masterBars[index];
      const tempos = removed.tempoAutomations;
      score.masterBars.splice(index, 1);
      for (const t of score.tracks) for (const st of t.staves) st.bars.splice(index, 1);
      // não perder o andamento inicial
      if (index === 0 && tempos && tempos.length && !score.masterBars[0].tempoAutomations.length) {
        score.masterBars[0].tempoAutomations.push(M.Automation.buildTempoAutomation(false, 0, tempos[0].value, 2));
      }
      return true;
    }
    function setTimeSignature(score, barIndex, num, den) {
      const mb = score.masterBars[barIndex]; if (!mb) return false;
      mb.timeSignatureNumerator = num; mb.timeSignatureDenominator = den; return true;
    }
    function setTempo(score, barIndex, bpm) {
      const mb = score.masterBars[barIndex]; if (!mb) return false;
      bpm = Math.max(20, Math.min(400, bpm | 0));
      const existing = mb.tempoAutomations.find(a => a.ratioPosition === 0);
      if (existing) existing.value = bpm;
      else mb.tempoAutomations.unshift(M.Automation.buildTempoAutomation(false, 0, bpm, 2));
      return true;
    }
    function getTempoAt(score, barIndex) {
      for (let i = barIndex; i >= 0; i--) {
        const a = score.masterBars[i].tempoAutomations;
        if (a && a.length) return a[a.length - 1].value;
      }
      return score.tempo || 120;
    }
    function toggleRepeat(score, barIndex, kind) {
      const mb = score.masterBars[barIndex]; if (!mb) return false;
      if (kind === 'start') mb.isRepeatStart = !mb.isRepeatStart;
      else mb.repeatCount = mb.repeatCount > 0 ? 0 : 2;
      return true;
    }

    /* efeitos na nota atual */
    function noteAt(score, c) { const b = getBeat(score, c); return b ? findNote(b, c.string) : null; }
    function toggleEffect(score, c, eff, arg) {
      const b = getBeat(score, c); if (!b) return false;
      const n = findNote(b, c.string);
      if (eff === 'palmMute') { if (!n) return false; n.isPalmMute = !n.isPalmMute; return true; }
      if (eff === 'letRing') { if (!n) return false; n.isLetRing = !n.isLetRing; return true; }
      if (eff === 'dead') { if (!n) return false; n.isDead = !n.isDead; return true; }
      if (eff === 'ghost') { if (!n) return false; n.isGhost = !n.isGhost; return true; }
      if (eff === 'staccato') { if (!n) return false; n.isStaccato = !n.isStaccato; return true; }
      if (eff === 'accent') { if (!n) return false; n.accentuated = n.accentuated ? 0 : 1; return true; }
      if (eff === 'vibrato') { if (!n) return false; n.vibrato = n.vibrato === M.VibratoType.None ? M.VibratoType.Slight : (n.vibrato === M.VibratoType.Slight ? M.VibratoType.Wide : M.VibratoType.None); return true; }
      if (eff === 'hammer') { if (!n) return false; n.isHammerPullOrigin = !n.isHammerPullOrigin; return true; }
      if (eff === 'slide') { if (!n) return false; n.slideOutType = n.slideOutType === M.SlideOutType.None ? M.SlideOutType.Legato : (n.slideOutType === M.SlideOutType.Legato ? M.SlideOutType.Shift : M.SlideOutType.None); return true; }
      if (eff === 'harmonic') { if (!n) return false; n.harmonicType = n.harmonicType ? 0 : 1; return true; }
      if (eff === 'tie') {
        // liga com a nota anterior na mesma corda
        // procura a batida anterior (mesma voz, podendo voltar ao compasso anterior)
        const st = score.tracks[c.track].staves[c.staff || 0];
        let pb = c.bar, pi = c.beat - 1, prevNote = null;
        while (pb >= 0) {
          const vv = st.bars[pb].voices[c.voice || 0];
          if (vv && pi < 0) pi = vv.beats.length - 1;
          if (vv && pi >= 0) { const pbeat = vv.beats[pi]; prevNote = findNote(pbeat, c.string); if (prevNote || pbeat.notes.length) break; pi--; if (pi >= 0) continue; }
          pb--; pi = -1;
        }
        if (n && n.isTieDestination) { n.isTieDestination = false; return true; }
        if (!prevNote) return false;
        let nn = n; if (!nn) { nn = new M.Note(); nn.string = c.string; b.addNote(nn); b.isEmpty = false; }
        nn.fret = prevNote.fret; nn.isTieDestination = true; return true;
      }
      if (eff === 'bend') {
        if (!n) return false;
        const amount = arg || 4; // 4 = 1 tom, 2 = meio tom
        if (n.hasBend && n.maxBendPoint && n.maxBendPoint.value === amount && n.bendType === M.BendType.Bend) { n.bendPoints = null; n.bendType = M.BendType.None; return true; }
        n.bendPoints = null; n.maxBendPoint = null;
        n.bendType = M.BendType.Bend;
        n.addBendPoint(new M.BendPoint(0, 0)); n.addBendPoint(new M.BendPoint(15, amount)); n.addBendPoint(new M.BendPoint(60, amount));
        return true;
      }
      if (eff === 'bendRelease') {
        if (!n) return false;
        if (n.bendType === M.BendType.BendRelease) { n.bendPoints = null; n.bendType = M.BendType.None; return true; }
        n.bendPoints = null; n.maxBendPoint = null;
        n.bendType = M.BendType.BendRelease;
        n.addBendPoint(new M.BendPoint(0, 0)); n.addBendPoint(new M.BendPoint(15, 4)); n.addBendPoint(new M.BendPoint(30, 4)); n.addBendPoint(new M.BendPoint(45, 0)); n.addBendPoint(new M.BendPoint(60, 0));
        return true;
      }
      if (eff === 'pickDown') { b.pickStroke = b.pickStroke === 2 ? 0 : 2; return true; }
      if (eff === 'pickUp') { b.pickStroke = b.pickStroke === 1 ? 0 : 1; return true; }
      return false;
    }

    function setTuning(score, trackIndex, tunings) {
      const st = score.tracks[trackIndex].staves[0];
      st.stringTuning.tunings = tunings.slice();
      return true;
    }

    /* copiar/colar compasso da trilha atual */
    function copyBar(score, c) {
      const bar = score.tracks[c.track].staves[0].bars[c.bar];
      const voices = bar.voices.map(v => v.beats.map(b => ({
        duration: b.duration, dots: b.dots, isEmpty: b.isEmpty, tn: b.tupletNumerator, td: b.tupletDenominator,
        notes: b.notes.map(n => ({ string: n.string, fret: n.fret, tie: n.isTieDestination, pm: n.isPalmMute, vib: n.vibrato, dead: n.isDead, hp: n.isHammerPullOrigin }))
      })));
      return { voices };
    }
    function pasteBar(score, c, clip) {
      if (!clip) return false;
      const bar = score.tracks[c.track].staves[0].bars[c.bar];
      clip.voices.forEach((beats, vi) => {
        let voice = bar.voices[vi];
        if (!voice) { voice = new M.Voice(); bar.addVoice(voice); }
        voice.beats.splice(0, voice.beats.length);
        beats.forEach(bd => {
          const b = new M.Beat(); b.duration = bd.duration; b.dots = bd.dots; b.isEmpty = bd.isEmpty;
          b.tupletNumerator = bd.tn; b.tupletDenominator = bd.td;
          bd.notes.forEach(nd => { const n = new M.Note(); n.string = nd.string; n.fret = nd.fret; n.isTieDestination = nd.tie; n.isPalmMute = nd.pm; n.vibrato = nd.vib; n.isDead = nd.dead; n.isHammerPullOrigin = nd.hp; b.addNote(n); });
          voice.addBeat(b);
        });
      });
      return true;
    }

    /** verifica se a soma das durações bate com a fórmula de compasso */
    function barFillState(score, trackIdx, barIdx) {
      const bar = score.tracks[trackIdx].staves[0].bars[barIdx];
      const v = bar.voices[0];
      const expected = bar.masterBar.calculateDuration();
      const actual = v.calculateDuration ? v.calculateDuration() : 0;
      return { expected, actual, state: actual === expected ? 'ok' : (actual < expected ? 'short' : 'long') };
    }

    return {
      INSTRUMENTS, countNotes, normalize, snapshot, restore, newScore, addTrack, removeTrack,
      getBeat, stringCount, clampCursor, cursorFromBeat, moveBeat, isStringedTrack, findNote, noteAt,
      setFret, deleteNote, setDuration, toggleDot, setTuplet, makeRest, insertBeatAfter, insertBeatBefore, deleteBeat,
      insertBar, deleteBar, setTimeSignature, setTempo, getTempoAt, toggleRepeat, toggleEffect, setTuning,
      copyBar, pasteBar, barFillState
    };
  }

  root.makeTabOps = makeTabOps;
  if (typeof module !== 'undefined' && module.exports) module.exports = makeTabOps;
})(typeof window !== 'undefined' ? window : globalThis);
