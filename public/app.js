'use strict';

/* ==================================================================
 * b站音乐播放器 — 前端逻辑
 * ================================================================== */

const $ = (s) => document.querySelector(s);
// 收藏夹列表存在服务端文件里（见 server.js 的 /api/library），
// localStorage 只保留「这台设备」的偏好：音量、播放模式、上次听的歌。
const LS = {
  volume: 'bfp.volume',
  mode: 'bfp.mode',
  lastBvid: 'bfp.lastBvid',
  user: 'bfp.user', // 只缓存昵称/头像/uid，真正的登录凭证在服务端 data/auth.json
  view: 'bfp.view', // list | card
};

/* ---------------- 状态 ---------------- */
const state = {
  folders: [], // [{ mediaId, title, count, cover, upper }]
  mediaId: null,
  info: null,
  tracks: [], // 全量曲目（当前列表：收藏夹 或 搜索结果）
  view: [], // 当前显示/播放顺序（tracks 的下标数组）
  playingIndex: -1, // 在 tracks 里的下标（只用于高亮，列表切换后可能是 -1）
  playingTrack: null, // 正在播放的那首（对象本身，和列表解耦：切到搜索结果也不丢）
  mode: 'list', // list | one | shuffle
  volume: 0.8,
  muted: false,
  query: '',
  // 列表来源：folder = 收藏夹；search = B 站搜索结果（临时视图，不落盘）
  listMode: 'folder',
  viewMode: 'list', // list | card（卡片视图分页显示）
  cardPage: 0, // 卡片视图当前页（0 起）
  search: null, // { keyword, page, total, pages, tracks }
  folderSnapshot: null, // 进搜索前的收藏夹现场，返回时原样还原
  user: null, // 已登录的 B 站账号 { mid, uname, face }，没登录为 null
  // 乱序播放：一次性把列表打乱，然后按这个顺序依次播完，播完一轮再重新洗牌。
  // 不是「每首独立随机抽」—— 那样上一首根本回不去，也保证不了一轮内不重复。
  shuffleQueue: [], // 打乱后的 tracks 下标
  shufflePos: -1, // 当前播到队列的第几个
  // 手动播放列表：右键「下一曲播放 / 添加到播放列表」入队。
  // 存 track 对象本身（浅拷贝），与当前列表解耦——切收藏夹/搜索都不丢。
  // queue[0] 固定是正在播的那首；播完一首 shift 掉，下一首顶上来。
  queue: [],
  loading: false,
};

const audio = $('#audio');
const npView = $('#npView');

/* ---------------- 桌面端：悬浮小卡片 ---------------- */
// 只有 Electron 壳里才有 window.desktop；纯浏览器打开时这段整体不生效
const DESKTOP = window.desktop && window.desktop.isDesktop ? window.desktop : null;
let lastMiniPush = 0;

/** 把当前播放状态推给悬浮卡片。节流 900ms，卡片那边靠本地插值推进度条 */
function pushMiniState(force) {
  if (!DESKTOP) return;
  const now = Date.now();
  if (!force && now - lastMiniPush < 900) return;
  lastMiniPush = now;
  const t = currentTrack();
  DESKTOP.reportState({
    title: t ? t.title : '',
    upper: t ? t.upper : '',
    cover: t && t.cover ? location.origin + imgUrl(t.cover, '@120w_120h_1c') : '',
    playing: !audio.paused && !audio.ended,
    pos: audio.currentTime || 0,
    dur: totalDuration() || 0,
    volume: state.volume,
    muted: state.muted,
  });
}

/* ---------------- 小工具 ---------------- */
const fmtTime = (sec) => {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

function imgUrl(u, size = '@160w_160h_1c') {
  if (!u) return '';
  let url = u;
  if (url.startsWith('//')) url = 'https:' + url;
  if (url.startsWith('http://')) url = 'https://' + url.slice(7);
  return `/api/img?u=${encodeURIComponent(url + size)}`;
}

let toastTimer = null;
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => (el.hidden = true), 220);
  }, ms);
}

/* ---------------- 当前账号（多用户） ---------------- */

// 注意：不能和 LS.user 撞键 —— 那个存的是 { mid, uname, face } 的 JSON 缓存
const LS_USER = 'bfp.uid';

/** 本机选定的 B 站账号 mid；空表示跟随服务端默认 */
function currentUserId() {
  try {
    return localStorage.getItem(LS_USER) || '';
  } catch {
    return '';
  }
}

function setCurrentUserId(mid) {
  try {
    if (mid) localStorage.setItem(LS_USER, String(mid));
    else localStorage.removeItem(LS_USER);
  } catch {}
}

/** 所有请求都带上账号，服务端据此决定读写哪个 users/<mid>/ */
function userHeaders(extra) {
  const h = extra || {};
  const mid = currentUserId();
  if (mid) h['X-BFP-User'] = mid;
  return h;
}

/** sendBeacon 不能带请求头，账号信息走查询串 */
function beaconUrl(path) {
  const mid = currentUserId();
  if (!mid) return path;
  return path + (path.includes('?') ? '&' : '?') + 'u=' + encodeURIComponent(mid);
}

async function api(path) {
  const r = await fetch(path, { headers: userHeaders() });
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new Error(`服务异常 (HTTP ${r.status})`);
  return r.json();
}

/* ---------------- 持久化（服务端） ---------------- */
let persistTimer = null;
let persistWarned = false;

/** 收藏夹列表变了就同步到服务端，防抖合并连续改动 */
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/library', {
        method: 'POST',
        headers: userHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ current: state.mediaId, folders: state.folders }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '保存失败');
    } catch (e) {
      if (!persistWarned) {
        persistWarned = true;
        toast('收藏夹没能保存到服务器：' + e.message, 3200);
        setTimeout(() => (persistWarned = false), 8000);
      }
    }
  }, 150);
}

async function fetchLibrary() {
  try {
    const r = await fetch('/api/library', { headers: userHeaders() });
    const j = await r.json();
    if (j && j.ok) {
      return {
        current: j.current || null,
        folders: Array.isArray(j.folders) ? j.folders : [],
      };
    }
  } catch {
    /* 服务不可用：当作空列表，走引导页 */
  }
  return { current: null, folders: [] };
}

/* ---------------- 输入解析 ---------------- */
/** 从链接或裸 ID 里抠出收藏夹 media_id */
function parseMediaId(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  // .../favlist?fid=123&ftype=create
  const m = s.match(/[?&](?:fid|media_id)=(\d+)/i);
  if (m) return m[1];
  // .../medialist/detail/ml123456
  const m2 = s.match(/\/ml(\d+)/i);
  if (m2) return m2[1];
  return null;
}

/** 从链接或裸 UID 里抠出 UID */
function parseUid(text) {
  const s = String(text || '').trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/space\.bilibili\.com\/(\d+)/i);
  return m ? m[1] : null;
}

/** 合集链接：space.bilibili.com/<mid>/lists/<season_id>?type=season */
function parseSeason(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  // /lists/ 同时用在合集和系列上，系列走 type=series，别误当成合集
  if (/[?&]type=series\b/i.test(s)) return null;
  const m = s.match(/space\.bilibili\.com\/(\d+)\/lists\/(\d+)/i);
  if (m) return { mid: m[1], seasonId: m[2] };
  const m2 = s.match(/^(\d+):(\d+)$/);
  if (m2) return { mid: m2[1], seasonId: m2[2] };
  return null;
}

/** 合集在收藏夹列表里的唯一键，和普通收藏夹的纯数字 mediaId 区分开 */
function seasonKey(season) {
  return `season:${season.mid}:${season.seasonId}`;
}

function parseSeasonKey(key) {
  const m = String(key || '').match(/^season:(\d+):(\d+)$/);
  return m ? { mid: m[1], seasonId: m[2] } : null;
}

/* ---------------- 收藏夹列表渲染 ---------------- */
function renderFolders() {
  const box = $('#folderList');
  box.innerHTML = '';

  if (!state.folders.length) {
    box.innerHTML = '<div class="f-count" style="padding:10px 9px;line-height:1.7">还没有收藏夹 / 合集<br>点右上角 + 添加</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const f of state.folders) {
    const el = document.createElement('div');
    el.className = 'folder' + (String(f.mediaId) === String(state.mediaId) ? ' active' : '');
    el.dataset.id = f.mediaId;
    const seasonTag = parseSeasonKey(f.mediaId) ? '<span class="f-tag">合集</span>' : '';
    el.innerHTML = `
      <div class="f-cover"${f.cover ? ` style="background-image:url('${imgUrl(f.cover, '@80w_80h_1c')}')"` : ''}></div>
      <div class="f-body">
        <div class="f-name" title="${escapeAttr(f.title)}">${seasonTag}${escapeHtml(f.title)}</div>
        <div class="f-count">${f.count || 0} 首</div>
      </div>
      <button class="f-del" title="移除">
        <svg viewBox="0 0 24 24" width="13" height="13"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
      </button>`;

    // 手机上删除按钮是隐藏的，用长按代替
    let pressTimer = null;
    let longPressed = false;
    const cancelPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    el.addEventListener(
      'touchstart',
      () => {
        cancelPress();
        longPressed = false;
        pressTimer = setTimeout(() => {
          pressTimer = null;
          longPressed = true;
          if (confirm(`移除「${f.title}」？\n只从本地列表移除，不影响 B 站收藏夹 / 合集。`)) {
            removeFolder(f.mediaId);
          }
        }, 650);
      },
      { passive: true }
    );
    el.addEventListener('touchend', cancelPress);
    el.addEventListener('touchmove', cancelPress, { passive: true });
    el.addEventListener('touchcancel', cancelPress);

    el.addEventListener('click', (e) => {
      if (longPressed) {
        longPressed = false;
        return;
      }
      if (e.target.closest('.f-del')) {
        e.stopPropagation();
        removeFolder(f.mediaId);
        return;
      }
      if (String(f.mediaId) !== String(state.mediaId)) loadFolder(f.mediaId);
    });

    // 右键合集/收藏夹条目：追加或替换播放列表
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showFolderContextMenu(e.clientX, e.clientY, f);
    });
    frag.appendChild(el);
  }
  box.appendChild(frag);
}

function removeFolder(mediaId) {
  state.folders = state.folders.filter((f) => String(f.mediaId) !== String(mediaId));
  persist();
  if (String(mediaId) === String(state.mediaId)) {
    const nextF = state.folders[0];
    if (nextF) {
      loadFolder(nextF.mediaId);
    } else {
      state.mediaId = null;
      state.tracks = [];
      state.view = [];
      renderFolders();
      renderCurrent();
      $('#gate').hidden = false;
      $('#app').hidden = true;
    }
  } else {
    renderFolders();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;

/* ---------------- 加载收藏夹 ---------------- */

/** 缓存时间说人话：12 分钟前 / 3 小时前 / 2 天前 */
function cacheAgo(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return '刚刚更新';
  if (min < 60) return `${min} 分钟前更新`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前更新`;
  return `${Math.floor(h / 24)} 天前更新`;
}

async function loadFolder(mediaId, opts = {}) {
  if (state.loading) return;
  leaveSearch(); // 从搜索结果点回某个收藏夹：直接丢掉搜索视图
  state.loading = true;
  state.mediaId = String(mediaId);
  persist(); // 记住当前选的是哪个收藏夹（存服务端，换设备也一致）

  $('#gate').hidden = true;
  $('#app').hidden = false;
  renderFolders();
  showSkeleton();
  $('#favTitle').textContent = opts.force ? '刷新中…' : '加载中…';
  $('#favSub').textContent = opts.force ? '正在从 B 站重新读取' : '正在读取本地缓存';

  try {
    // 默认读服务端缓存（data/fav/ 或 data/season/），只有刷新按钮才回源
    const season = parseSeasonKey(mediaId);
    const suffix = opts.force ? '&refresh=1' : '';
    const q = season
      ? `/api/season?mid=${encodeURIComponent(season.mid)}&season_id=${encodeURIComponent(season.seasonId)}${suffix}`
      : `/api/fav?media_id=${encodeURIComponent(mediaId)}${suffix}`;
    const data = await api(q);
    if (!data.ok) throw new Error(data.error || '加载失败');

    state.info = data.info;
    // 切收藏夹时如果正在播的歌在新列表里，保持它继续播（不打断）
    const prevBvid = currentTrack() ? currentTrack().bvid : null;
    state.tracks = data.tracks || [];
    state.playingIndex = prevBvid ? state.tracks.findIndex((t) => t.bvid === prevBvid) : -1;
    state.shuffleQueue = [];
    state.shufflePos = -1;

    $('#favTitle').textContent = (data.info && data.info.title) || '收藏夹';
    const n = state.tracks.filter((t) => !t.dead).length;
    const deadN = state.tracks.length - n;
    const up = (data.info && data.info.upper) || '';
    // 标明数据新鲜度：走缓存时说清是多久前的，避免「我新加的歌怎么没有」的困惑
    const ago = data.cached ? cacheAgo(data.savedAt) : '刚刚更新';
    $('#favSub').textContent =
      `${n} 首` + (deadN > 0 ? ` · ${deadN} 个已失效` : '') + (up ? ` · ${up}` : '') + (ago ? ` · ${ago}` : '');

    if (data.info && data.info.cover) {
      $('#favCover').style.backgroundImage = `url('${imgUrl(data.info.cover, '@120w_120h_1c')}')`;
    } else {
      $('#favCover').style.backgroundImage = '';
    }

    // 同步到侧栏（标题/数量可能变了）
    const rec = state.folders.find((f) => String(f.mediaId) === String(mediaId));
    if (rec) {
      rec.title = (data.info && data.info.title) || rec.title;
      rec.count = n;
      rec.cover = (data.info && data.info.cover) || rec.cover;
      persist();
      renderFolders();
    }

    rebuildView();
    restoreLast();

    // 回源失败但用上了旧缓存 —— 得让用户知道数据没更新成功
    if (data.warning) {
      toast(`刷新失败，先用 ${cacheAgo(data.savedAt)} 的缓存：${data.warning}`, 4200);
    }
  } catch (e) {
    $('#favTitle').textContent = '加载失败';
    $('#favSub').textContent = e.message;
    state.tracks = [];
    rebuildView();
    toast('加载失败：' + e.message, 3200);
  } finally {
    state.loading = false;
  }
}

function showSkeleton() {
  $('#emptyState').hidden = true;

  // 卡片视图：骨架画在网格里
  if (state.viewMode === 'card') {
    const grid = $('#cardGrid');
    $('#trackList').hidden = true;
    $('#cardPane').hidden = false;
    let cards = '';
    for (let i = 0; i < 8; i++) {
      cards += `<div class="card sk-card">
        <div class="sk" style="aspect-ratio:16/10;border-radius:8px"></div>
        <div class="sk" style="height:11px;margin-top:9px;width:${70 + ((i * 7) % 25)}%"></div>
        <div class="sk" style="height:10px;margin-top:6px;width:45%"></div>
      </div>`;
    }
    grid.innerHTML = cards;
    $('#cardPager').innerHTML = '';
    return;
  }

  const box = $('#trackList');
  let html = '';
  for (let i = 0; i < 8; i++) {
    html += `<div class="skeleton-row">
      <div class="sk" style="width:14px;justify-self:center"></div>
      <div class="sk" style="width:${40 + ((i * 13) % 45)}%"></div>
      <div class="sk" style="width:60%"></div>
      <div class="sk" style="width:70%;justify-self:end"></div>
      <div class="sk" style="width:70%;justify-self:end"></div>
    </div>`;
  }
  box.innerHTML = html;
}

/* ---------------- 曲目列表渲染 ---------------- */
function rebuildView() {
  // 搜索结果整页给出来，不再叠一层本地过滤（搜「未闻花名」时结果标题里可能一个中文都没有）
  const q = state.listMode === 'search' ? '' : state.query.trim().toLowerCase();
  state.view = [];
  state.tracks.forEach((t, i) => {
    if (!q || t.title.toLowerCase().includes(q) || (t.upper || '').toLowerCase().includes(q)) {
      state.view.push(i);
    }
  });
  // 搜索过滤后列表变了，旧的乱序队列作废
  state.shuffleQueue = [];
  state.shufflePos = -1;
  state.cardPage = 0; // 列表变了，卡片视图回到第一页
  renderCurrent();
}

/** 按当前视图（列表 / 卡片）渲染 */
function renderCurrent() {
  const cardMode = state.viewMode === 'card';
  const cols = document.querySelector('.list-cols');
  const list = $('#trackList');
  const pane = $('#cardPane');
  if (cols) cols.hidden = cardMode; // 卡片视图不需要「#/歌曲/UP/时长」表头
  if (list) list.hidden = cardMode;
  if (pane) pane.hidden = !cardMode;

  renderSearchPager(); // 搜索时才有分页条

  if (!state.view.length) {
    if (pane) pane.hidden = true;
    renderTracks(); // 复用列表那套空状态文案
    return;
  }
  $('#emptyState').hidden = true;
  if (cardMode) renderCards();
  else renderTracks();
  // 自动给当前列表的所有曲目获取音质（含已缓存的，服务端秒回）
  brSeen.clear();
  queueBitrates(state.view.map((ti) => state.tracks[ti]).filter(Boolean));
}

/* ---------------- 音质 / 码率（自动获取全部，含已缓存） ---------------- */

/** 192000 -> "192k"；1100 以上按 M 显示；estimated（durl 估算）加个 ≈ */
function fmtBitrate(bw, estimated) {
  if (!bw || bw <= 0) return '—';
  const k = Math.round(bw / 1000);
  const v = k >= 1000 ? `${(k / 1000).toFixed(1)}M` : `${k}k`;
  return estimated ? `≈${v}` : v;
}

function brLabel(t) {
  if (t.bandwidth) return fmtBitrate(t.bandwidth, t.estimated);
  return t.bitrateChecked ? '—' : '…';
}

/** 只给「已知」的码率文案；查不到 / 还没查返回空串 */
function bitrateText(t) {
  const v = t ? brLabel(t) : '';
  return v === '…' || v === '—' ? '' : v;
}

/**
 * 底栏 / 放大视图里的「UP 主 · 码率」。
 * 码率是后台异步补全的，拿到之后 bvRateApplied() 会再调一次这里刷新。
 */
function refreshNowPlayingMeta() {
  const t = currentTrack();
  const up = (t && t.upper) || '—';
  const br = bitrateText(t);

  const small = $('#npUpper');
  if (small) small.textContent = br ? `${up} · ${br}` : up;

  const big = $('#npBigUpper');
  if (big) big.textContent = up;

  const chip = $('#npBigBr');
  if (chip) {
    const parts = [];
    if (br) parts.push(br);
    if (videoMode && videoQuality) parts.push(videoQuality);
    chip.textContent = parts.join(' · ');
    chip.hidden = !parts.length;
    chip.classList.toggle('hi', videoMode);
  }
}

const brQueue = [];
const brSeen = new Set(); // 本轮去重，防止同一 bvid 重复入队
const brKnown = new Map(); // bvid -> { bandwidth, quality, estimated }：查过一次就记住
let brRunning = false;

/** 入队查码率——不跳过已查过的，已缓存的在服务端秒回，代价很小 */
function queueBitrates(tracks) {
  let added = false;
  for (const t of tracks) {
    if (!t || !t.bvid) continue;

    // 同一个视频换个对象出现（比如又从列表加进播放列表），直接套用已知码率
    const known = brKnown.get(t.bvid);
    if (known) {
      if (!t.bandwidth && known.bandwidth) {
        t.bandwidth = known.bandwidth;
        t.quality = known.quality || 0;
        t.estimated = !!known.estimated;
        t.bitrateChecked = true;
        bvRateApplied(t, known);
      }
      continue;
    }

    if (brSeen.has(t.bvid)) continue;
    brSeen.add(t.bvid);
    brQueue.push(t);
    added = true;
  }
  if (added) pumpBitrates();
}

/** 一次问 8 条（服务端每条要两次请求），问完再画到对应的行/卡片上 */
async function pumpBitrates() {
  if (brRunning) return;
  brRunning = true;
  try {
    while (brQueue.length) {
      const batch = brQueue.splice(0, 8);
      const bvids = batch.map((t) => t.bvid);
      try {
        const j = await api(`/api/bitrates?bvids=${encodeURIComponent(bvids.join(','))}`);
        if (j && j.ok) {
          for (const t of batch) {
            const b = j.map[t.bvid];
            t.bitrateChecked = true;
            bvRateApplied(t, b);
          }
        }
      } catch {
        /* 查不到就先留着「…」，下次重画再试 */
      }
      if (brQueue.length) await new Promise((r) => setTimeout(r, 120));
    }
  } finally {
    brRunning = false;
  }
}

function bvRateApplied(t, b) {
  if (b && b.bandwidth) {
    t.bandwidth = b.bandwidth;
    t.quality = b.quality || 0;
    t.estimated = !!b.estimated;
    brKnown.set(t.bvid, { bandwidth: t.bandwidth, quality: t.quality, estimated: t.estimated });
  }
  const txt = brLabel(t);
  document.querySelectorAll(`[data-bvid="${t.bvid}"] .t-br`).forEach((el) => {
    el.textContent = txt;
    el.classList.toggle('known', !!t.bandwidth);
  });
  // 卡片上只在拿到码率后才显示这个角标
  document.querySelectorAll(`[data-bvid="${t.bvid}"] .c-br`).forEach((el) => {
    el.textContent = t.bandwidth ? fmtBitrate(t.bandwidth, t.estimated) : '';
    el.hidden = !t.bandwidth;
  });
  // 播放列表里的码率角标
  document.querySelectorAll(`[data-bvid="${t.bvid}"] .q-br`).forEach((el) => {
    el.textContent = bitrateText(t) || '—';
  });
  // 正播着这首：底栏和放大视图上的码率也跟着更新
  const cur = currentTrack();
  if (cur && cur.bvid === t.bvid) refreshNowPlayingMeta();
}

/* ---------------- 卡片视图（分页） ---------------- */
const CARD_PAGE_SIZE = 24;

function cardPageCount() {
  return Math.max(1, Math.ceil(state.view.length / CARD_PAGE_SIZE));
}

function renderCards() {
  const grid = $('#cardGrid');
  if (!grid) return;

  const total = cardPageCount();
  if (state.cardPage >= total) state.cardPage = total - 1;
  if (state.cardPage < 0) state.cardPage = 0;

  const start = state.cardPage * CARD_PAGE_SIZE;
  const pageItems = state.view.slice(start, start + CARD_PAGE_SIZE);

  const frag = document.createDocumentFragment();
  for (const ti of pageItems) {
    const t = state.tracks[ti];
    if (!t) continue;
    const active = ti === state.playingIndex;
    const el = document.createElement('div');
    el.className = 'card' + (active ? ' active' : '') + (t.dead ? ' dead' : '');
    el.dataset.idx = ti;
    if (t.bvid) el.dataset.bvid = t.bvid;
    el.title = t.upper ? `${t.title}\n${t.upper}` : t.title || '';
    el.innerHTML = `
      <div class="c-cover"${t.cover ? ` style="background-image:url('${imgUrl(t.cover, '@320w_200h_1c')}')"` : ''}>
        ${active ? `<div class="bars${audio.paused ? ' paused' : ''}"><i></i><i></i><i></i></div>` : ''}
        ${t.seasonTitle ? `<span class="c-season" title="来自合集：${escapeAttr(t.seasonTitle)}">合集</span>` : ''}
        <span class="c-br"${t.bandwidth ? '' : ' hidden'}>${t.bandwidth ? fmtBitrate(t.bandwidth, t.estimated) : ''}</span>
        ${t.duration ? `<span class="c-dur">${fmtTime(t.duration)}</span>` : ''}
      </div>
      <div class="c-title">${escapeHtml(t.title)}</div>
      <div class="c-upper">${escapeHtml(t.upper || '')}</div>`;

    if (!t.dead) el.addEventListener('click', () => playAt(ti));
    if (t.bvid) {
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, { bvid: t.bvid, track: t });
      });
    }
    frag.appendChild(el);
  }

  grid.innerHTML = '';
  grid.appendChild(frag);
  renderPager(total);
}

function renderPager(total) {
  const pager = $('#cardPager');
  if (!pager) return;
  pager.innerHTML = '';

  const addBtn = (label, page, { on = false, disabled = false } = {}) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pg-btn' + (on ? ' on' : '');
    b.textContent = label;
    if (disabled) b.disabled = true;
    else if (!on) b.addEventListener('click', () => goCardPage(page));
    pager.appendChild(b);
  };
  const addDots = () => {
    const s = document.createElement('span');
    s.className = 'pg-dots';
    s.textContent = '…';
    pager.appendChild(s);
  };

  if (total > 1) {
    addBtn('‹', state.cardPage - 1, { disabled: state.cardPage === 0 });

    // 首页、末页、当前页附近各留几个，中间用省略号
    const pages = [];
    for (let p = 0; p < total; p++) {
      if (p === 0 || p === total - 1 || Math.abs(p - state.cardPage) <= 2) pages.push(p);
    }
    let prev = -2;
    for (const p of pages) {
      if (p - prev > 1) addDots();
      addBtn(String(p + 1), p, { on: p === state.cardPage });
      prev = p;
    }

    addBtn('›', state.cardPage + 1, { disabled: state.cardPage >= total - 1 });
  }

  const info = document.createElement('span');
  info.className = 'pg-info';
  info.textContent =
    (total > 1 ? `第 ${state.cardPage + 1} / ${total} 页 · ` : '') + `共 ${state.view.length} 首`;
  pager.appendChild(info);
}

function goCardPage(page) {
  state.cardPage = Math.max(0, page);
  renderCards();
  const pane = $('.list-pane');
  if (pane) pane.scrollTop = 0;
}

/** 切换列表 / 卡片视图，选择记在本机 */
function setViewMode(mode, remember = true) {
  state.viewMode = mode === 'card' ? 'card' : 'list';
  const btn = $('#viewBtn');
  if (btn) {
    btn.classList.toggle('card', state.viewMode === 'card');
    btn.title = state.viewMode === 'card' ? '切换到列表视图' : '切换到卡片视图';
  }
  state.cardPage = 0;
  if (remember) {
    try {
      localStorage.setItem(LS.view, state.viewMode);
    } catch {
      /* 隐私模式忽略 */
    }
  }
  renderCurrent();
}

function renderTracks() {
  const box = $('#trackList');
  const empty = $('#emptyState');

  if (!state.view.length) {
    box.innerHTML = '';
    empty.hidden = false;
    if (state.listMode === 'search') {
      empty.textContent = `B 站没搜到「${(state.search && state.search.keyword) || ''}」的相关视频`;
    } else if (state.query) {
      // 本地没搜到：给一条去 B 站搜的出路
      empty.innerHTML =
        `没有匹配「${escapeHtml(state.query)}」的曲目` +
        `<div class="empty-actions"><button id="emptySearchBtn" class="ghost-btn" type="button">在 B 站搜索「${escapeHtml(
          state.query
        )}」</button></div>`;
      const go = $('#emptySearchBtn');
      if (go) go.addEventListener('click', () => doSearch(state.query));
    } else {
      empty.textContent = state.tracks.length ? '这个收藏夹是空的' : '没有数据，试试右上角重新加载';
    }
    return;
  }
  empty.hidden = true;

  const frag = document.createDocumentFragment();
  state.view.forEach((ti, pos) => {
    const t = state.tracks[ti];
    const active = ti === state.playingIndex;
    const el = document.createElement('div');
    el.className = 'track' + (active ? ' active' : '') + (t.dead ? ' dead' : '');
    el.dataset.idx = ti;
    if (t.bvid) el.dataset.bvid = t.bvid;

    let idxHtml;
    if (active) {
      idxHtml = `<div class="bars${audio.paused ? ' paused' : ''}"><i></i><i></i><i></i></div>`;
    } else {
      idxHtml = String(pos + 1);
    }

    const seasonTag = t.seasonTitle
      ? `<span class="t-season" title="来自合集：${escapeAttr(t.seasonTitle)}">合集</span>`
      : '';

    el.innerHTML = `
      <div class="t-idx">${idxHtml}</div>
      <div class="t-main">
        <div class="t-thumb"${t.cover ? ` style="background-image:url('${imgUrl(t.cover, '@80w_80h_1c')}')"` : ''}></div>
        <div class="t-title" title="${escapeAttr(t.title)}">${seasonTag}${escapeHtml(t.title)}</div>
      </div>
      <div class="t-upper" title="${escapeAttr(t.upper)}">${escapeHtml(t.upper)}</div>
      <div class="t-br">${brLabel(t)}</div>
      <div class="t-time">${fmtTime(t.duration)}</div>`;

    if (!t.dead) el.addEventListener('click', () => playAt(ti));
    // 右键先出菜单，点击菜单项再去 B 站看原视频 / 收藏到自己收藏夹
    if (t.bvid) {
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, { bvid: t.bvid, track: t });
      });
    }
    frag.appendChild(el);
  });

  box.innerHTML = '';
  box.appendChild(frag);
}

/* ---------------- B 站搜索 ---------------- */

/** 当前列表对应的收藏夹 ID（搜索结果不属于任何收藏夹，进度/历史里记 null） */
function listId() {
  return state.listMode === 'search' ? null : state.mediaId;
}

function showSearchBar(text) {
  const bar = $('#searchBar');
  const label = $('#searchLabel');
  if (bar) bar.hidden = false;
  if (label) label.textContent = text || '';
}

function hideSearchBar() {
  const bar = $('#searchBar');
  if (bar) bar.hidden = true;
}

/** 搜索结果条的文案：关键词 / 第几页 / 条数 */
function searchBarText() {
  const s = state.search;
  if (!s) return '';
  const n = state.tracks.length;
  return (
    `B站搜索「${s.keyword}」· 第 ${s.page || 1} 页 · ${n} 首` +
    (s.total ? `（共约 ${s.total} 个结果）` : '')
  );
}

let searching = false;

/* ---------------- 搜索分页（一次显示 5 个页码，点了才请求） ---------------- */

const SEARCH_PAGE_WIN = 5;

/** 画分页条：窗口式显示 5 个页码，当前页高亮，两侧有上一页/下一页 */
function renderSearchPager() {
  const box = $('#searchPager');
  if (!box) return;

  const s = state.search;
  if (state.listMode !== 'search' || !s || !s.pages || s.pages <= 1) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }

  const total = s.pages;
  const cur = Math.min(Math.max(1, s.page || 1), total);
  let start = Math.max(cur - Math.floor(SEARCH_PAGE_WIN / 2), 1);
  start = Math.min(start, Math.max(1, total - SEARCH_PAGE_WIN + 1));
  const end = Math.min(total, start + SEARCH_PAGE_WIN - 1);

  box.innerHTML = '';

  const mk = (label, page, opts) => {
    const o = opts || {};
    const b = document.createElement('button');
    b.className = 'pg-btn' + (o.on ? ' on' : '');
    b.textContent = label;
    if (o.disabled) b.disabled = true;
    else b.addEventListener('click', () => gotoSearchPage(page));
    return b;
  };

  box.appendChild(mk('上一页', cur - 1, { disabled: cur <= 1 }));
  for (let p = start; p <= end; p++) box.appendChild(mk(String(p), p, { on: p === cur }));
  box.appendChild(mk('下一页', cur + 1, { disabled: cur >= total }));

  const info = document.createElement('span');
  info.className = 'pg-info';
  info.textContent = `第 ${cur} / ${total} 页`;
  box.appendChild(info);

  box.hidden = false;
}

/** 翻到搜索结果的第 n 页：点页码时才真的去请求 B 站 */
async function gotoSearchPage(n) {
  const s = state.search;
  if (!s || !s.keyword || searching) return;
  const total = s.pages || 0;
  const page = Math.max(1, Math.min(Number(n) || 1, total || 1));
  if (page === (s.page || 1) && state.tracks.length) return; // 点的是当前页

  searching = true;
  const prevPage = s.page || 1;
  $('#favSub').textContent = `正在读取第 ${page} 页…`;

  try {
    const data = await api(`/api/search?keyword=${encodeURIComponent(s.keyword)}&page=${page}`);
    if (!data.ok) throw new Error(data.error || '搜索失败');
    // 这期间退出搜索 / 换了关键词：这次结果作废
    if (state.listMode !== 'search' || !state.search || state.search.keyword !== s.keyword) return;

    state.search = data;
    state.tracks = data.tracks || [];
    state.query = '';
    state.playingIndex = state.playingTrack
      ? state.tracks.findIndex((t) => t.bvid === state.playingTrack.bvid)
      : -1;
    state.shuffleQueue = [];
    state.shufflePos = -1;
    rebuildView();

    const count = state.tracks.length;
    $('#favSub').textContent =
      `B站搜索 · 第 ${data.page || page} 页 · ${count} 首` +
      (data.total ? ` · 共约 ${data.total} 个结果` : '');
    showSearchBar(searchBarText());
    if (!count) toast('这一页没有结果', 1800);

    // 翻页后回到顶部
    const pane = $('.list-pane');
    if (pane) pane.scrollTop = 0;

    enrichSearchSeasons();
  } catch (e) {
    state.search.page = prevPage; // 失败保持原页码，分页条不要跳
    renderSearchPager();
    toast('翻页失败：' + e.message, 3000);
  } finally {
    searching = false;
  }
}

/**
 * 在 B 站搜视频，只取第一页（20 条）。
 * 结果临时替换列表：state.tracks 换成搜索结果，收藏夹现场存进 folderSnapshot，
 * 「返回列表」时原样还原 —— 搜索不写 library.json，也不动用户的收藏夹。
 */
async function doSearch(rawKeyword) {
  const kw = String(rawKeyword || '').trim();
  if (!kw) {
    toast('先输入要搜的内容', 1600);
    return;
  }
  if (searching) return;
  searching = true;

  // 第一次进搜索时记下收藏夹现场
  if (state.listMode !== 'search') {
    state.folderSnapshot = {
      mediaId: state.mediaId,
      info: state.info,
      tracks: state.tracks,
      query: state.query,
      title: $('#favTitle').textContent,
      sub: $('#favSub').textContent,
      cover: (state.info && state.info.cover) || '',
    };
  }

  state.listMode = 'search';
  state.search = { keyword: kw, page: 1, total: 0, pages: 0 };
  $('#searchInput').value = kw;
  $('#favTitle').textContent = `搜索：${kw}`;
  $('#favSub').textContent = '正在从 B 站搜索…';
  showSearchBar(`正在搜索「${kw}」…`);
  showSkeleton();

  try {
    const data = await api(`/api/search?keyword=${encodeURIComponent(kw)}&page=1`);
    if (!data.ok) throw new Error(data.error || '搜索失败');

    state.search = data;
    state.tracks = data.tracks || [];
    state.query = ''; // 搜索结果整页给出，不做本地二次过滤
    // 正在播的那首通常不在结果里，playingIndex 归 -1；播放本身不受影响
    state.playingIndex = state.playingTrack
      ? state.tracks.findIndex((t) => t.bvid === state.playingTrack.bvid)
      : -1;
    state.shuffleQueue = [];
    state.shufflePos = -1;
    rebuildView();

    const n = state.tracks.length;
    $('#favSub').textContent =
      `B站搜索 · 第 1 页 · ${n} 首` + (data.total ? ` · 共约 ${data.total} 个结果` : '');
    showSearchBar(searchBarText());
    if (!n) toast(`B 站没搜到「${kw}」`, 2200);
    enrichSearchSeasons(); // 后台补「这条属于哪个合集」，补完会自动重画一次
  } catch (e) {
    state.search = { keyword: kw, page: 1, total: 0, pages: 0 };
    state.tracks = [];
    state.playingIndex = -1;
    rebuildView();
    $('#favSub').textContent = '搜索失败';
    showSearchBar(`搜索「${kw}」失败：${e.message}`);
    toast('搜索失败：' + e.message, 3200);
  } finally {
    searching = false;
  }
}

/**
 * 搜索结果里哪些视频属于某个合集：B 站搜索接口不给这个信息，
 * 后台逐条问一次（服务端带缓存 + 限速），回来后在列表/卡片上打「合集」标，
 * 右键也就多出「导入整个合集」。
 */
let seasonEnrichToken = 0;

async function enrichSearchSeasons() {
  if (state.listMode !== 'search') return;
  const token = ++seasonEnrichToken;
  const keyword = (state.search && state.search.keyword) || '';
  const bvids = state.tracks
    .filter((t) => t.bvid && !t.seasonChecked)
    .map((t) => t.bvid)
    .slice(0, 20);
  if (!bvids.length) return;

  try {
    const j = await api(`/api/seasons?bvids=${encodeURIComponent(bvids.join(','))}`);
    if (!j.ok) return;
    // 这期间又搜了别的 / 已经退出搜索：结果作废
    if (token !== seasonEnrichToken) return;
    if (state.listMode !== 'search' || ((state.search && state.search.keyword) || '') !== keyword) return;

    let changed = false;
    for (const t of state.tracks) {
      if (!Object.prototype.hasOwnProperty.call(j.map, t.bvid)) continue;
      const s = j.map[t.bvid];
      t.seasonChecked = true;
      if (s) {
        t.seasonId = s.seasonId;
        t.seasonMid = s.mid;
        t.seasonTitle = s.title || '合集';
        t.seasonCover = s.cover || '';
        changed = true;
      }
    }
    if (changed) renderCurrent();
  } catch {
    /* 补不上就算了，不影响播放 */
  }
}

/** 右键「导入整个合集」：把这个视频所在的合集当歌单加进侧栏 */
async function importSeasonOfTrack(t) {
  if (!t || !t.seasonId || !t.seasonMid) return;
  try {
    await addSeason({ mid: String(t.seasonMid), seasonId: String(t.seasonId) }, { keepView: true });
  } catch (e) {
    toast('导入合集失败：' + e.message, 3200);
  }
}

/** 退出搜索视图并还原收藏夹现场（纯内存还原，不重新请求网络） */
function exitSearch() {
  if (state.listMode !== 'search') return;
  state.listMode = 'folder';
  const snap = state.folderSnapshot;
  state.folderSnapshot = null;
  state.search = null;
  hideSearchBar();

  if (snap) {
    state.mediaId = snap.mediaId;
    state.info = snap.info;
    state.tracks = snap.tracks || [];
    state.query = snap.query || '';
    $('#searchInput').value = state.query;
    $('#favTitle').textContent = snap.title;
    $('#favSub').textContent = snap.sub;
    $('#favCover').style.backgroundImage = snap.cover ? `url('${imgUrl(snap.cover, '@120w_120h_1c')}')` : '';
  } else {
    state.tracks = [];
    state.query = '';
    $('#searchInput').value = '';
  }

  // 播放中的那首如果恰好在新列表里，接着高亮它；不在就只是不高亮
  state.playingIndex = state.playingTrack
    ? state.tracks.findIndex((t) => t.bvid === state.playingTrack.bvid)
    : -1;
  state.shuffleQueue = [];
  state.shufflePos = -1;
  rebuildView();
  renderFolders();
}

/** 静默离开搜索：用户直接点了别的收藏夹，搜索现场就不要了 */
function leaveSearch() {
  if (state.listMode !== 'search') return;
  state.listMode = 'folder';
  state.folderSnapshot = null;
  state.search = null;
  state.query = '';
  hideSearchBar();
  const input = $('#searchInput');
  if (input) input.value = '';
}

/* ---------------- 右键菜单（列表 / 播放页共用） ---------------- */
let ctxTrack = null; // 右键点的是哪一首（收藏时要用到 avid 等字段）

function hideContextMenu() {
  const menu = $('#ctxMenu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  delete menu.dataset.bvid;
}

function showContextMenu(x, y, opts) {
  const menu = $('#ctxMenu');
  if (!menu) return;

  const bvid = (opts && opts.bvid) || '';
  const showMini = !!(opts && opts.mini && DESKTOP);
  ctxTrack = (opts && opts.track) || null;
  const showFav = !!(ctxTrack && ctxTrack.bvid);
  // 「移动到收藏夹」只在「当前看的就是一个 B 站收藏夹」时才给：
  // 搜索结果、合集、别的列表里的歌本来就不属于哪个收藏夹，谈不上移动
  const showMove = showFav && !!currentFavFolderId();
  // 「导入整个合集」：这首视频本身属于某个合集时才有
  const showSeason = !!(ctxTrack && ctxTrack.seasonId && ctxTrack.seasonMid);
  if (!bvid && !showMini && !showFav) return; // 没有可点的项，交给系统菜单

  menu.dataset.bvid = bvid;
  const biliItem = menu.querySelector('[data-action="open-bili"]');
  const miniItem = menu.querySelector('[data-action="open-mini"]');
  const favItem = menu.querySelector('[data-action="add-fav"]');
  const moveItem = menu.querySelector('[data-action="move-fav"]');
  const seasonItem = menu.querySelector('[data-action="import-season"]');
  const videoItem = menu.querySelector('[data-action="open-video"]');
  if (biliItem) biliItem.hidden = !bvid;
  if (videoItem) videoItem.hidden = !showFav;
  if (miniItem) miniItem.hidden = !showMini;
  if (favItem) favItem.hidden = !showFav;
  if (moveItem) moveItem.hidden = !showMove;
  if (seasonItem) {
    seasonItem.hidden = !showSeason;
    if (showSeason) seasonItem.title = ctxTrack.seasonTitle || '';
  }

  menu.hidden = false;

  // 先显示再量尺寸，避免菜单在窗口右下角被裁掉
  const rect = menu.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad));
  const top = Math.max(pad, Math.min(y, window.innerHeight - rect.height - pad));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function initContextMenu() {
  const menu = $('#ctxMenu');
  if (!menu) return;

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.ctx-item');
    if (!item || item.hidden) return;
    const action = item.dataset.action;
    const bvid = menu.dataset.bvid;
    const track = ctxTrack;
    hideContextMenu();

    if (action === 'open-bili' && bvid) {
      // 桌面端由主进程 setWindowOpenHandler 转给系统浏览器
      window.open(`https://www.bilibili.com/video/${encodeURIComponent(bvid)}`, '_blank', 'noopener');
    } else if (action === 'open-video' && track) {
      // 直接进放大视图的「视频 + 评论」模式
      if (!currentTrack() || currentTrack().bvid !== track.bvid) {
        // 不是当前在播的这首：先播它，再开视频
        const idx = state.tracks.findIndex((x) => x.bvid === track.bvid);
        if (idx >= 0 && !state.tracks[idx].dead) playAt(idx);
        else {
          state.queue = [{ ...track }];
          queuePlayAt(0);
        }
      }
      openNp();
      setVideoMode(true);
      openComments();
    } else if (action === 'open-mini' && DESKTOP) {
      DESKTOP.openMini();
    } else if (action === 'add-fav') {
      openFavPicker(track);
    } else if (action === 'move-fav') {
      openFavPicker(track, { mode: 'move', fromFolderId: currentFavFolderId() });
    } else if (action === 'import-season') {
      importSeasonOfTrack(track);
    } else if (action === 'play-now' && track) {
      // 立即播放：打断当前，切到这首；在当前列表里就按列表方式播（高亮一致），
      // 不在列表里（搜索结果）就通过队列播
      const idx = state.tracks.findIndex((x) => x.bvid === track.bvid);
      if (idx >= 0 && !state.tracks[idx].dead) {
        playAt(idx);
      } else if (state.queue.length) {
        state.queue.splice(0, 1, { ...track }); // 队首换成它，待播保留
        queuePlayAt(0);
      } else {
        state.queue = [{ ...track }];
        queuePlayAt(0);
      }
    } else if (action === 'play-next' && track) {
      if (queueAdd(track, 1)) toast('已插到下一曲播放', 1600);
      else toast('已经在播放列表里了', 1600);
    } else if (action === 'add-queue' && track) {
      if (queueAdd(track)) toast('已加入播放列表', 1600);
      else toast('已经在播放列表里了', 1600);
    }
  });

  // 播放页右键：网页端只有「在浏览器中打开」，桌面端多一个「悬浮窗」
  npView.addEventListener('contextmenu', (e) => {
    const t = currentTrack();
    const bvid = t ? t.bvid : '';
    if (!bvid && !DESKTOP) return; // 纯网页没有可选项，保留系统菜单
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, { bvid, mini: true, track: t });
  });

  document.addEventListener('mousedown', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) hideContextMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) hideContextMenu();
  });
  window.addEventListener('blur', hideContextMenu);
  window.addEventListener('resize', hideContextMenu);
  window.addEventListener('scroll', hideContextMenu, true);
}

initContextMenu();

/* ---------------- 主页面空白处右键（桌面端）：缩小为悬浮窗 / 悬浮球 ---------------- */
function initPageContextMenu() {
  const menu = $('#pageCtxMenu');
  if (!menu || !DESKTOP) return;

  document.addEventListener('contextmenu', (e) => {
    // 曲目行、卡片、播放页自己已经处理过（preventDefault），这里不重复弹
    if (e.defaultPrevented) return;
    if (e.target.closest('input, textarea, [contenteditable="true"]')) return;
    if (e.target.closest('.ctx-menu, .queue-panel, .modal')) return;
    e.preventDefault();
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    const pad = 8;
    menu.style.left = `${Math.max(pad, Math.min(e.clientX, window.innerWidth - rect.width - pad))}px`;
    menu.style.top = `${Math.max(pad, Math.min(e.clientY, window.innerHeight - rect.height - pad))}px`;
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.ctx-item');
    if (!item) return;
    const action = item.dataset.action;
    menu.hidden = true;
    if (action === 'mini-card') DESKTOP.openMini();
    else if (action === 'mini-ball' && DESKTOP.openMiniBall) DESKTOP.openMiniBall();
  });

  document.addEventListener('mousedown', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') menu.hidden = true;
  });
  window.addEventListener('blur', () => { menu.hidden = true; });
  window.addEventListener('scroll', () => { menu.hidden = true; }, true);
}

initPageContextMenu();

/* ---------------- B 站登录（扫码） ---------------- */

let qrKey = null;
let qrTimer = null;

/** 把昵称/头像记在本机：服务端一时连不上时，界面不至于突然显示「未登录」 */
function rememberUser(u) {
  try {
    if (u && u.mid) localStorage.setItem(LS.user, JSON.stringify({ mid: u.mid, uname: u.uname, face: u.face }));
    else localStorage.removeItem(LS.user);
  } catch {
    /* 隐私模式写不进去，无所谓 */
  }
}

function cachedUser() {
  try {
    const u = JSON.parse(localStorage.getItem(LS.user) || 'null');
    return u && u.mid ? u : null;
  } catch {
    return null;
  }
}

function renderAccount() {
  const btn = $('#acctBtn');
  if (!btn) return;
  const u = state.user;
  btn.title = u ? `已登录：${u.uname}（点击切换账号）` : '登录 B 站 / 切换账号';
  btn.classList.toggle('on', !!u);
  if (u && u.face) {
    btn.classList.add('has-avatar');
    btn.style.backgroundImage = `url('${imgUrl(u.face, '@80w_80h_1c')}')`;
  } else {
    btn.classList.remove('has-avatar');
    btn.style.backgroundImage = '';
  }
}

function stopQrPolling() {
  if (qrTimer) {
    clearInterval(qrTimer);
    qrTimer = null;
  }
}

/** 把登录二维码画成 SVG（用 public/qr.js，纯本地生成，不经过任何第三方） */
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}

function renderLoginState() {
  const logged = !!state.user;
  $('#qrBox').hidden = logged;
  $('#qrStatus').hidden = logged;
  $('#loginUser').hidden = !logged;
  $('#loginRefresh').hidden = logged;
  $('#loginLogout').hidden = !logged;

  // 已登录时，这个弹窗就是「账号 + 导入页」
  const imp = $('#acctImport');
  if (imp) imp.hidden = !logged;
  const impBtn = $('#acctImportBtn');
  if (impBtn) impBtn.hidden = !logged;

  if (logged) {
    $('#loginName').textContent = state.user.uname || '已登录';
    $('#loginAvatar').style.backgroundImage = state.user.face
      ? `url('${imgUrl(state.user.face, '@120w_120h_1c')}')`
      : '';
  }
}

async function refreshQr() {
  stopQrPolling();
  const box = $('#qrBox');
  box.innerHTML = '<div class="qr-loading">正在获取二维码…</div>';
  $('#qrStatus').textContent = '请用 B 站手机客户端扫码';
  try {
    const j = await api('/api/login/qr');
    if (!j.ok) throw new Error(j.error || '获取二维码失败');
    qrKey = j.key;
    box.innerHTML = qrSvg(j.url);
    qrTimer = setInterval(pollQr, 2000);
  } catch (e) {
    qrKey = null;
    box.innerHTML = `<div class="qr-loading">获取失败：${escapeHtml(e.message)}</div>`;
    $('#qrStatus').textContent = '点「刷新二维码」重试';
  }
}

async function pollQr() {
  if (!qrKey) return;
  let j;
  try {
    j = await api(`/api/login/poll?key=${encodeURIComponent(qrKey)}`);
  } catch {
    return; // 网络抖一下，下一轮继续
  }
  if (j.status === 'scanned') {
    $('#qrStatus').textContent = '已扫码，请在手机上点确认';
    return;
  }
  if (j.status === 'expired') {
    stopQrPolling();
    qrKey = null;
    $('#qrStatus').textContent = '二维码已过期，点「刷新二维码」';
    return;
  }
  if (j.status === 'success') {
    stopQrPolling();
    qrKey = null;
    const prevMid = state.user && state.user.mid;
    state.user = j.user;
    rememberUser(state.user);
    renderAccount();
    renderLoginState();
    toast(`已登录：${j.user.uname}`, 2200);

    // 切到这个账号：之后所有请求都带着它的 mid，数据各自独立
    const mid = j.user && j.user.mid;
    const changed = !!(mid && mid !== prevMid);
    if (mid) {
      setCurrentUserId(mid);
      try {
        fetch('/api/users/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mid }),
        });
      } catch {}
    }

    if (!$('#favPickModal').hidden) loadFavFolders();
    if (!$('#modal').hidden && modalTab === 'mine') loadMineFolders();
    if (!$('#loginModal').hidden) loadAcctFolders();
    setTimeout(() => {
      if (!$('#loginModal').hidden) closeLogin();
      // 换了个账号：重新载入，让收藏夹/进度/历史都换成这个账号的
      if (changed) location.reload();
    }, 900);
    return;
  }
  if (j.status === 'error') {
    stopQrPolling();
    qrKey = null;
    $('#qrStatus').textContent = j.error || j.message || '登录失败';
  }
}

function openLogin() {
  $('#loginModal').hidden = false;
  renderLoginState();
  if (!state.user) {
    refreshQr();
  } else {
    stopQrPolling();
    loadAcctFolders(); // 已登录：直接列出自己的收藏夹，勾选就能导入
  }
}

function closeLogin() {
  stopQrPolling();
  $('#loginModal').hidden = true;
}

if ($('#acctBtn')) $('#acctBtn').addEventListener('click', openUserMenu);

/* ---------------- 账号切换菜单 ---------------- */

function positionUserMenu(menu, btn) {
  const r = btn.getBoundingClientRect();
  const rect = menu.getBoundingClientRect();
  const pad = 8;
  let left = r.right - rect.width;
  left = Math.max(pad, Math.min(left, window.innerWidth - rect.width - pad));
  let top = r.bottom + 8;
  if (top + rect.height > window.innerHeight - pad) top = Math.max(pad, r.top - rect.height - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function renderUserList(j) {
  const list = $('#userList');
  if (!list) return;
  list.innerHTML = '';
  const cur = j.current;
  const users = j.users || [];

  for (const u of users) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'um-item' + (u.mid === cur ? ' on' : '');

    const av = document.createElement('div');
    av.className = 'um-avatar';
    if (u.face) av.style.backgroundImage = `url('${imgUrl(u.face, '@80w_80h_1c')}')`;
    row.appendChild(av);

    const txt = document.createElement('div');
    txt.className = 'um-text';
    const name = document.createElement('div');
    name.className = 'um-name';
    name.textContent = u.uname || (u.guest ? '未登录' : u.mid);
    const sub = document.createElement('div');
    sub.className = 'um-sub';
    sub.textContent = u.guest
      ? '不登录 B 站，导入的列表也存在这里'
      : u.loggedIn
      ? `mid ${u.mid}`
      : `mid ${u.mid} · 登录已失效`;
    txt.appendChild(name);
    txt.appendChild(sub);
    row.appendChild(txt);

    if (u.mid === cur) {
      const tag = document.createElement('span');
      tag.className = 'um-cur';
      tag.textContent = '✓';
      row.appendChild(tag);
    }

    row.addEventListener('click', () => switchUser(u.mid));
    list.appendChild(row);
  }

  const logout = $('#userLogout');
  const me = users.find((u) => u.mid === cur);
  if (logout) logout.hidden = !me || !me.loggedIn;
}

async function openUserMenu() {
  const menu = $('#userMenu');
  const btn = $('#acctBtn');
  if (!menu || !btn) return;
  if (!menu.hidden) {
    menu.hidden = true;
    return;
  }

  menu.hidden = false;
  const list = $('#userList');
  list.innerHTML = '<div class="um-loading">正在读取…</div>';
  positionUserMenu(menu, btn);

  try {
    const j = await api('/api/users');
    if (!j.ok) throw new Error(j.error || '读取失败');
    renderUserList(j);
  } catch (e) {
    list.innerHTML = `<div class="um-loading">读取失败：${escapeHtml(e.message)}</div>`;
  }
  positionUserMenu(menu, btn);
}

function hideUserMenu() {
  const menu = $('#userMenu');
  if (menu) menu.hidden = true;
}

/** 切换账号：记住选择 → 通知服务端默认账号 → 重载页面 */
async function switchUser(mid) {
  hideUserMenu();
  setCurrentUserId(mid);
  rememberUser(null); // 清掉上一个账号的昵称/头像缓存，避免切过去还闪一下旧头像
  try {
    await fetch('/api/users/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mid }),
    });
  } catch {
    /* 服务端没记上也无所谓，本机 localStorage 已经生效 */
  }
  location.reload();
}

$('#userAdd') && $('#userAdd').addEventListener('click', () => {
  hideUserMenu();
  openLogin();
});

$('#userLogout') &&
  $('#userLogout').addEventListener('click', async () => {
    hideUserMenu();
    if (!confirm('退出这个账号的 B 站登录？\n收藏夹列表、播放历史都会保留。')) return;
    try {
      await fetch('/api/users/logout', {
        method: 'POST',
        headers: userHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ mid: currentUserId() }),
      });
      rememberUser(null);
      location.reload();
    } catch (e) {
      toast('退出失败：' + e.message, 2600);
    }
  });

document.addEventListener('mousedown', (e) => {
  const menu = $('#userMenu');
  if (!menu || menu.hidden) return;
  if (menu.contains(e.target) || (e.target.closest && e.target.closest('#acctBtn'))) return;
  hideUserMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideUserMenu();
});
window.addEventListener('blur', hideUserMenu);
if ($('#loginClose')) $('#loginClose').addEventListener('click', closeLogin);
if ($('#loginRefresh')) $('#loginRefresh').addEventListener('click', refreshQr);
if ($('#loginModal')) {
  $('#loginModal').addEventListener('click', (e) => {
    if (e.target.id === 'loginModal') closeLogin();
  });
}
if ($('#loginLogout')) {
  $('#loginLogout').addEventListener('click', async () => {
    try {
      await fetch('/api/login/logout', { method: 'POST', headers: userHeaders() });
    } catch {
      /* 忽略：本地照样清掉界面状态 */
    }
    state.user = null;
    rememberUser(null);
    renderAccount();
    renderLoginState();
    toast('已退出登录', 1600);
    if (!$('#modal').hidden && modalTab === 'mine') loadMineFolders();
    if (!$('#favPickModal').hidden) loadFavFolders();
    refreshQr();
  });
}

/* ---------------- 添加到收藏夹 / 移动到收藏夹 ---------------- */

let favPickTrack = null;
let favPickMode = 'add'; // add | move
let favPickFrom = ''; // move 时的源收藏夹 ID

/** 当前列表如果是「B 站收藏夹」，返回它的 ID；搜索结果 / 合集 / 其它都返回 '' */
function currentFavFolderId() {
  if (state.listMode !== 'folder') return '';
  const id = String(state.mediaId || '');
  return /^\d+$/.test(id) ? id : '';
}

function closeFavPicker() {
  $('#favPickModal').hidden = true;
  $('#favPickErr').hidden = true;
  favPickTrack = null;
  favPickMode = 'add';
  favPickFrom = '';
}

async function openFavPicker(track, opts = {}) {
  if (!track || !track.bvid) return;
  favPickTrack = track;
  favPickMode = opts.mode === 'move' ? 'move' : 'add';
  favPickFrom = favPickMode === 'move' ? String(opts.fromFolderId || '') : '';
  $('#favPickTitle').textContent = favPickMode === 'move' ? '移动到收藏夹' : '添加到收藏夹';
  $('#favPickTrack').textContent = track.title || '';
  $('#favPickErr').hidden = true;
  $('#favPickLogin').hidden = !!state.user;
  $('#favPickModal').hidden = false;
  await loadFavFolders();
}

async function loadFavFolders() {
  const box = $('#favPickList');
  if (!state.user) {
    box.innerHTML =
      '<div class="favpick-empty">登录 B 站后，才能把这首歌收藏进<b>你自己的</b>收藏夹</div>';
    $('#favPickLogin').hidden = false;
    return;
  }
  $('#favPickLogin').hidden = true;
  box.innerHTML = '<div class="favpick-empty">正在读取你的收藏夹…</div>';
  try {
    const j = await api('/api/my/favs');
    if (!j.ok) throw new Error(j.error || '读取收藏夹失败');
    // 移动时不能选「当前所在的那个夹子」
    const folders = (j.folders || []).filter((f) => !(favPickMode === 'move' && String(f.id) === favPickFrom));
    if (!folders.length) {
      box.innerHTML =
        favPickMode === 'move'
          ? '<div class="favpick-empty">你只有一个收藏夹，先去「+」里新建一个再移动</div>'
          : '<div class="favpick-empty">你还没有创建过收藏夹，先去 B 站建一个吧</div>';
      return;
    }
    box.innerHTML = '';
    for (const f of folders) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'favpick-item';
      el.innerHTML = `
        <div class="favpick-cover"${f.cover ? ` style="background-image:url('${imgUrl(f.cover, '@80w_80h_1c')}')"` : ''}></div>
        <div class="favpick-body">
          <div class="favpick-name">${escapeHtml(f.title)}${
        f.isPrivate ? '<span class="favpick-tag">私密</span>' : ''
      }</div>
          <div class="favpick-count">${f.count} 首</div>
        </div>`;
      el.addEventListener('click', () => addToFavFolder(f));
      box.appendChild(el);
    }
  } catch (e) {
    if (/登录/.test(e.message)) {
      state.user = null;
      renderAccount();
      $('#favPickLogin').hidden = false;
    }
    box.innerHTML = `<div class="favpick-empty">${escapeHtml(e.message)}</div>`;
  }
}

/** 移动成功后，把这首从当前列表里摘掉（歌还归 B 站那边管，界面得跟上） */
function dropTrackFromCurrentList(track) {
  const idx = state.tracks.findIndex((x) => x.bvid === track.bvid);
  if (idx < 0) return;
  state.tracks.splice(idx, 1);
  state.playingIndex = state.playingTrack
    ? state.tracks.findIndex((x) => x.bvid === state.playingTrack.bvid)
    : -1;
  state.shuffleQueue = [];
  state.shufflePos = -1;
  rebuildView();

  const n = state.tracks.filter((t) => !t.dead).length;
  if (state.info) state.info.count = n;
  $('#favSub').textContent = `${n} 首 · ${(state.info && state.info.upper) || '我的收藏夹'} · 刚刚更新`;
}

async function addToFavFolder(folder) {
  const t = favPickTrack;
  if (!t) return;
  const moving = favPickMode === 'move';
  const from = favPickFrom;
  const box = $('#favPickList');
  box.querySelectorAll('button').forEach((b) => {
    b.disabled = true;
  });
  $('#favPickErr').hidden = true;

  try {
    const r = await fetch('/api/fav/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bvid: t.bvid,
        avid: t.avid,
        folderId: folder.id,
        fromFolderId: moving ? from : '',
      }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '收藏失败');
    closeFavPicker();

    // B 站 code=0 就是成功（它的 success_num 永远是 0，不能拿来判断）
    toast(moving ? `已移动到「${folder.title}」` : `已收藏到「${folder.title}」`, 2400);

    // 侧栏数量跟着变
    const bump = (id, delta) => {
      const rec = state.folders.find((f) => String(f.mediaId) === String(id));
      if (rec) rec.count = Math.max(0, (rec.count || 0) + delta);
    };
    bump(folder.id, 1);
    if (moving) {
      bump(from, -1);
      if (String(state.mediaId) === from) dropTrackFromCurrentList(t);
    }
    persist();
    renderFolders();
  } catch (e) {
    box.querySelectorAll('button').forEach((b) => {
      b.disabled = false;
    });
    const err = $('#favPickErr');
    err.hidden = false;
    err.textContent = e.message;
    if (/登录/.test(e.message)) {
      state.user = null;
      renderAccount();
      $('#favPickLogin').hidden = false;
    }
  }
}

if ($('#favPickCancel')) $('#favPickCancel').addEventListener('click', closeFavPicker);
if ($('#favPickLogin')) {
  $('#favPickLogin').addEventListener('click', () => {
    openLogin();
  });
}
if ($('#favPickModal')) {
  $('#favPickModal').addEventListener('click', (e) => {
    if (e.target.id === 'favPickModal') closeFavPicker();
  });
}

/** 只更新某一行的播放状态，避免整表重绘（列表长了会卡） */
function refreshActiveRow() {
  document.querySelectorAll('.track').forEach((el) => {
    const ti = Number(el.dataset.idx);
    const active = ti === state.playingIndex;
    el.classList.toggle('active', active);
    const idxCell = el.querySelector('.t-idx');
    if (active) {
      idxCell.innerHTML = `<div class="bars${audio.paused ? ' paused' : ''}"><i></i><i></i><i></i></div>`;
    } else {
      const pos = state.view.indexOf(ti);
      idxCell.textContent = pos >= 0 ? String(pos + 1) : '';
    }
  });
}

/** 播放状态变了：列表视图只改一行，卡片视图（一页最多 24 个）整页重画更省事 */
function refreshActiveUI() {
  if (state.viewMode === 'card') {
    renderCards();
    return;
  }
  refreshActiveRow();
}

/* ---------------- 播放控制 ---------------- */
/**
 * 正在播放的那首。
 * 以 state.playingTrack 为准而不是 playingIndex：列表可以换成搜索结果 / 别的收藏夹，
 * 但正在响的那首不能因此变成 null（否则进度、历史、悬浮窗全断）。
 */
function currentTrack() {
  if (state.playingTrack) return state.playingTrack;
  return state.playingIndex >= 0 ? state.tracks[state.playingIndex] : null;
}

/* ---------------- 手动播放列表（队列） ---------------- */

/** 入队。at = 1 表示插到当前播放之后（「下一曲播放」），不传则追加队尾。
 *  只入队不开播——不打断当前正在播的这首。 */
function queueAdd(track, at) {
  if (!track || !track.bvid) return false;
  // 已经在队列里的就不重复加（按 bvid 去重）
  if (state.queue.some((q) => q.bvid === track.bvid)) return false;
  const copy = { ...track };
  if (at === 1 && state.queue.length) {
    state.queue.splice(1, 0, copy); // [0] 是正在播的，插到它后面
  } else {
    state.queue.push(copy);
  }
  renderQueuePanel();
  return true;
}

/** 播队列里的第 i 首。队列模式下 queue[0] 始终代表「当前这首」 */
function queuePlayAt(i) {
  const t = state.queue[i];
  if (!t) return;
  // 播放队列和当前视图解耦：直接借用 playAt 的播放逻辑，
  // 但 playAt 只认 state.tracks 下标，所以走一个代理：临时把
  // playingTrack 设为目标，然后用 queueStep 接管 ended/下一首。
  playQueuedTrack(t);
}

/** 队列专用播放：不走 playAt（它依赖 state.tracks 下标），自己设 src */
function playQueuedTrack(t) {
  if (!t || !t.bvid) return;
  if (state.playingIndex >= 0) reportProgress(true);
  histEnd();

  state.playingTrack = t;
  state.playingIndex = state.tracks.findIndex((x) => x.bvid === t.bvid); // 能对上就高亮，对不上就算了

  const cover = t.cover ? imgUrl(t.cover, '@200w_200h_1c') : '';
  $('#npCover').style.backgroundImage = cover ? `url('${cover}')` : '';
  $('#npTitle').textContent = t.title;
  refreshNowPlayingMeta();
  document.title = `${t.title} · ${t.upper || 'B站'}`;

  pendingSeek = 0;
  histBegin(t, 0);

  audio.src = `/api/audio?bvid=${encodeURIComponent(t.bvid)}`;
  audio.play().catch((e) => {
    if (e && e.name === 'AbortError') return;
    histSession = null;
    toast('播放失败：' + (e.message || '未知错误'), 3000);
  });

  localStorage.setItem(LS.lastBvid, t.bvid);
  refreshActiveUI();
  updateProgressUI(0, t.duration);
  setPlayingUI(true);
  if (!npView.hidden) renderNp();
  setTimeout(() => pushMiniState(true), 80);
  renderQueuePanel();
}

/** 播完/手动下一首时：把队首（刚播完的）移除，下一首顶上来开播 */
function queueAdvance() {
  if (!state.queue.length) return false;
  state.queue.shift();
  if (state.queue.length) {
    queuePlayAt(0);
    return true;
  }
  return false;
}

/** 队列模式下删除第 i 首（正在播的不给删） */
function queueRemove(i) {
  if (i <= 0 || i >= state.queue.length) return;
  state.queue.splice(i, 1);
  renderQueuePanel();
}

function queueClearAll() {
  // 保留正在播的那首（queue[0]），其余全清
  if (state.queue.length) state.queue = [state.queue[0]];
  renderQueuePanel();
}

function renderQueuePanel() {
  const panel = $('#queuePanel');
  const list = $('#queueList');
  const count = $('#queueCount');
  if (!panel || !list) return;
  count.textContent = state.queue.length ? `${state.queue.length} 首` : '';
  $('#queueClear').hidden = state.queue.length <= 1;

  list.innerHTML = '';
  if (!state.queue.length) {
    const empty = document.createElement('div');
    empty.className = 'queue-empty';
    empty.textContent = '播放列表是空的。右键歌曲 →「添加到播放列表」试试';
    list.appendChild(empty);
    return;
  }
  state.queue.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'queue-row' + (i === 0 ? ' now' : '');
    row.draggable = i > 0;
    row.dataset.i = i;
    row.dataset.bvid = t.bvid || '';

    const cover = document.createElement('div');
    cover.className = 'q-cover';
    cover.style.backgroundImage = t.cover ? `url('${imgUrl(t.cover, '@120w_120h_1c')}')` : '';
    row.appendChild(cover);

    const text = document.createElement('div');
    text.className = 'q-text';
    const title = document.createElement('div');
    title.className = 'q-title';
    title.textContent = t.title || '(无标题)';
    const sub = document.createElement('div');
    sub.className = 'q-sub';
    sub.textContent = t.upper || '';
    text.appendChild(title);
    text.appendChild(sub);
    row.appendChild(text);

    // 每首的码率（查过的立刻有值，没查过的显示 …，后台会补上）
    const br = document.createElement('span');
    br.className = 'q-br';
    br.textContent = bitrateText(t) || '…';
    row.appendChild(br);

    if (i === 0) {
      const tag = document.createElement('span');
      tag.className = 'q-now-tag';
      tag.textContent = '正在播';
      row.appendChild(tag);
    } else {
      const del = document.createElement('button');
      del.className = 'q-del';
      del.title = '从列表移除';
      del.textContent = '✕';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        queueRemove(i);
      });
      row.appendChild(del);
    }

    row.addEventListener('click', () => {
      if (i === 0) return;
      // 点队列中某首：把它之前的（不含队首）全部移除，它变成下一首直接播
      state.queue.splice(1, i - 1);
      queuePlayAt(1);
    });

    // 拖拽排序（队首不参与）
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(i));
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => {
      if (i === 0) return;
      e.preventDefault();
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (isNaN(from) || from <= 0 || from === i || from >= state.queue.length) return;
      const [moved] = state.queue.splice(from, 1);
      state.queue.splice(Math.max(1, i), 0, moved);
      renderQueuePanel();
    });

    list.appendChild(row);
  });

  // 队列里的每首也都要有码率
  queueBitrates(state.queue);
}

function toggleQueuePanel() {
  const panel = $('#queuePanel');
  if (!panel) return;
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderQueuePanel();
}

/* ---------------- 侧栏合集/收藏夹右键：整单入队 ---------------- */

let ctxFolder = null; // 右键点的是哪个收藏夹/合集

/** 拉一个收藏夹/合集的完整曲目列表（服务端有缓存，通常秒回） */
async function fetchFolderTracks(mediaId) {
  const season = parseSeasonKey(mediaId);
  const q = season
    ? `/api/season?mid=${encodeURIComponent(season.mid)}&season_id=${encodeURIComponent(season.seasonId)}`
    : `/api/fav?media_id=${encodeURIComponent(mediaId)}`;
  const data = await api(q);
  if (!data.ok) throw new Error(data.error || '读取失败');
  return (data.tracks || []).filter((t) => !t.dead && t.bvid);
}

/**
 * 整单入队。mode:
 *  append — 追加到队尾（跳过已在队列里的）
 *  replace — 清掉待播部分，整单变成待播（正在播的保留）
 */
async function queueFolder(mediaId, mode) {
  const f = ctxFolder;
  const name = f ? f.title : '列表';
  try {
    toast(`正在读取「${name}」…`, 2000);
    const tracks = await fetchFolderTracks(mediaId);
    if (!tracks.length) return toast('这个列表里没有能播的歌', 2200);

    if (mode === 'replace') {
      // 保留正在播的（queue[0]），其余换掉；没有任何在播的就直接开播第一首
      const cur = state.queue.length ? state.queue[0] : null;
      state.queue = cur ? [cur, ...tracks] : [...tracks];
      if (!cur && !hasLoaded()) queuePlayAt(0); // 什么都没在播：直接开播
      toast(`播放列表已替换为「${name}」，${tracks.length} 首`, 2600);
    } else {
      // 追加：跳过已在队列里的（按 bvid 去重）
      const have = new Set(state.queue.map((q) => q.bvid));
      const fresh = tracks.filter((t) => !have.has(t.bvid));
      if (!fresh.length) return toast('这些歌都已经在播放列表里了', 2200);
      state.queue.push(...fresh);
      // 队列原来完全是空的且没在播：直接开播第一首
      if (state.queue.length === fresh.length && !hasLoaded()) queuePlayAt(0);
      toast(`已把「${name}」的 ${fresh.length} 首加入播放列表`, 2600);
    }
    renderQueuePanel();
  } catch (e) {
    toast('操作失败：' + e.message, 3000);
  }
}

/** 侧栏条目右键菜单（复用 #ctxMenu 样式，独立小菜单） */
function showFolderContextMenu(x, y, f) {
  let menu = $('#folderCtxMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'folderCtxMenu';
    menu.className = 'ctx-menu';
    menu.hidden = true;
    menu.innerHTML = `
      <button class="ctx-item" data-action="q-append">添加到播放列表</button>
      <button class="ctx-item" data-action="q-replace">替换播放列表</button>
      <button class="ctx-item" data-action="q-open">打开列表</button>`;
    document.body.appendChild(menu);

    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.ctx-item');
      if (!item) return;
      const mediaId = menu.dataset.id;
      const mode = item.dataset.action;
      hideFolderCtxMenu();
      if (mode === 'q-append') queueFolder(mediaId, 'append');
      else if (mode === 'q-replace') queueFolder(mediaId, 'replace');
      else if (mode === 'q-open') loadFolder(mediaId);
    });

    document.addEventListener('mousedown', (e) => {
      if (!menu.hidden && !menu.contains(e.target)) hideFolderCtxMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.hidden) hideFolderCtxMenu();
    });
    window.addEventListener('blur', hideFolderCtxMenu);
    window.addEventListener('scroll', hideFolderCtxMenu, true);
  }
  ctxFolder = f;
  menu.dataset.id = f.mediaId;
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const pad = 8;
  menu.style.left = `${Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad))}px`;
  menu.style.top = `${Math.max(pad, Math.min(y, window.innerHeight - rect.height - pad))}px`;
}

function hideFolderCtxMenu() {
  const menu = $('#folderCtxMenu');
  if (menu) menu.hidden = true;
}

function playAt(trackIndex) {
  const t = state.tracks[trackIndex];
  if (!t || t.dead) return;

  // 切歌前先把上一首听到哪儿存下来
  if (state.playingIndex >= 0 && state.playingIndex !== trackIndex) reportProgress(true);
  // 上一首的播放历史也在这里结算（此时 audio.currentTime 还是上一首的）
  histEnd();

  state.playingIndex = trackIndex;
  state.playingTrack = t;

  // 手动播放列表对齐：主列表点歌 = 当前播放换成这首，队列待播部分保留
  if (state.queue.length) {
    const at = state.queue.findIndex((q) => q.bvid === t.bvid);
    if (at >= 0) state.queue.splice(0, at, t); // 队首到它之间全去掉
    else state.queue.splice(0, 1, t); // 队首换成它，后面待播的保留
    renderQueuePanel();
  }

  // 乱序模式下直接点列表里的某首：把它定位成队列中的当前位置，
  // 之后「下一首」从它往后走，「上一首」回到它前面那首
  if (state.mode === 'shuffle') {
    const at = state.shuffleQueue.indexOf(trackIndex);
    if (at >= 0) {
      state.shufflePos = at;
    } else {
      buildShuffleQueue();
      state.shufflePos = state.shuffleQueue.indexOf(trackIndex);
    }
  }

  const cover = t.cover ? imgUrl(t.cover, '@200w_200h_1c') : '';
  $('#npCover').style.backgroundImage = cover ? `url('${cover}')` : '';
  $('#npTitle').textContent = t.title;
  refreshNowPlayingMeta();
  document.title = `${t.title} · ${t.upper || 'B站'}`;

  // 上次中断的位置由 restoreLast 直接写进 pendingSeek；主动切歌一律从头播
  pendingSeek = 0;

  // 历史会话在这里就建好：play 事件触发时 audio.currentTime 可能还是上一首的
  // 位置（新 src 还没归零），拿它当基准会把 played 算成负数
  histBegin(t, pendingSeek);

  audio.src = `/api/audio?bvid=${encodeURIComponent(t.bvid)}`;
  audio.play().catch((e) => {
    // 快速切歌 / 马上暂停会让 play() 的 promise 被打断（AbortError），
    // 播放其实已经起来了，这不是失败，别弹提示也别动会话
    if (e && e.name === 'AbortError') return;
    histSession = null;
    toast('播放失败：' + (e.message || '未知错误'), 3000);
  });

  localStorage.setItem(LS.lastBvid, t.bvid);
  refreshActiveUI();
  updateProgressUI(pendingSeek, t.duration);
  setPlayingUI(true);
  if (!npView.hidden) renderNp();
  // 切歌时 play 事件不一定触发（本来就在播），单独推一次让卡片换标题
  setTimeout(() => pushMiniState(true), 80);
}

function setPlayingUI(playing) {
  $('#iconPlay').classList.toggle('hide', playing);
  $('#iconPause').classList.toggle('hide', !playing);
  $('#npIconPlay').classList.toggle('hide', playing);
  $('#npIconPause').classList.toggle('hide', !playing);
  document.querySelectorAll('.bars').forEach((b) => b.classList.toggle('paused', !playing));
  // 封面像唱片一样转，暂停就停下
  const art = $('#npArt');
  if (art) art.classList.toggle('spinning', playing);
}

/** 播放器里是否已经载入了曲目（与列表位置无关，切收藏夹后仍成立） */
function hasLoaded() {
  return !!(audio.currentSrc || audio.getAttribute('src'));
}

function togglePlay() {
  if (!hasLoaded()) {
    // 还没载入任何曲目：从当前列表第一首开始
    if (state.view.length) playAt(state.view[0]);
    return;
  }
  if (audio.paused) {
    audio.play().catch((e) => {
      if (e && e.name === 'AbortError') return; // 被切歌/暂停打断，不是真失败
      toast('播放失败：' + e.message);
    });
  } else {
    audio.pause();
  }
}

/** 生成一轮新的乱序：整个列表洗一次牌，之后按这个顺序依次播 */
function buildShuffleQueue() {
  const pool = state.view.filter((ti) => !state.tracks[ti].dead);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  state.shuffleQueue = pool;
  state.shufflePos = -1;
}

/** 队列里的这一项还能不能播（搜索过滤后可能已经不在当前列表里） */
function shuffleAlive(ti) {
  return state.view.includes(ti) && state.tracks[ti] && !state.tracks[ti].dead;
}

/**
 * 把某首歌钉到乱序队列的队首，并把它设成「当前位置」。
 * 这样「下一首」从队列第二个开始走，能完整走完一轮；
 * 而「上一首」退回队首，正好是刚才实际播的那首。
 */
function pinShuffleHead(ti) {
  const qi = state.shuffleQueue.indexOf(ti);
  if (qi < 0) return false;
  if (qi > 0) {
    state.shuffleQueue.splice(qi, 1);
    state.shuffleQueue.unshift(ti);
  }
  state.shufflePos = 0;
  return true;
}

/** 乱序的下一首：沿队列往下走；走完一轮就重新洗牌 */
function shuffleNext() {
  const skipDead = (from) => {
    let p = from;
    while (p < state.shuffleQueue.length && !shuffleAlive(state.shuffleQueue[p])) p++;
    return p;
  };

  if (!state.shuffleQueue.length || state.shufflePos < 0) buildShuffleQueue();

  let pos = skipDead(state.shufflePos + 1);

  if (pos >= state.shuffleQueue.length) {
    // 一轮播完了，重新生成乱序
    const justPlayed = state.playingIndex;
    buildShuffleQueue();
    // 刚播完这首钉在队首：新一轮第一首不会又是它，
    // 而且再点「上一首」还能退回它 —— 跨轮时也不会丢「刚才那首」
    pinShuffleHead(justPlayed);
    pos = skipDead(1);
  }

  if (pos >= state.shuffleQueue.length) return -1;
  state.shufflePos = pos;
  return state.shuffleQueue[pos];
}

/** 乱序的上一首：退回队列里的前一首 —— 也就是刚才实际播的那首 */
function shufflePrev() {
  if (!state.shuffleQueue.length || state.shufflePos < 0) return -1;
  let pos = state.shufflePos - 1;
  while (pos >= 0 && !shuffleAlive(state.shuffleQueue[pos])) pos--;
  if (pos < 0) return -1; // 已经是这一轮的第一首
  state.shufflePos = pos;
  return state.shuffleQueue[pos];
}

function step(delta) {
  if (!state.view.length && !state.queue.length) return;

  // 手动播放列表非空：下一首沿队列走，上一首回到刚播过的那首
  if (state.queue.length) {
    if (delta > 0) {
      queueAdvance();
      return;
    }
    // delta < 0：把当前这首重新插回队首要播的位置（简单做法：重播当前）
    const cur = state.queue[0];
    if (cur) {
      playQueuedTrack(cur);
      return;
    }
  }

  if (!state.view.length) return;

  // 乱序模式下「下一首」和「上一首」都沿同一个乱序队列走，
  // 所以上一首天然回到刚才实际播的那首，不会又随机抽一首新的
  if (state.mode === 'shuffle') {
    const pick = delta > 0 ? shuffleNext() : shufflePrev();
    if (pick >= 0) {
      playAt(pick);
    } else if (delta < 0) {
      toast('已经是这一轮的第一首了', 1400);
    }
    return;
  }

  let pos = state.view.indexOf(state.playingIndex);
  if (pos < 0) pos = delta > 0 ? -1 : 0;
  let next = pos + delta;
  if (next >= state.view.length) next = 0;
  if (next < 0) next = state.view.length - 1;

  // 跳过失效条目
  let guard = 0;
  while (state.tracks[state.view[next]] && state.tracks[state.view[next]].dead && guard++ < state.view.length) {
    next = (next + (delta > 0 ? 1 : -1) + state.view.length) % state.view.length;
  }
  playAt(state.view[next]);
}

/* ---------------- 进度条 ---------------- */
function totalDuration() {
  const d = audio.duration;
  if (Number.isFinite(d) && d > 0) return d;
  const t = currentTrack();
  return (t && t.duration) || 0;
}

function updateProgressUI(cur, total) {
  const tot = total || totalDuration();
  const pct = tot > 0 ? Math.min(100, (cur / tot) * 100) : 0;
  const curText = fmtTime(cur);
  const totText = fmtTime(tot);

  // 底栏
  $('#progressFill').style.width = pct + '%';
  $('#progressKnob').style.left = pct + '%';
  $('#curTime').textContent = curText;
  $('#totTime').textContent = totText;

  // 单曲大图视图（同步一份）
  const npFill = $('#npFill');
  if (npFill) {
    npFill.style.width = pct + '%';
    $('#npKnob').style.left = pct + '%';
    $('#npCur').textContent = curText;
    $('#npTot').textContent = totText;
  }
}

let progressDragging = false;

/** 底栏和大图视图的进度条共用同一套拖拽逻辑 */
function bindProgressBar(selector) {
  const root = $(selector);
  if (!root) return;

  const seekFrom = (e) => {
    const rect = root.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const tot = totalDuration();
    if (tot > 0) {
      audio.currentTime = ratio * tot;
      updateProgressUI(ratio * tot, tot);
    }
  };

  root.addEventListener('pointerdown', (e) => {
    if (!hasLoaded()) return;
    progressDragging = true;
    root.classList.add('dragging');
    try { root.setPointerCapture(e.pointerId); } catch {}
    seekFrom(e);
  });

  root.addEventListener('pointermove', (e) => {
    if (progressDragging) seekFrom(e);
  });

  const endDrag = (e) => {
    progressDragging = false;
    root.classList.remove('dragging');
    try { root.releasePointerCapture(e.pointerId); } catch {}
  };
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', () => {
    progressDragging = false;
    root.classList.remove('dragging');
  });

  root.addEventListener('keydown', (e) => {
    if (!hasLoaded()) return;
    if (e.key === 'ArrowRight') audio.currentTime = Math.min(totalDuration(), audio.currentTime + 5);
    if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
  });
}

bindProgressBar('#progress');
bindProgressBar('#npProgress');

/* ---------------- 音量 ---------------- */

// 底栏和单曲大图各有一条音量条，状态共用
const VOL_BARS = [
  { bar: '#volBar', fill: '#volFill', knob: '#volKnob', wave: '#volWave' },
  { bar: '#npVolBar', fill: '#npVolFill', knob: '#npVolKnob', wave: '#npVolWave' },
];

function applyVolume() {
  audio.volume = state.muted ? 0 : state.volume;
  const pct = state.muted ? 0 : state.volume * 100;
  const silent = state.volume === 0 || state.muted;

  for (const v of VOL_BARS) {
    const fill = $(v.fill);
    const knob = $(v.knob);
    const wave = $(v.wave);
    const bar = $(v.bar);
    if (fill) fill.style.width = pct + '%';
    if (knob) knob.style.left = pct + '%';
    if (wave) wave.style.opacity = silent ? 0.25 : 1;
    if (bar) bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  }

  localStorage.setItem(LS.volume, String(state.volume));
}

function bindVolBar(sel) {
  const bar = $(sel);
  if (!bar) return;

  let dragging = false;
  const apply = (e) => {
    const rect = bar.getBoundingClientRect();
    state.volume = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    if (state.volume > 0) state.muted = false;
    applyVolume();
  };

  bar.addEventListener('pointerdown', (e) => {
    dragging = true;
    bar.setPointerCapture(e.pointerId);
    apply(e);
  });
  bar.addEventListener('pointermove', (e) => { if (dragging) apply(e); });
  bar.addEventListener('pointerup', (e) => {
    dragging = false;
    try { bar.releasePointerCapture(e.pointerId); } catch {}
  });

  // 键盘也能调
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = e.key === 'ArrowRight' ? 0.05 : -0.05;
      state.volume = Math.min(1, Math.max(0, state.volume + step));
      if (state.volume > 0) state.muted = false;
      applyVolume();
    }
  });
}

bindVolBar('#volBar');
bindVolBar('#npVolBar');

/* ---------------- 播放模式 ---------------- */
const MODE_ORDER = ['list', 'one', 'shuffle'];
const MODE_LABEL = { list: '顺序循环', one: '单曲循环', shuffle: '随机播放' };

function setMode(mode) {
  state.mode = mode;
  $('#modeList').classList.toggle('hide', mode !== 'list');
  $('#modeOne').classList.toggle('hide', mode !== 'one');
  $('#modeShuffle').classList.toggle('hide', mode !== 'shuffle');
  $('#modeBtn').title = '播放模式：' + MODE_LABEL[mode];
  $('#modeBtn').classList.toggle('on', mode !== 'list');

  // 大图视图里的模式按钮同步
  const npMode = $('#npMode');
  if (npMode) {
    $('#npModeList').classList.toggle('hide', mode !== 'list');
    $('#npModeOne').classList.toggle('hide', mode !== 'one');
    $('#npModeShuffle').classList.toggle('hide', mode !== 'shuffle');
    npMode.title = '播放模式：' + MODE_LABEL[mode];
    npMode.classList.toggle('on', mode !== 'list');
  }

  // 换模式就丢掉旧的乱序队列，下次按新模式重新排
  state.shuffleQueue = [];
  state.shufflePos = -1;
  localStorage.setItem(LS.mode, mode);
}

function cycleMode() {
  const i = MODE_ORDER.indexOf(state.mode);
  setMode(MODE_ORDER[(i + 1) % MODE_ORDER.length]);
  toast('播放模式：' + MODE_LABEL[state.mode], 1400);
}

/* ---------------- 事件绑定 ---------------- */
$('#playBtn').addEventListener('click', togglePlay);
$('#nextBtn').addEventListener('click', () => step(1));
$('#prevBtn').addEventListener('click', () => {
  // 播过 3 秒以上，先回到开头
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  step(-1);
});

$('#modeBtn').addEventListener('click', cycleMode);

$('#muteBtn').addEventListener('click', () => {
  state.muted = !state.muted;
  applyVolume();
});

$('#shuffleAllBtn').addEventListener('click', () => {
  if (!state.view.length) return toast('列表是空的');
  setMode('shuffle');
  buildShuffleQueue(); // 整个列表洗一次牌，之后按这个顺序播
  if (!state.shuffleQueue.length) return toast('列表里没有能播的歌');
  state.shufflePos = 0;
  playAt(state.shuffleQueue[0]);
  toast('乱序播放已开启', 1400);
});

/* ---------------- 播放列表面板 ---------------- */
$('#queueBtn').addEventListener('click', toggleQueuePanel);
$('#queueClose').addEventListener('click', toggleQueuePanel);
$('#queueClear').addEventListener('click', () => {
  queueClearAll();
  toast('已清空（正在播的保留）', 1600);
});

$('#reloadBtn').addEventListener('click', () => {
  // 搜索视图下「重新加载」= 重新搜一次当前关键词
  if (state.listMode === 'search' && state.search) {
    doSearch(state.search.keyword);
    return;
  }
  if (state.mediaId) loadFolder(state.mediaId, { force: true });
});

if (DESKTOP) {
  const miniBtn = $('#miniBtn');
  if (miniBtn) {
    miniBtn.classList.remove('hide'); // 纯网页打开时这个按钮不出现
    miniBtn.addEventListener('click', () => DESKTOP.openMini());
  }

  // 卡片上的按钮走和界面完全相同的逻辑，不另开一套
  DESKTOP.onCommand((cmd) => {
    const name = typeof cmd === 'string' ? cmd : cmd && cmd.type;
    if (name === 'toggle') togglePlay();
    else if (name === 'next') step(1);
    else if (name === 'prev') step(-1);
    else if (name === 'volume') {
      const v = Number(cmd && cmd.value);
      if (Number.isFinite(v)) {
        state.volume = Math.min(1, Math.max(0, v));
        if (state.volume > 0) state.muted = false; // 拖动音量即取消静音
        applyVolume();
      }
    } else if (name === 'mute') {
      state.muted = !state.muted;
      applyVolume();
    } else if (name === 'mode') {
      const v = cmd && cmd.value;
      if (v === 'list' || v === 'one' || v === 'shuffle') setMode(v);
    } else if (name === 'queue') {
      toggleQueuePanel();
    }
    // play()/音量变化是异步的，稍等一下再回推，卡片才不会显示旧状态
    setTimeout(() => pushMiniState(true), 60);
  });
}

/* 搜索框：打字 = 过滤本地列表；回车 / 点放大镜 = 去 B 站搜第一页 */
let searchTimer = null;
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value;
  searchTimer = setTimeout(() => {
    if (state.listMode === 'search') {
      // 搜索结果里再打字 = 准备下一次搜索，回车才真的发出去
      const kw = v.trim();
      const s = state.search;
      showSearchBar(kw && s && kw !== s.keyword ? `按回车在 B 站搜索「${kw}」` : searchBarText());
      return;
    }
    state.query = v;
    rebuildView();
  }, 140);
});

$('#searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(searchTimer);
    doSearch(e.target.value);
  } else if (e.key === 'Escape') {
    // 清空搜索框；在搜索视图里等于「返回列表」
    e.target.value = '';
    if (state.listMode === 'search') {
      exitSearch();
    } else if (state.query) {
      state.query = '';
      rebuildView();
    }
  }
});

const searchGoBtn = $('#searchGoBtn');
if (searchGoBtn) {
  searchGoBtn.addEventListener('click', () => {
    const input = $('#searchInput');
    const v = input.value.trim() || (state.search && state.search.keyword) || '';
    doSearch(v);
    input.focus();
  });
}

const searchBackBtn = $('#searchBackBtn');
if (searchBackBtn) searchBackBtn.addEventListener('click', exitSearch);

/* ---------------- 主题（深色 / 白天） ---------------- */
const THEME_KEY = 'bfp.theme';

/** theme: 'dark' | 'light'。remember=false 用于启动时同步按钮，不覆盖已存的值 */
function applyTheme(theme, remember = true) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#f4f5f7' : '#0d0a10');
  const btn = $('#themeBtn');
  if (btn) {
    btn.classList.toggle('light', t === 'light');
    btn.title = t === 'light' ? '切换到夜间主题' : '切换到白天主题';
  }
  // 桌面端：原生标题栏（右上角窗口按钮那条）由主进程画，得告诉它一声
  if (DESKTOP && typeof DESKTOP.reportTheme === 'function') DESKTOP.reportTheme(t);
  if (remember) {
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* 隐私模式下写不进去，无所谓 */
    }
  }
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
}

if ($('#themeBtn')) $('#themeBtn').addEventListener('click', toggleTheme);
// 页面 head 里的内联脚本已经先设过一次，这里只是把按钮状态对上
applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark', false);

/* ---------------- 设置（放大视图的默认显示） ---------------- */

const LS_NPVIEW = 'bfp.npview'; // 'visual' 唱片+频谱 / 'video' 直接出画面
const LS_NPCMT = 'bfp.npcmt'; // '1' 放大时自动带出评论区

/** 放大视图默认看什么 */
function prefNpView() {
  try {
    return localStorage.getItem(LS_NPVIEW) === 'video' ? 'video' : 'visual';
  } catch {
    return 'visual';
  }
}

/** 放大时是否自动开评论（默认关，和加这个设置之前的行为一致） */
function prefNpComments() {
  try {
    return localStorage.getItem(LS_NPCMT) === '1';
  } catch {
    return false;
  }
}

function syncSettingsUI() {
  const v = prefNpView();
  document.querySelectorAll('#segView button').forEach((b) => b.classList.toggle('on', b.dataset.val === v));
  const c = prefNpComments() ? '1' : '0';
  document.querySelectorAll('#segCmt button').forEach((b) => b.classList.toggle('on', b.dataset.val === c));
}

function setPref(key, val) {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* 隐私模式写不进去就算了，这次会话内仍然生效 */
  }
  syncSettingsUI();
}

function hideSettings() {
  const menu = $('#setMenu');
  if (menu) menu.hidden = true;
}

function toggleSettings() {
  const menu = $('#setMenu');
  const btn = $('#settingsBtn');
  if (!menu || !btn) return;
  if (!menu.hidden) {
    menu.hidden = true;
    return;
  }
  hideUserMenu();
  menu.hidden = false;
  syncSettingsUI();
  positionUserMenu(menu, btn); // 定位逻辑和账号菜单共用一套
}

const settingsBtn = $('#settingsBtn');
if (settingsBtn) {
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSettings();
  });
}

document.querySelectorAll('#segView button').forEach((b) => {
  b.addEventListener('click', () => setPref(LS_NPVIEW, b.dataset.val));
});
document.querySelectorAll('#segCmt button').forEach((b) => {
  b.addEventListener('click', () => setPref(LS_NPCMT, b.dataset.val));
});

document.addEventListener('mousedown', (e) => {
  const menu = $('#setMenu');
  if (!menu || menu.hidden) return;
  if (menu.contains(e.target) || (e.target.closest && e.target.closest('#settingsBtn'))) return;
  menu.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideSettings();
});
window.addEventListener('resize', hideSettings);

syncSettingsUI();

// 列表 / 卡片视图切换
if ($('#viewBtn')) {
  $('#viewBtn').addEventListener('click', () => setViewMode(state.viewMode === 'card' ? 'list' : 'card'));
}

/* ---------------- 侧栏宽度可拖动 ---------------- */
const SIDE_W_KEY = 'bfp.sideW';
const SIDE_MIN = 168;
const SIDE_MAX = 460;

(function initSideResizer() {
  const root = document.documentElement;
  const bar = $('#sideResizer');
  const sidebar = document.querySelector('.sidebar');
  if (!bar || !sidebar) return;

  // 记住上次拖的宽度
  const saved = parseFloat(localStorage.getItem(SIDE_W_KEY));
  if (Number.isFinite(saved) && saved >= SIDE_MIN && saved <= SIDE_MAX) {
    root.style.setProperty('--side-w', `${Math.round(saved)}px`);
  }

  let dragging = false;
  let startX = 0;
  let startW = 0;

  const setWidth = (w) => root.style.setProperty('--side-w', `${Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, w)))}px`);

  bar.addEventListener('pointerdown', (e) => {
    if (window.innerWidth <= 720) return; // 手机上侧栏是横向条，没有可拖的竖边
    dragging = true;
    startX = e.clientX;
    startW = sidebar.getBoundingClientRect().width;
    bar.classList.add('dragging');
    document.body.classList.add('resizing');
    try {
      bar.setPointerCapture(e.pointerId);
    } catch {}
    e.preventDefault();
  });

  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    setWidth(startW + (e.clientX - startX));
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('dragging');
    document.body.classList.remove('resizing');
    try {
      bar.releasePointerCapture(e.pointerId);
    } catch {}
    try {
      localStorage.setItem(SIDE_W_KEY, String(Math.round(sidebar.getBoundingClientRect().width)));
    } catch {}
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);

  // 双击恢复默认宽度
  bar.addEventListener('dblclick', () => {
    root.style.removeProperty('--side-w');
    try {
      localStorage.removeItem(SIDE_W_KEY);
    } catch {}
  });
})();

/* audio 事件 */
audio.addEventListener('timeupdate', () => {
  if (!progressDragging) updateProgressUI(audio.currentTime, totalDuration());
  reportProgress(); // 内部有 5 秒节流
  pushMiniState(); // 内部有 900ms 节流
});

audio.addEventListener('loadedmetadata', () => {
  // 必须等元数据到了再 seek，早了会被浏览器忽略
  if (pendingSeek > 0) {
    const d = audio.duration;
    const target = Number.isFinite(d) && pendingSeek < d - 3 ? pendingSeek : 0;
    if (target > 0) audio.currentTime = target;
    pendingSeek = 0;
  }
  restoring = false;
  updateProgressUI(audio.currentTime, totalDuration());
  pushMiniState(true); // 这时才拿到真实时长，卡片上的进度条要靠它
});

audio.addEventListener('play', () => {
  // playAt 已经建好会话了；这里兜的是「点播放键接着上次那首播」这种没走 playAt 的情况
  if (!histSession) histBegin(currentTrack(), audio.currentTime || 0);
  setPlayingUI(true);
  pushMiniState(true);
});
audio.addEventListener('pause', () => {
  setPlayingUI(false);
  reportProgress(true);
  pushMiniState(true);
});
audio.addEventListener('ended', () => {
  if (state.mode === 'one' && !state.queue.length) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  // 手动播放列表非空时优先走队列
  if (queueAdvance()) return;
  step(1);
});
audio.addEventListener('error', () => {
  // 恢复上次那首时加载失败：只把播放器清空，别自动跳歌（用户还没打算播）
  if (restoring) {
    restoring = false;
    pendingSeek = 0;
    audio.removeAttribute('src');
    audio.load();
    updateProgressUI(0, 0);
    return;
  }
  if (!currentTrack()) return;
  histSession = null; // 这首放不出来，别把半截会话带到下一首
  toast('这首放不出来，跳过', 1800);
  setTimeout(() => step(1), 500);
});

/* 键盘 */
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;

  switch (e.key) {
    case 'Escape':
      if (!npView.hidden) {
        e.preventDefault();
        closeNp();
      }
      break;
    case ' ':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowRight':
      if (hasLoaded()) {
        e.preventDefault();
        audio.currentTime = Math.min(totalDuration(), audio.currentTime + 5);
      }
      break;
    case 'ArrowLeft':
      if (hasLoaded()) {
        e.preventDefault();
        audio.currentTime = Math.max(0, audio.currentTime - 5);
      }
      break;
    case 'ArrowUp':
      e.preventDefault();
      state.volume = Math.min(1, state.volume + 0.05);
      state.muted = false;
      applyVolume();
      break;
    case 'ArrowDown':
      e.preventDefault();
      state.volume = Math.max(0, state.volume - 0.05);
      applyVolume();
      break;
    case 'n':
    case 'N':
      step(1);
      break;
    case 'p':
    case 'P':
      step(-1);
      break;
    case 'm':
    case 'M':
      state.muted = !state.muted;
      applyVolume();
      break;
    case 'q':
    case 'Q':
      toggleQueuePanel();
      break;
    case 'v':
    case 'V':
      // 只在放大视图里生效，免得在列表页误触
      if (!npView.hidden) setVideoMode(!videoMode);
      break;
    case 'c':
    case 'C':
      if (!npView.hidden) (cmt.open ? hideComments() : openComments());
      break;
    default:
      break;
  }
});

/* ---------------- 播放进度同步（多端共享，精确到秒） ---------------- */

let pendingSeek = 0; // 待应用到 audio 的秒数
let lastReportAt = 0;
// 正在「静默载入上次那首」（不自动播），这期间加载失败不要自动跳歌
let restoring = false;

async function fetchLastProgress() {
  try {
    const r = await fetch('/api/progress', { headers: userHeaders() });
    const j = await r.json();
    return j && j.ok ? j : null;
  } catch {
    return null;
  }
}

/** 把当前播放位置写回服务端。force=true 时会绕过节流（暂停/切歌/关页面） */
function reportProgress(force = false) {
  const t = currentTrack();
  if (!t || !hasLoaded()) return;

  const now = Date.now();
  if (!force && now - lastReportAt < 5000) return;
  lastReportAt = now;

  const payload = JSON.stringify({
    bvid: t.bvid,
    pos: audio.currentTime,
    dur: totalDuration(),
    mediaId: listId(),
  });

  // 关页面时普通 fetch 会被浏览器掐掉，用 sendBeacon 才发得出去
  if (force && navigator.sendBeacon) {
    try {
      navigator.sendBeacon(beaconUrl('/api/progress'), new Blob([payload], { type: 'application/json' }));
      return;
    } catch {
      /* 退回 fetch */
    }
  }

  fetch('/api/progress', {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: payload,
  }).catch(() => {});
}

/* ---------------- 播放历史（每次播放记一条，带实际听了多久） ---------------- */

// 一次「播放会话」= 从开始播到切歌/关页面。中途暂停不算结束，接着播还是同一次。
let histSession = null;

function histBegin(t, fromSec) {
  if (!t) return;
  histSession = {
    bvid: t.bvid,
    title: t.title || '',
    upper: t.upper || '',
    cover: t.cover ? imgUrl(t.cover, '@120w_120h_1c') : '',
    mediaId: listId(),
    dur: t.duration || 0, // 这首歌总长
    at: Date.now(),
    base: Number(fromSec) || 0, // 这次是从第几秒开始听的
  };
}

function histEnd() {
  if (!histSession) return;
  const s = histSession;
  histSession = null;

  // currentTime 只在真正播放时前进，所以这个差值就是实际听了多久（不含暂停）
  const played = Math.round((audio.currentTime || 0) - s.base);
  if (played < 1) return; // 一秒都没听就不记

  const payload = JSON.stringify({ ...s, played });
  // 关页面时普通 fetch 会被浏览器掐掉，用 sendBeacon 才发得出去
  if (navigator.sendBeacon) {
    try {
      navigator.sendBeacon(beaconUrl('/api/history'), new Blob([payload], { type: 'application/json' }));
      return;
    } catch {
      /* 退回 fetch */
    }
  }
  fetch('/api/history', {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: payload,
  }).catch(() => {});
}

/* ---------------- 单曲大图视图 + 频谱 ---------------- */

const VIZ_BARS = 72;
// AAC 音频 16kHz 以上基本被编码器滤掉，频段表末尾那一截永远是 0。
// 只映射到有效部分，否则上半圈拿到的全是死 bin，柱子一动不动。
const VIZ_USABLE = 0.62;

let audioCtx = null;
let analyser = null;
let vizData = null;
let vizLevels = null;
let vizRAF = null;

function initViz() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    audioCtx = new AC();
    // 音频同源（/api/audio），不需要 crossOrigin，可以安全地接分析器
    const src = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.82;
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
    vizData = new Uint8Array(analyser.frequencyBinCount);
    vizLevels = new Float32Array(VIZ_BARS);
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch {
    // 受限环境（某些 WebView）不支持，降级为无频谱，不影响播放
    audioCtx = null;
    analyser = null;
  }
}

let vizGeom = { cx: 0, cy: 0, r: 0, inner: 0, maxLen: 0, dpr: 1, bars: [] };

/** 量圆心/半径 —— 频谱要围成完整的球，所以取上下左右可用空间的最小值 */
function measureViz() {
  const cvs = $('#npViz');
  const art = $('#npArt');
  if (!cvs || !art) return false;

  const vr = npView.getBoundingClientRect();
  const ar = art.getBoundingClientRect();
  if (!vr.width || !ar.width) return false;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cvs.width = Math.round(vr.width * dpr);
  cvs.height = Math.round(vr.height * dpr);

  const cx = (ar.left + ar.width / 2 - vr.left) * dpr;
  const cy = (ar.top + ar.height / 2 - vr.top) * dpr;
  // 封面在自转，getBoundingClientRect 会随角度膨胀，必须用布局尺寸算半径
  const r = (art.clientWidth / 2) * dpr;

  // 下方是大字歌名/UP 主，上方是屏幕边，取四向最紧的那个当外径
  const titleEl = $('#npBigTitle');
  const tr = titleEl ? titleEl.getBoundingClientRect() : null;
  const bottomLimit = tr && tr.height
    ? (tr.top - vr.top) * dpr - 8 * dpr
    : cvs.height - 10 * dpr;

  const pad = 8 * dpr;
  const room = Math.min(cy - pad, bottomLimit - cy, cx - pad, cvs.width - cx - pad);

  // 和封面留一圈空隙，别贴成一圈「毛边」。
  // 但矮窗口里空间本来就紧，硬留 26px 会把柱子压到只剩 20 多像素，
  // 所以按「至少给柱子留 36px」往回缩。
  const inner = Math.max(r + 8 * dpr, Math.min(r + 26 * dpr, room - 36 * dpr));
  const maxLen = Math.max(12 * dpr, Math.min(room - inner, 170 * dpr));

  const bars = [];
  for (let i = 0; i < VIZ_BARS; i++) {
    const t = i / VIZ_BARS;
    const a = t * Math.PI * 2 + Math.PI / 2; // t=0 在正下方，t=0.5 在正上方
    bars.push({ cos: Math.cos(a), sin: Math.sin(a), mirrored: 1 - Math.abs(2 * t - 1) });
  }

  vizGeom = { cx, cy, r, inner, maxLen, dpr, bars };
  return true;
}

function drawViz() {
  vizRAF = null;
  const cvs = $('#npViz');
  if (!cvs || npView.hidden) return;

  const ctx2d = cvs.getContext('2d');
  if (!ctx2d) return;

  const { cx, cy, r, inner, maxLen, dpr, bars } = vizGeom;
  ctx2d.clearRect(0, 0, cvs.width, cvs.height);

  if (analyser && vizData && vizLevels && r > 0 && bars.length) {
    analyser.getByteFrequencyData(vizData);

    // 低音能量 -> 封面背后那圈呼吸光晕
    let bass = 0;
    for (let i = 1; i < 9; i++) bass += vizData[i];
    bass = bass / 8 / 255;

    const glowR = r * (1.2 + bass * 0.18);
    const glow = ctx2d.createRadialGradient(cx, cy, r * 0.82, cx, cy, glowR);
    glow.addColorStop(0, `rgba(251, 114, 153, ${0.1 + bass * 0.26})`);
    glow.addColorStop(0.55, `rgba(167, 139, 250, ${0.05 + bass * 0.13})`);
    glow.addColorStop(1, 'rgba(56, 189, 248, 0)');
    ctx2d.fillStyle = glow;
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, glowR, 0, Math.PI * 2);
    ctx2d.fill();

    // 左右两侧的大片柔光，随低音一起呼吸，把屏幕两边的空白填住
    const washR = r * 2.6;
    for (const side of [-1, 1]) {
      const wx = cx + side * r * 1.9;
      const wash = ctx2d.createRadialGradient(wx, cy, 0, wx, cy, washR);
      wash.addColorStop(0, `rgba(251, 114, 153, ${0.045 + bass * 0.075})`);
      wash.addColorStop(0.45, `rgba(167, 139, 250, ${0.028 + bass * 0.05})`);
      wash.addColorStop(1, 'rgba(56, 189, 248, 0)');
      ctx2d.fillStyle = wash;
      ctx2d.beginPath();
      ctx2d.arc(wx, cy, washR, 0, Math.PI * 2);
      ctx2d.fill();
    }

    // 底环：柱子再短也有一圈完整的光环
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, inner, 0, Math.PI * 2);
    ctx2d.strokeStyle = 'rgba(251, 114, 153, 0.14)';
    ctx2d.lineWidth = 1.1 * dpr;
    ctx2d.stroke();

    const binCount = vizData.length;
    const usable = Math.max(8, Math.floor(binCount * VIZ_USABLE));
    const span = Math.max(1, Math.floor(usable / 26));
    ctx2d.lineCap = 'round';

    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      // 对称映射：正下方是低频，向左右两侧同时爬升，顶部是高频。
      // 直接用原始频谱会出现「一边全是柱子、另一边空着」，镜像后才成环。
      // 指数 1.15（原来是 1.7）—— 原来高频被挤到最顶上几根柱子，上半圈几乎不动。
      const idx = Math.min(usable - 1, Math.floor(Math.pow(b.mirrored, 1.15) * usable));

      let peak = 0;
      for (let k = idx; k < idx + span && k < usable; k++) {
        if (vizData[k] > peak) peak = vizData[k];
      }

      // 高频段（上半圈）的原始数值本来就只有 20~50，且变化幅度小，
      // 用同一套曲线画出来就是「一圈静止的短毛」。所以按位置分别整形：
      //   低频 -> gamma 0.75，抬弱信号，柔和不刺眼
      //   高频 -> gamma 1.3，放大相对变化，让柱子真的跳起来
      const m = b.mirrored;
      const gamma = 0.75 + 0.45 * m;
      const gain = 1 + 1.5 * m;
      const lin = peak / 255;
      const raw = Math.pow(lin, gamma) * gain;
      // 软饱和：硬封顶会让柱子卡在满格不动，这里过了 0.85 还能慢慢长
      const target = raw < 0.85 ? raw : 0.85 + (1 - Math.exp(-(raw - 0.85) * 2.2)) * 0.15;
      vizLevels[i] += (target - vizLevels[i]) * 0.26;
      const v = vizLevels[i];

      // 基线从 0.28 降到 0.08：原来每根柱子至少 28% 长，
      // 高频那点起伏全被这个固定底座吃掉了，看着像静止的
      const len = maxLen * (0.08 + v * 0.92) + 3 * dpr;
      const x0 = cx + b.cos * inner;
      const y0 = cy + b.sin * inner;
      const x1 = cx + b.cos * (inner + len);
      const y1 = cy + b.sin * (inner + len);

      // 颜色跟着 mirrored 走：底部粉 -> 中段紫 -> 顶部青，左右自然对称
      let cr, cg, cb;
      if (b.mirrored < 0.5) {
        const k = b.mirrored / 0.5;
        cr = Math.round(251 + (167 - 251) * k);
        cg = Math.round(114 + (139 - 114) * k);
        cb = Math.round(153 + (250 - 153) * k);
      } else {
        const k = (b.mirrored - 0.5) / 0.5;
        cr = Math.round(167 + (56 - 167) * k);
        cg = Math.round(139 + (189 - 139) * k);
        cb = Math.round(250 + (248 - 250) * k);
      }

      // 外层柔光
      ctx2d.globalAlpha = (0.09 + v * 0.16);
      ctx2d.lineWidth = (3.2 + v * 4) * dpr * 2.2;
      ctx2d.strokeStyle = `rgb(${cr}, ${cg}, ${cb})`;
      ctx2d.beginPath();
      ctx2d.moveTo(x0, y0);
      ctx2d.lineTo(x1, y1);
      ctx2d.stroke();

      // 内层实芯
      ctx2d.globalAlpha = (0.34 + v * 0.66);
      ctx2d.lineWidth = (3 + v * 3.4) * dpr;
      ctx2d.strokeStyle = `rgb(${cr}, ${cg}, ${cb})`;
      ctx2d.beginPath();
      ctx2d.moveTo(x0, y0);
      ctx2d.lineTo(x1, y1);
      ctx2d.stroke();
    }
    ctx2d.globalAlpha = 1;
  }

  vizRAF = requestAnimationFrame(drawViz);
}

function startViz() {
  initViz();
  if (!measureViz()) {
    // 布局还没落定（刚显示），稍后再量一次
    setTimeout(() => {
      if (npView.hidden) return;
      measureViz();
      if (!vizRAF) vizRAF = requestAnimationFrame(drawViz);
    }, 70);
    return;
  }
  if (!vizRAF) vizRAF = requestAnimationFrame(drawViz);
}

function stopViz() {
  if (vizRAF) {
    cancelAnimationFrame(vizRAF);
    vizRAF = null;
  }
}

function renderNp() {
  const t = currentTrack();
  if (!t) return;
  const big = t.cover ? imgUrl(t.cover, '@600w_600h_1c') : '';
  $('#npArt').style.backgroundImage = big ? `url('${big}')` : '';
  $('#npBg').style.backgroundImage = big ? `url('${big}')` : '';
  $('#npBigTitle').textContent = t.title;
  refreshNowPlayingMeta();
  updateProgressUI(audio.currentTime, totalDuration());

  // 开着视频 / 评论面板时切歌，两个面板都跟着换内容
  if (videoMode && videoWant !== t.bvid) loadVideo(t);
  if (cmt.open && cmt.bvid !== t.bvid) startComments(t.bvid);
}

function openNp() {
  if (!currentTrack()) {
    toast('还没有在播放的歌');
    return;
  }
  renderNp();
  npView.hidden = false;
  // 设置里选的默认显示方式：视频 / 可视化（唱片+频谱），评论同理
  const wantVideo = prefNpView() === 'video';
  if (wantVideo !== videoMode) setVideoMode(wantVideo);
  if (prefNpComments()) openComments();
  else hideComments();
  // 等布局完成再量画布尺寸
  requestAnimationFrame(() => startViz());
}

function closeNp() {
  if (npView.hidden) return;
  // 关掉放大视图就停止拉视频（几十 MB 一条，别在后台偷流量）
  if (videoMode) setVideoMode(false);
  hideComments();
  npView.hidden = true;
  stopViz();
}

$('.now-playing').addEventListener('click', openNp);
$('#npClose').addEventListener('click', closeNp);
$('#npPlay').addEventListener('click', togglePlay);
$('#npPrev').addEventListener('click', () => step(-1));
$('#npNext').addEventListener('click', () => step(1));
$('#npMode').addEventListener('click', cycleMode);

npView.addEventListener('click', (e) => {
  if (e.target === npView) closeNp();
});

window.addEventListener('resize', () => {
  if (!npView.hidden) measureViz();
});

// 关页面 / 切到后台时把进度补发一次，避免丢掉最后几秒
window.addEventListener('pagehide', () => {
  reportProgress(true);
  histEnd(); // 关窗口时把这一次听了多久结掉
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') reportProgress(true);
});

/* ---------------- 放大视图里的「视频」和「评论」 ---------------- */

/**
 * 视频只出画面，声音还是 /api/audio 那条（本地缓存、大码率）。
 * 好处是：进度条 / 上一首下一首 / 音量 / 频谱全都不用改，audio 永远是唯一的「表」。
 * 代价是画面得自己跟 audio 对齐，所以下面有 seekVideoHard / syncVideoDrift。
 */

const npVideoBox = $('#npVideo');
const npVideoEl = $('#npVideoEl');
const npVideoTip = $('#npVideoTip');
const cmtPanel = $('#cmtPanel');
const cmtListEl = $('#cmtList');

let videoMode = false; // 画面开关
let videoWant = ''; // 正在为哪首加载（防止切歌后旧请求把画面贴错）
let videoReady = false;
let videoQuality = ''; // 当前画面的清晰度（720P 之类），和码率一起显示

const cmt = { open: false, sort: 'hot', next: '', bvid: '', loading: false, end: false, count: 0, token: 0 };

function npVideoReset(tip) {
  videoReady = false;
  videoWant = '';
  videoQuality = '';
  npVideoBox.classList.remove('ready');
  npVideoTip.hidden = false;
  npVideoTip.textContent = tip || '';
  try {
    npVideoEl.pause();
    npVideoEl.removeAttribute('src');
    npVideoEl.load();
  } catch {}
  refreshNowPlayingMeta();
}

function setVideoMode(on) {
  const t = currentTrack();
  if (on && !t) {
    toast('还没有在播放的歌', 1800);
    return;
  }
  videoMode = !!on;
  npView.classList.toggle('video-mode', videoMode);
  $('#npVideoBtn').classList.toggle('on', videoMode);
  npVideoBox.hidden = !videoMode;
  refreshNowPlayingMeta();
  if (!videoMode) {
    npVideoReset('正在获取视频…');
    return;
  }
  loadVideo(t);
}

async function loadVideo(t) {
  if (!t || !t.bvid) return;
  videoWant = t.bvid;
  videoReady = false;
  npVideoBox.classList.remove('ready');
  npVideoTip.hidden = false;
  npVideoTip.textContent = '正在获取视频…';

  try {
    const j = await api(`/api/video/info?bvid=${encodeURIComponent(t.bvid)}`);
    if (videoWant !== t.bvid || !videoMode) return; // 已经切歌 / 已经关掉
    if (!j || !j.ok) throw new Error((j && j.error) || '获取视频信息失败');
    if (!j.stream || !j.stream.available) {
      npVideoTip.textContent = '这条只有音频，没有能直接播的画面';
      return;
    }
    npVideoTip.textContent = (j.stream.label ? j.stream.label + ' · ' : '') + '加载中…';
    videoQuality = j.stream.label || '';
    refreshNowPlayingMeta();
    npVideoEl.src = `/api/video/stream?bvid=${encodeURIComponent(t.bvid)}&cid=${encodeURIComponent(j.cid || '')}`;
    npVideoEl.load();
    whenVideoReady(() => {
      if (videoWant !== t.bvid || !videoMode) return;
      videoReady = true;
      npVideoBox.classList.add('ready');
      npVideoTip.hidden = true;
      seekVideoHard();
      if (!audio.paused) {
        npVideoEl.play().catch(() => {});
        // 起播会慢半拍（要等缓冲 / 落到关键帧），起来后再对一次表
        setTimeout(() => {
          if (videoMode && videoReady && videoWant === t.bvid) seekVideoHard();
        }, 600);
      }
    });
  } catch (e) {
    if (videoWant === t.bvid) npVideoTip.textContent = '视频加载失败：' + (e.message || e);
  }
}

function whenVideoReady(fn) {
  if (npVideoEl.readyState >= 1) {
    fn();
    return;
  }
  npVideoEl.addEventListener('loadedmetadata', fn, { once: true });
}

/** 直接把画面拽到音频的位置（切歌 / 拖动进度条 / 偏差太大时用） */
function seekVideoHard() {
  npVideoEl.playbackRate = 1;
  if (!videoReady) return;
  const target = audio.currentTime || 0;
  try {
    if (Math.abs(npVideoEl.currentTime - target) > 0.12) npVideoEl.currentTime = target;
  } catch {}
}

/**
 * 画面比音频跑偏了就用微调播放速率追回来。
 * 画面是静音的，改 playbackRate 只影响画面快慢，听不出破绽。
 */
function syncVideoDrift() {
  if (!videoMode || !videoReady || npVideoEl.paused) return;
  const d = npVideoEl.currentTime - audio.currentTime;
  if (Math.abs(d) > 0.55) {
    seekVideoHard();
    return;
  }
  npVideoEl.playbackRate = Math.abs(d) > 0.08 ? (d > 0 ? 0.9 : 1.1) : 1;
}

$('#npVideoBtn').addEventListener('click', () => setVideoMode(!videoMode));
$('#npVideoEl').addEventListener('click', togglePlay);
$('#npVideoFs').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (npVideoEl.requestFullscreen) npVideoEl.requestFullscreen().catch(() => {});
  else npVideoEl.webkitEnterFullscreen && npVideoEl.webkitEnterFullscreen();
});
npVideoEl.addEventListener('error', () => {
  if (!videoMode) return;
  npVideoBox.classList.remove('ready');
  npVideoTip.hidden = false;
  npVideoTip.textContent = '视频加载失败，可能这条视频没有开放外链播放';
});

/* 跟着音频走：播放暂停、拖动、漂移 */
audio.addEventListener('play', () => {
  if (videoMode && videoReady) npVideoEl.play().catch(() => {});
});
audio.addEventListener('pause', () => {
  if (videoMode && videoReady) npVideoEl.pause();
});
audio.addEventListener('seeked', () => {
  if (videoMode) seekVideoHard();
});
audio.addEventListener('timeupdate', () => {
  if (!videoMode) return;
  if (npVideoEl.paused && !audio.paused) npVideoEl.play().catch(() => {});
  syncVideoDrift();
});

/* ---------------- 评论 ---------------- */

function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return String(n);
}

function fmtCmtTime(sec) {
  const t = Number(sec) * 1000;
  if (!t) return '';
  const d = Date.now() - t;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  if (d < 86400000 * 30) return Math.floor(d / 86400000) + ' 天前';
  const dt = new Date(t);
  const p = (x) => String(x).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

function isSafeEmoteUrl(u) {
  return /^https?:\/\/([a-z0-9-]+\.)*(hdslb\.com|biliimg\.com)\//i.test(u || '');
}

/** 评论正文：先转义，再把 [doge] 这类表情码换成图片 */
function cmtText(r) {
  let html = escapeHtml(r.msg || '').replace(/\n/g, '<br>');
  const em = r.emotes || {};
  for (const code of Object.keys(em)) {
    const safe = escapeHtml(code);
    if (!html.includes(safe)) continue;
    const url = em[code];
    if (!isSafeEmoteUrl(url)) continue;
    const src = `/api/img?u=${encodeURIComponent(url)}`;
    html = html.split(safe).join(`<img class="cmt-emote" src="${escapeAttr(src)}" alt="${safe}">`);
  }
  return html;
}

function renderComment(r) {
  const face = r.face
    ? `<img class="cmt-face" src="${escapeAttr(imgUrl(r.face, '@80w_80h_1c'))}" alt="" loading="lazy">`
    : '<div class="cmt-face"></div>';

  const pics = (r.pics || [])
    .map((p) => `<img class="cmt-pic" src="${escapeAttr(imgUrl(p, '@200w_200h_1c'))}" alt="" loading="lazy">`)
    .join('');

  const subs = (r.subs || [])
    .map(
      (s) => `<div class="cmt-sub">
        <span class="cmt-sub-name">${escapeHtml(s.uname)}${s.up ? ' <i class="cmt-badge">UP</i>' : ''}</span>
        <span class="cmt-sub-msg">${cmtText(s)}</span>
      </div>`
    )
    .join('');

  return `<div class="cmt-item">
    ${face}
    <div class="cmt-main">
      <div class="cmt-top">
        <span class="cmt-name">${escapeHtml(r.uname)}</span>
        ${r.up ? '<i class="cmt-badge">UP</i>' : ''}
        <span class="cmt-time">${fmtCmtTime(r.ctime)}</span>
      </div>
      <div class="cmt-msg">${cmtText(r)}</div>
      ${pics ? `<div class="cmt-pics">${pics}</div>` : ''}
      <div class="cmt-foot">
        <span class="cmt-like">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M2 11h3v9H2zM6.5 20V10.5L12 3l1.4 1.1c.5.4.7 1 .5 1.6L12.8 9h6.6c1.2 0 2 1.1 1.7 2.2l-2 7.3c-.2.9-1 1.5-1.9 1.5z"/></svg>
          ${fmtNum(r.like)}
        </span>
        ${r.rcount ? `<span class="cmt-rc">${fmtNum(r.rcount)} 条回复</span>` : ''}
      </div>
      ${subs}
    </div>
  </div>`;
}

function appendComments(list, kind) {
  if (!list.length) return;
  const html = list.map((r) => renderComment(r)).join('');
  if (kind === 'top') {
    const box = document.createElement('div');
    box.className = 'cmt-tops';
    box.innerHTML = html;
    cmtListEl.appendChild(box);
    return;
  }
  cmtListEl.insertAdjacentHTML('beforeend', html);
}

/** 第一页评论缓存：开关放大视图很频繁，同一首别每次都请求 */
const cmtPage1 = new Map(); // `${bvid}|${sort}` -> { data, ts }
const CMT_CACHE_TTL = 10 * 60 * 1000;

/** 把一页评论画进面板（首屏 / 翻页共用） */
function paintCommentsPage(j, reset) {
  cmt.count = j.count || 0;
  cmt.next = j.next || '';
  cmt.end = !!j.isEnd || !cmt.next;

  if (reset) cmtListEl.innerHTML = '';
  appendComments(j.top || [], 'top');
  appendComments(j.replies || [], 'more');

  $('#cmtCount').textContent = cmt.count ? `${fmtNum(cmt.count)} 条` : '';
  if (!cmtListEl.children.length) cmtListEl.innerHTML = '<div class="cmt-empty">还没有人评论</div>';
  const more = $('#cmtMore');
  more.hidden = cmt.end;
  more.textContent = '加载更多';
}

async function loadComments(reset) {
  if (!cmt.bvid || cmt.loading) return;
  if (!reset && cmt.end) return;

  const token = ++cmt.token;
  cmt.loading = true;
  const more = $('#cmtMore');
  more.hidden = false;
  more.textContent = reset ? '正在加载评论…' : '正在加载更多…';

  try {
    const q =
      `/api/video/comments?bvid=${encodeURIComponent(cmt.bvid)}&sort=${cmt.sort}` +
      (reset ? '' : `&next=${encodeURIComponent(cmt.next)}`);
    const j = await api(q);
    if (token !== cmt.token) return; // 又切歌 / 又换排序了，这次结果丢掉
    if (!j || !j.ok) throw new Error((j && j.error) || '评论加载失败');

    paintCommentsPage(j, reset);

    if (reset) {
      // 只有首屏值得缓存（翻页是用户主动点的，缓存了反而占内存）
      cmtPage1.set(`${cmt.bvid}|${cmt.sort}`, { data: j, ts: Date.now() });
      if (cmtPage1.size > 30) cmtPage1.delete(cmtPage1.keys().next().value);
    }
  } catch (e) {
    if (token !== cmt.token) return;
    if (reset) cmtListEl.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'cmt-empty';
    err.textContent = e.message || String(e);
    cmtListEl.appendChild(err);
    more.hidden = true;
  } finally {
    if (token === cmt.token) cmt.loading = false;
  }
}

function startComments(bvid) {
  cmt.bvid = bvid;
  cmt.next = '';
  cmt.end = false;
  // 作废还在飞的请求：换歌 / 换排序时不能等它，否则会贴上去上一批评论
  cmt.loading = false;
  cmt.token++;
  $('#cmtOpenBili').href = `https://www.bilibili.com/video/${encodeURIComponent(bvid)}`;

  const hit = cmtPage1.get(`${bvid}|${cmt.sort}`);
  if (hit && Date.now() - hit.ts < CMT_CACHE_TTL) {
    paintCommentsPage(hit.data, true); // 秒开，不再请求
    return;
  }

  cmtListEl.innerHTML = '<div class="cmt-empty">正在加载评论…</div>';
  $('#cmtCount').textContent = '';
  loadComments(true);
}

function openComments() {
  const t = currentTrack();
  if (!t) {
    toast('还没有在播放的歌', 1800);
    return;
  }
  cmt.open = true;
  cmtPanel.hidden = false;
  npView.classList.add('cmt-open');
  $('#npCmtBtn').classList.add('on');
  if (cmt.bvid !== t.bvid) startComments(t.bvid);
}

/** 只收起面板，列表留着；关掉放大视图时用 */
function hideComments() {
  cmt.open = false;
  cmtPanel.hidden = true;
  npView.classList.remove('cmt-open');
  $('#npCmtBtn').classList.remove('on');
}

$('#npCmtBtn').addEventListener('click', () => (cmt.open ? hideComments() : openComments()));
$('#cmtClose').addEventListener('click', hideComments);
$('#cmtMore').addEventListener('click', () => loadComments(false));
document.querySelectorAll('.cmt-sort').forEach((b) => {
  b.addEventListener('click', () => {
    const sort = b.dataset.sort || 'hot';
    if (cmt.sort === sort) return;
    cmt.sort = sort;
    document.querySelectorAll('.cmt-sort').forEach((x) => x.classList.toggle('active', x === b));
    if (cmt.bvid) startComments(cmt.bvid);
  });
});

/* ---------------- 添加收藏夹 ---------------- */
let modalTab = 'folder';

function openModal(tab) {
  // 登录了就直接落在「我的收藏夹」——那才是导入自己夹子的入口
  if (tab) modalTab = tab;
  else if (state.user) modalTab = 'mine';
  $('#modal').hidden = false;
  $('#modalErr').hidden = true;
  setModalTab(modalTab);
  setTimeout(() => {
    const sel = { folder: '#folderInput', uid: '#uidInput', season: '#seasonInput' }[modalTab];
    if (sel) $(sel).focus();
  }, 40);
}

function closeModal() {
  $('#modal').hidden = true;
  $('#modalErr').hidden = true;
}

function setModalTab(tab) {
  modalTab = tab;
  document.querySelectorAll('.modal-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab));
  const ok = $('#modalOk');
  if (ok) ok.textContent = tab === 'mine' ? '导入选中' : '确定';
  if (tab === 'mine') loadMineFolders();
}

/* ---- 我的收藏夹（登录后直接勾选导入；侧栏「+」和头像里的导入页共用） ---- */

async function renderMyFoldersInto(box, hintEl) {
  if (!box) return;

  if (!state.user) {
    if (hintEl) hintEl.textContent = '需要先登录';
    box.innerHTML =
      '<div class="mine-empty">登录 B 站后，这里会列出你自己的收藏夹（含私密夹）' +
      '<br><button class="ghost-btn mine-login mine-login-btn" type="button">登录 B 站</button></div>';
    const btn = box.querySelector('.mine-login-btn');
    if (btn) btn.addEventListener('click', () => openLogin());
    return;
  }

  if (hintEl) hintEl.textContent = '勾选要导入的收藏夹，可以多选';
  box.innerHTML = '<div class="mine-empty">正在读取你的收藏夹…</div>';
  try {
    const j = await api('/api/my/favs');
    if (!j.ok) throw new Error(j.error || '读取收藏夹失败');
    const folders = j.folders || [];
    if (!folders.length) {
      box.innerHTML = '<div class="mine-empty">你还没有创建过收藏夹，先去 B 站建一个吧</div>';
      return;
    }
    box.innerHTML = '';
    for (const f of folders) {
      const added = state.folders.some((x) => String(x.mediaId) === String(f.id));
      const el = document.createElement('label');
      el.className = 'mine-item' + (added ? ' added' : '');
      el.innerHTML = `
        <input type="checkbox" value="${escapeAttr(f.id)}"${added ? ' disabled' : ''} />
        <span class="mine-name">${escapeHtml(f.title)}${
        f.isPrivate ? '<span class="favpick-tag">私密</span>' : ''
      }</span>
        <span class="mine-count">${added ? '已添加' : `${f.count} 首`}</span>`;
      box.appendChild(el);
    }
  } catch (e) {
    if (/登录/.test(e.message)) {
      state.user = null;
      rememberUser(null);
      renderAccount();
    }
    box.innerHTML = `<div class="mine-empty">${escapeHtml(e.message)}</div>`;
  }
}

function loadMineFolders() {
  return renderMyFoldersInto($('#mineList'), $('#mineHint'));
}

/** 头像里那个导入页 */
function loadAcctFolders() {
  return renderMyFoldersInto($('#acctFolderList'), $('#acctImportHint'));
}

/** 批量把「我的收藏夹」加进侧栏；单个失败不影响其他 */
async function importMyFolders(ids) {
  const todo = ids.filter((id) => !state.folders.some((f) => String(f.mediaId) === String(id)));
  if (!todo.length) {
    toast('这些收藏夹已经在列表里了', 2200);
    return;
  }

  let added = 0;
  let firstId = null;
  let firstErr = '';

  for (const id of todo) {
    try {
      const data = await api(`/api/fav?media_id=${encodeURIComponent(id)}&refresh=1`);
      if (!data.ok) throw new Error(data.error || '读取失败');
      const count = (data.tracks || []).filter((t) => !t.dead).length;
      state.folders.push({
        mediaId: String(id),
        title: (data.info && data.info.title) || '收藏夹 ' + id,
        count,
        cover: (data.info && data.info.cover) || '',
        upper: (data.info && data.info.upper) || '',
      });
      added += 1;
      if (!firstId) firstId = id;
    } catch (e) {
      if (!firstErr) firstErr = e.message;
    }
  }

  if (!added) throw new Error('导入失败：' + (firstErr || '未知原因'));

  persist();
  renderFolders();
  if (firstId) await loadFolder(firstId);
  toast(added > 1 ? `已导入 ${added} 个收藏夹` : '已导入 1 个收藏夹', 2400);
}

/** 「全选 / 全不选」按钮，两个勾选列表共用 */
function bindSelectAll(btnSel, listSel) {
  const btn = $(btnSel);
  if (!btn) return;
  btn.addEventListener('click', () => {
    const boxes = [...document.querySelectorAll(`${listSel} input[type="checkbox"]:not(:disabled)`)];
    if (!boxes.length) return;
    const allOn = boxes.every((b) => b.checked);
    boxes.forEach((b) => {
      b.checked = !allOn;
    });
    btn.textContent = allOn ? '全选' : '全不选';
  });
}

bindSelectAll('#mineAll', '#mineList');
bindSelectAll('#acctImportAll', '#acctFolderList');

/** 头像导入页里的「导入选中」 */
if ($('#acctImportBtn')) {
  $('#acctImportBtn').addEventListener('click', async () => {
    const ids = [
      ...document.querySelectorAll('#acctFolderList input[type="checkbox"]:checked:not(:disabled)'),
    ].map((b) => b.value);
    if (!ids.length) {
      toast('先勾选要导入的收藏夹', 2000);
      return;
    }
    const btn = $('#acctImportBtn');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = `导入中（${ids.length}）…`;
    try {
      await importMyFolders(ids);
      closeLogin();
    } catch (e) {
      toast(e.message, 3200);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });
}

document.querySelectorAll('.modal-tab').forEach((b) => {
  b.addEventListener('click', () => setModalTab(b.dataset.tab));
});

$('#modalCancel').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
});

/* ---------------- 「+」：导入 / 新建收藏夹 ---------------- */

function closeAddMenu() {
  const m = $('#addMenu');
  if (m) m.hidden = true;
}

function openAddMenu(anchor) {
  const menu = $('#addMenu');
  if (!menu || !anchor) return;
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const pad = 8;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = Math.min(Math.max(pad, r.right - mw), window.innerWidth - mw - pad);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - pad) top = Math.max(pad, r.top - mh - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

[['#addFolderBtn'], ['#addFolderMobile']].forEach(([sel]) => {
  const btn = $(sel);
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!$('#addMenu').hidden) {
      closeAddMenu();
      return;
    }
    openAddMenu(btn);
  });
});

if ($('#addMenu')) {
  $('#addMenu').addEventListener('click', (e) => {
    const item = e.target.closest('.add-menu-item');
    if (!item) return;
    const act = item.dataset.act;
    closeAddMenu();
    if (act === 'import') openModal();
    else if (act === 'create') openNewFolderModal();
  });
  document.addEventListener('mousedown', (e) => {
    const m = $('#addMenu');
    if (m && !m.hidden && !m.contains(e.target)) closeAddMenu();
  });
  window.addEventListener('resize', closeAddMenu);
  window.addEventListener('blur', closeAddMenu);
}

/* ---- 新建收藏夹（建在 B 站账号里） ---- */

function closeNewFolderModal() {
  $('#newFolderModal').hidden = true;
  $('#newFolderErr').hidden = true;
}

function openNewFolderModal() {
  if (!state.user) {
    toast('先登录 B 站才能新建收藏夹', 2400);
    openLogin();
    return;
  }
  $('#newFolderName').value = '';
  $('#newFolderPrivate').checked = false;
  $('#newFolderErr').hidden = true;
  $('#newFolderModal').hidden = false;
  setTimeout(() => $('#newFolderName').focus(), 40);
}

if ($('#newFolderCancel')) $('#newFolderCancel').addEventListener('click', closeNewFolderModal);
if ($('#newFolderModal')) {
  $('#newFolderModal').addEventListener('click', (e) => {
    if (e.target.id === 'newFolderModal') closeNewFolderModal();
  });
}
if ($('#newFolderName')) {
  $('#newFolderName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#newFolderOk').click();
  });
}
if ($('#newFolderOk')) {
  $('#newFolderOk').addEventListener('click', async () => {
    const btn = $('#newFolderOk');
    const err = $('#newFolderErr');
    const name = $('#newFolderName').value.trim();
    err.hidden = true;
    if (!name) {
      err.hidden = false;
      err.textContent = '先给收藏夹起个名字';
      return;
    }
    btn.disabled = true;
    try {
      const r = await fetch('/api/fav/folder/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: name, privacy: $('#newFolderPrivate').checked }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '新建失败');
      closeNewFolderModal();
      toast(`已新建收藏夹「${j.item.title}」`, 2400);
      // 顺手加到左边列表，马上就能往里收藏（提示已经在上面给过了）
      try {
        await addFolder(j.item.id, { silent: true });
      } catch (e) {
        toast('新建成功，但没加进列表：' + e.message, 3200);
      }
      if (!$('#modal').hidden && modalTab === 'mine') loadMineFolders();
    } catch (e) {
      err.hidden = false;
      err.textContent = e.message;
      if (/登录/.test(e.message)) {
        state.user = null;
        rememberUser(null);
        renderAccount();
      }
    } finally {
      btn.disabled = false;
    }
  });
}

function modalError(msg) {
  const el = $('#modalErr');
  el.textContent = msg;
  el.hidden = false;
}

$('#modalOk').addEventListener('click', async () => {
  const okBtn = $('#modalOk');
  okBtn.disabled = true;
  $('#modalErr').hidden = true;

  try {
    if (modalTab === 'folder') {
      const raw = $('#folderInput').value;
      const season = parseSeason(raw);
      if (season) {
        await addSeason(season);
        closeModal();
        $('#folderInput').value = '';
        return;
      }
      const mediaId = parseMediaId(raw);
      if (!mediaId) {
        modalError('没识别出收藏夹 ID。请粘贴完整网址，或直接填纯数字 ID。');
        return;
      }
      await addFolder(mediaId);
      closeModal();
      $('#folderInput').value = '';
    } else if (modalTab === 'season') {
      const season = parseSeason($('#seasonInput').value);
      if (!season) {
        modalError('没识别出合集。请粘贴形如 space.bilibili.com/<uid>/lists/<合集ID>?type=season 的网址。');
        return;
      }
      await addSeason(season);
      closeModal();
      $('#seasonInput').value = '';
    } else if (modalTab === 'mine') {
      const ids = [...document.querySelectorAll('#mineList input[type="checkbox"]:checked:not(:disabled)')].map(
        (b) => b.value
      );
      if (!ids.length) {
        modalError('先勾选要导入的收藏夹');
        return;
      }
      await importMyFolders(ids);
      closeModal();
    } else {
      const uid = parseUid($('#uidInput').value);
      if (!uid) {
        modalError('没识别出 UID。填纯数字，或者粘贴个人空间链接。');
        return;
      }
      await importByUid(uid);
      closeModal();
      $('#uidInput').value = '';
    }
  } catch (e) {
    modalError(e.message);
  } finally {
    okBtn.disabled = false;
  }
});

// 回车提交
['#folderInput', '#uidInput', '#seasonInput'].forEach((sel) => {
  $(sel).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#modalOk').click();
  });
});

async function addFolder(mediaId, opts = {}) {
  if (state.folders.some((f) => String(f.mediaId) === String(mediaId))) {
    // 已存在，直接切过去
    await loadFolder(mediaId);
    return;
  }
  // 新增时强制回源，保证刚加进来的收藏夹是最新内容
  const data = await api(`/api/fav?media_id=${encodeURIComponent(mediaId)}&refresh=1`);
  if (!data.ok) throw new Error(data.error || '添加失败');

  const count = (data.tracks || []).filter((t) => !t.dead).length;
  state.folders.push({
    mediaId: String(mediaId),
    title: (data.info && data.info.title) || '收藏夹 ' + mediaId,
    count,
    cover: (data.info && data.info.cover) || '',
    upper: (data.info && data.info.upper) || '',
  });
  persist();
  renderFolders();
  await loadFolder(mediaId);
  if (!opts.silent) toast(`已添加「${(data.info && data.info.title) || mediaId}」，${count} 首`);
}

/**
 * 把一个合集加进侧栏。
 * opts.keepView：加完不切过去（从搜索结果右键「导入整个合集」时用，别把人踢出搜索页）
 */
async function addSeason(season, opts = {}) {
  const key = seasonKey(season);
  const exists = state.folders.some((f) => String(f.mediaId) === key);
  if (exists) {
    if (opts.keepView) {
      toast('这个合集已经在左边列表里了', 2200);
      return;
    }
    await loadFolder(key);
    return;
  }

  const data = await api(
    `/api/season?mid=${encodeURIComponent(season.mid)}&season_id=${encodeURIComponent(season.seasonId)}&refresh=1`
  );
  if (!data.ok) throw new Error(data.error || '添加合集失败');

  const count = (data.tracks || []).filter((t) => !t.dead).length;
  state.folders.push({
    mediaId: key,
    title: (data.info && data.info.title) || `合集 ${season.seasonId}`,
    count,
    cover: (data.info && data.info.cover) || '',
    upper: (data.info && data.info.upper) || '',
  });
  persist();
  renderFolders();
  if (!opts.keepView) await loadFolder(key);
  toast(`已添加合集「${(data.info && data.info.title) || season.seasonId}」，${count} 首`, 2600);
}

async function importByUid(uid) {
  const data = await api(`/api/folders?mid=${encodeURIComponent(uid)}`);
  if (!data.ok) throw new Error(data.error || '获取收藏夹列表失败');
  const list = data.folders || [];
  if (!list.length) throw new Error('这个账号下没有公开收藏夹（私密收藏夹无法读取）');

  let added = 0;
  for (const f of list) {
    if (state.folders.some((x) => String(x.mediaId) === String(f.mediaId))) continue;
    state.folders.push({
      mediaId: String(f.mediaId),
      title: f.title || '收藏夹 ' + f.mediaId,
      count: f.count || 0,
      cover: f.cover || '',
      upper: f.upper || '',
    });
    added++;
  }
  persist();
  renderFolders();
  if (added) {
    await loadFolder(list[0].mediaId);
    toast(`导入了 ${added} 个收藏夹`);
  } else {
    toast('这些收藏夹都已经在列表里了');
  }
}

$('#importUidBtn').addEventListener('click', () => {
  modalTab = 'uid';
  openModal();
});

/* ---------------- 启动 ---------------- */
/**
 * 恢复上次听的那首。
 * 关键点：不只是把标题/封面/进度画上去，还得真把这首歌载进 audio（但不自动播）。
 * 只画 UI 的话 hasLoaded() 是假，用户一点播放键就会从列表第一首重新开始。
 */
function restoreLast() {
  // 播放器里已经有歌了（比如正在播的时候切收藏夹），别再恢复，否则会打断当前播放
  if (hasLoaded()) return Promise.resolve();

  return fetchLastProgress().then((data) => {
    const last = data && data.last;
    const bvid = (last && last.bvid) || localStorage.getItem(LS.lastBvid);
    if (!bvid) return;

    const ti = state.tracks.findIndex((t) => t.bvid === bvid);
    if (ti < 0) return;

    const t = state.tracks[ti];
    if (!t || t.dead) return;

    state.playingIndex = ti;
    state.playingTrack = t;
    const cover = t.cover ? imgUrl(t.cover, '@200w_200h_1c') : '';
    $('#npCover').style.backgroundImage = cover ? `url('${cover}')` : '';
    $('#npTitle').textContent = t.title;
    refreshNowPlayingMeta();
    refreshActiveUI();

    const pos = last && last.bvid === bvid ? Number(last.pos) || 0 : 0;

    // 静默载入：preload="metadata" 只会拉一小段头部，不占带宽
    pendingSeek = pos > 5 ? pos : 0;
    restoring = true;
    audio.src = `/api/audio?bvid=${encodeURIComponent(t.bvid)}`;
    updateProgressUI(pos, t.duration);

    // 乱序模式下先把这一轮排好，并把这首钉在队首当作当前位置：
    // 「下一首」接着走完这一轮，「上一首」到头为止，不会随机抽到重复的
    if (state.mode === 'shuffle') {
      buildShuffleQueue();
      pinShuffleHead(ti);
    }

    pushMiniState(true);
  });
}

async function init() {
  // 音量 / 模式（这两个是「这台设备」的偏好，留在本地）
  const v = parseFloat(localStorage.getItem(LS.volume));
  state.volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
  const m = localStorage.getItem(LS.mode);
  setMode(MODE_ORDER.includes(m) ? m : 'list');
  applyVolume();

  // 上次用的是列表还是卡片视图
  setViewMode(localStorage.getItem(LS.view) === 'card' ? 'card' : 'list', false);

  // 收藏夹列表从服务端 json 读
  const lib = await fetchLibrary();
  state.folders = lib.folders;
  renderFolders();

  // 登录态：凭证（Cookie）只存在服务端 data/auth.json，这里只拿昵称/头像
  try {
    const me = await api('/api/login/me');
    state.user = me && me.isLogin ? me.user : null;
  } catch {
    // 服务端暂时连不上：先用本机缓存的名字撑着，别显示成掉线
    state.user = cachedUser();
  }
  rememberUser(state.user);
  renderAccount();

  // 支持用 ?media_id=xxx / ?fid=xxx 直达某个收藏夹（可存成书签）
  const qp = new URLSearchParams(location.search);
  const urlId = parseMediaId(qp.get('media_id') || qp.get('fid') || '');
  if (urlId) {
    $('#gate').hidden = true;
    $('#app').hidden = false;
    addFolder(urlId).catch((e) => {
      $('#gate').hidden = false;
      $('#app').hidden = true;
      const hint = $('#gateHint');
      hint.textContent = e.message;
      hint.classList.add('error');
    });
    return;
  }

  const cur = lib.current;

  if (state.folders.length) {
    const target = state.folders.find((f) => String(f.mediaId) === String(cur)) || state.folders[0];
    loadFolder(target.mediaId);
  } else {
    // 首次使用：走引导页
    $('#gate').hidden = false;
    $('#app').hidden = true;

    const input = $('#gateInput');
    const btn = $('#gateBtn');
    const hint = $('#gateHint');

    const submit = async () => {
      const raw = input.value;
      const season = parseSeason(raw);
      const mediaId = parseMediaId(raw);
      if (!season && !mediaId) {
        hint.textContent = '没识别出收藏夹或合集，检查一下链接？';
        hint.classList.add('error');
        return;
      }
      btn.disabled = true;
      btn.textContent = '加载中…';
      try {
        if (season) await addSeason(season);
        else await addFolder(mediaId);
      } catch (e) {
        hint.textContent = e.message;
        hint.classList.add('error');
      } finally {
        btn.disabled = false;
        btn.textContent = '开始听';
      }
    };

    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    input.focus();
  }
}

init();
