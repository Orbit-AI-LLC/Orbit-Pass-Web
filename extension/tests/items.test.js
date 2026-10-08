// The popup's list: the page's logins above everything else, never twice.
import { test } from "node:test";
import assert from "node:assert/strict";

import { blankItem, siteFirst } from "../src/lib/items.js";

function login(id, title, url, extra = {}) {
  const item = blankItem("login");
  Object.assign(item, { title, ...extra });
  item.login.urls = url ? [url] : [];
  return { id, vault: "v", revision: 1, item };
}

const entries = [
  login("zed", "Zed", "https://zed.dev"),
  login("proxmox", "Proxmox", "https://104.243.35.82:8006/"),
  login("other-port", "Other port", "https://104.243.35.82:9000/"),
  login("gist", "Gist", "https://gist.github.com/login"),
  login("github", "GitHub", "https://github.com", { favorite: true }),
  { id: "card", vault: "v", revision: 1, item: { ...blankItem("card"), title: "Visa" } },
];
const ids = (list) => list.map((e) => e.id);

test("this site's logins come first, best match first, and the rest follow without them", () => {
  const { here, rest } = siteFirst(entries, "https://github.com/session");
  assert.deepEqual(ids(here), ["github", "gist"]);
  assert.deepEqual(ids(rest), ["other-port", "proxmox", "card", "zed"]);
});

test("an IP address matches its own port only", () => {
  const { here, rest } = siteFirst(entries, "https://104.243.35.82:8006/#v1:0:18:4:::::::");
  assert.deepEqual(ids(here), ["proxmox"]);
  assert.equal(rest.length, entries.length - 1);
});

test("a search keeps the order and narrows both parts", () => {
  const { here, rest } = siteFirst(entries, "https://github.com/", "gi");
  assert.deepEqual(ids(here), ["github", "gist"]);
  assert.deepEqual(ids(rest), []);
  assert.deepEqual(ids(siteFirst(entries, "https://github.com/", "zed").rest), ["zed"]);
});

test("a page that isn't a website has nothing first", () => {
  for (const page of ["", "chrome://newtab/", "about:blank", "not a url"]) {
    const { here, rest } = siteFirst(entries, page);
    assert.deepEqual(here, []);
    assert.equal(rest.length, entries.length);
  }
});
