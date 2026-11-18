import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

const MODEL_URL = `${import.meta.env.BASE_URL}models/perseverance.glb`;
const DRACO_URL = `${import.meta.env.BASE_URL}draco/`;

// Diámetro real de las ruedas de Perseverance: 52,5 cm (NASA/JPL). De ahí sale la escala del modelo.
const REAL_WHEEL_DIAMETER = 0.525;

// Conducción (el rover real va a 4 cm/s; aquí se acelera para poder explorar)
const MAX_SPEED = 6;       // m/s hacia delante
const MAX_REVERSE = 3;     // m/s marcha atrás
const ACCEL = 5;           // m/s²
const BRAKE = 9;           // m/s²
const TURN_RATE = 0.9;     // rad/s
const WORLD_LIMIT = 330;   // el terreno mide 700 x 700

// Huellas
const STAMP_DIST = 0.25;       // una marca cada 25 cm de recorrido por rueda
const QUADS_PER_WHEEL = 3000;  // ~750 m de huella por rueda antes de borrar las más antiguas
const TREAD_TILE = 0.6;        // largo (m) de una repetición del dibujo de la banda

// ---------- utilidades ----------
const damp = (k, dt) => 1 - Math.exp(-k * dt);
function angleDelta(a, b) {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

/** Agrupa en 3 filas (z) por lado las ruedas a partir de los vértices de la malla de ruedas. */
function measureWheels(wheelsObj) {
  const v = new THREE.Vector3();
  const pts = [];
  wheelsObj.updateWorldMatrix(true, true);
  wheelsObj.traverse((o) => {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
      pts.push(v.x, v.y, v.z);
    }
  });
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    minX = Math.min(minX, pts[i]); maxX = Math.max(maxX, pts[i]);
    minY = Math.min(minY, pts[i + 1]); maxY = Math.max(maxY, pts[i + 1]);
    minZ = Math.min(minZ, pts[i + 2]); maxZ = Math.max(maxZ, pts[i + 2]);
  }
  const midX = (minX + maxX) / 2;
  const wheels = [];
  for (const side of [-1, 1]) {
    // k-means 1D sobre z con 3 centros
    const zs = [];
    for (let i = 0; i < pts.length; i += 3) if ((pts[i] - midX) * side > 0) zs.push([pts[i], pts[i + 2]]);
    let c = [minZ, (minZ + maxZ) / 2, maxZ];
    for (let it = 0; it < 12; it++) {
      const sum = [0, 0, 0], n = [0, 0, 0];
      for (const [, z] of zs) {
        let k = 0;
        if (Math.abs(z - c[1]) < Math.abs(z - c[k])) k = 1;
        if (Math.abs(z - c[2]) < Math.abs(z - c[k])) k = 2;
        sum[k] += z; n[k]++;
      }
      c = c.map((cz, k) => (n[k] ? sum[k] / n[k] : cz));
    }
    for (let k = 0; k < 3; k++) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [x, z] of zs) {
        const kk = [0, 1, 2].reduce((b, j) => (Math.abs(z - c[j]) < Math.abs(z - c[b]) ? j : b), 0);
        if (kk !== k) continue;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
      wheels.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, width: x1 - x0, side });
    }
  }
  return { wheels, minY, maxY, minX, maxX, minZ, maxZ };
}

// ---------- huellas ----------
function treadTexture() {
  const W = 64, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);
  // banda comprimida (regolito más oscuro) con bordes difusos
  const edge = g.createLinearGradient(0, 0, W, 0);
  edge.addColorStop(0, 'rgba(62,30,14,0)');
  edge.addColorStop(0.12, 'rgba(62,30,14,0.55)');
  edge.addColorStop(0.88, 'rgba(62,30,14,0.55)');
  edge.addColorStop(1, 'rgba(62,30,14,0)');
  g.fillStyle = edge; g.fillRect(0, 0, W, H);
  // surcos en V como los de las ruedas de aluminio (dibujo "chevron")
  g.strokeStyle = 'rgba(38,16,6,0.95)';
  g.lineWidth = 7;
  g.lineCap = 'butt';
  for (let y = 0; y < H; y += H / 4) {
    g.beginPath();
    g.moveTo(W * 0.14, y + H / 8);
    g.lineTo(W * 0.5, y);
    g.lineTo(W * 0.86, y + H / 8);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

class Trails {
  constructor(scene, groundHeight, wheelCount, halfWidth) {
    this.ground = groundHeight;
    this.hw = halfWidth;
    this.n = QUADS_PER_WHEEL;
    this.wheelCount = wheelCount;
    const quads = this.n * wheelCount;
    this.pos = new Float32Array(quads * 4 * 3);
    this.nrm = new Float32Array(quads * 4 * 3);
    this.uv = new Float32Array(quads * 4 * 2);
    const idx = new Uint32Array(quads * 6);
    for (let q = 0; q < quads; q++) {
      const a = q * 4;
      // (a,c,b) y (b,c,d): cara hacia arriba (+Y). Con el orden contrario el culling las descarta.
      idx.set([a, a + 2, a + 1, a + 1, a + 2, a + 3], q * 6);
    }
    for (let i = 1; i < this.nrm.length; i += 3) this.nrm[i] = 1;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      map: treadTexture(), transparent: true, depthWrite: false, roughness: 1, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    this.mesh.frustumCulled = false; // el bounding sphere inicial no refleja lo que se escribe después
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.last = Array.from({ length: wheelCount }, () => null);
    this.head = new Array(wheelCount).fill(0);
    this.dist = new Array(wheelCount).fill(0);
    this._n = new THREE.Vector3();
  }

  lift(x, z) { return this.ground(x, z) + 0.025; }

  stamp(w, p) {
    const last = this.last[w];
    if (!last) { this.last[w] = { x: p.x, z: p.z }; return false; }
    const dx = p.x - last.x, dz = p.z - last.z;
    const d = Math.hypot(dx, dz);
    if (d < STAMP_DIST) return false;
    const dirx = dx / d, dirz = dz / d;
    const px = -dirz * this.hw, pz = dirx * this.hw; // perpendicular
    const q = w * this.n + this.head[w];
    this.head[w] = (this.head[w] + 1) % this.n;
    const pa = q * 12, ua = q * 8;
    const pts = [
      [last.x + px, last.z + pz, 0, this.dist[w]],
      [last.x - px, last.z - pz, 1, this.dist[w]],
      [p.x + px, p.z + pz, 0, this.dist[w] + d],
      [p.x - px, p.z - pz, 1, this.dist[w] + d],
    ];
    for (let i = 0; i < 4; i++) {
      const [x, z, u, s] = pts[i];
      this.pos[pa + i * 3] = x;
      this.pos[pa + i * 3 + 1] = this.lift(x, z);
      this.pos[pa + i * 3 + 2] = z;
      this.uv[ua + i * 2] = u;
      this.uv[ua + i * 2 + 1] = s / TREAD_TILE;
    }
    // normal del terreno en el centro de la marca (para que se ilumine como el suelo)
    const cx = (last.x + p.x) / 2, cz = (last.z + p.z) / 2, e = 0.5;
    this._n.set(this.ground(cx - e, cz) - this.ground(cx + e, cz), 2 * e, this.ground(cx, cz - e) - this.ground(cx, cz + e)).normalize();
    for (let i = 0; i < 4; i++) this._n.toArray(this.nrm, pa + i * 3);
    this.dist[w] += d;
    last.x = p.x; last.z = p.z;
    return true;
  }

  flush() {
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
    this.geo.attributes.uv.needsUpdate = true;
  }
}

// ---------- rover ----------
/**
 * Carga el rover y devuelve { update(dt), state }.
 * - groundHeight(x, z): altura exacta de la malla del terreno
 */
export async function createRover({ scene, camera, renderer, skyMesh, groundHeight, spawn = { x: 0, z: 0, heading: Math.PI } }) {
  const draco = new DRACOLoader().setDecoderPath(DRACO_URL);
  const loader = new GLTFLoader().setDRACOLoader(draco);
  const gltf = await loader.loadAsync(MODEL_URL);
  draco.dispose();
  const model = gltf.scene;
  model.updateMatrixWorld(true);

  // --- escala real: las 6 ruedas miden 52,5 cm de diámetro ---
  const wheelsObj = model.getObjectByName('Wheels_objs');
  if (!wheelsObj) throw new Error('No se encontró "Wheels_objs" en el modelo');
  const m = measureWheels(wheelsObj);
  const modelWheelDiameter = m.maxY - m.minY;
  const s = REAL_WHEEL_DIAMETER / modelWheelDiameter;
  model.scale.setScalar(s);
  model.position.y = -m.minY * s; // las ruedas apoyan en y = 0 del grupo
  model.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; }
  });

  const rover = new THREE.Group();
  rover.add(model);
  scene.add(rover);

  // contactos de rueda en coordenadas locales del rover (ya escalados)
  const wheels = m.wheels.map((w) => ({ local: new THREE.Vector3(w.x * s, 0, w.z * s), side: w.side, width: w.width * s }));

  // medidas finales (para comprobar el tamaño real)
  rover.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  console.log(
    `%cRover Perseverance%c escala ${s.toFixed(5)} · ruedas ${(modelWheelDiameter * s * 100).toFixed(1)} cm · ` +
    `caja ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m (ancho × alto × largo)`,
    'font-weight:bold;color:#e0803a', '',
  );

  // --- entorno para los metales (el cielo procedural, no el de todo el mundo) ---
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(skyMesh.clone());
  const envMap = pmrem.fromScene(envScene, 0, 0.1, 6000).texture;
  pmrem.dispose();
  const seen = new Set();
  model.traverse((o) => {
    if (!o.isMesh) return;
    for (const mat of [].concat(o.material)) {
      if (seen.has(mat)) continue;
      seen.add(mat);
      if ('envMap' in mat) { mat.envMap = envMap; mat.envMapIntensity = 0.9; mat.needsUpdate = true; }
    }
  });

  // --- consola: piezas que son cámaras ---
  // Solo el nodo de más arriba de cada pieza (las submallas con nombres de CAD largos se omiten).
  const cams = [], related = [], maybe = [];
  const hasMatchedAncestor = (o, re) => { for (let p = o.parent; p; p = p.parent) if (p.name && re.test(p.name)) return true; return false; };
  const CAM = /cam|watson/i;
  model.traverse((o) => {
    if (!o.name || hasMatchedAncestor(o, /cam|watson|lens/i)) return;
    if (/cover|wiring/i.test(o.name) && CAM.test(o.name)) related.push(o.name);
    else if (CAM.test(o.name)) cams.push(o.name);
    else if (/lens/i.test(o.name)) maybe.push(o.name);
  });
  console.group('📷 Piezas del modelo que son cámaras');
  cams.forEach((n) => console.log(n));
  console.log('Tapas / cableado de cámaras:', related.join(', ') || '—');
  console.log('Ambigua (en la cabeza del mástil):', maybe.join(', ') || '—');
  console.groupEnd();
  window.__cameraParts = cams;

  // --- huellas ---
  const avgWidth = wheels.reduce((a, w) => a + w.width, 0) / wheels.length;
  const trails = new Trails(scene, groundHeight, wheels.length, avgWidth * 0.5);

  // --- estado y control ---
  const state = {
    x: spawn.x, z: spawn.z, heading: spawn.heading,
    speed: 0, yawRate: 0, pitch: 0, roll: 0, y: groundHeight(spawn.x, spawn.z),
  };
  window.__rover = state;
  const keys = {};
  let controlsEnabled = true; // se apaga mientras se mira una foto
  addEventListener('keydown', (e) => { if (controlsEnabled && /^Key[WASD]$/.test(e.code)) { keys[e.code] = true; e.preventDefault(); } });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

  const tmp = new THREE.Vector3();
  const frontWheels = wheels.filter((w) => w.local.z > 0.3), rearWheels = wheels.filter((w) => w.local.z < -0.3);
  const leftWheels = wheels.filter((w) => w.local.x > 0), rightWheels = wheels.filter((w) => w.local.x < 0);
  const mean = (a, f) => a.reduce((t, w) => t + f(w), 0) / a.length;
  // posición en el mundo del contacto de cada rueda (solo yaw; la inclinación es de pocos grados)
  const wheelsWorld = (w) => {
    const c = Math.cos(state.heading), sn = Math.sin(state.heading);
    return { x: state.x + w.local.x * c + w.local.z * sn, z: state.z - w.local.x * sn + w.local.z * c };
  };
  const spanZ = mean(frontWheels, (w) => w.local.z) - mean(rearWheels, (w) => w.local.z);
  const spanX = mean(leftWheels, (w) => w.local.x) - mean(rightWheels, (w) => w.local.x);

  // cámara
  let camHeading = state.heading;
  const CAM_DIST = 9, CAM_UP = 4.2;
  const camPos = new THREE.Vector3();
  const look = new THREE.Vector3();
  const placeCamera = (dt, snap) => {
    camHeading += angleDelta(camHeading, state.heading) * (snap ? 1 : damp(2.2, dt));
    const fx = Math.sin(camHeading), fz = Math.cos(camHeading);
    const tx = state.x - fx * CAM_DIST, tz = state.z - fz * CAM_DIST;
    const ty = Math.max(state.y + CAM_UP, groundHeight(tx, tz) + 1.2);
    tmp.set(tx, ty, tz);
    if (snap) camPos.copy(tmp); else camPos.lerp(tmp, damp(5, dt));
    camPos.y = Math.max(camPos.y, groundHeight(camPos.x, camPos.z) + 1.0);
    camera.position.copy(camPos);
    look.set(state.x + fx * 3, state.y + 1.3, state.z + fz * 3);
    camera.lookAt(look);
  };

  function applyTransform(dt, snap) {
    // altura y pendiente a partir de los puntos de contacto de las 6 ruedas
    const h = new Map();
    for (const w of wheels) { const p = wheelsWorld(w); h.set(w, groundHeight(p.x, p.z)); }
    const hv = (w) => h.get(w);
    const targetY = mean(wheels, hv) - 0.01;
    const targetPitch = Math.atan2(mean(frontWheels, hv) - mean(rearWheels, hv), spanZ);
    const targetRoll = Math.atan2(mean(leftWheels, hv) - mean(rightWheels, hv), spanX);
    const k = snap ? 1 : damp(10, dt);
    state.y += (targetY - state.y) * k;
    state.pitch += (targetPitch - state.pitch) * k;
    state.roll += (targetRoll - state.roll) * k;
    rover.position.set(state.x, state.y, state.z);
    // +Z es el frente del modelo: pitch positivo (frente arriba) es una rotación negativa en X;
    // +X es la izquierda, roll positivo (izquierda arriba) es rotación positiva en Z.
    rover.rotation.set(-state.pitch, state.heading, state.roll, 'YXZ');
    rover.updateMatrixWorld(true);
  }

  function update(dt) {
    dt = Math.min(dt, 0.1);
    const fwd = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
    const turn = (keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0);

    const target = fwd > 0 ? MAX_SPEED : fwd < 0 ? -MAX_REVERSE : 0;
    const reversing = state.speed !== 0 && Math.sign(target) !== Math.sign(state.speed);
    const rate = fwd === 0 || reversing ? BRAKE : ACCEL;
    state.speed += THREE.MathUtils.clamp(target - state.speed, -rate * dt, rate * dt);
    state.yawRate += (turn * TURN_RATE - state.yawRate) * damp(8, dt);
    state.heading += state.yawRate * dt;
    state.x += Math.sin(state.heading) * state.speed * dt;
    state.z += Math.cos(state.heading) * state.speed * dt;
    state.x = THREE.MathUtils.clamp(state.x, -WORLD_LIMIT, WORLD_LIMIT);
    state.z = THREE.MathUtils.clamp(state.z, -WORLD_LIMIT, WORLD_LIMIT);

    applyTransform(dt, false);

    // huellas: se marcan solo cuando la rueda realmente se desplaza
    let dirty = false;
    for (let i = 0; i < wheels.length; i++) dirty = trails.stamp(i, wheelsWorld(wheels[i])) || dirty;
    if (dirty) trails.flush();

    placeCamera(dt, false);
  }

  applyTransform(0, true);
  placeCamera(0, true);
  window.__trails = trails;

  return {
    update, state, group: rover,
    getPart: (name) => model.getObjectByName(name),
    setControlsEnabled(on) { controlsEnabled = on; if (!on) for (const k in keys) keys[k] = false; },
  };
}
