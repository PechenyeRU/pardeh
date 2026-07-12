"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Environment stubs. background.js targets the extension runtime, so the
// browser surface it touches (storage.local, runtime.onMessage, tabs,
// indexedDB) is faked here and the file is loaded once via require().
// ---------------------------------------------------------------------------

const storageData = new Map();
const sentToTab = [];
let onMessageListener = null;
let tabRefusesDelivery = false;

function fakeIndexedDb() {
  const stores = new Map();

  function request(fn) {
    const req = {};
    queueMicrotask(() => {
      try {
        req.result = fn();
        req.onsuccess?.();
      } catch (err) {
        req.error = err;
        req.onerror?.();
      }
    });
    return req;
  }

  const db = {
    createObjectStore(name, opts) {
      const store = { rows: new Map(), keyPath: opts.keyPath, indexes: {} };
      stores.set(name, store);
      return {
        createIndex(indexName, keyPath) {
          store.indexes[indexName] = keyPath;
        }
      };
    },
    transaction(name) {
      return {
        objectStore(storeName) {
          const store = stores.get(storeName);
          return {
            get: (key) => request(() => store.rows.get(key)),
            getAll: () => request(() => [...store.rows.values()]),
            put: (value) => request(() => store.rows.set(value[store.keyPath], value)),
            delete: (key) => request(() => store.rows.delete(key)),
            index: (indexName) => ({
              getAll: (val) =>
                request(() =>
                  [...store.rows.values()].filter((r) => r[store.indexes[indexName]] === val)
                ),
              getAllKeys: (val) =>
                request(() =>
                  [...store.rows.entries()]
                    .filter(([, r]) => r[store.indexes[indexName]] === val)
                    .map(([k]) => k)
                )
            })
          };
        }
      };
    }
  };

  return {
    stores,
    open() {
      const req = { result: db };
      queueMicrotask(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    }
  };
}

const idb = fakeIndexedDb();
globalThis.indexedDB = idb;

globalThis.browser = {
  storage: {
    local: {
      async get(keys) {
        // get(null) returns the whole store, like the real API.
        if (keys === null || keys === undefined) return Object.fromEntries(storageData);
        const out = {};
        for (const key of keys) if (storageData.has(key)) out[key] = storageData.get(key);
        return out;
      },
      async set(obj) {
        for (const [key, value] of Object.entries(obj)) storageData.set(key, value);
      },
      async remove(keys) {
        for (const key of [].concat(keys)) storageData.delete(key);
      }
    }
  },
  runtime: {
    onMessage: {
      addListener(fn) {
        onMessageListener = fn;
      }
    }
  },
  tabs: {
    async sendMessage(tabId, message) {
      if (message.type === "SEND_CHAT_MESSAGE") {
        // The content script refuses payloads for a chat that is not on
        // screen; tests flip this to exercise the fail-closed path.
        if (tabRefusesDelivery) return { success: false, error: "wrong_chat" };
        sentToTab.push({ text: message.text, chatId: message.chatId });
        return { success: true };
      }
      return {};
    },
    async query() {
      return [{ id: 1 }];
    }
  }
};

const Crypto = require("../crypto.js");
require("../state-machine.js");
require("../background.js");

function call(message) {
  return new Promise((resolve) => {
    onMessageListener(message, { tab: { id: 1 } }, resolve);
  });
}

function lastSentHandshake() {
  const parsed = Crypto.parseHandshakeText(sentToTab[sentToTab.length - 1].text);
  assert.ok(parsed, "expected the last tab message to be a handshake");
  return parsed;
}

function expirePending(chatId) {
  const row = idb.stores.get("pending").rows.get(chatId);
  assert.ok(row, "expected a pending handshake to expire");
  row.createdAt -= 11 * 60 * 1000; // past the 10 minute TTL
}

async function makePeer() {
  const kp = await Crypto.generateEcdhKeyPair();
  return { kp, pubB64: await Crypto.exportRawPublicKeyB64(kp.publicKey) };
}

let chatCounter = 0;
let chatId;

beforeEach(() => {
  // Fresh chat per test: state is namespaced by chatId, so no cross-talk.
  chatId = `chat-${++chatCounter}`;
  sentToTab.length = 0;
  tabRefusesDelivery = false;
});

// ---------------------------------------------------------------------------
// Regression: a reload after the pending handshake expired must not read
// our own HS1 back from chat history as a fresh peer offer.
// ---------------------------------------------------------------------------

test("own hs1 re-scanned after pending expiry is ignored", async () => {
  const click = await call({ type: "HANDSHAKE_CLICK", chatId, tabId: 1 });
  assert.equal(click.action, "sent_hs1");
  const ourPubB64 = lastSentHandshake().pubB64;

  expirePending(chatId);

  const res = await call({
    type: "HS_DETECTED", chatId, kind: 1, version: 2, pubB64: ourPubB64, tabId: 1
  });
  assert.equal(res.ignored, true);

  const state = await call({ type: "GET_CHAT_STATE", chatId });
  assert.equal(state.pendingStage, null, "own key must not become a peer offer");
});

test("own hs1 re-scanned after clear chat state is ignored", async () => {
  await call({ type: "HANDSHAKE_CLICK", chatId, tabId: 1 });
  const ourPubB64 = lastSentHandshake().pubB64;

  await call({ type: "CLEAR_CHAT_STATE", chatId });

  const res = await call({
    type: "HS_DETECTED", chatId, kind: 1, version: 2, pubB64: ourPubB64, tabId: 1
  });
  assert.equal(res.ignored, true);

  const state = await call({ type: "GET_CHAT_STATE", chatId });
  assert.equal(state.pendingStage, null);
});

test("rotation retires the previous unanswered hs1", async () => {
  await call({ type: "HANDSHAKE_CLICK", chatId, tabId: 1 });
  const firstPubB64 = lastSentHandshake().pubB64;

  const rotate = await call({ type: "ROTATE_KEYS", chatId, tabId: 1 });
  assert.equal(rotate.action, "sent_hs1_rotation");
  const secondPubB64 = lastSentHandshake().pubB64;
  assert.notEqual(firstPubB64, secondPubB64);

  expirePending(chatId);

  for (const pubB64 of [firstPubB64, secondPubB64]) {
    const res = await call({
      type: "HS_DETECTED", chatId, kind: 1, version: 2, pubB64, tabId: 1
    });
    assert.equal(res.ignored, true);
  }

  const state = await call({ type: "GET_CHAT_STATE", chatId });
  assert.equal(state.pendingStage, null);
});

// ---------------------------------------------------------------------------
// Guard: ledgering our own keys must not get in the way of a real peer.
// ---------------------------------------------------------------------------

test("peer hs2 still finalizes after our hs1", async () => {
  await call({ type: "HANDSHAKE_CLICK", chatId, tabId: 1 });

  const peer = await makePeer();
  const res = await call({
    type: "HS_DETECTED", chatId, kind: 2, version: 2, pubB64: peer.pubB64, tabId: 1
  });
  assert.equal(res.action, "key_established");

  const state = await call({ type: "GET_CHAT_STATE", chatId });
  assert.equal(state.v2Ready, true);
  assert.equal(state.epoch, 1);
});

test("peer hs1 after our expired hs1 surfaces as a fresh offer", async () => {
  await call({ type: "HANDSHAKE_CLICK", chatId, tabId: 1 });
  expirePending(chatId);

  const peer = await makePeer();
  const res = await call({
    type: "HS_DETECTED", chatId, kind: 1, version: 2, pubB64: peer.pubB64, tabId: 1
  });
  assert.equal(res.action, "awaiting_click");

  const state = await call({ type: "GET_CHAT_STATE", chatId });
  assert.equal(state.pendingStage, "awaiting_click");
});

// ---------------------------------------------------------------------------
// Regression: an established session in one chat and an in-flight handshake
// in another must never interact — key state, rotation and outgoing
// messages all stay bound to their own chat.
// ---------------------------------------------------------------------------

async function establishChat(id) {
  await call({ type: "HANDSHAKE_CLICK", chatId: id, tabId: 1 });
  const peer = await makePeer();
  const res = await call({
    type: "HS_DETECTED", chatId: id, kind: 2, version: 2, pubB64: peer.pubB64, tabId: 1
  });
  assert.equal(res.action, "key_established");
  return peer;
}

test("handshake in one chat leaves an established session in another untouched", async () => {
  const chatA = `${chatId}-A`;
  const chatB = `${chatId}-B`;

  await establishChat(chatA);
  const before = await call({ type: "GET_CHAT_STATE", chatId: chatA });

  // Start and complete a fresh handshake in chat B.
  await call({ type: "HANDSHAKE_CLICK", chatId: chatB, tabId: 1 });
  const peerB = await makePeer();
  const resB = await call({
    type: "HS_DETECTED", chatId: chatB, kind: 2, version: 2, pubB64: peerB.pubB64, tabId: 1
  });
  assert.equal(resB.action, "key_established");

  const after = await call({ type: "GET_CHAT_STATE", chatId: chatA });
  assert.equal(after.epoch, before.epoch, "chat A epoch must not move");
  assert.equal(after.fingerprint, before.fingerprint, "chat A fingerprint must not change");
  assert.equal(after.pendingStage, null, "chat A must not gain a pending handshake");

  const stateB = await call({ type: "GET_CHAT_STATE", chatId: chatB });
  assert.notEqual(stateB.fingerprint, after.fingerprint);
});

test("rotation is scoped to its own chat", async () => {
  const chatA = `${chatId}-A`;
  const chatB = `${chatId}-B`;

  await establishChat(chatA);
  await establishChat(chatB);
  const beforeA = await call({ type: "GET_CHAT_STATE", chatId: chatA });

  const rotate = await call({ type: "ROTATE_KEYS", chatId: chatB, tabId: 1 });
  assert.equal(rotate.action, "sent_hs1_rotation");

  const afterA = await call({ type: "GET_CHAT_STATE", chatId: chatA });
  assert.equal(afterA.pendingStage, null, "rotating chat B must not open a pending in chat A");
  assert.equal(afterA.fingerprint, beforeA.fingerprint);

  const stateB = await call({ type: "GET_CHAT_STATE", chatId: chatB });
  assert.equal(stateB.pendingStage, "hs1_sent");
});

test("every outgoing chat message names the chat it belongs to", async () => {
  const chatA = `${chatId}-A`;
  const chatB = `${chatId}-B`;

  await establishChat(chatA);
  await call({ type: "HANDSHAKE_CLICK", chatId: chatB, tabId: 1 });
  await call({ type: "SEND_ENCRYPTED", chatId: chatA, text: "hello", tabId: 1 });

  assert.ok(sentToTab.length >= 3);
  for (const sent of sentToTab) {
    assert.ok(
      sent.chatId === chatA || sent.chatId === chatB,
      "outgoing payload must carry a chat id"
    );
  }
  const envelopeMsg = sentToTab[sentToTab.length - 1];
  assert.equal(envelopeMsg.chatId, chatA, "envelope must be bound to the chat it was encrypted for");
  assert.ok(Crypto.parseMessageEnvelope(envelopeMsg.text));
});

test("refused delivery leaves no handshake state behind", async () => {
  tabRefusesDelivery = true;

  const res = await call({ type: "HANDSHAKE_CLICK", chatId, tabId: 1 });
  assert.equal(res.success, false);

  const state = await call({ type: "GET_CHAT_STATE", chatId });
  assert.equal(state.pendingStage, null, "a refused HS1 must not persist a pending");
  assert.equal(state.v2Ready, false);
});

// ---------------------------------------------------------------------------
// Cross-chat key refusal: a public key already tied to another chat can
// never be a legitimate handshake here — neither as an offer nor as an
// HS2 that would silently finalize against the wrong peer key.
// ---------------------------------------------------------------------------

test("a key ledgered in another chat is refused as an offer", async () => {
  const chatA = `${chatId}-A`;
  const chatB = `${chatId}-B`;

  const peerA = await makePeer();
  const offer = await call({
    type: "HS_DETECTED", chatId: chatA, kind: 1, version: 2, pubB64: peerA.pubB64, tabId: 1
  });
  assert.equal(offer.action, "awaiting_click");

  const res = await call({
    type: "HS_DETECTED", chatId: chatB, kind: 1, version: 2, pubB64: peerA.pubB64, tabId: 1
  });
  assert.equal(res.ignored, true);
  assert.equal(res.reason, "key_used_in_other_chat");

  const stateB = await call({ type: "GET_CHAT_STATE", chatId: chatB });
  assert.equal(stateB.pendingStage, null);
});

test("another chat's peer key cannot finalize our pending handshake", async () => {
  const chatA = `${chatId}-A`;
  const chatB = `${chatId}-B`;

  // Chat A established: its peer key sits in A's meta and ledger.
  const peerA = await establishChat(chatA);

  // Chat B is waiting on its own HS1; A's peer key must not complete it —
  // this is exactly the mis-attribution that entangled two chats.
  await call({ type: "HANDSHAKE_CLICK", chatId: chatB, tabId: 1 });
  const res = await call({
    type: "HS_DETECTED", chatId: chatB, kind: 2, version: 2, pubB64: peerA.pubB64, tabId: 1
  });
  assert.equal(res.ignored, true);
  assert.equal(res.reason, "key_used_in_other_chat");

  const stateB = await call({ type: "GET_CHAT_STATE", chatId: chatB });
  assert.equal(stateB.v2Ready, false, "chat B must not establish against chat A's key");
  assert.equal(stateB.pendingStage, "hs1_sent", "chat B keeps waiting for its real peer");
});

// ---------------------------------------------------------------------------
// Historical markers: decided on the background's authoritative pending
// state, not the content script's (possibly mid-refresh) snapshot.
// ---------------------------------------------------------------------------

test("historical hs1 with no pending handshake is ignored", async () => {
  const peer = await makePeer();
  const res = await call({
    type: "HS_DETECTED", chatId, kind: 1, version: 2, pubB64: peer.pubB64,
    historical: true, tabId: 1
  });
  assert.equal(res.ignored, true);
  assert.equal(res.reason, "historical_marker");

  const state = await call({ type: "GET_CHAT_STATE", chatId });
  assert.equal(state.pendingStage, null, "history must not resurrect offers");
});

test("historical hs1 must not raise a rekey warning on an established chat", async () => {
  await establishChat(chatId);

  const stranger = await makePeer();
  const res = await call({
    type: "HS_DETECTED", chatId, kind: 1, version: 2, pubB64: stranger.pubB64,
    historical: true, tabId: 1
  });
  assert.equal(res.ignored, true);
  assert.equal(res.reason, "historical_marker");

  const state = await call({ type: "GET_CHAT_STATE", chatId });
  assert.equal(state.warnRekey, false);
  assert.equal(state.pendingStage, null);
});

test("an ignored historical marker stays dead for later handshakes", async () => {
  // Old markers sit in the chat history from a previous install whose
  // keys are gone. Scanned while idle they are ignored AND ledgered…
  const stale = await makePeer();
  const first = await call({
    type: "HS_DETECTED", chatId, kind: 2, version: 2, pubB64: stale.pubB64,
    historical: true, tabId: 1
  });
  assert.equal(first.reason, "historical_marker");

  // …so a re-scan during a live handshake cannot finalize against them.
  await call({ type: "HANDSHAKE_CLICK", chatId, tabId: 1 });
  const replay = await call({
    type: "HS_DETECTED", chatId, kind: 2, version: 2, pubB64: stale.pubB64,
    historical: true, tabId: 1
  });
  assert.equal(replay.ignored, true);
  assert.equal(replay.reason, "known_key");

  const state = await call({ type: "GET_CHAT_STATE", chatId });
  assert.equal(state.v2Ready, false, "dead key must not establish a session");
  assert.equal(state.pendingStage, "hs1_sent", "still waiting for the real peer");
});

test("historical hs2 still completes our in-flight handshake", async () => {
  await call({ type: "HANDSHAKE_CLICK", chatId, tabId: 1 });

  const peer = await makePeer();
  const res = await call({
    type: "HS_DETECTED", chatId, kind: 2, version: 2, pubB64: peer.pubB64,
    historical: true, tabId: 1
  });
  assert.equal(res.action, "key_established");

  const state = await call({ type: "GET_CHAT_STATE", chatId });
  assert.equal(state.v2Ready, true);
});
