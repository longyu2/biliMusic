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
};

/* ---------------- 状态 ---------------- */
const state = {
  folders: [], // [{ mediaId, title, count, cover, upper }]
  mediaId: null,
  info: null,
  tracks: [], // 全量曲目
  view: [], // 当前显示/播放顺序（tracks 的下标数组）
  playingIndex: -1, // 在 tracks 里的下标
  mode: 'list', // list | one | shuffle
  volume: 0.8,
  muted: false,
  query: '',
  // 乱序播放：一次性把列表打乱，然后按这个顺序依次播完，播完一轮再重新洗牌。
  // 不是「每首独立随机抽」—— 那样上一首根本回不去，也保证不了一轮内不重复。
  shuffleQueue: [], // 打乱后的 tracks 下标
  shufflePos: -1, // 当前播到队列的第几个
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

async function api(path) {
  const r = await fetch(path);
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
        headers: { 'Content-Type': 'application/json' },
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
    const r = await fetch('/api/library');
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

/* ---------------- 收藏夹列表渲染 ---------------- */
function renderFolders() {
  const box = $('#folderList');
  box.innerHTML = '';

  if (!state.folders.length) {
    box.innerHTML = '<div class="f-count" style="padding:10px 9px;line-height:1.7">还没有收藏夹<br>点右上角 + 添加</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const f of state.folders) {
    const el = document.createElement('div');
    el.className = 'folder' + (String(f.mediaId) === String(state.mediaId) ? ' active' : '');
    el.dataset.id = f.mediaId;
    el.innerHTML = `
      <div class="f-cover"${f.cover ? ` style="background-image:url('${imgUrl(f.cover, '@80w_80h_1c')}')"` : ''}></div>
      <div class="f-body">
        <div class="f-name" title="${escapeAttr(f.title)}">${escapeHtml(f.title)}</div>
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
          if (confirm(`移除收藏夹「${f.title}」？\n只从本地列表移除，不影响 B 站收藏夹。`)) {
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
      renderTracks();
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
    // 默认读服务端缓存（data/fav/<id>.json），只有刷新按钮才回源
    const q = `/api/fav?media_id=${encodeURIComponent(mediaId)}` + (opts.force ? '&refresh=1' : '');
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
  const box = $('#trackList');
  $('#emptyState').hidden = true;
  let html = '';
  for (let i = 0; i < 8; i++) {
    html += `<div class="skeleton-row">
      <div class="sk" style="width:14px;justify-self:center"></div>
      <div class="sk" style="width:${40 + ((i * 13) % 45)}%"></div>
      <div class="sk" style="width:60%"></div>
      <div class="sk" style="width:70%;justify-self:end"></div>
    </div>`;
  }
  box.innerHTML = html;
}

/* ---------------- 曲目列表渲染 ---------------- */
function rebuildView() {
  const q = state.query.trim().toLowerCase();
  state.view = [];
  state.tracks.forEach((t, i) => {
    if (!q || t.title.toLowerCase().includes(q) || (t.upper || '').toLowerCase().includes(q)) {
      state.view.push(i);
    }
  });
  // 搜索过滤后列表变了，旧的乱序队列作废
  state.shuffleQueue = [];
  state.shufflePos = -1;
  renderTracks();
}

function renderTracks() {
  const box = $('#trackList');
  const empty = $('#emptyState');

  if (!state.view.length) {
    box.innerHTML = '';
    empty.hidden = false;
    empty.textContent = state.query
      ? `没有匹配「${state.query}」的曲目`
      : state.tracks.length
      ? '这个收藏夹是空的'
      : '没有数据，试试右上角重新加载';
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

    let idxHtml;
    if (active) {
      idxHtml = `<div class="bars${audio.paused ? ' paused' : ''}"><i></i><i></i><i></i></div>`;
    } else {
      idxHtml = String(pos + 1);
    }

    el.innerHTML = `
      <div class="t-idx">${idxHtml}</div>
      <div class="t-main">
        <div class="t-thumb"${t.cover ? ` style="background-image:url('${imgUrl(t.cover, '@80w_80h_1c')}')"` : ''}></div>
        <div class="t-title" title="${escapeAttr(t.title)}">${escapeHtml(t.title)}</div>
      </div>
      <div class="t-upper" title="${escapeAttr(t.upper)}">${escapeHtml(t.upper)}</div>
      <div class="t-time">${fmtTime(t.duration)}</div>`;

    if (!t.dead) el.addEventListener('click', () => playAt(ti));
    frag.appendChild(el);
  });

  box.innerHTML = '';
  box.appendChild(frag);
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

/* ---------------- 播放控制 ---------------- */
function currentTrack() {
  return state.playingIndex >= 0 ? state.tracks[state.playingIndex] : null;
}

function playAt(trackIndex) {
  const t = state.tracks[trackIndex];
  if (!t || t.dead) return;

  // 切歌前先把上一首听到哪儿存下来
  if (state.playingIndex >= 0 && state.playingIndex !== trackIndex) reportProgress(true);
  // 上一首的播放历史也在这里结算（此时 audio.currentTime 还是上一首的）
  histEnd();

  state.playingIndex = trackIndex;

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
  $('#npUpper').textContent = t.upper || '—';
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
  refreshActiveRow();
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

$('#reloadBtn').addEventListener('click', () => {
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
    if (cmd === 'toggle') togglePlay();
    else if (cmd === 'next') step(1);
    else if (cmd === 'prev') step(-1);
    // play() 是异步的，稍等一下再回推，卡片才不会显示成暂停态
    setTimeout(() => pushMiniState(true), 60);
  });
}

let searchTimer = null;
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value;
  searchTimer = setTimeout(() => {
    state.query = v;
    rebuildView();
  }, 140);
});

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
  if (state.mode === 'one') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
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
  if (state.playingIndex < 0) return;
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
    const r = await fetch('/api/progress');
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
    mediaId: state.mediaId,
  });

  // 关页面时普通 fetch 会被浏览器掐掉，用 sendBeacon 才发得出去
  if (force && navigator.sendBeacon) {
    try {
      navigator.sendBeacon('/api/progress', new Blob([payload], { type: 'application/json' }));
      return;
    } catch {
      /* 退回 fetch */
    }
  }

  fetch('/api/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    mediaId: state.mediaId,
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
      navigator.sendBeacon('/api/history', new Blob([payload], { type: 'application/json' }));
      return;
    } catch {
      /* 退回 fetch */
    }
  }
  fetch('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  $('#npBigUpper').textContent = t.upper || '—';
  updateProgressUI(audio.currentTime, totalDuration());
}

function openNp() {
  if (!currentTrack()) {
    toast('还没有在播放的歌');
    return;
  }
  renderNp();
  npView.hidden = false;
  // 等布局完成再量画布尺寸
  requestAnimationFrame(() => startViz());
}

function closeNp() {
  if (npView.hidden) return;
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

/* ---------------- 添加收藏夹 ---------------- */
let modalTab = 'folder';

function openModal() {
  $('#modal').hidden = false;
  $('#modalErr').hidden = true;
  setModalTab(modalTab);
  setTimeout(() => {
    (modalTab === 'folder' ? $('#folderInput') : $('#uidInput')).focus();
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
}

document.querySelectorAll('.modal-tab').forEach((b) => {
  b.addEventListener('click', () => setModalTab(b.dataset.tab));
});

$('#addFolderBtn').addEventListener('click', openModal);
$('#addFolderMobile').addEventListener('click', openModal);
$('#modalCancel').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
});

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
      const mediaId = parseMediaId(raw);
      if (!mediaId) {
        modalError('没识别出收藏夹 ID。请粘贴完整网址，或直接填纯数字 ID。');
        return;
      }
      await addFolder(mediaId);
      closeModal();
      $('#folderInput').value = '';
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
['#folderInput', '#uidInput'].forEach((sel) => {
  $(sel).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#modalOk').click();
  });
});

async function addFolder(mediaId) {
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
  toast(`已添加「${(data.info && data.info.title) || mediaId}」，${count} 首`);
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
    const cover = t.cover ? imgUrl(t.cover, '@200w_200h_1c') : '';
    $('#npCover').style.backgroundImage = cover ? `url('${cover}')` : '';
    $('#npTitle').textContent = t.title;
    $('#npUpper').textContent = t.upper || '—';
    refreshActiveRow();

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

  // 收藏夹列表从服务端 json 读
  const lib = await fetchLibrary();
  state.folders = lib.folders;
  renderFolders();

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
      const mediaId = parseMediaId(input.value);
      if (!mediaId) {
        hint.textContent = '没识别出收藏夹 ID，检查一下链接？';
        hint.classList.add('error');
        return;
      }
      btn.disabled = true;
      btn.textContent = '加载中…';
      try {
        await addFolder(mediaId);
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
