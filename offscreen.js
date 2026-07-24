"use strict";

const translators = new Map();
const translationCache = new Map();
const TRANSLATION_CACHE_LIMIT = 2500;
const TRANSLATION_GROUP_SIZE = 4;
const TRANSLATION_CHUNK_LIMIT = 320;
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
  const missing = [];
  texts.forEach((rawText, index) => {
    const text = String(rawText);
    const key = requestCacheKey(text, sourceLanguage, targetLanguage, languageHint);
    const cached = getCachedTranslation(key);
    if (cached !== undefined) output[index] = cached;
    else missing.push({ index, text, key });
  });
  if (!missing.length) return output;

  const sharedSource = sourceLanguage === "auto"
    ? await detectBatchLanguage(missing.map((item) => item.text), languageHint, targetLanguage)
    : normalizeLanguage(sourceLanguage);

  for (let start = 0; start < missing.length; start += TRANSLATION_GROUP_SIZE) {
    const group = missing.slice(start, start + TRANSLATION_GROUP_SIZE);
    const translated = await translateGroup(
      group.map((item) => item.text),
      sourceLanguage,
      sharedSource,
      targetLanguage,
      languageHint
    );
    translated.forEach((value, index) => {
      const item = group[index];
      output[item.index] = value;
      if (String(value).replace(/\s+/g, " ").trim() !== item.text.replace(/\s+/g, " ").trim()) {
        setCachedTranslation(item.key, value);
      }
    });
  }
  return output;
}

async function translateGroup(texts, sourceLanguage, sharedSource, targetLanguage, languageHint) {
  const output = new Array(texts.length);
  const bySource = new Map();
  texts.forEach((text, index) => {
    const source = sourceLanguage === "auto"
      ? resolveItemLanguage(text, languageHint, sharedSource, targetLanguage)
      : sharedSource;
    if (!source || source === targetLanguage) {
      output[index] = text;
      return;
    }
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source).push({ index, text });
  });

  await Promise.all([...bySource.entries()].map(async ([source, items]) => {
    try {
      const translations = await translateSameLanguage(items.map((item) => item.text), source, targetLanguage);
      translations.forEach((value, index) => {
        output[items[index].index] = value;
      });
    } catch {
      items.forEach((item) => {
        output[item.index] = item.text;
      });
    }
  }));
  return output;
}

async function translateSameLanguage(texts, sourceLanguage, targetLanguage) {
  let directError = null;
  try {
    const direct = await translateLanguagePair(texts, sourceLanguage, targetLanguage);
    if (isUsefulTranslationBatch(texts, direct, sourceLanguage, targetLanguage)) return direct;
    directError = new Error(`${sourceLanguage}→${targetLanguage} 返回了原文`);
  } catch (error) {
    directError = error;
  }

  if (sourceLanguage !== "en" && targetLanguage !== "en") {
    try {
      const english = await translateLanguagePair(texts, sourceLanguage, "en");
      const pivoted = await translateLanguagePair(english, "en", targetLanguage);
      if (isUsefulTranslationBatch(texts, pivoted, sourceLanguage, targetLanguage)) return pivoted;
    } catch {
      // 中转也不可用时，把直连错误交给上层，页面会保留原文而不是错误语言。
    }
  }
  throw directError || new Error(`无法翻译 ${sourceLanguage}→${targetLanguage}`);
}

async function translateLanguagePair(texts, sourceLanguage, targetLanguage) {
  const translator = await getTranslator(sourceLanguage, targetLanguage);
  if (texts.length === 1) return [await translateTextSafely(translator, texts[0])];

  const combined = texts
    .map((text, index) => `ZXQSEGMENT${index}QXZ ${text}`)
    .join("\n");
  if (combined.length <= 800) {
    try {
      const translated = await translator.translate(combined);
      const parsed = parseSegmentedTranslation(translated, texts.length);
      if (parsed) return retryUnchangedTranslations(translator, texts, parsed);
    } catch {
      // 合并文本超过设备模型的实际配额时，立即退回小并发单句翻译。
    }
  }
  return translateIndividually(translator, texts);
}

async function retryUnchangedTranslations(translator, originals, translations) {
  const output = [...translations];
  for (let index = 0; index < originals.length; index += 1) {
    if (normalizedText(output[index]) !== normalizedText(originals[index])) continue;
    try {
      output[index] = await translateTextSafely(translator, originals[index]);
    } catch {
      // 单条仍不可译时保留原文，不影响同批其他已完成的译文。
    }
  }
  return output;
}

async function translateIndividually(translator, texts) {
  const output = new Array(texts.length);
  for (let start = 0; start < texts.length; start += 2) {
    const group = texts.slice(start, start + 2);
    const translated = await Promise.all(group.map((text) => translateTextSafely(translator, text)));
    translated.forEach((value, index) => {
      output[start + index] = value;
    });
  }
  return output;
}

async function translateTextSafely(translator, text) {
  let directError = null;
  try {
    return await translator.translate(text);
  } catch (error) {
    directError = error;
    const chunks = splitTranslationChunks(text, TRANSLATION_CHUNK_LIMIT);
    if (chunks.length <= 1) throw directError;
    const translated = [];
    for (const chunk of chunks) {
      try {
        translated.push(await translator.translate(chunk));
      } catch (error) {
        throw error || directError;
      }
    }
    return translated.join(" ");
  }
}

function isUsefulTranslationBatch(originals, translations, sourceLanguage, targetLanguage) {
  if (!Array.isArray(translations) || translations.length !== originals.length) return false;
  let changedCount = 0;
  const valid = translations.every((translation, index) => {
    const original = String(originals[index] || "").replace(/\s+/g, " ").trim();
    const output = String(translation || "").replace(/\s+/g, " ").trim();
    if (!output) return false;
    if (sourceLanguage !== targetLanguage && output.toLocaleLowerCase() === original.toLocaleLowerCase()) {
      return true;
    }
    changedCount += 1;
    if (targetLanguage === "ja" && /[A-Za-z]/.test(original) && !/[\u3040-\u30ff\u3400-\u9fff]/.test(output)) {
      return false;
    }
    if (targetLanguage === "ko" && /[A-Za-z\u3400-\u9fff]/.test(original) && !/[\uac00-\ud7af]/.test(output)) {
      return false;
    }
    if (targetLanguage === "ru" && /[A-Za-z\u3400-\u9fff]/.test(original) && !/[\u0400-\u052f]/.test(output)) {
      return false;
    }
    if (targetLanguage === "ar" && /[A-Za-z\u3400-\u9fff]/.test(original) && !/[\u0600-\u06ff]/.test(output)) {
      return false;
    }
    if (targetLanguage === "th" && /[A-Za-z\u3400-\u9fff]/.test(original) && !/[\u0e00-\u0e7f]/.test(output)) {
      return false;
    }
    return true;
  });
  return valid && changedCount > 0;
}

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function splitTranslationChunks(value, limit) {
  let remaining = String(value || "").trim();
  const chunks = [];
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt < Math.floor(limit * 0.55)) {
      const punctuation = Math.max(
        remaining.lastIndexOf(". ", limit),
        remaining.lastIndexOf("? ", limit),
        remaining.lastIndexOf("! ", limit),
        remaining.lastIndexOf("; ", limit),
        remaining.lastIndexOf(", ", limit)
      );
      splitAt = punctuation >= Math.floor(limit * 0.45) ? punctuation + 1 : limit;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function parseSegmentedTranslation(value, expectedCount) {
  const text = String(value || "");
  const matches = [...text.matchAll(/ZXQSEGMENT(\d+)QXZ/gi)];
  if (matches.length !== expectedCount) return null;
  const output = new Array(expectedCount);
  for (let index = 0; index < matches.length; index += 1) {
    const itemIndex = Number(matches[index][1]);
    if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= expectedCount || output[itemIndex] !== undefined) {
      return null;
    }
    const start = matches[index].index + matches[index][0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    const item = text.slice(start, end).trim();
    if (!item) return null;
    output[itemIndex] = item;
  }
  return output.every((item) => item !== undefined) ? output : null;
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

async function detectBatchLanguage(texts, languageHint, targetLanguage) {
  const hint = normalizeLanguage(languageHint);
  if (hint && hint !== targetLanguage) return hint;
  const prepared = texts
    .map((text) => String(text).replace(/ZXQKEEP\d+QXZ/gi, " "))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2400);
  const scripted = scriptLanguage(prepared);
  if (scripted) return scripted;
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
  return heuristicLanguage(prepared, hint);
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

function resolveItemLanguage(text, languageHint, sharedSource, targetLanguage) {
  const prepared = String(text).replace(/ZXQKEEP\d+QXZ/gi, " ").trim();
  const scripted = scriptLanguage(prepared);
  if (scripted) return scripted;
  if (/[A-Za-z\u00c0-\u024f]/.test(prepared)) {
    const hint = normalizeLanguage(languageHint);
    const latinLanguages = ["en", "es", "fr", "de", "pt", "it", "tr", "vi"];
    if (latinLanguages.includes(hint) && hint !== targetLanguage) return hint;
    if (latinLanguages.includes(sharedSource) && sharedSource !== targetLanguage) return sharedSource;
    return "en";
  }
  return sharedSource || normalizeLanguage(languageHint);
}

function scriptLanguage(text) {
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  if (/[\u0400-\u052f]/.test(text)) return "ru";
  if (/[\u0600-\u06ff]/.test(text)) return "ar";
  if (/[\u0e00-\u0e7f]/.test(text)) return "th";
  const chineseCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (text.match(/[A-Za-z\u00c0-\u024f]/g) || []).length;
  if (chineseCount >= 2 && chineseCount >= latinCount * 2) return "zh";
  return null;
}

function requestCacheKey(text, sourceLanguage, targetLanguage, languageHint) {
  const source = normalizeLanguage(sourceLanguage) || "auto";
  const hint = source === "auto" ? (normalizeLanguage(languageHint) || "") : "";
  return `${source}>${targetLanguage}>${hint}:${text}`;
}

function getCachedTranslation(key) {
  if (!translationCache.has(key)) return undefined;
  const value = translationCache.get(key);
  translationCache.delete(key);
  translationCache.set(key, value);
  return value;
}

function setCachedTranslation(key, value) {
  if (translationCache.has(key)) translationCache.delete(key);
  translationCache.set(key, value);
  while (translationCache.size > TRANSLATION_CACHE_LIMIT) {
    translationCache.delete(translationCache.keys().next().value);
  }
}

function normalizeLanguage(value) {
  const language = String(value || "").toLowerCase().split(/[-_]/)[0];
  return ["zh", "en", "ja", "ko", "es", "fr", "de", "ru", "ar", "pt", "it", "tr", "vi", "th"].includes(language)
    ? language
    : null;
}
