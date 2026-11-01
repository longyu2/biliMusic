# biliMusic

把 B 站公开收藏夹当成一个音乐播放器来听。

服务端是一个**零第三方依赖**的 Node 小程序（只用内置模块），前端是**原生 JS**（没有框架、没有构建步骤），另外附带一个 Electron 桌面壳，可以缩成一张置顶的小卡片挂在屏幕角落。

> 仅供个人学习与技术研究使用。音频、封面等资源均来自 B 站官方接口，本项目不存储任何媒体文件，也不提供任何绕过付费/权限的能力。请勿用于商业用途。

---

## 功能

**播放**

- 导入任意 B 站公开收藏夹（粘贴链接或 `media_id` 都行），也可以输入 UP 主 UID 列出他所有公开收藏夹
- 三种播放模式：列表循环、单曲循环、乱序
- **乱序是「一次性洗牌」**：整张列表洗一次牌后按顺序播完，一轮之内不重复；播完一轮才重新洗牌，且刚播完那首会被钉在队首，所以「上一首」永远能退回刚才实际播的那首
- 单曲大图视图：圆形封面 + **环形音频频谱**（Web Audio `AnalyserNode` 实时驱动）

**多端**

- 播放进度存在服务端，手机听到一半、电脑打开能接着放
- 播放历史（每次播放一条，带实际收听时长），按歌聚合出播放次数和累计时长
- 桌面端可呼出**悬浮小卡片**：置顶、可拖动、记住位置，三个按钮直接控制主窗口

**缓存**

三层，越靠前越快：

| 层 | 位置 | 有效期 |
|---|---|---|
| 收藏夹列表 | `data/fav/<media_id>.json` | 永久，直到手动刷新 |
| 封面图 | `data/img/<sha1>` | 7 天（HTTP 缓存同步） |
| 前端 | 内存 | 当前页面 |

回源失败时会自动回退到旧缓存，并提示数据是多久前的——断网也不会变成空白页。

---

## 快速开始

需要 **Node.js 18+**，不需要 `npm install`。

```bash
node server.js
# 打开 http://localhost:7788
```

Windows 下双击 `启动播放器.bat` 也行（会检查 Node 是否安装）。

首次打开会让你粘贴收藏夹链接，例如：

```
https://space.bilibili.com/123456/favlist?fid=3497634532&ftype=create
```

识别出 `media_id` 后就会导入并缓存到本地。

### 让局域网/其他设备访问

```bash
HOST=0.0.0.0 PORT=7788 node server.js
```

然后手机、平板、电视盒子打开 `http://<你的内网IP>:7788` 即可。

### 部署到服务器（pm2）

```bash
pm2 start ecosystem.config.js
pm2 save
```

`ecosystem.config.js` 里已经配好 `HOST=0.0.0.0`、`PORT=7788`、`max_memory_restart=300M`。

---

## 目录结构

```
biliMusic/
├── server.js              # 服务端，零依赖（893 行）
├── public/                # 前端，原生 JS，无构建
│   ├── index.html
│   ├── app.js             # 全部逻辑（1610 行）
│   ├── style.css
│   └── icons/
├── desktop/               # Electron 桌面壳
│   ├── main.js            # 主进程：窗口、标题栏、悬浮卡片、IPC
│   ├── preload.js
│   └── mini/              # 悬浮卡片页面
├── data/                  # 运行时数据，不入库
│   ├── library.json       # 收藏夹列表 + 当前选中
│   ├── progress.json      # 每首听到第几秒
│   ├── history.json       # 播放历史
│   ├── fav/               # 收藏夹快照
│   └── img/               # 封面缓存
├── ecosystem.config.js
└── 启动播放器.bat
```

---

## 工作原理

### 为什么要服务端代理

B 站的音频流和图床都有**防盗链**：直接在前端 `<audio src="...">` 引用会 403。所以服务端做了三件事：

1. **补 `Referer`**：请求 B 站资源时带上 `Referer: https://www.bilibili.com`
2. **透传 `Range`**：把浏览器的 `Range` 头原样转发，并把上游的 `206 Partial Content` 原样返回——否则进度条不能拖动
3. **缓存封面**：按 URL 的 sha1 落盘，配一份 `.ct` 存 content-type，避免每次都回源

### 音频地址解析

```
GET /api/audio?bvid=BV1xxxxxxx
  → 取 view 接口拿到 cid
  → 取 player/playurl 拿到音频直链
  → 带 Referer 代理转发
```

### 环形频谱

`AnalyserNode` 的 `fftSize` 设成 256，得到 128 个 bin（每 bin 约 172Hz）。B 站的 AAC 在 16kHz 以上基本没有信号，所以只映射到前 62% 的 bin，剩下的死区不参与，否则半边频谱永远是平的。

高频还要单独整形，否则会被低频压成一排静止的短柱：

```js
const gamma = 0.75 + 0.45 * m;          // 低频抬弱信号，高频放大对比
const gain  = 1 + 1.5 * m;
const raw   = Math.pow(peak / 255, gamma) * gain;
// 软饱和，不能用 Math.min 硬封顶，否则撞顶的柱子会卡死不动
const target = raw < 0.85 ? raw : 0.85 + (1 - Math.exp(-(raw - 0.85) * 2.2)) * 0.15;
```

---

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/library` | 收藏夹列表 + 当前选中 |
| `POST` | `/api/library` | 保存列表（body: `{ current, folders }`） |
| `GET` | `/api/fav?media_id=&refresh=1` | 收藏夹曲目（默认读缓存，`refresh=1` 强制回源） |
| `GET` | `/api/folders?mid=` | 某 UP 主的全部公开收藏夹 |
| `GET` | `/api/audio?bvid=&cid=` | 音频流代理（支持 Range / 206） |
| `GET` | `/api/img?u=` | 封面图代理（磁盘缓存） |
| `GET` | `/api/progress` | 播放进度（`?bvid=` 查单首） |
| `POST` | `/api/progress` | 上报进度 `{ bvid, pos, dur, mediaId }` |
| `GET` | `/api/history?limit=200` | 播放历史（明细倒序 + 聚合统计） |
| `POST` | `/api/history` | 上报一次播放 `{ bvid, title, upper, cover, mediaId, dur, played, at }` |
| `GET` | `/api/health` | 存活检查 |

### 数据文件

`progress.json` 和 `history.json` 的分工：

- **progress** 记「听到哪」——每首一条，反复覆盖，最多 800 首
- **history** 记「听过哪些」——每次播放追加一条，只增不改，明细留 5000 条、聚合留 2000 首

```jsonc
// history.json
{
  "entries": [
    {
      "bvid": "BV16gFWeWEVz",
      "title": "让你来探班",
      "upper": "棋手战鹰",
      "cover": "/api/img?u=...",
      "mediaId": "3497634532",
      "dur": 708,          // 这首歌总长
      "played": 45,        // 这一次实际听了多久
      "at": 1793565400000  // 开始播放的时间戳
    }
  ],
  "stats": {
    "BV16gFWeWEVz": { "plays": 3, "played": 190, "last": 1793565400000, "dur": 708 }
  }
}
```

`played` 用 `audio.currentTime` 的差值算——`currentTime` 只在真正播放时前进，所以这个数字天然不含暂停时间。

---

## 桌面端

```bash
cd desktop
npm install
npm start          # 开发运行
npm run dist       # 打包出 NSIS 安装版 + 便携版
```

主窗口是 `BrowserWindow` 加载内网地址，页面顶部被一段注入的 CSS 下推 36px 给自绘标题栏让位。

### 悬浮小卡片

`frame: false` + `transparent: true` + `setAlwaysOnTop(true, 'screen-saver')`，尺寸 372×108。

卡片**不持有音频**，只通过 IPC 发指令、收状态：

```
主窗口 ──player:state──> 卡片      { title, upper, cover, playing, pos, dur }
卡片   ──player:command──> 主窗口  'toggle' | 'next' | 'prev'
```

这样不会出现两个播放实例。进度条在卡片本地按时间插值，不依赖每秒推送。

### 打包踩过的坑

**别用 portable。** portable 版每次启动都要把 268MB 全量解压到 `%TEMP%\<27位随机串>`，而且退出不清理。每次都是新路径，Windows Defender 也没有扫描缓存，冷启动会从 6 秒一路涨到 17 秒。换成 NSIS 安装版后稳定 **0.42 秒**。

---

## 快捷键

| 键 | 作用 |
|---|---|
| `空格` | 播放 / 暂停 |
| `←` `→` | 后退 / 前进 5 秒 |
| `↑` `↓` | 音量 ±5% |
| `M` | 静音 |
| `N` / `P` | 下一首 / 上一首 |
| `Esc` | 收起单曲大图 |

---

## 已知限制

- 只支持**公开**收藏夹，私密收藏夹需要登录态，本项目不处理 Cookie
- 失效稿件（`dead`）会在列表里标灰并自动跳过
- 音频直链有时效，长时间挂着可能需要切下一首重新解析
- 悬浮卡片仅桌面端可用，纯浏览器打开时按钮不显示

## License

MIT
