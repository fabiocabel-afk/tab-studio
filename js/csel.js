/* Tab Studio — listas personalizadas (no lugar do menu branco do navegador).
 * A <select> original continua no lugar, escondida, e segue sendo a "fonte da verdade":
 * o código do app lê e muda select.value normalmente. Por cima dela fica um botão do app
 * e, ao tocar, um menu nosso. Opções desativadas com só "──" viram um separador.
 *   data-full  = texto completo (mostrado na lista aberta)
 *   texto da opção = rótulo curto (mostrado no botão fechado) */
(function () {
  const svg = id => '<svg class="i" aria-hidden="true"><use href="#i-' + id + '"/></svg>';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const VAL = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const IDX = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  let openPop = null;

  function close() {
    if (!openPop) return;
    const { pop, btn } = openPop; openPop = null;
    pop.remove(); btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false');
  }
  function enhance(sel) {
    if (sel._cs || sel.multiple) return;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    if (sel.id) btn.id = sel.id + 'Btn';
    sel.classList.add('cs-native'); sel.tabIndex = -1; sel.setAttribute('aria-hidden', 'true');
    sel.after(btn);
    const sync = () => {
      const o = sel.options[IDX.get.call(sel)];
      const icon = o && o.dataset.icon ? svg(o.dataset.icon) : (sel.dataset.icon ? svg(sel.dataset.icon) : '');
      btn.className = 'cs' + (sel.dataset.cs ? ' ' + sel.dataset.cs : '') + (openPop && openPop.btn === btn ? ' open' : '');
      btn.innerHTML = icon + '<span class="cs-lbl">' + esc(o ? (o.dataset.btn || o.textContent) : '') + '</span>' + svg('chev');
      btn.hidden = sel.hidden; btn.disabled = sel.disabled;
      btn.title = sel.title || '';
    };
    // mudanças feitas pelo código (select.value = …) também atualizam o botão
    Object.defineProperty(sel, 'value', { configurable: true, get() { return VAL.get.call(this); }, set(v) { VAL.set.call(this, v); sync(); } });
    Object.defineProperty(sel, 'selectedIndex', { configurable: true, get() { return IDX.get.call(this); }, set(v) { IDX.set.call(this, v); sync(); } });
    new MutationObserver(sync).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'title', 'data-cs', 'selected'] });
    sel.addEventListener('change', sync);
    btn.addEventListener('click', e => { e.stopPropagation(); if (openPop && openPop.btn === btn) close(); else open(sel, btn); });
    btn.addEventListener('keydown', e => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const opts = [...sel.options]; let i = IDX.get.call(sel);
      do { i += e.key === 'ArrowDown' ? 1 : -1; } while (opts[i] && opts[i].disabled);
      if (opts[i]) choose(sel, i);
    });
    sel._cs = { btn, sync };
    sync();
  }
  function choose(sel, i) {
    if (IDX.get.call(sel) === i) { sel._cs.sync(); return; }
    IDX.set.call(sel, i); sel._cs.sync();
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function open(sel, btn) {
    close();
    // o app pode trocar os textos ao abrir (listas compactas): avisa antes de montar
    sel.dispatchEvent(new Event('cs-open'));
    const pop = document.createElement('div');
    pop.className = 'cs-pop'; pop.setAttribute('role', 'listbox');
    const cur = IDX.get.call(sel);
    [...sel.options].forEach((o, i) => {
      const full = o.dataset.full || o.textContent;
      if (o.disabled && /^[\s─—\-]+$/.test(full)) { const hr = document.createElement('hr'); pop.appendChild(hr); return; }
      const it = document.createElement('button');
      it.type = 'button'; it.className = 'cs-opt' + (i === cur ? ' on' : ''); it.disabled = o.disabled;
      it.setAttribute('role', 'option'); it.setAttribute('aria-selected', i === cur ? 'true' : 'false');
      it.dataset.value = o.value;
      it.innerHTML = (i === cur ? svg('check') : '<i class="cs-sp"></i>') + (o.dataset.icon ? svg(o.dataset.icon) : '') + '<span>' + esc(full) + '</span>';
      it.addEventListener('click', e => { e.stopPropagation(); close(); choose(sel, i); btn.focus({ preventScroll: true }); });
      pop.appendChild(it);
    });
    // dentro de um diálogo aberto o menu precisa morar no próprio diálogo (camada de cima)
    (btn.closest('dialog[open]') || document.body).appendChild(pop);
    const r = btn.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
    pop.style.minWidth = Math.max(r.width, 170) + 'px';
    const w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(r.left, vw - w - 8)) + 'px';
    const below = vh - r.bottom - 8, above = r.top - 8;
    if (h <= below || below >= above) { pop.style.top = (r.bottom + 6) + 'px'; pop.style.maxHeight = (below - 6) + 'px'; }
    else { pop.style.bottom = (vh - r.top + 6) + 'px'; pop.style.maxHeight = (above - 6) + 'px'; }
    const on = pop.querySelector('.cs-opt.on'); if (on) on.scrollIntoView({ block: 'nearest' });
    btn.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
    openPop = { pop, btn, sel };
  }
  document.addEventListener('pointerdown', e => { if (openPop && !openPop.pop.contains(e.target) && e.target !== openPop.btn && !openPop.btn.contains(e.target)) close(); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && openPop) { e.stopPropagation(); close(); } }, true);
  window.addEventListener('resize', close);
  // fecha só se a rolagem mexer no lugar do botão (a partitura rola sozinha durante a música e não deve fechar a lista)
  document.addEventListener('scroll', e => {
    if (!openPop || openPop.pop.contains(e.target)) return;
    const t = e.target;
    if (t === document || t === document.documentElement || t === document.body || (t.contains && t.contains(openPop.btn))) close();
  }, true);

  function scan(root) { (root.querySelectorAll ? root : document).querySelectorAll('select').forEach(enhance); if (root.tagName === 'SELECT') enhance(root); }
  window.CustomSelect = { enhance, scan, close, isOpen: () => !!openPop };
  const start = () => {
    scan(document);
    new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n); }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
