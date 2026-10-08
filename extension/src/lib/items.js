/* What an Orbit Pass item looks like inside its ciphertext (format v1).
   OrbitPassKit's Item.swift reads and writes the same JSON; SECURITY.md
   lists the fields. Unknown fields are kept, so an older client never drops
   what a newer one wrote. */

import { matchStrength } from "./domains.js";
import { parseOtpauth } from "./totp.js";

export const TYPES = ["login", "card", "identity", "note"];

export function now() {
  return new Date().toISOString();
}

export function blankItem(type = "login") {
  const base = { v: 1, type, title: "", favorite: false, notes: "", tags: [], fields: [], createdAt: now(), updatedAt: now() };
  if (type === "login") base.login = { username: "", password: "", urls: [], totp: "", passkeys: [] };
  if (type === "card") base.card = { cardholder: "", number: "", expMonth: "", expYear: "", cvv: "", brand: "" };
  if (type === "identity") {
    base.identity = {
      firstName: "", middleName: "", lastName: "", email: "", phone: "", company: "",
      address1: "", address2: "", city: "", state: "", postalCode: "", country: "",
    };
  }
  return base;
}

/** Fill in anything an older or partial item is missing, keeping the rest. */
export function normalize(item) {
  const blank = blankItem(TYPES.includes(item?.type) ? item.type : "note");
  const out = { ...blank, ...item };
  for (const section of ["login", "card", "identity"]) {
    if (blank[section]) out[section] = { ...blank[section], ...(item?.[section] || {}) };
  }
  if (out.login) {
    out.login.urls = Array.isArray(out.login.urls) ? out.login.urls.filter(Boolean) : [];
    out.login.passkeys = Array.isArray(out.login.passkeys) ? out.login.passkeys : [];
  }
  out.fields = Array.isArray(out.fields) ? out.fields : [];
  out.tags = Array.isArray(out.tags) ? out.tags : [];
  return out;
}

export function cardBrand(number) {
  const digits = String(number || "").replace(/\D/g, "");
  if (/^4/.test(digits)) return "Visa";
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return "Mastercard";
  if (/^3[47]/.test(digits)) return "American Express";
  if (/^6(011|5|4[4-9])/.test(digits)) return "Discover";
  if (/^35(2[89]|[3-8])/.test(digits)) return "JCB";
  if (/^3(0[0-5]|[68])/.test(digits)) return "Diners Club";
  if (/^62/.test(digits)) return "UnionPay";
  return "";
}

export function luhnValid(number) {
  const digits = String(number || "").replace(/\D/g, "");
  if (digits.length < 12) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function hostOf(url) {
  try {
    return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The name to show for an item, with a sensible fallback. */
export function displayTitle(item) {
  if (item.title) return item.title;
  if (item.type === "login") return hostOf(item.login?.urls?.[0] || "") || item.login?.username || "Login";
  if (item.type === "card") return item.card?.brand || cardBrand(item.card?.number) || "Card";
  if (item.type === "identity") return [item.identity?.firstName, item.identity?.lastName].filter(Boolean).join(" ") || "Identity";
  return "Note";
}

/** The second line under the title. */
export function subtitle(item) {
  if (item.type === "login") return item.login?.username || hostOf(item.login?.urls?.[0] || "");
  if (item.type === "card") {
    const digits = String(item.card?.number || "").replace(/\D/g, "");
    const exp = item.card?.expMonth && item.card?.expYear ? ` · ${item.card.expMonth}/${String(item.card.expYear).slice(-2)}` : "";
    return digits ? `•••• ${digits.slice(-4)}${exp}` : exp.slice(3);
  }
  if (item.type === "identity") return item.identity?.email || item.identity?.address1 || "";
  return (item.notes || "").split("\n")[0].slice(0, 80);
}

export function hasTotp(item) {
  return Boolean(item.type === "login" && item.login?.totp && parseOtpauthLoose(item.login.totp));
}

/** A stored TOTP is an otpauth URI or a bare secret. */
export function parseOtpauthLoose(value) {
  if (!value) return null;
  if (/^(apple-)?otpauth:/i.test(value)) return parseOtpauth(value);
  const secret = String(value).replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z2-7]+=*$/.test(secret) ? { secret, issuer: "", account: "", algorithm: "SHA1", digits: 6, period: 30 } : null;
}

/** Logins for a page, best match first. */
export function loginsFor(entries, pageUrl) {
  const out = [];
  for (const entry of entries) {
    if (entry.item.type !== "login") continue;
    let best = 0;
    for (const url of entry.item.login.urls) best = Math.max(best, matchStrength(url, pageUrl));
    if (best > 0) out.push({ entry, strength: best });
  }
  out.sort((a, b) => b.strength - a.strength || Number(b.entry.item.favorite) - Number(a.entry.item.favorite) || displayTitle(a.entry.item).localeCompare(displayTitle(b.entry.item)));
  return out.map((x) => x.entry);
}

export function search(entries, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(({ item }) => {
    const hay = [
      displayTitle(item), subtitle(item), item.notes, ...(item.tags || []),
      ...(item.login?.urls || []), item.login?.username, item.identity?.email, item.card?.cardholder,
    ].filter(Boolean).join(" ").toLowerCase();
    return q.split(/\s+/).every((word) => hay.includes(word));
  });
}

export function sortEntries(entries) {
  return [...entries].sort((a, b) => Number(b.item.favorite) - Number(a.item.favorite) || displayTitle(a.item).localeCompare(displayTitle(b.item)));
}

/** The popup's list: the page's logins (best match first), then everything
    else, each narrowed by the search. Nothing is in both. */
export function siteFirst(entries, pageUrl, query = "") {
  const here = search(loginsFor(entries, pageUrl), query);
  const ids = new Set(here.map((e) => e.id));
  return { here, rest: sortEntries(search(entries, query)).filter((e) => !ids.has(e.id)) };
}

/** Record a password change in the item's history (newest first, ten kept). */
export function withPasswordChange(item, newPassword) {
  const out = normalize(item);
  const old = out.login.password;
  if (old && old !== newPassword) {
    out.passwordHistory = [{ password: old, changedAt: now() }, ...(out.passwordHistory || [])].slice(0, 10);
  }
  out.login.password = newPassword;
  out.updatedAt = now();
  return out;
}
