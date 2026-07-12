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

// The content script pins the page's theme on the iframe URL; without it
// (standalone open) fall back to the OS scheme.
function applyTheme() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("theme");
  const theme =
    fromHash || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
}
applyTheme();
window.addEventListener("hashchange", applyTheme);

const emblemEl = document.getElementById("emblem");
const inputEl = document.getElementById("input");
const sendEl = document.getElementById("send");
const errorEl = document.getElementById("error");
const pickerEl = document.getElementById("picker");
const emojiToggleEl = document.getElementById("emoji-toggle");

let lang = "en";
let t = PardehI18n.create(lang);
let chatId = null;
let sending = false;
let errorTimer = null;
let pickerOpen = false;
let pickerBuilt = false;
let tonePopEl = null;
// base emoji -> its renderable skin-tone variants, filled while building
// the grid so the same font filter applies to the variants too.
const toneVariants = new Map();

function closeTonePop() {
  tonePopEl?.remove();
  tonePopEl = null;
}

function openTonePop(anchorBtn, base) {
  closeTonePop();
  const pop = document.createElement("div");
  pop.className = "tone-pop";
  for (const emoji of [base, ...toneVariants.get(base)]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = emoji;
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeTonePop();
      insertEmoji(emoji);
    });
    pop.appendChild(btn);
  }
  document.body.appendChild(pop);
  const btnRect = anchorBtn.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  const left = Math.max(4, Math.min(innerWidth - popRect.width - 4, btnRect.left + btnRect.width / 2 - popRect.width / 2));
  const top = btnRect.top - popRect.height - 6;
  pop.style.left = `${left}px`;
  // No room above the first grid row: flip below the button.
  pop.style.top = `${top >= 2 ? top : btnRect.bottom + 6}px`;
  tonePopEl = pop;
}

function applyLanguage() {
  document.documentElement.lang = lang;
  const rtl = PardehI18n.isRtl(lang);
  document.documentElement.dir = rtl ? "rtl" : "ltr";
  inputEl.placeholder = t("composerPlaceholder");
  sendEl.textContent = t("composerSend");
  emblemEl.title = t("composerEmblemHint");
  emojiToggleEl.title = t("composerEmojiHint");
  emojiToggleEl.setAttribute("aria-label", t("composerEmojiHint"));
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

  sending = true;
  sendEl.disabled = true;

  // Re-resolve on every send: the id cached at load time goes stale the
  // moment the user switches chats, and sending under it would encrypt
  // for the previous chat. The content script answers with the id it
  // verified against the live URL, or null while a switch is settling.
  await loadChatId();
  if (!chatId) {
    sending = false;
    sendEl.disabled = false;
    showError(t("errComposeFailed", { error: "no chat" }));
    return;
  }
  sendEl.disabled = true; // loadChatId re-enabled it; still sending

  const res = await sendToBackground("SEND_ENCRYPTED", { chatId, text });

  sending = false;
  sendEl.disabled = false;

  if (res.success) {
    // Clear only after the background confirms the ciphertext was
    // delivered. On failure the plaintext stays here, never in the page.
    inputEl.value = "";
    autoGrow();
    if (pickerOpen) togglePicker();
  } else {
    showError(t("errComposeFailed", { error: res.error || "unknown" }));
  }

  inputEl.focus();
}

function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 120)}px`;
}

async function buildPicker() {
  if (pickerBuilt) return;
  pickerBuilt = true;

  // Measure with the same stack the buttons render with; the bundled
  // Twemoji face loads async, so wait for it or the filter would judge
  // against the fallback font only.
  try {
    await document.fonts.load("20px Twemoji");
  } catch (_) {}

  // The full Unicode list (emoji-data.js) outruns what the fonts can
  // draw: hide what would render broken. fonts.check() answers coverage
  // for the bundled Twemoji face exactly; whatever it lacks is kept only
  // if the system font draws every codepoint (pixel-compared against the
  // missing-glyph box — advance widths are useless across mixed stacks).
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 24;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.font = "18px Twemoji, sans-serif";
  ctx.textBaseline = "top";
  const sig = (text) => {
    ctx.clearRect(0, 0, 24, 24);
    ctx.fillText(text, 0, 2);
    const d = ctx.getImageData(0, 0, 24, 24).data;
    let hash = 0;
    for (let i = 0; i < d.length; i += 7) hash = ((hash * 31) + d[i]) >>> 0;
    return hash;
  };
  const tofuSig = sig("\u{10FFFE}");
  const blankSig = sig("");
  // A ZWJ sequence is only usable if some font in the stack shapes it
  // into ONE glyph; when the ligature is missing the components render
  // side by side (roughly two advances wide) and look broken in a cell.
  // Everything else must actually leave pixels that differ from both the
  // missing-glyph box and a blank cell — font metadata over-promises.
  const singleWidth = ctx.measureText("\u{1F600}").width;
  const renders = (emoji) => {
    if (emoji.includes("‍")) {
      return ctx.measureText(emoji).width <= singleWidth * 1.5;
    }
    const g = sig(emoji);
    return g !== tofuSig && g !== blankSig;
  };

  for (const [base, variants] of Object.entries(PARDEH_EMOJI_TONES)) {
    const usable = variants.filter(renders);
    if (usable.length) toneVariants.set(base, usable);
  }

  for (const group of PARDEH_EMOJI_GROUPS) {
    const emoji = group.emoji.filter(renders);
    if (!emoji.length) continue;

    const header = document.createElement("div");
    header.className = "picker-group";
    header.textContent = group.icon;
    pickerEl.appendChild(header);

    for (const e of emoji) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = e;

      if (toneVariants.has(e)) {
        btn.classList.add("has-tones");
        // Long-press (or right-click) opens the variants; the click that
        // follows the release of a long-press must not also insert.
        let pressTimer = null;
        let suppressClick = false;
        btn.addEventListener("pointerdown", () => {
          pressTimer = setTimeout(() => {
            suppressClick = true;
            openTonePop(btn, e);
          }, 450);
        });
        const cancelPress = () => clearTimeout(pressTimer);
        btn.addEventListener("pointerup", cancelPress);
        btn.addEventListener("pointerleave", cancelPress);
        btn.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          openTonePop(btn, e);
        });
        btn.addEventListener("click", () => {
          if (suppressClick) {
            suppressClick = false;
            return;
          }
          insertEmoji(e);
        });
      } else {
        btn.addEventListener("click", () => insertEmoji(e));
      }
      pickerEl.appendChild(btn);
    }
  }

  // The popover is anchored to the viewport: any scroll or stray click
  // would leave it floating over the wrong cell.
  pickerEl.addEventListener("scroll", closeTonePop);
  document.addEventListener("pointerdown", (ev) => {
    if (tonePopEl && !tonePopEl.contains(ev.target)) closeTonePop();
  });
}

function insertEmoji(emoji) {
  const start = inputEl.selectionStart ?? inputEl.value.length;
  const end = inputEl.selectionEnd ?? start;
  inputEl.setRangeText(emoji, start, end, "end");
  inputEl.focus();
  autoGrow();
}

// This frame cannot resize its own <iframe> element (the parent document
// owns it), so the panel is revealed only after the content script — via
// the background, since page-level postMessage is untrusted both ways —
// has granted the frame the extra height. Opening before the grant would
// squeeze the input strip inside the old 48px viewport.
async function togglePicker() {
  if (!pickerOpen) {
    await buildPicker();
    const res = await sendToBackground("COMPOSER_PANEL", { open: true });
    if (!res.success) return;
    pickerOpen = true;
    pickerEl.classList.remove("hidden");
  } else {
    pickerOpen = false;
    closeTonePop();
    pickerEl.classList.add("hidden");
    await sendToBackground("COMPOSER_PANEL", { open: false });
    inputEl.focus();
  }
}

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (tonePopEl) {
    closeTonePop();
    return;
  }
  if (pickerOpen) togglePicker();
});

inputEl.addEventListener("input", autoGrow);
sendEl.addEventListener("click", submit);
emojiToggleEl.addEventListener("click", togglePicker);

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
