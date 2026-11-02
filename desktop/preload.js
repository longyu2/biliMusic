const { contextBridge, ipcRenderer } = require('electron');

// 错误页用：重试连接、打开配置文件、退出应用
contextBridge.exposeInMainWorld('appBridge', {
  retry: () => ipcRenderer.send('app:retry'),
  openConfig: () => ipcRenderer.send('app:open-config'),
  quit: () => ipcRenderer.send('app:quit'),
});

// 主页面用：悬浮小卡片。web 端靠 isDesktop 判断要不要显示那个按钮
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  openMini: () => ipcRenderer.send('mini:open'),
  onCommand: (cb) => {
    ipcRenderer.on('player:command', (_e, cmd) => cb(cmd));
  },
  reportState: (s) => ipcRenderer.send('player:state', s),
});
