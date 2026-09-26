// ============================================================
// content.js - 页面脚本（v1.7）
// ------------------------------------------------------------
// 职责：
//   - 录制用户操作（点击 / 标记删除）并同步到后台
//   - 同 class 累计删除后自动批量删除同类（可回放）
//   - dHash 图像角标识别 + 按域名学习角标 class/指纹
//   - 应用订阅的元素隐藏规则（CSS display:none，不删除 DOM）
//   - 执行录制的通用 / 站点规则（回放点击、删除、批量删除）
//   - 广告启发式扫描（关闭按钮、标签、角标、覆盖层）
//   - 删除备份与点击占位符恢复
//   - 页面特征提取（精准特征 + 核心词放宽）
// 性能优化：扫描节流、智能过滤（只注入页面可能命中的选择器）、
//           关闭按钮反查、选择器缓存
// ============================================================

// 防止 content script 被重复注入（多份实例会导致监听器/状态重复）
(function () {
if (window.__adBlockerLoaded) {
  console.warn('[广告拦截] 检测到重复注入，已跳过');
  return;
}
window.__adBlockerLoaded = true;

let isRecording = false;
let recordedOps = [];
let operationCounter = 0;
let markDeleteMode = false;
let classDeleteCounts = {};            // 各 class 被删除的次数
const CLASS_DELETE_THRESHOLD = 2;      // 同一 class 删够几次就批量删同类
const backupLimit = 10;
let currentPageRules = [];
let confirmedFeatureWords = [];

// ---- 拦截模式：'remove'（删除型）| 'hide'（隐藏型）----
let blockMode = 'remove';
const _hiddenEls = new Map();          // id -> element（隐藏型的元素，便于恢复）

// ---- 扫描防抖 ----
let scanScheduled = false;
let scanTimer = null;

// ---- 录制状态同步防抖 ----
let syncTimer = null;
let stopResetTimer = null;
const SYNC_DELAY = 500;

// ================= 选择器定义 =================
const DEFAULT_AD_SELECTORS = [
  '.ad-container', '.ad-banner', '.ad-wrapper', '.ad-slot',
  '.advertisement', '.sponsored', '.promoted',
  '.popup-ad', '.overlay-ad', '.interstitial',
  '[aria-label*="广告"]', '[aria-label*="sponsored"]',
  '[data-ad="true"]', '[data-ad-unit]', '[data-google-query-id]'
];

const CLOSE_BUTTON_SELECTORS = [
  '[aria-label*="close" i]', '[aria-label*="关闭" i]',
  '[aria-label*="dismiss" i]',
  '.close', '.close-btn', '.close-button',
  '.dismiss', '.dismiss-btn',
  '[class*="close"]', '[class*="dismiss"]', '[class*="cancel"]',
  '.ad-close', '.ad-close-button', '.ad-close-btn',
  '.skip-ad', '.skip-button', '[aria-label*="skip" i]'
];
// 预编译组合选择器（合并查询，比逐个 querySelector 快）
const CLOSE_BUTTON_COMBINED = CLOSE_BUTTON_SELECTORS.join(',');
const AD_SELECTORS_COMBINED = DEFAULT_AD_SELECTORS.join(',');

// ---------- 工具函数 ----------
function getUniqueSelector(el) {
  // 过滤掉不稳定的属性：Vue 的 data-v-*（scoped 哈希）、无意义的空值 data 属性、id 类前缀
  const dataAttrs = Array.from(el.attributes)
    .filter(attr => {
      const n = attr.name;
      if (!n.startsWith('data-')) return false;
      if (n.startsWith('data-v-')) return false;          // Vue scoped 哈希，刷新会变
      if (n === 'data-ad-handled' || n === 'data-restored' || n === 'data-backup-id') return false;
      if (!attr.value) return false;                       // 空值属性无意义
      return true;
    })
    .map(attr => {
      const val = attr.value.replace(/['"]/g, (m) => m === '"' ? '\\"' : "\\'");
      return `[${attr.name}="${val}"]`;
    });
  if (dataAttrs.length > 0) {
    return el.tagName.toLowerCase() + dataAttrs.join('');
  }
  if (el.id) return `#${el.id}`;
  if (el.className && typeof el.className === 'string') {
    const classes = el.className.split(' ')
      .filter(c => c && /^[a-zA-Z0-9_-]+$/.test(c)
        && !c.includes('swiper') && !c.includes('svelte')
        && !/^(data-v-|is-|has-)/.test(c));               // 排除框架前缀类
    if (classes.length > 0) {
      return el.tagName.toLowerCase() + '.' + classes.join('.');
    }
  }
  const parent = el.parentElement;
  if (parent) {
    const children = Array.from(parent.children);
    const index = children.indexOf(el) + 1;
    const parentSelector = getUniqueSelector(parent);
    return `${parentSelector} > ${el.tagName}:nth-child(${index})`;
  }
  return getXPath(el);
}

function getXPath(el) {
  if (el.id) return `//*[@id="${el.id}"]`;
  if (el === document.body) return '/html/body';
  let index = 1;
  let siblings = el.parentNode ? el.parentNode.children : [];
  for (let sibling of siblings) {
    if (sibling === el) break;
    if (sibling.tagName === el.tagName) index++;
  }
  const parentPath = el.parentNode ? getXPath(el.parentNode) : '';
  return `${parentPath}/${el.tagName}[${index}]`;
}

function isVisible(el) {
  if (!el) return false;
  // 优化：先用廉价的 offsetWidth/Height 判断尺寸，再查样式，减少 reflow
  if (el.offsetWidth === 0 || el.offsetHeight === 0) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' &&
    parseFloat(style.opacity) > 0;
}

function getMainDomain(hostname) {
  const parts = hostname.split('.');
  if (parts.length >= 3) return parts.slice(-2).join('.');
  return hostname;
}

function isInContentArea(el) {
  let current = el;
  while (current && current !== document.body) {
    const tag = current.tagName.toLowerCase();
    const role = current.getAttribute('role');
    const id = current.id;
    const cls = current.className;
    if (tag === 'main' || tag === 'article' || role === 'main' ||
        id === 'content' || id === 'main' || id === 'app' ||
        (typeof cls === 'string' && /(^|\s)(content|main|article)(\s|$)/.test(cls))) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function containsImage(el) {
  return el.querySelector('img, video, [class*="image"], [class*="img"]') !== null;
}

function hasCloseButton(el) {
  // 优化：合并为单次查询（原来逐个 querySelector 要查 16 次）
  try {
    return el.querySelector(CLOSE_BUTTON_COMBINED) !== null;
  } catch (e) {
    return false;
  }
}

function hasAdText(el) {
  const text = el.textContent.toLowerCase();
  return /广告|sponsored|promoted|推广|advertisement|adchoices/i.test(text);
}

function hasExternalLink(el) {
  const links = el.querySelectorAll('a[href]');
  for (const a of links) {
    const href = a.getAttribute('href');
    if (href && !href.startsWith('#') && !href.startsWith('javascript:') && !href.startsWith('mailto:')) {
      try {
        const url = new URL(href, window.location.href);
        if (url.hostname !== window.location.hostname) {
          return true;
        }
      } catch (e) {}
    }
  }
  return false;
}

// 删除/隐藏前的安全保护：避免误删整个页面或主内容区
function isSafeToRemove(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'HTML' || tag === 'BODY' || tag === 'HEAD' || tag === 'MAIN') return false;
  if (el.dataset.adHandled === 'true' || el.dataset.restored === 'true') return false;
  if (el.classList && el.classList.contains('ad-placeholder')) return false;
  // 面积保护：占视口 90% 宽 且 60% 高 → 视为页面级容器
  try {
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    if (rect.width >= vw * 0.9 && rect.height >= vh * 0.6) return false;
  } catch (e) {}
  // 文本保护：长文本视为正文
  const text = (el.textContent || '').trim();
  if (text.length > 800) return false;
  // 子元素过多视为容器
  if (el.children && el.children.length > 150) return false;
  return true;
}

// 隐藏前的安全保护（比删除宽松，仅拦页面级容器）
function isSafeToHide(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'HTML' || tag === 'BODY' || tag === 'HEAD' || tag === 'MAIN') return false;
  try {
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    if (rect.width >= vw * 0.95 && rect.height >= vh * 0.8) return false;
  } catch (e) {}
  return true;
}

function isLikelyAd(el) {
  if (!isVisible(el)) return false;
  if (el.dataset.adHandled === 'true' || el.dataset.restored === 'true') return false;
  if (!isSafeToRemove(el)) return false;

  // 优化：惰性求值 + 缓存，逻辑与原版完全等价，但只在需要时才做重判定
  let _style = null, _isFixed = false, _isHighZ = false;
  const ensureStyle = () => {
    if (_style) return;
    _style = window.getComputedStyle(el);
    _isFixed = _style.position === 'fixed' || _style.position === 'absolute' || _style.position === 'sticky';
    _isHighZ = (parseInt(_style.zIndex) || 0) > 100;
  };
  let _hasImg, _hasClose, _hasAdText, _hasExtLink;
  const hasImg = () => (_hasImg === undefined ? (_hasImg = containsImage(el)) : _hasImg);
  const hasClose = () => (_hasClose === undefined ? (_hasClose = hasCloseButton(el)) : _hasClose);
  const hasAdText_ = () => (_hasAdText === undefined ? (_hasAdText = hasAdText(el)) : _hasAdText);
  const hasExtLink = () => (_hasExtLink === undefined ? (_hasExtLink = hasExternalLink(el)) : _hasExtLink);

  // 强化：明确含广告字样 → 直接判定
  if (hasAdText_() && !isInContentArea(el)) return true;
  if (hasAdText_() && (hasImg() || hasClose() || hasExtLink())) return true;

  if (hasImg() && hasClose()) return true;
  if (hasImg() && hasExtLink() && hasAdText_()) return true;

  ensureStyle();
  if (_isFixed && _isHighZ && (hasImg() || hasClose() || hasAdText_())) return true;

  if (hasClose() && !hasImg()) {
    if (isInContentArea(el)) return false;
    return _isHighZ || hasAdText_();
  }
  return false;
}

function detectAds() {
  const ads = new Set();
  let candidates;
  try {
    // 优化：合并为单次查询（原来逐个选择器查 14 次）
    candidates = document.querySelectorAll(AD_SELECTORS_COMBINED);
  } catch (e) {
    return [];
  }
  for (const el of candidates) {
    if (el.dataset.adHandled === 'true' || el.dataset.restored === 'true') continue;
    // 优化：isLikelyAd 只算一次（原来调用两次）
    const likely = isLikelyAd(el);
    if (isInContentArea(el) && !likely) continue;  // 正文区且不像广告 → 跳过
    if (likely) ads.add(el);
  }
  return Array.from(ads);
}

// ---------- 与后台通信 ----------
async function fetchMatchingRules() {
  const hostname = window.location.hostname;
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'getMatchingRules', hostname }, (response) => {
      if (response && response.confirmedWords) {
        confirmedFeatureWords = response.confirmedWords;
      }
      resolve(response && response.rules ? response.rules : []);
    });
  });
}

async function fetchSiteRule(hostname) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'getSiteRule', hostname }, (response) => {
      resolve(response && response.siteRule ? response.siteRule : null);
    });
  });
}


// 订阅隐藏规则：注入 CSS display:none（不删除 DOM，安全可恢复）
let cachedRulesRef = null;
let cachedHideSelectors = null;
const HIDE_STYLE_ID = 'adblock-hide-style';

// 内存中保留被摘下的 DOM 节点（同一会话内恢复可保留事件/状态/iframe）
const detachedNodes = new Map(); // 上限 200，超出删最旧

// 收集页面中实际出现的 class / id 标记
function collectPageTokens() {
  const tokens = new Set();
  const all = document.querySelectorAll('*');
  for (const el of all) {
    if (el.id) tokens.add(el.id);
    const cls = el.className;
    if (typeof cls === 'string') {
      if (cls) cls.split(/\s+/).forEach(c => { if (c) tokens.add(c); });
    } else if (el.classList) {
      el.classList.forEach(c => tokens.add(c));
    }
  }
  return tokens;
}

// 从选择器提取 class / id 标记
function extractSelectorTokens(sel) {
  const classes = [];
  const ids = [];
  let m;
  const clsRe = /\.([a-zA-Z0-9_-]+)/g;
  while ((m = clsRe.exec(sel)) !== null) classes.push(m[1]);
  const idRe = /#([a-zA-Z0-9_-]+)/g;
  while ((m = idRe.exec(sel)) !== null) ids.push(m[1]);
  return { classes, ids };
}

// 只保留可能命中当前页面的选择器（页面没有对应标记则一定不匹配）
function filterRelevantSelectors(selectors, tokens, haystack) {
  const relevant = [];
  let skipped = 0;
  for (const sel of selectors) {
    // 属性子串选择器如 [class*="ad"]：用 haystack 子串检查
    const attrMatch = sel.match(/\[(?:class|id)\s*[*^$|~]?=\s*["']?([a-zA-Z0-9_-]+)/);
    if (attrMatch) {
      if (haystack.includes(attrMatch[1])) relevant.push(sel);
      else skipped++;
      continue;
    }
    const { classes, ids } = extractSelectorTokens(sel);
    if (classes.length === 0 && ids.length === 0) {
      relevant.push(sel); // 纯标签/复杂选择器，保守保留
      continue;
    }
    let ok = true;
    for (const c of classes) { if (!tokens.has(c)) { ok = false; break; } }
    if (ok) for (const id of ids) { if (!tokens.has(id)) { ok = false; break; } }
    if (ok) relevant.push(sel);
    else skipped++;
  }
  return { relevant, skipped };
}

function injectHideCss(selectors) {
  // 安全：禁止隐藏根容器（html/body/main），避免整页被隐藏
  const safe = selectors.map(s => s + ':not(html):not(body):not(main)');
  const css = safe.map(s => s + '{display:none !important;}').join('\n');
  let style = document.getElementById(HIDE_STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = HIDE_STYLE_ID;
    (document.head || document.documentElement).appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
  // 运行时兜底：若注入后主内容区被隐藏，撤回本次注入
  setTimeout(() => {
    try {
      const body = document.body;
      if (body && body.offsetHeight < 20) {
        style.textContent = '';
        console.warn('[内容] 检测到整页被隐藏，已撤回隐藏规则');
      }
    } catch (err) {}
  }, 300);
  return selectors.length;
}

// 智能过滤：先扫描页面标记，只注入可能命中的选择器
function applyFilteredHiding(selectors) {
  if (!selectors || !selectors.length) return 0;
  const tokens = collectPageTokens();
  const haystack = Array.from(tokens).join(' ');
  const { relevant, skipped } = filterRelevantSelectors(selectors, tokens, haystack);
  if (skipped > 0) console.log(`[内容] 智能过滤: 保留 ${relevant.length} 条, 跳过 ${skipped} 条（页面无对应标记）`);
  return injectHideCss(relevant);
}

function applyElementHiding(rules) {
  let selectors;
  if (rules === cachedRulesRef && cachedHideSelectors) {
    selectors = cachedHideSelectors;
  } else {
    selectors = [];
    for (const rule of rules) {
      if (rule.type === 'elemhide' && rule.match && rule.match.selector) {
        selectors.push(rule.match.selector);
      }
    }
    cachedRulesRef = rules;
    cachedHideSelectors = selectors;
  }
  if (!selectors.length) return 0;
  return applyFilteredHiding(selectors);
}

function findCloseButton(adElement) {
  // 优化：合并为单次查询，再逐个检查可见性（原来逐个选择器查 16 次）
  let btns;
  try {
    btns = adElement.querySelectorAll(CLOSE_BUTTON_COMBINED);
  } catch (e) {
    return null;
  }
  for (const btn of btns) {
    if (isVisible(btn)) return btn;
  }
  return null;
}

// ---------- 恢复元素（统一入口） ----------
async function restoreFromBackup(backup, parent) {
  // 优先：使用内存中保留的原始节点（保留事件/状态/iframe/视频）
  const mem = detachedNodes.get(backup.id);
  if (mem && mem.node) {
    const node = mem.node;
    node.dataset.restored = 'true';
    delete node.dataset.adHandled;
    node.querySelectorAll('*').forEach(d => { d.dataset.restored = 'true'; });  // 整个子树标记，防被重新扫描
    const ph = document.querySelector('.ad-placeholder[data-backup-id="' + backup.id + '"]');
    if (ph) {
      ph.replaceWith(node);
    } else {
      let tp = parent && document.contains(parent) ? parent : (backup.parentSelector ? document.querySelector(backup.parentSelector) : null);
      if (!tp || !document.contains(tp)) tp = document.body;
      tp.appendChild(node);
    }
    detachedNodes.delete(backup.id);
    console.log('[恢复] 已还原原始节点（保留动态状态）');
    return true;
  }

  // 回退：页面刷新后用保存的 HTML 重建（仅结构）
  const temp = document.createElement('div');
  temp.innerHTML = backup.html;
  const restored = temp.firstElementChild;
  if (!restored) {
    console.error('[恢复] 无法解析备份 HTML');
    return false;
  }
  restored.dataset.restored = 'true';
  delete restored.dataset.adHandled;
  restored.querySelectorAll('*').forEach(d => { d.dataset.restored = 'true'; });
  let targetParent = parent;
  if (!targetParent || !document.contains(targetParent)) {
    targetParent = backup.parentSelector ? document.querySelector(backup.parentSelector) : null;
  }
  if (!targetParent || !document.contains(targetParent)) {
    targetParent = document.body;
  }
  const placeholder = targetParent.querySelector('.ad-placeholder[data-backup-id="' + backup.id + '"]');
  if (placeholder) {
    placeholder.replaceWith(restored);
    console.log('[恢复] 已替换占位恢复元素（HTML 重建）');
  } else {
    targetParent.appendChild(restored);
    console.log('[恢复] 已追加恢复元素（HTML 重建）');
  }
  return true;
}

// ---------- 删除元素（创建占位符） ----------
async function removeWithBackup(element, source, preSize) {
  if (!element) return;
  if (element.dataset.adHandled === 'true') return;
  if (element.dataset.restored === 'true') return;  // 已恢复的元素不再删
  // 安全保护：拒绝删除页面级容器 / 正文大块
  if (!isSafeToRemove(element)) {
    console.log('[广告拦截] 跳过删除（疑似页面级容器）:', element.tagName, element.className);
    return;
  }

  const parentSelector = getUniqueSelector(element.parentElement);
  const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  // 尺寸：优先用预存值（元素可能已被隐藏，测不到真实尺寸）
  let w, h;
  if (preSize && preSize.w) {
    w = preSize.w; h = preSize.h;
  } else {
    const rect = element.getBoundingClientRect();
    w = Math.max(50, Math.round(rect.width));
    h = Math.max(40, Math.round(rect.height));
  }

  // 创建占位符
  const placeholder = document.createElement('div');
  placeholder.className = 'ad-placeholder';
  placeholder.dataset.backupId = id;
  placeholder.dataset.adHandled = 'true';
  placeholder.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: center;
    width: ${w}px;
    height: ${h}px;
    background: #f9f9f9;
    border: 1px dashed #ccc;
    text-align: center;
    padding: 10px;
    color: #999;
    cursor: pointer;
    font-size: 12px;
    box-sizing: border-box;
    font-family: sans-serif;
    overflow: hidden;
  `;
  placeholder.textContent = '点击显示被隐藏的内容';

  // 关键：保留节点引用（同一会话内恢复可还原事件/状态/iframe）
  detachedNodes.set(id, { node: element, parentSelector, source: source || 'scan' });
  // 内存上限：超出删最旧，防泄漏
  if (detachedNodes.size > 200) {
    const oldest = detachedNodes.keys().next().value;
    detachedNodes.delete(oldest);
  }

  // 同时保存 HTML 兜底（页面刷新后仍可重建）
  try {
    const result = await chrome.storage.local.get(['removedBackups']);
    let backups = result.removedBackups || [];
    backups.push({ id, parentSelector, html: element.outerHTML, timestamp: Date.now() });
    if (backups.length > backupLimit) backups = backups.slice(-backupLimit);
    await chrome.storage.local.set({ removedBackups: backups });
  } catch (e) {}

  element.replaceWith(placeholder);
  console.log('[广告拦截] 已替换为占位（点击可恢复）');
}

// ---------- 统一入口：按当前模式删除或隐藏 ----------
async function applyBlock(el, source) {
  if (!el || el.nodeType !== 1) return;
  if (blockMode === 'hide') {
    hideElement(el);
  } else {
    await removeWithBackup(el, source);
  }
}

// 隐藏型：仅 display:none，不碰 DOM 结构（对 SPA 安全），记录以便恢复
function hideElement(el) {
  if (!el || el.nodeType !== 1) return;
  if (el.dataset.adHidden === '1') return;
  if (el.dataset.adHandled === 'true' || el.dataset.restored === 'true') return;
  if (!isSafeToHide(el)) return;
  const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  _hiddenEls.set(id, el);
  el.dataset.adHidden = '1';
  el.style.setProperty('display', 'none', 'important');
  // 内存上限
  if (_hiddenEls.size > 500) {
    const oldest = _hiddenEls.keys().next().value;
    _hiddenEls.delete(oldest);
  }
}

// ---------- 事件委托：点击占位符恢复 ----------
document.addEventListener('click', async function(e) {
  const placeholder = e.target.closest('.ad-placeholder');
  if (!placeholder) return;
  e.stopPropagation();

  const backupId = placeholder.dataset.backupId;
  if (!backupId) return;
  const parent = placeholder.parentElement;

  // 内存中的原始节点（保留动态状态，无需 storage）
  if (detachedNodes.has(backupId)) {
    const ok = await restoreFromBackup({ id: backupId, parentSelector: '' }, parent);
    // 清理 storage 中对应的 HTML 备份（内存已恢复）
    try {
      const r = await chrome.storage.local.get(['removedBackups']);
      let bs = r.removedBackups || [];
      const before = bs.length;
      bs = bs.filter(b => b.id !== backupId);
      if (bs.length !== before) await chrome.storage.local.set({ removedBackups: bs });
    } catch (err) {}
    if (!ok) alert('恢复失败');
    return;
  }

  // 回退：从 storage 读 HTML 备份（页面刷新后）
  const result = await chrome.storage.local.get(['removedBackups']);
  let backups = result.removedBackups || [];
  const index = backups.findIndex(b => b.id === backupId);
  if (index === -1) {
    alert('未找到备份，无法恢复');
    return;
  }
  const backup = backups[index];
  backups.splice(index, 1);
  await chrome.storage.local.set({ removedBackups: backups });
  const success = await restoreFromBackup(backup, parent);
  if (!success) alert('恢复失败，元素结构可能已变化');
});

// ---------- 广告处理函数 ----------
async function handleAdElement(adElement) {
  if (!adElement || !isVisible(adElement)) return false;
  if (adElement.dataset.adHandled === 'true') return false;
  if (adElement.dataset.restored === 'true') return false;

  const closeBtn = findCloseButton(adElement);
  if (closeBtn) {
    closeBtn.click();
    adElement.dataset.adHandled = 'true';
    console.log('[广告拦截] 点击关闭按钮');
    let disappeared = false;
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (!isVisible(adElement)) {
        disappeared = true;
        break;
      }
    }
    if (!disappeared) {
      console.log('[广告拦截] 关闭后未消失，执行删除');
      await applyBlock(adElement, 'scan');
    }
    return true;
  } else {
    await applyBlock(adElement, 'scan');
    return true;
  }
}

// ---------- 启发式扫描 ----------
async function scanByCloseButton() {
  // 优化：不再遍历所有元素；直接定位关闭按钮，再向上找覆盖层容器
  let buttons;
  try {
    buttons = document.querySelectorAll(CLOSE_BUTTON_COMBINED);
  } catch (e) {
    return;
  }
  const checked = new Set();
  for (const btn of buttons) {
    if (scanOverBudget()) break;
    if (!isVisible(btn)) continue;
    // 向上寻找候选覆盖层容器（最多 8 层）
    let el = btn.parentElement;
    let depth = 0;
    let target = null;
    while (el && depth < 8) {
      if (el.dataset.adHandled === 'true' || el.dataset.restored === 'true') { target = null; break; }
      const style = window.getComputedStyle(el);
      const isOverlay = style.position === 'fixed' || style.position === 'absolute' || style.position === 'sticky';
      const zIndex = parseInt(style.zIndex) || 0;
      if (isOverlay && zIndex >= 1000) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 50 && rect.height >= 50) { target = el; break; }
      }
      el = el.parentElement;
      depth++;
    }
    if (!target || checked.has(target)) continue;
    checked.add(target);
    if (!/广告|sponsored|promoted|推广|advertisement|adchoices/i.test(target.textContent)) continue;
    await handleAdElement(target);
  }
}

// ---------- 扫描调度器 ----------
let lastScanAt = 0;
const MIN_SCAN_INTERVAL = 2000; // 动态扫描最小间隔
const SCAN_BUDGET_MS = 2000;    // 单次扫描总时间预算（放宽，保证扫完不遗漏）
let _scanDeadline = 0;
function scanOverBudget() { return performance.now() > _scanDeadline; }

function scheduleScan() {
  if (scanScheduled) return; // 已排期
  const elapsed = Date.now() - lastScanAt;
  if (elapsed >= MIN_SCAN_INTERVAL) {
    scanScheduled = true;
    const doScan = () => {
      scanScheduled = false;
      lastScanAt = Date.now();
      scanAndClean().catch(console.error);
    };
    if ('requestIdleCallback' in window) {
      requestIdleCallback(doScan, { timeout: 1000 });
    } else {
      setTimeout(doScan, 300);
    }
  } else {
    if (scanTimer) return; // 已有等待定时器，不重复排
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scheduleScan();
    }, MIN_SCAN_INTERVAL - elapsed);
  }
}

// 广告标签文字（短标签，如卡片角标）
const AD_LABEL_RE = /^(广告|推广|赞助|ad|ads|sponsored|promoted|advertisement)$/i;

// ================= dHash 图像指纹匹配 =================
// 全域默认模板（所有网站生效）
const DEFAULT_AD_BADGES = [
  'data:image/png;base64,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',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAZCAYAAAB3oa15AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAMhSURBVFhH7ZbbK3xRFMf9HaYUNS/zonmRQgppGiMyKWHE4MG1xv1uUBOPUiPGDJ49KJcYJUUpD/IiHuQyjVyj5JL799daZWLPj9mHn+anfGp1Zq911jnnu/dea08IfjghouOn8Ssg2HxJwNPTE66urvD8/CyGAnJ7e4vz83Pc39+LIUV8SQB9QHt7O8bGxsSQH1tbWxgdHcXx8TGPV1dX0dLSgu3tbfFWRSgWQLP9+PjIdn19jbKyMqSlpeHg4IBX5CVGv1+vTGdnJ/R6PTweD8cmJyeRkJCAlZUVvzwlSAu4uLhAT08PsrOzkZeXx2Y2m5GYmIjw8HBkZGQgPz+f/XRPRUUFNjY2OHd3dxdRUVEIDQ2FyWTivKSkJKhUKhgMBhQUFHBeVlYWampqcHJyIr7+XaQFHB4eIiYmBpGRkfyS+vp61NbWoqmpCa2trb4xmcVi4Rmn7XF3d4e2tjZotVrOa2xsRENDA4xGIwsnQeR7yevu7sbZ2Zn4+ndRJIBmmz5GCbT3dTod+vv73/gXFhaQmprqW6XP8q0CqEONj4/zdnK5XHC73ZidneVrR0cHr2Zvby/m5uYwMzPDNjU1heXlZelaUCyAtoss+/v7sFqtXBvFxcUoLCxkKyoqQk5ODtLT03kL0Zj8VBtUP11dXdLtVVrA0dERFx61PlnoI6ggSQjZ3t4eFzQZdSOv1+vz0ZXGZJQje7ZIC6AViI+P5+JUyunpKWw2G0pKSlBVVcXF+trIV15ejrq6Oq4ZJUgLWF9fh0ajwdDQkBgKCB1a0dHRvI0GBwe5oO12u8/omc3NzVCr1ZiYmBDTP0RawMjICLfCpaUlMRQQEpCSkoL5+Xkx5GNnZwdxcXHfI+Dy8hKZmZl86NDfB6WQADqFp6enfSeuaLTCsbGx/14AFZPT6URYWBiGh4fFsBRra2t8EicnJ3NLLS0tfWOVlZU8QRERESxSCQEF0Oz09fWhurr6U7NPbG5uIjc3l58xMDDgVwMOh4NbJ63w4uKimP4hAQUQDw8P0m3tb9Ak3NzciG4/6B56lxKkBPzP/AoINr8Cgs0fimyMbCSNJl4AAAAASUVORK5CYII=',
  'data:image/png;base64,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',
  'data:image/png;base64,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'
];
let adImageHashes = [];  // init 时由 DEFAULT_AD_BADGES 计算填充 + 当前域名采集
let adBadgeClasses = [];       // 当前域名下学习的角标 class（如 gg-pic）
let collectImageMode = false;  // 采集模式开关
let DHASH_DISTANCE = 10;       // 汉明距离阈值（默认 10，越小越严格；可从 popup 调整）

// 当前域名的存储 key（主域名）
function featureKey() {
  const host = location.hostname;
  const parts = host.split('.');
  return parts.length >= 3 ? parts.slice(-2).join('.') : host;
}

// 加载一张 base64 图片并计算其 dHash（用于内置默认角标模板）
function loadBadgeHash(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(computeDHash(img));
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// 计算所有内置默认角标的指纹
async function loadDefaultBadgeHashes() {
  const hashes = [];
  for (const url of DEFAULT_AD_BADGES) {
    const h = await loadBadgeHash(url);
    if (h && !hashes.includes(h)) hashes.push(h);
  }
  return hashes;
}

// 复用同一个 canvas，避免每次 computeDHash 都新建（性能优化）
let _dhashCanvas = null, _dhashCtx = null;
function getDHashCtx() {
  if (!_dhashCanvas) {
    _dhashCanvas = document.createElement('canvas');
    _dhashCanvas.width = 9; _dhashCanvas.height = 8;
    // willReadFrequently：消除 getImageData 的性能警告
    _dhashCtx = _dhashCanvas.getContext('2d', { willReadFrequently: true });
  }
  return _dhashCtx;
}
// 跨域图片会污染（taint）canvas，一旦污染后续 getImageData 全失败 → 立即重建
function resetDHashCanvas() {
  _dhashCanvas = null;
  _dhashCtx = null;
}

// 优化：dHash 结果按图片 URL 缓存（同一张图只做一次 canvas 回读，避免主线程卡顿）
const _dhashCache = new Map();

// 计算 <img> 的 dHash：缩放到 9x8，比较相邻像素亮度 → 64 位指纹
function computeDHash(imgEl) {
  // 优化：命中缓存直接返回（B站等页面图片密集，避免重复 canvas 回读）
  const url = imgEl.currentSrc || imgEl.src || '';
  if (url && _dhashCache.has(url)) return _dhashCache.get(url);
  try {
    // 图片必须已加载完成，否则画出来是空白
    if (!imgEl.complete || !imgEl.naturalWidth) return null;
    const ctx = getDHashCtx();
    ctx.clearRect(0, 0, 9, 8);
    ctx.drawImage(imgEl, 0, 0, 9, 8);
    const d = ctx.getImageData(0, 0, 9, 8).data;
    let hash = '';
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const i = (y * 9 + x) * 4;
        const j = (y * 9 + x + 1) * 4;
        const l1 = d[i] * 0.3 + d[i+1] * 0.59 + d[i+2] * 0.11;
        const l2 = d[j] * 0.3 + d[j+1] * 0.59 + d[j+2] * 0.11;
        hash += (l1 > l2) ? '1' : '0';
      }
    }
    if (url) {
      _dhashCache.set(url, hash);
      if (_dhashCache.size > 800) _dhashCache.clear();
    }
    return hash;
  } catch (e) {
    // 跨域图片会污染 canvas，重建以恢复干净状态
    resetDHashCanvas();
    if (url) _dhashCache.set(url, null);  // 失败也缓存，避免重复尝试
    return null;
  }
}

function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  let dist = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) dist++;
  return dist;
}

// 指纹按位取反（用于匹配反色图片：亮度关系整体翻转）
function invertHash(h) {
  let r = '';
  for (let i = 0; i < h.length; i++) r += (h[i] === '1' ? '0' : '1');
  return r;
}

// 判断某图片是否与预存角标指纹相似（支持正图 / 反色图）
function matchAdImage(imgEl) {
  if (!adImageHashes.length) return false;
  const h = computeDHash(imgEl);
  if (!h) return false;
  const inv = invertHash(h);
  return adImageHashes.some(t => {
    // 正向比对
    if (hammingDistance(h, t) <= DHASH_DISTANCE) return true;
    // 反色比对（图片颜色反转时 hash 每位翻转）
    if (hammingDistance(inv, t) <= DHASH_DISTANCE) return true;
    return false;
  });
}

// 加载 CSS 背景图 URL 并匹配指纹（跨域失败返回 false）
const bgImageCache = new Map();
async function matchBackgroundImage(bgValue) {
  const m = bgValue.match(/url\(["']?([^"')]+)["']?\)/);
  if (!m) return false;
  const url = m[1];
  if (bgImageCache.has(url)) {
    const h = bgImageCache.get(url);
    if (!h) return false;
    const inv = invertHash(h);
    return adImageHashes.some(t => hammingDistance(h, t) <= DHASH_DISTANCE || hammingDistance(inv, t) <= DHASH_DISTANCE);
  }
  const hash = await loadImageHash(url);
  bgImageCache.set(url, hash);
  if (!hash) return false;
  const inv = invertHash(hash);
  return adImageHashes.some(t => hammingDistance(hash, t) <= DHASH_DISTANCE || hammingDistance(inv, t) <= DHASH_DISTANCE);
}

function loadImageHash(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const ctx = getDHashCtx();
        ctx.clearRect(0, 0, 9, 8);
        ctx.drawImage(img, 0, 0, 9, 8);
        const d = ctx.getImageData(0, 0, 9, 8).data;
        let hash = '';
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const i = (y * 9 + x) * 4, j = (y * 9 + x + 1) * 4;
            const l1 = d[i] * 0.3 + d[i+1] * 0.59 + d[i+2] * 0.11;
            const l2 = d[j] * 0.3 + d[j+1] * 0.59 + d[j+2] * 0.11;
            hash += (l1 > l2) ? '1' : '0';
          }
        }
        resolve(hash);
      } catch (e) { resolve(null); } // 跨域
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// 判断元素是否命中学习的角标 class 特征
function matchByBadgeClass(el) {
  if (!adBadgeClasses.length || !el) return false;
  const cls = (typeof el.className === 'string') ? el.className : (el.className && el.className.baseVal || '');
  if (!cls) return false;
  const parts = cls.split(/\s+/).filter(Boolean);
  return adBadgeClasses.some(c => parts.includes(c));
}

// 从标签向上定位信息流卡片（优先取与兄弟元素尺寸一致的容器）
function findCardFromLabel(label) {
  let el = label;
  let fallback = null;
  const vw = window.innerWidth || 1200;
  for (let depth = 0; el && depth < 15; depth++) {
    const parent = el.parentElement;
    if (!parent) break;
    // 用 getBoundingClientRect（准确，考虑 transform/scale/虚拟滚动）
    const rect = el.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    // 卡片/横幅尺寸范围：宽 100~视口98%，高 40~700
    const sizeOk = w >= 100 && h >= 40 && w <= vw * 0.98 && h <= 700;
    if (sizeOk) {
      // 媒体：img/video/a 或背景图
      let hasMedia = el.querySelector && el.querySelector('img, video, a[href]');
      if (!hasMedia) {
        // 检查背景图
        try {
          const bg = getComputedStyle(el).backgroundImage;
          if (bg && bg !== 'none' && bg.startsWith('url(')) hasMedia = true;
        } catch (e) {}
      }
      if (hasMedia) {
        if (!isSafeToRemove(el)) break;
        // 与兄弟同尺寸 → 信息流网格卡片，最准
        const siblings = parent.children;
        for (let i = 0; i < siblings.length; i++) {
          const s = siblings[i];
          if (s === el) continue;
          const sr = s.getBoundingClientRect();
          if (Math.abs(sr.width - w) < 30 && Math.abs(sr.height - h) < 60) return el;
        }
        if (!fallback) fallback = el; // 记下首个含媒体候选（横幅走这里）
      }
    }
    el = parent;
  }
  return fallback;
}

// 按'广告/推广'文字标签定位卡片并删除（可恢复）
async function scanByAdLabel() {
  let removed = 0;
  const candidates = document.querySelectorAll('span, div, i, em, b, label, a, p, strong');
  for (const el of candidates) {
    if (scanOverBudget()) return removed;
    if (el.dataset.adHandled === 'true' || el.dataset.restored === 'true') continue;
    const t = (el.textContent || '').trim();
    if (!t || t.length > 6) continue;
    if (!AD_LABEL_RE.test(t)) continue;
    const lw = el.offsetWidth, lh = el.offsetHeight;
    if (lw > 400 || lh > 200) continue;
    if (!isVisible(el)) continue;
    const card = findCardFromLabel(el);
    if (!card || card.dataset.adHandled === 'true') continue;
    if (!isSafeToRemove(card)) continue;
    await applyBlock(card, 'scan');
    removed++;
  }
  if (removed > 0) console.log(`[广告拦截] 按广告标签删除 ${removed} 个卡片`);
  return removed;
}

async function scanAndClean() {
  const t0 = performance.now();
  applyElementHiding(currentPageRules);

  // 每个阶段独立预算（避免 handleAdElement 的等待耗尽总预算，导致后续阶段被跳过）
  _scanDeadline = performance.now() + SCAN_BUDGET_MS;
  const ads = detectAds();
  let count = 0;
  for (const ad of ads) {
    if (scanOverBudget()) break;
    if (await handleAdElement(ad)) count++;
  }

  _scanDeadline = performance.now() + SCAN_BUDGET_MS;
  await scanByBadgeClass();
  _scanDeadline = performance.now() + SCAN_BUDGET_MS;
  await scanByAdLabel();
  _scanDeadline = performance.now() + SCAN_BUDGET_MS;
  await scanByAdImage();
  _scanDeadline = performance.now() + SCAN_BUDGET_MS;
  await scanByCloseButton();

  const cost = Math.round(performance.now() - t0);
  if (cost > 500) console.warn(`[扫描] 单次扫描耗时 ${cost}ms`);
  if (count > 0) console.log(`[扫描] 清理了 ${count} 个广告`);
}

// 按学习的角标 class 特征扫描（如 gg-pic），最准
async function scanByBadgeClass() {
  if (!adBadgeClasses.length) return 0;
  let removed = 0;
  let all;
  try {
    all = document.querySelectorAll(adBadgeClasses.map(c => '.' + CSS.escape(c)).join(','));
  } catch (e) { return 0; }
  for (const el of all) {
    if (scanOverBudget()) break;
    if (el.dataset.adHandled === 'true' || el.dataset.restored === 'true') continue;
    // (matchByBadgeClass 判定已由外部 class 选择器完成)
    if (!isVisible(el)) continue;
    const r = { width: el.offsetWidth, height: el.offsetHeight };
    if (r.width < 5 || r.height < 5 || r.width > 200 || r.height > 120) continue;
    const card = findCardFromLabel(el);
    if (!card || card.dataset.adHandled === 'true') continue;
    if (!isSafeToRemove(card)) continue;
    await applyBlock(card, 'scan');
    removed++;
  }
  if (removed > 0) console.log(`[广告拦截] 按角标class删除 ${removed} 个卡片`);
  return removed;
}

// 按图像指纹匹配广告角标，找到卡片删除
async function scanByAdImage() {
  if (!adImageHashes.length) return 0;
  let removed = 0;
  // 1) 普通 <img>
  const imgs = document.querySelectorAll('img');
  for (const img of imgs) {
    if (scanOverBudget()) return removed;
    if (img.dataset.adHandled === 'true' || img.dataset.restored === 'true') continue;
    const w = img.offsetWidth, h = img.offsetHeight;
    if (w < 10 || h < 8 || w > 200 || h > 120) continue;
    if (!isVisible(img)) continue;
    if (!matchAdImage(img)) continue;
    const card = findCardFromLabel(img);
    if (!card || card.dataset.adHandled === 'true') continue;
    if (!isSafeToRemove(card)) continue;
    await applyBlock(card, 'scan');
    removed++;
  }
  // 2) CSS 背景图元素（角标常用 background-image）
  const all = document.querySelectorAll('i, span, div, em, b');
  for (const el of all) {
    if (scanOverBudget()) return removed;
    if (el.dataset.adHandled === 'true' || el.dataset.restored === 'true') continue;
    const w = el.offsetWidth, h = el.offsetHeight;
    if (w < 10 || h < 8 || w > 200 || h > 120) continue;
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none' || !bg.startsWith('url(')) continue;
    if (await matchBackgroundImage(bg)) {
      const card = findCardFromLabel(el);
      if (!card || card.dataset.adHandled === 'true') continue;
      if (!isSafeToRemove(card)) continue;
      await applyBlock(card, 'scan');
      removed++;
    }
  }
  if (removed > 0) console.log(`[广告拦截] 按图像指纹删除 ${removed} 个卡片`);
  return removed;
}

// 优化：已判定过的图片 URL 缓存，避免重复做 canvas 回读
const _judgedImgUrls = new Set();

// 单张图片即时判断（图片加载完立即调用，无需等扫描周期）
async function judgeImageAd(img) {
  if (!adImageHashes.length) return false;
  if (!img || img.tagName !== 'IMG') return false;
  if (img.dataset.adHandled === 'true') return false;
  // 优化：先用廉价的 offsetWidth 做尺寸筛（大图直接跳过，避免 getComputedStyle + canvas）
  const w = img.offsetWidth, h = img.offsetHeight;
  if (w < 10 || h < 8 || w > 200 || h > 120) return false;
  // 优化：同一 URL 只判定一次
  const url = img.currentSrc || img.src || '';
  if (url) {
    if (_judgedImgUrls.has(url)) return false;
    _judgedImgUrls.add(url);
    if (_judgedImgUrls.size > 2000) _judgedImgUrls.clear();
  }
  if (!isVisible(img)) return false;
  if (!matchAdImage(img)) return false;
  const card = findCardFromLabel(img);
  if (!card || card.dataset.adHandled === 'true') return false;
  if (!isSafeToRemove(card)) return false;
  await applyBlock(card, 'scan');
  console.log('[广告拦截] 图片加载即判定为广告，已删除');
  return true;
}

// 图片判定队列：避免大量图片同时加载时集中阻塞主线程（图片渲染被延迟）
let _judgeRunning = false;
const _judgeQueue = [];
async function processJudgeQueue() {
  if (_judgeRunning) return;
  _judgeRunning = true;
  while (_judgeQueue.length) {
    const img = _judgeQueue.shift();
    try { await judgeImageAd(img); } catch (e) {}
    // 每处理若干张让出主线程，避免长时间占用导致图片懒加载延迟
    if (_judgeQueue.length % 8 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
  _judgeRunning = false;
}

// 全局图片加载监听（capture 阶段捕获所有 img 的 load）
document.addEventListener('load', function(e) {
  const t = e.target;
  if (t && t.tagName === 'IMG') {
    _judgeQueue.push(t);
    // 防止积压：超过 200 张只保留最新的
    if (_judgeQueue.length > 200) _judgeQueue.splice(0, _judgeQueue.length - 200);
    // 空闲时批量处理，优先级低于图片渲染
    if ('requestIdleCallback' in window) {
      requestIdleCallback(processJudgeQueue, { timeout: 2000 });
    } else {
      setTimeout(processJudgeQueue, 300);
    }
  }
}, true);

// ---------- 等待元素 ----------
async function waitForElement(selector, timeout = 3000, interval = 200) {
  const startTime = Date.now();
  const selectorsToTry = [
    selector,
    selector.replace(/"/g, "'"),
    selector.replace(/'/g, '"'),
    selector.trim()
  ];
  const uniqueSelectors = [...new Set(selectorsToTry)];
  while (Date.now() - startTime < timeout) {
    for (const sel of uniqueSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (e) {}
    }
    await new Promise(r => setTimeout(r, interval));
  }
  return null;
}

// ---------- 执行操作 ----------
async function executeOperations(ops) {
  for (const op of ops) {
    try {
      let target = await waitForElement(op.targetSelector, 3000, 200);
      if (!target && op.searchScope) {
        const scope = await waitForElement(op.searchScope, 2000, 200);
        if (scope) {
          const startTime = Date.now();
          while (Date.now() - startTime < 3000) {
            const selectorsToTry = [
              op.targetSelector,
              op.targetSelector.replace(/"/g, "'"),
              op.targetSelector.replace(/'/g, '"'),
              op.targetSelector.trim()
            ];
            const uniqueSelectors = [...new Set(selectorsToTry)];
            for (const sel of uniqueSelectors) {
              try {
                const el = scope.querySelector(sel);
                if (el) { target = el; break; }
              } catch (e) {}
            }
            if (target) break;
            await new Promise(r => setTimeout(r, 200));
          }
        }
      }
      if (!target) {
        console.warn(`[回放] 超时未找到: ${op.targetSelector}`);
        continue;
      }
      if (op.action === 'click') {
        target.click();
        console.log(`[回放] 点击: ${op.targetSelector}`);
      } else if (op.action === 'remove') {
        await applyBlock(target, 'replay');
        console.log(`[回放] 删除: ${op.targetSelector}`);
      } else if (op.action === 'batchRemove') {
        // 按 class 批量删除所有同类
        let els;
        try { els = document.querySelectorAll('.' + CSS.escape(op.classSelector)); } catch (e) { continue; }
        let n = 0;
        for (const s of els) {
          if (s.dataset.adHandled === 'true' || s.dataset.restored === 'true') continue;
          await applyBlock(s, 'replay');
          n++;
        }
        console.log(`[回放] 批量删除 .${op.classSelector} 共 ${n} 个`);
      }
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.error(`[回放] 操作失败: ${op.id}`, e);
    }
  }
}

// ---------- 回放 ----------
async function replayOperations() {
  // 第一步：先判断哪些规则适用于当前页面（一次遍历，判断与分类合并）
  const { hideSelectors, elementRules } = selectApplicableRules(currentPageRules);
  // 第二步：只对筛选出的规则应用到页面
  const hostname = window.location.hostname;
  const siteData = await fetchSiteRule(hostname);
  if (siteData && siteData.operations) {
    await executeOperations(siteData.operations);
  }
  if (hideSelectors.length) {
    applyFilteredHiding(hideSelectors);
    console.log(`[回放] 应用隐藏规则 ${hideSelectors.length} 条`);
  }
  for (const rule of elementRules) {
    console.log(`[回放] 匹配通用规则: ${rule.name || rule.id}`);
    await executeOperations(rule.operations);
  }
}

// 先判断：筛选出当前页面实际适用的规则，返回 { hideSelectors, elementRules }
function selectApplicableRules(rules) {
  const hideSelectors = [];
  const elementRules = [];
  for (const rule of rules) {
    if (rule.type === 'elemhide' && rule.match && rule.match.selector) {
      // 只收集选择器，交由 injectHideCss 注入 CSS 隐藏
      hideSelectors.push(rule.match.selector);
    } else if (rule.type === 'element' && rule.operations) {
      // element 规则会主动执行 click/remove，必须先判断是否适用当前页面
      if (ruleMatchesCurrentPage(rule)) elementRules.push(rule);
    }
  }
  return { hideSelectors, elementRules };
}

// 判断规则是否适用于当前页面（requiredElements 任一命中即认为适用）
function ruleMatchesCurrentPage(rule) {
  if (!rule.match || !rule.match.requiredElements) return true;
  const required = rule.match.requiredElements;
  if (!Array.isArray(required) || required.length === 0) return true;
  for (const sel of required) {
    try {
      // 精准匹配
      if (document.querySelector(sel)) return true;
      // 放宽：核心词已确认时，改用 [class*="核心词"] 匹配
      const word = extractCoreWord(sel);
      if (word && confirmedFeatureWords.includes(word)) {
        if (document.querySelector(`[class*="${word}"]`)) return true;
      }
    } catch (e) {}
  }
  return false;
}

// 提取选择器核心词（与 background 的甲方案一致）
function extractCoreWord(selector) {
  const m = selector.match(/[.#]([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const parts = m[1].split(/[-_]/).filter(Boolean);
  if (!parts.length) return null;
  return parts[parts.length - 1].toLowerCase();
}

// ---------- 录制功能 ----------
function addRecordedOp(action, selector) {
  const exists = recordedOps.some(op => op.action === action && op.targetSelector === selector);
  if (exists) {
    console.log('[录制] 操作已存在，跳过:', action, selector);
    return false;
  }
  const op = {
    id: `op_${++operationCounter}`,
    targetSelector: selector,
    action: action,
    timestamp: Date.now()
  };
  recordedOps.push(op);
  scheduleSyncRecordingState();
  updateRecordingCount();
  return true;
}

function scheduleSyncRecordingState() {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncRecordingStateNow();
  }, SYNC_DELAY);
}

async function syncRecordingStateNow() {
  await chrome.runtime.sendMessage({
    type: 'updateRecordingOps',
    recordedOps: recordedOps,
    operationCounter: operationCounter
  });
}

async function restoreRecordingState() {
  const response = await chrome.runtime.sendMessage({ type: 'getRecordingState' });
  if (response && response.isRecording) {
    isRecording = true;
    recordedOps = response.recordedOps || [];
    operationCounter = response.operationCounter || 0;
    showRecordingIndicator();
    updateRecordingCount();
    console.log('[录制] 从 background 恢复，已记录:', recordedOps.length);
  }
}

function startRecording() {
  if (stopResetTimer) { clearTimeout(stopResetTimer); stopResetTimer = null; }
  chrome.runtime.sendMessage({ type: 'startRecording' }, (response) => {
    if (response.success) {
      isRecording = true;
      recordedOps = [];
      operationCounter = 0;
      showRecordingIndicator();
      updateRecordingCount();
      console.log('[录制] 开始录制');
    }
  });
}

function stopRecording() {
  if (recordedOps.length === 0) {
    chrome.runtime.sendMessage({ type: 'clearRecordingState' });
    isRecording = false;
    hideRecordingIndicator();
    console.log('[录制] 未录制任何操作');
    return;
  }
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  const count = recordedOps.length;
  const features = extractPageFeatures();
  // 直接发 stopRecording（携带完整 ops），不依赖前一步同步成功
  chrome.runtime.sendMessage({
    type: 'stopRecording',
    operations: recordedOps,
    features: features,
    url: window.location.href
  }, (response) => {
    isRecording = false;
    recordedOps = [];
    operationCounter = 0;
    hideRecordingIndicator();
    console.log(`[录制] 停止，共 ${count} 个操作`);
  });
  // 兜底：若 1 秒内无响应，也复位本地状态
  if (stopResetTimer) clearTimeout(stopResetTimer);
  stopResetTimer = setTimeout(() => {
    stopResetTimer = null;
    if (isRecording) {
      isRecording = false;
      recordedOps = [];
      operationCounter = 0;
      hideRecordingIndicator();
    }
  }, 1000);
}

function extractPageFeatures() {
  const features = { requiredElements: [] };
  // 精准提取：从录制的操作里取被操作元素的实际 class / id 特征
  for (const op of recordedOps) {
    const sel = op.targetSelector;
    if (!sel) continue;
    let m;
    const classRe = /\.([a-zA-Z0-9_-]+)/g;
    while ((m = classRe.exec(sel)) !== null) {
      features.requiredElements.push('.' + m[1]);
    }
    const idMatch = sel.match(/#([a-zA-Z0-9_-]+)/);
    if (idMatch) features.requiredElements.push('#' + idMatch[1]);
  }
  features.requiredElements = [...new Set(features.requiredElements)];
  // 兜底：未提取到任何特征时，回退到通用广告标签
  if (features.requiredElements.length === 0) {
    const fallback = ['.ad-container', '.popup-ad', '.banner-ad'];
    for (const sel of fallback) {
      if (document.querySelector(sel)) features.requiredElements.push(sel);
    }
  }
  return features;
}

// ---------- 录制指示器 ----------
function showRecordingIndicator() {
  let indicator = document.getElementById('recording-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'recording-indicator';
    indicator.style.cssText = `
      position: fixed; top: 10px; right: 10px; z-index: 999999;
      background: #ff4444; color: white; padding: 8px 16px;
      border-radius: 20px; font-weight: bold; font-size: 14px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      display: flex; align-items: center; gap: 10px;
      font-family: 'Segoe UI', sans-serif;
    `;
    indicator.innerHTML = `
      <span>⏺️ 录制中</span>
      <span id="recording-count" style="background:rgba(255,255,255,0.3);padding:0 8px;border-radius:10px;">0</span>
      <button id="undo-recording-btn" style="background:#ffcc00;color:#333;border:none;border-radius:12px;padding:2px 10px;cursor:pointer;font-weight:bold;">↩️ 撤回</button>
      <button id="stop-recording-btn" style="background:#ffffff;color:#ff4444;border:none;border-radius:12px;padding:2px 10px;cursor:pointer;font-weight:bold;">⏹ 停止</button>
      <button id="mark-delete-btn" style="background:white;color:#ff4444;border:none;border-radius:12px;padding:2px 10px;cursor:pointer;font-weight:bold;">✖ 标记删除</button>
      <button id="collect-img-btn" style="background:white;color:#0088cc;border:none;border-radius:12px;padding:2px 10px;cursor:pointer;font-weight:bold;">📷 采集角标</button>
    `;
    document.body.appendChild(indicator);

    document.getElementById('undo-recording-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      undoLastRecordingOp();
    });
    document.getElementById('stop-recording-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      stopRecording();
    });
    document.getElementById('mark-delete-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      toggleMarkDeleteMode();
    });
    document.getElementById('collect-img-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      toggleCollectImageMode();
    });
  }
  updateRecordingCount();
  indicator.style.display = 'flex';
}

function hideRecordingIndicator() {
  const indicator = document.getElementById('recording-indicator');
  if (indicator) indicator.style.display = 'none';
  if (markDeleteMode) toggleMarkDeleteMode(false);
  if (collectImageMode) toggleCollectImageMode(false);
}

function updateRecordingCount() {
  const countEl = document.getElementById('recording-count');
  if (countEl) countEl.textContent = recordedOps.length;
}

// ---------- 撤回录制中的删除 ----------
async function undoLastRecordingOp() {
  if (recordedOps.length === 0) {
    alert('没有可撤回的操作');
    return;
  }
  // 撤回最后一次操作（不管 click 还是 remove）
  const lastOp = recordedOps[recordedOps.length - 1];
  recordedOps.pop();
  operationCounter--;

  // 仅删除操作需要恢复元素；click 只是移除记录
  if (lastOp.action === 'remove') {
    const memIds = Array.from(detachedNodes.keys()).filter(k => {
      const m = detachedNodes.get(k);
      return m && m.source === 'record';
    });
    if (memIds.length) {
      const id = memIds[memIds.length - 1];
      const mem = detachedNodes.get(id);
      let parent = mem.parentSelector ? document.querySelector(mem.parentSelector) : null;
      if (!parent) parent = document.body;
      const ok = await restoreFromBackup({ id, parentSelector: mem.parentSelector }, parent);
      if (!ok) { recordedOps.push(lastOp); operationCounter++; return; }
    } else {
      const result = await chrome.storage.local.get(['removedBackups']);
      let backups = result.removedBackups || [];
      if (backups.length > 0) {
        const backup = backups.pop();
        await chrome.storage.local.set({ removedBackups: backups });
        let parent = backup.parentSelector ? document.querySelector(backup.parentSelector) : null;
        if (!parent) parent = document.body;
        await restoreFromBackup(backup, parent);
      }
    }
  }

  updateRecordingCount();
  scheduleSyncRecordingState();
  console.log(`[撤回] 已撤回 ${lastOp.action}，当前 ${recordedOps.length} 个`);
}

// ---------- 标记删除模式 ----------
function toggleMarkDeleteMode(active) {
  if (active === undefined) {
    markDeleteMode = !markDeleteMode;
  } else {
    markDeleteMode = active;
  }
  const btn = document.getElementById('mark-delete-btn');
  if (markDeleteMode) {
    if (collectImageMode) toggleCollectImageMode(false);  // 互斥
    document.body.style.cursor = 'crosshair';
    if (btn) btn.style.background = '#ffdddd';
    document.addEventListener('click', markDeleteHandler, true);
  } else {
    document.body.style.cursor = '';
    if (btn) btn.style.background = 'white';
    document.removeEventListener('click', markDeleteHandler, true);
  }
}

function markDeleteHandler(event) {
  if (!markDeleteMode) return;
  const target = event.target;
  if (target.closest('#recording-indicator')) return;
  // 点击占位符 → 放行，交给恢复逻辑（不拦截、不记录删除）
  if (target.closest('.ad-placeholder')) return;
  event.preventDefault();
  event.stopPropagation();
  const selector = getUniqueSelector(target);
  addRecordedOp('remove', selector);
  target.style.outline = '3px solid #ff0000';
  setTimeout(async () => {
    await applyBlock(target, 'record');
    await checkAndBatchDeleteByClass(target);
  }, 300);
  console.log(`[录制] 记录删除: ${selector}`);
  // 单次操作：删一个后自动退出标记模式，回到普通录制
  toggleMarkDeleteMode(false);
}

// 同一 class 被删够次数后，批量删除页面所有同类（可恢复）
async function checkAndBatchDeleteByClass(target) {
  if (!target || !target.className || typeof target.className !== 'string') return;
  const classes = target.className.split(/\s+/).filter(c => c && !/^data-v-/.test(c) && !/^swiper/.test(c));
  for (const c of classes) {
    classDeleteCounts[c] = (classDeleteCounts[c] || 0) + 1;
    if (classDeleteCounts[c] === CLASS_DELETE_THRESHOLD) {
      let siblings;
      try {
        siblings = document.querySelectorAll('.' + CSS.escape(c));
      } catch (e) { continue; }
      let removed = 0;
      for (const s of siblings) {
        if (s.dataset.adHandled === 'true' || s.dataset.restored === 'true') continue;
        if (s.closest('#recording-indicator')) continue;
        await applyBlock(s, 'record');
        removed++;
      }
      console.log(`[录制] class "${c}" 已删 ${CLASS_DELETE_THRESHOLD} 次，批量删除 ${removed} 个同类`);
      // 记录批量删除操作，回放时按 class 删所有同类
      const exists = recordedOps.some(op => op.action === 'batchRemove' && op.classSelector === c);
      if (!exists) {
        recordedOps.push({
          id: 'op_' + (++operationCounter),
          action: 'batchRemove',
          classSelector: c,
          targetSelector: '.' + c,
          timestamp: Date.now()
        });
        scheduleSyncRecordingState();
        updateRecordingCount();
      }
    }
  }
}

// ---------- 图像角标采集模式 ----------
function toggleCollectImageMode(active) {
  if (active === undefined) collectImageMode = !collectImageMode;
  else collectImageMode = active;
  const btn = document.getElementById('collect-img-btn');
  if (collectImageMode) {
    if (markDeleteMode) toggleMarkDeleteMode(false);  // 互斥
    document.body.style.cursor = 'copy';
    if (btn) btn.style.background = '#cceeff';
    document.addEventListener('click', collectImageHandler, true);
    console.log('[采集] 点击页面上的广告角标图片即可采集');
  } else {
    document.body.style.cursor = '';
    if (btn) btn.style.background = 'white';
    document.removeEventListener('click', collectImageHandler, true);
  }
}

async function collectImageHandler(event) {
  if (!collectImageMode) return;
  const target = event.target;
  if (target.closest('#recording-indicator')) return;
  event.preventDefault();
  event.stopPropagation();

  // 找到目标或最近的 <img>
  let img = target.tagName === 'IMG' ? target : target.querySelector('img');
  if (!img) {
    console.warn('[采集] 该元素不是图片，请点击 <img> 角标');
    toggleCollectImageMode(false);  // 单次操作：点空也退出
    return;
  }
  const key = featureKey();
  // 1) 学习 class 特征（最可靠，如 gg-pic）
  const cls = (typeof img.className === 'string') ? img.className : '';
  const clsList = cls.split(/\s+/).filter(c => c && !/^data-v-/.test(c));
  const r0 = await chrome.storage.local.get(['adBadgeClassesByDomain']);
  const map0 = r0.adBadgeClassesByDomain || {};
  const classArr = map0[key] || [];
  for (const c of clsList) { if (!classArr.includes(c)) classArr.push(c); }
  map0[key] = classArr;
  await chrome.storage.local.set({ adBadgeClassesByDomain: map0 });
  adBadgeClasses = classArr;
  console.log('[采集] 已学习角标 class:', clsList.join(','), '（域名', key, '共', classArr.length, '个）');

  // 2) 学习图像指纹（data: 图能算，跨域图跳过）
  const hash = computeDHash(img);
  if (hash) {
    const r = await chrome.storage.local.get(['adImageHashesByDomain']);
    const map = r.adImageHashesByDomain || {};
    const arr = map[key] || [];
    if (!arr.includes(hash)) arr.push(hash);
    map[key] = arr;
    await chrome.storage.local.set({ adImageHashesByDomain: map });
    adImageHashes = arr;
    console.log('[采集] 已采集角标指纹（域名', key, '共', arr.length, '个）');
  }

  // 视觉反馈
  img.style.outline = '3px solid #00ccff';
  setTimeout(() => img.style.outline = '', 600);
  toggleCollectImageMode(false);

  // 立即扫描，验证能否识别（class 优先，其次图像指纹）
  let removed = 0;
  if (classArr.length) removed += await scanByBadgeClass();
  if (hash) removed += await scanByAdImage();
  alert('已学习广告角标特征：\nclass = ' + (clsList.join(', ') || '无') +
        '\n图像指纹 = ' + (hash ? '已记录' : '无法读取(跨域)') +
        '\n\n本次立即清理了 ' + removed + ' 个卡片');
}

// ---------- 恢复删除（通用，用于 popup 按钮） ----------
async function undoLastRemoved() {
  // 优先恢复内存中保留的节点（保留动态状态）
  const ids = Array.from(detachedNodes.keys());
  if (ids.length) {
    const id = ids[ids.length - 1];
    const mem = detachedNodes.get(id);
    let parent = mem.parentSelector ? document.querySelector(mem.parentSelector) : null;
    if (!parent) parent = document.body;
    await restoreFromBackup({ id, parentSelector: mem.parentSelector }, parent);
    return;
  }
  const result = await chrome.storage.local.get(['removedBackups']);
  const backups = result.removedBackups || [];
  if (backups.length === 0) {
    alert('没有可恢复的备份');
    return;
  }
  const backup = backups.pop();
  await chrome.storage.local.set({ removedBackups: backups });
  let parent = backup.parentSelector ? document.querySelector(backup.parentSelector) : null;
  if (!parent) parent = document.body;
  await restoreFromBackup(backup, parent);
}

// ---------- 点击监听（录制时） ----------
document.addEventListener('click', function(event) {
  if (!isRecording) return;
  if (markDeleteMode) return;
  const target = event.target;
  if (target.closest('#recording-indicator')) return;
  const selector = getUniqueSelector(target);
  const added = addRecordedOp('click', selector);
  if (added) {
    const orig = target.style.outline;
    target.style.outline = '3px solid #00ff00';
    setTimeout(() => target.style.outline = orig, 500);
    console.log(`[录制] 记录点击: ${selector}`);
  }
}, true);


// ---------- 消息监听 ----------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'startRecording') {
    startRecording();
    sendResponse({ success: true });
  } else if (message.type === 'stopRecording') {
    stopRecording();
    sendResponse({ success: true });
  } else if (message.type === 'undoLast') {
    undoLastRemoved();
    sendResponse({ success: true });
  } else if (message.type === 'scanNow') {
    scheduleScan();
    sendResponse({ success: true });
  } else if (message.type === 'getRecordingStatus') {
    sendResponse({ isRecording });
  } else if (message.type === 'setDhashDistance') {
    DHASH_DISTANCE = message.value;
    sendResponse({ success: true });
  } else if (message.type === 'refreshRules') {
    fetchMatchingRules().then(async (rules) => {
      currentPageRules = rules;
      await replayOperations();
      sendResponse({ success: true });
    });
    return true;
  } else if (message.type === 'toggleBlockMode') {
    // 切换拦截模式
    (async () => {
      const newMode = (blockMode === 'remove') ? 'hide' : 'remove';
      let converted = 0;
      if (newMode === 'hide') {
        // 切到隐藏型：直接删掉所有占位符，彻底清空位置（不恢复元素）
        converted = clearAllRemoved();
      } else {
        // 切到删除型：把已隐藏的元素转为删除（插占位符）
        converted = await convertHiddenToRemoved();
      }
      blockMode = newMode;
      await chrome.storage.local.set({ blockMode });
      sendResponse({ mode: blockMode, converted });
    })();
    return true;
  } else if (message.type === 'getBlockMode') {
    sendResponse({ mode: blockMode });
  }
  return true;
});

// 清空所有占位符（切到隐藏型时调用）——直接删占位符，位置留空
function clearAllRemoved() {
  const phs = document.querySelectorAll('.ad-placeholder');
  let n = 0;
  for (const ph of phs) {
    ph.remove();
    n++;
  }
  detachedNodes.clear();
  chrome.storage.local.set({ removedBackups: [] }).catch(() => {});
  console.log('[拦截模式] 已清空 ' + n + ' 个占位符');
  return n;
}

// 把已隐藏元素转为删除（插占位符）（切到删除型时调用）
async function convertHiddenToRemoved() {
  let n = 0;
  for (const [id, el] of Array.from(_hiddenEls)) {
    if (!el || !el.isConnected) { _hiddenEls.delete(id); continue; }
    el.style.removeProperty('display');
    delete el.dataset.adHidden;
    _hiddenEls.delete(id);
    await removeWithBackup(el, 'scan');
    n++;
  }
  console.log('[拦截模式] 已把 ' + n + ' 个隐藏元素转为删除');
  return n;
}

// ---------- 初始化 ----------
async function init() {
  // 幂等保护：防止 content script 被重复注入导致双份状态
  if (window.__adBlockerInited) {
    console.log('[广告拦截] 已初始化，跳过重复加载');
    return;
  }
  window.__adBlockerInited = true;
  // 读取拦截模式（remove / hide）
  try {
    const mr = await chrome.storage.local.get(['blockMode']);
    if (mr.blockMode === 'hide' || mr.blockMode === 'remove') blockMode = mr.blockMode;
  } catch (e) {}
  currentPageRules = await fetchMatchingRules();
  // 加载角标特征（class + 图像指纹）
  try {
    const r = await chrome.storage.local.get(['adImageHashesByDomain', 'adBadgeClassesByDomain', 'dhashDistance']);
    const key = featureKey();
    const domainHashes = (r.adImageHashesByDomain && r.adImageHashesByDomain[key]) || [];
    const defaultHashes = await loadDefaultBadgeHashes();
    adImageHashes = defaultHashes.concat(domainHashes);
    adBadgeClasses = (r.adBadgeClassesByDomain && r.adBadgeClassesByDomain[key]) || [];
    if (r.dhashDistance !== undefined) DHASH_DISTANCE = r.dhashDistance;
    console.log('[广告拦截] 域名', key, '默认角标指纹', defaultHashes.length, '个 + 域名采集', domainHashes.length, '个，角标class', adBadgeClasses.length, '个');
  } catch (e) {}
  await replayOperations();

  // 刷新后恢复录制状态（若 background 仍在录制）
  await restoreRecordingState();

  // 首次扫描延后 1200ms（与 1.6.0 一致，等页面初始化稳定后再清理）
  setTimeout(scheduleScan, 1200);

  const observer = new MutationObserver(() => {
    scheduleScan();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  console.log('[广告拦截] 已启动（事件委托恢复）');
}

if (document.readyState === 'complete') {
  init();
} else {
  window.addEventListener('load', init);
}
})();
