/* The extension's vault: signing in, unlocking, syncing, opening items, and
   every change, sharing included. The service worker owns one VaultService;
   the popup and the vault page talk to it by message.

   Unlocking means getting the Orbit vault key again, either from Mission
   Control (a sign-in round trip in a tab, which needs no typing when Mission
   Control already has a session and the key) or from the Orbit password
   typed here (derived locally with the same 600,000 PBKDF2 rounds). Either
   way the identity is derived from it and checked against the one on the
   server, the vault keys are unwrapped, and everything goes into session
   storage, which Chrome keeps in memory only. */

import { Api, ApiError } from "./api.js";
import * as C from "./crypto.js";
import { duplicateKey, reconcileFields } from "./importers.js";
import { BATCH, IconStore, isFresh } from "./icons.js";
import { normalize } from "./items.js";
import { DEFAULT_SETTINGS } from "./store.js";

export class VaultError extends Error {
  /** `details` travel to the page with the code and message (a conflict's
      revision, say). */
  constructor(code, message, details = undefined) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Password unlock with no identity on the server yet: there is nothing to
    check the password against, and a typo would register the wrong identity.
    Orbit's sign-in checks the password, so the first unlock goes through it. */
export const NEEDS_ORBIT = "Unlock with Orbit the first time. After that, your Orbit password unlocks Orbit Pass here too.";

export const CONFLICT = "This item changed on another device. Save again to keep your version.";

export const DEFAULT_SERVER = "https://pass.orbit.com.ai";

/** The usernames this account had before, as this device saw them, newest
    first. The Orbit password is salted with the username, so a username
    change (Mission Control) makes new keys from the same password, like a
    password change: the identity registered before it comes from the old
    address. The handoff's `previous` key usually carries it over; when it
    can't, the password typed here is derived under these as well. */
function formerEmails(before, user) {
  if (!before || !user || String(before.user?.id) !== String(user.id)) return [];
  const now = C.normalEmail(user.email);
  return [...new Set([C.normalEmail(before.user.email), ...(before.formerEmails || [])])].filter((email) => email && email !== now).slice(0, 5);
}

export class VaultService {
  /**
   * @param {object} deps
   * @param {import("./store.js").Area} deps.local
   * @param {import("./store.js").Area} deps.session
   * @param {object} deps.keyStore  put/get/delete for key objects
   * @param {(server: string, token: string) => Api} [deps.makeApi]
   * @param {import("./icons.js").IconStore} [deps.icons]  this device's website icons
   */
  constructor({ local, session, keyStore, makeApi, icons }) {
    this.local = local;
    this.session = session;
    this.keyStore = keyStore;
    this.makeApi = makeApi || ((server, token) => new Api(server, token));
    this.icons = icons || new IconStore();
    this.index = null; // decrypted entries, rebuilt on demand
    this.identityKeys = null; // imported private keys, per worker lifetime
    this.syncing = null;
  }

  // -- state ------------------------------------------------------------------------

  async server() {
    return (await this.local.get("config", {})).server || DEFAULT_SERVER;
  }

  async setServer(server) {
    const clean = String(server || "").trim().replace(/\/+$/, "");
    if (!/^https:\/\/[^/]+$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(clean)) {
      throw new VaultError("bad-server", "Enter the server's address, like https://pass.orbit.com.ai.");
    }
    await this.local.set("config", { ...(await this.local.get("config", {})), server: clean });
  }

  async api() {
    const device = await this.local.get("device");
    return this.makeApi(await this.server(), device?.token || "");
  }

  async settings() {
    return { ...DEFAULT_SETTINGS, ...(await this.local.get("settings", {})) };
  }

  async updateSettings(changes) {
    const next = { ...(await this.settings()), ...changes };
    await this.local.set("settings", next);
    // Turning icons off forgets the ones this device kept.
    if (changes.siteIcons === false) await this.forgetIcons();
    return next;
  }

  async status() {
    const device = await this.local.get("device");
    const account = await this.local.get("account");
    const keys = await this.session.get("keys");
    const pending = await this.session.get("rekey");
    return {
      signedIn: Boolean(device?.token),
      locked: !keys,
      needsPrevious: Boolean(pending),
      email: account?.user?.email || "",
      name: account?.user?.name || "",
      organization: account?.organization || null,
      server: await this.server(),
    };
  }

  async touch() {
    await this.session.set("activity", Date.now());
  }

  // -- signing in through Mission Control ---------------------------------------------

  /** The address that starts a sign-in (or an unlock) in a tab, and what to
      keep for when it comes back. */
  async beginSignIn({ intent = "link", extensionId = "", returnTo = "extension", device = "Chrome", prompt = "" } = {}) {
    const { verifier, challenge } = await C.pkcePair();
    const state = C.b64url(C.random(24));
    const { privateKey, vaultPk } = await C.handoffStart();
    await this.keyStore.put("handoff", { key: privateKey, state });
    await this.session.set("pending", { state, verifier, intent, returnTo, device, extensionId, at: Date.now() });
    // The extension comes back to its own page; the Windows app to
    // orbitpass://link, which its sign-in window catches; the web vault to
    // /vault/ on the server itself.
    const back = returnTo === "extension" || returnTo === "web" ? returnTo : "app";
    const params = new URLSearchParams({ challenge, state, device, return: back, vault_pk: vaultPk, previous: "1" });
    if (returnTo === "extension") params.set("ext", extensionId);
    if (intent === "unlock") params.set("intent", "unlock");
    if (prompt === "login") params.set("prompt", "login");
    return `${await this.server()}/account/link/?${params}`;
  }

  /** The link page sent the browser back to the extension's callback page.
      Returns {done: true} or {retry: url} when Mission Control handed over no
      vault key and the form has to be shown once. */
  async completeSignIn({ search, hash }) {
    const query = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    const pending = await this.session.get("pending");
    const handoff = await this.keyStore.get("handoff");
    if (!pending || !handoff || query.get("state") !== pending.state || handoff.state !== pending.state) {
      throw new VaultError("bad-state", "That sign-in has expired. Start again from Orbit Pass.");
    }
    await this.session.remove("pending");
    const fragment = C.parseHandoffFragment(hash);

    if (pending.intent !== "unlock") {
      const code = query.get("code");
      if (!code) throw new VaultError("no-code", "Signing in didn't finish. Try again.");
      const api = this.makeApi(await this.server(), "");
      const result = await api.exchange(code, pending.verifier, pending.device || "Chrome");
      await this.local.set("device", { token: result.token, keyId: result.device.key_id, name: result.device.name });
      await this.refreshAccount();
    }

    if (!fragment.vault) {
      await this.keyStore.delete("handoff");
      if (!pending.retried) {
        // No vault key kept in this browser (a sign-in by passkey or code, or
        // a browser that never saw the password): show Mission Control's form
        // once, where the password is typed and the key derived.
        const url = await this.beginSignIn({ intent: "unlock", extensionId: pending.extensionId, returnTo: pending.returnTo, device: pending.device, prompt: "login" });
        const again = await this.session.get("pending");
        await this.session.set("pending", { ...again, retried: true });
        return { retry: url };
      }
      throw new VaultError("no-key", "Orbit didn't hand over your keys. Unlock with your Orbit password instead.");
    }

    const current = await C.handoffOpen(fragment.vault, handoff.key);
    const previous = fragment.previous ? await C.handoffOpen(fragment.previous, handoff.key).catch(() => null) : null;
    await this.keyStore.delete("handoff");
    let account = await this.local.get("account");
    if (account && current.email !== C.normalEmail(account.user.email)) {
      // An unlock doesn't refresh the account first, and the username may
      // have changed since this device last looked: ask before refusing.
      await this.refreshAccount().catch(() => null);
      account = (await this.local.get("account")) || account;
    }
    if (account && current.email !== C.normalEmail(account.user.email)) {
      throw new VaultError("wrong-account", `You signed in to Orbit as ${current.email}, but this extension belongs to ${account.user.email}.`);
    }
    await this.adoptVaultKey(current.vault, previous?.vault || null);
    return { done: true };
  }

  async refreshAccount() {
    let me;
    try {
      me = await (await this.api()).me();
    } catch (error) {
      // Signed out from another device while this one was locked: forget the
      // token, as a sync does, so signing in is offered instead of unlocking.
      if (error instanceof ApiError && error.status === 401) {
        await this.lock();
        await this.local.remove("device", "cache");
        await this.forgetIcons();
        throw new VaultError("signed-out", "This device was signed out of Orbit Pass. Sign in again.");
      }
      throw error;
    }
    const before = await this.local.get("account");
    await this.local.set("account", { user: me.user, organization: me.organization, formerEmails: formerEmails(before, me.user) });
    await this.local.set("identity", me.identity);
    return me;
  }

  /** The vault key the Orbit password makes under a username this account
      had before, when that is the one `registered` came from; else null. */
  async formerVault(password, registered) {
    const account = await this.local.get("account");
    for (const email of account?.formerEmails || []) {
      const { vault } = await C.passwordKeys(email, password);
      if (C.sameIdentity(await C.deriveIdentity(vault), registered)) return vault;
    }
    return null;
  }

  // -- unlocking -------------------------------------------------------------------------

  /** Unlock with the Orbit password, derived here. A wrong password derives an
      identity the server doesn't have, and nothing changes. With no identity
      registered yet it is refused ("needs-orbit"): the first unlock goes
      through Orbit, which checks the password before handing the key over. */
  async unlockWithPassword(password) {
    const account = await this.local.get("account");
    if (!account) throw new VaultError("signed-out", "Sign in first.");
    const fresh = await this.refreshAccount().catch((error) => {
      if (error instanceof VaultError && error.code === "signed-out") throw error;
      return null; // offline or failing: check against what this device knows
    });
    const registered = fresh?.identity || (await this.local.get("identity"));
    if (!registered) throw new VaultError("needs-orbit", NEEDS_ORBIT);
    // The username as it is now: the refresh may have just learned it changed.
    const email = (await this.local.get("account"))?.user?.email || account.user.email;
    const { vault } = await C.passwordKeys(email, password);
    const identity = await C.deriveIdentity(vault);
    if (!C.sameIdentity(identity, registered)) {
      // After a username change the registered identity is this password
      // under the old username: carry it over to the new keys.
      const former = await this.formerVault(password, registered);
      if (former) return this.adoptVaultKey(vault, former);
      throw new VaultError("wrong-password", "That isn't your Orbit password. If you changed it recently, use Unlock with Orbit.");
    }
    await this.adoptVaultKey(vault, null);
  }

  /** Make an Orbit vault key this session's: register the identity the first
      time, carry vault keys over after a password change, or ask for the
      previous password when that can't happen by itself. */
  async adoptVaultKey(vaultBytes, previousBytes) {
    const identity = await C.deriveIdentity(vaultBytes);
    const api = await this.api();
    let me;
    let offline = false;
    try {
      me = await this.refreshAccount();
    } catch (error) {
      // Offline: unlock against what this device already knows, and sync later.
      if (!(error instanceof ApiError) || error.status !== 0) throw error;
      me = { identity: await this.local.get("identity") };
      offline = true;
      if (!me.identity || !C.sameIdentity(identity, me.identity)) throw error;
    }
    if (!me.identity) {
      const result = await api.registerIdentity(identity);
      await this.local.set("identity", result.identity);
      await this.setKeys(identity, result.identity.version);
    } else if (C.sameIdentity(identity, me.identity)) {
      await this.setKeys(identity, me.identity.version);
    } else {
      // The Orbit password changed since this account last used Orbit Pass.
      const previous = previousBytes ? await C.deriveIdentity(previousBytes) : null;
      if (previous && C.sameIdentity(previous, me.identity)) {
        await this.rekey(previous, me.identity.version, identity);
      } else {
        await this.session.set("rekey", { next: { ecdh: identity.ecdh, sign: identity.sign, pkcs8: identity.pkcs8 } });
        throw new VaultError("needs-previous", "Your Orbit password changed. Enter your previous Orbit password once to move your vault to the new one.");
      }
    }
    await this.session.remove("rekey");
    await this.touch();
    if (offline) {
      await this.unwrapVaultKeys((await this.local.get("cache", { vaults: [] })).vaults);
      return;
    }
    await this.sync();
    await this.ensurePersonalVault();
  }

  /** After a password change: the previous Orbit password, typed once. */
  async providePreviousPassword(password) {
    const pending = await this.session.get("rekey");
    const account = await this.local.get("account");
    if (!pending || !account) throw new VaultError("nothing-pending", "There's nothing to move.");
    const registered = (await this.refreshAccount()).identity;
    // Under the username now, or, after a username change, one it had before.
    const now = (await this.local.get("account")) || account;
    let previous = null;
    for (const email of [now.user.email, ...(now.formerEmails || [])]) {
      const candidate = await C.deriveIdentity((await C.passwordKeys(email, password)).vault);
      if (C.sameIdentity(candidate, registered)) { previous = candidate; break; }
    }
    if (!previous) throw new VaultError("wrong-password", "That isn't your previous Orbit password.");
    await this.rekey(previous, registered.version, pending.next);
    await this.session.remove("rekey");
    await this.touch();
    await this.sync({ full: true });
    await this.ensurePersonalVault();
  }

  /** Give up on the old identity: personal items are lost, shared vaults wait
      for a teammate to share them again. */
  async startOver() {
    const pending = await this.session.get("rekey");
    if (!pending) throw new VaultError("nothing-pending", "There's nothing to reset.");
    const api = await this.api();
    const result = await api.registerIdentity(pending.next);
    await this.local.set("identity", result.identity);
    await this.setKeys(pending.next, result.identity.version);
    await this.session.remove("rekey");
    await this.sync({ full: true });
    const cache = await this.local.get("cache");
    const personal = cache?.vaults?.find((v) => v.kind === "personal");
    if (personal) await api.deleteVault(personal.id);
    await this.sync({ full: true });
    await this.ensurePersonalVault();
  }

  /** Re-wrap every vault key I can open with the old identity to the new one,
      and register the new identity with them in one request. */
  async rekey(previous, previousVersion, next) {
    const api = await this.api();
    const prevKeys = await C.importIdentity(previous.pkcs8);
    const nextKeys = await C.importIdentity(next.pkcs8);
    const account = await this.local.get("account");
    const me = account.user.id;
    const synced = await api.sync(0);
    const version = previousVersion + 1;
    const envelopes = [];
    for (const vault of synced.vaults) {
      if (vault.envelope.recipient_identity_version !== previousVersion || !vault.wrapper_identity) continue;
      let key;
      try {
        key = await C.unwrapEnvelope({ envelope: vault.envelope, vaultId: vault.id, me, myEcdh: prevKeys.ecdh, wrapperSign: vault.wrapper_identity.sign });
      } catch {
        continue;
      }
      envelopes.push({
        vault: vault.id,
        envelope: await C.wrapEnvelope({
          vaultKey: key, vaultId: vault.id, version: vault.key_version, recipient: me, recipientIdv: version,
          recipientEcdh: next.ecdh, wrapper: me, wrapperIdv: version, signKey: nextKeys.sign,
        }),
      });
    }
    const result = await api.registerIdentity(next, envelopes);
    await this.local.set("identity", result.identity);
    await this.setKeys(next, result.identity.version);
  }

  async setKeys(identity, version) {
    await this.session.set("keys", {
      identity: { ecdh: identity.ecdh, sign: identity.sign, pkcs8: identity.pkcs8, version },
      vaults: {},
    });
    this.identityKeys = null;
    this.index = null;
  }

  async lock() {
    await this.session.remove("keys", "rekey", "activity", "lastFill");
    this.identityKeys = null;
    this.index = null;
  }

  async signOut() {
    try {
      await (await this.api()).signOutDevice("current");
    } catch {
      // Signing out locally matters more than telling the server.
    }
    await this.lock();
    await this.local.remove("device", "account", "identity", "cache");
    await this.forgetIcons();
  }

  async keys() {
    const keys = await this.session.get("keys");
    if (!keys) throw new VaultError("locked", "Orbit Pass is locked.");
    if (!this.identityKeys) this.identityKeys = await C.importIdentity(keys.identity.pkcs8);
    return { ...keys, imported: this.identityKeys };
  }

  // -- sync --------------------------------------------------------------------------------

  async sync({ full = false } = {}) {
    if (this.syncing) return this.syncing;
    this.syncing = this._sync(full).finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async _sync(full) {
    const api = await this.api();
    const cache = full ? { cursor: 0, vaults: [], items: {} } : await this.local.get("cache", { cursor: 0, vaults: [], items: {} });
    let result;
    try {
      result = await api.sync(cache.cursor || 0);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await this.lock();
        await this.local.remove("device", "cache");
        await this.forgetIcons();
        throw new VaultError("signed-out", "This device was signed out of Orbit Pass. Sign in again.");
      }
      throw error;
    }
    const items = result.full ? {} : { ...cache.items };
    const live = new Set(result.vaults.map((v) => v.id));
    for (const item of result.items) {
      if (item.deleted) delete items[item.id];
      else items[item.id] = item;
    }
    for (const [id, item] of Object.entries(items)) if (!live.has(item.vault)) delete items[id];
    await this.local.set("cache", { cursor: result.cursor, vaults: result.vaults, items });
    if (result.identity) await this.local.set("identity", result.identity);
    this.index = null;
    if (await this.session.get("keys")) await this.unwrapVaultKeys(result.vaults);
    return result;
  }

  /** Unwrap the keys of vaults whose key this session doesn't hold yet. */
  async unwrapVaultKeys(vaults) {
    const keys = await this.keys();
    const me = (await this.local.get("account")).user.id;
    const next = { ...keys.vaults };
    for (const vault of vaults) {
      const held = next[vault.id];
      if (held && held.v === vault.key_version) continue;
      if (vault.envelope.recipient_identity_version !== keys.identity.version || !vault.wrapper_identity) {
        delete next[vault.id]; // waiting for someone to share it again
        continue;
      }
      try {
        const key = await C.unwrapEnvelope({ envelope: vault.envelope, vaultId: vault.id, me, myEcdh: keys.imported.ecdh, wrapperSign: vault.wrapper_identity.sign });
        next[vault.id] = { v: vault.key_version, k: C.b64(key) };
      } catch {
        delete next[vault.id];
      }
    }
    for (const id of Object.keys(next)) if (!vaults.some((v) => v.id === id)) delete next[id];
    // Locked while the keys were being unwrapped: writing them back would
    // read as unlocked with no identity.
    const current = await this.session.get("keys");
    if (!current) return;
    await this.session.set("keys", { ...current, vaults: next });
    this.index = null;
  }

  async vaultKey(vaultId, version) {
    const keys = await this.keys();
    const held = keys.vaults[vaultId];
    if (!held || (version && held.v !== version)) throw new VaultError("no-key", "You don't have the key to this vault yet.");
    return { key: C.unb64(held.k), version: held.v };
  }

  async ensurePersonalVault() {
    const cache = await this.local.get("cache", { vaults: [] });
    if (cache.vaults.some((v) => v.kind === "personal")) return;
    const keys = await this.keys();
    const me = (await this.local.get("account")).user.id;
    const id = C.uuid();
    const key = C.newVaultKey();
    const envelope = await C.wrapEnvelope({
      vaultKey: key, vaultId: id, version: 1, recipient: me, recipientIdv: keys.identity.version,
      recipientEcdh: keys.identity.ecdh, wrapper: me, wrapperIdv: keys.identity.version, signKey: keys.imported.sign,
    });
    await (await this.api()).createVault({ id, kind: "personal", meta: "", envelope });
    await this.sync();
  }

  // -- reading -------------------------------------------------------------------------------

  /** Every item this session can open: [{id, vault, revision, keyVersion, item, updatedAt, updatedBy}]. */
  async entries() {
    if (this.index) return this.index;
    const keys = await this.keys();
    const cache = await this.local.get("cache", { vaults: [], items: {} });
    const out = [];
    for (const raw of Object.values(cache.items)) {
      const held = keys.vaults[raw.vault];
      if (!held || held.v !== raw.key_version || !raw.ciphertext) continue;
      try {
        const item = normalize(await C.open(C.unb64(held.k), C.itemAad(raw.vault, raw.key_version, raw.id), raw.ciphertext));
        out.push({ id: raw.id, vault: raw.vault, revision: raw.revision, keyVersion: raw.key_version, item, updatedAt: raw.updated_at, updatedBy: raw.updated_by });
      } catch {
        // A ciphertext that doesn't open under its vault key is skipped,
        // never shown half-read.
      }
    }
    this.index = out;
    return out;
  }

  async entry(id) {
    return (await this.entries()).find((e) => e.id === id) || null;
  }

  /** The vaults as the UI shows them, names decrypted. */
  async vaults() {
    const cache = await this.local.get("cache", { vaults: [] });
    const keys = await this.session.get("keys");
    const out = [];
    for (const vault of cache.vaults) {
      const held = keys?.vaults?.[vault.id];
      let meta = { name: vault.kind === "personal" ? "Personal" : "Shared vault", description: "" };
      if (vault.meta && held) {
        try {
          meta = { ...meta, ...(await C.open(C.unb64(held.k), C.metaAad(vault.id, vault.key_version), vault.meta)) };
        } catch {
          // keep the generic name
        }
      }
      out.push({
        id: vault.id,
        kind: vault.kind,
        name: meta.name,
        description: meta.description || "",
        role: vault.role,
        keyVersion: vault.key_version,
        organization: vault.organization,
        open: Boolean(held),
        canEdit: ["owner", "manager", "editor"].includes(vault.role),
        canManage: ["owner", "manager"].includes(vault.role),
        members: vault.members || [],
      });
    }
    return out.sort((a, b) => (a.kind === "personal" ? -1 : b.kind === "personal" ? 1 : a.name.localeCompare(b.name)));
  }

  // -- changing items ------------------------------------------------------------------------

  async saveItem({ id, vault, revision, item }) {
    const api = await this.api();
    const { key, version } = await this.vaultKey(vault);
    const clean = normalize({ ...item, updatedAt: new Date().toISOString() });
    if (!id) {
      const newId = C.uuid();
      const ciphertext = await C.seal(key, C.itemAad(vault, version, newId), clean);
      await api.createItem({ id: newId, vault, key_version: version, ciphertext });
      await this.sync();
      return newId;
    }
    const ciphertext = await C.seal(key, C.itemAad(vault, version, id), clean);
    try {
      await api.updateItem(id, { ciphertext, key_version: version, revision });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      await this.sync();
      if (error.code !== "conflict") throw error;
      // Changed on another device since the editor opened it. The editor
      // keeps what was typed and takes the revision on the server now, so
      // saving again puts this version on top.
      const current = error.body?.item?.revision ?? (await this.local.get("cache", { items: {} })).items[id]?.revision;
      throw new VaultError("conflict", CONFLICT, { revision: current });
    }
    await this.sync();
    return id;
  }

  async deleteItem(id) {
    const entry = await this.entry(id);
    if (!entry) return;
    await (await this.api()).deleteItem(id, entry.revision);
    await this.sync();
  }

  /** Moving re-seals under the target vault's key, so it is a new item there
      and a deletion here. */
  async moveItem(id, targetVault) {
    const entry = await this.entry(id);
    if (!entry || entry.vault === targetVault) return id;
    const newId = await this.saveItem({ vault: targetVault, item: entry.item });
    await (await this.api()).deleteItem(id, entry.revision);
    await this.sync();
    return newId;
  }

  /** Add items from another password manager to a vault, leaving out any the
      vault already has (importers.js, duplicateKey). Several go up at once;
      if one fails, those already sent stay and the error says how many. */
  async importItems(vaultId, items) {
    const api = await this.api();
    const { key, version } = await this.vaultKey(vaultId);
    const seen = new Set((await this.entries()).filter((e) => e.vault === vaultId).map((e) => duplicateKey(e.item)));
    const fresh = [];
    for (const item of items || []) {
      const clean = normalize({ ...item, updatedAt: new Date().toISOString() });
      const k = duplicateKey(clean);
      if (seen.has(k)) continue;
      seen.add(k);
      fresh.push(clean);
    }
    let imported = 0;
    try {
      for (let i = 0; i < fresh.length; i += 6) {
        await Promise.all(fresh.slice(i, i + 6).map(async (item) => {
          const id = C.uuid();
          const ciphertext = await C.seal(key, C.itemAad(vaultId, version, id), item);
          await api.createItem({ id, vault: vaultId, key_version: version, ciphertext });
          imported++;
        }));
      }
    } catch (error) {
      await this.sync().catch(() => {});
      throw new VaultError(error.code || "import-failed", `Imported ${imported} of ${fresh.length} before this went wrong: ${error.message}`);
    }
    await this.sync();
    return { imported, duplicates: (items || []).length - fresh.length };
  }

  /** Move a custom field into the login detail it really is, in the given
      vaults (importers.js, reconcileFields: options are its {field, target,
      remove}). Several go up at once; a login changed on another device
      meanwhile is left as it is and counted, so running this again takes it. */
  async reconcileFields(vaultIds, options) {
    const api = await this.api();
    const entries = (await this.entries()).filter((e) => (vaultIds || []).includes(e.vault));
    const { changes, ...counts } = reconcileFields(entries.map((e) => e.item), options);
    let updated = 0;
    let changedElsewhere = 0;
    try {
      for (let i = 0; i < changes.length; i += 6) {
        await Promise.all(changes.slice(i, i + 6).map(async ({ index, item }) => {
          const entry = entries[index];
          const { key, version } = await this.vaultKey(entry.vault);
          const clean = normalize({ ...item, updatedAt: new Date().toISOString() });
          const ciphertext = await C.seal(key, C.itemAad(entry.vault, version, entry.id), clean);
          try {
            await api.updateItem(entry.id, { ciphertext, key_version: version, revision: entry.revision });
            updated++;
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 409 || error.code !== "conflict") throw error;
            changedElsewhere++;
          }
        }));
      }
    } catch (error) {
      await this.sync().catch(() => {});
      throw new VaultError(error.code || "update-failed", `Updated ${updated} of ${changes.length} before this went wrong: ${error.message}`);
    }
    await this.sync();
    return { ...counts, updated, changedElsewhere };
  }

  // -- shared vaults -------------------------------------------------------------------------

  async myIdentity() {
    const keys = await this.keys();
    const me = (await this.local.get("account")).user.id;
    return { me, keys };
  }

  async createSharedVault(name, description = "") {
    const { me, keys } = await this.myIdentity();
    const id = C.uuid();
    const key = C.newVaultKey();
    const envelope = await C.wrapEnvelope({
      vaultKey: key, vaultId: id, version: 1, recipient: me, recipientIdv: keys.identity.version,
      recipientEcdh: keys.identity.ecdh, wrapper: me, wrapperIdv: keys.identity.version, signKey: keys.imported.sign,
    });
    const meta = await C.seal(key, C.metaAad(id, 1), { name, description });
    await (await this.api()).createVault({ id, kind: "shared", meta, envelope });
    await this.sync();
    return id;
  }

  async renameVault(vaultId, name, description = "") {
    const { key, version } = await this.vaultKey(vaultId);
    await (await this.api()).updateVault(vaultId, await C.seal(key, C.metaAad(vaultId, version), { name, description }));
    await this.sync();
  }

  async deleteVault(vaultId) {
    await (await this.api()).deleteVault(vaultId);
    await this.sync();
  }

  async candidates(vaultId, q = "") {
    return (await (await this.api()).candidates(vaultId, q)).people;
  }

  async envelopeFor(vaultId, person) {
    const { me, keys } = await this.myIdentity();
    const { key, version } = await this.vaultKey(vaultId);
    return C.wrapEnvelope({
      vaultKey: key, vaultId, version, recipient: person.user.id, recipientIdv: person.identity.version,
      recipientEcdh: person.identity.ecdh, wrapper: me, wrapperIdv: keys.identity.version, signKey: keys.imported.sign,
    });
  }

  /** person: {user: {id}, identity: {version, ecdh}} from candidates() or a member. */
  async addMember(vaultId, person, role = "editor") {
    await (await this.api()).putMember(vaultId, person.user.id, { role, envelope: await this.envelopeFor(vaultId, person) });
    await this.sync();
  }

  async reshare(vaultId, member) {
    await (await this.api()).putMember(vaultId, member.user.id, { envelope: await this.envelopeFor(vaultId, member) });
    await this.sync();
  }

  async setRole(vaultId, userId, role) {
    await (await this.api()).putMember(vaultId, userId, { role });
    await this.sync();
  }

  /** Remove someone, then move the vault to a new key so what is saved from
      now on is under a key they never held. */
  async removeMember(vaultId, userId) {
    const result = await (await this.api()).removeMember(vaultId, userId);
    await this.sync();
    if (result.rotate) await this.rotateVault(vaultId);
  }

  async leaveVault(vaultId) {
    const me = (await this.local.get("account")).user.id;
    await (await this.api()).removeMember(vaultId, me);
    await this.sync();
  }

  async rotateVault(vaultId) {
    await this.sync();
    const { me, keys } = await this.myIdentity();
    const cache = await this.local.get("cache");
    const vault = cache.vaults.find((v) => v.id === vaultId);
    if (!vault) throw new VaultError("gone", "That vault is gone.");
    const { key: oldKey } = await this.vaultKey(vaultId, vault.key_version);
    const version = vault.key_version + 1;
    const key = C.newVaultKey();
    const envelopes = [];
    for (const member of vault.members) {
      if (!member.identity) throw new VaultError("member-no-identity", `${member.user.email} has no identity yet.`);
      envelopes.push(await C.wrapEnvelope({
        vaultKey: key, vaultId, version, recipient: member.user.id, recipientIdv: member.identity.version,
        recipientEcdh: member.identity.ecdh, wrapper: me, wrapperIdv: keys.identity.version, signKey: keys.imported.sign,
      }));
    }
    const items = [];
    for (const raw of Object.values(cache.items).filter((i) => i.vault === vaultId)) {
      const plain = await C.open(oldKey, C.itemAad(vaultId, raw.key_version, raw.id), raw.ciphertext);
      items.push({ id: raw.id, revision: raw.revision, ciphertext: await C.seal(key, C.itemAad(vaultId, version, raw.id), plain) });
    }
    let meta = null;
    if (vault.meta) {
      const plain = await C.open(oldKey, C.metaAad(vaultId, vault.key_version), vault.meta);
      meta = await C.seal(key, C.metaAad(vaultId, version), plain);
    }
    await (await this.api()).rotate(vaultId, { key_version: version, meta, envelopes, items });
    await this.sync();
  }

  async devices() {
    return (await (await this.api()).devices()).devices;
  }

  async signOutDevice(keyId) {
    await (await this.api()).signOutDevice(keyId);
  }

  // -- website icons (icons.js) --------------------------------------------------------------

  /** Icons for these sites: {icons: {site: data URL or null}, missing: [site…]}.
      What this device kept comes back at once, an old copy included; with
      `ask`, one server call's worth of the rest (old copies too) is asked for.
      `missing` is what still has no fresh answer: the server is fetching it,
      or it was past this call's batch. Icons are decoration, so this never
      throws, and with icons off in Settings it asks nothing. */
  async siteIcons(domains, { ask = true } = {}) {
    const sites = [...new Set((Array.isArray(domains) ? domains : []).filter((d) => typeof d === "string" && /^[a-z0-9.-]{1,253}$/.test(d)))];
    if (!sites.length || !(await this.settings()).siteIcons) return { icons: {}, missing: [] };
    let kept = new Map();
    try {
      kept = await this.icons.getMany(sites);
    } catch {
      // Unreadable: asked for again below.
    }
    const icons = {};
    const missing = [];
    for (const site of sites) {
      const record = kept.get(site);
      if (record) icons[site] = record.icon;
      if (!isFresh(record)) missing.push(site);
    }
    if (!ask || !missing.length || !(await this.local.get("device"))?.token) return { icons, missing };
    const batch = missing.slice(0, BATCH);
    let answer;
    try {
      answer = await (await this.api()).siteIcons(batch);
    } catch {
      return { icons, missing };
    }
    const at = Date.now();
    const fresh = {};
    for (const site of batch) {
      if (!answer?.icons || !(site in answer.icons)) continue; // pending
      const icon = answer.icons[site];
      // Only a picture, never an address to load something from.
      fresh[site] = { icon: typeof icon === "string" && icon.startsWith("data:image/") ? icon : null, at };
      icons[site] = fresh[site].icon;
    }
    try {
      await this.icons.putMany(fresh);
    } catch {
      // Shown this time, asked for again next time.
    }
    return { icons, missing: missing.filter((site) => !(site in fresh)) };
  }

  async forgetIcons() {
    try {
      await this.icons.clear();
    } catch {
      // Nothing kept to forget.
    }
  }
}
