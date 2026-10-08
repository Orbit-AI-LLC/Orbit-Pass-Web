// Importing exports from other apps, against vectors/import/ (which
// OrbitPassKit's ImportTests read too), and into a vault.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import * as C from "../src/lib/crypto.js";
import { describeItems, duplicateKey, guessTarget, ImportError, importTotp, loginFieldNames, parseCsv, parseImport, reconcileFields, splitExpiry } from "../src/lib/importers.js";
import { ApiError } from "../src/lib/api.js";
import { blankItem } from "../src/lib/items.js";
import { Area, MemoryBackend } from "../src/lib/store.js";
import { VaultService } from "../src/lib/vault.js";
import { project } from "./import-projection.mjs";

const dir = new URL("../../vectors/import/", import.meta.url);
const expected = JSON.parse(readFileSync(new URL("expected.json", dir), "utf8"));

test("every sample export reads as expected.json says", () => {
  const files = readdirSync(dir).filter((name) => name !== "expected.json").sort();
  assert.deepEqual(files, Object.keys(expected).sort(), "expected.json covers every sample");
  for (const name of files) {
    const want = expected[name];
    const text = readFileSync(new URL(name, dir), "utf8");
    if (want.error) {
      assert.throws(() => parseImport(text, name), ImportError, name);
      continue;
    }
    const got = parseImport(text, name);
    assert.deepEqual({ source: got.source, skipped: got.skipped, items: got.items.map(project) }, want, name);
  }
});

test("CSV fields keep their commas, quotes and line breaks", () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\n'), [["a", "b"], ["x, y", 'say "hi"\nthere']]);
  assert.deepEqual(parseCsv("a;b\n1;2\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseCsv("a\tb\n1\t2"), [["a", "b"], ["1", "2"]]);
});

test("a file it can't read says so in plain words", () => {
  assert.throws(() => parseImport(""), /empty/);
  assert.throws(() => parseImport("colour,shape\nred,round\n"), /can't find the columns/);
  assert.throws(() => parseImport("{nope", "x.json"), /can't be read/);
  assert.throws(() => parseImport("PK\u0003\u0004", "export.1pux"), /CSV export/);
});

test("verification codes are kept as links or cleaned-up keys, or set aside", () => {
  assert.deepEqual(importTotp(" jbsw-y3dp ehpk3pxp== "), { totp: "JBSWY3DPEHPK3PXP" });
  assert.deepEqual(importTotp("otpauth://totp/X?secret=JBSWY3DPEHPK3PXP"), { totp: "otpauth://totp/X?secret=JBSWY3DPEHPK3PXP" });
  assert.equal(importTotp("otpauth://hotp/X?secret=JBSWY3DPEHPK3PXP&counter=1").field.value, "otpauth://hotp/X?secret=JBSWY3DPEHPK3PXP&counter=1");
  assert.deepEqual(importTotp(""), { totp: "" });
  assert.deepEqual([splitExpiry("9/28"), splitExpiry("2031-12"), splitExpiry("soon")], [{ month: "09", year: "2028" }, { month: "12", year: "2031" }, { month: "", year: "" }]);
});

test("the same login twice is a duplicate, whatever the address looks like", () => {
  const login = (url, username, password) => ({ ...blankItem("login"), login: { ...blankItem("login").login, urls: [url], username, password } });
  assert.equal(duplicateKey(login("https://www.github.com/login", "Dana", "x")), duplicateKey(login("github.com", "dana", "x")));
  assert.notEqual(duplicateKey(login("github.com", "dana", "x")), duplicateKey(login("github.com", "dana", "y")));
  assert.equal(describeItems([login("a", "", ""), login("b", "", ""), blankItem("note"), blankItem("card")]), "2 logins, 1 secure note and 1 card");
});

test("importing seals each new item to the vault and skips what's already there", async () => {
  const vaultId = C.uuid();
  const key = C.newVaultKey();
  const stored = [];
  const existing = { ...blankItem("login"), title: "GitHub" };
  existing.login = { ...existing.login, urls: ["https://github.com"], username: "dana", password: "gh-secret-1" };
  const existingId = C.uuid();
  stored.push({ id: existingId, vault: vaultId, ciphertext: await C.seal(key, C.itemAad(vaultId, 1, existingId), existing), key_version: 1, revision: 1, deleted: false, seq: 1, updated_at: "", updated_by: null });
  const api = {
    async createItem(body) { stored.push({ ...body, revision: 1, deleted: false, seq: stored.length + 1, updated_at: "", updated_by: null }); return {}; },
    async sync() {
      return { cursor: stored.length, full: true, identity: null, vaults: [{ id: vaultId, kind: "personal", key_version: 1, role: "owner", envelope: {}, members: [] }], items: [...stored] };
    },
  };
  const vault = new VaultService({ local: new Area(new MemoryBackend()), session: new Area(new MemoryBackend()), keyStore: { async put() {}, async get() { return null; }, async delete() {} }, makeApi: () => api });
  vault.keys = async () => ({ identity: { version: 1 }, imported: {}, vaults: { [vaultId]: { v: 1, k: C.b64(key) } } });
  await vault.sync();

  const { items } = parseImport(readFileSync(new URL("chrome.csv", dir), "utf8"), "chrome.csv");
  // github.com is in the file and already in the vault; the file also has it twice.
  const result = await vault.importItems(vaultId, [...items, items[1]]);
  assert.deepEqual(result, { imported: 1, duplicates: 2 });
  assert.equal(stored.length, 2);
  const added = stored[1];
  assert.equal(added.vault, vaultId);
  const opened = await C.open(key, C.itemAad(vaultId, 1, added.id), added.ciphertext);
  assert.equal(opened.login.password, 'pa,ss"word');
  assert.equal((await vault.entries()).length, 2, "synced afterwards");
});

// -- tidying up fields after an import ------------------------------------------------------

function loginWith(username, fields, extra = {}) {
  const item = blankItem("login");
  item.login = { ...item.login, username, ...extra };
  item.fields = fields.map(([name, value, hidden = false]) => ({ name, value, hidden }));
  return item;
}

test("a field that holds the username fills it in where it's missing", () => {
  const items = [
    loginWith("", [["Email", " dana@acme.test "], ["Recovery", "blue"]]),
    loginWith("Dana@Acme.test", [["e-mail", "dana@acme.test"]]),
    loginWith("dana", [["EMAIL", "dana@acme.test"]]),
    loginWith("", [["Recovery", "blue"]]),
    { ...blankItem("note"), fields: [{ name: "Email", value: "x@y.z", hidden: false }] },
  ];
  const before = structuredClone(items);
  const result = reconcileFields(items, { field: "Email", target: "username" });
  assert.deepEqual(items, before, "the items given aren't changed");
  assert.deepEqual([result.filled, result.same, result.left], [1, 1, 1]);
  assert.deepEqual(result.changes.map((c) => c.index), [0, 1]);
  const [filled, same] = result.changes.map((c) => c.item);
  assert.equal(filled.login.username, "dana@acme.test");
  assert.deepEqual(filled.fields.map((f) => f.name), ["Recovery"]);
  assert.equal(same.login.username, "Dana@Acme.test");
  assert.deepEqual(same.fields, [], "the field that only repeats the username goes");

  // Kept fields: only the logins that were missing a username change.
  const kept = reconcileFields(items, { field: "email", target: "username", remove: false });
  assert.deepEqual(kept.changes.map((c) => c.index), [0]);
  assert.deepEqual(kept.changes[0].item.fields.map((f) => f.name), ["Email", "Recovery"]);
});

test("a field can be a password, a website or a verification code too", () => {
  const items = [
    loginWith("dana", [["Website", "https://www.github.com/login"]]),
    loginWith("dana", [["URL", "github.com"]], { urls: ["https://github.com"] }),
    loginWith("dana", [["Website", "not a site, http://sn"]], { urls: ["https://example.com"] }),
  ];
  const sites = reconcileFields(items, { field: "website", target: "website" });
  assert.deepEqual([sites.filled, sites.same, sites.left], [1, 0, 1]);
  assert.deepEqual(sites.changes[0].item.login.urls, ["https://www.github.com/login"]);
  assert.equal(reconcileFields(items, { field: "url", target: "website" }).same, 1, "same site, other address");

  const codes = reconcileFields([
    loginWith("dana", [["2FA", "jbsw-y3dp ehpk3pxp"]]),
    loginWith("dana", [["2FA", "n/a"]]),
  ], { field: "2fa", target: "totp" });
  assert.deepEqual([codes.filled, codes.left], [1, 1]);
  assert.equal(codes.changes[0].item.login.totp, "JBSWY3DPEHPK3PXP");

  const passwords = reconcileFields([loginWith("dana", [["Pass", " with spaces ", true]])], { field: "pass", target: "password" });
  assert.equal(passwords.changes[0].item.login.password, " with spaces ", "kept exactly as it was");
  assert.deepEqual(reconcileFields(items, { field: "website", target: "nonsense" }).changes, []);
});

test("the fields to choose from are counted once per login, however they're spelled", () => {
  const items = [
    loginWith("", [["Email", "a@b.c"], ["e-mail", "a@b.c"]]),
    loginWith("", [["EMAIL", "d@e.f"], ["Электронная почта", "g@h.i"], ["Empty", " "]]),
    { ...blankItem("card"), fields: [{ name: "PIN", value: "1234", hidden: true }] },
  ];
  assert.deepEqual(loginFieldNames(items), [{ name: "Email", count: 2 }, { name: "Электронная почта", count: 1 }]);
  assert.equal(reconcileFields(items, { field: "электронная  ПОЧТА", target: "username" }).filled, 1);
  assert.deepEqual(["E-mail", "Password", "Login URI", "OTP", "Recovery"].map(guessTarget), ["username", "password", "website", "totp", "username"]);
});

test("tidying fields re-seals the changed logins and leaves ones changed elsewhere", async () => {
  const vaultId = C.uuid();
  const otherVault = C.uuid();
  const key = C.newVaultKey();
  const stored = [];
  const put = async (vault, item, revision = 1) => {
    const id = C.uuid();
    stored.push({ id, vault, ciphertext: await C.seal(key, C.itemAad(vault, 1, id), item), key_version: 1, revision, deleted: false, seq: stored.length + 1, updated_at: "", updated_by: null });
    return id;
  };
  const missing = await put(vaultId, loginWith("", [["Email", "dana@acme.test"]]));
  const elsewhere = await put(vaultId, loginWith("", [["Email", "sam@acme.test"]]));
  const untouched = await put(vaultId, loginWith("dana", [["Email", "other@acme.test"]]));
  const notChosen = await put(otherVault, loginWith("", [["Email", "lee@acme.test"]]));
  const updates = [];
  const api = {
    async updateItem(id, body) {
      if (id === elsewhere) throw new ApiError(409, "conflict", "Changed elsewhere.", { item: { revision: 2 } });
      updates.push(id);
      const row = stored.find((r) => r.id === id);
      Object.assign(row, { ciphertext: body.ciphertext, revision: row.revision + 1 });
      return {};
    },
    async sync() {
      return { cursor: stored.length, full: true, identity: null, vaults: [vaultId, otherVault].map((id) => ({ id, kind: "personal", key_version: 1, role: "owner", envelope: {}, members: [] })), items: [...stored] };
    },
  };
  const vault = new VaultService({ local: new Area(new MemoryBackend()), session: new Area(new MemoryBackend()), keyStore: { async put() {}, async get() { return null; }, async delete() {} }, makeApi: () => api });
  vault.keys = async () => ({ identity: { version: 1 }, imported: {}, vaults: { [vaultId]: { v: 1, k: C.b64(key) }, [otherVault]: { v: 1, k: C.b64(key) } } });
  await vault.sync();

  const result = await vault.reconcileFields([vaultId], { field: "Email", target: "username", remove: true });
  assert.deepEqual(result, { filled: 2, same: 0, left: 1, updated: 1, changedElsewhere: 1 });
  assert.deepEqual(updates, [missing], "only the login in the chosen vault that could change");
  const row = stored.find((r) => r.id === missing);
  const opened = await C.open(key, C.itemAad(vaultId, 1, missing), row.ciphertext);
  assert.equal(opened.login.username, "dana@acme.test");
  assert.deepEqual(opened.fields, []);
  const after = Object.fromEntries((await vault.entries()).map((e) => [e.id, e.item]));
  assert.equal(after[missing].login.username, "dana@acme.test", "synced afterwards");
  assert.equal(after[untouched].fields.length, 1);
  assert.equal(after[notChosen].login.username, "");
});
