'use strict';
// Desktop (Steam) entry point. Runs a local game server inside the app and shows the game in a window.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { startServer } = require('../server.js');
const C = require('../shared/common.js');
const steam = require('./steam.js');
const pkg = require('../package.json');

// Your Steam App ID goes in package.json ("steamAppId"). 480 is Valve's public test app (Spacewar).
const APP_ID = Number(process.env.STEAM_APP_ID) || Number(pkg.steamAppId) || 480;

steam.preInit();
if (app.isPackaged && APP_ID !== 480 && steam.restartIfNeeded(APP_ID)) app.exit(0);
if (!app.requestSingleInstanceLock()) app.exit(0);
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

let win = null, game = null, pendingLobby = null;
const lobbyArg = (argv) => { const i = argv.indexOf('+connect_lobby'); return i >= 0 ? argv[i + 1] : null; };
pendingLobby = lobbyArg(process.argv);

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 900, minWidth: 1024, minHeight: 600,
    backgroundColor: '#1a140d', title: 'The Strait! (Beta 0.0.1)', autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.removeMenu();
  if (!process.env.IW_SMOKE) win.once('ready-to-show', () => { win.maximize(); win.show(); });
  const origin = `http://127.0.0.1:${game.port}`;
  win.loadURL(origin + '/');
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin)) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (input.type === 'keyDown' && input.key === 'F12' && !app.isPackaged) win.webContents.toggleDevTools();
  });
  win.webContents.on('did-finish-load', () => {
    if (pendingLobby) { win.webContents.send('steam:join-request', pendingLobby); pendingLobby = null; }
    if (process.env.IW_SMOKE) smokeTest();
  });
  win.on('closed', () => { win = null; });
}

// IW_SMOKE=1: load hidden, start an offline match, report what happened, then quit.
async function smokeTest() {
  const js = `(async () => {
    const out = { hasSteamApi: !!window.steam, info: await window.steam.info() };
    document.getElementById('btnOffline').click();
    await new Promise((r) => setTimeout(r, 2500));
    out.state = window.__game.state(); out.alive = window.__game.me.alive; out.remotes = window.__game.remotes.size;
    out.renderCalls = window.__game.renderer.info.render.calls;
    return out;
  })()`;
  try { console.log('[smoke]', JSON.stringify(await win.webContents.executeJavaScript(js))); }
  catch (e) { console.log('[smoke] failed', e.message); }
  app.quit();
}

app.on('second-instance', (_e, argv) => {
  const id = lobbyArg(argv);
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); if (id) win.webContents.send('steam:join-request', id); }
});

app.whenReady().then(async () => {
  game = await startServer({ port: 0, host: '127.0.0.1', bots: 8, name: 'Local', log: (...a) => console.log('[game]', ...a) });
  if (!process.env.IW_NO_STEAM) steam.init(APP_ID, {
    localPort: game.port,
    onJoinRequest: (lobbyId) => { if (win) win.webContents.send('steam:join-request', lobbyId); else pendingLobby = lobbyId; },
  });

  const localUrl = () => ({ url: `ws://127.0.0.1:${game.port}` });
  ipcMain.handle('steam:info', () => steam.info());
  ipcMain.handle('game:host', async (_e, o = {}) => {
    game.setBots(o.bots);
    game.newMatch();
    await steam.host(o.visibility, C.MAP.name);
    return localUrl();
  });
  ipcMain.handle('game:offline', (_e, o = {}) => {
    steam.leave();
    game.setBots(o.bots);
    game.newMatch();
    return localUrl();
  });
  ipcMain.handle('game:find', () => steam.findLobbies());
  ipcMain.handle('game:join', async (_e, id) => ({ url: `ws://127.0.0.1:${await steam.join(String(id))}` }));
  ipcMain.handle('game:leave', () => steam.leave());
  ipcMain.handle('steam:invite', () => steam.invite());
  ipcMain.handle('steam:status', (_e, t) => steam.setStatus(t));
  ipcMain.handle('steam:achievement', (_e, n) => steam.achievement(n));
  ipcMain.handle('app:quit', () => app.quit());

  createWindow();
});

app.on('before-quit', () => { steam.leave(); if (game) game.close(); });
app.on('window-all-closed', () => app.quit());
