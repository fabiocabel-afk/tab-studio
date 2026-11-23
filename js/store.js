/* Tab Studio — armazenamento local (IndexedDB) para o rascunho automático. */
(function (root) {
  'use strict';
  const DB = 'tabstudio', STORE = 'kv', VER = 1;
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      if (!('indexedDB' in root)) { rej(new Error('IndexedDB indisponível')); return; }
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || new Error('Falha ao abrir IndexedDB'));
    });
    return dbp;
  }
  function tx(mode, fn) {
    return open().then(db => new Promise((res, rej) => {
      const t = db.transaction(STORE, mode);
      const s = t.objectStore(STORE);
      const req = fn(s);
      t.oncomplete = () => res(req && typeof req === 'object' && 'result' in req ? req.result : undefined);
      t.onerror = () => rej(t.error || new Error('Erro de transação'));
      t.onabort = () => rej(t.error || new Error('Transação abortada'));
    }));
  }
  const Store = {
    get(key) { return tx('readonly', s => s.get(key)); },
    set(key, val) { return tx('readwrite', s => { s.put(val, key); }); },
    del(key) { return tx('readwrite', s => { s.delete(key); }); }
  };
  root.TabStore = Store;
})(window);
