(() => {
  "use strict";

  // Firefox exposes promise-based `browser.*`; Chrome exposes `chrome.*`.
  const api = globalThis.browser ?? globalThis.chrome;

  // Envelope parsing comes from crypto.js (loaded before this file); no key
  // material or crypto operations live in the page context — encryption and
  // decryption happen in the background script. UI strings come from
  // i18n.js, also loaded before this file.
  const Crypto = globalThis.PardehCrypto;
  const I18n = globalThis.PardehI18n;

  const INSTANCE_KEY = "__e2eExtensionInstance";
  const COMPOSER_PREF_KEY = "secure_composer";

  // Background handshake outcomes that change what the dot/menu must show.
  const HS_STATE_CHANGING_ACTIONS = new Set([
    "awaiting_click",
    "stored_peer_hs1",
    "sent_hs1",
    "sent_hs1_rotation",
    "sent_hs2_key_established",
    "key_established",
    "waiting_for_peer"
  ]);
  const COMPOSER_ID = "e2e-secure-composer";
  // Extra height granted to the composer iframe while its emoji panel is
  // open; the frame grows upward so the input strip stays on Bale's row.
  const COMPOSER_PANEL_EXTRA = 208;
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

    uiLanguage: "en",
    translate: null,

    secureComposer: true,
    composerTracker: null,
    composerPanelExtra: 0,
    dotTracker: null,
    previewSanitizeTimer: null,
    previewObserver: null,

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

    await loadLanguage();
    state.chatId = await waitForChatId();
    await reloadChatState();

    installRouteChangeHooks();
    startDomWatcher();
    attachUiHooks(true);
    observeMessages(true);
    await scanExistingMessages();
    updateEncryptionStatusUI();
    startPreviewObserver();
    scheduleSanitizePreviews();

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
      if (state.previewSanitizeTimer) clearTimeout(state.previewSanitizeTimer);

      if (state.messageObserver) state.messageObserver.disconnect();
      if (state.domObserver) state.domObserver.disconnect();
      if (state.previewObserver) state.previewObserver.disconnect();

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

      closeStatusMenu();
      removeComposer();
      stopDotTracking();
      document.getElementById(DOT_ID)?.remove();
      document.getElementById("e2e-toast-container")?.remove();
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

        case "SET_COMPOSER_PANEL":
          state.composerPanelExtra = message.open ? COMPOSER_PANEL_EXTRA : 0;
          syncComposerPosition();
          sendResponse({ success: true });
          return true;

        default:
          sendResponse({ success: false, error: "unknown_message_type" });
          return true;
      }
    };

    api.runtime.onMessage.addListener(state.onRuntimeMessage);
  }

  async function loadLanguage() {
    try {
      const stored = await api.storage.local.get([I18n.STORAGE_KEY, COMPOSER_PREF_KEY]);
      setLanguage(stored[I18n.STORAGE_KEY]);
      state.secureComposer = stored[COMPOSER_PREF_KEY] !== false;
    } catch (_) {
      setLanguage(null);
    }
  }

  function setLanguage(storedValue) {
    state.uiLanguage = I18n.resolveLanguage(storedValue);
    state.translate = I18n.create(state.uiLanguage);
  }

  function tr(key, params) {
    if (!state.translate) setLanguage(null);
    return state.translate(key, params);
  }

  function registerStorageListener() {
    state.onStorageChanged = (changes, areaName) => {
      if (state.destroyed || areaName !== "local") return;

      if (changes[I18n.STORAGE_KEY]) {
        setLanguage(changes[I18n.STORAGE_KEY].newValue);
        updateEncryptionStatusUI();
      }

      if (changes[COMPOSER_PREF_KEY]) {
        state.secureComposer = changes[COMPOSER_PREF_KEY].newValue !== false;
        updateComposer();
      }

      if (!state.chatId) return;

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
    updateComposer();
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
    closeStatusMenu();

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
    updateComposer();
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

      // React re-renders can drop the injected status dot with the header.
      const dot = document.getElementById(DOT_ID);
      if (!dot || !dot.isConnected) {
        updateEncryptionStatusUI();
      }

      updateComposer();
      scheduleSanitizePreviews();
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

    state._sendClickHandler = (e) => {
      if (state.destroyed) return;

      if (state.bypassNextSend) {
        state.bypassNextSend = false;
        return;
      }

      interceptOutgoingMessage(e);
    };

    state._inputKeydownHandler = (e) => {
      if (state.destroyed) return;
      if (e.key !== "Enter" || e.shiftKey) return;

      interceptOutgoingMessage(e);
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
        await processNewMessage(item, { historical: true });
      } catch (err) {
        console.error("[E2E] scanExistingMessages item failed:", err);
      }
    }
  }

  async function processNewMessage(messageElement, { historical = false } = {}) {
    if (state.destroyed) return;

    const fullText = messageElement.textContent?.trim();
    if (!fullText) return;

    // Handshake markers: report to the background state machine once per
    // (chat, marker) — echoes and duplicates are also filtered over there.
    const handshake = Crypto.parseHandshakeText(fullText);
    if (handshake) {
      // Always collapse the raw [[E2EHS..]] bubble to a tidy badge, even
      // on re-scan of an already-reported marker (the bubble is a fresh
      // DOM node after every SPA re-render).
      collapseHandshakeBubble(messageElement);

      // Handshakes in chat history (initial scan) must not create fresh
      // key offers: re-reading old [[E2EHS..]] on every chat open would
      // otherwise resurrect stale offers and, after a clear, drive both
      // sides to answer mismatched keys. Only process a historical marker
      // when it could complete a handshake WE are still waiting on.
      if (historical && state.chat?.pendingStage !== "hs1_sent") return;

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

      // A detection that moved the handshake forward changes what the dot
      // and its menu should show (offer to accept, or an established key).
      // The pending state lives in the background's IndexedDB, which does
      // not fire storage.onChanged, so reload the snapshot explicitly.
      if (res?.success && HS_STATE_CHANGING_ACTIONS.has(res.action)) {
        await reloadChatState();
      }
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
        return tr("errNoKey");
      case "bad_envelope":
        return tr("errBadEnvelope");
      case "auth_failed":
      default:
        return tr("errAuthFailed");
    }
  }

  // Fail-safe interception: the host page is treated as potentially
  // hostile, so the plaintext is pulled OUT of its input synchronously
  // inside the event handler — after this function returns, the page
  // input never holds the plaintext again during the async encryption
  // window (a malicious page could otherwise ship it on its own trigger,
  // e.g. a keyup listener). On any anomaly nothing is sent.
  function interceptOutgoingMessage(e) {
    if (!canEncrypt() || !state.messageInput) return;

    const text = getInputText(state.messageInput).trim();
    if (!text) return;
    if (isHandshakeText(text)) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();

    clearInput(state.messageInput);
    handleEncryptedSend(text).catch((err) => {
      console.error("[E2E] Encrypted send failed:", err);
    });
  }

  async function handleEncryptedSend(plaintext) {
    if (state.destroyed || !state.messageInput) return;

    try {
      const res = await safeSendToBackground("ENCRYPT_MESSAGE", {
        chatId: state.chatId,
        text: plaintext
      });

      // Accept only a string that is exactly one well-formed envelope.
      const parsed = res?.success && typeof res.envelope === "string"
        ? Crypto.parseMessageEnvelope(res.envelope)
        : null;
      if (!parsed || parsed.envelope !== res.envelope) {
        throw new Error(res?.error || "encrypt_failed");
      }

      setInputText(state.messageInput, res.envelope);
      await sleep(80);

      // Verify the page did not tamper with the injected envelope, then
      // dispatch the send synchronously so there is no gap between the
      // check and the click.
      if (getInputText(state.messageInput).trim() !== res.envelope) {
        throw new Error("input_tampered");
      }
      triggerSendMessage();

      await sleep(80);
      clearInput(state.messageInput);
    } catch (err) {
      // Fail closed: nothing was sent; give the plaintext back to the
      // user instead of leaving it lost or, worse, in flight.
      console.error("[E2E] Encryption failed:", err);
      clearInput(state.messageInput);
      setInputText(state.messageInput, plaintext);
      showToast(tr("toastEncryptFailed"), "error");
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
  // Secure composer overlay.
  //
  // An extension-origin iframe is laid over Bale's message input whenever
  // the chat can be encrypted. Keystrokes typed inside a cross-origin
  // browsing context do not reach the host page's window listeners, so
  // the plaintext never exists in the page — unlike anything typed in the
  // native input, which the page observes before any extension code runs.
  // The composer talks straight to the background script; the page is
  // only ever handed the ciphertext.
  // -------------------------------------------------------------------------

  function shouldShowComposer() {
    return canEncrypt() && state.secureComposer && !!findMessageInput();
  }

  function updateComposer() {
    if (state.destroyed || !shouldShowComposer()) {
      removeComposer();
      return;
    }

    ensureComposer();
    syncComposerPosition();
  }

  function ensureComposer() {
    let frame = document.getElementById(COMPOSER_ID);
    if (frame?.isConnected) return frame;

    frame = document.createElement("iframe");
    frame.id = COMPOSER_ID;
    frame.src = api.runtime.getURL("composer.html");
    frame.setAttribute("scrolling", "no");
    frame.style.cssText = `
      position: fixed;
      z-index: 2147483646;
      border: none;
      background: transparent;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.18);
      border-radius: 12px;
    `;
    document.body.appendChild(frame);

    startComposerTracking();
    return frame;
  }

  function removeComposer() {
    stopComposerTracking();
    // A re-created frame starts with the panel closed.
    state.composerPanelExtra = 0;
    document.getElementById(COMPOSER_ID)?.remove();
  }

  function syncComposerPosition() {
    const frame = document.getElementById(COMPOSER_ID);
    const input = findMessageInput();
    if (!frame) return;

    if (!input?.isConnected) {
      frame.style.visibility = "hidden";
      return;
    }

    // Cover the whole composer row, not just the editable node, so the
    // page's own input cannot be clicked or focused past the overlay.
    const anchor = input.closest("form") || input.parentElement || input;
    const rect = anchor.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 16) {
      frame.style.visibility = "hidden";
      return;
    }

    // The strip can be taller than the anchor row, and the row sits at the
    // bottom of the viewport: anchor the frame's BOTTOM to the row's bottom
    // so the extra height (and the emoji panel) always grows upward instead
    // of spilling past the window edge.
    const stripHeight = Math.max(rect.height, 48);
    frame.style.visibility = "visible";
    frame.style.left = `${rect.left}px`;
    frame.style.top = `${rect.bottom - stripHeight - state.composerPanelExtra}px`;
    frame.style.width = `${rect.width}px`;
    frame.style.height = `${stripHeight + state.composerPanelExtra}px`;

    // Keep the composer on Bale's palette; the OS theme may disagree.
    const theme = pageIsDark() ? "dark" : "light";
    if (frame.dataset.e2eTheme !== theme) {
      frame.dataset.e2eTheme = theme;
      frame.src = api.runtime.getURL(`composer.html#theme=${theme}`);
    }
  }

  // Pardeh surfaces overlay Bale, so they must match BALE's theme rather
  // than the OS one: the browser can be in dark mode while the page
  // renders light, which would drop dark slabs onto a light app.
  function pageIsDark() {
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      const parts = (bg.match(/\d+(?:\.\d+)?/g) || []).map(Number);
      if (parts.length < 3 || (parts.length === 4 && parts[3] === 0)) return false;
      return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2] < 128;
    } catch (_) {
      return false;
    }
  }

  function startComposerTracking() {
    if (state.composerTracker) return;

    const onChange = () => syncComposerPosition();

    window.addEventListener("resize", onChange);
    window.addEventListener("scroll", onChange, true);

    // Bale reflows its composer on typing, attachments and replies; a
    // cheap rect poll keeps the overlay glued without a rAF loop.
    const interval = setInterval(onChange, 250);

    state.composerTracker = () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener("scroll", onChange, true);
      clearInterval(interval);
    };
  }

  function stopComposerTracking() {
    if (!state.composerTracker) return;
    state.composerTracker();
    state.composerTracker = null;
  }

  async function toggleSecureComposer() {
    await api.storage.local.set({ [COMPOSER_PREF_KEY]: !state.secureComposer });
  }

  // -------------------------------------------------------------------------
  // User feedback
  // -------------------------------------------------------------------------

  function reportHandshakeFeedback(res) {
    if (!res) return;

    if (res.error === "invalid_public_key") {
      showToast(tr("toastInvalidHandshake"), "error");
      return;
    }

    if (res.ignored && res.reason === "legacy_handshake") {
      // History rescans re-detect old markers on every chat open; nag once
      // per page load at most.
      if (!state.legacyToastShown) {
        state.legacyToastShown = true;
        showToast(tr("toastOutdatedPeer"), "warn");
      }
      return;
    }

    if (res.action === "awaiting_click") {
      showToast(tr(res.warnRekey ? "toastOfferRekey" : "toastOfferReceived"), "warn");
      return;
    }

    if (res.action === "key_established" || res.action === "sent_hs2_key_established") {
      showToast(tr("toastEstablished"), "success");
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
  // Status dot: a small circle aligned to the chat header. It lives as a
  // position:fixed element in <body> — NOT inside Bale's header — because
  // Bale re-renders the header on navigation and reload, which would take
  // an injected child with it (the dot would vanish). Instead its screen
  // position is tracked to the header bar, falling back to a fixed corner
  // when no header is found. Clicking it opens a quick menu.
  // -------------------------------------------------------------------------

  const DOT_ID = "e2e-status-dot";
  const MENU_ID = "e2e-status-menu";

  function updateEncryptionStatusUI() {
    // Remove pre-2.0 / older-build leftovers.
    document.getElementById("e2e-status-indicator")?.remove();

    const dot = ensureStatusDot();
    if (!dot) return;

    const { color, label } = dotAppearance();
    dot.style.background = color;
    dot.title = label;
    dot.setAttribute("aria-label", label);
    syncDotPosition();

    // Refresh the menu if it is open.
    if (document.getElementById(MENU_ID)) {
      closeStatusMenu();
      openStatusMenu();
    }
  }

  function dotAppearance() {
    const chat = state.chat;
    if (chat?.warnRekey) {
      return { color: "#e5484d", label: tr("dotRekey") };
    }
    if (chat?.enabled && chat?.v2Ready) {
      return { color: "#4caf50", label: tr("dotActive") };
    }
    if (chat?.enabled && chat?.legacyReady) {
      return { color: "#ff9800", label: tr("dotLegacy") };
    }
    if (chat?.enabled) {
      return { color: "#fdd835", label: tr("dotEnabledNoKey") };
    }
    return { color: "#9e9e9e", label: tr("dotOff") };
  }


  function ensureStatusDot() {
    let dot = document.getElementById(DOT_ID);
    if (dot?.isConnected) return dot;

    dot = document.createElement("div");
    dot.id = DOT_ID;
    dot.style.cssText = `
      position: fixed;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      cursor: pointer;
      z-index: 2147483646;
      box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.12);
      background: #9e9e9e;
      visibility: hidden;
    `;
    document.body.appendChild(dot);
    dot.addEventListener("click", onDotClick);

    startDotTracking();
    return dot;
  }

  // Anchor the dot just left of the chat header's action buttons. The
  // anchor is scoped to the CHAT column (derived from the message area) so
  // Bale's two-pane layout does not make it latch onto the contact-list
  // bar on the left when the window is wide.
  function syncDotPosition() {
    const dot = document.getElementById(DOT_ID);
    if (!dot) return;

    const anchor = findHeaderAnchor();
    if (anchor) {
      dot.style.top = `${Math.round(anchor.y - 6)}px`;
      dot.style.left = `${Math.round(anchor.x - 22)}px`;
    } else {
      dot.style.top = "20px";
      dot.style.left = `${window.innerWidth - 28}px`;
    }
    dot.style.visibility = "visible";
  }

  function findHeaderAnchor() {
    // Horizontal span of the active chat column.
    const col = findMessageContainer() || findMessageInput();
    const cr = col?.getBoundingClientRect();
    const left = cr ? cr.left : 0;
    const right = cr ? cr.right : window.innerWidth;

    // Clickable controls sitting in the top band of that column: the chat
    // header's call/video/search/menu buttons.
    const controls = [];
    for (const el of document.querySelectorAll('button, [role="button"], svg')) {
      const r = el.getBoundingClientRect();
      if (
        r.top < 64 && r.bottom > 4 &&
        r.width >= 16 && r.width <= 64 &&
        r.height >= 16 && r.height <= 64 &&
        r.left >= left - 6 && r.right <= right + 6
      ) {
        controls.push(r);
      }
    }
    if (!controls.length) return null;

    // The buttons cluster on the right of the header; anchor to the
    // leftmost one of that right-side cluster.
    const mid = (left + right) / 2;
    const rightSide = controls.filter((r) => r.left > mid);
    const pool = rightSide.length ? rightSide : controls;
    const leftmost = pool.reduce((a, b) => (b.left < a.left ? b : a));

    return { x: leftmost.left, y: leftmost.top + leftmost.height / 2 };
  }

  function startDotTracking() {
    if (state.dotTracker) return;

    const onChange = () => syncDotPosition();
    window.addEventListener("resize", onChange);
    window.addEventListener("scroll", onChange, true);
    const interval = setInterval(onChange, 300);

    state.dotTracker = () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener("scroll", onChange, true);
      clearInterval(interval);
    };
  }

  function stopDotTracking() {
    if (!state.dotTracker) return;
    state.dotTracker();
    state.dotTracker = null;
  }

  function onDotClick(e) {
    e.stopPropagation();
    if (document.getElementById(MENU_ID)) {
      closeStatusMenu();
    } else {
      openStatusMenu();
    }
  }

  function closeStatusMenu() {
    document.getElementById(MENU_ID)?.remove();
    document.removeEventListener("click", onDocumentClickForMenu, true);
  }

  function onDocumentClickForMenu(e) {
    const menu = document.getElementById(MENU_ID);
    if (menu && !menu.contains(e.target) && e.target?.id !== DOT_ID) {
      closeStatusMenu();
    }
  }

  function openStatusMenu() {
    const dot = document.getElementById(DOT_ID);
    if (!dot || !state.chatId) return;

    const dark = pageIsDark();
    const colors = dark
      ? { bg: "#101827", text: "#e5edf5", muted: "#95a3b8", border: "#233147" }
      : { bg: "#ffffff", text: "#18212f", muted: "#667085", border: "#dbe3ee" };

    const menu = document.createElement("div");
    menu.id = MENU_ID;
    menu.dir = I18n.isRtl(state.uiLanguage) ? "rtl" : "ltr";

    const rect = dot.getBoundingClientRect();
    const top = Math.min(rect.bottom + 8, window.innerHeight - 240);
    const left = Math.min(Math.max(rect.left - 120, 8), window.innerWidth - 276);

    menu.style.cssText = `
      position: fixed;
      top: ${top}px;
      left: ${left}px;
      width: 260px;
      background: ${colors.bg};
      color: ${colors.text};
      border: 1px solid ${colors.border};
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.3);
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      padding: 14px;
    `;

    const status = document.createElement("div");
    status.textContent = dotAppearance().label;
    status.style.cssText = "font-weight: 600; margin-bottom: 10px;";
    menu.appendChild(status);

    if (state.chat?.fingerprint) {
      const fpTitle = document.createElement("div");
      fpTitle.textContent = tr("safetyTitle");
      fpTitle.style.cssText = `font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: ${colors.muted}; margin-bottom: 4px;`;
      menu.appendChild(fpTitle);

      const fp = document.createElement("div");
      fp.textContent = state.chat.fingerprint;
      fp.dir = "ltr";
      fp.style.cssText = "font-family: monospace; font-weight: 700; font-size: 14px; letter-spacing: 0.05em; margin-bottom: 4px; user-select: all;";
      menu.appendChild(fp);

      const fpHint = document.createElement("div");
      fpHint.textContent = tr("menuCompareHint");
      fpHint.style.cssText = `font-size: 11px; color: ${colors.muted}; margin-bottom: 10px;`;
      menu.appendChild(fpHint);
    }

    const buttonCss = `
      display: block;
      width: 100%;
      padding: 8px 10px;
      margin-top: 8px;
      border: 1px solid ${colors.border};
      border-radius: 8px;
      background: transparent;
      color: ${colors.text};
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
    `;

    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = tr(state.chat?.enabled ? "menuDisable" : "menuEnable");
    toggleBtn.style.cssText = buttonCss;
    toggleBtn.addEventListener("click", async () => {
      await safeSendToBackground("ENCRYPT_TOGGLE", {
        chatId: state.chatId,
        enabled: !state.chat?.enabled
      });
      closeStatusMenu();
    });
    menu.appendChild(toggleBtn);

    if (canEncrypt()) {
      const composerBtn = document.createElement("button");
      composerBtn.textContent = tr(state.secureComposer ? "menuComposerOff" : "menuComposerOn");
      composerBtn.style.cssText = buttonCss;
      composerBtn.addEventListener("click", async () => {
        closeStatusMenu();
        await toggleSecureComposer();
      });
      menu.appendChild(composerBtn);
    }

    const handshakeLabel = handshakeMenuLabel();
    if (handshakeLabel) {
      const hsBtn = document.createElement("button");
      hsBtn.textContent = handshakeLabel.text;
      hsBtn.disabled = handshakeLabel.disabled;
      hsBtn.style.cssText = buttonCss + (handshakeLabel.disabled ? "opacity: 0.55; cursor: default;" : "");
      hsBtn.addEventListener("click", async () => {
        if (handshakeLabel.disabled) return;
        closeStatusMenu();
        const res = await safeSendToBackground("HANDSHAKE_CLICK", { chatId: state.chatId });
        reportClickFeedback(res);
      });
      menu.appendChild(hsBtn);
    }

    // A handshake in any state (in flight or established) can be restarted
    // from here: a stuck exchange would otherwise dead-end on the disabled
    // "waiting" button with no way out short of opening the popup.
    if (state.chat?.pendingStage || state.chat?.v2Ready) {
      const restartBtn = document.createElement("button");
      restartBtn.textContent = tr("menuRestartHandshake");
      restartBtn.style.cssText = buttonCss;
      let armed = false;
      restartBtn.addEventListener("click", async () => {
        if (!armed) {
          armed = true;
          restartBtn.textContent = tr("btnConfirm");
          setTimeout(() => {
            armed = false;
            restartBtn.textContent = tr("menuRestartHandshake");
          }, 4000);
          return;
        }
        closeStatusMenu();
        const res = await safeSendToBackground("ROTATE_KEYS", { chatId: state.chatId });
        reportClickFeedback(res);
      });
      menu.appendChild(restartBtn);
    }

    // The popup header has the same switch, but this menu is the surface
    // users actually reach; the label names the OTHER language in its own
    // script so it stays readable from either side.
    const langBtn = document.createElement("button");
    langBtn.textContent = state.uiLanguage === "fa" ? "🌐 English" : "🌐 فارسی";
    langBtn.style.cssText = buttonCss;
    langBtn.addEventListener("click", async () => {
      closeStatusMenu();
      try {
        // The storage listener picks the change up and relabels everything.
        await api.storage.local.set({ [I18n.STORAGE_KEY]: I18n.next(state.uiLanguage) });
      } catch (_) {}
    });
    menu.appendChild(langBtn);

    document.body.appendChild(menu);
    setTimeout(() => {
      document.addEventListener("click", onDocumentClickForMenu, true);
    }, 0);
  }

  function handshakeMenuLabel() {
    const chat = state.chat;
    if (chat?.warnRekey) return { text: tr("menuAcceptKey"), disabled: false };
    if (chat?.pendingStage === "awaiting_click") return { text: tr("menuCompleteHandshake"), disabled: false };
    if (chat?.pendingStage === "hs1_sent") return { text: tr("menuWaitingPeer"), disabled: true };
    if (chat?.v2Ready) return null;
    return { text: tr("menuStartHandshake"), disabled: false };
  }

  function reportClickFeedback(res) {
    if (!res) return;

    if (res.error && !res.success) {
      showToast(tr("toastHandshakeFailed", { error: res.error }), "error");
      return;
    }

    const messages = {
      sent_hs1: ["statusSentHs1", "info"],
      sent_hs1_rotation: ["statusRotation", "warn"],
      sent_hs2_key_established: ["statusEstablished", "success"],
      key_established: ["statusEstablished", "success"],
      waiting_for_peer: ["statusWaiting", "info"],
      already_ready: ["statusAlreadyReady", "info"]
    };

    const entry = messages[res.action];
    if (entry) showToast(tr(entry[0]), entry[1]);

    // Reflect the new pending/established state in the dot immediately.
    if (res.success && HS_STATE_CHANGING_ACTIONS.has(res.action)) {
      reloadChatState().catch((err) => console.error("[E2E] reload after click failed:", err));
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

    // The plaintext goes into a CLOSED shadow root: page scripts cannot
    // traverse it, so the decrypted text is rendered for the user but is
    // not readable by the host page through DOM APIs (textContent,
    // innerText, selection). Inheritable styles (font, color) still flow
    // in from the surrounding bubble.
    const host = document.createElement("span");
    const root = host.attachShadow({ mode: "closed" });

    const text = document.createElement("span");
    text.textContent = decryptedText;

    const dir = detectTextDirection(decryptedText);
    text.dir = dir;
    text.style.textAlign = dir === "rtl" ? "right" : "left";
    text.style.direction = dir;

    root.appendChild(text);
    textElement.appendChild(host);
    addDecryptedMessageIndicator(textElement);
  }

  // The [[E2EHS1/2:...]] handshake messages are real chat messages, so
  // they show up as walls of base64. They cannot be deleted from Bale
  // without its (unavailable) delete API, so collapse the bubble in place
  // to a small "🤝 key exchange" badge. Idempotent per bubble.
  function collapseHandshakeBubble(messageElement) {
    const bubble =
      messageElement.closest('[data-sentry-component="BaseBubbleFC"]') ||
      messageElement.closest('[data-sentry-component="Message"]') ||
      messageElement.closest(".message-item") ||
      messageElement;

    if (bubble.dataset.e2eHsCollapsed === "1") return;
    bubble.dataset.e2eHsCollapsed = "1";

    // The base64 lives in a leaf node; replacing just that keeps the
    // bubble chrome (timestamp, ticks) intact.
    const holder = [...bubble.querySelectorAll("*")].find(
      (n) => n.children.length === 0 && /E2EHS[12]:/.test(n.textContent || "")
    );

    const badge = document.createElement("span");
    badge.textContent = `🤝 ${tr("handshakeBadge")}`;
    badge.style.cssText = "font-style: italic; opacity: 0.6; font-size: 0.9em;";

    if (holder) {
      holder.textContent = "";
      holder.appendChild(badge);
    } else {
      // No isolated leaf found: hide the whole bubble rather than leave
      // the base64 visible.
      bubble.style.display = "none";
    }
  }

  // Bale's conversation-list sidebar (and notifications) preview the last
  // message as raw text, so our envelopes show up there as base64 walls.
  // Those nodes live OUTSIDE the open chat view (handled by the message
  // pipeline), so replace the marker text in place with a placeholder.
  // Idempotent — re-runs whenever Bale re-renders a preview.
  function sanitizeCiphertextPreviews() {
    if (state.destroyed || !document.body) return;

    const container = findMessageContainer();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const v = node.nodeValue;
        if (!v || (!v.includes("E2EMSG:") && !v.includes("E2EHS"))) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const targets = [];
    let node;
    while ((node = walker.nextNode())) {
      if (container && container.contains(node)) continue; // chat view: handled elsewhere
      targets.push(node);
    }

    const hs = `🤝 ${tr("handshakeBadge")}`;
    const enc = `🔒 ${tr("previewEncrypted")}`;
    for (const n of targets) {
      const v = n.nodeValue;
      const next = v
        .replace(/\[\[E2EHS[12]:[^\]]*\]\]/g, hs)
        // Truncated previews lose the closing "]]", and since v2 a ":"
        // follows the version segment, so the plain base64 run after the
        // marker is too short for the legacy pattern. Swallow an optional
        // leading "[[" and version segment explicitly.
        .replace(/\[?\[?E2EHS[12]:(?:v\d+:)?[A-Za-z0-9+/=]{8,}\S*/g, hs)
        .replace(/E2EMSG:\S+/g, enc);
      if (next !== v) n.nodeValue = next;
    }
  }

  function scheduleSanitizePreviews() {
    if (state.destroyed || state.previewSanitizeTimer) return;
    state.previewSanitizeTimer = setTimeout(() => {
      state.previewSanitizeTimer = null;
      try {
        sanitizeCiphertextPreviews();
      } catch (err) {
        console.error("[E2E] sanitizeCiphertextPreviews failed:", err);
      }
    }, 250);
  }

  // Bale updates a conversation-list preview by mutating its text node
  // (characterData), which the childList DOM watcher misses. A dedicated
  // observer catches those so the placeholder is reapplied; the throttle
  // coalesces bursts so this stays cheap.
  function startPreviewObserver() {
    if (state.previewObserver || !document.body) return;
    state.previewObserver = new MutationObserver(() => {
      if (state.destroyed) return;
      scheduleSanitizePreviews();
    });
    state.previewObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function renderDecryptError(textElement, message = tr("errAuthFailed")) {
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
    lockIndicator.setAttribute("aria-label", tr("decryptedTooltip"));
    lockIndicator.title = tr("decryptedTooltip");

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
