// Shared between server (Node) and client (browser): map, weapons, attachments, collision helpers.
(function (root) {
  'use strict';
  const C = {};

  C.GAME_NAME = 'The Strait!';
  C.VERSION = 'Beta 0.0.1';

  C.TEAMS = {
    1: { name: 'U.S. Marines', short: 'MARINES', color: '#5fb0ff' },
    2: { name: 'Iranian Forces', short: 'IRAN', color: '#ff6a55' },
  };

  C.MATCH = { scoreLimit: 75, timeLimit: 10 * 60 * 1000, respawnDelay: 4000, endPause: 12000 };

  C.PLAYER = {
    radius: 0.4, height: 1.8, crouchHeight: 1.25, eye: 1.62, crouchEye: 1.12,
    walk: 5.0, sprint: 7.4, crouchSpeed: 2.5, jump: 6.6, gravity: 20, step: 0.6, maxHp: 100, nades: 2,
  };

  // order matters: index is used on the wire
  C.WEAPON_KEYS = ['rifle', 'shotgun', 'sniper', 'pistol'];
  C.WEAPONS = {
    rifle: {
      label: 'Assault Rifle', names: { 1: 'M4A1', 2: 'KL-7.62' },
      dmg: 30, head: 1.8, interval: 100, auto: true, mag: 30, reserve: 150, reload: 2.2,
      spread: 0.028, adsSpread: 0.003, moveSpread: 0.03, bloom: 0.006, range: 180,
      falloff: [45, 0.75], recoil: 0.011, pellets: 1, adsFov: 52, adsSpeed: 1,
      allow: { optic: ['none', 'reddot', 'holo', 'acog'], muzzle: ['none', 'suppressor', 'compensator'], under: ['none', 'grip', 'laser'], mag: ['none', 'extended'] },
    },
    shotgun: {
      label: 'Shotgun', names: { 1: 'M1014', 2: 'Saiga-12' },
      dmg: 15, head: 1.4, interval: 700, auto: false, mag: 7, reserve: 35, reload: 2.8,
      spread: 0.075, adsSpread: 0.055, moveSpread: 0.01, bloom: 0, range: 35,
      falloff: [12, 0.55], recoil: 0.05, pellets: 9, adsFov: 60, adsSpeed: 1,
      allow: { optic: ['none', 'reddot', 'holo'], muzzle: ['none', 'suppressor'], under: ['none', 'grip', 'laser'], mag: ['none', 'extended'] },
    },
    sniper: {
      label: 'Sniper Rifle', names: { 1: 'M24', 2: 'Nakhjir' },
      dmg: 95, head: 2.5, interval: 1300, auto: false, mag: 5, reserve: 25, reload: 3.0,
      spread: 0.09, adsSpread: 0.0, moveSpread: 0.06, bloom: 0, range: 400,
      falloff: [400, 1], recoil: 0.06, pellets: 1, adsFov: 16, adsSpeed: 0.7, scope: 'sniper',
      allow: { optic: ['none'], muzzle: ['none', 'suppressor'], under: ['none'], mag: ['none', 'extended'] },
    },
    pistol: {
      label: 'Pistol', names: { 1: 'M18', 2: 'ZOAF PC-9' },
      dmg: 28, head: 2.0, interval: 150, auto: false, mag: 12, reserve: 60, reload: 1.6,
      spread: 0.018, adsSpread: 0.006, moveSpread: 0.015, bloom: 0.008, range: 80,
      falloff: [25, 0.7], recoil: 0.02, pellets: 1, adsFov: 62, adsSpeed: 1.25,
      allow: { optic: ['none', 'reddot'], muzzle: ['none', 'suppressor', 'compensator'], under: ['none', 'laser'], mag: ['none', 'extended'] },
    },
  };
  C.PRIMARIES = ['rifle', 'shotgun', 'sniper'];
  C.NADE = { fuse: 2600, radius: 7.5, dmg: 140, gravity: 20 };

  // ---------- Ballistics ----------
  // Muzzle velocity (m/s) and penetration power per weapon. Bullets fly with real drop.
  C.BULLET_GRAVITY = 9.8;
  Object.assign(C.WEAPONS.rifle, { velocity: 880, pen: 1.0 });
  Object.assign(C.WEAPONS.shotgun, { velocity: 420, pen: 0.25 });
  Object.assign(C.WEAPONS.sniper, { velocity: 820, pen: 1.8 });
  Object.assign(C.WEAPONS.pistol, { velocity: 370, pen: 0.45 });
  C.LEAN = { head: 0.34, angle: 0.5 };

  // What it costs a bullet to pass through each material (Infinity = stops every round).
  const SOLID = Infinity;
  C.PEN_COST = {
    wood: 0.3, cloth1: 0.05, cloth2: 0.05, cloth3: 0.05, cloth4: 0.05, palm: 0.35,
    corrugated: 0.45, roofmetal: 0.45, cont_red: 0.55, cont_blue: 0.55, cont_green: 0.55, cont_orange: 0.55, cont_gray: 0.55,
    rust: 0.6, burnt: 0.6, truck: 0.6, tire: 0.5, drum: 0.4, drumred: 0.4, metal: 0.75, humvee: 0.95, tank: 1.2,
    plaster: 1.0, mud: 1.2, mud2: 1.2, roof: 1.1, crane: 1.6,
    stone: SOLID, concrete: SOLID, hesco: SOLID, sandbag: SOLID, perimeter: SOLID,
  };
  C.penCost = (mat) => (mat in C.PEN_COST ? C.PEN_COST[mat] : SOLID);

  // Learnable recoil: shot i of a burst kicks by [pitch, yaw] multipliers that are the same every time.
  C.recoilAt = function (key, i) {
    const seed = { rifle: 1.3, shotgun: 0.4, sniper: 2.1, pistol: 0.9 }[key] || 1;
    const pitch = 1 + 0.12 * Math.sin(i * 1.7 + seed);
    const drift = i < 7 ? 0.35 : Math.sin((i - 7) * 0.45 + seed) * 0.8;
    return [pitch, drift + 0.15 * Math.sin(i * 2.3 + seed * 3)];
  };

  // ---------- Attachments ----------
  C.SLOTS = ['optic', 'muzzle', 'under', 'mag'];
  C.SLOT_LABELS = { optic: 'Optic', muzzle: 'Muzzle', under: 'Underbarrel', mag: 'Magazine' };
  C.ATTACH = {
    optic: {
      none: { label: 'Iron sights', info: 'Clear view, no zoom' },
      reddot: { label: 'Red dot', info: 'Fast, precise dot reticle' },
      holo: { label: 'Holographic', info: 'Ring reticle, wide view' },
      acog: { label: '4x ACOG', info: '4x zoom, slower to aim' },
    },
    muzzle: {
      none: { label: 'None', info: '' },
      suppressor: { label: 'Suppressor', info: 'Quiet, hidden from minimap, less range' },
      compensator: { label: 'Compensator', info: '−28% recoil, bigger flash' },
    },
    under: {
      none: { label: 'None', info: '' },
      grip: { label: 'Vertical grip', info: '−15% recoil, steadier hip fire' },
      laser: { label: 'Laser', info: '−35% hip-fire spread' },
    },
    mag: {
      none: { label: 'Standard', info: '' },
      extended: { label: 'Extended mag', info: '+50% ammo, slower reload' },
    },
  };
  C.DEFAULT_ATT = {
    rifle: { optic: 'reddot', muzzle: 'none', under: 'grip', mag: 'none' },
    shotgun: { optic: 'none', muzzle: 'none', under: 'laser', mag: 'none' },
    sniper: { optic: 'none', muzzle: 'none', under: 'none', mag: 'none' },
    pistol: { optic: 'none', muzzle: 'none', under: 'none', mag: 'none' },
  };

  // Returns a valid attachment set for a weapon (anything unknown or not allowed becomes 'none').
  C.cleanAtt = function (key, att) {
    const W = C.WEAPONS[key], out = {};
    for (const s of C.SLOTS) {
      const v = att && typeof att[s] === 'string' ? att[s] : 'none';
      out[s] = W && W.allow[s].includes(v) ? v : 'none';
    }
    return out;
  };

  // Weapon stats after attachments. Used by both the client (feel, ammo) and server (damage range).
  C.weaponStats = function (key, att) {
    const base = C.WEAPONS[key];
    const a = C.cleanAtt(key, att);
    const W = Object.assign({}, base, { falloff: base.falloff.slice(), att: a });
    if (a.muzzle === 'suppressor') { W.falloff[0] *= 0.75; W.range *= 0.9; W.recoil *= 0.92; W.suppressed = true; }
    if (a.muzzle === 'compensator') { W.recoil *= 0.72; W.bloom *= 0.8; W.bigFlash = true; }
    if (a.under === 'grip') { W.recoil *= 0.85; W.spread *= 0.9; W.adsSpeed *= 0.95; }
    if (a.under === 'laser') { W.spread *= 0.65; W.moveSpread *= 0.8; }
    if (a.mag === 'extended') { W.mag = Math.round(W.mag * 1.5); W.reserve = Math.round(W.reserve * 1.3); W.reload *= 1.15; }
    if (a.optic === 'reddot' || a.optic === 'holo') W.adsFov *= 0.94;
    if (a.optic === 'acog') { W.adsFov = 20; W.adsSpeed *= 0.75; W.scope = 'acog'; }
    return W;
  };

  // ---------- Geometry helpers ----------

  // Slab test. Returns distance along d (unit) to entry, 0 if inside, or -1 on miss.
  C.rayBox = function (o, d, min, max) {
    let tmin = 0, tmax = Infinity;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-9) {
        if (o[i] < min[i] || o[i] > max[i]) return -1;
      } else {
        const inv = 1 / d[i];
        let t1 = (min[i] - o[i]) * inv, t2 = (max[i] - o[i]) * inv;
        if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return -1;
      }
    }
    return tmin;
  };

  // Nearest map hit along ray, or -1. Ignores decoration and bullet-transparent boxes (the sea).
  C.rayMap = function (o, d, maxDist) {
    let best = -1;
    const solids = C.MAP.solids;
    for (let i = 0; i < solids.length; i++) {
      const b = solids[i];
      if (b.nobullet) continue;
      const t = C.rayBox(o, d, b.min, b.max);
      if (t >= 0 && t <= maxDist && (best < 0 || t < best)) best = t;
    }
    return best;
  };

  C.canSee = function (a, b) {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const dist = Math.hypot(d[0], d[1], d[2]);
    if (dist < 0.01) return true;
    d[0] /= dist; d[1] /= dist; d[2] /= dist;
    const t = C.rayMap(a, d, dist);
    return t < 0 || t >= dist - 0.25;
  };

  // Leaning moves the head sideways (along the player's right vector) but not the body.
  C.leanOffset = function (lean, ry) {
    const o = (lean || 0) * C.LEAN.head;
    return [Math.cos(ry || 0) * o, -Math.sin(ry || 0) * o];
  };

  C.hitboxes = function (x, y, z, crouch, lean, ry) {
    const h = crouch ? C.PLAYER.crouchHeight : C.PLAYER.height;
    const [lx, lz] = C.leanOffset(lean, ry);
    const hy = y + h - 0.38 - Math.abs(lean || 0) * 0.06;
    return {
      body: { min: [x - 0.36, y, z - 0.36], max: [x + 0.36, y + h - 0.38, z + 0.36] },
      head: { min: [x + lx - 0.2, hy, z + lz - 0.2], max: [x + lx + 0.2, hy + 0.4, z + lz + 0.2] },
    };
  };

  // Entry and exit distance of a ray through a box, or null.
  C.rayBoxRange = function (o, d, min, max) {
    let tmin = -Infinity, tmax = Infinity;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-9) {
        if (o[i] < min[i] || o[i] > max[i]) return null;
      } else {
        const inv = 1 / d[i];
        let t1 = (min[i] - o[i]) * inv, t2 = (max[i] - o[i]) * inv;
        if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return null;
      }
    }
    if (tmax < 0) return null;
    return [Math.max(0, tmin), tmax];
  };

  // Straight bullet path through the map with penetration.
  // Returns where it stopped (or maxDist), the damage multiplier left, power left and the boxes it passed.
  C.penTrace = function (o, d, maxDist, power) {
    const hits = [];
    const solids = C.MAP.solids;
    for (let i = 0; i < solids.length; i++) {
      const b = solids[i];
      if (b.nobullet) continue;
      const r = C.rayBoxRange(o, d, b.min, b.max);
      if (r && r[0] <= maxDist) hits.push([r[0], r[1], b]);
    }
    hits.sort((a, b) => a[0] - b[0]);
    let mult = 1, left = power, reach = 0;
    const passed = [];
    for (const [tin, tout, b] of hits) {
      if (tout <= reach) continue; // already inside an overlapping box we paid for
      const cost = C.penCost(b.mat);
      if (cost > left) return { stop: Math.max(tin, reach), mult, power: left, passed, box: b };
      left -= cost;
      mult *= Math.max(0.25, 1 - cost * 0.5);
      reach = tout;
      passed.push({ tin, tout, box: b });
    }
    return { stop: maxDist, mult, power: left, passed, box: null };
  };

  // Does an upright cylinder-ish AABB overlap any solid box?
  C.overlapsMap = function (x, y, z, r, h) {
    const solids = C.MAP.solids;
    for (let i = 0; i < solids.length; i++) {
      const b = solids[i];
      if (x + r > b.min[0] && x - r < b.max[0] && z + r > b.min[2] && z - r < b.max[2] &&
          y + h > b.min[1] && y < b.max[1]) return b;
    }
    return null;
  };

  // ---------- Map: "Hormuz Port" ----------
  // X runs west->east, Z runs north(-) -> south(+). The sea is east of the quay at x=60.
  // Iranian Forces spawn north, U.S. Marines spawn south. Both halves are mirrored for fairness.
  function buildMap() {
    const boxes = [];
    const palms = [];
    const tanks = [];
    const decoProps = []; // small models with no collision (jerry cans, ammo boxes)
    const box = (x, z, w, d, h, mat, y, extra) => {
      const b = { min: [x - w / 2, y || 0, z - d / 2], max: [x + w / 2, (y || 0) + h, z + d / 2], mat };
      if (extra) Object.assign(b, extra);
      boxes.push(b);
      return b;
    };

    const T = 0.4;

    // Decorative window frames (no collision); a second row on tall buildings.
    function windowAt(cx, cz, alongX, h) {
      for (const y of h > 5 ? [1.3, 4.3] : [1.3]) {
        box(cx, cz, alongX ? 1.0 : T + 0.08, alongX ? T + 0.08 : 1.0, 1.1, 'window', y, { deco: true });
      }
    }

    function wall(cx, cz, len, alongX, h, mat, door, dw, dh) {
      const w = alongX ? len : T, d = alongX ? T : len;
      const at = (off) => (alongX ? [cx + off, cz] : [cx, cz + off]);
      if (!door) {
        box(cx, cz, w, d, h, mat);
        const n = Math.floor((len - 1) / 3.2);
        for (let k = 0; k < n; k++) windowAt(...at((k - (n - 1) / 2) * 3.2), alongX, h);
        return;
      }
      const seg = (len - dw) / 2, off = dw / 2 + seg / 2;
      if (seg >= 2.6) { windowAt(...at(-off), alongX, h); windowAt(...at(off), alongX, h); }
      if (alongX) {
        box(cx - off, cz, seg, T, h, mat);
        box(cx + off, cz, seg, T, h, mat);
        box(cx, cz, dw, T, h - dh, mat, dh);
      } else {
        box(cx, cz - off, T, seg, h, mat);
        box(cx, cz + off, T, seg, h, mat);
        box(cx, cz, T, dw, h - dh, mat, dh);
      }
    }

    // Solid steps stacked from the ground. dir is the climbing direction.
    function stairs(x0, z0, dx, dz, n, rise, run, width, mat) {
      for (let i = 0; i < n; i++) {
        const c = i * run + run / 2;
        const x = x0 + dx * c, z = z0 + dz * c;
        box(x, z, dx ? run : width, dx ? width : run, (i + 1) * rise, mat);
      }
    }

    // Hollow single-room building with doors, flat roof, parapet and outside stairs to the roof.
    function building(x, z, w, d, h, doors, stairSide, mat, opts) {
      mat = mat || 'mud';
      const o = Object.assign({ dw: 1.7, dh: 2.4, roof: 'roof' }, opts);
      wall(x, z - d / 2 + T / 2, w, true, h, mat, doors.includes('n'), o.dw, o.dh);
      wall(x, z + d / 2 - T / 2, w, true, h, mat, doors.includes('s'), o.dw, o.dh);
      wall(x - w / 2 + T / 2, z, d - 2 * T, false, h, mat, doors.includes('w'), o.dw, o.dh);
      wall(x + w / 2 - T / 2, z, d - 2 * T, false, h, mat, doors.includes('e'), o.dw, o.dh);
      const roofTop = h + 0.3;
      box(x, z, w, d, 0.3, o.roof, h);
      const ph = 0.9, pt = 0.3, py = roofTop;
      if (stairSide !== 'n') box(x, z - d / 2 + pt / 2, w, pt, ph, mat, py);
      if (stairSide !== 's') box(x, z + d / 2 - pt / 2, w, pt, ph, mat, py);
      if (stairSide !== 'w') box(x - w / 2 + pt / 2, z, pt, d - 2 * pt, ph, mat, py);
      if (stairSide !== 'e') box(x + w / 2 - pt / 2, z, pt, d - 2 * pt, ph, mat, py);
      if (!stairSide) return roofTop;
      const n = Math.ceil(roofTop / 0.5), rise = roofTop / n, sw = 1.4;
      const len = stairSide === 'n' || stairSide === 's' ? w : d;
      const run = Math.min(0.62, (len - 0.6) / n);
      if (stairSide === 'e') stairs(x + w / 2 + sw / 2, z + d / 2, 0, -1, n, rise, run, sw, 'stone');
      if (stairSide === 'w') stairs(x - w / 2 - sw / 2, z - d / 2, 0, 1, n, rise, run, sw, 'stone');
      if (stairSide === 'n') stairs(x - w / 2, z - d / 2 - sw / 2, 1, 0, n, rise, run, sw, 'stone');
      if (stairSide === 's') stairs(x + w / 2, z + d / 2 + sw / 2, -1, 0, n, rise, run, sw, 'stone');
      return roofTop;
    }

    // Persian wind tower (badgir) standing on a roof.
    function windTower(x, z, y) {
      box(x, z, 2.2, 2.2, 3.4, 'plaster', y);
      for (const k of [-0.6, 0, 0.6]) {
        box(x + k, z - 1.12, 0.3, 0.06, 1.4, 'window', y + 1.6, { deco: true });
        box(x + k, z + 1.12, 0.3, 0.06, 1.4, 'window', y + 1.6, { deco: true });
        box(x - 1.12, z + k, 0.06, 0.3, 1.4, 'window', y + 1.6, { deco: true });
        box(x + 1.12, z + k, 0.06, 0.3, 1.4, 'window', y + 1.6, { deco: true });
      }
      box(x, z, 2.5, 2.5, 0.25, 'roof', y + 3.4);
    }

    function car(x, z, alongX, mat) {
      const L = 4.4, W = 1.9;
      box(x, z, alongX ? L : W, alongX ? W : L, 0.95, mat, 0.3);
      const cabOff = 0.3;
      box(alongX ? x - cabOff : x, alongX ? z : z - cabOff, alongX ? 2.3 : 1.7, alongX ? 1.7 : 2.3, 0.7, mat, 1.25);
      box(x, z, alongX ? L - 0.6 : W - 0.1, alongX ? W - 0.1 : L - 0.6, 0.3, 'tire', 0);
    }
    function humvee(x, z, alongX) {
      const L = 4.8, W = 2.2;
      box(x, z, alongX ? L : W, alongX ? W : L, 1.1, 'humvee', 0.45);
      box(x, z, alongX ? 2.6 : 2.0, alongX ? 2.0 : 2.6, 0.75, 'humvee', 1.55);
      box(x, z, 0.6, 0.6, 0.5, 'metal', 2.3); // turret
      box(x, z, alongX ? L - 0.8 : W, alongX ? W : L - 0.8, 0.45, 'tire', 0);
    }
    function crate(x, z, s, h, y) { box(x, z, s, s, h || s, 'wood', y, { prop: 'crate' }); }
    function barrels(x, z, n, mat) {
      for (let i = 0; i < n; i++) box(x + (i % 2) * 0.75, z + Math.floor(i / 2) * 0.75, 0.62, 0.62, 1.0, mat || 'drum', 0, { prop: mat === 'drumred' ? 'barrel_red' : 'barrel_blue', rot: i * 1.3 });
    }
    // concrete jersey barrier (2 m long)
    function barrier(x, z, alongX) { box(x, z, alongX ? 2.0 : 0.62, alongX ? 0.62 : 2.0, 1.05, 'barrier', 0, { prop: 'barrier', rot: alongX ? 0 : Math.PI / 2 }); }
    function sandbags(x, z, len, alongX) { box(x, z, alongX ? len : 1.0, alongX ? 1.0 : len, 1.1, 'sandbag'); }
    function hesco(x, z, len, alongX, h) { box(x, z, alongX ? len : 1.3, alongX ? 1.3 : len, h || 2.2, 'hesco'); }
    function twall(x, z, len, alongX) { box(x, z, alongX ? len : 0.6, alongX ? 0.6 : len, 3.6, 'concrete'); }
    function stall(x, z, cloth) {
      box(x, z, 2.6, 1.0, 1.0, 'wood');
      box(x, z + 0.5, 3.2, 2.6, 0.08, cloth, 2.45, { thin: true });
      box(x - 1.5, z + 1.7, 0.12, 0.12, 2.45, 'wood', 0, { deco: true });
      box(x + 1.5, z + 1.7, 0.12, 0.12, 2.45, 'wood', 0, { deco: true });
    }
    function palm(x, z, h) {
      palms.push({ x, z, h });
      box(x, z, 0.45, 0.45, h, 'palm', 0, { deco: true, trunk: true });
      box(x, z, 0.5, 0.5, h, 'palm', 0, { hidden: true }); // collision only
    }
    function guardTower(x, z) {
      const s = 3.2, h = 4.2;
      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(x + ox * (s / 2 - 0.15), z + oz * (s / 2 - 0.15), 0.3, 0.3, h, 'wood');
      box(x, z, s, s, 0.25, 'wood', h);
      box(x, z - s / 2 + 0.15, s, 0.3, 1.1, 'sandbag', h + 0.25);
      box(x - s / 2 + 0.15, z + 0.3, 0.3, s - 0.6, 1.1, 'sandbag', h + 0.25);
      box(x + s / 2 - 0.15, z + 0.3, 0.3, s - 0.6, 1.1, 'sandbag', h + 0.25);
      box(x, z, s + 0.4, s + 0.4, 0.2, 'metal', h + 2.3, { thin: true });
      const n = 9, top = h + 0.25, rise = top / n;
      stairs(x - 0.6, z + s / 2 + 5.0, 0, -1, n, rise, 0.55, 1.2, 'wood');
    }
    // 20ft shipping container stack; mats is one material or one per level.
    function container(x, z, alongX, mats, levels) {
      for (let i = 0; i < levels; i++) {
        const m = Array.isArray(mats) ? mats[i % mats.length] : mats;
        box(x, z, alongX ? 6.1 : 2.44, alongX ? 2.44 : 6.1, 2.59, m, i * 2.59);
      }
    }
    // Ship-to-shore gantry crane straddling the quay. Only the legs collide.
    function crane(x0, x1, z0, z1) {
      const H = 16, zc = (z0 + z1) / 2;
      for (const x of [x0, x1]) for (const z of [z0, z1]) box(x, z, 0.8, 0.8, H, 'crane');
      for (const z of [z0, z1]) box((x0 + x1) / 2, z, x1 - x0 + 0.8, 0.9, 1.2, 'crane', H, { deco: true });
      for (const x of [x0, x1]) box(x, zc, 0.9, z1 - z0 + 0.8, 0.9, 'crane', H - 4, { deco: true });
      box((x0 + x1) / 2 + 4, zc, 46, 1.4, 1.2, 'crane', H + 1.2, { deco: true });
      box(x1 - 1, zc, 3.2, 2.8, 2.4, 'metal', H + 2.4, { deco: true });
      box(x0 - 14, zc, 4, 2.4, 2.0, 'concrete', H + 1.4, { deco: true }); // counterweight
    }
    function forklift(x, z, alongX) {
      box(x, z, alongX ? 2.2 : 1.2, alongX ? 1.2 : 2.2, 1.1, 'crane', 0.25);
      box(x + (alongX ? 1.2 : 0), z + (alongX ? 0 : 1.2), alongX ? 0.15 : 1.0, alongX ? 1.0 : 0.15, 2.5, 'metal');
      box(x - (alongX ? 0.3 : 0), z - (alongX ? 0 : 0.3), alongX ? 1.1 : 1.1, alongX ? 1.1 : 1.1, 0.08, 'metal', 2.3, { deco: true });
      box(x, z, alongX ? 1.8 : 1.3, alongX ? 1.3 : 1.8, 0.3, 'tire', 0);
    }
    function fuelTank(x, z, r, h) {
      tanks.push({ x, z, r, h });
      box(x, z, r * 1.8, r * 1.8, h, 'tank', 0, { hidden: true });
    }
    function boat(x, z, len, mat) {
      box(x, z, 3.4, len, 1.8, mat || 'hull', -1.2, { deco: true });
      box(x, z + len * 0.12, 2.4, len * 0.3, 1.6, 'plaster', 0.6, { deco: true });
      box(x, z + len * 0.12, 0.3, 0.3, 2.4, 'metal', 2.2, { deco: true });
    }

    // Perimeter on three sides; the east side is open water past the quay.
    const E = 78, QUAY = 60;
    box(-9, -E, 140, 2, 7, 'perimeter');
    box(-9, E, 140, 2, 7, 'perimeter');
    box(-E, 0, 2, 2 * E, 7, 'perimeter');
    box(QUAY - 0.3, 0, 0.6, 2 * E, 1.25, 'concrete', -1);   // quay edge
    box(QUAY + 10.3, 0, 20, 2 * E + 4, 12, 'sea', -2, { hidden: true, nobullet: true }); // keeps players out of the water
    for (let z = -70; z <= 70; z += 10) if (z !== 20 && z !== -20) box(QUAY - 0.8, z, 0.35, 0.35, 0.55, 'metal');

    // Central bazaar square
    box(0, 0, 3.2, 3.2, 1.0, 'stone');
    box(0, 0, 1.0, 1.0, 5.5, 'stone', 1.0);
    box(0, 0, 1.8, 1.8, 0.5, 'stone', 6.5);
    stall(-9, -9, 'cloth1'); stall(9, -9, 'cloth2'); stall(-9, 9, 'cloth3'); stall(9, 9, 'cloth4');
    stall(-13, 2, 'cloth2'); stall(13, -2, 'cloth1');
    crate(-5, 6, 1.1); crate(-4, 6.2, 0.9); crate(5.5, -6, 1.1); barrels(6, 4, 3); barrels(-7, -4, 2, 'drumred');
    palm(-15, -15, 7.5); palm(15, -15, 8); palm(-15, 15, 8); palm(15, 15, 7.5);

    // s=-1 north (Iran), s=+1 south (Marines)
    for (const s of [-1, 1]) {
      const Z = (z) => z * s;
      const side = (c) => (s === 1 ? c : ({ n: 's', s: 'n', e: 'e', w: 'w' })[c] || c);
      const sides = (arr) => arr.map(side);
      const B = (x, z, w, d, h, doors, st, mat, o) => building(x, Z(z), w, d, h, sides(doors), st ? side(st) : null, mat, o);

      // west: old town
      B(-20, 20, 10, 9, 3.6, ['s', 'e', 'n'], 'w', 'mud');
      const tall = B(-40, 16, 12, 10, 6.5, ['s', 'e'], 'e', 'plaster');
      windTower(-43, Z(19), tall);
      B(-61, 24, 9, 12, 3.6, ['e', 'n'], 'n', 'mud2');
      const hall = B(-24, 40, 14, 8, 4.0, ['n', 's', 'w'], 'e', 'plaster');
      windTower(-28.5, Z(41.5), hall);
      B(-50, 42, 10, 10, 3.6, ['e', 'n'], 's', 'mud');
      car(-3, Z(26), false, s === 1 ? 'rust' : 'burnt');
      car(3.5, Z(33), false, s === 1 ? 'burnt' : 'rust');
      car(-31, Z(5), true, 'rust');
      crate(-8, Z(30), 1.2); crate(-8.2, Z(31.3), 1.0, 2.0);
      crate(8, Z(20), 1.2);
      barrels(-46, Z(30), 4);
      box(-10, Z(48), 8, 0.5, 1.3, 'stone'); box(10, Z(48), 8, 0.5, 1.3, 'stone');
      box(-68, Z(40), 0.5, 10, 2.4, 'mud');
      box(-34, Z(30), 6, 0.5, 2.2, 'mud2');
      palm(-30, Z(10), 8); palm(-55, Z(8), 9); palm(-70, Z(55), 9);
      barrier(-6.2, Z(15), true); barrier(6.6, Z(14), true); barrier(-24, Z(3), false); barrier(24, Z(3), false);
      decoProps.push({ type: 'jerrycan', x: -7.1, z: Z(31.9), rot: 0.4 }, { type: 'jerrycan', x: 9.0, z: Z(21), rot: 2.1 },
        { type: 'ammo', x: -8.7, z: Z(28.9), rot: 1.2 }, { type: 'jerrycan', x: -45.2, z: Z(32), rot: 3.0 }, { type: 'ammo', x: 29.5, z: Z(26.4), rot: 0.2 });

      // east: the port
      B(26, 24, 18, 12, 7.0, ['w', 'e', 'n'], 's', 'corrugated', { dw: 3.4, dh: 3.6, roof: 'roofmetal' });
      crate(21, Z(22), 1.2); crate(22.3, Z(22), 1.2); crate(21.6, Z(22), 1.0, 1.0, 1.2);
      crate(30, Z(27), 1.2); crate(31.3, Z(27.2), 1.1);
      container(39, Z(12), false, ['cont_blue', 'cont_red'], 2);
      container(39, Z(19), false, 'cont_red', 1);
      container(42.6, Z(12), false, 'cont_orange', 1);
      container(42.6, Z(26), false, ['cont_green', 'cont_gray', 'cont_blue'], 3);
      container(39, Z(33), false, ['cont_gray', 'cont_orange'], 2);
      container(45, Z(40), true, 'cont_red', 1);
      container(50.5, Z(12), false, ['cont_green', 'cont_red'], 2);
      container(51, Z(28), false, 'cont_blue', 1);
      container(54.6, Z(28), false, ['cont_orange', 'cont_green'], 2);
      container(51, Z(44), false, 'cont_gray', 1);
      crane(52.5, 58.5, Z(17), Z(23));
      fuelTank(22, Z(48), 3.4, 7);
      fuelTank(31, Z(48), 3.4, 7);
      forklift(31, Z(6), true);
      forklift(47, Z(33), false);
      barrels(35, Z(42), 3, 'drumred');
      boat(66, Z(36), 16, s === 1 ? 'hull' : 'hullgray');
      palm(30, Z(10), 7.5);
    }

    // North: Iranian naval compound
    {
      const z0 = -64;
      box(-20, -55, 30, 0.6, 2.8, 'mud'); box(20, -55, 30, 0.6, 2.8, 'mud'); // gate gap at x=-5..5
      box(-35, -65, 0.6, 20, 2.8, 'mud'); box(35, -65, 0.6, 20, 2.8, 'mud');
      building(-20, z0 - 3, 10, 8, 3.6, ['s'], 'e', 'mud2');
      building(20, z0 - 3, 10, 8, 3.6, ['s'], 'w', 'mud2');
      car(0, -63, true, 'truck');
      box(0.6, -63, 0.5, 0.5, 1.0, 'metal', 1.25);
      barrels(-9, -60, 3, 'drumred'); crate(9, -59, 1.1); crate(10.2, -59, 1.1);
      sandbags(-6, -57.5, 2.0, true); sandbags(6, -57.5, 2.0, true);
      box(-50, -62, 8, 0.6, 2.0, 'mud2'); box(50, -62, 8, 0.6, 2.0, 'mud2');
      car(-62, -66, false, 'burnt'); car(55, -66, false, 'truck');
      decoProps.push({ type: 'jerrycan', x: 2.6, z: -61.6, rot: 0.8 }, { type: 'jerrycan', x: 3.1, z: -61.2, rot: 2.2 }, { type: 'ammo', x: -3.5, z: -58.4, rot: 1.0 });
    }

    // South: U.S. Marines FOB
    {
      hesco(-20, 55, 30, true); hesco(20, 55, 30, true);
      hesco(-35, 65, 20, false); hesco(35, 65, 20, false);
      building(-20, 67, 10, 8, 3.6, ['n'], 'e', 'concrete');
      building(20, 67, 10, 8, 3.6, ['n'], 'w', 'concrete');
      humvee(-7, 63, true); humvee(7, 66, true);
      twall(-10, 58.5, 4, true); twall(10, 58.5, 4, true);
      sandbags(0, 57.3, 4, true);
      guardTower(-29, 59.5); guardTower(29, 59.5);
      box(-50, 62, 8, 1.3, 2.2, 'hesco'); box(50, 62, 8, 1.3, 2.2, 'hesco');
      humvee(-62, 66, false); humvee(55, 66, false);
      decoProps.push({ type: 'ammo', x: 1.5, z: 58.6, rot: 0.3 }, { type: 'ammo', x: -1.2, z: 58.7, rot: 2.5 }, { type: 'jerrycan', x: -4.2, z: 62.4, rot: 1.6 });
    }

    // Town skyline beyond the wall (visual only), none over the water
    const skyline = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 80; i++) {
      const a = (i / 80) * Math.PI * 2 + rnd() * 0.05;
      const r = 95 + rnd() * 50;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (x > 30) continue;
      skyline.push({ x, z, w: 6 + rnd() * 14, d: 6 + rnd() * 14, h: 4 + rnd() * 12, dome: rnd() < 0.07 });
    }

    const south = [[-6, 70], [6, 70], [0, 74], [-12, 73], [12, 73], [-29.5, 70], [29.5, 70], [-3, 60], [3, 60], [-48, 70], [48, 70], [-14, 61]];
    const spawns = { 1: south.map(([x, z]) => [x, 0, z]), 2: south.map(([x, z]) => [x, 0, -z]) };

    const solids = boxes.filter((b) => !b.deco);
    return { boxes, solids, palms, tanks, decoProps, skyline, spawns, size: E, quay: QUAY };
  }

  C.MAP = buildMap();
  C.MAP.name = 'Hormuz Port';

  if (typeof module !== 'undefined' && module.exports) module.exports = C;
  else root.COMMON = C;
})(typeof window !== 'undefined' ? window : globalThis);
