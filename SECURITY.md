# Orbit Pass security model

Orbit Pass is a password manager whose vaults are encrypted on people's devices
with keys that come from their Orbit password. This document says what the
server can and cannot read, where every key lives, and the exact format, so the
three implementations (`apps/vaults/crypto_reference.py`,
`extension/src/lib/crypto.js`, `apple/OrbitPassKit`) can be checked against it.
`vectors/vectors.json` pins them together byte for byte.

## The short version

The Orbit Pass server stores ciphertext it cannot open, the public halves of
people's encryption identities, and who may open which vault. It never holds a
private key, a vault key, the Orbit password, or anything any of those open. A
database dump, a backup or a subpoena yields membership, sizes and timestamps,
unreadable blobs, and a cache of websites' icons kept by site, with nothing
saying who asked for which (see "Website icons").

Decryption happens only in people's browsers and devices: the Chrome
extension, the Apple apps, the Windows app, and the web vault. The first three
ship separately from the server. The web vault is a page this server sends, so
it is only as trustworthy as the server sending it: see "Web vault" below and
"What this does not protect against".

## Keys, from the top

### The Orbit vault key (from the Orbit password)

The Orbit password is typed into Orbit Mission Control's sign-in page, which
turns it into two keys before anything is sent (Mission Control,
`static/js/orbit-password.js` and `apps/accounts/password.py`):

```
root  = PBKDF2-SHA256(NFKC(password), salt = "orbit/password/v1|" + lower(trim(email)), 600000 rounds, 32 bytes)
auth  = HKDF-SHA256(root, salt = empty, info = "orbit/auth/v1")   -> posted to Mission Control instead of the password
vault = HKDF-SHA256(root, salt = empty, info = "orbit/vault/v1")  -> never leaves the browser
```

`lower` is Unicode lower-casing (Python's `str.lower`, JavaScript's
`toLowerCase`), not case folding: `ß` stays `ß` and a final `ς` stays `ς`.
Mission Control stores addresses that way, and so does the Orbit Pass server,
so the address it reports for an account derives that person's keys and
matches the address in the handoff below.

Orbit Pass gets the vault key through the **handoff**: the client makes an
ephemeral P-256 key pair and sends the public half (`vault_pk`, SPKI,
base64url, 122 characters) with the sign-in. Mission Control's last hop puts
the vault key in the redirect's URL fragment, which no server receives:

```
#vault=<b64url(email)>.<b64url(epk SPKI)>.<b64url(iv)>.<b64url(ct)>[&previous=<same form>]
shared = ECDH(client handoff private key, epk)
kek    = HKDF-SHA256(shared, salt = SHA-256(epk SPKI), info = "orbit/vault-handoff/v1")
vault  = AES-256-GCM-Open(kek, iv, ct, aad = "orbit/vault-handoff/v1|" + email)
```

`previous` is the vault key of the password before the last change, when that
browser still has it (Orbit Pass always asks with `vault_previous=1`). The
recovery gate (the "Orbit password" box in the extension and the apps) derives
the same vault key locally with the same 600,000 rounds. It works only once an
identity is registered for the account, because the identity is what a typed
password is checked against: with none yet, a typo would register an identity
derived from the wrong password. So the first unlock always goes through
Mission Control, which checks the password before handing the key over, and
the clients refuse a password unlock until then ("Unlock with Orbit the first
time").

### The identity (derived, never stored)

Every Orbit app derives the same encryption identity from the vault key, so a
person has one identity across Orbit Chat, Orbit Mail and Orbit Pass:

```
ecdh scalar = int(HKDF-SHA256(vault, info = "orbit/identity/ecdh-p256/v1")) mod (n - 1) + 1
sign scalar = int(HKDF-SHA256(vault, info = "orbit/identity/ecdsa-p256/v1")) mod (n - 1) + 1
```

over P-256 (n is the group order). The public keys are SubjectPublicKeyInfo DER
in standard base64; the key id is the first twelve hex characters of SHA-256 of
the ECDH key's DER. The server stores public keys only, versioned per person
(`Identity`): a password change derives a new identity, version + 1.

### Vault keys and envelopes

Each Orbit Pass vault (a person's personal vault, or a shared vault) has a
random 256-bit **vault key**. It is stored only as **envelopes**, one per
member, each wrapped to that member's identity and signed by whoever wrapped
it:

```
info    = "orbit-pass/wrap/v1|" + vault_id + "|" + key_version + "|" + recipient_id + "|" + recipient_identity_version
eph     = a fresh P-256 key pair; epk = SPKI(eph.public)
kek     = HKDF-SHA256(ECDH(eph, recipient ECDH key), salt = SHA-256(epk), info = info)
wrapped = AES-256-GCM(kek, iv = 12 random bytes, vault key, aad = info)        (32 bytes + 16-byte tag)
signed  = "orbit-pass/envelope/v1|" + vault_id + "|" + key_version + "|" + recipient_id + "|"
          + recipient_identity_version + "|" + wrapper_id + "|" + wrapper_identity_version + "|"
          + b64(epk) + "|" + b64(iv) + "|" + b64(wrapped)
signature = ECDSA-P256-SHA256(wrapper's signing key, signed), as r || s (64 bytes)
```

The envelope is `{version, recipient, recipient_identity_version, wrapper,
wrapper_identity_version, epk, iv, wrapped, signature}` (ids are the Orbit Pass
user ids as decimal strings; `vault_id` is the lower-case UUID). A member's
client verifies the signature with the wrapper's public identity (rebuilding
the signed text with its *own* id as the recipient, so a copy made for someone
else fails), then unwraps.

### Items and vault names

```
item ciphertext = b64(iv || AES-256-GCM(vault key, iv, UTF-8 JSON, aad = "orbit-pass/item/v1|" + vault_id + "|" + key_version + "|" + item_id))
vault meta      = b64(iv || AES-256-GCM(vault key, iv, UTF-8 JSON {name, description}, aad = "orbit-pass/vault-meta/v1|" + vault_id + "|" + key_version))
```

The associated data binds each ciphertext to its vault, key version and item,
so the server cannot move an item to another vault or swap two items: the
result fails to open. The JSON inside an item (format v1):

| Field | Contents |
|---|---|
| `v`, `type` | 1; `login`, `card`, `identity` or `note` |
| `title`, `favorite`, `notes`, `tags` | as named |
| `login` | `username`, `password`, `urls` (array), `totp` (an `otpauth://` URI), `passkeys` (below) |
| `card` | `cardholder`, `number`, `expMonth`, `expYear`, `cvv`, `brand` |
| `identity` | `firstName`, `middleName`, `lastName`, `email`, `phone`, `company`, `address1`, `address2`, `city`, `state`, `postalCode`, `country` |
| `fields` | custom fields: `{name, value, hidden}` |
| `passwordHistory` | `{password, changedAt}`, newest first, ten kept |
| `createdAt`, `updatedAt` | ISO 8601 |

Clients keep fields they don't know, so an older client never drops what a
newer one wrote.

### Passkeys

Orbit Pass is a software passkey authenticator (ES256). A passkey is stored
inside its login, and so encrypted and synced like everything else:
`{credentialId (b64url), rpId, userHandle (b64url), userName, userDisplayName,
privateKey (PKCS#8 DER, b64), counter (always 0), createdAt}`. Registration
returns a `none` attestation; authenticator data sets UP, UV, BE and BS (and AT
at registration) with a zero sign counter, as synced passkeys do. The AAGUID is
`6f726269-742d-7061-7373-000000000001` ("orbit-pass" + version). A passkey in a
shared vault can be used by everyone the vault is shared with, which is the
point of putting it there.

### One-time codes

TOTP per RFC 6238 (HMAC-SHA1, SHA-256 or SHA-512; 6 to 8 digits; any period up
to 300 s), configured by `otpauth://totp/…` URIs. The apps also read Google
Authenticator's `otpauth-migration://` exports.

## Unlocking, locking and devices

**Linking a device.** The extension or an app opens `/account/link/` with a
PKCE challenge (RFC 7636) and the handoff key. After the round trip through
Mission Control, the link page mints a one-time code bound to the challenge and
sends the browser to the client (`orbitpass://link` for the apps, the
extension's own `chrome-extension://<id>/src/auth/callback.html`, or `/vault/`
on this server for the web vault, all carrying the fragment). The client swaps code and verifier for a **device token**
(`orbitpass_<key id>_<secret>`; the server keeps a SHA-256 of the secret). A
wrong verifier burns the code. The token authenticates the device to the API;
it opens nothing. `intent=unlock` runs the same round trip for a device that is
already linked and only needs the vault key again; nothing is minted.

**Chrome extension.** While unlocked, the identity's private keys and the
unwrapped vault keys live in `chrome.storage.session`: memory only, emptied when
Chrome quits, unreadable by content scripts. Locking empties it, after the
chosen idle time (1 minute to 4 hours, or only when Chrome quits) and when the
computer locks. The vault cache in `chrome.storage.local` is ciphertext as the
server sent it. Content scripts never see a secret until a person picks an item
in the menu, and the service worker hands a login only to a frame whose own
address (as Chrome reports it, not as the page claims) matches the login's
saved site.

**Apple apps.** The identity's private keys are kept in the keychain behind
the device's own lock (`.userPresence`, `WhenPasscodeSetThisDeviceOnly`): Face
ID, Touch ID, or the device passcode (the Mac's login password), so after the
first sign-in the device unlocks Orbit Pass and quitting never signs anyone
out. This is a choice: whoever knows the device's passcode can unlock Orbit
Pass on that device, as they can the device's own passwords, and a new face or
finger doesn't invalidate the keys. Turning the setting off deletes them; the
Orbit password re-creates them. The Orbit password always works as the backup.
The auto-lock interval (immediately to one day) is enforced in the app and,
through an **unlock window**, in the AutoFill extension: while unlocked, a copy
of the keys sits in the shared keychain group, readable without a prompt but
with an expiry of that interval after the last use. That is what lets AutoFill
fill without asking again inside the chosen time; with "Immediately" there is
no window, and locking deletes it. The vault cache in the App Group container
is ciphertext. Orbit Authenticator is entitled to the same App Group and
keychain group, so it holds the same keys under the same rules; it is the same
person's same vault, shown differently.

A Mac build not signed by Orbit's team (an ad-hoc build) isn't allowed the
data-protection keychain or the App Group. It keeps the device token, the kept
keys and the unlock window in the login keychain instead, whose items macOS
gives only to the app that wrote them unless the person approves another, and
its cache in its own Application Support folder. That keychain can't put an
item behind Touch ID, so the app asks for Touch ID or the Mac's password itself
before reading the keys: an app-level check, not one the Secure Enclave
enforces. Such a build is for development and can't be an AutoFill provider;
the releases meant for people are signed.

**Importing** reads the exported file on the device (the extension's page, the
web vault's page, the Windows app or the Apple apps) and seals each item under
the chosen vault's key like any other save; the file itself goes nowhere. The
export is plain text, so the apps say to delete it afterwards.

**Credential exchange** (the Apple apps, iOS 26 and macOS 26) moves items
between Orbit Pass and another password manager through the operating
system, which establishes which apps are involved and carries the data
between them without writing a file. Importing: the system hands Orbit Pass a
one-time token when another app exports to it, and Orbit Pass redeems it at
once, locked or not. What arrives is plaintext, held in the app's memory
only (never on disk) until the vault is unlocked and the person picks a
vault, then sealed under that vault's key like any import; dismissing the
sheet or signing out drops it. Exporting: the person chooses the vaults
(shared ones are opt-in), confirms with Face ID, Touch ID or the device
password (`.deviceOwnerAuthentication`; a device with no passcode has nothing
to confirm with), and picks the receiving app in the system's sheet; Orbit
Pass decrypts the chosen items on the device and gives them to the system.
Passkey private keys travel as they are stored (PKCS#8), which is what lets
them keep working in the other app; from then on their safety is that app's.
Exporting removes nothing from Orbit Pass.

**Windows app.** The same vault page and vault service as the extension, in
a Tauri window. The identity's private keys and vault keys live in the page's
memory only, so quitting the app locks it, as does the chosen idle time; the
cache in IndexedDB is ciphertext. Orbit's sign-in runs in a separate window
showing remote content, which has no access to the app's commands; Rust
catches its `orbitpass://link` address and hands it to the main window. The
app's page is served at `https://tauri.localhost`, so the API answers that
origin (and only the origins in `ORBIT_PASS_APP_ORIGINS`) across origins; the
API authenticates by device token alone and never reads cookies, so this
exposes nothing a token holder couldn't read anyway.

**Web vault.** The same vault page and vault service again, served by this
server at `/vault/` (`apps/vaults/views.py`, `static/vault/host.js`). Each
browser links as its own device. Signing in leaves the page for Orbit's sign-in
in the same tab and comes back to `/vault/?code=…&state=…#vault=…`; the host
reads the code and the wrapped key and wipes them from the address bar and
history before the page draws. While that trip is in flight, the handoff
private key waits in IndexedDB as a non-extractable key and the state and PKCE
verifier in `sessionStorage`. The identity's private keys and vault keys live
in the page's memory only: closing, reloading or leaving the page locks it, as
does the chosen idle time. The device token and the ciphertext cache are in
IndexedDB, readable by any script this origin runs, which is why the page's
Content-Security-Policy allows scripts from this site only, no inline script,
connections to this site only, no framing and no form posts, and the page is
never cached. It is same-origin with the API, so it needs no CORS.

**Password changes.** A new Orbit password means a new identity. On the next
unlock the client finds its derived identity differs from the one on the server
and, with the previous vault key (handed over by Mission Control, or the
previous password typed once), re-wraps every vault key it holds to the new
identity and registers it in one request. Without the previous password the
person can start over: their personal vault is lost, and their shared vaults
show "needs re-share" to the vaults' managers, who share them again (a
deliberate click that shows the new identity, because accepting a new identity
on the server's word is exactly the attack a malicious server would try).

**Username changes.** The password is salted with the username, so a username
change in Mission Control is a new identity too, from the same password. It is
carried over the same way: Mission Control finishes the change on a page where
the password is typed, keeps the old username's vault key as `previous`, and
the handoff (whose `vault=` email is the new username) brings both. A client
follows the new username from the server's `me` rather than refusing a handoff
for an address it has not seen, and remembers the usernames the account had
before on this device (`formerEmails` on the stored account, newest first): a
password typed into the recovery gate or the previous-password step is also
derived under those, so the old identity is found without `previous`.

**Removing someone** from a shared vault rotates its key: the client re-seals
every live item and the vault name under a new key and wraps it for each
remaining member, all or nothing (`/vaults/<id>/rotate`). The removed person
saw what was in the vault while they were a member; rotation protects what is
saved afterwards.

## What the server can see

- Who has an Orbit Pass account, their organization and role (from Mission Control).
- Each person's public identity keys and when they changed.
- Which vaults exist, their kind and organization, who is in each and with what role.
- How many items each vault holds, each item's size, revision and timestamps, and who changed it last.
- Which devices are linked, when they were last seen, and from which IP address.
- While a device shows website icons: the sites (registrable domains, like
  `github.com`) of its logins, as it asks for their icons. See "Website icons".

It cannot see vault names, item titles, types, full URLs, usernames,
passwords, codes, passkeys, cards, identities, notes, or custom fields.

## Website icons

A login shows its website's icon. To get it, a device sends the server the
login's site: the registrable domain of its first web address (`github.com`
for `https://gist.github.com/login?next=…`), never the path, the subdomain,
the username or anything else about the item. The server answers from a
table keyed by site alone (`SiteIcon`), fetching a site it hasn't seen.

- **What the server learns.** Each request is authenticated by a device
  token, so at that moment the server can tell which person's device asked
  about which sites; asking for icons a page shows means the sites of that
  person's logins. Nothing records it: the table has no person, device or
  time of asking, and requests carry the sites in the body, not the address,
  so access logs don't list them. A server that wanted to keep that list
  could, so this is a disclosure to the server by design, not a guarantee.
  The cache is shared, so a site anyone has asked about is answered without
  a fetch.
- **Turning it off.** Settings → Website icons stops a device sending sites
  and forgets its copy; logins show their first letter.
- **On the device.** The icons a device was given are kept in IndexedDB
  (the extension's, the Windows app's, the web vault's site), or in the Apple
  apps as a file per site in the App Group container, unencrypted, so
  someone with the device's disk can see which sites' icons were shown.
  Signing out, or turning icons off, empties it. A client keeps an answer only
  if it is a `data:image/` URL, so the server can't make a page load anything
  from elsewhere.
- **The server's own network.** Fetching a site someone named is how a server
  gets turned on its own network (server-side request forgery). The fetcher
  (`apps/vaults/icons.py`) refuses names that are IP addresses or internal
  (`.internal`, `.local`, `localhost` and the like), resolves each name
  itself, refuses it if any address it resolves to isn't public (private,
  loopback, link-local, shared, reserved, multicast, or an IPv4 address inside
  IPv6), and connects to the very address it checked, so a name can't resolve
  to an internal address a moment later. Only ports 80 and 443, four
  redirects at most, each checked the same way; bodies are read to a limit
  (512 KB of a page, 100 KB of an icon) and an icon must be an image by its
  bytes. One person can have a limited number of new sites fetched an hour.
- **Icons in pages.** Icons are shown as `<img>` from `data:` URLs, which
  run no script, SVG included. The web vault's and the Windows app's
  Content-Security-Policy already allow `data:` images; the field menu shows
  the icon inside its closed shadow root only once it has loaded, so a page
  that forbids `data:` images keeps the letter. The Apple apps keep and draw
  only PNGs they made: ImageIO redraws raster icons, refusing any over 1024
  pixels rather than decoding them, and an SVG is drawn by WebKit in an
  off-screen web view with page script off and nothing stored, as an `<img>`
  (which runs no script and loads nothing else) onto a canvas.

## What this does not protect against

- **Mission Control's operator** could serve a sign-in page that keeps the
  password. Every Orbit app places that same trust in Mission Control.
- **A malicious Orbit Pass server** can refuse service, withhold or roll back
  changes, and offer a fabricated identity as a person's "new" one after a
  password reset. Envelope signatures and the deliberate re-share step limit
  the last; the first two are out of scope.
- **The web vault's code comes from this server.** Whoever controls what the
  server sends (its operator, or anyone who breaks into its host or its
  deploys) can change the page to keep the Orbit password typed into it, the
  vault key from Orbit's handoff, or what it decrypts, for chosen people at
  chosen times, and the page can't notice, because the page is what changed.
  Its Content-Security-Policy keeps out other sites' scripts and injected
  inline script, not the server itself. The apps and the extension don't run
  code from the server. Such a server can already ask Mission Control for a
  person's vault key, wrapped to a key of its own, when they sign in or unlock
  through Orbit, because the handoff key travels through this server's sign-in
  redirect. So the web vault widens an exposure rather than creating one: to
  the Orbit password typed into it, and to people who otherwise unlock only
  with the password, which never leaves their device.
- **A compromised device** that is unlocked can read what that device can read.
- **The on-device field model** decides only which kind of field a box is; a
  wrong guess means a menu offered or not offered. The model never sees vault
  data and nothing it reads leaves the device.

## Server-side checks

The server cannot check that an envelope or an item is right, but it checks
everything it can: base64 lengths, P-256 points, that an envelope is wrapped to
the recipient's *current* identity by the actor's current identity for the
vault's current key version, item revisions (optimistic concurrency), roles on
every write, membership on every read (a non-member gets the same 404 as a
vault that does not exist), and that a rotation covers every member and every
live item. Device tokens are re-checked on every request, and a deactivation in
Mission Control reaches every linked device within fifteen minutes.

## Reporting a vulnerability

Do not open a public issue. Contact the maintainers privately with the details
and a reproduction.
