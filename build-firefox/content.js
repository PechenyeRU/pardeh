(() => {
  "use strict";

  // Firefox shim: Use browser.* if available, fall back to chrome.*
  // Firefox supports both chrome.* and browser.* APIs for extension compatibility
  const api = typeof browser !== "undefined" ? browser : chrome;
  const apiType = typeof browser !== "undefined" ? "browser" : "chrome";
  console.log(`[E2E] Content script using ${apiType} API`);

  const INSTANCE_KEY = "__e2eExtensionInstance";
  const CHAT_KEY_PREFIX = "chat_key_";
  const ENCRYPTION_PREFIX = "encryption_enabled_";

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
    onStorageChanged: null,

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
    registerStorageListener();

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
          api.runtime.onMessage.removeListener(state.onRuntimeMessage);
        } catch (_) {}
      }

      if (state.onStorageChanged) {
        try {
          api.storage.onChanged.removeListener(state.onStorageChanged);
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
          reloadChatState()
            .then(() => sendResponse({ success: true }))
            .catch((err) => sendResponse({ success: false, error: String(err?.message || err) }));
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

    api.runtime.onMessage.addListener(state.onRuntimeMessage);
  }

  function registerStorageListener() {
    state.onStorageChanged = (changes, areaName) => {
      if (state.destroyed || areaName !== "local" || !state.chatId) return;

      const encryptionStorageKey = `${ENCRYPTION_PREFIX}${state.chatId}`;
      const sharedKeyStorageKey = `${CHAT_KEY_PREFIX}${state.chatId}`;

      if (!changes[encryptionStorageKey] && !changes[sharedKeyStorageKey]) return;

      reloadChatState().catch((err) => {
        console.error("[E2E] Failed to sync chat state from storage:", err);
      });
    };

    api.storage.onChanged.addListener(state.onStorageChanged);
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
    state.sharedKey = keyResult?.key || null;

    updateEncryptionStatusUI();
  }

  // Firefox needs to read Bale's SPA route directly because the old
  // input-text heuristic misses `https://web.bale.ai/chat?uid=...`.
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
      location.href.match(/[?&](uid|chatId|peerId|dialogId)=([^&]+)/);

    if (pathMatch) {
      return pathMatch[pathMatch.length - 1];
    }

    return null;
  }

  async function waitForChatId(timeoutMs = 15000) {
    const immediate = extractChatId();
    if (immediate) {
      console.log("[E2E] Detected chatId from URL:", immediate);
      return immediate;
    }

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const detected = extractChatId();
      if (detected) {
        console.log("[E2E] Detected chatId after route update:", detected);
        return detected;
      }

      await sleep(200);
    }

    return null;
  }

  async function safeSendToBackground(type, data) {
    if (state.destroyed) {
      return { error: "content_destroyed" };
    }

    try {
      return await new Promise((resolve) => {
        api.runtime.sendMessage({ type, ...data }, (res) => {
          if (api.runtime.lastError) {
            resolve({ error: api.runtime.lastError.message });
          } else {
            resolve(res || {});
          }
        });
      });
    } catch (err) {
      return { error: String(err?.message || err) };
    }
  }

  function installRouteChangeHooks() {
    if (state.routeHooksInstalled) return;
    state.routeHooksInstalled = true;

    if (history.pushState) {
      const originalPushState = history.pushState.bind(history);
      history.pushState = function (...args) {
        originalPushState(...args);
        onRouteChange();
      };
    }

    window.addEventListener("popstate", onRouteChange);
  }

  function onRouteChange() {
    if (state.destroyed) return;
    const newUrl = location.href;
    if (newUrl !== state.lastKnownUrl) {
      state.lastKnownUrl = newUrl;
      handleRouteChange();
    }
  }

  async function handleRouteChange() {
    cleanup();
    await sleep(100);
    bootstrap();
  }

  function startDomWatcher() {
    if (state.domObserver) return;

    state.domObserver = new MutationObserver((mutations) => {
      if (state.destroyed) return;
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) {
            checkAndAttachHandlers();
            observeAddedNodes(node);
          }
        });
      });
    });

    state.domObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  async function attachUiHooks(force = false) {
    if (state.handlersAttached && !force) return;

    state.sendButton = findSendButton();
    state.messageInput = findMessageInput();

    if (!state.sendButton || !state.messageInput) {
      state.attachRetryTimer = setTimeout(() => attachUiHooks(), 1000);
      return;
    }

    if (state._sendClickHandler) {
      state.sendButton.removeEventListener("click", state._sendClickHandler, true);
    }

    state._sendClickHandler = async (e) => {
      if (state.bypassNextSend) {
        state.bypassNextSend = false;
        return;
      }
      e.preventDefault();
      await handleSendMessage();
    };

    state.sendButton.addEventListener("click", state._sendClickHandler, true);

    if (state._inputKeydownHandler) {
      state.messageInput.removeEventListener("keydown", state._inputKeydownHandler, true);
    }

    state._inputKeydownHandler = async (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        await handleSendMessage();
      }
    };

    state.messageInput.addEventListener("keydown", state._inputKeydownHandler, true);

    state.handlersAttached = true;
  }

  function checkAndAttachHandlers() {
    if (!state.sendButton) {
      state.sendButton = findSendButton();
    }
    if (!state.messageInput) {
      state.messageInput = findMessageInput();
    }
    attachUiHooks();
  }

  async function handleSendMessage() {
    if (!state.messageInput) return;

    const originalText = getInputText(state.messageInput);
    if (!originalText.trim()) return;

    if (state.encryptionEnabled && state.sharedKey) {
      const encrypted = await encryptMessage(originalText, state.sharedKey);
      setInputText(state.messageInput, encrypted);
    }

    state.bypassNextSend = true;
    simulateSendButton();

    if (state.encryptionEnabled && state.sharedKey) {
      markMessageAsProcessed(encrypted);
    }

    setInputText(state.messageInput, originalText);
  }

  async function simulateSendButton() {
    if (state.sendButton) {
      state.sendButton.click();
      await sleep(100);
    }
  }

  function observeAddedNodes(node) {
    if (state.destroyed) return;

    const textNodes = node.querySelectorAll ? node.querySelectorAll(".KTwPFW") : [];
    textNodes.forEach((el) => {
      const text = el.textContent?.trim();
      if (text?.startsWith("E2EMSG:")) {
        processEncryptedMessage(text, el);
      }
    });
  }

  async function observeMessages(disable = false) {
    if (disable || state.destroyed) return;

    const messageList = document.querySelector(".messages-list, #message_list_scroller_id, div[data-sentry-component='MessagesListFC']");
    if (!messageList) {
      state.messageObserver = setTimeout(() => observeMessages(), 1000);
      return;
    }

    if (state.messageObserver) {
      state.messageObserver.disconnect();
    }

    state.messageObserver = new MutationObserver((mutations) => {
      if (state.destroyed) return;
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) {
            const messages = extractMessageItems(node);
            messages.forEach((msg) => {
              processMessageElement(msg);
            });
          }
        });
      });
    });

    state.messageObserver.observe(messageList, { childList: true, subtree: true });
  }

  function extractMessageItems(node) {
    const items = [];

    if (node.nodeType === 1) {
      const tagName = node.tagName?.toLowerCase();
      if (tagName === "div" || tagName === "span") {
        if (node.classList?.contains?.("message-item") || node.dataset?.sentryComponent === "Message") {
          items.push(node);
        }
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

  function processMessageElement(messageElement) {
    const payload = extractMessagePayload(messageElement);
    if (!payload) return;

    if (payload.text.startsWith("[[E2EHS1:") || payload.text.startsWith("E2EHS1:")) {
      processHandshakeMessage(payload.text, "hs1", payload.textElement);
    } else if (payload.text.startsWith("[[E2EHS2:") || payload.text.startsWith("E2EHS2:")) {
      processHandshakeMessage(payload.text, "hs2", payload.textElement);
    } else if (payload.text.startsWith("E2EMSG:")) {
      processEncryptedMessage(payload.text, payload.textElement);
    }
  }

  function processHandshakeMessage(text, type, textElement) {
    if (textElement) {
      const className = textElement.className || "";
      if (className.includes("sent-message") || className.includes("outgoing")) {
        return;
      }
    }

    const senderText = textElement?.parentElement?.querySelector(".sender-name")?.textContent?.trim() || "";
    const isFromSelf = senderText.includes("Me") || senderText === "me";

    if (type === "hs1" && !isFromSelf) {
      const key = extractLegacyHandshakeKey(text, "E2EHS1:");
      if (key) {
        safeSendToBackground("HANDSHAKE_MARK_HS1_DETECTED", {
          chatId: state.chatId,
          payload: { legacyRawKeyB64: key }
        }).catch(console.error);
      }
    } else if (type === "hs2" && !isFromSelf) {
      const key = extractLegacyHandshakeKey(text, "E2EHS2:");
      if (key) {
        safeSendToBackground("HANDSHAKE_MARK_HS2_DETECTED", {
          chatId: state.chatId,
          payload: { legacyRawKeyB64: key }
        }).catch(console.error);
      }
    }
  }

  async function processEncryptedMessage(text, textElement) {
    if (state.destroyed || !state.encryptionEnabled || !state.sharedKey) return;

    const key = buildProcessedKey(text);
    if (key && state.processedCache.has(key)) return;

    const result = await decryptMessage(text, state.sharedKey);
    if (!result) return;

    markProcessed(key);
    textElement?.parentElement?.querySelectorAll?.(".E2EMSG-indicator").forEach((el) => el.remove());

    const indicator = document.createElement("span");
    indicator.className = "E2EMSG-indicator";
    indicator.textContent = "🔓";
    indicator.style.cssText = "margin-right: 4px; cursor: pointer;";
    indicator.title = "Decrypted: " + result;

    const parent = textElement?.parentElement;
    if (parent) {
      parent.insertBefore(indicator, textElement?.nextSibling || null);
    }
  }

  async function scanExistingMessages() {
    if (state.destroyed) return;

    const messageList = document.querySelector(".messages-list, #message_list_scroller_id, div[data-sentry-component='MessagesListFC']");
    if (!messageList) return;

    const items = extractMessageItems(messageList);
    items.forEach((item) => processMessageElement(item));
  }

  function updateEncryptionStatusUI() {
    // No-op - UI is controlled by popup
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

  function waitForInput(timeoutMs = 5000) {
    return new Promise((resolve) => {
      const immediate = findMessageInput();
      if (immediate) {
        resolve(immediate);
        return;
      }

      const started = Date.now();
      const timer = setInterval(() => {
        const input = findMessageInput();
        if (input) {
          clearInterval(timer);
          resolve(input);
          return;
        }

        if (Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, 150);
    });
  }

  function waitForSendButton(timeoutMs = 5000) {
    return new Promise((resolve) => {
      const immediate = findSendButton();
      if (immediate) {
        resolve(immediate);
        return;
      }

      const started = Date.now();
      const timer = setInterval(() => {
        const sendButton = findSendButton();
        if (sendButton) {
          clearInterval(timer);
          resolve(sendButton);
          return;
        }

        if (Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, 150);
    });
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

  async function encryptMessage(plaintext, keyB64) {
    try {
      const keyBuffer = base64ToArrayBuffer(keyB64);
      const aesKey = await crypto.subtle.importKey(
        "raw",
        keyBuffer,
        { name: "AES-GCM" },
        true,
        ["encrypt"]
      );

      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encoder = new TextEncoder();
      const encoded = encoder.encode(plaintext);

      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        aesKey,
        encoded
      );

      const encryptedBase64 = arrayBufferToBase64(encrypted);
      const ivBase64 = arrayBufferToBase64(iv);

      return `E2EMSG:${ivBase64}:${encryptedBase64}`;
    } catch (err) {
      console.error("[E2E] Encryption failed:", err);
      return plaintext;
    }
  }

  async function decryptMessage(ciphertext, keyB64) {
    try {
      const parts = ciphertext.match(/^E2EMSG:([^:]+):(.+)$/);
      if (!parts) return null;

      const ivB64 = parts[1];
      const dataB64 = parts[2];

      const keyBuffer = base64ToArrayBuffer(keyB64);
      const ivBuffer = base64ToArrayBuffer(ivB64);
      const dataBuffer = base64ToArrayBuffer(dataB64);

      const aesKey = await crypto.subtle.importKey(
        "raw",
        keyBuffer,
        { name: "AES-GCM" },
        true,
        ["decrypt"]
      );

      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: ivBuffer },
        aesKey,
        dataBuffer
      );

      const decoder = new TextDecoder();
      return decoder.decode(decrypted);
    } catch (err) {
      console.error("[E2E] Decryption failed:", err);
      return null;
    }
  }
})();
