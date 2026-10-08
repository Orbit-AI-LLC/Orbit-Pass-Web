import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { base32Decode, otpauthUri, parseOtpauth, totp, totpFromInput } from "../src/lib/totp.js";
import { matchStrength, registrableDomain, urlMatches } from "../src/lib/domains.js";
import { estimateBits, generatePassphrase, generatePassword } from "../src/lib/generator.js";

const V = JSON.parse(readFileSync(new URL("../../vectors/vectors.json", import.meta.url)));

test("RFC 6238 and everyday TOTP vectors", async () => {
  for (const v of [...V.totp.rfc6238, ...V.totp.common]) {
    const { code } = await totp(v, v.time);
    assert.equal(code, v.code, `${v.algorithm} @ ${v.time}`);
  }
});

test("seconds remaining in the period", async () => {
  const { remaining } = await totp({ secret: "JBSWY3DPEHPK3PXP" }, 1759750010);
  assert.equal(remaining, 30 - (1759750010 % 30));
});

test("otpauth URIs parse like the vectors say", () => {
  for (const v of V.otpauth) assert.deepEqual(parseOtpauth(v.uri), v.parsed, v.uri);
});

test("bare secrets and URIs from a paste", () => {
  assert.equal(totpFromInput("jbsw y3dp ehpk 3pxp").secret, "JBSWY3DPEHPK3PXP");
  assert.equal(totpFromInput("not a secret!"), null);
  const config = parseOtpauth(V.otpauth[0].uri);
  assert.deepEqual(parseOtpauth(otpauthUri(config)), config);
  assert.equal(base32Decode("1"), null);
});

test("saved URLs match pages like the vectors say", () => {
  for (const v of V.domains) assert.equal(urlMatches(v.saved, v.page), v.match, `${v.saved} on ${v.page}`);
});

test("registrable domains and match strength", () => {
  assert.equal(registrableDomain("login.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("a.b.github.com"), "github.com");
  assert.equal(matchStrength("https://github.com/login", "https://github.com/session"), 3);
  assert.equal(matchStrength("https://github.com/login", "https://gist.github.com/"), 1);
});

test("generated passwords use every chosen set and the requested length", () => {
  for (let i = 0; i < 50; i++) {
    const password = generatePassword({ length: 16 });
    assert.equal(password.length, 16);
    assert.match(password, /[a-z]/);
    assert.match(password, /[A-Z]/);
    assert.match(password, /[2-9]/);
    assert.match(password, /[!#$%&*+\-=?@^_~]/);
  }
  assert.match(generatePassword({ length: 12, upper: false, digits: false, symbols: false }), /^[a-z]{12}$/);
  const phrase = generatePassphrase({ words: 4 });
  assert.equal(phrase.split("-").length, 4);
  assert.match(phrase, /\d/);
  assert.ok(estimateBits(generatePassword()) > 80);
});
