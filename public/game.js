import * as THREE from '/vendor/three/three.module.js';
import { buildGun, buildSoldier, poseSoldier, buildViewArms, mergeGeos } from '/models.js';

const C = window.COMMON;
const STEAM = window.steam || null; // provided by the desktop app's preload script
const P = C.PLAYER;
const WKEYS = C.WEAPON_KEYS;
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const teamName = (t) => (C.TEAMS[t] ? C.TEAMS[t].name : '');
const weaponName = (key, team) => (key === 'nade' ? 'Grenade' : C.WEAPONS[key] ? C.WEAPONS[key].names[team] || C.WEAPONS[key].label : '');

// ---------- Settings ----------
const settings = Object.assign(
  { name: '', sens: 1.0, fov: 75, volume: 0.7, shadows: true, team: 0, primary: 'rifle', bots: 8, vis: 1, att: {} },
  (() => { try { return JSON.parse(localStorage.getItem('iw_settings') || '{}'); } catch { return {}; } })(),
);
settings.att = Object.fromEntries(WKEYS.map((k) => [k, C.cleanAtt(k, (settings.att && settings.att[k]) || C.DEFAULT_ATT[k])]));
const saveSettings = () => { try { localStorage.setItem('iw_settings', JSON.stringify(settings)); } catch { /* storage unavailable */ } };

// ---------- Renderer / scene ----------
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const FOG = new THREE.Color(0xd9c49c);
scene.fog = new THREE.Fog(FOG, 60, 430);
const camera = new THREE.PerspectiveCamera(settings.fov, innerWidth / innerHeight, 0.05, 700);
camera.rotation.order = 'YXZ';
scene.add(camera);

const hemi = new THREE.HemisphereLight(0xfff1d6, 0x9b7b52, 1.25);
scene.add(hemi);
const SUN_DIR = new THREE.Vector3(0.5, 0.78, 0.38).normalize();
const sun = new THREE.DirectionalLight(0xffe6c0, 2.7);
sun.castShadow = settings.shadows;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 320 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.05;
scene.add(sun, sun.target);
const flashLight = new THREE.PointLight(0xffc070, 0, 12, 2);
scene.add(flashLight);
const boomLight = new THREE.PointLight(0xff9a40, 0, 30, 2);
scene.add(boomLight);

// Sky dome
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(600, 24, 12),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(0x7fa2c4) }, horizon: { value: new THREE.Color(0xe2cfa6) }, sunDir: { value: SUN_DIR } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; varying vec3 vDir;
      void main(){ float h = clamp(vDir.y, 0.0, 1.0); vec3 col = mix(horizon, top, pow(h, 0.55));
        float s = max(dot(normalize(vDir), sunDir), 0.0); col += vec3(1.0, 0.92, 0.75) * (pow(s, 600.0) * 4.0 + pow(s, 12.0) * 0.25);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }),
);
sky.renderOrder = -1;
scene.add(sky);

// Image-based lighting so metal and polymer on guns and soldiers catch the desert light
const envMap = (() => {
  const envScene = new THREE.Scene();
  const g = new THREE.SphereGeometry(10, 32, 16);
  const top = new THREE.Color(0x9ab6d0), hor = new THREE.Color(0xf0dcb4), gnd = new THREE.Color(0x8a6c48);
  const pa = g.attributes.position, cols = [];
  for (let i = 0; i < pa.count; i++) {
    const y = pa.getY(i) / 10;
    const c = y > 0 ? hor.clone().lerp(top, Math.pow(y, 0.6)) : hor.clone().lerp(gnd, Math.min(1, -y * 3));
    cols.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  envScene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const sunBall = new THREE.Mesh(new THREE.SphereGeometry(1.2, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 5.4, 4.4) }));
  sunBall.position.copy(SUN_DIR).multiplyScalar(8);
  envScene.add(sunBall);
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(envScene, 0.02);
  pm.dispose();
  return rt.texture;
})();
scene.environment = envMap;
scene.environmentIntensity = 0.55;

// ---------- Procedural textures ----------
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = mulberry32(1337);
const maxAniso = renderer.capabilities.getMaxAnisotropy();
function tex(draw, size = 256, srgb = true) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, maxAniso);
  return t;
}
function grain(g, s, n, alpha, maxSz = 2) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = rand() < 0.5 ? `rgba(0,0,0,${alpha * rand()})` : `rgba(255,255,255,${alpha * rand()})`;
    const w = 1 + rand() * maxSz;
    g.fillRect(rand() * s, rand() * s, w, w);
  }
}
function blotches(g, s, n, rgb, alphaMax, rMax) {
  for (let i = 0; i < n; i++) {
    const x = rand() * s, y = rand() * s, r = rMax * (0.3 + rand() * 0.7), a = alphaMax * rand();
    for (const ox of [-s, 0, s]) for (const oy of [-s, 0, s]) {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      gr.addColorStop(0, `rgba(${rgb},${a})`);
      gr.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gr;
      g.fillRect(x + ox - r, y + oy - r, 2 * r, 2 * r);
    }
  }
}
function cracks(g, s, n) {
  g.strokeStyle = 'rgba(70,50,30,0.35)';
  g.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    let x = rand() * s, y = rand() * s;
    g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 8; k++) { x += (rand() - 0.5) * 22; y += rand() * 16; g.lineTo(x, y); }
    g.stroke();
  }
}
const brickTex = (base, rows = 8, cols = 4, wash = 0.5) => tex((g, s) => {
  g.fillStyle = base; g.fillRect(0, 0, s, s);
  const bh = s / rows, bw = s / cols;
  for (let r = 0; r < rows; r++) for (let c = 0; c <= cols; c++) {
    const x = c * bw - (r % 2 ? bw / 2 : 0);
    g.fillStyle = rand() < 0.5 ? `rgba(90,60,30,${0.14 * rand()})` : `rgba(255,240,210,${0.14 * rand()})`;
    g.fillRect(x + 1, r * bh + 1, bw - 2, bh - 2);
  }
  g.fillStyle = 'rgba(70,48,25,0.32)';
  for (let r = 0; r <= rows; r++) g.fillRect(0, r * bh - 1, s, 2);
  for (let r = 0; r < rows; r++) for (let c = 0; c <= cols; c++) g.fillRect(c * bw - (r % 2 ? bw / 2 : 0) - 1, r * bh, 2, bh);
  blotches(g, s, 7, '226,205,165', wash, s * 0.35);
  blotches(g, s, 4, '90,65,40', 0.15, s * 0.25);
  grain(g, s, 2500, 0.18);
});
const plasterTex = (base) => tex((g, s) => {
  g.fillStyle = base; g.fillRect(0, 0, s, s);
  blotches(g, s, 10, '120,90,55', 0.16, s * 0.3);
  blotches(g, s, 8, '255,245,225', 0.14, s * 0.3);
  grain(g, s, 3000, 0.12);
  cracks(g, s, 3);
});
const stoneTex = (base, n = 4) => tex((g, s) => {
  g.fillStyle = base; g.fillRect(0, 0, s, s);
  const b = s / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    g.fillStyle = rand() < 0.5 ? `rgba(80,60,40,${0.12 * rand()})` : `rgba(255,245,225,${0.12 * rand()})`;
    g.fillRect(i * b + 2, j * b + 2, b - 4, b - 4);
  }
  g.fillStyle = 'rgba(70,55,35,0.35)';
  for (let i = 0; i <= n; i++) { g.fillRect(i * b - 1, 0, 2, s); g.fillRect(0, i * b - 1, s, 2); }
  grain(g, s, 2500, 0.15);
});
const concreteTex = (base) => tex((g, s) => {
  g.fillStyle = base; g.fillRect(0, 0, s, s);
  blotches(g, s, 8, '60,60,60', 0.12, s * 0.3);
  for (let i = 0; i < 12; i++) { g.fillStyle = `rgba(60,55,50,${0.08 * rand()})`; g.fillRect(rand() * s, 0, 2 + rand() * 6, s * rand()); }
  g.fillStyle = 'rgba(40,40,40,0.25)'; g.fillRect(0, 0, 2, s);
  grain(g, s, 3500, 0.14);
});
const hescoTex = (base) => tex((g, s) => {
  g.fillStyle = base; g.fillRect(0, 0, s, s);
  blotches(g, s, 6, '90,70,45', 0.25, s * 0.25);
  grain(g, s, 2000, 0.15);
  g.fillStyle = 'rgba(55,55,50,0.6)';
  const n = 6;
  for (let i = 0; i <= n; i++) { g.fillRect(i * (s / n) - 1, 0, 2, s); g.fillRect(0, i * (s / n) - 1, s, 2); }
  g.fillStyle = 'rgba(40,40,35,0.8)'; g.fillRect(0, 0, 4, s);
});
const sandbagTex = (base) => tex((g, s) => {
  g.fillStyle = '#6d5c40'; g.fillRect(0, 0, s, s);
  const rows = 4, bh = s / rows, bw = s / 2;
  for (let r = 0; r < rows; r++) for (let c = -1; c <= 2; c++) {
    const x = c * bw + (r % 2 ? bw / 2 : 0), y = r * bh;
    const gr = g.createLinearGradient(0, y, 0, y + bh);
    gr.addColorStop(0, '#bba57a'); gr.addColorStop(0.5, base); gr.addColorStop(1, '#7c6948');
    g.fillStyle = gr;
    g.beginPath(); g.roundRect(x + 3, y + 3, bw - 6, bh - 6, 14); g.fill();
  }
  grain(g, s, 2500, 0.15);
});
const woodTex = (base) => tex((g, s) => {
  g.fillStyle = base; g.fillRect(0, 0, s, s);
  const n = 4, w = s / n;
  for (let i = 0; i < n; i++) {
    g.fillStyle = `rgba(${rand() < 0.5 ? '0,0,0' : '255,230,200'},${0.1 * rand()})`; g.fillRect(i * w, 0, w, s);
    for (let k = 0; k < 10; k++) { g.fillStyle = 'rgba(50,30,15,0.15)'; g.fillRect(i * w + rand() * w, 0, 1, s); }
    g.fillStyle = 'rgba(30,18,8,0.5)'; g.fillRect(i * w, 0, 2, s);
  }
  grain(g, s, 1500, 0.12);
});
const paintTex = (base, kind) => tex((g, s) => {
  g.fillStyle = base; g.fillRect(0, 0, s, s);
  if (kind === 'rust') blotches(g, s, 14, '120,72,40', 0.3, s * 0.2);
  if (kind === 'burnt') { blotches(g, s, 12, '10,8,6', 0.6, s * 0.25); blotches(g, s, 8, '120,60,30', 0.35, s * 0.15); }
  blotches(g, s, 6, '0,0,0', 0.12, s * 0.3);
  grain(g, s, 2500, 0.14);
});
const clothTex = (a, b) => tex((g, s) => {
  g.fillStyle = a; g.fillRect(0, 0, s, s);
  g.fillStyle = b;
  for (let i = 0; i < 6; i += 2) g.fillRect(i * (s / 6), 0, s / 6, s);
  grain(g, s, 1500, 0.12);
});
const corrugatedTex = (base, rust = 0.25) => tex((g, s) => {
  g.fillStyle = base; g.fillRect(0, 0, s, s);
  const n = 16, w = s / n;
  for (let i = 0; i < n; i++) {
    const gr = g.createLinearGradient(i * w, 0, (i + 1) * w, 0);
    gr.addColorStop(0, 'rgba(0,0,0,0.22)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.12)'); gr.addColorStop(1, 'rgba(0,0,0,0.22)');
    g.fillStyle = gr; g.fillRect(i * w, 0, w, s);
  }
  blotches(g, s, 8, '120,70,35', rust, s * 0.15);
  for (let i = 0; i < 10; i++) { g.fillStyle = `rgba(90,50,25,${0.15 * rand()})`; g.fillRect(rand() * s, rand() * s * 0.5, 2 + rand() * 3, s * 0.5 * rand()); }
  grain(g, s, 2000, 0.12);
});
const windowTex = tex((g, s) => {
  g.fillStyle = '#5b4631'; g.fillRect(0, 0, s, s);
  g.fillStyle = '#1b1510'; g.fillRect(s * 0.1, s * 0.1, s * 0.8, s * 0.8);
  g.fillStyle = '#4a3a29'; g.fillRect(s * 0.47, s * 0.1, s * 0.06, s * 0.8); g.fillRect(s * 0.1, s * 0.45, s * 0.8, s * 0.05);
  grain(g, s, 800, 0.15);
}, 64);

const MATDEF = {
  mud: [brickTex('#c6a072'), 2.4], mud2: [plasterTex('#d4b98c'), 3], plaster: [plasterTex('#e0d1b2'), 3],
  roof: [plasterTex('#ad946a'), 3], stone: [stoneTex('#c0ad8a'), 2], concrete: [concreteTex('#a8a49b'), 3.6],
  hesco: [hescoTex('#b7a078'), 1.3], sandbag: [sandbagTex('#a58f66'), 1.1], perimeter: [brickTex('#ab9068', 6, 3, 0.3), 4],
  wood: [woodTex('#7a5a3a'), 1.2], metal: [paintTex('#4c524f'), 2], rust: [paintTex('#6b5444', 'rust'), 2],
  burnt: [paintTex('#3a3430', 'burnt'), 2], technical: [paintTex('#d8d3c6', 'rust'), 2.5], humvee: [paintTex('#b6a179'), 2.5],
  tire: [null, 1, 0x1c1c1c], drum: [paintTex('#2f5b84', 'rust'), 1], drumred: [paintTex('#8a3029', 'rust'), 1],
  cloth1: [clothTex('#a8423a', '#d9c7a0'), 1.6], cloth2: [clothTex('#3b5e8c', '#d9d0b8'), 1.6],
  cloth3: [clothTex('#5b7a3a', '#c9b98a'), 1.6], cloth4: [clothTex('#c99a32', '#8a3a2a'), 1.6],
  window: [windowTex, 0, null, true],
  corrugated: [corrugatedTex('#b9b4a6', 0.15), 3], roofmetal: [corrugatedTex('#8f8c84', 0.2), 3],
  cont_red: [corrugatedTex('#9c3226'), 2.6], cont_blue: [corrugatedTex('#2d4f7c'), 2.6], cont_green: [corrugatedTex('#3f6b47'), 2.6],
  cont_orange: [corrugatedTex('#c0662a'), 2.6], cont_gray: [corrugatedTex('#7d8288'), 2.6],
  crane: [paintTex('#d9a21c', 'rust'), 2], tank: [paintTex('#dcdad2'), 3], hull: [paintTex('#d2d4d6', 'rust'), 3],
  hullgray: [paintTex('#6f767c'), 3], truck: [paintTex('#5b6040'), 2.5],
};
const materials = {};
for (const [k, [map, , color]] of Object.entries(MATDEF)) {
  materials[k] = new THREE.MeshLambertMaterial(map ? { map } : { color });
}

// ---------- World geometry ----------
function boxGeometry(list, tile, local) {
  const pos = [], nor = [], uv = [], idx = [];
  for (const b of list) {
    const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
    const faces = [
      [[1, 0, 0], [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], 2, 1],
      [[-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], 2, 1],
      [[0, 1, 0], [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], 0, 2],
      [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], 0, 2],
      [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], 0, 1],
      [[0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], 0, 1],
    ];
    for (const [n, corners, ua, va] of faces) {
      if (n[1] === -1 && y0 <= 0.001) continue;
      const base = pos.length / 3;
      for (const c of corners) {
        pos.push(c[0], c[1], c[2]);
        nor.push(n[0], n[1], n[2]);
        if (local) uv.push((c[ua] - b.min[ua]) / (b.max[ua] - b.min[ua]), (c[va] - b.min[va]) / (b.max[va] - b.min[va]));
        else uv.push(c[ua] / tile, c[va] / tile);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
function buildWorld() {
  // ground, roads and plaza
  const sand = tex((g, s) => {
    g.fillStyle = '#cdb084'; g.fillRect(0, 0, s, s);
    blotches(g, s, 18, '150,120,80', 0.25, s * 0.2);
    blotches(g, s, 14, '240,225,195', 0.22, s * 0.2);
    grain(g, s, 14000, 0.18, 2);
    for (let i = 0; i < 120; i++) { g.fillStyle = `rgba(110,90,65,${0.5 * rand()})`; g.beginPath(); g.ellipse(rand() * s, rand() * s, 1 + rand() * 3, 1 + rand() * 2, rand() * 3, 0, 7); g.fill(); }
  }, 512);
  const QX = C.MAP.quay;
  sand.repeat.set((QX + 300) / 8, 600 / 8);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(QX + 300, 600), new THREE.MeshLambertMaterial({ map: sand }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.x = (QX - 300) / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const roadT = tex((g, s) => {
    g.fillStyle = '#a58f6c'; g.fillRect(0, 0, s, s);
    blotches(g, s, 10, '80,65,45', 0.22, s * 0.25);
    g.fillStyle = 'rgba(70,58,42,0.25)'; g.fillRect(s * 0.28, 0, s * 0.08, s); g.fillRect(s * 0.64, 0, s * 0.08, s);
    grain(g, s, 6000, 0.16);
  }, 256);
  const roadMat = new THREE.MeshLambertMaterial({ map: roadT, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const ns = new THREE.Mesh(new THREE.PlaneGeometry(12, 154), roadMat);
  ns.rotation.x = -Math.PI / 2; ns.position.y = 0.01; ns.receiveShadow = true;
  roadT.repeat.set(1, 154 / 12);
  const roadT2 = roadT.clone(); roadT2.needsUpdate = true; roadT2.repeat.set(1, (QX + 77) / 12);
  const ew = new THREE.Mesh(new THREE.PlaneGeometry(12, QX + 77), new THREE.MeshLambertMaterial({ map: roadT2, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  ew.rotation.set(-Math.PI / 2, 0, Math.PI / 2); ew.position.set((QX - 77) / 2, 0.014, 0); ew.receiveShadow = true;
  const plazaT = stoneTex('#c7b493', 4); plazaT.repeat.set(16, 16);
  const plaza = new THREE.Mesh(new THREE.PlaneGeometry(32, 32), new THREE.MeshLambertMaterial({ map: plazaT, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  plaza.rotation.x = -Math.PI / 2; plaza.position.y = 0.02; plaza.receiveShadow = true;
  scene.add(ns, ew, plaza);

  // port apron, sea, fuel tanks, shipping and the far shore
  const apronT = concreteTex('#aaa69d'); apronT.repeat.set((QX - 17) / 5, 154 / 5);
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(QX - 17, 154), new THREE.MeshLambertMaterial({ map: apronT, polygonOffset: true, polygonOffsetFactor: -0.5, polygonOffsetUnits: -0.5 }));
  apron.rotation.x = -Math.PI / 2; apron.position.set((QX + 17) / 2, 0.006, 0); apron.receiveShadow = true;
  scene.add(apron);
  waterTex = tex((g, s) => {
    g.fillStyle = '#2e6a7c'; g.fillRect(0, 0, s, s);
    blotches(g, s, 10, '18,58,78', 0.35, s * 0.25);
    for (let i = 0; i < 320; i++) {
      g.strokeStyle = `rgba(255,255,255,${0.04 + 0.09 * rand()})`; g.lineWidth = 1 + rand() * 2;
      const x = rand() * s, y = rand() * s, l = 8 + rand() * 30;
      g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + l / 2, y - 3, x + l, y); g.stroke();
    }
  }, 256);
  waterTex.repeat.set(70, 140);
  const water = new THREE.Mesh(new THREE.PlaneGeometry(700, 1400), new THREE.MeshPhongMaterial({ map: waterTex, shininess: 80, specular: 0x8899aa }));
  water.rotation.x = -Math.PI / 2; water.position.set(QX + 350, -0.55, 0); water.receiveShadow = true;
  scene.add(water);
  const tankMat = new THREE.MeshLambertMaterial({ map: MATDEF.tank[0] }), bandMat = new THREE.MeshLambertMaterial({ color: 0xa3392b });
  for (const t of C.MAP.tanks) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(t.r, t.r, t.h, 36), tankMat);
    m.position.set(t.x, t.h / 2, t.z); m.castShadow = m.receiveShadow = true;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(t.r, 36, 6, 0, Math.PI * 2, 0, 0.35), tankMat);
    cap.position.set(t.x, t.h - t.r * Math.cos(0.35), t.z); cap.castShadow = true;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(t.r + 0.02, t.r + 0.02, 0.5, 36, 1, true), bandMat);
    band.position.set(t.x, t.h * 0.8, t.z);
    const ladder = new THREE.Mesh(new THREE.BoxGeometry(0.5, t.h, 0.1), new THREE.MeshLambertMaterial({ color: 0x555b5e }));
    ladder.position.set(t.x - t.r - 0.05, t.h / 2, t.z);
    scene.add(m, cap, band, ladder);
  }
  const hullShape = (len, beam) => {
    const sh = new THREE.Shape();
    sh.moveTo(-beam / 2, -len / 2); sh.lineTo(beam / 2, -len / 2); sh.lineTo(beam / 2, len * 0.3);
    sh.quadraticCurveTo(beam / 2, len / 2, 0, len / 2); sh.quadraticCurveTo(-beam / 2, len / 2, -beam / 2, len * 0.3); sh.closePath();
    return sh;
  };
  const shipGeo = { hull: [], white: [], red: [], gray: [], boxes: [[], [], [], [], []] };
  const boxCols = [0x9c3226, 0x2d4f7c, 0x3f6b47, 0xc0662a, 0x7d8288];
  const addShip = (x, z, len, beam, kind) => {
    const h = kind === 'boat' ? 1.2 : kind === 'warship' ? 7 : 10;
    const g = new THREE.ExtrudeGeometry(hullShape(len, beam), { depth: h, bevelEnabled: false });
    g.rotateX(-Math.PI / 2); g.translate(x, -2, z);
    (kind === 'tanker' ? shipGeo.red : kind === 'warship' ? shipGeo.gray : shipGeo.hull).push(g);
    const sup = (w, hh, d, oz, oy, list) => { const b = new THREE.BoxGeometry(w, hh, d); b.translate(x, -2 + h + oy + hh / 2, z + oz); list.push(b); };
    if (kind === 'tanker') { sup(beam * 0.8, 9, len * 0.12, -len * 0.4, 0, shipGeo.white); sup(beam * 0.7, 1.2, len * 0.6, len * 0.05, 0, shipGeo.red); }
    if (kind === 'container') {
      sup(beam * 0.85, 12, len * 0.08, -len * 0.42, 0, shipGeo.white);
      for (let i = 0; i < 7; i++) sup(beam * 0.9, 5 + (i % 3) * 2.6, len * 0.09, -len * 0.3 + i * len * 0.1, 0, shipGeo.boxes[i % 5]);
    }
    if (kind === 'warship') {
      sup(beam * 0.7, 7, len * 0.25, -len * 0.05, 0, shipGeo.gray);
      sup(1.2, 14, 1.2, -len * 0.05, 7, shipGeo.gray);
      sup(beam * 0.4, 2, len * 0.08, len * 0.28, 0, shipGeo.gray);
    }
    if (kind === 'boat') sup(beam * 0.6, 1.4, len * 0.3, -len * 0.1, 0, shipGeo.white);
  };
  addShip(185, -110, 130, 22, 'tanker');
  addShip(255, 70, 160, 28, 'container');
  addShip(130, 170, 80, 10, 'warship');
  addShip(330, -280, 170, 30, 'tanker');
  addShip(95, -35, 11, 3.2, 'boat');
  addShip(112, 30, 9, 3, 'boat');
  addShip(150, -10, 10, 3, 'boat');
  const lam2 = (c) => new THREE.MeshLambertMaterial({ color: c });
  const shipMats = { hull: lam2(0x30353a), white: lam2(0xdedfdb), red: lam2(0x7a3328), gray: lam2(0x7d858c) };
  for (const k of ['hull', 'white', 'red', 'gray']) if (shipGeo[k].length) scene.add(new THREE.Mesh(mergeGeos(shipGeo[k]), shipMats[k]));
  shipGeo.boxes.forEach((list, i) => { if (list.length) scene.add(new THREE.Mesh(mergeGeos(list), lam2(boxCols[i]))); });
  // far shore across the strait
  const hills = [];
  for (let i = 0; i < 26; i++) {
    const z = -520 + i * 42 + (rand() - 0.5) * 30, x = 360 + rand() * 80, r = 50 + rand() * 70, h = 25 + rand() * 60;
    const c = new THREE.ConeGeometry(r, h, 7); c.translate(x, h / 2 - 3, z); hills.push(c);
  }
  scene.add(new THREE.Mesh(mergeGeos(hills), new THREE.MeshLambertMaterial({ color: 0x9b8566, flatShading: true })));

  // map boxes merged per material
  const byMat = {};
  for (const b of C.MAP.boxes) {
    if (b.hidden || b.trunk) continue;
    (byMat[b.mat] = byMat[b.mat] || []).push(b);
  }
  for (const [mat, list] of Object.entries(byMat)) {
    const def = MATDEF[mat] || [null, 2];
    const mesh = new THREE.Mesh(boxGeometry(list, def[1] || 2, def[3]), materials[mat] || materials.mud);
    mesh.castShadow = mat !== 'window';
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // palms
  const bark = tex((g, s) => {
    g.fillStyle = '#6d5537'; g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 10) { g.fillStyle = 'rgba(40,28,15,0.55)'; g.fillRect(0, y, s, 3); }
    grain(g, s, 1500, 0.2);
  }, 128);
  const leaf = tex((g, s) => {
    g.clearRect(0, 0, s, s);
    g.strokeStyle = '#4f6a2b'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(s / 2, 0); g.lineTo(s / 2, s); g.stroke();
    for (let y = 6; y < s; y += 7) {
      const len = (s / 2) * Math.sin((y / s) * Math.PI) * 0.95;
      g.strokeStyle = rand() < 0.5 ? '#5c7a32' : '#6f8a3a'; g.lineWidth = 4;
      g.beginPath(); g.moveTo(s / 2, y); g.lineTo(s / 2 - len, y + 16); g.stroke();
      g.beginPath(); g.moveTo(s / 2, y); g.lineTo(s / 2 + len, y + 16); g.stroke();
    }
  }, 128);
  const barkMat = new THREE.MeshLambertMaterial({ map: bark });
  const leafMat = new THREE.MeshLambertMaterial({ map: leaf, alphaTest: 0.5, side: THREE.DoubleSide });
  for (const p of C.MAP.palms) {
    const lean = (rand() - 0.5) * 1.2, leanZ = (rand() - 0.5) * 1.2;
    const trunk = new THREE.CylinderGeometry(0.17, 0.27, p.h, 8, 8);
    trunk.translate(0, p.h / 2, 0);
    const pa = trunk.attributes.position;
    for (let i = 0; i < pa.count; i++) { const t = pa.getY(i) / p.h; pa.setX(i, pa.getX(i) + lean * t * t); pa.setZ(i, pa.getZ(i) + leanZ * t * t); }
    trunk.computeVertexNormals();
    const tm = new THREE.Mesh(trunk, barkMat);
    tm.position.set(p.x, 0, p.z); tm.castShadow = true;
    scene.add(tm);
    const fronds = [];
    const n = 11;
    for (let i = 0; i < n; i++) {
      const f = new THREE.PlaneGeometry(1.1, 3.4, 1, 6);
      const fa = f.attributes.position;
      for (let k = 0; k < fa.count; k++) { const y = fa.getY(k) + 1.7; fa.setY(k, y); fa.setZ(k, -0.25 * y * y); }
      f.rotateX(-Math.PI / 2 + 0.55 + rand() * 0.25);
      f.rotateY((i / n) * Math.PI * 2 + rand() * 0.3);
      f.translate(lean, p.h - 0.1, leanZ);
      f.computeVertexNormals();
      fronds.push(f);
    }
    const fm = new THREE.Mesh(mergeGeos(fronds), leafMat);
    fm.position.set(p.x, 0, p.z); fm.castShadow = true;
    scene.add(fm);
  }

  // distant skyline beyond the perimeter wall
  const sk = [], domes = [], minarets = [];
  for (const s of C.MAP.skyline) {
    sk.push({ min: [s.x - s.w / 2, 0, s.z - s.d / 2], max: [s.x + s.w / 2, s.h, s.z + s.d / 2] });
    if (s.dome) {
      const d = new THREE.SphereGeometry(Math.min(s.w, s.d) * 0.4, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      d.translate(s.x, s.h, s.z); domes.push(d);
      const m = new THREE.CylinderGeometry(0.7, 0.9, s.h + 16, 8);
      m.translate(s.x + s.w / 2 + 2, (s.h + 16) / 2, s.z); minarets.push(m);
    }
  }
  const skMat = new THREE.MeshLambertMaterial({ map: MATDEF.mud2[0] });
  scene.add(new THREE.Mesh(boxGeometry(sk, 4), skMat));
  if (domes.length) scene.add(new THREE.Mesh(mergeGeos([...domes, ...minarets]), new THREE.MeshLambertMaterial({ color: 0x9fb3a8 })));
}

// ---------- Sprites / particles ----------
const softTex = tex((g, s) => {
  const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
}, 64);
const flashTex = tex((g, s) => {
  g.translate(s / 2, s / 2);
  for (let i = 0; i < 7; i++) {
    g.rotate((Math.PI * 2) / 7 + rand() * 0.3);
    const gr = g.createLinearGradient(0, 0, s / 2, 0);
    gr.addColorStop(0, 'rgba(255,240,190,1)'); gr.addColorStop(1, 'rgba(255,150,40,0)');
    g.fillStyle = gr; g.beginPath(); g.moveTo(0, -5); g.lineTo(s / 2, 0); g.lineTo(0, 5); g.fill();
  }
  const gr = g.createRadialGradient(0, 0, 0, 0, 0, s / 4);
  gr.addColorStop(0, 'rgba(255,255,230,1)'); gr.addColorStop(1, 'rgba(255,170,60,0)');
  g.fillStyle = gr; g.fillRect(-s / 2, -s / 2, s, s);
}, 128);
const holeTex = tex((g, s) => {
  const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  gr.addColorStop(0, 'rgba(15,10,5,1)'); gr.addColorStop(0.35, 'rgba(30,22,14,0.9)'); gr.addColorStop(0.6, 'rgba(60,45,30,0.35)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
}, 32);

const particles = [];
function spawnParticle(pos, vel, color, size, grow, life, opacity = 0.8, additive = false, gravity = 0) {
  let p = particles.find((q) => !q.alive && q.additive === additive);
  if (!p) {
    if (particles.length > 400) return;
    const m = new THREE.SpriteMaterial({ map: softTex, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    p = { sprite: new THREE.Sprite(m), vel: new THREE.Vector3(), additive, alive: false };
    scene.add(p.sprite);
    particles.push(p);
  }
  p.alive = true; p.sprite.visible = true;
  p.sprite.position.copy(pos); p.vel.copy(vel);
  p.sprite.material.color.set(color); p.sprite.material.opacity = opacity;
  p.size = size; p.grow = grow; p.life = life; p.age = 0; p.op = opacity; p.gravity = gravity;
  p.sprite.scale.setScalar(size);
}
function updateParticles(dt) {
  for (const p of particles) {
    if (!p.alive) continue;
    p.age += dt;
    if (p.age >= p.life) { p.alive = false; p.sprite.visible = false; continue; }
    p.vel.y -= p.gravity * dt;
    p.sprite.position.addScaledVector(p.vel, dt);
    p.vel.multiplyScalar(Math.exp(-2 * dt));
    const t = p.age / p.life;
    p.sprite.scale.setScalar(p.size + p.grow * t);
    p.sprite.material.opacity = p.op * (1 - t);
  }
}
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
function puff(pos, color, n, spread, size, life) {
  for (let i = 0; i < n; i++) {
    _v.set((Math.random() - 0.5) * spread, Math.random() * spread * 0.8, (Math.random() - 0.5) * spread);
    spawnParticle(pos, _v, color, size * (0.6 + Math.random() * 0.6), size * 2, life * (0.7 + Math.random() * 0.6), 0.7);
  }
}

const tracers = [];
const tracerGeo = new THREE.BoxGeometry(0.018, 0.018, 1); tracerGeo.translate(0, 0, -0.5);
function addTracer(from, to, color = 0xffd890) {
  let t = tracers.find((q) => !q.alive);
  if (!t) {
    if (tracers.length > 60) return;
    t = { mesh: new THREE.Mesh(tracerGeo, new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })) };
    scene.add(t.mesh); tracers.push(t);
  }
  const len = from.distanceTo(to);
  if (len < 0.5) return;
  t.alive = true; t.mesh.visible = true; t.age = 0; t.life = 0.07;
  t.mesh.material.color.set(color);
  t.mesh.position.copy(from);
  t.mesh.lookAt(to);
  t.mesh.scale.set(1, 1, len);
}
function updateTracers(dt) {
  for (const t of tracers) {
    if (!t.alive) continue;
    t.age += dt;
    if (t.age > t.life) { t.alive = false; t.mesh.visible = false; continue; }
    t.mesh.material.opacity = 0.9 * (1 - t.age / t.life);
  }
}

const decals = [];
let decalIdx = 0;
const decalGeo = new THREE.PlaneGeometry(0.11, 0.11);
const decalMat = new THREE.MeshBasicMaterial({ map: holeTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
function addDecal(pos, normal) {
  let d = decals[decalIdx];
  if (!d) { d = new THREE.Mesh(decalGeo, decalMat); scene.add(d); decals[decalIdx] = d; }
  decalIdx = (decalIdx + 1) % 120;
  d.position.copy(pos).addScaledVector(normal, 0.01);
  d.lookAt(_v2.copy(pos).add(normal));
  d.rotation.z = Math.random() * 6;
}

const flashes = [];
function muzzleFlash(pos, size = 0.6) {
  let f = flashes.find((q) => !q.alive);
  if (!f) {
    f = { sprite: new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })) };
    scene.add(f.sprite); flashes.push(f);
  }
  f.alive = true; f.age = 0; f.sprite.visible = true;
  f.sprite.position.copy(pos);
  f.sprite.material.rotation = Math.random() * 6;
  f.sprite.scale.setScalar(size * (0.8 + Math.random() * 0.4));
}
function updateFlashes(dt) {
  for (const f of flashes) { if (!f.alive) continue; f.age += dt; if (f.age > 0.05) { f.alive = false; f.sprite.visible = false; } }
}

// ambient dust + distant smoke columns
const dust = (() => {
  const n = 500, geo = new THREE.BufferGeometry(), arr = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) arr[i] = (Math.random() - 0.5) * 60;
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xf0dfb8, size: 0.05, transparent: true, opacity: 0.55, depthWrite: false }));
  pts.frustumCulled = false;
  scene.add(pts);
  return { pts, arr, n };
})();
const smokeCols = [[-150, -90], [170, 60], [60, -190]].map(([x, z]) => ({ x, z, acc: 0 }));
function updateAmbient(dt, t) {
  const a = dust.arr, cp = camera.position;
  for (let i = 0; i < dust.n; i++) {
    a[i * 3] += (1.2 + Math.sin(t * 0.3 + i) * 0.4) * dt;
    a[i * 3 + 1] += Math.sin(t * 0.7 + i * 1.3) * 0.1 * dt;
    for (let k = 0; k < 3; k++) {
      const rel = a[i * 3 + k] - cp.getComponent(k);
      if (rel > 30) a[i * 3 + k] -= 60; else if (rel < -30) a[i * 3 + k] += 60;
    }
  }
  dust.pts.geometry.attributes.position.needsUpdate = true;
  for (const s of smokeCols) {
    s.acc += dt;
    if (s.acc > 0.35) {
      s.acc = 0;
      _v.set(s.x + (Math.random() - 0.5) * 4, 2, s.z + (Math.random() - 0.5) * 4);
      _v2.set(1.5 + Math.random(), 4 + Math.random() * 2, (Math.random() - 0.5));
      spawnParticle(_v, _v2, 0x3d3833, 8, 30, 14, 0.55);
    }
  }
}

// ---------- Name tags ----------
function nameSprite(text, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 48;
  const g = c.getContext('2d');
  g.font = '600 28px Bahnschrift, Segoe UI, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(text, 128, 24);
  g.fillStyle = color; g.fillText(text, 128, 24);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true, fog: false }));
  s.scale.set(1.6, 0.3, 1);
  s.renderOrder = 10;
  return s;
}

// ---------- Viewmodel (rendered in its own pass so it never clips into walls) ----------
const vmScene = new THREE.Scene();
vmScene.environment = envMap;
vmScene.environmentIntensity = 0.8;
const vmCam = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.01, 10);
vmScene.add(new THREE.HemisphereLight(0xfff0d8, 0x7a6248, 1.2));
const vmSun = new THREE.DirectionalLight(0xffe8c4, 2.0); vmSun.position.set(0.6, 1, 0.4); vmScene.add(vmSun);
const vm = new THREE.Group(); vmScene.add(vm);
const vmFlash = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
vmFlash.visible = false;
let vmGun = null;
const vmHip = new THREE.Vector3(), vmAds = new THREE.Vector3();
function buildViewmodel() {
  vm.clear();
  const key = curKey();
  vmGun = buildGun(key, me.team, me.att[key]);
  vm.add(vmGun);
  vm.add(buildViewArms(me.team, vmGun));
  const gd = vmGun.userData;
  if (gd.pistol) { vmHip.set(0.12, -0.12, -0.34); vmAds.set(0, -gd.sightY, -0.3); }
  else { vmHip.set(0.15, -0.17, -0.38); vmAds.set(0, -gd.sightY, gd.att.optic === 'none' ? -0.28 : -0.24); }
  const W = stats(key);
  vmFlash.position.copy(gd.muzzle);
  vmFlash.scale.setScalar((key === 'pistol' ? 0.16 : 0.28) * (W.bigFlash ? 1.5 : 1));
  vmGun.add(vmFlash);
}

// ---------- Game state ----------
let state = 'menu'; // menu | game
let ws = null, myId = 0, mode = null;
const roster = new Map();
const remotes = new Map();
const nadeMeshes = new Map();
let phase = 'playing', scores = [0, 0], timeLeft = 0, timeAt = 0, endAt = 0, pingMs = 0;
const me = {
  pos: new THREE.Vector3(0, 0, 60), vel: new THREE.Vector3(), yaw: 0, pitch: 0, recoil: 0, kick: 0,
  onGround: true, crouch: false, eyeH: P.eye, stepOff: 0, alive: false, hp: 100, team: 1,
  primary: 'rifle', slot: 0, ammo: {}, nades: 2, reloadEnd: 0, reloadKey: null, switchEnd: 0, nextFire: 0, nadeCd: 0, throwAt: 0,
  bloom: 0, ads: 0, sprint: 0, sprinting: false, moving: false, bob: 0, stepAcc: 0, spawnAt: 0, deathAt: 0, killerId: 0, streak: 0, lastKillAt: 0, multi: 0,
};
const curKey = () => (me.slot === 0 ? me.primary : 'pistol');
me.att = settings.att;
// weapon stats after the attachments you spawned with
const statCache = {};
function stats(key) {
  const att = (me.att && me.att[key]) || C.DEFAULT_ATT[key];
  const k = key + JSON.stringify(att);
  return statCache[k] || (statCache[k] = C.weaponStats(key, att));
}
let waterTex = null;
const keys = Object.create(null);
const mouse = { fire: false, ads: false };
let jumpQueued = false, locked = false, chatOpen = false;
const sway = { x: 0, y: 0 };

function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

// ---------- Audio (synthesised, no asset files) ----------
const audio = (() => {
  let ac = null, master = null, noise = null;
  function init() {
    if (ac) { ac.resume(); return; }
    ac = new (window.AudioContext || window.webkitAudioContext)();
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 5;
    master = ac.createGain(); master.gain.value = settings.volume;
    master.connect(comp); comp.connect(ac.destination);
    noise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    // wind bed
    const src = ac.createBufferSource(); src.buffer = noise; src.loop = true;
    const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 380; f.Q.value = 0.6;
    const g = ac.createGain(); g.gain.value = 0.035;
    const lfo = ac.createOscillator(); lfo.frequency.value = 0.08;
    const lg = ac.createGain(); lg.gain.value = 0.02;
    lfo.connect(lg); lg.connect(g.gain);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(); lfo.start();
  }
  function dest(pan) {
    if (!pan) return master;
    const p = ac.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); p.connect(master); return p;
  }
  function burst({ freq, type = 'lowpass', q = 0.7, dur, vol, pan = 0, delay = 0, rate = 1 }) {
    if (!ac || vol < 0.002) return;
    const t = ac.currentTime + delay;
    const src = ac.createBufferSource(); src.buffer = noise; src.playbackRate.value = rate;
    const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(dest(pan));
    src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.05);
  }
  function tone({ f0, f1 = f0, dur, vol, type = 'sine', pan = 0, delay = 0 }) {
    if (!ac || vol < 0.002) return;
    const t = ac.currentTime + delay;
    const o = ac.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest(pan)); o.start(t); o.stop(t + dur + 0.05);
  }
  const GUN = { rifle: [2300, 0.2, 0.55], shotgun: [1400, 0.38, 1], sniper: [2900, 0.65, 1], pistol: [3100, 0.13, 0.35] };
  return {
    init,
    setVolume(v) { if (master) master.gain.value = v; },
    gun(key, dist = 0, pan = 0, alt = false, suppressed = false) {
      const [f, d, th] = GUN[key] || GUN.rifle;
      const att = 1 / (1 + dist / 16), far = clamp(1 - dist / 140, 0.12, 1);
      if (suppressed) {
        const sa = 1 / (1 + dist / 6);
        burst({ freq: 1100, dur: 0.09, vol: 0.4 * sa, pan, q: 0.6 });
        burst({ freq: 3800, type: 'bandpass', q: 3, dur: 0.035, vol: 0.18 * sa, pan, delay: 0.02 });
        tone({ f0: 110, f1: 45, dur: 0.07, vol: 0.25 * th * sa, pan });
        return;
      }
      burst({ freq: f * far * (alt ? 0.8 : 1), dur: d * (1 + dist / 70), vol: 0.85 * att, pan, q: 0.5 });
      burst({ freq: 5500, type: 'highpass', dur: 0.05, vol: 0.35 * att * far * far, pan });
      tone({ f0: alt ? 140 : 170, f1: 38, dur: 0.1 + th * 0.12, vol: th * att * 0.9, pan });
      if (dist > 25) burst({ freq: 700, dur: 0.6, vol: 0.12 * att, pan: -pan * 0.5, delay: 0.18 + Math.random() * 0.15 });
    },
    click() { burst({ freq: 3500, type: 'bandpass', q: 3, dur: 0.03, vol: 0.25 }); },
    reload(dur) {
      burst({ freq: 2200, type: 'bandpass', q: 4, dur: 0.05, vol: 0.3, delay: 0.15 });
      burst({ freq: 1500, type: 'bandpass', q: 4, dur: 0.07, vol: 0.35, delay: dur * 0.55 });
      burst({ freq: 2600, type: 'bandpass', q: 5, dur: 0.05, vol: 0.35, delay: dur * 0.85 });
    },
    hit(head) { tone({ f0: head ? 1900 : 1500, dur: 0.06, vol: 0.18, type: 'triangle' }); if (head) tone({ f0: 2600, dur: 0.25, vol: 0.12, delay: 0.03 }); },
    kill() { tone({ f0: 880, dur: 0.12, vol: 0.18, type: 'square' }); tone({ f0: 1320, dur: 0.2, vol: 0.15, type: 'square', delay: 0.08 }); },
    boom(dist, pan) {
      const att = 1 / (1 + dist / 20);
      burst({ freq: 900 * clamp(1 - dist / 150, 0.3, 1), dur: 1.6, vol: 1.0 * att, pan, q: 0.4 });
      tone({ f0: 90, f1: 25, dur: 0.9, vol: 1.0 * att, pan });
      burst({ freq: 300, dur: 2.5, vol: 0.3 * att, delay: 0.25 });
    },
    hurt() { tone({ f0: 120, f1: 60, dur: 0.18, vol: 0.4 }); burst({ freq: 500, dur: 0.12, vol: 0.25 }); },
    step(vol = 0.08, pan = 0) { burst({ freq: 420 + Math.random() * 200, dur: 0.07, vol, pan, q: 0.8 }); },
    whiz(pan) { burst({ freq: 2400, type: 'bandpass', q: 2, dur: 0.12, vol: 0.18, pan }); },
    throwNade() { burst({ freq: 800, type: 'bandpass', q: 1, dur: 0.15, vol: 0.15 }); },
  };
})();

function spatial(pos) {
  const dx = pos.x - camera.position.x, dy = pos.y - camera.position.y, dz = pos.z - camera.position.z;
  const dist = Math.hypot(dx, dy, dz) || 1;
  const pan = clamp((dx * Math.cos(me.yaw) - dz * Math.sin(me.yaw)) / dist, -1, 1) * 0.85;
  return [dist, pan];
}

// ---------- Physics ----------
const near = [];
function gatherNear() {
  near.length = 0;
  const x = me.pos.x, y = me.pos.y, z = me.pos.z, m = 3;
  for (const b of C.MAP.solids) {
    if (b.max[0] > x - m && b.min[0] < x + m && b.max[2] > z - m && b.min[2] < z + m && b.max[1] > y - m && b.min[1] < y + 4) near.push(b);
  }
}
function hitAt(x, y, z, h) {
  const r = P.radius;
  let top = null;
  for (const b of near) {
    if (x + r > b.min[0] && x - r < b.max[0] && z + r > b.min[2] && z - r < b.max[2] && y + h > b.min[1] && y < b.max[1]) {
      if (top === null || b.max[1] > top) top = b.max[1];
    }
  }
  return top;
}
function physics(dt) {
  gatherNear();
  const h = me.crouch ? P.crouchHeight : P.height;
  me.vel.y = Math.max(-40, me.vel.y - P.gravity * dt);
  const dx = me.vel.x * dt, dy = me.vel.y * dt, dz = me.vel.z * dt;
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) / 0.05));
  const wasGround = me.onGround;
  let grounded = false, bx = false, bz = false, by = false;
  const fallSpeed = me.vel.y;
  for (let i = 0; i < n; i++) {
    for (const ax of ['x', 'z']) {
      if (ax === 'x' ? bx : bz) continue;
      const d = (ax === 'x' ? dx : dz) / n;
      if (!d) continue;
      const nx = me.pos.x + (ax === 'x' ? d : 0), nz = me.pos.z + (ax === 'z' ? d : 0);
      const top = hitAt(nx, me.pos.y, nz, h);
      if (top === null) { me.pos[ax] += d; continue; }
      if ((wasGround || grounded) && top - me.pos.y <= P.step && hitAt(nx, top + 0.001, nz, h) === null) {
        me.stepOff -= top + 0.001 - me.pos.y;
        me.pos.y = top + 0.001; me.pos[ax] += d;
        continue;
      }
      me.vel[ax] = 0;
      if (ax === 'x') bx = true; else bz = true;
    }
    if (by) continue;
    const ny = me.pos.y + dy / n;
    if (ny <= 0) { me.pos.y = 0; me.vel.y = 0; grounded = true; by = true; continue; }
    const top = hitAt(me.pos.x, ny, me.pos.z, h);
    if (top === null) me.pos.y = ny;
    else if (dy < 0) { if (top <= me.pos.y + 0.01) me.pos.y = top; me.vel.y = 0; grounded = true; by = true; }
    else { me.vel.y = 0; by = true; }
  }
  me.onGround = grounded;
  if (grounded && !wasGround && fallSpeed < -7) { audio.step(0.25); me.kick += 0.4; }
}
function toggleCrouch() {
  if (!me.crouch) { me.crouch = true; return; }
  gatherNear();
  if (hitAt(me.pos.x, me.pos.y, me.pos.z, P.height) === null) me.crouch = false;
}

// ---------- Weapons ----------
function refill() {
  me.ammo = {};
  for (const k of [me.primary, 'pistol']) { const W = stats(k); me.ammo[k] = { mag: W.mag, res: W.reserve }; }
  me.nades = P.nades;
}
function startReload() {
  const k = curKey(), W = stats(k), a = me.ammo[k], now = performance.now();
  if (!me.alive || me.reloadEnd || !a || a.mag >= W.mag || a.res <= 0 || now < me.switchEnd) return;
  me.reloadEnd = now + W.reload * 1000; me.reloadKey = k;
  audio.reload(W.reload);
}
function finishReload() {
  const k = me.reloadKey, W = stats(k), a = me.ammo[k];
  me.reloadEnd = 0;
  if (!a || k !== curKey()) return;
  const take = Math.min(W.mag - a.mag, a.res);
  a.mag += take; a.res -= take;
}
function switchTo(slot) {
  if (slot === me.slot || !me.alive) return;
  me.slot = slot; me.reloadEnd = 0;
  me.switchEnd = performance.now() + 420;
  buildViewmodel();
  audio.click();
}
const camFwd = new THREE.Vector3(), camRight = new THREE.Vector3(), camUp = new THREE.Vector3();
function camBasis() {
  camera.updateMatrixWorld();
  camera.getWorldDirection(camFwd);
  camRight.setFromMatrixColumn(camera.matrixWorld, 0);
  camUp.setFromMatrixColumn(camera.matrixWorld, 1);
}
function castRay(o, d, maxDist) {
  const oa = [o.x, o.y, o.z], da = [d.x, d.y, d.z];
  let best = maxDist, box = null, player = null, head = false;
  for (const b of C.MAP.solids) { const t = C.rayBox(oa, da, b.min, b.max); if (t >= 0 && t < best) { best = t; box = b; } }
  for (const r of remotes.values()) {
    if (!r.alive) continue;
    const hb = C.hitboxes(r.pos.x, r.pos.y, r.pos.z, r.crouch);
    let t = C.rayBox(oa, da, hb.head.min, hb.head.max);
    if (t >= 0 && t < best) { best = t; player = r; head = true; box = null; }
    t = C.rayBox(oa, da, hb.body.min, hb.body.max);
    if (t >= 0 && t < best) { best = t; player = r; head = false; box = null; }
  }
  return { t: best, box, player, head };
}
function boxNormal(b, p) {
  const e = 0.03;
  if (Math.abs(p.x - b.min[0]) < e) return _v2.set(-1, 0, 0);
  if (Math.abs(p.x - b.max[0]) < e) return _v2.set(1, 0, 0);
  if (Math.abs(p.z - b.min[2]) < e) return _v2.set(0, 0, -1);
  if (Math.abs(p.z - b.max[2]) < e) return _v2.set(0, 0, 1);
  if (Math.abs(p.y - b.max[1]) < e) return _v2.set(0, 1, 0);
  return _v2.set(0, -1, 0);
}
function currentSpread(W) {
  const moveAmt = clamp(Math.hypot(me.vel.x, me.vel.z) / P.walk, 0, 1.5);
  let s = THREE.MathUtils.lerp(W.spread, W.adsSpread, me.ads) + W.moveSpread * moveAmt * (1 - me.ads * 0.7) + me.bloom;
  if (!me.onGround) s += 0.05;
  if (me.crouch) s *= 0.75;
  return s;
}
function tryFire(now) {
  const key = curKey(), W = stats(key), a = me.ammo[key];
  if (!a || now < me.switchEnd || me.reloadEnd || now < me.nextFire || now - me.throwAt < 450) return;
  if (me.sprinting) { me.sprinting = false; return; }
  if (a.mag <= 0) {
    audio.click(); me.nextFire = now + 300;
    if (a.res > 0) startReload();
    if (!W.auto) mouse.fire = false;
    return;
  }
  me.nextFire = now + W.interval;
  a.mag--;
  if (!W.auto) mouse.fire = false;
  camBasis();
  const origin = camera.position.clone();
  const spread = currentSpread(W);
  const hits = [], ends = [];
  const muzzle = _v.copy(camRight).multiplyScalar(0.18 * (1 - me.ads)).addScaledVector(camUp, -0.12).addScaledVector(camFwd, 0.6).add(origin).clone();
  for (let i = 0; i < W.pellets; i++) {
    const r = spread * Math.sqrt(Math.random()), ang = Math.random() * Math.PI * 2;
    const dir = camFwd.clone().addScaledVector(camRight, Math.cos(ang) * r).addScaledVector(camUp, Math.sin(ang) * r).normalize();
    const res = castRay(origin, dir, W.range);
    const end = origin.clone().addScaledVector(dir, res.t);
    ends.push([r2(end.x), r2(end.y), r2(end.z)]);
    if (res.player) {
      if (res.player.team !== me.team) { hits.push([res.player.id, res.head ? 1 : 0]); puff(end, 0x8a1010, 3, 1.2, 0.18, 0.35); }
    } else if (res.box) {
      puff(end, 0xcdb48a, 2, 1.2, 0.22, 0.6);
      if (res.t < 120) addDecal(end, boxNormal(res.box, end));
    }
    if (i === 0 || i % 3 === 0) addTracer(muzzle, end);
  }
  send({ t: 'fire', w: WKEYS.indexOf(key), o: [r2(origin.x), r2(origin.y), r2(origin.z)], e: ends, hits });
  // feel
  const k = W.recoil * (me.ads > 0.5 ? 0.65 : 1) * (0.8 + Math.random() * 0.4) * (me.crouch ? 0.8 : 1);
  me.pitch = clamp(me.pitch + k * 0.45, -1.54, 1.54);
  me.recoil += k * 0.55;
  me.yaw += (Math.random() - 0.5) * k * 0.6;
  me.bloom = Math.min(0.06, me.bloom + W.bloom);
  me.kick = Math.min(1.5, me.kick + (key === 'sniper' || key === 'shotgun' ? 1.2 : 0.5));
  vmFlash.visible = !W.suppressed; vmFlash.material.rotation = Math.random() * 6; me.flashUntil = now + 45;
  flashLight.position.copy(muzzle); flashLight.intensity = W.suppressed ? 0.3 : 3;
  audio.gun(key, 0, 0, me.team === 2, W.suppressed);
  if (a.mag === 0 && a.res > 0) setTimeout(startReload, 250);
}
function throwNade() {
  const now = performance.now();
  if (!me.alive || me.nades <= 0 || now < me.nadeCd || me.reloadEnd) return;
  me.nades--; me.nadeCd = now + 1000; me.throwAt = now;
  camBasis();
  const o = camera.position.clone().addScaledVector(camFwd, 0.4);
  const v = camFwd.clone().multiplyScalar(17).add(new THREE.Vector3(me.vel.x * 0.4, 3.5, me.vel.z * 0.4));
  send({ t: 'nade', o: [r2(o.x), r2(o.y), r2(o.z)], v: [r2(v.x), r2(v.y), r2(v.z)] });
  audio.throwNade();
}

// ---------- Local update ----------
function updateLocal(dt, now) {
  if (!me.alive) return;
  const W = stats(curKey());
  const fwd = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0), str = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  const sin = Math.sin(me.yaw), cos = Math.cos(me.yaw);
  let wx = -sin * fwd + cos * str, wz = -cos * fwd - sin * str;
  const wl = Math.hypot(wx, wz);
  if (wl > 0) { wx /= wl; wz /= wl; }
  const shift = keys.ShiftLeft || keys.ShiftRight;
  if (shift && fwd > 0 && me.crouch) toggleCrouch();
  me.sprinting = !!shift && fwd > 0 && !me.crouch && me.ads < 0.3 && !mouse.fire && phase === 'playing';
  let speed = me.crouch ? P.crouchSpeed : me.sprinting ? P.sprint : P.walk;
  speed *= 1 - 0.45 * me.ads;
  if (phase !== 'playing') speed = 0;
  const accel = me.onGround ? 14 : 2.5;
  me.vel.x += (wx * speed - me.vel.x) * Math.min(1, accel * dt);
  me.vel.z += (wz * speed - me.vel.z) * Math.min(1, accel * dt);
  if (jumpQueued && me.onGround && phase === 'playing') {
    if (me.crouch) toggleCrouch();
    if (!me.crouch) { me.vel.y = P.jump; me.onGround = false; }
  }
  jumpQueued = false;
  physics(dt);
  const hs = Math.hypot(me.vel.x, me.vel.z);
  me.moving = hs > 0.5;
  if (me.onGround && me.moving) {
    me.bob += dt * hs * 1.9;
    me.stepAcc += hs * dt;
    if (me.stepAcc > (me.sprinting ? 2.3 : 1.9)) { me.stepAcc = 0; if (!me.crouch) audio.step(me.sprinting ? 0.09 : 0.06); }
  }
  me.eyeH += ((me.crouch ? P.crouchEye : P.eye) - me.eyeH) * Math.min(1, 12 * dt);
  me.stepOff *= Math.exp(-14 * dt);
  const wantAds = mouse.ads && !me.reloadEnd && now > me.switchEnd && !me.sprinting && phase === 'playing';
  me.ads += ((wantAds ? 1 : 0) - me.ads) * Math.min(1, dt * (wantAds ? 11 : 14) * W.adsSpeed);
  me.sprint += ((me.sprinting ? 1 : 0) - me.sprint) * Math.min(1, dt * 8);
  if (mouse.fire && phase === 'playing') tryFire(now);
  if (me.reloadEnd && now >= me.reloadEnd) finishReload();
  me.bloom *= Math.exp(-5 * dt);
  me.recoil *= Math.exp(-9 * dt);
  me.kick *= Math.exp(-12 * dt);
  if (me.flashUntil && now > me.flashUntil) { vmFlash.visible = false; me.flashUntil = 0; }
  void W;
}

function updateCamera(dt, now) {
  if (state !== 'game') {
    const t = now * 0.00004;
    camera.position.set(Math.sin(t) * 62, 26, Math.cos(t) * 62);
    camera.lookAt(0, 3, 0);
    camera.fov = 60; camera.updateProjectionMatrix();
    return;
  }
  if (me.alive) {
    camera.position.set(me.pos.x, me.pos.y + me.eyeH + me.stepOff, me.pos.z);
    camera.rotation.set(me.pitch + me.recoil, me.yaw, 0);
  } else {
    // death cam: drop low and turn toward whoever killed you
    const t = clamp((now - me.deathAt) / 900, 0, 1);
    camera.position.set(me.pos.x, me.pos.y + THREE.MathUtils.lerp(me.eyeH, 0.45, t), me.pos.z);
    const killer = remotes.get(me.killerId);
    if (killer) {
      const want = Math.atan2(-(killer.pos.x - me.pos.x), -(killer.pos.z - me.pos.z));
      me.yaw += angDiff(me.yaw, want) * Math.min(1, dt * 3);
      me.pitch += (0.05 - me.pitch) * Math.min(1, dt * 3);
    }
    camera.rotation.set(me.pitch, me.yaw, 0.35 * t);
  }
  const W = stats(curKey());
  const base = settings.fov;
  const target = THREE.MathUtils.lerp(base, W.scope ? W.adsFov : base * (W.adsFov / 75), me.ads) + me.sprint * 4;
  if (Math.abs(camera.fov - target) > 0.01) { camera.fov = target; camera.updateProjectionMatrix(); }
}

function updateViewmodel(dt, now) {
  const key = curKey();
  const scope = stats(key).scope;
  const scoped = scope && me.ads > 0.85;
  vm.visible = state === 'game' && me.alive && !scoped;
  $('scope').classList.toggle('hidden', !(state === 'game' && me.alive && scoped));
  $('scope').classList.toggle('acog', scope === 'acog');
  if (!vm.visible || !vmGun) return;
  const p = vm.position.copy(vmHip).lerp(vmAds, me.ads);
  const moveAmt = clamp(Math.hypot(me.vel.x, me.vel.z) / P.walk, 0, 1.5) * (me.onGround ? 1 : 0.2);
  const bobA = (1 - me.ads * 0.85) * moveAmt;
  p.x += Math.sin(me.bob) * 0.011 * bobA;
  p.y += -Math.abs(Math.cos(me.bob)) * 0.009 * bobA;
  sway.x *= Math.exp(-10 * dt); sway.y *= Math.exp(-10 * dt);
  let rx = clamp(sway.y * 0.0012, -0.08, 0.08) * (1 - me.ads * 0.7), ry = clamp(sway.x * 0.0012, -0.08, 0.08) * (1 - me.ads * 0.7), rz = 0;
  p.z += me.kick * 0.035; rx += me.kick * 0.05;
  p.y -= me.sprint * 0.04; p.x -= me.sprint * 0.03; ry += me.sprint * 0.55; rx -= me.sprint * 0.2;
  if (me.reloadEnd) {
    const W = stats(me.reloadKey);
    const t = 1 - (me.reloadEnd - now) / (W.reload * 1000), dip = Math.sin(clamp(t, 0, 1) * Math.PI);
    p.y -= 0.1 * dip; rx -= 0.5 * dip; rz += 0.45 * dip;
  }
  if (now < me.switchEnd) { const t = (me.switchEnd - now) / 420; p.y -= 0.25 * t; rx -= 0.6 * t; }
  if (now - me.throwAt < 500) { const t = Math.sin(((now - me.throwAt) / 500) * Math.PI); p.y -= 0.2 * t; rx -= 0.4 * t; }
  if (key === 'sniper' && now < me.nextFire && now > me.nextFire - C.WEAPONS.sniper.interval + 200) {
    const t = Math.sin(((now - (me.nextFire - C.WEAPONS.sniper.interval + 200)) / (C.WEAPONS.sniper.interval - 200)) * Math.PI);
    rz -= 0.25 * t; p.y -= 0.02 * t;
  }
  vm.rotation.set(rx, ry, rz);
  for (const r of vmGun.userData.reticles) r.visible = me.ads > 0.5;
  if (vmGun.userData.laserBeam) vmGun.userData.laserBeam.visible = me.sprint < 0.3 && me.ads < 0.9;
  vmCam.aspect = camera.aspect; vmCam.updateProjectionMatrix();
}

// ---------- Remote players ----------
function remoteWeaponKey(w) { return WKEYS[w] || 'rifle'; }
function getRemote(id) {
  let r = remotes.get(id);
  if (r) return r;
  const info = roster.get(id);
  r = { id, team: info ? info.team : 1, pos: new THREE.Vector3(), target: new THREE.Vector3(), ry: 0, tRy: 0, rx: 0, crouch: 0, w: 0,
    alive: false, hp: 100, moving: 0, phase: 0, amt: 0, dyingAt: 0, spotted: 0, model: null, tag: null, last: new THREE.Vector3(), fresh: true };
  remotes.set(id, r);
  buildRemoteModel(r);
  return r;
}
function remoteAtt(r, key) {
  const info = roster.get(r.id);
  if (!info) return null;
  return key === 'pistol' ? info.ap || null : key === info.pr ? info.at || null : null;
}
function buildRemoteModel(r) {
  if (r.model) scene.remove(r.model.root);
  const key = remoteWeaponKey(r.w), att = remoteAtt(r, key);
  r.model = buildSoldier(r.team, r.id, key, att);
  r.model.attKey = key + JSON.stringify(att);
  r.model.root.position.copy(r.pos);
  r.model.root.rotation.y = r.ry;
  scene.add(r.model.root);
  const info = roster.get(r.id);
  if (r.team === me.team && info) {
    r.tag = nameSprite(info.name, C.TEAMS[r.team].color);
    r.tag.position.y = 2.25;
    r.model.root.add(r.tag);
  } else r.tag = null;
  r.model.root.visible = r.alive;
}
function removeRemote(r) { if (r.model) scene.remove(r.model.root); remotes.delete(r.id); }
function updateRemotes(dt, now) {
  for (const r of remotes.values()) {
    const m = r.model;
    if (!m) continue;
    if (!r.alive) {
      if (r.dyingAt) {
        const t = clamp((now - r.dyingAt) / 450, 0, 1);
        m.root.rotation.x = -t * t * (Math.PI / 2) * 0.95;
        if (now - r.dyingAt > 3500) { m.root.visible = false; r.dyingAt = 0; }
      } else m.root.visible = false;
      continue;
    }
    m.root.visible = true;
    m.root.rotation.x = 0;
    r.last.copy(r.pos);
    r.pos.lerp(r.target, 1 - Math.exp(-dt * 16));
    r.ry += angDiff(r.ry, r.tRy) * Math.min(1, dt * 16);
    const sp = Math.hypot(r.pos.x - r.last.x, r.pos.z - r.last.z) / Math.max(dt, 1e-4);
    r.amt += ((sp > 0.3 ? clamp(sp / 5, 0.3, 1) : 0) - r.amt) * Math.min(1, dt * 8);
    r.phase += dt * sp * 1.6;
    m.root.position.copy(r.pos);
    m.root.rotation.y = r.ry;
    poseSoldier(m, r.phase, r.amt, !!r.crouch, r.rx);
    const key = remoteWeaponKey(r.w);
    if (key + JSON.stringify(remoteAtt(r, key)) !== m.attKey) buildRemoteModel(r);
  }
}
function remoteMuzzle(r) {
  r.model.root.updateMatrixWorld(true);
  return r.model.tip.getWorldPosition(new THREE.Vector3());
}

function updateNadeMeshes(dt) {
  for (const n of nadeMeshes.values()) n.mesh.position.lerp(n.target, 1 - Math.exp(-dt * 18));
}
const nadeGeo = new THREE.SphereGeometry(0.07, 8, 6);
const nadeMat = new THREE.MeshLambertMaterial({ color: 0x3f4a2c });

function explosion(p) {
  const pos = new THREE.Vector3(p[0], p[1] + 0.3, p[2]);
  for (let i = 0; i < 10; i++) {
    _v.set((Math.random() - 0.5) * 8, Math.random() * 6, (Math.random() - 0.5) * 8);
    spawnParticle(pos, _v, 0xffa040, 1.2, 2.5, 0.35, 1, true);
  }
  for (let i = 0; i < 16; i++) {
    _v.set((Math.random() - 0.5) * 6, 1 + Math.random() * 4, (Math.random() - 0.5) * 6);
    spawnParticle(pos, _v, i % 2 ? 0x5a4c3c : 0xb9a17a, 1.2, 4, 2.2 + Math.random(), 0.75);
  }
  for (let i = 0; i < 14; i++) {
    _v.set((Math.random() - 0.5) * 14, 4 + Math.random() * 8, (Math.random() - 0.5) * 14);
    spawnParticle(pos, _v, 0x2b2620, 0.12, 0, 1.2, 1, false, 18);
  }
  boomLight.position.copy(pos); boomLight.intensity = 60;
  const [dist, pan] = spatial(pos);
  audio.boom(dist, pan);
  if (dist < 14) { me.kick += (14 - dist) * 0.12; shake = Math.max(shake, (14 - dist) / 14); }
  if (dist < 6) flashScreen(0.35);
}
let shake = 0;

// ---------- Network messages ----------
let debugFreeze = false;
function onMessage(m) {
  const now = performance.now();
  if (debugFreeze && (m.t === 'snap' || m.t === 'tp' || m.t === 'shot')) return;
  switch (m.t) {
    case 'welcome':
      myId = m.id; me.team = m.team; phase = m.ph; scores = m.sc; timeLeft = m.tl; timeAt = now;
      enterGame();
      break;
    case 'full':
      showMsg('Server full', 'This match has no free slots right now.');
      break;
    case 'roster': {
      const seen = new Set();
      for (const p of m.pl) {
        roster.set(p.id, p); seen.add(p.id);
        if (p.id === myId && p.team !== me.team) { me.team = p.team; buildViewmodel(); for (const r of remotes.values()) buildRemoteModel(r); }
      }
      for (const id of [...roster.keys()]) if (!seen.has(id)) roster.delete(id);
      for (const r of [...remotes.values()]) {
        const info = roster.get(r.id);
        if (!info) { removeRemote(r); continue; }
        const wantTag = info.team === me.team;
        if (info.team !== r.team || wantTag !== !!r.tag) { r.team = info.team; buildRemoteModel(r); }
      }
      if (!$('scoreboard').classList.contains('hidden')) renderScoreboard();
      break;
    }
    case 'snap': {
      scores = m.sc; timeLeft = m.tl; timeAt = now; phase = m.ph;
      for (const e of m.ps) {
        const [id, x, y, z, ry, rx, c, w, alive, hp, moving] = e;
        if (id === myId) { me.hp = hp; continue; }
        const r = getRemote(id);
        const wasAlive = r.alive;
        r.target.set(x, y, z); r.tRy = ry; r.rx = rx; r.crouch = c; r.w = w; r.hp = hp; r.moving = moving;
        r.alive = !!alive;
        if ((r.alive && !wasAlive) || r.fresh) { r.pos.set(x, y, z); r.ry = ry; r.dyingAt = 0; r.fresh = false; }
      }
      const seen = new Set();
      for (const [id, x, y, z] of m.g) {
        seen.add(id);
        let n = nadeMeshes.get(id);
        if (!n) { n = { mesh: new THREE.Mesh(nadeGeo, nadeMat), target: new THREE.Vector3(x, y, z) }; n.mesh.position.set(x, y, z); n.mesh.castShadow = true; scene.add(n.mesh); nadeMeshes.set(id, n); }
        n.target.set(x, y, z);
      }
      for (const [id, n] of nadeMeshes) if (!seen.has(id)) { scene.remove(n.mesh); nadeMeshes.delete(id); }
      break;
    }
    case 'spawn':
      me.pos.set(m.p[0], m.p[1], m.p[2]); me.vel.set(0, 0, 0);
      me.yaw = m.ry; me.pitch = 0; me.recoil = 0; me.alive = true; me.hp = 100; me.crouch = false;
      me.primary = m.primary || me.primary; me.slot = 0; me.reloadEnd = 0; me.nextFire = 0; me.ads = 0;
      me.spawnAt = now; me.switchEnd = now + 420; me.streak = 0;
      if (m.att) me.att = m.att;
      refill(); buildViewmodel();
      $('death').classList.add('hidden');
      break;
    case 'tp': me.pos.set(m.p[0], m.p[1], m.p[2]); me.vel.set(0, 0, 0); break;
    case 'shot': onShot(m, now); break;
    case 'dmg': {
      me.hp = m.hp;
      flashDamage(m.self ? 0.4 : 0.55);
      audio.hurt();
      if (!m.self) addDamageArc(m.from);
      break;
    }
    case 'hm': {
      const hm = $('hitmarker');
      hm.className = m.k ? 'kill' : m.h ? 'head' : '';
      hm.style.opacity = 1;
      clearTimeout(hm._t); hm._t = setTimeout(() => (hm.style.opacity = 0), m.k ? 300 : 120);
      audio.hit(!!m.h);
      break;
    }
    case 'kill': onKill(m, now); break;
    case 'boom': explosion(m.p); break;
    case 'chat': addChat(m.id, m.m); break;
    case 'left': { const r = remotes.get(m.id); if (r) removeRemote(r); break; }
    case 'end': {
      endAt = now + C.MATCH.endPause;
      const res = m.win === 0 ? 'DRAW' : m.win === me.team ? 'VICTORY' : 'DEFEAT';
      $('endRes').textContent = res;
      $('endRes').style.color = res === 'VICTORY' ? '#8fd16a' : res === 'DEFEAT' ? '#ff6a55' : '#e8d5ae';
      $('endWrap').innerHTML = teamTable(1) + teamTable(2);
      $('endScreen').classList.remove('hidden');
      if (res === 'VICTORY') steamAchievement('WIN_MATCH');
      break;
    }
    case 'start': $('endScreen').classList.add('hidden'); break;
    case 'pong': pingMs = Math.round(performance.now() - m.c); break;
  }
}

function onShot(m, now) {
  const r = remotes.get(m.id);
  if (!r || !r.model) return;
  const key = remoteWeaponKey(m.w);
  const muzzle = remoteMuzzle(r);
  const ends = Array.isArray(m.e) && Array.isArray(m.e[0]) ? m.e : m.e ? [m.e] : [];
  let whizzed = false;
  for (let i = 0; i < ends.length; i++) {
    const end = new THREE.Vector3(ends[i][0], ends[i][1], ends[i][2]);
    if (i % 3 === 0) addTracer(muzzle, end);
    if (end.distanceTo(camera.position) > 1.5) puff(end, 0xcdb48a, 1, 1, 0.2, 0.5);
    if (!whizzed && me.alive && r.team !== me.team) {
      // near-miss crack when a bullet passes close to your head
      const ab = _v.copy(end).sub(muzzle), ap = _v2.copy(camera.position).sub(muzzle);
      const t = clamp(ap.dot(ab) / ab.lengthSq(), 0, 1);
      const d = ap.sub(ab.multiplyScalar(t)).length();
      if (d < 2 && t < 0.98) { audio.whiz(spatial(end)[1]); whizzed = true; }
    }
  }
  if (!m.s) muzzleFlash(muzzle, key === 'pistol' ? 0.35 : 0.6);
  const [dist, pan] = spatial(r.pos);
  audio.gun(key, dist, pan, r.team === 2, !!m.s);
  if (r.team !== me.team && !m.s) r.spotted = now + 2500;
}

function onKill(m, now) {
  const k = roster.get(m.k), v = roster.get(m.v);
  if (m.w === -1) { addChat(0, `${v ? v.name : 'Someone'} switched to ${teamName(v ? v.team : 0)}`); }
  else {
    const wkey = m.w === 4 ? 'nade' : WKEYS[m.w];
    addFeed(k, v, weaponName(wkey, k ? k.team : 1), m.h, m.k === myId || m.v === myId, m.k === m.v);
  }
  if (m.v === myId) {
    me.alive = false; me.deathAt = now; me.killerId = m.k; mouse.fire = false;
    vmFlash.visible = false;
    $('deathBy').textContent = m.k === m.v ? 'Yourself' : k ? k.name : 'Unknown';
    $('deathBy').className = 'n c' + (m.k === m.v ? 0 : k ? k.team : 0);
    $('deathW').textContent = m.w === -1 ? 'Team switch' : (m.w === 4 ? 'Grenade' : weaponName(WKEYS[m.w], k ? k.team : 1)) + (m.h ? ' · Headshot' : '');
    $('death').classList.remove('hidden');
  } else {
    const r = remotes.get(m.v);
    if (r) { r.alive = false; r.dyingAt = now; }
  }
  if (m.k === myId && m.v !== myId && m.w !== -1) {
    me.streak++;
    me.multi = now - me.lastKillAt < 4000 ? me.multi + 1 : 1;
    me.lastKillAt = now;
    const label = m.w === 4 ? 'GRENADE KILL' : m.h ? 'HEADSHOT' : 'ENEMY KILLED';
    centerMsg(label, m.h ? '+150' : '+100');
    if (me.multi === 2) centerMsg('DOUBLE KILL', '+50');
    else if (me.multi === 3) centerMsg('TRIPLE KILL', '+100');
    else if (me.multi >= 4) centerMsg('MULTI KILL', '+150');
    if (me.streak === 5) centerMsg('5 KILL STREAK', '');
    audio.kill();
    steamAchievement('FIRST_BLOOD');
    if (m.h) steamAchievement('HEADSHOT');
    if (m.w === 4) steamAchievement('GRENADIER');
  }
}

// ---------- HUD ----------
const hudCache = {};
function setText(id, text) { if (hudCache[id] !== text) { hudCache[id] = text; $(id).textContent = text; } }
function setHTML(id, html) { if (hudCache[id] !== html) { hudCache[id] = html; $(id).innerHTML = html; } }
let fpsAcc = 0, fpsN = 0, fpsShown = 0;
function updateHUD(dt, now) {
  const hp = Math.max(0, Math.ceil(me.hp));
  setText('hpNum', String(hp));
  $('hpBar').style.width = hp + '%';
  $('health').classList.toggle('low', hp <= 35);
  const key = curKey(), W = stats(key), a = me.ammo[key] || { mag: 0, res: 0 };
  setText('wName', weaponName(key, me.team));
  setHTML('ammoCount', `${a.mag} <small>/ ${a.res}</small>`);
  $('ammoCount').classList.toggle('low', a.mag <= Math.ceil(W.mag * 0.25));
  setText('ammoHint', me.reloadEnd ? 'RELOADING' : a.mag === 0 && a.res === 0 ? 'NO AMMO' : a.mag <= Math.ceil(W.mag * 0.25) ? 'RELOAD [R]' : '');
  setText('nadeCount', 'GRENADES ' + ('● '.repeat(me.nades) + '○ '.repeat(Math.max(0, P.nades - me.nades))).trim());
  setText('sc1', String(scores[0])); setText('sc2', String(scores[1]));
  document.querySelector('#scorebar .s1').classList.toggle('mine', me.team === 1);
  document.querySelector('#scorebar .s2').classList.toggle('mine', me.team === 2);
  const tl = Math.max(0, timeLeft - (now - timeAt)), mins = Math.floor(tl / 60000), secs = Math.floor((tl % 60000) / 1000);
  setText('timer', `${mins}:${String(secs).padStart(2, '0')}`);
  // crosshair
  const spread = currentSpread(W);
  const px = Math.max(3, (spread / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * (innerHeight / 2));
  const ch = $('crosshair');
  const showCross = me.alive && me.ads < 0.5 && !me.sprinting;
  ch.style.display = showCross ? '' : 'none';
  if (showCross) {
    ch.children[0].style.transform = `translateY(${-px - 9}px)`;
    ch.children[1].style.transform = `translateY(${px}px)`;
    ch.children[2].style.transform = `translateX(${-px - 9}px)`;
    ch.children[3].style.transform = `translateX(${px}px)`;
  }
  $('protect').classList.toggle('hidden', !(me.alive && now - me.spawnAt < 1500));
  if (!me.alive) {
    const left = Math.max(0, Math.ceil((C.MATCH.respawnDelay - (now - me.deathAt)) / 1000));
    setText('deathTimer', left > 0 ? `Redeploying in ${left}` : 'Redeploying…');
  }
  if (!$('endScreen').classList.contains('hidden')) setText('endSub', `Next match in ${Math.max(0, Math.ceil((endAt - now) / 1000))}`);
  // vignette from low health
  const vg = $('vignette');
  vg._dmg = Math.max(0, (vg._dmg || 0) - dt * 1.4);
  vg.style.opacity = Math.max(vg._dmg, me.alive ? clamp((50 - hp) / 60, 0, 0.6) : 0);
  const fl = $('flash'); fl._v = Math.max(0, (fl._v || 0) - dt * 1.2); fl.style.opacity = fl._v;
  // damage arcs follow your view
  for (const el of [...$('dmgDirs').children]) {
    const age = now - el._t;
    if (age > 1600) { el.remove(); continue; }
    const want = Math.atan2(-(el._x - me.pos.x), -(el._z - me.pos.z));
    el.style.transform = `rotate(${-angDiff(me.yaw, want)}rad)`;
    el.style.opacity = 1 - age / 1600;
  }
  // grenade warning
  let closest = null, cd = 8;
  for (const n of nadeMeshes.values()) { const d = n.mesh.position.distanceTo(me.pos); if (d < cd) { cd = d; closest = n; } }
  $('nadeWarn').classList.toggle('hidden', !closest || !me.alive);
  if (closest) {
    const want = Math.atan2(-(closest.mesh.position.x - me.pos.x), -(closest.mesh.position.z - me.pos.z));
    $('nadeWarn').firstElementChild.style.transform = `rotate(${-angDiff(me.yaw, want)}rad)`;
  }
  // enemy name under crosshair
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { fpsShown = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
  setText('fps', `${fpsShown} FPS`);
  setText('ping', `${pingMs} ms`);
  drawMinimap(now);
}
function flashDamage(v) { const vg = $('vignette'); vg._dmg = Math.max(vg._dmg || 0, v); }
function flashScreen(v) { const f = $('flash'); f._v = Math.max(f._v || 0, v); }
function addDamageArc(from) {
  const el = document.createElement('div');
  el.className = 'arc'; el._t = performance.now(); el._x = from[0]; el._z = from[1];
  $('dmgDirs').appendChild(el);
  while ($('dmgDirs').children.length > 4) $('dmgDirs').firstChild.remove();
}
function centerMsg(big, pts) {
  const el = document.createElement('div');
  el.innerHTML = `<div class="big">${esc(big)}</div>${pts ? `<div class="pts">${esc(pts)}</div>` : ''}`;
  $('center').appendChild(el);
  setTimeout(() => el.remove(), 1700);
  while ($('center').children.length > 3) $('center').firstChild.remove();
}
function addFeed(k, v, wname, head, mine, suicide) {
  const el = document.createElement('div');
  if (mine) el.className = 'me';
  const kn = k ? `<span class="c${k.team}">${esc(k.name)}</span>` : '<span class="c0">?</span>';
  const vn = v ? `<span class="c${v.team}">${esc(v.name)}</span>` : '<span class="c0">?</span>';
  el.innerHTML = suicide ? `${vn}<span class="w">[${esc(wname)}]</span>` : `${kn}<span class="w">[${esc(wname)}${head ? ' · HS' : ''}]</span>${vn}`;
  $('killfeed').prepend(el);
  setTimeout(() => { el.style.opacity = 0; }, 5000);
  setTimeout(() => el.remove(), 5600);
  while ($('killfeed').children.length > 6) $('killfeed').lastChild.remove();
}
function addChat(id, text) {
  const p = roster.get(id);
  const el = document.createElement('div');
  el.innerHTML = id === 0 ? `<span class="c0">${esc(text)}</span>` : `<span class="c${p ? p.team : 0}">${esc(p ? p.name : '?')}:</span> ${esc(text)}`;
  $('chatLog').appendChild(el);
  setTimeout(() => el.classList.add('fade'), 8000);
  while ($('chatLog').children.length > 8) $('chatLog').firstChild.remove();
}
function teamTable(team) {
  const list = [...roster.values()].filter((p) => p.team === team).sort((a, b) => b.k - a.k || a.d - b.d);
  const rows = list.map((p) => `<tr class="${p.id === myId ? 'me' : ''}"><td class="${p.bot ? 'bot' : ''}">${esc(p.name)}</td><td class="n">${p.k}</td><td class="n">${p.d}</td></tr>`).join('');
  return `<div class="team-table t${team}"><h3><span>${teamName(team).toUpperCase()}</span><span>${scores[team - 1]}</span></h3><table><tr><th>Name</th><th class="n">K</th><th class="n">D</th></tr>${rows}</table></div>`;
}
function renderScoreboard() { $('sbWrap').innerHTML = teamTable(1) + teamTable(2); }

// minimap: pre-render the map once, then rotate it around the player every frame
const MM = (() => {
  const E = C.MAP.size + 2, s = 2.2, S = Math.ceil(2 * E * s);
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#7a6849'; g.fillRect(0, 0, S, S);
  g.fillStyle = '#665638';
  g.fillRect((-6 + E) * s, 0, 12 * s, S); g.fillRect(0, (-6 + E) * s, S, 12 * s);
  g.fillStyle = '#2f5d6e'; g.fillRect((C.MAP.quay + E) * s, 0, S, S);
  const solids = C.MAP.solids.filter((b) => !b.thin && b.mat !== 'sea' && b.mat !== 'tank').sort((a, b) => a.max[1] - b.max[1]);
  for (const b of solids) {
    const h = b.max[1];
    g.fillStyle = h > 5 ? '#241d14' : h > 2.5 ? '#3a3022' : '#52452f';
    g.fillRect((b.min[0] + E) * s, (b.min[2] + E) * s, Math.max(1, (b.max[0] - b.min[0]) * s), Math.max(1, (b.max[2] - b.min[2]) * s));
  }
  g.fillStyle = '#3a3022';
  for (const t of C.MAP.tanks) { g.beginPath(); g.arc((t.x + E) * s, (t.z + E) * s, t.r * s, 0, Math.PI * 2); g.fill(); }
  return { c, E, s, ctx: $('minimap').getContext('2d') };
})();
function drawMinimap(now) {
  const g = MM.ctx, R = 100, zoom = 1.1, k = MM.s * zoom;
  g.clearRect(0, 0, 200, 200);
  g.save();
  g.beginPath(); g.arc(R, R, R - 2, 0, Math.PI * 2); g.clip();
  g.translate(R, R); g.rotate(me.yaw); g.scale(zoom, zoom);
  g.drawImage(MM.c, -(me.pos.x + MM.E) * MM.s, -(me.pos.z + MM.E) * MM.s);
  g.restore();
  const cs = Math.cos(me.yaw), sn = Math.sin(me.yaw);
  const blip = (x, z, color, size) => {
    const dx = (x - me.pos.x) * k, dz = (z - me.pos.z) * k;
    const px = dx * cs - dz * sn, py = dx * sn + dz * cs;
    if (px * px + py * py > (R - 6) * (R - 6)) return;
    g.fillStyle = color; g.beginPath(); g.arc(R + px, R + py, size, 0, Math.PI * 2); g.fill();
  };
  for (const r of remotes.values()) {
    if (!r.alive) continue;
    if (r.team === me.team) blip(r.pos.x, r.pos.z, C.TEAMS[r.team].color, 4);
    else if (r.spotted > now) blip(r.pos.x, r.pos.z, '#ff3b30', 4.5);
  }
  g.fillStyle = '#fff'; g.beginPath(); g.moveTo(R, R - 8); g.lineTo(R + 5.5, R + 6); g.lineTo(R, R + 3); g.lineTo(R - 5.5, R + 6); g.closePath(); g.fill();
}

// ---------- Input ----------
function pauseVisible() { return !$('pause').classList.contains('hidden'); }
function lock() {
  try {
    const p = canvas.requestPointerLock({ unadjustedMovement: true });
    if (p && p.catch) p.catch(() => { const q = canvas.requestPointerLock(); if (q && q.catch) q.catch(() => toast('Click the game to resume')); });
  } catch { canvas.requestPointerLock(); }
}
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (locked) { $('pause').classList.add('hidden'); return; }
  for (const k in keys) keys[k] = false;
  mouse.fire = mouse.ads = false;
  if (state === 'game' && !chatOpen && $('msgBox').classList.contains('hidden')) showPause();
});
addEventListener('keydown', (e) => {
  if (state !== 'game') return;
  if (chatOpen) return;
  if (e.code === 'Tab') { e.preventDefault(); renderScoreboard(); $('scoreboard').classList.remove('hidden'); return; }
  if (!locked) return;
  if (e.code === 'Enter' || e.code === 'KeyT') { e.preventDefault(); openChat(); return; }
  keys[e.code] = true;
  if (e.repeat) return;
  switch (e.code) {
    case 'KeyR': startReload(); break;
    case 'Digit1': switchTo(0); break;
    case 'Digit2': switchTo(1); break;
    case 'KeyQ': switchTo(1 - me.slot); break;
    case 'KeyG': throwNade(); break;
    case 'KeyC': case 'ControlLeft': toggleCrouch(); break;
    case 'Space': jumpQueued = true; break;
  }
});
addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'Tab') $('scoreboard').classList.add('hidden');
});
addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouse.fire = mouse.ads = false; });
canvas.addEventListener('mousedown', (e) => {
  if (state !== 'game') return;
  if (!locked) { if (!pauseVisible()) lock(); return; }
  if (e.button === 0) mouse.fire = true;
  if (e.button === 2) mouse.ads = true;
});
addEventListener('mouseup', (e) => { if (e.button === 0) mouse.fire = false; if (e.button === 2) mouse.ads = false; });
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('mousemove', (e) => {
  if (!locked || state !== 'game' || !me.alive) return;
  if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return; // browser glitch spikes
  const k = 0.0022 * settings.sens * (camera.fov / settings.fov);
  me.yaw -= e.movementX * k;
  me.pitch = clamp(me.pitch - e.movementY * k, -1.54, 1.54);
  sway.x += e.movementX; sway.y += e.movementY;
});
addEventListener('wheel', () => { if (locked && state === 'game') switchTo(1 - me.slot); });

function openChat() {
  chatOpen = true;
  for (const k in keys) keys[k] = false;
  mouse.fire = false;
  $('chat').classList.add('open');
  const inp = $('chatInput'); inp.classList.remove('hidden'); inp.value = ''; inp.focus();
}
function closeChat() {
  chatOpen = false;
  $('chat').classList.remove('open');
  const inp = $('chatInput'); inp.classList.add('hidden'); inp.blur();
}
$('chatInput').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.code === 'Enter') { const v = e.target.value.trim(); if (v) send({ t: 'chat', m: v }); closeChat(); }
  else if (e.code === 'Escape') closeChat();
});

// ---------- Menus ----------
function toast(text) {
  const t = $('toast'); t.textContent = text; t.style.opacity = 1;
  clearTimeout(t._h); t._h = setTimeout(() => (t.style.opacity = 0), 2600);
}
function setStatus(t) { $('menuStatus').textContent = t || ''; }
function showMsg(title, text) {
  $('msgTitle').textContent = title; $('msgText').textContent = text;
  $('msgBox').classList.remove('hidden');
  if (document.pointerLockElement) document.exitPointerLock();
}
function showPause() { $('pause').classList.remove('hidden'); renderLoadout($('pauseLoadout')); renderGunsmith($('pauseGunsmith')); }

function renderLoadout(el) {
  el.innerHTML = C.PRIMARIES.map((k) => {
    const W = C.WEAPONS[k];
    return `<button data-w="${k}" class="${settings.primary === k ? 'on' : ''}">${W.label}<small>${W.names[1]} / ${W.names[2]}</small></button>`;
  }).join('');
  el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    settings.primary = b.dataset.w; saveSettings();
    document.querySelectorAll('[data-w]').forEach((x) => x.classList.toggle('on', x.dataset.w === settings.primary));
    renderGunsmith($('gunsmith')); renderGunsmith($('pauseGunsmith'));
    if (state === 'game') { send({ t: 'loadout', primary: settings.primary, att: settings.att }); toast('Loadout changes on your next spawn'); }
  }));
}
// Attachment picker for the chosen primary and the pistol.
function renderGunsmith(el) {
  if (!el) return;
  el.innerHTML = [settings.primary, 'pistol'].map((k) => {
    const W = C.WEAPONS[k], cur = settings.att[k];
    const rows = C.SLOTS.filter((sl) => W.allow[sl].length > 1).map((sl) => `<div class="gs-row"><span>${C.SLOT_LABELS[sl]}</span><div class="seg sm">${
      W.allow[sl].map((v) => `<button data-k="${k}" data-s="${sl}" data-v="${v}" class="${cur[sl] === v ? 'on' : ''}" title="${esc(C.ATTACH[sl][v].info)}">${esc(C.ATTACH[sl][v].label)}</button>`).join('')
    }</div></div>`).join('');
    const S = C.weaponStats(k, cur);
    const bits = [`Mag ${S.mag}`, `Recoil ${Math.round((S.recoil / W.recoil) * 100)}%`, `Hip spread ${Math.round((S.spread / W.spread) * 100)}%`];
    if (S.suppressed) bits.push('Suppressed');
    if (S.scope === 'acog') bits.push('4x zoom');
    return `<div class="gs-gun"><div class="gs-name">${W.label} <small>${W.names[1]} / ${W.names[2]}</small></div>${rows}<div class="gs-sum">${bits.join(' · ')}</div></div>`;
  }).join('');
  el.querySelectorAll('button[data-s]').forEach((b) => b.addEventListener('click', () => {
    settings.att[b.dataset.k][b.dataset.s] = b.dataset.v; saveSettings();
    renderGunsmith($('gunsmith')); renderGunsmith($('pauseGunsmith'));
    if (state === 'game') { send({ t: 'loadout', primary: settings.primary, att: settings.att }); toast('Attachments change on your next spawn'); }
  }));
}
function renderSettings(el) {
  el.innerHTML = `
    <div class="slider"><span>Sensitivity</span><input type="range" min="0.2" max="3" step="0.05" data-s="sens"><span></span></div>
    <div class="slider"><span>Field of view</span><input type="range" min="60" max="100" step="1" data-s="fov"><span></span></div>
    <div class="slider"><span>Volume</span><input type="range" min="0" max="1" step="0.05" data-s="volume"><span></span></div>
    <div class="slider"><span>Shadows</span><input type="checkbox" data-s="shadows" style="justify-self:start"><span></span></div>`;
  el.querySelectorAll('[data-s]').forEach((inp) => {
    const key = inp.dataset.s, out = inp.nextElementSibling;
    const show = () => { out.textContent = inp.type === 'checkbox' ? '' : key === 'volume' ? Math.round(settings[key] * 100) + '%' : String(settings[key]); };
    if (inp.type === 'checkbox') inp.checked = settings[key]; else inp.value = settings[key];
    show();
    inp.addEventListener('input', () => {
      settings[key] = inp.type === 'checkbox' ? inp.checked : parseFloat(inp.value);
      if (key === 'volume') audio.setVolume(settings.volume);
      if (key === 'shadows') sun.castShadow = settings.shadows;
      saveSettings(); show();
    });
  });
}

function initMenu() {
  $('nameInput').value = settings.name || 'Soldier' + Math.floor(100 + Math.random() * 900);
  $('nameInput').addEventListener('input', () => { settings.name = $('nameInput').value; saveSettings(); });
  const teamBtns = $('teamSeg').querySelectorAll('button');
  const syncTeam = () => teamBtns.forEach((b) => b.classList.toggle('on', +b.dataset.team === settings.team));
  teamBtns.forEach((b) => b.addEventListener('click', () => { settings.team = +b.dataset.team; saveSettings(); syncTeam(); }));
  syncTeam();
  renderLoadout($('loadoutSeg'));
  renderGunsmith($('gunsmith'));
  renderSettings($('menuSettings'));
  renderSettings($('pauseSettings'));
  $('btnDeploy').addEventListener('click', () => play('web'));
  $('btnResume').addEventListener('click', () => lock());
  $('btnLeave').addEventListener('click', () => leaveMatch());
  $('btnSwitchTeam').addEventListener('click', () => { send({ t: 'team', team: me.team === 1 ? 2 : 1 }); lock(); });
  $('btnInvite').addEventListener('click', () => {
    if (STEAM) STEAM.invite();
    else { navigator.clipboard?.writeText(location.href).catch(() => {}); toast('Link copied — friends on your network can open it to join'); }
  });
  $('msgOk').addEventListener('click', () => { $('msgBox').classList.add('hidden'); leaveMatch(); });

  if (STEAM) {
    $('webPlay').classList.add('hidden');
    $('steamPlay').classList.remove('hidden');
    $('botSlider').value = settings.bots; $('botVal').textContent = settings.bots;
    $('botSlider').addEventListener('input', () => { settings.bots = +$('botSlider').value; $('botVal').textContent = settings.bots; saveSettings(); });
    const visBtns = $('visSeg').querySelectorAll('button');
    const syncVis = () => visBtns.forEach((b) => b.classList.toggle('on', +b.dataset.vis === settings.vis));
    visBtns.forEach((b) => b.addEventListener('click', () => { settings.vis = +b.dataset.vis; saveSettings(); syncVis(); }));
    syncVis();
    $('btnHost').addEventListener('click', () => play('host'));
    $('btnOffline').addEventListener('click', () => play('offline'));
    $('btnDirect').addEventListener('click', () => { const a = $('addrInput').value.trim(); if (a) play('direct', a); });
    $('findPanel').addEventListener('toggle', () => { if ($('findPanel').open) refreshLobbies(); });
    $('btnRefresh').addEventListener('click', refreshLobbies);
    $('btnQuit').addEventListener('click', () => STEAM.quit());
    STEAM.onJoinRequest((lobbyId) => { if (state === 'game') leaveMatch(); play('join', lobbyId); });
    STEAM.info().then((info) => {
      const badge = $('steamBadge');
      badge.classList.remove('hidden');
      badge.classList.toggle('off', !info.available);
      badge.querySelector('span').textContent = info.available ? `Signed in to Steam as ${info.name}` : 'Steam not running — hosting, invites and server list are off (practice and direct connect still work)';
      if (info.available && (!settings.name || /^Soldier\d+$/.test(settings.name))) { settings.name = info.name.slice(0, 18); $('nameInput').value = settings.name; saveSettings(); }
      $('btnHost').disabled = !info.available;
      if (!info.available) $('btnHost').style.opacity = 0.4;
    });
  }
}

async function refreshLobbies() {
  const list = $('lobbyList');
  list.innerHTML = '<div class="note">Searching…</div>';
  try {
    const lobbies = await STEAM.findGames();
    if (!lobbies.length) { list.innerHTML = '<div class="note">No public games found. Host one, or ask a friend to invite you through Steam.</div>'; return; }
    list.innerHTML = lobbies.map((l) => `<div class="lob" data-id="${esc(l.id)}"><span>${esc(l.name)}</span><span class="note">${l.players}/${l.max}</span></div>`).join('');
    list.querySelectorAll('.lob').forEach((el) => el.addEventListener('click', () => play('join', el.dataset.id)));
  } catch (e) { list.innerHTML = `<div class="note">Could not search: ${esc(e.message || e)}</div>`; }
}

async function play(how, arg) {
  if (ws) return;
  audio.init();
  settings.name = $('nameInput').value.trim() || settings.name;
  saveSettings();
  setStatus(how === 'join' ? 'Joining game…' : 'Connecting…');
  let url;
  try {
    if (how === 'web') url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    else if (how === 'host') url = (await STEAM.hostGame({ visibility: settings.vis, bots: settings.bots })).url;
    else if (how === 'offline') url = (await STEAM.playOffline({ bots: settings.bots })).url;
    else if (how === 'join') url = (await STEAM.joinGame(String(arg))).url;
    else if (how === 'direct') url = 'ws://' + arg.replace(/^(wss?|https?):\/\//, '').replace(/\/.*$/, '');
  } catch (e) {
    setStatus('Could not start: ' + (e.message || e));
    return;
  }
  mode = how;
  connect(url);
}

function connect(url) {
  let opened = false;
  ws = new WebSocket(url);
  ws.onopen = () => { opened = true; send({ t: 'join', name: settings.name, team: settings.team, primary: settings.primary, att: settings.att }); };
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
  ws.onclose = () => {
    const wasInGame = state === 'game';
    ws = null;
    if (wasInGame) showMsg('Connection lost', 'The connection to the game server was closed.');
    else setStatus(opened ? 'Disconnected' : 'Could not connect to the server.');
    if (STEAM) STEAM.leaveGame();
  };
  lock();
}

function enterGame() {
  state = 'game';
  setStatus('');
  $('menu').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('endScreen').classList.add('hidden');
  if (!locked) lock();
  if (STEAM) STEAM.setStatus(`Playing Team Deathmatch on ${C.MAP.name}`);
}

function leaveMatch() {
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  if (STEAM) STEAM.leaveGame();
  state = 'menu'; mode = null; myId = 0; me.alive = false;
  for (const r of [...remotes.values()]) removeRemote(r);
  roster.clear();
  for (const n of nadeMeshes.values()) scene.remove(n.mesh);
  nadeMeshes.clear();
  for (const id of ['hud', 'death', 'pause', 'scoreboard', 'endScreen', 'msgBox']) $(id).classList.add('hidden');
  $('chatLog').innerHTML = ''; $('killfeed').innerHTML = ''; $('dmgDirs').innerHTML = '';
  $('menu').classList.remove('hidden');
  if (document.pointerLockElement) document.exitPointerLock();
  if (STEAM) STEAM.setStatus('In menus');
}

function steamAchievement(name) { if (STEAM) STEAM.achievement(name); }

// ---------- Main loop ----------
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
});

let lastT = performance.now(), sendAcc = 0, pingAcc = 0;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  step(dt, now);
}
function step(dt, now) {
  if (state === 'game') {
    updateLocal(dt, now);
    updateRemotes(dt, now);
    updateNadeMeshes(dt);
    sendAcc += dt; pingAcc += dt;
    if (sendAcc >= 0.05) {
      sendAcc = 0;
      if (me.alive) send({ t: 'st', p: [r2(me.pos.x), r2(me.pos.y), r2(me.pos.z)], ry: r3(me.yaw), rx: r3(me.pitch), c: me.crouch ? 1 : 0, w: WKEYS.indexOf(curKey()), m: me.moving ? 1 : 0 });
    }
    if (pingAcc > 2) { pingAcc = 0; send({ t: 'ping', c: performance.now() }); }
  }
  updateCamera(dt, now);
  if (shake > 0) {
    camera.rotation.x += (Math.random() - 0.5) * shake * 0.04;
    camera.rotation.y += (Math.random() - 0.5) * shake * 0.04;
    shake = Math.max(0, shake - dt * 2);
  }
  updateViewmodel(dt, now);
  if (state === 'game') updateHUD(dt, now);
  updateParticles(dt); updateTracers(dt); updateFlashes(dt);
  updateAmbient(dt, now / 1000);
  flashLight.intensity *= Math.exp(-dt * 40);
  boomLight.intensity *= Math.exp(-dt * 6);
  sun.target.position.set(Math.round(camera.position.x / 4) * 4, 0, Math.round(camera.position.z / 4) * 4);
  sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 160);
  sky.position.copy(camera.position);
  if (waterTex) { waterTex.offset.x = (now * 0.000004) % 1; waterTex.offset.y = (now * 0.0000025) % 1; }

  renderer.autoClear = true;
  renderer.render(scene, camera);
  if (vm.visible && state === 'game') {
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(vmScene, vmCam);
  }
}

buildWorld();
initMenu();
frame();
// debug/test hook (used by automated playtests; harmless in normal play)
window.__game = { me, remotes, roster, settings, scene, renderer, camera, keys, mouse, state: () => state, setLocked: (v) => { locked = v; }, freeze: (v) => { debugFreeze = v; },
  loadout: (team, primary, att, slot = 0) => { me.team = team; me.primary = primary; me.att = Object.assign({}, me.att, att); me.slot = slot; refill(); buildViewmodel(); me.switchEnd = 0; }, jump: () => { jumpQueued = true; },
  // run N simulated frames synchronously (rAF is paused while the page is hidden)
  advance: (sec, fps = 60) => { const t0 = performance.now(); for (let i = 0; i < sec * fps; i++) step(1 / fps, t0 + (i * 1000) / fps); lastT = performance.now(); } };
