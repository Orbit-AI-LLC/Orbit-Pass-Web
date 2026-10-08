// Package the extension for the Chrome Web Store (or "Load unpacked"):
//
//   node extension/scripts/package.mjs [out.zip]
//
// Zips manifest.json, icons/ and src/ (no tests, no package.json), with the
// version from manifest.json in the default name. Uses the system `zip`
// (present on macOS, Linux and GitHub's runners).
//
// For Firefox (Orbit Browser builds it in from this package):
//
//   node extension/scripts/package.mjs --firefox [out.zip]
//
// The same files with Firefox's manifest (firefoxManifest below): Firefox runs
// the background script as an event page, which has a document of its own, so
// the offscreen clipboard page Chrome needs is left out.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Orbit Pass's ID in Firefox, and so in Orbit Browser. */
export const GECKO_ID = "pass@orbit.com.ai";

/** Chrome's manifest, as Firefox wants it. */
export function firefoxManifest(manifest) {
  const out = structuredClone(manifest);
  delete out.minimum_chrome_version;
  out.background = { scripts: [manifest.background.service_worker], type: manifest.background.type };
  out.permissions = manifest.permissions.filter((permission) => permission !== "offscreen");
  // On the toolbar from the start, rather than in the extensions menu.
  out.action = { ...manifest.action, default_area: "navbar" };
  out.browser_specific_settings = { gecko: { id: GECKO_ID, strict_min_version: "128.0" } };
  return out;
}

function main(argv) {
  const firefox = argv.includes("--firefox");
  const [target] = argv.filter((arg) => arg !== "--firefox");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const out = resolve(target || join(root, "dist", `Orbit-Pass-${firefox ? "Firefox" : "Chrome"}-${manifest.version}.zip`));
  mkdirSync(dirname(out), { recursive: true });
  rmSync(out, { force: true });
  let cwd = root;
  if (firefox) {
    cwd = mkdtempSync(join(tmpdir(), "orbit-pass-firefox-"));
    const offscreen = join(root, "src", "offscreen");
    cpSync(join(root, "icons"), join(cwd, "icons"), { recursive: true });
    cpSync(join(root, "src"), join(cwd, "src"), { recursive: true, filter: (path) => path !== offscreen && !path.startsWith(offscreen + sep) });
    writeFileSync(join(cwd, "manifest.json"), JSON.stringify(firefoxManifest(manifest), null, 2) + "\n");
  }
  try {
    execFileSync("zip", ["-r", "-q", "-X", out, "manifest.json", "icons", "src", "-x", "*.DS_Store"], { cwd, stdio: "inherit" });
  } finally {
    if (firefox) rmSync(cwd, { recursive: true, force: true });
  }
  console.log(out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
