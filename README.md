# biliMusic

把 B 站公开收藏夹当成一个音乐播放器来听。

服务端是一个**零第三方依赖**的 Node 小程序（只用内置模块），前端是**原生 JS**（没有框架、没有构建步骤），另外附带一个 Electron 桌面壳，可以缩成一张置顶的小卡片挂在屏幕角落。

> 仅供个人学习与技术研究使用。音频、封面等资源均来自 B 站官方接口，本项目不存储任何媒体文件，也不提供任何绕过付费/权限的能力。请勿用于商业用途。

---

## 功能

**播放**

- 导入任意 B 站公开收藏夹（粘贴链接或 `media_id` 都行），也可以输入 UP 主 UID 列出他所有公开收藏夹
- 支持直接导入 B 站合集（`space.bilibili.com/<uid>/lists/<season_id>?type=season`）；收藏夹里收藏的合集也会自动展开成单集
- **搜索**：搜索框里回车（或点放大镜）直接在 B 站搜视频，每页 20 条（课堂/课程类没有 bvid 的条目会被过滤），点一首就播；底部有分页条（一次显示 5 个页码，**点了才请求**，不会预加载）；「返回列表」原样回到收藏夹，不写任何数据
- **合集识别**：搜索结果里属于某个合集的视频会打上「合集」标（卡片视图是封面左上角小标签），右键多一项 **导入整个合集**，一次把那个合集加成歌单、且不会把你踢出搜索页
- 三种播放模式：列表循环、单曲循环、乱序
- **乱序是「一次性洗牌」**：整张列表洗一次牌后按顺序播完，一轮之内不重复；播完一轮才重新洗牌，且刚播完那首会被钉在队首，所以「上一首」永远能退回刚才实际播的那首
- 单曲大图视图：圆形封面 + **环形音频频谱**（Web Audio `AnalyserNode` 实时驱动）
- **放大视图里的「视频」和「评论」**：点底栏正在播放的那块（或右键任意一首 → 看视频 / 评论）展开后，左上角两个开关——`视频` 把唱片封面换成 720P 画面，`评论` 拉出右侧评论区抽屉（最热 / 最新、表情、图片、楼中楼、加载更多）。声音始终走 `/api/audio` 那条本地缓存，画面静音只负责播，所以进度条 / 上一首下一首 / 音量 / 频谱全都照旧

**多端**

- 播放进度存在服务端，手机听到一半、电脑打开能接着放
- 播放历史（每次播放一条，带实际收听时长），按歌聚合出播放次数和累计时长
- 桌面端可呼出**悬浮小卡片**：置顶、可拖动、记住位置，三个按钮直接控制主窗口

**登录 / 收藏**

- 右上角**扫码登录 B 站**（手机客户端扫一下就行，不用填账号密码）
- 登录后搜索任意视频，**右键 → 添加到收藏夹**，列表里只有你自己创建的收藏夹（含私密夹），选一个就收藏进 B 站
- 在收藏夹里右键还能**移动到收藏夹**（B 站同一次请求里完成「加进新夹子 + 从旧夹子移除」，列表会立刻少一首）；搜索结果页只给「添加到收藏夹」
- 登录后点**右上角头像**：弹出的就是导入页，勾选自己的收藏夹 → 「导入选中」直接进左侧列表（含私密夹）
- 登录后点侧栏「+」→「我的收藏夹」，同样能勾选导入（不用再粘贴链接 / ID）
- 侧栏「+」里还能**新建收藏夹**：直接在 B 站账号里建一个（可设私密），建好自动进左边列表，马上就能往里收藏
- Cookie 只存在服务端的 `data/users/<mid>/auth.json`（权限 600），前端永远拿不到；点「退出登录」即删除
- 登录后还能直接读自己的**私密收藏夹**（未登录时只能读公开的）

**多账号**

- 支持登录多个 B 站账号，右上角头像点开就是账号菜单：切账号、添加账号、退出登录
- **每个账号的数据完全独立**：收藏夹列表、播放进度、播放历史、收藏夹缓存各存一份（`data/users/<mid>/`）
- **缓存所有账号共用**：封面图、音频文件（播放过的整首歌）、码率、合集快照（`data/common/`），换个账号听同一首歌也是秒开
- 不登录也能用：那是 `data/users/guest/` 这个工作区，第一次登录某个账号时会把它的收藏夹列表带过去
- 老版本的单用户数据会在首次启动时自动迁移，账号数据进 `users/<mid>/`，缓存进 `common/`

**界面**

- 深色 / **白天主题**，右上角一键切换，选择记在本机
- 左侧收藏夹栏的**分隔线可以拖动**调宽度（双击恢复默认），宽度也会记住
- **列表视图 / 卡片视图**一键切换（右上角那个小格子图标），卡片视图每页 24 张、带翻页器，选择也会记住
- 列表里有 **音质** 列（显示音频码率，如 `192k` / `1.2M`）：列表一渲染就在后台自动补全全部曲目，查过的落在 `data/common/meta/`，下次秒出；卡片视图是在封面右上角显示

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

### 不想装 Node：用现成的发布包

到 [Releases](https://github.com/longyu2/biliMusic/releases) 下 `biliMusic-<版本>-win-x64.zip`，
解压后有两个程序，**目标机器不需要装 Node，也不需要联网装任何依赖**：

| 文件 | 作用 |
|---|---|
| `biliMusic.exe` | 服务端 + 网页版，**必须先启动它** |
| `biliMusic-desktop-setup-<版本>.exe` | 桌面窗口版，默认连 `http://localhost:7788` |

桌面窗口版就是个 Electron 壳，比网页版多了**置顶悬浮小卡片**，也没有浏览器地址栏；
它自己不提供服务，仍然要先把 `biliMusic.exe` 跑起来。

桌面端的服务器地址写在**安装目录的 `config.json`** 里（和 `b站音乐播放器.exe` 同级，
装完就在那儿），改完重启即可：

```json
{
  "_说明": "改 server 这一行即可",
  "server": "http://192.168.1.3:7788/"
}
```

连不上时不用去找文件——错误页上会显示配置文件完整路径，点「打开配置文件」直接在资源管理器里选中它，
改完点「重试」就会重新读配置，不用重启。

> 老版本把配置存在 `%APPDATA%\b站音乐播放器\config.json`，这个位置仍然兼容读取（程序目录优先）。
> 早期默认连内网 `192.168.1.3`，升级后会自动把老配置迁移到 localhost。
> 重装桌面端会把 `config.json` 重置成默认值，改过的记得先备份。

原理是用 Node 22 的 SEA（Single Executable Application）：把 `server.js` 和整个 `public/`
打包成一个 blob，注入到 `node.exe` 的 PE 资源段里，产出一个约 83 MB 的独立可执行文件。
运行时静态资源直接从 exe 内部按 key 取，`data/` 会建在 exe 同目录下，拷走整个文件夹即完成迁移。

自己构建：

```bash
cd tools && npm install && cd ..   # 只装构建期的 postject，不是运行时依赖
node build-release.js              # 产物在 release/（会顺带拷入桌面端安装包）
node build-release.js --no-zip     # 只要文件夹，不打 zip
```

> 坑：`sea.getAsset(key, 'binary')` 的第二个参数会交给 `TextDecoder`，而 `'binary'` 不是
> 合法编码名，会抛 `RangeError` 并被静默吞掉，表现为「所有静态资源 404」。
> 不传第二个参数才是正确的——它直接返回 `ArrayBuffer`。

---

## 目录结构

```
biliMusic/
├── server.js              # 服务端，零依赖
├── build-release.js       # 构建单文件 exe（Node SEA）
├── tools/                 # 构建期依赖（postject），不入库
├── public/                # 前端，原生 JS，无构建
│   ├── index.html
│   ├── app.js             # 全部逻辑
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
│   ├── season/            # 单独导入的合集快照
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

### 视频为什么走 durl 而不是 dash

```
GET /api/video/stream?bvid=BV1xxxxxxx&cid=
  → player/playurl?qn=80&fnval=0&platform=html5   (要的是 durl，不是 dash)
  → 拿到一条音视频混流的整段 mp4
  → 带上 Referer + 原样透传 Range 转发给 <video>
```

- `dash` 是「纯视频流 + 独立音轨」，一个视频被切成成百上千个 `.m4s` 分片，浏览器原生 `<video>` 既拖不动、也没声音，要引 MSE（flv.js / dash.js）那一整套
- `durl`（`platform=html5`）是音视频混流的整段 mp4，`ftypisom` 开头、支持 `Range`，原生 `<video>` 直接能播能拖；代价是画质封顶 720P
- 画质不是重点时这样最省事：**声音还是走 `/api/audio`**（本地磁盘缓存 + 最高码率），`<video>` 只是静音出画面，所以 `audio` 一直是进度/播放/音量的唯一真源
- 画面跟音频对齐靠两条：切歌、拖进度条时直接 `video.currentTime = audio.currentTime`；平时在 `timeupdate` 里量偏差，超过 80ms 就用 `playbackRate = 1.1 / 0.9` 追（画面静音，改速率听不出来）。实测稳定在 **70ms** 以内

**评论**翻页用 B 站的游标：第一页不带 `pagination_str`，之后把上一页 `cursor.pagination_reply.next_offset` 塞进 `pagination_str={"offset":"..."}`。注意这个接口**不能带 buvid Cookie** —— 带上 `buvid3/buvid4` 只会回 3 条「最热」就 `is_end=true` 收尾（实测），所以 `biliJsonAnon()` 专走完全匿名的请求。

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
| `GET` | `/api/season?mid=&season_id=` | 合集曲目（默认读缓存，`refresh=1` 强制回源） |
| `GET` | `/api/search?keyword=&page=1` | B 站视频搜索（默认第一页 20 条，服务端缓存 5 分钟） |
| `GET` | `/api/seasons?bvids=a,b,c` | 批量查这些视频分别属于哪个合集（最多 20 条，带 30 分钟缓存） |
| `GET` | `/api/bitrates?bvids=a,b,c` | 批量查音频码率（最多 10 条，结果落 `data/meta/`，7 天有效） |
| `GET` | `/api/login/qr` | 取登录二维码（`{ key, url }`，前端用 `public/qr.js` 自己画成 SVG） |
| `GET` | `/api/login/poll?key=` | 轮询扫码状态：`waiting` / `scanned` / `expired` / `success` |
| `GET` | `/api/login/me` | 当前登录用户（`isLogin` + `{ mid, uname, face }`，不含 Cookie） |
| `POST` | `/api/login/logout` | 退出登录（删掉 `data/auth.json`） |
| `GET` | `/api/my/favs` | **我自己创建的**收藏夹列表（需登录） |
| `POST` | `/api/fav/add` | 收藏到自己的收藏夹 `{ bvid, avid, folderId }`（需登录，走 `x/v3/fav/resource/deal`） |
| `POST` | `/api/fav/folder/add` | 在自己的账号下新建收藏夹 `{ title, privacy }`（需登录，走 `x/v3/fav/folder/add`） |
| `GET` | `/api/audio?bvid=&cid=` | 音频流代理（支持 Range / 206） |
| `GET` | `/api/video/info?bvid=` | 视频信息 + 可否播放（`{ aid, cid, title, desc, stat, stream:{ available, quality, label, size } }`，内存缓存 10 分钟） |
| `GET` | `/api/video/stream?bvid=&cid=` | 视频流代理（durl 混流 mp4，透传 Range / 206，不落盘） |
| `GET` | `/api/video/comments?bvid=&sort=hot\|new&next=` | 评论一页（20 条，含置顶 / UP 主、楼中楼前 3 条、表情表；`next` 传上一页给的游标） |
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
| `Esc` | 收起单曲大图 / 退出搜索视图 |
| `V` / `C` | 放大视图里开关「视频」/「评论」 |
| 右键曲目 | 添加到收藏夹 / 看视频 / 在浏览器打开 B 站原视频 |

---

## 已知限制

- 未登录时只能读**公开**收藏夹；登录后可读自己的私密收藏夹（Cookie 只存服务端 `data/auth.json`，权限 600）
- 「添加到收藏夹」只能选**你自己创建的**收藏夹；B 站的合集（season）只能装自己的稿件，所以不做合集写入
- 失效稿件（`dead`）会在列表里标灰并自动跳过
- 音频直链有时效，长时间挂着可能需要切下一首重新解析
- 悬浮卡片仅桌面端可用，纯浏览器打开时按钮不显示
- 视频最高 **720P**：走的是 B 站 `platform=html5` 的 durl（音视频混流 mp4），好处是浏览器原生就能播、能拖、还带声音；1080P 只有 DASH 分片，纯 `<video>` 拖不动，得引 MSE，所以没做
- 看视频时每条视频会额外走一遍完整流量（不落盘，几十 MB 一条）；只听歌不进「视频」模式就一点不耗
- 评论区是**只读**的：能看最热 / 最新、表情、图片、楼中楼，不能发评论 / 点赞

## License

MIT
