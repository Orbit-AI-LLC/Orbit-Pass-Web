// The extension's VaultService against a stand-in for the server.
import { test } from "node:test";
import assert from "node:assert/strict";

import { ApiError } from "../src/lib/api.js";
import * as C from "../src/lib/crypto.js";
import { blankItem } from "../src/lib/items.js";
import { Area, MemoryBackend } from "../src/lib/store.js";
import { NEEDS_ORBIT, VaultService } from "../src/lib/vault.js";

const keyStore = { async put() {}, async get() { return null; }, async delete() {} };

test("a device signed out elsewhere while locked offers sign-in again", async () => {
  // The server answers every call as it does for a signed-out device token.
  const signedOut = { me: async () => { throw new ApiError(401, "unauthorized", "This device is signed out of Orbit Pass. Sign in again."); } };
  const vault = new VaultService({ local: new Area(new MemoryBackend()), session: new Area(new MemoryBackend()), keyStore, makeApi: () => signedOut });
  await vault.local.set("device", { token: "orbitpass_0123456789abcdef_revoked", keyId: "0123456789abcdef", name: "Chrome" });
  await vault.local.set("account", { user: { id: "1", email: "dana@acme.test", name: "Dana" }, organization: null });
  assert.deepEqual([(await vault.status()).signedIn, (await vault.status()).locked], [true, true]);

  // Unlocking (with Orbit, or the password) can't work with this token...
  await assert.rejects(vault.adoptVaultKey(new Uint8Array(32).fill(7), null), (e) => e.code === "signed-out");
  // ...so the device is signed out here too, and sign-in is offered instead of unlocking forever.
  assert.equal((await vault.status()).signedIn, false);
});

test("locking while vault keys are unwrapped stays locked", async () => {
  const vault = new VaultService({ local: new Area(new MemoryBackend()), session: new Area(new MemoryBackend()), keyStore, makeApi: () => ({}) });
  await vault.local.set("device", { token: "orbitpass_0123456789abcdef_live", keyId: "0123456789abcdef", name: "Chrome" });
  await vault.local.set("account", { user: { id: "1", email: "dana@acme.test", name: "Dana" }, organization: null });
  // The sync read the keys while unlocked; the vault locked before it wrote them back.
  vault.keys = async () => ({ identity: { version: 1 }, imported: {}, vaults: {} });
  await vault.unwrapVaultKeys([]);
  assert.equal(await vault.session.get("keys"), null);
  assert.equal((await vault.status()).locked, true);
});

test("each host's sign-in comes back to that host", async () => {
  const vault = new VaultService({ local: new Area(new MemoryBackend()), session: new Area(new MemoryBackend()), keyStore, makeApi: () => ({}) });
  const params = async (client) => new URL(await vault.beginSignIn(client)).searchParams;
  const extension = await params({ returnTo: "extension", extensionId: "abcdefghijklmnopabcdefghijklmnop", device: "Chrome" });
  assert.deepEqual([extension.get("return"), extension.get("ext")], ["extension", "abcdefghijklmnopabcdefghijklmnop"]);
  assert.equal((await params({ returnTo: "app", device: "Windows PC" })).get("return"), "app");
  const web = await params({ returnTo: "web", device: "Web browser", intent: "unlock" });
  assert.deepEqual([web.get("return"), web.get("ext"), web.get("device"), web.get("intent")], ["web", null, "Web browser", "unlock"]);
  // What comes back is checked against the sign-in this host started.
  assert.equal((await vault.session.get("pending")).returnTo, "web");
});

// -- the first password unlock ----------------------------------------------------------

/** A stand-in for the server: one person, their identity (or none yet), and
    the calls it was sent. */
function fakeServer({ identity = null } = {}) {
  const calls = [];
  const user = { id: "1", email: "dana@acme.test", name: "Dana" };
  const api = {
    calls,
    identity,
    async me() { calls.push("me"); return { user, organization: null, identity: api.identity, device: { key_id: "k", name: "Chrome", current: true } }; },
    async registerIdentity(next) { calls.push("identity"); api.identity = { version: 1, ecdh: next.ecdh, sign: next.sign }; return { identity: api.identity, created: true }; },
    async sync() { calls.push("sync"); return { cursor: 1, full: true, identity: api.identity, vaults: [], items: [] }; },
    async createVault() { calls.push("vault"); return {}; },
  };
  return api;
}

async function signedIn(api) {
  const vault = new VaultService({ local: new Area(new MemoryBackend()), session: new Area(new MemoryBackend()), keyStore, makeApi: () => api });
  await vault.local.set("device", { token: "orbitpass_0123456789abcdef_live", keyId: "0123456789abcdef", name: "Chrome" });
  await vault.local.set("account", { user: { id: "1", email: "dana@acme.test", name: "Dana" }, organization: null });
  return vault;
}

test("the first unlock goes through Orbit, so a mistyped password can't register an identity", async () => {
  const server = fakeServer();
  const vault = await signedIn(server);
  await assert.rejects(vault.unlockWithPassword("a typo"), (e) => e.code === "needs-orbit" && e.message === NEEDS_ORBIT && /^Unlock with Orbit the first time/.test(e.message));
  assert.equal(server.calls.includes("identity"), false, "nothing was registered");
  assert.equal((await vault.status()).locked, true);
});

test("once an identity is registered, the password unlocks and a wrong one doesn't", async () => {
  // Registered by an Orbit unlock earlier.
  const registered = await C.deriveIdentity((await C.passwordKeys("dana@acme.test", "the right one")).vault);
  const server = fakeServer({ identity: { version: 1, ecdh: registered.ecdh, sign: registered.sign } });
  const vault = await signedIn(server);
  await assert.rejects(vault.unlockWithPassword("a typo"), (e) => e.code === "wrong-password");
  assert.equal((await vault.status()).locked, true);
  await vault.unlockWithPassword("the right one");
  assert.equal((await vault.status()).locked, false);
  assert.equal(server.calls.includes("identity"), false, "the identity stayed as it was");
});

// -- saving after an edit conflict --------------------------------------------------------

test("a save that conflicts takes the server's revision, and saving again keeps this version", async () => {
  const vaultId = C.uuid();
  const itemId = C.uuid();
  const key = C.newVaultKey();
  const seal = (title) => C.seal(key, C.itemAad(vaultId, 1, itemId), { ...blankItem("note"), title });
  // Another device saved since this one opened the item: the server is at revision 2.
  const stored = { id: itemId, vault: vaultId, ciphertext: await seal("Theirs"), key_version: 1, revision: 2, deleted: false, seq: 2, updated_at: "", updated_by: null };
  const api = {
    async updateItem(id, { ciphertext, revision }) {
      if (revision !== stored.revision) {
        throw new ApiError(409, "conflict", "This item was changed on another device. Your copy has been refreshed.", { error: "conflict", item: { ...stored } });
      }
      Object.assign(stored, { ciphertext, revision: stored.revision + 1, seq: stored.seq + 1 });
      return { item: { ...stored } };
    },
    async sync() {
      return { cursor: stored.seq, full: true, identity: null, vaults: [{ id: vaultId, kind: "personal", key_version: 1, role: "owner", envelope: {}, members: [] }], items: [{ ...stored }] };
    },
  };
  const vault = new VaultService({ local: new Area(new MemoryBackend()), session: new Area(new MemoryBackend()), keyStore, makeApi: () => api });
  vault.keys = async () => ({ identity: { version: 1 }, imported: {}, vaults: { [vaultId]: { v: 1, k: C.b64(key) } } });
  const mine = { ...blankItem("note"), title: "Mine" };

  let conflict;
  await assert.rejects(vault.saveItem({ id: itemId, vault: vaultId, revision: 1, item: mine }), (e) => { conflict = e; return true; });
  assert.equal(conflict.code, "conflict");
  assert.equal(conflict.message, "This item changed on another device. Save again to keep your version.");
  assert.equal(conflict.details.revision, 2);
  assert.equal((await vault.local.get("cache")).items[itemId].revision, 2, "synced");

  // The editor saves again with the revision it was given: this version wins.
  await vault.saveItem({ id: itemId, vault: vaultId, revision: conflict.details.revision, item: mine });
  assert.equal(stored.revision, 3);
  assert.equal((await C.open(key, C.itemAad(vaultId, 1, itemId), stored.ciphertext)).title, "Mine");
});
