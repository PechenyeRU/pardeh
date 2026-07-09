"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const SM = require("../state-machine.js");

// Deterministic fake keys: same length, known ordering.
const LOW_KEY = "A".repeat(88);
const HIGH_KEY = "Z".repeat(88);
const OTHER_KEY = "M".repeat(88);

test("click with no state sends hs1", () => {
  const act = SM.onHandshakeClick({ pending: null, keyMeta: null });
  assert.equal(act.action, "send_hs1");
});

test("click with an established key is a no-op", () => {
  const act = SM.onHandshakeClick({
    pending: null,
    keyMeta: { ourPubB64: LOW_KEY, peerPubB64: HIGH_KEY, epoch: 1 }
  });
  assert.equal(act.action, "already_ready");
});

test("click after receiving an offer responds with a fresh keypair", () => {
  const act = SM.onHandshakeClick({
    pending: { stage: "awaiting_click", peerHs1B64: HIGH_KEY, createdAt: 1 },
    keyMeta: null
  });
  assert.equal(act.action, "respond_hs2");
  assert.equal(act.peerPubB64, HIGH_KEY);
  assert.equal(act.reuseKeypair, false);
});

test("click while waiting without peer offer stays idempotent", () => {
  const act = SM.onHandshakeClick({
    pending: { stage: "hs1_sent", ourPubB64: LOW_KEY, createdAt: 1 },
    keyMeta: null
  });
  assert.equal(act.action, "wait_for_hs2");
});

test("simultaneous hs1: exactly one deterministic responder", () => {
  const actLow = SM.onHs1Detected(
    { pending: { stage: "hs1_sent", ourPubB64: LOW_KEY, createdAt: 1 }, keyMeta: null },
    HIGH_KEY
  );
  const actHigh = SM.onHs1Detected(
    { pending: { stage: "hs1_sent", ourPubB64: HIGH_KEY, createdAt: 1 }, keyMeta: null },
    LOW_KEY
  );

  assert.equal(actLow.action, "store_peer_hs1");
  assert.equal(actHigh.action, "respond_hs2");
  assert.equal(actHigh.reuseKeypair, true);
  assert.equal(actHigh.peerPubB64, LOW_KEY);
});

test("simultaneous click after both stored the peer offer converges too", () => {
  const actLow = SM.onHandshakeClick({
    pending: { stage: "hs1_sent", ourPubB64: LOW_KEY, peerHs1B64: HIGH_KEY, createdAt: 1 },
    keyMeta: null
  });
  const actHigh = SM.onHandshakeClick({
    pending: { stage: "hs1_sent", ourPubB64: HIGH_KEY, peerHs1B64: LOW_KEY, createdAt: 1 },
    keyMeta: null
  });

  assert.equal(actLow.action, "wait_for_hs2");
  assert.equal(actHigh.action, "respond_hs2");
});

test("own echoes are ignored regardless of role", () => {
  // pending echo
  let act = SM.onHs1Detected(
    { pending: { stage: "hs1_sent", ourPubB64: LOW_KEY, createdAt: 1 }, keyMeta: null },
    LOW_KEY
  );
  assert.deepEqual(act, { action: "ignore", reason: "own_echo" });

  // established-key echo (hs2 case)
  act = SM.onHs2Detected(
    { pending: null, keyMeta: { ourPubB64: HIGH_KEY, peerPubB64: LOW_KEY, epoch: 1 } },
    HIGH_KEY
  );
  assert.deepEqual(act, { action: "ignore", reason: "own_echo" });
});

test("historical handshake rescans are ignored", () => {
  const keyMeta = { ourPubB64: LOW_KEY, peerPubB64: HIGH_KEY, epoch: 1 };

  assert.deepEqual(SM.onHs1Detected({ pending: null, keyMeta }, HIGH_KEY), {
    action: "ignore",
    reason: "known_peer_key"
  });
  assert.deepEqual(SM.onHs2Detected({ pending: null, keyMeta }, HIGH_KEY), {
    action: "ignore",
    reason: "known_peer_key"
  });
});

test("fresh offer over an established key requires explicit accept with warning", () => {
  const act = SM.onHs1Detected(
    { pending: null, keyMeta: { ourPubB64: LOW_KEY, peerPubB64: HIGH_KEY, epoch: 1 } },
    OTHER_KEY
  );
  assert.equal(act.action, "store_awaiting_click");
  assert.equal(act.warnRekey, true);
});

test("first offer with no state awaits a click without warning", () => {
  const act = SM.onHs1Detected({ pending: null, keyMeta: null }, OTHER_KEY);
  assert.equal(act.action, "store_awaiting_click");
  assert.equal(act.warnRekey, false);
});

test("duplicate offers are ignored", () => {
  let act = SM.onHs1Detected(
    { pending: { stage: "hs1_sent", ourPubB64: LOW_KEY, peerHs1B64: HIGH_KEY, createdAt: 1 }, keyMeta: null },
    HIGH_KEY
  );
  assert.deepEqual(act, { action: "ignore", reason: "duplicate_hs1" });

  act = SM.onHs1Detected(
    { pending: { stage: "awaiting_click", peerHs1B64: HIGH_KEY, createdAt: 1 }, keyMeta: null },
    HIGH_KEY
  );
  assert.deepEqual(act, { action: "ignore", reason: "duplicate_hs1" });
});

test("hs2 finalizes only from the initiator state", () => {
  const act = SM.onHs2Detected(
    { pending: { stage: "hs1_sent", ourPubB64: LOW_KEY, createdAt: 1 }, keyMeta: null },
    HIGH_KEY
  );
  assert.equal(act.action, "finalize");
  assert.equal(act.peerPubB64, HIGH_KEY);

  const unexpected = SM.onHs2Detected({ pending: null, keyMeta: null }, HIGH_KEY);
  assert.deepEqual(unexpected, { action: "ignore", reason: "unexpected_hs2" });
});

test("pending expiry", () => {
  const pending = { stage: "hs1_sent", ourPubB64: LOW_KEY, createdAt: 1000 };
  assert.equal(SM.isExpired(pending, 1000 + 5, 60_000), false);
  assert.equal(SM.isExpired(pending, 1000 + 60_001, 60_000), true);
  assert.equal(SM.isExpired(null, 99999, 60_000), false);
});
