/**
 * pm2 配置：在服务器上常驻运行
 *   pm2 start ecosystem.config.js
 *   pm2 save
 */
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'bili-fav-player',
      script: path.join(__dirname, 'server.js'),
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: '7788',
        NO_OPEN: '1',
      },
    },
  ],
};
