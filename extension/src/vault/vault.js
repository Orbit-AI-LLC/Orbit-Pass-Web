/* The vault page: everything the popup is too small for. Items of every
   kind, shared vaults and their members, settings, and signed-in devices. */

import { aiMark, countdownRing, copyText, h, icon, initial, readQr, rpc, toast } from "../ui/dom.js";
import { describeItems, FIELD_TARGETS, guessTarget, loginFieldNames, parseImport, reconcileFields } from "../lib/importers.js";
import { blankItem, cardBrand, displayTitle, hasTotp, search, sortEntries, subtitle, withPasswordChange } from "../lib/items.js";
import { estimateBits, generatePassword } from "../lib/generator.js";
import { otpauthUri, totpFromInput } from "../lib/totp.js";
import { clearSiteIcons, itemAvatar, loadSiteIcons } from "../ui/site-icons.js";

const side = document.getElementById("side");
const list = document.getElementById("list");
const detail = document.getElementById("detail");

const state = {
  status: null,
  entries: [],
  vaults: [],
  me: null,
  filter: { kind: "all" }, // {kind: all|favorites|login|card|identity|note} or {vault: id}
  query: "",
  selected: null,
};
let timer = null;

// Relative to this module, not the page: the web vault's page (/vault/) isn't
// beside it.
const asset = (path) => new URL(path, import.meta.url).href;

const TYPE_LABELS = { login: "Login", card: "Card", identity: "Identity", note: "Secure note" };
const TYPE_ICONS = { login: "key", card: "card", identity: "person", note: "note" };
const ROLE_LABELS = { owner: "Owner", manager: "Manager", editor: "Editor", viewer: "Viewer" };

// -- loading ------------------------------------------------------------------------

async function load() {
  state.status = await rpc({ type: "status" });
  if (!state.status.signedIn || state.status.locked || state.status.needsPrevious) return lockedPage();
  try {
    const [{ entries }, { vaults, me }] = await Promise.all([rpc({ type: "entries" }), rpc({ type: "vaults" })]);
    state.entries = entries;
    state.vaults = vaults;
    state.me = me;
  } catch (error) {
    if (error.code === "locked") return lockedPage();
    throw error;
  }
  drawSide();
  drawList();
  loadSiteIcons(state.entries.map((e) => e.item));
}

async function refresh() {
  await rpc({ type: "sync" }).catch(() => {});
  const [{ entries }, { vaults, me }] = await Promise.all([rpc({ type: "entries" }), rpc({ type: "vaults" })]);
  state.entries = entries;
  state.vaults = vaults;
  state.me = me;
  drawSide();
  drawList();
  loadSiteIcons(state.entries.map((e) => e.item));
}

function lockedPage(error) {
  side.replaceChildren(brand());
  list.replaceChildren();
  const status = state.status || {};
  const box = (...children) => detail.replaceChildren(h("div", { class: "empty-state entrance" },
    h("img", { class: "mark", src: asset("../../icons/mark.svg"), width: 48, height: 48, alt: "" }), ...children));
  const fail = (e) => lockedPage(e);
  const failure = error ? h("div", { class: "error", role: "alert" }, error.message || String(error)) : null;
  const passwordForm = (placeholder, type, label) => {
    const password = h("input", { class: "input", type: "password", placeholder, autocomplete: type === "unlock-password" ? "current-password" : "off", "aria-label": placeholder });
    const submit = h("button", { class: "btn block", type: "submit" }, label);
    return h("form", { onsubmit: async (event) => {
      event.preventDefault();
      if (!password.value) return;
      submit.disabled = true;
      submit.textContent = "Working…";
      try {
        await rpc({ type, password: password.value });
        await load();
        route();
      } catch (e) {
        if (e.code === "needs-previous") { state.status = { ...status, needsPrevious: true }; return lockedPage(); }
        fail(e);
        // No identity yet to check the password against: Orbit's sign-in checks it.
        if (e.code === "needs-orbit") rpc({ type: "unlock-orbit" }).catch(fail);
      }
    } }, password, h("div", { style: "height:8px" }), submit);
  };

  if (!status.signedIn) {
    const server = h("input", { class: "input", value: status.server || "", "aria-label": "Server" });
    return box(
      h("h1", {}, "Sign in to Orbit Pass"),
      h("p", {}, "Your vault is encrypted with your Orbit password, on this device. Sign in with your Orbit account to start."),
      failure,
      h("button", { class: "btn primary block", onclick: () => rpc({ type: "sign-in" }).catch(fail) }, "Sign in with Orbit"),
      // The web vault talks to the server that sent it, and no other.
      status.platform === "web" ? null : h("details", { class: "faint", style: "margin-top:16px;text-align:left" }, h("summary", {}, "Server"),
        h("div", { class: "field-row" }, server, h("button", { class: "btn", onclick: async () => {
          try { state.status = await rpc({ type: "set-server", server: server.value }); toast("Server saved"); } catch (e) { fail(e); }
        } }, "Save"))),
    );
  }
  if (status.needsPrevious) {
    return box(
      h("h1", {}, "Your Orbit password changed"),
      h("p", {}, "Your vault is still sealed to your previous Orbit password. Enter it once and Orbit Pass moves everything over to the new one."),
      failure,
      passwordForm("Previous Orbit password", "previous-password", "Move my vault"),
      h("div", { class: "divider" }, "forgot it?"),
      h("p", { class: "faint" }, "Starting over keeps your shared vaults (a teammate shares them again) but your personal items can't be recovered."),
      h("button", { class: "btn danger block", onclick: async () => {
        if (!confirm("Start over? Items in your personal vault will be lost for good.")) return;
        try { await rpc({ type: "start-over" }); await load(); route(); } catch (e) { fail(e); }
      } }, "Start over"),
    );
  }
  return box(
    h("h1", {}, "Orbit Pass is locked"),
    h("p", {}, status.email || ""),
    failure,
    h("button", { class: "btn primary block", onclick: () => rpc({ type: "unlock-orbit" }).catch(fail) }, "Unlock with Orbit"),
    h("div", { class: "divider" }, "or"),
    passwordForm("Orbit password", "unlock-password", "Unlock"),
  );
}

function brand() {
  return h("div", { class: "brand" }, h("img", { class: "mark", src: asset("../../icons/logo.svg"), width: 22, height: 22, alt: "" }), h("span", {}, "Orbit Pass"));
}

// -- sidebar ----------------------------------------------------------------------------

function count(filter) {
  return filtered(filter, "").length;
}

function navButton(label, iconName, active, onclick, trailing) {
  return h("button", { class: `nav${active ? " active" : ""}`, onclick }, icon(iconName), h("span", { class: "label-text" }, label), trailing || null);
}

function drawSide() {
  const f = state.filter;
  const kinds = [["all", "All items", "key"], ["favorites", "Favorites", "star"], ["login", "Logins", "globe"], ["card", "Cards", "card"], ["identity", "Identities", "person"], ["note", "Secure notes", "note"]];
  const canShare = state.status.organization?.can_share;
  side.replaceChildren(...[
    brand(),
    ...kinds.map(([kind, label, iconName]) => navButton(label, iconName, f.kind === kind, () => select({ kind }), h("span", { class: "count" }, count({ kind })))),
    h("div", { class: "section-title" }, "Vaults"),
    ...state.vaults.map((vault) => navButton(vault.name, vault.kind === "personal" ? "lock" : "users", f.vault === vault.id, () => select({ vault: vault.id }),
      !vault.open ? h("span", { class: "pill warn", title: "Waiting for a teammate to share this vault with you again" }, "Locked")
        : vault.canManage && vault.members.some((m) => m.needs_reshare) ? h("span", { class: "pill warn" }, "Action") : h("span", { class: "count" }, count({ vault: vault.id })))),
    canShare ? navButton("New shared vault", "plus", false, newVault) : null,
    h("div", { class: "grow" }),
    navButton("Import", "import", f.page === "import", () => select({ page: "import" })),
    navButton("Devices", "devices", f.page === "devices", () => select({ page: "devices" })),
    navButton("Settings", "gear", f.page === "settings", () => select({ page: "settings" })),
    navButton("Lock", "lock", false, async () => { await rpc({ type: "lock" }); load(); }),
  ].filter(Boolean));
}

function select(filter) {
  state.filter = filter;
  state.selected = null;
  drawSide();
  if (filter.page === "settings") { list.replaceChildren(); return settingsPage(); }
  if (filter.page === "devices") { list.replaceChildren(); return devicesPage(); }
  if (filter.page === "import") { list.replaceChildren(); return importPage(); }
  drawList();
  if (filter.vault) {
    const vault = state.vaults.find((v) => v.id === filter.vault);
    if (vault && vault.kind === "shared") return vaultPage(vault);
  }
  detail.replaceChildren(emptyDetail());
}

// -- the list -------------------------------------------------------------------------------

function filtered(filter, query) {
  let out = state.entries;
  if (filter.vault) out = out.filter((e) => e.vault === filter.vault);
  else if (filter.kind === "favorites") out = out.filter((e) => e.item.favorite);
  else if (filter.kind && filter.kind !== "all") out = out.filter((e) => e.item.type === filter.kind);
  return sortEntries(search(out, query));
}

function drawList() {
  if (state.filter.page) return;
  const box = h("input", { class: "input", type: "search", placeholder: "Search", value: state.query, "aria-label": "Search" });
  const body = h("div", { class: "list-body" });
  const fill = () => {
    const rows = filtered(state.filter, state.query);
    body.replaceChildren(...(rows.length ? rows.map((entry) => h("div", {
      class: `item-row${state.selected === entry.id ? " active" : ""}`, role: "button", tabindex: 0,
      onclick: () => showItem(entry.id), onkeydown: (e) => e.key === "Enter" && showItem(entry.id),
    }, itemAvatar(entry.item, displayTitle(entry.item)), h("span", { class: "text" }, h("div", { class: "title" }, displayTitle(entry.item)), h("div", { class: "sub" }, subtitle(entry.item))))) : [h("div", { class: "empty-state" }, "Nothing here yet.")]));
  };
  box.addEventListener("input", () => { state.query = box.value; fill(); });
  const add = h("button", { class: "btn primary", onclick: () => editItem(null) }, icon("plus"), "New");
  list.replaceChildren(h("div", { class: "list-head" }, box, add), body);
  fill();
}

function emptyDetail() {
  return h("div", { class: "empty-state" }, h("img", { class: "mark", src: asset("../../icons/mark.svg"), width: 40, height: 40, alt: "" }), h("p", {}, "Choose an item, or make a new one."));
}

function vaultName(id) {
  return state.vaults.find((v) => v.id === id)?.name || "Vault";
}

// -- one item --------------------------------------------------------------------------------

function fieldRow(label, value, { secret = false, mono = false } = {}) {
  if (!value) return null;
  let shown = !secret;
  const text = h("span", { class: `grow${mono || secret ? " mono" : ""}` }, secret ? "••••••••••••" : value);
  const toggle = secret ? h("button", { class: "icon-btn", title: "Show", onclick: () => { shown = !shown; text.textContent = shown ? value : "••••••••••••"; toggle.replaceChildren(icon(shown ? "eyeOff" : "eye")); } }, icon("eye")) : null;
  return h("div", { class: "detail-field" }, h("div", { class: "label" }, label),
    h("div", { class: "value" }, text, toggle, h("button", { class: "icon-btn", title: `Copy ${label.toLowerCase()}`, onclick: () => copyText(value, `${label} copied`) }, icon("copy"))));
}

function showItem(id) {
  clearInterval(timer);
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return;
  state.selected = id;
  drawList();
  const { item } = entry;
  const vault = state.vaults.find((v) => v.id === entry.vault);
  const parts = [];
  if (item.type === "login") {
    parts.push(fieldRow("Username", item.login.username));
    parts.push(fieldRow("Password", item.login.password, { secret: true }));
    if (hasTotp(item)) {
      const box = h("div", { class: "detail-field" }, h("div", { class: "label" }, "Verification code"), h("div", { class: "value" }));
      parts.push(box);
      const tick = async () => {
        const { code } = await rpc({ type: "totp", id });
        if (code) box.lastChild.replaceChildren(h("span", { class: "grow code" }, code.code.replace(/^(\d{3})(\d{3})$/, "$1 $2")), countdownRing(code.remaining, code.period), h("button", { class: "icon-btn", title: "Copy code", onclick: () => copyText(code.code, "Code copied") }, icon("copy")));
      };
      tick();
      timer = setInterval(tick, 1000);
    }
    for (const url of item.login.urls) parts.push(h("div", { class: "detail-field" }, h("div", { class: "label" }, "Website"), h("div", { class: "value" }, h("a", { class: "grow", href: url.includes("://") ? url : `https://${url}`, target: "_blank", rel: "noreferrer" }, url))));
    for (const passkey of item.login.passkeys || []) parts.push(h("div", { class: "detail-field" }, h("div", { class: "label" }, "Passkey"), h("div", { class: "value" }, h("span", { class: "grow" }, `${passkey.userName || passkey.userDisplayName || "Passkey"} · ${passkey.rpId}`))));
  } else if (item.type === "card") {
    parts.push(fieldRow("Cardholder", item.card.cardholder));
    parts.push(fieldRow("Number", item.card.number, { secret: true }));
    parts.push(fieldRow("Expires", item.card.expMonth && item.card.expYear ? `${item.card.expMonth}/${item.card.expYear}` : ""));
    parts.push(fieldRow("Security code", item.card.cvv, { secret: true }));
  } else if (item.type === "identity") {
    const i = item.identity;
    parts.push(fieldRow("Name", [i.firstName, i.middleName, i.lastName].filter(Boolean).join(" ")));
    parts.push(fieldRow("Email", i.email));
    parts.push(fieldRow("Phone", i.phone));
    parts.push(fieldRow("Company", i.company));
    parts.push(fieldRow("Address", [i.address1, i.address2].filter(Boolean).join(", ")));
    parts.push(fieldRow("City", [i.city, i.state, i.postalCode].filter(Boolean).join(" ")));
    parts.push(fieldRow("Country", i.country));
  }
  for (const custom of item.fields || []) parts.push(fieldRow(custom.name || "Field", custom.value, { secret: custom.hidden }));
  if (item.notes) parts.push(h("div", { class: "detail-field" }, h("div", { class: "label" }, "Notes"), h("div", { class: "value", style: "white-space:pre-wrap" }, item.notes)));
  const meta = h("p", { class: "faint" }, `${TYPE_LABELS[item.type]} in ${vaultName(entry.vault)}${entry.updatedBy ? ` · last changed by ${entry.updatedBy}` : ""}`);
  detail.replaceChildren(h("div", { class: "wrap" },
    h("div", { class: "detail-top" }, itemAvatar(item, displayTitle(item)), h("h1", {}, displayTitle(item)), item.favorite ? icon("star") : null),
    h("div", { class: "panel" }, ...parts.filter(Boolean).length ? parts.filter(Boolean) : [h("p", { class: "muted", style: "margin:12px 0" }, "No details yet.")]),
    meta,
    vault?.canEdit ? h("div", { class: "toolbar" }, h("button", { class: "btn primary", onclick: () => editItem(entry) }, "Edit")) : h("p", { class: "faint" }, "You can view this vault but not change it."),
  ));
}

// -- editing ----------------------------------------------------------------------------------

function input(value, attrs = {}) {
  return h("input", { class: "input", value: value || "", ...attrs });
}

function labelled(label, node) {
  return h("div", {}, h("label", { class: "label" }, label), node);
}

function editItem(entry, preset = {}) {
  clearInterval(timer);
  const editableVaults = state.vaults.filter((v) => v.open && v.canEdit);
  if (!editableVaults.length) return toast("There's no vault you can add to.");
  const isNew = !entry;
  let item = structuredClone(entry ? entry.item : blankItem(preset.type || "login"));
  if (isNew && preset.totp) item.login.totp = preset.totp;
  if (isNew && preset.url) item.login.urls = [new URL(preset.url).origin];
  const defaultVault = state.filter.vault && editableVaults.some((v) => v.id === state.filter.vault) ? state.filter.vault : editableVaults[0].id;
  let vaultId = entry ? entry.vault : defaultVault;
  const error = h("div", { class: "error hidden", role: "alert" });

  const typeSelect = isNew ? h("select", { class: "input", onchange: () => { const fresh = blankItem(typeSelect.value); fresh.title = title.value; item = fresh; drawForm(); } },
    ...Object.entries(TYPE_LABELS).map(([value, label]) => h("option", { value, selected: item.type === value }, label))) : null;
  const vaultSelect = h("select", { class: "input", onchange: () => { vaultId = vaultSelect.value; } },
    ...editableVaults.map((v) => h("option", { value: v.id, selected: v.id === vaultId }, v.name)));
  const title = input(item.title, { placeholder: "Title" });
  const favorite = h("input", { type: "checkbox", checked: item.favorite });
  const notes = h("textarea", { class: "input", placeholder: "Notes" }, item.notes || "");
  const form = h("div");
  const collect = {};

  function drawForm() {
    const parts = [];
    for (const key of Object.keys(collect)) delete collect[key];
    if (item.type === "login") {
      const username = input(item.login.username, { autocomplete: "off" });
      const password = input(item.login.password, { type: "password", autocomplete: "new-password", class: "input mono" });
      const meter = h("span");
      const updateMeter = () => { meter.style.width = `${Math.min(100, (estimateBits(password.value) / 128) * 100)}%`; };
      password.addEventListener("input", updateMeter);
      updateMeter();
      const urls = h("div", { class: "urls" });
      const urlRows = [];
      const addUrl = (value = "") => {
        const box = input(value, { placeholder: "https://example.com" });
        const rowNode = h("div", { class: "field-row" }, box, h("button", { class: "icon-btn", title: "Remove", onclick: () => { rowNode.remove(); urlRows.splice(urlRows.indexOf(box), 1); } }, icon("trash")));
        urlRows.push(box);
        urls.appendChild(rowNode);
      };
      (item.login.urls.length ? item.login.urls : [""]).forEach(addUrl);
      const totp = input(item.login.totp, { placeholder: "otpauth://… or setup key", class: "input mono", autocomplete: "off" });
      const qrFile = h("input", { type: "file", accept: "image/*", class: "hidden", onchange: async () => {
        const text = qrFile.files[0] ? await readQr(qrFile.files[0]) : "";
        if (totpFromInput(text)) { totp.value = text; toast("Setup code read"); } else toast("No setup QR code in that image.");
      } });
      parts.push(
        labelled("Username or email", username),
        labelled("Password", h("div", {}, h("div", { class: "field-row" }, password,
          h("button", { class: "icon-btn", title: "Show", onclick: (e) => { password.type = password.type === "password" ? "text" : "password"; e.currentTarget.replaceChildren(icon(password.type === "password" ? "eye" : "eyeOff")); } }, icon("eye")),
          h("button", { class: "icon-btn", title: "Generate", onclick: () => { password.value = generatePassword({ length: 20 }); password.type = "text"; updateMeter(); } }, icon("dice"))),
          h("div", { class: "meter" }, meter))),
        labelled("Websites", h("div", {}, urls, h("button", { class: "btn ghost", onclick: () => addUrl("") }, icon("plus"), "Add website"))),
        labelled("Verification code (TOTP)", h("div", { class: "field-row" }, totp, qrFile, h("button", { class: "btn", title: "Read a setup QR code from an image", onclick: () => qrFile.click() }, icon("qr"), "QR image"))),
      );
      if (item.login.passkeys?.length) {
        parts.push(labelled("Passkeys", h("div", {}, ...item.login.passkeys.map((passkey, i) => h("div", { class: "field-row", style: "margin-bottom:6px" },
          h("span", { class: "grow" }, `${passkey.userName || "Passkey"} · ${passkey.rpId}`),
          h("button", { class: "btn danger", onclick: () => { if (confirm("Remove this passkey? You won't be able to sign in with it.")) { item.login.passkeys.splice(i, 1); drawForm(); } } }, "Remove"))))));
      }
      collect.read = () => {
        const totpValue = totp.value.trim();
        if (totpValue && !totpFromInput(totpValue)) throw new Error("That verification code setup isn't valid. Paste the otpauth:// link or the setup key.");
        const config = totpFromInput(totpValue);
        const next = withPasswordChange(item, password.value);
        next.login.username = username.value.trim();
        next.login.urls = urlRows.map((b) => b.value.trim()).filter(Boolean);
        next.login.totp = config ? (totpValue.startsWith("otpauth") ? totpValue : otpauthUri({ ...config, issuer: title.value.trim() })) : "";
        return next;
      };
    } else if (item.type === "card") {
      const c = item.card;
      const holder = input(c.cardholder, { autocomplete: "off" });
      const number = input(c.number, { class: "input mono", inputmode: "numeric", autocomplete: "off" });
      const month = input(c.expMonth, { placeholder: "MM", inputmode: "numeric", maxlength: 2 });
      const year = input(c.expYear, { placeholder: "YYYY", inputmode: "numeric", maxlength: 4 });
      const cvv = input(c.cvv, { type: "password", inputmode: "numeric", maxlength: 4, autocomplete: "off" });
      parts.push(labelled("Cardholder name", holder), labelled("Card number", number), h("div", { class: "grid3" }, labelled("Month", month), labelled("Year", year), labelled("Security code", cvv)));
      collect.read = () => ({ ...item, card: { cardholder: holder.value.trim(), number: number.value.replace(/\s+/g, " ").trim(), expMonth: month.value.padStart(month.value ? 2 : 0, "0"), expYear: year.value.length === 2 ? `20${year.value}` : year.value, cvv: cvv.value.trim(), brand: cardBrand(number.value) } });
    } else if (item.type === "identity") {
      const i = item.identity;
      const boxes = {};
      const make = (key, label, attrs = {}) => { boxes[key] = input(i[key], attrs); return labelled(label, boxes[key]); };
      parts.push(
        h("div", { class: "grid3" }, make("firstName", "First name"), make("middleName", "Middle name"), make("lastName", "Last name")),
        h("div", { class: "grid2" }, make("email", "Email", { type: "email" }), make("phone", "Phone", { type: "tel" })),
        make("company", "Company"), make("address1", "Address"), make("address2", "Apartment, suite, etc."),
        h("div", { class: "grid3" }, make("city", "City"), make("state", "State or region"), make("postalCode", "Postal code")),
        make("country", "Country"),
      );
      collect.read = () => ({ ...item, identity: Object.fromEntries(Object.entries(boxes).map(([k, b]) => [k, b.value.trim()])) });
    } else {
      collect.read = () => ({ ...item });
    }
    // Custom fields, for every kind.
    const customs = h("div");
    const customRows = [];
    const addCustom = (f = { name: "", value: "", hidden: false }) => {
      const name = input(f.name, { placeholder: "Name" });
      const value = input(f.value, { placeholder: "Value", type: f.hidden ? "password" : "text" });
      const hidden = h("input", { type: "checkbox", checked: f.hidden, title: "Hidden", onchange: () => { value.type = hidden.checked ? "password" : "text"; } });
      const rowNode = h("div", { class: "custom" }, name, value, hidden, h("button", { class: "icon-btn", title: "Remove", onclick: () => { rowNode.remove(); customRows.splice(customRows.indexOf(entryRow), 1); } }, icon("trash")));
      const entryRow = { name, value, hidden };
      customRows.push(entryRow);
      customs.appendChild(rowNode);
    };
    (item.fields || []).forEach(addCustom);
    parts.push(labelled("More fields", h("div", {}, customs, h("button", { class: "btn ghost", onclick: () => addCustom() }, icon("plus"), "Add field"))));
    collect.fields = () => customRows.map((r) => ({ name: r.name.value.trim(), value: r.value.value, hidden: r.hidden.checked })).filter((f) => f.name || f.value);
    form.replaceChildren(...parts);
  }

  async function save() {
    error.classList.add("hidden");
    try {
      const next = collect.read();
      next.title = title.value.trim();
      next.favorite = favorite.checked;
      next.notes = notes.value;
      next.fields = collect.fields();
      let id;
      if (entry && vaultId !== entry.vault) {
        await rpc({ type: "save-item", entry: { id: entry.id, vault: entry.vault, revision: entry.revision, item: next } });
        await refresh();
        id = (await rpc({ type: "move-item", id: entry.id, vault: vaultId })).id;
      } else {
        id = (await rpc({ type: "save-item", entry: { id: entry?.id, vault: vaultId, revision: entry?.revision, item: next } })).id;
      }
      await refresh();
      toast("Saved");
      showItem(id);
    } catch (e) {
      // Changed on another device: keep what was typed, and take the
      // revision now on the server so the next Save puts this version on top.
      if (e.code === "conflict" && entry && Number.isInteger(e.details?.revision)) entry = { ...entry, revision: e.details.revision };
      error.textContent = e.message;
      error.classList.remove("hidden");
      if (e.code === "conflict") await refresh();
    }
  }

  drawForm();
  detail.replaceChildren(h("div", { class: "wrap" },
    h("div", { class: "detail-top" }, h("h1", {}, isNew ? "New item" : `Edit ${displayTitle(item)}`)),
    error,
    h("div", { class: "grid2" }, typeSelect ? labelled("Kind", typeSelect) : null, labelled("Vault", vaultSelect)),
    labelled("Title", title),
    form,
    labelled("Notes", notes),
    h("label", { class: "switch" }, "Favorite", favorite),
    h("div", { class: "toolbar" },
      h("button", { class: "btn primary", onclick: save }, "Save"),
      h("button", { class: "btn", onclick: () => (entry ? showItem(entry.id) : detail.replaceChildren(emptyDetail())) }, "Cancel"),
      entry ? h("button", { class: "btn danger", onclick: async () => {
        if (!confirm(`Delete ${displayTitle(item)}? Everyone with access to ${vaultName(entry.vault)} loses it too.`)) return;
        try { await rpc({ type: "delete-item", id: entry.id }); await refresh(); detail.replaceChildren(emptyDetail()); toast("Deleted"); } catch (e) { toast(e.message); }
      } }, icon("trash"), "Delete") : null),
  ));
  title.focus();
}

// -- shared vaults ------------------------------------------------------------------------------

async function newVault() {
  const name = h("input", { class: "input", placeholder: "Engineering, Finance, Marketing…" });
  const description = h("input", { class: "input", placeholder: "What it's for (optional)" });
  const error = h("div", { class: "error hidden" });
  state.filter = { kind: "new-vault" };
  drawSide();
  list.replaceChildren();
  detail.replaceChildren(h("div", { class: "wrap" },
    h("div", { class: "detail-top" }, h("h1", {}, "New shared vault")),
    h("p", { class: "muted" }, `Share logins with teammates in ${state.status.organization?.name || "your organization"}. Each person you add gets their own copy of the vault's key, wrapped to them; the server can't open it.`),
    error, labelled("Name", name), labelled("Description", description),
    h("div", { class: "toolbar" }, h("button", { class: "btn primary", onclick: async () => {
      if (!name.value.trim()) return name.focus();
      try {
        const { id } = await rpc({ type: "create-vault", name: name.value.trim(), description: description.value.trim() });
        await refresh();
        select({ vault: id });
      } catch (e) { error.textContent = e.message; error.classList.remove("hidden"); }
    } }, "Create vault")),
  ));
  name.focus();
}

function vaultPage(vault) {
  const error = h("div", { class: "error hidden", role: "alert" });
  const fail = (e) => { error.textContent = e.message; error.classList.remove("hidden"); };
  const meId = state.me?.id;
  const members = vault.members.map((member) => {
    const isMe = member.user.id === meId;
    const role = h("select", { class: "input", disabled: !vault.canManage || isMe || (vault.role !== "owner" && member.role === "owner"), onchange: async () => {
      try { await rpc({ type: "set-role", id: vault.id, userId: member.user.id, role: role.value }); await refresh(); toast("Role changed"); } catch (e) { fail(e); refresh(); }
    } }, ...Object.entries(ROLE_LABELS).filter(([value]) => vault.role === "owner" || value !== "owner" || member.role === "owner").map(([value, label]) => h("option", { value, selected: member.role === value }, label)));
    return h("div", { class: "member" },
      h("span", { class: "avatar soft" }, initial(member.user.name)),
      h("span", { class: "text" }, h("div", { class: "title" }, `${member.user.name}${isMe ? " (you)" : ""}`), h("div", { class: "sub muted" }, member.user.email)),
      member.needs_reshare ? (vault.canManage && vault.open
        ? h("button", { class: "btn", title: "They changed their Orbit password", onclick: async () => {
          if (!confirm(`${member.user.email} reset their Orbit password. Share this vault with their new key?`)) return;
          try { await rpc({ type: "reshare", id: vault.id, member }); await refresh(); toast("Shared again"); vaultPage(state.vaults.find((v) => v.id === vault.id)); } catch (e) { fail(e); }
        } }, "Share again")
        : h("span", { class: "pill warn" }, "Needs re-share")) : null,
      role,
      vault.canManage && !isMe && (vault.role === "owner" || member.role !== "owner") ? h("button", { class: "icon-btn", title: "Remove", onclick: async () => {
        if (!confirm(`Remove ${member.user.email} from ${vault.name}? Orbit Pass then moves the vault to a new key.`)) return;
        try { await rpc({ type: "remove-member", id: vault.id, userId: member.user.id }); await refresh(); toast("Removed"); vaultPage(state.vaults.find((v) => v.id === vault.id)); } catch (e) { fail(e); }
      } }, icon("trash")) : null,
    );
  });

  const addBox = h("input", { class: "input", placeholder: "Search teammates by name or email" });
  const addRole = h("select", { class: "input", style: "width:auto" }, ...["editor", "viewer", "manager"].concat(vault.role === "owner" ? ["owner"] : []).map((r) => h("option", { value: r }, ROLE_LABELS[r])));
  const results = h("div");
  const searchPeople = async () => {
    try {
      const { people } = await rpc({ type: "candidates", id: vault.id, q: addBox.value });
      results.replaceChildren(...(people.length ? people.map((person) => h("div", { class: "member" },
        h("span", { class: "avatar soft" }, initial(person.user.name)),
        h("span", { class: "text" }, h("div", { class: "title" }, person.user.name), h("div", { class: "sub muted" }, person.user.email)),
        h("button", { class: "btn", onclick: async () => {
          try { await rpc({ type: "add-member", id: vault.id, person, role: addRole.value }); await refresh(); toast(`${person.user.name} added`); vaultPage(state.vaults.find((v) => v.id === vault.id)); } catch (e) { fail(e); }
        } }, "Add"))) : [h("p", { class: "faint", style: "margin:8px 0" }, "No one else yet. Teammates appear here once they've opened Orbit Pass with your organization's Orbit account.")]));
    } catch (e) { fail(e); }
  };
  addBox.addEventListener("input", () => { clearTimeout(addBox.timer); addBox.timer = setTimeout(searchPeople, 200); });

  const name = h("input", { class: "input", value: vault.name });
  const description = h("input", { class: "input", value: vault.description, placeholder: "What it's for" });
  detail.replaceChildren(h("div", { class: "wrap" },
    h("div", { class: "detail-top" }, h("span", { class: "avatar" }, icon("users")), h("h1", {}, vault.name), h("span", { class: "pill" }, ROLE_LABELS[vault.role])),
    !vault.open ? h("div", { class: "notice warn" }, "You changed your Orbit password and this vault's key was sealed to the old one. A manager or owner of the vault needs to share it with you again.") : null,
    error,
    h("h2", {}, "People"),
    h("div", { class: "panel" }, ...members),
    vault.canManage && vault.open ? h("div", {}, h("h2", {}, "Add people"), h("div", { class: "field-row" }, addBox, addRole), results) : null,
    vault.canManage && vault.open ? h("div", { style: "margin-top:18px" }, h("h2", {}, "Name"), labelled("Name", name), labelled("Description", description),
      h("div", { class: "toolbar" }, h("button", { class: "btn", onclick: async () => {
        try { await rpc({ type: "rename-vault", id: vault.id, name: name.value.trim() || vault.name, description: description.value.trim() }); await refresh(); toast("Saved"); } catch (e) { fail(e); }
      } }, "Save name"), h("button", { class: "btn", title: "Re-seal everything under a fresh key", onclick: async () => {
        if (!confirm("Move this vault to a new key now? Everyone keeps access; anyone who copied the old key loses it.")) return;
        try { await rpc({ type: "rotate-vault", id: vault.id }); await refresh(); toast("Vault moved to a new key"); } catch (e) { fail(e); }
      } }, "Change key"))) : null,
    h("div", { class: "toolbar" },
      vault.role !== "owner" ? h("button", { class: "btn danger", onclick: async () => {
        if (!confirm(`Leave ${vault.name}?`)) return;
        try { await rpc({ type: "leave-vault", id: vault.id }); await refresh(); select({ kind: "all" }); } catch (e) { fail(e); }
      } }, "Leave vault") : null,
      vault.role === "owner" ? h("button", { class: "btn danger", onclick: async () => {
        if (!confirm(`Delete ${vault.name} and everything in it, for everyone? This can't be undone.`)) return;
        try { await rpc({ type: "delete-vault", id: vault.id }); await refresh(); select({ kind: "all" }); } catch (e) { fail(e); }
      } }, icon("trash"), "Delete vault") : null),
  ));
  if (vault.canManage && vault.open) searchPeople();
}

// -- settings and devices ---------------------------------------------------------------------

async function settingsPage() {
  const settings = await rpc({ type: "settings" });
  const desktop = state.status.platform === "desktop";
  const web = state.status.platform === "web";
  // The Windows app and the web vault fill nothing; the extension does.
  const fills = !desktop && !web;
  // Firefox and Orbit Browser don't tell extensions when the computer locks.
  const firefox = location.protocol === "moz-extension:";
  const quits = desktop ? "you quit Orbit Pass" : web ? "you close or reload this page" : "the browser quits";
  const update = (changes) => rpc({ type: "update-settings", changes }).then(() => toast("Saved"));
  const version = desktop ? (await rpc({ type: "app-version" }).catch(() => ({}))).version : "";
  const checkForUpdates = h("button", { class: "btn", onclick: async () => {
    checkForUpdates.disabled = true;
    checkForUpdates.textContent = "Checking…";
    // The app says what it found (up to date, ready to restart, or failed) in a dialog of its own.
    await rpc({ type: "check-for-updates" }).catch((error) => toast(error.message));
    checkForUpdates.disabled = false;
    checkForUpdates.textContent = "Check for Updates";
  } }, "Check for Updates");
  const toggle = (key, label, hint, after) => {
    const box = h("input", { type: "checkbox", checked: settings[key], onchange: () => update({ [key]: box.checked }).then(() => after?.(box.checked)) });
    return h("label", { class: "switch" }, h("span", {}, h("div", {}, label), hint ? h("div", { class: "faint" }, hint) : null), box);
  };
  const lock = h("select", { class: "input", style: "width:auto", onchange: () => update({ autoLockMinutes: Number(lock.value) }) },
    ...[[1, "After 1 minute"], [5, "After 5 minutes"], [15, "After 15 minutes"], [30, "After 30 minutes"], [60, "After 1 hour"], [240, "After 4 hours"], [0, `Only when ${quits}`]]
      .map(([value, label]) => h("option", { value, selected: settings.autoLockMinutes === value }, label)));
  const never = settings.neverSave.length ? settings.neverSave.map((origin) => h("div", { class: "field-row", style: "padding:6px 0" }, h("span", { class: "grow" }, origin),
    h("button", { class: "btn ghost", onclick: async () => { await update({ neverSave: settings.neverSave.filter((o) => o !== origin) }); settingsPage(); } }, "Remove"))) : [h("p", { class: "faint", style: "margin:8px 0" }, "None.")];
  detail.replaceChildren(h("div", { class: "wrap" },
    h("div", { class: "detail-top" }, h("h1", {}, "Settings")),
    h("h2", {}, "Locking"),
    h("div", { class: "panel" },
      h("div", { class: "switch" }, h("span", {}, h("div", {}, "Lock Orbit Pass"), h("div", { class: "faint" }, `When you haven't used it for this long. It always locks when ${quits}.`)), lock),
      fills && !firefox ? toggle("lockWhenComputerLocks", "Lock when your computer locks") : null),
    fills ? null : h("p", { class: "faint" }, "Orbit Pass fills logins in Chrome and Orbit Browser through the Orbit Pass extension, which you sign in to separately."),
    fills ? h("h2", {}, "Filling") : null,
    fills ? h("div", { class: "panel" },
      toggle("inlineMenu", "Offer logins when you click a field", "A menu opens under sign-in, code, card and address fields you click."),
      toggle("smartDetection", h("span", {}, aiMark(), "Find fields with the on-device model"), "Runs once when a page loads to spot verification-code, card and address fields. Nothing about the page leaves this computer."),
      toggle("copyTotpAfterFill", "Copy the verification code after filling a login", "Ready to paste on the next step."),
      toggle("offerToSave", "Offer to save new logins")) : null,
    fills ? h("h2", {}, "Never offer to save on") : null,
    fills ? h("div", { class: "panel" }, ...never) : null,
    h("h2", {}, "Website icons"),
    h("div", { class: "panel" },
      toggle("siteIcons", "Show websites' icons beside logins",
        "Orbit Pass sends each login's site, like github.com but never the full address, to its server, which fetches the icon once and keeps it for everyone. Turned off, nothing is sent and logins show their first letter.",
        (on) => (on ? loadSiteIcons(state.entries.map((e) => e.item)) : clearSiteIcons()))),
    // The Windows app has Check for Updates here; the Mac app has it in its Help menu.
    desktop ? h("h2", {}, "Updates") : null,
    desktop ? h("div", { class: "panel" }, h("div", { class: "switch" },
      h("span", {}, h("div", {}, version ? `Orbit Pass ${version}` : "Orbit Pass"), h("div", { class: "faint" }, "Orbit Pass checks for updates on its own every few hours. Check now to get a new version straight away.")),
      checkForUpdates)) : null,
    h("h2", {}, "Account"),
    h("div", { class: "panel" },
      h("div", { class: "detail-field" }, h("div", { class: "label" }, "Signed in as"), h("div", { class: "value" }, state.status.email)),
      state.status.organization ? h("div", { class: "detail-field" }, h("div", { class: "label" }, "Organization"), h("div", { class: "value" }, state.status.organization.name)) : null,
      h("div", { class: "detail-field" }, h("div", { class: "label" }, "Server"), h("div", { class: "value" }, state.status.server))),
    h("div", { class: "toolbar" }, h("button", { class: "btn danger", onclick: async () => {
      if (!confirm(`Sign out of Orbit Pass on this ${desktop ? "computer" : "browser"}? Your vault stays safe on the server.`)) return;
      await rpc({ type: "sign-out" });
      load();
    } }, desktop ? "Sign out of this computer" : "Sign out of this browser")),
  ));
}

// -- importing ------------------------------------------------------------------------------

const IMPORT_SOURCES = "Chrome, Edge, Brave, Safari, Apple Passwords, Firefox, Bitwarden (CSV or unencrypted JSON), 1Password (CSV), LastPass, Dashlane, Proton Pass, NordPass, KeePass, or any CSV file with a header row";

/** Choose an exported file, see what's in it, pick a vault, import. */
function importPage() {
  const vaults = state.vaults.filter((v) => v.open && v.canEdit);
  const page = (...children) => detail.replaceChildren(h("div", { class: "wrap" }, h("div", { class: "detail-top" }, h("h1", {}, "Import passwords")), ...children));
  const failure = (error) => h("div", { class: "error", role: "alert" }, error.message || String(error));
  if (!vaults.length) return page(h("p", { class: "muted" }, "There's no vault you can add to."));

  const choose = (error) => {
    const file = h("input", { class: "input", type: "file", accept: ".csv,.json,.txt,text/csv,application/json", "aria-label": "Exported file" });
    file.addEventListener("change", async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      try {
        review(parseImport(await chosen.text(), chosen.name));
      } catch (e) {
        choose(e);
      }
    });
    page(
      h("p", { class: "muted" }, "Export your passwords from the browser or password manager you used before, then choose the file here. Orbit Pass reads it on this device and encrypts each item before it leaves."),
      h("div", { class: "panel" },
        h("div", { class: "detail-field" }, h("div", { class: "label" }, "Exported file"), file),
        h("p", { class: "faint" }, `From ${IMPORT_SOURCES}.`)),
      error ? failure(error) : null,
      tidyFields(),
    );
  };

  const review = (parsed, error) => {
    const picker = h("select", { class: "input", style: "width:auto", "aria-label": "Vault" },
      ...vaults.map((v) => h("option", { value: v.id, selected: v.kind === "personal" }, v.name)));
    const go = h("button", { class: "btn primary", disabled: !parsed.items.length }, `Import ${parsed.items.length === 1 ? "1 item" : `${parsed.items.length} items`}`);
    go.addEventListener("click", async () => {
      go.disabled = true;
      go.textContent = "Importing…";
      try {
        const result = await rpc({ type: "import-items", vault: picker.value, items: parsed.items });
        await refresh();
        done(result, vaults.find((v) => v.id === picker.value));
      } catch (e) {
        review(parsed, e);
      }
    });
    page(
      h("div", { class: "panel" },
        h("p", {}, `Found ${describeItems(parsed.items)} from ${parsed.source}.`),
        parsed.skipped ? h("p", { class: "faint" }, `${parsed.skipped === 1 ? "1 row" : `${parsed.skipped} rows`} had nothing Orbit Pass can keep, and will be left out.`) : null,
        h("div", { class: "switch" }, h("span", {}, h("div", {}, "Add them to"), h("div", { class: "faint" }, "Items already in that vault aren't added twice.")), picker)),
      error ? failure(error) : null,
      h("div", { class: "toolbar" }, go, h("button", { class: "btn ghost", onclick: () => choose() }, "Choose another file")),
    );
  };

  const done = ({ imported, duplicates }, vault) => {
    page(
      h("div", { class: "panel" },
        h("p", {}, `Imported ${imported === 1 ? "1 item" : `${imported} items`} into ${vault?.name || "your vault"}.`),
        duplicates ? h("p", { class: "faint" }, `${duplicates === 1 ? "1 was" : `${duplicates} were`} already there.`) : null),
      h("p", { class: "muted" }, "Delete the exported file now: it isn't encrypted, and anyone who opens it can read your passwords."),
      h("div", { class: "toolbar" },
        h("button", { class: "btn primary", onclick: () => select(vault ? { vault: vault.id } : { kind: "all" }) }, "Show them"),
        h("button", { class: "btn ghost", onclick: () => choose() }, "Import another file")),
      tidyFields(vault?.id),
    );
  };

  choose();
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Import's Advanced section. Some apps export the username as its own field
    ("Email", say), so the login comes in with that field and no username:
    choose the field and what it really is, and every login missing that
    gets it (importers.js, reconcileFields). */
function tidyFields(preferredVault) {
  const vaults = state.vaults.filter((v) => v.open && v.canEdit);
  const body = h("div");
  let outcome = null;
  let failure = null;

  const vaultPicker = h("select", { class: "input", style: "width:auto", "aria-label": "Vault" },
    vaults.length > 1 ? h("option", { value: "" }, "All your vaults") : null,
    ...vaults.map((v) => h("option", { value: v.id, selected: v.id === preferredVault }, v.name)));
  const fieldPicker = h("select", { class: "input", style: "width:auto", "aria-label": "Field" });
  const targetPicker = h("select", { class: "input", style: "width:auto", "aria-label": "What it is" },
    ...Object.entries(FIELD_TARGETS).map(([value, label]) => h("option", { value }, label)));
  const remove = h("input", { type: "checkbox", checked: true });
  const go = h("button", { class: "btn primary" });
  const preview = h("div");

  const vaultIds = () => (vaultPicker.value ? [vaultPicker.value] : vaults.map((v) => v.id));
  const options = () => ({ field: fieldPicker.value, target: targetPicker.value, remove: remove.checked });
  const plan = () => reconcileFields(state.entries.filter((e) => vaultIds().includes(e.vault)).map((e) => e.item), options());

  const fillFields = () => {
    const names = loginFieldNames(state.entries.filter((e) => vaultIds().includes(e.vault)).map((e) => e.item));
    const before = fieldPicker.value;
    const keep = names.some((n) => n.name === before) ? before : names[0]?.name;
    fieldPicker.replaceChildren(...names.map((n) => h("option", { value: n.name, selected: n.name === keep }, `${n.name} (${n.count})`)));
    if (keep && keep !== before) targetPicker.value = guessTarget(keep);
    return names.length;
  };

  const showPreview = () => {
    const { changes, filled, same, left } = plan();
    const field = fieldPicker.value;
    const what = FIELD_TARGETS[targetPicker.value].toLowerCase();
    preview.replaceChildren(...[
      filled ? h("p", {}, `${plural(filled, "login", "logins")} without a ${what} will take it from ${field}.`) : null,
      same ? h("p", { class: "muted" }, `${plural(same, "login already has", "logins already have")} the same ${what}${remove.checked ? `, so ${same === 1 ? "its" : "their"} ${field} field goes` : ""}.`) : null,
      left ? h("p", { class: "muted" }, left === 1
        ? `1 login is left as it is: it has a different ${what}${["website", "totp"].includes(targetPicker.value) ? `, or its ${field} field doesn't hold one` : ""}.`
        : `${left} logins are left as they are: they have a different ${what}${["website", "totp"].includes(targetPicker.value) ? `, or their ${field} field doesn't hold one` : ""}.`) : null,
    ].filter(Boolean));
    go.textContent = changes.length ? `Update ${plural(changes.length, "login", "logins")}` : "Nothing to update";
    go.disabled = !changes.length;
  };

  const draw = () => {
    const found = fillFields();
    body.replaceChildren(...[
      h("h2", {}, "Tidy up imported fields"),
      h("p", { class: "muted" }, "Some apps export the username as a separate field, like Email, so it comes in as an extra field and the login has no username. Choose the field and what it really is, and Orbit Pass fills it in on every login that's missing it, on this device."),
      h("div", { class: "panel" },
        h("div", { class: "switch" }, h("span", {}, "In"), vaultPicker),
        found ? h("div", { class: "switch" }, h("span", {}, "The field"), fieldPicker) : null,
        found ? h("div", { class: "switch" }, h("span", {}, "Is the login's"), targetPicker) : null,
        found ? h("label", { class: "switch" }, h("span", {}, h("div", {}, "Remove the field once it's moved"), h("div", { class: "faint" }, "And where the login already has the same. A field with something different is kept.")), remove) : null,
        found ? null : h("p", { class: "faint" }, "No logins here have extra fields.")),
      outcome ? h("div", { class: "notice", role: "status" },
        `Updated ${plural(outcome.updated, "login", "logins")}.`,
        outcome.changedElsewhere ? ` ${plural(outcome.changedElsewhere, "was", "were")} changed on another device meanwhile and left as ${outcome.changedElsewhere === 1 ? "it is" : "they are"}; run this again to include ${outcome.changedElsewhere === 1 ? "it" : "them"}.` : "") : null,
      failure ? h("div", { class: "error", role: "alert" }, failure.message || String(failure)) : null,
      found ? preview : null,
      found ? h("div", { class: "toolbar" }, go) : null,
    ].filter(Boolean));
    if (found) showPreview();
  };

  vaultPicker.addEventListener("change", () => { outcome = null; failure = null; draw(); });
  fieldPicker.addEventListener("change", () => { targetPicker.value = guessTarget(fieldPicker.value); showPreview(); });
  targetPicker.addEventListener("change", showPreview);
  remove.addEventListener("change", showPreview);
  go.addEventListener("click", async () => {
    go.disabled = true;
    go.textContent = "Updating…";
    outcome = null;
    failure = null;
    try {
      outcome = await rpc({ type: "reconcile-fields", vaults: vaultIds(), options: options() });
    } catch (e) {
      failure = e;
    }
    await refresh().catch(() => {});
    draw();
  });

  if (!vaults.length) return null;
  draw();
  return h("details", { class: "advanced" }, h("summary", {}, "Advanced"), body);
}

async function devicesPage() {
  let devices = [];
  try { devices = (await rpc({ type: "devices" })).devices; } catch (e) { return detail.replaceChildren(h("div", { class: "error" }, e.message)); }
  detail.replaceChildren(h("div", { class: "wrap" },
    h("div", { class: "detail-top" }, h("h1", {}, "Signed-in devices")),
    h("p", { class: "muted" }, "Signing a device out stops it syncing at once. What it already has stays encrypted on it, so change your Orbit password if one was lost."),
    h("div", { class: "panel" }, ...devices.map((device) => h("div", { class: "member" },
      h("span", { class: "avatar soft" }, icon("devices")),
      h("span", { class: "text" }, h("div", { class: "title" }, `${device.name}${device.current ? " (this one)" : ""}`), h("div", { class: "sub muted" }, device.last_seen_at ? `Last used ${new Date(device.last_seen_at).toLocaleString()}` : "Not used yet")),
      device.current ? null : h("button", { class: "btn danger", onclick: async () => {
        if (!confirm(`Sign ${device.name} out of Orbit Pass?`)) return;
        await rpc({ type: "sign-out-device", keyId: device.key_id });
        devicesPage();
      } }, "Sign out")))),
  ));
}

// -- start ------------------------------------------------------------------------------------

/** The popup's Edit, for what it doesn't edit itself (cards, details, notes,
    and a login's code and extra fields): the item's editor, or the item alone
    in a vault this person can only view. */
function editLinked(id) {
  const entry = state.entries.find((e) => e.id === id);
  showItem(id);
  if (entry && state.vaults.find((v) => v.id === entry.vault)?.canEdit) editItem(entry);
}

async function route() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, "").replace(/^new&?/, "new=1&"));
  if (hash.has("settings")) return select({ page: "settings" });
  if (hash.has("devices")) return select({ page: "devices" });
  if (hash.has("import")) return select({ page: "import" });
  if (hash.has("item")) return showItem(hash.get("item"));
  if (hash.has("edit")) return editLinked(hash.get("edit"));
  if (hash.has("new")) return editItem(null, { totp: hash.get("totp") || "", url: hash.get("url") || "" });
  detail.replaceChildren(emptyDetail());
}

load().then(() => state.status?.locked === false && route()).catch((e) => detail.replaceChildren(h("div", { class: "error" }, e.message)));
chrome.storage.onChanged.addListener((changes, area) => {
  // Locked (keys gone), or unlocked somewhere else (keys appeared): redraw.
  if (area === "session" && "keys" in changes && (!changes.keys.newValue || !changes.keys.oldValue)) load().then(() => state.status?.locked === false && route());
});
