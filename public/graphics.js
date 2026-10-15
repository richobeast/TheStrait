// Graphics upgrades: post-processing, HDRI sky + lighting, photo-scanned PBR materials and prop models.
// Everything here is optional: the game renders with its procedural look until these finish loading.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const ASSETS = '/assets';

// ---------- post-processing ----------
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, saturation: { value: 1.08 }, contrast: { value: 1.06 }, warmth: { value: 0.03 }, vignette: { value: 0.32 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float saturation, contrast, warmth, vignette; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(l), col, saturation);
      col = (col - 0.5) * contrast + 0.5;
      col *= vec3(1.0 + warmth, 1.0, 1.0 - warmth * 1.4);
      float d = distance(vUv, vec2(0.5));
      col *= 1.0 - vignette * smoothstep(0.3, 0.85, d);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
    }`,
};

export function createPost(renderer, scene, camera, vmScene, vmCam) {
  const w = innerWidth, h = innerHeight, pr = renderer.getPixelRatio();
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(pr);
  composer.setSize(w, h);
  const world = new RenderPass(scene, camera);
  const ao = new GTAOPass(scene, camera, w, h);
  ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.2, scale: 1.0, samples: 12 });
  ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
  ao.blendIntensity = 0.85;
  const viewmodel = new RenderPass(vmScene, vmCam);
  viewmodel.clear = false;
  viewmodel.clearDepth = true;
  const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.22, 0.45, 0.92);
  const output = new OutputPass();
  const grade = new ShaderPass(GradeShader);
  const smaa = new SMAAPass(w * pr, h * pr);
  for (const p of [world, ao, viewmodel, bloom, output, grade, smaa]) composer.addPass(p);
  return {
    composer, ao, viewmodel, bloom, smaa,
    setQuality(q) { ao.enabled = q === 'high'; bloom.enabled = q !== 'low'; smaa.enabled = q !== 'low'; },
    setSize(width, height) { composer.setSize(width, height); ao.setSize(width, height); },
  };
}

// ---------- HDRI sky ----------
// Loads the sky, builds image-based lighting from it, and finds the sun (brightest spot) and horizon colour.
export async function loadSky(renderer, file) {
  const tex = await new RGBELoader().setDataType(THREE.FloatType).loadAsync(`${ASSETS}/hdri/${file}`);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  const { data, width, height } = tex.image;
  let best = -1, bx = 0, by = 0;
  const hor = [0, 0, 0];
  let hn = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      const lum = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
      if (lum > best) { best = lum; bx = x; by = y; }
      // just above the horizon line: used for fog colour
      if (y > height * 0.44 && y < height * 0.48) { hor[0] += data[i]; hor[1] += data[i + 1]; hor[2] += data[i + 2]; hn++; }
    }
  }
  const u = (bx + 0.5) / width, v = 1 - (by + 0.5) / height; // flipY = true: row 0 is the top
  const lat = (v - 0.5) * Math.PI, lon = (u - 0.5) * Math.PI * 2;
  const sunDir = new THREE.Vector3(Math.cos(lon) * Math.cos(lat), Math.sin(lat), Math.sin(lon) * Math.cos(lat)).normalize();
  const pm = new THREE.PMREMGenerator(renderer);
  const env = pm.fromEquirectangular(tex).texture;
  pm.dispose();
  const horizon = new THREE.Color(hor[0] / hn, hor[1] / hn, hor[2] / hn);
  return { background: tex, env, sunDir, horizon };
}

// ---------- PBR materials ----------
const texLoader = new THREE.TextureLoader();
const texCache = new Map();
function loadTex(url, srgb, gray) {
  const key = url + (gray ? '|gray' : '');
  if (!texCache.has(key)) {
    texCache.set(key, texLoader.loadAsync(url).then((t) => {
      if (gray) {
        // turn a coloured texture neutral so it can be tinted (e.g. one container texture, five paint colours)
        const img = t.image, c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        const px = g.getImageData(0, 0, c.width, c.height);
        for (let i = 0; i < px.data.length; i += 4) {
          const l = px.data[i] * 0.3 + px.data[i + 1] * 0.59 + px.data[i + 2] * 0.11;
          const v = Math.min(255, 70 + l * 1.35);
          px.data[i] = px.data[i + 1] = px.data[i + 2] = v;
        }
        g.putImageData(px, 0, 0);
        t = new THREE.CanvasTexture(c);
      }
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    }));
  }
  return texCache.get(key);
}

// def: { id, tint, gray, rough, normalScale, metal }
export async function loadPBR(def) {
  const base = `${ASSETS}/textures/${def.id}`;
  const [map, normalMap, roughnessMap] = await Promise.all([
    loadTex(`${base}_diff.jpg`, true, def.gray), loadTex(`${base}_nor.jpg`, false), loadTex(`${base}_rough.jpg`, false),
  ]);
  return new THREE.MeshStandardMaterial({
    map, normalMap, roughnessMap, color: new THREE.Color(def.tint || 0xffffff),
    roughness: def.rough == null ? 1 : def.rough, metalness: def.metal || 0,
    normalScale: new THREE.Vector2(def.normalScale || 1, def.normalScale || 1),
  });
}

// Same material but with its own texture repeat (for big planes that don't use world-space UVs).
export function withRepeat(mat, rx, ry) {
  const m = mat.clone();
  for (const k of ['map', 'normalMap', 'roughnessMap']) {
    if (!m[k]) continue;
    m[k] = m[k].clone();
    m[k].needsUpdate = true;
    m[k].repeat.set(rx, ry);
  }
  return m;
}

// ---------- prop models ----------
const gltfLoader = new GLTFLoader();
// Loads a glTF and returns its meshes flattened into the model's own space plus its bounding box.
export async function loadProp(id) {
  const gltf = await gltfLoader.loadAsync(`${ASSETS}/models/${id}/${id}.gltf`);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    parts.push({ geometry: g, material: o.material });
  });
  const box = new THREE.Box3();
  for (const p of parts) { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox); }
  return { parts, box };
}

// Places a prop at each target {min, max} (stretched to fill it) or {x, y, z, s, rot} (uniform scale).
export function instanceProp(prop, targets) {
  const size = prop.box.getSize(new THREE.Vector3()), center = prop.box.getCenter(new THREE.Vector3());
  const mats = targets.map((t) => {
    const m = new THREE.Matrix4();
    if (t.min) {
      const sx = (t.max[0] - t.min[0]) / size.x, sy = (t.max[1] - t.min[1]) / size.y, sz = (t.max[2] - t.min[2]) / size.z;
      const rot = t.rot || 0;
      const pos = new THREE.Vector3((t.min[0] + t.max[0]) / 2, t.min[1], (t.min[2] + t.max[2]) / 2);
      m.compose(pos, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot), new THREE.Vector3(sx, sy, sz));
    } else {
      m.compose(new THREE.Vector3(t.x, t.y || 0, t.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.rot || 0), new THREE.Vector3(t.s || 1, t.s || 1, t.s || 1));
    }
    // move the model's own origin so its footprint is centred and it sits on the ground
    return m.multiply(new THREE.Matrix4().makeTranslation(-center.x, -prop.box.min.y, -center.z));
  });
  const group = new THREE.Group();
  for (const part of prop.parts) {
    const im = new THREE.InstancedMesh(part.geometry, part.material, mats.length);
    mats.forEach((m, i) => im.setMatrixAt(i, m));
    im.castShadow = im.receiveShadow = true;
    group.add(im);
  }
  return group;
}
