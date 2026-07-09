"use strict";

/**
 * Pardeh protocol v2 — crypto primitives and wire formats.
 *
 * Loaded as a classic script by the background service worker (Chrome),
 * the background event page (Firefox), the content script (for envelope
 * parsing only — no key material ever reaches the page context), and as
 * a CommonJS module by the node test suite.
 *
 * Wire formats:
 *   handshake  [[E2EHS1:v2:<pubB64>]]  /  [[E2EHS2:v2:<pubB64>]]
 *   message    E2EMSG:v2:<epoch>:<A|B>:<ivB64>:<ctB64>
 *   legacy v1  [[E2EHS1:<pubB64>]]  /  E2EMSG:<ivB64>:<ctB64>
 *
 * Key derivation (v2): the raw ECDH P-256 shared secret is never used as
 * an encryption key directly. Both sides order the two raw public keys
 * bytewise (min || max); the party owning the smaller key is labelled "A",
 * the other "B". Then:
 *   salt    = SHA-256(minPub || maxPub)
 *   sendKey = HKDF-SHA256(secret, salt, "pardeh:v2:aes-gcm:<ownLabel>")
 *   recvKey = HKDF-SHA256(secret, salt, "pardeh:v2:aes-gcm:<peerLabel>")
 * so A's send key equals B's receive key and vice versa. Both AES-GCM-256
 * keys are imported non-extractable.
 *
 * Nonce strategy: every message uses a fresh random 96-bit IV from the
 * CSPRNG, transmitted alongside the ciphertext. Per-direction keys keep
 * the two senders' IV spaces independent; at chat volumes the random-IV
 * collision bound (~2^-33 after 2^32 messages) is not a practical concern.
 * Epoch and direction are bound into the GCM additional data so envelope
 * fields cannot be swapped without failing authentication.
 */

const PROTOCOL_VERSION = 2;
const RAW_P256_KEY_LENGTH = 65;
const GCM_IV_LENGTH = 12;

const HS_V2_RE = /\[\[E2EHS(1|2):v2:([A-Za-z0-9+/=]{80,140})\]\]/;
const HS_V1_RE = /\[\[E2EHS(1|2):([A-Za-z0-9+/=]{80,140})\]\]/;
const HS_V1_BARE_RE = /(?:^|\s)E2EHS(1|2):([A-Za-z0-9+/=]{80,140})(?:$|\s)/;
const MSG_V2_RE = /E2EMSG:v2:(\d{1,6}):(A|B):([A-Za-z0-9+/]+={0,2}):([A-Za-z0-9+/]+={0,2})/;
const MSG_V1_RE = /E2EMSG:([A-Za-z0-9+/]+={0,2}):([A-Za-z0-9+/]+={0,2})/;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function utf8(text) {
  return new TextEncoder().encode(text);
}

function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function validateRawP256PublicKeyB64(publicKeyB64) {
  let bytes;
  try {
    bytes = base64ToBytes(publicKeyB64);
  } catch (_) {
    throw new Error("Public key is not valid base64");
  }
  if (bytes.length !== RAW_P256_KEY_LENGTH) {
    throw new Error(`Invalid raw key length: ${bytes.length}, expected ${RAW_P256_KEY_LENGTH}`);
  }
  if (bytes[0] !== 0x04) {
    throw new Error(`Invalid EC point prefix: ${bytes[0]}, expected 4`);
  }
  return true;
}

/**
 * Deterministic total order over public keys. Both peers run the same
 * comparison on the same two strings, so any consistent order works;
 * plain string comparison keeps the state machine dependency-free.
 */
function compareKeysB64(aB64, bB64) {
  if (aB64 === bB64) return 0;
  return aB64 < bB64 ? -1 : 1;
}

async function generateEcdhKeyPair() {
  // Non-extractable: the private key can be persisted as a CryptoKey in
  // IndexedDB and used for deriveBits, but never exported.
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
}

async function exportRawPublicKeyB64(publicKey) {
  const exported = await crypto.subtle.exportKey("raw", publicKey);
  return arrayBufferToBase64(exported);
}

async function importRawPublicKey(publicKeyB64) {
  return crypto.subtle.importKey(
    "raw",
    base64ToBytes(publicKeyB64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
}

/**
 * Derives the per-direction AES-GCM keys for a completed handshake.
 * Returns { sendKey, recvKey, myLabel }. The send key also carries the
 * "decrypt" usage because the sender must decrypt its own messages when
 * they are re-rendered from the chat DOM.
 */
async function deriveDirectionalKeys(privateKey, peerPublicKey, ourPubB64, peerPubB64) {
  const secretBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerPublicKey },
    privateKey,
    256
  );

  const hkdfKey = await crypto.subtle.importKey("raw", secretBits, "HKDF", false, ["deriveKey"]);

  const ourBytes = base64ToBytes(ourPubB64);
  const peerBytes = base64ToBytes(peerPubB64);
  const cmp = compareKeysB64(ourPubB64, peerPubB64);
  const myLabel = cmp < 0 ? "A" : "B";
  const peerLabel = myLabel === "A" ? "B" : "A";
  const ordered = cmp < 0 ? concatBytes(ourBytes, peerBytes) : concatBytes(peerBytes, ourBytes);

  const salt = await crypto.subtle.digest("SHA-256", ordered);

  const deriveOne = (label, usages) =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: utf8(`pardeh:v2:aes-gcm:${label}`) },
      hkdfKey,
      { name: "AES-GCM", length: 256 },
      false,
      usages
    );

  const [sendKey, recvKey] = await Promise.all([
    deriveOne(myLabel, ["encrypt", "decrypt"]),
    deriveOne(peerLabel, ["decrypt"])
  ]);

  return { sendKey, recvKey, myLabel };
}

/**
 * Safety number for out-of-band peer verification: 25 decimal digits in
 * five groups, derived from both public keys. Both peers see the same
 * number; a MITM would produce a different one on each side.
 */
async function computeFingerprint(pubAB64, pubBB64) {
  const a = base64ToBytes(pubAB64);
  const b = base64ToBytes(pubBB64);
  const ordered = compareKeysB64(pubAB64, pubBB64) < 0 ? concatBytes(a, b) : concatBytes(b, a);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    concatBytes(utf8("pardeh:v2:fingerprint"), ordered)
  );

  const bytes = new Uint8Array(digest).slice(0, 10);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  const digits = value.toString().padStart(25, "0").slice(0, 25);
  return digits.match(/.{5}/g).join(" ");
}

function buildHandshakeMessage(kind, pubB64) {
  if (kind !== 1 && kind !== 2) throw new Error(`Invalid handshake kind: ${kind}`);
  return `[[E2EHS${kind}:v2:${pubB64}]]`;
}

/**
 * Parses handshake markers out of message text.
 * Returns { kind: 1|2, version: 1|2, pubB64 } or null.
 */
function parseHandshakeText(text) {
  if (!text || !text.includes("E2EHS")) return null;

  const v2 = text.match(HS_V2_RE);
  if (v2) return { kind: Number(v2[1]), version: 2, pubB64: v2[2] };

  const v1 = text.match(HS_V1_RE) || text.match(HS_V1_BARE_RE);
  if (v1) return { kind: Number(v1[1]), version: 1, pubB64: v1[2] };

  return null;
}

/**
 * Parses an encrypted message envelope.
 * Returns { version: 2, epoch, dir, ivB64, ctB64, envelope } |
 *         { version: 1, ivB64, ctB64, envelope } | null.
 */
function parseMessageEnvelope(text) {
  if (!text || !text.includes("E2EMSG:")) return null;

  const v2 = text.match(MSG_V2_RE);
  if (v2) {
    return {
      version: 2,
      epoch: Number(v2[1]),
      dir: v2[2],
      ivB64: v2[3],
      ctB64: v2[4],
      envelope: v2[0]
    };
  }

  const v1 = text.match(MSG_V1_RE);
  if (v1) {
    return { version: 1, ivB64: v1[1], ctB64: v1[2], envelope: v1[0] };
  }

  return null;
}

function gcmAad(epoch, dir) {
  return utf8(`pardeh:v2:${epoch}:${dir}`);
}

async function encryptEnvelope(sendKey, epoch, dir, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: gcmAad(epoch, dir) },
    sendKey,
    utf8(plaintext)
  );
  return `E2EMSG:v2:${epoch}:${dir}:${arrayBufferToBase64(iv)}:${arrayBufferToBase64(ciphertext)}`;
}

async function decryptEnvelopeV2(key, parsed) {
  const iv = base64ToBytes(parsed.ivB64);
  if (iv.length !== GCM_IV_LENGTH) {
    throw new Error(`Invalid IV length: ${iv.length}`);
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: gcmAad(parsed.epoch, parsed.dir) },
    key,
    base64ToBytes(parsed.ctB64)
  );
  return new TextDecoder().decode(plaintext);
}

// Legacy v1 envelopes: single shared key, no AAD. Kept for decrypting
// (and, until the user rotates, sending in) chats established before v2.
async function encryptLegacy(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    utf8(plaintext)
  );
  return `E2EMSG:${arrayBufferToBase64(iv)}:${arrayBufferToBase64(ciphertext)}`;
}

async function decryptLegacy(key, parsed) {
  const iv = base64ToBytes(parsed.ivB64);
  if (iv.length !== GCM_IV_LENGTH) {
    throw new Error(`Invalid IV length: ${iv.length}`);
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    base64ToBytes(parsed.ctB64)
  );
  return new TextDecoder().decode(plaintext);
}

async function importLegacyAesKey(keyB64) {
  return crypto.subtle.importKey(
    "raw",
    base64ToBytes(keyB64),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

const PardehCrypto = {
  PROTOCOL_VERSION,
  arrayBufferToBase64,
  base64ToBytes,
  validateRawP256PublicKeyB64,
  compareKeysB64,
  generateEcdhKeyPair,
  exportRawPublicKeyB64,
  importRawPublicKey,
  deriveDirectionalKeys,
  computeFingerprint,
  buildHandshakeMessage,
  parseHandshakeText,
  parseMessageEnvelope,
  encryptEnvelope,
  decryptEnvelopeV2,
  encryptLegacy,
  decryptLegacy,
  importLegacyAesKey
};

globalThis.PardehCrypto = PardehCrypto;
if (typeof module !== "undefined" && module.exports) {
  module.exports = PardehCrypto;
}
