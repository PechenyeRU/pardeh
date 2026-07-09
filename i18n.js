"use strict";

/**
 * Pardeh UI strings — English and Persian.
 *
 * Loaded as a classic script by the popup and the content script. The
 * selected language is stored in chrome.storage.local under "ui_language"
 * and defaults to the browser locale (fa* -> Persian, anything else ->
 * English). Keys missing from a dictionary fall back to English.
 */

const PARDEH_LANGUAGES = ["en", "fa"];

const PARDEH_DICTIONARIES = {
  en: {
    appName: "Pardeh",

    // Popup: status card
    chatIdLabel: "Chat ID:",
    encryptionLabel: "Encryption:",
    handshakeLabel: "Handshake:",
    keyStatusLabel: "Key Status:",
    loading: "Loading...",
    checking: "Checking...",
    enabled: "Enabled",
    disabled: "Disabled",
    openBale: "Open web.bale.ai",
    openChat: "Open a chat",
    keyReady: "Ready (epoch {epoch})",
    keyLegacy: "Legacy key",
    keyNone: "No key",
    hsComplete: "Complete",
    hsWaiting: "Waiting for peer",
    hsOffer: "Offer received",
    hsNotStarted: "Not started",
    hsNewKeyOffer: "New key offer!",

    // Popup: safety number
    safetyTitle: "Safety number",
    safetyHint: "Compare this number with your contact over another channel (call, in person). If it does not match, someone may be intercepting the conversation — do not trust the chat.",
    copySafetyNumber: "Copy safety number",
    copied: "Copied!",

    // Popup: toggle and actions
    toggleLabel: "Enable Encryption",
    btnHandshake: "Initiate Handshake",
    btnAcceptKey: "Accept New Key",
    btnCompleteHandshake: "Complete Handshake",
    btnRotate: "Rotate Keys",
    btnClear: "Clear Keys",
    btnConfirm: "Are you sure?",

    // Popup: secure compose
    composeTitle: "Secure compose",
    composePlaceholder: "Write your message…",
    composeHint: "Text typed here never reaches the Bale page — only the encrypted envelope is injected. Use this if you do not trust the page with your keystrokes.",
    composeSend: "Encrypt & Send",
    composeSent: "Encrypted message sent",
    errComposeFailed: "Send failed: {error}",

    // Composer overlay
    composerPlaceholder: "Encrypted message…",
    composerSend: "Send",
    composerEmblemHint: "Your personal emblem. If the message box does not show exactly these emoji, it is not Pardeh — do not type in it.",
    emblemTitle: "Your emblem",
    emblemHint: "The secure message box always shows these three emoji. A fake box drawn by the website cannot know them.",
    menuComposerOn: "Use secure message box",
    menuComposerOff: "Use the website's message box",

    // Popup: banners
    rekeyWarning: "The contact sent a new key offer. Accept it only if they told you they rotated keys, then compare the new safety number out-of-band.",
    legacyPeerWarning: "Your contact runs an outdated version of Pardeh. Ask them to update before doing a handshake.",
    legacyKeyWarning: "This chat uses a legacy key from an old version. Rotate keys to upgrade to the current protocol.",

    // Popup: statuses
    statusSentHs1: "Handshake offer sent — your contact must accept it",
    statusRotation: "Rotation started — your contact must accept the new key",
    statusEstablished: "Encryption established — compare the safety number",
    statusWaiting: "Waiting for your contact to answer the handshake",
    statusAlreadyReady: "Encryption is already established",
    statusEnabled: "Encryption enabled",
    statusDisabled: "Encryption disabled",
    statusCleared: "Keys and state cleared",
    errHandshakeFailed: "Handshake failed: {error}",
    errRotationFailed: "Rotation failed: {error}",
    errToggleFailed: "Failed to toggle encryption: {error}",
    errClearFailed: "Failed to clear state: {error}",
    errLoadFailed: "Failed to load state: {error}",
    errCopyFailed: "Copy failed: {error}",

    // Content: toasts
    toastEncryptFailed: "Could not encrypt — the message was NOT sent",
    toastInvalidHandshake: "Invalid handshake message received — ignored",
    toastOutdatedPeer: "Your contact runs an outdated Pardeh version — ask them to update",
    toastOfferReceived: "Encryption key offer received — open Pardeh to accept",
    toastOfferRekey: "New encryption key offer received — open Pardeh to verify and accept",
    toastEstablished: "End-to-end encryption established — verify the safety number in Pardeh",
    toastHandshakeFailed: "Handshake failed: {error}",

    // Content: status dot + menu
    dotOff: "Encryption off",
    dotEnabledNoKey: "Encryption enabled — handshake needed",
    dotActive: "End-to-end encryption active",
    dotLegacy: "Encryption active (legacy key) — rotate keys",
    dotRekey: "New key offer — verify before accepting",
    menuEnable: "Enable encryption",
    menuDisable: "Disable encryption",
    menuStartHandshake: "Start handshake",
    menuCompleteHandshake: "Complete handshake",
    menuAcceptKey: "Accept new key",
    menuWaitingPeer: "Waiting for peer…",
    menuCompareHint: "Compare with your contact over another channel.",

    // Content: inline decrypt errors
    errNoKey: "Encrypted — no key on this device",
    errBadEnvelope: "Malformed encrypted message",
    errAuthFailed: "Failed to decrypt",
    decryptedTooltip: "Decrypted message"
  },

  fa: {
    appName: "پرده",

    chatIdLabel: "شناسه گفتگو:",
    encryptionLabel: "رمزنگاری:",
    handshakeLabel: "تبادل کلید:",
    keyStatusLabel: "وضعیت کلید:",
    loading: "در حال بارگذاری…",
    checking: "در حال بررسی…",
    enabled: "فعال",
    disabled: "غیرفعال",
    openBale: "web.bale.ai را باز کنید",
    openChat: "یک گفتگو باز کنید",
    keyReady: "آماده (دوره {epoch})",
    keyLegacy: "کلید قدیمی",
    keyNone: "بدون کلید",
    hsComplete: "تکمیل شد",
    hsWaiting: "در انتظار مخاطب",
    hsOffer: "پیشنهاد دریافت شد",
    hsNotStarted: "شروع نشده",
    hsNewKeyOffer: "پیشنهاد کلید جدید!",

    safetyTitle: "شمارهٔ امنیتی",
    safetyHint: "این شماره را از راه دیگری (تماس یا حضوری) با مخاطب خود مقایسه کنید. اگر یکسان نبود، ممکن است شخصی در حال شنود گفتگو باشد — به این گفتگو اعتماد نکنید.",
    copySafetyNumber: "کپی شمارهٔ امنیتی",
    copied: "کپی شد!",

    toggleLabel: "فعال‌سازی رمزنگاری",
    btnHandshake: "شروع تبادل کلید",
    btnAcceptKey: "پذیرش کلید جدید",
    btnCompleteHandshake: "تکمیل تبادل کلید",
    btnRotate: "چرخش کلیدها",
    btnClear: "حذف کلیدها",
    btnConfirm: "مطمئن هستید؟",

    composeTitle: "ارسال امن",
    composePlaceholder: "پیام خود را بنویسید…",
    composeHint: "متنی که اینجا می‌نویسید هرگز به صفحهٔ بله نمی‌رسد — فقط نسخهٔ رمز شده تزریق می‌شود. اگر به صفحه اعتماد ندارید از اینجا بنویسید.",
    composeSend: "رمزنگاری و ارسال",
    composeSent: "پیام رمز شده ارسال شد",
    errComposeFailed: "ارسال ناموفق بود: {error}",

    composerPlaceholder: "پیام رمزشده…",
    composerSend: "ارسال",
    composerEmblemHint: "نشان شخصی شما. اگر کادر پیام دقیقاً همین ایموجی‌ها را نشان نمی‌دهد، پرده نیست — در آن تایپ نکنید.",
    emblemTitle: "نشان شما",
    emblemHint: "کادر پیام امن همیشه این سه ایموجی را نشان می‌دهد. کادر جعلی که وب‌سایت بکشد نمی‌تواند آن‌ها را بداند.",
    menuComposerOn: "استفاده از کادر پیام امن",
    menuComposerOff: "استفاده از کادر پیام وب‌سایت",

    rekeyWarning: "مخاطب شما کلید جدیدی پیشنهاد داده است. فقط اگر خودش تأیید کرده که کلید را عوض کرده بپذیرید و سپس شمارهٔ امنیتی جدید را از راه دیگری مقایسه کنید.",
    legacyPeerWarning: "مخاطب شما نسخهٔ قدیمی پرده را اجرا می‌کند. پیش از تبادل کلید از او بخواهید به‌روزرسانی کند.",
    legacyKeyWarning: "این گفتگو از کلید نسخهٔ قدیمی استفاده می‌کند. برای ارتقا به پروتکل جدید، کلیدها را بچرخانید.",

    statusSentHs1: "پیشنهاد تبادل کلید ارسال شد — مخاطب باید آن را بپذیرد",
    statusRotation: "چرخش کلید آغاز شد — مخاطب باید کلید جدید را بپذیرد",
    statusEstablished: "رمزنگاری برقرار شد — شمارهٔ امنیتی را مقایسه کنید",
    statusWaiting: "در انتظار پاسخ مخاطب به تبادل کلید",
    statusAlreadyReady: "رمزنگاری از قبل برقرار است",
    statusEnabled: "رمزنگاری فعال شد",
    statusDisabled: "رمزنگاری غیرفعال شد",
    statusCleared: "کلیدها و وضعیت حذف شدند",
    errHandshakeFailed: "تبادل کلید ناموفق بود: {error}",
    errRotationFailed: "چرخش کلید ناموفق بود: {error}",
    errToggleFailed: "تغییر وضعیت رمزنگاری ناموفق بود: {error}",
    errClearFailed: "حذف وضعیت ناموفق بود: {error}",
    errLoadFailed: "بارگذاری وضعیت ناموفق بود: {error}",
    errCopyFailed: "کپی ناموفق بود: {error}",

    toastEncryptFailed: "رمزنگاری انجام نشد — پیام ارسال نشد",
    toastInvalidHandshake: "پیام تبادل کلید نامعتبر دریافت شد — نادیده گرفته شد",
    toastOutdatedPeer: "مخاطب شما نسخهٔ قدیمی پرده دارد — از او بخواهید به‌روزرسانی کند",
    toastOfferReceived: "پیشنهاد کلید رمزنگاری دریافت شد — برای پذیرش، پرده را باز کنید",
    toastOfferRekey: "پیشنهاد کلید جدید دریافت شد — برای بررسی و پذیرش، پرده را باز کنید",
    toastEstablished: "رمزنگاری سرتاسری برقرار شد — شمارهٔ امنیتی را در پرده بررسی کنید",
    toastHandshakeFailed: "تبادل کلید ناموفق بود: {error}",

    dotOff: "رمزنگاری خاموش است",
    dotEnabledNoKey: "رمزنگاری فعال است — تبادل کلید لازم است",
    dotActive: "رمزنگاری سرتاسری فعال است",
    dotLegacy: "رمزنگاری با کلید قدیمی — کلیدها را بچرخانید",
    dotRekey: "پیشنهاد کلید جدید — پیش از پذیرش بررسی کنید",
    menuEnable: "فعال‌سازی رمزنگاری",
    menuDisable: "غیرفعال‌سازی رمزنگاری",
    menuStartHandshake: "شروع تبادل کلید",
    menuCompleteHandshake: "تکمیل تبادل کلید",
    menuAcceptKey: "پذیرش کلید جدید",
    menuWaitingPeer: "در انتظار مخاطب…",
    menuCompareHint: "این شماره را از راه دیگری با مخاطب مقایسه کنید.",

    errNoKey: "رمز شده — کلیدی روی این دستگاه نیست",
    errBadEnvelope: "پیام رمز شدهٔ نامعتبر",
    errAuthFailed: "رمزگشایی ناموفق بود",
    decryptedTooltip: "پیام رمزگشایی‌شده"
  }
};

function pardehResolveLanguage(stored) {
  if (PARDEH_LANGUAGES.includes(stored)) return stored;
  const browserLang = (globalThis.navigator?.language || "en").toLowerCase();
  return browserLang.startsWith("fa") ? "fa" : "en";
}

function pardehCreateTranslator(lang) {
  const dict = PARDEH_DICTIONARIES[lang] || PARDEH_DICTIONARIES.en;
  return (key, params) => {
    let text = dict[key] ?? PARDEH_DICTIONARIES.en[key] ?? key;
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.replace(`{${name}}`, String(value));
      }
    }
    return text;
  };
}

const PardehI18n = {
  LANGUAGES: PARDEH_LANGUAGES,
  STORAGE_KEY: "ui_language",
  resolveLanguage: pardehResolveLanguage,
  create: pardehCreateTranslator,
  isRtl: (lang) => lang === "fa",
  next: (lang) => PARDEH_LANGUAGES[(PARDEH_LANGUAGES.indexOf(lang) + 1) % PARDEH_LANGUAGES.length]
};

globalThis.PardehI18n = PardehI18n;
if (typeof module !== "undefined" && module.exports) {
  module.exports = PardehI18n;
}
