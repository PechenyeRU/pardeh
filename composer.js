"use strict";

/**
 * Secure composer — runs as an extension-origin page inside an iframe
 * overlaid on Bale's message input.
 *
 * Why an iframe and not shadow DOM: keystrokes typed into a same-page
 * element (shadow root included) are visible to window-level listeners
 * the host page installs. A cross-origin browsing context does not
 * propagate its key events to the parent, so what the user types here is
 * unreachable from page scripts. The plaintext leaves this frame only
 * through runtime messaging to the background script, which returns the
 * ciphertext and injects that into the chat.
 *
 * The chat id is fetched from the background script, never accepted via
 * postMessage: a hostile page could postMessage this frame while
 * impersonating the content script (same window.parent, same origin) and
 * steer the composer at another chat's key.
 *
 * The emblem (three emoji chosen once per installation) defends against
 * a page that draws a look-alike composer: page scripts cannot read this
 * frame's DOM, so they cannot learn which emoji to render.
 */

const api = globalThis.browser ?? globalThis.chrome;

const emblemEl = document.getElementById("emblem");
const inputEl = document.getElementById("input");
const sendEl = document.getElementById("send");
const errorEl = document.getElementById("error");

let lang = "en";
let t = PardehI18n.create(lang);
let chatId = null;
let sending = false;
let errorTimer = null;

function applyLanguage() {
  document.documentElement.lang = lang;
  const rtl = PardehI18n.isRtl(lang);
  document.documentElement.dir = rtl ? "rtl" : "ltr";
  inputEl.placeholder = t("composerPlaceholder");
  sendEl.textContent = t("composerSend");
  emblemEl.title = t("composerEmblemHint");
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => errorEl.classList.add("hidden"), 6000);
}

async function sendToBackground(type, data = {}) {
  try {
    return (await api.runtime.sendMessage({ type, ...data })) || {};
  } catch (err) {
    return { error: String(err?.message || err) };
  }
}

async function loadPreferences() {
  const stored = await api.storage.local.get([PardehI18n.STORAGE_KEY, "ui_emblem"]);
  lang = PardehI18n.resolveLanguage(stored[PardehI18n.STORAGE_KEY]);
  t = PardehI18n.create(lang);
  emblemEl.textContent = stored.ui_emblem || "";
  applyLanguage();
}

async function loadChatId() {
  const res = await sendToBackground("COMPOSER_INIT");
  chatId = res?.chatId || null;
  sendEl.disabled = !chatId;
}

async function submit() {
  const text = inputEl.value.trim();
  if (!text || sending) return;

  if (!chatId) {
    await loadChatId();
    if (!chatId) {
      showError(t("errComposeFailed", { error: "no chat" }));
      return;
    }
  }

  sending = true;
  sendEl.disabled = true;

  const res = await sendToBackground("SEND_ENCRYPTED", { chatId, text });

  sending = false;
  sendEl.disabled = false;

  if (res.success) {
    // Clear only after the background confirms the ciphertext was
    // delivered. On failure the plaintext stays here, never in the page.
    inputEl.value = "";
    autoGrow();
  } else {
    showError(t("errComposeFailed", { error: res.error || "unknown" }));
  }

  inputEl.focus();
}

function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 120)}px`;
}

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});

inputEl.addEventListener("input", autoGrow);
sendEl.addEventListener("click", submit);

api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes[PardehI18n.STORAGE_KEY] || changes.ui_emblem) {
    loadPreferences();
  }

  // A handshake, rotation or clear may have changed which chat we can
  // encrypt for; re-resolve rather than trust a stale id.
  if (Object.keys(changes).some((k) => k.startsWith("chat_meta_"))) {
    loadChatId();
  }
});

(async () => {
  await loadPreferences();
  await loadChatId();
  autoGrow();
})();
