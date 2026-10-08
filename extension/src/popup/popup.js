/* The toolbar popup: sign in, unlock, this site's logins above everything
   else, search, a quick look at any item, editing a login, the generator,
   and setting up a code from a QR code. */

import { countdownRing, copyText, h, icon, readQr, rpc, toast } from "../ui/dom.js";
import { displayTitle, hasTotp, loginsFor, siteFirst, subtitle, withPasswordChange } from "../lib/items.js";
import { estimateBits, generatePassphrase, generatePassword } from "../lib/generator.js";
import { parseOtpauth, otpauthUri } from "../lib/totp.js";
import { itemAvatar, loadSiteIcons } from "../ui/site-icons.js";

const view = document.getElementById("view");
const actions = document.getElementById("actions");
const params = new URLSearchParams(location.search);
if (params.get("tab")) document.body.classList.add("tab");

let status = null;
let entries = [];
let activeTab = { url: "" };
let timer = null;

function vaultPage(hash = "") {
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/vault/vault.html${hash}`) });
  window.close();
}

function render(...nodes) {
  clearInterval(timer);
  view.replaceChildren(...nodes.filter(Boolean));
}

function errorBox(error) {
  return h("div", { class: "error", role: "alert" }, error.message || String(error));
}

function setActions(buttons) {
  actions.replaceChildren(...buttons.filter(Boolean));
}

function iconButton(name, title, onclick) {
  return h("button", { class: "icon-btn", type: "button", title, "aria-label": title, onclick }, icon(name));
}

// -- states ---------------------------------------------------------------------------

async function start() {
  status = await rpc({ type: "status" });
  if (!status.signedIn) return signedOut();
  if (status.needsPrevious) return needsPrevious();
  if (status.locked) return locked();
  return unlocked();
}

function signedOut(error) {
  setActions([]);
  const server = h("input", { class: "input", value: status?.server || "", "aria-label": "Server" });
  const advanced = h("details", { class: "faint" }, h("summary", {}, "Server"), h("div", { class: "field-row" }, server,
    h("button", { class: "btn", onclick: async () => {
      try { status = await rpc({ type: "set-server", server: server.value }); toast("Server saved"); } catch (e) { signedOut(e); }
    } }, "Save")));
  render(h("div", { class: "center-view" },
    h("img", { class: "mark", src: "../../icons/mark.svg", width: 48, height: 48, alt: "" }),
    h("h1", {}, params.get("welcome") ? "Welcome to Orbit Pass" : "Sign in to Orbit Pass"),
    h("p", { class: "muted" }, "Your vault is encrypted with your Orbit password, on this device. Sign in with your Orbit account to start."),
    error ? errorBox(error) : null,
    h("button", { class: "btn primary block", onclick: () => rpc({ type: "sign-in" }).then(() => window.close()).catch(signedOut) }, "Sign in with Orbit"),
    h("div", { style: "margin-top:16px;text-align:left" }, advanced),
  ));
}

function locked(error) {
  setActions([]);
  const password = h("input", { class: "input", type: "password", placeholder: "Orbit password", autocomplete: "current-password", "aria-label": "Orbit password" });
  const submit = h("button", { class: "btn block", type: "submit" }, "Unlock");
  const form = h("form", { onsubmit: async (event) => {
    event.preventDefault();
    if (!password.value) return;
    submit.disabled = true;
    submit.textContent = "Unlocking…";
    try {
      await rpc({ type: "unlock-password", password: password.value });
      start();
    } catch (e) {
      if (e.code === "needs-previous") return needsPrevious(e);
      locked(e);
      // No identity yet to check the password against: Orbit's sign-in checks it.
      if (e.code === "needs-orbit") rpc({ type: "unlock-orbit" }).catch(locked);
    }
  } }, password, h("div", { style: "height:8px" }), submit);
  render(h("div", { class: "center-view" },
    h("img", { class: "mark", src: "../../icons/mark.svg", width: 44, height: 44, alt: "" }),
    h("h1", {}, "Orbit Pass is locked"),
    h("p", { class: "muted" }, status.email),
    error ? errorBox(error) : null,
    h("button", { class: "btn primary block", onclick: () => rpc({ type: "unlock-orbit" }).then(() => window.close()).catch(locked) }, "Unlock with Orbit"),
    h("div", { class: "divider" }, "or"),
    form,
  ));
  password.focus();
}

function needsPrevious(error) {
  setActions([]);
  const password = h("input", { class: "input", type: "password", placeholder: "Previous Orbit password", autocomplete: "off", "aria-label": "Previous Orbit password" });
  render(h("div", { class: "center-view" },
    h("h1", {}, "Your Orbit password changed"),
    h("p", { class: "muted" }, "Your vault is still sealed to your previous Orbit password. Enter it once and Orbit Pass moves everything over to the new one."),
    error && error.code !== "needs-previous" ? errorBox(error) : null,
    h("form", { onsubmit: async (event) => {
      event.preventDefault();
      try { await rpc({ type: "previous-password", password: password.value }); start(); } catch (e) { needsPrevious(e); }
    } }, password, h("div", { style: "height:8px" }), h("button", { class: "btn primary block", type: "submit" }, "Move my vault")),
    h("div", { class: "divider" }, "forgot it?"),
    h("p", { class: "faint" }, "Starting over keeps your shared vaults (a teammate shares them again) but your personal items can't be recovered."),
    h("button", { class: "btn danger block", onclick: async () => {
      if (!confirm("Start over? Items in your personal vault will be lost for good.")) return;
      try { await rpc({ type: "start-over" }); start(); } catch (e) { needsPrevious(e); }
    } }, "Start over"),
  ));
}

// -- unlocked -----------------------------------------------------------------------------

async function unlocked() {
  setActions([
    iconButton("dice", "Password generator", generator),
    iconButton("qr", "Set up a verification code from this page", scanPage),
    iconButton("plus", "New item", () => vaultPage("#new")),
    iconButton("open", "Open vault", () => vaultPage()),
    iconButton("lock", "Lock", async () => { await rpc({ type: "lock" }); start(); }),
  ]);
  try {
    activeTab = await rpc({ type: "active-tab" });
    entries = (await rpc({ type: "entries" })).entries;
  } catch (e) {
    if (e.code === "locked") return start();
    return render(errorBox(e));
  }
  rpc({ type: "sync" }).then(async () => { entries = (await rpc({ type: "entries" })).entries; }).catch(() => {});
  const box = h("input", { class: "input", type: "search", placeholder: "Search your vault", "aria-label": "Search" });
  const results = h("div");
  // This site's logins first, ready to fill; a divider; then everything else.
  const draw = () => {
    const q = box.value.trim();
    const { here, rest } = siteFirst(entries, activeTab.url, q);
    results.replaceChildren(...[
      here.length ? h("div", { class: "section-title" }, "On this site") : null,
      ...here.map((e) => row(e, true)),
      here.length
        ? (rest.length ? h("div", { class: "divider list-divider" }, q ? "Other results" : "Everything else") : null)
        : h("div", { class: "section-title" }, q ? "Results" : "All items"),
      ...rest.map((e) => row(e, false)),
      !here.length && !rest.length ? h("div", { class: "empty" }, q ? "Nothing matches." : "Your vault is empty. Add an item, or sign in somewhere and Orbit Pass will offer to save it.") : null,
      !q && !entries.length ? h("button", { class: "btn block", onclick: () => vaultPage("#import") }, icon("import"), "Import passwords from another app") : null,
    ].filter(Boolean));
    loadSiteIcons([...here, ...rest].map((e) => e.item));
  };
  box.addEventListener("input", draw);
  render(h("div", { class: "search" }, box), results);
  draw();
  box.focus();
}

function row(entry, onSite) {
  const { item } = entry;
  return h("div", { class: "item-row", role: "button", tabindex: 0, onclick: () => detail(entry), onkeydown: (e) => e.key === "Enter" && detail(entry) },
    itemAvatar(item, displayTitle(item)),
    h("span", { class: "text" }, h("div", { class: "title" }, displayTitle(item)), h("div", { class: "sub" }, subtitle(item))),
    h("span", { class: "row-actions" },
      onSite ? h("button", { class: "btn", onclick: (e) => { e.stopPropagation(); fill(entry); } }, "Fill") : null,
      item.type === "login" && item.login.password ? iconButton("copy", "Copy password", (e) => { e.stopPropagation(); copyText(item.login.password, "Password copied"); }) : null,
    ),
  );
}

async function fill(entry) {
  try {
    await rpc({ type: "fill-tab", id: entry.id });
    window.close();
  } catch (e) {
    toast(e.message);
  }
}

function field(label, value, { secret = false, copyLabel = "Copied" } = {}) {
  if (!value) return null;
  let shown = !secret;
  const text = h("span", { class: secret ? "grow mono" : "grow" }, secret ? "••••••••••••" : value);
  const toggle = secret ? iconButton("eye", "Show", () => {
    shown = !shown;
    text.textContent = shown ? value : "••••••••••••";
    toggle.replaceChildren(icon(shown ? "eyeOff" : "eye"));
  }) : null;
  return h("div", { class: "detail-field" }, h("div", { class: "label" }, label),
    h("div", { class: "value" }, text, toggle, iconButton("copy", `Copy ${label.toLowerCase()}`, () => copyText(value, copyLabel))));
}

async function detail(entry) {
  const { item } = entry;
  // A viewer in a shared vault can't change its items, so isn't offered Edit.
  const vault = (await rpc({ type: "vaults" }).catch(() => ({ vaults: [] }))).vaults.find((v) => v.id === entry.vault);
  const edit = !vault || vault.canEdit
    ? h("button", { class: "btn", type: "button", onclick: () => (item.type === "login" ? editLogin(entry) : vaultPage(`#edit=${entry.id}`)) }, icon("pencil"), "Edit")
    : null;
  setActions([iconButton("back", "Back", unlocked), edit, iconButton("open", "Open in vault", () => vaultPage(`#item=${entry.id}`))]);
  const parts = [h("div", { class: "detail-head" }, itemAvatar(item, displayTitle(item)), h("h1", {}, displayTitle(item)))];
  if (item.type === "login") {
    parts.push(field("Username", item.login.username, { copyLabel: "Username copied" }));
    parts.push(field("Password", item.login.password, { secret: true, copyLabel: "Password copied" }));
    if (hasTotp(item)) {
      const codeBox = h("div", { class: "detail-field" }, h("div", { class: "label" }, "Verification code"), h("div", { class: "value" }));
      parts.push(codeBox);
      const tick = async () => {
        const { code } = await rpc({ type: "totp", id: entry.id });
        if (!code) return;
        codeBox.lastChild.replaceChildren(
          h("span", { class: "grow code" }, code.code.replace(/^(\d{3})(\d{3})$/, "$1 $2")),
          countdownRing(code.remaining, code.period),
          iconButton("copy", "Copy code", () => copyText(code.code, "Code copied")),
        );
      };
      await tick();
      timer = setInterval(tick, 1000);
    }
    for (const url of item.login.urls) parts.push(h("div", { class: "detail-field" }, h("div", { class: "label" }, "Website"), h("div", { class: "value" }, h("a", { class: "grow", href: url.includes("://") ? url : `https://${url}`, target: "_blank", rel: "noreferrer" }, url))));
    if (item.login.passkeys?.length) parts.push(h("div", { class: "notice" }, `Passkey for ${item.login.passkeys[0].rpId}, used through Orbit Pass on your Mac, iPhone or iPad.`));
    if (loginsFor([entry], activeTab.url).length) parts.push(h("button", { class: "btn primary block", style: "margin-top:12px", onclick: () => fill(entry) }, "Fill on this page"));
  } else if (item.type === "card") {
    parts.push(field("Cardholder", item.card.cardholder));
    parts.push(field("Number", item.card.number, { secret: true, copyLabel: "Card number copied" }));
    parts.push(field("Expires", item.card.expMonth && item.card.expYear ? `${item.card.expMonth}/${item.card.expYear}` : ""));
    parts.push(field("Security code", item.card.cvv, { secret: true, copyLabel: "Security code copied" }));
  } else if (item.type === "identity") {
    const id = item.identity;
    parts.push(field("Name", [id.firstName, id.middleName, id.lastName].filter(Boolean).join(" ")));
    parts.push(field("Email", id.email));
    parts.push(field("Phone", id.phone));
    parts.push(field("Address", [id.address1, id.address2, [id.city, id.state, id.postalCode].filter(Boolean).join(" "), id.country].filter(Boolean).join(", ")));
  }
  if (item.notes) parts.push(h("div", { class: "detail-field" }, h("div", { class: "label" }, "Notes"), h("div", { class: "value", style: "white-space:pre-wrap" }, item.notes)));
  render(...parts.filter(Boolean));
}

// -- editing a login ----------------------------------------------------------------------------

/** What people change on the spot: title, username, password, websites and
    notes. The rest (the code, extra fields, favorite, vault) is in the vault
    page's editor, a click away; anything not shown here is kept as it was. */
function editLogin(entry) {
  const { item } = entry;
  setActions([iconButton("back", "Cancel", () => detail(entry))]);
  const input = (value, attrs = {}) => h("input", { class: "input", value: value || "", ...attrs });
  const labelled = (label, node) => h("div", {}, h("div", { class: "label" }, label), node);

  const title = input(item.title, { placeholder: displayTitle(item), "aria-label": "Title" });
  const username = input(item.login.username, { autocomplete: "off", "aria-label": "Username or email" });
  const password = input(item.login.password, { type: "password", autocomplete: "new-password", class: "input mono", "aria-label": "Password" });
  const meter = h("span");
  const measure = () => { meter.style.width = `${Math.min(100, (estimateBits(password.value) / 128) * 100)}%`; };
  password.addEventListener("input", measure);
  measure();
  const reveal = (shown) => {
    password.type = shown ? "text" : "password";
    show.replaceChildren(icon(shown ? "eyeOff" : "eye"));
  };
  const show = iconButton("eye", "Show", () => reveal(password.type === "password"));
  const generate = iconButton("dice", "Generate a password", () => {
    password.value = generatePassword({ length: 20 });
    reveal(true);
    measure();
  });
  const urls = h("div", { class: "urls" });
  const addUrl = (value = "") => {
    const box = input(value, { placeholder: "https://example.com", "aria-label": "Website" });
    const line = h("div", { class: "field-row" }, box, iconButton("trash", "Remove", () => line.remove()));
    urls.appendChild(line);
    return box;
  };
  (item.login.urls.length ? item.login.urls : [""]).forEach((url) => addUrl(url));
  const notes = h("textarea", { class: "input", "aria-label": "Notes" }, item.notes || "");
  const error = h("div", { class: "error hidden", role: "alert" });
  const save = h("button", { class: "btn primary", type: "submit" }, "Save");

  const form = h("form", { onsubmit: async (event) => {
    event.preventDefault();
    error.classList.add("hidden");
    save.disabled = true;
    const next = withPasswordChange(item, password.value);
    next.title = title.value.trim();
    next.login.username = username.value.trim();
    next.login.urls = [...urls.querySelectorAll("input")].map((box) => box.value.trim()).filter(Boolean);
    next.notes = notes.value;
    try {
      const { id } = await rpc({ type: "save-item", entry: { id: entry.id, vault: entry.vault, revision: entry.revision, item: next } });
      entries = (await rpc({ type: "entries" })).entries;
      toast("Saved");
      detail(entries.find((e) => e.id === id) || entry);
    } catch (e) {
      if (e.code === "locked") return start();
      // Changed on another device: keep what was typed, and take the
      // revision now on the server so the next Save puts this version on top.
      if (e.code === "conflict" && Number.isInteger(e.details?.revision)) entry = { ...entry, revision: e.details.revision };
      error.textContent = e.message;
      error.classList.remove("hidden");
      save.disabled = false;
    }
  } },
    labelled("Title", title),
    labelled("Username or email", username),
    labelled("Password", h("div", {}, h("div", { class: "field-row" }, password, show, generate), h("div", { class: "meter" }, meter))),
    labelled("Websites", h("div", {}, urls, h("button", { class: "btn ghost", type: "button", onclick: () => addUrl().focus() }, icon("plus"), "Add website"))),
    labelled("Notes", notes),
    error,
    h("div", { class: "edit-actions" }, save, h("button", { class: "btn", type: "button", onclick: () => detail(entry) }, "Cancel")),
    h("button", { class: "btn ghost block", type: "button", onclick: () => vaultPage(`#edit=${entry.id}`) }, icon("open"), "More options in the vault"),
  );
  render(h("div", { class: "detail-head" }, itemAvatar(item, displayTitle(item)), h("h1", {}, `Edit ${displayTitle(item)}`)), form);
  title.focus();
}

// -- generator --------------------------------------------------------------------------------

function generator() {
  setActions([iconButton("back", "Back", unlocked)]);
  const out = h("div", { class: "gen-out", "aria-live": "polite" });
  const meter = h("span");
  const length = h("input", { type: "range", min: 8, max: 64, value: 20, "aria-label": "Length" });
  const lengthLabel = h("span", { class: "faint" });
  const options = { upper: true, digits: true, symbols: true };
  const toggles = Object.keys(options).map((key) => {
    const box = h("input", { type: "checkbox", checked: true, onchange: () => { options[key] = box.checked; make(); } });
    return h("label", { class: "switch" }, { upper: "Capital letters", digits: "Digits", symbols: "Symbols" }[key], box);
  });
  const phrase = h("input", { type: "checkbox", onchange: () => make() });
  let value = "";
  async function make() {
    lengthLabel.textContent = phrase.checked ? `${Math.max(3, Math.round(length.value / 4))} words` : `${length.value} characters`;
    const words = Math.max(3, Math.round(length.value / 4));
    value = phrase.checked ? generatePassphrase({ words }) : generatePassword({ length: Number(length.value), ...options });
    out.textContent = value;
    meter.style.width = `${Math.min(100, (estimateBits(value) / 128) * 100)}%`;
  }
  length.addEventListener("input", make);
  render(
    h("h1", {}, "Password generator"),
    out,
    h("div", { class: "meter" }, meter),
    h("div", { class: "field-row", style: "margin-top:10px" },
      h("button", { class: "btn primary", onclick: () => copyText(value, "Password copied") }, icon("copy"), "Copy"),
      h("button", { class: "btn", onclick: make }, icon("refresh"), "New")),
    h("div", { class: "gen-controls" },
      h("div", { class: "field-row" }, length, lengthLabel),
      h("label", { class: "switch" }, "Words instead of characters", phrase),
      ...toggles),
  );
  make();
}

// -- set up a code from the page ------------------------------------------------------------------

async function scanPage() {
  setActions([iconButton("back", "Back", unlocked)]);
  render(h("p", { class: "muted" }, "Looking for a QR code on this page…"));
  let text = "";
  try {
    const { dataUrl } = await rpc({ type: "capture-tab" });
    text = await readQr(dataUrl);
  } catch (e) {
    return render(errorBox(e));
  }
  const config = parseOtpauth(text);
  if (!config) {
    return render(h("h1", {}, "No setup code found"),
      h("p", { class: "muted" }, "Show the site's QR code on screen and try again, or paste the setup key into a login in your vault."),
      h("button", { class: "btn block", onclick: () => vaultPage("#new") }, "Add it by hand"));
  }
  const site = loginsFor(entries, activeTab.url);
  const save = async (entry) => {
    const item = entry ? { ...entry.item, login: { ...entry.item.login, totp: otpauthUri(config) } } : null;
    if (entry) {
      await rpc({ type: "save-item", entry: { id: entry.id, vault: entry.vault, revision: entry.revision, item } });
      toast("Verification code saved");
      unlocked();
    } else {
      vaultPage(`#new&totp=${encodeURIComponent(otpauthUri(config))}&url=${encodeURIComponent(activeTab.url)}`);
    }
  };
  render(h("h1", {}, "Verification code found"),
    h("p", { class: "muted" }, `${config.issuer || "A site"}${config.account ? ` · ${config.account}` : ""}. Add it to:`),
    ...site.map((e) => row({ ...e }, false)).map((node, i) => { node.onclick = () => save(site[i]); return node; }),
    h("button", { class: "btn block", style: "margin-top:8px", onclick: () => save(null) }, "A new login"));
}

start().catch((e) => render(errorBox(e)));
