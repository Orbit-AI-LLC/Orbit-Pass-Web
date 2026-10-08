/* The Orbit Pass field model: which kind of field is this?

   A small multinomial logistic regression over hashed features of the field
   (its attributes, its label, the text around it, the shape of its form),
   trained by scripts/field_model/train.py and shipped as field-model.json
   (int8 weights, about 250 KB). One field costs one sparse dot product:
   microseconds, on the CPU, with nothing downloaded and nothing sent
   anywhere. The extension runs it once when a page loads, over the fields
   the quick rules could not place, and once more for a field that appears
   later, the first time it is clicked.

   featurize() must match scripts/field_model/features.py exactly;
   tests/field-model.test.js checks it against field-features.json.

   Why not a language model: Qwen3.5-0.8B was measured on this task (see
   README, "The on-device model"): about 3.4 s per page on a Mac's CPU after
   a 570 MB download, and it did not answer in the format asked. This model
   answers in microseconds and was right on 118 of 119 held-out real-world
   fields. */

export const BUCKETS = 1 << 13;

// -- tokens -------------------------------------------------------------------------

function isCjk(char) {
  const code = char.codePointAt(0);
  return (code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff);
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

function bigrams(run) {
  const chars = Array.from(run);
  if (chars.length === 1) return [run];
  const out = [];
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}

function splitCjk(word) {
  const out = [];
  let run = "";
  let runCjk = false;
  for (const char of Array.from(word).concat(" ")) {
    const cjk = char !== " " && isCjk(char);
    if (run && (char === " " || cjk !== runCjk)) {
      if (runCjk) out.push(...bigrams(run));
      else out.push(run);
      run = "";
    }
    if (char !== " ") {
      run += char;
      runCjk = cjk;
    }
  }
  return out;
}

/** Words in a string, as features.py splits them. */
export function tokens(text, limit = 40) {
  if (!text) return [];
  let s = String(text)
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([^0-9\s])([0-9])/g, "$1 $2")
    .toLowerCase();
  const out = [];
  let word = "";
  for (const char of Array.from(s).concat(" ")) {
    if (WORD_CHAR.test(char)) {
      word += char;
      continue;
    }
    if (word) {
      out.push(...splitCjk(word));
      word = "";
    }
  }
  return out.slice(0, limit);
}

function hasCjk(word) {
  return Array.from(word).some(isCjk);
}

function trigrams(word) {
  const padded = Array.from(`^${word}$`);
  const out = [];
  for (let i = 0; i < padded.length - 2; i++) out.push(padded[i] + padded[i + 1] + padded[i + 2]);
  return out;
}

function maxlengthBucket(value) {
  const n = Number.isInteger(value) ? value : parseInt(value, 10);
  if (!(n > 0) || n >= 256) return "none";
  if (n === 1) return "1";
  if (n === 2) return "2";
  if (n <= 4) return "3-4";
  if (n <= 8) return "5-8";
  if (n <= 16) return "9-16";
  if (n <= 64) return "17-64";
  return "65+";
}

function countBucket(n, edges) {
  for (const edge of edges) if (n <= edge) return String(edge);
  return `${edges[edges.length - 1]}+`;
}

/** Feature strings for a descriptor, in the same order as features.py. */
export function featureStrings(d) {
  const tag = String(d.tag || "input").toLowerCase();
  const kind = tag === "input" ? String(d.type || "text").toLowerCase() : tag;
  const out = ["bias", `t=${kind}`];
  const autocomplete = String(d.autocomplete || "").toLowerCase().split(/\s+/).filter(Boolean);
  for (const token of autocomplete.slice(-2)) out.push(`ac=${token}`);
  if (d.inputMode) out.push(`im=${String(d.inputMode).toLowerCase()}`);
  const ml = maxlengthBucket(d.maxLength ?? -1);
  out.push(`ml=${ml}`);
  const pattern = d.pattern || "";
  if (pattern) out.push(pattern.includes("\\d") || pattern.includes("0-9") ? "pat=digit" : "pat=other");

  for (const word of tokens(d.name || "").concat(tokens(d.id || ""))) {
    out.push(`n:${word}`);
    if (Array.from(word).length > 2 && !hasCjk(word)) for (const tri of trigrams(word)) out.push(`n3:${tri}`);
  }
  const labelText = [d.label, d.ariaLabel, d.placeholder, d.title].filter(Boolean).join(" ");
  for (const word of tokens(labelText)) {
    out.push(`l:${word}`);
    if (Array.from(word).length > 3 && !hasCjk(word)) for (const tri of trigrams(word)) out.push(`l3:${tri}`);
  }
  for (const word of tokens(d.context || "", 30)) out.push(`c:${word}`);
  for (const word of tokens(d.form || "", 12)) out.push(`fm:${word}`);

  const passwords = Math.min(parseInt(d.passwordsInForm || 0, 10), 2);
  out.push(`pw=${passwords}`);
  out.push(`nf=${countBucket(parseInt(d.fieldsInForm || 0, 10), [1, 2, 4, 8])}`);
  out.push(`ix=${Math.min(parseInt(d.index || 0, 10), 3)}`);
  const siblings = parseInt(d.singleCharSiblings || 0, 10);
  out.push(`sib=${siblings === 0 ? "0" : siblings <= 3 ? "1-3" : siblings <= 8 ? "4-8" : "9+"}`);
  out.push(`t=${kind}|pw=${passwords}`);
  out.push(`ml=${ml}|im=${String(d.inputMode || "").toLowerCase()}`);
  out.push(`t=${kind}|ml=${ml}`);
  return out;
}

const encoder = new TextEncoder();

export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const byte of encoder.encode(text)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Sorted, de-duplicated hashed feature indices. */
export function featurize(d) {
  const set = new Set(featureStrings(d).map((f) => fnv1a(f) % BUCKETS));
  return Array.from(set).sort((a, b) => a - b);
}

// -- the model ------------------------------------------------------------------------

export class FieldModel {
  constructor(json) {
    this.classes = json.classes;
    this.buckets = json.buckets;
    this.bias = Float32Array.from(json.bias);
    this.scales = Float32Array.from(json.scales);
    const raw = atob(json.weights);
    this.weights = new Int8Array(raw.length);
    for (let i = 0; i < raw.length; i++) this.weights[i] = raw.charCodeAt(i) << 24 >> 24;
  }

  /** {kind, p, scores} for a descriptor: the likeliest class and its probability. */
  classify(descriptor) {
    const c = this.classes.length;
    const totals = new Float32Array(c);
    for (const index of featurize(descriptor)) {
      const row = index * c;
      for (let k = 0; k < c; k++) totals[k] += this.weights[row + k];
    }
    let max = -Infinity;
    const z = new Float64Array(c);
    for (let k = 0; k < c; k++) {
      z[k] = totals[k] * this.scales[k] + this.bias[k];
      if (z[k] > max) max = z[k];
    }
    let sum = 0;
    for (let k = 0; k < c; k++) { z[k] = Math.exp(z[k] - max); sum += z[k]; }
    let best = 0;
    for (let k = 0; k < c; k++) { z[k] /= sum; if (z[k] > z[best]) best = k; }
    return { kind: this.classes[best], p: z[best] };
  }
}

let loaded = null;

/** The bundled model, loaded once per service-worker lifetime. */
export async function loadFieldModel(url) {
  if (!loaded) {
    loaded = fetch(url).then((r) => r.json()).then((json) => new FieldModel(json));
  }
  return loaded;
}
