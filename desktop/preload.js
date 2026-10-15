'use strict';
// Exposes a small, fixed API to the game page as window.steam. The page never gets Node access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('steam', {
  info: () => ipcRenderer.invoke('steam:info'),
  hostGame: (o) => ipcRenderer.invoke('game:host', { visibility: Number(o.visibility), bots: Number(o.bots) }),
  playOffline: (o) => ipcRenderer.invoke('game:offline', { bots: Number(o.bots) }),
  findGames: () => ipcRenderer.invoke('game:find'),
  joinGame: (id) => ipcRenderer.invoke('game:join', String(id)),
  leaveGame: () => ipcRenderer.invoke('game:leave'),
  invite: () => ipcRenderer.invoke('steam:invite'),
  setStatus: (t) => ipcRenderer.invoke('steam:status', String(t)),
  achievement: (n) => ipcRenderer.invoke('steam:achievement', String(n)),
  quit: () => ipcRenderer.invoke('app:quit'),
  onJoinRequest: (cb) => ipcRenderer.on('steam:join-request', (_e, id) => cb(String(id))),
});
