/* Passwords and passphrases, from the system's secure random source, without
   modulo bias. */

const SETS = {
  lower: "abcdefghijkmnopqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digits: "23456789",
  symbols: "!#$%&*+-=?@^_~",
};

// A short list of plain, distinct words for passphrases (about 10.6 bits
// each). Not the EFF list, but drawn the same way.
const WORDS = (
  "acorn actor adobe agent alarm album alert alley amber angle ankle apple april apron arena armor arrow atlas attic audio " +
  "autumn award bacon badge bagel baker bamboo banjo barn basil basin beach beacon bench berry bison blade blanket blaze " +
  "bloom board bonus boost brave bread brick bridge brook brush bucket buffalo bugle cabin cable cactus camel candle canoe " +
  "canyon captain carbon cargo carpet castle cedar cellar chalk charm cherry chess chief cider cinema citrus clever cliff " +
  "clock cloud clover cobalt cocoa comet coral cotton cougar crane crater crayon cricket crown cube cupcake dairy daisy " +
  "dancer delta denim desert diesel dingo dolphin domino donkey dragon drift drum eagle echo eclipse elbow ember emerald " +
  "engine falcon feather fern ferry fiber fiddle field finch fjord flame flint flute forest fossil fox frost galaxy garden " +
  "garlic gecko geyser ginger glacier globe goblet golden goose gopher granite grape gravel harbor hazel hedge helmet heron " +
  "hickory honey horizon hornet husky igloo indigo island ivory jacket jaguar jasmine jelly jungle kayak kernel kettle kiwi " +
  "koala ladder lagoon lantern laser lemon leopard lilac linen lizard lobster locket lotus lunar magnet mango maple marble " +
  "meadow melon meteor mint mirror mitten moose mosaic motor muffin nebula needle nickel noodle nutmeg oasis ocean olive " +
  "onion opal orbit orchid otter oyster paddle panda papaya parrot pastry peach pebble pecan pepper piano pickle pigeon " +
  "pilot pine planet plaza plum polar pony poppy prairie prism pumpkin puzzle quartz quill rabbit radar radish raven " +
  "reef ribbon river robin rocket rose ruby saddle saffron salmon sapphire satin scarf shadow shell sierra silver sketch " +
  "sled slope socket sonic sparrow spider spruce squash stable starling stone storm studio summit sunset swan tango thistle " +
  "thunder tiger timber toffee topaz torch trail tulip tundra turtle tuxedo umber valley velvet violet volcano waffle " +
  "walnut walrus wander willow window winter wizard yarrow yodel zebra zephyr zinc"
).split(" ");

function randomIndex(n) {
  // Rejection sampling over 32-bit values so every index is equally likely.
  const limit = Math.floor(0x100000000 / n) * n;
  const buffer = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buffer);
    if (buffer[0] < limit) return buffer[0] % n;
  }
}

/** A random password. Every chosen set contributes at least one character. */
export function generatePassword({ length = 20, lower = true, upper = true, digits = true, symbols = true } = {}) {
  const chosen = Object.entries({ lower, upper, digits, symbols }).filter(([, on]) => on).map(([name]) => SETS[name]);
  if (!chosen.length) chosen.push(SETS.lower);
  const size = Math.max(length, chosen.length);
  const all = chosen.join("");
  const chars = chosen.map((set) => set[randomIndex(set.length)]);
  while (chars.length < size) chars.push(all[randomIndex(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** A passphrase of random words, with a digit so picky sites accept it. */
export function generatePassphrase({ words = 5, separator = "-" } = {}) {
  const picked = Array.from({ length: words }, () => WORDS[randomIndex(WORDS.length)]);
  picked[randomIndex(picked.length)] += String(randomIndex(10));
  return picked.join(separator);
}

/** A rough strength estimate in bits, for the meter. */
export function estimateBits(password) {
  const text = String(password || "");
  if (!text) return 0;
  let pool = 0;
  if (/[a-z]/.test(text)) pool += 26;
  if (/[A-Z]/.test(text)) pool += 26;
  if (/\d/.test(text)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(text)) pool += 33;
  const unique = new Set(text).size;
  return Math.round(Math.log2(pool) * Math.min(text.length, unique * 2));
}

export const WORD_COUNT = WORDS.length;
