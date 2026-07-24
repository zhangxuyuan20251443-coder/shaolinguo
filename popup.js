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

chrome.storage.local.get({ translationSettings: DEFAULT_SETTINGS }, async ({ translationSettings }) => {
  const settings = { ...DEFAULT_SETTINGS, ...(translationSettings || {}) };
  targetLanguage.value = supportedTargets.has(settings.targetLanguage) ? settings.targetLanguage : "zh";
  currentTarget = targetLanguage.value;
  status.textContent = `当前目标：${selectedLanguageName()}`;
  if (settings.enabled === false ||
      settings.sourceLanguage !== "auto" ||
      settings.targetLanguage !== currentTarget) {
    chrome.storage.local.set({
      translationSettings: {
        enabled: true,
        sourceLanguage: "auto",
        targetLanguage: targetLanguage.value
      }
    });
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (isRestrictedChromePage(tab?.url)) {
      status.textContent = "此页受 Chrome 限制；其他网页自动识别";
    }
  } catch {
    // 无法读取标签页时保留当前目标语言提示。
  }
});

targetLanguage.addEventListener("change", async () => {
  const previousTarget = currentTarget;
  const selectedTarget = targetLanguage.value;
  const selectedName = selectedLanguageName();
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
  } catch {
    targetLanguage.value = previousTarget;
    await chrome.storage.local.set({
      translationSettings: {
        enabled: true,
        sourceLanguage: "auto",
        targetLanguage: previousTarget
      }
    }).catch(() => {});
    status.textContent = `无法保存设置，仍使用${languageNameFor(previousTarget)}`;
    targetLanguage.disabled = false;
    targetLanguage.removeAttribute("aria-busy");
    return;
  }

  targetLanguage.value = selectedTarget;
  currentTarget = selectedTarget;
  prepareTargetModel(selectedTarget, selectedName).catch(() => {
    if (currentTarget === selectedTarget) {
      status.textContent = `${selectedName}将使用本地语义翻译`;
    }
  });

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (isRestrictedChromePage(tab?.url)) {
      status.textContent = `${selectedName}已保存；Chrome 不允许扩展修改此页面`;
    } else {
      status.textContent = `已切换到${selectedName}，正在刷新网页…`;
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      if (tab?.id) await chrome.tabs.reload(tab.id);
      status.textContent = `当前目标：${selectedName}`;
    }
  } catch {
    status.textContent = `当前目标：${selectedName}`;
  } finally {
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

function isRestrictedChromePage(url) {
  const value = String(url || "");
  return /^(?:chrome|chrome-extension|edge|about):/i.test(value) ||
    /^https:\/\/(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)\//i.test(value);
}
