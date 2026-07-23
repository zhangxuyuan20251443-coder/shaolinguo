(() => {
  "use strict";

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "KBD", "SAMP", "TEXTAREA", "TEMPLATE", "SVG", "MATH"]);
  const TRANSLATABLE_ATTRIBUTES = ["aria-label", "title", "placeholder"];
  const DEFAULT_GLOSSARY = ["KFC", "YouTube", "Google", "Apple", "macOS", "AU"];
  const DEFAULT_SETTINGS = { enabled: true, sourceLanguage: "auto", targetLanguage: "zh" };
  const IS_YOUTUBE = location.hostname === "youtube.com" || location.hostname.endsWith(".youtube.com");
  const CACHE_LIMIT = 800;
  const PENDING_LIMIT = 120;
  const TARGETS_PER_SOURCE_LIMIT = 24;
  const INITIAL_CANDIDATE_LIMIT = 2500;
  const ADDED_CANDIDATE_LIMIT = 120;
  const VISIBLE_QUEUE_LIMIT = 240;
  const STATUS_WRITE_INTERVAL = 1500;
  const CANDIDATE_SELECTOR = [
    "title", "h1", "h2", "h3", "h4", "p", "li", "label", "summary", "th", "td",
    "button", "a", "input[placeholder]", "textarea[placeholder]",
    "[role='button']", "[role='tab']", "[role='menuitem']", "[role='option']",
    "[aria-label]", "[title]", "[placeholder]", "yt-formatted-string",
    "yt-attributed-string", "ytd-comment-view-model #content-text",
    "ytd-comment-replies-renderer #content-text"
  ].join(",");
  const PRIMARY_SELECTOR = [
    "#video-title", "yt-formatted-string#video-title", "[role='heading']", "h1", "h2", "h3",
    "main p", "article p", "main [aria-label]", "article [aria-label]",
    "ytd-comments #content-text", "ytd-comment-thread-renderer #content-text",
    "ytd-comment-replies-renderer #content-text"
  ].join(",");
  const OBSERVED_SELECTOR = `${PRIMARY_SELECTOR},${CANDIDATE_SELECTOR}`;
  const EXACT = new Map(Object.entries({
    "home": "首页", "shorts": "短视频", "subscriptions": "订阅内容", "you": "我的内容",
    "history": "观看记录", "library": "媒体库", "search": "搜索", "settings": "设置",
    "sign in": "登录", "sign out": "退出登录", "log in": "登录", "log out": "退出登录",
    "subscribe": "订阅", "subscribed": "已订阅", "like": "喜欢", "dislike": "不喜欢",
    "share": "分享", "download": "下载", "save": "保存", "cancel": "取消", "delete": "删除",
    "edit": "编辑", "close": "关闭", "open": "打开", "next": "下一步", "back": "返回",
    "continue": "继续", "retry": "重试", "refresh": "刷新", "loading": "正在加载",
    "more": "更多", "show more": "展开更多", "show less": "收起", "learn more": "了解详情",
    "comments": "评论", "replies": "回复", "reply": "回复", "views": "次观看",
    "watch later": "稍后观看", "play": "播放", "pause": "暂停", "mute": "静音",
    "unmute": "取消静音", "full screen": "全屏", "exit full screen": "退出全屏",
    "captions": "字幕", "subtitles": "字幕", "quality": "画质", "speed": "播放速度",
    "previous": "上一个", "new": "新建", "copy": "复制", "paste": "粘贴", "cut": "剪切",
    "undo": "撤销", "redo": "重做", "select all": "全选", "upload": "上传",
    "create": "创建", "notifications": "通知", "help": "帮助", "feedback": "反馈",
    "shorts - more actions": "短视频 - 更多操作", "go to channel": "前往频道",
    "privacy": "隐私", "terms": "条款", "about": "关于", "error": "错误",
    "warning": "警告", "success": "成功", "failed": "失败", "required": "必填",
    "optional": "选填", "username": "用户名", "password": "密码", "email": "电子邮箱",
    "create account": "创建账户", "forgot password": "忘记密码", "save changes": "保存更改"
  }));

  const cache = new Map();
  const pending = new Map();
  const queuedTargets = new WeakMap();
  const appliedValues = new WeakMap();
  const maskedTargets = new WeakMap();
  const maskedElements = new WeakMap();
  let glossary = [...DEFAULT_GLOSSARY];
  let translationSettings = { ...DEFAULT_SETTINGS };
  let flushTimer = 0;
  let discoveryTimer = 0;
  let visibleDrainTimer = 0;
  let statusTimer = 0;
  let isFlushing = false;
  let appliedCount = 0;
  let lastStoredStatus = "";
  let pendingStatusValue = "";
  let lastStatusWriteAt = 0;
  let lastBackend = "waiting";
  let dynamicObserver = null;
  let visibilityObserver = null;
  let observedCandidates = new WeakSet();
  let visibleQueued = new WeakSet();
  const visibleQueue = [];

  chrome.storage.local.get({
    glossary: DEFAULT_GLOSSARY,
    translationSettings: DEFAULT_SETTINGS
  }, (result) => {
    glossary = sanitizeGlossary(result.glossary);
    translationSettings = sanitizeSettings(result.translationSettings);
    if (!translationSettings.enabled || translationSettings.sourceLanguage === translationSettings.targetLanguage) {
      markStatus("paused");
      return;
    }
    startTranslation();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.glossary) {
      glossary = sanitizeGlossary(changes.glossary.newValue);
      cache.clear();
    }
  });

  function startTranslation() {
    markStatus("active");
    installVisibilityObserver();
    installDynamicObserver();
    if (!IS_YOUTUBE) preflightAddedNode(document.documentElement, 500);
    scheduleCandidateDiscovery(0);
    document.addEventListener("DOMContentLoaded", () => {
      installVisibilityObserver();
      installDynamicObserver();
      if (!IS_YOUTUBE) preflightAddedNode(document.documentElement, 500);
      scheduleCandidateDiscovery(0);
    }, { once: true });
    window.addEventListener("popstate", () => scheduleCandidateDiscovery(100), { passive: true });
    window.addEventListener("hashchange", () => scheduleCandidateDiscovery(100), { passive: true });
    document.addEventListener("yt-navigate-finish", () => {
      resetVisibilityObserver();
      scheduleCandidateDiscovery(120);
    }, { passive: true });
  }

  function installVisibilityObserver() {
    if (visibilityObserver || typeof IntersectionObserver === "undefined") return;
    visibilityObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) queueVisibleCandidate(entry.target);
      }
    }, {
      root: null,
      rootMargin: "160px 120px 420px 120px",
      threshold: 0
    });
  }

  function installDynamicObserver() {
    if (dynamicObserver) return;
    dynamicObserver = new MutationObserver((records) => {
      let candidateBudget = IS_YOUTUBE ? 160 : 360;
      for (const record of records) {
        if (record.type === "characterData") {
          if (!wasTextAppliedByUs(record.target)) queueTextNode(record.target);
          continue;
        }
        if (record.type === "attributes") {
          queueAttribute(record.target, record.attributeName);
          continue;
        }
        for (const node of record.removedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) unregisterCandidates(node, 240);
        }
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            queueTextNode(node);
            continue;
          }
          if (candidateBudget <= 0 || node.nodeType !== Node.ELEMENT_NODE) continue;
          const discovered = discoverCandidates(node, Math.min(candidateBudget, ADDED_CANDIDATE_LIMIT));
          candidateBudget -= discovered;
          if (!IS_YOUTUBE && candidateBudget > 0 && isNearViewport(node)) {
            candidateBudget -= preflightAddedNode(node, Math.min(candidateBudget, 80));
          }
        }
      }
    });
    dynamicObserver.observe(document, {
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: TRANSLATABLE_ATTRIBUTES,
      subtree: true
    });
  }

  function resetVisibilityObserver() {
    visibilityObserver?.disconnect();
    visibilityObserver = null;
    observedCandidates = new WeakSet();
    visibleQueued = new WeakSet();
    visibleQueue.length = 0;
    if (visibleDrainTimer) window.clearTimeout(visibleDrainTimer);
    visibleDrainTimer = 0;
    installVisibilityObserver();
  }

  function preflightAddedNode(node, visitLimit = 120) {
    if (!node) return 0;
    if (node.nodeType === Node.TEXT_NODE) {
      queueTextNode(node);
      return 1;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || shouldSkipElement(node)) return 0;
    if (node !== document.documentElement && node.tagName !== "TITLE" && !isNearViewport(node)) return 0;

    queueElementAttributes(node);
    let visited = 0;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(candidate) {
        const element = candidate.nodeType === Node.ELEMENT_NODE ? candidate : candidate.parentElement;
        return element && !shouldSkipElement(element)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });
    while (visited < visitLimit) {
      const candidate = walker.nextNode();
      if (!candidate) break;
      if (candidate.nodeType === Node.TEXT_NODE) queueTextNode(candidate);
      else queueElementAttributes(candidate);
      visited += 1;
    }
    return visited;
  }

  function scheduleCandidateDiscovery(delay) {
    if (discoveryTimer) return;
    discoveryTimer = window.setTimeout(() => {
      discoveryTimer = 0;
      if (!document.hidden) discoverCandidates(document, INITIAL_CANDIDATE_LIMIT);
    }, delay);
  }

  function discoverCandidates(root, limit = ADDED_CANDIDATE_LIMIT) {
    if (!root || document.hidden || limit <= 0) return 0;
    let discovered = 0;
    if (root.nodeType === Node.ELEMENT_NODE) {
      const element = root;
      if (element.tagName === "TITLE") scanCandidateElement(element);
      if (element.matches?.(OBSERVED_SELECTOR)) {
        registerCandidate(element);
        discovered += 1;
      }
    }
    const queryRoot = root.querySelectorAll ? root : null;
    if (queryRoot && discovered < limit) {
      const candidates = queryRoot.querySelectorAll(OBSERVED_SELECTOR);
      for (const element of candidates) {
        if (discovered >= limit) break;
        if (element.tagName === "TITLE") scanCandidateElement(element);
        registerCandidate(element);
        discovered += 1;
      }
    }
    return discovered;
  }

  function registerCandidate(element) {
    if (!element?.isConnected || observedCandidates.has(element) || shouldSkipElement(element)) return;
    observedCandidates.add(element);
    if (element.tagName === "TITLE") {
      scanCandidateElement(element);
      return;
    }
    if (visibilityObserver) visibilityObserver.observe(element);
    else if (isNearViewport(element)) queueVisibleCandidate(element);
  }

  function unregisterCandidates(root, limit) {
    if (!visibilityObserver || !root) return;
    if (root.matches?.(OBSERVED_SELECTOR)) {
      visibilityObserver.unobserve(root);
      observedCandidates.delete(root);
    }
    if (!root.querySelectorAll) return;
    let visited = 0;
    for (const element of root.querySelectorAll(OBSERVED_SELECTOR)) {
      visibilityObserver.unobserve(element);
      observedCandidates.delete(element);
      visited += 1;
      if (visited >= limit) break;
    }
  }

  function queueVisibleCandidate(element) {
    if (!element?.isConnected || visibleQueued.has(element) || visibleQueue.length >= VISIBLE_QUEUE_LIMIT) return;
    visibleQueued.add(element);
    visibleQueue.push(element);
    if (!visibleDrainTimer) visibleDrainTimer = window.setTimeout(drainVisibleCandidates, 16);
  }

  function drainVisibleCandidates() {
    visibleDrainTimer = 0;
    let budget = 32;
    while (budget > 0 && visibleQueue.length) {
      const element = visibleQueue.shift();
      visibleQueued.delete(element);
      scanCandidateElement(element);
      budget -= 1;
    }
    if (visibleQueue.length) visibleDrainTimer = window.setTimeout(drainVisibleCandidates, 48);
  }

  function scanCandidateElement(element) {
    if (!element?.isConnected || shouldSkipElement(element)) return;
    if (element.tagName !== "TITLE" && !isNearViewport(element)) return;
    queueElementAttributes(element);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement && !shouldSkipElement(node.parentElement)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });
    let localTextNodes = 0;
    while (localTextNodes < 8) {
      const node = walker.nextNode();
      if (!node) break;
      queueTextNode(node);
      localTextNodes += 1;
    }
  }

  function shouldSkipElement(element) {
    if (SKIP_TAGS.has(element.tagName)) return true;
    if (element.isContentEditable) return true;
    if (element.closest?.("[translate='no'], .notranslate, [data-no-translation]")) return true;
    return false;
  }

  function queueTextNode(node) {
    const parent = node.parentElement;
    if (!parent || shouldSkipElement(parent)) return;
    queueTarget({ type: "text", node, source: node.data });
  }

  function queueElementAttributes(element) {
    for (const name of TRANSLATABLE_ATTRIBUTES) queueAttribute(element, name);
  }

  function queueAttribute(element, name) {
    if (!name || shouldSkipElement(element) || !element.hasAttribute(name)) return;
    queueTarget({ type: "attribute", node: element, name, source: element.getAttribute(name) || "" });
  }

  function queueTarget(target) {
    const normalized = normalize(target.source);
    if (wasAppliedByUs(target, normalized)) {
      releaseTargetMask(target);
      return;
    }
    if (!shouldTranslate(normalized)) {
      releaseTargetMask(target);
      return;
    }
    const element = target.type === "text" ? target.node.parentElement : target.node;
    if (element?.tagName !== "TITLE" && !isNearViewport(element)) return;

    const exact = translationSettings.targetLanguage === "zh"
      ? EXACT.get(normalized.toLowerCase().replace(/[.!?:]+$/, ""))
      : null;
    if (exact) {
      applyTarget(target, exact);
      return;
    }
    const key = cacheKey(normalized);
    const cached = getCachedTranslation(key);
    if (cached !== undefined) {
      if (normalize(cached) !== normalized) applyTarget(target, cached);
      else releaseTargetMask(target);
      return;
    }
    if (isTargetQueued(target, normalized)) return;
    const existingTargets = pending.get(normalized);
    if ((!existingTargets && pending.size >= PENDING_LIMIT) ||
        (existingTargets && existingTargets.length >= TARGETS_PER_SOURCE_LIMIT)) return;

    maskTarget(target, normalized);
    markTargetQueued(target, normalized);
    if (!pending.has(normalized)) pending.set(normalized, []);
    pending.get(normalized).push(target);
    scheduleFlush();
  }

  function isNearViewport(element) {
    if (!element?.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return rect.bottom >= -120 && rect.top <= window.innerHeight + 420 && rect.right >= -120 && rect.left <= window.innerWidth + 120;
  }

  function targetKey(target) {
    return target.type === "text" ? "text" : `attribute:${target.name}`;
  }

  function maskTarget(target, source) {
    if (target.type !== "text" && target.name !== "placeholder") return;
    const element = target.type === "text" ? target.node.parentElement : target.node;
    if (!element?.isConnected || shouldSkipElement(element)) return;

    let targets = maskedTargets.get(target.node);
    if (!targets) {
      targets = new Map();
      maskedTargets.set(target.node, targets);
    }
    const key = targetKey(target);
    const previous = targets.get(key);
    if (previous?.source === source && previous.element === element) return;

    if (previous?.element && previous.element !== element) {
      decrementMaskedElement(previous.element);
      incrementMaskedElement(element);
    } else if (!previous) {
      incrementMaskedElement(element);
    }
    targets.set(key, { source, element });
  }

  function releaseTargetMask(target, source = null) {
    const targets = maskedTargets.get(target.node);
    const key = targetKey(target);
    const state = targets?.get(key);
    if (!state || (source !== null && state.source !== source)) return;
    targets.delete(key);
    decrementMaskedElement(state.element);
  }

  function incrementMaskedElement(element) {
    const state = maskedElements.get(element);
    if (state) {
      state.count += 1;
      return;
    }
    const previousValue = element.style.getPropertyValue("visibility");
    const previousPriority = element.style.getPropertyPriority("visibility");
    maskedElements.set(element, { count: 1, previousValue, previousPriority });
    element.style.setProperty("visibility", "hidden", "important");
  }

  function decrementMaskedElement(element) {
    const state = maskedElements.get(element);
    if (!state) return;
    state.count -= 1;
    if (state.count > 0) return;
    maskedElements.delete(element);
    if (state.previousValue) {
      element.style.setProperty("visibility", state.previousValue, state.previousPriority);
    } else {
      element.style.removeProperty("visibility");
    }
  }

  function isTargetQueued(target, source) {
    return queuedTargets.get(target.node)?.get(targetKey(target)) === source;
  }

  function markTargetQueued(target, source) {
    let state = queuedTargets.get(target.node);
    if (!state) {
      state = new Map();
      queuedTargets.set(target.node, state);
    }
    state.set(targetKey(target), source);
  }

  function clearTargetQueued(target, source) {
    const state = queuedTargets.get(target.node);
    const key = targetKey(target);
    if (state?.get(key) === source) state.delete(key);
  }

  function scheduleFlush() {
    if (flushTimer || isFlushing) return;
    flushTimer = window.setTimeout(flush, 35);
  }

  async function flush() {
    flushTimer = 0;
    if (isFlushing) return;
    isFlushing = true;
    const entries = [...pending.entries()]
      .sort((left, right) => targetPriority(right[1]) - targetPriority(left[1]))
      .slice(0, 8);
    if (entries.length === 0) {
      isFlushing = false;
      return;
    }
    for (const [source] of entries) pending.delete(source);
    try {
      const protectedItems = entries.map(([source]) => protect(source));
      let translations = await tryChromeTranslator(protectedItems.map((item) => item.value));

      if (!translations) {
        lastBackend = "local-model";
        const response = await sendMessage({
          type: "translate",
          texts: protectedItems.map((item) => item.value),
          context: `${location.hostname || "网页"} / ${document.title || "页面"}`,
          sourceLanguage: translationSettings.sourceLanguage,
          targetLanguage: translationSettings.targetLanguage
        });
        if (response?.ok && Array.isArray(response.translations)) translations = response.translations;
        else markStatus(`backend-error:${String(response?.error || "no-response").slice(0, 120)}`);
      }

      if (translations && translations.length === entries.length) {
        entries.forEach(([source, targets], index) => {
          const restored = restoreTranslation(String(translations[index] || ""), protectedItems[index].tokens);
          if (normalize(restored) === normalize(source)) {
            setCachedTranslation(cacheKey(source), source);
            for (const target of targets) releaseTargetMask(target, source);
            return;
          }
          if (!isAcceptableTranslation(restored)) {
            setCachedTranslation(cacheKey(source), source);
            return;
          }
          setCachedTranslation(cacheKey(source), restored);
          for (const target of targets) applyTarget(target, restored);
          appliedCount += 1;
        });
        markStatus(`active:${lastBackend}:${appliedCount}`);
      }
    } finally {
      for (const [source, targets] of entries) {
        for (const target of targets) {
          clearTargetQueued(target, source);
          releaseTargetMask(target, source);
        }
      }
      isFlushing = false;
      if (pending.size) {
        flushTimer = window.setTimeout(flush, lastBackend === "chrome-fast" ? 60 : 80);
      }
    }
  }

  function targetPriority(targets) {
    let priority = 0;
    for (const target of targets) {
      const element = target.type === "text" ? target.node.parentElement : target.node;
      if (!element) continue;
      if (element.tagName === "TITLE") priority = Math.max(priority, 4);
      if (element.closest?.("ytd-comments, ytd-comment-thread-renderer, ytd-comment-replies-renderer")) {
        priority = Math.max(priority, 5);
      }
      if (element.matches?.("h1, h2, h3, button, [role='button'], a, input")) priority = Math.max(priority, 2);
      const rect = element.getBoundingClientRect?.();
      if (rect && rect.width > 0 && rect.height > 0 && rect.bottom >= -80 && rect.top <= window.innerHeight + 240 && rect.right >= -80 && rect.left <= window.innerWidth + 80) {
        priority = Math.max(priority, 3);
      }
    }
    return priority;
  }

  async function tryChromeTranslator(texts) {
    try {
      const response = await sendMessage({
        type: "fast-translate",
        texts,
        sourceLanguage: translationSettings.sourceLanguage,
        targetLanguage: translationSettings.targetLanguage,
        languageHint: document.documentElement?.lang || ""
      });
      if (!response?.ok || !Array.isArray(response.translations) || response.translations.length !== texts.length) return null;
      lastBackend = "chrome-fast";
      return response.translations;
    } catch {
      return null;
    }
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(response);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function applyTarget(target, translated) {
    if (!translated) return;
    const source = normalize(target.source);
    if (target.type === "text") {
      if (target.node.isConnected && normalize(target.node.data) === normalize(target.source)) {
        const leading = target.source.match(/^\s*/)?.[0] || "";
        const trailing = target.source.match(/\s*$/)?.[0] || "";
        target.node.data = `${leading}${translated}${trailing}`;
        rememberAppliedValue(target, translated);
        releaseTargetMask(target, source);
      }
    } else if (target.node.isConnected && target.node.getAttribute(target.name) === target.source) {
      target.node.setAttribute(target.name, translated);
      rememberAppliedValue(target, translated);
      releaseTargetMask(target, source);
    }
  }

  function shouldTranslate(text) {
    if (text.length < 2 || text.length > 800) return false;
    if (isProtectedWhole(text)) return false;
    const withoutTerms = glossary.reduce((value, term) => value.replace(new RegExp(escapeRegex(term), "gi"), ""), text);
    if (translationSettings.sourceLanguage === translationSettings.targetLanguage) return false;
    if (translationSettings.targetLanguage === "zh" && translationSettings.sourceLanguage === "auto") {
      return hasForeign(withoutTerms);
    }
    return hasLanguageText(withoutTerms);
  }

  function isProtectedWhole(text) {
    return /^(?:https?:\/\/|www\.)\S+$/i.test(text) ||
      /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(text) ||
      /^(?:\/|~\/|[A-Za-z]:\\)\S+$/.test(text) ||
      /^[A-Fa-f0-9]{16,}$/.test(text) ||
      /^[^/\\\n]+\.(?:app|dmg|pkg|zip|7z|rar|tar|gz|pdf|docx?|xlsx?|pptx?|pages|numbers|key|txt|md|rtf|csv|json|ya?ml|xml|html?|css|js|jsx|ts|tsx|swift|m|mm|h|hpp|c|cc|cpp|py|java|kt|rs|go|sh|zsh|fish|sql|db|sqlite|png|jpe?g|gif|webp|svg|mov|mp4|mkv|mp3|wav)$/i.test(text) ||
      /^[A-Za-z_$][A-Za-z0-9_$]*(?:_[A-Za-z0-9_$]+)+$/.test(text) ||
      /^[A-Za-z_$][a-z0-9_$]+(?:[A-Z][A-Za-z0-9_$]*)+$/.test(text) ||
      /^(?:[A-Za-z0-9-]+\.){2,}[A-Za-z0-9-]+$/.test(text);
  }

  function protect(source) {
    let value = source;
    const tokens = new Map();
    const automatic = source.match(/(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:~?\/)[^\s]+|\b[A-Fa-f0-9]{16,}\b/g) || [];
    const terms = [...new Set([...glossary, ...automatic])].filter(Boolean).sort((a, b) => b.length - a.length);
    let index = 0;
    for (const term of terms) {
      value = value.replace(new RegExp(escapeRegex(term), "gi"), (exact) => {
        const token = `ZXQKEEP${index++}QXZ`;
        tokens.set(token, exact);
        return token;
      });
    }
    return { value, tokens };
  }

  function restoreTranslation(raw, tokens) {
    let result = raw.trim();
    for (const [token, original] of tokens) {
      const pattern = new RegExp(escapeRegex(token), "gi");
      if (result.search(pattern) >= 0) result = result.replace(pattern, original);
      else if (!result.toLowerCase().includes(original.toLowerCase())) result = `${original} ${result}`.trim();
    }
    if (translationSettings.targetLanguage === "zh") {
      const replacements = [
        ["拉取请求", "代码修改合并请求"], ["身份验证", "确认身份"], ["凭据", "登录信息"],
        ["存储库", "代码项目"], ["依赖项", "必需组件"], ["权限不足", "没有足够权限"],
        ["终止进程", "停止程序"], ["执行命令", "运行命令"]
      ];
      for (const [from, to] of replacements) result = result.replaceAll(from, to);
    }
    return result;
  }

  function isAcceptableTranslation(text) {
    const withoutTerms = glossary.reduce((value, term) => value.replace(new RegExp(escapeRegex(term), "gi"), ""), text);
    const target = translationSettings.targetLanguage;
    if (target === "zh") {
      const chineseCount = (withoutTerms.match(/[\u3400-\u9FFF]/g) || []).length;
      if (chineseCount === 0) return false;
      const foreignCount = (withoutTerms.match(/[A-Za-z\u00C0-\u024F\u0370-\u052F\u0530-\u0E7F\u10A0-\u10FF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
      return foreignCount === 0 || chineseCount >= Math.max(3, Math.ceil(foreignCount / 2));
    }
    if (target === "ja") return /[\u3040-\u30ff\u3400-\u9fff]/.test(withoutTerms);
    if (target === "ko") return /[\uac00-\ud7af]/.test(withoutTerms);
    if (target === "ru") return /[\u0400-\u052f]/.test(withoutTerms);
    if (target === "ar") return /[\u0600-\u06ff]/.test(withoutTerms);
    if (target === "th") return /[\u0e00-\u0e7f]/.test(withoutTerms);
    return /[A-Za-z\u00c0-\u024f]/.test(withoutTerms);
  }

  function hasForeign(text) {
    return /[A-Za-z\u00C0-\u024F\u0370-\u052F\u0530-\u0E7F\u10A0-\u10FF\u3040-\u30FF\uAC00-\uD7AF]/.test(text);
  }

  function hasLanguageText(text) {
    return /[A-Za-z\u00c0-\u024f\u0370-\u052f\u0530-\u0e7f\u10a0-\u10ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text);
  }

  function rememberAppliedValue(target, value) {
    let values = appliedValues.get(target.node);
    if (!values) {
      values = new Map();
      appliedValues.set(target.node, values);
    }
    values.set(targetKey(target), normalize(value));
  }

  function wasAppliedByUs(target, value) {
    return appliedValues.get(target.node)?.get(targetKey(target)) === value;
  }

  function wasTextAppliedByUs(node) {
    return appliedValues.get(node)?.get("text") === normalize(node?.data);
  }

  function cacheKey(source) {
    return `${translationSettings.sourceLanguage}>${translationSettings.targetLanguage}:${source}`;
  }

  function getCachedTranslation(key) {
    if (!cache.has(key)) return undefined;
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  function setCachedTranslation(key, value) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > CACHE_LIMIT) {
      cache.delete(cache.keys().next().value);
    }
  }

  function sanitizeGlossary(value) {
    const terms = Array.isArray(value) ? value : DEFAULT_GLOSSARY;
    const cleaned = terms.map((item) => String(item).trim()).filter(Boolean);
    return [...new Set(cleaned.length ? cleaned : DEFAULT_GLOSSARY)];
  }

  function sanitizeSettings(value) {
    const settings = { ...DEFAULT_SETTINGS, ...(value || {}) };
    const supported = new Set(["auto", "zh", "en", "ja", "ko", "es", "fr", "de", "ru", "ar", "pt", "it", "tr", "vi", "th"]);
    if (!supported.has(settings.sourceLanguage)) settings.sourceLanguage = "auto";
    if (!supported.has(settings.targetLanguage) || settings.targetLanguage === "auto") settings.targetLanguage = "zh";
    settings.enabled = settings.enabled !== false;
    return settings;
  }

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function markStatus(value) {
    document.documentElement?.setAttribute("data-shaolinguo-translator", value);
    pendingStatusValue = value;
    const elapsed = Date.now() - lastStatusWriteAt;
    const urgent = !lastStoredStatus || !value.startsWith("active:");
    if (urgent || elapsed >= STATUS_WRITE_INTERVAL) {
      commitStatus();
    } else if (!statusTimer) {
      statusTimer = window.setTimeout(commitStatus, STATUS_WRITE_INTERVAL - elapsed);
    }
  }

  function commitStatus() {
    if (statusTimer) window.clearTimeout(statusTimer);
    statusTimer = 0;
    const value = pendingStatusValue;
    if (!value || value === lastStoredStatus) return;
    lastStoredStatus = value;
    lastStatusWriteAt = Date.now();
    safeStorageSet({
      contentRuntime: { state: value, page: location.hostname || "网页", pending: pending.size, at: lastStatusWriteAt }
    });
  }

  function safeStorageSet(value) {
    try {
      const request = chrome.storage.local.set(value);
      request?.catch?.(() => {});
    } catch {
      // 扩展正在重新加载或关闭时，不让旧页面留下未处理错误。
    }
  }

  function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
})();
