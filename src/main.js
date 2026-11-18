import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createRover } from './rover.js';
import { initMissionControl } from './mission.js';
import { initCameras } from './cameras.js';

// ---------- ruido ----------
function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, oct = 5) {
  let t = 0, amp = 0.5;
  for (let i = 0; i < oct; i++) { t += amp * vnoise(x, y); x *= 2.03; y *= 2.03; amp *= 0.5; }
  return t;
}

// ---------- altura del terreno ----------
const WIND = 0.45; // rad
const cw = Math.cos(WIND), sw = Math.sin(WIND);
function terrainHeight(x, z) {
  // dunas: crestas alargadas, perpendiculares al viento
  const u = x * cw + z * sw, v = -x * sw + z * cw;
  const warp = fbm(x * 0.01, z * 0.01, 3) * 30;
  const ph = (((u + warp) * 0.045 + fbm(v * 0.02, u * 0.01, 2) * 4) / 6.2832) % 1;
  const f = ph < 0 ? ph + 1 : ph;
  const saw = f < 0.72 ? f / 0.72 : (1 - f) / 0.28;   // barlovento suave, sotavento empinado
  const crest = saw * saw * (3 - 2 * saw);
  const dunes = (0.25 + 0.75 * fbm(v * 0.015 + 3, u * 0.008, 2) * 1.6) * crest * 11;
  const big = fbm(x * 0.006 + 10, z * 0.006 + 10, 4) * 14;
  const detail = fbm(x * 0.12, z * 0.12, 3) * 0.35;
  // zona despejada cerca de la cámara
  const d = Math.hypot(x, z + 10);
  const flat = THREE.MathUtils.smoothstep(d, 4, 40);
  return (dunes + big) * (0.45 + 0.55 * flat) + detail;
}

// ---------- escena ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const FOG = new THREE.Color(0.52, 0.27, 0.13);
scene.fog = new THREE.FogExp2(FOG, 0.0085);

const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 3000);

// dirección del sol (tarde, baja, adelante-izquierda)
const sunDir = new THREE.Vector3(-0.62, 0.17, -0.77).normalize();

// ---------- cielo ----------
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  fog: false,
  uniforms: { sunDir: { value: sunDir } },
  vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: `
    varying vec3 vDir; uniform vec3 sunDir;
    void main(){
      vec3 d = normalize(vDir);
      float h = clamp(d.y, -0.2, 1.0);
      vec3 horizon = vec3(0.52, 0.27, 0.13);
      vec3 mid     = vec3(0.40, 0.22, 0.13);
      vec3 zenith  = vec3(0.20, 0.13, 0.12);
      vec3 col = mix(horizon, mid, smoothstep(0.0, 0.25, h));
      col = mix(col, zenith, smoothstep(0.2, 0.95, h));
      float s = max(dot(d, normalize(sunDir)), 0.0);
      col += vec3(1.0, 0.55, 0.20) * pow(s, 5.0) * 0.45;       // halo amplio de polvo
      col += vec3(1.0, 0.75, 0.40) * pow(s, 60.0) * 0.8;
      col += vec3(1.0, 0.95, 0.8) * smoothstep(0.9993, 0.9998, s) * 4.0; // disco solar
      // banda de polvo en el horizonte
      col = mix(col, vec3(0.55,0.29,0.14), (1.0 - smoothstep(0.0, 0.12, abs(d.y))) * 0.5);
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(2500, 32, 16), skyMat);
scene.add(sky);

// ---------- luces ----------
const sun = new THREE.DirectionalLight(0xffb870, 3.6);
sun.position.copy(sunDir).multiplyScalar(150);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.radius = 5;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.05;
const sc = sun.shadow.camera;
sc.left = -55; sc.right = 55; sc.top = 55; sc.bottom = -55; sc.near = 1; sc.far = 400;
scene.add(sun, sun.target); // el sol y su sombra siguen al rover
scene.add(new THREE.HemisphereLight(0xf0a870, 0x8a4a22, 1.4));

// ---------- terreno ----------
const SIZE = 700, SEG = 320;
const tGeo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
tGeo.rotateX(-Math.PI / 2);
{
  const pos = tGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
  tGeo.computeVertexNormals();
  const n = tGeo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  const sand = new THREE.Color(0xd08a45), caramel = new THREE.Color(0xb86a2c);
  const dark = new THREE.Color(0x7a3f1f), light = new THREE.Color(0xe7ad6a);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), y = pos.getY(i);
    const slope = 1 - n.getY(i);
    const m = fbm(x * 0.03, z * 0.03, 3);
    c.copy(sand).lerp(caramel, m);
    c.lerp(light, THREE.MathUtils.clamp((y - 6) / 10, 0, 1) * 0.5);
    c.lerp(light, 0.18);
    c.lerp(dark, THREE.MathUtils.clamp(slope * 2.2, 0, 1) * 0.55);
    c.multiplyScalar(0.9 + 0.2 * vnoise(x * 0.8, z * 0.8)); // grano
    colors.set([c.r, c.g, c.b], i * 3);
  }
  tGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// Altura EXACTA de la malla renderizada (misma triangulación que PlaneGeometry), no del ruido:
// así las ruedas y las huellas apoyan justo sobre lo que se ve.
const heights = new Float32Array(tGeo.attributes.position.count);
for (let i = 0; i < heights.length; i++) heights[i] = tGeo.attributes.position.getY(i);
function groundHeight(x, z) {
  const cell = SIZE / SEG;
  const gx = THREE.MathUtils.clamp((x + SIZE / 2) / cell, 0, SEG - 1e-6);
  const gz = THREE.MathUtils.clamp((z + SIZE / 2) / cell, 0, SEG - 1e-6);
  const ix = Math.floor(gx), iz = Math.floor(gz), u = gx - ix, v = gz - iz;
  const row = SEG + 1;
  const a = heights[ix + row * iz], b = heights[ix + row * (iz + 1)];
  const c = heights[ix + 1 + row * (iz + 1)], d = heights[ix + 1 + row * iz];
  // PlaneGeometry: triángulos (a,b,d) y (b,c,d); la diagonal es b–d
  return u + v <= 1 ? a + u * (d - a) + v * (b - a) : c + (1 - u) * (b - c) + (1 - v) * (d - c);
}
function rippleNormalMap() {
  const N = 256, h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const w = fbm(x * 0.03, y * 0.03, 3) * 7;
    h[y * N + x] = Math.sin((x * 0.9 + w * 6) * 0.35) * 0.6 + (vnoise(x * 0.5, y * 0.5) - 0.5) * 0.5;
  }
  const cv = document.createElement('canvas'); cv.width = cv.height = N;
  const g = cv.getContext('2d'), img = g.createImageData(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = h[y * N + (x + 1) % N] - h[y * N + (x + N - 1) % N];
    const dy = h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x];
    const l = Math.hypot(dx * 0.8, dy * 0.8, 1), i = (y * N + x) * 4;
    img.data[i] = (-dx * 0.8 / l * 0.5 + 0.5) * 255;
    img.data[i + 1] = (-dy * 0.8 / l * 0.5 + 0.5) * 255;
    img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(90, 90);
  t.anisotropy = 8;
  return t;
}
const terrain = new THREE.Mesh(tGeo, new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 1, metalness: 0,
  normalMap: rippleNormalMap(), normalScale: new THREE.Vector2(0.4, 0.4),
}));
terrain.receiveShadow = true;
scene.add(terrain);

// ---------- rocas ----------
// Geometría angular: esfera deformada con ruido "ridged" + planos de corte (caras) + estratos.
function makeRockGeo(seed) {
  let g = new THREE.IcosahedronGeometry(1, 5);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  // planos de corte aleatorios que dan caras rotas
  const cuts = [];
  for (let i = 0; i < 7; i++) {
    const n = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 - 0.35, Math.random() - 0.5).normalize();
    cuts.push({ n, d: 0.6 + Math.random() * 0.22 });
  }
    const base = new THREE.Color(), dustC = new THREE.Color(0xc8884e), dark = new THREE.Color(0x4a2616);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    let r = 0.8 + fbm(v.x * 1.4 + seed, v.y * 1.4 + v.z * 1.4, 3) * 0.55;
    r += (1 - Math.abs(vnoise(v.x * 3 + seed, v.z * 3 + v.y * 3) * 2 - 1)) * 0.12; // grietas/aristas
    v.multiplyScalar(r);
    for (const c of cuts) {
      const dist = v.dot(c.n);
      if (dist > c.d) v.addScaledVector(c.n, c.d - dist); // aplana contra el plano
    }
    v.y *= 0.8;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.deleteAttribute('uv');
  g = toCreasedNormals(g, 0.5); // suave en curvas, arista marcada en cortes
  const mp = g.attributes.position, n = g.attributes.normal;
  const cols = new Float32Array(mp.count * 3);
  for (let i = 0; i < mp.count; i++) {
    v.fromBufferAttribute(mp, i);
    const strata = Math.sin(v.y * 5 + fbm(v.x * 2 + seed, v.z * 2, 2) * 3) * 0.5 + 0.5; // capas
    base.setHSL(0.045 + strata * 0.012, 0.42, 0.2 + strata * 0.1 + (fbm(v.x * 2.5, v.z * 2.5 + seed, 2) - 0.5) * 0.08);
    base.lerp(dark, THREE.MathUtils.clamp(0.5 - n.getY(i), 0, 1) * 0.5);   // laterales más oscuros
    base.lerp(dustC, THREE.MathUtils.smoothstep(n.getY(i), 0.35, 0.9) * 0.75); // polvo arriba
    cols.set([base.r, base.g, base.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return g;
}
const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.02, flatShading: false });
const VARIANTS = [makeRockGeo(1.3), makeRockGeo(8.9), makeRockGeo(21.4), makeRockGeo(40.2)];
const buckets = VARIANTS.map(() => []);
{
  const place = (x, z, size, sink) => {
    const y = terrainHeight(x, z) - size * sink;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    e.set((Math.random() - 0.5) * 0.35, Math.random() * 6.28, (Math.random() - 0.5) * 0.35);
    q.setFromEuler(e);
    const s = new THREE.Vector3(size * (0.8 + Math.random() * 0.6), size * (0.7 + Math.random() * 0.6), size * (0.8 + Math.random() * 0.6));
    m.compose(new THREE.Vector3(x, y, z), q, s);
    buckets[Math.floor(Math.random() * VARIANTS.length)].push(m);
  };
  let big = 0, tries = 0;
  while (big < 140 && tries++ < 30000) {
    // 60% en la zona visible frente a la cámara, resto por todo el paisaje
    const near = big < 80;
    const x = near ? (Math.random() - 0.5) * 110 : (Math.random() - 0.5) * 300;
    const z = near ? 12 - Math.random() * 110 : (Math.random() - 0.5) * 300 - 40;
    if (Math.hypot(x, z + 10) < 7) continue;
    if (fbm(x * 0.03 + 50, z * 0.03, 3) < 0.4 && Math.random() < 0.6) continue;
    const size = Math.pow(Math.random(), 2.8) * 2.8 + 0.5;
    place(x, z, size, 0.12); // semienterradas
    big++;
    // guijarros y lascas alrededor de cada roca
    const n = 2 + Math.floor(Math.random() * 6);
    for (let k = 0; k < n; k++) {
      const a = Math.random() * 6.28, d = size * (1.1 + Math.random() * 2.2);
      place(x + Math.cos(a) * d, z + Math.sin(a) * d, 0.08 + Math.random() * 0.3, 0.2);
    }
  }
}
const rockMeshes = VARIANTS.map((geo, i) => {
  const im = new THREE.InstancedMesh(geo, rockMat, Math.max(buckets[i].length, 1));
  buckets[i].forEach((m, j) => im.setMatrixAt(j, m));
  im.count = buckets[i].length;
  im.castShadow = true;
  im.receiveShadow = true;
  scene.add(im);
  return im;
});

// ---------- lunas ----------
function moonTexture(seed, base) {
  const W = 512, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, W, H);
  const img = g.getImageData(0, 0, W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const n = fbm(x * 0.05 + seed, y * 0.05, 4) - 0.5;
    const i = (y * W + x) * 4;
    for (let k = 0; k < 3; k++) img.data[i + k] = Math.max(0, Math.min(255, img.data[i + k] * (1 + n * 0.9)));
  }
  g.putImageData(img, 0, 0);
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * W, y = Math.random() * H, r = 3 + Math.pow(Math.random(), 2) * 26;
    for (const ox of [0, -W, W]) {
      const gr = g.createRadialGradient(x + ox - r * 0.2, y - r * 0.2, r * 0.2, x + ox, y, r);
      gr.addColorStop(0, 'rgba(20,10,5,0.55)');
      gr.addColorStop(0.8, 'rgba(20,10,5,0.25)');
      gr.addColorStop(1, 'rgba(255,230,200,0.18)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(x + ox, y, r, 0, 6.283); g.fill();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function makeMoon(radius, scale, seed, color, dir, dist) {
  const geo = new THREE.SphereGeometry(radius, 64, 48);
  const p = geo.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const k = 1 + (fbm(v.x * 2 + seed, v.y * 2 + v.z * 2, 3) - 0.5) * 0.28;
    v.set(v.x * scale.x, v.y * scale.y, v.z * scale.z).multiplyScalar(radius * k);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ map: moonTexture(seed, color), roughness: 1, fog: false, emissive: 0x6a4a3a, emissiveMap: null });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(dir).normalize().multiplyScalar(dist);
  scene.add(mesh);
  return mesh;
}
// Fobos (grande, irregular) y Deimos (pequeña)
const phobos = makeMoon(1, new THREE.Vector3(1.25, 0.95, 1), 3.1, '#8a6a58', new THREE.Vector3(0.12, 0.33, -0.93), 1500);
phobos.scale.setScalar(70);
const deimos = makeMoon(1, new THREE.Vector3(1.1, 0.95, 1), 7.7, '#9a7a62', new THREE.Vector3(0.52, 0.28, -0.8), 1500);
deimos.scale.setScalar(26);
const skyGroup = new THREE.Group(); // cielo y lunas viajan con la cámara: sin paralaje, siempre en el infinito
skyGroup.add(sky, phobos, deimos);
scene.add(skyGroup);

// ---------- polvo ----------
const dustTex = (() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,200,140,0.9)'); gr.addColorStop(1, 'rgba(255,200,140,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
})();
const DUST = 900;
const dGeo = new THREE.BufferGeometry();
const dPos = new Float32Array(DUST * 3);
for (let i = 0; i < DUST; i++) {
  dPos[i * 3] = (Math.random() - 0.5) * 160;
  dPos[i * 3 + 1] = Math.random() * 18 + 0.5;
  dPos[i * 3 + 2] = (Math.random() - 0.5) * 140;
}
dGeo.setAttribute('position', new THREE.BufferAttribute(dPos, 3));
const dust = new THREE.Points(dGeo, new THREE.PointsMaterial({
  map: dustTex, size: 1.6, transparent: true, opacity: 0.35, depthWrite: false, color: 0xffc58a,
}));
dust.frustumCulled = false;
scene.add(dust);

// ---------- rover, cámara y bucle ----------
const hud = document.getElementById('hud');
initMissionControl(); // panel de la tecla T; carga sus datos en paralelo con el rover
const rover = await createRover({ scene, camera, renderer, skyMesh: sky, groundHeight });
hud.classList.add('ready');
const cameras = await initCameras({ camera, renderer, rover }); // puntos que brillan sobre las cámaras

// El mapa de sombras sigue al rover, ajustado a la rejilla de texeles para que no parpadee.
const texel = (sc.right - sc.left) / sun.shadow.mapSize.x;
const lz = sunDir.clone(), lx = new THREE.Vector3(0, 1, 0).cross(lz).normalize(), ly = lz.clone().cross(lx);
function followSun() {
  const p = new THREE.Vector3(rover.state.x, rover.state.y, rover.state.z);
  const a = Math.round(p.dot(lx) / texel) * texel, b = Math.round(p.dot(ly) / texel) * texel, c = p.dot(lz);
  sun.target.position.copy(lx).multiplyScalar(a).addScaledVector(ly, b).addScaledVector(lz, c);
  sun.position.copy(sun.target.position).addScaledVector(sunDir, 150);
}

const timer = new THREE.Timer();
function frame() {
  timer.update();
  const dt = timer.getDelta();
  rover.update(dt);
  followSun();
  skyGroup.position.copy(camera.position);
  cameras.update?.(performance.now());

  // el polvo se envuelve alrededor del rover
  const p = dGeo.attributes.position, rs = rover.state;
  for (let i = 0; i < DUST; i++) {
    p.array[i * 3] += 0.03;
    if (p.array[i * 3] - rs.x > 80) p.array[i * 3] -= 160;
    else if (p.array[i * 3] - rs.x < -80) p.array[i * 3] += 160;
    if (p.array[i * 3 + 2] - rs.z > 70) p.array[i * 3 + 2] -= 140;
    else if (p.array[i * 3 + 2] - rs.z < -70) p.array[i * 3 + 2] += 140;
  }
  p.needsUpdate = true;

  hud.querySelector('.speed').textContent = Math.abs(rs.speed).toFixed(1);
  renderer.render(scene, camera);
  window.__frames = (window.__frames || 0) + 1;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
