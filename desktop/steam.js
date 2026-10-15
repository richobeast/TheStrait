'use strict';
// Steam integration for the desktop build: lobbies, invites, rich presence, achievements,
// and a relay that carries game traffic over Steam P2P so nobody has to port-forward.
//
// Host:   friend's packets  --Steam P2P-->  this module  --WebSocket-->  local game server
// Client: renderer --WebSocket--> local proxy (this module) --Steam P2P--> host
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;

const GAME_TAG = 'thestrait';
const VERSION = '2';
const PKT = { HELLO: 1, DATA: 2, BYE: 3 };
// steamworks.js exposes these as TypeScript const enums, so the numeric values are used directly
const CB = { LobbyChatUpdate: 5, P2PSessionRequest: 6, GameLobbyJoinRequested: 8 };
const LOBBY = { FriendsOnly: 1, Public: 2 };
const SEND_RELIABLE = 2;
const DIALOG_FRIENDS = 0;

let sw = null, client = null, localPort = 0, onJoinRequest = null;
let hosting = false, lobby = null, joinState = null;
const hostSessions = new Map(); // steamId string -> { id, ws, queue, lastSeen }

// Must run before Electron's app 'ready' so the overlay can hook the renderer.
function preInit() {
  try {
    sw = require('steamworks.js');
    sw.electronEnableSteamOverlay();
  } catch (e) {
    console.warn('[steam] steamworks.js unavailable:', e.message);
    sw = null;
  }
}

function restartIfNeeded(appId) {
  try { return !!(sw && sw.restartAppIfNecessary(appId)); } catch { return false; }
}

function init(appId, opts) {
  localPort = opts.localPort;
  onJoinRequest = opts.onJoinRequest;
  if (!sw) return false;
  try {
    client = sw.init(appId);
  } catch (e) {
    console.warn('[steam] init failed (is Steam running and logged in?):', e.message);
    client = null;
    return false;
  }
  client.callback.register(CB.P2PSessionRequest, ({ remote }) => {
    if (hosting || (joinState && remote === joinState.hostId)) client.networking.acceptP2PSession(remote);
  });
  client.callback.register(CB.GameLobbyJoinRequested, ({ lobby_steam_id }) => {
    if (onJoinRequest) onJoinRequest(String(lobby_steam_id));
  });
  setInterval(pump, 4);
  console.log(`[steam] ready as ${client.localplayer.getName()} (app ${appId})`);
  return true;
}

const available = () => !!client;

function info() {
  if (!client) return { available: false, name: '' };
  return { available: true, name: client.localplayer.getName(), steamId: String(client.localplayer.getSteamId().steamId64) };
}

function sendPkt(id, type, payload) {
  if (!client) return;
  const body = payload == null ? Buffer.alloc(0) : Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  client.networking.sendP2PPacket(id, SEND_RELIABLE, Buffer.concat([Buffer.from([type]), body]));
}

function pump() {
  if (!client) return;
  let size, n = 0;
  while ((size = client.networking.isP2PPacketAvailable()) > 0 && n++ < 1000) {
    const pkt = client.networking.readP2PPacket(size);
    if (!pkt || !pkt.data || !pkt.data.length) continue;
    const from = pkt.steamId.steamId64;
    const type = pkt.data[0], body = pkt.data.subarray(1);
    if (hosting) onHostPacket(from, type, body);
    else if (joinState && from === joinState.hostId) onClientPacket(type, body);
  }
  const now = Date.now();
  for (const [key, s] of hostSessions) if (now - s.lastSeen > 20000) closeHostSession(key, true);
  if (joinState && joinState.sock && now - joinState.lastSeen > 15000) joinState.sock.close();
}

// ---------- Hosting ----------
function onHostPacket(from, type, body) {
  const key = String(from);
  let s = hostSessions.get(key);
  if (type === PKT.HELLO) {
    if (s) closeHostSession(key, false);
    if (hostSessions.size >= 15) { sendPkt(from, PKT.BYE); return; }
    const ws = new WebSocket(`ws://127.0.0.1:${localPort}`);
    s = { id: from, ws, queue: [], lastSeen: Date.now() };
    hostSessions.set(key, s);
    ws.on('open', () => { for (const m of s.queue) ws.send(m); s.queue = []; });
    ws.on('message', (data) => sendPkt(from, PKT.DATA, data));
    ws.on('close', () => { if (hostSessions.get(key) === s) { hostSessions.delete(key); sendPkt(from, PKT.BYE); } });
    ws.on('error', () => {});
    return;
  }
  if (!s) return;
  s.lastSeen = Date.now();
  if (type === PKT.DATA) {
    const text = body.toString('utf8');
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(text);
    else if (s.queue.length < 200) s.queue.push(text);
  } else if (type === PKT.BYE) closeHostSession(key, false);
}

function closeHostSession(key, notify) {
  const s = hostSessions.get(key);
  if (!s) return;
  hostSessions.delete(key);
  if (notify) sendPkt(s.id, PKT.BYE);
  try { s.ws.close(); } catch { /* already closed */ }
}

async function host(visibility, mapName) {
  if (!client) throw new Error('Steam is not running');
  leave();
  hosting = true;
  lobby = await client.matchmaking.createLobby(visibility === 2 ? LOBBY.Public : LOBBY.FriendsOnly, 16);
  lobby.mergeFullData({ game: GAME_TAG, version: VERSION, name: `${client.localplayer.getName()}'s game`, map: mapName || '' });
  lobby.setJoinable(true);
  client.localplayer.setRichPresence('connect', `+connect_lobby ${lobby.id}`);
  client.localplayer.setRichPresence('status', 'Hosting a match');
  return String(lobby.id);
}

// ---------- Joining ----------
function onClientPacket(type, body) {
  const s = joinState;
  s.lastSeen = Date.now();
  if (type === PKT.DATA) { if (s.sock && s.sock.readyState === WebSocket.OPEN) s.sock.send(body.toString('utf8')); }
  else if (type === PKT.BYE && s.sock) s.sock.close();
}

async function join(lobbyIdStr) {
  if (!client) throw new Error('Steam is not running');
  leave();
  const lob = await client.matchmaking.joinLobby(BigInt(lobbyIdStr));
  const tag = lob.getData('game');
  if (tag && tag !== GAME_TAG) { lob.leave(); throw new Error('That lobby is for a different game'); }
  if (lob.getData('version') && lob.getData('version') !== VERSION) { lob.leave(); throw new Error('The host is running a different version of the game'); }
  const hostId = lob.getOwner().steamId64;
  if (hostId === client.localplayer.getSteamId().steamId64) { lob.leave(); throw new Error('That is your own lobby'); }
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  joinState = { hostId, lobby: lob, server, sock: null, lastSeen: Date.now() };
  server.on('connection', (sock) => {
    const st = joinState;
    if (!st) { sock.close(); return; }
    if (st.sock) st.sock.close();
    st.sock = sock;
    st.lastSeen = Date.now();
    sendPkt(hostId, PKT.HELLO);
    sock.on('message', (data) => sendPkt(hostId, PKT.DATA, data));
    sock.on('close', () => { if (joinState === st && st.sock === sock) { sendPkt(hostId, PKT.BYE); st.sock = null; } });
  });
  client.localplayer.setRichPresence('connect', `+connect_lobby ${lob.id}`);
  client.localplayer.setRichPresence('status', 'In a match');
  return server.address().port;
}

async function findLobbies() {
  if (!client) return [];
  const list = await client.matchmaking.getLobbies();
  return list
    .filter((l) => l.getData('game') === GAME_TAG && l.getData('version') === VERSION)
    .map((l) => ({ id: String(l.id), name: l.getData('name') || 'The Strait! match', players: Number(l.getMemberCount()), max: Number(l.getMemberLimit() || 16) }));
}

function leave() {
  if (hosting) { for (const key of [...hostSessions.keys()]) closeHostSession(key, true); hosting = false; }
  if (lobby) { try { lobby.leave(); } catch { /* ignore */ } lobby = null; }
  if (joinState) {
    const st = joinState;
    joinState = null;
    try { sendPkt(st.hostId, PKT.BYE); } catch { /* ignore */ }
    try { if (st.sock) st.sock.close(); } catch { /* ignore */ }
    try { st.server.close(); } catch { /* ignore */ }
    try { st.lobby.leave(); } catch { /* ignore */ }
  }
  if (client) { client.localplayer.setRichPresence('connect', null); client.localplayer.setRichPresence('status', 'In menus'); }
}

function invite() {
  if (!client) return false;
  const id = lobby ? lobby.id : joinState ? joinState.lobby.id : null;
  if (id) client.overlay.activateInviteDialog(id);
  else client.overlay.activateDialog(DIALOG_FRIENDS);
  return !!id;
}

function setStatus(text) { if (client) client.localplayer.setRichPresence('status', String(text).slice(0, 200)); }

function achievement(name) {
  if (!client) return false;
  try { return client.achievement.isActivated(name) || client.achievement.activate(name); } catch { return false; }
}

module.exports = { preInit, restartIfNeeded, init, available, info, host, join, findLobbies, leave, invite, setStatus, achievement };
