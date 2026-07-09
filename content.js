(() => {
  "use strict";

  // Firefox exposes promise-based `browser.*`; Chrome exposes `chrome.*`.
  const api = globalThis.browser ?? globalThis.chrome;

  // Envelope parsing comes from crypto.js (loaded before this file); no key
  // material or crypto operations live in the page context — encryption and
  // decryption happen in the background script.
  const Crypto = globalThis.PardehCrypto;

  const INSTANCE_KEY = "__e2eExtensionInstance";
  const ENCRYPTION_PREFIX = "encryption_enabled_";
  const META_PREFIX = "chat_meta_";
  const LEGACY_KEY_PREFIX = "chat_key_";
  const PEER_LEGACY_PREFIX = "peer_legacy_";

  try {
    if (window[INSTANCE_KEY]?.cleanup) {
      window[INSTANCE_KEY].cleanup("reinject");
    }
  } catch (_) {}

  const state = {
    destroyed: false,
    initialized: false,

    chatId: null,
    // Snapshot of GET_CHAT_STATE: { enabled, v2Ready, legacyReady, epoch,
    // fingerprint, pendingStage, warnRekey, peerLegacy }
    chat: null,

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

    // envelope -> { ok, plaintext?, code? }; cleared when keys change.
    plaintextCache: new Map(),
    maxPlaintextCache: 300,
    decryptQueue: new Map(),
    decryptTimer: null,

    legacyToastShown: false,

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

  console.log("[E2E] Pardeh content script booting");

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
      if (state.decryptTimer) clearTimeout(state.decryptTimer);

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

      const watched = [
        `${ENCRYPTION_PREFIX}${state.chatId}`,
        `${META_PREFIX}${state.chatId}`,
        `${LEGACY_KEY_PREFIX}${state.chatId}`,
        `${PEER_LEGACY_PREFIX}${state.chatId}`
      ];
      if (!watched.some((key) => changes[key])) return;

      reloadChatState().catch((err) => {
        console.error("[E2E] Failed to sync chat state from storage:", err);
      });
    };

    api.storage.onChanged.addListener(state.onStorageChanged);
  }

  async function reloadChatState() {
    if (!state.chatId || state.destroyed) {
      state.chat = null;
      updateEncryptionStatusUI();
      return;
    }

    const hadKeys = canDecrypt();
    const res = await safeSendToBackground("GET_CHAT_STATE", { chatId: state.chatId });
    state.chat = res?.success ? res : null;

    if (!hadKeys && canDecrypt()) {
      retryFailedDecrypts();
    }

    updateEncryptionStatusUI();
  }

  function canDecrypt() {
    return !!(state.chat?.v2Ready || state.chat?.legacyReady);
  }

  function canEncrypt() {
    return !!(state.chat?.enabled && canDecrypt());
  }

  // A key just became available: clear stale results and re-run messages
  // that previously rendered as decryption failures.
  function retryFailedDecrypts() {
    state.plaintextCache.clear();

    const failed = document.querySelectorAll('[data-e2e-decrypted="error"]');
    for (const el of failed) {
      delete el.dataset.e2eDecrypted;
    }

    scanExistingMessages().catch((err) => {
      console.error("[E2E] retryFailedDecrypts failed:", err);
    });
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
    state.plaintextCache.clear();
    state.decryptQueue.clear();

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

      if (canEncrypt()) {
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

      if (canEncrypt()) {
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

    const fullText = messageElement.textContent?.trim();
    if (!fullText) return;

    // Handshake markers: report to the background state machine once per
    // (chat, marker) — echoes and duplicates are also filtered over there.
    const handshake = Crypto.parseHandshakeText(fullText);
    if (handshake) {
      const cacheKey = buildProcessedKey(`hs${handshake.kind}:${handshake.pubB64}`);
      if (cacheKey && state.processedCache.has(cacheKey)) return;
      markProcessed(cacheKey);

      const activeChatId = state.chatId || extractChatId();
      if (!activeChatId) return;

      const res = await safeSendToBackground("HS_DETECTED", {
        chatId: activeChatId,
        kind: handshake.kind,
        version: handshake.version,
        pubB64: handshake.pubB64
      });
      reportHandshakeFeedback(res);
      return;
    }

    if (!fullText.includes("E2EMSG:")) return;

    const textElement = findBestTextContainer(messageElement);
    if (!textElement) return;
    // Already rendered (or already showing an error — retried explicitly
    // when keys change, never from DOM mutations, to avoid render loops).
    if (textElement.dataset.e2eDecrypted) return;

    const envelopeInfo = Crypto.parseMessageEnvelope(textElement.textContent || "");
    if (!envelopeInfo) return;

    queueDecrypt(envelopeInfo.envelope, textElement);
  }

  // -------------------------------------------------------------------------
  // Decryption pipeline: envelopes are collected for a few milliseconds and
  // decrypted in a single round trip to the background script.
  // -------------------------------------------------------------------------

  function queueDecrypt(envelope, textElement) {
    const cached = state.plaintextCache.get(envelope);
    if (cached) {
      renderDecryptResult(textElement, cached);
      return;
    }

    const elements = state.decryptQueue.get(envelope) || new Set();
    elements.add(textElement);
    state.decryptQueue.set(envelope, elements);

    if (!state.decryptTimer) {
      state.decryptTimer = setTimeout(() => {
        flushDecryptQueue().catch((err) => console.error("[E2E] decrypt flush failed:", err));
      }, 80);
    }
  }

  async function flushDecryptQueue() {
    state.decryptTimer = null;
    if (state.destroyed || !state.chatId) return;

    const batch = [...state.decryptQueue.entries()];
    state.decryptQueue.clear();
    if (!batch.length) return;

    const envelopes = batch.map(([envelope]) => envelope);
    const res = await safeSendToBackground("DECRYPT_BATCH", { chatId: state.chatId, envelopes });
    const results = res?.success ? res.results : null;

    batch.forEach(([envelope, elements], index) => {
      const result = results?.[index] || { ok: false, code: "error" };
      cachePlaintext(envelope, result);
      for (const el of elements) {
        renderDecryptResult(el, result);
      }
    });
  }

  function cachePlaintext(envelope, result) {
    state.plaintextCache.set(envelope, result);
    if (state.plaintextCache.size > state.maxPlaintextCache) {
      const first = state.plaintextCache.keys().next().value;
      state.plaintextCache.delete(first);
    }
  }

  function renderDecryptResult(textElement, result) {
    if (!textElement?.isConnected) return;

    if (result.ok) {
      renderDecryptedMessage(textElement, result.plaintext);
    } else {
      renderDecryptError(textElement, decryptErrorLabel(result.code));
    }
  }

  function decryptErrorLabel(code) {
    switch (code) {
      case "no_key":
        return "Encrypted — no key on this device";
      case "bad_envelope":
        return "Malformed encrypted message";
      case "auth_failed":
      default:
        return "Failed to decrypt";
    }
  }

  async function handleEncryptedSend() {
    if (state.destroyed || !state.messageInput) return;

    const originalMessage = getInputText(state.messageInput).trim();
    if (!originalMessage) return;
    if (!canEncrypt()) return;

    try {
      const res = await safeSendToBackground("ENCRYPT_MESSAGE", {
        chatId: state.chatId,
        text: originalMessage
      });
      if (!res?.success || !res.envelope) {
        throw new Error(res?.error || "encrypt_failed");
      }

      setInputText(state.messageInput, res.envelope);
      await sleep(80);
      triggerSendMessage();
      await sleep(80);
      clearInput(state.messageInput);
    } catch (err) {
      // The original plaintext stays in the input and nothing was sent.
      console.error("[E2E] Encryption failed:", err);
      showToast("Could not encrypt — the message was NOT sent", "error");
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

  // -------------------------------------------------------------------------
  // User feedback
  // -------------------------------------------------------------------------

  function reportHandshakeFeedback(res) {
    if (!res) return;

    if (res.error === "invalid_public_key") {
      showToast("Invalid handshake message received — ignored", "error");
      return;
    }

    if (res.ignored && res.reason === "legacy_handshake") {
      // History rescans re-detect old markers on every chat open; nag once
      // per page load at most.
      if (!state.legacyToastShown) {
        state.legacyToastShown = true;
        showToast("Your contact runs an outdated Pardeh version — ask them to update", "warn");
      }
      return;
    }

    if (res.action === "awaiting_click") {
      showToast(
        res.warnRekey
          ? "New encryption key offer received — open Pardeh to verify and accept"
          : "Encryption key offer received — open Pardeh to accept",
        "warn"
      );
      return;
    }

    if (res.action === "key_established" || res.action === "sent_hs2_key_established") {
      showToast("End-to-end encryption established — verify the safety number in Pardeh", "success");
    }
  }

  const TOAST_COLORS = {
    error: "#e5484d",
    warn: "#b45309",
    success: "#23a26d",
    info: "#334155"
  };

  function showToast(message, kind = "info", durationMs = 6000) {
    let container = document.getElementById("e2e-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "e2e-toast-container";
      container.style.cssText = `
        position: fixed;
        bottom: 84px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        z-index: 2147483647;
        pointer-events: none;
      `;
      document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.textContent = message;
    toast.style.cssText = `
      max-width: 360px;
      padding: 10px 16px;
      border-radius: 10px;
      background: ${TOAST_COLORS[kind] || TOAST_COLORS.info};
      color: #fff;
      font-size: 13px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
      opacity: 0;
      transition: opacity 0.25s ease;
      text-align: center;
    `;
    container.appendChild(toast);

    requestAnimationFrame(() => {
      toast.style.opacity = "1";
    });

    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => {
        toast.remove();
        if (container.childElementCount === 0) container.remove();
      }, 300);
    }, durationMs);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

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

    const enabled = !!state.chat?.enabled;
    if (enabled && state.chat?.v2Ready) {
      indicator.textContent = "🔒 E2E READY";
      indicator.style.background = "#4CAF50";
    } else if (enabled && state.chat?.legacyReady) {
      indicator.textContent = "🔒 E2E LEGACY — rotate keys";
      indicator.style.background = "#FF9800";
    } else if (enabled) {
      indicator.textContent = "🟡 E2E ON (NO KEY)";
      indicator.style.background = "#FF9800";
    } else {
      indicator.textContent = "🔓 E2E OFF";
      indicator.style.background = "#9E9E9E";
    }
  }

  function detectTextDirection(text) {
    if (!text) return "ltr";

    // Persian, Arabic and Hebrew ranges vs Latin ranges: whichever script
    // dominates decides direction; ties fall back to the first strong char.
    const rtlRegex = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/g;
    const ltrRegex = /[A-Za-z]/g;

    const rtlMatches = text.match(rtlRegex) || [];
    const ltrMatches = text.match(ltrRegex) || [];

    if (rtlMatches.length > ltrMatches.length) return "rtl";
    if (ltrMatches.length > rtlMatches.length) return "ltr";

    for (const ch of text) {
      if (/[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/.test(ch)) return "rtl";
      if (/[A-Za-z]/.test(ch)) return "ltr";
    }

    return "ltr";
  }

  function renderDecryptedMessage(textElement, decryptedText) {
    if (!textElement) return;
    if (textElement.dataset.e2eDecrypted === "1") return;
    textElement.textContent = "";

    textElement.dataset.e2eDecrypted = "1";
    const text = document.createElement("span");
    text.textContent = decryptedText;
    text.className = "p";

    const dir = detectTextDirection(decryptedText);
    text.dir = dir;

    if (dir === "rtl") {
      text.style.textAlign = "right";
      text.style.direction = "rtl";
    } else {
      text.style.textAlign = "left";
      text.style.direction = "ltr";
    }

    textElement.appendChild(text);
    addDecryptedMessageIndicator(textElement);
  }

  function renderDecryptError(textElement, message = "Failed to decrypt") {
    if (!textElement) return;

    textElement.dataset.e2eDecrypted = "error";
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

  function addDecryptedMessageIndicator(textElement) {
    const bubble =
      textElement.closest('[data-sentry-component="BaseBubbleFC"]') ||
      textElement.closest('[data-sentry-component="Message"]') ||
      textElement.closest(".message-item");

    if (!bubble) return;

    const infoContainer =
      bubble.querySelector('[data-sentry-component="InfoFC"]') ||
      bubble.querySelector('[data-testid="message-state-icon"]')?.parentElement;

    if (!infoContainer || infoContainer.querySelector(".e2e-message-lock-indicator")) {
      return;
    }

    const lockIndicator = document.createElement("span");
    lockIndicator.textContent = "🔒";
    lockIndicator.className = "e2e-message-lock-indicator x3ai0M";
    lockIndicator.setAttribute("aria-label", "Decrypted message");
    lockIndicator.title = "Decrypted message";

    const timestamp =
      infoContainer.querySelector("time") ||
      infoContainer.querySelector("p") ||
      infoContainer.lastElementChild;

    const stateIcon = infoContainer.querySelector('[data-testid="message-state-icon"]');
    if (stateIcon?.nextSibling) {
      infoContainer.insertBefore(lockIndicator, stateIcon.nextSibling);
    } else if (timestamp) {
      infoContainer.insertBefore(lockIndicator, timestamp);
    } else {
      infoContainer.appendChild(lockIndicator);
    }
  }

  // -------------------------------------------------------------------------
  // Background messaging
  // -------------------------------------------------------------------------

  // Promise style works in both browsers (Chrome MV3 returns a promise
  // when no callback is passed; Firefox is promise-only).
  async function safeSendToBackground(type, data = {}) {
    if (state.destroyed) return { error: "content_destroyed" };

    try {
      const response = await api.runtime.sendMessage({ type, ...data });
      return response || {};
    } catch (err) {
      return { error: String(err?.message || err) };
    }
  }

  // -------------------------------------------------------------------------
  // Chat / DOM discovery
  // -------------------------------------------------------------------------

  function extractChatId() {
    try {
      const url = new URL(location.href);

      // Bale is an SPA: the chat id can live in the query string
      // (web.bale.ai/chat?uid=...) or, depending on routing, in the hash.
      const paramSets = [url.searchParams];
      const hashQuery = url.hash.split("?")[1];
      if (hashQuery) paramSets.push(new URLSearchParams(hashQuery));

      for (const params of paramSets) {
        for (const key of ["uid", "peerId", "chatId", "dialogId"]) {
          const value = params.get(key);
          if (value) return value;
        }
      }

      const pathMatch = (url.pathname + url.hash).match(/\/chat\/([^/?#]+)/);
      if (pathMatch) return pathMatch[1];
    } catch (_) {}

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
      text.includes("[[E2EHS") ||
      text.startsWith("E2EHS1:") ||
      text.startsWith("E2EHS2:")
    );
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
