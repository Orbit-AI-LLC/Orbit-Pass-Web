/* Orbit Pass in the page.

   1. When the page loads, quick rules (no model) place the obvious fields:
      password boxes, autocomplete attributes, the username box before a
      password. Then the on-device field model looks once at every field and
      stops: it places the ones the rules could not (verification codes,
      cards, addresses), and overrules a rule when it is sure the rule is
      wrong (an email-only sign-in box marked autocomplete="email", such as
      claude.ai's, is a login, not personal details). A field that appears
      later is placed the first time it is clicked.
   2. Nothing is offered until a person actually clicks a field Orbit Pass
      placed. Then a menu opens under it with what fits: logins for this site
      (username and password are filled together), the verification code,
      cards, or saved personal details.
   3. After a sign-in form is submitted, a bar offers to save the login.

   Everything secret stays in the service worker until a person picks an item;
   the worker checks the frame's own address before handing a login over. */

(() => {
  "use strict";

  if (window.__orbitPassLoaded) return;
  window.__orbitPassLoaded = true;

  const TEXTISH = new Set(["text", "email", "tel", "number", "password", "search", "url", ""]);
  const LOGIN_KINDS = new Set(["username", "password", "new-password"]);
  const CARD_KINDS = new Set(["cc-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc"]);
  const IDENTITY_KINDS = new Set(["name", "given-name", "family-name", "email", "tel", "address-line1", "address-line2", "city", "state", "postal-code", "country", "organization"]);
  const AUTOCOMPLETE = {
    "username": "username", "current-password": "password", "new-password": "new-password", "one-time-code": "otp",
    "cc-name": "cc-name", "cc-given-name": "cc-name", "cc-number": "cc-number", "cc-exp": "cc-exp", "cc-exp-month": "cc-exp-month",
    "cc-exp-year": "cc-exp-year", "cc-csc": "cc-csc", "name": "name", "given-name": "given-name", "family-name": "family-name",
    "tel": "tel", "tel-national": "tel", "address-line1": "address-line1", "street-address": "address-line1",
    "address-line2": "address-line2", "address-level2": "city", "address-level1": "state", "postal-code": "postal-code",
    "country": "country", "country-name": "country", "organization": "organization",
  };
  // How sure the model must be to place a field the rules left alone, and to
  // overrule a rule's answer. The second is far stricter: a rule is usually
  // right, so only a confident disagreement replaces it (see the field
  // model's REPORT.md for how often a confident answer is wrong).
  const MODEL_THRESHOLD = 0.55;
  const OVERRIDE_THRESHOLD = 0.9;

  const kinds = new WeakMap(); // element -> kind ("none" when nothing fits)
  let settings = { inlineMenu: true, smartDetection: true, offerToSave: true };
  let state = { signedIn: false, locked: true };

  // -- messaging ----------------------------------------------------------------------

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) resolve({ error: "unavailable" });
          else resolve(response || {});
        });
      } catch {
        resolve({ error: "unavailable" }); // the extension was reloaded under this page
      }
    });
  }

  // -- reading fields ---------------------------------------------------------------------

  function deepTarget(event) {
    const path = event.composedPath ? event.composedPath() : [];
    return path[0] instanceof Element ? path[0] : event.target;
  }

  function isField(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.tagName === "SELECT") return true;
    return el.tagName === "INPUT" && TEXTISH.has((el.getAttribute("type") || "").toLowerCase()) && !el.readOnly && !el.disabled;
  }

  function visible(el) {
    if (!el.isConnected || el.offsetWidth < 2 || el.offsetHeight < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  }

  function textOf(node, limit = 200) {
    return node ? (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, limit) : "";
  }

  function labelFor(el) {
    const parts = [];
    if (el.labels) for (const label of el.labels) parts.push(textOf(label));
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) for (const id of labelledBy.split(/\s+/)) parts.push(textOf(el.getRootNode().getElementById?.(id) || document.getElementById(id)));
    if (!parts.join("").trim()) {
      const previous = el.previousElementSibling;
      if (previous && !isField(previous) && textOf(previous).length < 60) parts.push(textOf(previous));
    }
    return parts.filter(Boolean).join(" ").slice(0, 160);
  }

  function scopeOf(el) {
    if (el.form) return el.form;
    let node = el.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      if (node.tagName === "FORM") return node;
      if (node.querySelectorAll("input, select").length >= 2 && depth >= 1) return node;
    }
    return el.getRootNode() instanceof ShadowRoot ? el.getRootNode() : document.body || document.documentElement;
  }

  function fieldsIn(scope) {
    return Array.from(scope.querySelectorAll("input, select")).filter((f) => isField(f) && visible(f));
  }

  function contextFor(el, label) {
    const scope = scopeOf(el);
    let heading = "";
    const headings = (scope.querySelectorAll ? scope : document).querySelectorAll("h1, h2, h3, h4, legend, [role=heading]");
    for (const h of headings) {
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) heading = textOf(h, 120);
    }
    if (!heading) {
      const pageHeadings = document.querySelectorAll("h1, h2, h3, legend, [role=heading]");
      for (const h of pageHeadings) if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) heading = textOf(h, 120);
    }
    let near = "";
    let node = el.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const text = textOf(node, 400);
      if (text.length > label.length + 15) { near = text; break; }
    }
    return `${heading} ${near}`.replace(/\s+/g, " ").trim().slice(0, 300);
  }

  function formString(scope) {
    if (!(scope instanceof HTMLFormElement)) return "";
    let action = scope.getAttribute("action") || "";
    try { action = new URL(action, location.href).pathname; } catch { /* keep as is */ }
    return [action, scope.id, scope.getAttribute("name")].filter(Boolean).join(" ");
  }

  function describe(el) {
    const scope = scopeOf(el);
    const fields = fieldsIn(scope);
    const label = labelFor(el);
    const group = el.parentElement?.parentElement || el.parentElement;
    const singles = group ? Array.from(group.querySelectorAll("input")).filter((f) => f !== el && f.maxLength === 1 && visible(f)).length : 0;
    return {
      tag: el.tagName.toLowerCase(),
      type: el.tagName === "INPUT" ? (el.getAttribute("type") || "text").toLowerCase() : "",
      name: el.getAttribute("name") || "",
      id: el.id || "",
      autocomplete: el.getAttribute("autocomplete") || "",
      placeholder: el.getAttribute("placeholder") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      label,
      title: el.getAttribute("title") || "",
      maxLength: el.maxLength > 0 ? el.maxLength : -1,
      inputMode: el.getAttribute("inputmode") || "",
      pattern: el.getAttribute("pattern") || "",
      context: contextFor(el, label),
      form: formString(scope),
      passwordsInForm: fields.filter((f) => f.type === "password").length,
      fieldsInForm: fields.length,
      index: Math.max(0, fields.indexOf(el)),
      singleCharSiblings: el.maxLength === 1 ? singles : 0,
    };
  }

  /** The quick rules: certain answers only, else null (ask the model). */
  function quickKind(el) {
    const tokens = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/).filter(Boolean);
    const scope = scopeOf(el);
    const fields = fieldsIn(scope);
    const passwords = fields.filter((f) => f.type === "password");
    for (const token of tokens.slice().reverse()) {
      if (token === "email") return passwords.length ? "username" : "email";
      if (AUTOCOMPLETE[token]) return AUTOCOMPLETE[token];
    }
    if (el.type === "password") {
      const hint = `${el.name} ${el.id} ${labelFor(el)} ${el.placeholder}`.toLowerCase();
      if (/new|confirm|repeat|retype|again|verify|create|choose|register|signup|sign-up|password2|pass2|re-?enter|nouveau|neues|nueva|nuova|nova|bestätig|confirma/.test(hint)) return "new-password";
      if (passwords.length >= 2 && passwords.indexOf(el) > 0) return "new-password";
      return "password";
    }
    if (passwords.length && el.tagName === "INPUT" && ["text", "email", "tel", ""].includes((el.getAttribute("type") || "").toLowerCase())) {
      // The text box just before the first password box is the username.
      const firstPassword = fields.indexOf(passwords[0]);
      const before = fields.slice(0, firstPassword).filter((f) => f.tagName === "INPUT" && f.type !== "password");
      if (before.length && before[before.length - 1] === el) return "username";
    }
    return null;
  }

  /** The rule's answer, unless the model is sure of another; the model's alone where no rule applies. */
  function decide(rule, result) {
    if (!result) return rule || "none";
    if (!rule) return result.p >= MODEL_THRESHOLD ? result.kind : "none";
    return result.kind !== rule && result.p >= OVERRIDE_THRESHOLD ? result.kind : rule;
  }

  async function classify(elements) {
    const pending = elements.filter((el) => !kinds.has(el));
    if (!pending.length) return;
    const rules = pending.map(quickKind);
    if (!settings.smartDetection) {
      pending.forEach((el, i) => kinds.set(el, rules[i] || "none"));
      return;
    }
    const response = await send({ type: "classify", fields: pending.map(describe) });
    pending.forEach((el, i) => kinds.set(el, decide(rules[i], response.results?.[i])));
  }

  async function kindOf(el) {
    if (!kinds.has(el)) await classify([el]);
    return kinds.get(el) || "none";
  }

  // -- filling -----------------------------------------------------------------------------

  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;

  function setValue(el, value) {
    if (value == null || value === "") return false;
    if (el.tagName === "SELECT") return selectOption(el, value);
    el.focus({ preventScroll: true });
    valueSetter.call(el, String(value));
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return true;
  }

  function selectOption(el, value) {
    const wanted = String(value).trim().toLowerCase();
    const variants = new Set([wanted, wanted.replace(/^0+/, ""), wanted.padStart(2, "0"), wanted.slice(-2)]);
    const option = Array.from(el.options).find((o) => variants.has(o.value.trim().toLowerCase()) || variants.has(o.text.trim().toLowerCase()))
      || Array.from(el.options).find((o) => o.text.trim().toLowerCase().startsWith(wanted) && wanted.length > 2);
    if (!option) return false;
    el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  async function fieldsByKind(scope) {
    const fields = fieldsIn(scope);
    await classify(fields);
    return fields.map((el) => ({ el, kind: kinds.get(el) }));
  }

  async function fillLogin(field, data) {
    const placed = await fieldsByKind(scopeOf(field));
    const usernames = placed.filter((p) => p.kind === "username").map((p) => p.el);
    const passwords = placed.filter((p) => p.kind === "password" || (p.kind === "new-password" && kinds.get(field) !== "new-password")).map((p) => p.el);
    if (!usernames.length && kinds.get(field) === "username") usernames.push(field);
    if (!passwords.length && kinds.get(field) === "password") passwords.push(field);
    if (usernames[0]) setValue(usernames[0], data.username);
    if (passwords[0]) setValue(passwords[0], data.password);
    (passwords[0] || usernames[0] || field).focus({ preventScroll: true });
  }

  function otpBoxes(field) {
    if (field.maxLength !== 1) return [field];
    const group = field.parentElement?.parentElement || field.parentElement;
    const boxes = Array.from(group.querySelectorAll("input")).filter((f) => f.maxLength === 1 && visible(f));
    return boxes.length >= 4 ? boxes : [field];
  }

  function fillOtp(field, code) {
    const boxes = otpBoxes(field);
    if (boxes.length === 1) return setValue(field, code);
    Array.from(code).forEach((digit, i) => boxes[i] && setValue(boxes[i], digit));
    boxes[Math.min(code.length, boxes.length) - 1]?.focus({ preventScroll: true });
    return true;
  }

  function expiryText(el, month, year) {
    const hint = `${el.placeholder} ${labelFor(el)}`.toUpperCase();
    const mm = String(month).padStart(2, "0");
    const yyyy = String(year).length === 2 ? `20${year}` : String(year);
    if (/YYYY|AAAA|JJJJ/.test(hint) || el.maxLength >= 7 && el.maxLength < 9 && !/ \/ /.test(hint)) return `${mm}/${yyyy}`;
    if (/ \/ /.test(el.placeholder || "")) return `${mm} / ${yyyy.slice(-2)}`;
    return `${mm}/${yyyy.slice(-2)}`;
  }

  async function fillCard(card) {
    const placed = await fieldsByKind(document);
    let filled = 0;
    for (const { el, kind } of placed) {
      if (!CARD_KINDS.has(kind)) continue;
      const value = {
        "cc-name": card.cardholder,
        "cc-number": card.number,
        "cc-exp": card.expMonth && card.expYear ? expiryText(el, card.expMonth, card.expYear) : "",
        "cc-exp-month": card.expMonth,
        "cc-exp-year": el.tagName === "SELECT" || el.maxLength === 4 ? card.expYear : String(card.expYear).slice(-2),
        "cc-csc": card.cvv,
      }[kind];
      if (setValue(el, value)) filled++;
    }
    return filled;
  }

  async function fillIdentity(field, identity) {
    const placed = await fieldsByKind(scopeOf(field));
    const full = [identity.firstName, identity.middleName, identity.lastName].filter(Boolean).join(" ");
    for (const { el, kind } of placed) {
      const value = {
        "name": full, "given-name": identity.firstName, "family-name": identity.lastName, "email": identity.email,
        "tel": identity.phone, "address-line1": identity.address1, "address-line2": identity.address2, "city": identity.city,
        "state": identity.state, "postal-code": identity.postalCode, "country": identity.country, "organization": identity.company,
      }[kind];
      if (IDENTITY_KINDS.has(kind)) setValue(el, value);
    }
  }

  async function fillNewPassword(field, password) {
    const placed = await fieldsByKind(scopeOf(field));
    const targets = placed.filter((p) => p.kind === "new-password").map((p) => p.el);
    for (const el of targets.length ? targets : [field]) setValue(el, password);
    lastGenerated = { password, at: Date.now() };
  }

  let lastGenerated = null;

  // -- the menu ----------------------------------------------------------------------------

  const MENU_CSS = `
    :host { all: initial; }
    .menu { position: fixed; z-index: 2147483647; min-width: 260px; max-width: 340px; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #111; background: #fff; border: 1px solid #e4e4e4; border-radius: 12px; box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 12px 32px -12px rgba(0,0,0,.3); overflow: hidden; }
    .head { display: flex; align-items: center; gap: 6px; padding: 8px 12px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: #6b6b6b; border-bottom: 1px solid #efefef; }
    .head svg { width: 14px; height: 14px; }
    .row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 12px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    .row:hover, .row.on { background: #f2f2f2; }
    .badge { flex: none; width: 28px; height: 28px; border-radius: 8px; background: #111; color: #fff; display: grid; place-items: center; font-weight: 650; font-size: 12px; }
    .badge.site { box-sizing: border-box; background: #fff; border: 1px solid #e4e4e4; color-scheme: light; }
    .badge.site img { display: block; width: 18px; height: 18px; object-fit: contain; }
    .text { min-width: 0; flex: 1; }
    .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { color: #6b6b6b; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .code { font: 600 15px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; }
    .note { padding: 10px 12px; color: #4d4d4d; }
    .toast { position: fixed; z-index: 2147483647; padding: 8px 12px; border-radius: 10px; background: #111; color: #fff; font: 600 12px/1.3 -apple-system, BlinkMacSystemFont, sans-serif; box-shadow: 0 8px 24px -8px rgba(0,0,0,.4); }
    .bar { position: fixed; top: 12px; right: 12px; z-index: 2147483647; width: 320px; padding: 14px; border-radius: 14px; background: #fff; color: #111; border: 1px solid #e4e4e4;
      box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 16px 40px -12px rgba(0,0,0,.35); font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .bar h2 { margin: 0 0 4px; font-size: 14px; }
    .bar p { margin: 0 0 12px; color: #4d4d4d; overflow-wrap: anywhere; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .btn { padding: 7px 12px; border-radius: 8px; border: 1px solid #cfcfcf; background: #fff; color: #111; font: 600 12px/1 inherit; cursor: pointer; }
    .btn.primary { background: #111; border-color: #111; color: #fff; }
    .btn.quiet { border-color: transparent; color: #4d4d4d; }
    @media (prefers-color-scheme: dark) {
      .menu, .bar { background: #141414; color: #f5f5f5; border-color: #262626; }
      .head { border-color: #1f1f1f; color: #8a8a8a; }
      .row:hover, .row.on { background: #1f1f1f; }
      .badge, .toast, .btn.primary { background: #fff; color: #0a0a0a; border-color: #fff; }
      .sub, .note, .bar p, .btn.quiet { color: #a8a8a8; }
      .btn { background: #141414; color: #f5f5f5; border-color: #3a3a3a; }
    }`;
  const MARK = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7.2" fill="currentColor"/><circle cx="16" cy="14" r="3" fill="#fff"/><path d="M14.8 15.5h2.4l.8 6h-4z" fill="#fff"/></svg>';

  let host = null;
  let root = null;
  let menu = null;
  let menuField = null;
  let rows = [];
  let selected = -1;
  const choices = new WeakMap(); // row -> what picking it does

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement("orbit-pass-ui");
    root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = MENU_CSS;
    root.appendChild(style);
    document.documentElement.appendChild(host);
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function closeMenu() {
    menu?.remove();
    menu = null;
    menuField = null;
    rows = [];
    selected = -1;
  }

  function position(node, field) {
    const rect = field.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    node.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 348))}px`;
    if (below < 220 && rect.top > below) {
      node.style.top = "";
      node.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    } else {
      node.style.bottom = "";
      node.style.top = `${rect.bottom + 6}px`;
    }
  }

  function openMenu(field, heading, entries) {
    ensureHost();
    closeMenu();
    menu = el("div", "menu");
    menu.setAttribute("role", "listbox");
    const head = el("div", "head");
    head.innerHTML = MARK;
    head.appendChild(document.createTextNode(heading));
    menu.appendChild(head);
    rows = [];
    for (const entry of entries) {
      if (entry.note) {
        const note = el("div", "note", entry.note);
        menu.appendChild(note);
        if (entry.action) {
          const row = el("button", "row");
          row.appendChild(el("span", "text")).appendChild(el("div", "title", entry.action.label));
          row.addEventListener("click", entry.action.run);
          choices.set(row, entry.action.run);
          menu.appendChild(row);
          rows.push(row);
        }
        continue;
      }
      const row = el("button", "row");
      row.type = "button";
      row.setAttribute("role", "option");
      const badge = row.appendChild(el("span", "badge", entry.badge || (entry.title || "?").slice(0, 1).toUpperCase()));
      if (entry.icon) siteIcon(badge, entry.icon);
      const text = el("span", "text");
      text.appendChild(el("div", entry.code ? "title code" : "title", entry.title));
      if (entry.subtitle) text.appendChild(el("div", "sub", entry.subtitle));
      row.appendChild(text);
      row.addEventListener("click", (event) => {
        if (!event.isTrusted) return;
        entry.run();
      });
      choices.set(row, entry.run);
      menu.appendChild(row);
      rows.push(row);
    }
    // Keep the field focused while a row is clicked.
    menu.addEventListener("mousedown", (event) => event.preventDefault());
    root.appendChild(menu);
    menuField = field;
    position(menu, field);
  }

  // The site's icon in place of the letter, once it has loaded: a page whose
  // own image policy won't show it keeps the letter.
  function siteIcon(badge, url) {
    if (!/^data:image\//.test(url)) return;
    const img = document.createElement("img");
    img.alt = "";
    img.addEventListener("load", () => { badge.classList.add("site"); badge.replaceChildren(img); }, { once: true });
    img.src = url;
  }

  function toast(field, message) {
    ensureHost();
    const node = el("div", "toast", message);
    root.appendChild(node);
    position(node, field);
    setTimeout(() => node.remove(), 2600);
  }

  function host_() {
    return location.hostname.replace(/^www\./, "");
  }

  async function showMenuFor(field) {
    if (!settings.inlineMenu) return;
    const kind = await kindOf(field);
    if (kind === "none") return;
    const status = await send({ type: "page-state" });
    if (status.error) return;
    state = status;
    settings = status.settings || settings;
    if (!status.signedIn) return;
    if (status.locked) {
      openMenu(field, "Orbit Pass", [{ note: "Orbit Pass is locked.", action: { label: "Unlock Orbit Pass", run: () => { send({ type: "open-popup" }); closeMenu(); } } }]);
      return;
    }

    if (LOGIN_KINDS.has(kind)) {
      const { items = [] } = await send({ type: "suggest", kind: "login" });
      const entries = [];
      if (kind === "new-password") {
        entries.push({ badge: "★", title: "Use a strong password", subtitle: "Orbit Pass makes one and fills it in", run: async () => {
          const { password } = await send({ type: "generate" });
          if (password) await fillNewPassword(field, password);
          closeMenu();
          toast(field, "Strong password filled. Orbit Pass will offer to save it.");
        } });
      }
      for (const item of items) {
        entries.push({ title: item.title, subtitle: item.subtitle, icon: item.icon, run: async () => {
          closeMenu();
          const data = await send({ type: "fill", itemId: item.id, kind: "login" });
          if (data.error) return toast(field, data.message || "Orbit Pass couldn't fill that.");
          await fillLogin(field, data);
          if (data.copiedCode) toast(field, "Filled. Verification code copied.");
        } });
      }
      if (!entries.length) entries.push({ note: `No saved logins for ${host_()}.`, action: { label: "Open Orbit Pass", run: () => { send({ type: "open-popup" }); closeMenu(); } } });
      openMenu(field, "Orbit Pass", entries);
      return;
    }

    if (kind === "otp") {
      const { items = [] } = await send({ type: "suggest", kind: "otp" });
      const entries = items.map((item) => ({
        title: item.code.replace(/^(\d{3})(\d{3})$/, "$1 $2"), subtitle: `${item.title} · ${item.remaining}s left`, code: true, badge: "#",
        run: async () => {
          closeMenu();
          const data = await send({ type: "fill", itemId: item.id, kind: "otp" });
          if (data.code) fillOtp(field, data.code);
        },
      }));
      if (!entries.length) entries.push({ note: `No verification codes saved for ${host_()}.` });
      openMenu(field, "Verification code", entries);
      return;
    }

    if (CARD_KINDS.has(kind)) {
      const { items = [] } = await send({ type: "suggest", kind: "card" });
      const entries = items.map((item) => ({ title: item.title, subtitle: item.subtitle, badge: "▭", run: async () => {
        closeMenu();
        // The worker sends the card to every frame of this tab, so a payment
        // form split across frames fills in one go.
        const data = await send({ type: "fill", itemId: item.id, kind: "card" });
        if (data.error) toast(field, data.message || "Orbit Pass couldn't fill that.");
      } }));
      if (!entries.length) entries.push({ note: "No cards saved yet." });
      openMenu(field, "Cards", entries);
      return;
    }

    if (IDENTITY_KINDS.has(kind)) {
      const { items = [] } = await send({ type: "suggest", kind: "identity" });
      if (!items.length) return; // no identities saved: stay out of the way
      openMenu(field, "Personal details", items.map((item) => ({ title: item.title, subtitle: item.subtitle, run: async () => {
        closeMenu();
        const data = await send({ type: "fill", itemId: item.id, kind: "identity" });
        if (data.identity) await fillIdentity(field, data.identity);
      } })));
    }
  }

  // -- events --------------------------------------------------------------------------------

  document.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    const target = deepTarget(event);
    if (menu && host && event.composedPath().includes(host)) return;
    if (isField(target) && visible(target)) {
      if (menuField === target && menu) return;
      showMenuFor(target);
    } else {
      closeMenu();
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (!menu || !rows.length) {
      if (event.key === "ArrowDown" && event.altKey && isField(deepTarget(event))) showMenuFor(deepTarget(event));
      return;
    }
    if (event.key === "Escape") { closeMenu(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      rows[selected]?.classList.remove("on");
      selected = (selected + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
      rows[selected].classList.add("on");
    } else if (event.key === "Enter" && selected >= 0) {
      event.preventDefault();
      // rows[selected].click() would be an untrusted click, which the rows
      // ignore; a person's own Enter picks the row directly.
      if (event.isTrusted) choices.get(rows[selected])();
    }
  }, true);

  window.addEventListener("scroll", () => menu && menuField && position(menu, menuField), true);
  window.addEventListener("resize", closeMenu);

  // -- the frame-wide fill messages (cards across frames) --------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type === "fill-card" && message.card) {
      fillCard(message.card).then((filled) => reply({ filled }));
      return true;
    }
    if (message?.type === "fill-focused" && message.data) {
      // From the popup: fill the login into this frame's sign-in form.
      const field = document.activeElement && isField(document.activeElement) ? document.activeElement : fieldsIn(document).find((f) => f.type === "password") || fieldsIn(document)[0];
      if (field) fillLogin(field, message.data).then(() => reply({ ok: true }));
      else reply({ ok: false });
      return true;
    }
    return false;
  });

  // -- offering to save ----------------------------------------------------------------------

  async function captureLogin(scope) {
    if (!settings.offerToSave) return;
    const placed = await fieldsByKind(scope);
    const password = placed.find((p) => (p.kind === "password" || p.kind === "new-password") && p.el.value);
    if (!password) {
      // A username step on its own (identifier first): remember it for the next page.
      const username = placed.find((p) => p.kind === "username" && p.el.value);
      if (username) send({ type: "username-seen", username: username.el.value });
      return;
    }
    const username = placed.find((p) => p.kind === "username" && p.el.value);
    send({ type: "submitted", username: username ? username.el.value : "", password: password.el.value, generated: lastGenerated?.password === password.el.value });
  }

  document.addEventListener("submit", (event) => {
    if (event.isTrusted) captureLogin(event.target);
  }, true);
  document.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    const button = deepTarget(event).closest?.("button, input[type=submit], [role=button]");
    if (!button) return;
    const scope = scopeOf(button);
    if (scope.querySelector?.("input[type=password]")) captureLogin(scope);
  }, true);

  function showSaveBar(pending) {
    ensureHost();
    root.querySelector(".bar")?.remove();
    const bar = el("div", "bar");
    bar.appendChild(el("h2", null, pending.update ? "Update the saved password?" : "Save this login to Orbit Pass?"));
    bar.appendChild(el("p", null, `${pending.username || "No username"} on ${pending.host}`));
    const actions = el("div", "actions");
    const act = (label, cls, action) => {
      const button = el("button", `btn ${cls}`, label);
      button.addEventListener("click", async (event) => {
        if (!event.isTrusted) return;
        bar.remove();
        await send({ type: "save-decision", action });
      });
      actions.appendChild(button);
    };
    act(pending.update ? "Update" : "Save", "primary", pending.update ? "update" : "save");
    act("Not now", "", "dismiss");
    act("Never for this site", "quiet", "never");
    bar.appendChild(actions);
    root.appendChild(bar);
  }

  // -- start ---------------------------------------------------------------------------------

  async function start() {
    const status = await send({ type: "page-state" });
    if (status.error || !status.signedIn) return;
    state = status;
    settings = status.settings || settings;
    if (window.top === window) {
      const { pending } = await send({ type: "pending-save" });
      if (pending) showSaveBar(pending);
    }
    if (status.locked) return;
    // Place the fields once, then stop.
    const fields = fieldsIn(document);
    if (fields.length) await classify(fields.slice(0, 60));
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "show-save" && window.top === window && message.pending) showSaveBar(message.pending);
  });

  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
})();
