#!/usr/bin/env node
'use strict';

/**
 * b站音乐播放器 - 本地服务
 *
 * 职责：
 *  1. 把收藏夹接口包一层，前端只认 /api/fav
 *  2. 代理音频流（关键：补上 Referer，透传 Range，否则 403 / 不能拖动）
 *  3. 代理封面图（B 站图床同样有防盗链）
 *
 * 零第三方依赖，只用 Node 内置模块。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const PORT = Number(process.env.PORT) || 7788;
// 默认只监听本机；部署到服务器时用 HOST=0.0.0.0 让局域网可访问
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
// 收藏夹列表存服务端文件，换设备/换浏览器都能看到同一份
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
// 每个收藏夹的歌单单独存一份，打开时直接读盘，不用再去 B 站翻页
const FAV_DIR = path.join(DATA_DIR, 'fav');
// 封面图缓存：B 站图床在公网，每次回源都要多等几百毫秒
const IMG_DIR = path.join(DATA_DIR, 'img');
const IMG_MAX_AGE = 'public, max-age=604800'; // 浏览器侧也缓存一周

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';
const BASE_HEADERS = {
  'User-Agent': UA,
  Referer: REFERER,
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* B 站接口封装                                                         */
/* ------------------------------------------------------------------ */

async function biliJson(url, extraHeaders) {
  const res = await fetch(url, {
    headers: { ...BASE_HEADERS, ...(extraHeaders || {}) },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`B站接口返回非 JSON（HTTP ${res.status}），大概率触发了风控`);
  }
  return json;
}

/** 收藏夹列表（单页） */
async function favPage(mediaId, pn, ps = 20) {
  const url =
    `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${encodeURIComponent(mediaId)}` +
    `&pn=${pn}&ps=${ps}&platform=web&keyword=&order=mtime&type=0&tid=0`;
  return biliJson(url);
}

function normalizeMedia(m) {
  const dead = !m.title || m.title === '已失效视频' || m.title === '已失效' || m.attr === 9;
  return {
    avid: m.id,
    bvid: m.bvid || m.bv_id || '',
    title: m.title || '（已失效）',
    cover: m.cover || '',
    duration: Number(m.duration) || 0,
    upper: (m.upper && m.upper.name) || '',
    upperMid: (m.upper && m.upper.mid) || 0,
    intro: m.intro || '',
    play: (m.cnt_info && m.cnt_info.play) || 0,
    favTime: m.fav_time || 0,
    dead,
  };
}

/** 收藏夹全量（自动翻页） */
async function favAll(mediaId, onProgress) {
  const tracks = [];
  let info = null;
  let pn = 1;
  const MAX_PAGES = 60;

  while (pn <= MAX_PAGES) {
    const j = await favPage(mediaId, pn);
    if (j.code !== 0) {
      const msg = j.code === -403 ? '无权访问：这个收藏夹不是公开的' : j.message || `错误码 ${j.code}`;
      const err = new Error(msg);
      err.code = j.code;
      throw err;
    }
    if (pn === 1) info = j.data && j.data.info;

    const medias = (j.data && j.data.medias) || [];
    if (!medias.length) break;
    for (const m of medias) tracks.push(normalizeMedia(m));

    if (onProgress) onProgress({ page: pn, count: tracks.length, total: (info && info.media_count) || 0 });
    if (!(j.data && j.data.has_more)) break;
    pn += 1;
    await sleep(220); // 温和限速，避免风控
  }

  return {
    info: info
      ? {
          id: info.id,
          title: info.title,
          mediaCount: info.media_count,
          upper: (info.upper && info.upper.name) || '',
          cover: info.cover || '',
        }
      : null,
    tracks,
  };
}

/** bvid -> cid（顺带拿分 P 信息） */
async function resolveCid(bvid) {
  const j = await biliJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  if (j.code !== 0) throw new Error(j.message || `view 失败 ${j.code}`);
  return {
    cid: j.data.cid,
    pages: (j.data.pages || []).length,
    duration: j.data.duration || 0,
    tname: j.data.tname || '',
  };
}

/**
 * 音频流地址。B 站返回 dash，音频流通常 3 档（64k / 132k / 192k），
 * 有大会员/杜比时还会有 flac。这里直接取最高带宽。
 */
async function audioSource(bvid, cid) {
  const url = `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(
    bvid
  )}&cid=${cid}&fnval=16&fnver=0&fourk=1`;
  const j = await biliJson(url);
  if (j.code !== 0) throw new Error(j.message || `playurl 失败 ${j.code}`);

  const dash = j.data && j.data.dash;
  if (dash && Array.isArray(dash.audio) && dash.audio.length) {
    const best = [...dash.audio].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    return {
      urls: [best.baseUrl, ...(best.backupUrl || [])].filter(Boolean),
      mime: 'audio/mp4',
      quality: best.id,
      bandwidth: best.bandwidth,
    };
  }
  // 老视频走 durl（flv/mp4 混合）
  const durl = j.data && j.data.durl;
  if (Array.isArray(durl) && durl.length) {
    return {
      urls: [durl[0].url, ...(durl[0].backup_url || [])].filter(Boolean),
      mime: 'video/mp4',
      quality: 0,
      bandwidth: 0,
    };
  }
  throw new Error('这条视频没有可用的音频流');
}

/* 音频地址缓存：B 站链接约 2 小时过期，过期或 403 时自动重取 */
const srcCache = new Map(); // key -> { urls, mime, ts }
const SRC_TTL = 25 * 60 * 1000;

async function getCachedSource(bvid, cid, force = false) {
  const key = `${bvid}:${cid}`;
  const hit = srcCache.get(key);
  if (!force && hit && Date.now() - hit.ts < SRC_TTL) return hit;

  const info = await resolveCid(bvid).catch(() => null);
  const realCid = cid || (info && info.cid);
  if (!realCid) throw new Error('拿不到 cid');

  const src = await audioSource(bvid, realCid);
  const entry = { ...src, cid: realCid, ts: Date.now() };
  srcCache.set(key, entry);
  return entry;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                 */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/** 只允许代理 B 站图床，避免变成任意 URL 的开放代理 */
function isAllowedImageHost(hostname) {
  return /(^|\.)(hdslb\.com|biliimg\.com|bilivideo\.com)$/i.test(hostname);
}

/* ------------------------------------------------------------------ */
/* 音频代理                                                             */
/* ------------------------------------------------------------------ */

async function proxyAudio(req, res, bvid, cid) {
  if (!bvid) return sendText(res, 400, 'missing bvid');

  let src;
  try {
    src = await getCachedSource(bvid, cid);
  } catch (e) {
    return sendText(res, 502, '取音频流失败: ' + e.message);
  }

  const range = req.headers.range;
  const attempt = async (urls) => {
    let lastErr = null;
    for (const u of urls) {
      try {
        const upstream = await fetch(u, {
          headers: {
            ...BASE_HEADERS,
            Accept: '*/*',
            ...(range ? { Range: range } : {}),
          },
          signal: AbortSignal.timeout(30000),
        });
        return { upstream, url: u };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('所有音频节点都连不上');
  };

  let result;
  try {
    result = await attempt(src.urls);
    // 链接过期 / 被拒 -> 强制刷新一次
    if (result.upstream.status === 403 || result.upstream.status === 410) {
      const fresh = await getCachedSource(bvid, cid, true);
      result = await attempt(fresh.urls);
      src = fresh;
    }
  } catch (e) {
    return sendText(res, 502, '音频节点不可达: ' + e.message);
  }

  const up = result.upstream;

  if (up.status >= 400) {
    return sendText(res, up.status, 'B站拒绝: ' + up.status);
  }

  const headers = {
    'Content-Type': src.mime || 'audio/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  const len = up.headers.get('content-length');
  const cr = up.headers.get('content-range');
  if (len) headers['Content-Length'] = len;
  if (cr) headers['Content-Range'] = cr;

  res.writeHead(up.status, headers);

  if (!up.body) return res.end();
  const nodeStream = Readable.fromWeb(up.body);
  nodeStream.on('error', () => res.destroy());
  req.on('close', () => nodeStream.destroy());
  nodeStream.pipe(res);
}

/* ------------------------------------------------------------------ */
/* 图片代理                                                             */
/* ------------------------------------------------------------------ */

async function proxyImage(req, res, rawUrl) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return sendText(res, 400, 'bad url');
  }
  if (!/^https?:$/.test(target.protocol) || !isAllowedImageHost(target.hostname)) {
    return sendText(res, 403, 'host not allowed');
  }

  // 封面是静态图，URL 变了图才变 —— 按 URL 哈希落盘，之后完全不用联网
  const key = crypto.createHash('sha1').update(target.href).digest('hex');
  const file = path.join(IMG_DIR, key);

  try {
    const buf = fs.readFileSync(file);
    let ct = 'image/jpeg';
    try {
      ct = fs.readFileSync(file + '.ct', 'utf8').trim() || ct;
    } catch {
      /* 类型文件丢了就按 jpeg 发，浏览器能自己嗅探 */
    }
    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Length': buf.length,
      'Cache-Control': IMG_MAX_AGE,
    });
    return res.end(buf);
  } catch {
    /* 没缓存，往下回源 */
  }

  try {
    const up = await fetch(target.href, {
      headers: { ...BASE_HEADERS, Accept: 'image/*' },
      signal: AbortSignal.timeout(15000),
    });
    if (up.status >= 400) return sendText(res, up.status, 'upstream ' + up.status);

    const ct = up.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await up.arrayBuffer());

    // 写盘失败不影响这次响应，下次再拉一遍就是了
    try {
      fs.mkdirSync(IMG_DIR, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.writeFileSync(`${tmp}.ct`, ct);
      fs.renameSync(tmp, file);
      fs.renameSync(`${tmp}.ct`, `${file}.ct`);
    } catch {
      /* 忽略 */
    }

    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Length': buf.length,
      'Cache-Control': IMG_MAX_AGE,
    });
    res.end(buf);
  } catch (e) {
    sendText(res, 502, 'image fetch failed: ' + e.message);
  }
}

/* ------------------------------------------------------------------ */
/* 某账号下的公开收藏夹                                                  */
/* ------------------------------------------------------------------ */

async function listPublicFolders(mid) {
  const out = [];
  let pn = 1;
  while (pn <= 5) {
    const j = await biliJson(
      `https://api.bilibili.com/x/v3/fav/folder/created/list?up_mid=${encodeURIComponent(mid)}&pn=${pn}&ps=50`
    );
    if (j.code !== 0) {
      const err = new Error(j.message || `错误码 ${j.code}`);
      err.code = j.code;
      throw err;
    }
    const list = (j.data && j.data.list) || [];
    for (const f of list) {
      // attr 是位掩码，公开收藏夹不一定是 0（官方号常见 22 / 258），
      // 所以这里不按 attr 过滤；私密夹未登录读取时会在加载阶段报 -403。
      out.push({
        mediaId: String(f.id),
        title: f.title || '未命名收藏夹',
        count: f.media_count || 0,
        cover: f.cover || '',
        upper: (f.upper && f.upper.name) || '',
        isPrivate: !!(f.attr & 1),
      });
    }
    if (list.length < 50) break;
    pn += 1;
    await sleep(200);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 收藏夹歌单本地缓存                                                    */
/* ------------------------------------------------------------------ */

/**
 * 一个收藏夹一首歌一页 20 条，125 首就要翻 7 页、每页限速 220ms，
 * 每次打开都去 B 站拉一遍纯属浪费 —— 拉下来就存本地，之后直接读盘。
 * 只有带 refresh=1 时才重新请求（顶栏那个刷新按钮）。
 */

function favCacheFile(mediaId) {
  return path.join(FAV_DIR, `${mediaId}.json`);
}

function readFavCache(mediaId) {
  try {
    const j = JSON.parse(fs.readFileSync(favCacheFile(mediaId), 'utf8'));
    if (!j || !Array.isArray(j.tracks)) return null;
    return j;
  } catch {
    return null; // 没缓存 / 文件坏了，都当作没有
  }
}

function writeFavCache(mediaId, data) {
  try {
    fs.mkdirSync(FAV_DIR, { recursive: true });
    const file = favCacheFile(mediaId);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), ...data }), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('[fav] 缓存写入失败:', e.message); // 写不进去不影响这次返回
  }
}

/** 收藏夹从列表里删掉后，把它的缓存也清掉，免得 data/fav 越堆越大 */
function pruneFavCache(keepIds) {
  try {
    const keep = new Set(keepIds.map(String));
    for (const name of fs.readdirSync(FAV_DIR)) {
      if (!name.endsWith('.json')) continue;
      if (!keep.has(name.slice(0, -5))) fs.unlinkSync(path.join(FAV_DIR, name));
    }
  } catch {
    /* 目录还不存在，没什么可清的 */
  }
}

/* ------------------------------------------------------------------ */
/* 收藏夹列表持久化（服务端文件）                                        */
/* ------------------------------------------------------------------ */

function readLibrary() {
  try {
    const raw = fs.readFileSync(LIBRARY_FILE, 'utf8');
    const j = JSON.parse(raw);
    return {
      current: j.current ? String(j.current) : null,
      folders: Array.isArray(j.folders) ? j.folders : [],
      updatedAt: j.updatedAt || null,
    };
  } catch {
    return { current: null, folders: [], updatedAt: null };
  }
}

function writeLibrary(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 先写临时文件再 rename，避免写一半断电留下坏 JSON
  const tmp = `${LIBRARY_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, LIBRARY_FILE);
}

/** 把外部传来的数据收敛成安全形状，避免脏数据写进文件 */
function sanitizeLibrary(input) {
  const folders = (Array.isArray(input.folders) ? input.folders : [])
    .map((f) => ({
      mediaId: String(f && f.mediaId != null ? f.mediaId : '').trim(),
      title: String((f && f.title) || ''),
      count: Number(f && f.count) || 0,
      cover: String((f && f.cover) || ''),
      upper: String((f && f.upper) || ''),
    }))
    .filter((f) => /^\d+$/.test(f.mediaId));

  // 去重（同一个收藏夹只留一条）
  const seen = new Set();
  const uniq = folders.filter((f) => (seen.has(f.mediaId) ? false : (seen.add(f.mediaId), true)));

  let current = input.current != null ? String(input.current) : null;
  if (current && !uniq.some((f) => f.mediaId === current)) current = uniq.length ? uniq[0].mediaId : null;

  return { current, folders: uniq, updatedAt: new Date().toISOString() };
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* 播放进度持久化（按 bvid 记录到秒，多端共享）                          */
/* ------------------------------------------------------------------ */

const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');
const PROGRESS_MAX = 800; // 最多保留多少首的历史位置

let progressCache = null;
let progressDirty = false;
let progressFlushTimer = null;

function loadProgress() {
  if (progressCache) return progressCache;
  try {
    const j = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    progressCache = j && typeof j === 'object' ? j : {};
  } catch {
    progressCache = {};
  }
  if (!progressCache.tracks || typeof progressCache.tracks !== 'object') progressCache.tracks = {};
  if (!progressCache.last || typeof progressCache.last !== 'object') progressCache.last = null;
  return progressCache;
}

function flushProgress() {
  if (!progressDirty || !progressCache) return;
  progressDirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${PROGRESS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(progressCache), 'utf8');
    fs.renameSync(tmp, PROGRESS_FILE);
  } catch (e) {
    console.error('[progress] 写入失败:', e.message);
  }
}

/** 播放中每几秒就上报一次，没必要每次都落盘，合并成 4 秒一次 */
function scheduleFlush() {
  progressDirty = true;
  if (progressFlushTimer) return;
  progressFlushTimer = setTimeout(() => {
    progressFlushTimer = null;
    flushProgress();
  }, 4000);
}

function recordProgress({ bvid, pos, dur, mediaId }) {
  const p = loadProgress();
  const now = Date.now();
  const entry = {
    pos: Math.round(pos * 10) / 10,
    dur: Math.round(dur),
    at: now,
  };
  if (mediaId) entry.mediaId = String(mediaId);

  p.tracks[bvid] = entry;
  p.last = { bvid, mediaId: mediaId ? String(mediaId) : null, pos: entry.pos, dur: entry.dur, at: now };

  const keys = Object.keys(p.tracks);
  if (keys.length > PROGRESS_MAX) {
    // 超出上限时丢掉最久没碰过的
    keys.sort((a, b) => (p.tracks[a].at || 0) - (p.tracks[b].at || 0));
    for (const k of keys.slice(0, keys.length - PROGRESS_MAX)) delete p.tracks[k];
  }

  scheduleFlush();
  return entry;
}

/* ------------------------------------------------------------------ */
/* 播放历史（每次播放记一条明细，另存一份按歌聚合的统计）               */
/* ------------------------------------------------------------------ */

const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const HISTORY_MAX = 5000; // 明细最多留多少条
const HISTORY_STATS_MAX = 2000; // 聚合最多留多少首

let historyCache = null;
let historyDirty = false;
let historyFlushTimer = null;

function loadHistory() {
  if (historyCache) return historyCache;
  try {
    const j = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    historyCache = j && typeof j === 'object' ? j : {};
  } catch {
    historyCache = {};
  }
  if (!Array.isArray(historyCache.entries)) historyCache.entries = [];
  if (!historyCache.stats || typeof historyCache.stats !== 'object') historyCache.stats = {};
  return historyCache;
}

function flushHistory() {
  if (!historyDirty || !historyCache) return;
  historyDirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${HISTORY_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(historyCache), 'utf8');
    fs.renameSync(tmp, HISTORY_FILE);
  } catch (e) {
    console.error('[history] 写入失败:', e.message);
  }
}

/** 切歌时才会写一条，没必要每条都落盘，合并成 1 秒一次 */
function scheduleHistoryFlush() {
  historyDirty = true;
  if (historyFlushTimer) return;
  historyFlushTimer = setTimeout(() => {
    historyFlushTimer = null;
    flushHistory();
  }, 1000);
}

function recordHistory(rec) {
  const h = loadHistory();
  h.entries.push(rec);
  if (h.entries.length > HISTORY_MAX) h.entries.splice(0, h.entries.length - HISTORY_MAX);

  const st = h.stats[rec.bvid] || (h.stats[rec.bvid] = { plays: 0, played: 0 });
  st.plays += 1;
  st.played += rec.played;
  st.last = rec.at;
  st.title = rec.title;
  st.upper = rec.upper;
  st.dur = rec.dur;

  const keys = Object.keys(h.stats);
  if (keys.length > HISTORY_STATS_MAX) {
    // 超出上限时丢掉最久没听过的
    keys.sort((a, b) => (h.stats[a].last || 0) - (h.stats[b].last || 0));
    for (const k of keys.slice(0, keys.length - HISTORY_STATS_MAX)) delete h.stats[k];
  }

  scheduleHistoryFlush();
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                             */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'forbidden');

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      if (rel === '/index.html') return sendText(res, 500, '缺少 public/index.html');
      return sendText(res, 404, 'not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ */
/* 路由                                                                 */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname, searchParams } = url;

  try {
    if (pathname === '/api/library') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { ok: true, ...readLibrary() });
      }
      if (req.method === 'POST') {
        const raw = await readBody(req);
        let input;
        try {
          input = JSON.parse(raw || '{}');
        } catch {
          return sendJson(res, 400, { ok: false, error: '不是合法 JSON' });
        }
        const clean = sanitizeLibrary(input);
        writeLibrary(clean);
        pruneFavCache(clean.folders.map((f) => f.mediaId));
        return sendJson(res, 200, { ok: true, current: clean.current, count: clean.folders.length });
      }
      return sendJson(res, 405, { ok: false, error: '只支持 GET / POST' });
    }

    if (pathname === '/api/progress') {
      if (req.method === 'GET') {
        const p = loadProgress();
        const bvid = (searchParams.get('bvid') || '').trim();
        if (bvid) return sendJson(res, 200, { ok: true, track: p.tracks[bvid] || null });
        return sendJson(res, 200, { ok: true, last: p.last, tracks: p.tracks });
      }

      if (req.method === 'POST') {
        const raw = await readBody(req, 64 * 1024);
        let d;
        try {
          d = JSON.parse(raw || '{}');
        } catch {
          return sendJson(res, 400, { ok: false, error: '不是合法 JSON' });
        }
        const bvid = String(d.bvid || '').trim();
        if (!/^BV[0-9A-Za-z]{8,12}$/.test(bvid)) {
          return sendJson(res, 400, { ok: false, error: 'bvid 不合法' });
        }
        const clamp = (n) => Math.max(0, Math.min(Number(n) || 0, 86400));
        const entry = recordProgress({
          bvid,
          pos: clamp(d.pos),
          dur: clamp(d.dur),
          mediaId: d.mediaId,
        });
        return sendJson(res, 200, { ok: true, entry });
      }

      return sendJson(res, 405, { ok: false, error: '只支持 GET / POST' });
    }

    if (pathname === '/api/history') {
      if (req.method === 'GET') {
        const h = loadHistory();
        const limit = Math.max(1, Math.min(Number(searchParams.get('limit')) || 200, HISTORY_MAX));
        // 明细按时间倒序给（最近听的在最前面），方便直接看
        const entries = h.entries.slice(-limit).reverse();
        return sendJson(res, 200, { ok: true, total: h.entries.length, entries, stats: h.stats });
      }

      if (req.method === 'POST') {
        const raw = await readBody(req, 16 * 1024);
        let d;
        try {
          d = JSON.parse(raw || '{}');
        } catch {
          return sendJson(res, 400, { ok: false, error: '不是合法 JSON' });
        }
        const bvid = String(d.bvid || '').trim();
        if (!/^BV[0-9A-Za-z]{8,12}$/.test(bvid)) {
          return sendJson(res, 400, { ok: false, error: 'bvid 不合法' });
        }
        const clamp = (n) => Math.max(0, Math.min(Number(n) || 0, 86400));
        const rec = {
          bvid,
          title: String(d.title || '').slice(0, 200),
          upper: String(d.upper || '').slice(0, 100),
          cover: String(d.cover || '').slice(0, 500),
          mediaId: d.mediaId ? String(d.mediaId) : null,
          dur: Math.round(clamp(d.dur)), // 这首歌总长
          played: Math.round(clamp(d.played)), // 这次实际听了多久
          at: Number(d.at) > 0 ? Math.round(Number(d.at)) : Date.now(),
        };
        // 一秒都没听就别记，免得拖动进度条/误点塞满历史
        if (rec.played < 1) return sendJson(res, 200, { ok: true, skipped: true });
        recordHistory(rec);
        return sendJson(res, 200, { ok: true, count: loadHistory().entries.length });
      }

      return sendJson(res, 405, { ok: false, error: '只支持 GET / POST' });
    }

    if (pathname === '/api/fav') {
      const mediaId = (searchParams.get('media_id') || '').trim();
      if (!/^\d+$/.test(mediaId)) return sendJson(res, 400, { ok: false, error: '收藏夹 ID 应该是纯数字' });

      // 默认走本地缓存，只有显式 refresh=1 才去 B 站重新拉
      const refresh = searchParams.get('refresh') === '1';
      if (!refresh) {
        const hit = readFavCache(mediaId);
        if (hit) return sendJson(res, 200, { ok: true, ...hit, cached: true });
      }

      let data;
      try {
        data = await favAll(mediaId);
      } catch (e) {
        // 回源失败（断网 / 风控 / 收藏夹被删）时，有旧缓存就先顶上，别让用户啥也听不了
        const hit = readFavCache(mediaId);
        if (hit) {
          return sendJson(res, 200, {
            ok: true,
            ...hit,
            cached: true,
            warning: e.message || String(e),
          });
        }
        throw e;
      }
      writeFavCache(mediaId, data);
      return sendJson(res, 200, { ok: true, ...data, cached: false });
    }

    if (pathname === '/api/folders') {
      const mid = (searchParams.get('mid') || '').trim();
      if (!/^\d+$/.test(mid)) return sendJson(res, 400, { ok: false, error: 'UID 应该是纯数字' });
      const folders = await listPublicFolders(mid);
      return sendJson(res, 200, { ok: true, folders });
    }

    if (pathname === '/api/audio') {
      return await proxyAudio(req, res, (searchParams.get('bvid') || '').trim(), Number(searchParams.get('cid')) || 0);
    }

    if (pathname === '/api/img') {
      return await proxyImage(req, res, searchParams.get('u') || '');
    }

    if (pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, uptime: process.uptime() });
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'no such api' });

    return serveStatic(req, res, pathname);
  } catch (e) {
    if (pathname === '/api/fav') {
      return sendJson(res, 200, { ok: false, error: e.message || String(e), code: e.code });
    }
    return sendJson(res, 500, { ok: false, error: e.message || String(e) });
  }
});

server.listen(PORT, HOST, () => {
  const isLocal = HOST === '127.0.0.1' || HOST === 'localhost';
  const url = `http://localhost:${PORT}`;
  const line = `  B站收藏夹播放器已启动  ->  ${isLocal ? url : `http://${HOST}:${PORT}`}`;
  console.log('\n' + '='.repeat(line.length));
  console.log(line);
  console.log('='.repeat(line.length));
  console.log(`  监听 ${HOST}:${PORT}`);
  console.log('  关闭这个窗口即停止播放器。\n');

  // 自动打开浏览器：只在监听本机回环时做（服务器上没浏览器）
  if (!process.env.NO_OPEN && isLocal) {
    const { exec } = require('child_process');
    const cmd =
      process.platform === 'win32'
        ? `start "" "${url}"`
        : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用。换个端口再试：PORT=7789 node server.js\n`);
    process.exit(1);
  }
  throw e;
});

// 退出前把还没落盘的播放进度写完（pm2 restart 走 SIGINT）
process.on('exit', () => flushProgress());
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    flushProgress();
    process.exit(0);
  });
});
