// Firefox exposes promise-based `browser.*`; Chrome exposes `chrome.*`.
const api = globalThis.browser ?? globalThis.chrome;

document.addEventListener("DOMContentLoaded", async () => {
  const chatIdEl = document.getElementById("chatId");
  const encryptionStatusEl = document.getElementById("encryptionStatus");
  const handshakeStatusEl = document.getElementById("handshakeStatus");
  const keyStatusEl = document.getElementById("keyStatus");

  const safetyCard = document.getElementById("safetyCard");
  const fingerprintEl = document.getElementById("fingerprint");
  const copyFingerprintBtn = document.getElementById("copyFingerprint");

  const composeCard = document.getElementById("composeCard");
  const composeInput = document.getElementById("composeInput");
  const composeSendBtn = document.getElementById("composeSend");

  const rekeyWarning = document.getElementById("rekeyWarning");
  const legacyPeerWarning = document.getElementById("legacyPeerWarning");
  const legacyKeyWarning = document.getElementById("legacyKeyWarning");

  const toggle = document.getElementById("encryptionToggle");
  const handshakeBtn = document.getElementById("initiateHandshake");
  const rotateBtn = document.getElementById("rotateKeys");
  const clearBtn = document.getElementById("clearKeys");
  const langSwitchBtn = document.getElementById("langSwitch");
  const statusEl = document.getElementById("popupStatus");
  const logsEl = document.getElementById("logs");

  let chatId = null;
  let tabId = null;

  let lang = "en";
  let t = PardehI18n.create(lang);

  async function loadLanguage() {
    const stored = await api.storage.local.get([PardehI18n.STORAGE_KEY]);
    lang = PardehI18n.resolveLanguage(stored[PardehI18n.STORAGE_KEY]);
    t = PardehI18n.create(lang);
    applyStaticTranslations();
  }

  function applyStaticTranslations() {
    document.documentElement.lang = lang;
    document.documentElement.dir = PardehI18n.isRtl(lang) ? "rtl" : "ltr";
    langSwitchBtn.textContent = `🌐 ${lang.toUpperCase()}`;

    for (const el of document.querySelectorAll("[data-i18n]")) {
      el.textContent = t(el.dataset.i18n);
    }
    for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    }
  }

  function setStatusColor(element, token) {
    element.style.color = `var(${token})`;
  }

  function setVisible(element, visible) {
    element.classList.toggle("hidden", !visible);
  }

  function updateEncryptionLabel(enabled) {
    encryptionStatusEl.textContent = enabled ? t("enabled") : t("disabled");
    setStatusColor(encryptionStatusEl, enabled ? "--success" : "--text-muted");
  }

  let statusTimer = null;

  function showStatus(msg, type = "info") {
    log(msg, type);
    if (!statusEl) return;

    statusEl.textContent = msg;
    statusEl.classList.remove("hidden");
    statusEl.style.color =
      type === "error" ? "var(--danger)" :
      type === "warn" ? "var(--warning)" :
      type === "success" ? "var(--success)" : "var(--text-muted)";

    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => statusEl.classList.add("hidden"), 6000);
  }

  const ACTION_STATUS = {
    sent_hs1: ["statusSentHs1", "info"],
    sent_hs1_rotation: ["statusRotation", "warn"],
    sent_hs2_key_established: ["statusEstablished", "success"],
    key_established: ["statusEstablished", "success"],
    waiting_for_peer: ["statusWaiting", "info"],
    already_ready: ["statusAlreadyReady", "info"]
  };

  function showActionStatus(action) {
    const entry = ACTION_STATUS[action];
    if (entry) showStatus(t(entry[0]), entry[1]);
  }

  function log(msg, type = "info") {
    if (!logsEl) return;

    const div = document.createElement("div");
    div.className = "log-entry";

    const time = new Date().toLocaleTimeString();
    div.innerHTML = `<span class="log-time">[${time}]</span> <span class="log-${type}">${msg}</span>`;
    logsEl.prepend(div);
  }

  async function sendToBackground(type, data = {}) {
    try {
      return (await api.runtime.sendMessage({ type, ...data })) || {};
    } catch (err) {
      return { error: String(err?.message || err) };
    }
  }

  async function getActiveChatContext() {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab) return { chatId: null, tabId: null, isBale: false };

    // Without the broad "tabs" permission tab.url is only visible for
    // hosts we hold permissions on, so it doubles as the Bale check.
    const isBale = !!tab.url?.startsWith("https://web.bale.ai/");
    if (!isBale) return { chatId: null, tabId: tab.id, isBale };

    try {
      const res = await api.tabs.sendMessage(tab.id, { type: "GET_CHAT_ID" });
      return { chatId: res?.chatId || null, tabId: tab.id, isBale };
    } catch {
      return { chatId: null, tabId: tab.id, isBale };
    }
  }

  async function refreshUI() {
    let isBale = false;
    ({ chatId, tabId, isBale } = await getActiveChatContext());

    if (!chatId) {
      chatIdEl.textContent = isBale ? t("openChat") : t("openBale");
      handshakeBtn.disabled = true;
      setVisible(safetyCard, false);
      setVisible(composeCard, false);
      setVisible(rotateBtn, false);
      setVisible(rekeyWarning, false);
      setVisible(legacyPeerWarning, false);
      setVisible(legacyKeyWarning, false);
      return;
    }

    chatIdEl.textContent = chatId;

    const chatState = await sendToBackground("GET_CHAT_STATE", { chatId });
    if (!chatState.success) {
      showStatus(t("errLoadFailed", { error: chatState.error }), "error");
      return;
    }

    toggle.checked = !!chatState.enabled;
    updateEncryptionLabel(!!chatState.enabled);

    if (chatState.v2Ready) {
      keyStatusEl.textContent = t("keyReady", { epoch: chatState.epoch });
      setStatusColor(keyStatusEl, "--success");
    } else if (chatState.legacyReady) {
      keyStatusEl.textContent = t("keyLegacy");
      setStatusColor(keyStatusEl, "--warning");
    } else {
      keyStatusEl.textContent = t("keyNone");
      setStatusColor(keyStatusEl, "--text-muted");
    }

    if (chatState.warnRekey) {
      handshakeStatusEl.textContent = t("hsNewKeyOffer");
      setStatusColor(handshakeStatusEl, "--danger");
      handshakeBtn.disabled = false;
      handshakeBtn.textContent = t("btnAcceptKey");
    } else if (chatState.v2Ready && !chatState.pendingStage) {
      handshakeStatusEl.textContent = t("hsComplete");
      setStatusColor(handshakeStatusEl, "--success");
      handshakeBtn.disabled = true;
      handshakeBtn.textContent = t("btnHandshake");
    } else if (chatState.pendingStage === "hs1_sent") {
      handshakeStatusEl.textContent = t("hsWaiting");
      setStatusColor(handshakeStatusEl, "--warning");
      handshakeBtn.disabled = false;
      handshakeBtn.textContent = t("btnHandshake");
    } else if (chatState.pendingStage === "awaiting_click") {
      handshakeStatusEl.textContent = t("hsOffer");
      setStatusColor(handshakeStatusEl, "--warning");
      handshakeBtn.disabled = false;
      handshakeBtn.textContent = t("btnCompleteHandshake");
    } else {
      handshakeStatusEl.textContent = t("hsNotStarted");
      setStatusColor(handshakeStatusEl, "--text-muted");
      handshakeBtn.disabled = false;
      handshakeBtn.textContent = t("btnHandshake");
    }

    setVisible(safetyCard, !!chatState.fingerprint);
    if (chatState.fingerprint) {
      fingerprintEl.textContent = chatState.fingerprint;
    }

    setVisible(composeCard, chatState.v2Ready || chatState.legacyReady);
    setVisible(rotateBtn, chatState.v2Ready || chatState.legacyReady);
    setVisible(rekeyWarning, !!chatState.warnRekey);
    setVisible(legacyPeerWarning, !!chatState.peerLegacy);
    setVisible(legacyKeyWarning, !!chatState.legacyReady && !chatState.v2Ready);
  }

  // Native confirm() dialogs are unreliable inside extension popups, so
  // destructive buttons ask for a second click within a short window.
  function armTwoStep(button, onConfirm) {
    let armed = false;
    let disarmTimer = null;
    let restoreLabel = null;

    button.addEventListener("click", async () => {
      if (!chatId) return;

      if (!armed) {
        armed = true;
        restoreLabel = button.textContent;
        button.textContent = t("btnConfirm");
        disarmTimer = setTimeout(() => {
          armed = false;
          button.textContent = restoreLabel;
        }, 4000);
        return;
      }

      clearTimeout(disarmTimer);
      armed = false;
      button.textContent = restoreLabel;
      await onConfirm();
    });
  }

  langSwitchBtn.addEventListener("click", async () => {
    lang = PardehI18n.next(lang);
    t = PardehI18n.create(lang);
    await api.storage.local.set({ [PardehI18n.STORAGE_KEY]: lang });
    applyStaticTranslations();
    refreshUI();
  });

  toggle.addEventListener("change", async () => {
    if (!chatId) return;

    updateEncryptionLabel(toggle.checked);

    const res = await sendToBackground("ENCRYPT_TOGGLE", {
      chatId,
      enabled: toggle.checked
    });

    if (res.success) {
      log(t(toggle.checked ? "statusEnabled" : "statusDisabled"));
    } else {
      updateEncryptionLabel(!toggle.checked);
      toggle.checked = !toggle.checked;
      showStatus(t("errToggleFailed", { error: res.error }), "error");
    }

    refreshUI();
  });

  handshakeBtn.addEventListener("click", async () => {
    if (!chatId) return;

    const res = await sendToBackground("HANDSHAKE_CLICK", { chatId, tabId });

    if (res.success) {
      showActionStatus(res.action);
    } else {
      showStatus(t("errHandshakeFailed", { error: res.error }), "error");
    }

    setTimeout(refreshUI, 500);
  });

  armTwoStep(rotateBtn, async () => {
    const res = await sendToBackground("ROTATE_KEYS", { chatId, tabId });

    if (res.success) {
      showActionStatus(res.action);
    } else {
      showStatus(t("errRotationFailed", { error: res.error }), "error");
    }

    setTimeout(refreshUI, 500);
  });

  armTwoStep(clearBtn, async () => {
    const res = await sendToBackground("CLEAR_CHAT_STATE", { chatId });

    if (res.success) {
      showStatus(t("statusCleared"), "warn");
    } else {
      showStatus(t("errClearFailed", { error: res.error }), "error");
    }

    setTimeout(refreshUI, 300);
  });

  composeSendBtn.addEventListener("click", async () => {
    const text = composeInput.value.trim();
    if (!chatId || !text) return;

    composeSendBtn.disabled = true;
    const res = await sendToBackground("SEND_ENCRYPTED", { chatId, tabId, text });
    composeSendBtn.disabled = false;

    if (res.success) {
      composeInput.value = "";
      showStatus(t("composeSent"), "success");
    } else {
      // Fail closed: the plaintext stays here in the popup, nothing was
      // handed to the page.
      showStatus(t("errComposeFailed", { error: res.error }), "error");
    }
  });

  copyFingerprintBtn.addEventListener("click", async () => {
    const value = fingerprintEl.textContent.trim();
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      copyFingerprintBtn.textContent = t("copied");
      setTimeout(() => {
        copyFingerprintBtn.textContent = t("copySafetyNumber");
      }, 1500);
    } catch (err) {
      showStatus(t("errCopyFailed", { error: err.message }), "error");
    }
  });

  await loadLanguage();
  await refreshUI();
});
