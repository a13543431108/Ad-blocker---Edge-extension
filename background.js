// ============================================================
// background.js - 后台服务（v1.7）
// ------------------------------------------------------------
// 职责：
//   - IndexedDB 规则存储（globalRules / siteRules）
//   - ABP 规则订阅解析（## 元素隐藏 / || 网络拦截 / @@ 例外 / $options 映射）
//   - FilterLists 全网规则搜索（含中文关键词翻译 + 同义词兜底 + 分页）
//   - DNR 动态规则生成与容错安装（分块 + 逐条回退，跳过非法规则）
//   - 录制状态管理、消息路由、规则去重与统计
// 性能优化：规则匹配缓存、全量规则内存缓存、正则缓存、DNR 增量更新、
//           智能选取（配额分配）、订阅去重、结果分页缓存
// ============================================================

let recordingStates = new Map();
const STORAGE_KEY = 'recordingState';

// ========== 域名工具 ==========
function getMainDomain(hostname) {
  const parts = hostname.split('.');
  if (parts.length >= 3) return parts.slice(-2).join('.');
  return hostname;
}

// ========== 缓存 ==========
let matchingRulesCache = new Map();
let cacheVersion = 0;
let allGlobalRulesCache = null;   // 全量通用规则内存缓存
const domainRegexCache = new Map(); // domain pattern -> RegExp
function invalidateCache() {
  cacheVersion++;
  matchingRulesCache.clear();
  allGlobalRulesCache = null;
  domainRegexCache.clear();
  console.log('[Cache] 已失效');
}

// ========== 特征核心词累计与放宽 ==========
const FEATURE_CONFIRM_THRESHOLD = 2;

// 从选择器提取核心词（甲方案：取最后一段，去掉修饰前缀，如 .ad-banner -> banner）
function extractCoreWord(selector) {
  const m = selector.match(/[.#]([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const parts = m[1].split(/[-_]/).filter(Boolean);
  if (!parts.length) return null;
  return parts[parts.length - 1].toLowerCase();
}

// 记录一次特征确认（保存通用规则时调用）
async function recordFeatureConfirmation(requiredElements) {
  if (!requiredElements || !requiredElements.length) return;
  const result = await chrome.storage.local.get(['featureCounts']);
  const counts = result.featureCounts || {};
  for (const sel of requiredElements) {
    const word = extractCoreWord(sel);
    if (word) counts[word] = (counts[word] || 0) + 1;
  }
  await chrome.storage.local.set({ featureCounts: counts });
  console.log('[特征] 累计计数:', counts);
}

// 获取已确认的核心词（达到阈值即放宽匹配）
async function getConfirmedFeatureWords() {
  const result = await chrome.storage.local.get(['featureCounts']);
  const counts = result.featureCounts || {};
  return Object.keys(counts).filter(w => counts[w] >= FEATURE_CONFIRM_THRESHOLD);
}

// ========== IndexedDB 管理 ==========
const DB_NAME = 'AdRulesDB';
const DB_VERSION = 1;
const GLOBAL_STORE = 'globalRules';
const SITE_STORE = 'siteRules';
let dbInstance = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (dbInstance) return resolve(dbInstance);
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(GLOBAL_STORE)) {
        const store = db.createObjectStore(GLOBAL_STORE, { keyPath: 'id' });
        store.createIndex('type', 'type', { unique: false });
        store.createIndex('domain', 'match.domains', { multiEntry: true });
      }
      if (!db.objectStoreNames.contains(SITE_STORE)) {
        const siteStore = db.createObjectStore(SITE_STORE, { keyPath: 'hostname' });
      }
    };
    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };
    request.onerror = (event) => reject(event.target.error);
  });
}

// ---------- 通用规则 CRUD ----------
async function saveGlobalRules(rulesArray) {
  if (!rulesArray || !rulesArray.length) return;
  const db = await openDB();
  const tx = db.transaction(GLOBAL_STORE, 'readwrite');
  const store = tx.objectStore(GLOBAL_STORE);
  for (const rule of rulesArray) {
    if (!rule.id) rule.id = 'rule_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    store.put(rule); // 同一事务内批量入队，不再逐条 await
  }
  await new Promise((resolve) => {
    tx.oncomplete = resolve;
    tx.onerror = (e) => console.error('保存规则失败', e);
  });
  invalidateCache();
  updateNetworkRules(); // 异步更新DNR
}

async function getAllGlobalRules() {
  if (allGlobalRulesCache) return allGlobalRulesCache; // 命中内存缓存，避免遍历 DB
  const db = await openDB();
  const tx = db.transaction(GLOBAL_STORE, 'readonly');
  const store = tx.objectStore(GLOBAL_STORE);
  const rules = await new Promise((resolve) => {
    const result = [];
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      if (cursor.result) {
        result.push(cursor.result.value);
        cursor.result.continue();
      } else resolve(result);
    };
    cursor.onerror = () => resolve(result);
  });
  allGlobalRulesCache = rules;
  return rules;
}

// [性能] 分页查询
async function getGlobalRulesPage(offset = 0, limit = 20) {
  const db = await openDB();
  const tx = db.transaction(GLOBAL_STORE, 'readonly');
  const store = tx.objectStore(GLOBAL_STORE);
  return new Promise((resolve) => {
    const result = [];
    let count = 0;
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      if (cursor.result) {
        count++;
        if (count > offset && count <= offset + limit) {
          result.push(cursor.result.value);
        }
        cursor.result.continue();
      } else {
        resolve({ total: count, rules: result });
      }
    };
    cursor.onerror = () => resolve({ total: 0, rules: [] });
  });
}

async function getGlobalRulesByType(type) {
  const db = await openDB();
  const tx = db.transaction(GLOBAL_STORE, 'readonly');
  const store = tx.objectStore(GLOBAL_STORE);
  const index = store.index('type');
  return new Promise((resolve) => {
    const result = [];
    const cursor = index.openCursor(IDBKeyRange.only(type));
    cursor.onsuccess = () => {
      if (cursor.result) {
        result.push(cursor.result.value);
        cursor.result.continue();
      } else resolve(result);
    };
    cursor.onerror = () => resolve(result);
  });
}

async function deleteGlobalRuleById(ruleId) {
  const db = await openDB();
  const tx = db.transaction(GLOBAL_STORE, 'readwrite');
  const store = tx.objectStore(GLOBAL_STORE);
  store.delete(ruleId);
  await new Promise((resolve) => { tx.oncomplete = resolve; });
  invalidateCache();
  updateNetworkRules();
}

async function clearGlobalRules() {
  const db = await openDB();
  const tx = db.transaction(GLOBAL_STORE, 'readwrite');
  const store = tx.objectStore(GLOBAL_STORE);
  store.clear();
  await new Promise((resolve) => { tx.oncomplete = resolve; });
  invalidateCache();
  updateNetworkRules();
}

// ---------- 站点规则 CRUD ----------
async function saveSiteRule(hostname, siteData) {
  const db = await openDB();
  const tx = db.transaction(SITE_STORE, 'readwrite');
  const store = tx.objectStore(SITE_STORE);
  await store.put({ hostname, ...siteData });
  await new Promise((resolve) => { tx.oncomplete = resolve; });
  invalidateCache();
}

async function getSiteRule(hostname) {
  const db = await openDB();
  const tx = db.transaction(SITE_STORE, 'readonly');
  const store = tx.objectStore(SITE_STORE);
  let result = await new Promise((resolve) => {
    const request = store.get(hostname);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
  if (result) return result;
  const mainDomain = getMainDomain(hostname);
  if (mainDomain !== hostname) {
    result = await new Promise((resolve) => {
      const request = store.get(mainDomain);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  }
  return result;
}

async function getAllSiteRules() {
  const db = await openDB();
  const tx = db.transaction(SITE_STORE, 'readonly');
  const store = tx.objectStore(SITE_STORE);
  return new Promise((resolve) => {
    const result = [];
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      if (cursor.result) {
        result.push(cursor.result.value);
        cursor.result.continue();
      } else resolve(result);
    };
    cursor.onerror = () => resolve(result);
  });
}

async function deleteSiteRuleByHost(hostname) {
  const db = await openDB();
  const tx = db.transaction(SITE_STORE, 'readwrite');
  const store = tx.objectStore(SITE_STORE);
  store.delete(hostname);
  await new Promise((resolve) => { tx.oncomplete = resolve; });
  invalidateCache();
}

async function clearSiteRules() {
  const db = await openDB();
  const tx = db.transaction(SITE_STORE, 'readwrite');
  const store = tx.objectStore(SITE_STORE);
  store.clear();
  await new Promise((resolve) => { tx.oncomplete = resolve; });
  invalidateCache();
}

// ========== 查询匹配当前域名的规则（带缓存） ==========
async function getRulesForHost(hostname, types) {
  const cacheKey = hostname + ':' + cacheVersion;
  let matched = matchingRulesCache.get(cacheKey);
  if (!matched) {
    const allGlobal = await getAllGlobalRules();
    matched = allGlobal.filter(rule => {
      if (!rule.match || !rule.match.domains || rule.match.domains.length === 0) {
        return true;
      }
      return rule.match.domains.some(pattern => {
        let regex = domainRegexCache.get(pattern);
        if (!regex) {
          regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
          domainRegexCache.set(pattern, regex);
        }
        return regex.test(hostname);
      });
    });
    matchingRulesCache.set(cacheKey, matched);
  }
  if (types && types.length) {
    return matched.filter(r => types.includes(r.type));
  }
  return matched;
}

// ========== 数据迁移 ==========
async function migrateFromStorage() {
  const result = await chrome.storage.local.get(['learnedRules']);
  const old = result.learnedRules || { globalRules: [] };
  if (old.globalRules && old.globalRules.length > 0) {
    await saveGlobalRules(old.globalRules);
  }
  for (const [key, val] of Object.entries(old)) {
    if (key === 'globalRules') continue;
    await saveSiteRule(key, val);
  }
  await chrome.storage.local.set({ migratedToIndexedDB: true });
  console.log('[迁移] 完成');
}

// ========== DNR 增量更新（带初始化） ==========
let currentDnrRuleIds = [];
let currentDnrRulesMap = new Map(); // id -> rule

// 初始化：从浏览器获取已存在的DNR规则
async function initDnrState() {
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    currentDnrRuleIds = rules.map(r => r.id);
    currentDnrRulesMap = new Map(rules.map(r => [r.id, r]));
    console.log(`[DNR] 已加载现有规则 ${currentDnrRuleIds.length} 条`);
  } catch (e) {
    console.warn('[DNR] 获取现有规则失败，将重置状态', e);
    currentDnrRuleIds = [];
    currentDnrRulesMap = new Map();
  }
}

// 规则价值评分：分越高越优先装进 DNR（上限 4900 条）
function scoreNetworkRule(r) {
  let score = 0;
  const m = r.match || {};
  // 例外（白名单）必须优先，否则会误杀正常内容
  if (r.exception) score += 100000;
  if (r.important) score += 500;
  if (m.urlPattern) {
    if (m.urlPattern.startsWith('||')) score += 200;
    if (m.urlPattern.endsWith('^')) score += 80;
    // 含路径的更精准
    if (m.urlPattern.includes('/')) score += 40;
    // 通配符越多越不精准
    const stars = (m.urlPattern.match(/\*/g) || []).length;
    score -= stars * 40;
    // 越短覆盖越广，略微加分（但不超过域名价值）
    score += Math.max(0, 40 - m.urlPattern.length);
  } else if (m.regexFilter) {
    score += 30;
  }
  // 有域名/资源类型限定的更精准
  if (r.condition && r.condition.initiatorDomains && r.condition.initiatorDomains.length) score += 30;
  if (r.condition && r.condition.resourceTypes && r.condition.resourceTypes.length) score += 10;
  return score;
}

async function updateNetworkRules() {
  const allRules = await getAllGlobalRules();
  const networkRules = allRules.filter(r => r.type === 'network' && r.match && (r.match.urlPattern || r.match.regexFilter));
  const MAX_DNR_RULES = 30000; // Chrome DNR 动态规则上限约 30000
  let rulesToApply = networkRules;
  if (networkRules.length > MAX_DNR_RULES) {
    // 配额分配：例外规则最多 EXC_QUOTA 条，其余名额给拦截规则
    const EXC_QUOTA = 1500;
    const exceptions = networkRules.filter(r => r.exception === true);
    const blocks = networkRules.filter(r => r.exception !== true);
    const excScored = exceptions.map(r => ({ r, s: scoreNetworkRule(r) })).sort((a, b) => b.s - a.s);
    const blkScored = blocks.map(r => ({ r, s: scoreNetworkRule(r) })).sort((a, b) => b.s - a.s);
    const excPicked = excScored.slice(0, EXC_QUOTA).map(x => x.r);
    const blkPicked = blkScored.slice(0, MAX_DNR_RULES - excPicked.length).map(x => x.r);
    rulesToApply = excPicked.concat(blkPicked);
    console.warn(`[DNR] 网络规则 ${networkRules.length} 条：例外 ${exceptions.length} 取 ${excPicked.length}，拦截 ${blocks.length} 取 ${blkPicked.length}`);
  }

  const newDnrMap = new Map();
  rulesToApply.forEach((r, idx) => {
    let baseCondition;
    if (r.match.regexFilter) {
      baseCondition = { regexFilter: r.match.regexFilter };
    } else if (r.match.urlPattern) {
      baseCondition = { urlFilter: r.match.urlPattern };
    } else {
      return;
    }
    const isAllow = r.exception === true;
    const condition = { ...baseCondition, ...(r.condition || {}) };
    if (!isAllow && !condition.resourceTypes && !condition.excludedResourceTypes) {
      condition.resourceTypes = ['script', 'image', 'xmlhttprequest', 'sub_frame', 'stylesheet', 'object'];
    }
    let priority = 1;
    if (isAllow) priority = 2;
    if (r.important) priority = 3;
    const dnrRule = {
      id: 1000 + idx,
      priority,
      action: { type: isAllow ? 'allow' : 'block' },
      condition
    };
    newDnrMap.set(dnrRule.id, dnrRule);
  });

  if (currentDnrRulesMap.size === 0 && currentDnrRuleIds.length === 0) {
    await initDnrState();
  }

  const newRules = Array.from(newDnrMap.values());

  // 全量重建：先清空旧规则，再逐条容错安装（跳过非法规则）
  const oldIds = currentDnrRuleIds.slice();
  let installed = [];

  // 1) 先移除所有旧规则
  try {
    if (oldIds.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: oldIds });
    }
  } catch (e) {
    console.warn('[DNR] 清除旧规则失败，尝试全清', e);
    try {
      const all = await chrome.declarativeNetRequest.getDynamicRules();
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: all.map(r => r.id) });
    } catch (e2) {}
  }

  // 2) 分块批量添加，块失败则逐条添加，自动跳过非法规则
  const CHUNK = 500;
  let added = 0, skipped = 0, consecutiveFail = 0;
  for (let i = 0; i < newRules.length; i += CHUNK) {
    if (consecutiveFail > 200) {
      console.warn('[DNR] 连续失败过多，可能已达浏览器上限，停止安装');
      break;
    }
    const chunk = newRules.slice(i, i + CHUNK);
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules: chunk });
      for (const r of chunk) installed.push(r.id);
      added += chunk.length;
      consecutiveFail = 0;
    } catch (e) {
      for (const rule of chunk) {
        try {
          await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
          installed.push(rule.id);
          added++;
          consecutiveFail = 0;
        } catch (e2) {
          skipped++;
          consecutiveFail++;
          if (consecutiveFail > 200) break;
        }
      }
    }
  }

  currentDnrRuleIds = installed;
  currentDnrRulesMap = new Map(installed.map(id => [id, newDnrMap.get(id)]));
  console.log(`[DNR] 安装完成: 成功 ${added} 条, 跳过非法 ${skipped} 条`);
}


// ========== 录制状态管理 ==========
async function saveRecordingStateToStorage() {
  const stateObj = {};
  for (const [tabId, state] of recordingStates) {
    stateObj[tabId] = state;
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: stateObj });
}

async function loadRecordingStateFromStorage() {
  const result = await chrome.storage.local.get([STORAGE_KEY]);
  const stateObj = result[STORAGE_KEY] || {};
  recordingStates.clear();
  for (const [tabId, state] of Object.entries(stateObj)) {
    recordingStates.set(parseInt(tabId), state);
  }
  console.log('[Background] 恢复录制状态，标签页数:', recordingStates.size);
}

function startRecordingForTab(tabId) {
  const state = { isRecording: true, recordedOps: [], operationCounter: 0 };
  recordingStates.set(tabId, state);
  saveRecordingStateToStorage();
  return state;
}

function stopRecordingForTab(tabId) {
  const state = recordingStates.get(tabId);
  if (state) {
    state.isRecording = false;
    saveRecordingStateToStorage();
    return state;
  }
  return null;
}

function getRecordingState(tabId) {
  return recordingStates.get(tabId) || { isRecording: false, recordedOps: [], operationCounter: 0 };
}

// ========== 通用规则确认 ==========
async function handleAskGlobalRule(operations, features, url) {
  if (!operations || operations.length === 0) return;
  const generatedRule = generateElemHideRule(operations);
  let extraMessage = generatedRule ? `\n同时生成元素隐藏规则: ${generatedRule.match.selector}` : '';

  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'showGlobalConfirm',
        operations,
        features,
        url,
        generatedRule
      }, (reply) => resolve(reply || null));
    });
    if (response && response.confirmed !== undefined) {
      if (response.confirmed) {
        const rule = {
          id: 'global_' + Date.now(),
          name: `通用规则 (${new Date().toLocaleDateString()})`,
          type: 'element',
          match: { requiredElements: features.requiredElements || [] },
          operations: operations
        };
        await saveGlobalRules([rule]);
        await recordFeatureConfirmation(rule.match.requiredElements);
        if (generatedRule) {
          generatedRule.id = 'gen_' + Date.now();
          await saveGlobalRules([generatedRule]);
        }
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icon.png',
          title: '✅ 已保存为通用规则',
          message: '规则将应用于所有匹配的网站。' + extraMessage
        });
      } else {
        const hostname = new URL(url).hostname;
        const site = await getSiteRule(hostname) || { operations: [] };
        site.operations = site.operations.concat(operations);
        await saveSiteRule(hostname, site);
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icon.png',
          title: '📋 已保存为站点规则',
          message: '规则仅适用于当前网站。'
        });
      }
      return;
    }
  } catch (e) {}

  // 通知fallback
  const notificationId = 'global_rule_confirm_' + Date.now();
  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icon.png',
    title: '广告学习拦截器',
    message: `已录制 ${operations.length} 个操作。是否设为“通用规则”？${extraMessage}`,
    buttons: [{ title: '是，设为通用' }, { title: '否，仅此网站' }],
    requireInteraction: true
  });

  const listener = async (notifId, btnIndex) => {
    if (notifId !== notificationId) return;
    chrome.notifications.clear(notificationId);
    chrome.notifications.onButtonClicked.removeListener(listener);
    if (btnIndex === 0) {
      const rule = {
        id: 'global_' + Date.now(),
        name: `通用规则 (${new Date().toLocaleDateString()})`,
        type: 'element',
        match: { requiredElements: features.requiredElements || [] },
        operations: operations
      };
      await saveGlobalRules([rule]);
      await recordFeatureConfirmation(rule.match.requiredElements);
      if (generatedRule) {
        generatedRule.id = 'gen_' + Date.now();
        await saveGlobalRules([generatedRule]);
      }
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: '✅ 已保存为通用规则',
        message: '规则将应用于所有匹配的网站。' + extraMessage
      });
    } else {
      const hostname = new URL(url).hostname;
      const site = await getSiteRule(hostname) || { operations: [] };
      site.operations = site.operations.concat(operations);
      await saveSiteRule(hostname, site);
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: '📋 已保存为站点规则',
        message: '规则仅适用于当前网站。'
      });
    }
  };
  chrome.notifications.onButtonClicked.addListener(listener);
  setTimeout(() => {
    chrome.notifications.clear(notificationId, () => {
      chrome.notifications.onButtonClicked.removeListener(listener);
    });
  }, 30000);
}

function generateElemHideRule(operations) {
  for (const op of operations) {
    if (op.action === 'remove') {
      const selector = op.targetSelector;
      if (selector.match(/^[.#][a-zA-Z0-9_-]+$/)) {
        return { type: 'elemhide', match: { selector: selector }, name: '自动生成元素隐藏' };
      }
    }
  }
  return null;
}

// ========== 订阅 ==========
// 判断元素选择器是否被浏览器原生支持（DNR/querySelector 可表达）
function isSupportedSelector(sel) {
  if (!sel) return false;
  // ABP 专有扩展伪类，浏览器无法解析
  const unsupported = [':-abp-', ':has(', ':matches-', ':contains(',
    ':style(', ':remove()', ':remove-attr', ':min-text-length',
    ':others', ':upward', ':watch-attr', ':xpath', ':if(', ':if-not('];
  for (const u of unsupported) {
    if (sel.includes(u)) return false;
  }
  return true;
}

// 判断正则是否合法且被 DNR(re2) 支持（re2 不支持环视/反向引用）
function isSupportedRegex(body) {
  if (!body) return false;
  if (/\\[1-9]/.test(body)) return false;   // 反向引用
  if (body.includes('(?=')) return false;    // 正向环视
  if (body.includes('(?!')) return false;    // 负向环视
  if (body.includes('(?<')) return false;    // 反向环视
  try {
    new RegExp(body);
    return true;
  } catch (e) {
    return false;
  }
}

// ABP 资源类型 -> DNR resourceTypes 映射
const RES_TYPE_MAP = {
  script: 'script', image: 'image', stylesheet: 'stylesheet', object: 'object',
  xmlhttprequest: 'xmlhttprequest', xhr: 'xmlhttprequest',
  subdocument: 'sub_frame', document: 'main_frame',
  media: 'media', font: 'font', websocket: 'websocket', ping: 'ping', other: 'other'
};
// 无法映射到 DNR 的选项：命中即整条跳过
const UNMAPPABLE_OPTIONS = ['csp', 'redirect', 'redirect-rule', 'removeparam',
  'queryprune', 'replace', 'popup', 'sitekey', 'genericblock', 'generichide',
  'elemhide', 'badfilter'];

// 解析 $options，映射为 DNR condition；含不可映射选项时返回 { ok: false }
function parseAbpOptions(optionsStr) {
  const condition = {};
  const resourceTypes = [];
  const excludedResourceTypes = [];
  const initiatorDomains = [];
  const excludedInitiatorDomains = [];
  let important = false;
  const parts = optionsStr.split(',').map(s => s.trim()).filter(s => s);
  for (let part of parts) {
    if (!part) continue;
    let negated = false;
    if (part.startsWith('~')) { negated = true; part = part.slice(1); }
    const eq = part.indexOf('=');
    const name = (eq === -1 ? part : part.slice(0, eq)).toLowerCase();
    const value = eq === -1 ? '' : part.slice(eq + 1);
    if (UNMAPPABLE_OPTIONS.includes(name)) return { ok: false };
    if (RES_TYPE_MAP[name]) {
      if (negated) excludedResourceTypes.push(RES_TYPE_MAP[name]);
      else resourceTypes.push(RES_TYPE_MAP[name]);
      continue;
    }
    if (name === 'third-party' || name === '3p') {
      condition.domainType = negated ? 'firstParty' : 'thirdParty';
      continue;
    }
    if (name === 'first-party' || name === '1p') {
      condition.domainType = negated ? 'thirdParty' : 'firstParty';
      continue;
    }
    if (name === 'domain') {
      const list = value.split('|').map(s => s.trim()).filter(s => s);
      for (const d of list) {
        if (d.startsWith('~')) excludedInitiatorDomains.push(d.slice(1));
        else initiatorDomains.push(d);
      }
      continue;
    }
    if (name === 'match-case') {
      condition.isUrlFilterCaseSensitive = true;
      continue;
    }
    if (name === 'important') {
      important = true;
      continue;
    }
    // 未知选项：保守起见整条跳过
    return { ok: false };
  }
  if (resourceTypes.length) condition.resourceTypes = resourceTypes;
  if (excludedResourceTypes.length) condition.excludedResourceTypes = excludedResourceTypes;
  if (initiatorDomains.length) condition.initiatorDomains = initiatorDomains;
  if (excludedInitiatorDomains.length) condition.excludedInitiatorDomains = excludedInitiatorDomains;
  return { ok: true, condition, important };
}

// ========== 订阅 ==========
// 规则唯一键：用于去重
function ruleKey(r) {
  if (!r || !r.type) return '';
  if (r.type === 'network') {
    const f = (r.match && (r.match.urlPattern || r.match.regexFilter)) || '';
    return (r.exception ? 'A:' : 'B:') + f;
  }
  if (r.type === 'elemhide') {
    const sel = (r.match && r.match.selector) || '';
    const dom = (r.match && r.match.domains) ? r.match.domains.join(',') : '';
    return 'H:' + dom + '|' + sel;
  }
  if (r.type === 'element') return 'E:' + (r.id || '');
  return '';
}


// ========== FilterLists 全网规则库 ==========
let filterListsCache = null;      // /lists 元数据缓存
let flSearchCache = null; // 搜索结果缓存（同关键词复用）
let filterListsFetchAt = 0;
const FILTERLISTS_TTL = 6 * 60 * 60 * 1000; // 缓存 6 小时
const FL_LANG = {
  37: '英语', 8: '法语', 47: '法语', 73: '日语', 83: '韩语', 179: '中文',
  32: '德语', 132: '俄语', 14: '俄语', 79: '俄语', 169: '俄语', 167: '乌克兰语',
  113: '荷兰语', 161: '土耳其语', 171: '越南语', 39: '西班牙语', 22: '西班牙语',
  127: '葡萄牙语', 71: '意大利语', 56: '希伯来语', 64: '印尼语', 106: '印尼语',
  155: '泰语', 31: '丹麦语', 44: '芬兰语', 114: '挪威语', 150: '瑞典语',
  36: '希腊语', 131: '罗马尼亚语', 15: '保加利亚语', 27: '捷克语', 141: '斯洛伐克语',
  96: '立陶宛语', 98: '拉脱维亚语', 142: '斯洛文尼亚语', 139: '塞尔维亚语',
  70: '冰岛语', 60: '匈牙利语', 42: '波斯语', 57: '印地语', 19: '印地语',
  53: '印地语', 103: '印地语', 111: '印地语', 123: '印地语', 152: '僧伽罗语',
  153: '尼泊尔语', 46: '挪威语', 80: '格陵兰语', 137: '萨米语', 12: '多语言'
};
// 中英同义词：中文搜索词 -> 一组英文同义词（任一命中即匹配）
const FL_SYNONYMS = {
  '中文': ['chinese', 'china', 'cn'], '中国': ['chinese', 'china', 'cn'],
  '大陆': ['chinese', 'china'], '简体': ['chinese', 'simplified'], '国内': ['chinese', 'china'],
  '广告': ['ad', 'ads', 'advert', 'advertising', 'adblock'], '拦截': ['block', 'blocker', 'filter'],
  '隐私': ['privacy', 'track', 'tracking', 'tracker'], '追踪': ['track', 'tracking', 'tracker'],
  '恶意': ['malware', 'malicious', 'badware', 'virus'], '钓鱼': ['phishing', 'phish', 'scam'],
  '弹窗': ['popup', 'pop-up', 'popunder', 'overlay'], '烦扰': ['annoyance', 'annoyances', 'annoying'],
  '挖矿': ['coin', 'crypto', 'mining', 'miner', 'cryptomin'], '社交': ['social', 'facebook', 'twitter'],
  '视频': ['video', 'youtube', 'twitch', 'stream'], '电影': ['video', 'movie', 'stream'],
  '安全': ['security', 'safe', 'threat'], '诈骗': ['scam', 'fraud', 'phishing'],
  '统计': ['analytic', 'analytics', 'counter', 'stats', 'telemetry'],
  '干扰': ['annoyance', 'nag', 'distraction'], '内容': ['content', 'element'],
  'hosts': ['hosts', 'host', 'domain'], '域名': ['domain', 'domains', 'host'],
  '儿童': ['adult', 'porn', 'nsfw'], '赌博': ['gambling', 'gamble', 'casino'],
  '日语': ['japanese', 'japan'], '日本': ['japanese', 'japan'],
  '韩语': ['korean', 'korea'], '韩国': ['korean', 'korea'],
  '德语': ['german', 'germany'], '德国': ['german', 'germany'],
  '法语': ['french', 'france'], '法国': ['french', 'france'],
  '俄语': ['russian', 'russia'], '俄罗斯': ['russian', 'russia'],
  '英语': ['english'], '西班牙语': ['spanish', 'spain'], '葡萄牙语': ['portuguese', 'brazil'],
  '意大利语': ['italian', 'italy'], '荷兰语': ['dutch', 'netherlands'], '土耳其语': ['turkish', 'turkey'],
  '越南语': ['vietnamese', 'vietnam'], '泰语': ['thai', 'thailand'], '印尼语': ['indonesian', 'indonesia'],
  '波兰语': ['polish', 'poland'], '繁体': ['traditional', 'chinese'], '台湾': ['chinese', 'taiwan'],
  'cookie': ['cookie', 'gdpr', 'consent'], '通知': ['notification', 'push'],
  '恶意软件': ['malware', 'badware'], '木马': ['trojan', 'malware'], '勒索': ['ransomware', 'ransom'],
  'b站': ['bilibili', 'chinese'], '哔哩哔哩': ['bilibili', 'chinese'],
  '百度': ['baidu', 'chinese'], '腾讯': ['tencent', 'qq', 'chinese'], '淘宝': ['taobao', 'chinese'],
  '苹果': ['apple', 'ios'], '安卓': ['android'], '微软': ['microsoft', 'windows']
};

// 中文关键词翻译为英文（失败时返回 null，由同义词兜底）
async function translateKeyword(kw) {
  // 纯英文/数字无需翻译
  if (!/[\u4e00-\u9fa5]/.test(kw)) return null;
  try {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&tl=en&dt=t&q=' + encodeURIComponent(kw);
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data) && Array.isArray(data[0])) {
      const text = data[0].map(seg => seg[0]).join('').trim().toLowerCase();
      return text || null;
    }
  } catch (e) {
    console.warn('[翻译] 失败，回退同义词:', e.message);
  }
  return null;
}

async function fetchFilterListsMeta() {
  if (filterListsCache && (Date.now() - filterListsFetchAt) < FILTERLISTS_TTL) {
    return filterListsCache;
  }
  const res = await fetch('https://api.filterlists.com/lists', { cache: 'no-store' });
  if (!res.ok) throw new Error('FilterLists HTTP ' + res.status);
  const data = await res.json();
  filterListsCache = Array.isArray(data) ? data : (data.lists || []);
  filterListsFetchAt = Date.now();
  console.log('[FilterLists] 已加载', filterListsCache.length, '个列表元数据');
  return filterListsCache;
}

async function fetchFilterListDetail(id) {
  try {
    const res = await fetch('https://api.filterlists.com/lists/' + id, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// 从列表详情里取出可直接下载的原始文本订阅链接
function pickSourceUrl(detail) {
  if (!detail || !detail.viewUrls || !detail.viewUrls.length) return null;
  const urls = detail.viewUrls.slice().sort((a, b) => (a.primariness || 9) - (b.primariness || 9));
  for (const v of urls) {
    const u = v.url || '';
    if (!u) continue;
    if (/\.(txt|text|list)(\?|$)/i.test(u)) return u;
    if (u.includes('raw.githubusercontent.com')) return u;
    if (u.endsWith('.json') || u.includes('filterlists.com')) continue;
    return u;
  }
  return null;
}

async function subscribeFromUrl(initialUrl, callback) {
  // 只用用户指定的 URL，不再回退到 EasyList（避免选了中文列表却订阅了 EasyList）
  const uniqueUrls = [initialUrl];
  let lastError = '';
  for (const url of uniqueUrls) {
    try {
      console.log(`[订阅] 尝试获取: ${url}`);
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) { lastError = `HTTP ${response.status}`; continue; }
      const text = await response.text();
      if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) { lastError = '返回的不是规则文本'; continue; }

      const lines = text.split('\n');
      const newRules = [];
      let elemHideCount = 0, networkCount = 0, skippedCount = 0;

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('!') || line.startsWith('[')) continue;

        // ---- 元素隐藏规则 ## ----
        if (line.includes('##')) {
          if (line.includes('#@#')) { skippedCount++; continue; }
          const idx = line.indexOf('##');
          const domainPart = line.substring(0, idx).trim();
          const selectorPart = line.substring(idx + 2).trim();
          if (!isSupportedSelector(selectorPart)) { skippedCount++; continue; }
          if (selectorPart) {
            const domains = domainPart ? domainPart.split(',').map(d => d.trim()).filter(d => d) : [];
            const rule = {
              type: 'elemhide',
              match: { selector: selectorPart },
              name: `订阅元素隐藏 ${elemHideCount + 1}`
            };
            if (domains.length > 0) rule.match.domains = domains;
            newRules.push(rule);
            elemHideCount++;
          } else {
            skippedCount++;
          }
          continue;
        }

        // ---- 例外规则 @@||... ----
        if (line.startsWith('@@')) {
          let filter = line.substring(2);
          let options = "";
          const dollarIdx = filter.indexOf("$");
          if (dollarIdx !== -1) { options = filter.substring(dollarIdx + 1); filter = filter.substring(0, dollarIdx); }
          filter = filter.trim();
          if (filter.startsWith('||') || filter.startsWith('|')) {
            const parsed = options ? parseAbpOptions(options) : { ok: true, condition: {}, important: false };
            if (!parsed.ok) { skippedCount++; continue; }
            const rule = {
              type: 'network',
              match: { urlPattern: filter },
              exception: true,
              name: `订阅例外规则 ${networkCount + 1}`
            };
            if (Object.keys(parsed.condition).length) rule.condition = parsed.condition;
            if (parsed.important) rule.important = true;
            newRules.push(rule);
            networkCount++;
          } else {
            skippedCount++;
          }
          continue;
        }

        // ---- 正则过滤规则 /regex/ ----
        if (line.startsWith('/') && line.endsWith('/') && line.length > 2) {
          let filter = line;
          let options = "";
          const dollarIdx = filter.indexOf("$");
          if (dollarIdx !== -1) { options = filter.substring(dollarIdx + 1); filter = filter.substring(0, dollarIdx); }
          const body = filter.slice(1, -1);
          if (!isSupportedRegex(body)) { skippedCount++; continue; }
          const parsed = options ? parseAbpOptions(options) : { ok: true, condition: {}, important: false };
          if (!parsed.ok) { skippedCount++; continue; }
          const rule = {
            type: 'network',
            match: { regexFilter: body },
            name: `订阅正则规则 ${networkCount + 1}`
          };
          if (Object.keys(parsed.condition).length) rule.condition = parsed.condition;
          if (parsed.important) rule.important = true;
          newRules.push(rule);
          networkCount++;
          continue;
        }

        // ---- 网络规则 || | ----
        if (line.startsWith('||') || line.startsWith('|')) {
          let filter = line;
          let options = "";
          const dollarIdx = filter.indexOf("$");
          if (dollarIdx !== -1) { options = filter.substring(dollarIdx + 1); filter = filter.substring(0, dollarIdx); }
          filter = filter.trim();
          if (filter) {
            const parsed = options ? parseAbpOptions(options) : { ok: true, condition: {}, important: false };
            if (!parsed.ok) { skippedCount++; continue; }
            const rule = {
              type: 'network',
              match: { urlPattern: filter },
              name: `订阅网络规则 ${networkCount + 1}`
            };
            if (Object.keys(parsed.condition).length) rule.condition = parsed.condition;
            if (parsed.important) rule.important = true;
            newRules.push(rule);
            networkCount++;
          } else {
            skippedCount++;
          }
          continue;
        }

        // ---- 其它未知格式（hosts 等）跳过 ----
        skippedCount++;
      }

      console.log(`[订阅] 解析完成: 网络 ${networkCount} 条, 隐藏 ${elemHideCount} 条, 跳过 ${skippedCount} 条`);

      if (newRules.length === 0) {
        lastError = `从 ${url} 未解析出规则`;
        continue;
      }

      // 订阅时全量去重：既去重新规则，也清理历史遗留的重复
      const existing = await getAllGlobalRules();
      const seen = new Set();
      const cleanedExisting = [];
      let removedExisting = 0;
      for (const r of existing) {
        const k = ruleKey(r);
        if (k && seen.has(k)) { removedExisting++; continue; }
        if (k) seen.add(k);
        cleanedExisting.push(r);
      }
      const uniqueNew = [];
      let dupNew = 0;
      for (const r of newRules) {
        const k = ruleKey(r);
        if (k && seen.has(k)) { dupNew++; continue; }
        if (k) seen.add(k);
        uniqueNew.push(r);
      }
      const dup = removedExisting + dupNew;
      if (dup > 0) console.log(`[订阅] 去重：清理历史重复 ${removedExisting} 条，跳过新重复 ${dupNew} 条`);

      if (uniqueNew.length === 0) {
        // 新规则全重复：若历史有重复仍需重写清理
        if (removedExisting > 0) {
          await clearGlobalRules();
          await saveGlobalRules(cleanedExisting);
        }
        callback({ success: true, count: 0, skipped: skippedCount, dup });
        return;
      }

      if (removedExisting > 0) {
        // 历史库有重复：整体重写（去重后的旧规则 + 新规则）
        await clearGlobalRules();
        await saveGlobalRules(cleanedExisting.concat(uniqueNew));
      } else {
        await saveGlobalRules(uniqueNew);
      }

      chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, { type: 'refreshRules' }).catch(() => {});
        }
      });

      callback({ success: true, count: uniqueNew.length, skipped: skippedCount, dup });
      return;
    } catch (e) {
      console.warn(`[订阅] ${url} 失败:`, e);
      lastError = e.message;
    }
  }
  callback({ success: false, error: `所有尝试均失败: ${lastError}` });
}


// ========== 统计（优化：使用 count 而不是遍历） ==========
async function getRuleStats() {
  const db = await openDB();
  const tx = db.transaction([GLOBAL_STORE, SITE_STORE], 'readonly');
  const globalStore = tx.objectStore(GLOBAL_STORE);
  const siteStore = tx.objectStore(SITE_STORE);
  
  const globalCount = await new Promise((resolve) => {
    const request = globalStore.count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(0);
  });
  
  // 站点规则数量和操作数
  let siteCount = 0;
  let opCount = 0;
  const siteCursor = siteStore.openCursor();
  await new Promise((resolve) => {
    siteCursor.onsuccess = () => {
      if (siteCursor.result) {
        siteCount++;
        const site = siteCursor.result.value;
        if (site.operations) opCount += site.operations.length;
        siteCursor.result.continue();
      } else {
        resolve();
      }
    };
    siteCursor.onerror = () => resolve();
  });
  
  return { globalCount, siteCount, opCount };
}

// ========== 消息监听 ==========
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;

  // 录制相关
  if (message.type === 'startRecording') {
    startRecordingForTab(tabId);
    sendResponse({ success: true });
    return true;
  } else if (message.type === 'stopRecording') {
    // 优先用消息里携带的完整操作（避免异步同步延迟导致丢失）
    const ops = (message.operations && message.operations.length)
      ? message.operations
      : (getRecordingState(tabId).recordedOps || []);
    stopRecordingForTab(tabId);
    if (ops && ops.length > 0) {
      handleAskGlobalRule(ops, message.features || {}, message.url || '');
    }
    sendResponse({ success: true });
    return true;
  } else if (message.type === 'updateRecordingOps') {
    const state = recordingStates.get(tabId);
    if (state) {
      state.recordedOps = message.recordedOps;
      state.operationCounter = message.operationCounter;
      saveRecordingStateToStorage();
    }
    sendResponse({ success: true });
    return true;
  } else if (message.type === 'getRecordingState') {
    const state = getRecordingState(tabId);
    sendResponse(state);
    return true;
  } else if (message.type === 'clearRecordingState') {
    recordingStates.delete(tabId);
    saveRecordingStateToStorage();
    sendResponse({ success: true });
    return true;
  }

  // -------- 规则查询 --------
  if (message.type === 'getMatchingRules') {
    const hostname = message.hostname || (sender.tab && new URL(sender.tab.url).hostname) || '';
    // content 只用 elemhide/element，network 由 DNR 处理，无需下发
    Promise.all([getRulesForHost(hostname, ['elemhide', 'element']), getConfirmedFeatureWords()])
      .then(([rules, confirmedWords]) => {
        sendResponse({ rules, confirmedWords });
      }).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (message.type === 'getAllGlobalRules') {
    getAllGlobalRules().then(rules => {
      sendResponse({ rules });
    }).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (message.type === 'getGlobalRulesPage') {
    const offset = message.offset || 0;
    const limit = message.limit || 20;
    getGlobalRulesPage(offset, limit).then(({ total, rules }) => {
      sendResponse({ total, rules });
    }).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (message.type === 'getSiteRule') {
    getSiteRule(message.hostname).then(siteRule => {
      sendResponse({ siteRule });
    }).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (message.type === 'getRuleStats') {
    getRuleStats().then(stats => {
      sendResponse(stats);
    }).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // -------- 规则修改 --------
  if (message.type === 'deleteGlobalRule') {
    deleteGlobalRuleById(message.ruleId).then(() => {
      sendResponse({ success: true });
    }).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (message.type === 'deleteSiteRule') {
    deleteSiteRuleByHost(message.hostname).then(() => {
      sendResponse({ success: true });
    }).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (message.type === 'clearAllRules') {
    Promise.all([clearGlobalRules(), clearSiteRules()]).then(() => {
      sendResponse({ success: true });
    }).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // -------- 导入/导出 --------
  if (message.type === 'importRules') {
    const { globalRules, siteRules } = message.data;
    const promises = [];
    if (globalRules && globalRules.length) {
      promises.push(saveGlobalRules(globalRules));
    }
    if (siteRules) {
      for (const [host, data] of Object.entries(siteRules)) {
        promises.push(saveSiteRule(host, data));
      }
    }
    Promise.all(promises).then(() => {
      sendResponse({ success: true });
    }).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'exportRules') {
    Promise.all([getAllGlobalRules(), getAllSiteRules()]).then(([global, sites]) => {
      const siteObj = {};
      for (const site of sites) {
        const { hostname, ...rest } = site;
        siteObj[hostname] = rest;
      }
      sendResponse({
        globalRules: global,
        siteRules: siteObj
      });
    }).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // -------- 订阅 --------
  if (message.type === 'subscribeRules') {
    subscribeFromUrl(message.url, (response) => {
      sendResponse(response);
    });
    return true;
  }

  // -------- 强制更新网络规则 --------
  if (message.type === 'updateNetworkRules') {
    updateNetworkRules().then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.type === 'dedupeAllRules') {
    (async () => {
      const all = await getAllGlobalRules();
      const seen = new Set();
      const keep = [];
      let removed = 0;
      for (const r of all) {
        const k = ruleKey(r);
        if (k && seen.has(k)) { removed++; continue; }
        if (k) seen.add(k);
        keep.push(r);
      }
      if (removed > 0) {
        await clearGlobalRules();
        await saveGlobalRules(keep);
      }
      sendResponse({ total: all.length, kept: keep.length, removed });
    })().catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (message.type === 'searchFilterLists') {
    (async () => {
      const meta = await fetchFilterListsMeta();
      const kw = (message.keyword || '').trim().toLowerCase();
      const offset = message.offset || 0;
      const limit = message.limit || 30;
      let matched;
      // 命中缓存：同关键词同元数据版本，复用上次过滤结果
      if (flSearchCache && flSearchCache.kw === kw) {
        matched = flSearchCache.lists;
      } else {
        matched = meta;
        if (kw) {
          const tokens = kw.split(/\s+/).filter(Boolean);
          const tokenCandidates = await Promise.all(tokens.map(async tok => {
            if (!/[\u4e00-\u9fa5]/.test(tok)) return [tok];
            const cands = [];
            const translated = await translateKeyword(tok);
            if (translated) translated.split(/\s+/).forEach(w => cands.push(w));
            if (FL_SYNONYMS[tok]) FL_SYNONYMS[tok].forEach(w => cands.push(w));
            if (!cands.length) cands.push(tok);
            return [...new Set(cands)];
          }));
          matched = meta.filter(l => {
            const langNames = (l.languageIds || []).map(id => FL_LANG[id]).filter(Boolean).join(' ');
            const hay = (l.name + ' ' + (l.description || '') + ' ' + langNames).toLowerCase();
            return tokenCandidates.every(cands => cands.some(c => hay.includes(c)));
          });
        }
        flSearchCache = { kw, lists: matched };
      }
      const page = matched.slice(offset, offset + limit).map(l => ({
        id: l.id,
        name: l.name || ('列表 #' + l.id),
        description: l.description || '',
        languages: (l.languageIds || []).map(id => FL_LANG[id]).filter(Boolean)
      }));
      sendResponse({ success: true, total: matched.length, offset, lists: page, hasMore: offset + limit < matched.length });
    })().catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'resolveFilterListUrl') {
    (async () => {
      const d = await fetchFilterListDetail(message.id);
      const url = pickSourceUrl(d);
      sendResponse({ success: !!url, url: url || null });
    })().catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'getDiagnostics') {
    (async () => {
      const allRules = await getAllGlobalRules();
      const net = allRules.filter(r => r.type === 'network').length;
      const hide = allRules.filter(r => r.type === 'elemhide').length;
      const elem = allRules.filter(r => r.type === 'element').length;
      let dnrCount = 0;
      try {
        const dnr = await chrome.declarativeNetRequest.getDynamicRules();
        dnrCount = dnr.length;
      } catch (e) {}
      const hostname = message.hostname || '';
      let matchHide = 0, matchElem = 0;
      if (hostname) {
        const matched = await getRulesForHost(hostname, ['elemhide', 'element']);
        matchHide = matched.filter(r => r.type === 'elemhide').length;
        matchElem = matched.filter(r => r.type === 'element').length;
      }
      sendResponse({ total: allRules.length, net, hide, elem, dnrCount, matchHide, matchElem });
    })().catch(e => sendResponse({ error: e.message }));
    return true;
  }

  return false;
});

// ========== 标签页移除 ==========
chrome.tabs.onRemoved.addListener((tabId) => {
  recordingStates.delete(tabId);
  saveRecordingStateToStorage();
});

// ========== 启动和安装 ==========
chrome.runtime.onStartup.addListener(async () => {
  await loadRecordingStateFromStorage();
  await initDnrState(); // 初始化DNR状态
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await loadRecordingStateFromStorage();
  if (details.reason === 'install') {
    await chrome.storage.local.set({ removedBackups: [] });
  }
  const result = await chrome.storage.local.get(['migratedToIndexedDB']);
  if (!result.migratedToIndexedDB) {
    await migrateFromStorage();
    await chrome.storage.local.set({ migratedToIndexedDB: true });
  }
  await initDnrState(); // 初始化DNR状态
  await updateNetworkRules();
});






























