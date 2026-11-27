/* Tab Studio — aplicação principal (leitor, player, editor, ponte com o 3D). */
(function () {
  'use strict';
  const APP_VERSION = '2.8.1';
  const at = window.alphaTab;
  const Ops = window.makeTabOps(at);
  const Tr = window.makeTranspose(at);   // tom do conjunto (js/transpose.js)
  const Store = window.TabStore;
  const $ = id => document.getElementById(id);
  const TICKS_PER_QUARTER = 960;
  const FRAMED = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();

  /* ---------------- preferências ---------------- */
  const PREF_KEY = 'tabstudio.prefs';
  const prefs = Object.assign({ stave: 'ScoreTab', layout: 'Page', zoom: 100, follow: true, flip: false, tbarCollapsed: window.innerWidth < 700 }, readPrefs());
  /* notação: 4 opções; "Tablatura + ritmo" = tablatura com as hastes do ritmo */
  const STAVES = { ScoreTab: ['ScoreTab', 'Automatic'], TabRhythm: ['Tab', 'ShowWithBars'], Tab: ['Tab', 'Hidden'], Score: ['Score', 'Automatic'] };
  function staveOf(v) { return STAVES[v] || v === 'Auto' ? v : ({ Default: 'ScoreTab', TabMixed: 'TabRhythm' }[v] || 'ScoreTab'); }
  /* "Automático": instrumento de corda (pela trilha principal) = tablatura + ritmo; teclado, bateria e o resto = partitura */
  function effStave() {
    const v = staveOf(prefs.stave);
    if (v !== 'Auto') return v;
    const t = S.score ? S.score.tracks[S.primary] : null;
    return !t || neckable(t) ? 'TabRhythm' : 'Score';
  }
  function readPrefs() { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch (e) { return {}; } }
  function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* armazenamento indisponível */ } }

  /* ---------------- estado ---------------- */
  const S = {
    score: null, fileName: '', tracks: [0], viewTracksBeforeEdit: null,
    edit: false, cur: { track: 0, staff: 0, bar: 0, voice: 0, beat: 0, string: 6 },
    undo: [], redo: [], dirty: false, clip: null, saveHandle: null,
    fretBuf: '', fretT: 0,
    playerReady: false, playing: false, endTime: 0, seeking: false,
    mix: {}, threeTrack: 0, primary: 0, fb: null, lastTick: 0,
    pendingScroll: null,
    rep: null, recId: null, curBytes: null, repPending: false,  // recId: música dos recentes (ajustes guardados nela)
    test: null, keyMode: 'auto',  // teste de tom no player (a música original fica guardada em test.orig)
    keySkip: new Set(),           // trilhas desmarcadas (não mudam de tom)
    chg: { key: 0, edited: false }, // o que mudou desde que abriu (vai no nome do "Salvar como")
    srcName: '', origId: null, origKept: false
  };
  let Rep = null; // módulo de repertórios (js/rep.js), criado no fim

  /* ---------------- alphaTab ---------------- */
  const viewport = $('viewport');
  const atEl = $('alphaTab');
  const settings = {
    core: {
      fontDirectory: new URL('font/', location.href).href,
      scriptFile: new URL('vendor/alphaTab.min.js', location.href).href,
      includeNoteBounds: true,
      engine: 'svg'
    },
    notation: { rhythmMode: at.TabRhythmMode[STAVES[effStave()][1]] },
    display: {
      staveProfile: at.StaveProfile[STAVES[effStave()][0]],
      layoutMode: at.LayoutMode[prefs.layout] ?? at.LayoutMode.Page,
      scale: prefs.zoom / 100
    },
    player: {
      enablePlayer: true,
      enableCursor: true,
      enableAnimatedBeatCursor: true,
      enableUserInteraction: true,
      soundFont: window.TABSTUDIO_SF_B64 ? undefined : new URL('soundfont/sonivox.sf3', location.href).href,
      scrollElement: viewport,
      scrollMode: prefs.follow ? at.ScrollMode.Continuous : at.ScrollMode.Off
    }
  };
  let api;
  try {
    api = new at.AlphaTabApi(atEl, settings);
  } catch (e) {
    showMsg('Erro ao iniciar', 'Não foi possível iniciar o motor de partituras: ' + esc(e.message));
    return;
  }

  // versão embutida (link de visualização): sons vêm de um arquivo .js
  if (window.TABSTUDIO_SF_B64) {
    let sfDone = false;
    const sfBytes = Uint8Array.from(atob(window.TABSTUDIO_SF_B64), c => c.charCodeAt(0));
    const loadSf = () => { if (!sfDone && api.loadSoundFont(sfBytes, false)) sfDone = true; };
    api.scoreLoaded.on(() => setTimeout(loadSf, 0));
    api.playerReady.on(loadSf);
  }
  /* ---------------- utilidades ---------------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  let toastT = 0;
  const icon = id => '<svg class="i" aria-hidden="true"><use href="#i-' + id + '"/></svg>';
  /* faixas deslizantes: a parte "cheia" acompanha o valor */
  function paintRange(el) { if (!el) return; const mn = +el.min || 0, mx = +el.max || 100; el.style.setProperty('--pct', ((+el.value - mn) / (mx - mn) * 100) + '%'); }
  document.addEventListener('input', e => { if (e.target.type === 'range') paintRange(e.target); });
  /* tema: escuro (padrão) ou claro */
  function applyTheme() {
    const light = prefs.theme === 'light';
    if (light) document.documentElement.dataset.theme = 'light'; else delete document.documentElement.dataset.theme;
    const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = light ? '#f3eff8' : '#130d1c';
    $('btnTheme').innerHTML = icon(light ? 'sun' : 'moon');
    $('btnTheme').title = light ? 'Mudar para o modo escuro' : 'Mudar para o modo claro';
    try { tbar.draw(); tbar.drawStrip(); } catch (e) { /* barra ainda não criada */ }
  }
  function toast(msg, kind, ms) {
    const t = $('toast'); t.textContent = msg; t.className = 'show ' + (kind || '');
    // com uma janela aberta, o aviso vai para dentro dela (senão fica escondido atrás)
    const ds = [...document.querySelectorAll('dialog[open]')]; const host = ds.length ? ds[ds.length - 1] : document.body;
    if (t.parentNode !== host) host.appendChild(t);
    clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, ms || (kind === 'err' ? 6000 : 2600));
  }
  function showMsg(title, html, buttons) {
    const d = $('dlgMsg'); $('msgTitle').textContent = title; $('msgBody').innerHTML = html;
    const menu = $('msgMenu'); menu.innerHTML = '';
    const btns = buttons || [{ label: 'OK', value: 'ok', primary: true }];
    btns.forEach(b => { const el = document.createElement('button'); el.className = 'btn' + (b.primary ? ' primary' : ''); el.value = b.value; el.textContent = b.label; menu.appendChild(el); });
    return new Promise(res => { d.onclose = () => res(d.returnValue); d.returnValue = ''; d.showModal(); });
  }
  function confirmDlg(title, html, okLabel) {
    return showMsg(title, html, [{ label: 'Cancelar', value: 'cancel' }, { label: okLabel || 'Continuar', value: 'ok', primary: true }]).then(v => v === 'ok');
  }
  function fmtTime(ms) { ms = Math.max(0, ms | 0); const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function midiName(m) { return NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1); }
  function trackTuning(t) { return t.staves[0].tuning || []; }
  function isStringed(t) { return t && trackTuning(t).length > 0 && !t.staves[0].isPercussion; }

  const GM = ['Piano acústico', 'Piano brilhante', 'Piano elétrico grand', 'Honky-tonk', 'Piano elétrico 1 (Rhodes)', 'Piano elétrico 2', 'Cravo', 'Clavinet', 'Celesta', 'Glockenspiel', 'Caixa de música', 'Vibrafone', 'Marimba', 'Xilofone', 'Sinos tubulares', 'Dulcimer', 'Órgão drawbar (Hammond)', 'Órgão percussivo', 'Órgão rock', 'Órgão de igreja', 'Órgão de palheta', 'Acordeão', 'Gaita', 'Bandoneón', 'Violão nylon', 'Violão aço', 'Guitarra jazz', 'Guitarra limpa', 'Guitarra abafada', 'Guitarra overdrive', 'Guitarra distorcida', 'Harmônicos de guitarra', 'Baixo acústico', 'Baixo elétrico (dedo)', 'Baixo elétrico (palheta)', 'Baixo fretless', 'Baixo slap 1', 'Baixo slap 2', 'Synth baixo 1', 'Synth baixo 2', 'Violino', 'Viola', 'Violoncelo', 'Contrabaixo', 'Cordas tremolo', 'Cordas pizzicato', 'Harpa', 'Tímpanos', 'Cordas 1', 'Cordas 2', 'Synth cordas 1', 'Synth cordas 2', 'Coro aahs', 'Voz oohs', 'Synth voz', 'Orquestra hit', 'Trompete', 'Trombone', 'Tuba', 'Trompete surdo', 'Trompa', 'Metais', 'Synth metais 1', 'Synth metais 2', 'Sax soprano', 'Sax alto', 'Sax tenor', 'Sax barítono', 'Oboé', 'Corne inglês', 'Fagote', 'Clarinete', 'Flautim', 'Flauta', 'Flauta doce', 'Flauta de pã', 'Garrafa', 'Shakuhachi', 'Assobio', 'Ocarina', 'Lead quadrada', 'Lead serra', 'Lead calliope', 'Lead chiff', 'Lead charang', 'Lead voz', 'Lead quintas', 'Lead baixo+lead', 'Pad new age', 'Pad quente', 'Pad polysynth', 'Pad coro', 'Pad arco', 'Pad metálico', 'Pad halo', 'Pad sweep', 'FX chuva', 'FX trilha', 'FX cristal', 'FX atmosfera', 'FX brilho', 'FX goblins', 'FX ecos', 'FX sci-fi', 'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Gaita de fole', 'Rabeca', 'Shanai', 'Sino', 'Agogô', 'Steel drums', 'Bloco de madeira', 'Taiko', 'Tom melódico', 'Synth bateria', 'Prato reverso', 'Ruído de traste', 'Respiração', 'Mar', 'Pássaro', 'Telefone', 'Helicóptero', 'Aplausos', 'Tiro'];
  function instName(t) {
    if (t.staves[0].isPercussion || t.playbackInfo.primaryChannel === 9) return 'Bateria';
    const tun = trackTuning(t);
    const base = GM[t.playbackInfo.program] || ('Programa ' + t.playbackInfo.program);
    return tun.length ? base + ' · ' + tun.length + ' cordas (' + tun.slice().reverse().map(m => NOTE_NAMES[m % 12]).join(' ') + ')' : base;
  }

  /* ---------------- barra de trilhas ---------------- */
  const Wake = window.TabWake;
  const tbar = new window.TrackBar($('trackBar'), {
    onSelect: (i, add) => selectTrack(i, add),
    onMute: i => setMute(i),
    onSolo: i => setSolo(i),
    onBar: (track, bar) => {
      if (track !== S.primary) selectTrack(track, false);
      if (S.edit) { S.cur.bar = bar; S.cur.beat = 0; Ops.clampCursor(S.score, S.cur); updateEditor(); drawCursor(); ensureCursorVisible(); }
      seekToBar(bar);
    },
    onRange: (a, b, track) => { if (track !== S.primary && !S.edit) selectTrack(track, false); setRangeBars(a, b); },
    onCollapse: c => { prefs.tbarCollapsed = c; savePrefs(); },
    onState: c => { const b = document.getElementById('btnTrkPanel'); if (b) b.classList.toggle('on', !c); }
  });
  tbar.setCollapsed(prefs.tbarCollapsed);

  /* ---------------- carregar / mostrar ---------------- */
  function setScore(score, opts) {
    opts = opts || {};
    if (Rep) Rep.leaving(); // guarda os ajustes da música do repertório que está saindo
    S.rep = opts.rep || null; S.recId = opts.rep ? null : (opts.recId || null); S.repPending = !!(opts.rep || opts.recId); S.repBase = null; S.curBytes = null; S.test = null;
    // cada música começa "do zero": sem trecho, sem repetição, sem aumento automático e a 100%
    // (no repertório, a velocidade escolhida para a música é aplicada depois)
    api.isLooping = false; S.loopProg = null; S.speedBeforeLoop = null;
    try { api.playbackRange = null; api.clearPlaybackRangeHighlight(); } catch (e) { /* nada destacado */ }
    if (typeof setLoopPick === 'function') setLoopPick(null);
    setSpeed(100);
    S.score = score;
    S.fileName = opts.name || score.title || 'musica';
    S.saveHandle = opts.saveHandle || null;
    S.undo = []; S.redo = []; S.undoChg = []; S.redoChg = []; S.mix = {}; S.clip = null;
    S.chg = { key: 0, edited: false }; S.keySkip = new Set(); S.srcName = ''; S.origId = null; S.origKept = false;
    S.dirty = !!opts.dirty;
    S.tracks = [firstStringed(score)];
    // ajustes guardados (repertório): trilhas mostradas, a principal e o mixer
    const okT = i => Number.isInteger(i) && i >= 0 && i < score.tracks.length;
    if (Array.isArray(opts.tracks) && opts.tracks.filter(okT).length) S.tracks = [...new Set(opts.tracks.filter(okT))].sort((a, b) => a - b);
    let prim = okT(opts.primary) && S.tracks.includes(opts.primary) ? opts.primary : S.tracks[0];
    if (opts.mix && typeof opts.mix === 'object') {
      for (const k of Object.keys(opts.mix)) { const m = opts.mix[k]; if (okT(+k) && m) S.mix[+k] = { mute: !!m.mute, solo: !!m.solo, vol: Math.max(0, Math.min(1.5, +m.vol || 0)) }; }
    }
    S.cur = { track: prim, staff: 0, bar: 0, voice: 0, beat: 0, string: 1 };
    Ops.clampCursor(score, S.cur);
    S.cur.string = Ops.stringCount(score, S.cur);
    S.primary = prim; S.threeTrack = S.primary;
    tbar.setRange(null); updateLoopStatus();
    $('welcome').hidden = true;
    viewport.scrollTop = 0; viewport.scrollLeft = 0;
    if (S.edit) { S.viewTracksBeforeEdit = null; S.tracks = [S.cur.track]; }
    waitMidi = true; waitRender = true;
    render();
    tbar.setScore(score); tbar.setPos(0); tbar.setRange(null);
    updateTitle(); refreshTrackUI(); updateEditor();
    if (opts.enterEdit && !S.edit) toggleEdit(true);
    if (Rep) Rep.updateBar();
    renderKeyUI();
  }
  function firstStringed(score) {
    // prefere guitarra/violão/baixo (programas GM 24–39) com tablatura visível
    const pr = t => t.playbackInfo.program >= 24 && t.playbackInfo.program <= 39;
    let i = score.tracks.findIndex(t => isStringed(t) && pr(t) && t.staves[0].showTablature);
    if (i < 0) i = score.tracks.findIndex(t => isStringed(t) && pr(t));
    if (i < 0) i = score.tracks.findIndex(t => isStringed(t));
    return i >= 0 ? i : 0;
  }
  /* Modo "só tablatura" com uma bateria que não tem tablatura (comum em GP7/GP8):
     o alphaTab não tem o que desenhar e quebra ("reading 'staves'"), deixando a página em branco.
     Nesse caso a bateria aparece na notação de bateria (cada pauta como foi gravada no arquivo). */
  function applyStaveProfile() {
    const [prof, rhythm] = STAVES[effStave()];
    let want = prof;
    if (prof === 'Tab' && S.tracks.some(i => { const t = S.score.tracks[i]; return t && t.staves.some(st => st.isPercussion && !st.showTablature); })) want = 'Default';
    const sp = at.StaveProfile[want], rm = at.TabRhythmMode[rhythm];
    if (api.settings.display.staveProfile !== sp || api.settings.notation.rhythmMode !== rm) {
      api.settings.display.staveProfile = sp; api.settings.notation.rhythmMode = rm; api.updateSettings();
    }
    S.staveOverride = want !== prof;
  }
  function render() {
    if (!S.score) return;
    S.tracks = S.tracks.filter(i => i < S.score.tracks.length);
    if (!S.tracks.length) S.tracks = [0];
    applyStaveProfile();
    if (api.score === S.score) api.renderTracks(S.tracks.map(i => S.score.tracks[i]));
    else {
      // partitura nova (arquivo ou edição): o trecho destacado apontava para a antiga
      try { if (api.playbackRange) api.playbackRange = null; api.clearPlaybackRangeHighlight(); } catch (e) { /* nada destacado */ }
      // contorno de um defeito do alphaTab: a limpeza não esquece as batidas antigas e o redesenho quebraria;
      // apontar início=fim para uma batida da partitura nova faz o alphaTab ignorar o destaque.
      try { const b0 = S.score.tracks[0].staves[0].bars[0].voices[0].beats[0]; if (b0) api.highlightPlaybackRange(b0, b0); } catch (e) { /* sem batidas */ }
      tbar.setRange(null);
      api.renderScore(S.score, S.tracks.slice());
    }
  }
  /* seleção de trilha (barra de trilhas, painel, 3D): a principal manda no 3D */
  function selectTrack(i, additive) {
    if (!S.score || i < 0 || i >= S.score.tracks.length) return;
    S.vizPick = null; // clicou numa trilha: instrumento volta à sugestão (cordas ou teclas)
    if (S.edit) { setEditTrack(i); return; }
    if (additive) {
      if (S.tracks.includes(i)) {
        if (S.tracks.length === 1) { toast('Mostre pelo menos uma trilha'); return; }
        S.tracks = S.tracks.filter(x => x !== i);
        if (S.primary === i) S.primary = S.tracks[0];
      } else { S.tracks = S.tracks.concat([i]).sort((a, b) => a - b); S.primary = i; }
    } else { S.tracks = [i]; S.primary = i; }
    render(); refreshTrackUI();
  }
  function refreshTrackUI() {
    updateTuneChip();
    if (!S.score) return;
    if (!S.tracks.includes(S.primary)) S.primary = S.tracks[0];
    buildTrackList();
    tbar.setState({ visible: S.tracks, primary: S.primary, mix: S.mix });
    sync3d();
  }
  function setMute(i) { const m = mixOf(i); m.mute = !m.mute; api.changeTrackMute([S.score.tracks[i]], m.mute); refreshTrackUI(); }
  function setSolo(i) { const m = mixOf(i); m.solo = !m.solo; api.changeTrackSolo([S.score.tracks[i]], m.solo); refreshTrackUI(); }
  function seekToBar(bar) {
    const mb = S.score && S.score.masterBars[bar]; if (!mb) return;
    const tc = api.tickCache;
    if (tc) { try { api.tickPosition = tc.getMasterBarStart(mb); } catch (e) { /* sem MIDI ainda */ } }
    tbar.setPos(bar, S.playing);
    if (!S.playing) scrollToBar(bar);
  }
  function scrollToBar(bar) {
    const t = S.score.tracks[S.primary]; if (!t || !api.boundsLookup) return;
    const b = t.staves[0].bars[bar]; const beat = b && b.voices[0] && b.voices[0].beats[0]; if (!beat) return;
    let list = []; try { list = api.boundsLookup.findBeats(beat) || []; } catch (e) { list = []; }
    if (!list.length) return;
    const br = list[0].barBounds.masterBarBounds ? list[0].barBounds.masterBarBounds.realBounds : list[0].barBounds.realBounds;
    const top = atEl.offsetTop + br.y - 30, left = atEl.offsetLeft + br.x - 30;
    if (top < viewport.scrollTop || top > viewport.scrollTop + viewport.clientHeight - 80) viewport.scrollTop = top;
    if (left < viewport.scrollLeft || left > viewport.scrollLeft + viewport.clientWidth - 80) viewport.scrollLeft = Math.max(0, left);
  }
  function rangeBars(r) {
    if (!r || !S.score || !api.tickCache) return null;
    let a = -1, b = -1;
    S.score.masterBars.forEach((mb, i) => {
      let st; try { st = api.tickCache.getMasterBarStart(mb); } catch (e) { return; }
      const en = st + mb.calculateDuration();
      if (a < 0 && r.startTick < en) a = i;
      if (r.endTick > st) b = i;
    });
    return a >= 0 && b >= a ? [a, b] : null;
  }
  function setRangeBars(a, b, quiet) {
    const tc = api.tickCache; if (!tc || !S.score) return;
    const mA = S.score.masterBars[a], mB = S.score.masterBars[b];
    const R = (at.synth && at.synth.PlaybackRange) ? new at.synth.PlaybackRange() : {};
    R.startTick = tc.getMasterBarStart(mA); R.endTick = tc.getMasterBarStart(mB) + mB.calculateDuration();
    api.playbackRange = R;
    try {
      const st = S.score.tracks[S.primary].staves[0];
      const vA = st.bars[a].voices[0], vB = st.bars[b].voices[0];
      api.highlightPlaybackRange(vA.beats[0], vB.beats[vB.beats.length - 1]);
    } catch (e) { /* destaque é opcional */ }
    tbar.setRange([a, b]);
    try { api.tickPosition = R.startTick; } catch (e) { /* nada */ }
    if (!quiet) toast('Trecho: compassos ' + (a + 1) + ' a ' + (b + 1) + (api.isLooping ? ' (repetindo)' : ' — ligue a repetição para repetir'));
  }
  function renderKeepScroll() {
    S.pendingScroll = { top: viewport.scrollTop, left: viewport.scrollLeft };
    render();
  }

  function loadBytes(bytes, name, extra) {
    let score;
    try {
      score = at.importer.ScoreLoader.loadScoreFromBytes(bytes, api.settings);
    } catch (e) {
      showMsg('Não foi possível abrir', 'O arquivo <b>' + esc(name) + '</b> não foi reconhecido como tablatura/partitura válida.<br><br><span class="muted">' + esc(e.message || e) + '</span>');
      return false;
    }
    setScore(score, Object.assign({ name: name.replace(/\.[^.]+$/, '') }, extra || {}));
    S.curBytes = bytes; S.srcName = name; S.origId = hashBytes(bytes);
    updateDisk();
    toast('Aberto: ' + name + ' — ' + score.tracks.length + ' trilha(s), ' + score.masterBars.length + ' compassos', 'ok');
    return true;
  }
  /* ---------------- arquivos recentes (até 20, guardados no aparelho) ---------------- */
  // o navegador não deixa guardar o caminho do arquivo; como os arquivos são pequenos, guardamos o conteúdo
  const RECENT_MAX = 500, RECENT_MAX_BYTES = 20 * 1024 * 1024;
  function hashBytes(b) { let h = 0x811c9dc5; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36) + '-' + b.length; }
  async function getRecent() { try { return (await Store.get('recent')) || []; } catch (e) { return []; } }
  // settings: ajustes guardados nessa música (velocidade, trilhas, mixer…); sem informar, mantém os que já tinha
  async function addRecent(bytes, name, settings) {
    try {
      if (!bytes || bytes.length > RECENT_MAX_BYTES) return false;
      const id = hashBytes(bytes);
      const sc = S.score || {};
      const meta = { id, name, title: sc.title || '', artist: sc.artist || '', size: bytes.length, time: Date.now() };
      const list = await getRecent();
      const old = list.find(x => x.id === id);
      let st = settings !== undefined ? settings : (old && old.settings);
      const kept = await getKept();
      if (!st && settings === undefined && kept[id]) st = kept[id];   // voltou para a lista: os ajustes guardados voltam junto
      const keep = [meta].concat(list.filter(x => x.id !== id && x.name !== name));
      if (st) meta.settings = cleanSt(st);
      const drop = keep.slice(RECENT_MAX).concat(list.filter(x => x.id !== id && x.name === name));
      await Store.set('file:' + id, bytes);
      // quem sai da lista não perde os ajustes: ficam guardados para quando o arquivo for aberto de novo
      let kch = false;
      if (kept[id]) { delete kept[id]; kch = true; }
      for (const d of drop) if (d.id !== id && d.settings) { kept[d.id] = d.settings; kch = true; }
      if (kch) await putKept(kept);
      await Store.set('recent', keep.slice(0, RECENT_MAX));
      for (const d of drop) if (d.id !== id) await gcFile(d.id);
      updateRecentButton();
      return true;
    } catch (e) { return false; /* sem espaço no aparelho: a lista só não é atualizada */ }
  }
  /* ---------------- favoritos (o arquivo fica guardado no aparelho enquanto for favorito) ---------------- */
  async function getFavs() { try { return (await Store.get('favs')) || []; } catch (e) { return []; } }
  let curIdCache = { b: null, id: null };
  function curFileId() {   // identidade da música aberta = o arquivo guardado (null: música nova ainda não salva)
    const b = S.curBytes; if (!b) return null;
    if (curIdCache.b !== b) curIdCache = { b, id: hashBytes(b) };
    return curIdCache.id;
  }
  let favIds = new Set();
  async function loadFavIds() { favIds = new Set((await getFavs()).map(x => x.id)); updateFavBtn(); }
  function isFav(id) { return !!id && favIds.has(id); }
  async function setFav(meta, on, bytes) {
    try {
      const list = await getFavs(), i = list.findIndex(x => x.id === meta.id);
      if (on) {
        if (bytes) await Store.set('file:' + meta.id, bytes);
        else if (!(await Store.get('file:' + meta.id))) throw new Error('o arquivo não está mais guardado no aparelho');
        const e = { id: meta.id, name: meta.name, title: meta.title || '', artist: meta.artist || '', size: meta.size || 0, time: Date.now() };
        if (meta.settings) e.settings = cleanSt(meta.settings);
        if (i >= 0) list[i] = Object.assign(list[i], e); else list.unshift(e);
      } else if (i >= 0) list.splice(i, 1);
      await Store.set('favs', list);
      if (!on) await gcFile(meta.id);
      await loadFavIds();
      return true;
    } catch (e) {
      showMsg('Favoritos não atualizados', 'Não foi possível ' + (on ? 'favoritar' : 'tirar dos favoritos') + ': ' + esc(e.message || e) + '.');
      return false;
    }
  }
  async function toggleFavCurrent() {
    if (!S.score) return;
    const id = curFileId();
    if (!id) { toast('Salve a música no app (Ctrl+S) para poder favoritar'); return; }
    const on = !isFav(id), sc = S.score;
    const rec = (await getRecent()).find(x => x.id === id);
    const meta = { id, name: (rec && rec.name) || S.srcName || ((S.fileName || sc.title || 'musica') + '.gp'), title: sc.title, artist: sc.artist, size: S.curBytes.length, settings: (rec && rec.settings) || (S.recId === id ? S.repBase : null) };
    if (await setFav(meta, on, on ? S.curBytes : null)) toast(on ? 'Adicionada aos favoritos' : 'Tirada dos favoritos', on ? 'ok' : '');
  }
  // ao salvar uma versão nova, a estrela acompanha a música aberta
  async function favFollow(oldId, bytes, name) {
    if (!oldId || !isFav(oldId)) return;
    const id = hashBytes(bytes); if (id === oldId) return;
    try {
      const list = await getFavs(), e = list.find(x => x.id === oldId); if (!e) return;
      Object.assign(e, { id, name, size: bytes.length, title: (S.score && S.score.title) || e.title, artist: (S.score && S.score.artist) || e.artist, time: Date.now() });
      if (S.recId === id && S.repBase) e.settings = cleanSt(S.repBase);
      await Store.set('file:' + id, bytes);
      await Store.set('favs', list.filter((x, i) => x.id !== id || x === e));
      await gcFile(oldId); await loadFavIds();
    } catch (e) { /* segue: a versão antiga continua nos favoritos */ }
  }
  async function openFav(id) {
    const f = (await getFavs()).find(x => x.id === id); if (!f) return;
    if (!(await confirmLeave())) return;
    let bytes = null; try { bytes = await Store.get('file:' + id); } catch (e) { bytes = null; }
    if (!bytes) { toast('Esse arquivo não está mais guardado no aparelho', 'err'); return; }
    await openAsRecent(bytes, f.name);
  }
  function updateFavBtn() {
    const b = $('btnFav'); if (!b) return;
    const id = S.score ? curFileId() : null, on = isFav(id);
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.title = !id ? 'Favoritar (salve a música no app primeiro)' : on ? 'Tirar dos favoritos' : 'Favoritar esta música';
  }
  async function getKept() { try { return (await Store.get('keptSettings')) || {}; } catch (e) { return {}; } }
  async function putKept(k) { const ks = Object.keys(k); if (ks.length > 3000) for (const x of ks.slice(0, ks.length - 3000)) delete k[x]; await Store.set('keptSettings', k); }
  const cleanSt = st => { const c = JSON.parse(JSON.stringify(st)); c.loop = null; c.prog = null; return c; };
  async function saveRecentSettings(id, st) {
    try {
      const list = await getRecent(), m = list.find(x => x.id === id);
      if (!m) throw new Error('a música não está mais nos recentes');
      m.settings = cleanSt(st);
      await Store.set('recent', list);
      if (isFav(id)) { const fl = await getFavs(), f = fl.find(x => x.id === id); if (f) { f.settings = cleanSt(st); await Store.set('favs', fl); } }
      return true;
    } catch (e) {
      showMsg('Ajustes não guardados', 'Os ajustes <b>não</b> foram guardados: ' + esc(e.message || e) + '. A música continua aberta com eles; tente aplicar de novo.');
      return false;
    }
  }
  /** abre uma música que fica nos recentes, com os ajustes que a pessoa aplicou nela */
  let recSeq = 0;
  async function openAsRecent(bytes, name, extra) {
    const id = hashBytes(bytes);
    const meta = (await getRecent()).find(x => x.id === id), fav = (await getFavs()).find(x => x.id === id);
    const st = (meta && meta.settings) || (fav && fav.settings) || (await getKept())[id] || null;
    const metro0 = $('btnMetro').classList.contains('on'), count0 = $('btnCountIn').classList.contains('on');
    const opts = Object.assign({}, extra || {}, { recId: id }, st ? { tracks: st.tracks, primary: st.primary, mix: st.mix } : {});
    if (!loadBytes(bytes, name, opts)) return false;
    clearDraft();
    const sc = S.score, token = ++recSeq;
    const stored = await addRecent(bytes, name);
    if (!stored && S.score === sc) S.recId = null;   // sem espaço: não há onde guardar ajustes
    let done = false;
    const apply = () => {
      if (done || token !== recSeq || S.score !== sc || !S.repPending || S.rep) return;
      done = true;
      applyPlaySettings(st || { speed: 100, metro: metro0, countIn: count0 });
    };
    afterMidi(apply);
    setTimeout(apply, 8000); // segurança: se o MIDI demorar, aplica assim mesmo
    return true;
  }
  async function openRecent(id) {
    const list = await getRecent(); const meta = list.find(x => x.id === id); if (!meta) return;
    if (!(await confirmLeave())) return;
    let bytes = null; try { bytes = await Store.get('file:' + id); } catch (e) { bytes = null; }
    if (!bytes) { toast('Esse arquivo não está mais guardado no aparelho — abra pelo "Abrir arquivo"', 'err'); await removeRecent(id); return; }
    await openAsRecent(bytes, meta.name);
  }
  async function removeRecent(id) {
    const list = await getRecent();
    const m = list.find(x => x.id === id);
    if (m && m.settings) { const k = await getKept(); k[id] = m.settings; await putKept(k).catch(() => { /* segue */ }); }
    await Store.set('recent', list.filter(x => x.id !== id)); await gcFile(id);
    updateRecentButton();
  }
  async function clearRecent() {
    const list = await getRecent();
    const k = await getKept(); let kch = false;
    for (const m of list) if (m.settings) { k[m.id] = m.settings; kch = true; }
    if (kch) await putKept(k).catch(() => { /* segue */ });
    await Store.set('recent', []);
    for (const m of list) await gcFile(m.id);
    updateRecentButton();
  }
  /* um arquivo guardado é compartilhado entre recentes e repertórios: só apaga quando ninguém mais usa */
  async function gcFile(id) {
    if (!id) return;
    const inRecent = (await getRecent()).some(x => x.id === id);
    const inFav = (await getFavs()).some(x => x.id === id);
    const inRep = Rep ? await Rep.usesFile(id) : true; // na dúvida, não apaga
    if (!inRecent && !inFav && !inRep) await Store.del('file:' + id);
  }
  async function updateRecentButton() { const n = (await getRecent()).length; $('wRecent').innerHTML = icon('clock') + '<span>Recentes' + (n ? ' (' + n + ')' : '') + '</span>'; }
  function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0).replace('.', ',') + ' KB' : (n / 1048576).toFixed(n < 10485760 ? 1 : 0).replace('.', ',') + ' MB'; }
  // aviso quando o espaço que o navegador dá ao app está quase no fim
  async function storageWarn() {
    try {
      if (!navigator.storage || !navigator.storage.estimate) return '';
      const e = await navigator.storage.estimate();
      if (e.quota && e.usage / e.quota > 0.85) return 'espaço do aparelho quase cheio (' + fmtSize(e.usage) + ' de ' + fmtSize(e.quota) + ') — faça um backup';
    } catch (err) { /* sem estimativa */ }
    return '';
  }
  function recentDialog() { return Rep.openLibrary('recent'); }
  async function openFile(file, extra) {
    if (!file) return;
    if (/\.(zip|tabrep)$/i.test(file.name) && Rep) {
      try { const b = new Uint8Array(await file.arrayBuffer()); if (await Rep.isRepZip(b)) { Rep.importBytes(b, file.name); return; } if (window.TabBackup && await window.TabBackup.isBackupZip(b)) { window.TabBackup.restore(b, file.name); return; } }
      catch (e) { showMsg('Erro ao ler arquivo', esc(e.message)); return; }
    }
    if (!(await confirmLeave())) return;
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (Rep && await Rep.isRepZip(bytes)) { Rep.importBytes(bytes, file.name); return; }
      if (window.TabBackup && await window.TabBackup.isBackupZip(bytes)) { window.TabBackup.restore(bytes, file.name); return; }
      await openAsRecent(bytes, file.name, extra);
    } catch (e) { showMsg('Erro ao ler arquivo', esc(e.message)); }
  }

  function updateTitle() {
    const s = S.score;
    document.body.classList.toggle('no-song', !s);
    if (!s) { $('songTitle').textContent = ''; return; }
    // nome da música em cima (negrito) e da banda embaixo, menor — cabem mais letras na mesma altura
    $('songTitle').innerHTML = '<b>' + (S.dirty ? '● ' : '') + esc(s.title || S.fileName || 'Sem título') + '</b>' + (s.artist ? '<span>' + esc(s.artist) + '</span>' : '');
    document.title = (S.dirty ? '● ' : '') + (s.title || S.fileName || 'Tab Studio') + ' · Tab Studio';
  }

  let idleRaf = 0;   // instrumento parado: redesenha uma vez por quadro
  /* ---------------- eventos do alphaTab ---------------- */
  api.error.on(e => { console.error(e); toast('Erro: ' + (e && e.message ? e.message : e), 'err'); });
  api.soundFontLoad.on(e => { if (e.total) $('plStatus').textContent = 'Carregando sons… ' + Math.round(e.loaded / e.total * 100) + '%'; });
  api.soundFontLoaded.on(() => { S.soundReady = true; if (!S.playerReady) $('plStatus').textContent = 'Sons carregados'; });
  api.playerReady.on(() => { S.playerReady = true; $('btnPlay').disabled = false; $('plStatus').textContent = 'Pronto'; });
  api.playerStateChanged.on(e => {
    S.playing = e.state === 1;
    if (!S.playing && S.tempCount) { S.tempCount = false; api.countInVolume = $('btnCountIn').classList.contains('on') ? 1 : 0; }
    $('btnPlay').innerHTML = icon(S.playing ? 'pause' : 'play'); $('btnPlay').classList.toggle('playing', S.playing);
    if (S.playing) { Promise.resolve(Wake.request()).then(m => { $('plStatus').textContent = 'Tocando' + (m !== 'off' ? ' · tela sempre ligada' : ''); }); }
    else { Wake.release(); $('plStatus').textContent = S.playerReady ? 'Pausado' : $('plStatus').textContent; }
    if (S.fb) { if (!S.playing) { S.fb.stopAll(); show3dIdle(); } }
  });
  // fim da música: garante que a tela volta a apagar sozinha
  api.playerFinished.on(() => { setTimeout(() => { if (!S.playing) Wake.release(); }, 100); if (Rep) Rep.onFinished(); });
  api.playerPositionChanged.on(e => {
    S.endTime = e.endTime;
    $('plCur').textContent = fmtTime(e.currentTime); $('plEnd').textContent = fmtTime(e.endTime);
    if (!S.seeking && e.endTime > 0) { $('rngSeek').value = Math.round(e.currentTime / e.endTime * 1000); paintRange($('rngSeek')); }
    loopCycleCheck(e.currentTick);
    S.lastTick = e.currentTick;
    if (!S.playing) scheduleIdle();   // parado: ao mudar de lugar, o instrumento mostra as notas dali
  });
  // depois de trocar de música: espera o MIDI e o desenho ficarem prontos (o trecho depende dos dois)
  const midiWaiters = []; let waitMidi = false, waitRender = false;
  function runWaiters() { if (waitMidi || waitRender) return; midiWaiters.splice(0).forEach(f => { try { f(); } catch (e) { console.error(e); } }); }
  api.midiLoaded.on(() => { applyMix(); waitMidi = false; runWaiters(); scheduleIdle(); });
  api.postRenderFinished.on(() => { waitRender = false; runWaiters(); });
  function afterMidi(fn) { midiWaiters.push(fn); runWaiters(); }
  api.playedBeatChanged.on(beat => { if (beat && beat.voice) tbar.setPos(beat.voice.bar.index, S.playing); });
  api.playbackRangeChanged.on(e => {
    const rb = rangeBars(e.playbackRange); tbar.setRange(rb);
    if (rb && !$('loopPanel').hidden) { $('lpStart').value = rb[0] + 1; $('lpEnd').value = rb[1] + 1; }
  });
  // painel de repetição aberto: tocar num compasso preenche o campo escolhido
  api.beatMouseDown.on(beat => {
    if ($('loopPanel').hidden || !S.loopPick || !beat) return;
    const bar = beat.voice.bar.index + 1;
    if (S.loopPick === 'start') { $('lpStart').value = bar; if (+$('lpEnd').value < bar) $('lpEnd').value = bar; setLoopPick('end'); }
    else { $('lpEnd').value = bar; if (+$('lpStart').value > bar) $('lpStart').value = bar; setLoopPick(null); }
    previewLoop();
  });
  api.renderFinished.on(() => {
    if (S.pendingScroll) { const p = S.pendingScroll; S.pendingScroll = null; viewport.scrollTop = p.top; viewport.scrollLeft = p.left; }
  });
  api.postRenderFinished.on(() => { drawCursor(); });
  api.beatMouseDown.on(beat => {
    if (!S.edit || !beat) return;
    const c = Ops.cursorFromBeat(beat, S.cur.string);
    if (c.track !== S.cur.track) return;
    S.cur = Ops.clampCursor(S.score, c);
    updateEditor(); drawCursor();
  });
  api.noteMouseDown.on(note => {
    if (!S.edit || !note) return;
    const c = Ops.cursorFromBeat(note.beat, note.string);
    if (c.track !== S.cur.track) return;
    S.cur = Ops.clampCursor(S.score, c);
    updateEditor(); drawCursor();
  });
  api.activeBeatsChanged.on(e => {
    if (!S.fb || !S.playing || S.threeTrack < 0) return;
    const beats = e.activeBeats.filter(b => b.voice.bar.staff.track.index === S.threeTrack);
    if (!beats.length) return;
    let dur = 0; const notes = [], up = [];
    const look = S.vizMode && S.vizMode.startsWith('keys') ? 3500 : S.vizMode && S.vizMode.startsWith('drum') ? 2600 : 2500;
    for (const b of beats) {
      dur = Math.max(dur, b.playbackDuration * msPerTick(b.voice.bar.index));
      for (const n of b.notes) notes.push(noteFor3d(n));
      upcomingNotes(b, look, up);
    }
    S.fb.play(notes, dur, up, previewNotes(beats));
  });
  /* prévia: notas que ainda vão tocar até o fim do compasso atual + N compassos */
  function previewNotes(beats) {
    const P = +prefs.preview || 0; if (P <= 0) return [];
    const extra = P - 1, out = [];
    for (const b of beats) {
      const lastBar = b.voice.bar.index + extra;
      let x = b.nextBeat, guard = 0;
      while (x && x.voice.bar.index <= lastBar && guard++ < 600) {
        for (const n of x.notes) if (!n.isTieDestination) out.push(noteFor3d(n));
        x = x.nextBeat;
      }
    }
    return out;
  }
  /* próximas notas (para o 2D e o teclado se posicionarem antes) */
  function upcomingNotes(beat, ms, out) {
    let b = beat.nextBeat, acc = 0, guard = 0;
    let at = beat.playbackDuration * msPerTick(beat.voice.bar.index); // quando cada nota futura vai soar (ms a partir de agora)
    while (b && acc < ms && guard++ < 160) {
      for (const n of b.notes) { const o = noteFor3d(n); o.at = at; out.push(o); }
      const d = b.playbackDuration * msPerTick(b.voice.bar.index);
      acc += d; at += d;
      b = b.nextBeat;
    }
    return out;
  }
  function msPerTick(barIndex) {
    const bpm = Ops.getTempoAt(S.score, barIndex) || 120;
    return 60000 / (bpm * TICKS_PER_QUARTER) / (api.playbackSpeed || 1);
  }
  /* bateria: número General MIDI da peça (36 = bumbo, 38 = caixa, 42 = chimbal…) */
  function drumMidi(n) {
    const tr = n.beat.voice.bar.staff.track;
    const a = tr.percussionArticulations && tr.percussionArticulations[n.percussionArticulation];
    return a ? a.outputMidiNumber : (n.percussionArticulation >= 0 ? n.percussionArticulation : n.realValue);
  }
  function usedDrums(t) {
    const set = new Set();
    for (const st of t.staves) for (const bar of st.bars) for (const v of bar.voices) for (const b of v.beats) for (const n of b.notes) set.add(drumMidi(n));
    return [...set];
  }
  function noteFor3d(n) {
    if (n.beat.voice.bar.staff.isPercussion || n.beat.voice.bar.staff.track.playbackInfo.primaryChannel === 9) {
      return { drum: drumMidi(n), dyn: n.dynamics, ghost: !!n.isGhost, accent: n.accentuated || 0, tie: n.isTieDestination };
    }
    let slideTo = null;
    if (n.slideTarget) slideTo = n.slideTarget.fret;
    else if (n.slideOutType === at.model.SlideOutType.OutUp) slideTo = n.fret + 4;
    else if (n.slideOutType === at.model.SlideOutType.OutDown) slideTo = Math.max(0, n.fret - 4);
    // com capotraste, a casa no braço é a do capotraste + a da tablatura
    const capo = n.beat.voice.bar.staff.capo || 0;
    if (capo && slideTo != null) slideTo += capo;
    return {
      string: n.string, fret: n.fret + capo,
      bend: n.hasBend && n.bendPoints ? n.bendPoints.map(p => ({ offset: p.offset, value: p.value })) : null,
      vibrato: n.vibrato || (n.beat.vibrato || 0),
      slideTo, dead: n.isDead, tie: n.isTieDestination, harmonic: !!n.harmonicType,
      pitch: n.realValue,
      // piano com duas pautas: sol = mão direita, fá = mão esquerda
      hand: n.beat.voice.bar.staff.track.staves.length > 1 ? (n.beat.voice.bar.staff.index === 0 ? 'R' : 'L') : null
    };
  }

  /* ---------------- player ---------------- */
  $('btnPlay').onclick = () => { if (!S.score) return; if (!S.playing) Wake.request(); api.playPause(); };
  $('btnStop').onclick = () => { api.stop(); };
  /* pautas (linhas da partitura): ⏪ volta uma, ⏩ avança uma, ⏮ volta ao início */
  function systemBars() {
    try { const bl = api.boundsLookup; return bl && bl.staffSystems ? bl.staffSystems.map(s => s.bars.map(b => b.index)).filter(a => a.length) : []; } catch (e) { return []; }
  }
  function jumpSystem(dir) {
    if (!S.score) return;
    const n = S.score.masterBars.length, cur = S.edit ? S.cur.bar : tbar.cur;
    const sys = systemBars();
    let bar;
    if (!sys.length) bar = cur + dir * 4;
    else {
      let i = sys.findIndex(a => cur >= a[0] && cur <= a[a.length - 1]);
      if (i < 0) i = sys.findIndex(a => a[0] > cur) - 1;
      bar = sys[Math.max(0, Math.min(sys.length - 1, i + dir))][0];
    }
    seekToBar(Math.max(0, Math.min(n - 1, bar)));
  }
  $('btnPrevSys').onclick = () => jumpSystem(-1);
  $('btnNextSys').onclick = () => jumpSystem(1);
  $('btnHome').onclick = () => { if (S.score) seekToBar(0); };
  /* ▲ ▼ no topo: troca de instrumento (trilha) sem abrir a lista; do último volta ao primeiro e vice-versa */
  // trilha com som AGORA: tem nota no compasso onde está a música (só pausa nesse compasso = pula)
  function trackHasNotes(t, bar) {
    for (const st of t.staves) { const b = st.bars[bar]; if (b) for (const v of b.voices) for (const be of v.beats) if (!be.isRest && be.notes.length) return true; }
    return false;
  }
  function stepTrack(d) {
    if (!S.score) return;
    const n = S.score.tracks.length; if (n < 2) return;
    const skip = prefs.skipEmpty !== false, bar = Math.max(0, tbar.cur || 0);
    let i = S.primary;
    for (let k = 0; k < n - 1; k++) {
      i = ((i + d) % n + n) % n;
      if (!skip || trackHasNotes(S.score.tracks[i], bar)) break;
      if (k === n - 2) i = S.primary;
    }
    if (i === S.primary) { toast('Nenhuma outra trilha tem notas no compasso ' + (bar + 1)); return; }
    selectTrack(i);
    toast(S.score.tracks[i].name.trim() || 'Trilha ' + (i + 1));
  }
  $('chkSkipEmpty').checked = prefs.skipEmpty !== false;
  $('chkSkipEmpty').onchange = () => { prefs.skipEmpty = $('chkSkipEmpty').checked; savePrefs(); };
  $('btnTrkUp').onclick = () => stepTrack(-1);
  $('btnTrkDown').onclick = () => stepTrack(1);
  $('rngSeek').addEventListener('input', () => { S.seeking = true; });
  $('rngSeek').addEventListener('change', () => {
    S.seeking = false;
    if (S.endTime > 0) api.timePosition = $('rngSeek').value / 1000 * S.endTime;
  });
  $('selSpeed').onchange = () => { api.playbackSpeed = parseFloat($('selSpeed').value); if (S.loopProg) { S.loopProg = null; updateLoopStatus(); toast('Velocidade manual: aumento automático pausado'); } };
  function setMetro(on) { api.metronomeVolume = on ? 1 : 0; $('btnMetro').classList.toggle('on', !!on); }
  function setCountIn(on) { S.tempCount = false; api.countInVolume = on ? 1 : 0; $('btnCountIn').classList.toggle('on', !!on); }
  $('btnMetro').onclick = () => setMetro(!$('btnMetro').classList.contains('on'));
  $('btnCountIn').onclick = () => setCountIn(!$('btnCountIn').classList.contains('on'));
  $('btnClearSel').onclick = () => { api.playbackRange = null; try { api.clearPlaybackRangeHighlight(); } catch (e) { /* versão sem destaque */ } tbar.setRange(null); toast('Trecho limpo'); };
  $('rngVol').oninput = () => { api.masterVolume = $('rngVol').value / 100; };
  api.masterVolume = 0.8;

  /* ---------------- repetição (início/fim e velocidade progressiva) ---------------- */
  function setSpeed(pct) {
    pct = Math.max(10, Math.min(300, Math.round(pct)));
    api.playbackSpeed = pct / 100;
    const sel = $('selSpeed'), val = String(pct / 100);
    if (![...sel.options].some(o => o.value === val)) {
      sel.querySelectorAll('option[data-custom]').forEach(o => o.remove());
      const o = document.createElement('option'); o.value = val; o.textContent = pct + '%'; o.dataset.custom = '1';
      const after = [...sel.options].find(x => +x.value > pct / 100); sel.insertBefore(o, after || null);
    }
    sel.value = val;
  }
  function setLoopPick(which) {
    S.loopPick = which;
    $('lpStart').classList.toggle('picking', which === 'start');
    $('lpEnd').classList.toggle('picking', which === 'end');
    $('lpHint').textContent = which ? 'Agora toque no compasso de ' + (which === 'start' ? 'início' : 'fim') + ' na partitura (ou digite).' : 'Toque num campo e depois no compasso da partitura.';
  }
  function loopBars() {
    const n = S.score ? S.score.masterBars.length : 1;
    let a = Math.round(+$('lpStart').value || 1), b = Math.round(+$('lpEnd').value || a);
    a = Math.max(1, Math.min(n, a)); b = Math.max(1, Math.min(n, b));
    if (b < a) [a, b] = [b, a];
    $('lpStart').value = a; $('lpEnd').value = b;
    return [a - 1, b - 1];
  }
  function previewLoop() { if (S.score) tbar.setRange(loopBars()); }
  function openLoopPanel() {
    if (!S.score) { toast('Abra uma música primeiro'); return; }
    const p = $('loopPanel'); p.hidden = false;
    // fica logo acima da barra de trilhas e do player, qualquer que seja a altura deles
    p.style.bottom = (document.body.classList.contains('inst-fs') ? ($('fsStrip').offsetHeight + $('fsCtl').offsetHeight + 20) : ($('player').offsetHeight + $('trackBar').offsetHeight + 8)) + 'px';
    const n = S.score.masterBars.length;
    if (tbar.range) { $('lpStart').value = tbar.range[0] + 1; $('lpEnd').value = tbar.range[1] + 1; }
    else { const a = (S.edit ? S.cur.bar : tbar.cur) + 1; $('lpStart').value = a; $('lpEnd').value = Math.min(n, a + 3); }
    $('lpStart').max = n; $('lpEnd').max = n;
    $('lpProgRow').classList.toggle('off', !$('lpProg').checked);
    setLoopPick('start');
    updateLoopStatus();
  }
  function updateLoopStatus() {
    const P = S.loopProg;
    $('lpStatus').textContent = api.isLooping ? (P ? 'Volta ' + (P.cycle + 1) + ' · ' + Math.round(api.playbackSpeed * 100) + '%' : 'Repetindo') : '';
    $('btnLoop').classList.toggle('on', !!api.isLooping);
  }
  function applyLoop(opt) {
    opt = opt || {};
    const [a, b] = loopBars();
    setRangeBars(a, b, true);
    api.isLooping = true;
    if ($('lpProg').checked) {
      const from = Math.max(10, Math.min(300, +$('lpFrom').value || 50)), to = Math.max(10, Math.min(300, +$('lpTo').value || 100)), step = Math.max(1, Math.min(100, +$('lpStep').value || 5));
      $('lpFrom').value = from; $('lpTo').value = to; $('lpStep').value = step;
      if (S.speedBeforeLoop == null) S.speedBeforeLoop = api.playbackSpeed;
      S.loopProg = { from, to, step, cycle: 0 };
      setSpeed(from);
    } else S.loopProg = null;
    setLoopPick(null); updateLoopStatus();
    if (opt.noPlay) return;
    if (!S.playing && S.playerReady) { Wake.request(); api.play(); }
    toast('Repetindo compassos ' + (a + 1) + ' a ' + (b + 1) + (S.loopProg ? ' — de ' + S.loopProg.from + '% até ' + S.loopProg.to + '%, +' + S.loopProg.step + '% por volta' : ''), 'ok', 4000);
  }
  function loopOff() {
    api.isLooping = false; S.loopProg = null;
    api.playbackRange = null; try { api.clearPlaybackRangeHighlight(); } catch (e) { /* nada */ }
    tbar.setRange(null);
    if (S.speedBeforeLoop != null) { setSpeed(S.speedBeforeLoop * 100); S.speedBeforeLoop = null; }
    setLoopPick(null); updateLoopStatus();
    toast('Repetição desligada');
  }
  /* cada vez que a música volta ao início do trecho, conta uma volta e acelera */
  function loopCycleCheck(tick) {
    const P = S.loopProg, R = api.playbackRange;
    if (!P || !api.isLooping || !S.playing || !R) return;
    if (tick < S.lastTick - 480 && Math.abs(tick - R.startTick) < TICKS_PER_QUARTER * 4) {
      P.cycle++;
      const dir = P.to >= P.from ? 1 : -1;
      const v = P.from + dir * P.step * P.cycle;
      setSpeed(dir > 0 ? Math.min(P.to, v) : Math.max(P.to, v));
      updateLoopStatus();
    }
  }
  $('btnLoop').onclick = () => { const p = $('loopPanel'); if (p.hidden) openLoopPanel(); else { p.hidden = true; setLoopPick(null); tbar.setRange(rangeBars(api.playbackRange)); } };
  $('lpClose').onclick = () => { $('loopPanel').hidden = true; setLoopPick(null); tbar.setRange(rangeBars(api.playbackRange)); };
  $('lpApply').onclick = () => applyLoop();
  $('lpOff').onclick = loopOff;
  ['lpStart', 'lpEnd'].forEach(id => {
    $(id).addEventListener('focus', () => setLoopPick(id === 'lpStart' ? 'start' : 'end'));
    $(id).addEventListener('click', () => setLoopPick(id === 'lpStart' ? 'start' : 'end'));
    $(id).addEventListener('change', previewLoop);
  });
  $('lpProg').onchange = () => $('lpProgRow').classList.toggle('off', !$('lpProg').checked);

  /* ---------------- trilhas / mixer ---------------- */
  function mixOf(i) { return S.mix[i] || (S.mix[i] = { mute: false, solo: false, vol: 1 }); }
  function applyMix() {
    if (!S.score) return;
    for (const t of S.score.tracks) {
      const m = S.mix[t.index]; if (!m) continue;
      api.changeTrackMute([t], m.mute); api.changeTrackSolo([t], m.solo); api.changeTrackVolume([t], m.vol);
    }
  }
  function buildTrackList() {
    const box = $('trackList'); box.innerHTML = '';
    if (!S.score) return;
    S.score.tracks.forEach(t => {
      const m = mixOf(t.index);
      const d = document.createElement('div');
      d.className = 'trk' + (S.primary === t.index ? ' editing' : '');
      d.innerHTML =
        '<input type="checkbox" title="Mostrar na partitura" ' + (S.tracks.includes(t.index) ? 'checked' : '') + (S.edit ? ' disabled' : '') + '>' +
        '<div class="tname" title="' + (S.edit ? 'Editar esta trilha' : 'Mostrar só esta trilha') + '">' + esc(t.name || ('Trilha ' + (t.index + 1))) + '</div>' +
        '<button class="mini-tog m' + (m.mute ? ' on' : '') + '" title="Mudo">M</button>' +
        '<button class="mini-tog s' + (m.solo ? ' on' : '') + '" title="Solo">S</button>' +
        '<div class="tinst">' + esc(instName(t)) + '</div>' +
        '<div class="vol">Vol <input type="range" min="0" max="150" value="' + Math.round(m.vol * 100) + '"></div>';
      const [chk, name, bm, bs] = [d.querySelector('input[type=checkbox]'), d.querySelector('.tname'), d.querySelector('.m'), d.querySelector('.s')];
      chk.onchange = () => {
        let tr = S.tracks.slice();
        if (chk.checked) { if (!tr.includes(t.index)) tr.push(t.index); } else tr = tr.filter(x => x !== t.index);
        if (!tr.length) { chk.checked = true; toast('Mostre pelo menos uma trilha'); return; }
        S.tracks = tr.sort((a, b) => a - b); if (chk.checked) S.primary = t.index; render(); refreshTrackUI();
      };
      name.onclick = e => selectTrack(t.index, e.ctrlKey || e.metaKey || e.shiftKey);
      bm.onclick = () => setMute(t.index);
      bs.onclick = () => setSolo(t.index);
      d.querySelector('.vol input').oninput = ev => { m.vol = ev.target.value / 100; api.changeTrackVolume([t], m.vol); };
      paintRange(d.querySelector('.vol input'));
      box.appendChild(d);
    });
  }
  const selNewTrack = $('selNewTrack');
  Object.entries(Ops.INSTRUMENTS).forEach(([k, v]) => { const o = document.createElement('option'); o.value = k; o.textContent = v.name; selNewTrack.appendChild(o); $('nInst').appendChild(o.cloneNode(true)); });
  $('nInst').value = 'guitar-dist';
  $('btnAddTrack').onclick = () => {
    commit(score => Ops.addTrack(score, selNewTrack.value, api.settings));
    setEditTrack(S.score.tracks.length - 1);
    toast('Trilha adicionada: ' + Ops.INSTRUMENTS[selNewTrack.value].name, 'ok');
  };
  $('btnDelTrack').onclick = async () => {
    if (!S.score) return;
    const t = S.score.tracks[S.cur.track];
    if (!(await confirmDlg('Remover trilha', 'Remover a trilha <b>' + esc(t.name) + '</b>? (dá para desfazer com Ctrl+Z)', 'Remover'))) return;
    const idx = S.cur.track;
    commit(score => Ops.removeTrack(score, idx, api.settings));
    setEditTrack(Math.max(0, idx - 1));
  };

  /* ---------------- edição ---------------- */
  function commit(fn, opts) {
    if (!S.score) return false;
    opts = opts || {};
    const before = Ops.snapshot(S.score);
    let result;
    try { result = fn(S.score, S.cur); }
    catch (e) { S.score = Ops.restore(before, api.settings); toast(e.message || String(e), 'err'); renderKeepScroll(); return false; }
    if (result === false) { if (!opts.silent) toast('Nada para alterar aqui (posicione numa nota)'); return false; }
    let ns;
    try { ns = (result instanceof at.model.Score) ? result : Ops.normalize(S.score, api.settings); }
    catch (e) {
      S.score = Ops.restore(before, api.settings);
      toast('Essa edição deixou a música inválida e foi desfeita: ' + (e.message || e), 'err');
      renderKeepScroll(); return false;
    }
    if (!opts.merge) { S.undo.push(before); S.undoChg.push(Object.assign({}, S.chg)); trimUndo(before.length); }
    S.chg = opts.chg ? opts.chg(Object.assign({}, S.chg)) : Object.assign({}, S.chg, { edited: true });
    S.redo = [];
    S.score = ns;
    Ops.clampCursor(S.score, S.cur);
    markDirty();
    renderKeepScroll(); tbar.setScore(S.score); updateEditor(); refreshTrackUI();
    return true;
  }
  // limita a memória do histórico (~150 MB de texto), mínimo de 10 passos
  function trimUndo(size) {
    const max = Math.max(10, Math.min(80, Math.floor(150e6 / Math.max(1, size * 2))));
    while (S.undo.length > max) { S.undo.shift(); S.undoChg.shift(); }
  }
  function undo() {
    if (S.test) endKeyTest();
    if (!S.undo.length) { toast('Nada para desfazer'); return; }
    S.redo.push(Ops.snapshot(S.score)); S.redoChg.push(S.chg);
    S.score = Ops.restore(S.undo.pop(), api.settings); S.chg = S.undoChg.pop() || { key: 0, edited: true };
    afterHistory();
  }
  function redo() {
    if (S.test) endKeyTest();
    if (!S.redo.length) { toast('Nada para refazer'); return; }
    S.undo.push(Ops.snapshot(S.score)); S.undoChg.push(S.chg);
    S.score = Ops.restore(S.redo.pop(), api.settings); S.chg = S.redoChg.pop() || { key: 0, edited: true };
    afterHistory();
  }
  function afterHistory() { Ops.clampCursor(S.score, S.cur); markDirty(); renderKeepScroll(); tbar.setScore(S.score); updateEditor(); refreshTrackUI(); }

  function markDirty() { S.dirty = true; updateTitle(); scheduleDraft(); }

  function toggleEdit(force) {
    if (!S.score) { toast('Abra ou crie uma música primeiro'); return; }
    const on = force === undefined ? !S.edit : force;
    if (on === S.edit) return;
    if (on && S.test) { endKeyTest(); toast('Teste de tom encerrado para editar (a música está no tom original)'); }
    S.edit = on;
    document.body.classList.toggle('editing', on);
    $('btnEdit').classList.toggle('on', on); $('btnEdit').querySelector('span').textContent = on ? 'Sair do modo edição' : 'Modo edição';
    $('editPanel').hidden = !on;
    if (on) {
      api.stop();
      S.viewTracksBeforeEdit = S.tracks.slice();
      let t = S.tracks.find(i => isStringed(S.score.tracks[i]));
      if (t === undefined) t = firstStringed(S.score);
      setEditTrack(t, true);
      viewport.focus();
    } else {
      S.tracks = (S.viewTracksBeforeEdit || [S.cur.track]).filter(i => i < S.score.tracks.length);
      if (!S.tracks.includes(S.cur.track)) S.tracks = [S.cur.track];
      S.primary = S.cur.track;
      removeCursor(); tbar.setEditBar(null); render(); refreshTrackUI();
    }
  }
  function setEditTrack(i, noRenderSkip) {
    if (!S.score) return;
    i = Math.max(0, Math.min(i, S.score.tracks.length - 1));
    const changed = S.cur.track !== i || noRenderSkip || S.tracks.length !== 1 || S.tracks[0] !== i;
    S.cur.track = i; Ops.clampCursor(S.score, S.cur);
    if (S.cur.track === i && S.edit) S.tracks = [i];
    S.primary = S.cur.track;
    if (changed) render();
    updateEditor(); refreshTrackUI();
  }

  function cursorBeat() { return S.score ? Ops.getBeat(S.score, S.cur) : null; }
  const DUR_NAMES = { 1: 'semibreve', 2: 'mínima', 4: 'semínima', 8: 'colcheia', 16: 'semicolcheia', 32: 'fusa', 64: 'semifusa' };

  function updateEditor() {
    if (!S.edit || !S.score) return;
    const t = S.score.tracks[S.cur.track];
    $('edTrackName').textContent = t.name;
    const stringed = isStringed(t);
    const beat = cursorBeat();
    const n = Ops.stringCount(S.score, S.cur);
    $('edPos').textContent = 'Compasso ' + (S.cur.bar + 1) + ' · Batida ' + (S.cur.beat + 1) + (stringed ? ' · Corda ' + (n + 1 - S.cur.string) : '') +
      (beat ? ' · ' + (DUR_NAMES[beat.duration] || beat.duration) + (beat.dots ? ' pontuada' : '') + (beat.isRest ? ' (pausa)' : '') : '');
    const fill = Ops.barFillState(S.score, S.cur.track, S.cur.bar);
    const fe = $('edFill');
    const q = d => { const v = Math.abs(d) / TICKS_PER_QUARTER; return (Math.round(v * 100) / 100).toString().replace('.', ',') + ' tempo(s)'; };
    fe.className = 'ed-fill ' + fill.state;
    fe.textContent = fill.state === 'ok' ? '✓ Compasso completo' : (fill.state === 'short' ? '⚠ Faltam ' + q(fill.expected - fill.actual) + ' neste compasso' : '⚠ Passou ' + q(fill.actual - fill.expected) + ' do compasso');
    // cordas
    const sv = $('stringsView'); sv.innerHTML = '';
    if (stringed) {
      const tun = trackTuning(t);
      for (let s = n; s >= 1; s--) {
        const note = beat ? Ops.findNote(beat, s) : null;
        const row = document.createElement('div');
        row.className = 'sv' + (s === S.cur.string ? ' cur' : '');
        const midi = tun[tun.length - s];
        row.innerHTML = '<span class="sn">' + (n + 1 - s) + 'ª ' + (midi !== undefined ? NOTE_NAMES[midi % 12] : '') + '</span><span class="sf">' + (note ? (note.isDead ? 'x' : note.fret) + (note.isTieDestination ? ' (lig.)' : '') : '–') + '</span>';
        row.onclick = () => { S.cur.string = s; updateEditor(); drawCursor(); };
        sv.appendChild(row);
      }
    } else {
      sv.innerHTML = '<div class="muted">Esta trilha não é de cordas. Por enquanto o editor trabalha com tablatura (guitarra, violão, baixo). A edição pela partitura entra na próxima etapa.</div>';
    }
    // duração atual
    document.querySelectorAll('#durRow [data-dur]').forEach(b => b.classList.toggle('on', beat && +b.dataset.dur === beat.duration));
    // compasso
    const mb = S.score.masterBars[S.cur.bar];
    $('inTempo').value = Ops.getTempoAt(S.score, S.cur.bar);
    $('inNum').value = mb.timeSignatureNumerator; $('inDen').value = String(mb.timeSignatureDenominator);
    buildTuningSelect(t);
    $('btnUndo').disabled = !S.undo.length; $('btnRedo').disabled = !S.redo.length;
    tbar.setEditBar(S.cur.bar); if (!S.playing) tbar.setPos(S.cur.bar);
    show3dIdle();
  }

  const TUNINGS = {
    6: [['Padrão (E A D G B E)', [64, 59, 55, 50, 45, 40]], ['Drop D', [64, 59, 55, 50, 45, 38]], ['Meio tom abaixo (Eb)', [63, 58, 54, 49, 44, 39]], ['Um tom abaixo (D)', [62, 57, 53, 48, 43, 38]], ['Drop C', [62, 57, 53, 48, 43, 36]], ['DADGAD', [62, 57, 55, 50, 45, 38]], ['Open G', [62, 59, 55, 50, 43, 38]], ['Open D', [62, 57, 54, 50, 45, 38]], ['Open E', [64, 59, 56, 52, 47, 40]]],
    7: [['Padrão 7 cordas (B)', [64, 59, 55, 50, 45, 40, 35]], ['Drop A', [64, 59, 55, 50, 45, 40, 33]]],
    4: [['Padrão baixo (E A D G)', [43, 38, 33, 28]], ['Drop D', [43, 38, 33, 26]], ['Meio tom abaixo', [42, 37, 32, 27]]],
    5: [['Padrão baixo 5 (B E A D G)', [43, 38, 33, 28, 23]]]
  };
  function buildTuningSelect(t) {
    const sel = $('selTuning'); const tun = trackTuning(t);
    const list = TUNINGS[tun.length] || [];
    const curKey = tun.join(',');
    sel.innerHTML = '';
    let found = false;
    list.forEach(([name, arr]) => { const o = document.createElement('option'); o.value = arr.join(','); o.textContent = name; if (o.value === curKey) { o.selected = true; found = true; } sel.appendChild(o); });
    if (!found && tun.length) { const o = document.createElement('option'); o.value = curKey; o.textContent = 'Atual: ' + tun.slice().reverse().map(midiName).join(' '); o.selected = true; sel.prepend(o); }
    sel.disabled = !tun.length; $('btnApplyTuning').disabled = !tun.length;
  }
  $('btnApplyTuning').onclick = () => {
    const arr = $('selTuning').value.split(',').map(Number);
    const ti = S.cur.track;
    commit(score => Ops.setTuning(score, ti, arr));
    toast('Afinação aplicada (as casas foram mantidas; o som muda conforme a afinação)');
  };
  $('btnApplyBar').onclick = () => {
    const bpm = parseInt($('inTempo').value, 10), num = parseInt($('inNum').value, 10), den = parseInt($('inDen').value, 10);
    const bi = S.cur.bar;
    if (!(bpm >= 20 && bpm <= 400)) { toast('Andamento deve ficar entre 20 e 400', 'err'); return; }
    if (!(num >= 1 && num <= 32)) { toast('Fórmula de compasso inválida', 'err'); return; }
    commit(score => {
      let ch = false;
      if (Ops.getTempoAt(score, bi) !== bpm) { Ops.setTempo(score, bi, bpm); ch = true; }
      const mb = score.masterBars[bi];
      if (mb.timeSignatureNumerator !== num || mb.timeSignatureDenominator !== den) { Ops.setTimeSignature(score, bi, num, den); ch = true; }
      return ch;
    });
  };

  // teclado de casas
  (function buildFretPad() {
    const pad = $('fretPad');
    for (let f = 0; f <= 24; f++) {
      const b = document.createElement('button'); b.textContent = f;
      if ([3, 5, 7, 9, 12, 15, 17, 19, 21, 24].includes(f)) b.className = 'dot';
      b.onclick = () => edSetFret(f);
      pad.appendChild(b);
    }
    const x = document.createElement('button'); x.textContent = 'x'; x.title = 'Nota abafada'; x.onclick = () => edAction('dead'); pad.appendChild(x);
    const r = document.createElement('button'); r.textContent = '𝄽'; r.title = 'Pausa'; r.onclick = () => edAction('rest'); pad.appendChild(r);
    const tt = document.createElement('button'); tt.textContent = '‿'; tt.title = 'Ligar com a anterior'; tt.onclick = () => edAction('tie'); pad.appendChild(tt);
  })();

  function requireStringed() {
    if (!isStringed(S.score.tracks[S.cur.track])) { toast('Esta trilha não é de cordas — edição por partitura vem na próxima etapa'); return false; }
    return true;
  }
  function edSetFret(f, merge) {
    if (!S.edit || !requireStringed()) return;
    if (commit((sc, c) => Ops.setFret(sc, c, f), { merge })) previewNote();
  }
  function previewNote() {
    const b = cursorBeat(); if (!b || !S.playerReady) return;
    const n = Ops.findNote(b, S.cur.string);
    try { if (n) api.playNote(n); } catch (e) { /* prévia de som é opcional */ }
  }
  const DURS = [1, 2, 4, 8, 16, 32, 64];
  function edAction(act, arg) {
    if (!S.edit || !S.score) return;
    const c = S.cur;
    switch (act) {
      case 'left': Ops.moveBeat(S.score, c, -1); break;
      case 'right': Ops.moveBeat(S.score, c, 1); break;
      case 'up': c.string = Math.min(Ops.stringCount(S.score, c), c.string + 1); break;
      case 'down': c.string = Math.max(1, c.string - 1); break;
      case 'barPrev': c.bar = Math.max(0, c.bar - 1); c.beat = 0; Ops.clampCursor(S.score, c); break;
      case 'barNext': c.bar = Math.min(S.score.masterBars.length - 1, c.bar + 1); c.beat = 0; Ops.clampCursor(S.score, c); break;
      case 'delNote': commit((sc, cc) => Ops.deleteNote(sc, cc)); return;
      case 'dot': commit((sc, cc) => Ops.toggleDot(sc, cc)); return;
      case 'triplet': commit((sc, cc) => Ops.setTuplet(sc, cc, 3, 2)); return;
      case 'rest': commit((sc, cc) => Ops.makeRest(sc, cc)); return;
      case 'insBeat': commit((sc, cc) => Ops.insertBeatAfter(sc, cc)); return;
      case 'insBeatBefore': commit((sc, cc) => Ops.insertBeatBefore(sc, cc)); return;
      case 'delBeat': commit((sc, cc) => Ops.deleteBeat(sc, cc)); return;
      case 'insBar': commit((sc, cc) => { Ops.insertBar(sc, cc.bar); cc.bar++; cc.beat = 0; return true; }); return;
      case 'delBar': commit((sc, cc) => Ops.deleteBar(sc, cc.bar)); return;
      case 'copyBar': S.clip = Ops.copyBar(S.score, c); toast('Compasso ' + (c.bar + 1) + ' copiado'); return;
      case 'pasteBar': if (!S.clip) { toast('Copie um compasso primeiro'); return; } commit((sc, cc) => Ops.pasteBar(sc, cc, S.clip)); return;
      case 'repStart': commit((sc, cc) => Ops.toggleRepeat(sc, cc.bar, 'start')); return;
      case 'repEnd': commit((sc, cc) => Ops.toggleRepeat(sc, cc.bar, 'end')); return;
      case 'durLonger': case 'durShorter': {
        const b = cursorBeat(); if (!b) return;
        let i = DURS.indexOf(b.duration); if (i < 0) i = 2;
        i = act === 'durLonger' ? Math.max(0, i - 1) : Math.min(DURS.length - 1, i + 1);
        commit((sc, cc) => Ops.setDuration(sc, cc, DURS[i])); return;
      }
      case 'dur': commit((sc, cc) => Ops.setDuration(sc, cc, arg)); return;
      default:
        if (!requireStringed()) return;
        commit((sc, cc) => Ops.toggleEffect(sc, cc, act, arg)); return;
    }
    updateEditor(); drawCursor(); ensureCursorVisible();
  }
  document.querySelectorAll('[data-ed]').forEach(b => b.addEventListener('click', () => edAction(b.dataset.ed)));
  document.querySelectorAll('[data-dur]').forEach(b => b.addEventListener('click', () => edAction('dur', +b.dataset.dur)));
  document.querySelectorAll('[data-fx]').forEach(b => b.addEventListener('click', () => edAction(b.dataset.fx, b.dataset.arg ? +b.dataset.arg : undefined)));
  $('btnUndo').onclick = undo; $('btnRedo').onclick = redo;

  /* cursor desenhado sobre a partitura */
  let curEl = null;
  function removeCursor() { if (curEl) { curEl.remove(); curEl = null; } }
  function tabVisibleFor(track) {
    if (!isStringed(track)) return false;
    const p = effStave();
    if (p === 'Score') return false;

    return true;
  }
  function drawCursor() {
    if (!S.edit || !S.score || !api.boundsLookup) { removeCursor(); return; }
    const beat = cursorBeat(); if (!beat) { removeCursor(); return; }
    let list = [];
    try { list = api.boundsLookup.findBeats(beat) || []; } catch (e) { list = []; }
    if (!list.length) { removeCursor(); return; }
    if (!curEl) { curEl = document.createElement('div'); curEl.id = 'edCursor'; curEl.innerHTML = '<div class="col"></div><div class="str"></div>'; }
    if (curEl.parentNode !== atEl) atEl.appendChild(curEl);
    curEl.style.left = '0'; curEl.style.top = '0';
    let x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity;
    for (const bb of list) {
      const v = bb.visualBounds, br = bb.barBounds.realBounds;
      x1 = Math.min(x1, v.x); x2 = Math.max(x2, v.x + Math.max(v.w, 14));
      y1 = Math.min(y1, br.y); y2 = Math.max(y2, br.y + br.h);
    }
    const col = curEl.querySelector('.col');
    Object.assign(col.style, { left: (x1 - 4) + 'px', top: (y1 - 6) + 'px', width: (x2 - x1 + 8) + 'px', height: (y2 - y1 + 12) + 'px' });
    const str = curEl.querySelector('.str');
    const track = S.score.tracks[S.cur.track];
    if (tabVisibleFor(track)) {
      const tab = list[list.length - 1];
      const n = Ops.stringCount(S.score, S.cur);
      const br = tab.barBounds.realBounds;
      const sp = n > 1 ? br.h / (n - 1) : 0;
      const y = br.y + (n - S.cur.string) * sp;
      Object.assign(str.style, { display: 'block', left: (tab.visualBounds.x - 3) + 'px', width: (Math.max(tab.visualBounds.w, 14) + 6) + 'px', top: (y - 7) + 'px' });
    } else str.style.display = 'none';
    S._curBox = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  function ensureCursorVisible() {
    const b = S._curBox; if (!b) return;
    const ox = atEl.offsetLeft, oy = atEl.offsetTop;
    const top = oy + b.y - 40, bottom = oy + b.y + b.h + 40, left = ox + b.x - 60, right = ox + b.x + b.w + 60;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (bottom > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = bottom - viewport.clientHeight;
    if (left < viewport.scrollLeft) viewport.scrollLeft = left;
    else if (right > viewport.scrollLeft + viewport.clientWidth) viewport.scrollLeft = right - viewport.clientWidth;
  }
  api.postRenderFinished.on(() => { if (S.edit) ensureCursorVisible(); });

  /* ---------------- teclado ---------------- */
  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || document.querySelector('dialog[open]')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (ctrl && (k === 'o' || k === 'O')) { e.preventDefault(); $('fileInput').click(); return; }
    if (ctrl && (k === 's' || k === 'S')) { e.preventDefault(); if (e.shiftKey) saveAsFile(); else saveGp(); return; }
    if (k === ' ' && !ctrl) { e.preventDefault(); if (S.score && S.playerReady) { if (!S.playing) Wake.request(); api.playPause(); } return; }
    if (!ctrl && (k === 'e' || k === 'E') && !S.edit) { toggleEdit(true); return; }
    if (!S.edit && !ctrl && (k === 'ArrowLeft' || k === 'ArrowRight') && S.score) { e.preventDefault(); stepNote(k === 'ArrowRight' ? 1 : -1); return; }
    if (!S.edit) return;
    if (ctrl && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (ctrl && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); return; }
    if (ctrl && (k === 'c' || k === 'C')) { e.preventDefault(); edAction('copyBar'); return; }
    if (ctrl && (k === 'v' || k === 'V')) { e.preventDefault(); edAction('pasteBar'); return; }
    if (ctrl) return;
    if (/^[0-9]$/.test(k)) {
      e.preventDefault();
      const now = e.timeStamp || Date.now(); let v = +k, merge = false;
      if (S.fretBuf && now - S.fretT < 1200 && +(S.fretBuf + k) <= 30) { v = +(S.fretBuf + k); S.fretBuf = ''; merge = true; }
      else S.fretBuf = k;
      S.fretT = now;
      edSetFret(v, merge); return;
    }
    const map = {
      ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', PageUp: 'barPrev', PageDown: 'barNext',
      Delete: e.shiftKey ? 'delBeat' : 'delNote', Backspace: e.shiftKey ? 'delBeat' : 'delNote', Insert: 'insBeat', Enter: 'insBeat',
      '.': 'dot', '+': 'durShorter', '-': 'durLonger', r: 'rest', R: 'rest', t: 'tie', T: 'tie', v: 'vibrato', V: 'vibrato', b: 'bend', B: 'bend',
      p: 'palmMute', P: 'palmMute', h: 'hammer', H: 'hammer', s: 'slide', S: 'slide', x: 'dead', X: 'dead', l: 'letRing', L: 'letRing', g: 'ghost', G: 'ghost'
    };
    const a = map[k];
    if (a) { e.preventDefault(); edAction(a, a === 'bend' ? 4 : undefined); }
    if (k === 'Escape') toggleEdit(false);
  });

  /* ---------------- salvar / exportar ---------------- */
  function safeName(n) { return (n || 'musica').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'musica'; }
  /* ---------------- salvar ----------------
     Salvar        → grava a versão nova DENTRO do app (recentes e repertório). O arquivo de origem nunca é alterado,
                     e a primeira vez guarda a versão original nos recentes com "(original)" no nome.
     Salvar como   → gera um arquivo .gp novo, com o que mudou no fim do nome: "Música (+1 tom).gp".
     Baixar arquivo→ baixa o arquivo como está (sem alterações: o arquivo original, no formato original). */
  // pergunta o que fazer com um teste de tom ligado; devolve false se cancelou
  async function settleKeyTest() {
    if (!S.test) return true;
    const v = await showMsg('Teste de tom ativo', 'Você está ouvindo a música <b>' + Tr.tomText(S.test.n) + '</b> só como teste. Usar o tom original ou aplicar o tom novo antes?',
      [{ label: 'Cancelar', value: 'cancel' }, { label: 'Usar o original', value: 'orig' }, { label: 'Aplicar o tom novo', value: 'apply', primary: true }]);
    if (v === 'orig') { endKeyTest(); return true; }
    if (v === 'apply') return applyKey();
    return false;
  }
  // exporta e confere (nada é gravado se a conferência falhar)
  function exportChecked() {
    let data, check;
    try {
      data = new at.exporter.Gp7Exporter().export(S.score, api.settings);
      check = at.importer.ScoreLoader.loadScoreFromBytes(data, api.settings);
    } catch (e) {
      showMsg('Falha ao salvar', 'A música <b>não</b> foi salva porque a conversão falhou:<br><span class="muted">' + esc(e.message || e) + '</span><br><br>Seu trabalho continua aberto e no rascunho automático.');
      return null;
    }
    const n1 = Ops.countNotes(S.score), n2 = Ops.countNotes(check);
    if (n1 !== n2 || check.masterBars.length !== S.score.masterBars.length || check.tracks.length !== S.score.tracks.length) {
      showMsg('Verificação falhou', 'O arquivo gerado não confere com a música aberta (notas ' + n1 + ' → ' + n2 + ', compassos ' + S.score.masterBars.length + ' → ' + check.masterBars.length + '). Por segurança ele <b>não</b> foi salvo. Seu trabalho continua no rascunho automático.');
      return null;
    }
    return { data, notes: n2, bars: check.masterBars.length };
  }
  const baseName = () => safeName((S.fileName || (S.score && S.score.title) || 'musica').replace(/\s*\(original\)\s*$/i, ''));
  function changeSuffix() {
    const p = [];
    if (S.chg.key) p.push(Tr.tomShort(S.chg.key));
    if (S.chg.edited) p.push('editada');
    return p.length ? ' (' + p.join(', ') + ')' : '';
  }
  // na primeira gravação, a versão original fica nos recentes como "(original)"
  async function keepOriginal() {
    if (S.origKept || !S.origId) return;
    try {
      const list = await getRecent(), m = list.find(x => x.id === S.origId);
      const mark = nm => /\(original\)/i.test(nm) ? nm : nm.replace(/\.[^.]+$/, '') + ' (original)' + ((/\.[^.]+$/.exec(nm) || [''])[0]);
      if (m) { if (m.name !== mark(m.name)) { m.name = mark(m.name); await Store.set('recent', list); } }
      else if (S.curBytes) await addRecent(S.curBytes, mark(S.srcName || (baseName() + '.gp')));   // veio do repertório: guarda a original nos recentes
      S.origKept = true;
    } catch (e) { /* segue: o arquivo de origem continua no aparelho */ }
  }
  async function saveGp() {
    if (!S.score) { toast('Nada para salvar'); return false; }
    if (!(await settleKeyTest())) return false;
    const r = exportChecked(); if (!r) return false;
    await keepOriginal();
    const name = baseName() + '.gp';
    // música dos recentes: o arquivo novo leva os ajustes já aplicados; música nova passa a ter os de agora
    const carry = S.rep ? undefined : (S.recId ? S.repBase : (captureSettings() || undefined));
    const stored = await addRecent(r.data, name, carry);
    if (!stored) {
      showMsg('Não foi possível salvar', 'A música <b>não</b> foi gravada no app (sem espaço no aparelho ou arquivo grande demais). Use <b>Salvar como</b> para gerar o arquivo. Seu trabalho continua aberto e no rascunho automático.');
      return false;
    }
    S.dirty = false; updateTitle(); clearDraft();
    const oldId = curFileId();
    S.curBytes = r.data; S.srcName = name; S.origId = null;
    await favFollow(oldId, r.data, name);
    if (!S.rep) { S.recId = hashBytes(r.data); if (carry) S.repBase = JSON.parse(JSON.stringify(carry)); }
    if (Rep) Rep.onSaved(r.data);
    toast('Salvo no app: ' + name + ' (' + r.notes + ' notas, ' + r.bars + ' compassos)' + (S.rep ? ' — repertório atualizado' : '') + '. O arquivo de origem não foi alterado; para ter o arquivo, use "Salvar como" ou "Baixar".', 'ok', 6500);
    return true;
  }
  async function saveAsFile() {
    if (!S.score) { toast('Nada para salvar'); return false; }
    if (!(await settleKeyTest())) return false;
    const r = exportChecked(); if (!r) return false;
    const name = baseName() + changeSuffix() + '.gp';
    let how = null, shownName = name;
    try {
      if (window.showSaveFilePicker && !FRAMED) {
        const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Guitar Pro 7/8', accept: { 'application/octet-stream': ['.gp'] } }] });
        const w = await h.createWritable(); await w.write(new Blob([r.data])); await w.close(); how = 'file'; shownName = h.name;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') { toast('Salvamento cancelado'); return false; }
      how = null;
    }
    if (!how) {
      const d = await deliverFile(r.data, name);
      if (d !== 'download' && d !== 'zip') { fileNotDelivered(d); return false; }
      how = d; if (d === 'zip') shownName = name + '.zip';
    }
    await keepOriginal();
    S.dirty = false; updateTitle(); clearDraft();
    const oldId = curFileId();
    await favFollow(oldId, r.data, shownName.replace(/\.zip$/i, ''));
    S.curBytes = r.data; S.srcName = shownName.replace(/\.zip$/i, ''); S.fileName = S.srcName.replace(/\.gp$/i, ''); S.origId = null;
    S.chg = { key: 0, edited: false };
    const carry = S.rep ? undefined : (S.recId ? S.repBase : (captureSettings() || undefined));
    if (await addRecent(r.data, S.srcName, carry) && !S.rep) { S.recId = hashBytes(r.data); if (carry) S.repBase = JSON.parse(JSON.stringify(carry)); }
    if (Rep) Rep.onSaved(r.data);
    updateTitle();
    toast((how === 'file' ? 'Salvo' : 'Baixado') + ' e verificado: ' + shownName + ' (' + r.notes + ' notas, ' + r.bars + ' compassos)' + (how === 'zip' ? ' — o .gp está dentro do .zip' : ''), 'ok', 5000);
    return true;
  }
  // baixa como está: sem alterações vai o arquivo original (no formato dele); com alterações, um .gp conferido
  async function downloadFile() {
    if (!S.score) { toast('Abra uma música primeiro'); return false; }
    if (!(await settleKeyTest())) return false;
    let data, name;
    if (!S.dirty && S.curBytes) { data = S.curBytes; name = (S.srcName || (baseName() + '.gp')).replace(/\s*\(original\)(?=\.[^.]+$|$)/i, ''); }
    else { const r = exportChecked(); if (!r) return false; data = r.data; name = baseName() + changeSuffix() + '.gp'; }
    const d = await deliverFile(data, name);
    if (d !== 'download' && d !== 'zip') { fileNotDelivered(d); return false; }
    toast('Baixado: ' + name + (d === 'zip' ? ' (dentro de um .zip)' : ''), 'ok', 4500);
    return true;
  }
  /* Entrega um arquivo ao usuário. Fora do link de visualização: download normal.
     Dentro do link do Claude (moldura protegida): só pela permissão de downloads, em .zip. */
  async function deliverFile(bytes, name) {
    if (!FRAMED) { downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), name); return 'download'; }
    let dl = null;
    try { dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch (e) { dl = null; }
    if (!dl) return 'unavailable';
    try { await dl.save({ filename: name + '.zip', data: new Blob([zipStore([{ name, data: bytes }])]) }); return 'zip'; }
    catch (e) { return e && e.code === 'declined' ? 'declined' : 'unavailable'; }
  }
  function fileNotDelivered(r) {
    if (r === 'declined') { toast('Download recusado — nada foi salvo. O trabalho continua no rascunho automático.', 'err', 6000); return; }
    showMsg('Não foi possível baixar aqui', 'Neste link de visualização o navegador não permite baixar arquivos. <b>Nada foi perdido</b>: o trabalho continua aberto e no rascunho automático.<br><br>Para salvar, use a versão instalada (pacote .zip do app hospedado no seu servidor).');
  }
  function downloadBlob(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  /* ZIP simples (sem compressão) */
  const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zipStore(files) { return zipBuild(files, false); }
  // backup grande: devolve um Blob em partes (não junta tudo num bloco só de memória)
  function zipBlob(files) { return zipBuild(files, true); }
  function zipBuild(files, asBlob) {
    const enc = new TextEncoder(); const parts = []; const central = []; let off = 0;
    // data/hora no formato do zip (sem isso alguns programas reclamam de "data antes de 1980")
    const now = new Date(), dTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), dDate = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const f of files) {
      const nm = enc.encode(f.name), d = f.data, crc = crc32(d);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true); lh.setUint16(10, dTime, true); lh.setUint16(12, dDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, d.length, true); lh.setUint32(22, d.length, true); lh.setUint16(26, nm.length, true);
      parts.push(new Uint8Array(lh.buffer), nm, d);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(12, dTime, true); ch.setUint16(14, dDate, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, d.length, true); ch.setUint32(24, d.length, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), nm);
      off += 30 + nm.length + d.length;
    }
    const csize = central.reduce((a, b) => a + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, csize, true); end.setUint32(16, off, true);
    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    if (asBlob) return new Blob(all, { type: 'application/zip' });
    const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0)); let p = 0;
    for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }
  async function exportMidi() {
    if (!S.score) return;
    let bytes;
    try {
      const mf = new at.midi.MidiFile();
      const h = new at.midi.AlphaSynthMidiFileHandler(mf, true);
      new at.midi.MidiFileGenerator(S.score, api.settings, h).generate();
      bytes = mf.toBinary();
    } catch (e) { toast('Falha ao gerar MIDI: ' + e.message, 'err'); return; }
    const r = await deliverFile(bytes, safeName(S.fileName || S.score.title) + '.mid');
    if (r === 'download' || r === 'zip') toast('MIDI exportado' + (r === 'zip' ? ' (dentro do .zip)' : ''), 'ok'); else fileNotDelivered(r);
  }
  function printScore() {
    if (!S.score) { toast('Abra uma música primeiro'); return; }
    if (FRAMED) { showMsg('Impressão', 'Neste link de visualização o navegador bloqueia a impressão. Na versão instalada do app, <b>Imprimir / PDF</b> abre a partitura pronta para imprimir ou salvar em PDF.'); return; }
    try { api.print(); }
    catch (e) { toast('Janela de impressão bloqueada — usando a impressão do navegador'); setTimeout(() => window.print(), 300); }
  }

  /* ---------------- rascunho automático ---------------- */
  let draftT = 0;
  function scheduleDraft() {
    clearTimeout(draftT);
    draftT = setTimeout(() => {
      if (!S.score || !S.dirty) return;
      Store.set('draft', { json: S.test ? S.test.base : Ops.snapshot(S.score), name: S.fileName, time: Date.now(), v: APP_VERSION })
        .catch(e => toast('Atenção: não foi possível gravar o rascunho automático (' + e.message + '). Salve o arquivo para não perder o trabalho.', 'err', 8000));
    }, 1200);
  }
  // ao sair/trocar de app, grava o rascunho na hora (sem esperar o intervalo)
  function flushDraft() {
    if (!S.score || !S.dirty) return;
    clearTimeout(draftT);
    try { Store.set('draft', { json: Ops.snapshot(S.score), name: S.fileName, time: Date.now(), v: APP_VERSION }).catch(() => { /* aviso já é dado no salvamento normal */ }); } catch (e) { /* sem IndexedDB */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDraft(); });
  window.addEventListener('pagehide', flushDraft);
  function clearDraft() { Store.del('draft').catch(() => { /* sem rascunho */ }); }
  function checkDraft() {
    Store.get('draft').then(d => {
      if (!d || !d.json) return;
      const box = $('draftBox');
      box.innerHTML = '<b>Rascunho não salvo encontrado</b><div class="muted">' + esc(d.name || 'Sem título') + ' — ' + new Date(d.time).toLocaleString('pt-BR') + '</div><div class="row"><button class="btn primary sm" id="dRec">Recuperar</button><button class="btn sm danger" id="dDel">Descartar</button></div>';
      box.hidden = false;
      $('dRec').onclick = () => {
        try { const sc = Ops.restore(d.json, api.settings); setScore(sc, { name: d.name, dirty: true }); updateTitle(); toast('Rascunho recuperado — lembre de salvar', 'ok'); }
        catch (e) { showMsg('Não foi possível recuperar', esc(e.message)); }
      };
      $('dDel').onclick = async () => { if (await confirmDlg('Descartar rascunho', 'Apagar o rascunho não salvo? Isso não pode ser desfeito.', 'Apagar')) { clearDraft(); box.hidden = true; } };
    }).catch(() => { /* IndexedDB indisponível */ });
  }
  window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------------- nova música / exemplo / informações ---------------- */
  function newSongDialog() {
    const d = $('dlgNew'); d.returnValue = '';
    d.onclose = async () => {
      if (d.returnValue !== 'ok') return;
      if (!(await confirmLeave())) return;
      try {
        const sc = Ops.newScore({
          title: $('nTitle').value.trim() || 'Nova música', artist: $('nArtist').value.trim(),
          tempo: Math.max(20, Math.min(400, +$('nTempo').value || 120)), num: Math.max(1, Math.min(32, +$('nNum').value || 4)),
          den: +$('nDen').value || 4, bars: Math.max(1, Math.min(999, +$('nBars').value || 16)), instrument: $('nInst').value
        }, api.settings);
        setScore(sc, { name: sc.title, enterEdit: true, dirty: true });
        toast('Nova música criada — digite as casas no teclado ou toque no painel', 'ok', 4000);
      } catch (e) { showMsg('Erro', esc(e.message)); }
    };
    d.showModal();
  }
  function buildDemo() {
    const M = at.model;
    let sc = Ops.newScore({ title: 'Exemplo — Riff em Lá menor', artist: 'Tab Studio', tempo: 96, bars: 4, instrument: 'guitar-dist' }, api.settings);
    sc.tracks[0].name = 'Guitarra'; sc.tracks[0].shortName = 'Guit.';
    sc = Ops.addTrack(sc, 'bass4', api.settings);
    sc.tracks[1].name = 'Baixo'; sc.tracks[1].shortName = 'Bx.';
    // tabString: 1 = mi aguda (convenção da tablatura); convertido para a numeração interna
    function fill(trackIdx, barIdx, spec) {
      const st = sc.tracks[trackIdx].staves[0]; const N = st.tuning.length;
      const v = st.bars[barIdx].voices[0]; v.beats.splice(0, v.beats.length);
      spec.forEach(([dur, notes, fx]) => {
        const b = new M.Beat(); b.duration = dur; b.isEmpty = false;
        (notes || []).forEach(([ts, fret, nfx]) => {
          const n = new M.Note(); n.string = N + 1 - ts; n.fret = fret;
          const f = Object.assign({}, fx || {}, nfx || {});
          if (f.pm) n.isPalmMute = true;
          if (f.vib) n.vibrato = f.vib;
          if (f.hp) n.isHammerPullOrigin = true;
          if (f.slide) n.slideOutType = M.SlideOutType.Legato;
          if (f.ring) n.isLetRing = true;
          if (f.bend) { n.bendType = M.BendType.Bend; f.bend.forEach(([o, val]) => n.addBendPoint(new M.BendPoint(o, val))); }
          b.addNote(n);
        });
        v.addBeat(b);
      });
    }
    const A5 = [[6, 5], [5, 7]], C5 = [[6, 8], [5, 10]], D5 = [[5, 5], [4, 7]];
    const riff = [[8, A5, { pm: 1 }], [8, A5, { pm: 1 }], [8, C5], [8, A5, { pm: 1 }], [8, A5, { pm: 1 }], [8, D5], [8, C5], [8, A5]];
    fill(0, 0, riff);
    fill(0, 1, [[8, [[3, 7, { hp: 1 }]]], [8, [[3, 9]]], [4, [[2, 8, { bend: [[0, 0], [15, 4], [60, 4]] }]]], [4, [[2, 8, { bend: [[0, 0], [15, 4], [30, 4], [45, 0], [60, 0]] }]]], [4, [[1, 5, { vib: 2 }]]]]);
    fill(0, 2, riff);
    fill(0, 3, [[8, [[4, 7, { slide: 1 }]]], [8, [[4, 9]]], [4, [[3, 7, { vib: 1 }]]], [2, [[6, 5], [5, 7], [4, 7]], { ring: 1 }]]);
    const bassRiff = [[8, [[4, 5]]], [8, [[4, 5]]], [8, [[4, 8]]], [8, [[4, 5]]], [8, [[4, 5]]], [8, [[3, 5]]], [8, [[4, 8]]], [8, [[4, 5]]]];
    fill(1, 0, bassRiff); fill(1, 1, [[2, [[4, 5]]], [2, [[4, 3]]]]); fill(1, 2, bassRiff); fill(1, 3, [[4, [[4, 5]]], [4, [[3, 7]]], [2, [[4, 5]]]]);
    sc.masterBars[3].repeatCount = 0;
    return Ops.normalize(sc, api.settings);
  }
  async function openDemo() {
    if (!(await confirmLeave())) return;
    try { setScore(buildDemo(), { name: 'Exemplo' }); S.tracks = [0, 1]; render(); buildTrackList(); toast('Exemplo aberto — aperte o play e abra o instrumento', 'ok'); }
    catch (e) { showMsg('Erro no exemplo', esc(e.message)); }
  }
  function infoDialog() {
    if (!S.score) return;
    const s = S.score, d = $('dlgInfo');
    $('iTitle').value = s.title; $('iSub').value = s.subTitle; $('iArtist').value = s.artist; $('iAlbum').value = s.album; $('iMusic').value = s.music; $('iTab').value = s.tab;
    d.returnValue = '';
    d.onclose = () => {
      if (d.returnValue !== 'ok') return;
      commit(sc => { sc.title = $('iTitle').value; sc.subTitle = $('iSub').value; sc.artist = $('iArtist').value; sc.album = $('iAlbum').value; sc.music = $('iMusic').value; sc.tab = $('iTab').value; return true; });
      updateTitle();
    };
    d.showModal();
  }
  function shortcutsDialog() {
    const rows = [['0–9', 'Casa na corda atual (dois dígitos rápidos = 10 a 30)'], ['← →', 'Batida anterior / próxima'], ['↑ ↓', 'Corda de cima / de baixo'], ['PgUp PgDn', 'Compasso anterior / próximo'], ['Enter / Insert', 'Nova batida depois'], ['Del / ⌫', 'Apagar nota (Shift: apagar batida)'], ['− / +', 'Duração mais longa / mais curta'], ['.', 'Ponto de aumento'], ['R', 'Pausa'], ['T', 'Ligadura'], ['B', 'Bend de 1 tom'], ['V', 'Vibrato (leve → largo → sem)'], ['H', 'Hammer-on / pull-off'], ['S', 'Slide'], ['P', 'Palm mute'], ['L', 'Deixar soar'], ['X', 'Nota abafada'], ['G', 'Nota fantasma'], ['Ctrl+Z / Ctrl+Y', 'Desfazer / refazer'], ['Ctrl+C / Ctrl+V', 'Copiar / colar compasso'], ['Ctrl+S', 'Salvar no app'], ['Ctrl+Shift+S', 'Salvar como arquivo (.gp)'], ['Espaço', 'Tocar / pausar'], ['Esc', 'Sair do modo edição']];
    showMsg('Atalhos do editor', '<table>' + rows.map(r => '<tr><td><kbd>' + r[0] + '</kbd></td><td>' + r[1] + '</td></tr>').join('') + '</table>');
  }
  function aboutDialog() {
    showMsg('Sobre o Tab Studio', 'Versão ' + APP_VERSION + '.<br>Leitura, reprodução, impressão e edição de tablaturas e partituras no navegador, funcionando offline.<br><br>Formatos de leitura: Guitar Pro 3, 4, 5 (.gp3/.gp4/.gp5), 6 (.gpx), 7 e 8 (.gp), MusicXML, Capella e alphaTex.<br>Formato de gravação: Guitar Pro 7/8 (.gp) e MIDI.<br><br><span class="muted">Motor de notação: alphaTab (MPL-2.0). Fonte musical: Bravura (SIL OFL). Sons: SoundFont Sonivox. 3D: three.js (MIT). Guitarra Les Paul 3D: "Generic Les Paul Guitar", de simonrepp (Blend Swap, CC0). Bateria 3D: "Rack Drum Set" (Blend Swap #85792, CC0), só a geometria, com cores próprias.</span>');
  }

  /* ---------------- instrumento na tela (braço/teclado, 2D/3D) ---------------- */
  const VIZ_MODS = {
    neck3d: { file: './fretboard3d.js', cls: 'Fretboard3D', canvas: 'canvas3d', label: 'Braço 3D', views: [['player', 'Visão do músico', 'Músico'], ['top', 'Topo', 'Topo'], ['full', 'Braço inteiro', 'Inteiro']] },
    neck2d: { file: './fretboard2d.js', cls: 'Fretboard2D', canvas: 'canvasN2d', label: 'Braço 2D', views: [['focus7', '7 casas', '7'], ['focus10', '10 casas', '10'], ['focus12', '12 casas', '12'], ['focus15', '15 casas', '15'], ['full', 'Braço inteiro', 'Todo']] },
    keys3d: { file: './keyboard3d.js', cls: 'Keyboard3D', canvas: 'canvasK3d', label: 'Teclado 3D', views: [['player', 'Visão do músico', 'Músico'], ['top', 'Topo', 'Topo'], ['full', 'Teclado inteiro', 'Inteiro']] },
    keys2d: { file: './keyboard2d.js', cls: 'Keyboard2D', canvas: 'canvasK2d', label: 'Teclado 2D', views: [['range', 'Faixa tocada', 'Faixa'], ['hands', 'Duas mãos', '2 mãos'], ['full', 'Teclado inteiro', 'Inteiro']] },
    drum3d: { file: './drums3d.js', cls: 'Drums3D', canvas: 'canvasD3d', label: 'Bateria 3D', views: [['player', 'Visão do baterista', 'Baterista'], ['front', 'De frente', 'Frente'], ['top', 'De cima', 'De cima']] },
    drum2d: { file: './drums2d.js', cls: 'Drums2D', canvas: 'canvasD2d', label: 'Bateria 2D', views: [['kit', 'Bateria vista de cima', 'De cima'], ['kitnames', 'De cima (nomes das peças)', 'Com nomes'], ['lanes', 'Pistas (notas descendo)', 'Pistas']] }
  };
  S.viz = {}; S.vizLoading = {}; S.vizMode = null;
  prefs.vizViews = Object.assign({ neck3d: 'player', neck2d: 'focus7', keys3d: 'player', keys2d: 'range', drum3d: 'player', drum2d: 'kit' }, prefs.vizViews || {});
  if (!prefs.vizNeck) prefs.vizNeck = 'neck3d';
  if (!prefs.vizOther) prefs.vizOther = 'keys3d';
  /* 3D/2D guardado separado para cordas e teclas; o tipo (cordas/teclas) segue a trilha escolhida */
  if (!prefs.dimNeck) prefs.dimNeck = prefs.vizNeck.startsWith('neck') ? prefs.vizNeck.slice(4) : '3d';
  if (!prefs.dimKeys) prefs.dimKeys = prefs.vizOther.slice(4) || '3d';
  /* 3D/2D é uma escolha só, para todos os instrumentos: só muda quando a pessoa muda */
  if (prefs.dim !== '2d' && prefs.dim !== '3d') prefs.dim = prefs.dimNeck === '2d' ? '2d' : '3d';
  function isPerc(t) { return t.staves[0].isPercussion || t.playbackInfo.primaryChannel === 9; }
  /* Cordas = só pelo tipo de instrumento (som General MIDI), nunca pela tablatura:
     o Guitar Pro mostra tablatura e guarda afinação até em trilhas de teclado, sopro e naipe de cordas.
     24–31 violões/guitarras · 32–39 baixos · 40–43 violino, viola, violoncelo, contrabaixo · 104–107 sitar, banjo, shamisen, koto.
     Todo o resto (piano, órgão, sopros, voz, naipes, synth…) = Teclas. Percussão fica de fora. */
  function neckable(t) {
    if (!isStringed(t) || isPerc(t)) return false;
    const p = t.playbackInfo.program;
    return (p >= 24 && p <= 43) || (p >= 104 && p <= 107);
  }
  function modesFor(t) {
    if (t && isPerc(t)) return ['drum3d', 'drum2d'];
    if (!t) return [];
    return neckable(t) ? ['neck3d', 'neck2d', 'keys3d', 'keys2d'] : ['keys3d', 'keys2d'];
  }
  /* libera as telas 3D que não estão à vista: cada uma segura memória da placa de vídeo,
     e no celular isso deixava a partitura em branco durante a música */
  S.vizRecent = [];
  function releaseViz(keep) {
    // mantém vivas só as 2 telas 3D usadas por último (troca rápida entre, por ex., guitarra e bateria)
    if (keep) S.vizRecent = [keep].concat(S.vizRecent.filter(k => k !== keep)).slice(0, 2); else S.vizRecent = [];
    for (const k of Object.keys(S.viz)) {
      if (S.vizRecent.includes(k) || !k.endsWith('3d')) continue;
      const inst = S.viz[k];
      try { inst.dispose(); if (inst.renderer) inst.renderer.forceContextLoss(); } catch (e) { /* segue */ }
      const old = $(VIZ_MODS[k].canvas), fresh = old.cloneNode(false); fresh.hidden = true; old.replaceWith(fresh);
      delete S.viz[k]; S.vizLoading[k] = null;
      if (S.fb === inst) S.fb = null;
    }
  }
  function ensureViz(mode) {
    if (S.viz[mode]) return Promise.resolve(S.viz[mode]);
    if (!S.vizLoading[mode]) {
      const M = VIZ_MODS[mode];
      S.vizLoading[mode] = import(M.file).then(mod => {
        const inst = new mod[M.cls]($(M.canvas), { onPick: on3dPick, flip: prefs.flip });
        S.viz[mode] = inst;
        if (mode === 'neck3d') window.__fb = inst;
        return inst;
      }).catch(e => { S.vizLoading[mode] = null; throw e; });
    }
    return S.vizLoading[mode];
  }
  function fillSelect(sel, items, value) {
    sel.innerHTML = '';
    items.forEach(([v, label, dis, short, tiny]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = label; if (dis) o.disabled = true;
      o.dataset.full = label; if (short) o.dataset.short = short; if (tiny) o.dataset.tiny = tiny;
      sel.appendChild(o);
    });
    sel.value = value;
    if (sel._compact) sel._compact();
  }
  /* listas compactas: fechadas mostram a abreviação (cabem numa linha); abertas mostram o nome completo */
  function compactSelect(sel) {
    const narrow = () => window.innerWidth < 360;
    const full = o => (o.dataset.full != null ? o.dataset.full : (o.dataset.full = o.textContent));
    sel._compact = () => { [...sel.options].forEach(o => { full(o); o.textContent = (narrow() && o.dataset.tiny) || o.dataset.short || o.dataset.full; }); };
    sel._expand = () => { [...sel.options].forEach(o => { o.textContent = full(o); }); };
    ['pointerdown', 'focus', 'keydown'].forEach(ev => sel.addEventListener(ev, sel._expand));
    sel.addEventListener('change', () => setTimeout(sel._compact, 0));
    sel.addEventListener('blur', sel._compact);
    window.addEventListener('resize', () => { if (document.activeElement !== sel) sel._compact(); });
    sel._compact();
  }
  /* o instrumento na tela mostra sempre a trilha principal selecionada */
  function sync3d() { syncViz().catch(e => { $('p3dMsg').textContent = 'Não foi possível mostrar o instrumento neste aparelho: ' + e.message; }); }
  async function syncViz() {
    if ($('panel3d').hidden) return;
    const t = S.score && S.score.tracks[S.primary];
    const modes = t ? modesFor(t) : ['neck3d', 'neck2d', 'keys3d', 'keys2d'];
    const hideAll = () => { Object.values(VIZ_MODS).forEach(M => { $(M.canvas).hidden = true; }); Object.values(S.viz).forEach(v => v.setVisible(false)); };
    if (!modes.length) {
      hideAll(); S.fb = null; S.vizMode = null; S.threeTrack = -1;
      fillSelect($('selVizKind'), [['', 'Percussão', true]], '');
      $('selVizView').innerHTML = ''; $('selVizView').hidden = true; $('selVizDim').hidden = true; $('selVizPrev').hidden = true;
      $('p3dMsg').textContent = 'Bateria e percussão ainda não têm instrumento na tela.';
      return;
    }
    $('selVizView').hidden = false; $('selVizDim').hidden = false; $('selVizPrev').hidden = false;
    const stringedTrack = !t || neckable(t);
    // cordas → braço; teclas, sopros, voz etc. → teclado. Só muda se a pessoa escolheu outro tipo para ESTA trilha
    if (S.vizPick && (S.vizPick.track !== S.primary || S.vizPick.score !== S.score)) S.vizPick = null; // trocou de trilha: volta ao tipo certo
    const pick = S.vizPick ? S.vizPick.kind + prefs.dim : null;
    const drumTrack = !!(t && isPerc(t));
    let mode = pick || (drumTrack ? 'drum' : stringedTrack ? 'neck' : 'keys') + prefs.dim;
    if (!modes.includes(mode)) mode = modes[0];
    S.vizMode = mode; S.threeTrack = t ? S.primary : -1;
    // três listas: cordas/teclas · 3D/2D · visão
    const kinds = drumTrack ? [['drum', 'Bateria', false, 'Bateria', 'Bateria']]
      : modes.some(m => m.startsWith('neck')) ? [['neck', 'Cordas', false, 'Cordas', 'Cordas'], ['keys', 'Teclas', false, 'Teclas', 'Teclas']] : [['keys', 'Teclas']];
    fillSelect($('selVizKind'), kinds, mode.slice(0, 4));
    // 3D/2D: só o que existe para este tipo (bateria 3D ainda vem)
    for (const o of $('selVizDim').options) o.disabled = !modes.includes(mode.slice(0, 4) + o.value);
    $('selVizDim').value = mode.slice(4);
    const M = VIZ_MODS[mode];
    const view = M.views.some(v => v[0] === prefs.vizViews[mode]) ? prefs.vizViews[mode] : M.views[0][0];
    const viewItems = M.views.map(v => [v[0], v[1], false, v[2]]);
    fillSelect($('selVizView'), viewItems, view);
    // braço 2D: as casas vão nos botões (7 · 10 · 12 · 15 · Todo); braço 2D e 3D: "Inverter cordas" é um interruptor
    $('selVizView').hidden = mode === 'neck2d';
    $('p3dOpts').hidden = !mode.startsWith('neck');
    $('segFrets').hidden = $('segFretsLbl').hidden = mode !== 'neck2d';
    for (const b of $('segFrets').children) b.classList.toggle('on', b.dataset.v === view);
    $('chkFlip').checked = !!prefs.flip;
    for (const o of $('selVizKind').options) o.dataset.icon = { neck: 'guitar', keys: 'keys', drum: 'drum' }[o.value] || '';
    $('selVizKind').value = $('selVizKind').value;
    Object.entries(VIZ_MODS).forEach(([k, X]) => { $(X.canvas).hidden = k !== mode; if (k !== mode && S.viz[k]) S.viz[k].setVisible(false); });
    releaseViz(mode);
    $('p3dMsg').textContent = S.viz[mode] ? '' : 'Carregando…';
    const inst = await ensureViz(mode);
    if (S.vizMode !== mode) return;
    $('p3dMsg').textContent = '';
    S.fb = inst; window.__viz = inst;
    inst.setVisible(true); inst.resize();
    const capo = t ? (t.staves[0].capo || 0) : 0;
    const key = S.primary + '|' + (t ? trackTuning(t).join(',') : '') + '|' + capo + '|' + prefs.flip + '|' + (S.score ? S.score.title : '');
    if (inst._tsKey !== key) {
      inst._tsKey = key;
      if (mode.startsWith('neck')) { inst.flip = prefs.flip; inst.setInstrument(t ? trackTuning(t) : [64, 59, 55, 50, 45, 40], capo); }
      else if (mode.startsWith('drum')) inst.setTrack({ drums: t ? usedDrums(t) : [] });
      else inst.setTrack({ twoStaves: t ? t.staves.length > 1 : false });
    }
    if (inst._view !== view) { inst._view = view; inst.setCamera(view); }
    show3dIdle();
  }
  function setVizMode(v) {
    if (!VIZ_MODS[v]) return;
    const t = S.score && S.score.tracks[S.primary];
    const kind = v.slice(0, 4), natural = t && isPerc(t) ? 'drum' : (!t || neckable(t)) ? 'neck' : 'keys';
    prefs.dim = v.slice(4);
    S.vizPick = kind !== natural ? { track: S.primary, score: S.score, kind } : null;
    savePrefs(); sync3d();
  }
  $('selVizKind').onchange = () => setVizMode($('selVizKind').value + $('selVizDim').value);
  $('selVizDim').onchange = () => setVizMode($('selVizKind').value + $('selVizDim').value);
  $('segFrets').onclick = e => {
    const b = e.target.closest('button[data-v]'); if (!b || S.vizMode !== 'neck2d') return;
    $('selVizView').value = b.dataset.v; $('selVizView').onchange();
    for (const x of $('segFrets').children) x.classList.toggle('on', x === b);
  };
  $('chkFlip').onchange = () => {
    prefs.flip = $('chkFlip').checked; savePrefs();
    for (const i of Object.values(S.viz)) { if (i.setFlip) i.setFlip(prefs.flip); i._tsKey = null; }
    sync3d();
  };
  $('selVizView').onchange = () => {
    const v = $('selVizView').value, mode = S.vizMode; if (!mode) return;
    prefs.vizViews[mode] = v; savePrefs();
    const inst = S.viz[mode]; if (inst) { inst._view = v; inst.setCamera(v); show3dIdle(); }
  };
  // 0 = só a nota atual; 1 = compasso atual; 2 = atual + próximo; 3 e 4 = 2 e 3 compassos à frente
  if (prefs.preview == null || prefs.preview === 'off') prefs.preview = '0';
  else if (!prefs.previewV2) prefs.preview = String(Math.min(4, (+prefs.preview || 0) + 1));
  if (!prefs.previewV2) { prefs.previewV2 = true; savePrefs(); }
  $('selVizPrev').value = String(prefs.preview);
  [$('selVizKind'), $('selVizDim'), $('selVizView'), $('selVizPrev')].forEach(compactSelect);
  const prevAccent = () => { $('selVizPrev').dataset.cs = prefs.preview !== '0' ? 'accent' : ''; };
  prevAccent();
  $('selVizPrev').onchange = () => { prefs.preview = $('selVizPrev').value; savePrefs(); prevAccent(); if (S.fb && prefs.preview === '0' && S.fb.setPreview) S.fb.setPreview([]); if (!S.playing) scheduleIdle(); };
  function toggle3d(force) {
    const p = $('panel3d');
    const on = force === undefined ? p.hidden : force;
    p.hidden = !on; $('btn3d').classList.toggle('on', on);
    if (!on) { Object.values(S.viz).forEach(v => v.setVisible(false)); releaseViz(null); S.vizMode = null; return; }
    sync3d();
  }
  function show3dIdle() {
    if (!S.fb || !S.score || S.playing) return;
    if (S.threeTrack < 0) return;
    if (S.edit && S.cur.track === S.threeTrack) {
      const b = cursorBeat();
      S.fb.showStatic(b ? b.notes.map(noteFor3d) : [], S.cur.string);
      return;
    }
    // parado: mostra as notas que soam onde a música está (e a prévia das próximas, se ligada)
    const at = beatsAtTick(S.threeTrack, api.tickPosition);
    S.fb.showStatic(at.beats.flatMap(b => b.notes.map(noteFor3d)), null);
    if (S.fb.setPreview) S.fb.setPreview(at.beats.length ? previewNotes(at.beats) : []);
  }
  function scheduleIdle() { if (idleRaf) return; idleRaf = requestAnimationFrame(() => { idleRaf = 0; show3dIdle(); }); }
  /* o que soa no instante "tick" numa trilha (usa o mapa de tempo do alphaTab: respeita repetições) */
  function findAt(track, tick) {
    const tc = api.tickCache; if (!tc || !S.score) return null;
    try { return tc.findBeat(new Set([track]), Math.max(0, tick)); } catch (e) { return null; }
  }
  function beatsAtTick(track, tick) {
    const r = findAt(track, tick);
    if (!r || !r.beatLookup) return { r: null, beats: [] };
    const beats = r.beatLookup.highlightedBeats.filter(x => x.beat.voice.bar.staff.track.index === track).map(x => x.beat);
    return { r, beats };
  }
  // começa nota aqui (não só pausa nem continuação de ligadura)?
  function startsNote(r, track) {
    return !!r && !!r.beatLookup && r.beatLookup.highlightedBeats.some(x => x.playbackStart === r.beatLookup.start && x.beat.voice.bar.staff.track.index === track && x.beat.notes.some(n => !n.isTieDestination));
  }
  /* ◀ ▶ ao lado do play: anda uma nota por vez (para estudar a passagem no braço / teclado / bateria) */
  function stepNote(dir) {
    if (!S.score || !api.tickCache) return;
    if (S.edit) { edAction(dir > 0 ? 'right' : 'left'); return; }
    if (S.playing) api.pause();
    const track = S.fb && S.threeTrack >= 0 ? S.threeTrack : S.primary;
    const tick = api.tickPosition;   // o player devolve a posição com +1 depois de um pulo: tolerância abaixo
    let r = findAt(track, tick), guard = 0;
    if (!r) return;
    if (dir < 0 && tick > r.start + 8 && startsNote(r, track)) { /* estava no meio da nota: volta ao começo dela */ }
    else {
      do {
        const nt = dir > 0 ? r.end : r.start - 1;
        if (nt < 0) { toast('Começo da música'); return; }
        const nr = findAt(track, nt);
        if (!nr || nr.start === r.start) { if (dir > 0) toast('Fim da música'); return; }
        r = nr;
      } while (!startsNote(r, track) && guard++ < 4000);
      if (!startsNote(r, track)) return;
    }
    api.tickPosition = r.start;
    tbar.setPos(r.beat.voice.bar.index, false);
    scheduleIdle();
    try { if (api.scrollToCursor) api.scrollToCursor(); } catch (e) { /* sem rolagem automática */ }
  }
  $('btnStepBack').onclick = () => stepNote(-1);
  $('btnStepFwd').onclick = () => stepNote(1);
  function on3dPick(string, fret) {
    if (!S.edit) { toast('Ative o modo edição para escrever tocando no braço'); return; }
    if (S.threeTrack < 0) return;
    if (S.cur.track !== S.threeTrack) setEditTrack(S.threeTrack);
    S.cur.string = string;
    edSetFret(fret);
  }
  document.querySelector('[data-close3d]').onclick = () => { if (window.TabStudio && TabStudio.fullView.active) TabStudio.fullView.exit(); toggle3d(false); };

  /* ---------------- visualização ---------------- */
  prefs.stave = staveOf(prefs.stave);
  $('selStave').value = prefs.stave; $('selLayout').value = prefs.layout; $('rngZoom').value = prefs.zoom; $('zoomVal').textContent = prefs.zoom + '%';
  $('chkFollow').checked = prefs.follow;
  viewport.classList.toggle('horizontal', prefs.layout === 'Horizontal');
  function applyDisplay() {
    prefs.stave = staveOf(prefs.stave);
    api.settings.display.staveProfile = at.StaveProfile[STAVES[effStave()][0]];
    api.settings.notation.rhythmMode = at.TabRhythmMode[STAVES[effStave()][1]];
    api.settings.display.layoutMode = at.LayoutMode[prefs.layout];
    api.settings.display.scale = prefs.zoom / 100;
    api.settings.player.scrollMode = prefs.follow ? at.ScrollMode.Continuous : at.ScrollMode.Off;
    viewport.classList.toggle('horizontal', prefs.layout === 'Horizontal');
    api.updateSettings();
    if (S.score) renderKeepScroll();
    savePrefs();
  }
  $('selStave').onchange = () => { prefs.stave = $('selStave').value; applyDisplay(); };
  $('selLayout').onchange = () => { prefs.layout = $('selLayout').value; applyDisplay(); };
  $('rngZoom').oninput = () => { $('zoomVal').textContent = $('rngZoom').value + '%'; };
  ['rngZoom', 'rngVol', 'rngSeek'].forEach(id => paintRange($(id)));
  $('rngZoom').classList.add('purple'); $('rngVol').classList.add('purple');
  applyTheme();
  $('btnTheme').onclick = () => { prefs.theme = prefs.theme === 'light' ? 'dark' : 'light'; savePrefs(); applyTheme(); };
  $('rngZoom').onchange = () => { prefs.zoom = +$('rngZoom').value; applyDisplay(); };
  $('chkFollow').onchange = () => { prefs.follow = $('chkFollow').checked; applyDisplay(); };

  /* ---------------- ajustes da música (para o repertório) ---------------- */
  // tudo o que o músico ajustou: velocidade, trecho/repetição, trilhas, metrônomo, contagem e mixer
  // trecho, repetição e o aumento automático de velocidade são treino do momento: NUNCA são guardados
  function captureSettings() {
    if (!S.score || S.repPending || !api.tickCache) return null;
    const view = (S.edit && S.viewTracksBeforeEdit) ? S.viewTracksBeforeEdit : S.tracks;
    const t = S.score.tracks[S.primary];
    const base = (S.loopProg && S.speedBeforeLoop != null) ? S.speedBeforeLoop : api.playbackSpeed;
    const mix = {};
    for (const k of Object.keys(S.mix)) { const m = S.mix[k]; if (m && (m.mute || m.solo || Math.abs(m.vol - 1) > 0.001)) mix[k] = { mute: !!m.mute, solo: !!m.solo, vol: Math.round(m.vol * 100) / 100 }; }
    return {
      speed: Math.round(base * 100),
      loop: null, prog: null,
      tracks: view.slice(), primary: S.primary, trackName: t ? (t.name || '').trim() : '',
      metro: $('btnMetro').classList.contains('on'), countIn: $('btnCountIn').classList.contains('on'),
      mix
    };
  }
  // parte que depende do MIDI pronto (trecho em compassos → posição no tempo)
  function applyPlaySettings(st) {
    st = st || {};
    S.loopProg = null; S.speedBeforeLoop = null;
    setSpeed(st.speed || 100);
    setMetro(!!st.metro); setCountIn(!!st.countIn);
    api.isLooping = false;
    try { api.playbackRange = null; api.clearPlaybackRangeHighlight(); } catch (e) { /* nada destacado */ }
    tbar.setRange(null);
    // trecho/repetição guardados por versões antigas são ignorados: a música sempre começa sem repetição
    try { api.tickPosition = 0; } catch (e) { /* sem MIDI */ }
    S.repPending = false;
    S.repBase = (S.rep || S.recId) ? captureSettings() : null;   // o que está aplicado; mudanças depois disso ficam pendentes (disquete)
    updateLoopStatus();
  }
  /* bytes da música como está agora (alterações não salvas entram também, verificadas) */
  function currentBytes() {
    if (S.curBytes && !S.dirty) return S.curBytes;
    const sc = S.test ? S.test.orig : S.score;   // testando tom: vai a música original
    const data = new at.exporter.Gp7Exporter().export(sc, api.settings);
    const check = at.importer.ScoreLoader.loadScoreFromBytes(data, api.settings);
    if (Ops.countNotes(check) !== Ops.countNotes(sc) || check.masterBars.length !== sc.masterBars.length || check.tracks.length !== sc.tracks.length) throw new Error('a conversão da música não conferiu');
    return data;
  }
  function parseScore(bytes) { return at.importer.ScoreLoader.loadScoreFromBytes(bytes, api.settings); }
  /* entrega um .zip pronto (exportar repertório) */
  async function deliverZip(bytes, name) {
    if (!FRAMED) { downloadBlob(new Blob([bytes], { type: 'application/zip' }), name); return 'download'; }
    let dl = null;
    try { dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch (e) { dl = null; }
    if (!dl) return 'unavailable';
    try { await dl.save({ filename: name, data: new Blob([bytes]) }); return 'zip'; }
    catch (e) { return e && e.code === 'declined' ? 'declined' : 'unavailable'; }
  }

  /* ---------------- tom do conjunto (testar no player / aplicar na música) ---------------- */
  // troca a partitura desenhada mantendo o ponto, o trecho e o play
  function swapScore(sc) {
    const st = { play: S.playing, tick: api.tickPosition, rb: rangeBars(api.playbackRange), loop: api.isLooping };
    if (st.play) api.pause();
    S.score = sc;
    Ops.clampCursor(S.score, S.cur);
    waitMidi = true; waitRender = true;
    renderKeepScroll(); tbar.setScore(S.score); refreshTrackUI();
    afterMidi(() => {
      try { if (st.rb && st.rb[1] < S.score.masterBars.length) { setRangeBars(st.rb[0], st.rb[1], true); api.isLooping = st.loop; } api.tickPosition = st.tick; } catch (e) { /* posição inválida */ }
      if (st.play) api.play();
    });
    syncViz();
  }
  /** testa a música n meios tons acima/abaixo (não muda a música; 0 = volta ao original) */
  function setKeyTest(n, mode) {
    if (!S.score) return false;
    mode = mode || S.keyMode;
    n = Math.max(-Tr.LIMITS.RANGE, Math.min(Tr.LIMITS.RANGE, n));
    const orig = S.test ? S.test.orig : S.score;
    if (n !== 0) {
      const a = Tr.analyze(orig, n, mode, S.keySkip);
      if (!a.modes[mode].ok) {
        if (mode !== 'auto' && a.modes.auto.ok) { toast(a.modes[mode].why + ' — usando Automático'); mode = 'auto'; }
        else { toast('Esse tom não dá: ' + a.modes[mode].why, 'err'); renderKeyUI(); return false; }
      }
    }
    S.keyMode = mode;
    if (n === 0) { if (S.test) { const o = S.test.orig; S.test = null; swapScore(o); } renderKeyUI(); return true; }
    if (!S.test) S.test = { base: Ops.snapshot(S.score), orig: S.score };
    S.test.n = n; S.test.mode = mode;
    let sc = Ops.restore(S.test.base, api.settings);
    Tr.apply(sc, n, mode, S.keySkip);
    sc = Ops.normalize(sc, api.settings);
    swapScore(sc);
    renderKeyUI();
    return true;
  }
  function endKeyTest() { if (S.test) setKeyTest(0); }
  /** leva o tom testado para a música (vira uma alteração: dá para desfazer e salvar) */
  function applyKey() {
    if (!S.test) return false;
    const { n, mode, orig } = S.test;
    const skip = new Set(S.keySkip);
    const a = Tr.analyze(orig, n, mode, skip);
    const st = { play: S.playing, tick: api.tickPosition, rb: rangeBars(api.playbackRange), loop: api.isLooping };
    if (st.play) api.pause();
    S.score = orig; S.test = null;
    waitMidi = true; waitRender = true;
    // tom do conjunto entra no nome do "Salvar como"; corrigir só algumas trilhas conta como "editada"
    const ok = commit(sc => { Tr.apply(sc, n, mode, skip); }, { silent: true, chg: c => skip.size ? Object.assign(c, { edited: true }) : Object.assign(c, { key: c.key + n }) });
    afterMidi(() => {
      try { if (st.rb) { setRangeBars(st.rb[0], st.rb[1], true); api.isLooping = st.loop; } api.tickPosition = st.tick; } catch (e) { /* posição inválida */ }
      if (st.play) api.play();
    });
    syncViz(); renderKeyUI();
    if (ok) {
      const how = Tr.describe(a).filter(d => !/transpostas|sem mudança/.test(d.text)).map(d => d.name + ': ' + d.text).join(' · ');
      toast('Tom aplicado: ' + Tr.tomText(n) + (how ? ' — ' + how : '') + '. Salve para guardar no arquivo.', 'ok', 7000);
    }
    return ok;
  }
  const MODE_NAMES = { auto: 'Automático', capo: 'Capotraste', tuning: 'Afinação', shape: 'Desenho' };
  /* aviso das cordas soltas em cima da partitura (afinação diferente da padrão, capotraste ou teste de tom) */
  const STD_TUN = { 4: [43, 38, 33, 28], 5: [43, 38, 33, 28, 23], 6: [64, 59, 55, 50, 45, 40], 7: [64, 59, 55, 50, 45, 40, 35] };
  /* afinação: aviso rápido embaixo da partitura (some sozinho) + informação fixa no painel Ver */
  let tuneSig = '', tuneShownAt = 0, tuneTimer = 0;
  function tuneHtml() {
    const t = S.score && S.score.tracks[S.primary];
    const st = t && t.staves.find(s => s.tuning && s.tuning.length && !s.isPercussion);
    if (!st) return { html: '', odd: false };
    const tun = st.tuning, std = STD_TUN[tun.length], capo = st.capo || 0;
    const odd = !!(std && tun.join(',') !== std.join(',')) || capo > 0 || !!S.test;
    return { odd, html: '<b>Cordas soltas:</b> ' + esc(Tr.tuningNames(tun)) + (capo ? ' · <b>Capotraste na casa ' + capo + '</b>' : '') + (S.test ? ' · <span class="tc-test">teste: ' + esc(Tr.tomText(S.test.n)) + '</span>' : '') };
  }
  function showTuneNote(html) {
    const n = $('tuneNote');
    n.innerHTML = html; n.hidden = false; n.classList.remove('out'); tuneShownAt = Date.now();
    clearTimeout(tuneTimer);
    tuneTimer = setTimeout(() => { n.classList.add('out'); tuneTimer = setTimeout(() => { n.hidden = true; }, 450); }, 5000);
  }
  function updateTuneChip() {
    const { html, odd } = tuneHtml();
    const info = $('tuneInfo');
    info.hidden = !html; info.innerHTML = html ? html.replace('Cordas soltas:', 'Afinação da trilha:') : '';
    // avisa quando muda (abrir música, trocar de trilha, mudar o tom) e só se não for a afinação padrão
    const sig = (S.score ? S.score.title + '|' + S.primary + '|' : '') + html;
    if (sig !== tuneSig) { tuneSig = sig; if (odd) showTuneNote(html); else { clearTimeout(tuneTimer); $('tuneNote').hidden = true; } }
  }
  // ao começar a tocar, lembra a afinação (no máximo a cada 12 s, para não repetir no tocar/pausar)
  api.playerStateChanged.on(e => { if (e.state === 1 && Date.now() - tuneShownAt > 12000) { const { html, odd } = tuneHtml(); if (odd) showTuneNote(html); } });
  function renderKeyUI() {
    updateTuneChip();
    const n = S.test ? S.test.n : 0;
    $('keyVal').textContent = n ? (n > 0 ? '+' : '') + n : '';
    $('btnKey').classList.toggle('on', !!S.test);
    document.querySelectorAll('.key-box').forEach(box => {
      if (!box.offsetParent && box.closest('[hidden]')) return;   // só desenha o que está aberto
      if (!S.score) { box.innerHTML = '<p class="muted">Abra uma música para mudar o tom.</p>'; return; }
      const orig = S.test ? S.test.orig : S.score, mode = S.keyMode;
      const sk = S.keySkip, a = Tr.analyze(orig, n, mode, sk);
      const up = n < Tr.LIMITS.RANGE && Tr.analyze(orig, n + 1, 'auto', sk).modes.auto.ok;
      const dn = n > -Tr.LIMITS.RANGE && Tr.analyze(orig, n - 1, 'auto', sk).modes.auto.ok;
      const lines = Tr.describe(a);
      if (orig.tracks.some(t => t.staves.some(s => s.isPercussion))) lines.push({ name: 'Bateria', text: 'sem mudança' });
      const bad = n ? Object.keys(MODE_NAMES).filter(m => m !== 'auto' && !a.modes[m].ok) : [];
      box.innerHTML =
        '<div class="kb-row"><button type="button" class="kb-step" data-k="-1" title="Meio tom abaixo"' + (dn ? '' : ' disabled') + '>−</button>' +
        '<div class="kb-val' + (n ? ' on' : '') + '"><b>' + (n > 0 ? '+' : '') + n + '</b><span>' + Tr.tomText(n) + '</span></div>' +
        '<button type="button" class="kb-step" data-k="1" title="Meio tom acima"' + (up ? '' : ' disabled') + '>+</button></div>' +
        (a.hasStr ? '<div class="kb-lbl">Como tocar nas cordas</div><div class="seg kb-modes">' + Object.keys(MODE_NAMES).map(m =>
          '<button type="button" data-m="' + m + '"' + (m === mode ? ' class="on"' : '') + (n && !a.modes[m].ok ? ' disabled title="' + esc(a.modes[m].why) + '"' : '') + '>' + MODE_NAMES[m] + '</button>').join('') + '</div>' : '') +
        '<div class="kb-lbl">Instrumentos que mudam</div>' +
        '<ul class="kb-list">' + lines.map(l => '<li class="' + (l.bad ? 'bad' : '') + (l.off ? ' off' : '') + '">' + (l.i != null ? '<label class="kb-chk"><input type="checkbox" data-t="' + l.i + '"' + (l.off ? '' : ' checked') + '><b>' + esc(l.name) + '</b></label>' : '<b class="kb-fixed">' + esc(l.name) + '</b>') + '<span>' + esc(l.text) + '</span></li>').join('') + '</ul>' +
        (sk.size ? '<div class="kb-warn">Só alguns instrumentos vão mudar. Isso serve para <b>corrigir</b> uma trilha; para mudar o tom da música, marque todos.</div>' : '') +
        (bad.length ? '<div class="kb-why">' + bad.map(m => '<span><b>' + MODE_NAMES[m] + ':</b> ' + esc(a.modes[m].why) + '</span>').join('') + '</div>' : '') +
        '<div class="kb-acts"><button type="button" class="btn" data-a="orig"' + (n ? '' : ' disabled') + '>Tom original</button><button type="button" class="btn primary" data-a="apply"' + (n ? '' : ' disabled') + '>Aplicar à música</button></div>';
    });
  }
  document.querySelectorAll('.key-box').forEach(box => box.addEventListener('change', e => {
    const c = e.target.closest('input[data-t]'); if (!c) return;
    const i = Number(c.dataset.t);
    if (c.checked) S.keySkip.delete(i); else S.keySkip.add(i);
    if (S.test) setKeyTest(S.test.n, S.keyMode); else renderKeyUI();
  }));
  document.querySelectorAll('.key-box').forEach(box => box.addEventListener('click', e => {
    e.stopPropagation();
    if (e.target.closest('label.kb-chk')) return;
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    const n = S.test ? S.test.n : 0;
    if (b.dataset.k) setKeyTest(n + Number(b.dataset.k), S.keyMode);
    else if (b.dataset.m) { if (n) setKeyTest(n, b.dataset.m); else { S.keyMode = b.dataset.m; renderKeyUI(); } }
    else if (b.dataset.a === 'orig') setKeyTest(0);
    else if (b.dataset.a === 'apply') { applyKey(); closePopups(); }
  }));
  $('btnKey').onclick = e => {
    e.stopPropagation();
    const p = $('keyPop'), wasHidden = p.hidden;
    closePopups('keyPop'); p.hidden = !wasHidden;
    if (!p.hidden) {
      renderKeyUI();
      const r = $('btnKey').getBoundingClientRect(), w = Math.min(360, innerWidth - 16);
      p.style.width = w + 'px'; p.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
      p.style.top = 'auto'; p.style.right = 'auto'; p.style.bottom = (innerHeight - r.top + 8) + 'px';
    }
  };
  $('keyPop').onclick = e => e.stopPropagation();

  /* ---------------- alterações para aplicar (disquete) ----------------
     No repertório, velocidade, trilhas, metrônomo, contagem e mixer só ficam guardados se a pessoa aplicar.
     Notas/tom alterados também entram na lista ("Salvar no app"). Trocar de música à mão pergunta;
     a passagem automática do repertório descarta. Fechar o app de repente não aplica nada. */
  const trackLabel = i => { const t = S.score && S.score.tracks[i]; return t ? ((t.name || '').trim() || 'Trilha ' + (i + 1)) : 'Trilha ' + (i + 1); };
  const onOff = v => v ? 'ligado' : 'desligado';
  function mixText(m) {
    if (!m) return 'normal';
    const p = []; if (m.mute) p.push('mudo'); if (m.solo) p.push('solo'); if (Math.abs((m.vol == null ? 1 : m.vol) - 1) > 0.001) p.push('volume ' + Math.round(m.vol * 100) + '%');
    return p.join(', ') || 'normal';
  }
  function pendingChanges() {
    const out = [];
    if ((S.rep || S.recId) && !S.repPending && S.repBase) {
      const b = S.repBase, c = captureSettings();
      if (c) {
        out.cur = c;
        if ((b.speed || 100) !== c.speed) out.push({ id: 'speed', label: 'Velocidade', from: (b.speed || 100) + '%', to: c.speed + '%' });
        // trilhas na tela + a principal (a que comanda o instrumento) numa linha só
        const tl = (ts, p) => { ts = (ts || []).slice().sort((x, y) => x - y); return ts.length > 1 ? ts.map(i => trackLabel(i) + (i === p ? ' (principal)' : '')).join(', ') : ts.map(trackLabel).join(', '); };
        const bt = (b.tracks || []).slice().sort((x, y) => x - y), ct = c.tracks.slice().sort((x, y) => x - y);
        if (bt.join(',') !== ct.join(',') || b.primary !== c.primary) out.push({ id: 'tracks', label: 'Trilhas', from: tl(b.tracks, b.primary), to: tl(c.tracks, c.primary) });
        if (!!b.metro !== !!c.metro) out.push({ id: 'metro', label: 'Metrônomo', from: onOff(b.metro), to: onOff(c.metro) });
        if (!!b.countIn !== !!c.countIn) out.push({ id: 'countIn', label: 'Contagem antes de tocar', from: onOff(b.countIn), to: onOff(c.countIn) });
        const bm = b.mix || {}, keys = new Set([...Object.keys(bm), ...Object.keys(c.mix)]);
        for (const k of [...keys].sort((x, y) => x - y)) { const x = mixText(bm[k]), y = mixText(c.mix[k]); if (x !== y) out.push({ id: 'mix:' + k, label: 'Mixer – ' + trackLabel(+k), from: x, to: y }); }
      }
    }
    if (S.dirty && S.score) {
      // tom e notas ficam no mesmo arquivo: uma caixinha só
      const k = S.chg.key, e = S.chg.edited || !k;
      out.push({ id: 'score', score: true, label: k && e ? 'Tom e notas editadas' : k ? 'Tom' : 'Notas editadas', from: k ? 'original' : null, to: (k ? Tr.tomText(k) : 'notas alteradas') + (k && e ? ' + notas alteradas' : '') + ' (salva no app)' });
    }
    if (S.test && S.score) out.push({ id: 'test', score: true, test: true, label: 'Tom em teste', from: S.chg.key ? Tr.tomText(S.chg.key) : 'original', to: Tr.tomText(S.chg.key + S.test.n) + ' — aplica e salva no app' });
    return out;
  }
  function applyDialog(mode, items) {
    return new Promise(res => {
      const d = $('dlgApply');
      $('apTitle').textContent = mode === 'leave' ? 'Aplicar as alterações antes de trocar?' : 'Aplicar alterações';
      $('apSub').innerHTML = '<b>' + esc((S.score && (S.score.title || S.fileName)) || '') + '</b>' + (S.rep ? ' · repertório' : '') + (mode === 'leave' ? '<br>O que não for aplicado será descartado.' : '<br>Desmarque o que não quiser guardar.');
      $('apList').innerHTML = items.map((it, i) => '<li data-i="' + i + '"><label class="ap-chk"><input type="checkbox" data-i="' + i + '" checked><span><b>' + esc(it.label) + '</b><i>' + (it.from != null ? esc(it.from) + ' → ' : '') + esc(it.to) + '</i></span></label><button type="button" class="ap-x" title="Desfazer esta alteração (volta como estava)" aria-label="Desfazer">' + icon('close') + '</button></li>').join('');
      const btns = mode === 'leave' ? [['cancel', 'Cancelar', ''], ['discard', 'Descartar', 'danger'], ['apply', 'Aplicar', 'primary']] : [['undoAll', 'Remover tudo', 'danger left'], ['cancel', 'Cancelar', ''], ['apply', 'Aplicar', 'primary']];
      $('apMenu').innerHTML = btns.map(([v, l, c]) => '<button type="button" class="btn ' + c + '" data-v="' + v + '">' + (v === 'undoAll' ? icon('trash') : '') + l + '</button>').join('');
      let fin = false;
      const done = v => { if (fin) return; fin = true; const sel = [...d.querySelectorAll('#apList input')].filter(x => x.checked).map(x => items[+x.dataset.i]); d.close(); res({ v, sel }); };
      $('apList').onclick = async e => {
        const x = e.target.closest('.ap-x'); if (!x || x.disabled) return;
        const li = x.closest('li'); x.disabled = true;
        await revertChange(items[+li.dataset.i]);
        li.remove();
        if (!d.querySelector('#apList li')) done(mode === 'leave' ? 'discard' : 'cancel');   // nada mais pendente
        else $('apList').onchange();
      };
      $('apMenu').onclick = async e => {
        const b = e.target.closest('button'); if (!b || b.disabled) return;
        if (b.dataset.v === 'undoAll') {
          b.disabled = true;
          for (const li of [...d.querySelectorAll('#apList li')]) await revertChange(items[+li.dataset.i]);
          done('cancel'); toast('Alterações removidas: a música voltou como estava');
          return;
        }
        done(b.dataset.v);
      };
      $('apList').onchange = () => { $('apMenu').querySelector('[data-v="apply"]').disabled = ![...d.querySelectorAll('#apList input')].some(x => x.checked); };
      d.oncancel = e => { e.preventDefault(); done('cancel'); };
      d.onclose = () => done('cancel');
      d.showModal();
    });
  }
  /** desfaz uma alteração pendente: volta ao que está aplicado (a linha some da lista) */
  async function revertChange(it) {
    const b = S.repBase || {};
    try {
      if (it.id === 'speed') { const v = b.speed || 100; if (S.loopProg) S.speedBeforeLoop = v / 100; else setSpeed(v); }
      else if (it.id === 'tracks') {
        const ok = i => Number.isInteger(i) && S.score && i >= 0 && i < S.score.tracks.length;
        const ts = (b.tracks || []).filter(ok); if (!ts.length) return;
        if (S.edit && S.viewTracksBeforeEdit) S.viewTracksBeforeEdit = ts.slice();
        else S.tracks = ts.slice();
        S.primary = ok(b.primary) && ts.includes(b.primary) ? b.primary : ts[0];
        if (S.edit) setEditTrack(S.primary); else { render(); refreshTrackUI(); }
      }
      else if (it.id === 'metro') setMetro(!!b.metro);
      else if (it.id === 'countIn') setCountIn(!!b.countIn);
      else if (it.id.startsWith('mix:')) {
        const k = +it.id.slice(4), m = (b.mix || {})[k], t = S.score && S.score.tracks[k];
        S.mix[k] = m ? { mute: !!m.mute, solo: !!m.solo, vol: m.vol == null ? 1 : m.vol } : { mute: false, solo: false, vol: 1 };
        if (t) { api.changeTrackMute([t], S.mix[k].mute); api.changeTrackSolo([t], S.mix[k].solo); api.changeTrackVolume([t], S.mix[k].vol); }
        refreshTrackUI();
      }
      else if (it.id === 'test') endKeyTest();
      else if (it.id === 'score') revertScore();
    } catch (e) { console.error(e); toast('Não foi possível desfazer: ' + (e.message || e), 'err'); }
    updateDisk();
  }
  // a música volta a ser o arquivo guardado (ou, se é nova, desfaz tudo o que foi feito)
  function revertScore() {
    if (S.test) endKeyTest();
    if (S.curBytes) {
      const sc = at.importer.ScoreLoader.loadScoreFromBytes(S.curBytes, api.settings);
      swapScore(sc);
    } else {
      while (S.undo.length) { S.score = Ops.restore(S.undo.pop(), api.settings); S.chg = S.undoChg.pop() || S.chg; }
      swapScore(S.score);
      if (S.chg.key || S.chg.edited) { toast('Parte das edições é antiga demais para desfazer', 'err'); return; }
    }
    S.undo = []; S.redo = []; S.undoChg = []; S.redoChg = [];
    S.chg = { key: 0, edited: false }; S.dirty = false; clearDraft();
    if (S.edit) updateEditor();
    updateTitle(); renderKeyUI();
  }
  async function applySelected(sel, all) {
    const ids = sel.filter(x => !x.score).map(x => x.id);
    const cur0 = all.cur || captureSettings();
    // primeiro a música (tom/notas): ao salvar no app ela ganha um arquivo novo nos recentes
    if (sel.some(x => x.score)) {
      if (S.test) { if (sel.some(x => x.test)) { if (!applyKey()) return false; } else endKeyTest(); }
      if (!(await saveGp())) return false;
    }
    if (ids.length && (S.rep || S.recId) && S.repBase) {
      const cur = cur0 || captureSettings(), nb = JSON.parse(JSON.stringify(S.repBase));
      nb.mix = nb.mix || {};
      for (const id of ids) {
        if (id.startsWith('mix:')) { const k = id.slice(4); if (cur.mix[k]) nb.mix[k] = cur.mix[k]; else delete nb.mix[k]; }
        else if (id === 'tracks') { nb.tracks = cur.tracks.slice(); nb.primary = cur.primary; nb.trackName = cur.trackName; }
        else nb[id] = cur[id];
      }
      nb.loop = null; nb.prog = null;
      if (!(S.rep ? await Rep.saveSettings(S.rep.id, S.rep.iid, nb) : await saveRecentSettings(S.recId, nb))) return false;
      S.repBase = nb;
    }
    updateDisk();
    return true;
  }
  /** antes de trocar de música à mão: pergunta o que fazer com o que mudou (true = pode seguir) */
  async function confirmLeave() {
    const items = pendingChanges();
    if (!items.length) return true;
    const r = await applyDialog('leave', items);
    if (r.v === 'cancel') return false;
    if (r.v === 'apply' && !(await applySelected(r.sel, items))) return false;
    S.dirty = false;   // o resto foi descartado
    updateDisk();
    return true;
  }
  function updateDisk() {
    document.body.classList.toggle('no-song', !S.score);   // sem música: some o que não tem uso
    updateFavBtn();
    const n = S.score ? pendingChanges().length : 0, b = $('btnApply');
    b.classList.toggle('on', n > 0); $('applyN').textContent = n ? String(n) : '';
    b.title = n ? (n === 1 ? '1 alteração para aplicar' : n + ' alterações para aplicar') : 'Nada para aplicar';
  }
  setInterval(updateDisk, 1000);
  updateDisk();
  $('btnApply').onclick = async () => {
    const items = pendingChanges();
    if (!items.length) { toast('Nada para aplicar'); return; }
    const r = await applyDialog('disk', items);
    if (r.v === 'apply' && r.sel.length && await applySelected(r.sel, items)) toast(r.sel.length === 1 ? 'Alteração aplicada' : r.sel.length + ' alterações aplicadas', 'ok');
    updateDisk();
  };

  /* ---------------- botões do topo / menus ---------------- */
  function closePopups(except) { ['menuMore', 'viewPanel', 'keyPop'].forEach(id => { if (id !== except) $(id).hidden = true; }); $('btnView').classList.toggle('on', !$('viewPanel').hidden); }
  $('wOpen').onclick = () => $('fileInput').click();
  $('fileInput').onchange = () => { const f = $('fileInput').files[0]; $('fileInput').value = ''; openFile(f); };
  $('wNew').onclick = newSongDialog;
  $('wDemo').onclick = openDemo;
  $('wRecent').onclick = recentDialog;
  $('wFavs').onclick = () => Rep.openLibrary('favs');
  $('btnFav').onclick = toggleFavCurrent;
  loadFavIds();
  updateRecentButton();
  $('edClose').onclick = () => toggleEdit(false);
  // botão Trilhas do topo: abre/fecha a barra de trilhas e fica aceso quando aberta
  $('btnTrkPanel').onclick = () => tbar.toggle();
  // altura da barra de trilhas: o Mixer cobre essa área para ficar por cima
  const setTbarH = () => document.documentElement.style.setProperty('--tbar-h', $('trackBar').offsetHeight + 'px');
  try { new ResizeObserver(setTbarH).observe($('trackBar')); } catch (e) { addEventListener('resize', setTbarH); }
  setTbarH();
  $('btnTrkPanel').classList.toggle('on', !tbar.collapsed);
  $('btn3d').onclick = () => toggle3d();
  $('btnTracks').onclick = () => { const p = $('tracksPanel'); p.hidden = !p.hidden; $('btnTracks').classList.toggle('on', !p.hidden); if (!p.hidden) renderKeyUI(); };
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => { $(b.dataset.close).hidden = true; $('btnTracks').classList.toggle('on', !$('tracksPanel').hidden); });
  $('btnMore').onclick = e => { e.stopPropagation(); const m = $('menuMore'); closePopups('menuMore'); m.hidden = !m.hidden; if (!m.hidden && window.TabBackup) window.TabBackup.refreshBadge(); };
  $('btnView').onclick = e => { e.stopPropagation(); const m = $('viewPanel'); closePopups('viewPanel'); m.hidden = !m.hidden; $('btnView').classList.toggle('on', !m.hidden); };
  $('viewPanel').onclick = e => e.stopPropagation();
  document.addEventListener('click', () => closePopups());
  $('menuVer').textContent = 'Tab Studio · versão ' + APP_VERSION;
  $('menuMore').onclick = e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    closePopups();
    ({ open: () => $('fileInput').click(), recent: recentDialog, reps: () => Rep.openLibrary('reps'), favs: () => Rep.openLibrary('favs'), backup: () => Backup.exportAll(), restore: () => Backup.pickRestore(), edit: () => toggleEdit(), new: newSongDialog, save: () => saveGp(), saveAs: () => saveAsFile(), download: () => downloadFile(), midi: exportMidi, print: printScore, demo: openDemo, info: infoDialog, shortcuts: shortcutsDialog, about: aboutDialog })[act]();
  };

  /* arrastar e soltar */
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; $('dropZone').hidden = false; e.preventDefault(); } });
  window.addEventListener('dragover', e => { e.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropZone').hidden = true; });
  window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('dropZone').hidden = true; const f = e.dataTransfer.files[0]; if (f) openFile(f); });

  /* arquivos abertos pelo sistema (PWA instalado) */
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async params => {
      if (!params.files || !params.files.length) return;
      const h = params.files[0]; const f = await h.getFile();
      openFile(f, /\.gp$/i.test(f.name) ? { saveHandle: h } : {});
    });
  }

  /* service worker */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadSW = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then(r => { try { r.update(); } catch (e) { /* segue */ } }).catch(() => { /* hospedagem sem suporte: segue sem offline */ });
    // versão nova instalada: atualiza na hora (se não houver trabalho sem salvar nem música tocando)
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadSW || reloading) return;
      const go = async () => { reloading = true; if (S.score && S.dirty) { clearTimeout(draftT); try { await Store.set('draft', { json: Ops.snapshot(S.score), name: S.fileName, time: Date.now(), v: APP_VERSION }); } catch (e) { /* segue */ } } location.reload(); };
      if (!S.dirty && !S.playing) { go(); return; }
      showMsg('Nova versão do Tab Studio', 'Uma versão nova foi baixada. Atualizar agora? (sua música fica guardada no rascunho)', [{ label: 'Depois', value: 'no' }, { label: 'Atualizar', value: 'ok', primary: true }]).then(v => { if (v === 'ok') go(); });
    });
  }

  /* ---------------- repertórios ---------------- */
  Rep = window.makeRepertoire({
    S, api, Store, $, esc, icon, toast, showMsg, confirmDlg, fmtSize, FRAMED, Wake,
    getRecent, openRecent, removeRecent, clearRecent, updateRecentButton, gcFile, hashBytes,
    getFavs, isFav, setFav, openFav, RECENT_MAX, storageWarn, getKept, putKept, cleanSt,
    loadBytes, parseScore, currentBytes, captureSettings, applyPlaySettings, afterMidi, setCountIn,
    zipStore, deliverZip, fileNotDelivered, clearDraft, addRecent, confirmLeave, updateDisk,
    openFilePicker: () => $('fileInput').click(), newSong: () => newSongDialog()
  });
  $('btnLib').onclick = () => Rep.openLibrary();
  const Backup = window.makeBackup({ S, Store, $, esc, toast, showMsg, APP_VERSION, FRAMED, Rep, zipBlob, deliverZip, fileNotDelivered, fmtSize, hashBytes,
    getRecent, getFavs, getKept, putKept, cleanSt, loadFavIds, updateRecentButton, RECENT_MAX });
  window.TabBackup = Backup;
  if (prefs.fsStrip === undefined) prefs.fsStrip = true;
  const FullView = window.makeFullView({ S, api, at, $, prefs, savePrefs, toast, icon, FRAMED, findAt, msPerTick, scheduleIdle, stepNote, setSpeed, toggle3d, paintRange, fmtTime,
    staveNow: () => STAVES[effStave()], fontDir: settings.core.fontDirectory, scriptFile: settings.core.scriptFile, scoreGen: () => 0 });

  /* ---------------- botão "voltar" do celular ----------------
     Mantém uma entrada extra no histórico: cada "voltar" fecha a camada de cima
     (lista aberta, menu, janela, painel, modo edição) sem sair do app nem parar a música.
     Sem nada aberto, pergunta se quer sair; só sai tocando em "Sair". */
  if (!FRAMED && history.pushState) {
    let exiting = false;
    const guard = () => { try { history.pushState({ tabstudio: 1 }, ''); } catch (e) { /* sem histórico */ } };
    const closeTop = () => {
      if (window.CustomSelect && CustomSelect.isOpen()) { CustomSelect.close(); return true; }
      if (!$('menuMore').hidden || !$('viewPanel').hidden || !$('keyPop').hidden) { closePopups(); return true; }
      const ds = [...document.querySelectorAll('dialog[open]')];
      if (ds.length) {
        const d = ds[ds.length - 1];
        if (d.id === 'dlgLib' && Rep.back()) return true;
        d.close('cancel'); return true;
      }
      if (!$('loopPanel').hidden && FullView.active) { $('btnLoop').click(); return true; }
      if (FullView.active) { FullView.exit(); return true; }
      if (!$('tracksPanel').hidden) { $('tracksPanel').hidden = true; $('btnTracks').classList.remove('on'); return true; }
      if (S.edit) { toggleEdit(false); return true; }
      if (!$('panel3d').hidden) { toggle3d(false); return true; }
      return false;
    };
    const askExit = async () => {
      const msg = S.score ? 'A música continua aberta se você ficar.' + (S.dirty ? '<br><b>Há alterações não salvas</b> (ficam guardadas como rascunho).' : '') : '';
      const v = await showMsg('Sair do Tab Studio?', msg, [{ label: 'Ficar', value: 'cancel', primary: true }, { label: 'Sair', value: 'exit' }]);
      if (v !== 'exit') return;
      exiting = true;
      history.back();   // tira a entrada extra; no aparelho, o próximo passo é fechar o app
      setTimeout(() => {
        try { window.close(); } catch (e) { /* o navegador não deixou */ }
        setTimeout(() => { if (!document.hidden) { exiting = false; toast('Toque em voltar mais uma vez para sair'); armed = true; } }, 400);
      }, 150);
    };
    let armed = false;
    // desistiu de sair e voltou a usar o app: volta a proteger o "voltar"
    document.addEventListener('pointerdown', () => { if (armed) { armed = false; guard(); } }, true);
    window.addEventListener('popstate', () => {
      if (exiting) { exiting = false; try { history.back(); } catch (e) { /* início do histórico */ } return; }
      if (armed) { armed = false; return; }
      guard();
      if (!closeTop()) askExit();
    });
    guard();
  }
  $('wReps').onclick = () => Rep.openLibrary('reps');
  $('btnRepAdd').onclick = () => Rep.addCurrent();

  checkDraft();

  // ganchos para testes automatizados
  window.TabStudio = { backup: Backup, fullView: FullView,
    version: APP_VERSION, api, Ops, state: S,
    loadBytes, setScore, getRecent, saveAsFile, downloadFile, rep: Rep, captureSettings, gcFile, openRecent, recentDialog, selectTrack, setVizMode, openLoopPanel, applyLoop, loopOff, setSpeed, seekToBar, setRangeBars, tbar, Wake: window.TabWake, zipStore, exportMidi, buildDemo, openDemo, toggleEdit, toggle3d, edAction, edSetFret, saveGp, undo, redo, commit, drawCursor, updateDisk, pendingChanges, stepNote, beatsAtTick
  };
})();
