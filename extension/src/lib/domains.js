/* Which saved logins belong on which page.

   A saved URL matches a page when both have the same registrable domain
   (eTLD+1: "github.com" for gist.github.com, "example.co.uk" for
   login.example.co.uk). IP addresses, localhost and single-label hosts must
   match exactly, port included. A login saved on https is never offered on
   plain http. Hosts under a shared-hosting suffix (github.io, herokuapp.com
   and the like) count as their own site, since strangers own the neighbours.

   This is a compact subset of the Public Suffix List: the multi-part suffixes
   people actually meet. OrbitPassKit's DomainMatcher.swift carries the same
   list; vectors/vectors.json pins the two together. */

const MULTI_PART_SUFFIXES = new Set([
  // Country second levels.
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "me.uk", "net.uk", "nhs.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "gr.jp",
  "co.kr", "or.kr", "ne.kr", "go.kr", "ac.kr",
  "com.br", "net.br", "org.br", "gov.br", "edu.br",
  "com.mx", "org.mx", "gob.mx", "edu.mx",
  "com.ar", "com.co", "com.pe", "com.ve", "com.uy", "com.ec", "cl.cl",
  "co.in", "net.in", "org.in", "gov.in", "ac.in", "firm.in", "gen.in", "ind.in",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "com.hk", "org.hk", "net.hk", "edu.hk", "gov.hk",
  "com.tw", "org.tw", "net.tw", "edu.tw", "gov.tw",
  "com.sg", "org.sg", "net.sg", "edu.sg", "gov.sg",
  "com.my", "org.my", "net.my", "edu.my", "gov.my",
  "co.id", "or.id", "go.id", "ac.id", "web.id",
  "co.th", "or.th", "go.th", "ac.th", "in.th",
  "com.ph", "org.ph", "net.ph", "gov.ph", "edu.ph",
  "com.vn", "net.vn", "org.vn", "gov.vn", "edu.vn",
  "co.za", "org.za", "gov.za", "ac.za", "net.za", "web.za",
  "com.ng", "org.ng", "gov.ng", "edu.ng",
  "co.ke", "or.ke", "go.ke", "ac.ke",
  "com.eg", "org.eg", "gov.eg", "edu.eg",
  "com.tr", "org.tr", "net.tr", "gov.tr", "edu.tr", "gen.tr",
  "co.il", "org.il", "net.il", "ac.il", "gov.il",
  "com.sa", "org.sa", "gov.sa", "edu.sa",
  "co.ae", "gov.ae", "ac.ae",
  "com.pk", "org.pk", "gov.pk", "edu.pk",
  "com.ua", "org.ua", "net.ua", "gov.ua", "in.ua",
  "com.pl", "net.pl", "org.pl", "gov.pl",
  "co.at", "or.at", "gv.at", "ac.at",
  "com.es", "org.es", "nom.es", "gob.es", "edu.es",
  "com.pt", "org.pt", "gov.pt", "edu.pt",
  "com.gr", "org.gr", "gov.gr", "edu.gr",
  "co.hu", "org.hu", "gov.hu",
  "com.ru", "org.ru", "net.ru", "msk.ru", "spb.ru",
  "co.it", "gov.it", "edu.it",
  "com.be", "co.no", "priv.no", "com.se", "org.se", "co.dk", "com.fi",
  // Shared hosting: each subdomain is someone else's site.
  "github.io", "gitlab.io", "herokuapp.com", "netlify.app", "vercel.app", "pages.dev", "workers.dev",
  "web.app", "firebaseapp.com", "appspot.com", "azurewebsites.net", "cloudfront.net", "amplifyapp.com",
  "onrender.com", "fly.dev", "railway.app", "up.railway.app", "glitch.me", "repl.co", "replit.app",
  "blogspot.com", "wordpress.com", "wixsite.com", "squarespace.com", "myshopify.com", "webflow.io",
  "s3.amazonaws.com", "elasticbeanstalk.com", "ngrok.io", "ngrok-free.app", "trycloudflare.com",
]);

function isIp(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");
}

/** The registrable domain for a hostname, or the host itself when it has
    none (an IP, localhost, a single label). */
export function registrableDomain(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host || isIp(host)) return host;
  const labels = host.split(".");
  if (labels.length < 2) return host;
  for (let take = Math.min(4, labels.length - 1); take >= 2; take--) {
    const suffix = labels.slice(-take).join(".");
    if (MULTI_PART_SUFFIXES.has(suffix)) {
      return labels.length > take ? labels.slice(-(take + 1)).join(".") : host;
    }
  }
  return labels.slice(-2).join(".");
}

/** A URL from what was saved: "github.com" becomes https://github.com/. */
export function parseSaved(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
}

/** Hosts with no registrable domain: an IP, localhost, a single label, .local. */
export function exactHost(url) {
  const host = url.hostname.toLowerCase();
  return isIp(host) || host === "localhost" || !host.includes(".") || host.endsWith(".local");
}

/** Whether a saved URL belongs on a page URL. */
export function urlMatches(saved, page) {
  const a = parseSaved(saved);
  let b;
  try {
    b = new URL(page);
  } catch {
    return false;
  }
  if (!a || !/^https?:$/.test(b.protocol)) return false;
  if (a.protocol === "https:" && b.protocol !== "https:") return false;
  if (exactHost(a) || exactHost(b)) return a.host.toLowerCase() === b.host.toLowerCase();
  return registrableDomain(a.hostname) === registrableDomain(b.hostname);
}

/** How well a saved URL fits: 3 same origin, 2 same host, 1 same site, 0 none.
    Used to put the best login first. */
export function matchStrength(saved, page) {
  if (!urlMatches(saved, page)) return 0;
  const a = parseSaved(saved);
  const b = new URL(page);
  if (a.origin === b.origin) return 3;
  if (a.hostname === b.hostname) return 2;
  return 1;
}
