# Pardeh — E2E Encryption for Bale Web

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-beta-orange.svg)]()

A browser extension (Chrome MV3 / Firefox) that overlays **end-to-end encryption** on [Bale Messenger Web](https://web.bale.ai) using a manual handshake (ECDH P-256 + HKDF + AES-256-GCM). Both chat participants install the extension, exchange keys with one click each, verify a safety number out-of-band, and from then on messages travel through Bale as opaque ciphertext.

> **⚠️ Beta software, not audited.** The protocol has known, documented limitations (see [Security model](#security-model)). Do not rely on it against a determined, well-resourced adversary.

---

## How it works

| Component         | File              | Responsibility |
|-------------------|-------------------|----------------|
| Background script | `background.js`   | Handshake orchestration, key store (IndexedDB), all encryption/decryption |
| Crypto module     | `crypto.js`       | Primitives, key derivation, wire formats (shared, unit-tested) |
| State machine     | `state-machine.js`| Pure handshake decision logic (shared, unit-tested) |
| Content script    | `content.js`      | DOM integration: message interception, decryption rendering, status dot |
| Secure composer   | `composer.html/js`| Extension-origin iframe overlaid on Bale's message box |
| i18n              | `i18n.js`         | English / Persian strings |
| Popup             | `popup.html/js`   | Status, safety number, toggle, handshake/rotate/clear actions |

Key material never reaches the page context: the content script only parses message envelopes and asks the background script to encrypt or decrypt. Keys are stored as **non-extractable `CryptoKey` objects in IndexedDB** — they survive restarts but cannot be exported, by the extension or by anything reading its storage.

### Handshake (protocol v2)

1. **Alice** clicks the handshake button → the extension sends `[[E2EHS1:v2:<publicKey>]]` in the chat.
2. **Bob**'s extension detects the offer and shows a notification; Bob clicks → `[[E2EHS2:v2:<publicKey>]]` goes back and Bob's side derives the keys.
3. Alice's extension detects HS2 and finalizes automatically — no third click.
4. Both sides display the same 25-digit **safety number**; compare it over another channel (call, in person) to rule out interception.

If **both** parties initiate simultaneously, a deterministic tie-break on the public keys picks exactly one responder, so the handshake converges instead of producing mismatched keys. Own-message echoes are recognized by key comparison and ignored, and a per-chat mutex serializes concurrent clicks. Pending handshakes expire after 10 minutes.

### Cryptography

- **Key agreement:** ECDH over P-256 (Web Crypto), ephemeral per handshake.
- **Key derivation:** the raw shared secret feeds HKDF-SHA256, salted with a hash of both public keys, producing **separate AES-256-GCM keys per direction** (A→B and B→A).
- **Messages:** `E2EMSG:v2:<epoch>:<direction>:<iv>:<ciphertext>` with a fresh random 96-bit IV per message; epoch and direction are authenticated as GCM additional data, so envelope fields cannot be swapped.
- **Rotation:** "Rotate Keys" runs a fresh handshake and bumps the key epoch. Old epochs are kept so chat history keeps decrypting; new messages use the new keys.
- **Peer verification:** the safety number is derived from both public keys (order-independent). A key offer arriving over an already-established session raises an explicit warning and is never auto-accepted.

## Security model

**What it protects against:** the Bale server (or anyone else on the path) reading message *content*. Ciphertext is authenticated; tampering fails decryption visibly.

**Hardening against a hostile page.** The Bale web app itself is treated as potentially adversarial:

- Keys are non-extractable `CryptoKey` objects in extension IndexedDB. Page scripts cannot reach extension storage, and content scripts share no JS objects with the page (isolated world), so there is no path from the page to key material.
- Decrypted incoming messages are rendered inside **closed shadow roots**: visible to the user, not readable by page scripts through DOM APIs (`textContent`, `innerText`, selection).
- The send path **fails closed**: the plaintext is pulled out of the page input synchronously inside the event handler (so the page cannot ship it during the async encryption window), the envelope returned by the background script must parse as exactly one well-formed message, and the input is re-verified against it immediately before the send is dispatched. On any anomaly nothing is sent and the plaintext is handed back to the user.
- Outgoing text is typed into the **secure composer**: an extension-origin `<iframe>` overlaid on Bale's message box. Keystrokes inside a cross-origin browsing context do not reach the page's window listeners, so what you type is never observable by the page — unlike anything typed into the native input, which the page sees before any extension code runs. The composer talks straight to the background script; the page only ever receives the ciphertext.
- The composer displays a personal **emblem** (three emoji chosen once per installation). Page scripts cannot read inside the composer frame, so a look-alike message box drawn by the page cannot reproduce it. The emblem is shown in the popup for reference: if the box in the chat does not show exactly those emoji, it is not Pardeh — do not type in it.

**What it does NOT protect against:**

- **Active MITM during an unverified handshake.** Key exchange runs through the chat itself, so the server could substitute keys. Mitigation: compare the safety number out-of-band — a MITM produces different numbers on each side. This is detection, not prevention; it requires users to actually compare.
- **No forward secrecy.** A compromised device/key store decrypts all history that used those keys. This is an architectural trade-off: messages are re-decrypted from the chat DOM on every render, so old keys must be retained. Rotate keys periodically to bound the blast radius.
- **In-page UI spoofing and display control.** The page can imitate the status dot or toasts, and it ultimately controls what is rendered — it could hide or fabricate *displayed* messages. The popup is the source of truth for encryption state; encryption guarantees what your peer's extension decrypts, not what a hostile page chooses to show.
- **Metadata.** Who talks to whom, when, and message sizes stay visible to the server regardless.
- **Availability tricks.** The server can drop or reorder handshake messages.

Chats created with pre-2.0 versions keep decrypting through the legacy code path, and sending keeps working with the old key, but the legacy scheme (raw ECDH secret used directly as the AES key) is weaker — the UI flags such chats; rotate keys to upgrade them.

## Install (developer mode)

**Chrome / Chromium**
1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the repo root.

**Firefox**
1. `./build.sh` → `about:debugging` → **This Firefox** → **Load Temporary Add-on** → pick `dist/pardeh-<version>-firefox.xpi`.

Both packages are produced by `./build.sh` from a single source tree (the Firefox MV2 manifest is generated at build time).

## Usage

1. Open a chat on web.bale.ai. A **status dot** appears next to the chat header: grey (off), yellow (enabled, no key), green (established), orange (legacy key), red (new key offer to verify).
2. Click the dot (or open the popup) → **Start handshake**. Your contact accepts with one click.
3. **Compare the safety number** shown in the popup/dot menu over another channel.
4. Toggle **Enable Encryption**. The secure composer takes over the message box — check it shows your emblem, then type and press Enter as usual. Incoming (and your own) encrypted messages are decrypted in place with a 🔒 marker.
5. The dot menu can switch back to the website's own message box (faster, but the page sees your keystrokes). The popup also offers a **Secure compose** box as a fallback if the overlay cannot attach.
6. The popup's 🌐 button switches the UI between English and Persian (RTL supported).

## Development

```bash
npm test        # unit tests (node:test, no dependencies)
npm run lint    # syntax checks
./build.sh      # dist/ packages for chrome + firefox
```

`crypto.js` and `state-machine.js` are pure modules loaded both by the extension and the test suite. CI runs lint, tests and the build on every push.

## Upstream issues addressed

This fork reworks the original experimental codebase and addresses upstream issues [#1–#15](https://github.com/Abulfadl-Ahmadi/pardeh/issues): handshake role confusion (#1), echo handling (#2), state persistence (#3), click races (#4), peer verification (#5), key rotation (#6), key storage (#7), KDF (#8), nonce management (#9), chat id detection (#10), tab targeting (#11), error surfacing (#12), i18n (#13), and the floating-icon UI (#14, #15).

## License

[MIT](LICENSE) — use at your own risk. The authors assume no liability for security breaches or data loss.
