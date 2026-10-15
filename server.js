'use strict';
// Game server: serves the client files and runs the authoritative match (HTTP + WebSocket).
// Runs inside the desktop app when you host, or standalone: node server.js --port 3000 --bots 8
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const C = require('./shared/common.js');

const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};
const MOUNTS = [
  ['/shared/', path.join(ROOT, 'shared')],
  ['/vendor/three/', path.join(ROOT, 'node_modules', 'three', 'build')],
  ['/', path.join(ROOT, 'public')],
];

function resolveStatic(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  if (p === '/') p = '/index.html';
  for (const [prefix, dir] of MOUNTS) {
    if (!p.startsWith(prefix)) continue;
    const file = path.resolve(dir, '.' + p.slice(prefix.length - 1));
    return file.startsWith(dir + path.sep) ? file : null;
  }
  return null;
}

const BOT_NAMES = {
  1: ['Reaper', 'Ghost', 'Hammer', 'Viking', 'Maverick', 'Outlaw', 'Bishop', 'Nomad', 'Havoc', 'Ranger'],
  2: ['Shahin', 'Palang', 'Oghab', 'Tondar', 'Toufan', 'Arash', 'Kaveh', 'Rostam', 'Babak', 'Sohrab'],
};
const BOT_SKILL = { maxHit: 0.42, react: [320, 750], interval: 125 };
const MAX_PLAYERS = 16;
const WEAPON_INDEX = { rifle: 0, shotgun: 1, sniper: 2, pistol: 3, nade: 4 };

const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const vec3 = (v) => (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? v.map(Number) : null);
const angleDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const turnToward = (a, b, max) => { const d = angleDiff(a, b); return a + clamp(d, -max, max); };
const eyeOf = (p) => [p.x, p.y + (p.crouch ? C.PLAYER.crouchEye : C.PLAYER.eye), p.z];

// ---------- Bot navigation grid ----------
const NAV = (() => {
  const E = C.MAP.size - 1, N = 2 * E, R = 0.45;
  const blocked = new Uint8Array(N * N);
  for (const b of C.MAP.solids) {
    if (b.min[1] > 1.5 || b.max[1] < 0.25) continue;
    const i0 = Math.max(0, Math.ceil(b.min[0] - R + E - 0.5)), i1 = Math.min(N - 1, Math.floor(b.max[0] + R + E - 0.5));
    const j0 = Math.max(0, Math.ceil(b.min[2] - R + E - 0.5)), j1 = Math.min(N - 1, Math.floor(b.max[2] + R + E - 0.5));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) blocked[j * N + i] = 1;
  }
  for (let k = 0; k < N; k++) { blocked[k] = blocked[(N - 1) * N + k] = blocked[k * N] = blocked[k * N + N - 1] = 1; }
  const cell = (x, z) => [clamp(Math.floor(x + E), 0, N - 1), clamp(Math.floor(z + E), 0, N - 1)];
  const open = (i, j) => i >= 0 && j >= 0 && i < N && j < N && !blocked[j * N + i];
  const world = (i, j) => [i - E + 0.5, j - E + 0.5];
  function nearestOpen(i, j, maxR) {
    if (open(i, j)) return [i, j];
    for (let r = 1; r <= maxR; r++) for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) === r && open(i + di, j + dj)) return [i + di, j + dj];
    }
    return null;
  }
  function lineClear(ax, az, bx, bz) {
    const d = Math.hypot(bx - ax, bz - az), steps = Math.ceil(d / 0.35);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, [i, j] = cell(ax + (bx - ax) * t, az + (bz - az) * t);
      if (!open(i, j)) return false;
    }
    return true;
  }
  const g = new Float32Array(N * N), came = new Int32Array(N * N), stamp = new Uint32Array(N * N), closed = new Uint32Array(N * N);
  let gen = 0;
  function findPath(sx, sz, tx, tz) {
    const s = nearestOpen(...cell(sx, sz), 3), t = nearestOpen(...cell(tx, tz), 6);
    if (!s || !t) return null;
    gen++;
    const start = s[1] * N + s[0], goal = t[1] * N + t[0];
    const heap = [];
    const push = (node, f) => {
      heap.push([f, node]);
      let k = heap.length - 1;
      while (k > 0) { const pk = (k - 1) >> 1; if (heap[pk][0] <= heap[k][0]) break; [heap[pk], heap[k]] = [heap[k], heap[pk]]; k = pk; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last; let k = 0;
        for (;;) {
          const l = 2 * k + 1, r = l + 1; let m = k;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m;
        }
      }
      return top[1];
    };
    const h = (n) => { const dx = Math.abs((n % N) - t[0]), dz = Math.abs(((n / N) | 0) - t[1]); return Math.max(dx, dz) + 0.414 * Math.min(dx, dz); };
    g[start] = 0; stamp[start] = gen; came[start] = -1; push(start, h(start));
    let iter = 0, found = false;
    while (heap.length && iter++ < 30000) {
      const n = pop();
      if (closed[n] === gen) continue;
      closed[n] = gen;
      if (n === goal) { found = true; break; }
      const ni = n % N, nj = (n / N) | 0;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        if (!di && !dj) continue;
        const ii = ni + di, jj = nj + dj;
        if (!open(ii, jj)) continue;
        if (di && dj && (!open(ni + di, nj) || !open(ni, nj + dj))) continue;
        const m = jj * N + ii;
        if (closed[m] === gen) continue;
        const ng = g[n] + (di && dj ? 1.414 : 1);
        if (stamp[m] !== gen || ng < g[m]) { stamp[m] = gen; g[m] = ng; came[m] = n; push(m, ng + h(m)); }
      }
    }
    if (!found) return null;
    const cells = [];
    for (let n = goal; n !== -1; n = came[n]) cells.push(world(n % N, (n / N) | 0));
    cells.reverse();
    // string-pull to drop unnecessary waypoints
    const out = [];
    let from = [sx, sz], k = 0;
    while (k < cells.length) {
      let far = k;
      for (let m = cells.length - 1; m > k; m--) if (lineClear(from[0], from[1], cells[m][0], cells[m][1])) { far = m; break; }
      out.push(cells[far]); from = cells[far]; k = far + 1;
    }
    return out;
  }
  function randomOpen() {
    for (let tries = 0; tries < 200; tries++) {
      const i = (Math.random() * N) | 0, j = (Math.random() * N) | 0;
      if (open(i, j)) return world(i, j);
    }
    return [0, 0];
  }
  return { findPath, randomOpen };
})();

// Places bots like to roam to (all on walkable ground of Hormuz Port)
const HOTSPOTS = [[0, 12], [0, -12], [-12, 0], [12, 0], [-20, -28], [-20, 28], [-40, 0], [40, 0], [-62, 0], [52, 0],
  [-35, -33], [-35, 33], [44, 36], [44, -36], [0, 42], [0, -42], [-45, -52], [-45, 52], [45, 52], [45, -52],
  [-70, -30], [-70, 30], [26, -24], [26, 24], [47, 20], [47, -20]];
const defaultAtt = () => Object.fromEntries(C.WEAPON_KEYS.map((k) => [k, C.cleanAtt(k, C.DEFAULT_ATT[k])]));
const cleanAllAtt = (att) => Object.fromEntries(C.WEAPON_KEYS.map((k) => [k, C.cleanAtt(k, att && att[k])]));
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// ---------- Server ----------
function startServer(opts = {}) {
  const port = opts.port == null ? 3000 : opts.port;
  let botFill = opts.bots == null ? 8 : opts.bots;
  const host = opts.host || '0.0.0.0';
  const log = opts.log || ((...a) => console.log('[server]', ...a));

  const players = new Map();
  const nades = [];
  let nextId = 1, nextNadeId = 1;
  const score = { 1: 0, 2: 0 };
  let phase = 'playing', matchEndsAt = Date.now() + C.MATCH.timeLimit, resetAt = 0;

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/api/info') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(info()));
      return;
    }
    const file = resolveStatic(req.url);
    if (!file) { res.writeHead(404); res.end('Not found'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 16 * 1024 });

  function info() {
    const humans = [...players.values()].filter((p) => !p.bot).length;
    return { name: opts.name || 'The Strait! Server', map: C.MAP.name, humans, max: MAX_PLAYERS, score: [score[1], score[2]] };
  }

  const send = (p, msg) => { if (p.ws && p.ws.readyState === 1) p.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); };
  const broadcast = (msg, except) => {
    const s = JSON.stringify(msg);
    for (const p of players.values()) if (p !== except) send(p, s);
  };
  const roster = () => ({
    t: 'roster',
    pl: [...players.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, k: p.kills, d: p.deaths, bot: p.bot ? 1 : 0, pr: p.primary, at: p.att[p.primary], ap: p.att.pistol })),
  });
  const broadcastRoster = () => broadcast(roster());

  function makePlayer(name, team, bot) {
    return {
      id: nextId++, name, team, bot, ws: null, x: 0, y: 0, z: 0, ry: 0, rx: 0, crouch: 0, w: 0, moving: 0,
      alive: false, hp: 100, kills: 0, deaths: 0, lastDamage: 0, lastFire: {}, respawnAt: Date.now(),
      primary: 'rifle', nextPrimary: 'rifle', att: defaultAtt(), nextAtt: defaultAtt(), attKey: '', nades: C.PLAYER.nades, protectUntil: 0, spawnedAt: 0, lastChat: 0, ai: null, lastSt: 0, lastTp: 0,
    };
  }

  function makeBot(team) {
    const used = new Set([...players.values()].map((p) => p.name));
    const pool = BOT_NAMES[team].filter((n) => !used.has('BOT ' + n));
    const name = 'BOT ' + (pool.length ? pool[(Math.random() * pool.length) | 0] : 'Grunt' + nextId);
    const b = makePlayer(name, team, true);
    const allow = C.WEAPONS.rifle.allow;
    b.att.rifle = { optic: pick(allow.optic), muzzle: pick(allow.muzzle), under: pick(allow.under), mag: pick(allow.mag) };
    b.nextAtt = b.att;
    b.respawnAt = Date.now() + 500;
    return b;
  }

  function balanceBots() {
    const per = Math.ceil(botFill / 2);
    for (const team of [1, 2]) {
      const list = [...players.values()].filter((p) => p.team === team);
      const humans = list.filter((p) => !p.bot).length;
      const bots = list.filter((p) => p.bot);
      const want = botFill > 0 ? Math.max(0, per - humans) : 0;
      while (bots.length > want) players.delete(bots.pop().id);
      while (bots.length < want) { const b = makeBot(team); players.set(b.id, b); bots.push(b); }
    }
    broadcastRoster();
  }

  function spawn(p) {
    const now = Date.now();
    const enemies = [...players.values()].filter((e) => e.alive && e.team !== p.team);
    const friends = [...players.values()].filter((e) => e.alive && e.team === p.team && e !== p);
    let best = null, bestScore = -Infinity;
    for (const s of C.MAP.spawns[p.team]) {
      let minD = 80;
      for (const e of enemies) minD = Math.min(minD, Math.hypot(e.x - s[0], e.z - s[2]));
      let crowd = 0;
      for (const f of friends) if (Math.hypot(f.x - s[0], f.z - s[2]) < 1.6) crowd += 100;
      const sc = minD + Math.random() * 20 - crowd;
      if (sc > bestScore) { bestScore = sc; best = s; }
    }
    p.x = best[0] + (Math.random() - 0.5) * 0.6; p.y = 0; p.z = best[2] + (Math.random() - 0.5) * 0.6;
    p.ry = p.team === 1 ? 0 : Math.PI; p.rx = 0; p.crouch = 0; p.moving = 0;
    p.alive = true; p.hp = C.PLAYER.maxHp; p.nades = C.PLAYER.nades;
    p.primary = p.nextPrimary; p.w = WEAPON_INDEX[p.primary];
    p.att = p.nextAtt;
    const attKey = JSON.stringify([p.primary, p.att[p.primary], p.att.pistol]);
    const attChanged = attKey !== p.attKey;
    p.attKey = attKey;
    p.protectUntil = now + 1500; p.spawnedAt = now; p.lastDamage = 0; p.lastSt = now;
    if (p.bot) {
      p.ai = { target: null, nextLook: 0, reactAt: 0, nextShot: 0, burst: 4, ammo: 30, strafeDir: 1, strafeUntil: 0,
        path: null, pathIdx: 0, repathAt: 0, lastSeen: null, alertBy: null, alertUntil: 0, stuckX: p.x, stuckZ: p.z, stuckAt: now + 1500, crouchShoot: false };
    }
    send(p, { t: 'spawn', p: [r2(p.x), p.y, r2(p.z)], ry: p.ry, primary: p.primary, att: p.att });
    if (attChanged) broadcastRoster();
  }

  function applyDamage(victim, attacker, dmg, weapon, head) {
    const now = Date.now();
    if (!victim.alive || phase !== 'playing') return;
    if (victim.protectUntil > now && attacker !== victim) return;
    dmg = Math.max(1, Math.round(dmg));
    victim.hp -= dmg;
    victim.lastDamage = now;
    if (victim.bot && attacker !== victim && victim.ai) {
      victim.ai.alertBy = attacker; victim.ai.alertUntil = now + 2500;
      victim.ai.lastSeen = { x: attacker.x, z: attacker.z, t: now };
    }
    send(victim, { t: 'dmg', hp: Math.max(0, Math.ceil(victim.hp)), from: [r2(attacker.x), r2(attacker.z)], self: attacker === victim ? 1 : 0 });
    if (attacker !== victim) send(attacker, { t: 'hm', h: head ? 1 : 0, k: victim.hp <= 0 ? 1 : 0 });
    if (victim.hp <= 0) kill(victim, attacker, weapon, head);
  }

  function kill(victim, attacker, weapon, head) {
    const now = Date.now();
    victim.alive = false; victim.hp = 0; victim.deaths++;
    victim.respawnAt = now + C.MATCH.respawnDelay;
    if (attacker !== victim && attacker.team !== victim.team) { attacker.kills++; score[attacker.team]++; }
    broadcast({ t: 'kill', k: attacker.id, v: victim.id, w: WEAPON_INDEX[weapon], h: head ? 1 : 0 });
    broadcastRoster();
    if (score[1] >= C.MATCH.scoreLimit || score[2] >= C.MATCH.scoreLimit) endMatch();
  }

  function endMatch() {
    if (phase !== 'playing') return;
    phase = 'ended';
    resetAt = Date.now() + C.MATCH.endPause;
    nades.length = 0;
    const win = score[1] > score[2] ? 1 : score[2] > score[1] ? 2 : 0;
    broadcast({ t: 'end', win, sc: [score[1], score[2]] });
    log(`match over: ${C.TEAMS[1].name} ${score[1]} - ${score[2]} ${C.TEAMS[2].name}`);
  }

  function resetMatch() {
    const now = Date.now();
    phase = 'playing'; score[1] = score[2] = 0; matchEndsAt = now + C.MATCH.timeLimit;
    for (const p of players.values()) { p.kills = p.deaths = 0; p.alive = false; p.respawnAt = now + 300; }
    broadcast({ t: 'start' });
    broadcastRoster();
  }

  // A target counts as visible if any of head, chest or knees has line of sight from the shooter.
  function visibleTarget(o, t) {
    if (Math.hypot(o[0] - t.x, o[2] - t.z) < 2.5) return true;
    const hh = t.crouch ? [1.1, 0.75, 0.35] : [1.6, 1.1, 0.45];
    return hh.some((h) => C.canSee(o, [t.x, t.y + h, t.z]));
  }

  // ---------- Bots ----------
  function botShoot(b, e, d, now) {
    const W = C.weaponStats('rifle', b.att.rifle);
    let p = clamp(BOT_SKILL.maxHit + 0.1 - d / 110, 0.08, BOT_SKILL.maxHit);
    if (d < 7) p = 0.6;
    if (e.moving) p *= 0.8;
    if (e.crouch) p *= 0.85;
    if (b.moving) p *= 0.85;
    const eye = [b.x, b.y + 1.5, b.z];
    const hit = Math.random() < p;
    const head = hit && Math.random() < 0.14;
    let end;
    if (hit) {
      const hy = head ? (e.crouch ? 1.1 : 1.62) : (e.crouch ? 0.7 : 1.05);
      end = [e.x + (Math.random() - 0.5) * 0.3, e.y + hy, e.z + (Math.random() - 0.5) * 0.3];
    } else {
      const aim = [e.x + (Math.random() - 0.5) * 2.4, e.y + 0.4 + Math.random() * 1.6, e.z + (Math.random() - 0.5) * 2.4];
      const dir = [aim[0] - eye[0], aim[1] - eye[1], aim[2] - eye[2]];
      const len = Math.hypot(...dir) || 1;
      dir[0] /= len; dir[1] /= len; dir[2] /= len;
      const t = C.rayMap(eye, dir, 140);
      const tt = t > 0 ? t : 140;
      end = [eye[0] + dir[0] * tt, eye[1] + dir[1] * tt, eye[2] + dir[2] * tt];
    }
    broadcast({ t: 'shot', id: b.id, w: 0, e: end.map(r2), m: hit ? 0 : 1, s: W.suppressed ? 1 : 0 });
    if (hit) {
      let dmg = W.dmg * (head ? W.head : 1);
      if (d > W.falloff[0]) dmg *= W.falloff[1];
      applyDamage(e, b, dmg, 'rifle', head);
    }
  }

  function pickGoal(b) {
    const r = Math.random();
    if (r < 0.55) { const h = HOTSPOTS[(Math.random() * HOTSPOTS.length) | 0]; return [h[0] + (Math.random() - 0.5) * 6, h[1] + (Math.random() - 0.5) * 6]; }
    if (r < 0.75) { const s = C.MAP.spawns[b.team === 1 ? 2 : 1]; const p = s[(Math.random() * s.length) | 0]; return [p[0], p[2] + (b.team === 1 ? 10 : -10)]; }
    return NAV.randomOpen();
  }

  function updateBot(b, dt, now) {
    const ai = b.ai;
    if (!ai) return;
    if (ai.target && !ai.target.alive) ai.target = null;
    if (now >= ai.nextLook) {
      ai.nextLook = now + 110 + Math.random() * 90;
      const eye = eyeOf(b);
      const fx = -Math.sin(b.ry), fz = -Math.cos(b.ry);
      let best = null, bestD = Infinity;
      for (const e of players.values()) {
        if (!e.alive || e.team === b.team) continue;
        const dx = e.x - b.x, dz = e.z - b.z, d = Math.hypot(dx, dz);
        if (d > 90 || d >= bestD) continue;
        const facing = (dx * fx + dz * fz) / (d || 1);
        if (facing < 0.15 && d > 9 && !(e === ai.alertBy && now < ai.alertUntil)) continue;
        if (!visibleTarget(eye, e)) continue;
        best = e; bestD = d;
      }
      if (best && best !== ai.target) ai.reactAt = now + BOT_SKILL.react[0] + Math.random() * (BOT_SKILL.react[1] - BOT_SKILL.react[0]);
      ai.target = best;
      if (best) ai.lastSeen = { x: best.x, z: best.z, t: now };
    }

    let mx = 0, mz = 0, speed = 0;
    if (ai.target) {
      const e = ai.target;
      const dx = e.x - b.x, dz = e.z - b.z, d = Math.hypot(dx, dz);
      const wantYaw = Math.atan2(-dx, -dz);
      const wantPitch = Math.atan2(e.y + (e.crouch ? 0.8 : 1.2) - (b.y + 1.5), d);
      b.ry = turnToward(b.ry, wantYaw, 4.5 * dt);
      b.rx += (wantPitch - b.rx) * Math.min(1, 8 * dt);
      if (now > ai.strafeUntil) {
        ai.strafeDir = Math.random() < 0.5 ? -1 : 1;
        ai.strafeUntil = now + 500 + Math.random() * 1200;
        ai.crouchShoot = d > 15 && Math.random() < 0.3;
      }
      mx = Math.cos(b.ry) * ai.strafeDir; mz = -Math.sin(b.ry) * ai.strafeDir;
      if (d > 35) { mx += -Math.sin(b.ry) * 0.7; mz += -Math.cos(b.ry) * 0.7; }
      speed = ai.crouchShoot ? 1.2 : 2.6;
      b.crouch = ai.crouchShoot ? 1 : 0;
      if (now >= ai.reactAt && Math.abs(angleDiff(b.ry, wantYaw)) < 0.12 && now >= ai.nextShot) {
        if (ai.ammo <= 0) { ai.ammo = 30; ai.nextShot = now + 2200; }
        else {
          botShoot(b, e, d, now);
          ai.ammo--; ai.burst--;
          ai.nextShot = now + BOT_SKILL.interval;
          if (ai.burst <= 0) { ai.burst = 3 + ((Math.random() * 5) | 0); ai.nextShot += 250 + Math.random() * 450; }
        }
      }
      ai.path = null;
    } else {
      b.crouch = 0;
      if (!ai.path || ai.pathIdx >= ai.path.length || now > ai.repathAt) {
        let goal;
        if (ai.lastSeen && now - ai.lastSeen.t < 6000) { goal = [ai.lastSeen.x, ai.lastSeen.z]; ai.lastSeen.t = 0; }
        else goal = pickGoal(b);
        ai.path = NAV.findPath(b.x, b.z, goal[0], goal[1]);
        ai.pathIdx = 0;
        ai.repathAt = now + (ai.path ? 6000 + Math.random() * 4000 : 400);
      }
      if (ai.path && ai.pathIdx < ai.path.length) {
        const wp = ai.path[ai.pathIdx];
        const dx = wp[0] - b.x, dz = wp[1] - b.z, d = Math.hypot(dx, dz);
        if (d < 0.7) ai.pathIdx++;
        else { mx = dx / d; mz = dz / d; speed = 4.6; }
      }
      let wantYaw = mx || mz ? Math.atan2(-mx, -mz) : b.ry;
      if (ai.alertBy && now < ai.alertUntil) wantYaw = Math.atan2(-(ai.alertBy.x - b.x), -(ai.alertBy.z - b.z));
      b.ry = turnToward(b.ry, wantYaw, 6 * dt);
      b.rx *= 1 - Math.min(1, 5 * dt);
    }

    const len = Math.hypot(mx, mz);
    b.moving = 0;
    if (len > 0 && speed > 0) {
      const nx = b.x + (mx / len) * speed * dt, nz = b.z + (mz / len) * speed * dt;
      if (!C.overlapsMap(nx, 0.05, b.z, 0.4, 1.7)) b.x = nx;
      if (!C.overlapsMap(b.x, 0.05, nz, 0.4, 1.7)) b.z = nz;
      b.moving = 1;
    }
    if (now > ai.stuckAt) {
      if (b.moving && Math.hypot(b.x - ai.stuckX, b.z - ai.stuckZ) < 0.4) { ai.path = null; ai.strafeDir *= -1; }
      ai.stuckX = b.x; ai.stuckZ = b.z; ai.stuckAt = now + 1500;
    }
  }

  // ---------- Grenades ----------
  function nadeBlocked(x, y, z) {
    if (y < 0.08) return true;
    for (const b of C.MAP.solids) {
      if (x > b.min[0] - 0.08 && x < b.max[0] + 0.08 && y > b.min[1] - 0.08 && y < b.max[1] + 0.08 && z > b.min[2] - 0.08 && z < b.max[2] + 0.08) return true;
    }
    return false;
  }

  function updateNades(dt, now) {
    for (let i = nades.length - 1; i >= 0; i--) {
      const n = nades[i];
      const steps = 3, sdt = dt / steps;
      for (let s = 0; s < steps; s++) {
        n.vy -= C.NADE.gravity * sdt;
        const nx = n.x + n.vx * sdt;
        if (nadeBlocked(nx, n.y, n.z)) n.vx *= -0.4; else n.x = nx;
        const nz = n.z + n.vz * sdt;
        if (nadeBlocked(n.x, n.y, nz)) n.vz *= -0.4; else n.z = nz;
        const ny = n.y + n.vy * sdt;
        if (nadeBlocked(n.x, ny, n.z)) {
          n.vy *= -0.3; n.vx *= 0.65; n.vz *= 0.65;
          if (Math.abs(n.vy) < 1.2) n.vy = 0;
        } else n.y = ny;
      }
      if (now >= n.at) { nades.splice(i, 1); explode(n); }
    }
  }

  function explode(n) {
    const owner = players.get(n.owner) || { id: n.owner, team: n.team, x: n.x, y: n.y, z: n.z, kills: 0, ws: null };
    broadcast({ t: 'boom', p: [r2(n.x), r2(n.y), r2(n.z)] });
    const o = [n.x, n.y + 0.3, n.z];
    for (const p of players.values()) {
      if (!p.alive || (p.team === n.team && p.id !== n.owner)) continue;
      const c = [p.x, p.y + 1.0, p.z];
      const d = dist3(o, c);
      if (d > C.NADE.radius) continue;
      if (!C.canSee(o, c) && !C.canSee(o, [p.x, p.y + 1.6, p.z]) && !C.canSee(o, [p.x, p.y + 0.3, p.z])) continue;
      applyDamage(p, owner, C.NADE.dmg * (1 - d / C.NADE.radius), 'nade', false);
    }
  }

  // ---------- Messages ----------
  function handleJoin(ws, msg) {
    const humans = [...players.values()].filter((p) => !p.bot);
    if (humans.length >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: 'full' })); return null; }
    let name = String(msg.name || '').replace(/[^\p{L}\p{N} _\-.[\]]/gu, '').trim().slice(0, 18);
    if (!name) name = 'Soldier' + nextId;
    const count = (team) => humans.filter((p) => p.team === team).length;
    let team = msg.team === 1 || msg.team === 2 ? msg.team : 0;
    if (!team) team = count(1) < count(2) ? 1 : count(2) < count(1) ? 2 : (Math.random() < 0.5 ? 1 : 2);
    const p = makePlayer(name, team, false);
    p.ws = ws;
    if (C.PRIMARIES.includes(msg.primary)) p.primary = p.nextPrimary = msg.primary;
    if (msg.att) p.att = p.nextAtt = cleanAllAtt(msg.att);
    players.set(p.id, p);
    send(p, { t: 'welcome', id: p.id, team, map: C.MAP.name, ph: phase, sc: [score[1], score[2]], tl: Math.max(0, matchEndsAt - Date.now()) });
    balanceBots();
    spawn(p);
    log(`${name} joined ${C.TEAMS[team].name}`);
    broadcast({ t: 'chat', id: 0, m: `${name} joined ${C.TEAMS[team].name}` });
    return p;
  }

  function handleMessage(p, msg) {
    const now = Date.now();
    switch (msg.t) {
      case 'st': {
        if (!p.alive) return;
        const pos = vec3(msg.p);
        if (!pos || Math.abs(pos[0]) > 80 || Math.abs(pos[2]) > 80 || pos[1] < -2 || pos[1] > 40) return;
        // reject impossible jumps and pull the client back to the last good position
        const allowed = 6 + ((now - p.lastSt) / 1000) * 12;
        if (Math.hypot(pos[0] - p.x, pos[2] - p.z) > allowed && now - p.spawnedAt > 1500) {
          if (now - p.lastTp > 500) { p.lastTp = now; send(p, { t: 'tp', p: [r2(p.x), r2(p.y), r2(p.z)] }); }
          return;
        }
        p.lastSt = now;
        p.x = pos[0]; p.y = pos[1]; p.z = pos[2];
        if (Number.isFinite(msg.ry)) p.ry = msg.ry;
        if (Number.isFinite(msg.rx)) p.rx = clamp(msg.rx, -1.6, 1.6);
        p.crouch = msg.c ? 1 : 0;
        p.moving = msg.m ? 1 : 0;
        if (msg.w === 3 || msg.w === WEAPON_INDEX[p.primary]) p.w = msg.w;
        break;
      }
      case 'fire': {
        if (!p.alive || phase !== 'playing') return;
        const key = C.WEAPON_KEYS[msg.w];
        if (!key || (key !== p.primary && key !== 'pistol')) return;
        const W = C.weaponStats(key, p.att[key]);
        if (now - (p.lastFire[key] || 0) < W.interval * 0.75) return;
        p.lastFire[key] = now;
        const eye = eyeOf(p);
        let o = vec3(msg.o);
        if (!o || dist3(o, eye) > 2.5) o = eye;
        const ends = Array.isArray(msg.e) ? msg.e.slice(0, W.pellets).map(vec3).filter(Boolean).map((v) => v.map(r2)) : [];
        broadcast({ t: 'shot', id: p.id, w: msg.w, e: ends.length === 1 ? ends[0] : ends, s: W.suppressed ? 1 : 0 }, p);
        if (!Array.isArray(msg.hits)) return;
        const tally = new Map();
        for (const h of msg.hits.slice(0, W.pellets)) {
          if (!Array.isArray(h)) continue;
          const target = players.get(h[0] | 0);
          if (!target || !target.alive || target.team === p.team) continue;
          const dist = Math.hypot(target.x - p.x, target.y - p.y, target.z - p.z);
          if (dist > W.range + 4) continue;
          if (!tally.has(target)) tally.set(target, visibleTarget(o, target) ? { dmg: 0, head: false } : null);
          const t = tally.get(target);
          if (!t) continue;
          let dmg = W.dmg * (h[1] ? W.head : 1);
          if (dist > W.falloff[0]) dmg *= W.falloff[1];
          t.dmg += dmg;
          if (h[1]) t.head = true;
        }
        for (const [target, t] of tally) if (t && t.dmg > 0) applyDamage(target, p, t.dmg, key, t.head);
        break;
      }
      case 'nade': {
        if (!p.alive || p.nades <= 0 || phase !== 'playing') return;
        const eye = eyeOf(p);
        let o = vec3(msg.o);
        if (!o || dist3(o, eye) > 2.5) o = eye;
        let v = vec3(msg.v) || [0, 0, 0];
        const sp = Math.hypot(...v);
        if (sp > 28) v = v.map((c) => (c * 28) / sp);
        p.nades--;
        nades.push({ id: nextNadeId++, owner: p.id, team: p.team, x: o[0], y: o[1], z: o[2], vx: v[0], vy: v[1], vz: v[2], at: now + C.NADE.fuse });
        break;
      }
      case 'chat': {
        if (now - p.lastChat < 600) return;
        const m = String(msg.m || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
        if (!m) return;
        p.lastChat = now;
        broadcast({ t: 'chat', id: p.id, m, tm: msg.tm ? 1 : 0 });
        break;
      }
      case 'loadout':
        if (C.PRIMARIES.includes(msg.primary)) p.nextPrimary = msg.primary;
        if (msg.att) p.nextAtt = cleanAllAtt(msg.att);
        break;
      case 'team': {
        const team = msg.team === 1 || msg.team === 2 ? msg.team : 0;
        if (!team || team === p.team) return;
        p.team = team;
        if (p.alive) { p.alive = false; p.respawnAt = now + 1500; broadcast({ t: 'kill', k: p.id, v: p.id, w: -1, h: 0 }); }
        balanceBots();
        break;
      }
      case 'ping':
        send(p, { t: 'pong', c: msg.c });
        break;
    }
  }

  wss.on('connection', (ws) => {
    let p = null;
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      if (!p) { if (msg.t === 'join') p = handleJoin(ws, msg); return; }
      handleMessage(p, msg);
    });
    ws.on('close', () => {
      if (!p) return;
      players.delete(p.id);
      for (const b of players.values()) if (b.ai && (b.ai.target === p || b.ai.alertBy === p)) { b.ai.target = null; b.ai.alertBy = null; }
      broadcast({ t: 'left', id: p.id });
      broadcast({ t: 'chat', id: 0, m: `${p.name} left` });
      log(`${p.name} left`);
      balanceBots();
    });
  });

  // ---------- Loops ----------
  let last = Date.now();
  const tickTimer = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (phase === 'playing') {
      if (now >= matchEndsAt) endMatch();
      let anyHuman = false;
      for (const p of players.values()) if (!p.bot) { anyHuman = true; break; }
      for (const p of players.values()) {
        if (!p.alive && now >= p.respawnAt && (p.ws || (p.bot && anyHuman))) spawn(p);
        if (p.alive && p.hp < C.PLAYER.maxHp && now - p.lastDamage > 4500) p.hp = Math.min(C.PLAYER.maxHp, p.hp + 30 * dt);
        if (p.bot && p.alive && anyHuman) updateBot(p, dt, now);
      }
      updateNades(dt, now);
    } else if (now >= resetAt) resetMatch();
  }, 1000 / 30);

  const snapTimer = setInterval(() => {
    if (!players.size) return;
    const now = Date.now();
    const ps = [];
    for (const p of players.values()) {
      ps.push([p.id, r2(p.x), r2(p.y), r2(p.z), r2(p.ry), r2(p.rx), p.crouch, p.w, p.alive ? 1 : 0, Math.ceil(p.hp), p.moving]);
    }
    broadcast({
      t: 'snap', ps, g: nades.map((n) => [n.id, r2(n.x), r2(n.y), r2(n.z)]),
      tl: phase === 'playing' ? Math.max(0, matchEndsAt - now) : 0, sc: [score[1], score[2]], ph: phase,
    });
  }, 50);

  function close() {
    clearInterval(tickTimer); clearInterval(snapTimer);
    for (const c of wss.clients) c.terminate();
    wss.close(); httpServer.close();
  }

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      const actual = httpServer.address().port;
      log(`listening on port ${actual} (bots: ${botFill})`);
      resolve({
        port: actual, close, info,
        setBots(n) { botFill = Math.max(0, Math.min(14, n | 0)); balanceBots(); },
        newMatch() { nades.length = 0; resetMatch(); },
      });
    });
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

module.exports = { startServer, lanAddresses };

if (require.main === module) {
  const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
  const port = parseInt(arg('--port', process.env.PORT || 3000), 10);
  const bots = parseInt(arg('--bots', process.env.BOTS || 8), 10);
  startServer({ port, bots }).then(({ port: p }) => {
    console.log(`\n  The Strait! dedicated server`);
    console.log(`  Local:   http://localhost:${p}`);
    for (const ip of lanAddresses()) console.log(`  Network: http://${ip}:${p}`);
    console.log('');
  });
}
