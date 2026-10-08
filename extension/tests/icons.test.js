// Website icons: which site a login shows, and the copy this device keeps of
// what the server answers (lib/icons.js, VaultService.siteIcons).
import { test } from "node:test";
import assert from "node:assert/strict";

import { ApiError } from "../src/lib/api.js";
import { BATCH, ICON_TTL, IconStore, NONE_TTL, iconDomain, isFresh } from "../src/lib/icons.js";
import { blankItem } from "../src/lib/items.js";
import { handlePageMessage } from "../src/lib/pages.js";
import { Area, MemoryBackend } from "../src/lib/store.js";
import { VaultService } from "../src/lib/vault.js";

const keyStore = { async put() {}, async get() { return null; }, async delete() {} };
const PNG = "data:image/png;base64,iVBORw0KGgo=";

function login(...urls) {
  const item = blankItem("login");
  item.login.urls = urls;
  return item;
}

test("a login shows its site's icon, named by the registrable domain alone", () => {
  assert.equal(iconDomain(login("https://gist.github.com/alice/login?next=/")), "github.com");
  assert.equal(iconDomain(login("login.example.co.uk")), "example.co.uk");
  assert.equal(iconDomain(login("https://bücher.de")), "xn--bcher-kva.de");
  // The first address with a site counts; addresses with none are passed over.
  assert.equal(iconDomain(login("http://localhost:8000", "http://192.168.1.1", "https://printer.local", "https://app.acme.com")), "acme.com");
  assert.equal(iconDomain(login("ftp://files.acme.com")), "");
  assert.equal(iconDomain(login()), "");
  const passkeyOnly = login();
  passkeyOnly.login.passkeys = [{ rpId: "accounts.google.com" }];
  assert.equal(iconDomain(passkeyOnly), "google.com");
  for (const type of ["card", "identity", "note"]) assert.equal(iconDomain(blankItem(type)), "");
});

test("an icon is kept a month, a site with none a day", () => {
  const now = Date.now();
  assert.equal(isFresh({ icon: PNG, at: now - ICON_TTL + 1000 }, now), true);
  assert.equal(isFresh({ icon: PNG, at: now - ICON_TTL - 1 }, now), false);
  assert.equal(isFresh({ icon: null, at: now - NONE_TTL + 1000 }, now), true);
  assert.equal(isFresh({ icon: null, at: now - NONE_TTL - 1 }, now), false);
  assert.equal(isFresh(undefined, now), false);
});

/** A signed-in VaultService whose server answers icons from `answers`
    (site -> data URL or null; a site left out is pending). */
async function service(answers = {}) {
  const calls = [];
  const api = {
    async siteIcons(domains) {
      calls.push(domains);
      if (api.down) throw new ApiError(0, "offline", "Orbit Pass can't reach its server.");
      return { icons: Object.fromEntries(domains.filter((d) => d in answers).map((d) => [d, answers[d]])), pending: domains.filter((d) => !(d in answers)) };
    },
    async signOutDevice() {},
  };
  const icons = new IconStore();
  const vault = new VaultService({ local: new Area(new MemoryBackend()), session: new Area(new MemoryBackend()), keyStore, makeApi: () => api, icons });
  await vault.local.set("device", { token: "orbitpass_0123456789abcdef_live", keyId: "0123456789abcdef", name: "Chrome" });
  return { vault, api, calls, icons };
}

test("a site is asked of the server once, then drawn from this device's copy", async () => {
  const { vault, calls } = await service({ "github.com": PNG, "nothing.test": null });
  const first = await vault.siteIcons(["github.com", "nothing.test", "github.com"]);
  assert.deepEqual(first, { icons: { "github.com": PNG, "nothing.test": null }, missing: [] });
  assert.deepEqual(calls, [["github.com", "nothing.test"]]);

  const again = await vault.siteIcons(["github.com", "nothing.test"]);
  assert.deepEqual(again, first);
  assert.equal(calls.length, 1, "nothing asked the second time");
});

test("a site the server is still fetching stays missing and isn't kept", async () => {
  const { vault, calls } = await service({ "github.com": PNG });
  const result = await vault.siteIcons(["github.com", "slow.test"]);
  assert.deepEqual(result, { icons: { "github.com": PNG }, missing: ["slow.test"] });
  await vault.siteIcons(["slow.test"]);
  assert.deepEqual(calls.at(-1), ["slow.test"], "asked again");
});

test("an old copy is shown while the server is asked again", async () => {
  const { vault, calls, icons } = await service({ "github.com": "data:image/png;base64,bmV3" });
  await icons.putMany({ "github.com": { icon: PNG, at: Date.now() - ICON_TTL - 1 } });
  assert.deepEqual(await vault.siteIcons(["github.com"], { ask: false }), { icons: { "github.com": PNG }, missing: ["github.com"] });
  assert.equal(calls.length, 0, "ask: false asks nothing");
  assert.deepEqual(await vault.siteIcons(["github.com"]), { icons: { "github.com": "data:image/png;base64,bmV3" }, missing: [] });
});

test("only pictures are kept, never an address to load from", async () => {
  const { vault } = await service({ "a.test": "https://tracker.test/pixel.gif", "b.test": "javascript:alert(1)", "c.test": 42 });
  const { icons } = await vault.siteIcons(["a.test", "b.test", "c.test"]);
  assert.deepEqual(icons, { "a.test": null, "b.test": null, "c.test": null });
});

test("one server call asks for a batch; anything that isn't a site name is dropped", async () => {
  const sites = Array.from({ length: BATCH + 7 }, (_, i) => `site${i}.test`);
  const { vault, calls } = await service(Object.fromEntries(sites.map((s) => [s, null])));
  const result = await vault.siteIcons([...sites, "Not A Site!", "", null, 7]);
  assert.equal(calls[0].length, BATCH);
  assert.deepEqual(result.missing, sites.slice(BATCH));
  assert.equal((await vault.siteIcons(result.missing)).missing.length, 0);
});

test("with the server out of reach, what this device has comes back and nothing throws", async () => {
  const { vault, api, icons } = await service();
  await icons.putMany({ "github.com": { icon: PNG, at: Date.now() - ICON_TTL - 1 } });
  api.down = true;
  assert.deepEqual(await vault.siteIcons(["github.com", "new.test"]), { icons: { "github.com": PNG }, missing: ["github.com", "new.test"] });
});

test("turned off, nothing is sent and the copy is forgotten; signing out forgets it too", async () => {
  const { vault, calls, icons } = await service({ "github.com": PNG });
  await vault.siteIcons(["github.com"]);
  assert.equal((await icons.getMany(["github.com"])).size, 1);

  await vault.updateSettings({ siteIcons: false });
  assert.equal((await icons.getMany(["github.com"])).size, 0);
  assert.deepEqual(await vault.siteIcons(["github.com"]), { icons: {}, missing: [] });
  assert.equal(calls.length, 1);

  await vault.updateSettings({ siteIcons: true });
  await vault.siteIcons(["github.com"]);
  await vault.signOut();
  assert.equal((await icons.getMany(["github.com"])).size, 0);
  // Signed out: nothing to ask the server with.
  assert.deepEqual(await vault.siteIcons(["github.com"]), { icons: {}, missing: ["github.com"] });
  assert.equal(calls.length, 2);
});

test("the vault page and popup ask through the shared page messages", async () => {
  const { vault } = await service({ "github.com": PNG });
  const host = { vault, local: vault.local, platform: { name: "web" } };
  assert.deepEqual(await handlePageMessage({ type: "site-icons", domains: ["github.com"], ask: false }, host), { icons: {}, missing: ["github.com"] });
  assert.deepEqual(await handlePageMessage({ type: "site-icons", domains: ["github.com"] }, host), { icons: { "github.com": PNG }, missing: [] });
});
