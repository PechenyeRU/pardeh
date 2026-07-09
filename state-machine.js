"use strict";

/**
 * Pardeh handshake state machine — pure decision logic, no I/O.
 *
 * The background script owns storage and crypto; this module only decides
 * what to do next, so every transition is unit-testable. All handlers take
 * a context snapshot and return an action object:
 *
 *   context = {
 *     pending: null
 *       | { stage: "hs1_sent", ourPubB64, peerHs1B64?, createdAt }
 *       | { stage: "awaiting_click", peerHs1B64, createdAt, warnRekey? },
 *     keyMeta: null | { ourPubB64, peerPubB64, epoch }   // established key
 *   }
 *
 * Role tie-break: when both parties clicked first (both sent HS1), each
 * side compares its own public key with the peer's using the same
 * deterministic order (compareKeysB64). The side with the SMALLER key
 * stays initiator and waits for HS2; the side with the LARGER key becomes
 * responder and answers with HS2 reusing its already-sent keypair. Both
 * sides reach the same conclusion independently, so exactly one HS2 is
 * produced and both derive the same secret from the same two keypairs.
 *
 * Echo handling is role-independent: any detected key equal to one of our
 * own public keys (pending or established) is dropped as an echo.
 */

// Kept dependency-free: any deterministic total order shared by both
// peers works for the tie-break, so plain string comparison is enough.
function compareKeys(aB64, bB64) {
  if (aB64 === bB64) return 0;
  return aB64 < bB64 ? -1 : 1;
}

function isOwnKey(context, pubB64) {
  return (
    pubB64 === context.pending?.ourPubB64 ||
    pubB64 === context.keyMeta?.ourPubB64
  );
}

/** User pressed the handshake button. */
function onHandshakeClick(context) {
  const { pending, keyMeta } = context;

  if (pending?.stage === "awaiting_click") {
    return {
      action: "respond_hs2",
      peerPubB64: pending.peerHs1B64,
      reuseKeypair: false
    };
  }

  if (pending?.stage === "hs1_sent") {
    if (!pending.peerHs1B64) {
      return { action: "wait_for_hs2", reason: "hs1_already_sent" };
    }

    const cmp = compareKeys(pending.ourPubB64, pending.peerHs1B64);
    if (cmp > 0) {
      return {
        action: "respond_hs2",
        peerPubB64: pending.peerHs1B64,
        reuseKeypair: true
      };
    }
    return { action: "wait_for_hs2", reason: "initiator_role" };
  }

  if (keyMeta) {
    return { action: "already_ready" };
  }

  return { action: "send_hs1" };
}

/** A handshake step 1 (public key offer) appeared in the chat. */
function onHs1Detected(context, pubB64) {
  const { pending, keyMeta } = context;

  if (isOwnKey(context, pubB64)) {
    return { action: "ignore", reason: "own_echo" };
  }
  if (pubB64 === keyMeta?.peerPubB64) {
    return { action: "ignore", reason: "known_peer_key" };
  }

  if (pending?.stage === "hs1_sent") {
    if (pending.peerHs1B64 === pubB64) {
      return { action: "ignore", reason: "duplicate_hs1" };
    }

    const cmp = compareKeys(pending.ourPubB64, pubB64);
    if (cmp > 0) {
      // We hold the larger key: deterministic responder. Answer with HS2
      // built from the keypair we already announced in our own HS1.
      return { action: "respond_hs2", peerPubB64: pubB64, reuseKeypair: true };
    }
    // We hold the smaller key: stay initiator, remember the peer offer and
    // wait for the peer (who runs the same tie-break) to answer with HS2.
    return { action: "store_peer_hs1", peerPubB64: pubB64 };
  }

  if (pending?.stage === "awaiting_click" && pending.peerHs1B64 === pubB64) {
    return { action: "ignore", reason: "duplicate_hs1" };
  }

  // A fresh offer while a key is already established is either a peer key
  // rotation or a MITM attempt: never auto-accept, require an explicit
  // click and surface a warning so the user re-checks the safety number.
  return {
    action: "store_awaiting_click",
    peerPubB64: pubB64,
    warnRekey: !!keyMeta || !!pending?.warnRekey
  };
}

/** A handshake step 2 (responder answer) appeared in the chat. */
function onHs2Detected(context, pubB64) {
  const { pending, keyMeta } = context;

  if (isOwnKey(context, pubB64)) {
    return { action: "ignore", reason: "own_echo" };
  }
  if (pubB64 === keyMeta?.peerPubB64) {
    return { action: "ignore", reason: "known_peer_key" };
  }

  if (pending?.stage === "hs1_sent") {
    return { action: "finalize", peerPubB64: pubB64 };
  }

  return { action: "ignore", reason: "unexpected_hs2" };
}

function isExpired(pending, nowMs, ttlMs) {
  if (!pending?.createdAt) return false;
  return nowMs - pending.createdAt > ttlMs;
}

const PardehStateMachine = {
  onHandshakeClick,
  onHs1Detected,
  onHs2Detected,
  isExpired
};

globalThis.PardehStateMachine = PardehStateMachine;
if (typeof module !== "undefined" && module.exports) {
  module.exports = PardehStateMachine;
}
