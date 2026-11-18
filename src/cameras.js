// Cámaras de Percy: 4 puntos que brillan sobre sus piezas del modelo. Un clic dispara el obturador
// y abre una foto real de Marte tomada por esa cámara (public/photos, ver scripts/fetch-photos.mjs).
import * as THREE from 'three';

const BASE = import.meta.env.BASE_URL;
const PHOTOS_URL = `${BASE}photos/`;

// key = carpeta de fotos; part = nombre del nodo en el modelo (los que se escribieron en la consola)
const CAMERAS = [
  { key: 'mastcamz', part: 'Mastcam_Z_cams', name: 'Mastcam-Z', about: 'Cámaras a color con zoom, en lo alto del mástil' },
  { key: 'navcam', part: 'NavCams', name: 'NavCam', about: 'Cámaras de navegación, en el mástil' },
  { key: 'hazcam', part: 'hazcams_front', name: 'HazCam frontal', about: 'Cámara de peligros, mira el suelo delante de las ruedas' },
  { key: 'watson', part: 'WATSON', name: 'WATSON', about: 'Cámara de primeros planos, en la punta del brazo' },
];

const DOT_SIZE = 0.03;     // fracción de la altura de pantalla: el punto mide lo mismo cerca o lejos
const HIT_RADIUS = 20;     // píxeles alrededor del punto donde cuenta el clic / el mouse
const MIN_SEPARATION = 0.3; // m: separa los puntos para que no se encimen (Mastcam-Z y NavCam están pegadas)
const REVEAL_MS = 3400, REVEAL_NEXT_MS = 1400, HOLD_MS = 3000;

const ago = (utc) => {
  const d = Math.max(0, Math.floor((Date.now() - Date.parse(`${utc}Z`)) / 86400000));
  return d === 0 ? 'hoy' : d === 1 ? 'hace 1 día' : `hace ${d} días`;
};

function glowTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.18, 'rgba(160,250,255,0.95)');
  r.addColorStop(0.42, 'rgba(60,200,235,0.35)');
  r.addColorStop(1, 'rgba(60,200,235,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Sonido de obturador sintetizado (sin archivos): dos clics cortos de ruido filtrado
let audio;
function shutterSound() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
    const click = (at, f) => {
      const n = Math.floor(audio.sampleRate * 0.05), buf = audio.createBuffer(1, n, audio.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
      const src = audio.createBufferSource(), bp = audio.createBiquadFilter(), gain = audio.createGain();
      src.buffer = buf; bp.type = 'bandpass'; bp.frequency.value = f; gain.gain.value = 0.35;
      src.connect(bp).connect(gain).connect(audio.destination);
      src.start(audio.currentTime + at);
    };
    click(0, 2600); click(0.075, 1700);
  } catch { /* sin audio, el juego sigue */ }
}

export async function initCameras({ camera, renderer, rover }) {
  const state = { ready: false, error: null, hotspots: [], viewer: { open: false, stage: 'closed', size: 'medium', key: null, index: 0, count: 0 } };
  window.__cameras = state;

  // ---------- manifiesto de fotos ----------
  let manifest;
  try {
    const r = await fetch(`${PHOTOS_URL}manifest.json`);
    if (!r.ok) throw new Error(`No se pudo leer ${PHOTOS_URL}manifest.json (${r.status}). Ejecuta: npm run photos`);
    manifest = await r.json();
  } catch (err) {
    state.error = String(err.message || err);
    console.error('[cámaras]', err);
    return state;
  }

  // ---------- puntos que brillan sobre las piezas ----------
  const group = rover.group;
  group.updateMatrixWorld(true);
  const tex = glowTexture();
  const hotspots = [];
  for (const cam of CAMERAS) {
    const part = rover.getPart(cam.part);
    if (!part) { console.error(`[cámaras] el modelo no tiene la pieza "${cam.part}"`); continue; }
    const center = new THREE.Box3().setFromObject(part).getCenter(new THREE.Vector3());
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: false, fog: false, toneMapped: false });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 20;
    sprite.position.copy(group.worldToLocal(center));
    sprite.scale.setScalar(DOT_SIZE);
    group.add(sprite);
    hotspots.push({ ...cam, sprite, mat, hover: 0, x: 0, y: 0, visible: false });
  }
  // separa los que quedaron demasiado juntos (en el espacio del rover)
  for (let it = 0; it < 20; it++) {
    for (const a of hotspots) for (const b of hotspots) {
      if (a === b) continue;
      const d = a.sprite.position.distanceTo(b.sprite.position);
      if (d < MIN_SEPARATION) {
        const push = new THREE.Vector3().subVectors(a.sprite.position, b.sprite.position);
        if (push.lengthSq() < 1e-8) push.set(0, 1, 0);
        a.sprite.position.addScaledVector(push.normalize(), (MIN_SEPARATION - d) / 2);
      }
    }
  }

  // ---------- visor de fotos ----------
  const root = document.createElement('div');
  root.id = 'photo';
  root.className = 'ph';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <div class="ph-flash"></div>
    <div class="ph-stage" role="dialog" aria-modal="true" aria-label="Foto de Marte">
      <button type="button" class="ph-close" aria-label="Volver al juego">Esc · volver al juego</button>
      <figure class="ph-card">
        <div class="ph-frame"><img class="ph-img" alt=""><div class="ph-scan"></div></div>
        <figcaption>
          <div class="ph-meta"><b class="ph-cam"></b><span class="ph-sol"></span><span class="ph-ago"></span></div>
          <div class="ph-keys"><span class="ph-count"></span><span><kbd>←</kbd> <kbd>→</kbd> otras fotos</span><span>clic para ampliar</span></div>
          <div class="ph-credit"></div>
        </figcaption>
      </figure>
    </div>`;
  document.body.appendChild(root);
  const $ = (s) => root.querySelector(s);
  const img = $('.ph-img'), frame = $('.ph-frame'), scan = $('.ph-scan'), flash = $('.ph-flash');
  const tip = document.createElement('div');
  tip.className = 'cam-tip';
  tip.hidden = true;
  document.body.appendChild(tip);

  const v = state.viewer;
  let session = 0;          // invalida animaciones viejas si se cambia de foto o se cierra
  let holdTimer = 0;
  // etapa = qué está pasando (shooting → revealing → holding → ready); tamaño = cuánto se ve (medium → large → full)
  const setStage = (s) => { v.stage = s; root.dataset.stage = s; };
  const setSize = (z) => { v.size = z; root.dataset.size = z; };
  const photos = () => manifest.cameras[v.key] ?? [];
  const wait = (ms, id) => new Promise((res) => { holdTimer = setTimeout(() => res(id === session), ms); });

  async function showPhoto(index, { first }) {
    const id = ++session;
    clearTimeout(holdTimer);
    const list = photos();
    v.index = (index + list.length) % list.length;
    const p = list[v.index];
    // carga primero: la revelación empieza con la foto lista
    img.style.opacity = '0';
    img.src = `${PHOTOS_URL}${p.file}`;
    try { await img.decode(); } catch { /* si falla, onerror deja el estado visible */ }
    if (id !== session) return;
    v.src = img.currentSrc; v.naturalWidth = img.naturalWidth;
    const camDef = CAMERAS.find((c) => c.key === v.key);
    $('.ph-cam').textContent = camDef.name;
    $('.ph-sol').textContent = `Sol ${p.sol}`;
    $('.ph-ago').textContent = ago(p.utc);
    $('.ph-count').textContent = `${v.index + 1} / ${list.length}`;
    $('.ph-credit').textContent = `${p.credit} · imagen cruda de la NASA`;
    img.alt = `${camDef.name}, sol ${p.sol}, ${ago(p.utc)}`;
    state.viewer.label = { cam: camDef.name, sol: p.sol, ago: ago(p.utc) };

    // La foto se revela de arriba hacia abajo, como llegan las imágenes del rover, y se "revela" de oscura a nítida
    setStage('revealing');
    const ms = first ? REVEAL_MS : REVEAL_NEXT_MS;
    img.style.opacity = '1';
    const opts = { duration: ms, easing: 'linear', fill: 'forwards' };
    img.animate([
      { clipPath: 'inset(0 0 100% 0)', filter: 'brightness(2.2) contrast(.6) saturate(.2) blur(5px)' },
      { clipPath: 'inset(0 0 0% 0)', filter: 'none' },
    ], opts);
    scan.animate([{ top: '0%', opacity: 1 }, { top: '100%', opacity: 1 }, { top: '100%', opacity: 0 }], { ...opts, offset: [0, 0.97, 1] });
    if (!(await wait(ms + 80, id))) return;

    if (first) {
      setStage('holding'); // se queda quieta unos segundos
      if (!(await wait(HOLD_MS, id))) return;
      if (v.size === 'medium') setSize('large'); // y se muestra grande (si ya la ampliaron, se respeta)
    }
    setStage('ready');
  }

  function open(key) {
    if (v.open) return;
    v.open = true; v.key = key; v.count = photos().length;
    document.body.classList.add('viewing');
    rover.setControlsEnabled(false);
    tip.hidden = true;
    renderer.domElement.style.cursor = '';
    setStage('shooting');
    setSize('medium');
    root.setAttribute('aria-hidden', 'false');
    root.classList.add('on');
    shutterSound();
    flash.animate([{ opacity: 0 }, { opacity: 0.95, offset: 0.12 }, { opacity: 0 }], { duration: 520, easing: 'ease-out' });
    showPhoto(0, { first: true });
  }
  function close() {
    if (!v.open) return;
    session++; clearTimeout(holdTimer);
    v.open = false;
    root.classList.remove('on');
    root.setAttribute('aria-hidden', 'true');
    setStage('closed');
    document.body.classList.remove('viewing');
    rover.setControlsEnabled(true);
    img.getAnimations().forEach((a) => a.cancel());
    scan.getAnimations().forEach((a) => a.cancel());
  }
  function toggleFull() {
    if (!v.open || v.stage === 'shooting') return;
    setSize(v.size === 'full' ? 'large' : 'full');
  }
  frame.addEventListener('click', toggleFull);
  $('.ph-close').addEventListener('click', close);

  // Teclado: mientras el visor está abierto, solo Esc y las flechas (captura antes que el resto del juego)
  addEventListener('keydown', (e) => {
    if (!v.open) return;
    if (e.code === 'Escape') { close(); e.preventDefault(); e.stopImmediatePropagation(); }
    else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (v.stage !== 'shooting') showPhoto(v.index + (e.code === 'ArrowRight' ? 1 : -1), { first: false });
    } else if (e.code === 'KeyT') e.stopImmediatePropagation();
  }, true);

  // ---------- mouse: nombre al pasar, clic para fotografiar ----------
  let pointer = null;
  const nearest = (px, py) => {
    let best = null, bd = HIT_RADIUS;
    for (const h of hotspots) {
      if (!h.visible || v.open) continue;
      const d = Math.hypot(h.x - px, h.y - py);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  };
  let hovered = null;
  const canvas = renderer.domElement;
  canvas.addEventListener('pointermove', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    hovered = v.open ? null : nearest(e.clientX, e.clientY);
    canvas.style.cursor = hovered ? 'pointer' : '';
    if (hovered) {
      tip.innerHTML = `<b>${hovered.name}</b><span>${hovered.part}</span><em>${hovered.about}</em><i>Clic para tomar una foto</i>`;
      tip.hidden = false;
      tip.style.left = `${Math.min(e.clientX + 16, innerWidth - 250)}px`;
      tip.style.top = `${Math.max(8, e.clientY - 12)}px`;
    } else tip.hidden = true;
  });
  canvas.addEventListener('pointerleave', () => { pointer = null; hovered = null; tip.hidden = true; });
  canvas.addEventListener('click', (e) => {
    if (v.open) return;
    const h = nearest(e.clientX, e.clientY);
    if (h) open(h.key);
  });

  // ---------- cada cuadro: proyecta los puntos a pantalla y los hace latir ----------
  const tmp = new THREE.Vector3();
  function update(timeMs) {
    const rect = canvas.getBoundingClientRect();
    for (const h of hotspots) {
      h.sprite.getWorldPosition(tmp).project(camera);
      h.visible = tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05;
      h.x = rect.left + (tmp.x * 0.5 + 0.5) * rect.width;
      h.y = rect.top + (1 - (tmp.y * 0.5 + 0.5)) * rect.height;
      const isHover = h === hovered;
      h.hover += ((isHover ? 1 : 0) - h.hover) * 0.25;
      const pulse = 0.82 + 0.18 * Math.sin(timeMs * 0.004 + h.x * 0.01);
      h.sprite.visible = !v.open;
      h.sprite.scale.setScalar(DOT_SIZE * (pulse + 0.55 * h.hover));
      h.mat.opacity = Math.min(1, 0.75 + 0.25 * pulse + 0.3 * h.hover);
    }
    state.hotspots = hotspots.map((h) => ({ key: h.key, name: h.name, part: h.part, x: Math.round(h.x), y: Math.round(h.y), visible: h.visible }));
  }

  state.ready = true;
  return { update, state, open, close };
}
