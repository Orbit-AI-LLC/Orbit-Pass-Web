// The JS field model against the Python trainer: same features, same answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { FieldModel, featureStrings, featurize, tokens } from "../src/ai/field-model.js";

const fixture = JSON.parse(readFileSync(new URL("../src/ai/field-features.json", import.meta.url)));
const model = new FieldModel(JSON.parse(readFileSync(new URL("../src/ai/field-model.json", import.meta.url))));

test("tokens split like features.py", () => {
  assert.deepEqual(tokens("ctl00$Main$txtUserName"), ["ctl", "00", "main", "txt", "user", "name"]);
  assert.deepEqual(tokens("HTMLInput2fa"), ["html", "input", "2fa"]);
  assert.deepEqual(tokens("手机号/邮箱"), ["手机", "机号", "邮箱"]);
  assert.deepEqual(tokens("ログインID"), ["ログ", "グイ", "イン", "id"]);
});

test("feature strings and hashed indices match Python on every fixture", () => {
  for (const row of fixture) {
    assert.deepEqual(featureStrings(row.descriptor), row.features, JSON.stringify(row.descriptor));
    assert.deepEqual(featurize(row.descriptor), row.indices);
  }
});

test("predictions match Python's", () => {
  for (const row of fixture) {
    const { kind, p } = model.classify(row.descriptor);
    assert.equal(kind, row.top, JSON.stringify(row.descriptor));
    assert.ok(Math.abs(p - row.p) < 1e-3, `${p} vs ${row.p}`);
  }
});

test("one-time-code fields are found and promo codes are not", () => {
  const github = { tag: "input", type: "text", name: "app_otp", id: "app_totp", placeholder: "XXXXXX", label: "Authentication code", inputMode: "numeric", maxLength: 6, context: "Two-factor authentication", passwordsInForm: 0, fieldsInForm: 1 };
  assert.equal(model.classify(github).kind, "otp");
  const promo = { tag: "input", type: "text", name: "promo", placeholder: "Promo code", context: "Order summary", fieldsInForm: 1 };
  assert.equal(model.classify(promo).kind, "none");
  const cvc = { tag: "input", type: "tel", name: "cvc", label: "Security code", maxLength: 4, context: "Payment", fieldsInForm: 4, index: 3 };
  assert.equal(model.classify(cvc).kind, "cc-csc");
});

test("an email-only sign-in box is a login, sure enough to overrule autocomplete=email", () => {
  // claude.ai/login as captured: the quick rules call this personal details
  // (autocomplete="email", no password), and content.js lets the model
  // overrule a rule only at 0.9 or more.
  const claude = { tag: "input", type: "email", id: "email", autocomplete: "email", placeholder: "Enter your email", ariaLabel: "Email", context: "Your thinking partner for big ambitions Continue with email Continue with SSO", form: "/login", passwordsInForm: 0, fieldsInForm: 1 };
  const signIn = model.classify(claude);
  assert.equal(signIn.kind, "username");
  assert.ok(signIn.p >= 0.9, `${signIn.p}`);
  // A newsletter box with the same attributes is still an email address.
  const newsletter = { tag: "input", type: "email", name: "contact[email]", autocomplete: "email", placeholder: "Email", ariaLabel: "Email", context: "Subscribe to our emails Be the first to know about new collections and exclusive offers.", form: "/contact#contact_form", passwordsInForm: 0, fieldsInForm: 1 };
  assert.equal(model.classify(newsletter).kind, "email");
});

test("a field takes microseconds", () => {
  const d = fixture[0].descriptor;
  const start = performance.now();
  for (let i = 0; i < 2000; i++) model.classify(d);
  const perField = (performance.now() - start) / 2000;
  assert.ok(perField < 1, `${perField} ms per field`);
});
