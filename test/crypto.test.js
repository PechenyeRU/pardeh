"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Crypto = require("../crypto.js");

async function makeParty() {
  const kp = await Crypto.generateEcdhKeyPair();
  return { kp, pubB64: await Crypto.exportRawPublicKeyB64(kp.publicKey) };
}

async function establish(party, peerPubB64) {
  const peerPub = await Crypto.importRawPublicKey(peerPubB64);
  return Crypto.deriveDirectionalKeys(party.kp.privateKey, peerPub, party.pubB64, peerPubB64);
}

test("public key validation", async () => {
  const { pubB64 } = await makeParty();
  assert.equal(Crypto.validateRawP256PublicKeyB64(pubB64), true);

  assert.throws(() => Crypto.validateRawP256PublicKeyB64("not base64!!!"));
  assert.throws(() => Crypto.validateRawP256PublicKeyB64(btoa("short")));
  // right length, wrong EC point prefix
  assert.throws(() =>
    Crypto.validateRawP256PublicKeyB64(btoa(String.fromCharCode(5, ...Array(64).fill(1))))
  );
});

test("directional keys: opposite labels, working both ways", async () => {
  const alice = await makeParty();
  const bob = await makeParty();

  const aliceKeys = await establish(alice, bob.pubB64);
  const bobKeys = await establish(bob, alice.pubB64);

  assert.notEqual(aliceKeys.myLabel, bobKeys.myLabel);

  const env = await Crypto.encryptEnvelope(aliceKeys.sendKey, 1, aliceKeys.myLabel, "hello bob ☕");
  const parsed = Crypto.parseMessageEnvelope(env);
  assert.equal(await Crypto.decryptEnvelopeV2(bobKeys.recvKey, parsed), "hello bob ☕");

  const back = await Crypto.encryptEnvelope(bobKeys.sendKey, 1, bobKeys.myLabel, "سلام");
  assert.equal(
    await Crypto.decryptEnvelopeV2(aliceKeys.recvKey, Crypto.parseMessageEnvelope(back)),
    "سلام"
  );
});

test("sender can decrypt its own echo with the send key", async () => {
  const alice = await makeParty();
  const bob = await makeParty();
  const keys = await establish(alice, bob.pubB64);

  const env = await Crypto.encryptEnvelope(keys.sendKey, 3, keys.myLabel, "echo");
  assert.equal(
    await Crypto.decryptEnvelopeV2(keys.sendKey, Crypto.parseMessageEnvelope(env)),
    "echo"
  );
});

test("epoch and direction are bound via gcm aad", async () => {
  const alice = await makeParty();
  const bob = await makeParty();
  const aliceKeys = await establish(alice, bob.pubB64);
  const bobKeys = await establish(bob, alice.pubB64);

  const env = await Crypto.encryptEnvelope(aliceKeys.sendKey, 1, aliceKeys.myLabel, "bind me");
  const parsed = Crypto.parseMessageEnvelope(env);

  await assert.rejects(Crypto.decryptEnvelopeV2(bobKeys.recvKey, { ...parsed, epoch: 2 }));
  await assert.rejects(
    Crypto.decryptEnvelopeV2(bobKeys.recvKey, { ...parsed, dir: parsed.dir === "A" ? "B" : "A" })
  );
});

test("fingerprint: symmetric, stable format, key-dependent", async () => {
  const alice = await makeParty();
  const bob = await makeParty();
  const eve = await makeParty();

  const fpAB = await Crypto.computeFingerprint(alice.pubB64, bob.pubB64);
  const fpBA = await Crypto.computeFingerprint(bob.pubB64, alice.pubB64);
  assert.equal(fpAB, fpBA);
  assert.match(fpAB, /^\d{5} \d{5} \d{5} \d{5} \d{5}$/);

  const fpAE = await Crypto.computeFingerprint(alice.pubB64, eve.pubB64);
  assert.notEqual(fpAB, fpAE);
});

test("handshake message roundtrip and legacy detection", async () => {
  const { pubB64 } = await makeParty();

  const hs1 = Crypto.parseHandshakeText(Crypto.buildHandshakeMessage(1, pubB64));
  assert.deepEqual(hs1, { kind: 1, version: 2, pubB64 });

  const hs2 = Crypto.parseHandshakeText(`noise before [[E2EHS2:v2:${pubB64}]] noise after`);
  assert.equal(hs2.kind, 2);
  assert.equal(hs2.version, 2);

  const legacy = Crypto.parseHandshakeText(`[[E2EHS1:${pubB64}]]`);
  assert.equal(legacy.version, 1);
  assert.equal(legacy.kind, 1);

  const bare = Crypto.parseHandshakeText(`E2EHS2:${pubB64}`);
  assert.equal(bare.version, 1);

  assert.equal(Crypto.parseHandshakeText("just a normal message"), null);
});

test("envelope parsing: v2 wins over v1, garbage rejected", () => {
  const v2 = Crypto.parseMessageEnvelope("E2EMSG:v2:12:A:aXZpdml2aXZpdg==:Y2lwaGVydGV4dA==");
  assert.equal(v2.version, 2);
  assert.equal(v2.epoch, 12);
  assert.equal(v2.dir, "A");

  const v1 = Crypto.parseMessageEnvelope("E2EMSG:aXZpdml2aXZpdg==:Y2lwaGVydGV4dA==");
  assert.equal(v1.version, 1);

  assert.equal(Crypto.parseMessageEnvelope("E2EMSG:"), null);
  assert.equal(Crypto.parseMessageEnvelope("hello"), null);
});

test("legacy envelope roundtrip", async () => {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await Crypto.importLegacyAesKey(Crypto.arrayBufferToBase64(raw.buffer));

  const env = await Crypto.encryptLegacy(key, "old world");
  const parsed = Crypto.parseMessageEnvelope(env);
  assert.equal(parsed.version, 1);
  assert.equal(await Crypto.decryptLegacy(key, parsed), "old world");
});

test("decrypt rejects invalid iv length", async () => {
  const alice = await makeParty();
  const bob = await makeParty();
  const keys = await establish(alice, bob.pubB64);

  await assert.rejects(
    Crypto.decryptEnvelopeV2(keys.recvKey, {
      version: 2,
      epoch: 1,
      dir: "A",
      ivB64: btoa("too-short"),
      ctB64: btoa("whatever")
    })
  );
});
