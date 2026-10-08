// The extension's VaultService against a real Orbit Pass server, end to end.
// Skipped unless ORBIT_PASS_E2E points at the people file from
// scripts/e2e_setup.py (see that file for the commands). It uses the file's
// "extension" people, so the Swift kit's test can share the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as C from "../src/lib/crypto.js";
import { blankItem } from "../src/lib/items.js";
import { Area, MemoryBackend } from "../src/lib/store.js";
import { VaultService } from "../src/lib/vault.js";

const peopleFile = process.env.ORBIT_PASS_E2E;
const SERVER = process.env.ORBIT_PASS_E2E_SERVER || "http://127.0.0.1:8765";
const people = peopleFile ? JSON.parse(readFileSync(peopleFile, "utf8")).extension : null;
const run = people ? test : test.skip;

const keyMemory = new Map();
const keyStore = {
  async put(k, v) { keyMemory.set(k, v); },
  async get(k) { return keyMemory.get(k) || null; },
  async delete(k) { keyMemory.delete(k); },
};

async function device(name) {
  const service = new VaultService({ local: new Area(new MemoryBackend()), session: new Area(new MemoryBackend()), keyStore });
  await service.setServer(SERVER);
  await service.local.set("device", { token: people[name].token, keyId: "", name: "Chrome" });
  await service.refreshAccount();
  return service;
}

async function vaultKeyFor(email, password) {
  return (await C.passwordKeys(email, password, 1000)).vault;
}

function login(title, username, password, url) {
  const item = blankItem("login");
  item.title = title;
  item.login.username = username;
  item.login.password = password;
  item.login.urls = [url];
  item.login.totp = "otpauth://totp/Acme:alice?secret=JBSWY3DPEHPK3PXP&issuer=Acme";
  return item;
}

run("personal vault, sharing, removal with rotation, password change", async () => {
  const alice = await device("alice");
  const bob = await device("bob");
  const carol = await device("carol");
  const olga = await device("olga");

  // First unlock registers each identity and makes a personal vault.
  await alice.adoptVaultKey(await vaultKeyFor(people.alice.email, "alice pw"), null);
  await bob.adoptVaultKey(await vaultKeyFor(people.bob.email, "bob pw"), null);
  await carol.adoptVaultKey(await vaultKeyFor(people.carol.email, "carol pw 1"), null);
  await olga.adoptVaultKey(await vaultKeyFor(people.olga.email, "olga pw"), null);
  const alicePersonal = (await alice.vaults()).find((v) => v.kind === "personal");
  assert.ok(alicePersonal && alicePersonal.open);

  // A personal login round-trips.
  const id = await alice.saveItem({ vault: alicePersonal.id, item: login("GitHub", "alice", "gh-secret", "https://github.com/login") });
  const entry = await alice.entry(id);
  assert.equal(entry.item.login.password, "gh-secret");

  // A shared vault, shared with Bob and Carol.
  const shared = await alice.createSharedVault("Engineering");
  await alice.saveItem({ vault: shared, item: login("AWS", "root", "aws-secret", "https://console.aws.amazon.com") });
  const candidates = await alice.candidates(shared);
  assert.deepEqual(candidates.map((p) => p.user.email).sort(), ["bob@acme.test", "carol@acme.test"]);
  for (const person of candidates) await alice.addMember(shared, person, "editor");

  await bob.sync();
  const bobView = (await bob.vaults()).find((v) => v.id === shared);
  assert.equal(bobView.name, "Engineering");
  assert.equal((await bob.entries()).find((e) => e.vault === shared).item.login.password, "aws-secret");

  // Bob edits; Alice sees it.
  const bobEntry = (await bob.entries()).find((e) => e.vault === shared);
  await bob.saveItem({ ...bobEntry, item: { ...bobEntry.item, title: "AWS root" } });
  await alice.sync();
  assert.equal((await alice.entries()).find((e) => e.vault === shared).item.title, "AWS root");

  // An outsider can't be added and can't see it.
  await assert.rejects(alice.addMember(shared, { user: { id: (await olga.local.get("account")).user.id }, identity: (await olga.local.get("identity")) }));
  assert.equal((await olga.vaults()).some((v) => v.id === shared), false);

  // Removing Bob rotates the key; Carol keeps access, Bob loses it.
  await alice.removeMember(shared, (await bob.local.get("account")).user.id);
  await bob.sync();
  assert.equal((await bob.vaults()).some((v) => v.id === shared), false);
  await carol.sync();
  const carolView = (await carol.vaults()).find((v) => v.id === shared);
  assert.equal(carolView.keyVersion, 2);
  assert.equal((await carol.entries()).find((e) => e.vault === shared).item.title, "AWS root");

  // Carol changes her Orbit password; Mission Control hands over the previous
  // vault key too, and her access moves to the new identity.
  await carol.lock();
  await carol.adoptVaultKey(await vaultKeyFor(people.carol.email, "carol pw 2"), await vaultKeyFor(people.carol.email, "carol pw 1"));
  assert.equal((await carol.local.get("identity")).version, 2);
  assert.equal((await carol.entries()).find((e) => e.vault === shared).item.title, "AWS root");

  // Lock, then a wrong password fails and the right one unlocks.
  await alice.lock();
  await assert.rejects(alice.entries(), /locked/);
  const status = await alice.status();
  assert.equal(status.locked, true);
});

run("a password reset without the old password needs a re-share", async () => {
  const bob = await device("bob");
  const alice = await device("alice");
  await alice.adoptVaultKey(await vaultKeyFor(people.alice.email, "alice pw"), null);
  await bob.adoptVaultKey(await vaultKeyFor(people.bob.email, "bob pw"), null);
  const shared = await alice.createSharedVault("Ops");
  const bobPerson = (await alice.candidates(shared)).find((p) => p.user.email === "bob@acme.test");
  await alice.addMember(shared, bobPerson, "viewer");

  await bob.lock();
  await assert.rejects(bob.adoptVaultKey(await vaultKeyFor(people.bob.email, "bob reset"), null), (e) => e.code === "needs-previous");
  await bob.startOver();
  await bob.sync();
  assert.equal((await bob.vaults()).find((v) => v.id === shared).open, false);

  await alice.sync();
  const member = (await alice.vaults()).find((v) => v.id === shared).members.find((m) => m.user.email === "bob@acme.test");
  assert.equal(member.needs_reshare, true);
  await alice.reshare(shared, member);
  await bob.sync();
  assert.equal((await bob.vaults()).find((v) => v.id === shared).open, true);
});
