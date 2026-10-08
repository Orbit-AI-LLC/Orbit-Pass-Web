/* Orbit Pass encryption, for the Chrome extension. The server never receives a
   private key, a vault key, the Orbit password or anything they open.

   SECURITY.md describes the format; apps/vaults/crypto_reference.py (Python)
   and OrbitPassKit (Swift) implement the same bytes, and vectors/vectors.json
   pins all three together. Labels are part of the format: a change here is a
   new version, everywhere.

   Keys, from the top:
   - The Orbit vault key (32 bytes). Mission Control's sign-in page derives it
     from the Orbit password and hands it over wrapped to a key this extension
     made (the handoff). The recovery gate can derive it from the password too.
   - The identity: two P-256 pairs (ECDH and ECDSA) derived from the vault key,
     the same ones Orbit Chat and Orbit Mail derive. The server stores only the
     public halves.
   - A vault key per Orbit Pass vault (random 32 bytes), stored on the server
     only as envelopes: wrapped to each member's identity, signed by whoever
     wrapped it.
   - Items and vault names: AES-256-GCM under the vault key, bound to where
     they belong (vault, key version, item) as associated data. */

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ITERATIONS = 600000;
const ECDH = { name: "ECDH", namedCurve: "P-256" };
const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const SIGN = { name: "ECDSA", hash: "SHA-256" };

const PASSWORD_SALT = "orbit/password/v1|";
const AUTH_INFO = "orbit/auth/v1";
const VAULT_INFO = "orbit/vault/v1";
const HANDOFF_INFO = "orbit/vault-handoff/v1";
const IDENTITY_ECDH_INFO = "orbit/identity/ecdh-p256/v1";
const IDENTITY_SIGN_INFO = "orbit/identity/ecdsa-p256/v1";
const WRAP_INFO = "orbit-pass/wrap/v1";
const ENVELOPE_SIGNED = "orbit-pass/envelope/v1";
const ITEM_AAD = "orbit-pass/item/v1";
const META_AAD = "orbit-pass/vault-meta/v1";

// -- encodings ----------------------------------------------------------------

export function b64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < view.length; i += 0x8000) out += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
  return btoa(out);
}

export function unb64(text) {
  const raw = atob(String(text || "").replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, ""));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function b64url(bytes) {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function hex(bytes) {
  return Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function unhex(text) {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.substr(i * 2, 2), 16);
  return out;
}

export function random(length) {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

export async function sha256(data) {
  return new Uint8Array(await subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
}

export function uuid() {
  return globalThis.crypto.randomUUID();
}

export function normalEmail(email) {
  return String(email || "").trim().toLowerCase();
}

async function hkdfBits(keyBytes, info, salt = new Uint8Array(0)) {
  const key = await subtle.importKey("raw", keyBytes, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode(info) }, key, 256));
}

async function aesKey(raw, usages = ["encrypt", "decrypt"]) {
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usages);
}

// -- the Orbit password ---------------------------------------------------------

/** What the Orbit password becomes, exactly as Mission Control's sign-in page
    derives it: the auth key (sent there) and the vault key (never sent). Orbit
    Pass uses it only for the recovery gate, when no vault key was handed over. */
export async function passwordKeys(email, password, iterations = PBKDF2_ITERATIONS) {
  const material = await subtle.importKey("raw", enc.encode(String(password).normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const root = new Uint8Array(await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(PASSWORD_SALT + normalEmail(email)), iterations },
    material,
    256,
  ));
  const auth = await hkdfBits(root, AUTH_INFO);
  const vault = await hkdfBits(root, VAULT_INFO);
  root.fill(0);
  return { auth: b64url(auth), vault };
}

// -- P-256 scalar multiplication --------------------------------------------------
// WebCrypto imports a private key only together with its public point, so the
// point for a derived scalar is computed here with BigInt arithmetic. It runs
// once per unlock, on the person's own device. Orbit Chat's crypto.js and
// Orbit Mail's e2ee.js carry the same code.

const P = BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff");
const N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const G = [
  BigInt("0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"),
  BigInt("0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"),
];
const ZERO = BigInt(0), ONE = BigInt(1), TWO = BigInt(2), THREE = BigInt(3), BYTE = BigInt(255), EIGHT = BigInt(8);

function fmod(a) { const r = a % P; return r < ZERO ? r + P : r; }

function finv(a) {
  let result = ONE, base = fmod(a), e = P - TWO;
  while (e > ZERO) {
    if (e & ONE) result = (result * base) % P;
    base = (base * base) % P;
    e >>= ONE;
  }
  return result;
}

function padd(p, q) {
  if (!p) return q;
  if (!q) return p;
  const [x1, y1] = p, [x2, y2] = q;
  if (x1 === x2 && fmod(y1 + y2) === ZERO) return null;
  const lam = x1 === x2 && y1 === y2
    ? fmod((THREE * x1 * x1 - THREE) * finv(TWO * y1))
    : fmod((y2 - y1) * finv(x2 - x1));
  const x3 = fmod(lam * lam - x1 - x2);
  return [x3, fmod(lam * (x1 - x3) - y1)];
}

function pmul(d) {
  let result = null, addend = G;
  while (d > ZERO) {
    if (d & ONE) result = padd(result, addend);
    addend = padd(addend, addend);
    d >>= ONE;
  }
  return result;
}

function bigToBytes(value) {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(value & BYTE); value >>= EIGHT; }
  return out;
}

function bytesToBig(bytes) {
  let value = ZERO;
  for (const byte of bytes) value = (value << EIGHT) | BigInt(byte);
  return value;
}

/** The private JWK for a P-256 scalar (32 bytes, big-endian). */
export function jwkForScalar(scalarBytes) {
  const d = bytesToBig(scalarBytes);
  const point = pmul(d);
  return { kty: "EC", crv: "P-256", d: b64url(bigToBytes(d)), x: b64url(bigToBytes(point[0])), y: b64url(bigToBytes(point[1])), ext: true };
}

/** seed mod (n - 1) + 1, as every Orbit app maps an HKDF seed to a scalar. */
export function scalarForSeed(seed) {
  return bigToBytes((bytesToBig(seed) % (N - ONE)) + ONE);
}

async function pairFromScalar(scalar, algorithm, usages) {
  const jwk = jwkForScalar(scalar);
  const privateKey = await subtle.importKey("jwk", jwk, algorithm, true, usages);
  const publicKey = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true }, algorithm, true, algorithm.name === "ECDSA" ? ["verify"] : []);
  return { privateKey, publicKey };
}

// -- the identity -------------------------------------------------------------------

/** The identity a vault key stands for: public keys (what the server stores)
    and the private keys, as non-extractable key objects plus PKCS#8 for
    keeping in session storage while unlocked. */
export async function deriveIdentity(vaultBytes) {
  const ecdhScalar = scalarForSeed(await hkdfBits(vaultBytes, IDENTITY_ECDH_INFO));
  const signScalar = scalarForSeed(await hkdfBits(vaultBytes, IDENTITY_SIGN_INFO));
  const ecdh = await pairFromScalar(ecdhScalar, ECDH, ["deriveBits"]);
  const signing = await pairFromScalar(signScalar, ECDSA, ["sign"]);
  ecdhScalar.fill(0);
  signScalar.fill(0);
  const ecdhSpki = new Uint8Array(await subtle.exportKey("spki", ecdh.publicKey));
  return {
    ecdh: b64(ecdhSpki),
    sign: b64(new Uint8Array(await subtle.exportKey("spki", signing.publicKey))),
    kid: hex((await sha256(ecdhSpki)).slice(0, 6)),
    pkcs8: {
      ecdh: b64(new Uint8Array(await subtle.exportKey("pkcs8", ecdh.privateKey))),
      sign: b64(new Uint8Array(await subtle.exportKey("pkcs8", signing.privateKey))),
    },
  };
}

/** Private keys back from PKCS#8 (session storage), non-extractable. */
export async function importIdentity(pkcs8) {
  return {
    ecdh: await subtle.importKey("pkcs8", unb64(pkcs8.ecdh), ECDH, false, ["deriveBits"]),
    sign: await subtle.importKey("pkcs8", unb64(pkcs8.sign), ECDSA, false, ["sign"]),
  };
}

export function sameIdentity(a, b) {
  return Boolean(a && b && a.ecdh === b.ecdh && a.sign === b.sign);
}

/** 32 hex digits in 8 groups, the same everywhere for the same identity:
    something two people can read to each other to check a share. */
export async function fingerprint(identity) {
  const digest = await sha256(concat(unb64(identity.ecdh), unb64(identity.sign)));
  return hex(digest.slice(0, 16)).match(/.{4}/g).join(" ");
}

// -- the handoff from Mission Control ----------------------------------------------

/** A fresh handoff pair: the private key stays here (non-extractable), the
    public key goes in the sign-in URL as vault_pk. */
export async function handoffStart() {
  const pair = await subtle.generateKey(ECDH, false, ["deriveBits"]);
  const spki = new Uint8Array(await subtle.exportKey("spki", pair.publicKey));
  return { privateKey: pair.privateKey, vaultPk: b64url(spki) };
}

/** Open one "vault=" (or "previous=") fragment value with the handoff private
    key: the email it is for and the raw vault key. */
export async function handoffOpen(value, privateKey) {
  const parts = String(value || "").split(".");
  if (parts.length !== 4) throw new Error("bad-handoff");
  const email = normalEmail(dec.decode(unb64(parts[0])));
  const epk = unb64(parts[1]);
  const epkKey = await subtle.importKey("spki", epk, ECDH, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: epkKey }, privateKey, 256));
  const kek = await aesKey(await hkdfBits(shared, HANDOFF_INFO, await sha256(epk)), ["decrypt"]);
  try {
    const raw = await subtle.decrypt({ name: "AES-GCM", iv: unb64(parts[2]), additionalData: enc.encode(`${HANDOFF_INFO}|${email}`) }, kek, unb64(parts[3]));
    return { email, vault: new Uint8Array(raw) };
  } catch {
    throw new Error("bad-handoff");
  }
}

/** The vault keys in a sign-in fragment: `#vault=…&previous=…`. */
export function parseHandoffFragment(hash) {
  const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  return { vault: params.get("vault") || "", previous: params.get("previous") || "" };
}

// -- signatures -------------------------------------------------------------------------

export async function sign(privateKey, text) {
  return b64(new Uint8Array(await subtle.sign(SIGN, privateKey, enc.encode(text))));
}

const publicCache = new Map();

async function verifyKey(spkiB64) {
  if (!publicCache.has(spkiB64)) publicCache.set(spkiB64, subtle.importKey("spki", unb64(spkiB64), ECDSA, false, ["verify"]));
  return publicCache.get(spkiB64);
}

export async function verify(spkiB64, text, signatureB64) {
  try {
    const signature = unb64(signatureB64);
    if (signature.length !== 64) return false;
    return await subtle.verify(SIGN, await verifyKey(spkiB64), signature, enc.encode(text));
  } catch {
    return false;
  }
}

// -- envelopes ----------------------------------------------------------------------------

export function wrapInfo(vaultId, version, recipient, recipientIdv) {
  return `${WRAP_INFO}|${vaultId}|${version}|${recipient}|${recipientIdv}`;
}

export function envelopeSigned(vaultId, env) {
  return [
    ENVELOPE_SIGNED, vaultId, env.version, env.recipient, env.recipient_identity_version,
    env.wrapper, env.wrapper_identity_version, env.epk, env.iv, env.wrapped,
  ].join("|");
}

async function wrapKek(sharedBits, epk, info) {
  return aesKey(await hkdfBits(sharedBits, info, await sha256(epk)));
}

/** One member's signed copy of a vault key.
    opts: vaultKey (Uint8Array), vaultId, version, recipient, recipientIdv,
    recipientEcdh (SPKI b64), wrapper, wrapperIdv, signKey (CryptoKey);
    ephemeral and iv only for the test vectors. */
export async function wrapEnvelope(opts) {
  const info = wrapInfo(opts.vaultId, opts.version, opts.recipient, opts.recipientIdv);
  const ephemeral = opts.ephemeral
    ? await pairFromScalar(opts.ephemeral, ECDH, ["deriveBits"])
    : await subtle.generateKey(ECDH, true, ["deriveBits"]);
  const epk = new Uint8Array(await subtle.exportKey("spki", ephemeral.publicKey));
  const recipientKey = await subtle.importKey("spki", unb64(opts.recipientEcdh), ECDH, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: recipientKey }, ephemeral.privateKey, 256));
  const kek = await wrapKek(shared, epk, info);
  const iv = opts.iv || random(12);
  const wrapped = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(info) }, kek, opts.vaultKey));
  const env = {
    version: opts.version,
    recipient: String(opts.recipient),
    recipient_identity_version: opts.recipientIdv,
    wrapper: String(opts.wrapper),
    wrapper_identity_version: opts.wrapperIdv,
    epk: b64(epk),
    iv: b64(iv),
    wrapped: b64(wrapped),
  };
  env.signature = await sign(opts.signKey, envelopeSigned(opts.vaultId, env));
  return env;
}

/** Check the wrapper's signature, then unwrap with my ECDH key. The signed
    text is rebuilt with my own id as the recipient, so a copy signed for
    someone else fails. */
export async function unwrapEnvelope({ envelope, vaultId, me, myEcdh, wrapperSign }) {
  const signed = { ...envelope, recipient: String(me) };
  if (!(await verify(wrapperSign, envelopeSigned(vaultId, signed), envelope.signature))) throw new Error("bad-envelope-signature");
  const info = wrapInfo(vaultId, envelope.version, me, envelope.recipient_identity_version);
  const epk = unb64(envelope.epk);
  const epkKey = await subtle.importKey("spki", epk, ECDH, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: epkKey }, myEcdh, 256));
  const kek = await wrapKek(shared, epk, info);
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: unb64(envelope.iv), additionalData: enc.encode(info) }, kek, unb64(envelope.wrapped)));
}

// -- items and vault names ---------------------------------------------------------------

export function itemAad(vaultId, keyVersion, itemId) {
  return `${ITEM_AAD}|${vaultId}|${keyVersion}|${itemId}`;
}

export function metaAad(vaultId, keyVersion) {
  return `${META_AAD}|${vaultId}|${keyVersion}`;
}

export function newVaultKey() {
  return random(32);
}

/** Seal a JSON payload: base64(iv || AES-GCM(ciphertext + tag)). */
export async function seal(vaultKey, aad, payload, iv = random(12)) {
  const key = await aesKey(vaultKey, ["encrypt"]);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(payload))));
  return b64(concat(iv, ct));
}

export async function open(vaultKey, aad, blob) {
  const raw = unb64(blob);
  const key = await aesKey(vaultKey, ["decrypt"]);
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12), additionalData: enc.encode(aad) }, key, raw.slice(12));
  return JSON.parse(dec.decode(plain));
}

// -- PKCE ------------------------------------------------------------------------------------

export async function pkcePair() {
  const verifier = b64url(random(48));
  const challenge = b64url(await sha256(verifier));
  return { verifier, challenge };
}
