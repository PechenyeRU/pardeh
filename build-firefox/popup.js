document.addEventListener("DOMContentLoaded", async () => {
  // Firefox may expose promise-based `browser.*` APIs while callback-based
  // `chrome.*` methods return `undefined`, so the popup uses wrappers here.
  const api = typeof browser !== "undefined" ? browser : chrome;
  const chatIdEl = document.getElementById("chatId");
  const encryptionStatusEl = document.getElementById("encryptionStatus");
  const handshakeStatusEl = document.getElementById("handshakeStatus");
  const keyStatusEl = document.getElementById("keyStatus");

  const toggle = document.getElementById("encryptionToggle");
  const handshakeBtn = document.getElementById("initiateHandshake");
  const clearBtn = document.getElementById("clearKeys");
  const logsEl = document.getElementById("logs");

  let chatId = null;

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

  function sendToBackground(type, data = {}) {
    if (typeof api.runtime.sendMessage === "function" && api.runtime.sendMessage.length < 2) {
      return api.runtime.sendMessage({ type, ...data }).catch((error) => ({
        error: error?.message || String(error)
      }));
    }

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...data }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          resolve(res || {});
        }
      });
    });
  }

  function queryTabs(queryInfo) {
    if (typeof api.tabs.query === "function" && api.tabs.query.length < 2) {
      return api.tabs.query(queryInfo);
    }

    return new Promise((resolve) => {
      chrome.tabs.query(queryInfo, (tabs) => {
        if (chrome.runtime.lastError) {
          resolve([]);
          return;
        }

        resolve(Array.isArray(tabs) ? tabs : []);
      });
    });
  }

  function sendMessageToTab(tabId, message) {
    if (typeof api.tabs.sendMessage === "function" && api.tabs.sendMessage.length < 3) {
      return api.tabs.sendMessage(tabId, message);
    }

    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(response);
      });
    });
  }

  async function getActiveChatId() {
    const tabs = await queryTabs({ active: true, currentWindow: true });
    if (!tabs.length) return null;

    try {
      const res = await sendMessageToTab(tabs[0].id, { type: "GET_CHAT_ID" });
      return res?.chatId || null;
    } catch {
      return null;
    }
  }

  async function refreshUI() {
    chatId = await getActiveChatId();

    if (!chatId) {
      chatIdEl.textContent = "Not detected";
      toggle.checked = false;
      updateEncryptionLabel(false);
      keyStatusEl.textContent = "No key";
      setStatusColor(keyStatusEl, "--text-muted");
      handshakeStatusEl.textContent = "Not started";
      setStatusColor(handshakeStatusEl, "--text-muted");
      handshakeBtn.disabled = true;
      return;
    }

    chatIdEl.textContent = chatId;

    const enc = await sendToBackground("GET_ENCRYPTION_STATUS", { chatId });
    toggle.checked = !!enc.enabled;

    updateEncryptionLabel(!!enc.enabled);

    const key = await sendToBackground("GET_SHARED_KEY", { chatId });
    const hasKey = !!key.key;

    keyStatusEl.textContent = hasKey ? "Ready" : "No key";
    setStatusColor(keyStatusEl, hasKey ? "--success" : "--text-muted");

    const pending = await sendToBackground("GET_PENDING_HANDSHAKE", { chatId });

    if (hasKey) {
      handshakeStatusEl.textContent = "Complete";
      setStatusColor(handshakeStatusEl, "--success");
      handshakeBtn.disabled = true;
    } else if (pending?.pending) {
      handshakeStatusEl.textContent = "In progress";
      setStatusColor(handshakeStatusEl, "--warning");
      handshakeBtn.disabled = false;
    } else {
      handshakeStatusEl.textContent = "Not started";
      setStatusColor(handshakeStatusEl, "--text-muted");
      handshakeBtn.disabled = false;
    }
  }

  // 🔘 Toggle encryption
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
    const tabs = await queryTabs({ active: true, currentWindow: true });
    if (tabs.length) {
      try {
        await sendMessageToTab(tabs[0].id, {
          type: "UPDATE_ENCRYPTION_STATUS",
          enabled: toggle.checked
        });
      } catch (_) {}
    }
    refreshUI();
  });

  // 🤝 Handshake button
  handshakeBtn.addEventListener("click", async () => {
    if (!chatId) return;

    log("Initiating handshake...");

    const res = await sendToBackground("HANDSHAKE_CLICK", { chatId });

    if (res.success) {
      log(`Action: ${res.action}`);
    } else {
      log(`Error: ${res.error}`, "error");
    }

    setTimeout(refreshUI, 500);
  });

  // 🧹 Clear keys
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
