"use strict";

const DEFAULT_SETTINGS = {
  enabled: true,
  sourceLanguage: "auto",
  targetLanguage: "zh"
};

const targetLanguage = document.querySelector("#targetLanguage");
const status = document.querySelector("#status");
const supportedTargets = new Set([...targetLanguage.options].map((option) => option.value));
let currentTarget = DEFAULT_SETTINGS.targetLanguage;

chrome.storage.local.get({ translationSettings: DEFAULT_SETTINGS }, ({ translationSettings }) => {
  const settings = { ...DEFAULT_SETTINGS, ...(translationSettings || {}) };
  targetLanguage.value = supportedTargets.has(settings.targetLanguage) ? settings.targetLanguage : "zh";
  currentTarget = targetLanguage.value;
  status.textContent = `当前目标：${selectedLanguageName()}`;
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
  const previousTarget = currentTarget;
  const selectedTarget = targetLanguage.value;
  const selectedName = selectedLanguageName();
  const modelPreparation = prepareTargetModel(selectedTarget, selectedName);
  targetLanguage.disabled = true;
  targetLanguage.setAttribute("aria-busy", "true");
  status.textContent = `正在切换到${selectedName}…`;
  const translationSettings = {
    enabled: true,
    sourceLanguage: "auto",
    targetLanguage: selectedTarget
  };
  try {
    await chrome.storage.local.set({ translationSettings });
    const saved = await chrome.storage.local.get({ translationSettings: DEFAULT_SETTINGS });
    if (saved.translationSettings?.targetLanguage !== selectedTarget) {
      throw new Error("目标语言没有保存成功");
    }
    await modelPreparation;
    targetLanguage.value = selectedTarget;
    currentTarget = selectedTarget;
    status.textContent = `已切换到${selectedName}，正在刷新网页…`;
    await new Promise((resolve) => window.setTimeout(resolve, 480));
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.reload(tab.id);
    }
    status.textContent = `当前目标：${selectedName}`;
    targetLanguage.disabled = false;
    targetLanguage.removeAttribute("aria-busy");
  } catch {
    targetLanguage.value = previousTarget;
    await chrome.storage.local.set({
      translationSettings: {
        enabled: true,
        sourceLanguage: "auto",
        targetLanguage: previousTarget
      }
    }).catch(() => {});
    status.textContent = `无法准备${selectedName}模型，仍使用${languageNameFor(previousTarget)}`;
    targetLanguage.disabled = false;
    targetLanguage.removeAttribute("aria-busy");
  }
});

function selectedLanguageName() {
  return targetLanguage.selectedOptions[0]?.textContent?.trim() || "简体中文";
}

function languageNameFor(target) {
  return [...targetLanguage.options].find((option) => option.value === target)?.textContent?.trim() || "简体中文";
}

function prepareTargetModel(target, languageName) {
  if (target === "en" || typeof Translator === "undefined") return Promise.resolve();
  try {
    return Translator.create({
      sourceLanguage: "en",
      targetLanguage: target,
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          const percent = Math.max(0, Math.min(100, Math.round(Number(event.loaded || 0) * 100)));
          status.textContent = `正在准备${languageName}翻译模型 ${percent}%`;
        });
      }
    }).then((translator) => {
      translator.destroy?.();
    });
  } catch (error) {
    return Promise.reject(error);
  }
}
