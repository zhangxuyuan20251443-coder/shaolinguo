"use strict";

const DEFAULT_SETTINGS = {
  enabled: true,
  sourceLanguage: "auto",
  targetLanguage: "zh"
};

const targetLanguage = document.querySelector("#targetLanguage");
const status = document.querySelector("#status");

chrome.storage.local.get({ translationSettings: DEFAULT_SETTINGS }, ({ translationSettings }) => {
  const settings = { ...DEFAULT_SETTINGS, ...(translationSettings || {}) };
  const supportedTargets = new Set([...targetLanguage.options].map((option) => option.value));
  targetLanguage.value = supportedTargets.has(settings.targetLanguage) ? settings.targetLanguage : "zh";
  if (settings.enabled === false || settings.sourceLanguage !== "auto") {
    chrome.storage.local.set({
      translationSettings: {
        enabled: true,
        sourceLanguage: "auto",
        targetLanguage: targetLanguage.value
      }
    });
  }
});

targetLanguage.addEventListener("change", async () => {
  targetLanguage.disabled = true;
  status.textContent = "正在应用";
  const translationSettings = {
    enabled: true,
    sourceLanguage: "auto",
    targetLanguage: targetLanguage.value
  };
  await chrome.storage.local.set({ translationSettings });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && /^https?:/i.test(tab.url || "")) await chrome.tabs.reload(tab.id);
  status.textContent = "已应用";
  window.setTimeout(() => window.close(), 180);
});
