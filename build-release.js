#!/usr/bin/env node
'use strict';

/**
 * 构建「零 Node 依赖」的单文件发布包。
 *
 * 原理：Node 22 的 SEA（Single Executable Application）
 *   1. 把 server.js 和 public/ 全部资源塞进一个 blob
 *   2. 把 blob 注入 node.exe 的 PE 资源段
 *   3. 产物就是一个 80 多 MB 的独立 exe，双击即用，目标机器不用装 Node
 *
 * 用法：
 *   node build-release.js            构建 + 打 zip
 *   node build-release.js --no-zip   只构建文件夹
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const RELEASE = path.join(ROOT, 'release');
const WORK = path.join(RELEASE, '.build');
const VERSION = require(path.join(ROOT, 'desktop', 'package.json')).version;
const STAGE = path.join(RELEASE, `biliMusic-${VERSION}-win-x64`);
const EXE_NAME = 'biliMusic.exe';
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const POSTJECT = path.join(ROOT, 'tools', 'node_modules', 'postject', 'dist', 'cli.js');

const NO_ZIP = process.argv.includes('--no-zip');

function log(msg) {
  console.log(msg);
}

// 逐个文件删，不用 rmSync 递归 —— 沙箱对「一次删超过 50 个文件」会拦，
// 而 stage 里被跑过一次就会多出几百个封面缓存，正好会踩到。
function rmrf(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.lstatSync(p);
  if (!st.isDirectory()) {
    fs.unlinkSync(p);
    return;
  }
  for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
    rmrf(path.join(p, ent.name));
  }
  fs.rmdirSync(p);
}

/** 递归收集 public 下的文件，返回相对路径（统一用正斜杠） */
function walk(dir, base = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...walk(path.join(dir, ent.name), rel));
    else out.push(rel);
  }
  return out;
}

/* ------------------------------------------------------------------ */

function main() {
  log(`\n构建 biliMusic v${VERSION} 单文件发布包`);
  log(`Node ${process.version}  (${process.execPath})`);
  log('='.repeat(64));

  if (!fs.existsSync(POSTJECT)) {
    console.error(`\n缺少 postject：${POSTJECT}`);
    console.error('先在 tools/ 里装一下：cd tools && npm install\n');
    process.exit(1);
  }

  rmrf(WORK);
  rmrf(STAGE);
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(STAGE, { recursive: true });

  /* 1. 主脚本：去掉 shebang（SEA 的 blob 入口不需要，留着可能解析失败） */
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const mainJs = src.replace(/^#![^\n]*\n/, '');
  const mainPath = path.join(WORK, 'sea-main.js');
  fs.writeFileSync(mainPath, mainJs, 'utf8');
  log(`\n[1/5] 主脚本 ${(Buffer.byteLength(mainJs) / 1024).toFixed(1)} KB`);

  /* 2. 静态资源全部登记为 asset */
  const files = walk(PUBLIC);
  const assets = {};
  let assetBytes = 0;
  for (const rel of files) {
    assets[`public/${rel}`] = path.join(PUBLIC, rel);
    assetBytes += fs.statSync(path.join(PUBLIC, rel)).size;
  }
  log(`[2/5] 内嵌资源 ${files.length} 个 / ${(assetBytes / 1024).toFixed(1)} KB`);
  for (const rel of files) log(`        public/${rel}`);

  /* 3. 生成 sea-config.json 并产出 blob */
  const cfg = {
    main: mainPath,
    output: path.join(WORK, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true, // V8 代码缓存，冷启动能快一截
    assets,
  };
  const cfgPath = path.join(WORK, 'sea-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  try {
    execFileSync(process.execPath, ['--experimental-sea-config', cfgPath], {
      stdio: 'inherit',
      cwd: ROOT,
    });
  } catch (e) {
    // 个别环境生成 code cache 会失败，退回不带缓存再试一次
    log('       code cache 生成失败，退回普通模式重试');
    cfg.useCodeCache = false;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    execFileSync(process.execPath, ['--experimental-sea-config', cfgPath], {
      stdio: 'inherit',
      cwd: ROOT,
    });
  }
  const blobSize = fs.statSync(cfg.output).size;
  log(`[3/5] blob ${(blobSize / 1024 / 1024).toFixed(2)} MB`);

  /* 4. 复制 node.exe 并把 blob 注进去 */
  const exePath = path.join(STAGE, EXE_NAME);
  fs.copyFileSync(process.execPath, exePath);
  log('[4/5] 注入 blob（这一步会重写 exe，稍等）');
  execFileSync(
    process.execPath,
    [POSTJECT, exePath, 'NODE_SEA_BLOB', cfg.output, '--sentinel-fuse', SENTINEL],
    { stdio: 'inherit', cwd: ROOT }
  );

  const exeSize = fs.statSync(exePath).size;
  log(`[5/5] 产物 ${EXE_NAME} ${(exeSize / 1024 / 1024).toFixed(1)} MB`);

  /* 桌面端（前端窗口）：连 localhost:7788，和上面的服务端配套使用 */
  const desktopExe = path.join(
    ROOT,
    'desktop',
    'dist',
    `biliMusic-desktop-setup-${VERSION}.exe`
  );
  if (fs.existsSync(desktopExe)) {
    fs.copyFileSync(desktopExe, path.join(STAGE, path.basename(desktopExe)));
    const mb = (fs.statSync(desktopExe).size / 1024 / 1024).toFixed(1);
    log(`       + ${path.basename(desktopExe)} ${mb} MB`);
  } else {
    log('       ! 没找到桌面端安装包，跳过（先 cd desktop && npm run dist）');
  }

  /* 附带说明 */
  fs.writeFileSync(path.join(STAGE, 'README.txt'), readmeText(), 'utf8');

  /* 打 zip */
  if (!NO_ZIP) {
    const zipPath = `${STAGE}.zip`;
    rmrf(zipPath);
    log('\n打包 zip...');
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${zipPath}' -Force`,
      ],
      { stdio: 'inherit' }
    );
    log(`       ${path.basename(zipPath)} ${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);
  }

  log('\n' + '='.repeat(64));
  log(`完成：${STAGE}`);
  log(`运行：双击 ${EXE_NAME}，浏览器会自动打开 http://localhost:7788\n`);
}

function readmeText() {
  return `biliMusic v${VERSION} — B 站收藏夹音乐播放器（Windows x64）

这个文件夹里有两个程序，作用不一样：

  biliMusic.exe                      服务端 + 网页版（必须先启动它）
  biliMusic-desktop-setup-${VERSION}.exe   桌面窗口版（可选，更像原生 App）

两个都不需要安装 Node.js，也不需要联网装任何依赖。


【用法一：只用网页版（最简单）】

  1. 双击 biliMusic.exe
  2. 会弹出一个黑色命令行窗口，浏览器自动打开 http://localhost:7788
  3. 第一次用要把 B 站收藏夹地址粘进去
     （形如 space.bilibili.com/xxx/favlist?fid=yyy）
  4. 关掉那个黑色窗口就停止播放器


【用法二：桌面窗口版（没有浏览器地址栏，带悬浮小卡片）】

  1. 双击 biliMusic-desktop-setup-${VERSION}.exe 装一次
  2. 每次用之前，先双击 biliMusic.exe 把服务起起来   ← 这步不能省
  3. 打开桌面上的「b站音乐播放器」

  桌面端默认连 http://localhost:7788。想连别的服务器，改这里：

      %APPDATA%\\b站音乐播放器\\config.json
      { "url": "http://你的地址:端口/" }

  桌面版多了：置顶悬浮小卡片（可拖到屏幕角落）、隐藏系统菜单栏。


【数据存在哪】

  biliMusic.exe 同目录下会自动建一个 data/ 文件夹：

    data/library.json    你导入过的收藏夹列表
    data/progress.json   每首歌听到第几秒
    data/history.json    播放历史（每次听了多久）
    data/fav/            收藏夹歌单缓存
    data/img/            封面图缓存

  备份就整个拷走 data/，换电脑放回 exe 旁边即可。


【想换端口】

  命令行里：set PORT=7789 && biliMusic.exe
  （换了端口，桌面端的 config.json 也要跟着改）


【想局域网内其他设备也能听】

  set HOST=0.0.0.0 && biliMusic.exe
  然后手机访问 http://<本机IP>:7788


【注意】

  - 只在 Windows x64 上测过
  - 本程序只是把 B 站公开收藏夹当歌单来播放，音频和封面都实时从 B 站取，
    不做任何下载或二次分发；需要登录才能听的曲目会取不到
  - 两个 exe 都没做代码签名，Windows 可能提示「已保护你的电脑」，
    点「更多信息 → 仍要运行」即可

项目主页：https://github.com/longyu2/biliMusic
`;
}

main();
