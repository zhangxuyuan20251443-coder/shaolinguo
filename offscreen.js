"use strict";

const translators = new Map();
let languageDetectorPromise = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen" || message?.type !== "translate" || !Array.isArray(message.texts)) return false;
  translate(
    message.texts,
    message.sourceLanguage || "auto",
    message.targetLanguage || "zh",
    message.languageHint || ""
  )
    .then((translations) => sendResponse({ ok: true, translations }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

async function translate(texts, sourceLanguage, targetLanguage, languageHint) {
  if (typeof Translator === "undefined") throw new Error("Chrome 快速翻译接口不可用");
  const output = new Array(texts.length);
  for (let start = 0; start < texts.length; start += 3) {
    const group = texts.slice(start, start + 3);
    const translated = await Promise.all(group.map(async (rawText) => {
      const text = String(rawText);
      const source = sourceLanguage === "auto"
        ? await detectLanguage(text, languageHint)
        : normalizeLanguage(sourceLanguage);
      if (!source || source === targetLanguage) return text;
      const translator = await getTranslator(source, targetLanguage);
      return translator.translate(text);
    }));
    translated.forEach((value, index) => {
      output[start + index] = value;
    });
  }
  return output;
}

async function getTranslator(sourceLanguage, targetLanguage) {
  const key = `${sourceLanguage}>${targetLanguage}`;
  if (!translators.has(key)) {
    const creating = (async () => {
      const availability = await Translator.availability({ sourceLanguage, targetLanguage });
      if (availability === "unavailable") {
        throw new Error(`Chrome 不支持 ${sourceLanguage}→${targetLanguage} 快速翻译`);
      }
      return Translator.create({ sourceLanguage, targetLanguage });
    })().catch((error) => {
      translators.delete(key);
      throw error;
    });
    translators.set(key, creating);
  }
  return translators.get(key);
}

async function detectLanguage(text, languageHint) {
  const prepared = text.replace(/ZXQKEEP\d+QXZ/gi, " ").trim();
  try {
    const detector = await getLanguageDetector();
    if (detector) {
      const results = await detector.detect(prepared);
      const detected = normalizeLanguage(results?.[0]?.detectedLanguage);
      if (detected && Number(results?.[0]?.confidence || 0) >= 0.35) return detected;
    }
  } catch {
    // 检测模型不可用时立即使用脚本和页面语言判断，不阻塞网页。
  }
  return heuristicLanguage(prepared, languageHint);
}

async function getLanguageDetector() {
  if (typeof LanguageDetector === "undefined") return null;
  if (!languageDetectorPromise) {
    languageDetectorPromise = (async () => {
      const availability = await LanguageDetector.availability();
      if (availability !== "available") return null;
      return LanguageDetector.create();
    })().catch(() => null);
  }
  return languageDetectorPromise;
}

function heuristicLanguage(text, languageHint) {
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  if (/[\u0400-\u052f]/.test(text)) return "ru";
  if (/[\u0600-\u06ff]/.test(text)) return "ar";
  if (/[\u0e00-\u0e7f]/.test(text)) return "th";
  if (/[ăâđêôơưĂÂĐÊÔƠƯ]/.test(text)) return "vi";
  if (/[ñ¿¡]/i.test(text)) return "es";
  if (/[ãõ]/i.test(text)) return "pt";
  if (/[äöüß]/i.test(text)) return "de";
  if (/[àâçéèêëîïôûùüÿœ]/i.test(text)) return "fr";
  const hint = normalizeLanguage(languageHint);
  if (/[A-Za-z\u00c0-\u024f]/.test(text)) {
    return ["en", "es", "fr", "de", "pt", "it", "tr", "vi"].includes(hint) ? hint : "en";
  }
  if (/[\u3400-\u9fff]/.test(text)) return "zh";
  return hint || null;
}

function normalizeLanguage(value) {
  const language = String(value || "").toLowerCase().split(/[-_]/)[0];
  return ["zh", "en", "ja", "ko", "es", "fr", "de", "ru", "ar", "pt", "it", "tr", "vi", "th"].includes(language)
    ? language
    : null;
}
