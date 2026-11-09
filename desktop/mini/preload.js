const { contextBridge, ipcRenderer } = require('electron');

// 小卡片只当遥控器：不碰音频，所有播放都由主窗口执行
contextBridge.exposeInMainWorld('mini', {
  onState: (cb) => {
    ipcRenderer.on('player:state', (_e, s) => cb(s));
  },
  onMode: (cb) => {
    ipcRenderer.on('mini:mode', (_e, mode) => cb(mode));
  },
  command: (cmd) => ipcRenderer.send('player:command', cmd),
  expand: () => ipcRenderer.send('mini:close'),
  card: () => ipcRenderer.send('mini:card'),
  collapse: () => ipcRenderer.send('mini:collapse'),
  menu: () => ipcRenderer.send('mini:menu'),
  dragStart: () => ipcRenderer.send('mini:dragstart'),
  dragMove: (dx, dy) => ipcRenderer.send('mini:dragmove', { dx, dy }),
  dragEnd: (moved) => ipcRenderer.send('mini:dragend', !!moved),
});
