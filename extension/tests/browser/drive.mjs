// Drive the real extension in a Chromium browser over the DevTools protocol:
// load it, unlock it against a local Orbit Pass server, save items, then click
// fields on the fixture pages like a person would and check what got filled.
//
//   BROWSER="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
//   ORBIT_PASS_SERVER=http://127.0.0.1:8765 ORBIT_PASS_TOKEN=orbitpass_… \
//   FIXTURES=http://127.0.0.1:8766 OUT=/tmp/shots node extension/tests/browser/drive.mjs
//
// The server needs a person with a device token and no identity yet
// (scripts/e2e_setup.py makes one: its "browser" person); the fixtures are
// served with `python3 -m http.server 8766 --directory extension/tests/fixtures`.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const BROWSER = process.env.BROWSER;
const SERVER = process.env.ORBIT_PASS_SERVER;
const TOKEN = process.env.ORBIT_PASS_TOKEN;
const FIXTURES = process.env.FIXTURES;
const OUT = process.env.OUT || mkdtempSync(join(tmpdir(), "orbit-pass-shots-"));
const EXTENSION = resolve(decodeURIComponent(new URL("../..", import.meta.url).pathname));
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "orbit-pass-profile-"));
// Chromium 137+ ignores --load-extension in branded browsers; the supported
// way is Extensions.loadUnpacked over the DevTools pipe (fd 3 in, fd 4 out).
const browser = spawn(BROWSER, [
  "--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1100,900", "about:blank",
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });

let nextId = 1;
const pending = new Map();
const events = [];
let buffer = "";
const ws = { close() {} };

async function connect() {
  browser.stdio[4].on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const data = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (data.id && pending.has(data.id)) {
        const { ok, fail } = pending.get(data.id);
        pending.delete(data.id);
        data.error ? fail(new Error(JSON.stringify(data.error))) : ok(data.result);
      } else if (data.method) {
        events.push(data);
      }
    }
  });
  for (let i = 0; i < 60; i++) {
    try {
      await Promise.race([cdp("Browser.getVersion"), sleep(500).then(() => { throw new Error("slow"); })]);
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("browser did not start");
}

function cdp(method, params = {}, sessionId) {
  const id = nextId++;
  browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  return new Promise((ok, fail) => pending.set(id, { ok, fail }));
}

async function evaluate(sessionId, expression) {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function open(url) {
  const { targetId } = await cdp("Target.createTarget", { url });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Page.enable", {}, sessionId);
  await cdp("Runtime.enable", {}, sessionId);
  // A 900px-high page in every browser: --window-size counts the window, and
  // some builds leave a page too short for the menu to open below a field
  // near the bottom (it then opens above, where these clicks don't go).
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  for (let i = 0; i < 40; i++) {
    if ((await evaluate(sessionId, "document.readyState")) === "complete") break;
    await sleep(150);
  }
  return sessionId;
}

async function shot(sessionId, name) {
  const { data } = await cdp("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
}

async function click(sessionId, x, y) {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, sessionId);
  }
}

async function press(sessionId, key, keyCode) {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await cdp("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: keyCode }, sessionId);
  }
}

async function rect(sessionId, selector) {
  return evaluate(sessionId, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, bottom: r.bottom }; })()`);
}

async function clickFieldThenFirstRow(sessionId, selector, rowIndex = 0) {
  const box = await rect(sessionId, selector);
  await click(sessionId, box.x, box.y);
  await sleep(900);
  // The menu opens 6px under the field: a 31px header, then 46px rows.
  await click(sessionId, box.left + 60, box.bottom + 6 + 31 + 23 + rowIndex * 46);
  await sleep(900);
}

async function main() {
  await connect();
  const loaded = await cdp("Extensions.loadUnpacked", { path: EXTENSION });
  await cdp("Target.setDiscoverTargets", { discover: true });
  let extensionId = loaded.id || null;
  for (let i = 0; i < 40 && !extensionId; i++) {
    const { targetInfos } = await cdp("Target.getTargets");
    const worker = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js"));
    if (worker) break;
    await sleep(250);
  }
  assert.ok(extensionId, "the extension's service worker started");
  console.log(`extension ${extensionId} loaded`);

  // Signed out, the popup offers sign-in.
  const page = await open(`chrome-extension://${extensionId}/src/popup/popup.html?tab=1`);
  await sleep(500);
  await shot(page, "1-popup-signed-out");
  assert.match(await evaluate(page, "document.body.innerText"), /Sign in with Orbit/);

  // Link this browser as the test person (the Mission Control round trip
  // can't run here), unlock with an Orbit password, and save some items.
  const setup = await evaluate(page, `(async () => {
    const send = (m) => new Promise((ok) => chrome.runtime.sendMessage(m, ok));
    await send({ type: "set-server", server: ${JSON.stringify(SERVER)} });
    await chrome.storage.local.set({ device: { token: ${JSON.stringify(TOKEN)}, keyId: "", name: "Chrome" } });
    const auth = { Authorization: "Bearer " + ${JSON.stringify(TOKEN)} };
    const me = await (await fetch(${JSON.stringify(SERVER)} + "/api/v1/me", { headers: auth })).json();
    await chrome.storage.local.set({ account: { user: me.user, organization: me.organization } });
    // The first password unlock is refused: Orbit's unlock goes first. It
    // needs Mission Control, so register the identity it would.
    const first = await send({ type: "unlock-password", password: "test person's orbit password" });
    if (first.error !== "needs-orbit") return { error: "the first password unlock wasn't sent to Orbit: " + JSON.stringify(first) };
    const C = await import(chrome.runtime.getURL("src/lib/crypto.js"));
    const identity = await C.deriveIdentity((await C.passwordKeys(me.user.email, "test person's orbit password")).vault);
    await fetch(${JSON.stringify(SERVER)} + "/api/v1/identity", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ ecdh: identity.ecdh, sign: identity.sign }) });
    const unlocked = await send({ type: "unlock-password", password: "test person's orbit password" });
    const { vaults } = await send({ type: "vaults" });
    const personal = vaults.find((v) => v.kind === "personal").id;
    const save = (item) => send({ type: "save-item", entry: { vault: personal, item } });
    const base = { v: 1, favorite: false, notes: "", tags: [], fields: [] };
    await save({ ...base, type: "login", title: "Acme", login: { username: "dana@acme.test", password: "correct-horse-42", urls: [${JSON.stringify(FIXTURES)}], totp: "otpauth://totp/Acme:dana?secret=JBSWY3DPEHPK3PXP&issuer=Acme", passkeys: [] } });
    await save({ ...base, type: "card", title: "Work Visa", card: { cardholder: "Dana Scully", number: "4242 4242 4242 4242", expMonth: "08", expYear: "2029", cvv: "123", brand: "Visa" } });
    await save({ ...base, type: "identity", title: "Dana at home", identity: { firstName: "Dana", middleName: "", lastName: "Scully", email: "dana@example.com", phone: "+1 555 0100", company: "", address1: "1 Orbit Way", address2: "", city: "Springfield", state: "OR", postalCode: "97477", country: "United States" } });
    const { entries } = await send({ type: "entries" });
    return { locked: unlocked.locked, count: entries.length, error: unlocked.error || null };
  })()`);
  console.log("setup", setup);
  assert.equal(setup.locked, false, "unlocked with the Orbit password");
  assert.equal(setup.count, 3);
  await evaluate(page, "location.reload()");
  await sleep(1200);
  await shot(page, "2-popup-unlocked");

  // Sign-in page: click the username field, pick the login.
  const login = await open(`${FIXTURES}/login.html`);
  await sleep(800);
  const userBox = await rect(login, "#user");
  await click(login, userBox.x, userBox.y);
  await sleep(900);
  await shot(login, "3-login-menu");
  await click(login, userBox.left + 60, userBox.bottom + 6 + 31 + 23);
  await sleep(1000);
  const filled = await evaluate(login, "({ user: document.querySelector('#user').value, pass: document.querySelector('#pass').value })");
  console.log("login filled", filled);
  assert.deepEqual(filled, { user: "dana@acme.test", pass: "correct-horse-42" });
  await shot(login, "4-login-filled");

  // The same with the keyboard: down to the login, Enter.
  const keyboard = await open(`${FIXTURES}/login.html`);
  await sleep(800);
  await click(keyboard, userBox.x, userBox.y);
  await sleep(900);
  await press(keyboard, "ArrowDown", 40);
  await press(keyboard, "Enter", 13);
  await sleep(1000);
  const typed = await evaluate(keyboard, "({ user: document.querySelector('#user').value, pass: document.querySelector('#pass').value })");
  console.log("login filled from the keyboard", typed);
  assert.deepEqual(typed, { user: "dana@acme.test", pass: "correct-horse-42" });

  // An email-first sign-in page (claude.ai's markup): the box says
  // autocomplete="email", which the quick rules read as personal details; the
  // model overrules them, so it offers the login, not the identity's email.
  const emailFirst = await open(`${FIXTURES}/email-first.html`);
  await sleep(800);
  await clickFieldThenFirstRow(emailFirst, "#email");
  const emailFilled = await evaluate(emailFirst, "document.querySelector('#email').value");
  console.log("email-first sign-in filled", emailFilled);
  assert.equal(emailFilled, "dana@acme.test", "the login's username, not the identity's email");
  await shot(emailFirst, "4b-email-first-filled");

  // Two-step page: the code field has no hints but its words; the model places it.
  const twofa = await open(`${FIXTURES}/2fa.html`);
  await sleep(800);
  await clickFieldThenFirstRow(twofa, "#c");
  const code = await evaluate(twofa, "document.querySelector('#c').value");
  const expected = await evaluate(page, `(async () => { const { entries } = await new Promise((ok) => chrome.runtime.sendMessage({ type: "entries" }, ok)); const id = entries.find((e) => e.item.type === "login").id; return (await new Promise((ok) => chrome.runtime.sendMessage({ type: "totp", id }, ok))).code.code; })()`);
  console.log("code filled", code, "expected", expected);
  assert.equal(code, expected);
  // The promo box is not a code field: no menu.
  const promo = await rect(twofa, "#promo");
  await click(twofa, promo.x, promo.y);
  await sleep(700);
  await shot(twofa, "5-2fa-promo-no-menu");

  // Checkout: a card into the payment fields, then the identity into the address.
  const checkout = await open(`${FIXTURES}/checkout.html`);
  await sleep(800);
  await clickFieldThenFirstRow(checkout, "input[name=cardnumber]");
  const card = await evaluate(checkout, "({ name: document.querySelector('[name=ccname]').value, number: document.querySelector('[name=cardnumber]').value, exp: document.querySelector('[name=exp]').value, cvc: document.querySelector('[name=cvc]').value })");
  console.log("card filled", card);
  assert.deepEqual(card, { name: "Dana Scully", number: "4242 4242 4242 4242", exp: "08 / 29", cvc: "123" });
  await clickFieldThenFirstRow(checkout, "input[name=billing_first_name]");
  const address = await evaluate(checkout, "Object.fromEntries(Array.from(document.querySelectorAll('#ship input')).map((i) => [i.name, i.value]))");
  console.log("address filled", address);
  assert.equal(address.billing_first_name, "Dana");
  assert.equal(address.billing_last_name, "Scully");
  assert.equal(address.billing_city, "Springfield");
  assert.equal(address.billing_postcode, "97477");
  assert.equal(address.billing_email, "dana@example.com");
  await shot(checkout, "6-checkout-filled");

  // The code menu, for the record.
  const again = await open(`${FIXTURES}/2fa.html`);
  await sleep(800);
  const codeBox = await rect(again, "#c");
  await click(again, codeBox.x, codeBox.y);
  await sleep(900);
  await shot(again, "7-code-menu");

  // The vault page and its settings.
  const vaultTab = await open(`chrome-extension://${extensionId}/src/vault/vault.html`);
  await sleep(1200);
  await evaluate(vaultTab, "document.querySelector('.list-body .item-row')?.click()");
  await sleep(1200);
  await shot(vaultTab, "8-vault-item");
  await evaluate(vaultTab, "location.hash = 'settings'; location.reload()");
  await sleep(1500);
  await shot(vaultTab, "9-vault-settings");
  console.log(`all browser checks passed; screenshots in ${OUT}`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => { browser.kill(); });
