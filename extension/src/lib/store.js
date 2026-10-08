/* Where the extension keeps things.

   - local (on disk): the server address, this device's token, the account,
     the public identity, settings, and the vault cache: ciphertext exactly as
     the server sent it. Nothing here opens anything.
   - session (memory only, cleared when Chrome quits, unreadable by content
     scripts): the identity's private keys and the unwrapped vault keys while
     unlocked. Locking empties it.
   - IndexedDB: the handoff private key while a sign-in is in flight (a
     non-extractable key object, which chrome.storage cannot hold). */

export class Area {
  constructor(backend) {
    this.backend = backend;
  }

  async get(key, fallback = null) {
    const out = await this.backend.get(key);
    return out[key] === undefined ? fallback : out[key];
  }

  async set(key, value) {
    await this.backend.set({ [key]: value });
  }

  async remove(...keys) {
    await this.backend.remove(keys);
  }

  async clear() {
    await this.backend.clear();
  }
}

/** A chrome.storage-shaped area in memory, for tests. */
export class MemoryBackend {
  constructor() {
    this.data = new Map();
  }

  async get(key) {
    return this.data.has(key) ? { [key]: structuredClone(this.data.get(key)) } : {};
  }

  async set(values) {
    for (const [key, value] of Object.entries(values)) this.data.set(key, structuredClone(value));
  }

  async remove(keys) {
    for (const key of keys) this.data.delete(key);
  }

  async clear() {
    this.data.clear();
  }
}

/** A chrome.storage-shaped area in IndexedDB: the Windows app's disk store,
    with no size limit (the vault cache can be several megabytes). */
export class IdbBackend {
  constructor(name) {
    this.name = name;
  }

  open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("values");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async run(mode, work) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("values", mode);
      let out;
      const request = work(tx.objectStore("values"));
      if (request) request.onsuccess = () => { out = request.result; };
      tx.oncomplete = () => { db.close(); resolve(out); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  async get(key) {
    const value = await this.run("readonly", (s) => s.get(key));
    return value === undefined ? {} : { [key]: value };
  }

  async set(values) {
    await this.run("readwrite", (s) => { for (const [key, value] of Object.entries(values)) s.put(value, key); });
  }

  async remove(keys) {
    await this.run("readwrite", (s) => { for (const key of keys) s.delete(key); });
  }

  async clear() {
    await this.run("readwrite", (s) => s.clear());
  }
}

// -- IndexedDB, for the handoff key -----------------------------------------------

const DB_NAME = "orbit-pass";
const STORE = "keys";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let out;
    const request = work(tx.objectStore(STORE));
    if (request) request.onsuccess = () => { out = request.result; };
    tx.oncomplete = () => { db.close(); resolve(out); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

/** Key objects that must survive a service-worker restart mid-flow. */
export const keyStore = {
  async put(name, value) {
    if (typeof indexedDB === "undefined") { memoryKeys.set(name, value); return; }
    await withStore("readwrite", (store) => store.put(value, name));
  },
  async get(name) {
    if (typeof indexedDB === "undefined") return memoryKeys.get(name) || null;
    return (await withStore("readonly", (store) => store.get(name))) || null;
  },
  async delete(name) {
    if (typeof indexedDB === "undefined") { memoryKeys.delete(name); return; }
    await withStore("readwrite", (store) => store.delete(name));
  },
};

const memoryKeys = new Map();

export const DEFAULT_SETTINGS = {
  // Minutes without use before the vault locks; 0 locks only when Chrome quits.
  autoLockMinutes: 30,
  lockWhenComputerLocks: true,
  // Offer saved logins when a sign-in field is clicked.
  inlineMenu: true,
  // Run the on-device field model when a page loads.
  smartDetection: true,
  // Copy the login's verification code after filling it.
  copyTotpAfterFill: true,
  // Offer to save logins after a form is submitted.
  offerToSave: true,
  // Sites never to offer saving on.
  neverSave: [],
  // Show websites' icons beside logins (lib/icons.js): each login's site is
  // sent to the Orbit Pass server, which fetches and keeps its icon.
  siteIcons: true,
};
