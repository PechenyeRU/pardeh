"use strict";

console.log("[E2E] Manual-handshake background loaded");

const PENDING_PREFIX = "pending_handshake_";
const CHAT_KEY_PREFIX = "chat_key_";
const ENCRYPTION_PREFIX = "encryption_enabled_";
const HANDSHAKE_TTL_MS = 10 * 60 * 1000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "GET_CHAT_ID":
        return { success: true, chatId: null };

      case "CHAT_ID_CHANGED":
        return { success: true };

      case "ENCRYPT_TOGGLE":
        return await handleEncryptionToggle(message.chatId, message.enabled);

      case "GET_ENCRYPTION_STATUS":
        return await handleGetEncryptionStatus(message.chatId);

      case "GET_SHARED_KEY":
        return await handleGetSharedKey(message.chatId);

      case "CLEAR_CHAT_STATE":
        return await handleClearChatState(message.chatId);

      case "GET_PENDING_HANDSHAKE":
        return await handleGetPendingHandshake(message.chatId);

      case "HANDSHAKE_MARK_HS1_DETECTED":
        return await handleMarkHs1Detected(message.chatId, message.payload);

      case "HANDSHAKE_MARK_HS2_DETECTED":
        return await handleMarkHs2Detected(message.chatId, message.payload);

      case "HANDSHAKE_CLICK":
        return await handleHandshakeClick(message.chatId, sender.tab?.id);

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

async function handleEncryptionToggle(chatId, enabled) {
  if (!chatId) return { success: false, error: "Missing chatId" };
  await chrome.storage.local.set({ [`${ENCRYPTION_PREFIX}${chatId}`]: !!enabled });
  return { success: true };
}

async function handleGetEncryptionStatus(chatId) {
  if (!chatId) return { enabled: false, error: "Missing chatId" };
  const result = await chrome.storage.local.get([`${ENCRYPTION_PREFIX}${chatId}`]);
  return { enabled: !!result[`${ENCRYPTION_PREFIX}${chatId}`] };
}

async function handleGetSharedKey(chatId) {
  if (!chatId) return { key: null, error: "Missing chatId" };
  const result = await chrome.storage.local.get([`${CHAT_KEY_PREFIX}${chatId}`]);
  return { key: result[`${CHAT_KEY_PREFIX}${chatId}`] || null };
}

async function handleClearChatState(chatId) {
  if (!chatId) return { success: false, error: "Missing chatId" };

  await chrome.storage.local.remove([
    `${CHAT_KEY_PREFIX}${chatId}`,
    `${ENCRYPTION_PREFIX}${chatId}`
  ]);
  await chrome.storage.session.remove([pendingKey(chatId)]);

  return { success: true };
}

async function handleGetPendingHandshake(chatId) {
  if (!chatId) return { success: false, error: "Missing chatId" };
  await clearExpiredPendingHandshake(chatId);
  return { success: true, pending: await getPendingHandshake(chatId) };
}

async function handleMarkHs1Detected(chatId, payload) {
  if (!chatId || !payload?.legacyRawKeyB64) {
    return { success: false, error: "Missing chatId or payload.legacyRawKeyB64" };
  }

  await clearExpiredPendingHandshake(chatId);
  const pending = await getPendingHandshake(chatId);

  if (pending?.role === "alice" && pending.legacyRawPublicKeyB64 === payload.legacyRawKeyB64) {
    return { success: true, ignored: true, reason: "own_hs1_echo" };
  }

  const next = {
    ...(pending || {}),
    detectedHs1KeyB64: payload.legacyRawKeyB64,
    detectedHs1At: Date.now(),
    createdAt: pending?.createdAt || Date.now()
  };

  await setPendingHandshake(chatId, next);
  return { success: true, pending: next };
}

async function handleMarkHs2Detected(chatId, payload) {
  if (!chatId || !payload?.legacyRawKeyB64) {
    return { success: false, error: "Missing chatId or payload.legacyRawKeyB64" };
  }

  await clearExpiredPendingHandshake(chatId);
  const pending = await getPendingHandshake(chatId);

  if (pending?.role === "bob" && pending.legacyRawPublicKeyB64 === payload.legacyRawKeyB64) {
    return { success: true, ignored: true, reason: "own_hs2_echo" };
  }

  const next = {
    ...(pending || {}),
    detectedHs2KeyB64: payload.legacyRawKeyB64,
    detectedHs2At: Date.now(),
    createdAt: pending?.createdAt || Date.now()
  };

  await setPendingHandshake(chatId, next);
  return { success: true, pending: next };
}

async function handleHandshakeClick(chatId, senderTabId) {
  if (!chatId) return { success: false, error: "Missing chatId" };

  await clearExpiredPendingHandshake(chatId);
  const pending = await getPendingHandshake(chatId);
  const tabId = senderTabId ?? await getActiveBaleTabId();
  if (!tabId) return { success: false, error: "No Bale tab found" };

  // Step 1: nothing yet => send HS1
  if (!pending) {
    const keyPair = await generateKeyPair();
    const publicKeyRawB64 = await exportLegacyRawPublicKey(keyPair.publicKey);
    const privateKeyJwk = await exportPrivateKeyJwk(keyPair.privateKey);

    await setPendingHandshake(chatId, {
      role: "alice",
      stage: "hs1_sent",
      legacyRawPublicKeyB64: publicKeyRawB64,
      privateKeyJwk,
      createdAt: Date.now()
    });

    await sendMessageToTab(tabId, {
      type: "SEND_CHAT_MESSAGE",
      text: `[[E2EHS1:${publicKeyRawB64}]]`
    });

    return { success: true, action: "sent_hs1" };
  }

  // Step 2: peer HS1 detected, answer with HS2 and save our side key
  if (pending.detectedHs1KeyB64 && !pending.detectedHs2KeyB64 && pending.stage !== "hs2_sent") {
    const theirPublicKeyB64 = pending.detectedHs1KeyB64;

    validateRawP256PublicKeyB64(theirPublicKeyB64);
    const theirPublicKey = await importLegacyRawPublicKey(theirPublicKeyB64);

    const keyPair = await generateKeyPair();
    const ourPublicKeyRawB64 = await exportLegacyRawPublicKey(keyPair.publicKey);
    const privateKeyJwk = await exportPrivateKeyJwk(keyPair.privateKey);

    const sharedSecret = await deriveSharedSecret(keyPair.privateKey, theirPublicKey);
    const aesKey = await deriveAESKey(sharedSecret);
    const aesKeyB64 = await exportAesKey(aesKey);

    await saveSharedKey(chatId, aesKeyB64);

    const next = {
      role: "bob",
      stage: "hs2_sent",
      legacyRawPublicKeyB64: ourPublicKeyRawB64,
      privateKeyJwk,
      peerHs1KeyB64: theirPublicKeyB64,
      createdAt: pending.createdAt || Date.now(),
      detectedHs1KeyB64: theirPublicKeyB64,
      detectedHs1At: pending.detectedHs1At || Date.now()
    };

    await setPendingHandshake(chatId, next);

    await sendMessageToTab(tabId, {
      type: "SEND_CHAT_MESSAGE",
      text: `[[E2EHS2:${ourPublicKeyRawB64}]]`
    });

    return { success: true, action: "sent_hs2_and_saved_key" };
  }

  // Step 3: alice sees HS2, finalize shared key
  if (
    pending.role === "alice" &&
    pending.stage === "hs1_sent" &&
    pending.privateKeyJwk &&
    pending.detectedHs2KeyB64
  ) {
    const privateKey = await importPrivateKeyJwk(pending.privateKeyJwk);
    const theirPublicKeyB64 = pending.detectedHs2KeyB64;

    validateRawP256PublicKeyB64(theirPublicKeyB64);
    const theirPublicKey = await importLegacyRawPublicKey(theirPublicKeyB64);

    const sharedSecret = await deriveSharedSecret(privateKey, theirPublicKey);
    const aesKey = await deriveAESKey(sharedSecret);
    const aesKeyB64 = await exportAesKey(aesKey);

    await saveSharedKey(chatId, aesKeyB64);
    await clearPendingHandshake(chatId);

    return { success: true, action: "finalized_key_from_hs2" };
  }

  // already ready
  const existingKey = await handleGetSharedKey(chatId);
  if (existingKey?.key) {
    return { success: true, action: "already_ready" };
  }

  return {
    success: false,
    error: "No valid manual handshake action available",
    pending
  };
}

function pendingKey(chatId) {
  return `${PENDING_PREFIX}${chatId}`;
}

async function setPendingHandshake(chatId, state) {
  await chrome.storage.session.set({ [pendingKey(chatId)]: state });
}

async function getPendingHandshake(chatId) {
  const result = await chrome.storage.session.get([pendingKey(chatId)]);
  return result[pendingKey(chatId)] || null;
}

async function clearPendingHandshake(chatId) {
  await chrome.storage.session.remove([pendingKey(chatId)]);
}

async function clearExpiredPendingHandshake(chatId) {
  const pending = await getPendingHandshake(chatId);
  if (!pending?.createdAt) return;

  if (Date.now() - pending.createdAt > HANDSHAKE_TTL_MS) {
    await clearPendingHandshake(chatId);
  }
}

async function getActiveBaleTabId() {
  const baleTabs = await chrome.tabs.query({ url: "*://web.bale.ai/*" });
  if (baleTabs.length > 0) return baleTabs[0].id ?? null;

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

async function sendMessageToTab(tabId, message, retries = 2) {
  await ensureContentScript(tabId);

  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      lastErr = err;
      await sleep(300);
    }
  }

  throw lastErr || new Error("Failed to send message to tab");
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return;
  } catch (_) {}

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });

  await sleep(250);
}

async function generateKeyPair() {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"]
  );
}

async function exportLegacyRawPublicKey(publicKey) {
  const exported = await crypto.subtle.exportKey("raw", publicKey);
  return arrayBufferToBase64(exported);
}

async function importLegacyRawPublicKey(publicKeyB64) {
  const keyData = base64ToArrayBuffer(publicKeyB64);
  return crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );
}

async function exportPrivateKeyJwk(privateKey) {
  return crypto.subtle.exportKey("jwk", privateKey);
}

async function importPrivateKeyJwk(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits", "deriveKey"]
  );
}

async function deriveSharedSecret(privateKey, publicKey) {
  return crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256
  );
}

async function deriveAESKey(sharedSecret) {
  return crypto.subtle.importKey(
    "raw",
    sharedSecret,
    { name: "AES-GCM" },
    true,
    ["encrypt", "decrypt"]
  );
}

async function exportAesKey(key) {
  const exported = await crypto.subtle.exportKey("raw", key);
  return arrayBufferToBase64(exported);
}

async function saveSharedKey(chatId, keyB64) {
  await chrome.storage.local.set({ [`${CHAT_KEY_PREFIX}${chatId}`]: keyB64 });
}

function validateRawP256PublicKeyB64(publicKeyB64) {
  const bytes = new Uint8Array(base64ToArrayBuffer(publicKeyB64));
  if (bytes.length !== 65) {
    throw new Error(`Invalid raw key length: ${bytes.length}, expected 65`);
  }
  if (bytes[0] !== 0x04) {
    throw new Error(`Invalid EC point prefix: ${bytes[0]}, expected 4`);
  }
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}
