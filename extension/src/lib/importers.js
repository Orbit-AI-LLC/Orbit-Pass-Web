/* Importing from browsers and other password managers: CSV exports (Chrome,
   Edge, Brave, Safari and Apple Passwords, Firefox, Bitwarden, 1Password,
   LastPass, Dashlane, Proton Pass, NordPass, KeePass, or any CSV with a
   header row) and Bitwarden's unencrypted JSON export.

   OrbitPassKit's Importer.swift reads the same files the same way;
   vectors/import/ (expected.json) pins the two together. Change both. */

import { blankItem } from "./items.js";

export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = "ImportError";
  }
}

// -- CSV ------------------------------------------------------------------------------------

/** Rows of fields. Quotes, doubled quotes and line breaks inside quotes are
    understood; the delimiter is whichever of , ; or tab the first line uses most. */
export function parseCsv(text) {
  const source = String(text).replace(/^﻿/, "");
  const firstLine = source.split(/\r?\n/, 1)[0] || "";
  const delimiter = [",", ";", "\t"].map((d) => [d, countOutsideQuotes(firstLine, d)]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && source[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((value) => value.trim() !== ""));
}

function countOutsideQuotes(line, delimiter) {
  let count = 0;
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (c === delimiter && !quoted) count++;
  }
  return count;
}

/** A header as compared: lower case, words separated by single spaces. */
export function headerKey(header) {
  return String(header).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// What each column means, by its header. Where several columns could hold a
// value, the first one with something in it wins, in this order.
const ROLES = {
  title: ["title", "name", "item name", "entry", "account name"],
  url: ["url", "login uri", "website", "web site", "uri", "login url", "urls", "hostname", "web address"],
  username: ["username", "login username", "user name", "login name", "user", "login", "username1", "username2", "username3", "email", "e mail", "email address"],
  password: ["password", "login password", "pass", "passwd"],
  totp: ["totp", "login totp", "otpauth", "otp", "one time password", "otp secret", "otpsecret", "2fa", "authenticator key", "mfa"],
  notes: ["notes", "note", "extra", "comments", "comment"],
  favorite: ["favorite", "fav", "favorite status", "favourite"],
  folder: ["folder", "grouping", "group", "category", "vault"],
  tags: ["tags"],
  type: ["type", "item type"],
  cardholder: ["cardholder", "cardholder name", "cardholdername", "card holder", "name on card"],
  number: ["card number", "cardnumber"],
  cvv: ["cvv", "cvc", "security code", "card cvv", "verification number"],
  expiry: ["expiry date", "expirydate", "expiration date", "expiration", "expiry"],
};

/** Which app made a CSV, from its header, for "Found 120 logins from …". */
export function csvSource(keys) {
  const has = (...names) => names.every((name) => keys.includes(name));
  if (has("login uri")) return "Bitwarden";
  if (has("grouping", "extra")) return "LastPass";
  if (has("httprealm") || has("formactionorigin")) return "Firefox";
  if (has("archived") || has("archived status")) return "1Password";
  if (has("username2")) return "Dashlane";
  if (has("createtime", "vault")) return "Proton Pass";
  if (has("cardholdername")) return "NordPass";
  if (has("group", "last modified")) return "KeePass";
  if (has("title", "url", "otpauth")) return "Safari or Apple Passwords";
  if (has("name", "url", "username", "password") && keys.length <= 5) return "Chrome, Edge or Brave";
  return "a CSV file";
}

function rowType(value, url) {
  const kind = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (url.trim().toLowerCase() === "http://sn") return "note"; // LastPass secure notes
  if (["", "login", "password", "1", "alias"].includes(kind)) return "login";
  if (["note", "securenote", "2"].includes(kind)) return "note";
  if (["card", "creditcard", "3"].includes(kind)) return "card";
  return "";
}

function truthy(value) {
  return ["1", "true", "yes", "y", "favorite", "favourite", "starred"].includes(String(value || "").trim().toLowerCase());
}

/** A stored verification code: an otpauth link as given, or a setup key
    cleaned up. Anything else is kept in a hidden field rather than lost. */
export function importTotp(value) {
  const text = String(value || "").trim();
  if (!text) return { totp: "" };
  if (/^(apple-)?otpauth:\/\/totp\//i.test(text) && /[?&]secret=/i.test(text)) return { totp: text };
  const secret = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (/^[A-Z2-7]{8,}$/.test(secret)) return { totp: secret };
  return { totp: "", field: { name: "One-time password", value: text, hidden: true } };
}

function splitUrls(value) {
  const out = [];
  for (const part of String(value || "").split(/[\n,]+/)) {
    const url = part.trim();
    if (url && url.toLowerCase() !== "http://sn" && !out.includes(url)) out.push(url);
  }
  return out;
}

/** "MM/YY", "MM/YYYY", "MM-YYYY" or "YYYY-MM" to two-digit month and four-digit year. */
export function splitExpiry(value) {
  const text = String(value || "").trim();
  let match = text.match(/^(\d{1,2})\s*[/\-.]\s*(\d{2}|\d{4})$/);
  if (match) return { month: match[1].padStart(2, "0"), year: match[2].length === 2 ? `20${match[2]}` : match[2] };
  match = text.match(/^(\d{4})\s*[/\-.]\s*(\d{1,2})$/);
  if (match) return { month: match[2].padStart(2, "0"), year: match[1] };
  return { month: "", year: "" };
}

function tagsFrom(folder, tags) {
  const out = [];
  const add = (value) => {
    const tag = String(value || "").trim().replace(/^Root\//, "");
    if (tag && tag !== "Root" && !out.includes(tag)) out.push(tag);
  };
  add(folder);
  for (const tag of String(tags || "").split(/[,;]/)) add(tag);
  return out;
}

function importCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new ImportError("That file has no rows to import.");
  const keys = rows[0].map(headerKey);
  const columns = {};
  for (const [role, names] of Object.entries(ROLES)) {
    columns[role] = names.flatMap((name) => keys.flatMap((key, index) => (key === name ? [index] : [])));
  }
  if (!columns.password.length && !columns.url.length && !columns.username.length && !columns.number.length) {
    throw new ImportError("Orbit Pass can't find the columns in that file. It reads exports with a header row naming the columns, like url, username and password.");
  }
  const items = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const get = (role) => {
      for (const index of columns[role]) {
        const value = (row[index] || "").trim();
        if (value) return value;
      }
      return "";
    };
    const type = rowType(get("type"), get("url"));
    const notes = get("notes");
    const tags = tagsFrom(get("folder"), get("tags"));
    let item;
    if (type === "login") {
      item = blankItem("login");
      item.login.username = get("username");
      item.login.password = get("password");
      item.login.urls = splitUrls(get("url"));
      const code = importTotp(get("totp"));
      item.login.totp = code.totp;
      if (code.field) item.fields.push(code.field);
      const empty = !item.login.username && !item.login.password && !item.login.urls.length && !item.login.totp && !code.field;
      if (empty) {
        if (!notes) { skipped++; continue; }
        item = blankItem("note");
      }
    } else if (type === "note") {
      item = blankItem("note");
      if (!notes && !get("title")) { skipped++; continue; }
    } else if (type === "card") {
      item = blankItem("card");
      item.card.cardholder = get("cardholder");
      item.card.number = get("number").replace(/\s+/g, "");
      item.card.cvv = get("cvv");
      const expiry = splitExpiry(get("expiry"));
      item.card.expMonth = expiry.month;
      item.card.expYear = expiry.year;
      if (!item.card.number) { skipped++; continue; }
    } else {
      skipped++;
      continue;
    }
    item.title = get("title");
    item.notes = notes;
    item.favorite = truthy(get("favorite"));
    item.tags = tags;
    items.push(item);
  }
  return { source: csvSource(keys), items, skipped };
}

// -- Bitwarden JSON -------------------------------------------------------------------------

function importBitwarden(data) {
  if (data.encrypted) {
    throw new ImportError("That Bitwarden export is encrypted. Export your vault again as .json, not the encrypted kind, then import that.");
  }
  const folders = Object.fromEntries((data.folders || []).map((folder) => [folder.id, folder.name || ""]));
  const items = [];
  let skipped = 0;
  for (const raw of data.items || []) {
    const text = (value) => (value == null ? "" : String(value));
    let item;
    if (raw.type === 1) {
      item = blankItem("login");
      const login = raw.login || {};
      item.login.username = text(login.username);
      item.login.password = text(login.password);
      item.login.urls = splitUrls((login.uris || []).map((uri) => text(uri?.uri)).join("\n"));
      const code = importTotp(login.totp);
      item.login.totp = code.totp;
      if (code.field) item.fields.push(code.field);
    } else if (raw.type === 2) {
      item = blankItem("note");
    } else if (raw.type === 3) {
      item = blankItem("card");
      const card = raw.card || {};
      item.card.cardholder = text(card.cardholderName);
      item.card.number = text(card.number).replace(/\s+/g, "");
      item.card.expMonth = card.expMonth ? text(card.expMonth).padStart(2, "0") : "";
      item.card.expYear = card.expYear ? (text(card.expYear).length === 2 ? `20${card.expYear}` : text(card.expYear)) : "";
      item.card.cvv = text(card.code);
      item.card.brand = text(card.brand);
    } else if (raw.type === 4) {
      item = blankItem("identity");
      const id = raw.identity || {};
      for (const key of ["firstName", "middleName", "lastName", "email", "phone", "company", "address1", "city", "state", "postalCode", "country"]) {
        item.identity[key] = text(id[key]);
      }
      item.identity.address2 = [id.address2, id.address3].map(text).filter(Boolean).join(", ");
    } else {
      skipped++;
      continue;
    }
    item.title = text(raw.name);
    item.notes = text(raw.notes);
    item.favorite = Boolean(raw.favorite);
    item.tags = tagsFrom(folders[raw.folderId], "");
    for (const field of raw.fields || []) {
      if (!field?.name && field?.value == null) continue;
      item.fields.push({ name: text(field.name), value: text(field.value), hidden: field.type === 1 });
    }
    items.push(item);
  }
  return { source: "Bitwarden", items, skipped };
}

// -- one entry point ------------------------------------------------------------------------

/** What's in an exported file: {source, items, skipped}. Throws ImportError
    with words for people when it can't be read. */
export function parseImport(text, filename = "") {
  const body = String(text || "").replace(/^﻿/, "").trim();
  if (!body) throw new ImportError("That file is empty.");
  if (/\.1pux$/i.test(filename)) throw new ImportError("Orbit Pass reads 1Password's CSV export. In 1Password choose File → Export, then CSV.");
  if (body.startsWith("{") || /\.json$/i.test(filename)) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new ImportError("That JSON file can't be read.");
    }
    if (Array.isArray(data?.items)) return importBitwarden(data);
    throw new ImportError("Orbit Pass reads Bitwarden's JSON export, and CSV files from browsers and other password managers.");
  }
  return importCsv(body);
}

function host(url) {
  return String(url || "").trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0];
}

/** Two items are the same import when this matches: a login by its first
    site, username and password; a card by its number; a note by title and text. */
export function duplicateKey(item) {
  switch (item.type) {
    case "login": return ["login", host(item.login?.urls?.[0]), String(item.login?.username || "").toLowerCase(), item.login?.password || ""].join("\u0000");
    case "card": return ["card", String(item.card?.number || "").replace(/\D/g, "")].join("\u0000");
    case "identity": return ["identity", item.identity?.firstName || "", item.identity?.lastName || "", String(item.identity?.email || "").toLowerCase()].join("\u0000");
    default: return ["note", item.title || "", item.notes || ""].join("\u0000");
  }
}

// -- tidying up after an import -------------------------------------------------------------
// Some apps export the username as a custom field ("Email", say), so the
// login comes in with that field and no username. The vault page's Import,
// Advanced, moves such a field where it belongs across a vault. Apple's apps
// don't offer this.

/** What a login's custom field can turn out to be. */
export const FIELD_TARGETS = { username: "Username", password: "Password", website: "Website", totp: "Verification code" };

// A field name as compared: its letters (of any script) and digits, lower
// case, so "E-mail" is "Email" and "User name" is "Username".
function fieldKey(name) {
  return String(name || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** The custom fields on logins, to choose one to move: [{name, count}], the
    most used first. Spellings that compare the same (Email, e-mail) are one. */
export function loginFieldNames(items) {
  const found = new Map();
  for (const item of items) {
    if (item?.type !== "login") continue;
    const seen = new Set();
    for (const field of item.fields || []) {
      const key = fieldKey(field?.name);
      if (!key || !String(field.value ?? "").trim() || seen.has(key)) continue;
      seen.add(key);
      const entry = found.get(key) || { name: String(field.name).trim(), count: 0 };
      entry.count++;
      found.set(key, entry);
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** What a field named this most likely is, by the names CSV columns go by. */
export function guessTarget(name) {
  const key = headerKey(name);
  if (ROLES.password.includes(key)) return "password";
  if (ROLES.url.includes(key)) return "website";
  if (ROLES.totp.includes(key)) return "totp";
  return "username";
}

// Put a field's value in a login: "filled" where the login had none, "same"
// where it already has this one, "left" where it has another (or the value
// isn't a website or code at all).
function place(login, target, raw) {
  const value = raw.trim();
  switch (target) {
    case "username":
      if (!login.username.trim()) { login.username = value; return "filled"; }
      return login.username.trim().toLowerCase() === value.toLowerCase() ? "same" : "left";
    case "password":
      if (!login.password) { login.password = raw; return "filled"; }
      return login.password === raw || login.password === value ? "same" : "left";
    case "website": {
      const urls = splitUrls(value);
      if (!urls.length) return "left";
      if (!login.urls.length) { login.urls = urls; return "filled"; }
      return urls.every((url) => login.urls.some((have) => host(have) === host(url))) ? "same" : "left";
    }
    case "totp": {
      const code = importTotp(value).totp;
      if (!code) return "left";
      if (!login.totp) { login.totp = code; return "filled"; }
      return importTotp(login.totp).totp === code ? "same" : "left";
    }
    default:
      return "left";
  }
}

/** Move the custom field named `field` into each login's `target` (a key of
    FIELD_TARGETS) where the login has none. Where it already has the same,
    the field only repeats it; where it has another, nothing changes. With
    `remove`, a field that was moved or repeats goes.
    Returns {changes: [{index, item}], filled, same, left}, counting logins
    by what happened to them; `items` themselves aren't changed. */
export function reconcileFields(items, { field, target, remove = true } = {}) {
  const key = fieldKey(field);
  const out = { changes: [], filled: 0, same: 0, left: 0 };
  if (!key || !FIELD_TARGETS[target]) return out;
  items.forEach((original, index) => {
    if (original?.type !== "login" || !original.login) return;
    const matches = (f) => fieldKey(f?.name) === key && String(f.value ?? "").trim();
    if (!(original.fields || []).some(matches)) return;
    const item = structuredClone(original);
    item.login.urls = item.login.urls || [];
    const outcomes = new Set();
    item.fields = item.fields.filter((f) => {
      if (!matches(f)) return true;
      const outcome = place(item.login, target, String(f.value));
      outcomes.add(outcome);
      return outcome === "left" || !remove;
    });
    if (outcomes.has("filled")) out.filled++;
    else if (outcomes.has("same")) out.same++;
    else out.left++;
    if (outcomes.has("filled") || item.fields.length !== original.fields.length) out.changes.push({ index, item });
  });
  return out;
}

/** A count for people: "120 logins, 3 secure notes and 1 card". */
export function describeItems(items) {
  const names = { login: ["login", "logins"], note: ["secure note", "secure notes"], card: ["card", "cards"], identity: ["identity", "identities"] };
  const parts = [];
  for (const type of ["login", "note", "card", "identity"]) {
    const n = items.filter((item) => item.type === type).length;
    if (n) parts.push(`${n} ${names[type][n === 1 ? 0 : 1]}`);
  }
  if (!parts.length) return "nothing";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
