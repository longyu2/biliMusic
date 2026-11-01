const { contextBridge, ipcRenderer } = require('electron');

// 小卡片只当遥控器：不碰音频，所有播放都由主窗口执行
contextBridge.exposeInMainWorld('mini', {
  onState: (cb) => {
    ipcRenderer.on('player:state', (_e, s) => cb(s));
  },
  command: (cmd) => ipcRenderer.send('player:command', cmd),
  expand: () => ipcRenderer.send('mini:close'),
});
