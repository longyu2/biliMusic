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

/* ------------------------------------------------------------------ */
/* 运行形态探测：源码运行 vs 打包成单文件 exe（Node SEA）                 */
/* ------------------------------------------------------------------ */

// 打包成 exe 后静态资源内嵌在可执行文件里，没有 public 目录可读
let SEA = null;
try {
  SEA = require('node:sea');
  if (typeof SEA.isSea !== 'function' || !SEA.isSea()) SEA = null;
} catch {
  SEA = null;
}

// SEA 下 __dirname 指向 exe 所在目录，data/ 就落在旁边（解压即用）
const BASE_DIR = SEA ? path.dirname(process.execPath) : __dirname;

const PORT = Number(process.env.PORT) || 7788;
// 默认只监听本机；部署到服务器时用 HOST=0.0.0.0 让局域网可访问
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(BASE_DIR, 'public');
// 收藏夹列表存服务端文件，换设备/换浏览器都能看到同一份
const DATA_DIR = process.env.DATA_DIR || path.join(BASE_DIR, 'data');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
// 每个收藏夹的歌单单独存一份，打开时直接读盘，不用再去 B 站翻页
const FAV_DIR = path.join(DATA_DIR, 'fav');
// 封面图缓存：B 站图床在公网，每次回源都要多等几百毫秒
const IMG_DIR = path.join(DATA_DIR, 'img');
// 单独导入的合集快照，和收藏夹缓存分开存
const SEASON_DIR = path.join(DATA_DIR, 'season');
// 每个视频的音频码率（要查 playurl 才拿得到，查过就落盘，别反复问 B 站）
const META_DIR = path.join(DATA_DIR, 'meta');
// 播放过的音频整文件落盘，第二次播放不再走 B 站，省流量
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const AUDIO_MAX_BYTES = 3 * 1024 * 1024 * 1024; // 缓存上限 3GB，超了按最旧清
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

/**
 * 部分接口（如合集列表 seasons_archives_list）没有 buvid Cookie 时
 * 会直接返回 -352 风控，即使请求来自浏览器同款 UA。
 * 这里在服务端自己领一对 buvid 并缓存，后续所有接口请求都带上。
 */
const BUVID_TTL = 12 * 60 * 60 * 1000;
let buvidCache = null;
let buvidPromise = null;

function getBuvid() {
  if (buvidCache && Date.now() - buvidCache.ts < BUVID_TTL) return Promise.resolve(buvidCache);
  if (buvidPromise) return buvidPromise;
  buvidPromise = (async () => {
    try {
      const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
        headers: BASE_HEADERS,
        signal: AbortSignal.timeout(10000),
      });
      const j = await res.json();
      const b3 = j && j.data && j.data.b_3;
      const b4 = j && j.data && j.data.b_4;
      if (b3 && b4) return (buvidCache = { b3, b4, ts: Date.now() });
    } catch {
      /* 领不到就退化成不带 Cookie，接口自己会报错 */
    } finally {
      buvidPromise = null;
    }
    return null;
  })();
  return buvidPromise;
}

async function biliJson(url, extraHeaders) {
  const headers = { ...BASE_HEADERS, ...(extraHeaders || {}) };
  if (!headers.Cookie) {
    const bv = await getBuvid();
    if (bv) headers.Cookie = `buvid3=${bv.b3}; buvid4=${bv.b4}`;
  }
  const res = await fetch(url, {
    headers,
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
  // 登录后带上 Cookie：私密收藏夹也能读
  return biliJson(url, await authHeaders());
}

function normalizeMedia(m) {
  const type = Number(m.type) || 2;
  const dead = !m.title || m.title === '已失效视频' || m.title === '已失效' || m.attr === 9;
  const track = {
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
  // type 21 是「收藏的整个合集」，本身没有 bvid，展开成单集后才能播
  if (type === 21) {
    track.seasonId = String(m.id);
    track.seasonTitle = m.title || '合集';
  }
  return track;
}

/** 合集展开：type 21 的收藏条目只有合集 id，需要按 mid + season_id 拉出全部单集 */
const SEASON_PAGE_SIZE = 30;
const SEASON_MAX_PAGES = 40;

function normalizeSeasonArchive(a, ctx) {
  const title = a.title || '';
  return {
    avid: a.aid,
    bvid: a.bvid || '',
    title: title || '（已失效）',
    cover: a.pic || '',
    duration: Number(a.duration) || 0,
    upper: ctx.upper || '',
    upperMid: ctx.mid || 0,
    intro: a.desc || '',
    play: (a.stat && a.stat.view) || 0,
    favTime: 0,
    dead: !a.bvid || !title,
    seasonId: String(ctx.seasonId),
    seasonTitle: ctx.seasonTitle || '',
    seasonCover: ctx.seasonCover || '',
  };
}

async function seasonData(ctx) {
  const tracks = [];
  let meta = null;

  for (let pn = 1; pn <= SEASON_MAX_PAGES; pn += 1) {
    const j = await biliJson(
      `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${encodeURIComponent(
        ctx.mid
      )}&season_id=${encodeURIComponent(ctx.seasonId)}&page_num=${pn}&page_size=${SEASON_PAGE_SIZE}`
    );
    if (j.code !== 0) {
      const err = new Error(j.message || `合集读取失败 ${j.code}`);
      err.code = j.code;
      throw err;
    }

    const data = j.data || {};
    if (pn === 1) meta = data.meta || null;
    const archives = data.archives || [];
    const resolved = {
      mid: ctx.mid,
      seasonId: ctx.seasonId,
      seasonTitle: (meta && (meta.title || meta.name)) || ctx.seasonTitle || `合集 ${ctx.seasonId}`,
      seasonCover: (meta && meta.cover) || ctx.seasonCover || '',
      upper: ctx.upper || '',
    };
    for (const a of archives) tracks.push(normalizeSeasonArchive(a, resolved));

    const total = (data.page && data.page.total) || (meta && meta.total) || 0;
    if (!archives.length || (total && tracks.length >= total) || archives.length < SEASON_PAGE_SIZE) break;
    await sleep(220);
  }

  // card 接口在部分网络下会被风控，退一步用任意一集的 view 拿 UP 昵称
  if (!ctx.upper) {
    const first = tracks.find((t) => t.bvid);
    const name = first ? await fetchOwnerName(first.bvid) : '';
    if (name) {
      ctx.upper = name;
      for (const t of tracks) if (!t.upper) t.upper = name;
    }
  }

  return {
    info: {
      id: String(ctx.seasonId),
      mid: String(ctx.mid),
      title: (meta && (meta.title || meta.name)) || ctx.seasonTitle || `合集 ${ctx.seasonId}`,
      cover: (meta && meta.cover) || ctx.seasonCover || '',
      upper: ctx.upper || '',
      count: (meta && meta.total) || tracks.length,
      description: (meta && meta.description) || '',
    },
    tracks,
  };
}

/** 合集 meta 里没有 UP 昵称，单独查一次（失败不影响导入） */
async function fetchUpperName(mid) {
  try {
    const j = await biliJson(`https://api.bilibili.com/x/web-interface/card?mid=${encodeURIComponent(mid)}`);
    return (j.data && j.data.card && j.data.card.name) || '';
  } catch {
    return '';
  }
}

/** card 被风控时，改用任意一集的 view 拿 UP 昵称 */
async function fetchOwnerName(bvid) {
  try {
    const j = await biliJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
    return (j.data && j.data.owner && j.data.owner.name) || '';
  } catch {
    return '';
  }
}

/** 把 type 21 占位条目替换成它包含的单集；普通视频优先，重复 bvid 只留一条 */
async function expandSeasonTracks(tracks) {
  const plain = new Set(tracks.filter((t) => !t.seasonId && t.bvid).map((t) => t.bvid));
  const added = new Set();
  const out = [];

  for (const t of tracks) {
    if (!t.seasonId) {
      if (!t.bvid || !added.has(t.bvid)) {
        if (t.bvid) added.add(t.bvid);
        out.push(t);
      }
      continue;
    }

    if (!t.upperMid) {
      out.push({ ...t, dead: true, title: `${t.seasonTitle}（合集，缺少 UP 信息）` });
      continue;
    }

    try {
      const { tracks: eps } = await seasonData({
        mid: t.upperMid,
        seasonId: t.seasonId,
        seasonTitle: t.seasonTitle,
        seasonCover: t.cover,
        upper: t.upper,
      });
      if (!eps.length) {
        out.push({ ...t, dead: true, title: `${t.seasonTitle}（合集为空）` });
        continue;
      }
      for (const ep of eps) {
        if (!ep.bvid || plain.has(ep.bvid) || added.has(ep.bvid)) continue;
        added.add(ep.bvid);
        out.push(ep);
      }
    } catch (e) {
      console.error(`[fav] 合集 ${t.seasonId} 展开失败:`, e.message);
      out.push({ ...t, dead: true, title: `${t.seasonTitle}（合集，展开失败）` });
    }
  }

  return out;
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
    tracks: await expandSeasonTracks(tracks),
  };
}

/* ------------------------------------------------------------------ */
/* B 站搜索                                                             */
/* ------------------------------------------------------------------ */

/**
 * 搜索结果标题里带 <em class="keyword">高亮标签</em>，
 * 得先去掉标签再把 HTML 实体还原，否则列表里会显示成一堆尖括号。
 */
function stripSearchText(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&') // &amp; 放最后，避免把上面还原出来的再解一次
    .trim();
}

/** 搜索结果的时长是 "5:50" / "1:02:03" 这种文本，转成秒 */
function parseDurationText(s) {
  const parts = String(s || '')
    .split(':')
    .map((x) => Number(x));
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// 同一关键词 5 分钟内直接复用，连续回车/刷新不会反复打 B 站接口
const SEARCH_TTL = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 60;
const searchCache = new Map(); // `${keyword}#${page}` -> { ts, data }

/** 视频搜索（第一页 20 条），返回和收藏夹曲目同构的 tracks */
async function searchVideos(keyword, page = 1) {
  const key = `${keyword}#${page}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.ts < SEARCH_TTL) return hit.data;

  const url =
    'https://api.bilibili.com/x/web-interface/search/type?search_type=video' +
    `&keyword=${encodeURIComponent(keyword)}&page=${page}&page_size=20&order=totalrank`;
  const j = await biliJson(url);
  if (j.code !== 0) {
    const err = new Error(j.message || `搜索失败 ${j.code}`);
    err.code = j.code;
    throw err;
  }

  const d = j.data || {};
  const tracks = [];
  for (const it of d.result || []) {
    if (!it || !it.bvid) continue;
    if (it.type && it.type !== 'video') continue; // 混进来的番剧/课程条目播不了
    tracks.push({
      avid: it.aid,
      bvid: it.bvid,
      title: stripSearchText(it.title) || '（无标题）',
      cover: it.pic || '',
      duration: parseDurationText(it.duration),
      upper: stripSearchText(it.author),
      upperMid: it.mid || 0,
      intro: stripSearchText(it.description),
      play: Number(it.play) || 0,
      pubdate: Number(it.pubdate) || 0,
      favTime: 0,
      dead: false,
      fromSearch: true,
    });
  }

  const data = {
    keyword,
    page: Number(d.page) || page,
    pageSize: Number(d.pagesize) || 20,
    total: Number(d.numResults) || 0,
    pages: Number(d.numPages) || 0,
    tracks,
  };

  searchCache.set(key, { ts: Date.now(), data });
  if (searchCache.size > SEARCH_CACHE_MAX) {
    searchCache.delete(searchCache.keys().next().value); // 超量丢最早的一条
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* 视频所属的合集（搜索结果里要用）                                       */
/* ------------------------------------------------------------------ */

/**
 * B 站搜索接口不告诉你「这条视频属于哪个合集」，只有 x/web-interface/view 里带 ugc_season。
 * 所以搜索完在后台逐条补一下：限速 + 内存缓存，查不到就当它没有合集。
 */
const SEASON_OF_TTL = 30 * 60 * 1000;
const seasonOfCache = new Map(); // bvid -> { ts, data }，data = null 表示确实不在合集里

async function seasonOfBvid(bvid) {
  const hit = seasonOfCache.get(bvid);
  if (hit && Date.now() - hit.ts < SEASON_OF_TTL) return hit.data;

  let data = null;
  try {
    const j = await biliJson(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      await authHeaders()
    );
    const s = j && j.data && j.data.ugc_season;
    if (s && s.id) {
      data = {
        seasonId: String(s.id),
        title: s.title || '',
        mid: String(s.mid || ''),
        cover: s.cover || '',
      };
    }
  } catch {
    return undefined; // 网络 / 风控失败：不写缓存，下次还能再试
  }

  seasonOfCache.set(bvid, { ts: Date.now(), data });
  if (seasonOfCache.size > 600) seasonOfCache.delete(seasonOfCache.keys().next().value);
  return data;
}

/** 批量查（最多 20 条），条与条之间留点间隔，别把风控惹毛 */
async function seasonsOfMany(bvids) {
  const map = {};
  let first = true;
  for (const bvid of bvids) {
    if (!first) await sleep(160);
    first = false;
    const r = await seasonOfBvid(bvid);
    if (r === undefined) continue; // 查失败的不写进结果，前端下次还会再问
    map[bvid] = r;
  }
  return map;
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
/* 音频码率（列表里显示「音质」用）                                       */
/* ------------------------------------------------------------------ */

/**
 * 码率只有 playurl 里有（dash.audio[].bandwidth），得先拿 cid 再查一次。
 * 一个视频两次请求，所以：查过就落盘（data/meta/<bvid>.json），7 天内直接读盘。
 */
const META_TTL = 7 * 24 * 60 * 60 * 1000;

function metaFile(bvid) {
  return path.join(META_DIR, `${bvid}.json`);
}

function readMeta(bvid) {
  try {
    const j = JSON.parse(fs.readFileSync(metaFile(bvid), 'utf8'));
    if (j && typeof j.bandwidth === 'number' && Date.now() - (j.ts || 0) < META_TTL) return j;
  } catch {
    /* 没缓存 */
  }
  return null;
}

function writeMeta(bvid, data) {
  try {
    fs.mkdirSync(META_DIR, { recursive: true });
    const file = metaFile(bvid);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...data, ts: Date.now() }), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* 写不进去不影响这次返回 */
  }
}

async function bitrateOf(bvid) {
  const hit = readMeta(bvid);
  if (hit) return { bandwidth: hit.bandwidth, quality: hit.quality || 0, estimated: !!hit.estimated, cached: true };

  const info = await resolveCid(bvid); // 顺带拿 cid
  let src;
  try {
    src = await audioSource(bvid, info.cid);
  } catch (e) {
    throw e;
  }
  const data = { bandwidth: src.bandwidth || 0, quality: src.quality || 0, mime: src.mime || '' };

  // 老视频可能只有 durl（flv/mp4 混流，音视频合在一起）：
  // 用「分段总字节数 × 8 ÷ 时长」估算一个总码率，标记 estimated，前端显示 ≈
  if (!data.bandwidth) {
    try {
      const j = await biliJson(
        `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${info.cid}&fnval=16&fnver=0&fourk=1`,
        await authHeaders()
      );
      const durl = j && j.data && j.data.durl;
      const tl = j && j.data && j.data.timelength;
      if (Array.isArray(durl) && durl.length && tl > 0) {
        const bytes = durl.reduce((a, x) => a + Number(x.size || 0), 0);
        if (bytes > 0) {
          data.bandwidth = Math.round((bytes * 8) / (tl / 1000));
          data.estimated = true; // 混流里含视频流，只能算个大概
        }
      }
    } catch {
      /* 估算失败就按 0 算 */
    }
  }

  writeMeta(bvid, data);
  return data;
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

/* ---------------- 音频磁盘缓存 ---------------- */

const audioCache = new Map(); // bvid -> { total, hit } 防并发下载同一首

function audioCacheFile(bvid) {
  return path.join(AUDIO_DIR, bvid + '.m4a');
}

function audioCacheComplete(bvid) {
  try {
    const st = fs.statSync(audioCacheFile(bvid));
    return st.size > 0 ? st : null;
  } catch {
    return null;
  }
}

/** 超上限时按 mtime 最旧优先清理（正在下载的不动） */
function pruneAudioCache() {
  let files;
  try {
    files = fs.readdirSync(AUDIO_DIR).filter((f) => f.endsWith('.m4a'));
  } catch {
    return;
  }
  let total = 0;
  const items = [];
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(AUDIO_DIR, f));
      total += st.size;
      items.push({ f, path: path.join(AUDIO_DIR, f), size: st.size, mtime: st.mtimeMs });
    } catch {}
  }
  if (total <= AUDIO_MAX_BYTES) return;
  items.sort((a, b) => a.mtime - b.mtime);
  for (const it of items) {
    if (total <= AUDIO_MAX_BYTES) break;
    if (audioCache.has(it.f.replace('.m4a', ''))) continue; // 正在下载的不清
    try {
      fs.unlinkSync(it.path);
      total -= it.size;
    } catch {}
  }
}

async function proxyAudio(req, res, bvid, cid) {
  if (!bvid) return sendText(res, 400, 'missing bvid');

  /* 完整缓存命中：本地直接伺服，支持 Range 拖进度条 */
  const cached = audioCacheComplete(bvid);
  if (cached) {
    const buf = fs.readFileSync(audioCacheFile(bvid));
    const total = buf.length;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= total) end = total - 1;
      if (start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': 'audio/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': end - start + 1,
        'Cache-Control': 'no-store',
      });
      return res.end(buf.subarray(start, end + 1));
    }
    res.writeHead(200, {
      'Content-Type': 'audio/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Length': total,
      'Cache-Control': 'no-store',
    });
    return res.end(buf);
  }

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

  /* 从头开始的整文件请求才落盘（下载完转正）；
     浏览器 <audio> 通常发 Range: bytes=0-，也算整文件；
     中途拖进度条（start>0 或带 end）的不缓存半截 */
  const m0 = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
  const isFullRequest = !range || (m0 && m0[1] === '0' && !m0[2]);
  let cacheStream = null;
  const canCache = isFullRequest && (up.status === 200 || up.status === 206) && (src.mime || '').includes('mp4');
  if (canCache) {
    try {
      fs.mkdirSync(AUDIO_DIR, { recursive: true });
      const tmp = audioCacheFile(bvid) + '.part';
      cacheStream = fs.createWriteStream(tmp);
      audioCache.set(bvid, { ts: Date.now() });
    } catch {
      cacheStream = null; // 磁盘满/只读等，退化为纯转发
    }
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

  if (!up.body) {
    if (cacheStream) cacheStream.end();
    return res.end();
  }
  const nodeStream = Readable.fromWeb(up.body);
  nodeStream.on('error', () => {
    if (cacheStream) cacheStream.destroy();
    res.destroy();
  });
  req.on('close', () => {
    nodeStream.destroy();
    // 没下完就断开：删掉半截文件，别留垃圾
    if (cacheStream && !nodeStream.readableEnded) {
      audioCache.delete(bvid);
      try { fs.unlinkSync(audioCacheFile(bvid) + '.part'); } catch {}
    }
  });

  if (cacheStream) {
    const tmp = audioCacheFile(bvid) + '.part';
    cacheStream.on('error', () => {
      try { fs.unlinkSync(tmp); } catch {}
    });
    cacheStream.on('finish', () => {
      try {
        fs.renameSync(tmp, audioCacheFile(bvid));
        audioCache.delete(bvid);
        pruneAudioCache();
      } catch {}
    });
    nodeStream.pipe(cacheStream);
    nodeStream.pipe(res);
  } else {
    nodeStream.pipe(res);
  }
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
      `https://api.bilibili.com/x/v3/fav/folder/created/list?up_mid=${encodeURIComponent(mid)}&pn=${pn}&ps=50`,
      await authHeaders()
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
/* B 站登录（扫码）与「添加到自己的收藏夹」                                */
/* ------------------------------------------------------------------ */

/**
 * 登录态只存在服务端 data/auth.json（0600），前端永远拿不到 Cookie，
 * 只会拿到 uname / face / mid。退出登录就是删这个文件。
 * 没登录时所有请求行为和以前完全一样（匿名 + buvid）。
 */
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
let authCache = null;

function readAuth() {
  if (authCache) return authCache;
  try {
    const j = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    authCache = j && j.sessdata && j.biliJct ? j : null;
  } catch {
    authCache = null;
  }
  return authCache;
}

function writeAuth(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${AUTH_FILE}.${process.pid}.tmp`;
  // 权限 600：这是账号凭证，同机器其他用户不该能读
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, AUTH_FILE);
  try {
    fs.chmodSync(AUTH_FILE, 0o600);
  } catch {
    /* Windows 上 chmod 基本是空操作，忽略 */
  }
  authCache = data;
}

function clearAuth() {
  authCache = null;
  try {
    fs.unlinkSync(AUTH_FILE);
  } catch {
    /* 本来就没有 */
  }
}

function cookieOf(a) {
  return `SESSDATA=${a.sessdata}; bili_jct=${a.biliJct}; DedeUserID=${a.mid}`;
}

/** 登录后给 B 站接口用的请求头；没登录返回 null（等于匿名） */
async function authHeaders() {
  const a = readAuth();
  if (!a) return null;
  const bv = await getBuvid();
  const parts = [cookieOf(a)];
  if (bv) parts.push(`buvid3=${bv.b3}`, `buvid4=${bv.b4}`);
  return { Cookie: parts.join('; ') };
}

/**
 * 用某个 Cookie 查登录信息。
 * 返回 { user } | { invalid: true } | { error: true }：
 *  - invalid：B 站明确说没登录（-101 / isLogin=false）→ Cookie 真的废了，可以清
 *  - error  ：网络不通 / 风控 / 5xx 之类的临时问题 → **绝不能当成没登录**，
 *             否则一次网络抖动就会把用户辛苦扫的登录态删掉
 */
async function navInfo(cookie) {
  try {
    const bv = await getBuvid();
    const parts = [cookie];
    if (bv) parts.push(`buvid3=${bv.b3}`, `buvid4=${bv.b4}`);
    const j = await biliJson('https://api.bilibili.com/x/web-interface/nav', { Cookie: parts.join('; ') });
    if (!j || typeof j.code !== 'number') return { error: true };
    if (j.code === -101 || j.code === -400) return { invalid: true };
    if (j.code !== 0) return { error: true };
    if (!j.data || !j.data.isLogin) return { invalid: true };
    return {
      user: {
        mid: String(j.data.mid),
        uname: j.data.uname || '',
        face: j.data.face || '',
        vip: !!(j.data.vipStatus),
      },
    };
  } catch {
    return { error: true };
  }
}

/**
 * 当前登录用户。
 * 登录态以 data/auth.json 为准（落盘，重启/部署都不会丢）；
 * 只有 B 站明确说失效才删文件，网络问题就沿用本地保存的信息。
 */
async function currentUser() {
  const a = readAuth();
  if (!a) return null;

  const r = await navInfo(cookieOf(a));
  if (r.invalid) {
    console.warn('[auth] B 站说登录态已失效，清掉本地 Cookie');
    clearAuth();
    return null;
  }
  if (r.error) {
    // 临时故障：继续用本地记录，别把用户踢下线
    return { mid: a.mid, uname: a.uname || '', face: a.face || '', vip: false, offline: true };
  }

  const u = r.user;
  // 昵称/头像可能改过，顺手把本地那份也更新掉
  if (u.mid !== a.mid || u.uname !== a.uname || u.face !== a.face) {
    writeAuth({ ...a, mid: u.mid, uname: u.uname, face: u.face, savedAt: a.savedAt || new Date().toISOString() });
  }
  return u;
}

/* ---- 扫码登录 ---- */

// 二维码有效期 180s，这里留点余量；只用来避免内存里堆无用的 key
const QR_TTL = 5 * 60 * 1000;
const qrKeys = new Map(); // qrcode_key -> 生成时间

async function qrGenerate() {
  const j = await biliJson('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
  if (j.code !== 0 || !j.data || !j.data.qrcode_key) {
    throw new Error(j.message || `二维码生成失败 ${j.code}`);
  }
  qrKeys.set(j.data.qrcode_key, Date.now());
  for (const [k, ts] of qrKeys) if (Date.now() - ts > QR_TTL) qrKeys.delete(k);
  return { key: j.data.qrcode_key, url: j.data.url };
}

/** 轮询扫码结果；成功后落盘 Cookie */
async function qrPoll(key) {
  const bv = await getBuvid();
  const headers = { ...BASE_HEADERS };
  if (bv) headers.Cookie = `buvid3=${bv.b3}; buvid4=${bv.b4}`;

  const res = await fetch(
    `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`,
    { headers, signal: AbortSignal.timeout(15000) }
  );
  const j = await res.json();
  const d = (j && j.data) || {};
  const code = Number(d.code);

  if (code === 86101) return { status: 'waiting', message: '等待扫码' };
  if (code === 86090) return { status: 'scanned', message: '已扫码，请在手机上点确认' };
  if (code === 86038) return { status: 'expired', message: '二维码已过期，请刷新' };
  if (code !== 0) return { status: 'error', message: d.message || `登录失败 ${code}` };

  // 成功后 Cookie 在 data.url 的查询串里；个别情况下只在 Set-Cookie 里
  let sessdata = '';
  let biliJct = '';
  let mid = '';
  try {
    const u = new URL(d.url);
    sessdata = u.searchParams.get('SESSDATA') || '';
    biliJct = u.searchParams.get('bili_jct') || '';
    mid = u.searchParams.get('DedeUserID') || '';
  } catch {
    /* url 解析失败就退回 Set-Cookie */
  }
  if (!sessdata) {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of raw) {
      const m = String(line).match(/^([^=]+)=([^;]*)/);
      if (!m) continue;
      if (m[1] === 'SESSDATA') sessdata = decodeURIComponent(m[2]);
      else if (m[1] === 'bili_jct') biliJct = m[2];
      else if (m[1] === 'DedeUserID') mid = m[2];
    }
  }
  if (!sessdata || !biliJct) {
    return { status: 'error', message: '登录成功但没拿到 Cookie，请重新登录' };
  }

  const r = await navInfo(cookieOf({ sessdata, biliJct, mid }));
  if (r.invalid) return { status: 'error', message: 'Cookie 校验没通过，请重新登录' };

  // 网络抽风时（r.error）也已经拿到有效 Cookie：先落盘，昵称头像下次 /api/login/me 再补
  const u = r.user || { mid: mid || '', uname: '', face: '' };
  const saved = {
    sessdata,
    biliJct,
    mid: u.mid || mid,
    uname: u.uname || '',
    face: u.face || '',
    savedAt: new Date().toISOString(),
  };
  writeAuth(saved);
  qrKeys.delete(key);
  return {
    status: 'success',
    message: '登录成功',
    user: { mid: saved.mid, uname: saved.uname, face: saved.face },
  };
}

/* ---- 我自己的收藏夹（只列自己创建的，不含订阅别人的） ---- */

async function myFavFolders() {
  const a = readAuth();
  if (!a) {
    const err = new Error('需要先登录 B 站');
    err.code = -101;
    throw err;
  }
  const j = await biliJson(
    `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${encodeURIComponent(a.mid)}`,
    await authHeaders()
  );
  if (j.code !== 0) {
    const err = new Error(j.code === -101 ? '登录已失效，请重新登录' : j.message || `错误码 ${j.code}`);
    err.code = j.code;
    throw err;
  }
  const list = (j.data && j.data.list) || [];
  return list.map((f) => ({
    id: String(f.id),
    title: f.title || '未命名收藏夹',
    count: Number(f.media_count) || 0,
    cover: f.cover || '',
    isPrivate: !!(f.attr & 1),
  }));
}

/** 把任意公开视频收藏进「我自己的」收藏夹；带 fromFolderId 时是从另一个夹子移过来 */
async function addToMyFav(bvid, avid, folderId, fromFolderId) {
  const a = readAuth();
  if (!a) {
    const err = new Error('需要先登录 B 站');
    err.code = -101;
    throw err;
  }

  let aid = Number(avid) || 0;
  if (!aid) {
    const j = await biliJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
    aid = Number(j && j.data && j.data.aid) || 0;
  }
  if (!aid) throw new Error('拿不到这个视频的 aid');

  const body = new URLSearchParams({
    rid: String(aid),
    type: '2', // 2 = 视频稿件
    add_media_ids: String(folderId),
    del_media_ids: fromFolderId ? String(fromFolderId) : '', // 一起传就是「移动」
    csrf: a.biliJct, // 就是 bili_jct，缺了会 -111
  });

  const res = await fetch('https://api.bilibili.com/x/v3/fav/resource/deal', {
    method: 'POST',
    headers: {
      ...BASE_HEADERS,
      ...(await authHeaders()),
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://www.bilibili.com',
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json();
  if (j.code !== 0) {
    const err = new Error(j.message || `收藏失败 ${j.code}`);
    err.code = j.code;
    throw err;
  }
  // 注意：data.success_num 在 B 站这边**永远是 0**（加成功了也是 0），
  // 不能拿它判断成败，code === 0 就是成功。
  console.log(
    `[fav] ${fromFolderId ? '移动' : '收藏'} ${bvid} -> ${folderId}` +
      (fromFolderId ? `（从 ${fromFolderId}）` : '') +
      ` code=0`
  );
  return j.data || {};
}

/** 给当前登录账号新建一个收藏夹（B 站 x/v3/fav/folder/add） */
async function createMyFavFolder(title, privacy) {
  const a = readAuth();
  if (!a) {
    const err = new Error('需要先登录 B 站');
    err.code = -101;
    throw err;
  }

  const body = new URLSearchParams({
    title,
    introduction: '',
    privacy: privacy ? '1' : '0', // 0 公开 / 1 私密
    cover: '',
    csrf: a.biliJct,
  });

  const res = await fetch('https://api.bilibili.com/x/v3/fav/folder/add', {
    method: 'POST',
    headers: {
      ...BASE_HEADERS,
      ...(await authHeaders()),
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://www.bilibili.com',
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json();
  if (j.code !== 0) {
    const err = new Error(j.message || `新建收藏夹失败 ${j.code}`);
    err.code = j.code;
    throw err;
  }
  const d = j.data || {};
  return { id: String(d.id || ''), title: d.title || title, privacy: !!privacy };
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
/* 单独导入的合集快照                                                    */
/* ------------------------------------------------------------------ */

function seasonCacheKey(mediaId) {
  const m = String(mediaId || '').match(/^season:(\d+):(\d+)$/);
  return m ? `${m[1]}_${m[2]}` : null;
}

function seasonCacheFile(mid, seasonId) {
  return path.join(SEASON_DIR, `${mid}_${seasonId}.json`);
}

function readSeasonCache(mid, seasonId) {
  try {
    const j = JSON.parse(fs.readFileSync(seasonCacheFile(mid, seasonId), 'utf8'));
    if (!j || !Array.isArray(j.tracks)) return null;
    return j;
  } catch {
    return null;
  }
}

function writeSeasonCache(mid, seasonId, data) {
  try {
    fs.mkdirSync(SEASON_DIR, { recursive: true });
    const file = seasonCacheFile(mid, seasonId);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), ...data }), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('[season] 缓存写入失败:', e.message);
  }
}

function pruneSeasonCache(keepKeys) {
  try {
    const keep = new Set(keepKeys);
    for (const name of fs.readdirSync(SEASON_DIR)) {
      if (!name.endsWith('.json')) continue;
      if (!keep.has(name.slice(0, -5))) fs.unlinkSync(path.join(SEASON_DIR, name));
    }
  } catch {
    /* 目录还不存在 */
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
    // 普通收藏夹是纯数字；单独导入的合集用 season:<mid>:<season_id> 作为唯一键
    .filter((f) => /^\d+$/.test(f.mediaId) || /^season:\d+:\d+$/.test(f.mediaId));

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
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');

  // 单文件 exe：资源在可执行文件内部，按 key 取出来直接吐
  if (SEA) {
    const key = 'public' + rel.replace(/\\/g, '/');
    let buf = null;
    try {
      // 注意：第二个参数会交给 TextDecoder，'binary' 不是合法编码名会抛 RangeError。
      // 不传则直接返回 ArrayBuffer，正是要的东西。
      const ab = SEA.getAsset(key);
      if (ab) buf = Buffer.from(ab);
    } catch (e) {
      if (process.env.DEBUG_ASSET) console.error('[asset] 读取失败', key, e && e.message);
      buf = null;
    }
    if (process.env.DEBUG_ASSET) {
      console.error('[asset]', key, buf ? `${buf.length}B` : 'MISS');
    }
    if (!buf) {
      if (rel === '/index.html') return sendText(res, 500, '缺少内嵌的 index.html');
      return sendText(res, 404, 'not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    return res.end(buf);
  }

  const filePath = path.join(PUBLIC_DIR, rel);
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
        pruneSeasonCache(clean.folders.map((f) => seasonCacheKey(f.mediaId)).filter(Boolean));
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

    if (pathname === '/api/season') {
      const mid = (searchParams.get('mid') || '').trim();
      const seasonId = (searchParams.get('season_id') || '').trim();
      if (!/^\d+$/.test(mid) || !/^\d+$/.test(seasonId)) {
        return sendJson(res, 400, { ok: false, error: 'mid 和 season_id 应该是纯数字' });
      }

      const refresh = searchParams.get('refresh') === '1';
      if (!refresh) {
        const hit = readSeasonCache(mid, seasonId);
        if (hit) return sendJson(res, 200, { ok: true, ...hit, cached: true });
      }

      try {
        const upper = await fetchUpperName(mid);
        const data = await seasonData({ mid, seasonId, upper });
        writeSeasonCache(mid, seasonId, data);
        return sendJson(res, 200, { ok: true, ...data, cached: false });
      } catch (e) {
        // 回源失败时用旧快照顶上，和收藏夹的行为保持一致
        const hit = readSeasonCache(mid, seasonId);
        if (hit) {
          return sendJson(res, 200, { ok: true, ...hit, cached: true, warning: e.message || String(e) });
        }
        return sendJson(res, 502, { ok: false, error: e.message || String(e) });
      }
    }

    if (pathname === '/api/folders') {
      const mid = (searchParams.get('mid') || '').trim();
      if (!/^\d+$/.test(mid)) return sendJson(res, 400, { ok: false, error: 'UID 应该是纯数字' });
      const folders = await listPublicFolders(mid);
      return sendJson(res, 200, { ok: true, folders });
    }

    if (pathname === '/api/search') {
      const keyword = (searchParams.get('keyword') || '').trim().slice(0, 80);
      if (!keyword) return sendJson(res, 400, { ok: false, error: '关键词不能为空' });
      const page = Math.max(1, Math.min(Number(searchParams.get('page')) || 1, 50));
      try {
        const data = await searchVideos(keyword, page);
        return sendJson(res, 200, { ok: true, ...data });
      } catch (e) {
        // 搜索接口最容易撞 -412 风控，给一句人话而不是裸错误码
        const msg =
          e.code === -412 || e.code === -352
            ? `搜索被 B 站风控拦了（${e.code}），过一会儿再试`
            : e.message || String(e);
        return sendJson(res, 502, { ok: false, error: msg, code: e.code });
      }
    }

    if (pathname === '/api/seasons') {
      // 搜索结果里「这些视频分别属于哪个合集」，一次最多问 20 条
      const bvids = (searchParams.get('bvids') || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^BV[0-9A-Za-z]{8,12}$/.test(s))
        .slice(0, 20);
      if (!bvids.length) return sendJson(res, 400, { ok: false, error: 'bvids 不能为空' });
      const map = await seasonsOfMany(bvids);
      return sendJson(res, 200, { ok: true, map });
    }

    if (pathname === '/api/bitrates') {
      // 这些视频的音频码率（列表里的「音质」列），一次最多问 10 条
      const bvids = (searchParams.get('bvids') || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^BV[0-9A-Za-z]{8,12}$/.test(s))
        .slice(0, 10);
      if (!bvids.length) return sendJson(res, 400, { ok: false, error: 'bvids 不能为空' });

      const map = {};
      let first = true;
      for (const bvid of bvids) {
        if (!first) await sleep(140); // 每条要两次请求，间隔一下
        first = false;
        try {
          map[bvid] = await bitrateOf(bvid);
        } catch {
          map[bvid] = null; // 拿不到的（失效/无音频）给 null，前端显示「—」
        }
      }
      return sendJson(res, 200, { ok: true, map });
    }

    if (pathname === '/api/login/qr') {
      try {
        const qr = await qrGenerate();
        return sendJson(res, 200, { ok: true, ...qr });
      } catch (e) {
        return sendJson(res, 502, { ok: false, error: e.message || String(e) });
      }
    }

    if (pathname === '/api/login/poll') {
      const key = (searchParams.get('key') || '').trim();
      if (!key) return sendJson(res, 400, { ok: false, status: 'error', error: '缺少 key' });
      try {
        const r = await qrPoll(key);
        return sendJson(res, 200, { ok: r.status !== 'error', ...r });
      } catch (e) {
        return sendJson(res, 502, { ok: false, status: 'error', error: e.message || String(e) });
      }
    }

    if (pathname === '/api/login/me') {
      const user = await currentUser();
      return sendJson(res, 200, { ok: true, isLogin: !!user, user });
    }

    if (pathname === '/api/login/logout') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' });
      clearAuth();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/my/favs') {
      try {
        const folders = await myFavFolders();
        return sendJson(res, 200, { ok: true, folders });
      } catch (e) {
        return sendJson(res, e.code === -101 ? 401 : 502, {
          ok: false,
          error: e.message || String(e),
          code: e.code,
        });
      }
    }

    if (pathname === '/api/fav/add') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' });
      let d;
      try {
        d = JSON.parse((await readBody(req, 8 * 1024)) || '{}');
      } catch {
        return sendJson(res, 400, { ok: false, error: '不是合法 JSON' });
      }
      const bvid = String(d.bvid || '').trim();
      const folderId = String(d.folderId || '').trim();
      const fromFolderId = String(d.fromFolderId || '').trim();
      if (!/^BV[0-9A-Za-z]{8,12}$/.test(bvid)) return sendJson(res, 400, { ok: false, error: 'bvid 不合法' });
      if (!/^\d+$/.test(folderId)) return sendJson(res, 400, { ok: false, error: '收藏夹 ID 不合法' });
      if (fromFolderId && !/^\d+$/.test(fromFolderId)) {
        return sendJson(res, 400, { ok: false, error: '原收藏夹 ID 不合法' });
      }
      if (fromFolderId && fromFolderId === folderId) {
        return sendJson(res, 400, { ok: false, error: '源收藏夹和目标收藏夹是同一个' });
      }

      try {
        const data = await addToMyFav(bvid, d.avid, folderId, fromFolderId || '');
        // 收藏夹内容变了，本地快照作废，下次打开重新拉（移动的话两边都要清）
        for (const id of [folderId, fromFolderId].filter(Boolean)) {
          try {
            fs.unlinkSync(favCacheFile(id));
          } catch {
            /* 本来就没缓存 */
          }
        }
        return sendJson(res, 200, { ok: true, moved: !!fromFolderId, data });
      } catch (e) {
        const msg =
          e.code === -101
            ? readAuth()
              ? '登录已失效，请重新登录'
              : '需要先登录 B 站'
            : e.message || String(e);
        return sendJson(res, e.code === -101 ? 401 : 502, { ok: false, error: msg, code: e.code });
      }
    }

    if (pathname === '/api/fav/folder/add') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' });
      let d;
      try {
        d = JSON.parse((await readBody(req, 8 * 1024)) || '{}');
      } catch {
        return sendJson(res, 400, { ok: false, error: '不是合法 JSON' });
      }
      const title = String(d.title || '').trim().slice(0, 40);
      if (!title) return sendJson(res, 400, { ok: false, error: '收藏夹名不能为空' });
      const privacy = d.privacy === true || d.privacy === 1 || d.privacy === '1';

      try {
        const item = await createMyFavFolder(title, privacy);
        return sendJson(res, 200, { ok: true, item });
      } catch (e) {
        const msg =
          e.code === -101 ? (readAuth() ? '登录已失效，请重新登录' : '需要先登录 B 站') : e.message || String(e);
        return sendJson(res, e.code === -101 ? 401 : 502, { ok: false, error: msg, code: e.code });
      }
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
