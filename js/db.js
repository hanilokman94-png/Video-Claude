// Customer & visit storage. Everything stays in this browser on this device (IndexedDB).

const DB_NAME = 'skinscope';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('customers')) db.createObjectStore('customers', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('visits')) {
          const v = db.createObjectStore('visits', { keyPath: 'id' });
          v.createIndex('customerId', 'customerId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((r) => (out = r));
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const db = {
  async customers() {
    const all = await tx('customers', 'readonly', (s) => reqP(s.getAll()));
    return (all || []).sort((a, b) => (b.lastVisit || b.created || 0) - (a.lastVisit || a.created || 0));
  },
  async customer(id) { return tx('customers', 'readonly', (s) => reqP(s.get(id))); },
  async saveCustomer(c) { await tx('customers', 'readwrite', (s) => s.put(c)); return c; },
  async deleteCustomer(id) {
    const visits = await this.visits(id);
    await tx('visits', 'readwrite', (s) => visits.forEach((v) => s.delete(v.id)));
    await tx('customers', 'readwrite', (s) => s.delete(id));
  },
  async visits(customerId) {
    const all = await tx('visits', 'readonly', (s) => reqP(s.index('customerId').getAll(customerId)));
    return (all || []).sort((a, b) => a.date - b.date);
  },
  async allVisitSummaries() {
    // light-weight list used for the clinic reference averages (no photos)
    const all = await tx('visits', 'readonly', (s) => reqP(s.getAll()));
    return (all || []).map(({ photos, ...rest }) => rest);
  },
  async visit(id) { return tx('visits', 'readonly', (s) => reqP(s.get(id))); },
  async saveVisit(v) { await tx('visits', 'readwrite', (s) => s.put(v)); return v; },
  async deleteVisit(id) { await tx('visits', 'readwrite', (s) => s.delete(id)); },
  async estimate() {
    try { return await navigator.storage?.estimate?.(); } catch { return null; }
  },
  async persist() {
    try { return await navigator.storage?.persist?.(); } catch { return false; }
  },
};
