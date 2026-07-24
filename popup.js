"use strict";

const DEFAULT_SETTINGS = {
  enabled: true,
  sourceLanguage: "auto",
  targetLanguage: "zh"
};

const status = document.querySelector("#status");

initialize();

async function initialize() {
  try {
    const stored = await chrome.storage.local.get({ translationSettings: DEFAULT_SETTINGS });
    const settings = { ...DEFAULT_SETTINGS, ...(stored.translationSettings || {}) };
    const needsReset = settings.enabled === false ||
      settings.sourceLanguage !== "auto" ||
      settings.targetLanguage !== "zh";
    await chrome.storage.local.set({ translationSettings: DEFAULT_SETTINGS });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (isRestrictedChromePage(tab?.url)) {
      status.textContent = "此页受 Chrome 限制；其他网页自动识别";
    } else if (needsReset && tab?.id) {
      status.textContent = "已固定为简体中文，正在刷新网页…";
      await chrome.tabs.reload(tab.id);
    } else {
      status.textContent = "自动识别外语并原位翻译";
    }
  } catch {
    status.textContent = "自动翻译为简体中文";
  }
}

function isRestrictedChromePage(url) {
  const value = String(url || "");
  return /^(?:chrome|chrome-extension|edge|about):/i.test(value) ||
    /^https:\/\/(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)\//i.test(value);
}
