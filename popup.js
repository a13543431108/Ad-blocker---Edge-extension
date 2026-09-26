// ============================================================
// popup.js - 弹出窗口逻辑（v1.7）
// ------------------------------------------------------------
// 职责：
//   - 展示统计（网站规则 / 通用规则 / 操作总数）
//   - 录制控制、立即扫描
//   - 规则管理：导出 / 导入 / 清空 / 诊断 / 清理重复
//   - 订阅规则：内置列表搜索 + FilterLists 全网搜索（翻译 + 分页 + 懒加载）
// 性能优化：分页查询、搜索结果缓存、点击订阅时才解析列表地址
// ============================================================

const statusMsg = document.getElementById('statusMsg');
const statSites = document.getElementById('statSites');
const statGlobal = document.getElementById('statGlobal');
const statOps = document.getElementById('statOps');
const globalRuleList = document.getElementById('globalRuleList');
const siteRuleList = document.getElementById('siteRuleList');
const recordHint = document.getElementById('recordHint');

const MAX_GLOBAL_RULES_DISPLAY = 20;

function getMainDomain(hostname) {
  const parts = hostname.split('.');
  if (parts.length >= 3) return parts.slice(-2).join('.');
  return hostname;
}

function setStatus(msg, type = '') {
  statusMsg.textContent = msg;
  statusMsg.className = 'status' + (type ? ' ' + type : '');
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendBackground(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, resolve);
  });
}

async function getMatchingRules(hostname) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'getMatchingRules', hostname }, (response) => {
      resolve(response && response.rules ? response.rules : []);
    });
  });
}

// ---------- 获取录制状态 ----------
async function updateRecordingStatus() {
  try {
    const state = await sendBackground({ type: 'getRecordingState' });
    if (state && state.isRecording) {
      document.getElementById('btnStartRecord').disabled = true;
      setStatus('⏺️ 录制中...', 'success');
      recordHint.textContent = `已记录 ${state.recordedOps.length} 个操作（请在页面指示器上停止或撤回）`;
    } else {
      document.getElementById('btnStartRecord').disabled = false;
      if (!statusMsg.textContent.includes('录制中')) {
        setStatus('就绪');
        recordHint.textContent = '';
      }
    }
  } catch (e) {
    console.error('获取录制状态失败', e);
    document.getElementById('btnStartRecord').disabled = false;
  }
}

// ---------- 更新 UI ----------
async function updateUI() {
  // 版本号从 manifest 读取
  const vb = document.getElementById('versionBadge');
  if (vb && chrome.runtime && chrome.runtime.getManifest) {
    vb.textContent = 'v' + chrome.runtime.getManifest().version;
  }
  // 统计数据（使用优化后的接口）
  const stats = await sendBackground({ type: 'getRuleStats' });
  if (stats && !stats.error) {
    statSites.textContent = stats.siteCount;
    statGlobal.textContent = stats.globalCount;
    statOps.textContent = stats.opCount;
  }

  // [性能] 分页获取通用规则（只取最后20条）
  const totalGlobal = stats ? stats.globalCount : 0;
  const offset = Math.max(0, totalGlobal - MAX_GLOBAL_RULES_DISPLAY);
  const pageResp = await sendBackground({ type: 'getGlobalRulesPage', offset, limit: MAX_GLOBAL_RULES_DISPLAY });
  const globalRules = pageResp.rules || [];
  const totalCount = pageResp.total || 0;

  if (totalCount === 0) {
    globalRuleList.innerHTML = '<div style="color:#999;text-align:center;padding:8px 0;">暂无通用规则</div>';
  } else {
    const displayRules = globalRules;
    const hiddenCount = totalCount - displayRules.length;
    let html = '';
    if (hiddenCount > 0) {
      html += `<div style="font-size:10px;color:#888;padding:4px 0;border-bottom:1px dashed #ccc;">共 ${totalCount} 条，仅显示最近 ${displayRules.length} 条</div>`;
    }
    for (const rule of displayRules) {
      let typeInfo = rule.type || 'element';
      let matchInfo = '';
      if (rule.match) {
        if (rule.match.requiredElements) matchInfo = '元素: ' + rule.match.requiredElements.join(',');
        else if (rule.match.selector) matchInfo = '隐藏: ' + rule.match.selector;
        else if (rule.match.urlPattern) matchInfo = 'URL: ' + rule.match.urlPattern;
        else if (rule.match.regexFilter) matchInfo = '正则: ' + rule.match.regexFilter;
        else if (rule.match.domains) matchInfo = '域名: ' + rule.match.domains.join(',');
      }
      html += `
        <div class="rule-item">
          <span>${rule.name || '未命名'} <span style="font-size:9px;color:#888;">[${typeInfo}]</span></span>
          <span style="font-size:10px;color:#888;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${matchInfo}</span>
          <span class="rule-delete" data-ruleid="${rule.id}">✕</span>
        </div>
      `;
    }
    if (hiddenCount > 0) {
      html += `<div style="font-size:10px;color:#999;text-align:center;padding:4px 0;">（还有 ${hiddenCount} 条未显示，可导出查看全部）</div>`;
    }
    globalRuleList.innerHTML = html;

    globalRuleList.querySelectorAll('.rule-delete').forEach(el => {
      el.addEventListener('click', async function() {
        const id = this.dataset.ruleid;
        if (confirm('删除此通用规则？')) {
          const resp = await sendBackground({ type: 'deleteGlobalRule', ruleId: id });
          if (resp && resp.success) {
            setStatus('已删除通用规则', 'success');
            updateUI();
          } else {
            setStatus('删除失败', 'error');
          }
        }
      });
    });
  }

  // -------- 当前网站规则（专属 + 匹配通用） --------
  const tab = await getActiveTab();
  let currentHost = '';
  if (tab && tab.url) {
    try {
      currentHost = new URL(tab.url).hostname;
    } catch (e) {}
  }

  if (currentHost) {
    const siteResp = await sendBackground({ type: 'getSiteRule', hostname: currentHost });
    const siteData = siteResp.siteRule;
    const siteOpCount = (siteData && siteData.operations) ? siteData.operations.length : 0;

    const matchingRules = await getMatchingRules(currentHost);
    const elemHideCount = matchingRules.filter(r => r.type === 'elemhide').length;
    const elementCount = matchingRules.filter(r => r.type === 'element').length;
    const networkCount = matchingRules.filter(r => r.type === 'network').length;
    const totalMatchCount = matchingRules.length;

    let html = `<div style="margin-bottom:6px;font-weight:500;color:#333;">当前网站规则</div>`;

    if (siteOpCount > 0) {
      html += `<div style="font-size:12px;color:#555;margin-bottom:4px;">📌 专属规则（仅本站）: <strong>${siteOpCount}</strong> 个操作</div>`;
      const opsToShow = siteData.operations.slice(0, 5);
      for (const op of opsToShow) {
        html += `<div class="rule-item" style="font-size:10px;color:#555;padding-left:12px;">${op.action}: ${op.targetSelector}</div>`;
      }
      if (siteData.operations.length > 5) {
        html += `<div style="font-size:10px;color:#999;padding-left:12px;">... 还有 ${siteData.operations.length - 5} 条</div>`;
      }
      html += `<div style="text-align:right;margin-top:4px;margin-bottom:8px;"><span class="rule-delete" data-site="${currentHost}">删除此站点规则</span></div>`;
    } else {
      html += `<div style="font-size:12px;color:#777;margin-bottom:8px;">📌 专属规则：无</div>`;
    }

    if (totalMatchCount > 0) {
      html += `<div style="font-size:12px;color:#555;border-top:1px dashed #ddd;padding-top:6px;">🌐 匹配的通用规则：<strong>${totalMatchCount}</strong> 条</div>`;
      html += `<div style="font-size:11px;color:#888;padding-left:4px;">`;
      if (elemHideCount > 0) html += `元素隐藏 ${elemHideCount} 条；`;
      if (elementCount > 0) html += `操作规则 ${elementCount} 条；`;
      if (networkCount > 0) html += `网络拦截 ${networkCount} 条；`;
      html += `</div>`;
    } else {
      html += `<div style="font-size:12px;color:#777;border-top:1px dashed #ddd;padding-top:6px;">🌐 匹配的通用规则：无</div>`;
    }

    siteRuleList.innerHTML = html;
    const deleteBtn = siteRuleList.querySelector('.rule-delete[data-site]');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async function() {
        const host = this.dataset.site;
        if (confirm(`删除 ${host} 的所有专属规则？`)) {
          const resp = await sendBackground({ type: 'deleteSiteRule', hostname: host });
          if (resp && resp.success) {
            setStatus('已删除站点规则', 'success');
            updateUI();
          }
        }
      });
    }
  } else {
    siteRuleList.innerHTML = '<div style="color:#999;text-align:center;padding:8px 0;">无法获取当前网站</div>';
  }

  await updateRecordingStatus();
}

// ---------- 导出 ----------
async function exportRules() {
  const resp = await sendBackground({ type: 'exportRules' });
  if (resp && !resp.error) {
    const data = {
      version: '1.3',
      exportDate: new Date().toISOString(),
      rules: {
        globalRules: resp.globalRules,
        ...resp.siteRules
      }
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ad-rules-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`导出成功 (${Object.keys(data.rules).length} 个规则)`, 'success');
  } else {
    setStatus('导出失败: ' + (resp?.error || '未知错误'), 'error');
  }
}

// ---------- 导入 ----------
async function importRules(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.rules || typeof data.rules !== 'object') {
      throw new Error('无效的规则格式');
    }
    const importData = { globalRules: [], siteRules: {} };
    if (data.rules.globalRules && Array.isArray(data.rules.globalRules)) {
      importData.globalRules = data.rules.globalRules;
    }
    for (const [key, val] of Object.entries(data.rules)) {
      if (key === 'globalRules') continue;
      importData.siteRules[key] = val;
    }
    const resp = await sendBackground({ type: 'importRules', data: importData });
    if (resp && resp.success) {
      setStatus(`导入成功！共 ${importData.globalRules.length} 条通用规则，${Object.keys(importData.siteRules).length} 个站点规则`, 'success');
      updateUI();
    } else {
      setStatus('导入失败: ' + (resp?.error || '未知错误'), 'error');
    }
  } catch (e) {
    setStatus('导入失败: ' + e.message, 'error');
  }
}

// ---------- 发送消息到 Tab ----------
async function sendToTab(message) {
  const tab = await getActiveTab();
  if (!tab) {
    setStatus('错误: 没有活动标签页', 'error');
    return false;
  }
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
    setStatus('错误: 此页面不支持扩展操作', 'error');
    return false;
  }
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tab.id, message),
      new Promise((_, reject) => setTimeout(() => reject(new Error('超时')), 2000))
    ]);
    if (response && response.success !== undefined) {
      return true;
    }
    return false;
  } catch (e) {
    console.warn('发送消息失败', e);
    return false;
  }
}

// ---------- 订阅规则列表 ----------
const SUBSCRIBE_LISTS = [
  { url: 'https://easylist.to/easylist/easylist.txt', name: 'EasyList（国际通用）', tags: '国际 英文 通用 adsense doubleclick google 基础', desc: '最主流的国际广告过滤列表，拦截 Google AdSense、DoubleClick 等国际广告网络。适合英文网站。' },
  { url: 'https://easylist-downloads.adblockplus.org/easylistchina.txt', name: 'EasyList China（中国）', tags: '中国 中文 国内 广告', desc: 'EasyList 官方中文补充列表，针对国内网站广告。与 EasyList 配合使用效果最佳。' },
  { url: 'https://raw.githubusercontent.com/cjx82630/cjxlist/master/cjx-annoyance.txt', name: 'CJX 国内反打扰', tags: '中国 中文 国内 反打扰 弹窗 悬浮 推广', desc: '国内知名反打扰列表，屏蔽悬浮窗、弹窗、推广链接、伪装广告等。强烈推荐中文用户。' },
  { url: 'https://filters.adtidy.org/extension/chromium/filters/224.txt', name: 'AdGuard 中文过滤', tags: '中国 中文 国内 adguard', desc: 'AdGuard 官方中文过滤规则，覆盖面广，含大量国内站点元素隐藏规则。' },
  { url: 'https://easylist-downloads.adblockplus.org/easyprivacy.txt', name: 'EasyPrivacy（隐私保护）', tags: '隐私 追踪 统计 分析 tracker privacy 数据', desc: '拦截追踪器、统计脚本、分析工具（Google Analytics 等），保护浏览隐私。' },
  { url: 'https://easylist-downloads.adblockplus.org/antiadblockfilters.txt', name: '反广告拦截检测', tags: '反拦截 anti-adblock 检测 绕过', desc: '绕过网站的“请关闭广告拦截器”提示，对付反拦截机制。' },
  { url: 'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/ChineseFilter/sections/adservers.txt', name: 'AdGuard 中文广告服务器', tags: '中国 中文 广告服务器 域名 联盟 adguard', desc: 'AdGuard 中文广告服务器域名列表，专注国内广告联盟域名拦截。' },
  { url: 'https://filters.adtidy.org/extension/chromium/filters/1.txt', name: 'AdGuard 基础过滤', tags: 'adguard 英文 基础', desc: 'AdGuard 英文基础广告过滤列表。' },
  { url: 'https://filters.adtidy.org/extension/chromium/filters/2.txt', name: 'AdGuard 隐私过滤', tags: 'adguard 隐私 追踪 tracker', desc: 'AdGuard 英文隐私保护过滤列表，拦截追踪与数据收集。' },
  { url: 'https://filters.adtidy.org/extension/chromium/filters/3.txt', name: 'AdGuard 社交过滤', tags: 'adguard 社交 分享 按钮 点赞 social', desc: '屏蔽社交媒体按钮、小组件、点赞跟踪等。' },
  { url: 'https://filters.adtidy.org/extension/chromium/filters/4.txt', name: 'AdGuard 烦扰过滤', tags: 'adguard 烦扰 弹窗 cookie 通知 annoyances', desc: '屏蔽 cookie 通知、推送弹窗、订阅提示等页面打扰元素。' },
  { url: 'https://easylist-downloads.adblockplus.org/easylistchina+easylist.txt', name: 'EasyList + China（合并）', tags: '中国 中文 国际 合并 全量', desc: 'EasyList 与 EasyList China 合并版本，一次订阅即可覆盖中英文网站。' },
  { url: 'https://raw.githubusercontent.com/banbendalao/ADgk/master/ADgk.txt', name: 'ADgk 综合中文规则', tags: '中国 中文 视频 下载 小说 综合', desc: '综合类中文广告过滤规则，覆盖视频、下载、小说等站点。' },
  { url: 'https://raw.githubusercontent.com/ADPlist/ADPlist/master/ADPlist.txt', name: 'ADPlist 中文广告规则', tags: '中国 中文 视频 小说 综合', desc: '国内社区维护的广告过滤规则，覆盖主流中文站点。' },
  { url: 'https://anti-ad.net/easylist.txt', name: 'anti-AD 中文规则', tags: '中国 中文 综合 anti-ad 国内', desc: 'anti-AD 项目的中文广告过滤规则，域名覆盖广，更新活跃。' },
  { url: 'https://anti-ad.net/adguard.txt', name: 'anti-AD（AdGuard 格式）', tags: '中国 中文 anti-ad adguard', desc: 'anti-AD 项目的 AdGuard 语法版本。' },
  { url: 'https://raw.githubusercontent.com/cjx82630/cjxlist/master/cjxlist.txt', name: 'CJX 综合列表', tags: '中国 中文 综合 cjx 视频', desc: 'CJX 完整规则列表，含广告、反打扰、追踪等，适合中文站。' },
  { url: 'https://easylist-downloads.adblockplus.org/easylistdutch.txt', name: 'EasyList 荷兰语', tags: '荷兰 dutch', desc: '荷兰语网站广告过滤列表。' },
  { url: 'https://easylist-downloads.adblockplus.org/easylistgermany.txt', name: 'EasyList 德语', tags: '德国 德语 german', desc: '德语网站广告过滤列表。' },
  { url: 'https://easylist-downloads.adblockplus.org/liste_fr.txt', name: 'EasyList 法语', tags: '法国 法语 french', desc: '法语网站广告过滤列表。' },
  { url: 'https://easylist-downloads.adblockplus.org/easylistspanish.txt', name: 'EasyList 西班牙语', tags: '西班牙 spanish', desc: '西班牙语网站广告过滤列表。' },
  { url: 'https://easylist-downloads.adblockplus.org/ruadlist.txt', name: 'RU AdList 俄语', tags: '俄罗斯 俄语 russian', desc: '俄语区广告过滤列表。' },
  { url: 'https://easylist-downloads.adblockplus.org/easylistjapan.txt', name: 'EasyList 日语', tags: '日本 日语 japan', desc: '日语网站广告过滤列表。' },
  { url: 'https://raw.githubusercontent.com/List-KR/List-KR/master/filters-shinuita.txt', name: 'List-KR 韩语', tags: '韩国 韩语 korea', desc: '韩语网站广告过滤列表。' },
  { url: 'https://easylist-downloads.adblockplus.org/fanboy-annoyance.txt', name: 'Fanboy 烦扰过滤', tags: '烦扰 annoyances 弹窗 cookie 通知', desc: '屏蔽网页上的烦扰元素：弹窗、cookie 提示、社交按钮等。' },
  { url: 'https://easylist-downloads.adblockplus.org/fanboy-social.txt', name: 'Fanboy 社交过滤', tags: '社交 social 分享 按钮 点赞', desc: '屏蔽社交媒体跟踪与分享按钮。' },
  { url: 'https://easylist-downloads.adblockplus.org/malwaredomains_full.txt', name: '恶意域名拦截', tags: '恶意 病毒 malware 安全 钓鱼', desc: '拦截已知恶意软件、钓鱼网站域名，提升安全性。' },
  { url: 'https://raw.githubusercontent.com/hoshsadiq/adblock-nocoin-list/master/nocoin.txt', name: '加密货币挖矿拦截', tags: '挖矿 加密货币 coin miner crypto', desc: '拦截网页加密货币挖矿脚本，避免 CPU 被占用。' },
  { url: 'https://raw.githubusercontent.com/DandelionSprout/adfilt/master/BrowseTheWebInPeace/WebsiteStretcher.txt', name: 'Dandelion 网页净化', tags: 'dandelion 净化 通用', desc: 'Dandelion Sprout 的网页清洁规则。' },
];

let searchTimer = null;

function renderItems(box, items) {
  if (!items.length) {
    box.innerHTML = '<div class="sub-empty">未找到匹配的规则，可直接粘贴订阅地址，或点“全网搜索”</div>';
    return;
  }
  box.innerHTML = items.map((item) => {
    const name = (item.name || '').replace(/"/g, '&quot;');
    const dataAttr = item.url
      ? 'data-url="' + item.url.replace(/"/g, '&quot;') + '"'
      : 'data-id="' + item.id + '"';
    return '<div class="sub-item">' +
      '<div class="sub-item-info">' +
        '<div class="sub-item-name">' + item.name + '</div>' +
        '<div class="sub-item-desc">' + (item.desc || '') + '</div>' +
      '</div>' +
      '<button class="btn btn-primary sub-sub-btn" ' + dataAttr + ' data-name="' + name + '">订阅</button>' +
    '</div>';
  }).join('');
  box.querySelectorAll('.sub-sub-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      let url = btn.dataset.url;
      if (!url && btn.dataset.id) {
        btn.disabled = true;
        btn.textContent = '解析中';
        setStatus('正在解析: ' + name + ' ...');
        const r = await sendBackground({ type: 'resolveFilterListUrl', id: parseInt(btn.dataset.id, 10) });
        btn.disabled = false;
        btn.textContent = '订阅';
        if (!r || !r.success || !r.url) {
          setStatus('无法获取该列表的订阅地址', 'error');
          return;
        }
        url = r.url;
      }
      if (!url) { setStatus('无效的订阅地址', 'error'); return; }
      setStatus('订阅中: ' + name + ' ...');
      subscribeRules(url);
    });
  });
}

function renderSubscribeResults(keyword) {
  const box = document.getElementById('subscribeResults');
  if (!box) return;
  const kw = (keyword || '').trim().toLowerCase();
  const list = SUBSCRIBE_LISTS.filter(item => {
    if (!kw) return true;
    const hay = (item.name + ' ' + item.desc + ' ' + (item.tags || '')).toLowerCase();
    return hay.includes(kw);
  });
  renderItems(box, list);
}

let webSearchState = { keyword: '', offset: 0, total: 0, rendered: 0 };
const WEB_PAGE_SIZE = 30;

async function searchWeb(keyword, append) {
  const box = document.getElementById('subscribeResults');
  if (!box) return;
  if (!append) {
    webSearchState = { keyword, offset: 0, total: 0, rendered: 0 };
    box.innerHTML = '<div class="sub-empty">🌐 正在搜索全网规则库...</div>';
  }
  const resp = await sendBackground({ type: 'searchFilterLists', keyword, offset: webSearchState.offset, limit: WEB_PAGE_SIZE });
  if (!resp || !resp.success) {
    if (!append) box.innerHTML = '<div class="sub-empty">全网搜索失败: ' + ((resp && resp.error) || '未知错误') + '</div>';
    return;
  }
  webSearchState.total = resp.total;
  const items = (resp.lists || []).map(l => {
    const langTag = (l.languages && l.languages.length) ? '[' + l.languages.join('/') + '] ' : '';
    return { id: l.id, name: l.name, desc: langTag + (l.description || '').slice(0, 130) };
  });

  if (!append) {
    if (!items.length) {
      box.innerHTML = '<div class="sub-empty">全网未找到匹配的规则，换个关键词试试</div>';
      return;
    }
    box.innerHTML = '';
  }

  const wrap = document.createElement('div');
  renderItems(wrap, items);
  while (wrap.firstChild) box.appendChild(wrap.firstChild);
  webSearchState.rendered += items.length;
  webSearchState.offset += items.length;

  // 移除旧的统计/加载更多，重建尾部
  const oldFoot = box.querySelector('.sub-foot');
  if (oldFoot) oldFoot.remove();
  const foot = document.createElement('div');
  foot.className = 'sub-foot';
  foot.style.cssText = 'font-size:10px;color:#888;padding:6px 8px;text-align:center;';
  let footHtml = '🌐 共 ' + webSearchState.total + ' 个，已显示 ' + webSearchState.rendered + ' 个';
  foot.innerHTML = footHtml;
  if (resp.hasMore) {
    const moreBtn = document.createElement('button');
    moreBtn.className = 'btn btn-outline';
    moreBtn.style.cssText = 'display:block;margin:6px auto 0;';
    moreBtn.textContent = '加载更多';
    moreBtn.addEventListener('click', () => {
      moreBtn.disabled = true;
      moreBtn.textContent = '加载中...';
      searchWeb(webSearchState.keyword, true);
    });
    foot.appendChild(moreBtn);
  }
  box.appendChild(foot);
}
function initSubscribeSearch() {
  const input = document.getElementById('subscribeSearch');
  if (!input) return;
  renderSubscribeResults('');
  input.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    const v = input.value;
    searchTimer = setTimeout(() => renderSubscribeResults(v), 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = input.value.trim();
      if (/^https?:\/\//i.test(v)) { setStatus('订阅中...'); subscribeRules(v); }
      else if (v) searchWeb(v);
    }
  });
  const btn = document.getElementById('btnWebSearch');
  if (btn) btn.addEventListener('click', () => {
    const v = input.value.trim();
    if (!v) { setStatus('请输入搜索关键词', 'error'); return; }
    searchWeb(v);
  });
}

// ---------- 订阅 ----------
async function subscribeRules(url) {
  const resp = await sendBackground({ type: 'subscribeRules', url });
  if (resp && resp.success) {
    const skipInfo = resp.skipped ? `，跳过 ${resp.skipped} 条（无法准确转换）` : '';
    const dupInfo = resp.dup ? `，去重 ${resp.dup} 条` : '';
    setStatus(`订阅成功，新增 ${resp.count} 条规则${dupInfo}${skipInfo}`, 'success');
    updateUI();
    const tab = await getActiveTab();
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: 'refreshRules' }).catch(() => {});
    }
  } else {
    setStatus('订阅失败: ' + (resp?.error || '未知错误'), 'error');
  }
}

// ---------- 事件绑定 ----------
document.getElementById('btnStartRecord').addEventListener('click', async () => {
  const success = await sendToTab({ type: 'startRecording' });
  if (!success) {
    setStatus('⚠️ 无法在页面启动录制，请刷新页面后重试', 'error');
    return;
  }
  await updateRecordingStatus();
});

document.getElementById('btnScan').addEventListener('click', async () => {
  await sendToTab({ type: 'scanNow' });
  setStatus('🔍 已触发扫描', 'success');
});

document.getElementById('btnExport').addEventListener('click', exportRules);

document.getElementById('btnDedupe').addEventListener('click', async () => {
  if (!confirm('扫描并删除重复的规则？此操作会压缩规则库。')) return;
  setStatus('正在清理重复规则...');
  const resp = await sendBackground({ type: 'dedupeAllRules' });
  if (resp && !resp.error) {
    setStatus(`清理完成：删除 ${resp.removed} 条重复，保留 ${resp.kept} 条`, 'success');
    updateUI();
  } else {
    setStatus('清理失败: ' + ((resp && resp.error) || '未知错误'), 'error');
  }
});

document.getElementById('btnDiag').addEventListener('click', async () => {
  const tab = await getActiveTab();
  let hostname = '';
  if (tab && tab.url) { try { hostname = new URL(tab.url).hostname; } catch (e) {} }
  const d = await sendBackground({ type: 'getDiagnostics', hostname });
  const el = document.getElementById('diagResult');
  if (!d || d.error) {
    el.textContent = '诊断失败: ' + ((d && d.error) || '未知错误');
    el.style.display = 'block';
    return;
  }
  el.textContent =
    `规则库总量: ${d.total}\n` +
    `  网络规则: ${d.net}\n` +
    `  元素隐藏: ${d.hide}\n` +
    `  录制操作: ${d.elem}\n` +
    `DNR 实际生效: ${d.dnrCount} 条\n` +
    `当前站(${hostname || '未知'}):\n` +
    `  匹配隐藏规则: ${d.matchHide}\n` +
    `  匹配操作规则: ${d.matchElem}`;
  el.style.display = 'block';
});

document.getElementById('fileInput').addEventListener('change', function(e) {
  if (this.files.length > 0) {
    importRules(this.files[0]);
    this.value = '';
  }
});

document.getElementById('btnClear').addEventListener('click', async () => {
  if (confirm('确定清空所有规则？此操作不可撤销！')) {
    const resp = await sendBackground({ type: 'clearAllRules' });
    if (resp && resp.success) {
      setStatus('已清空所有规则', 'success');
      updateUI();
    } else {
      setStatus('清空失败', 'error');
    }
  }
});

initSubscribeSearch();

// ---------- 图像识别阈值滑块 ----------
(async function initDhashSlider() {
  const range = document.getElementById('dhashRange');
  const valEl = document.getElementById('dhashVal');
  if (!range) return;
  const r = await chrome.storage.local.get(['dhashDistance']);
  const v = (r.dhashDistance !== undefined) ? r.dhashDistance : 10;
  range.value = v;
  valEl.textContent = v;
  range.addEventListener('input', () => { valEl.textContent = range.value; });
  range.addEventListener('change', async () => {
    const val = parseInt(range.value, 10);
    await chrome.storage.local.set({ dhashDistance: val });
    setStatus('图像识别阈值已设为 ' + val, 'success');
    // 通知当前标签页的 content 立即生效
    const tab = await getActiveTab();
    if (tab) chrome.tabs.sendMessage(tab.id, { type: 'setDhashDistance', value: val }).catch(() => {});
  });
})();

// ---------- 监听 background 确认 ----------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'showGlobalConfirm') {
    let extraMsg = '';
    if (message.generatedRule) {
      extraMsg = `\n同时生成元素隐藏规则: ${message.generatedRule.match.selector}`;
    }
    const confirmed = confirm(`是否将此录制操作设为“通用规则”，适用于所有类似网站？${extraMsg}`);
    sendResponse({ confirmed: confirmed });
    return true;
  }
});

// ---------- 赞助按钮 ----------
document.getElementById('sponsorBtn').addEventListener('click', function() {
  const qr = document.getElementById('sponsorQR');
  qr.style.display = qr.style.display === 'none' ? 'block' : 'none';
});

// ---------- 拦截模式切换 ----------
async function updateBlockModeButton() {
  const tab = await getActiveTab();
  let mode = 'remove';
  if (tab && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://') && !tab.url.startsWith('about:')) {
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'getBlockMode' });
      if (resp && resp.mode) mode = resp.mode;
    } catch (e) {}
  }
  const btn = document.getElementById('btnBlockMode');
  if (btn) {
    if (mode === 'hide') {
      btn.textContent = '👁️ 页面隐藏型';
      btn.style.background = '#e6f4ff';
      btn.style.color = '#0078d4';
    } else {
      btn.textContent = '🗑️ 页面删除型';
      btn.style.background = '';
      btn.style.color = '';
    }
  }
  return mode;
}

document.getElementById('btnBlockMode').addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
    setStatus('⚠️ 此页面不支持切换', 'error');
    return;
  }
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'toggleBlockMode' });
    if (resp && resp.mode) {
      await updateBlockModeButton();
      const label = resp.mode === 'hide' ? '👁️ 隐藏型' : '🗑️ 删除型';
      setStatus('已切换为 ' + label, 'success');
    }
  } catch (e) {
    setStatus('切换失败: ' + e.message, 'error');
  }
});

// ---------- 初始化 ----------
updateUI();
updateBlockModeButton();
setInterval(() => {
  updateRecordingStatus();
}, 5000);








