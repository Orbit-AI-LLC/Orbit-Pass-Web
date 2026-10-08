/* Website icons: the picture beside a login.

   A login shows its site's icon. The site is the registrable domain of its
   first web address ("github.com" for https://gist.github.com/login), and
   that name is all that leaves the device: the server keeps one icon per site
   for everyone and fetches a site it hasn't seen (apps/vaults/icons.py). This
   device keeps its own copy, so a page draws icons without asking again:

   - an icon is asked for again after a month, a site with none after a day;
   - the copy lives in IndexedDB, each host's own (the extension's, the
     Windows app's, the web vault's site), or in memory where there is none;
   - signing out, or turning icons off in Settings, empties it. */

import { exactHost, parseSaved, registrableDomain } from "./domains.js";

export const ICON_TTL = 30 * 86400000;
export const NONE_TTL = 86400000;
/** Sites per server call (the server's MAX_DOMAINS). */
export const BATCH = 50;

/** The site whose icon an item shows, or "" (a card, a note, a login with
    no web address, or one on an address with no site, like localhost). */
export function iconDomain(item) {
  if (item?.type !== "login") return "";
  const addresses = [...(item.login?.urls || []), ...(item.login?.passkeys || []).map((passkey) => passkey?.rpId)];
  for (const value of addresses) {
    const url = parseSaved(value);
    if (!url || !/^https?:$/.test(url.protocol) || exactHost(url)) continue;
    return registrableDomain(url.hostname);
  }
  return "";
}

/** Whether a kept answer ({icon: data URL or null, at}) is new enough to use
    without asking again. */
export function isFresh(record, now = Date.now()) {
  return Boolean(record) && now - record.at < (record.icon ? ICON_TTL : NONE_TTL);
}

/** This device's copy: site -> {icon, at}. */
export class IconStore {
  constructor(name = "orbit-pass-icons") {
    this.name = name;
    this.memory = typeof indexedDB === "undefined" ? new Map() : null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("icons");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async run(mode, work) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("icons", mode);
      const out = work(tx.objectStore("icons"));
      tx.oncomplete = () => { db.close(); resolve(out); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  /** The kept answers for these sites, as a Map (sites with none left out). */
  async getMany(sites) {
    if (this.memory) return new Map(sites.filter((site) => this.memory.has(site)).map((site) => [site, this.memory.get(site)]));
    return this.run("readonly", (store) => {
      const out = new Map();
      for (const site of sites) {
        const request = store.get(site);
        request.onsuccess = () => { if (request.result) out.set(site, request.result); };
      }
      return out;
    });
  }

  /** Keep these answers: {site: {icon, at}}. */
  async putMany(records) {
    const entries = Object.entries(records);
    if (!entries.length) return;
    if (this.memory) { for (const [site, record] of entries) this.memory.set(site, record); return; }
    await this.run("readwrite", (store) => { for (const [site, record] of entries) store.put(record, site); });
  }

  async clear() {
    if (this.memory) { this.memory.clear(); return; }
    await this.run("readwrite", (store) => { store.clear(); });
  }
}
