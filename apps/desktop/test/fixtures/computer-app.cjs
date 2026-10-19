const { app, BrowserWindow } = require('electron');
app.setName('DogO Computer Fixture');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ x: 90, y: 140, width: 400, height: 300, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', (...args) => {
    const text = args[0]?.message ?? (typeof args[1] === 'object' ? args[1].message : args[2]);
    if (typeof text === 'string' && text.startsWith('FIXTURE_INPUT:')) process.stdout.write(JSON.stringify({ received: text.slice(14) }) + '\n');
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>DogO 合成操作测试</title><style>body{font:16px system-ui;margin:20px}textarea{position:absolute;left:20px;top:50px;width:320px;height:60px}button{position:absolute;left:20px;top:140px;width:200px;height:45px}</style><h3>DogO 独立测试窗口</h3><textarea id="text"></textarea><button onclick="console.log(\'FIXTURE_INPUT:\'+document.getElementById(\'text\').value)">验证输入</button>'));
  win.show(); win.focus(); process.stdout.write(JSON.stringify({ bounds: win.getContentBounds() }) + '\n');
});
app.on('window-all-closed', () => app.quit());
