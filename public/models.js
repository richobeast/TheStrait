// Procedural "high-quality" models: guns built from real side profiles, attachments, soldiers and first-person arms.
// Everything is generated in code (no asset files) and baked into a few draw calls per model.
import * as THREE from '/vendor/three/three.module.js';

// ---------- shared helpers ----------
export function mergeGeos(geos) {
  let vc = 0, ic = 0;
  for (const g of geos) { vc += g.attributes.position.count; ic += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), uv = new Float32Array(vc * 2), idx = new Uint32Array(ic);
  let vo = 0, io = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, vo * 2);
    const n = g.attributes.position.count;
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.array[i] + vo;
    else for (let i = 0; i < n; i++) idx[io++] = vo + i;
    vo += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

const matCache = new Map();
function std(hex, rough, metal, extra) {
  const key = `${hex}|${rough}|${metal}|${extra ? JSON.stringify(extra) : ''}`;
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial(Object.assign({ color: hex, roughness: rough, metalness: metal }, extra)));
  return matCache.get(key);
}
const M = {
  black: std(0x1d1e1f, 0.6, 0.3),
  metal: std(0x2a2c2f, 0.42, 0.7),
  steel: std(0x45484c, 0.35, 0.85),
  polymer: std(0x232323, 0.82, 0.05),
  fde: std(0x8e7854, 0.78, 0.05),
  od: std(0x4e5540, 0.8, 0.05),
  wood: std(0x6a3b1c, 0.55, 0.0),
  bakelite: std(0x6b2c12, 0.4, 0.05),
  glass: std(0x1a3550, 0.06, 0.6, { transparent: true, opacity: 0.5 }),
  red: new THREE.MeshBasicMaterial({ color: 0xff2a12 }),
  laser: new THREE.MeshBasicMaterial({ color: 0xff2020, transparent: true, opacity: 0.28, depthWrite: false }),
};

// A small parts list that bakes into one mesh per material.
class Parts {
  constructor() { this.list = []; this.keep = []; }
  add(geo, mat) { this.list.push([geo, mat]); return geo; }
  // Keeps a separately toggleable mesh (reticles, laser) instead of merging it.
  own(geo, mat) { const m = new THREE.Mesh(geo, mat); this.keep.push(m); return m; }
  bake(group, shadows = true) {
    const byMat = new Map();
    for (const [g, m] of this.list) { if (!byMat.has(m)) byMat.set(m, []); byMat.get(m).push(g); }
    for (const [m, geos] of byMat) {
      const mesh = new THREE.Mesh(mergeGeos(geos), m);
      mesh.castShadow = shadows && !m.transparent;
      mesh.receiveShadow = shadows;
      group.add(mesh);
    }
    for (const m of this.keep) group.add(m);
    return group;
  }
}

function shapeFrom(pts) {
  const s = new THREE.Shape();
  pts.forEach((p, i) => {
    if (i === 0) s.moveTo(p[0], p[1]);
    else if (p[0] === 'q') s.quadraticCurveTo(p[1], p[2], p[3], p[4]);
    else s.lineTo(p[0], p[1]);
  });
  return s;
}
// Side profile in (u forward, v up), extruded sideways and centred. Forward maps to -z.
function prof(pts, depth, bevel = 0.003, holes) {
  const sh = shapeFrom(pts);
  if (holes) for (const h of holes) { const p = new THREE.Path(); h.forEach((q, i) => (i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1]))); sh.holes.push(p); }
  const core = Math.max(0.001, depth - 2 * bevel);
  const g = new THREE.ExtrudeGeometry(sh, { depth: core, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 6 });
  g.translate(0, 0, -core / 2);
  g.rotateY(Math.PI / 2);
  return g;
}
// Cylinder along the barrel axis from u0 (radius r0) to u1 (radius r1).
function cyl(r0, r1, u0, u1, v, x = 0, seg = 14) {
  const g = new THREE.CylinderGeometry(r1, r0, u1 - u0, seg);
  g.rotateX(-Math.PI / 2);
  g.translate(x, v, -(u0 + u1) / 2);
  return g;
}
function vcyl(r, h, u, v, x = 0, seg = 12) { const g = new THREE.CylinderGeometry(r, r, h, seg); g.translate(x, v, -u); return g; }
function bx(w, h, len, u, v, x = 0) { const g = new THREE.BoxGeometry(w, h, len); g.translate(x, v, -u); return g; }
function disc(r, u, v, x = 0, back = false) { const g = new THREE.CircleGeometry(r, 18); if (back) g.rotateY(Math.PI); g.translate(x, v, -u); return g; }
function shift(pts, du, dv = 0) { return pts.map((p) => (p[0] === 'q' ? ['q', p[1] + du, p[2] + dv, p[3] + du, p[4] + dv] : [p[0] + du, p[1] + dv])); }
// Lengthen a magazine below its top edge (extended mags).
function stretch(pts, top, k, lean = 0.1) { return pts.map(([u, v]) => (v < top ? [u + (top - v) * (k - 1) * lean, top + (v - top) * k] : [u, v])); }

const ARGRIP = [[-0.035, -0.04], [-0.066, -0.04], [-0.1, -0.152], [-0.097, -0.16], [-0.068, -0.16], [-0.034, -0.058]];
function triggerGuard(u0) {
  return shift([[-0.045, -0.046], [0.016, -0.046], [0.016, -0.052], [0.008, -0.078], [-0.045, -0.078], [-0.045, -0.072], [0.003, -0.072], [0.009, -0.052], [-0.045, -0.052]], u0);
}

// ---------- gun bodies (each returns anchor points in gun space) ----------
function m4(P, a) {
  P.add(prof([[-0.13, -0.018], [0.125, -0.018], [0.125, 0.03], [0.112, 0.037], [-0.118, 0.037], [-0.13, 0.026]], 0.05), M.metal);
  P.add(bx(0.024, 0.01, 0.25, 0, 0.042), M.black);
  for (let i = 0; i < 12; i++) P.add(bx(0.026, 0.004, 0.006, -0.115 + i * 0.021, 0.048), M.black);
  P.add(prof([[-0.12, -0.018], [0.1, -0.018], [0.1, -0.032], [0.088, -0.052], [0.02, -0.052], [0.012, -0.045], [-0.045, -0.045], [-0.06, -0.036], [-0.11, -0.036], [-0.12, -0.026]], 0.046), M.metal);
  P.add(prof([[0.022, -0.04], [0.094, -0.04], [0.094, -0.076], [0.022, -0.076]], 0.05), M.metal);
  P.add(prof(ARGRIP, 0.032), M.polymer);
  P.add(prof(triggerGuard(0), 0.008, 0.001), M.metal);
  P.add(bx(0.006, 0.022, 0.006, -0.015, -0.058), M.black);
  P.add(cyl(0.016, 0.016, -0.3, -0.125, 0.008), M.metal);
  P.add(prof([[-0.215, 0.032], [-0.355, 0.032], [-0.372, 0.02], [-0.372, -0.088], [-0.352, -0.092], [-0.33, -0.062], [-0.25, -0.036], [-0.215, -0.02]], 0.046, 0.004), M.polymer);
  P.add(bx(0.03, 0.01, 0.028, -0.132, 0.03), M.black);
  P.add(bx(0.002, 0.016, 0.06, 0.02, 0.012, 0.026), M.black);
  P.add(cyl(0.008, 0.008, -0.075, -0.06, 0.016, 0.028, 10), M.metal); // forward assist
  // quad-rail handguard
  P.add(bx(0.056, 0.056, 0.255, 0.255, 0.008), M.black);
  P.add(bx(0.022, 0.01, 0.255, 0.255, 0.041), M.black);
  P.add(bx(0.01, 0.022, 0.24, 0.255, 0.008, 0.033), M.black);
  P.add(bx(0.01, 0.022, 0.24, 0.255, 0.008, -0.033), M.black);
  P.add(bx(0.022, 0.01, 0.24, 0.255, -0.025), M.black);
  P.add(cyl(0.0095, 0.0095, 0.38, 0.5, 0.006), M.metal);
  P.add(prof([[0.365, -0.01], [0.395, -0.01], [0.39, 0.058], [0.371, 0.058]], 0.014), M.black);
  P.add(bx(0.004, 0.02, 0.004, 0.381, 0.068), M.black);
  if (a.optic === 'none') P.add(prof([[-0.112, 0.046], [-0.084, 0.046], [-0.088, 0.077], [-0.108, 0.077]], 0.022), M.black);
  const mag = [[0.024, -0.07], [0.092, -0.07], [0.1, -0.13], [0.114, -0.19], [0.134, -0.24], [0.078, -0.255], [0.06, -0.2], [0.045, -0.14], [0.03, -0.1]];
  P.add(prof(a.mag === 'extended' ? stretch(mag, -0.075, 1.5) : mag, 0.026), M.fde);
  return { railU: -0.02, railV: 0.048, muzzleU: 0.5, muzzleV: 0.006, barrelR: 0.0095, defMuzzle: [0.011, 0.045, M.black],
    gripU: -0.07, gripV: -0.1, foreU: 0.27, foreV: -0.03, laserU: 0.31, laserV: 0.008, laserX: 0.046, ironY: 0.073, buttU: -0.372 };
}

function ak(P, a, saiga) {
  const furn = saiga ? M.polymer : M.wood;
  P.add(prof([[-0.17, -0.035], [0.135, -0.035], [0.135, 0.018], [0.12, 0.03], [-0.12, 0.03], ['q', -0.165, 0.03, -0.17, 0.012]], 0.044), M.metal);
  for (let i = 0; i < 6; i++) P.add(bx(0.046, 0.003, 0.004, -0.1 + i * 0.035, 0.031), M.metal);
  P.add(prof([[0.1, 0.02], [0.155, 0.02], [0.155, 0.036], [0.125, 0.046], [0.1, 0.036]], 0.03), M.metal);
  P.add(prof([[0.155, 0.016], [0.33, 0.016], [0.335, 0.032], [0.32, 0.042], [0.165, 0.046]], 0.036), furn);
  P.add(prof([[0.135, -0.036], [0.33, -0.03], [0.335, 0.014], [0.135, 0.014]], 0.05), furn);
  P.add(cyl(0.009, 0.009, 0.335, 0.4, 0.03), M.metal);
  P.add(bx(0.03, 0.045, 0.03, 0.41, 0.015), M.metal);
  const br = saiga ? 0.013 : 0.0095;
  P.add(cyl(br, br, 0.3, 0.55, -0.002), M.metal);
  P.add(prof([[0.48, -0.018], [0.51, -0.018], [0.505, 0.056], [0.485, 0.056]], 0.016), M.metal);
  P.add(bx(0.004, 0.016, 0.004, 0.495, 0.062), M.metal);
  P.add(prof([[-0.1, -0.03], [-0.132, -0.03], [-0.168, -0.135], [-0.142, -0.142], [-0.104, -0.046]], 0.032), saiga ? M.polymer : M.bakelite);
  P.add(prof(triggerGuard(-0.03), 0.008, 0.001), M.metal);
  P.add(bx(0.006, 0.022, 0.006, -0.05, -0.058), M.black);
  P.add(prof([[-0.165, 0.022], [-0.172, -0.03], [-0.43, -0.105], [-0.442, -0.1], [-0.442, 0.0], [-0.43, 0.008], [-0.21, 0.028]], 0.042), furn);
  P.add(bx(0.044, 0.1, 0.008, -0.446, -0.05), M.black);
  P.add(bx(0.003, 0.016, 0.09, -0.03, 0.01, 0.024), M.metal);
  if (a.optic !== 'none') P.add(bx(0.03, 0.022, 0.12, -0.03, 0.042), M.black);
  if (saiga) {
    const mag = [[0.0, -0.035], [0.09, -0.035], [0.1, -0.17], [0.012, -0.17]];
    P.add(prof(a.mag === 'extended' ? stretch(mag, -0.04, 1.5, 0.05) : mag, 0.05), M.polymer);
  } else {
    const mag = [[0.0, -0.035], [0.075, -0.035], [0.092, -0.1], [0.128, -0.17], [0.18, -0.235], [0.13, -0.262], [0.085, -0.2], [0.05, -0.13], [0.02, -0.075]];
    P.add(prof(a.mag === 'extended' ? stretch(mag, -0.04, 1.45) : mag, 0.026), M.bakelite);
  }
  return { railU: -0.03, railV: 0.053, muzzleU: 0.55, muzzleV: -0.002, barrelR: br, defMuzzle: [br + 0.003, 0.04, M.metal],
    gripU: -0.135, gripV: -0.085, foreU: 0.24, foreV: -0.034, laserU: 0.27, laserV: -0.005, laserX: 0.042, ironY: 0.052, buttU: -0.446 };
}

function benelli(P, a) {
  P.add(prof([[-0.12, -0.03], [0.13, -0.03], [0.13, 0.03], [-0.11, 0.036], [-0.12, 0.022]], 0.05), M.black);
  P.add(bx(0.022, 0.01, 0.2, 0.0, 0.041), M.black);
  P.add(cyl(0.0115, 0.0115, 0.13, 0.56, 0.012), M.metal);
  P.add(cyl(0.012, 0.012, 0.13, 0.46, -0.017), M.black);
  P.add(bx(0.03, 0.05, 0.02, 0.44, 0.0), M.black);
  P.add(prof([[0.13, -0.042], [0.33, -0.042], [0.335, 0.022], [0.13, 0.027]], 0.058), M.polymer);
  P.add(prof(shift(ARGRIP, -0.02), 0.032), M.polymer);
  P.add(prof(triggerGuard(-0.02), 0.008, 0.001), M.black);
  P.add(cyl(0.016, 0.016, -0.3, -0.12, 0.008), M.black);
  P.add(prof([[-0.215, 0.032], [-0.355, 0.032], [-0.372, 0.02], [-0.372, -0.088], [-0.352, -0.092], [-0.33, -0.062], [-0.25, -0.036], [-0.215, -0.02]], 0.05, 0.004), M.polymer);
  if (a.optic === 'none') P.add(prof([[-0.09, 0.044], [-0.06, 0.044], [-0.064, 0.07], [-0.086, 0.07]], 0.024), M.black);
  P.add(bx(0.004, 0.018, 0.004, 0.55, 0.03), M.steel);
  const ext = a.mag === 'extended';
  if (ext) P.add(cyl(0.012, 0.012, 0.46, 0.53, -0.017), M.black);
  return { railU: -0.02, railV: 0.046, muzzleU: 0.56, muzzleV: 0.012, barrelR: 0.0115, defMuzzle: null,
    gripU: -0.09, gripV: -0.1, foreU: 0.24, foreV: -0.042, laserU: 0.27, laserV: 0.0, laserX: 0.045, ironY: 0.064, buttU: -0.372 };
}

function m24(P, a) {
  const stock = M.od;
  P.add(prof([[-0.5, 0.025], [-0.5, -0.11], [-0.47, -0.12], [-0.3, -0.065], [-0.21, -0.065], [-0.19, -0.135], [-0.15, -0.14], [-0.13, -0.05], [0.33, -0.04], [0.34, -0.012], [0.34, 0.008], [-0.1, 0.008], [-0.2, 0.03], [-0.45, 0.035]], 0.055, 0.005), stock);
  P.add(cyl(0.019, 0.019, -0.12, 0.12, 0.022), M.metal);
  P.add(cyl(0.006, 0.006, -0.07, -0.068, 0.02, 0.0), M.metal);
  P.add(bx(0.05, 0.006, 0.006, -0.07, 0.02, 0.028), M.steel);
  const knob = new THREE.SphereGeometry(0.011, 10, 8); knob.translate(0.055, 0.016, 0.07); P.add(knob, M.black);
  P.add(cyl(0.013, 0.009, 0.12, 0.66, 0.022), M.metal);
  P.add(prof(triggerGuard(-0.12), 0.008, 0.001), M.black);
  if (a.mag === 'extended') P.add(prof([[-0.03, -0.04], [0.06, -0.04], [0.065, -0.1], [-0.025, -0.1]], 0.03), M.black);
  // scope
  P.add(cyl(0.022, 0.022, -0.16, -0.1, 0.09), M.black);
  P.add(cyl(0.014, 0.014, -0.1, 0.07, 0.09), M.black);
  P.add(vcyl(0.012, 0.03, -0.01, 0.112), M.black);
  P.add(cyl(0.012, 0.012, 0.0, 0.03, 0.09, 0.022), M.black);
  P.add(cyl(0.014, 0.028, 0.07, 0.12, 0.09), M.black);
  P.add(cyl(0.028, 0.028, 0.12, 0.2, 0.09), M.black);
  P.add(disc(0.026, 0.201, 0.09), M.glass);
  P.add(disc(0.02, -0.161, 0.09, 0, true), M.glass);
  for (const u of [-0.06, 0.05]) P.add(bx(0.034, 0.05, 0.018, u, 0.06), M.black);
  return { railU: 0, railV: 0.05, muzzleU: 0.66, muzzleV: 0.022, barrelR: 0.009, defMuzzle: null,
    gripU: -0.17, gripV: -0.095, foreU: 0.22, foreV: -0.04, laserU: 0.25, laserV: -0.01, laserX: 0.04, ironY: 0.09, buttU: -0.5 };
}

function dragunov(P, a) {
  P.add(prof([[-0.48, 0.03], [-0.48, -0.12], [-0.445, -0.128], [-0.21, -0.045], [-0.13, -0.045], [-0.13, 0.02], [-0.21, 0.036]], 0.04, 0.003,
    [[[-0.41, 0.0], [-0.25, 0.0], [-0.39, -0.07]]]), M.wood);
  P.add(prof([[-0.2, -0.045], [-0.135, -0.045], [-0.152, -0.13], [-0.19, -0.13]], 0.034), M.wood);
  P.add(prof([[-0.14, -0.032], [0.15, -0.032], [0.15, 0.02], [0.135, 0.03], [-0.12, 0.03], [-0.14, 0.015]], 0.042), M.metal);
  P.add(prof([[0.15, -0.035], [0.4, -0.03], [0.4, 0.034], [0.15, 0.04]], 0.05), M.wood);
  for (let i = 0; i < 5; i++) P.add(bx(0.052, 0.008, 0.024, 0.19 + i * 0.045, 0.012), M.black);
  P.add(cyl(0.009, 0.009, 0.4, 0.72, 0.004), M.metal);
  P.add(cyl(0.011, 0.011, 0.72, 0.79, 0.004), M.metal);
  P.add(prof(triggerGuard(-0.1), 0.008, 0.001), M.metal);
  const mag = [[0.0, -0.032], [0.07, -0.032], [0.08, -0.13], [0.02, -0.13]];
  P.add(prof(a.mag === 'extended' ? stretch(mag, -0.035, 1.5, 0.05) : mag, 0.03), M.black);
  // PSO scope
  P.add(bx(0.016, 0.03, 0.12, -0.02, 0.045, -0.02), M.black);
  P.add(cyl(0.02, 0.02, -0.18, -0.13, 0.075), M.black);
  P.add(cyl(0.014, 0.014, -0.13, 0.08, 0.075), M.black);
  P.add(vcyl(0.011, 0.03, -0.02, 0.095), M.black);
  P.add(cyl(0.022, 0.024, 0.08, 0.16, 0.075), M.black);
  P.add(disc(0.021, 0.161, 0.075), M.glass);
  return { railU: 0, railV: 0.05, muzzleU: 0.79, muzzleV: 0.004, barrelR: 0.009, defMuzzle: null,
    gripU: -0.165, gripV: -0.09, foreU: 0.28, foreV: -0.034, laserU: 0.3, laserV: 0.0, laserX: 0.04, ironY: 0.075, buttU: -0.48 };
}

function pistol(P, a, team) {
  const frame = team === 1 ? M.fde : M.polymer;
  P.add(prof([[-0.09, 0.0], [0.085, 0.0], [0.09, 0.008], [0.09, 0.03], [0.08, 0.036], [-0.085, 0.036], [-0.09, 0.03]], 0.026, 0.0025), M.black);
  for (let i = 0; i < 5; i++) P.add(bx(0.027, 0.02, 0.003, -0.08 + i * 0.008, 0.02), M.metal);
  P.add(prof([[-0.08, 0.0], [0.07, 0.0], [0.07, -0.015], [0.0, -0.02], [-0.03, -0.02], [-0.06, -0.015], [-0.08, -0.005]], 0.024), frame);
  const grip = [[-0.035, -0.015], [-0.075, -0.01], [-0.1, -0.11], [-0.095, -0.12], [-0.06, -0.12], [-0.03, -0.02]];
  P.add(prof(a.mag === 'extended' ? stretch(grip, -0.1, 1.35, 0.25) : grip, 0.03), frame);
  P.add(prof([[-0.03, -0.018], [0.015, -0.018], [0.012, -0.045], [-0.025, -0.045], [-0.025, -0.04], [0.006, -0.04], [0.008, -0.023], [-0.03, -0.023]], 0.008, 0.001), frame);
  P.add(cyl(0.006, 0.006, 0.085, 0.093, 0.02), M.steel);
  if (a.optic === 'none') P.add(bx(0.02, 0.007, 0.008, -0.08, 0.04), M.black);
  P.add(bx(0.004, 0.007, 0.004, 0.08, 0.04), M.black);
  return { railU: -0.04, railV: 0.036, muzzleU: 0.093, muzzleV: 0.02, barrelR: 0.006, defMuzzle: null,
    gripU: -0.065, gripV: -0.06, foreU: -0.065, foreV: -0.06, laserU: 0.05, laserV: -0.03, laserX: 0, ironY: 0.043, buttU: -0.1, pistol: true };
}

// ---------- attachments ----------
function addOptic(P, d, a, key) {
  const u = d.railU, v = d.railV;
  if (key === 'sniper') return d.ironY;
  if (a.optic === 'reddot') {
    if (d.pistol) {
      P.add(bx(0.024, 0.02, 0.034, u, v + 0.01), M.black);
      P.add(disc(0.008, u + 0.016, v + 0.016), M.glass);
      const dot = P.own(disc(0.0009, u + 0.015, v + 0.016), M.red); dot.userData.reticle = true;
      return v + 0.016;
    }
    P.add(bx(0.03, 0.016, 0.04, u, v + 0.008), M.black);
    P.add(cyl(0.019, 0.019, u - 0.038, u + 0.038, v + 0.034), M.black);
    P.add(cyl(0.021, 0.021, u + 0.03, u + 0.042, v + 0.034), M.black);
    P.add(disc(0.016, u + 0.043, v + 0.034), M.glass);
    P.add(bx(0.012, 0.012, 0.012, u, v + 0.058), M.black);
    P.add(cyl(0.008, 0.008, u - 0.01, u + 0.01, v + 0.034, 0.024), M.black);
    const dot = P.own(disc(0.0011, u + 0.03, v + 0.034), M.red); dot.userData.reticle = true;
    return v + 0.034;
  }
  if (a.optic === 'holo') {
    P.add(bx(0.05, 0.016, 0.1, u, v + 0.008), M.black);
    P.add(bx(0.006, 0.05, 0.07, u - 0.01, v + 0.04, 0.024), M.black);
    P.add(bx(0.006, 0.05, 0.07, u - 0.01, v + 0.04, -0.024), M.black);
    P.add(bx(0.05, 0.006, 0.075, u - 0.01, v + 0.066), M.black);
    P.add(bx(0.044, 0.03, 0.04, u + 0.04, v + 0.03), M.black);
    const glass = new THREE.PlaneGeometry(0.042, 0.04); glass.translate(0, v + 0.04, -(u - 0.02)); P.add(glass, M.glass);
    const ring = new THREE.RingGeometry(0.0042, 0.005, 28); ring.translate(0, v + 0.04, -(u - 0.022));
    const dot = new THREE.CircleGeometry(0.0007, 10); dot.translate(0, v + 0.04, -(u - 0.022));
    const ret = P.own(mergeGeos([ring, dot]), M.red); ret.userData.reticle = true;
    return v + 0.04;
  }
  if (a.optic === 'acog') {
    P.add(bx(0.03, 0.02, 0.07, u, v + 0.01), M.black);
    P.add(cyl(0.02, 0.016, u - 0.08, u - 0.04, v + 0.045), M.black);
    P.add(cyl(0.015, 0.015, u - 0.04, u + 0.03, v + 0.045), M.black);
    P.add(cyl(0.016, 0.022, u + 0.03, u + 0.07, v + 0.045), M.black);
    P.add(cyl(0.022, 0.022, u + 0.07, u + 0.085, v + 0.045), M.black);
    P.add(disc(0.02, u + 0.086, v + 0.045), M.glass);
    P.add(cyl(0.003, 0.003, u - 0.03, u + 0.05, v + 0.067), M.red);
    return v + 0.045;
  }
  return d.ironY;
}

function addMuzzle(P, d, a) {
  const u = d.muzzleU, v = d.muzzleV;
  if (a.muzzle === 'suppressor') {
    const r = d.pistol ? 0.014 : 0.019, len = d.pistol ? 0.13 : 0.17;
    P.add(cyl(r, r, u, u + len, v), M.black);
    P.add(cyl(r + 0.001, r + 0.001, u, u + 0.015, v), M.metal);
    return u + len;
  }
  if (a.muzzle === 'compensator') {
    const r = d.barrelR + 0.004, len = d.pistol ? 0.03 : 0.05;
    P.add(cyl(r, r, u, u + len, v), M.metal);
    for (let i = 1; i < 4; i++) P.add(cyl(r + 0.001, r + 0.001, u + (len * i) / 4 - 0.002, u + (len * i) / 4 + 0.002, v), M.black);
    return u + len;
  }
  if (d.defMuzzle) { const [r, len, m] = d.defMuzzle; P.add(cyl(r, r, u, u + len, v), m); return u + len; }
  return u;
}

function addUnder(P, d, a) {
  const out = { fore: null, laser: null };
  if (a.under === 'grip' && !d.pistol) {
    P.add(bx(0.024, 0.01, 0.04, d.foreU, d.foreV - 0.004), M.black);
    P.add(vcyl(0.014, 0.085, d.foreU, d.foreV - 0.05), M.polymer);
    out.fore = [d.foreU, d.foreV - 0.06];
  }
  if (a.under === 'laser') {
    const x = d.laserX, u = d.laserU, v = d.laserV;
    P.add(bx(d.pistol ? 0.022 : 0.026, d.pistol ? 0.02 : 0.03, d.pistol ? 0.04 : 0.07, u, v, x), d.pistol ? M.black : M.fde);
    const tipU = u + (d.pistol ? 0.021 : 0.036);
    P.add(disc(0.004, tipU + 0.001, v + 0.004, x), M.red);
    const beam = new THREE.CylinderGeometry(0.0015, 0.0015, 8, 6);
    beam.rotateX(-Math.PI / 2); beam.translate(x, v + 0.004, -(tipU + 4));
    const b = P.own(beam, M.laser);
    b.userData.laserBeam = true;
    out.laser = new THREE.Vector3(x, v + 0.004, -tipU);
  }
  return out;
}

export function buildGun(key, team, attIn) {
  const a = Object.assign({ optic: 'none', muzzle: 'none', under: 'none', mag: 'none' }, attIn);
  const P = new Parts();
  const d = key === 'rifle' ? (team === 2 ? ak(P, a, false) : m4(P, a))
    : key === 'shotgun' ? (team === 2 ? ak(P, a, true) : benelli(P, a))
    : key === 'sniper' ? (team === 2 ? dragunov(P, a) : m24(P, a))
    : pistol(P, a, team);
  const sightY = addOptic(P, d, a, key);
  const tipU = addMuzzle(P, d, a);
  const under = addUnder(P, d, a);
  const g = P.bake(new THREE.Group());
  const fore = under.fore || [d.foreU, d.foreV];
  g.userData = {
    key, att: a, sightY,
    muzzle: new THREE.Vector3(0, d.muzzleV, -tipU),
    grip: new THREE.Vector3(0, d.gripV, -d.gripU),
    fore: new THREE.Vector3(0, fore[1] - 0.01, -fore[0]),
    buttU: d.buttU, pistol: !!d.pistol,
    reticles: g.children.filter((c) => c.userData.reticle),
    laserBeam: g.children.find((c) => c.userData.laserBeam) || null,
  };
  return g;
}

// ---------- camo textures ----------
const camoCache = {};
export function camoTexture(team) {
  if (camoCache[team]) return camoCache[team];
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  let seed = team * 9973;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  if (team === 1) {
    // desert digital (MARPAT-style)
    g.fillStyle = '#b09670'; g.fillRect(0, 0, S, S);
    const px = 4;
    for (const col of ['#cbb78e', '#94784f', '#6c563c', '#4f3f2d']) {
      for (let b = 0; b < 26; b++) {
        let x = rnd() * S, y = rnd() * S;
        for (let k = 0; k < 40; k++) {
          x += (rnd() - 0.5) * 3 * px; y += (rnd() - 0.5) * 3 * px;
          g.fillStyle = col;
          const gx = Math.floor(x / px) * px, gy = Math.floor(y / px) * px;
          for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) g.fillRect(gx + ox, gy + oy, px * (1 + (rnd() * 2 | 0)), px * (1 + (rnd() * 2 | 0)));
        }
      }
    }
  } else {
    // green-brown woodland
    g.fillStyle = '#5d6242'; g.fillRect(0, 0, S, S);
    for (const col of ['#7c7751', '#3b4029', '#2a2a20', '#6b5a3c']) {
      for (let b = 0; b < 14; b++) {
        const x = rnd() * S, y = rnd() * S, rx = 10 + rnd() * 26, ry = 6 + rnd() * 14, rot = rnd() * 3;
        g.fillStyle = col;
        for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) { g.beginPath(); g.ellipse(x + ox, y + oy, rx, ry, rot, 0, 7); g.fill(); }
      }
    }
  }
  for (let i = 0; i < 2500; i++) { g.fillStyle = `rgba(0,0,0,${0.08 * rnd()})`; g.fillRect(rnd() * S, rnd() * S, 1, 1); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(2, 2);
  return (camoCache[team] = t);
}

export const SKINS = [0xc99a75, 0xa8754f, 0x8a5a3b, 0xe0b48f, 0x6e4a33, 0xb88462];
const LOOK = {
  1: { vest: 0x6f5c3e, gear: 0x584a33, helmet: 0x7d6a4b, boots: 0x6e573a, gloves: 0x5f4f37 },
  2: { vest: 0x3d4030, gear: 0x30332a, helmet: 0x4b5137, boots: 0x1f1f1f, gloves: 0x252525 },
};

// Capsule limb from point a to point b (geometry pre-transformed).
function limb(a, b, r) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.CapsuleGeometry(r, Math.max(0.001, len), 4, 10);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return g;
}
function sphere(r, x, y, z, sx = 1, sy = 1, sz = 1, seg = 14) {
  const g = new THREE.SphereGeometry(r, seg, Math.round(seg * 0.7)); g.scale(sx, sy, sz); g.translate(x, y, z); return g;
}
function box3(w, h, d, x, y, z) { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return g; }
function roundBox(w, h, d, r, x, y, z) {
  const s = new THREE.Shape();
  const hw = w / 2 - r, hh = h / 2 - r;
  s.moveTo(-hw, -h / 2); s.lineTo(hw, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -hh);
  s.lineTo(w / 2, hh); s.quadraticCurveTo(w / 2, h / 2, hw, h / 2); s.lineTo(-hw, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, hh); s.lineTo(-w / 2, -hh); s.quadraticCurveTo(-w / 2, -h / 2, -hw, -h / 2);
  const core = Math.max(0.001, d - 2 * r);
  const g = new THREE.ExtrudeGeometry(s, { depth: core, bevelEnabled: true, bevelThickness: r, bevelSize: r * 0.5, bevelSegments: 2, curveSegments: 4 });
  g.translate(x, y, z - core / 2);
  return g;
}
// Gloved hand: a mitt plus a thumb, angled to wrap a grip.
function hand(p, r = 0.042, thumbSide = 1) {
  return [sphere(r, p.x, p.y, p.z, 0.75, 1.05, 1.15, 10), limb(new THREE.Vector3(p.x + 0.02 * thumbSide, p.y + 0.02, p.z - 0.01), new THREE.Vector3(p.x + 0.01 * thumbSide, p.y + 0.035, p.z - 0.05), 0.012)];
}

const HIP_Y = 0.92;
export function buildSoldier(team, id, key, att) {
  const L = LOOK[team] || LOOK[1];
  const camo = std(0xffffff, 0.92, 0, { map: camoTexture(team) });
  const vest = std(L.vest, 0.88, 0), gear = std(L.gear, 0.9, 0), helmetM = std(L.helmet, 0.75, 0.05);
  const bootsM = std(L.boots, 0.85, 0), gloveM = std(L.gloves, 0.85, 0), skin = std(SKINS[id % SKINS.length], 0.7, 0);
  const root = new THREE.Group();

  // legs: thigh pivot at the hip, shin pivot at the knee
  const legs = [];
  for (const side of [-1, 1]) {
    const thigh = new THREE.Group(); thigh.position.set(side * 0.1, HIP_Y, 0); root.add(thigh);
    const tp = new Parts();
    tp.add(limb(new THREE.Vector3(0, -0.02, 0), new THREE.Vector3(0, -0.41, 0), 0.092), camo);
    tp.add(roundBox(0.11, 0.1, 0.05, 0.014, 0, -0.42, -0.08), gear);
    tp.add(roundBox(0.045, 0.13, 0.08, 0.012, side * 0.09, -0.2, 0.0), gear);
    tp.bake(thigh);
    const shin = new THREE.Group(); shin.position.y = -0.43; thigh.add(shin);
    const sp = new Parts();
    sp.add(limb(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -0.36, 0), 0.076), camo);
    sp.add(roundBox(0.13, 0.13, 0.28, 0.028, 0, -0.42, -0.04), bootsM);
    sp.add(box3(0.125, 0.025, 0.28, 0, -0.475, -0.04), gear);
    sp.bake(shin);
    legs.push({ thigh, shin });
  }

  // upper body pivots at the hips so it can lean with the aim
  const upper = new THREE.Group(); upper.position.y = HIP_Y; root.add(upper);
  const up = new Parts();
  up.add(roundBox(0.38, 0.19, 0.24, 0.045, 0, 0.0, 0), camo);
  up.add(box3(0.36, 0.05, 0.24, 0, 0.085, 0), gear);
  const torso = new THREE.CapsuleGeometry(0.16, 0.24, 4, 12); torso.scale(1.18, 1, 0.74); torso.translate(0, 0.32, 0); up.add(torso, camo);
  up.add(roundBox(0.38, 0.36, 0.27, 0.035, 0, 0.35, 0), vest);
  for (const x of [-0.105, -0.035, 0.035, 0.105]) up.add(roundBox(0.062, 0.1, 0.05, 0.01, x, 0.26, -0.16), gear);
  up.add(roundBox(0.08, 0.07, 0.04, 0.01, -0.1, 0.43, -0.155), gear);
  up.add(roundBox(0.28, 0.3, 0.09, 0.02, 0, 0.37, 0.17), gear);
  for (const x of [-0.13, 0.13]) up.add(roundBox(0.09, 0.05, 0.3, 0.015, x, 0.53, 0), vest);
  up.add(new THREE.CylinderGeometry(0.052, 0.058, 0.09, 12).translate(0, 0.58, 0), skin);
  if (team === 2) up.add(new THREE.CylinderGeometry(0.075, 0.085, 0.08, 14, 1, true).translate(0, 0.58, 0), gear);

  // weapon in the hands; the stock sits in the right shoulder pocket
  const gun = buildGun(key, team, att);
  const holder = new THREE.Group();
  const gd = gun.userData;
  if (gd.pistol) holder.position.set(0.05, 0.42, -0.42);
  else holder.position.set(0.075, 0.43, -0.1 + gd.buttU);
  holder.add(gun);
  upper.add(holder);
  const gripP = gd.grip.clone().add(holder.position), foreP = gd.fore.clone().add(holder.position);
  if (gd.pistol) foreP.set(gripP.x - 0.035, gripP.y - 0.01, gripP.z + 0.01);
  const shR = new THREE.Vector3(0.21, 0.5, 0.0), shL = new THREE.Vector3(-0.21, 0.5, 0.0);
  const elR = shR.clone().lerp(gripP, 0.5).add(new THREE.Vector3(0.1, -0.13, 0.06));
  const elL = shL.clone().lerp(foreP, 0.5).add(new THREE.Vector3(-0.12, -0.12, 0.02));
  up.add(limb(shR, elR, 0.058), camo); up.add(limb(elR, gripP, 0.05), camo);
  up.add(limb(shL, elL, 0.058), camo); up.add(limb(elL, foreP, 0.05), camo);
  for (const g of hand(gripP, 0.042, -1)) up.add(g, gloveM);
  for (const g of hand(foreP, 0.042, 1)) up.add(g, gloveM);
  up.bake(upper);

  // head with helmet
  const head = new THREE.Group(); head.position.y = 0.64; upper.add(head);
  const hp = new Parts();
  hp.add(sphere(0.102, 0, 0.08, 0, 0.92, 1.08, 1.0, 16), skin);
  hp.add(box3(0.026, 0.035, 0.03, 0, 0.065, -0.1), skin);
  hp.add(sphere(0.124, 0, 0.115, 0.005, 1.0, 0.86, 1.08, 18).translate(0, 0, 0), helmetM);
  hp.add(box3(0.25, 0.03, 0.27, 0, 0.1, 0.005), helmetM);
  if (team === 1) {
    hp.add(roundBox(0.17, 0.034, 0.02, 0.008, 0, 0.09, -0.095), std(0x111316, 0.15, 0.6));
    hp.add(box3(0.045, 0.035, 0.03, 0, 0.19, -0.115), M.black);
  } else {
    hp.add(sphere(0.098, 0, 0.03, -0.004, 0.95, 0.75, 1.02, 14), gear);
  }
  hp.bake(head);

  const tip = new THREE.Object3D(); tip.position.copy(gd.muzzle); gun.add(tip);
  if (gd.laserBeam) gd.laserBeam.visible = false;
  for (const r of gd.reticles) r.visible = false;
  return { root, upper, head, legs, holder, gun, tip, weaponKey: key };
}

// Animate the rig: phase advances with walking speed, amt 0..1 is stride strength.
export function poseSoldier(m, phase, amt, crouch, pitch) {
  const hipY = crouch ? 0.56 : HIP_Y;
  m.upper.position.y = hipY;
  m.upper.rotation.x = pitch * 0.75;
  m.head.rotation.x = pitch * 0.25;
  m.legs.forEach((leg, i) => {
    const ph = phase + (i ? Math.PI : 0);
    leg.thigh.position.y = hipY;
    if (crouch) {
      leg.thigh.rotation.x = 1.2 + Math.sin(ph) * 0.25 * amt;
      leg.shin.rotation.x = -1.9 + Math.max(0, Math.sin(ph)) * 0.2 * amt;
    } else {
      leg.thigh.rotation.x = Math.sin(ph) * 0.6 * amt;
      leg.shin.rotation.x = -Math.max(0, Math.sin(ph + 1.3)) * 0.95 * amt - 0.05;
    }
  });
}

// First-person arms for the viewmodel, attached to a gun built with buildGun.
export function buildViewArms(team, gun) {
  const L = LOOK[team] || LOOK[1];
  const camo = std(0xffffff, 0.92, 0, { map: camoTexture(team) });
  const gloveM = std(L.gloves, 0.85, 0);
  const gd = gun.userData;
  const P = new Parts();
  const grip = gd.grip.clone();
  const fore = gd.pistol ? new THREE.Vector3(grip.x - 0.03, grip.y - 0.012, grip.z + 0.012) : gd.fore.clone();
  const elR = new THREE.Vector3(0.12, -0.24, 0.42), elL = gd.pistol ? new THREE.Vector3(-0.16, -0.26, 0.4) : new THREE.Vector3(-0.2, -0.24, 0.14);
  P.add(limb(new THREE.Vector3(grip.x + 0.005, grip.y - 0.015, grip.z + 0.04), elR, 0.046), camo);
  P.add(limb(new THREE.Vector3(fore.x - 0.01, fore.y - 0.02, fore.z + 0.03), elL, 0.046), camo);
  P.add(limb(new THREE.Vector3(grip.x + 0.003, grip.y - 0.02, grip.z + 0.06), new THREE.Vector3(grip.x + 0.006, grip.y - 0.03, grip.z + 0.1), 0.05), gloveM);
  for (const g of hand(grip, 0.04, -1)) P.add(g, gloveM);
  for (const g of hand(fore, 0.04, 1)) P.add(g, gloveM);
  return P.bake(new THREE.Group(), false);
}
