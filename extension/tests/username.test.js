// A username change in Mission Control salts the same Orbit password
// differently, so it makes new keys just as a password change does. The
// extension must follow the new username and carry the identity it had
// under the old one over, rather than refuse or derive under a stale address.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as C from "../src/lib/crypto.js";
import { Area, MemoryBackend } from "../src/lib/store.js";
import { VaultService } from "../src/lib/vault.js";

const OLD = "dana@gmail.test";
const NEW = "dana@acme.test";
const PW = "the same password";
const HANDOFF_INFO = "orbit/vault-handoff/v1";

function memoryKeyStore() {
  const memory = new Map();
  return { async put(k, v) { memory.set(k, v); }, async get(k) { return memory.get(k) || null; }, async delete(k) { memory.delete(k); } };
}

/** A device signed in as `email` whose server now answers with `serverEmail`. */
async function device({ email = OLD, serverEmail = NEW, identity = null } = {}) {
  const me = async () => ({ user: { id: "1", email: serverEmail, name: "Dana" }, organization: null, identity });
  const vault = new VaultService({
    local: new Area(new MemoryBackend()), session: new Area(new MemoryBackend()), keyStore: memoryKeyStore(), makeApi: () => ({ me }),
  });
  await vault.local.set("device", { token: "orbitpass_0123456789abcdef_live", keyId: "0123456789abcdef", name: "Chrome" });
  await vault.local.set("account", { user: { id: "1", email, name: "Dana" }, organization: null });
  return vault;
}

async function identityFor(email) {
  return C.deriveIdentity((await C.passwordKeys(email, PW)).vault);
}

/** What Mission Control's handoff page puts in the fragment (orbit-password.js wrapVault). */
async function wrapVault(email, vault, vaultPk) {
  const enc = new TextEncoder();
  const subtle = crypto.subtle;
  const recipient = await subtle.importKey("spki", C.unb64(vaultPk.replace(/-/g, "+").replace(/_/g, "/")), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ephemeral = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const epk = new Uint8Array(await subtle.exportKey("spki", ephemeral.publicKey));
  const shared = await subtle.deriveBits({ name: "ECDH", public: recipient }, ephemeral.privateKey, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const kek = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: await subtle.digest("SHA-256", epk), info: enc.encode(HANDOFF_INFO) }, hkdf, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(HANDOFF_INFO + "|" + email) }, kek, vault);
  return [C.b64url(enc.encode(email)), C.b64url(epk), C.b64url(iv), C.b64url(new Uint8Array(ct))].join(".");
}

test("the account remembers the username it had before, for this person only", async () => {
  const vault = await device();
  await vault.refreshAccount();
  const account = await vault.local.get("account");
  assert.equal(account.user.email, NEW);
  assert.deepEqual(account.formerEmails, [OLD]);

  // Someone else signing in on this device inherits nothing.
  await vault.local.set("account", { user: { id: "2", email: "eve@acme.test", name: "Eve" }, organization: null, formerEmails: ["eve@old.test"] });
  await vault.refreshAccount();
  assert.deepEqual((await vault.local.get("account")).formerEmails, []);
});

test("unlocking with Orbit after a username change follows it instead of refusing", async () => {
  const vault = await device();
  const { privateKey, vaultPk } = await C.handoffStart();
  await vault.keyStore.put("handoff", { key: privateKey, state: "s" });
  await vault.session.set("pending", { state: "s", verifier: "v", intent: "unlock", at: Date.now() });
  const newVault = (await C.passwordKeys(NEW, PW)).vault;
  const oldVault = (await C.passwordKeys(OLD, PW)).vault;
  const hash = `#vault=${await wrapVault(NEW, newVault, vaultPk)}&previous=${await wrapVault(NEW, oldVault, vaultPk)}`;
  let adopted = null;
  vault.adoptVaultKey = async (current, previous) => { adopted = { current, previous }; };
  assert.deepEqual(await vault.completeSignIn({ search: "?state=s&unlock=1", hash }), { done: true });
  assert.deepEqual([C.hex(adopted.current), C.hex(adopted.previous)], [C.hex(newVault), C.hex(oldVault)]);
});

test("someone else's sign-in is still refused", async () => {
  const vault = await device({ serverEmail: OLD });
  const { privateKey, vaultPk } = await C.handoffStart();
  await vault.keyStore.put("handoff", { key: privateKey, state: "s" });
  await vault.session.set("pending", { state: "s", verifier: "v", intent: "unlock", at: Date.now() });
  const hash = `#vault=${await wrapVault("mallory@acme.test", new Uint8Array(32).fill(1), vaultPk)}`;
  vault.adoptVaultKey = async () => assert.fail("adopted someone else's key");
  await assert.rejects(vault.completeSignIn({ search: "?state=s&unlock=1", hash }), (e) => e.code === "wrong-account");
});

test("the password unlocks after a username change and moves the vault to the new keys", async () => {
  const vault = await device({ identity: await identityFor(OLD) });
  let adopted = null;
  vault.adoptVaultKey = async (current, previous) => { adopted = { current, previous }; };
  await vault.unlockWithPassword(PW);
  assert.equal(C.hex(adopted.current), C.hex((await C.passwordKeys(NEW, PW)).vault));
  assert.equal(C.hex(adopted.previous), C.hex((await C.passwordKeys(OLD, PW)).vault));
});

test("once moved, the password unlocks under the new username alone", async () => {
  const vault = await device({ identity: await identityFor(NEW) });
  let adopted = null;
  vault.adoptVaultKey = async (current, previous) => { adopted = { current, previous }; };
  await vault.unlockWithPassword(PW);
  assert.equal(C.hex(adopted.current), C.hex((await C.passwordKeys(NEW, PW)).vault));
  assert.equal(adopted.previous, null);
  await assert.rejects(vault.unlockWithPassword("not the password"), (e) => e.code === "wrong-password");
});

test("the previous-password step finds the identity under the old username", async () => {
  const vault = await device({ identity: await identityFor(OLD) });
  await vault.session.set("rekey", { next: await identityFor(NEW) });
  let moved = null;
  vault.rekey = async (previous, version, next) => { moved = { previous, next }; };
  vault.touch = vault.sync = vault.ensurePersonalVault = async () => {};
  await vault.providePreviousPassword(PW);
  assert.ok(C.sameIdentity(moved.previous, await identityFor(OLD)));
  assert.equal(await vault.session.get("rekey"), null);
});
