// Firefox exposes promise-based `browser.*`; Chrome exposes `chrome.*`.
const api = globalThis.browser ?? globalThis.chrome;

document.addEventListener("DOMContentLoaded", async () => {
  const chatIdEl = document.getElementById("chatId");
  const encryptionStatusEl = document.getElementById("encryptionStatus");
  const handshakeStatusEl = document.getElementById("handshakeStatus");
  const keyStatusEl = document.getElementById("keyStatus");

  const toggle = document.getElementById("encryptionToggle");
  const handshakeBtn = document.getElementById("initiateHandshake");
  const clearBtn = document.getElementById("clearKeys");
  const logsEl = document.getElementById("logs");

  let chatId = null;
  let tabId = null;

  function setStatusColor(element, token) {
    element.style.color = `var(${token})`;
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
    if (!tabs.length) return { chatId: null, tabId: null };

    try {
      const res = await api.tabs.sendMessage(tabs[0].id, { type: "GET_CHAT_ID" });
      return { chatId: res?.chatId || null, tabId: tabs[0].id };
    } catch {
      return { chatId: null, tabId: tabs[0].id };
    }
  }

  async function refreshUI() {
    ({ chatId, tabId } = await getActiveChatContext());

    if (!chatId) {
      chatIdEl.textContent = "Not detected";
      handshakeBtn.disabled = true;
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
      keyStatusEl.textContent = "Ready";
      setStatusColor(keyStatusEl, "--success");
    } else if (chatState.legacyReady) {
      keyStatusEl.textContent = "Legacy key";
      setStatusColor(keyStatusEl, "--warning");
    } else {
      keyStatusEl.textContent = "No key";
      setStatusColor(keyStatusEl, "--text-muted");
    }

    if (chatState.warnRekey) {
      handshakeStatusEl.textContent = "New key offer — verify peer!";
      setStatusColor(handshakeStatusEl, "--danger");
      handshakeBtn.disabled = false;
    } else if (chatState.v2Ready && !chatState.pendingStage) {
      handshakeStatusEl.textContent = "Complete";
      setStatusColor(handshakeStatusEl, "--success");
      handshakeBtn.disabled = true;
    } else if (chatState.pendingStage === "hs1_sent") {
      handshakeStatusEl.textContent = "Waiting for peer";
      setStatusColor(handshakeStatusEl, "--warning");
      handshakeBtn.disabled = false;
    } else if (chatState.pendingStage === "awaiting_click") {
      handshakeStatusEl.textContent = "Offer received";
      setStatusColor(handshakeStatusEl, "--warning");
      handshakeBtn.disabled = false;
    } else {
      handshakeStatusEl.textContent = "Not started";
      setStatusColor(handshakeStatusEl, "--text-muted");
      handshakeBtn.disabled = false;
    }
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

  clearBtn.addEventListener("click", async () => {
    if (!chatId) return;

    const res = await sendToBackground("CLEAR_CHAT_STATE", { chatId });

    if (res.success) {
      log("Cleared keys and state", "warn");
    } else {
      log("Failed to clear state", "error");
    }

    setTimeout(refreshUI, 300);
  });

  await refreshUI();
});
