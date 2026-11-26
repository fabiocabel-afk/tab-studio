/* Tab Studio — backup completo: recentes, favoritos e repertórios (com os arquivos e os ajustes)
   num único .zip, e restauração sem apagar nada do que já está no aparelho.
   O contador no menu mostra quantas músicas e repertórios mudaram desde o último backup. */
(function (root) {
  'use strict';
  root.makeBackup = function (C) {
    const { S, Store, $, esc, toast, showMsg } = C;
    const FORMAT = 'tabstudio-backup';
    const plural = (n, a, b) => n + ' ' + (n === 1 ? a : b);
    const safe = t => String(t || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'musica';

    function askPersist() { try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { /* sem suporte */ }); } catch (e) { /* sem suporte */ } }
    async function info() { try { return (await Store.get('backupInfo')) || null; } catch (e) { return null; } }
    async function gather() {
      const [recent, favs, reps, kept] = await Promise.all([C.getRecent(), C.getFavs(), C.Rep.list(), C.getKept()]);
      const ids = new Set();
      recent.forEach(m => ids.add(m.id)); favs.forEach(m => ids.add(m.id));
      reps.forEach(r => r.items.forEach(it => ids.add(it.fid)));
      return { recent, favs, reps, kept, ids };
    }
    /** o que mudou desde o último backup: músicas novas e repertórios criados/alterados */
    async function pending() {
      const g = await gather(), b = await info();
      const had = new Set(b ? b.ids : []), repAt = (b && b.reps) || {};
      const songs = [...g.ids].filter(id => !had.has(id)).length;
      const reps = g.reps.filter(r => !(r.id in repAt) || (r.updated || 0) > repAt[r.id]).length;
      return { songs, reps, total: songs + reps, last: b ? b.time : 0, any: g.ids.size + g.reps.length };
    }
    async function refreshBadge() {
      let p; try { p = await pending(); } catch (e) { return; }
      const n = p.total, txt = n > 99 ? '99+' : String(n);
      const bd = $('moreBadge'), it = $('bkBadge'), sub = $('bkSub');
      if (bd) { bd.hidden = !n; bd.textContent = txt; }
      if (it) { it.hidden = !n; it.textContent = txt; }
      if (sub) {
        const parts = [];
        if (p.songs) parts.push(plural(p.songs, 'música', 'músicas'));
        if (p.reps) parts.push(plural(p.reps, 'repertório', 'repertórios'));
        sub.textContent = (parts.length ? parts.join(' e ') + ' fora do backup' : (p.any ? 'tudo guardado' : 'nada para guardar ainda')) +
          (p.last ? ' · último: ' + new Date(p.last).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');
      }
      $('btnMore').title = n ? 'Menu — ' + plural(n, 'item', 'itens') + ' fora do backup' : 'Menu';
    }

    /* ---------------- exportar tudo ---------------- */
    async function exportAll() {
      let g; try { g = await gather(); } catch (e) { showMsg('Backup não feito', 'Não foi possível ler os dados do app: ' + esc(e.message || e)); return false; }
      if (!g.ids.size && !g.reps.length) { toast('Nada para guardar ainda: abra ou adicione músicas primeiro'); return false; }
      const files = [], paths = {}, missing = [], saved = [];
      const nameOf = id => { const m = g.recent.find(x => x.id === id) || g.favs.find(x => x.id === id); if (m) return m.name; for (const r of g.reps) { const it = r.items.find(x => x.fid === id); if (it) return it.name || it.title; } return id; };
      let total = 0;
      for (const id of g.ids) {
        let b = null; try { b = await Store.get('file:' + id); } catch (e) { b = null; }
        if (!b) { missing.push(nameOf(id)); continue; }
        const nm = nameOf(id).replace(/\.[^.]+$/, '');
        const path = 'musicas/' + safe(nm) + ' [' + id + ']' + C.Rep.extOf(b);
        files.push({ name: path, data: b }); paths[id] = path; saved.push(id); total += b.length;
      }
      const has = id => id in paths;
      const meta = {
        format: FORMAT, version: 1, app: C.APP_VERSION, created: new Date().toISOString(),
        recent: g.recent.filter(m => has(m.id)), favs: g.favs.filter(m => has(m.id)),
        reps: g.reps.map(r => Object.assign({}, r, { items: r.items.filter(it => has(it.fid)) })),
        kept: g.kept, files: paths
      };
      files.unshift({ name: 'tabstudio-backup.json', data: new TextEncoder().encode(JSON.stringify(meta)) });
      const d = new Date(), pad = n => String(n).padStart(2, '0');
      const fname = 'tab-studio-backup-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.zip';
      const blob = C.zipBlob(files);
      const intro = 'O backup tem <b>' + plural(saved.length, 'música', 'músicas') + '</b> (recentes, favoritos e repertórios), <b>' + plural(g.reps.length, 'repertório', 'repertórios') + '</b> e os ajustes de cada uma — ' + C.fmtSize(blob.size) + '.' +
        (missing.length ? '<br><br><span class="muted">Ficam de fora (o arquivo não está mais no aparelho): ' + missing.slice(0, 8).map(esc).join(', ') + (missing.length > 8 ? ' e mais ' + (missing.length - 8) : '') + '.</span>' : '') +
        '<br><br>Guarde o arquivo <b>' + esc(fname) + '</b> fora do aparelho (Google Drive, computador, e-mail). Para recuperar: menu › <b>Restaurar backup</b>.';
      let file = null; try { file = new File([blob], fname, { type: 'application/zip' }); } catch (e) { file = null; }
      const canShare = !C.FRAMED && file && navigator.canShare && (() => { try { return navigator.canShare({ files: [file] }); } catch (e) { return false; } })();
      const how = await showMsg('Fazer backup de tudo', intro, [{ label: 'Cancelar', value: 'cancel' }].concat(canShare ? [{ label: 'Baixar arquivo', value: 'download' }, { label: 'Compartilhar', value: 'share', primary: true }] : [{ label: 'Baixar backup', value: 'download', primary: true }]));
      if (how !== 'download' && how !== 'share') return false;
      let ok = false;
      if (how === 'share') {
        try { await navigator.share({ files: [file], title: 'Backup do Tab Studio' }); ok = true; }
        catch (e) { if (e && e.name === 'AbortError') { toast('Backup cancelado — nada foi marcado como guardado'); return false; } }
      }
      if (!ok) {
        const got = await C.deliverZip(blob, fname);
        if (got !== 'download' && got !== 'zip') { C.fileNotDelivered(got); return false; }
        ok = true;
      }
      const reps = {}; g.reps.forEach(r => { reps[r.id] = r.updated || 0; });
      try { await Store.set('backupInfo', { time: Date.now(), ids: saved, reps, name: fname }); } catch (e) { /* o arquivo já foi entregue */ }
      askPersist();
      toast('Backup feito: ' + fname + ' (' + plural(saved.length, 'música', 'músicas') + ')', 'ok', 6000);
      refreshBadge();
      return true;
    }

    /* ---------------- restaurar (junta com o que já existe; nada é apagado) ---------------- */
    async function isBackupZip(bytes) {
      if (!bytes || bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
      try { return (await C.Rep.readZip(bytes)).names.includes('tabstudio-backup.json'); } catch (e) { return false; }
    }
    async function restore(bytes, fname) {
      const fail = msg => showMsg('Não foi possível restaurar', 'O arquivo <b>' + esc(fname) + '</b> não é um backup válido do Tab Studio.<br><span class="muted">' + esc(msg) + '</span>');
      let z, meta;
      try { z = await C.Rep.readZip(bytes); const j = await z.get('tabstudio-backup.json'); if (!j) throw new Error('falta o tabstudio-backup.json'); meta = JSON.parse(new TextDecoder().decode(j)); }
      catch (e) { fail(e.message || e); return null; }
      if (!meta || meta.format !== FORMAT || typeof meta.files !== 'object') { fail('formato desconhecido'); return null; }
      const ok = await showMsg('Restaurar backup', 'Backup de <b>' + esc(new Date(meta.created).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })) + '</b> com ' + plural(Object.keys(meta.files).length, 'música', 'músicas') + ' e ' + plural((meta.reps || []).length, 'repertório', 'repertórios') + '.<br><br>Ele é <b>somado</b> ao que já está no aparelho: nada do que você tem agora é apagado. Repertórios com o mesmo nome e diferenças entram como cópia "(backup)".',
        [{ label: 'Cancelar', value: 'cancel' }, { label: 'Restaurar', value: 'ok', primary: true }]);
      if (ok !== 'ok') return null;
      // 1) arquivos (confere cada um: o id é o próprio conteúdo)
      const map = {}, bad = [];
      for (const [id, path] of Object.entries(meta.files)) {
        try {
          const b = await z.get(String(path)); if (!b) { bad.push(path); continue; }
          const nid = C.hashBytes(b);
          await Store.set('file:' + nid, b); map[id] = nid;
        } catch (e) { bad.push(path); if (e && /quota|space|espaço/i.test(String(e.message || e.name))) { showMsg('Sem espaço', 'O aparelho ficou sem espaço durante a restauração. O que já foi copiado continua guardado; libere espaço e restaure de novo (nada é duplicado).'); break; } }
      }
      const fix = m => (m && map[m.id]) ? Object.assign({}, m, { id: map[m.id] }) : null;
      const res = { recent: 0, favs: 0, reps: null };
      try {
        // 2) recentes: junta, mais novos primeiro, até o limite
        const cur = await C.getRecent(), have = new Set(cur.map(m => m.id));
        const add = (meta.recent || []).map(fix).filter(m => m && !have.has(m.id));
        res.recent = add.length;
        const all = cur.concat(add).sort((a, b) => (b.time || 0) - (a.time || 0));
        const kept = await C.getKept();
        for (const [id, st] of Object.entries(meta.kept || {})) { const nid = map[id] || id; if (!kept[nid] && st) kept[nid] = C.cleanSt(st); }
        for (const m of all.slice(C.RECENT_MAX)) if (m.settings && !kept[m.id]) kept[m.id] = m.settings;
        await C.putKept(kept);
        await Store.set('recent', all.slice(0, C.RECENT_MAX));
        // 3) favoritos
        const fl = await C.getFavs(), fh = new Set(fl.map(m => m.id));
        const fa = (meta.favs || []).map(fix).filter(m => m && !fh.has(m.id));
        res.favs = fa.length;
        await Store.set('favs', fl.concat(fa));
        await C.loadFavIds();
        // 4) repertórios
        const reps = (meta.reps || []).map(r => Object.assign({}, r, { items: (r.items || []).filter(it => map[it.fid]).map(it => Object.assign({}, it, { fid: map[it.fid] })) }));
        res.reps = await C.Rep.mergeImported(reps);
      } catch (e) {
        showMsg('Restauração incompleta', 'Parte do backup não pôde ser gravada: ' + esc(e.message || e) + '.<br>O que já estava no aparelho não foi alterado. Tente de novo (nada é duplicado).');
        return null;
      }
      // o que veio do backup já está guardado nesse arquivo
      try {
        const b = (await info()) || { time: 0, ids: [], reps: {} };
        const ids = new Set(b.ids); Object.values(map).forEach(id => ids.add(id));
        b.ids = [...ids]; if (!b.time) b.time = Date.parse(meta.created) || Date.now();
        b.reps = b.reps || {};
        const now = await C.Rep.list();
        for (const r of meta.reps || []) { const x = now.find(y => y.id === r.id); if (x && (x.updated || 0) === (r.updated || 0)) b.reps[r.id] = x.updated || 0; }
        await Store.set('backupInfo', b);
      } catch (e) { /* só o contador */ }
      C.updateRecentButton(); askPersist(); refreshBadge();
      const r = res.reps || { added: 0, copies: 0, same: 0 };
      showMsg('Backup restaurado', '<b>' + plural(Object.keys(map).length, 'música', 'músicas') + '</b> conferidas e guardadas.<br>' +
        'Recentes: ' + plural(res.recent, 'nova', 'novas') + ' · Favoritos: ' + plural(res.favs, 'novo', 'novos') + '<br>' +
        'Repertórios: ' + plural(r.added, 'novo', 'novos') + (r.copies ? ', ' + plural(r.copies, 'cópia "(backup)"', 'cópias "(backup)"') : '') + (r.same ? ', ' + plural(r.same, 'já existia igual', 'já existiam iguais') : '') +
        (bad.length ? '<br><br><span class="muted">' + plural(bad.length, 'arquivo danificado ficou', 'arquivos danificados ficaram') + ' de fora.</span>' : ''));
      return res;
    }
    function pickRestore() { const i = $('bkFileInput'); i.value = ''; i.click(); }
    $('bkFileInput').onchange = async () => {
      const f = $('bkFileInput').files[0]; if (!f) return;
      const b = new Uint8Array(await f.arrayBuffer());
      if (!(await isBackupZip(b))) {
        if (await C.Rep.isRepZip(b)) { C.Rep.importBytes(b, f.name); return; }
        showMsg('Não é um backup', 'O arquivo <b>' + esc(f.name) + '</b> não é um backup do Tab Studio. O backup se chama <b>tab-studio-backup-….zip</b>.'); return;
      }
      restore(b, f.name);
    };
    setInterval(refreshBadge, 5000);
    refreshBadge();
    return { exportAll, restore, isBackupZip, pending, refreshBadge, pickRestore };
  };
})(window);
