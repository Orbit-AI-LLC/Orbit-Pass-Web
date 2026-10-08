// The Firefox package (scripts/package.mjs --firefox), which Orbit Browser
// builds in: the manifest Firefox wants, and nothing Chrome-only inside.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GECKO_ID, firefoxManifest } from "../scripts/package.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const chrome = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

test("Firefox runs the background script as a module event page", () => {
  const manifest = firefoxManifest(chrome);
  assert.deepEqual(manifest.background, { scripts: [chrome.background.service_worker], type: "module" });
  assert.equal(manifest.background.service_worker, undefined);
});

test("the Firefox manifest has its ID and none of Chrome's own keys", () => {
  const manifest = firefoxManifest(chrome);
  assert.equal(manifest.browser_specific_settings.gecko.id, GECKO_ID);
  assert.equal(manifest.minimum_chrome_version, undefined);
  assert.ok(!manifest.permissions.includes("offscreen"));
  assert.ok(manifest.permissions.includes("clipboardWrite"));
  assert.equal(manifest.action.default_area, "navbar");
  assert.equal(manifest.version, chrome.version);
  // Chrome's manifest is left as it was.
  assert.ok(chrome.permissions.includes("offscreen"));
});

test("the Firefox package leaves out the offscreen clipboard page", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-pass-test-"));
  try {
    const zip = join(dir, "firefox.zip");
    execFileSync("node", [join(root, "scripts", "package.mjs"), "--firefox", zip], { stdio: "ignore" });
    const names = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter(Boolean);
    assert.ok(names.includes("manifest.json"));
    assert.ok(names.includes("src/background.js"));
    assert.ok(names.includes("src/auth/callback.html"));
    assert.ok(!names.some((name) => name.startsWith("src/offscreen")));
    const manifest = JSON.parse(execFileSync("unzip", ["-p", zip, "manifest.json"], { encoding: "utf8" }));
    assert.equal(manifest.browser_specific_settings.gecko.id, GECKO_ID);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
