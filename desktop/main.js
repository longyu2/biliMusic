const { app, BrowserWindow, Menu, shell, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_TITLE = 'b站音乐播放器';
// 默认连本机服务（和单文件版 biliMusic.exe 配套使用）
const DEFAULT_URL = 'http://localhost:7788/';
// 早期版本默认连内网服务器。老用户升级后 config.json 里还留着旧地址，
// 光改默认值没用，得在读取时把它们自动迁过来。
const LEGACY_URLS = [
  'http://192.168.1.3:7788/',
  'http://192.168.1.3:7788',
  'https://music.misaka-mikoto.cn:10000/',
  'https://music.misaka-mikoto.cn:10000',
];

/* ---------------- 启动耗时打点 ---------------- */
// 设 APP_TIMING=<文件路径> 就会把各阶段时间写进去，平时零开销
const T0 = Date.now();
const T_UP = Math.round(process.uptime() * 1000); // 进程创建 → 本行执行
function mark(name) {
  if (!process.env.APP_TIMING) return;
  const line = `${name.padEnd(18)} +${String(Date.now() - T0).padStart(5)}ms  (进程已运行 ${T_UP + (Date.now() - T0)}ms)\n`;
  try {
    fs.appendFileSync(process.env.APP_TIMING, line);
  } catch {
    /* 打点失败不影响启动 */
  }
}
mark('js-start');

// 标题栏：和页面主题同色，窗口按钮由系统画在右上角
const TB_HEIGHT = 36;
const TB_COLOR = '#0d0a10';
const TB_CSS = `
  html, body { background: ${TB_COLOR} !important; }
  body { padding-top: ${TB_HEIGHT}px !important; box-sizing: border-box !important; }
  .app { height: calc(100dvh - ${TB_HEIGHT}px) !important; }
  .gate, .modal, .np-view { top: ${TB_HEIGHT}px !important; }
  body::before {
    content: '${APP_TITLE}';
    position: fixed;
    top: 0; left: 0; right: 0;
    height: ${TB_HEIGHT}px;
    display: flex;
    align-items: center;
    padding-left: 15px;
    font-size: 12px;
    letter-spacing: 0.4px;
    color: rgba(255, 255, 255, 0.36);
    font-family: "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
    background: ${TB_COLOR};
    -webkit-app-region: drag;
    z-index: 2147483000;
    pointer-events: auto;
  }
`;

let win = null;
let targetUrl = DEFAULT_URL;
let showingError = false;
let tbCssKey = null;

/* ---------------- 配置 / 窗口状态 ---------------- */

const userFile = (name) => path.join(app.getPath('userData'), name);

// 程序所在目录：安装版是安装目录，绿色版就是解压出来的那个文件夹
function appDir() {
  return app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath();
}

/**
 * 配置文件查找顺序：
 *   1. 程序目录下的 config.json —— 就放在 exe 旁边，用户能直接找到、直接改
 *   2. %APPDATA%\b站音乐播放器\config.json —— 老位置，兼容已经装过的
 */
function configCandidates() {
  return [path.join(appDir(), 'config.json'), userFile('config.json')];
}

let configFile = null; // 实际生效的那个文件，连不上时会在错误页上显示路径

function normalizeUrl(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!/^https?:\/\//i.test(s)) return '';
  return s.endsWith('/') ? s : s + '/';
}

function writeTemplate(file) {
  const body = {
    _说明: '改 server 这一行就行。改完重启桌面端，或者点错误页上的「重试」。',
    server: DEFAULT_URL,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf8');
}

function loadConfig() {
  for (const file of configCandidates()) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // 这个位置没有文件
    }

    let c;
    try {
      c = JSON.parse(raw);
    } catch {
      continue; // 文件在但不是合法 JSON，看下一个
    }

    // server 是新键名，url 是旧键名，两个都认
    let url = normalizeUrl(c.server) || normalizeUrl(c.url);
    if (!url) continue;

    // 老的默认地址（内网/外网）自动迁到本机，用户不用手动改
    if (LEGACY_URLS.includes(url)) {
      url = DEFAULT_URL;
      try {
        const next = { ...c, server: url };
        delete next.url;
        fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
      } catch {
        /* 写不进去也不影响这次启动 */
      }
    }

    targetUrl = url;
    configFile = file;
    return;
  }

  // 一个可用的配置都没有：生成一份模板，优先放程序目录
  for (const file of configCandidates()) {
    try {
      writeTemplate(file);
      configFile = file;
      break;
    } catch {
      /* 目录不可写，试下一个 */
    }
  }
}

function loadState() {
  const fallback = { width: 1180, height: 820 };
  try {
    const s = JSON.parse(fs.readFileSync(userFile('window-state.json'), 'utf8'));
    const ok =
      Number.isFinite(s.width) &&
      Number.isFinite(s.height) &&
      s.width >= 420 &&
      s.height >= 560;
    if (!ok) return fallback;
    return {
      width: Math.round(s.width),
      height: Math.round(s.height),
      x: Number.isFinite(s.x) ? Math.round(s.x) : undefined,
      y: Number.isFinite(s.y) ? Math.round(s.y) : undefined,
      maximized: !!s.maximized,
    };
  } catch {
    return fallback;
  }
}

function saveState() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(
      userFile('window-state.json'),
      JSON.stringify({ ...b, maximized: win.isMaximized() }),
      'utf8'
    );
  } catch {
    /* 记不住就算了 */
  }
}

/* ---------------- 标题栏 ---------------- */

/** 页面顶部让出标题栏高度；全屏时不显示覆盖层，就把这段 CSS 撤掉 */
async function applyTitlebar(force) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  const want = !win.isFullScreen();
  try {
    // insertCSS 每次返回新 key，重复注入会叠好几份，全屏时撤不干净留一条空白
    if (want && tbCssKey && !force) return;
    if (tbCssKey) {
      const old = tbCssKey;
      tbCssKey = null;
      await wc.removeInsertedCSS(old).catch(() => {});
    }
    if (!want) return;
    tbCssKey = await wc.insertCSS(TB_CSS);
  } catch {
    /* 页面还没就绪，等下一次事件 */
  }
}

/* ---------------- 加载 / 错误页 ---------------- */

function showError(detail) {
  if (!win || win.isDestroyed()) return;
  if (showingError) return; // did-fail-load 和 loadURL 的 reject 会同时来，只处理一次
  showingError = true;
  const file = path.join(__dirname, 'error', 'error.html');
  const query = { url: targetUrl, detail: detail || '', config: configFile || '' };
  // 必须推迟一帧再导航：在 did-fail-load 里同步 loadFile 会让 Electron 崩溃
  setImmediate(() => {
    if (!win || win.isDestroyed()) return;
    win.loadFile(file, { query }).catch(() => {});
  });
}

function openApp() {
  if (!win || win.isDestroyed()) return;
  showingError = false;
  win.loadURL(targetUrl).catch((e) => {
    showError(e && e.message ? e.message : '');
  });
}

/* ---------------- 悬浮小卡片 ---------------- */
/*
 * 独立窗口，加载本地 mini/index.html，只当遥控器用 —— 不放音频。
 * 声音始终由主窗口那个 <audio> 发出（主窗口隐藏时也照常播），
 * 两边靠 IPC 同步状态和指令，避免出现两个播放实例。
 */

const MINI_W = 372;
const MINI_H = 108;

let mini = null;
let miniState = null;

const miniPosFile = () => userFile('mini-pos.json');

function loadMiniPos() {
  const fallback = () => {
    const a = screen.getPrimaryDisplay().workArea;
    return { x: Math.round(a.x + a.width - MINI_W - 24), y: Math.round(a.y + a.height - MINI_H - 24) };
  };
  try {
    const s = JSON.parse(fs.readFileSync(miniPosFile(), 'utf8'));
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) return fallback();
    // 换了显示器 / 改了分辨率，原来的位置可能已经跑到屏幕外
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return (
        s.x + MINI_W > a.x + 40 &&
        s.x < a.x + a.width - 40 &&
        s.y + MINI_H > a.y + 20 &&
        s.y < a.y + a.height - 20
      );
    });
    return visible ? { x: Math.round(s.x), y: Math.round(s.y) } : fallback();
  } catch {
    return fallback();
  }
}

function saveMiniPos() {
  if (!mini || mini.isDestroyed()) return;
  try {
    const b = mini.getBounds();
    fs.writeFileSync(miniPosFile(), JSON.stringify({ x: b.x, y: b.y }), 'utf8');
  } catch {
    /* 记不住就算了 */
  }
}

function createMini() {
  const pos = loadMiniPos();
  mini = new BrowserWindow({
    width: MINI_W,
    height: MINI_H,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // 透明窗口自带的阴影在 Windows 上会变成一块灰方块，关掉，用 CSS 画
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: APP_TITLE,
    webPreferences: {
      preload: path.join(__dirname, 'mini', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 光 alwaysOnTop 会被别的置顶窗口压住，抬到 screen-saver 层
  mini.setAlwaysOnTop(true, 'screen-saver');
  mini.setVisibleOnAllWorkspaces(true);
  mini.loadFile(path.join(__dirname, 'mini', 'index.html'));

  mini.webContents.on('did-finish-load', () => {
    if (process.env.APP_DEBUG) console.log('[mini] loaded, state=', !!miniState);
    if (miniState) mini.webContents.send('player:state', miniState);
  });
  mini.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log('[mini] load failed', code, desc, url);
  });
  mini.webContents.on('render-process-gone', (_e, d) => {
    console.log('[mini] renderer gone:', d && d.reason);
  });

  mini.on('moved', saveMiniPos);
  mini.on('closed', () => {
    mini = null;
  });
}

function openMini() {
  if (process.env.APP_DEBUG) console.log('[mini] open, existing=', !!mini);
  if (!mini || mini.isDestroyed()) createMini();
  if (miniState && mini && !mini.isDestroyed()) mini.webContents.send('player:state', miniState);
  // showInactive：不抢焦点，用户可能正在别的窗口打字
  if (mini && !mini.isDestroyed()) mini.showInactive();
  if (win && !win.isDestroyed()) win.hide();
  if (process.env.APP_DEBUG && mini) console.log('[mini] bounds=', JSON.stringify(mini.getBounds()), 'visible=', mini.isVisible());
}

function closeMini() {
  if (mini && !mini.isDestroyed()) mini.hide();
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
  }
}

/* ---------------- 窗口 ---------------- */

function createWindow() {
  const st = loadState();

  win = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 420,
    minHeight: 560,
    title: APP_TITLE,
    backgroundColor: '#0d0a10',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    // 立即显示窗口：backgroundColor 已经是页面同色，先给一块深色底再填内容，
    // 比等 ready-to-show（要等远程页面首次渲染）体感快得多
    show: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: TB_COLOR,
      symbolColor: '#e9e9ef',
      height: TB_HEIGHT,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // 窗口最小化时也别把音频/定时器节流掉，否则多端进度上报会断
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false);
  if (st.maximized) win.maximize();
  mark('window-shown');

  // 页面标题固定用应用名，避免被远端页面改掉
  win.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle(APP_TITLE);
  });

  // 每次主框架导航后旧文档的 insertedCSS 自动失效，把 key 清掉等 dom-ready 重新注入
  win.webContents.on('did-start-navigation', (_e, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) tbCssKey = null;
  });
  // dom-ready 比 did-finish-load 早，标题栏留白能更早注入
  win.webContents.on('dom-ready', () => {
    mark('dom-ready');
    applyTitlebar();
  });
  win.webContents.on('did-finish-load', () => mark('did-finish-load'));

  win.on('enter-full-screen', () => applyTitlebar(true));
  win.on('leave-full-screen', () => applyTitlebar(true));

  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame) return;
    if (code === -3) return; // ERR_ABORTED：我们自己跳转导致的，忽略
    if (showingError) return;
    showError(desc);
  });

  // 站内链接保持窗口内跳转，外链交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (e, url) => {
    if (showingError) return;
    let sameOrigin = false;
    try {
      sameOrigin = new URL(url).origin === new URL(targetUrl).origin;
    } catch {
      /* 解析不了就当作外链 */
    }
    if (!sameOrigin) {
      e.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  // 快捷键：F11 全屏 / Ctrl+R 刷新 / F12 开发者工具 / Esc 退出全屏
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    if (key === 'f11') {
      e.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    } else if (key === 'escape' && win.isFullScreen()) {
      win.setFullScreen(false);
    } else if (input.control && key === 'r') {
      e.preventDefault();
      showingError ? openApp() : win.webContents.reload();
    } else if (key === 'f12') {
      e.preventDefault();
      win.webContents.toggleDevTools();
    }
  });

  win.on('close', () => {
    saveState();
    // 主窗口关了就把小卡片一起收掉，否则窗口数不为 0，应用会赖在后台退不出去
    if (mini && !mini.isDestroyed()) mini.destroy();
  });
  win.on('closed', () => {
    win = null;
  });

  openApp();

  if (process.env.APP_SHOT) {
    let shotTimer = null;
    win.webContents.on('did-finish-load', () => {
      clearTimeout(shotTimer);
      shotTimer = setTimeout(async () => {
        try {
          if (process.env.APP_SHOT_JS) {
            const r = await win.webContents
              .executeJavaScript(process.env.APP_SHOT_JS)
              .catch((e) => 'JS_ERR: ' + e.message);
            console.log('JS_RESULT', typeof r === 'string' ? r : JSON.stringify(r));
            await new Promise((r2) => setTimeout(r2, 2600));

            // 调试：验证卡片上的按钮能不能控制主窗口
            if (process.env.APP_TEST_MINI && mini && !mini.isDestroyed()) {
              const read = () =>
                win.webContents.executeJavaScript(
                  'JSON.stringify({paused: document.querySelector("audio").paused, title: document.title})'
                );
              const before = await read();
              await mini.webContents.executeJavaScript('document.getElementById("play").click()');
              await new Promise((r3) => setTimeout(r3, 900));
              const afterPlay = await read();
              await mini.webContents.executeJavaScript('document.getElementById("next").click()');
              await new Promise((r3) => setTimeout(r3, 1200));
              const afterNext = await read();
              console.log('MINI_TEST before    ', before);
              console.log('MINI_TEST afterPlay ', afterPlay);
              console.log('MINI_TEST afterNext ', afterNext);
            }
          }
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.APP_SHOT, img.toPNG());
          console.log('SHOT_OK');

          // 连标题栏一起截（标题栏是系统画的，capturePage 抓不到）
          const { desktopCapturer, screen } = require('electron');
          const sf = screen.getPrimaryDisplay().scaleFactor;
          const d = screen.getPrimaryDisplay().size;
          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: d.width * sf, height: d.height * sf },
          });
          const b = win.getBounds();
          // APP_SHOT_ALL=1 时截整个屏幕（验证悬浮窗这类不在主窗口里的东西）
          const full = process.env.APP_SHOT_ALL
            ? sources[0].thumbnail
            : sources[0].thumbnail.crop({
                x: Math.round(b.x * sf),
                y: Math.round(b.y * sf),
                width: Math.round(b.width * sf),
                height: Math.round(b.height * sf),
              });
          fs.writeFileSync(process.env.APP_SHOT.replace('.png', '-full.png'), full.toPNG());
          console.log('SHOT_FULL_OK');

          // 悬浮卡片单独截一份，方便看清楚它的样子
          if (mini && !mini.isDestroyed()) {
            const mimg = await mini.webContents.capturePage();
            fs.writeFileSync(process.env.APP_SHOT.replace('.png', '-mini.png'), mimg.toPNG());
            console.log('SHOT_MINI_OK');
          }
        } catch (e) {
          console.log('SHOT_ERR', e.message);
        }
        app.quit();
      }, 3500);
    });
  }
}

/* ---------------- 生命周期 ---------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    mark('app-ready');
    Menu.setApplicationMenu(null);
    app.setAppUserModelId('cn.misaka-mikoto.bilifavmusic');
    loadConfig();
    createWindow();
  });

  // 重试前先重读配置：改完 config.json 点一下重试就能生效，不用重启
  ipcMain.on('app:retry', () => {
    loadConfig();
    openApp();
  });
  ipcMain.on('app:quit', () => app.quit());

  // 错误页上「打开配置文件」：在资源管理器里选中它，方便直接改
  ipcMain.on('app:open-config', () => {
    if (configFile && fs.existsSync(configFile)) {
      shell.showItemInFolder(configFile);
    } else {
      shell.openPath(appDir());
    }
  });

  ipcMain.on('mini:open', openMini);
  ipcMain.on('mini:close', closeMini);

  // 主窗口上报播放状态 → 转发给小卡片
  ipcMain.on('player:state', (_e, s) => {
    miniState = s;
    if (mini && !mini.isDestroyed()) mini.webContents.send('player:state', s);
  });

  // 小卡片发来的指令 → 转发给主窗口执行
  ipcMain.on('player:command', (_e, cmd) => {
    if (win && !win.isDestroyed()) win.webContents.send('player:command', cmd);
  });

  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
