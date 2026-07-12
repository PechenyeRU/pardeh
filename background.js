"use strict";

// Firefox exposes promise-based `browser.*`; Chrome exposes `chrome.*`.
const api = globalThis.browser ?? globalThis.chrome;

// Chrome runs this file as a classic service worker and pulls shared
// modules in via importScripts; the Firefox event page loads them from
// the manifest background.scripts list instead.
if (typeof importScripts === "function" && typeof globalThis.PardehCrypto === "undefined") {
  importScripts("crypto.js", "state-machine.js");
}

const Crypto = globalThis.PardehCrypto;
const SM = globalThis.PardehStateMachine;

const ENCRYPTION_PREFIX = "encryption_enabled_";
const META_PREFIX = "chat_meta_";
const LEGACY_KEY_PREFIX = "chat_key_";
const PEER_LEGACY_PREFIX = "peer_legacy_";
const SEEN_KEYS_PREFIX = "seen_pubkeys_";
const MAX_SEEN_KEYS = 40;
const HANDSHAKE_TTL_MS = 10 * 60 * 1000;
const CONTENT_SCRIPTS = ["crypto.js", "i18n.js", "content.js"];

// The composer runs in a child frame of the same tab, so every message
// aimed at the content script must name the top frame explicitly.
const TOP_FRAME_ID = 0;

const EMBLEM_KEY = "ui_emblem";
const EMBLEM_ALPHABET = [
  "🦊", "🐢", "🦉", "🐙", "🦁", "🐝", "🦋", "🐬", "🦜", "🦌",
  "🌵", "🍄", "🌻", "🍀", "🌙", "⭐", "🔥", "❄️", "⚡", "🌈",
  "🎈", "🎸", "🚀", "⛵", "🗝️", "🧭", "🎲", "🍉", "🍋", "🥝"
];

// Three emoji picked once per installation and shown inside the composer
// iframe. Page scripts cannot read that frame, so a look-alike composer
// drawn by the page cannot reproduce the emblem.
async function getEmblem() {
  const stored = await api.storage.local.get([EMBLEM_KEY]);
  if (stored[EMBLEM_KEY]) return stored[EMBLEM_KEY];

  const picks = [];
  const pool = [...EMBLEM_ALPHABET];
  const random = crypto.getRandomValues(new Uint32Array(3));
  for (let i = 0; i < 3; i++) {
    picks.push(pool.splice(random[i] % pool.length, 1)[0]);
  }

  const emblem = picks.join(" ");
  await api.storage.local.set({ [EMBLEM_KEY]: emblem });
  return emblem;
}

api.runtime.onInstalled?.addListener(() => {
  getEmblem().catch((err) => console.error("[E2E] emblem init failed:", err));
});

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const tabId = sender.tab?.id ?? message.tabId ?? null;

    switch (message.type) {
      case "ENCRYPT_TOGGLE":
        return handleEncryptionToggle(message.chatId, message.enabled);

      case "GET_CHAT_STATE":
        return handleGetChatState(message.chatId);

      case "HANDSHAKE_CLICK":
        return withChatLock(message.chatId, () =>
          handleHandshakeClick(message.chatId, tabId)
        );

      case "ROTATE_KEYS":
        return withChatLock(message.chatId, () =>
          handleRotateKeys(message.chatId, tabId)
        );

      case "HS_DETECTED":
        return withChatLock(message.chatId, () =>
          handleHandshakeDetected(
            message.chatId,
            message.kind,
            message.version,
            message.pubB64,
            tabId,
            message.historical === true
          )
        );

      case "ENCRYPT_MESSAGE":
        return handleEncryptMessage(message.chatId, message.text);

      case "SEND_ENCRYPTED":
        return handleSendEncrypted(message.chatId, message.text, tabId);

      case "COMPOSER_INIT":
        return handleComposerInit(tabId);

      case "COMPOSER_PANEL":
        return handleComposerPanel(tabId, message.open);

      case "GET_EMBLEM":
        return { success: true, emblem: await getEmblem() };

      case "DECRYPT_BATCH":
        return handleDecryptBatch(message.chatId, message.envelopes);

      case "CLEAR_CHAT_STATE":
        return withChatLock(message.chatId, () => handleClearChatState(message.chatId));

      default:
        return { success: false, error: "Unknown message type" };
    }
  })()
    .then(sendResponse)
    .catch((err) => {
      console.error("[E2E] Background handler error:", err);
      sendResponse({ success: false, error: String(err?.message || err) });
    });

  return true;
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleEncryptionToggle(chatId, enabled) {
  if (!chatId) return { success: false, error: "Missing chatId" };
  await api.storage.local.set({ [`${ENCRYPTION_PREFIX}${chatId}`]: !!enabled });
  return { success: true };
}

async function handleGetChatState(chatId) {
  if (!chatId) return { success: false, error: "Missing chatId" };

  const [stored, pending] = await Promise.all([
    api.storage.local.get([
      `${ENCRYPTION_PREFIX}${chatId}`,
      `${META_PREFIX}${chatId}`,
      `${LEGACY_KEY_PREFIX}${chatId}`,
      `${PEER_LEGACY_PREFIX}${chatId}`
    ]),
    getPending(chatId)
  ]);

  const meta = stored[`${META_PREFIX}${chatId}`] || null;

  // Read-only view: an expired pending is reported as absent so the UI
  // offers a fresh start instead of a dead "waiting for peer" state. The
  // pending itself is only retired by the next state-changing handler
  // through loadContext; this getter runs outside the chat lock.
  const live =
    pending && !SM.isExpired(pending, Date.now(), HANDSHAKE_TTL_MS) ? pending : null;

  return {
    success: true,
    enabled: !!stored[`${ENCRYPTION_PREFIX}${chatId}`],
    v2Ready: !!meta,
    legacyReady: !!stored[`${LEGACY_KEY_PREFIX}${chatId}`],
    epoch: meta?.epoch ?? 0,
    fingerprint: meta?.fingerprint ?? null,
    establishedAt: meta?.establishedAt ?? null,
    pendingStage: live?.stage ?? null,
    warnRekey: !!live?.warnRekey,
    peerLegacy: !!stored[`${PEER_LEGACY_PREFIX}${chatId}`]
  };
}

async function handleHandshakeClick(chatId, tabId) {
  if (!chatId) return { success: false, error: "Missing chatId" };

  const context = await loadContext(chatId);
  const act = SM.onHandshakeClick(context);

  switch (act.action) {
    case "send_hs1":
      return sendHs1(chatId, tabId);

    case "respond_hs2":
      return respondHs2(chatId, tabId, context, act);

    case "wait_for_hs2":
      return { success: true, action: "waiting_for_peer", reason: act.reason };

    case "already_ready":
      return { success: true, action: "already_ready" };

    default:
      return { success: false, error: `Unhandled action: ${act.action}` };
  }
}

async function handleRotateKeys(chatId, tabId) {
  if (!chatId) return { success: false, error: "Missing chatId" };

  // Rotation is an explicit fresh handshake. The current epoch keys stay
  // in place (and keep decrypting history) until the new epoch finalizes.
  await retirePending(chatId, await getPending(chatId));
  return sendHs1(chatId, tabId, { rotation: true });
}

async function handleHandshakeDetected(chatId, kind, version, pubB64, tabId, historical = false) {
  if (!chatId || !pubB64 || (kind !== 1 && kind !== 2)) {
    return { success: false, error: "Missing chatId, kind or pubB64" };
  }

  if (version === 1) {
    // Peer runs a pre-v2 build: no KDF, no directional keys. Never answer
    // a legacy handshake; flag it so the UI can ask the peer to update.
    await api.storage.local.set({ [`${PEER_LEGACY_PREFIX}${chatId}`]: Date.now() });
    return { success: true, ignored: true, reason: "legacy_handshake" };
  }

  try {
    Crypto.validateRawP256PublicKeyB64(pubB64);
  } catch (err) {
    return { success: false, error: "invalid_public_key", detail: String(err?.message || err) };
  }

  // A public key from any past epoch (or an offer already surfaced once)
  // is not a new rekey attempt. Without this, re-scanning the chat history
  // after a reload re-reads old [[E2EHS..]] messages and mistakes them for
  // fresh key offers — a false MITM warning on every reload of a chat that
  // has ever rotated keys.
  const seen = await getSeenKeys(chatId);
  if (seen.includes(pubB64)) {
    return { success: true, ignored: true, reason: "known_key" };
  }

  // A key that already belongs to ANOTHER chat can never be legitimate
  // here: every handshake uses a fresh keypair, so this is either a
  // marker mis-attributed while the user was switching chats or a replay
  // of one chat's handshake into another (a cross-chat impersonation
  // attempt). Acting on it would entangle the two chats' key state.
  if (await isKeyKnownElsewhere(chatId, pubB64)) {
    return { success: true, ignored: true, reason: "key_used_in_other_chat" };
  }

  const context = await loadContext(chatId);

  // Markers replayed from chat history may only complete a handshake this
  // side is still waiting on. Anything else (fresh offers, rekeys) must
  // arrive as a live message: re-reading old [[E2EHS..]] on every chat
  // open would otherwise resurrect stale offers. Decided here on the
  // authoritative pending state — the content script's snapshot can be
  // mid-refresh during a chat switch and must not be trusted for this.
  // The ignored key is ledgered as dead: it predates any handshake of
  // ours, so it must never complete one later either (a re-scan during a
  // future hs1_sent would otherwise finalize against a key whose private
  // half is long gone).
  if (historical && context.pending?.stage !== "hs1_sent") {
    await addSeenKey(chatId, pubB64);
    return { success: true, ignored: true, reason: "historical_marker" };
  }
  const act = kind === 1
    ? SM.onHs1Detected(context, pubB64)
    : SM.onHs2Detected(context, pubB64);

  switch (act.action) {
    case "ignore":
      return { success: true, ignored: true, reason: act.reason };

    case "store_peer_hs1":
      await putPending(chatId, { ...context.pending, peerHs1B64: act.peerPubB64 });
      return { success: true, action: "stored_peer_hs1" };

    case "store_awaiting_click":
      await putPending(chatId, {
        stage: "awaiting_click",
        peerHs1B64: act.peerPubB64,
        warnRekey: act.warnRekey,
        createdAt: Date.now()
      });
      // Remember the offered key so a reload does not re-surface it: the
      // awaiting_click pending state already persists and drives the UI.
      await addSeenKey(chatId, act.peerPubB64);
      return { success: true, action: "awaiting_click", warnRekey: act.warnRekey };

    case "respond_hs2":
      return respondHs2(chatId, tabId, context, act);

    case "finalize":
      return finalizeKey(chatId, context, act.peerPubB64);

    default:
      return { success: false, error: `Unhandled action: ${act.action}` };
  }
}

async function handleEncryptMessage(chatId, text) {
  if (!chatId || !text) return { success: false, error: "Missing chatId or text" };

  const meta = await getMeta(chatId);
  if (meta) {
    const row = await getChatKeys(chatId, meta.epoch);
    if (!row) {
      return { success: false, error: "key_missing", detail: "Key store lost; redo the handshake" };
    }
    const envelope = await Crypto.encryptEnvelope(row.sendKey, row.epoch, row.myLabel, text);
    return { success: true, envelope };
  }

  const legacyKey = await getLegacyKey(chatId);
  if (legacyKey) {
    const envelope = await Crypto.encryptLegacy(legacyKey, text);
    return { success: true, envelope, legacy: true };
  }

  return { success: false, error: "no_key" };
}

// The composer iframe resolves its chat id here rather than from a
// postMessage: a hostile page can impersonate the content script towards
// its own child frames, but it cannot answer for the background script.
async function handleComposerInit(tabId) {
  if (!tabId) return { success: false, error: "No tab" };

  let chatId = null;
  try {
    const res = await api.tabs.sendMessage(tabId, { type: "GET_CHAT_ID" }, { frameId: TOP_FRAME_ID });
    chatId = res?.chatId || null;
  } catch (_) {}

  return { success: true, chatId };
}

// The composer cannot resize its own iframe (the parent document owns the
// element) and page-level postMessage is untrusted in both directions, so
// a panel open/close travels composer -> background -> content script:
// page scripts cannot forge runtime messages.
async function handleComposerPanel(tabId, open) {
  if (!tabId) return { success: false, error: "No tab" };
  await sendMessageToTab(tabId, { type: "SET_COMPOSER_PANEL", open: !!open });
  return { success: true };
}

// Secure compose path: the plaintext comes from extension UI the page
// cannot observe (composer iframe or popup), gets encrypted here and
// only the envelope is ever injected into the page.
async function handleSendEncrypted(chatId, text, tabId) {
  if (!chatId || !text) return { success: false, error: "Missing chatId or text" };

  const encrypted = await handleEncryptMessage(chatId, text);
  if (!encrypted.success) return encrypted;

  await sendChatMessage(tabId, encrypted.envelope, chatId);
  return { success: true, legacy: encrypted.legacy };
}

async function handleDecryptBatch(chatId, envelopes) {
  if (!chatId || !Array.isArray(envelopes)) {
    return { success: false, error: "Missing chatId or envelopes" };
  }

  const results = [];
  for (const envelope of envelopes.slice(0, 200)) {
    results.push(await decryptOne(chatId, envelope));
  }
  return { success: true, results };
}

async function decryptOne(chatId, envelope) {
  const parsed = Crypto.parseMessageEnvelope(envelope);
  if (!parsed) return { ok: false, code: "bad_envelope" };

  if (parsed.version === 2) {
    // The envelope epoch is the *sender's* local counter, which can drift
    // from ours after partial re-handshakes or a one-sided clear. Try the
    // hinted epoch first, then every stored epoch for this chat: the GCM
    // auth tag (with the envelope fields as AAD) picks the right key.
    const rows = [];
    const hinted = await getChatKeys(chatId, parsed.epoch);
    if (hinted) rows.push(hinted);
    for (const row of await getAllChatKeys(chatId)) {
      if (row.id !== hinted?.id) rows.push(row);
    }
    if (!rows.length) return { ok: false, code: "no_key" };

    for (const row of rows) {
      try {
        const key = parsed.dir === row.myLabel ? row.sendKey : row.recvKey;
        return { ok: true, plaintext: await Crypto.decryptEnvelopeV2(key, parsed) };
      } catch (_) {
        // wrong epoch key or tampered message; try the next epoch
      }
    }
    return { ok: false, code: "auth_failed" };
  }

  try {
    const legacyKey = await getLegacyKey(chatId);
    if (!legacyKey) return { ok: false, code: "no_key" };
    return { ok: true, plaintext: await Crypto.decryptLegacy(legacyKey, parsed), legacy: true };
  } catch (_) {
    return { ok: false, code: "auth_failed" };
  }
}

async function handleClearChatState(chatId) {
  if (!chatId) return { success: false, error: "Missing chatId" };

  // Note: the seen-keys ledger is intentionally NOT removed. Bale's chat
  // history still holds every past [[E2EHS..]] message, and its message
  // list is virtualized — old nodes are re-added as the user scrolls, so
  // the observer keeps re-seeing them. Keeping the ledger means those old
  // markers stay ignored after a clear; a new handshake uses fresh keys
  // (never in the ledger) and still goes through.
  await api.storage.local.remove([
    `${ENCRYPTION_PREFIX}${chatId}`,
    `${META_PREFIX}${chatId}`,
    `${LEGACY_KEY_PREFIX}${chatId}`,
    `${PEER_LEGACY_PREFIX}${chatId}`
  ]);
  legacyKeyCache.delete(chatId);

  await retirePending(chatId, await getPending(chatId));
  await deleteAllChatKeys(chatId);

  return { success: true };
}

// ---------------------------------------------------------------------------
// Handshake actions
// ---------------------------------------------------------------------------

async function sendHs1(chatId, tabId, { rotation = false } = {}) {
  const keyPair = await Crypto.generateEcdhKeyPair();
  const ourPubB64 = await Crypto.exportRawPublicKeyB64(keyPair.publicKey);

  // Deliver first, persist after: if delivery fails nothing is stored and
  // the user simply retries the click from a clean state.
  await sendChatMessage(tabId, Crypto.buildHandshakeMessage(1, ourPubB64), chatId);

  // Ledger our own key the moment it is on the wire: once the pending
  // state expires or is cleared nothing else remembers this key, and a
  // history re-scan would read our own HS1 back as a fresh peer offer —
  // answering that offer completes a handshake with ourselves.
  await addSeenKey(chatId, ourPubB64);

  await putPending(chatId, {
    stage: "hs1_sent",
    ourPubB64,
    privateKey: keyPair.privateKey,
    createdAt: Date.now()
  });

  return { success: true, action: rotation ? "sent_hs1_rotation" : "sent_hs1" };
}

async function respondHs2(chatId, tabId, context, act) {
  Crypto.validateRawP256PublicKeyB64(act.peerPubB64);
  const peerPublicKey = await Crypto.importRawPublicKey(act.peerPubB64);

  let privateKey;
  let ourPubB64;
  if (act.reuseKeypair) {
    privateKey = context.pending.privateKey;
    ourPubB64 = context.pending.ourPubB64;
  } else {
    const keyPair = await Crypto.generateEcdhKeyPair();
    privateKey = keyPair.privateKey;
    ourPubB64 = await Crypto.exportRawPublicKeyB64(keyPair.publicKey);
  }

  // Deliver HS2 before persisting the epoch so a failed delivery leaves a
  // retryable state. A crash between the two steps loses the epoch and
  // requires a key rotation; that window is accepted for simplicity.
  await sendChatMessage(tabId, Crypto.buildHandshakeMessage(2, ourPubB64), chatId);

  const established = await establishEpoch(chatId, privateKey, peerPublicKey, ourPubB64, act.peerPubB64);
  return { success: true, action: "sent_hs2_key_established", ...established };
}

async function finalizeKey(chatId, context, peerPubB64) {
  Crypto.validateRawP256PublicKeyB64(peerPubB64);
  const peerPublicKey = await Crypto.importRawPublicKey(peerPubB64);

  const established = await establishEpoch(
    chatId,
    context.pending.privateKey,
    peerPublicKey,
    context.pending.ourPubB64,
    peerPubB64
  );
  return { success: true, action: "key_established", ...established };
}

async function establishEpoch(chatId, privateKey, peerPublicKey, ourPubB64, peerPubB64) {
  const meta = await getMeta(chatId);
  const epoch = (meta?.epoch ?? 0) + 1;

  const { sendKey, recvKey, myLabel } = await Crypto.deriveDirectionalKeys(
    privateKey,
    peerPublicKey,
    ourPubB64,
    peerPubB64
  );
  const fingerprint = await Crypto.computeFingerprint(ourPubB64, peerPubB64);

  await putChatKeys({
    id: `${chatId}:${epoch}`,
    chatId,
    epoch,
    myLabel,
    sendKey,
    recvKey,
    createdAt: Date.now()
  });

  await api.storage.local.set({
    [`${META_PREFIX}${chatId}`]: {
      v: 2,
      epoch,
      myLabel,
      ourPubB64,
      peerPubB64,
      fingerprint,
      establishedAt: Date.now()
    }
  });

  // Both keys of every epoch are "known": a later re-scan of their
  // handshake messages must not read as a new offer.
  await addSeenKey(chatId, ourPubB64, peerPubB64);
  await deletePending(chatId);

  return { epoch, fingerprint };
}

async function getSeenKeys(chatId) {
  const stored = await api.storage.local.get([`${SEEN_KEYS_PREFIX}${chatId}`]);
  return stored[`${SEEN_KEYS_PREFIX}${chatId}`] || [];
}

// True when the public key is already tied to a DIFFERENT chat: in its
// seen-keys ledger, in its established meta (ledgers are trimmed, metas
// are not) or announced by its in-flight handshake. Fresh keypairs per
// handshake make a legitimate cross-chat repeat impossible.
async function isKeyKnownElsewhere(chatId, pubB64) {
  const all = await api.storage.local.get(null);
  for (const [storageKey, value] of Object.entries(all)) {
    if (storageKey.startsWith(SEEN_KEYS_PREFIX)) {
      if (storageKey === `${SEEN_KEYS_PREFIX}${chatId}`) continue;
      if (Array.isArray(value) && value.includes(pubB64)) return true;
    } else if (storageKey.startsWith(META_PREFIX)) {
      if (storageKey === `${META_PREFIX}${chatId}`) continue;
      if (value?.ourPubB64 === pubB64 || value?.peerPubB64 === pubB64) return true;
    }
  }

  for (const pending of await getAllPendings()) {
    if (pending.chatId === chatId) continue;
    if (pending.ourPubB64 === pubB64 || pending.peerHs1B64 === pubB64) return true;
  }

  return false;
}

async function addSeenKey(chatId, ...keys) {
  const current = await getSeenKeys(chatId);
  const merged = [...current];
  for (const key of keys) {
    if (key && !merged.includes(key)) merged.push(key);
  }
  // Bound the list; oldest keys fall off first.
  const trimmed = merged.slice(-MAX_SEEN_KEYS);
  await api.storage.local.set({ [`${SEEN_KEYS_PREFIX}${chatId}`]: trimmed });
}

// ---------------------------------------------------------------------------
// State access
// ---------------------------------------------------------------------------

async function loadContext(chatId) {
  let pending = await getPending(chatId);
  if (pending && SM.isExpired(pending, Date.now(), HANDSHAKE_TTL_MS)) {
    await retirePending(chatId, pending);
    pending = null;
  }
  const keyMeta = await getMeta(chatId);
  return { pending, keyMeta };
}

// Drop an in-flight handshake, first ledgering the key it announced (if
// any). Pendings written by builds that predate the sendHs1 ledgering
// only remember their key here: without this, their HS1 in chat history
// would resurface as a peer offer after the pending is gone.
async function retirePending(chatId, pending) {
  if (pending?.ourPubB64) await addSeenKey(chatId, pending.ourPubB64);
  await deletePending(chatId);
}

async function getMeta(chatId) {
  const stored = await api.storage.local.get([`${META_PREFIX}${chatId}`]);
  return stored[`${META_PREFIX}${chatId}`] || null;
}

const legacyKeyCache = new Map();

function getLegacyKey(chatId) {
  if (!legacyKeyCache.has(chatId)) {
    const promise = (async () => {
      const stored = await api.storage.local.get([`${LEGACY_KEY_PREFIX}${chatId}`]);
      const keyB64 = stored[`${LEGACY_KEY_PREFIX}${chatId}`];
      return keyB64 ? Crypto.importLegacyAesKey(keyB64) : null;
    })();
    promise.catch(() => legacyKeyCache.delete(chatId));
    legacyKeyCache.set(chatId, promise);
  }
  return legacyKeyCache.get(chatId);
}

// ---------------------------------------------------------------------------
// Per-chat mutex: handshake handlers for the same chat run serialized, so
// concurrent clicks or overlapping detections cannot interleave state
// reads and writes (a rapid double click would otherwise send two HS1
// with two different keypairs).
// ---------------------------------------------------------------------------

const chatLocks = new Map();

function withChatLock(chatId, fn) {
  const prev = chatLocks.get(chatId) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const guard = run.catch(() => {});
  chatLocks.set(chatId, guard);
  guard.then(() => {
    if (chatLocks.get(chatId) === guard) chatLocks.delete(chatId);
  });
  return run;
}

// ---------------------------------------------------------------------------
// IndexedDB key store. CryptoKey objects are structured-cloneable, so the
// non-extractable private keys and AES keys are persisted as-is: they
// survive service worker and browser restarts but can never be exported,
// unlike the JWK-in-storage approach this replaces.
//   "pending"  chatId -> in-flight handshake (incl. ECDH private key)
//   "chatKeys" `${chatId}:${epoch}` -> directional AES keys per epoch
// ---------------------------------------------------------------------------

const DB_NAME = "pardeh-keys";
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("pending", { keyPath: "chatId" });
        const keys = db.createObjectStore("chatKeys", { keyPath: "id" });
        keys.createIndex("chatId", "chatId", { unique: false });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

async function idbRequest(storeName, mode, operate) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = operate(tx.objectStore(storeName));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getPending(chatId) {
  const row = await idbRequest("pending", "readonly", (s) => s.get(chatId));
  return row || null;
}

async function getAllPendings() {
  const rows = await idbRequest("pending", "readonly", (s) => s.getAll());
  return rows || [];
}

function putPending(chatId, pending) {
  return idbRequest("pending", "readwrite", (s) => s.put({ ...pending, chatId }));
}

function deletePending(chatId) {
  return idbRequest("pending", "readwrite", (s) => s.delete(chatId));
}

async function getChatKeys(chatId, epoch) {
  const row = await idbRequest("chatKeys", "readonly", (s) => s.get(`${chatId}:${epoch}`));
  return row || null;
}

function putChatKeys(row) {
  return idbRequest("chatKeys", "readwrite", (s) => s.put(row));
}

async function getAllChatKeys(chatId) {
  const rows = await idbRequest("chatKeys", "readonly", (s) =>
    s.index("chatId").getAll(chatId)
  );
  // Newest epochs first: most likely to match current traffic.
  return (rows || []).sort((a, b) => b.epoch - a.epoch);
}

async function deleteAllChatKeys(chatId) {
  const keys = await idbRequest("chatKeys", "readonly", (s) =>
    s.index("chatId").getAllKeys(chatId)
  );
  for (const key of keys || []) {
    await idbRequest("chatKeys", "readwrite", (s) => s.delete(key));
  }
}

// ---------------------------------------------------------------------------
// Tab plumbing
// ---------------------------------------------------------------------------

// Injecting into "the open chat" is not enough: between the decision and
// the injection the user may have switched chats, and a handshake marker
// or envelope landing in the wrong one poisons both chats' key state. The
// payload names its chat and the content script refuses to deliver it
// anywhere else; a refusal is terminal — retrying would just target
// whatever chat comes next.
async function sendChatMessage(tabId, text, chatId) {
  if (!chatId) throw new Error("missing_chat_id");
  const targetTabId = tabId ?? (await getActiveBaleTabId());
  if (!targetTabId) throw new Error("No Bale tab found");
  const res = await sendMessageToTab(targetTabId, { type: "SEND_CHAT_MESSAGE", text, chatId });
  if (!res?.success) throw new Error(res?.error || "delivery_failed");
}

async function getActiveBaleTabId() {
  const active = await api.tabs.query({ active: true, currentWindow: true, url: "*://web.bale.ai/*" });
  if (active.length > 0) return active[0].id ?? null;

  const any = await api.tabs.query({ url: "*://web.bale.ai/*" });
  return any[0]?.id ?? null;
}

async function sendMessageToTab(tabId, message, retries = 2) {
  await ensureContentScript(tabId);

  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      return await api.tabs.sendMessage(tabId, message, { frameId: TOP_FRAME_ID });
    } catch (err) {
      lastErr = err;
      await sleep(300);
    }
  }

  throw lastErr || new Error("Failed to send message to tab");
}

async function ensureContentScript(tabId) {
  try {
    await api.tabs.sendMessage(tabId, { type: "PING" }, { frameId: TOP_FRAME_ID });
    return;
  } catch (_) {}

  if (api.scripting?.executeScript) {
    await api.scripting.executeScript({
      target: { tabId },
      files: CONTENT_SCRIPTS
    });
  } else {
    // Firefox MV2 fallback.
    for (const file of CONTENT_SCRIPTS) {
      await api.tabs.executeScript(tabId, { file });
    }
  }

  await sleep(250);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
