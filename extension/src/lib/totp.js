/* One-time codes: TOTP (RFC 6238) over HOTP (RFC 4226), and otpauth URIs.
   Mirrors apps/vaults/crypto_reference.py and OrbitPassKit's TOTP.swift;
   vectors/vectors.json pins them together. */

const subtle = globalThis.crypto.subtle;
const ALGORITHMS = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" };
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 (RFC 4648) to bytes. Spaces, dashes and padding are ignored, case
    too; anything else is not a secret, so null. */
export function base32Decode(secret) {
  const cleaned = String(secret || "").replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!cleaned || /[^A-Z2-7]/.test(cleaned)) return null;
  const out = [];
  let bits = 0, value = 0;
  for (const char of cleaned) {
    value = (value << 5) | B32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function normalSecret(secret) {
  return String(secret || "").replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
}

export async function hotp(key, counter, { digits = 6, algorithm = "SHA1" } = {}) {
  const hmacKey = await subtle.importKey("raw", key, { name: "HMAC", hash: ALGORITHMS[algorithm] || "SHA-1" }, false, ["sign"]);
  const message = new Uint8Array(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) { message[i] = Number(c & BigInt(255)); c >>= BigInt(8); }
  const digest = new Uint8Array(await subtle.sign("HMAC", hmacKey, message));
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The code for a TOTP config ({secret, algorithm, digits, period}) at a
    time in seconds, and how many seconds it has left. */
export async function totp(config, at = Date.now() / 1000) {
  const key = base32Decode(config.secret);
  if (!key) throw new Error("bad-secret");
  const period = config.period || 30;
  const seconds = Math.floor(at);
  const code = await hotp(key, Math.floor(seconds / period), { digits: config.digits || 6, algorithm: config.algorithm || "SHA1" });
  return { code, remaining: period - (seconds % period), period };
}

/** Parse an otpauth:// (or Apple's apple-otpauth://) TOTP URI. Returns null
    for anything that is not a usable TOTP set-up. */
export function parseOtpauth(uri) {
  let url;
  try {
    url = new URL(String(uri || "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "otpauth:" && url.protocol !== "apple-otpauth:") return null;
  // URL puts the type in the host for custom schemes ("//totp/label").
  const type = (url.host || url.pathname.replace(/^\/\//, "").split("/")[0]).toLowerCase();
  if (type !== "totp") return null;
  const rawLabel = url.host ? url.pathname.replace(/^\//, "") : url.pathname.replace(/^\/\/totp\//, "");
  const label = decodeURIComponent(rawLabel);
  const secret = normalSecret(url.searchParams.get("secret"));
  if (!secret || !base32Decode(secret)) return null;
  let issuer = url.searchParams.get("issuer") || "";
  let account = label;
  const colon = label.indexOf(":");
  if (colon >= 0) {
    if (!issuer) issuer = label.slice(0, colon).trim();
    account = label.slice(colon + 1).trim();
  }
  const algorithm = (url.searchParams.get("algorithm") || "SHA1").toUpperCase();
  const digits = parseInt(url.searchParams.get("digits") || "6", 10);
  const period = parseInt(url.searchParams.get("period") || "30", 10);
  if (!ALGORITHMS[algorithm] || ![6, 7, 8].includes(digits) || !(period > 0 && period <= 300)) return null;
  return { secret, issuer, account: account.trim(), algorithm, digits, period };
}

/** A TOTP config from what a person pasted: an otpauth URI or a bare secret. */
export function totpFromInput(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (/^(apple-)?otpauth:/i.test(text)) return parseOtpauth(text);
  const secret = normalSecret(text);
  return base32Decode(secret) ? { secret, issuer: "", account: "", algorithm: "SHA1", digits: 6, period: 30 } : null;
}

/** The otpauth URI for a config, for storing and for showing as a QR code. */
export function otpauthUri(config) {
  const label = encodeURIComponent(config.issuer ? `${config.issuer}:${config.account || ""}` : config.account || "Orbit Pass");
  const params = new URLSearchParams({ secret: config.secret });
  if (config.issuer) params.set("issuer", config.issuer);
  if (config.algorithm && config.algorithm !== "SHA1") params.set("algorithm", config.algorithm);
  if (config.digits && config.digits !== 6) params.set("digits", String(config.digits));
  if (config.period && config.period !== 30) params.set("period", String(config.period));
  return `otpauth://totp/${label}?${params}`;
}
