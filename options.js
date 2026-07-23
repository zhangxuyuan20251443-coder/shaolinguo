const DEFAULT_GLOSSARY = ["KFC", "YouTube", "Google", "Apple", "macOS", "AU"];
const DEFAULT_SETTINGS = { enabled: true, sourceLanguage: "auto", targetLanguage: "zh" };
const LANGUAGE_NAMES = {
  zh: "中文", en: "英语", ja: "日语", ko: "韩语", es: "西班牙语", fr: "法语",
  de: "德语", ru: "俄语", ar: "阿拉伯语", pt: "葡萄牙语", it: "意大利语",
  tr: "土耳其语", vi: "越南语", th: "泰语"
};
const field = document.querySelector("#glossary");
const status = document.querySelector("#status");
const runtime = document.querySelector("#runtime");
const fastModel = document.querySelector("#fastModel");
const prepareFastModel = document.querySelector("#prepareFastModel");
let translationSettings = { ...DEFAULT_SETTINGS };

chrome.storage.local.get({
  glossary: DEFAULT_GLOSSARY,
  translationSettings: DEFAULT_SETTINGS
}, ({ glossary, translationSettings: storedSettings }) => {
  field.value = glossary.join("\n");
  translationSettings = { ...DEFAULT_SETTINGS, ...(storedSettings || {}) };
  refreshFastModel();
});

refreshRuntime();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.contentRuntime || changes.backendRuntime)) refreshRuntime();
});

function refreshRuntime() {
  chrome.storage.local.get({ contentRuntime: null, backendRuntime: null }, ({ contentRuntime, backendRuntime }) => {
    const page = contentRuntime?.page || "尚未注入网页";
    const contentState = contentRuntime?.state || "未运行";
    let backendState = "本地模型尚未收到请求";
    if (backendRuntime?.state === "ready") backendState = `本地模型正常：最近 ${backendRuntime.count} 条，用时 ${backendRuntime.elapsedMs} 毫秒`;
    if (backendRuntime?.state === "translating") backendState = `本地模型正在翻译 ${backendRuntime.count} 条`;
    if (backendRuntime?.state === "error") backendState = `本地模型错误：${backendRuntime.error}`;
    runtime.textContent = `运行状态：${page} / 内容脚本 ${contentState} / ${backendState}`;
  });
}

async function refreshFastModel() {
  if (typeof Translator === "undefined") {
    fastModel.textContent = "Chrome 快速翻译接口不可用，将使用本地语义模型。";
    prepareFastModel.disabled = true;
    return;
  }
  try {
    const sourceLanguage = translationSettings.sourceLanguage === "auto" ? "en" : translationSettings.sourceLanguage;
    const targetLanguage = translationSettings.targetLanguage;
    if (sourceLanguage === targetLanguage) {
      fastModel.textContent = "原文和目标语言相同，不需要准备翻译模型。";
      prepareFastModel.disabled = true;
      return;
    }
    const availability = await Translator.availability({ sourceLanguage, targetLanguage });
    fastModel.textContent = `Chrome ${languageName(sourceLanguage)}→${languageName(targetLanguage)}快速模型：${availability}`;
    prepareFastModel.disabled = availability === "unavailable";
  } catch (error) {
    fastModel.textContent = `Chrome 快速模型检测失败：${error.message || error}`;
  }
}

prepareFastModel.addEventListener("click", async () => {
  const sourceLanguage = translationSettings.sourceLanguage === "auto" ? "en" : translationSettings.sourceLanguage;
  const targetLanguage = translationSettings.targetLanguage;
  prepareFastModel.disabled = true;
  fastModel.textContent = `正在准备 Chrome ${languageName(sourceLanguage)}→${languageName(targetLanguage)}快速模型…`;
  try {
    const translator = await Translator.create({
      sourceLanguage,
      targetLanguage,
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          fastModel.textContent = `正在下载 Chrome 快速模型：${Math.round(event.loaded * 100)}%`;
        });
      }
    });
    const test = await translator.translate(sourceLanguage === "zh" ? "打开设置" : "Open settings");
    translator.destroy?.();
    fastModel.textContent = `Chrome 快速模型已就绪，测试译文：${test}`;
  } catch (error) {
    fastModel.textContent = `Chrome 快速模型准备失败：${error.message || error}`;
  } finally {
    prepareFastModel.disabled = false;
  }
});

function languageName(code) {
  return LANGUAGE_NAMES[code] || code;
}

document.querySelector("#save").addEventListener("click", async () => {
  const glossary = [...new Set(field.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
  await chrome.storage.local.set({ glossary: glossary.length ? glossary : DEFAULT_GLOSSARY });
  status.textContent = "已保存，现有网页会立即使用新设置。";
  window.setTimeout(() => { status.textContent = ""; }, 2500);
});
