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

  const rekeyWarning = document.getElementById("rekeyWarning");
  const legacyPeerWarning = document.getElementById("legacyPeerWarning");
  const legacyKeyWarning = document.getElementById("legacyKeyWarning");

  const toggle = document.getElementById("encryptionToggle");
  const handshakeBtn = document.getElementById("initiateHandshake");
  const rotateBtn = document.getElementById("rotateKeys");
  const clearBtn = document.getElementById("clearKeys");
  const logsEl = document.getElementById("logs");

  let chatId = null;
  let tabId = null;

  function setStatusColor(element, token) {
    element.style.color = `var(${token})`;
  }

  function setVisible(element, visible) {
    element.classList.toggle("hidden", !visible);
  }

  function updateEncryptionLabel(enabled) {
    encryptionStatusEl.textContent = enabled ? "Enabled" : "Disabled";
    setStatusColor(encryptionStatusEl, enabled ? "--success" : "--text-muted");
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
      chatIdEl.textContent = isBale ? "Open a chat" : "Open web.bale.ai";
      handshakeBtn.disabled = true;
      setVisible(safetyCard, false);
      setVisible(rotateBtn, false);
      setVisible(rekeyWarning, false);
      setVisible(legacyPeerWarning, false);
      setVisible(legacyKeyWarning, false);
      return;
    }

    chatIdEl.textContent = chatId;

    const chatState = await sendToBackground("GET_CHAT_STATE", { chatId });
    if (!chatState.success) {
      log(`Failed to load state: ${chatState.error}`, "error");
      return;
    }

    toggle.checked = !!chatState.enabled;
    updateEncryptionLabel(!!chatState.enabled);

    if (chatState.v2Ready) {
      keyStatusEl.textContent = `Ready (epoch ${chatState.epoch})`;
      setStatusColor(keyStatusEl, "--success");
    } else if (chatState.legacyReady) {
      keyStatusEl.textContent = "Legacy key";
      setStatusColor(keyStatusEl, "--warning");
    } else {
      keyStatusEl.textContent = "No key";
      setStatusColor(keyStatusEl, "--text-muted");
    }

    if (chatState.warnRekey) {
      handshakeStatusEl.textContent = "New key offer!";
      setStatusColor(handshakeStatusEl, "--danger");
      handshakeBtn.disabled = false;
      handshakeBtn.textContent = "Accept New Key";
    } else if (chatState.v2Ready && !chatState.pendingStage) {
      handshakeStatusEl.textContent = "Complete";
      setStatusColor(handshakeStatusEl, "--success");
      handshakeBtn.disabled = true;
      handshakeBtn.textContent = "Initiate Handshake";
    } else if (chatState.pendingStage === "hs1_sent") {
      handshakeStatusEl.textContent = "Waiting for peer";
      setStatusColor(handshakeStatusEl, "--warning");
      handshakeBtn.disabled = false;
      handshakeBtn.textContent = "Initiate Handshake";
    } else if (chatState.pendingStage === "awaiting_click") {
      handshakeStatusEl.textContent = "Offer received";
      setStatusColor(handshakeStatusEl, "--warning");
      handshakeBtn.disabled = false;
      handshakeBtn.textContent = "Complete Handshake";
    } else {
      handshakeStatusEl.textContent = "Not started";
      setStatusColor(handshakeStatusEl, "--text-muted");
      handshakeBtn.disabled = false;
      handshakeBtn.textContent = "Initiate Handshake";
    }

    setVisible(safetyCard, !!chatState.fingerprint);
    if (chatState.fingerprint) {
      fingerprintEl.textContent = chatState.fingerprint;
    }

    setVisible(rotateBtn, chatState.v2Ready || chatState.legacyReady);
    setVisible(rekeyWarning, !!chatState.warnRekey);
    setVisible(legacyPeerWarning, !!chatState.peerLegacy);
    setVisible(legacyKeyWarning, !!chatState.legacyReady && !chatState.v2Ready);
  }

  // Native confirm() dialogs are unreliable inside extension popups, so
  // destructive buttons ask for a second click within a short window.
  function armTwoStep(button, armedLabel, onConfirm) {
    let armed = false;
    let disarmTimer = null;
    const originalLabel = button.textContent;

    button.addEventListener("click", async () => {
      if (!chatId) return;

      if (!armed) {
        armed = true;
        button.textContent = armedLabel;
        disarmTimer = setTimeout(() => {
          armed = false;
          button.textContent = originalLabel;
        }, 4000);
        return;
      }

      clearTimeout(disarmTimer);
      armed = false;
      button.textContent = originalLabel;
      await onConfirm();
    });
  }

  toggle.addEventListener("change", async () => {
    if (!chatId) return;

    updateEncryptionLabel(toggle.checked);

    const res = await sendToBackground("ENCRYPT_TOGGLE", {
      chatId,
      enabled: toggle.checked
    });

    if (res.success) {
      log(`Encryption ${toggle.checked ? "enabled" : "disabled"}`);
    } else {
      updateEncryptionLabel(!toggle.checked);
      toggle.checked = !toggle.checked;
      log("Failed to toggle encryption", "error");
    }

    refreshUI();
  });

  handshakeBtn.addEventListener("click", async () => {
    if (!chatId) return;

    log("Initiating handshake...");

    const res = await sendToBackground("HANDSHAKE_CLICK", { chatId, tabId });

    if (res.success) {
      log(`Action: ${res.action}`);
    } else {
      log(`Error: ${res.error}`, "error");
    }

    setTimeout(refreshUI, 500);
  });

  armTwoStep(rotateBtn, "Really rotate?", async () => {
    const res = await sendToBackground("ROTATE_KEYS", { chatId, tabId });

    if (res.success) {
      log("Key rotation started — peer must complete the handshake", "warn");
    } else {
      log(`Rotation failed: ${res.error}`, "error");
    }

    setTimeout(refreshUI, 500);
  });

  armTwoStep(clearBtn, "Really clear?", async () => {
    const res = await sendToBackground("CLEAR_CHAT_STATE", { chatId });

    if (res.success) {
      log("Cleared keys and state", "warn");
    } else {
      log("Failed to clear state", "error");
    }

    setTimeout(refreshUI, 300);
  });

  copyFingerprintBtn.addEventListener("click", async () => {
    const value = fingerprintEl.textContent.trim();
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      copyFingerprintBtn.textContent = "Copied!";
      setTimeout(() => {
        copyFingerprintBtn.textContent = "Copy safety number";
      }, 1500);
    } catch (err) {
      log(`Copy failed: ${err.message}`, "error");
    }
  });

  await refreshUI();
});
