# Bale E2E Encryption Extension

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-experimental-red.svg)]()

A Chrome extension that adds **experimental end‑to‑end encryption** to [Bale Messenger](https://web.bale.ai) using a manual handshake (ECDH P‑256 + AES‑GCM). The extension injects a UI indicator and manages key exchange inside the browser.

> **⚠️ Important:** This extension is **not production‑ready**. It has known security and reliability issues (see [Known Issues](#known-issues)). Use only for learning or at your own risk.

---

## Features

- **Manual handshake protocol** – users click a button to initiate key exchange.
- **ECDH P‑256** for shared secret derivation.
- **AES‑GCM** for message encryption/decryption (implemented in `content.js`).
- Per‑chat encryption toggle – enable/disable per conversation.
- Simple status indicator (floating icon) – shows whether encryption is active.

---

## Architecture

The extension consists of three main parts:

| Component          | File          | Responsibility                                                            |
|--------------------|---------------|---------------------------------------------------------------------------|
| Background script  | `background.js` | Handshake state machine, key storage, Chrome storage API, message routing |
| Content script     | `content.js`    | DOM injection (encryption toggle UI), message interception, encryption/decryption |
| Popup UI           | `popup.html/js` | Basic interface to view status (if implemented)                         |

**Handshake flow (simplified):**

1. **Alice** clicks → sends `[[E2EHS1:publicKeyB64]]` in chat.
2. **Bob** sees HS1 → automatically detects it, stores Bob’s pending state.
3. **Bob** clicks → sends `[[E2EHS2:publicKeyB64]]` and derives shared AES key.
4. **Alice** sees HS2 → derives same AES key and finalises handshake.

Keys are stored per chat in `chrome.storage.local`.

---

## Known Issues

This extension has several **critical problems** documented in the GitHub issue tracker. The most important are:

### 🔴 Security & Protocol
- **No peer authentication (MITM vulnerable)** – users cannot verify they are talking to the right person.
- **No forward secrecy** – a single leaked key decrypts all past and future messages.
- **Private key stored in JWK format without encryption** – increases attack surface.
- **Raw ECDH shared secret used directly as AES key** – should use a KDF (e.g., HKDF).

### 🟠 Logic & Race Conditions
- **Role confusion** – both parties can act as initiator and responder simultaneously, causing handshake failure.
- **Own‑message echo not ignored correctly** – can misinterpret echoed handshake messages.
- **Handshake state lost on service worker restart** – uses `storage.session`, which is wiped.
- **No locking for concurrent clicks** – race condition when user clicks rapidly.

### 🟡 UI / UX
- **Floating icon can overlap send button** – especially when window is not fullscreen.
- **No language switcher** – English only, confusing for non‑English users.
- **`GET_CHAT_ID` always returns null** – chat ID is not retrieved, so keys cannot be correctly associated.

For a complete list, see the [Issues](../../issues) page.

---

## Installation (Developer Mode)

1. **Clone or download** this repository.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in top right).
4. Click **Load unpacked** and select the extension folder.
5. The extension icon should appear in the toolbar.
6. Open [web.bale.ai](https://web.bale.ai) and log in.

> **Note:** You may need to refresh the Bale page after installation.

---

## Usage

1. Open any chat in Bale web.
2. Click the extension’s **floating icon** (or the grey dot if you’ve updated to the new design) to enable encryption for that chat.
3. Both you and your peer must **click the handshake button** (the same icon) to exchange keys.
4. Once handshake completes, messages will be encrypted/decrypted automatically.

---

## Contributing

Contributions are welcome! Areas that need help:

- Fixing the handshake state machine (role confusion, race conditions).
- Implementing peer fingerprint verification.
- Adding key rotation / forward secrecy.
- Improving UI (e.g., replace floating icon with a status dot next to contact name).
- Adding language support (i18n).

Please open an issue **before** starting major work.

---

## License

[MIT](LICENSE) – use at your own risk. The authors assume no liability for security breaches or data loss.

---

## Acknowledgments

- Built with the Web Crypto API.
- Inspired by Signal’s double ratchet (though not yet implemented).
- Special thanks to early testers who reported UI and protocol issues.
