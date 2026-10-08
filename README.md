# Orbit Pass for Chrome

The browser extension of [Orbit Pass](https://pass.orbit.com.ai), Orbit's
password manager. It fills logins, verification codes, cards and personal
details, and it is where your vault is encrypted and decrypted: the Orbit Pass
server stores only ciphertext it cannot open, the public halves of your keys,
and who may open which vault. This repository holds the extension's source so
you can check that for yourself.

| Where | What |
|---|---|
| `extension/` | The extension. There is no build step: Chrome runs these files as they are |
| `extension/src/lib/crypto.js` | The encryption: keys from your Orbit password, vault keys wrapped to each member, sealed items, passkeys |
| `extension/src/lib/vault.js` | The vault service: unlocking, locking, syncing, sharing |
| `extension/src/background.js` | The service worker, which answers the popup, the vault page and the fill menu, and locks the vault |
| `extension/src/content/content.js` | What runs in web pages: finds fields and shows the fill menu |
| `extension/src/ai/` | The on-device model that recognises fields; nothing it reads leaves your computer |
| `vectors/` | Test vectors that this extension and Orbit Pass's other apps all reproduce byte for byte |
| `SECURITY.md` | The security model: every key, the exact format, what the server can and cannot see, and what this does not protect against |

`SECURITY.md` describes all of Orbit Pass, so it also names files of the
server and the Apple apps, which aren't in this repository.

## What it can see

A page gets nothing from the extension until you pick an item in the menu
under a field, and a login goes only to a frame whose own address (as Chrome
reports it, not as the page claims) matches the login's saved site. While the
vault is unlocked its keys are in `chrome.storage.session`, which is memory
only, is emptied when Chrome quits and can't be read by pages; locking empties
it. The copy of your vault kept on disk is the ciphertext the server sent.

| Permission | Why |
|---|---|
| Read and change data on all sites | Finding and filling fields on whatever site you're on, and reaching the Orbit Pass server, whose address you can change |
| `storage` | The device's sign-in, settings and encrypted vault; the keys while unlocked (see above) |
| `alarms` | Locking after the idle time you choose, and syncing every few minutes |
| `idle` | Locking when your computer locks, if you ask it to |
| `offscreen`, `clipboardWrite` | Copying a password or code you asked for: a service worker has no clipboard, so Chrome copies from an offscreen page |

## Tests

```bash
node --test "extension/tests/*.test.js"
```

They need Node 22 or later and nothing else. They check the encryption, codes,
domain matching, password generator and field model against `vectors/`,
importing every sample export in `vectors/import/`, the vault service
(unlocking, edit conflicts, importing), website icons, and the Firefox
package. The two end-to-end tests are skipped unless pointed at a running
Orbit Pass server.

## Loading it yourself

**chrome://extensions → Developer mode → Load unpacked → `extension/`.** A copy
loaded this way has its own extension ID, and Orbit's server hands vault keys
only to the extension IDs it knows, so it can't sign in to Orbit's service; it
is for reading and testing the code. `node extension/scripts/package.mjs` makes
the zip Orbit's builds publish (`--firefox` for Firefox), from these same files.

## How this repository is updated

It is a copy of the extension from Orbit's own repository, replaced whenever
the extension changes there, and it builds nothing itself. Issues are welcome.
Changes are made in Orbit's repository, so pull requests here are read but not
merged; a fix we take arrives with the next update.

## Reporting a vulnerability

Please don't open a public issue. Email hello@orbit.com.ai with the details and
a way to reproduce it.

## License

MIT; see [LICENSE](LICENSE).
