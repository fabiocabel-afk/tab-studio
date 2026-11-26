/* Tab Studio — repertórios: listas de músicas com os ajustes de cada uma (velocidade,
   trilhas, metrônomo, contagem e mixer), tocadas em sequência, exportadas e importadas pela banda.
   Os arquivos ficam guardados uma vez só no aparelho ('file:<id>') e são compartilhados com os recentes. */
(function (root) {
  'use strict';
  root.makeRepertoire = function (C) {
    const { S, api, Store, $, esc, icon, toast, showMsg, confirmDlg } = C;
    const KEY = 'reps';
    const FORMAT = 'tabstudio-repertoire';
    const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
    const str = v => (typeof v === 'string' ? v : '').trim();
    const songName = it => it.title || (it.name || '').replace(/\.[^.]+$/, '') || 'Sem título';
    const plural = (n, a, b) => n + ' ' + (n === 1 ? a : b);

    /* ---------------- armazenamento ---------------- */
    let queue = Promise.resolve();
    async function load() { const l = await Store.get(KEY); return Array.isArray(l) ? l : []; }
    async function list() { try { return await load(); } catch (e) { return []; } }
    // alterações em fila: cada uma lê a lista atual, muda e grava (nunca sobrescreve a anterior)
    function mutate(fn) {
      const run = queue.then(async () => { const l = await load(); const r = await fn(l); await Store.set(KEY, l); return r; });
      queue = run.catch(() => { /* o erro é tratado por quem chamou */ });
      return run;
    }
    function saveErr(e, what) {
      showMsg('Não foi possível salvar', (what || 'O repertório') + ' <b>não</b> foi gravado no aparelho.<br><span class="muted">' + esc((e && e.message) || e) + '</span><br><br>Verifique se há espaço livre no aparelho e tente de novo.');
    }
    async function usesFile(fid) { try { return (await load()).some(r => r.items.some(it => it.fid === fid)); } catch (e) { return true; } }
    async function putFile(bytes) { const fid = C.hashBytes(bytes); await Store.set('file:' + fid, bytes); return fid; }
    // pede ao navegador para não apagar os dados do app quando faltar espaço
    function askPersist() {
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persisted().then(p => p || navigator.storage.persist()).catch(() => { /* sem suporte */ }); } catch (e) { /* sem suporte */ }
    }
    async function createRep(name) {
      try {
        const r = await mutate(l => { const r = { id: uid(), name, created: Date.now(), updated: Date.now(), mode: 'direct', repeat: false, items: [] }; l.push(r); return r; });
        askPersist(); return r;
      } catch (e) { saveErr(e); return null; }
    }
    function addItem(repId, item) {
      return mutate(l => {
        const r = l.find(x => x.id === repId); if (!r) throw new Error('repertório não encontrado');
        const ex = r.items.find(it => it.fid === item.fid);
        r.updated = Date.now();
        if (ex) {
          if (item.settings) ex.settings = item.settings;
          Object.assign(ex, { name: item.name, title: item.title, artist: item.artist, size: item.size });
          return { status: 'updated', rep: r.name, n: r.items.length, iid: ex.iid };
        }
        const it = Object.assign({ iid: uid(), added: Date.now() }, item);
        r.items.push(it);
        return { status: 'added', rep: r.name, n: r.items.length, iid: it.iid };
      });
    }
    function setOpt(repId, patch) { return mutate(l => { const r = l.find(x => x.id === repId); if (r) { Object.assign(r, patch); r.updated = Date.now(); } }); }

    /* ---------------- ajustes da música aberta (gravados sozinhos) ---------------- */
    let lastSaved = null, seq = 0;
    function flushSettings() {
      if (!S.rep || S.repPending) return;
      const st = C.captureSettings(); if (!st) return;
      const js = JSON.stringify(st); if (js === lastSaved) return;
      lastSaved = js;
      const { id, iid } = S.rep;
      mutate(l => { const r = l.find(x => x.id === id); const it = r && r.items.find(x => x.iid === iid); if (it) { it.settings = st; r.updated = Date.now(); } })
        .catch(e => { lastSaved = null; toast('Atenção: os ajustes desta música no repertório não foram gravados (' + ((e && e.message) || e) + ')', 'err', 7000); });
    }
    setInterval(flushSettings, 1500);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSettings(); });
    root.addEventListener('pagehide', flushSettings);
    function leaving() { clearTimeout(S.repWait); if (S.rep) flushSettings(); }
    function cleanSettings(st) {
      if (!st || typeof st !== 'object') return null;
      const int = (v, a, b) => Number.isFinite(+v) ? Math.max(a, Math.min(b, Math.round(+v))) : null;
      const o = { speed: int(st.speed, 10, 300) || 100, loop: null, prog: null, tracks: [], primary: int(st.primary, 0, 999), trackName: str(st.trackName).slice(0, 80), metro: !!st.metro, countIn: !!st.countIn, mix: {} };
      // trecho e repetição não vêm junto (são treino do momento)
      if (Array.isArray(st.tracks)) o.tracks = st.tracks.map(x => int(x, 0, 999)).filter(x => x != null).slice(0, 64);
      if (st.mix && typeof st.mix === 'object') for (const k of Object.keys(st.mix).slice(0, 64)) { const m = st.mix[k]; if (m && int(k, 0, 999) != null) o.mix[int(k, 0, 999)] = { mute: !!m.mute, solo: !!m.solo, vol: Math.max(0, Math.min(1.5, +m.vol || 0)) }; }
      return o;
    }

    /* ---------------- tocar em sequência ---------------- */
    async function openItem(repId, index, autoplay) {
      const r = (await list()).find(x => x.id === repId);
      if (!r || index < 0 || index >= r.items.length) return false;
      const it = r.items[index];
      if (S.dirty && !(await confirmDlg('Alterações não salvas', 'A música atual tem alterações que ainda não foram salvas. Abrir outra música vai descartá-las.', 'Descartar e abrir'))) return false;
      let bytes = null; try { bytes = await Store.get('file:' + it.fid); } catch (e) { bytes = null; }
      if (!bytes) { showMsg('Música não encontrada', 'O arquivo de <b>' + esc(songName(it)) + '</b> não está mais guardado neste aparelho. Tire a música do repertório e adicione de novo.'); return false; }
      const st = it.settings || {};
      const token = ++seq;
      S.dirty = false; // já confirmado acima
      const ok = C.loadBytes(bytes, it.name || songName(it), { rep: { id: r.id, iid: it.iid }, tracks: st.tracks, primary: st.primary, mix: st.mix });
      if (!ok) { S.rep = null; S.repPending = false; updateBar(); return false; }
      C.clearDraft();
      lastSaved = JSON.stringify(it.settings || null);
      let done = false;
      const apply = () => {
        if (done || token !== seq || !S.rep || S.rep.iid !== it.iid) return;
        done = true;
        C.applyPlaySettings(st);
        if (autoplay) startPlay(r.mode === 'count');
      };
      C.afterMidi(apply);
      setTimeout(apply, 8000); // segurança: se o MIDI demorar, aplica assim mesmo
      updateBar();
      return true;
    }
    function startPlay(withCount) {
      const go = () => {
        if (withCount && !(api.countInVolume > 0)) { api.countInVolume = 1; S.tempCount = true; }
        C.Wake.request(); api.play();
      };
      if (S.playerReady) { go(); return; }
      let n = 0; const t = setInterval(() => { if (S.playerReady) { clearInterval(t); go(); } else if (++n > 150) clearInterval(t); }, 200);
    }
    async function step(d) {
      if (!S.rep) return;
      const r = (await list()).find(x => x.id === S.rep.id); if (!r || !r.items.length) return;
      const i = r.items.findIndex(x => x.iid === S.rep.iid);
      let ni = i + d;
      if (ni < 0 || ni >= r.items.length) { if (!r.repeat) { toast(d > 0 ? 'Esta é a última música do repertório' : 'Esta é a primeira música do repertório'); return; } ni = (ni + r.items.length) % r.items.length; }
      const was = S.playing;
      if (was) api.stop();
      openItem(r.id, ni, was);
    }
    function onFinished() {
      if (!S.rep || api.isLooping) return;
      const cur = S.rep, token = ++seq;
      list().then(reps => {
        const r = reps.find(x => x.id === cur.id); if (!r) return;
        const i = r.items.findIndex(x => x.iid === cur.iid); if (i < 0) return;
        let ni = i + 1;
        if (ni >= r.items.length) {
          if (!r.repeat) { toast('Fim do repertório "' + r.name + '"', 'ok', 5000); return; }
          ni = 0;
        }
        const nx = r.items[ni];
        const wait = r.mode === 'count' ? 700 : 2500;
        toast('Próxima: ' + songName(nx) + (r.mode === 'count' ? ' — com contagem' : ''), '', wait + 1800);
        clearTimeout(S.repWait);
        S.repWait = setTimeout(() => {
          if (token !== seq || !S.rep || S.rep.iid !== cur.iid || S.playing) return;
          openItem(r.id, ni, true);
        }, wait);
      });
    }
    // música do repertório salva pelo usuário: o repertório passa a usar o arquivo novo
    async function onSaved(data) {
      if (!S.rep) return;
      const { id, iid } = S.rep;
      try {
        const fid = await putFile(data);
        let old = null;
        await mutate(l => {
          const r = l.find(x => x.id === id); const it = r && r.items.find(x => x.iid === iid); if (!it) return;
          if (it.fid !== fid) old = it.fid;
          Object.assign(it, { fid, size: data.length, title: (S.score && S.score.title) || it.title, artist: (S.score && S.score.artist) || it.artist });
          r.updated = Date.now();
        });
        if (old) await C.gcFile(old);
        refreshLib();
      } catch (e) { saveErr(e, 'A versão nova da música no repertório'); }
    }

    /* ---------------- barra do repertório no player ---------------- */
    async function updateBar() {
      const bar = $('repBar');
      const r = S.rep ? (await list()).find(x => x.id === S.rep.id) : null;
      const i = r ? r.items.findIndex(x => x.iid === S.rep.iid) : -1;
      if (!r || i < 0) { bar.hidden = true; document.body.classList.remove('in-rep'); return; }
      bar.hidden = false; document.body.classList.add('in-rep');
      $('rbName').querySelector('b').textContent = r.name;
      $('rbPos').textContent = (i + 1) + '/' + r.items.length;
      $('rbPrev').disabled = i <= 0 && !r.repeat;
      $('rbNext').disabled = i >= r.items.length - 1 && !r.repeat;
    }
    $('rbPrev').onclick = () => step(-1);
    $('rbNext').onclick = () => step(1);
    $('rbName').onclick = () => { if (S.rep) openLibrary({ rep: S.rep.id }); };
    $('rbClose').onclick = () => { leaving(); S.rep = null; S.repPending = false; updateBar(); toast('Saiu do repertório — a música continua aberta'); };

    /* ---------------- nome (novo / renomear) ---------------- */
    function askName(title, val) {
      const d = $('dlgName'), inp = $('nameInput');
      $('nameTitle').textContent = title; inp.value = val || ''; d.returnValue = '';
      return new Promise(res => {
        inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); d.close('ok'); } };
        d.onclose = () => { const v = inp.value.trim().slice(0, 60); if (d.returnValue === 'ok' && !v) toast('Digite um nome para o repertório'); res(d.returnValue === 'ok' && v ? v : null); };
        d.showModal(); setTimeout(() => { inp.focus(); inp.select(); }, 30);
      });
    }

    /* ---------------- escolher repertório (de um recente ou da música tocando) ---------------- */
    // repertórios em linhas compridas, no mesmo jeito da lista de recentes
    function card(r, withPlay) {
      const row = el('div', 'rep-row' + (S.rep && S.rep.id === r.id ? ' playing' : ''));
      row.dataset.id = r.id;
      row.innerHTML = '<button type="button" class="rr-open"><span class="rc-ic">' + icon('rep') + '</span><span class="rr-txt"><b>' + esc(r.name) + '</b><span>' + plural(r.items.length, 'música', 'músicas') + ' · ' + (r.mode === 'count' ? 'contagem' : 'direto') + (r.repeat ? ' · repete' : '') + '</span></span></button>' +
        (withPlay ? '<button type="button" class="rr-play" title="Tocar o repertório"' + (r.items.length ? '' : ' disabled') + '>' + icon('play') + '</button>' : '');
      return row;
    }
    function newCard() {
      const b = el('button', 'rep-row new', '<span class="rr-txt"><b>Novo repertório</b></span><span class="rr-plus">' + icon('plus') + '</span>');
      b.type = 'button'; return b;
    }
    async function pickRep(sub, make) {
      const d = $('dlgPick'); $('pickSub').textContent = sub;
      const go = async id => {
        d.close();
        let item = null;
        try { item = await make(); } catch (e) { saveErr(e, 'A música'); return; }
        if (!item) return;
        try {
          const res = await addItem(id, item);
          toast(res.status === 'updated' ? 'Já estava em "' + res.rep + '": ajustes atualizados' : 'Adicionada a "' + res.rep + '" (' + plural(res.n, 'música', 'músicas') + ')', 'ok', 4000);
          if (S.rep && S.rep.id === id && res.iid === S.rep.iid) lastSaved = JSON.stringify(item.settings || null);
          refreshLib(); updateBar();
        } catch (e) { await C.gcFile(item.fid).catch(() => { /* segue */ }); saveErr(e, 'A música'); }
      };
      const box = $('pickList'); box.innerHTML = '';
      (await list()).forEach(r => { const b = card(r, false); b.querySelector('.rr-open').onclick = () => go(r.id); box.appendChild(b); });
      const nb = newCard();
      nb.onclick = async () => { d.close(); const name = await askName('Novo repertório', ''); if (!name) return; const r = await createRep(name); if (r) { refreshLib(); go(r.id); } };
      box.appendChild(nb);
      $('pickClose').onclick = () => d.close();
      d.showModal();
    }
    async function itemFromRecent(m) {
      let b = null; try { b = await Store.get('file:' + m.id); } catch (e) { b = null; }
      if (!b) { toast('Esse arquivo não está mais guardado no aparelho — abra pelo "Abrir arquivo"', 'err'); return null; }
      return { fid: m.id, name: m.name, title: m.title || '', artist: m.artist || '', size: m.size || b.length, settings: null };
    }
    async function itemFromCurrent() {
      if (!S.score) { toast('Abra uma música primeiro'); return null; }
      let bytes;
      try { bytes = C.currentBytes(); }
      catch (e) { showMsg('Não foi possível adicionar', 'A música aberta não pôde ser preparada para o repertório (nada foi alterado):<br><span class="muted">' + esc(e.message || e) + '</span>'); return null; }
      const fid = await putFile(bytes);
      const sc = S.score;
      return { fid, name: (S.fileName || sc.title || 'musica') + extOf(bytes), title: sc.title || '', artist: sc.artist || '', size: bytes.length, settings: C.captureSettings() };
    }
    function addCurrent() {
      if (!S.score) { toast('Abra uma música primeiro'); return; }
      pickRep('"' + (S.score.title || S.fileName) + '" vai com os ajustes de agora: velocidade, trilhas, metrônomo, contagem e mixer (o trecho em repetição não vai: é treino do momento).', itemFromCurrent);
    }
    function extOf(b) {
      const head = String.fromCharCode.apply(null, b.subarray(0, 32));
      if (b[0] === 0x50 && b[1] === 0x4b) return '.gp';
      if (/^BCF[ZS]/.test(head)) return '.gpx';
      const m = /FICHIER GUITAR PRO v(\d)/.exec(head); if (m) return '.gp' + Math.max(3, Math.min(5, +m[1]));
      if (/^\s*</.test(head)) return '.xml';
      return '.gp';
    }

    /* ---------------- janela "Músicas": abrir, recentes e repertórios ---------------- */
    const L = { tab: 'recent', repId: null, adding: false };
    function refreshLib() { if ($('dlgLib').open) renderLib(); }
    async function openLibrary(where) {
      if (where === 'recent' || where === 'reps') { L.tab = where; L.repId = null; L.adding = false; }
      else if (where && where.rep) { L.tab = 'reps'; L.repId = where.rep; L.adding = false; }
      else if (S.rep) { L.tab = 'reps'; L.repId = S.rep.id; L.adding = false; }
      await renderLib();
      const d = $('dlgLib'); if (!d.open) d.showModal();
    }
    function closeLib() { $('dlgLib').close(); }
    async function renderLib() {
      const tabs = $('libTabs');
      tabs.querySelectorAll('button').forEach(b => {
        b.classList.toggle('on', b.dataset.tab === L.tab);
        b.onclick = () => { L.tab = b.dataset.tab; L.repId = null; L.adding = false; renderLib(); };
      });
      // a janela fica sempre igual: título, as duas guias e o corpo; só o conteúdo do corpo muda
      const head = $('libHead');
      if (!head.firstChild) {
        head.innerHTML = '<h3>' + icon('lib') + '<span>Músicas</span></h3><button type="button" class="x" data-close title="Fechar">' + icon('close') + '</button>';
        head.querySelector('[data-close]').onclick = closeLib;
      }
      if (L.tab === 'reps' && L.repId) {
        const r = (await list()).find(x => x.id === L.repId);
        if (r) return L.adding ? drawAdd(r) : drawRep(r);
        L.repId = null;
      }
      return L.tab === 'recent' ? drawRecent() : drawReps();
    }
    function recentRow(m, mode, inRep) {
      const row = el('div', 'rec');
      const sub = [m.title && m.title !== m.name.replace(/\.[^.]+$/, '') ? m.title : '', m.artist].filter(Boolean).join(' — ');
      row.innerHTML = '<button type="button" class="rec-open"><b>' + esc(m.name) + '</b><span>' + (sub ? esc(sub) + ' · ' : '') + C.fmtSize(m.size) + ' · ' + new Date(m.time).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) + '</span></button>' +
        (mode === 'pick'
          ? (inRep ? '<span class="rec-in" title="Já está no repertório">' + icon('check') + '</span>' : '<button type="button" class="rec-add" title="Adicionar ao repertório">' + icon('plus') + '</button>')
          : '<button type="button" class="rec-add" title="Adicionar a um repertório">' + icon('repadd') + '</button><button type="button" class="x" title="Tirar da lista">' + icon('close') + '</button>');
      return row;
    }
    async function drawRecent() {
      const body = $('libBody'), foot = $('libFoot');
      const items = await C.getRecent();
      body.innerHTML = '<div id="recentList"></div>';
      const box = $('recentList');
      if (!items.length) box.innerHTML = '<p class="muted">Nenhum arquivo aberto ainda. Os últimos 20 arquivos que você abrir ou salvar aparecem aqui, mesmo sem internet.</p>';
      items.forEach(m => {
        const row = recentRow(m, 'list');
        row.querySelector('.rec-open').onclick = () => { closeLib(); C.openRecent(m.id); };
        row.querySelector('.rec-add').onclick = () => pickRep('"' + m.name + '"', () => itemFromRecent(m));
        row.querySelector('.x').onclick = async () => { await C.removeRecent(m.id); drawRecent(); };
        box.appendChild(row);
      });
      foot.innerHTML = items.length ? '<button type="button" class="btn danger" id="recentClear">' + icon('trash') + 'Limpar lista</button>' : '';
      if (items.length) $('recentClear').onclick = async () => {
        if (!(await confirmDlg('Limpar recentes', 'Tirar todos os arquivos da lista de recentes? Os arquivos originais no seu aparelho não são apagados, e as músicas que estão em repertórios continuam nos repertórios.', 'Limpar'))) return;
        await C.clearRecent(); drawRecent();
      };
    }
    async function drawReps() {
      const body = $('libBody'), foot = $('libFoot');
      const reps = await list();
      body.innerHTML = '<div class="rep-list" id="repGrid"></div>';
      const grid = $('repGrid');
      reps.forEach(r => {
        const c = card(r, true);
        c.querySelector('.rr-open').onclick = () => { L.repId = r.id; renderLib(); };
        c.querySelector('.rr-play').onclick = () => { closeLib(); if (S.playing) api.stop(); openItem(r.id, 0, true); };
        grid.appendChild(c);
      });
      const nb = newCard();
      nb.onclick = async () => { const name = await askName('Novo repertório', ''); if (!name) return; const r = await createRep(name); if (r) { L.repId = r.id; renderLib(); } };
      grid.appendChild(nb);
      foot.innerHTML = '<button type="button" class="btn" id="repImport">' + icon('import') + 'Importar repertório</button><span class="muted foot-hint">Recebeu um repertório da banda? Importe o arquivo .zip.</span>';
      $('repImport').onclick = () => pickFile('import');
    }
    function chips(st) {
      if (!st) return '';
      const c = [];
      if (st.speed && st.speed !== 100) c.push(st.speed + '%');
      if (st.trackName) c.push(st.trackName);
      if (st.metro) c.push('metrônomo');
      if (st.countIn) c.push('contagem');
      return c.map(x => '<i class="chip">' + esc(x) + '</i>').join('');
    }
    function drawRep(r) {
      const body = $('libBody'), foot = $('libFoot');
      const active = S.rep && S.rep.id === r.id;
      body.innerHTML = '<div class="lib-sub"><button type="button" class="x back" id="repBack" title="Voltar aos repertórios">' + icon('back') + '</button>' +
        '<b class="rep-title">' + esc(r.name) + '</b>' +
        '<div class="rep-acts"><button type="button" class="x" id="repRename" title="Renomear">' + icon('edit') + '</button>' +
        '<button type="button" class="x" id="repShare" title="Exportar / compartilhar com a banda">' + icon('share') + '</button>' +
        '<button type="button" class="x danger" id="repDelete" title="Apagar repertório">' + icon('trash') + '</button></div></div>';
      $('repBack').onclick = () => { L.repId = null; renderLib(); };
      $('repRename').onclick = async () => {
        const name = await askName('Renomear repertório', r.name); if (!name || name === r.name) return;
        try { await setOpt(r.id, { name }); } catch (e) { saveErr(e); return; }
        renderLib(); updateBar();
      };
      $('repShare').onclick = () => shareRep(r);
      $('repDelete').onclick = async () => {
        if (!(await confirmDlg('Apagar repertório', 'Apagar o repertório <b>' + esc(r.name) + '</b> e os ajustes guardados das músicas dele? As músicas continuam nos recentes (se estiverem lá). Isso não pode ser desfeito.', 'Apagar'))) return;
        let fids = [];
        try { await mutate(l => { const i = l.findIndex(x => x.id === r.id); if (i >= 0) { fids = l[i].items.map(x => x.fid); l.splice(i, 1); } }); }
        catch (e) { saveErr(e, 'A exclusão do repertório'); return; }
        for (const f of fids) await C.gcFile(f).catch(() => { /* segue */ });
        if (S.rep && S.rep.id === r.id) { S.rep = null; S.repPending = false; }
        L.repId = null; renderLib(); updateBar(); toast('Repertório apagado');
      };
      const ul = el('div', 'rep-items'); ul.id = 'repItems';
      if (!r.items.length) ul.appendChild(el('p', 'muted', 'Repertório vazio. Toque em <b>Adicionar música</b> para escolher dos recentes ou do aparelho.'));
      r.items.forEach((it, i) => {
        const row = el('div', 'ri' + (active && S.rep.iid === it.iid ? ' playing' : ''));
        row.dataset.iid = it.iid;
        row.innerHTML = '<span class="grip" title="Arrastar para mudar a ordem">' + icon('grip') + '</span><span class="ri-n">' + (i + 1) + '</span>' +
          '<button type="button" class="ri-open"><b>' + esc(songName(it)) + '</b><span>' + (it.artist ? esc(it.artist) : '') + chips(it.settings) + '</span></button>' +
          '<button type="button" class="x ri-del" title="Tirar do repertório">' + icon('close') + '</button>';
        row.querySelector('.ri-open').onclick = async () => { const idx = [...ul.querySelectorAll('.ri')].indexOf(row); closeLib(); openItem(r.id, idx, false); };
        row.querySelector('.ri-del').onclick = async () => {
          if (!(await confirmDlg('Tirar do repertório', 'Tirar <b>' + esc(songName(it)) + '</b> do repertório <b>' + esc(r.name) + '</b>? Os ajustes guardados dela neste repertório serão perdidos.', 'Tirar'))) return;
          try { await mutate(l => { const x = l.find(y => y.id === r.id); if (x) { x.items = x.items.filter(y => y.iid !== it.iid); x.updated = Date.now(); } }); }
          catch (e) { saveErr(e); return; }
          await C.gcFile(it.fid).catch(() => { /* segue */ });
          if (S.rep && S.rep.iid === it.iid) { S.rep = null; S.repPending = false; }
          renderLib(); updateBar();
        };
        ul.appendChild(row);
      });
      const add = el('button', 'ri-add', icon('plus') + '<span>Adicionar música</span>'); add.type = 'button';
      add.onclick = () => { L.adding = true; renderLib(); };
      ul.appendChild(add);
      body.appendChild(ul);
      enableDrag(ul, async iids => {
        try { await mutate(l => { const x = l.find(y => y.id === r.id); if (!x) return; const by = new Map(x.items.map(y => [y.iid, y])); const nw = iids.map(k => by.get(k)).filter(Boolean); x.items.forEach(y => { if (!nw.includes(y)) nw.push(y); }); x.items = nw; x.updated = Date.now(); }); }
        catch (e) { saveErr(e, 'A nova ordem'); }
        renderLib(); updateBar();
      });
      foot.innerHTML = '<div class="rep-opts"><span class="lbl">Entre as músicas</span>' +
        '<div class="seg" id="repMode" role="group" aria-label="Passagem entre as músicas"><button type="button" data-v="direct" title="Passa direto para a próxima, com uma pausa curta (como faixas de um CD)">Direto</button><button type="button" data-v="count" title="Antes de cada música, contagem das baquetas (1-2-3-4)">Contagem</button></div>' +
        '<label class="sw"><span class="sw-txt">Repetir repertório</span><input type="checkbox" id="repRepeat"' + (r.repeat ? ' checked' : '') + '><span class="knob"></span></label></div>' +
        '<button type="button" class="btn primary big" id="repPlay"' + (r.items.length ? '' : ' disabled') + '>' + icon('play') + (active ? 'Tocar do início' : 'Tocar repertório') + '</button>';
      foot.querySelectorAll('#repMode button').forEach(b => {
        b.classList.toggle('on', b.dataset.v === (r.mode || 'direct'));
        b.onclick = async () => {
          try { await setOpt(r.id, { mode: b.dataset.v }); } catch (e) { saveErr(e); return; }
          r.mode = b.dataset.v; foot.querySelectorAll('#repMode button').forEach(x => x.classList.toggle('on', x === b));
        };
      });
      $('repRepeat').onchange = async () => {
        const v = $('repRepeat').checked;
        try { await setOpt(r.id, { repeat: v }); } catch (e) { $('repRepeat').checked = !v; saveErr(e); return; }
        r.repeat = v; updateBar();
      };
      $('repPlay').onclick = async () => { closeLib(); if (S.playing) api.stop(); openItem(r.id, 0, true); };
    }
    // arrastar pela alça para mudar a ordem (mouse e toque)
    function enableDrag(box, onDone) {
      box.querySelectorAll('.grip').forEach(g => g.addEventListener('pointerdown', e => {
        const row = g.closest('.ri'); if (!row) return;
        e.preventDefault();
        const pid = e.pointerId;
        row.classList.add('dragging');
        let moved = false;
        const scroller = $('libBody');
        // escuta no documento: mover a linha na lista solta a "captura" do ponteiro
        const move = ev => {
          if (ev.pointerId !== pid) return;
          ev.preventDefault();
          const others = [...box.querySelectorAll('.ri')].filter(o => o !== row);
          const idx = others.filter(o => { const rc = o.getBoundingClientRect(); return rc.top + rc.height / 2 < ev.clientY; }).length;
          const ref = others[idx] || box.querySelector('.ri-add');
          if (row.nextElementSibling !== ref) { box.insertBefore(row, ref); moved = true; box.querySelectorAll('.ri .ri-n').forEach((n, i) => { n.textContent = i + 1; }); }
          const b = scroller.getBoundingClientRect();
          if (ev.clientY < b.top + 30) scroller.scrollTop -= 10; else if (ev.clientY > b.bottom - 30) scroller.scrollTop += 10;
        };
        const up = ev => {
          if (ev.pointerId !== pid) return;
          document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up);
          row.classList.remove('dragging');
          if (moved) onDone([...box.querySelectorAll('.ri')].map(o => o.dataset.iid));
        };
        document.addEventListener('pointermove', move, { passive: false }); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
      }));
    }
    async function drawAdd(r) {
      const body = $('libBody'), foot = $('libFoot');
      const has = new Set(r.items.map(x => x.fid));
      body.innerHTML = '<div class="lib-sub"><button type="button" class="x back" id="addBack" title="Voltar ao repertório">' + icon('back') + '</button><b class="rep-title">Adicionar a "' + esc(r.name) + '"</b></div><div class="add-src"><button type="button" class="btn" id="addDevice">' + icon('folder') + 'Escolher no aparelho</button>' +
        (S.score ? '<button type="button" class="btn" id="addCurrent">' + icon('repadd') + 'A música aberta agora</button>' : '') + '</div><div class="lbl add-lbl">Recentes</div><div id="addList"></div>';
      $('addBack').onclick = () => { L.adding = false; renderLib(); };
      $('addDevice').onclick = () => pickFile('add', r.id);
      if (S.score) $('addCurrent').onclick = async () => {
        let item; try { item = await itemFromCurrent(); } catch (e) { saveErr(e, 'A música'); return; }
        if (!item) return;
        try { const res = await addItem(r.id, item); toast(res.status === 'updated' ? 'Já estava no repertório: ajustes atualizados' : 'Adicionada com os ajustes de agora', 'ok'); }
        catch (e) { await C.gcFile(item.fid).catch(() => { /* segue */ }); saveErr(e, 'A música'); return; }
        renderLib(); updateBar();
      };
      const box = $('addList');
      const items = await C.getRecent();
      if (!items.length) box.innerHTML = '<p class="muted">Nenhum arquivo recente. Use <b>Escolher no aparelho</b>.</p>';
      items.forEach(m => {
        const row = recentRow(m, 'pick', has.has(m.id));
        const addIt = async () => {
          if (has.has(m.id)) { toast('Essa música já está no repertório'); return; }
          const item = await itemFromRecent(m); if (!item) return;
          try { await addItem(r.id, item); } catch (e) { saveErr(e, 'A música'); return; }
          toast('Adicionada: ' + m.name, 'ok'); renderLib();
        };
        row.querySelector('.rec-open').onclick = addIt;
        const b = row.querySelector('.rec-add'); if (b) b.onclick = addIt;
        box.appendChild(row);
      });
      foot.innerHTML = '<button type="button" class="btn primary" id="addDone">' + icon('check') + 'Pronto</button>';
      $('addDone').onclick = () => { L.adding = false; renderLib(); };
    }
    function pickFile(mode, repId) {
      const inp = $('repFileInput');
      inp.accept = mode === 'import' ? '.zip,.tabrep,application/zip' : '.gp,.gp3,.gp4,.gp5,.gpx,.musicxml,.mxl,.xml,.capx,.tex,.txt';
      inp.multiple = mode === 'add';
      inp.value = '';
      inp.onchange = async () => {
        const files = [...inp.files]; inp.value = '';
        if (!files.length) return;
        if (mode === 'import') {
          try { importBytes(new Uint8Array(await files[0].arrayBuffer()), files[0].name); }
          catch (e) { showMsg('Erro ao ler arquivo', esc(e.message)); }
        } else addFiles(repId, files);
      };
      inp.click();
    }
    async function addFiles(repId, files) {
      let ok = 0; const bad = [];
      for (const f of files) {
        let bytes, sc;
        try { bytes = new Uint8Array(await f.arrayBuffer()); sc = C.parseScore(bytes); } catch (e) { bad.push(f.name); continue; }
        let fid = null;
        try { fid = await putFile(bytes); await addItem(repId, { fid, name: f.name, title: sc.title || '', artist: sc.artist || '', size: bytes.length, settings: null }); ok++; }
        catch (e) { if (fid) await C.gcFile(fid).catch(() => { /* segue */ }); saveErr(e, 'A música <b>' + esc(f.name) + '</b>'); break; }
      }
      if (bad.length) showMsg('Arquivo não reconhecido', 'Não foi possível ler como tablatura/partitura: <b>' + bad.map(esc).join('</b>, <b>') + '</b>.');
      if (ok) toast(plural(ok, 'música adicionada', 'músicas adicionadas'), 'ok');
      refreshLib(); updateBar();
    }

    /* ---------------- exportar / importar (arquivo .zip para a banda) ---------------- */
    function safe(n) { return (n || 'repertorio').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'repertorio'; }
    async function buildExport(r) {
      const files = [], items = [], missing = [];
      for (const it of r.items) {
        let b = null; try { b = await Store.get('file:' + it.fid); } catch (e) { b = null; }
        if (!b) { missing.push(songName(it)); continue; }
        const path = 'musicas/' + String(items.length + 1).padStart(2, '0') + ' - ' + safe(songName(it)).slice(0, 60) + extOf(b);
        files.push({ name: path, data: b });
        items.push({ name: it.name, title: it.title, artist: it.artist, file: path, settings: it.settings || null });
      }
      const meta = { format: FORMAT, version: 1, name: r.name, mode: r.mode || 'direct', repeat: !!r.repeat, exported: new Date().toISOString(), items };
      files.unshift({ name: 'repertorio.json', data: new TextEncoder().encode(JSON.stringify(meta, null, 1)) });
      return { zip: C.zipStore(files), missing, count: items.length };
    }
    async function shareRep(r) {
      if (!r.items.length) { toast('Repertório vazio — adicione músicas antes de exportar'); return; }
      let res;
      try { res = await buildExport(r); } catch (e) { showMsg('Não foi possível exportar', esc(e.message || e)); return; }
      if (res.missing.length && !(await confirmDlg('Músicas faltando', 'Estas músicas não estão mais guardadas no aparelho e vão ficar de fora: <b>' + res.missing.map(esc).join('</b>, <b>') + '</b>.', 'Exportar assim'))) return;
      if (!res.count) { toast('Nenhuma música para exportar', 'err'); return; }
      const fname = safe(r.name) + '.repertorio.zip';
      let file = null; try { file = new File([res.zip], fname, { type: 'application/zip' }); } catch (e) { file = null; }
      const canShare = !C.FRAMED && file && navigator.canShare && (() => { try { return navigator.canShare({ files: [file] }); } catch (e) { return false; } })();
      let how = 'download';
      if (canShare) {
        how = await showMsg('Exportar "' + r.name + '"', 'O repertório vai num arquivo <b>' + esc(fname) + '</b> (' + C.fmtSize(res.zip.length) + ') com as ' + plural(res.count, 'música', 'músicas') + ' e os ajustes de cada uma. Quem receber abre no Tab Studio em <b>Músicas › Repertórios › Importar repertório</b>.',
          [{ label: 'Cancelar', value: 'cancel' }, { label: 'Baixar arquivo', value: 'download' }, { label: 'Compartilhar', value: 'share', primary: true }]);
        if (how !== 'download' && how !== 'share') return;
      }
      if (how === 'share') {
        try { await navigator.share({ files: [file], title: 'Repertório ' + r.name, text: 'Repertório "' + r.name + '" do Tab Studio — abra em Músicas › Repertórios › Importar repertório.' }); toast('Repertório compartilhado', 'ok'); return; }
        catch (e) { if (e && e.name === 'AbortError') { toast('Compartilhamento cancelado'); return; } }
      }
      const got = await C.deliverZip(res.zip, fname);
      if (got === 'download' || got === 'zip') toast('Repertório exportado: ' + fname + ' — envie esse arquivo para a banda', 'ok', 6000);
      else C.fileNotDelivered(got);
    }
    async function readZip(bytes) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let eocd = -1;
      for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      if (eocd < 0) throw new Error('não é um arquivo .zip válido');
      const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
      const dec = new TextDecoder(); const ent = {};
      for (let k = 0; k < n; k++) {
        if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('arquivo .zip danificado');
        const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
        ent[dec.decode(bytes.subarray(p + 46, p + 46 + nl))] = { method, csize, off };
        p += 46 + nl + xl + cl;
      }
      return {
        names: Object.keys(ent),
        async get(name) {
          const e = ent[name]; if (!e) return null;
          const start = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true);
          const raw = bytes.subarray(start, start + e.csize);
          if (e.method === 0) return raw.slice();
          if (e.method === 8) {
            if (typeof DecompressionStream === 'undefined') throw new Error('este navegador não consegue descompactar o .zip');
            const s = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            return new Uint8Array(await new Response(s).arrayBuffer());
          }
          throw new Error('tipo de compressão não suportado');
        }
      };
    }
    async function isRepZip(bytes) {
      if (!bytes || bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
      try { return (await readZip(bytes)).names.includes('repertorio.json'); } catch (e) { return false; }
    }
    async function importBytes(bytes, fname) {
      const fail = msg => showMsg('Não foi possível importar', 'O arquivo <b>' + esc(fname) + '</b> não é um repertório do Tab Studio válido.<br><span class="muted">' + esc(msg) + '</span>');
      let z, meta;
      try { z = await readZip(bytes); const j = await z.get('repertorio.json'); if (!j) throw new Error('falta o repertorio.json'); meta = JSON.parse(new TextDecoder().decode(j)); }
      catch (e) { fail(e.message || e); return null; }
      if (!meta || meta.format !== FORMAT || !Array.isArray(meta.items)) { fail('formato desconhecido'); return null; }
      const items = [], bad = [];
      for (const it of meta.items.slice(0, 500)) {
        const label = str(it && it.title) || str(it && it.name) || str(it && it.file);
        try {
          const b = await z.get(str(it.file)); if (!b) { bad.push(label); continue; }
          const sc = C.parseScore(b);
          items.push({ bytes: b, name: str(it.name).slice(0, 200) || label, title: sc.title || str(it.title), artist: sc.artist || str(it.artist), settings: cleanSettings(it.settings) });
        } catch (e) { bad.push(label); }
      }
      if (!items.length) { fail('nenhuma música válida dentro do arquivo'); return null; }
      let name = str(meta.name).slice(0, 60) || 'Repertório importado';
      const reps = await list();
      const same = reps.find(r => r.name === name);
      let replaceId = null;
      if (same) {
        const v = await showMsg('Repertório já existe', 'Você já tem um repertório chamado <b>' + esc(name) + '</b>. Substituir pelo recebido (a lista e os ajustes dele) ou manter os dois?',
          [{ label: 'Cancelar', value: 'cancel' }, { label: 'Manter os dois', value: 'both' }, { label: 'Substituir', value: 'replace', primary: true }]);
        if (v === 'replace') replaceId = same.id;
        else if (v === 'both') { let k = 2; while (reps.some(r => r.name === name + ' (' + k + ')')) k++; name = name + ' (' + k + ')'; }
        else return null;
      }
      const stored = []; let oldFids = [], rep;
      try {
        for (const it of items) { it.fid = await putFile(it.bytes); stored.push(it.fid); it.size = it.bytes.length; delete it.bytes; }
        rep = await mutate(l => {
          const r = { id: uid(), name, created: Date.now(), updated: Date.now(), mode: meta.mode === 'count' ? 'count' : 'direct', repeat: !!meta.repeat,
            items: items.map(it => ({ iid: uid(), added: Date.now(), fid: it.fid, name: it.name, title: it.title, artist: it.artist, size: it.size, settings: it.settings })) };
          const i = replaceId ? l.findIndex(x => x.id === replaceId) : -1;
          if (i >= 0) { oldFids = l[i].items.map(x => x.fid); r.id = l[i].id; r.created = l[i].created; l[i] = r; } else l.push(r);
          return r;
        });
      } catch (e) {
        for (const f of stored) await C.gcFile(f).catch(() => { /* segue */ });
        saveErr(e, 'O repertório importado'); return null;
      }
      for (const f of oldFids) await C.gcFile(f).catch(() => { /* segue */ });
      if (replaceId && S.rep && S.rep.id === replaceId) { S.rep = null; S.repPending = false; updateBar(); }
      askPersist();
      if (bad.length) showMsg('Importado com avisos', 'O repertório <b>' + esc(name) + '</b> foi importado com ' + plural(items.length, 'música', 'músicas') + '. Ficaram de fora (arquivo ausente ou danificado): <b>' + bad.map(esc).join('</b>, <b>') + '</b>.');
      else toast('Repertório importado: ' + name + ' (' + plural(items.length, 'música', 'músicas') + ')', 'ok', 5000);
      openLibrary({ rep: rep.id });
      return rep;
    }

    // botão voltar do celular dentro da janela Músicas: volta um nível (adicionar → repertório → lista)
    function back() {
      if (!$('dlgLib').open) return false;
      if (L.adding) { L.adding = false; renderLib(); return true; }
      if (L.repId) { L.repId = null; renderLib(); return true; }
      return false;
    }
    return { back, openLibrary, addCurrent, usesFile, leaving, onFinished, onSaved, updateBar, isRepZip, importBytes, list, openItem, step, buildExport, readZip, flush: flushSettings, createRep, addItem };
  };
})(window);
