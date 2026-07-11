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
      if (message.type === "SEND_CHAT_MESSAGE") sentToTab.push(message.text);
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
  const parsed = Crypto.parseHandshakeText(sentToTab[sentToTab.length - 1]);
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
