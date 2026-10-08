// The extension's crypto against vectors/vectors.json (made by the Python
// reference). Run: node --test extension/tests
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as C from "../src/lib/crypto.js";

const V = JSON.parse(readFileSync(new URL("../../vectors/vectors.json", import.meta.url)));

test("the Orbit password derives Mission Control's vault and auth keys", async () => {
  for (const v of V.password.filter((p) => p.iterations <= 1000)) {
    const keys = await C.passwordKeys(v.email, v.password, v.iterations);
    assert.equal(C.b64(keys.vault), v.vault);
    assert.equal(keys.auth, v.auth);
  }
});

test("the full 600,000-round derivation matches too", async () => {
  const v = V.password.find((p) => p.iterations === 600000);
  const keys = await C.passwordKeys(v.email, v.password);
  assert.equal(C.b64(keys.vault), v.vault);
});

test("the identity derived from a vault key matches every Orbit app", async () => {
  for (const v of V.identity) {
    const identity = await C.deriveIdentity(C.unb64(v.vault));
    assert.equal(identity.ecdh, v.ecdh);
    assert.equal(identity.sign, v.sign);
    assert.equal(identity.kid, v.kid);
    const keys = await C.importIdentity(identity.pkcs8);
    assert.ok(keys.ecdh && keys.sign);
  }
});

test("a scalar maps to the same public point as Python", async () => {
  const v = V.identity[1];
  const jwk = C.jwkForScalar(C.unhex(v.ecdh_d));
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, { name: "ECDH", namedCurve: "P-256" }, true, []);
  assert.equal(C.b64(new Uint8Array(await crypto.subtle.exportKey("spki", pub))), v.ecdh);
  assert.ok(key);
});

test("Mission Control's handoff fragment opens", async () => {
  const v = V.handoff;
  const jwk = C.jwkForScalar(C.unhex(v.recipient_d));
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const opened = await C.handoffOpen(v.fragment, privateKey);
  assert.equal(opened.email, v.email);
  assert.equal(C.b64(opened.vault), v.vault);
  const fragment = C.parseHandoffFragment(`#vault=${v.fragment}&previous=${v.fragment}`);
  assert.equal(fragment.vault, v.fragment);
  assert.equal(fragment.previous, v.fragment);
  await assert.rejects(C.handoffOpen(v.fragment.replace(/.$/, (c) => (c === "A" ? "B" : "A")), privateKey), /bad-handoff/);
});

test("a fresh handoff pair has the length the server checks", async () => {
  const { vaultPk } = await C.handoffStart();
  assert.equal(vaultPk.length, 122);
});

test("envelopes: wrap matches Python byte for byte, and unwrap verifies", async () => {
  const v = V.envelope;
  const wrapper = await C.deriveIdentity(C.unb64(v.wrapper_vault));
  const recipient = await C.deriveIdentity(C.unb64(v.recipient_vault));
  assert.equal(wrapper.sign, v.wrapper_sign);
  assert.equal(recipient.ecdh, v.recipient_ecdh);
  const env = v.envelope;
  assert.equal(C.envelopeSigned(v.vault_id, env), v.signed);
  assert.equal(C.wrapInfo(v.vault_id, env.version, env.recipient, env.recipient_identity_version), v.info);

  const recipientKeys = await C.importIdentity(recipient.pkcs8);
  const key = await C.unwrapEnvelope({ envelope: env, vaultId: v.vault_id, me: "42", myEcdh: recipientKeys.ecdh, wrapperSign: wrapper.sign });
  assert.equal(C.b64(key), v.vault_key);

  // A copy addressed to someone else fails, as does a wrong signer.
  await assert.rejects(C.unwrapEnvelope({ envelope: env, vaultId: v.vault_id, me: "43", myEcdh: recipientKeys.ecdh, wrapperSign: wrapper.sign }), /bad-envelope-signature/);
  await assert.rejects(C.unwrapEnvelope({ envelope: env, vaultId: v.vault_id, me: "42", myEcdh: recipientKeys.ecdh, wrapperSign: recipient.sign }), /bad-envelope-signature/);

  const wrapperKeys = await C.importIdentity(wrapper.pkcs8);
  const mine = await C.wrapEnvelope({
    vaultKey: C.unb64(v.vault_key), vaultId: v.vault_id, version: 3, recipient: "42", recipientIdv: 2,
    recipientEcdh: recipient.ecdh, wrapper: "7", wrapperIdv: 5, signKey: wrapperKeys.sign,
    ephemeral: C.unhex(v.ephemeral_d), iv: C.unb64(env.iv),
  });
  for (const field of ["epk", "iv", "wrapped", "version", "recipient", "recipient_identity_version", "wrapper", "wrapper_identity_version"]) {
    assert.equal(mine[field], env[field], field);
  }
  assert.ok(await C.verify(wrapper.sign, C.envelopeSigned(v.vault_id, mine), mine.signature));
});

test("items and vault names sealed by Python open here, and round-trip", async () => {
  const v = V.seal;
  const key = C.unb64(v.vault_key);
  assert.equal(C.itemAad(v.vault_id, v.key_version, v.item_id), v.item_aad);
  assert.deepEqual(await C.open(key, v.item_aad, v.item), v.payload);
  assert.deepEqual(await C.open(key, v.meta_aad, v.meta), v.meta_payload);
  await assert.rejects(C.open(key, C.itemAad(v.vault_id, v.key_version, "someone-else"), v.item));
  const blob = await C.seal(key, v.item_aad, v.payload);
  assert.deepEqual(await C.open(key, v.item_aad, blob), v.payload);
});

test("PKCE pairs have the lengths the server checks", async () => {
  const { verifier, challenge } = await C.pkcePair();
  assert.equal(challenge.length, 43);
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
});
