/* The Orbit Pass service worker: the only place the vault is open.

   Extension pages (the popup, the vault page, the sign-in callback) can ask
   for anything. Content scripts can ask only for what a page needs at the
   moment a person clicks: suggestions for this frame's site, and the one item
   they picked, after this worker checks the item belongs on the frame's own
   address (which Chrome reports; the page cannot fake it). */

import { FieldModel } from "./ai/field-model.js";
import { ApiError } from "./lib/api.js";
import { urlMatches } from "./lib/domains.js";
import { generatePassword } from "./lib/generator.js";
import { iconDomain } from "./lib/icons.js";
import { blankItem, displayTitle, hasTotp, loginsFor, sortEntries, subtitle, withPasswordChange } from "./lib/items.js";
import { Area, keyStore } from "./lib/store.js";
import { codeFor, handlePageMessage } from "./lib/pages.js";
import { VaultError, VaultService } from "./lib/vault.js";

const local = new Area(chrome.storage.local);
const session = new Area(chrome.storage.session);
const vault = new VaultService({ local, session, keyStore });

// -- the field model ------------------------------------------------------------------

let model = null;

async function fieldModel() {
  if (!model) {
    const json = await (await fetch(chrome.runtime.getURL("src/ai/field-model.json"))).json();
    model = new FieldModel(json);
  }
  return model;
}

// -- clipboard (an offscreen document, since a worker has no DOM) -----------------------

async function copy(text) {
  if (!chrome.offscreen) {
    // Firefox (and Orbit Browser) run this as an event page, which has a
    // document of its own and the clipboardWrite permission.
    await navigator.clipboard.writeText(text);
    return;
  }
  const url = chrome.runtime.getURL("src/offscreen/offscreen.html");
  const existing = await chrome.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  if (!existing?.length) {
    await chrome.offscreen.createDocument({ url, reasons: ["CLIPBOARD"], justification: "Copy a password or verification code the person asked for." });
  }
  await chrome.runtime.sendMessage({ type: "offscreen-copy", text, target: "offscreen" });
}

// -- auto-lock ----------------------------------------------------------------------------

chrome.alarms.create("orbit-pass-autolock", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "orbit-pass-autolock") {
    const settings = await vault.settings();
    const activity = await session.get("activity");
    if (settings.autoLockMinutes > 0 && activity && Date.now() - activity > settings.autoLockMinutes * 60000) await vault.lock();
  }
  if (alarm.name === "orbit-pass-sync" && !(await vault.status()).locked) vault.sync().catch(() => {});
});
chrome.alarms.create("orbit-pass-sync", { periodInMinutes: 5 });
chrome.idle.onStateChanged.addListener(async (idleState) => {
  if (idleState === "locked" && (await vault.settings()).lockWhenComputerLocks) await vault.lock();
});

// -- helpers ------------------------------------------------------------------------------

function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

function failure(error) {
  if (error instanceof VaultError || error instanceof ApiError) return { error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  console.error(error);
  return { error: "failed", message: "Something went wrong. Try again." };
}

async function lastFill(tabId) {
  return (await session.get("lastFill", {}))[tabId] || null;
}

async function rememberFill(tabId, itemId) {
  const all = await session.get("lastFill", {});
  all[tabId] = { itemId, at: Date.now() };
  await session.set("lastFill", all);
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

async function openPopup() {
  try {
    await chrome.action.openPopup();
  } catch {
    await chrome.tabs.create({ url: chrome.runtime.getURL("src/popup/popup.html?tab=1") });
  }
}

// -- content-script requests ------------------------------------------------------------------

async function handleContent(message, sender) {
  const frameUrl = sender.url || "";
  const tabId = sender.tab?.id;
  const status = await vault.status();
  switch (message.type) {
    case "page-state": {
      const settings = await vault.settings();
      return { signedIn: status.signedIn, locked: status.locked, settings: { inlineMenu: settings.inlineMenu, smartDetection: settings.smartDetection, offerToSave: settings.offerToSave } };
    }
    case "classify": {
      if (!(await vault.settings()).smartDetection) return { results: [] };
      const m = await fieldModel();
      return { results: (message.fields || []).slice(0, 80).map((d) => m.classify(d)) };
    }
    case "open-popup":
      await openPopup();
      return {};
  }
  if (status.locked) return { error: "locked", message: "Orbit Pass is locked." };
  await vault.touch();
  const entries = await vault.entries();

  switch (message.type) {
    case "suggest": {
      if (message.kind === "login") {
        const logins = loginsFor(entries, frameUrl).slice(0, 8);
        const sites = logins.map(({ item }) => iconDomain(item));
        // Icons this device already has, so the menu never waits on the
        // network; the rest are fetched for next time.
        const { icons, missing } = await vault.siteIcons(sites, { ask: false });
        if (missing.length) vault.siteIcons(missing).catch(() => {});
        return { items: logins.map(({ id, item }, i) => ({ id, title: displayTitle(item), subtitle: subtitle(item), icon: icons[sites[i]] || undefined })) };
      }
      if (message.kind === "otp") {
        const recent = await lastFill(tabId);
        const matches = loginsFor(entries, frameUrl).filter((e) => hasTotp(e.item));
        if (recent && Date.now() - recent.at < 10 * 60000) {
          const filled = entries.find((e) => e.id === recent.itemId && hasTotp(e.item));
          if (filled && !matches.includes(filled)) matches.unshift(filled);
          else if (filled) matches.sort((a, b) => (a.id === filled.id ? -1 : b.id === filled.id ? 1 : 0));
        }
        const items = [];
        for (const { id, item } of matches.slice(0, 5)) {
          const code = await codeFor(item);
          if (code) items.push({ id, title: displayTitle(item), code: code.code, remaining: code.remaining });
        }
        return { items };
      }
      if (message.kind === "card") {
        return { items: sortEntries(entries.filter((e) => e.item.type === "card")).map(({ id, item }) => ({ id, title: displayTitle(item), subtitle: subtitle(item) })) };
      }
      if (message.kind === "identity") {
        return { items: sortEntries(entries.filter((e) => e.item.type === "identity")).map(({ id, item }) => ({ id, title: displayTitle(item), subtitle: subtitle(item) })) };
      }
      return { items: [] };
    }
    case "fill": {
      const entry = entries.find((e) => e.id === message.itemId);
      if (!entry) return { error: "not-found", message: "That item is gone." };
      const { item } = entry;
      if (message.kind === "login" || message.kind === "otp") {
        if (item.type !== "login") return { error: "wrong-type", message: "That isn't a login." };
        const recent = await lastFill(tabId);
        const belongs = item.login.urls.some((url) => urlMatches(url, frameUrl));
        const justFilled = message.kind === "otp" && recent && recent.itemId === entry.id && Date.now() - recent.at < 10 * 60000;
        if (!belongs && !justFilled) return { error: "wrong-site", message: `That login isn't saved for ${hostOf(frameUrl)}.` };
        if (message.kind === "otp") {
          const code = await codeFor(item);
          return code ? { code: code.code } : { error: "no-code", message: "That login has no verification code." };
        }
        await rememberFill(tabId, entry.id);
        let copiedCode = false;
        if ((await vault.settings()).copyTotpAfterFill && hasTotp(item)) {
          const code = await codeFor(item);
          if (code) {
            await copy(code.code).catch(() => {});
            copiedCode = true;
          }
        }
        return { username: item.login.username, password: item.login.password, copiedCode };
      }
      if (message.kind === "card") {
        if (item.type !== "card") return { error: "wrong-type", message: "That isn't a card." };
        // Every frame of this tab gets it: card fields often live in a
        // payment provider's frames.
        await chrome.tabs.sendMessage(tabId, { type: "fill-card", card: item.card }).catch(() => {});
        return { ok: true };
      }
      if (message.kind === "identity") {
        if (item.type !== "identity") return { error: "wrong-type", message: "That isn't an identity." };
        return { identity: item.identity };
      }
      return { error: "unknown" };
    }
    case "generate":
      return { password: generatePassword({ length: 20 }) };
    case "username-seen": {
      const seen = await session.get("usernames", {});
      seen[tabId] = { username: String(message.username || "").slice(0, 200), origin: new URL(frameUrl).origin, at: Date.now() };
      await session.set("usernames", seen);
      return {};
    }
    case "submitted": {
      const settings = await vault.settings();
      let origin;
      try { origin = new URL(frameUrl).origin; } catch { return {}; }
      if (!settings.offerToSave || settings.neverSave.includes(origin) || !message.password) return {};
      let username = String(message.username || "");
      if (!username) {
        const seen = (await session.get("usernames", {}))[tabId];
        if (seen && seen.origin === origin && Date.now() - seen.at < 10 * 60000) username = seen.username;
      }
      const matches = loginsFor(entries, frameUrl);
      const same = matches.find((e) => e.item.login.username === username);
      if (same && same.item.login.password === message.password) return {};
      const pending = { origin, url: frameUrl, host: hostOf(frameUrl), username, password: String(message.password), update: Boolean(same), itemId: same?.id || null, at: Date.now() };
      const all = await session.get("pendingSave", {});
      all[tabId] = pending;
      await session.set("pendingSave", all);
      chrome.tabs.sendMessage(tabId, { type: "show-save", pending: { host: pending.host, username, update: pending.update } }, { frameId: 0 }).catch(() => {});
      return {};
    }
    case "pending-save": {
      const pending = (await session.get("pendingSave", {}))[tabId];
      if (!pending || Date.now() - pending.at > 5 * 60000) return {};
      return { pending: { host: pending.host, username: pending.username, update: pending.update } };
    }
    case "save-decision": {
      const all = await session.get("pendingSave", {});
      const pending = all[tabId];
      delete all[tabId];
      await session.set("pendingSave", all);
      if (!pending) return {};
      if (message.action === "never") {
        const settings = await vault.settings();
        await vault.updateSettings({ neverSave: [...new Set([...settings.neverSave, pending.origin])] });
        return {};
      }
      if (message.action === "update" && pending.itemId) {
        // The bar is gone by now, so a conflict must not drop the new password:
        // the item changed on another device, and the save that failed synced
        // it. The password change goes onto that latest version, once.
        for (let attempt = 0; ; attempt++) {
          const entry = await vault.entry(pending.itemId);
          if (!entry) return {};
          try {
            await vault.saveItem({ ...entry, item: withPasswordChange(entry.item, pending.password) });
            return {};
          } catch (error) {
            if (error.code !== "conflict" || attempt) throw error;
          }
        }
      }
      if (message.action === "save") {
        const vaults = await vault.vaults();
        const personal = vaults.find((v) => v.kind === "personal" && v.open);
        if (!personal) return { error: "no-vault" };
        const item = blankItem("login");
        item.title = pending.host;
        item.login.username = pending.username;
        item.login.password = pending.password;
        item.login.urls = [pending.origin];
        await vault.saveItem({ vault: personal.id, item });
      }
      return {};
    }
    default:
      return { error: "unknown" };
  }
}

// -- extension-page requests -------------------------------------------------------------------

// Sign-in comes back to this extension's own pages, so the server is told
// their host: Chrome's extension ID, or the UUID Firefox names an
// extension's pages by (moz-extension://<uuid>/; chrome.runtime.id is the
// add-on's ID there). Orbit Browser builds Orbit Pass in with the same UUID
// in every copy (ORBIT_BROWSER_PASS_UUID on the server).
const ORBIT_BROWSER_UUID = "cabce947-8111-49e9-a61f-0224b07a4dfd";
const ownPages = new URL(chrome.runtime.getURL(""));
const browserName = ownPages.protocol !== "moz-extension:" ? "Chrome" : ownPages.host === ORBIT_BROWSER_UUID ? "Orbit Browser" : "Firefox";

const platform = {
  name: "extension",
  client: { returnTo: "extension", device: browserName, extensionId: ownPages.host },
  openUrl: (url) => chrome.tabs.create({ url }),
  copy,
};

async function handlePage(message, sender) {
  switch (message.type) {
    case "fill-tab": {
      // From the popup: fill a login into the active tab, if it belongs there.
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const entry = await vault.entry(message.id);
      if (!tab || !entry || entry.item.type !== "login") return { error: "nothing", message: "Open the sign-in page first." };
      if (!entry.item.login.urls.some((url) => urlMatches(url, tab.url))) return { error: "wrong-site", message: `That login isn't saved for ${hostOf(tab.url)}.` };
      await rememberFill(tab.id, entry.id);
      await chrome.tabs.sendMessage(tab.id, { type: "fill-focused", data: { username: entry.item.login.username, password: entry.item.login.password } }, { frameId: 0 });
      if ((await vault.settings()).copyTotpAfterFill && hasTotp(entry.item)) {
        const code = await codeFor(entry.item);
        if (code) await copy(code.code).catch(() => {});
      }
      return { ok: true };
    }
    case "active-tab": {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return { url: tab?.url || "", title: tab?.title || "" };
    }
    case "capture-tab": {
      // For setting up a verification code from a QR code on the page.
      const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
      return { dataUrl };
    }
    default: {
      const result = await handlePageMessage(message, { vault, local, platform });
      return result === undefined ? { error: "unknown" } : result;
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || typeof message.type !== "string" || message.target === "offscreen") return false;
  const handler = isExtensionPage(sender) ? handlePage : sender.tab ? handleContent : null;
  if (!handler) return false;
  handler(message, sender)
    .then((result) => {
      if (message.type === "auth-callback" && result?.done && sender.tab?.id) {
        setTimeout(() => chrome.tabs.remove(sender.tab.id).catch(() => {}), 1200);
      }
      if (message.type === "auth-callback" && result?.retry && sender.tab?.id) {
        chrome.tabs.update(sender.tab.id, { url: result.retry });
      }
      reply(result);
    })
    .catch((error) => reply(failure(error)));
  return true;
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") await chrome.tabs.create({ url: chrome.runtime.getURL("src/popup/popup.html?tab=1&welcome=1") });
});
