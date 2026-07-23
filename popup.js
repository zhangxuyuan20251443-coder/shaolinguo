"use strict";

const DEFAULT_SETTINGS = {
  enabled: true,
  sourceLanguage: "auto",
  targetLanguage: "zh"
};

const enabled = document.querySelector("#enabled");
const sourceLanguage = document.querySelector("#sourceLanguage");
const targetLanguage = document.querySelector("#targetLanguage");
const apply = document.querySelector("#apply");
const status = document.querySelector("#status");

chrome.storage.local.get({ translationSettings: DEFAULT_SETTINGS }, ({ translationSettings }) => {
  const settings = { ...DEFAULT_SETTINGS, ...(translationSettings || {}) };
  enabled.checked = settings.enabled !== false;
  sourceLanguage.value = settings.sourceLanguage || "auto";
  targetLanguage.value = settings.targetLanguage || "zh";
});

apply.addEventListener("click", async () => {
  apply.disabled = true;
  status.textContent = "正在应用…";
  const translationSettings = {
    enabled: enabled.checked,
    sourceLanguage: sourceLanguage.value,
    targetLanguage: targetLanguage.value
  };
  await chrome.storage.local.set({ translationSettings });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && /^https?:/i.test(tab.url || "")) await chrome.tabs.reload(tab.id);
  status.textContent = translationSettings.enabled ? "已应用" : "已暂停翻译";
  window.setTimeout(() => window.close(), 450);
});

document.querySelector("#advanced").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});
