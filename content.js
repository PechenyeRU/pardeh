(() => {
  "use strict";

  const INSTANCE_KEY = "__e2eExtensionInstance";

  try {
    if (window[INSTANCE_KEY]?.cleanup) {
      window[INSTANCE_KEY].cleanup("reinject");
    }
  } catch (_) {}

  const state = {
    destroyed: false,
    initialized: false,

    chatId: null,
    encryptionEnabled: false,
    sharedKey: null,

    messageObserver: null,
    domObserver: null,

    sendButton: null,
    messageInput: null,

    bypassNextSend: false,

    urlWatchInterval: null,
    attachRetryTimer: null,
    initTimer: null,

    processedCache: new Set(),
    maxProcessedCache: 500,

    handlersAttached: false,
    onRuntimeMessage: null,

    _sendClickHandler: null,
    _inputKeydownHandler: null,

    routeHooksInstalled: false,
    lastKnownUrl: location.href
  };

  window[INSTANCE_KEY] = { cleanup };

  const BALE_SELECTORS = {
    inputCandidates: [
      "#editable-message-text",
      '[contenteditable="true"]',
      'div[contenteditable="true"]'
    ],
    sendButtonCandidates: [
      'div[aria-label="send-button"]',
      'button[aria-label="send-button"]',
      'button[type="submit"]'
    ],
    messageListParents: [
      'div[data-sentry-component="MessagesListFC"]',
      "#message_list_scroller_id",
      ".messages-list",
      ".messages-container",
      ".message-list"
    ],
    messageItemCandidates: [
      ".message-item",
      '[data-sentry-component="Message"]',
      '[class*="message"]'
    ],
    textCandidates: [
      ".KTwPFW.YjkWXv",
      ".KTwPFW",
      ".YjkWXv",
      ".ljqtTr",
      ".message-text",
      ".text-content",
      "span",
      "div"
    ]
  };

  console.log("[E2E] Manual-handshake content script booting");

  bootstrap();

  function bootstrap() {
    state.initTimer = setTimeout(() => {
      initialize().catch((err) => console.error("[E2E] initialize failed:", err));
    }, 600);
  }

  async function initialize() {
    if (state.destroyed || state.initialized) return;
    state.initialized = true;

    registerRuntimeListener();

    state.chatId = await waitForChatId();
    await reloadChatState();

    installRouteChangeHooks();
    startDomWatcher();
    attachUiHooks(true);
    observeMessages(true);
    await scanExistingMessages();
    updateEncryptionStatusUI();

    console.log("[E2E] Initialized for chat:", state.chatId);
  }

  function cleanup() {
    if (state.destroyed) return;
    state.destroyed = true;

    try {
      if (state.urlWatchInterval) clearInterval(state.urlWatchInterval);
      if (state.attachRetryTimer) clearTimeout(state.attachRetryTimer);
      if (state.initTimer) clearTimeout(state.initTimer);

      if (state.messageObserver) state.messageObserver.disconnect();
      if (state.domObserver) state.domObserver.disconnect();

      if (state.sendButton && state._sendClickHandler) {
        state.sendButton.removeEventListener("click", state._sendClickHandler, true);
      }

      if (state.messageInput && state._inputKeydownHandler) {
        state.messageInput.removeEventListener("keydown", state._inputKeydownHandler, true);
      }

      if (state.onRuntimeMessage) {
        try {
          chrome.runtime.onMessage.removeListener(state.onRuntimeMessage);
        } catch (_) {}
      }
    } catch (_) {}
  }

  function registerRuntimeListener() {
    state.onRuntimeMessage = (message, sender, sendResponse) => {
      if (state.destroyed) {
        sendResponse?.({ success: false, error: "content_destroyed" });
        return true;
      }

      switch (message.type) {
        case "PING":
          sendResponse({ ok: true, chatId: state.chatId });
          return true;

        case "GET_CHAT_ID":
          sendResponse({ chatId: state.chatId });
          return true;

        case "UPDATE_ENCRYPTION_STATUS":
          state.encryptionEnabled = !!message.enabled;
          updateEncryptionStatusUI();
          sendResponse({ success: true });
          return true;

        case "SEND_CHAT_MESSAGE":
          handleSendChatMessageCommand(message.text)
            .then(() => sendResponse({ success: true }))
            .catch((err) => sendResponse({ success: false, error: String(err?.message || err) }));
          return true;

        default:
          sendResponse({ success: false, error: "unknown_message_type" });
          return true;
      }
    };

    chrome.runtime.onMessage.addListener(state.onRuntimeMessage);
  }

  async function reloadChatState() {
    if (!state.chatId || state.destroyed) {
      state.encryptionEnabled = false;
      state.sharedKey = null;
      updateEncryptionStatusUI();
      return;
    }

    const status = await safeSendToBackground("GET_ENCRYPTION_STATUS", { chatId: state.chatId });
    state.encryptionEnabled = !!status?.enabled;

    const keyResult = await safeSendToBackground("GET_SHARED_KEY", { chatId: state.chatId });
    if (keyResult?.key) {
      try {
        state.sharedKey = await importAESKey(keyResult.key);
      } catch (err) {
        console.error("[E2E] Failed to import AES key:", err);
        state.sharedKey = null;
      }
    } else {
      state.sharedKey = null;
    }

    updateEncryptionStatusUI();
  }

  function installRouteChangeHooks() {
    if (state.routeHooksInstalled) return;
    state.routeHooksInstalled = true;

    const notifyRouteChange = async () => {
      if (state.destroyed) return;

      const newChatId = extractChatId();
      if (newChatId && newChatId !== state.chatId) {
        await handleChatChanged(newChatId);
      }
    };

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      setTimeout(() => {
        notifyRouteChange().catch((err) => console.error("[E2E] pushState route change failed:", err));
      }, 50);
      return result;
    };

    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      setTimeout(() => {
        notifyRouteChange().catch((err) => console.error("[E2E] replaceState route change failed:", err));
      }, 50);
      return result;
    };

    window.addEventListener("popstate", () => {
      setTimeout(() => {
        notifyRouteChange().catch((err) => console.error("[E2E] popstate route change failed:", err));
      }, 50);
    });

    state.urlWatchInterval = setInterval(async () => {
      if (state.destroyed) return;

      const currentUrl = location.href;
      if (currentUrl === state.lastKnownUrl) return;

      state.lastKnownUrl = currentUrl;
      await notifyRouteChange();
    }, 500);
  }

  async function handleChatChanged(newChatId) {
    if (!newChatId || state.destroyed) return;
    if (newChatId === state.chatId) return;

    console.log("[E2E] Chat changed:", state.chatId, "=>", newChatId);

    state.chatId = newChatId;
    state.processedCache.clear();

    await safeSendToBackground("CHAT_ID_CHANGED", { chatId: newChatId });
    await reloadChatState();

    if (state.messageObserver) {
      state.messageObserver.disconnect();
      state.messageObserver = null;
    }

    attachUiHooks(true);
    observeMessages(true);

    // Wait a bit for SPA DOM to finish replacing content
    await sleep(150);
    await scanExistingMessages();

    updateEncryptionStatusUI();
  }

  function startDomWatcher() {
    if (state.domObserver) state.domObserver.disconnect();

    state.domObserver = new MutationObserver(() => {
      if (state.destroyed) return;

      const sendButton = findSendButton();
      const input = findMessageInput();

      const oldButtonDetached = state.sendButton && !state.sendButton.isConnected;
      const oldInputDetached = state.messageInput && !state.messageInput.isConnected;

      if (
        forceRebindNeeded(sendButton, input, oldButtonDetached, oldInputDetached)
      ) {
        attachUiHooks(true);
      }

      if (!state.messageObserver || !findMessageContainer()) {
        observeMessages(true);
      }
    });

    state.domObserver.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });
  }

  function forceRebindNeeded(sendButton, input, oldButtonDetached, oldInputDetached) {
    return (
      sendButton !== state.sendButton ||
      input !== state.messageInput ||
      oldButtonDetached ||
      oldInputDetached
    );
  }

  function attachUiHooks(force = false) {
    if (state.destroyed) return;

    const sendButton = findSendButton();
    const input = findMessageInput();

    if (!sendButton || !input) {
      if (state.attachRetryTimer) clearTimeout(state.attachRetryTimer);
      state.attachRetryTimer = setTimeout(() => attachUiHooks(true), 1200);
      return;
    }

    if (!force && state.sendButton === sendButton && state.messageInput === input && state.handlersAttached) {
      return;
    }

    if (state.sendButton && state._sendClickHandler) {
      state.sendButton.removeEventListener("click", state._sendClickHandler, true);
    }
    if (state.messageInput && state._inputKeydownHandler) {
      state.messageInput.removeEventListener("keydown", state._inputKeydownHandler, true);
    }

    state.sendButton = sendButton;
    state.messageInput = input;

    state._sendClickHandler = async (e) => {
      if (state.destroyed) return;

      if (state.bypassNextSend) {
        state.bypassNextSend = false;
        return;
      }

      const text = getInputText(state.messageInput).trim();
      if (!text) return;
      if (isHandshakeText(text)) return;

      if (state.encryptionEnabled && state.sharedKey) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
        await handleEncryptedSend();
      }
    };

    state._inputKeydownHandler = async (e) => {
      if (state.destroyed) return;
      if (e.key !== "Enter" || e.shiftKey) return;

      const text = getInputText(state.messageInput).trim();
      if (!text) return;
      if (isHandshakeText(text)) return;

      if (state.encryptionEnabled && state.sharedKey) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
        await handleEncryptedSend();
      }
    };

    state.sendButton.addEventListener("click", state._sendClickHandler, true);
    state.messageInput.addEventListener("keydown", state._inputKeydownHandler, true);
    state.handlersAttached = true;
  }

  function observeMessages(force = false) {
    if (state.destroyed) return;

    if (state.messageObserver && !force) return;
    if (state.messageObserver) {
      state.messageObserver.disconnect();
      state.messageObserver = null;
    }

    const container = findMessageContainer();
    if (!container) return;

    state.messageObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;

          const items = getMessageItemsFromNode(node);
          for (const item of items) {
            processNewMessage(item).catch((err) => {
              console.error("[E2E] processNewMessage failed:", err);
            });
          }
        }
      }
    });

    state.messageObserver.observe(container, {
      childList: true,
      subtree: true
    });
  }

  async function scanExistingMessages() {
    if (state.destroyed) return;

    const container = findMessageContainer();
    if (!container) return;

    const seen = new Set();
    const candidates = [];

    for (const sel of BALE_SELECTORS.messageItemCandidates) {
      const found = container.querySelectorAll(sel);
      for (const el of found) {
        if (!seen.has(el)) {
          seen.add(el);
          candidates.push(el);
        }
      }
    }

    if (candidates.length === 0) {
      for (const child of container.children) {
        if (child instanceof Element) candidates.push(child);
      }
    }

    for (const item of candidates) {
      try {
        await processNewMessage(item);
      } catch (err) {
        console.error("[E2E] scanExistingMessages item failed:", err);
      }
    }
  }

  async function processNewMessage(messageElement) {
    if (state.destroyed) return;

    const payload = extractMessagePayload(messageElement);
    if (!payload?.text) return;

    const originalText = payload.text.trim();
    const cacheKey = buildProcessedKey(originalText);
    if (cacheKey && state.processedCache.has(cacheKey)) return;

    if (originalText.startsWith("E2EHS1:") || originalText.startsWith("[[E2EHS1:")) {
      markProcessed(cacheKey);

      const rawKey = extractLegacyHandshakeKey(originalText, "E2EHS1:");
      if (!rawKey) return;

      const activeChatId = state.chatId || extractChatId();
      if (!activeChatId) return;

      await safeSendToBackground("HANDSHAKE_MARK_HS1_DETECTED", {
        chatId: activeChatId,
        payload: { legacyRawKeyB64: rawKey }
      });

      return;
    }

    if (originalText.startsWith("E2EHS2:") || originalText.startsWith("[[E2EHS2:")) {
      markProcessed(cacheKey);

      const rawKey = extractLegacyHandshakeKey(originalText, "E2EHS2:");
      if (!rawKey) return;

      const activeChatId = state.chatId || extractChatId();
      if (!activeChatId) return;

      await safeSendToBackground("HANDSHAKE_MARK_HS2_DETECTED", {
        chatId: activeChatId,
        payload: { legacyRawKeyB64: rawKey }
      });

      return;
    }

    if (originalText.startsWith("E2EMSG:")) {
      markProcessed(cacheKey);

      // Decrypt whenever key exists. Toggle only controls sending.
      if (!state.sharedKey) return;

      try {
        const textForDecrypt = payload.text;
        const parts = textForDecrypt.slice(7).split(":");
        if (parts.length < 2) return;

        const ivB64 = parts[0].trim();
        const ciphertextB64 = parts.slice(1).join(":").trim();

        if (!looksLikeBase64(ivB64) || !looksLikeBase64(ciphertextB64)) {
          throw new Error("Malformed encrypted payload");
        }

        const ivBytes = new Uint8Array(base64ToArrayBuffer(ivB64));
        if (ivBytes.length !== 12) {
          throw new Error(`Invalid IV length: ${ivBytes.length}`);
        }

        const decrypted = await decryptMessage(ciphertextB64, ivB64);

        if (payload.textElement) {
          renderDecryptedMessage(payload.textElement, decrypted);
        }
      } catch (err) {
        console.error("[E2E] Decryption failed:", err);
        if (payload.textElement) {
          renderDecryptError(payload.textElement, "Failed to decrypt");
        }
      }
    }
  }

  async function handleEncryptedSend() {
    if (state.destroyed || !state.messageInput) return;

    const originalMessage = getInputText(state.messageInput).trim();
    if (!originalMessage) return;
    if (!state.sharedKey) return;

    try {
      const encrypted = await encryptMessage(originalMessage);
      setInputText(state.messageInput, encrypted);
      await sleep(80);
      triggerSendMessage();
      await sleep(80);
      clearInput(state.messageInput);
    } catch (err) {
      console.error("[E2E] Encryption failed:", err);
    }
  }

  async function handleSendChatMessageCommand(text) {
    const input = await waitForInput(5000);
    if (!input) throw new Error("Chat input not found");

    const sendButton = await waitForSendButton(5000);
    if (!sendButton) throw new Error("Send button not found");

    setInputText(input, text);
    await sleep(120);

    state.bypassNextSend = true;
    sendButton.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window
    }));
  }

  function triggerSendMessage() {
    const sendButton = findSendButton();
    if (!sendButton) return;

    state.bypassNextSend = true;
    sendButton.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window
    }));
  }

  async function encryptMessage(plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      state.sharedKey,
      encoded
    );

    return `E2EMSG:${arrayBufferToBase64(iv)}:${arrayBufferToBase64(ciphertext)}`;
  }

  async function decryptMessage(ciphertextB64, ivB64) {
    const iv = base64ToArrayBuffer(ivB64);
    const ciphertext = base64ToArrayBuffer(ciphertextB64);

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      state.sharedKey,
      ciphertext
    );

    return new TextDecoder().decode(decrypted);
  }

  async function importAESKey(keyB64) {
    const keyData = base64ToArrayBuffer(keyB64);
    return crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
  }

  function updateEncryptionStatusUI() {
    let indicator = document.getElementById("e2e-status-indicator");

    if (!indicator) {
      indicator = document.createElement("div");
      indicator.id = "e2e-status-indicator";
      indicator.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        padding: 6px 12px;
        border-radius: 12px;
        font-size: 12px;
        font-weight: bold;
        z-index: 999999;
        pointer-events: none;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        color: #fff;
      `;
      document.body.appendChild(indicator);
    }

    if (state.encryptionEnabled && state.sharedKey) {
      indicator.textContent = "🔒 E2E READY";
      indicator.style.background = "#4CAF50";
    } else if (state.encryptionEnabled && !state.sharedKey) {
      indicator.textContent = "🟡 E2E ON (NO KEY)";
      indicator.style.background = "#FF9800";
    } else {
      indicator.textContent = "🔓 E2E OFF";
      indicator.style.background = "#9E9E9E";
    }
  }

  function renderDecryptedMessage(textElement, decryptedText) {
    if (!textElement) return;
    if (textElement.dataset.e2eDecrypted === "1") return;

    textElement.dataset.e2eDecrypted = "1";
    textElement.textContent = "";

    const wrapper = document.createElement("span");
    wrapper.className = "e2e-inline-wrap";
    wrapper.style.display = "inline-flex";
    wrapper.style.alignItems = "flex-start";
    wrapper.style.gap = "0.35em";
    wrapper.style.verticalAlign = "middle";
    wrapper.style.maxWidth = "100%";

    const lock = document.createElement("span");
    lock.className = "e2e-lock-icon";
    lock.textContent = "🔒";
    lock.style.flex = "0 0 auto";
    lock.style.fontSize = "0.95em";
    lock.style.lineHeight = "1";
    lock.style.marginTop = "0.1em";

    const text = document.createElement("span");
    text.className = "e2e-decrypted-text";
    text.textContent = decryptedText;
    text.style.whiteSpace = "pre-wrap";
    text.style.wordBreak = "break-word";
    text.style.overflowWrap = "anywhere";
    text.style.unicodeBidi = "plaintext";

    const dir = detectTextDirection(decryptedText);
    text.dir = dir;
    wrapper.dir = dir;

    if (dir === "rtl") {
      wrapper.style.flexDirection = "row-reverse";
      wrapper.style.textAlign = "right";
      text.style.textAlign = "right";
      text.style.direction = "rtl";
    } else {
      wrapper.style.flexDirection = "row";
      wrapper.style.textAlign = "left";
      text.style.textAlign = "left";
      text.style.direction = "ltr";
    }

    wrapper.appendChild(lock);
    wrapper.appendChild(text);
    textElement.appendChild(wrapper);
  }

  function renderDecryptError(textElement, message = "Failed to decrypt") {
    if (!textElement) return;

    textElement.dataset.e2eDecrypted = "1";
    textElement.textContent = "";

    const wrapper = document.createElement("span");
    wrapper.style.display = "inline-flex";
    wrapper.style.alignItems = "center";
    wrapper.style.gap = "0.35em";
    wrapper.style.direction = "ltr";
    wrapper.style.unicodeBidi = "plaintext";

    const lock = document.createElement("span");
    lock.textContent = "🔒";

    const text = document.createElement("span");
    text.textContent = `[${message}]`;
    text.style.fontStyle = "italic";
    text.style.opacity = "0.8";
    text.style.direction = "ltr";

    wrapper.appendChild(lock);
    wrapper.appendChild(text);
    textElement.appendChild(wrapper);
  }

  function detectTextDirection(text) {
    if (!text) return "ltr";

    // Arabic/Persian/Hebrew ranges
    const rtlRegex = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;
    const ltrRegex = /[A-Za-z]/;

    const rtlMatch = text.match(rtlRegex);
    const ltrMatch = text.match(ltrRegex);

    if (rtlMatch && !ltrMatch) return "rtl";
    if (ltrMatch && !rtlMatch) return "ltr";

    // first strong char wins
    for (const ch of text) {
      if (/[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/.test(ch)) return "rtl";
      if (/[A-Za-z]/.test(ch)) return "ltr";
    }

    return "ltr";
  }

  async function safeSendToBackground(type, data = {}) {
    if (state.destroyed) return { error: "content_destroyed" };

    try {
      return await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type, ...data }, (response) => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({ error: err.message });
            return;
          }
          resolve(response || {});
        });
      });
    } catch (err) {
      return { error: String(err?.message || err) };
    }
  }

  function extractChatId() {
    try {
      const url = new URL(location.href);

      const uid = url.searchParams.get("uid");
      if (uid) return uid;

      const peerId = url.searchParams.get("peerId");
      if (peerId) return peerId;

      const chatId = url.searchParams.get("chatId");
      if (chatId) return chatId;

      const dialogId = url.searchParams.get("dialogId");
      if (dialogId) return dialogId;
    } catch (_) {}

    const pathMatch =
      location.href.match(/\/chat\/([^/?#]+)/) ||
      location.href.match(/[?&](chatId|peerId|dialogId)=([^&]+)/);

    if (pathMatch) {
      return pathMatch[pathMatch.length - 1];
    }

    return null;
  }

  function waitForChatId(timeoutMs = 15000) {
    return new Promise((resolve) => {
      const immediate = extractChatId();
      if (immediate) return resolve(immediate);

      const started = Date.now();
      const timer = setInterval(() => {
        if (state.destroyed) {
          clearInterval(timer);
          resolve(null);
          return;
        }

        const found = extractChatId();
        if (found) {
          clearInterval(timer);
          resolve(found);
          return;
        }

        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, 300);
    });
  }

  function findMessageContainer() {
    for (const selector of BALE_SELECTORS.messageListParents) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function getMessageItemsFromNode(node) {
    const items = [];
    if (!(node instanceof Element)) return items;

    for (const sel of BALE_SELECTORS.messageItemCandidates) {
      if (node.matches?.(sel)) {
        items.push(node);
        return items;
      }
    }

    for (const sel of BALE_SELECTORS.messageItemCandidates) {
      const found = node.querySelectorAll?.(sel);
      if (found?.length) {
        items.push(...found);
        return items;
      }
    }

    return items;
  }

  function extractMessagePayload(messageElement) {
    const fullText = messageElement.textContent?.trim();
    if (!fullText) return null;

    const hsEnvelope = extractHandshakeEnvelope(fullText);
    if (hsEnvelope) {
      return {
        text: hsEnvelope,
        textElement: messageElement
      };
    }

    const textElement = findBestTextContainer(messageElement);
    if (!textElement) return null;

    const text = textElement.textContent?.trim();
    if (!text) return null;

    const msgEnvelope = extractEncryptedEnvelope(text);
    if (!msgEnvelope) return null;

    return {
      text: msgEnvelope,
      textElement
    };
  }

  function extractHandshakeEnvelope(text) {
    const hs1Marker = text.match(/\[\[E2EHS1:([A-Za-z0-9+/=]{80,140})\]\]/);
    if (hs1Marker) return `[[E2EHS1:${hs1Marker[1]}]]`;

    const hs2Marker = text.match(/\[\[E2EHS2:([A-Za-z0-9+/=]{80,140})\]\]/);
    if (hs2Marker) return `[[E2EHS2:${hs2Marker[1]}]]`;

    const hs1 = text.match(/E2EHS1:[A-Za-z0-9+/=]{80,140}/);
    if (hs1) return hs1[0];

    const hs2 = text.match(/E2EHS2:[A-Za-z0-9+/=]{80,140}/);
    if (hs2) return hs2[0];

    return null;
  }

  function extractEncryptedEnvelope(text) {
    if (!text) return null;
    const msg = text.match(/E2EMSG:([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)/);
    return msg ? msg[0] : null;
  }

  function extractLegacyHandshakeKey(text, prefix) {
    if (!text) return null;

    if (prefix === "E2EHS1:") {
      const marker = text.match(/^\[\[E2EHS1:([A-Za-z0-9+/=]{80,140})\]\]$/);
      if (marker) return marker[1];
      const raw = text.match(/^E2EHS1:([A-Za-z0-9+/=]{80,140})$/);
      return raw ? raw[1] : null;
    }

    if (prefix === "E2EHS2:") {
      const marker = text.match(/^\[\[E2EHS2:([A-Za-z0-9+/=]{80,140})\]\]$/);
      if (marker) return marker[1];
      const raw = text.match(/^E2EHS2:([A-Za-z0-9+/=]{80,140})$/);
      return raw ? raw[1] : null;
    }

    return null;
  }

  function findBestTextContainer(messageElement) {
    for (const selector of BALE_SELECTORS.textCandidates) {
      const nodes = messageElement.querySelectorAll(selector);
      for (const node of nodes) {
        const txt = node.textContent?.trim();
        if (txt && txt.includes("E2EMSG:")) {
          return node;
        }
      }
    }

    return null;
  }

  function findMessageInput() {
    for (const selector of BALE_SELECTORS.inputCandidates) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function findSendButton() {
    for (const selector of BALE_SELECTORS.sendButtonCandidates) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function waitForInput(timeoutMs = 5000) {
    return waitForElement(findMessageInput, timeoutMs);
  }

  function waitForSendButton(timeoutMs = 5000) {
    return waitForElement(findSendButton, timeoutMs);
  }

  function waitForElement(getter, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const found = getter();
      if (found) return resolve(found);

      const started = Date.now();
      const timer = setInterval(() => {
        if (state.destroyed) {
          clearInterval(timer);
          resolve(null);
          return;
        }

        const el = getter();
        if (el) {
          clearInterval(timer);
          resolve(el);
          return;
        }

        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, 200);
    });
  }

  function getInputText(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
    if (el.isContentEditable) return el.innerText || el.textContent || "";
    return "";
  }

  function setInputText(el, text) {
    if (!el) return;

    el.focus();

    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      el.value = text;
    } else if (el.isContentEditable) {
      try {
        document.execCommand("selectAll", false, null);
        document.execCommand("insertText", false, text);
        if ((el.innerText || "").trim() !== text.trim()) {
          el.innerText = text;
        }
      } catch (_) {
        el.innerText = text;
      }
    }

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function clearInput(el) {
    setInputText(el, "");
  }

  function buildProcessedKey(text) {
    if (!state.chatId || !text) return null;
    return `${state.chatId}|${text}`;
  }

  function markProcessed(key) {
    if (!key) return;
    state.processedCache.add(key);

    if (state.processedCache.size > state.maxProcessedCache) {
      const first = state.processedCache.values().next().value;
      state.processedCache.delete(first);
    }
  }

  function isHandshakeText(text) {
    return (
      text.startsWith("[[E2EHS1:") ||
      text.startsWith("[[E2EHS2:") ||
      text.startsWith("E2EHS1:") ||
      text.startsWith("E2EHS2:")
    );
  }

  function looksLikeBase64(s) {
    return !!s && /^[A-Za-z0-9+/=]+$/.test(s);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
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
})();
