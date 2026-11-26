/* Tab Studio — instrumento em tela inteira
   - deitado (tela cheia de verdade no Android/computador; no iPhone ocupa a janela e pede para girar)
   - só o instrumento; controles aparecem ao tocar no botão do canto (e somem sozinhos)
   - embaixo, uma linha só da partitura/tablatura da trilha do instrumento, correndo:
     a nota que toca fica no centro, marcada em verde */
(function (root) {
  'use strict';
  root.makeFullView = function (C) {
    const { S, api, at, $, prefs, savePrefs, toast, icon } = C;
    const SPEEDS = [25, 50, 60, 70, 80, 90, 100, 110, 125, 150];
    const coarse = () => matchMedia('(pointer: coarse)').matches;
    let active = false, real = false, sApi = null, sKey = '', sBusy = false, sReady = false, sDirty = true;
    let raf = 0, hideT = 0, lastTick = 0, lastAt = 0, scaleK = 1, natH = 0, curBeatId = -1, trkName = '';

    /* ---------------- faixa de uma linha ---------------- */
    function stripTrack() { return S.threeTrack >= 0 ? S.threeTrack : S.primary; }
    function stripScale() { return Math.min(innerWidth, innerHeight) < 500 ? 0.72 : 0.9; }
    function ensureApi() {
      if (sApi) return;
      const st = C.staveNow();
      sApi = new at.AlphaTabApi($('fsScore'), {
        core: { fontDirectory: C.fontDir, scriptFile: C.scriptFile, engine: 'svg', enableLazyLoading: false, includeNoteBounds: false },
        display: { layoutMode: at.LayoutMode.Horizontal, staveProfile: at.StaveProfile[st[0]], scale: stripScale(), padding: [12, 10, 10, 10] },
        notation: { rhythmMode: at.TabRhythmMode[st[1]] },
        player: { enablePlayer: false, enableCursor: false, enableUserInteraction: true }
      });
      const s = sApi.settings, col = c => at.model.Color.fromJson(c);
      try {
        const r = s.display.resources;
        r.mainGlyphColor = col('#F4F0FA'); r.secondaryGlyphColor = col('#B9AFCB'); r.scoreInfoColor = col('#F4F0FA');
        r.staffLineColor = col('#6E6382'); r.barSeparatorColor = col('#8A7FA0'); r.barNumberColor = col('#99CC33');
      } catch (e) { /* cores padrão */ }
      try {
        const E = at.NotationElement;
        ['ScoreTitle', 'ScoreSubTitle', 'ScoreArtist', 'ScoreAlbum', 'ScoreWords', 'ScoreMusic', 'ScoreWordsAndMusic', 'ScoreCopyright', 'GuitarTuning', 'TrackNames', 'ChordDiagrams']
          .forEach(k => { if (E[k] !== undefined) s.notation.elements.set(E[k], false); });
      } catch (e) { /* mostra tudo */ }
      sApi.updateSettings();
      sApi.postRenderFinished.on(() => { sBusy = false; sReady = true; measure(); curBeatId = -1; });
      sApi.renderStarted.on(() => { sReady = false; });
      // tocar numa nota da faixa: a música vai para lá
      sApi.beatMouseDown.on(b => {
        if (!b || !api.tickCache) return;
        try { api.tickPosition = api.tickCache.getBeatStart(b); C.scheduleIdle(); } catch (e) { /* fora do mapa */ }
        showUi(false);
      });
    }
    function measure() {
      const el = $('fsScore'); natH = el.scrollHeight || el.offsetHeight || 0;
      const maxH = Math.max(80, innerHeight * (innerHeight < 500 ? 0.36 : 0.32));
      scaleK = natH > maxH ? maxH / natH : 1;
      $('fsStrip').style.height = Math.round(natH * scaleK) + 'px';
      stripH();
    }
    // os controles ficam logo acima da faixa (ou no fundo, se ela estiver escondida)
    function stripH() { document.body.style.setProperty('--fs-strip-h', (prefs.fsStrip && !$('fsStrip').hidden ? $('fsStrip').offsetHeight : 0) + 'px'); }
    function wantKey() {
      const st = C.staveNow();
      return [stripTrack(), st[0], st[1], stripScale(), C.scoreGen()].join('|');
    }
    function renderStrip() {
      if (!S.score || !prefs.fsStrip) return;
      const k = wantKey();
      if (k === sKey && !sDirty) return;
      if (sBusy) return;
      ensureApi();
      const st = C.staveNow();
      sApi.settings.display.staveProfile = at.StaveProfile[st[0]];
      sApi.settings.notation.rhythmMode = at.TabRhythmMode[st[1]];
      sApi.settings.display.scale = stripScale();
      sApi.updateSettings();
      sKey = k; sDirty = false; sBusy = true; sReady = false;
      $('fsStrip').classList.add('loading');
      try { sApi.renderScore(S.score, [stripTrack()]); }
      catch (e) { sBusy = false; console.error(e); }
    }
    // onde a música está agora (entre uma atualização do player e outra, anda sozinho)
    function nowTick() {
      if (!S.playing) return api.tickPosition;
      const r = C.findAt(stripTrack(), lastTick);
      const bar = r && r.beat ? r.beat.voice.bar.index : 0;
      return lastTick + (performance.now() - lastAt) / C.msPerTick(bar);
    }
    function beatX(b) {
      try { const bb = sApi.boundsLookup && sApi.boundsLookup.findBeat(b); return bb ? bb.visualBounds : null; } catch (e) { return null; }
    }
    function syncStrip() {
      if (!sApi || !sReady || !prefs.fsStrip) return;
      $('fsStrip').classList.remove('loading');
      const tick = nowTick(), r = C.findAt(stripTrack(), tick);
      if (!r || !r.beat) return;
      const a = beatX(r.beat); if (!a) return;
      const cx = v => v.x + v.w / 2;   // o meio da nota vai para o meio da tela
      let x = cx(a);
      const nb = r.nextBeat ? beatX(r.nextBeat) : null;
      if (S.playing && nb && cx(nb) > x && r.end > r.start) x = x + (cx(nb) - x) * Math.max(0, Math.min(1, (tick - r.start) / (r.end - r.start)));
      const W = $('fsStrip').clientWidth, s = scaleK;
      $('fsStripIn').style.transform = 'translate3d(' + (W / 2 - x * s) + 'px,0,0) scale(' + s + ')';
      if (r.beat.id !== curBeatId) {
        curBeatId = r.beat.id;
        const m = $('fsBeat');
        m.style.left = (a.x - 6) + 'px'; m.style.top = '6px';
        m.style.width = (a.w + 12) + 'px'; m.style.height = Math.max(20, natH - 12) + 'px';   // coluna inteira (partitura e tablatura)
        m.hidden = false;
      }
    }

    /* ---------------- controles ---------------- */
    function showUi(on) {
      document.body.classList.toggle('fs-ui', on);
      $('fsToggle').setAttribute('aria-pressed', on ? 'true' : 'false');
      clearTimeout(hideT);
      if (on) armHide();
    }
    function armHide() {
      clearTimeout(hideT);
      hideT = setTimeout(() => {
        const busy = (window.CustomSelect && CustomSelect.isOpen()) || !$('loopPanel').hidden || document.querySelector('dialog[open]');
        if (busy || $('fsCtl').matches(':hover')) { armHide(); return; }
        showUi(false);
      }, 5000);
    }
    function speedTxt() { $('fsSpeed').textContent = Math.round(api.playbackSpeed * 100) + '%'; }
    function stepSpeed(d) {
      const cur = Math.round(api.playbackSpeed * 100);
      let i = d > 0 ? SPEEDS.findIndex(v => v > cur) : SPEEDS.length - 1 - [...SPEEDS].reverse().findIndex(v => v < cur);
      if (i < 0 || i >= SPEEDS.length) return;
      C.setSpeed(SPEEDS[i]); speedTxt();
    }
    function frame() {
      raf = requestAnimationFrame(frame);
      if (!S.score) return;
      renderStrip();
      syncStrip();
      const t = S.score.tracks[stripTrack()];
      const nm = t ? (t.name || 'Trilha ' + (t.index + 1)) : '';
      if (nm !== trkName) { trkName = nm; $('fsTrk').textContent = nm; }
      $('fsTitle').textContent = S.score.title || S.fileName || '';
      $('fsArtist').textContent = S.score.artist || '';
      $('fsLoop').classList.toggle('on', !!api.isLooping);
      speedTxt();
    }

    /* ---------------- entrar / sair ---------------- */
    async function enter() {
      if (active || !S.score) return;
      if ($('panel3d').hidden) C.toggle3d(true);
      active = true;
      document.body.classList.add('inst-fs');
      $('btnFull').innerHTML = icon('collapse'); $('btnFull').title = 'Sair da tela inteira';
      real = false;
      const de = document.documentElement;
      if (!C.FRAMED && de.requestFullscreen) {
        try { await de.requestFullscreen({ navigationUI: 'hide' }); real = true; } catch (e) { real = false; }
      }
      if (real && coarse() && screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => { /* aparelho não deixa */ });
      if (coarse() && matchMedia('(orientation: portrait)').matches) {
        const h = $('fsRotate'); h.hidden = false; setTimeout(() => { h.hidden = true; }, 4500);
      }
      sDirty = true; curBeatId = -1; trkName = '';
      $('fsStrip').hidden = !prefs.fsStrip; $('fsStripTog').classList.toggle('on', !!prefs.fsStrip); stripH();
      $('fsPlay').innerHTML = icon(S.playing ? 'pause' : 'play');
      lastTick = api.tickPosition; lastAt = performance.now();
      showUi(true);
      cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
      C.scheduleIdle();
    }
    function exit() {
      if (!active) return;
      active = false;
      document.body.classList.remove('inst-fs', 'fs-ui');
      $('btnFull').innerHTML = icon('expand'); $('btnFull').title = 'Tela inteira (instrumento deitado, só ele na tela)';
      cancelAnimationFrame(raf); clearTimeout(hideT);
      $('fsRotate').hidden = true;
      try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) { /* sem trava */ }
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => { /* já saiu */ });
      real = false;
      setTimeout(() => C.scheduleIdle(), 50);
    }
    document.addEventListener('fullscreenchange', () => { if (active && real && !document.fullscreenElement) exit(); });
    document.addEventListener('keydown', e => { if (active && e.key === 'Escape' && !document.querySelector('dialog[open]') && !(window.CustomSelect && CustomSelect.isOpen())) exit(); });
    addEventListener('resize', () => { if (!active) return; if (sKey && sKey !== wantKey()) sDirty = true; if (sReady) measure(); else stripH(); });

    api.playerPositionChanged.on(e => { lastTick = e.currentTick; lastAt = performance.now(); if (active && !S.seekingFs && e.endTime > 0) { $('fsSeek').value = Math.round(e.currentTime / e.endTime * 1000); C.paintRange($('fsSeek')); $('fsCur').textContent = C.fmtTime(e.currentTime); $('fsEnd').textContent = C.fmtTime(e.endTime); } });
    api.playerStateChanged.on(e => { const p = e.state === 1; $('fsPlay').innerHTML = icon(p ? 'pause' : 'play'); lastTick = api.tickPosition; lastAt = performance.now(); });
    api.renderStarted.on(resize => { if (!resize) sDirty = true; });

    $('btnFull').onclick = () => { if (active) exit(); else enter(); };
    $('fsToggle').onclick = () => showUi(!document.body.classList.contains('fs-ui'));
    $('fsCtl').addEventListener('pointerdown', () => armHide());
    $('panel3d').addEventListener('pointerdown', e => { if (active && document.body.classList.contains('fs-ui') && e.target.closest('.p3d-bar, .p3d-opts, .fs-top')) armHide(); });
    $('fsPlay').onclick = () => $('btnPlay').click();
    $('fsStop').onclick = () => api.stop();
    $('fsBack').onclick = () => C.stepNote(-1);
    $('fsFwd').onclick = () => C.stepNote(1);
    $('fsSlower').onclick = () => stepSpeed(-1);
    $('fsFaster').onclick = () => stepSpeed(1);
    $('fsLoop').onclick = () => $('btnLoop').click();
    $('fsTrkUp').onclick = () => { $('btnTrkUp').click(); curBeatId = -1; };
    $('fsTrkDown').onclick = () => { $('btnTrkDown').click(); curBeatId = -1; };
    $('fsStripTog').onclick = () => {
      prefs.fsStrip = !prefs.fsStrip; savePrefs();
      $('fsStrip').hidden = !prefs.fsStrip; $('fsStripTog').classList.toggle('on', !!prefs.fsStrip);
      sDirty = true; stripH(); armHide();
    };
    $('fsSeek').addEventListener('input', () => { S.seekingFs = true; });
    $('fsSeek').addEventListener('change', () => { S.seekingFs = false; if (S.endTime > 0) api.timePosition = $('fsSeek').value / 1000 * S.endTime; });

    return { enter, exit, get active() { return active; }, strip: () => sApi, syncNow: () => { renderStrip(); syncStrip(); } };
  };
})(window);
