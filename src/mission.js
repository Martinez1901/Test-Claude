// Control de misión dentro de la simulación (tecla T).
//
// Usa el mismo patrón que Open MCT (ver mapa-del-repo.html):
//   - cada dato es un CANAL con nombre, unidad y metadatos (qué columna es el tiempo y cuál el valor);
//   - un PROVEEDOR se registra y dice qué canales sabe servir (`supports`), con
//     `request` (historial) y `subscribe` (datos en vivo);
//   - el último proveedor registrado gana, igual que en TelemetryAPI.addProvider.
import { lightTimeSeconds } from './lighttime.js';

const DATA_URL = `${import.meta.env.BASE_URL}data/m20-waypoints.json`;

// Perseverance aterrizó el 18 de febrero de 2021, 20:55 UTC. Un sol (día marciano) dura 88 775,244 s.
const LANDING_MS = Date.UTC(2021, 1, 18, 20, 55, 0);
const SOL_SECONDS = 88775.244;
const solAt = (ms) => (ms - LANDING_MS) / 1000 / SOL_SECONDS;
const msAtSol = (sol) => LANDING_MS + sol * SOL_SECONDS * 1000;

const nf = (digits) => new Intl.NumberFormat('es', { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });

// ---------- mini API de telemetría (como la de Open MCT, en pequeño) ----------
class Telemetry {
  #providers = [];
  #channels = new Map();
  addChannel(def) { this.#channels.set(def.key, def); }
  addProvider(provider) { this.#providers.unshift(provider); } // el último registrado gana
  channels() { return [...this.#channels.values()]; }
  channel(key) { return this.#channels.get(key); }
  providerOf(key) {
    const ch = this.channel(key);
    const p = this.#providers.find((x) => x.supports(ch));
    if (!p) throw new Error(`Ningún proveedor sirve el canal "${key}"`);
    return p;
  }
  request(key, opts = {}) { return this.providerOf(key).request(this.channel(key), opts); }
  subscribe(key, callback) {
    const p = this.providerOf(key);
    return p.subscribe ? p.subscribe(this.channel(key), callback) : () => {};
  }
}

// Proveedor 1: historial de manejos de la NASA (copia local en public/data, ver scripts/fetch-nasa-data.mjs)
function driveLogProvider() {
  let loading;
  const load = () => (loading ??= fetch(DATA_URL).then((r) => {
    if (!r.ok) throw new Error(`No se pudo leer ${DATA_URL} (${r.status}). Ejecuta: npm run data`);
    return r.json();
  }));
  return {
    id: 'nasa-drive-log',
    name: 'Historial de manejos NASA/JPL',
    kind: 'histórico',
    supports: (ch) => ch.provider === 'nasa-drive-log',
    meta: load,
    async request(ch) {
      const data = await load();
      return data.points.map((p) => ({ sol: p.sol, utc: msAtSol(p.sol), value: p[ch.field] * (ch.scale ?? 1) }));
    },
  };
}

// Proveedor 2: tiempo de luz calculado en el momento (no usa red)
function lightTimeProvider() {
  const toMinutes = (ms) => lightTimeSeconds(ms) / 60;
  return {
    id: 'light-time',
    name: 'Cálculo orbital en vivo',
    kind: 'en vivo',
    supports: (ch) => ch.provider === 'light-time',
    async request() {
      // Una muestra cada 5 soles desde el aterrizaje hasta hoy: así sale la gráfica de toda la misión
      const now = Date.now(), pts = [];
      for (let sol = 0; sol < solAt(now); sol += 5) pts.push({ sol, utc: msAtSol(sol), value: toMinutes(msAtSol(sol)) });
      pts.push({ sol: solAt(now), utc: now, value: toMinutes(now) });
      return pts;
    },
    subscribe(ch, callback) {
      const tick = () => { const t = Date.now(); callback({ sol: solAt(t), utc: t, value: toMinutes(t) }); };
      tick();
      const id = setInterval(tick, 1000);
      return () => clearInterval(id);
    },
  };
}

// ---------- los 4 canales ----------
const mmss = (min) => {
  const s = Math.round(min * 60);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const CHANNELS = [
  {
    key: 'distance', name: 'Distancia recorrida', unit: 'km', provider: 'nasa-drive-log', field: 'dist_total_m', scale: 0.001,
    color: '#f0954f', digits: 2, show: (v) => nf(2).format(v), axis: (v) => nf(0).format(v),
    explain: 'Lo que Perseverance ha caminado sobre Marte desde que aterrizó, sumando todos sus manejos.',
  },
  {
    key: 'elevation', name: 'Altura del terreno', unit: 'm', provider: 'nasa-drive-log', field: 'elev_geoid',
    color: '#e6c07b', digits: 0, show: (v) => nf(0).format(v), axis: (v) => nf(0).format(v),
    explain: 'Qué tan alto está respecto al «nivel del mar» de Marte. Si es negativo, está más abajo, como dentro de un cráter.',
  },
  {
    key: 'tilt', name: 'Inclinación', unit: '°', provider: 'nasa-drive-log', field: 'tilt',
    color: '#e4685a', digits: 1, show: (v) => nf(1).format(v), axis: (v) => nf(0).format(v),
    explain: 'Cuánto está inclinado el rover al terminar un manejo. 0° es plano; mientras más grande, más empinada la cuesta.',
  },
  {
    key: 'lighttime', name: 'Luz Tierra → Marte', unit: 'min:s', provider: 'light-time',
    color: '#5cc9b5', digits: 2, show: mmss, axis: (v) => nf(0).format(v) + ' min',
    explain: 'Lo que tarda una señal de radio en llegar de la Tierra a Marte. Es el retraso mínimo de cada comando.',
  },
];
for (const c of CHANNELS) {
  // metadatos al estilo Open MCT: qué columna es el dominio (tiempo) y cuál el rango (valor)
  c.values = [
    { key: 'sol', name: 'Sol marciano', hints: { domain: 1 } },
    { key: 'value', name: c.name, unit: c.unit, hints: { range: 1 } },
  ];
}

// ---------- panel ----------
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const SIGN = '−';
const signed = (txt) => txt.replace('-', SIGN);

export async function initMissionControl() {
  const telemetry = new Telemetry();
  CHANNELS.forEach((c) => telemetry.addChannel(c));
  const drive = driveLogProvider();
  telemetry.addProvider(drive);
  telemetry.addProvider(lightTimeProvider());

  const panel = el(`
    <aside id="mission" class="mc" aria-label="Control de misión">
      <header class="mc-head">
        <div><div class="mc-eyebrow">Control de misión</div><div class="mc-title">Perseverance · <span class="mc-sol">sol —</span></div></div>
        <div class="mc-hint"><kbd>T</kbd> ocultar</div>
      </header>
      <div class="mc-cards">${CHANNELS.map((c) => `
        <button type="button" class="mc-card" data-key="${c.key}" aria-pressed="false" style="--c:${c.color}">
          <span class="mc-name">${c.name}</span>
          <span class="mc-valrow"><span class="mc-val">—</span><span class="mc-unit">${c.unit}</span></span>
          <span class="mc-explain">${c.explain}</span>
          <span class="mc-prov"><i class="mc-dot"></i><span class="mc-prov-text"></span></span>
        </button>`).join('')}
      </div>
      <section class="mc-chart">
        <div class="mc-chart-head"><b class="mc-chart-title"></b><span class="mc-chart-read"></span></div>
        <canvas class="mc-canvas"></canvas>
        <div class="mc-chart-foot">Toda la misión, del aterrizaje (sol 0) a hoy. Toca un dato para graficarlo.</div>
      </section>
      <footer class="mc-foot"></footer>
    </aside>`);
  document.body.appendChild(panel);

  const $ = (sel) => panel.querySelector(sel);
  const cards = Object.fromEntries(CHANNELS.map((c) => [c.key, panel.querySelector(`.mc-card[data-key="${c.key}"]`)]));
  const canvas = $('.mc-canvas'), ctx = canvas.getContext('2d');
  const state = { visible: true, selected: 'distance', ready: false, error: null, channels: {}, currentSol: solAt(Date.now()), meta: null };
  const points = {};
  window.__mission = state;

  function setCard(key, p) {
    const c = telemetry.channel(key);
    const card = cards[key];
    card.querySelector('.mc-val').textContent = signed(c.show(p.value));
    state.channels[key] = { ...(state.channels[key] || {}), name: c.name, unit: c.unit, value: p.value, sol: p.sol,
      text: signed(c.show(p.value)), provider: telemetry.providerOf(key).id };
  }

  // ---------- gráfica ----------
  let hover = null;
  function draw() {
    const c = telemetry.channel(state.selected), pts = points[state.selected];
    if (!pts || !pts.length) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pad = { l: 46, r: 12, t: 10, b: 20 };
    const xmin = 0, xmax = Math.max(state.currentSol, pts.at(-1).sol);
    let ymin = Math.min(...pts.map((p) => p.value)), ymax = Math.max(...pts.map((p) => p.value));
    if (state.selected === 'distance') ymin = 0;
    const span = ymax - ymin || 1;
    if (state.selected !== 'distance') ymin -= span * 0.08;
    ymax += span * 0.08;
    const X = (v) => pad.l + ((v - xmin) / (xmax - xmin)) * (w - pad.l - pad.r);
    const Y = (v) => pad.t + (1 - (v - ymin) / (ymax - ymin)) * (h - pad.t - pad.b);

    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(243,210,174,0.14)';
    ctx.fillStyle = 'rgba(243,210,174,0.62)';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 3; i++) {
      const v = ymin + ((ymax - ymin) * i) / 3, y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillText(signed(c.axis(v)), pad.l - 6, y);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const step = xmax > 1500 ? 500 : 250;
    for (let s = 0; s <= xmax; s += step) {
      ctx.fillText(String(s), X(s), h - pad.b + 5);
    }

    // área + línea
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p.sol), Y(p.value)) : ctx.moveTo(X(p.sol), Y(p.value))));
    ctx.lineJoin = 'round'; ctx.lineWidth = 2; ctx.strokeStyle = c.color; ctx.stroke();
    ctx.lineTo(X(pts.at(-1).sol), Y(ymin)); ctx.lineTo(X(pts[0].sol), Y(ymin)); ctx.closePath();
    const g = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
    g.addColorStop(0, c.color + '55'); g.addColorStop(1, c.color + '00');
    ctx.fillStyle = g; ctx.fill();

    // marca del último dato (o del punto bajo el cursor)
    const mark = hover ?? pts.at(-1);
    ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(243,210,174,0.4)';
    ctx.beginPath(); ctx.moveTo(X(mark.sol), pad.t); ctx.lineTo(X(mark.sol), h - pad.b); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#2a1408'; ctx.strokeStyle = c.color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(X(mark.sol), Y(mark.value), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

    const read = hover ?? pts.at(-1);
    $('.mc-chart-read').textContent = `sol ${Math.round(read.sol)} · ${signed(c.show(read.value))} ${c.unit}`;
  }
  function select(key) {
    state.selected = key;
    hover = null;
    for (const k in cards) cards[k].setAttribute('aria-pressed', String(k === key));
    $('.mc-chart-title').textContent = `${telemetry.channel(key).name} (${telemetry.channel(key).unit})`;
    draw();
  }
  canvas.addEventListener('pointermove', (e) => {
    const pts = points[state.selected];
    if (!pts) return;
    const r = canvas.getBoundingClientRect(), pad = { l: 46, r: 12 };
    const xmax = Math.max(state.currentSol, pts.at(-1).sol);
    const sol = ((e.clientX - r.left - pad.l) / (r.width - pad.l - pad.r)) * xmax;
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.sol - sol) < Math.abs(best.sol - sol)) best = p;
    hover = best; draw();
  });
  canvas.addEventListener('pointerleave', () => { hover = null; draw(); });
  for (const c of CHANNELS) cards[c.key].addEventListener('click', () => select(c.key));
  addEventListener('resize', draw);

  // ---------- tecla T ----------
  function setVisible(v) {
    state.visible = v;
    panel.classList.toggle('mc-hidden', !v);
    panel.setAttribute('aria-hidden', String(!v));
    if (v) requestAnimationFrame(draw);
  }
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyT' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    setVisible(!state.visible);
  });

  // ---------- cargar los 4 datos ----------
  try {
    for (const c of CHANNELS) {
      points[c.key] = await telemetry.request(c.key);
      const last = points[c.key].at(-1);
      if (!Number.isFinite(last?.value)) throw new Error(`El canal "${c.key}" no devolvió un número`);
      state.channels[c.key] = { points: points[c.key].length };
      setCard(c.key, last);
      const prov = telemetry.providerOf(c.key);
      cards[c.key].querySelector('.mc-prov-text').textContent =
        c.provider === 'nasa-drive-log' ? `${prov.name} · sol ${last.sol}` : `${prov.name} · ahora`;
      cards[c.key].classList.toggle('live', prov.kind === 'en vivo');
    }
    state.meta = await drive.meta();
    // en vivo: el tiempo de luz se recalcula cada segundo
    telemetry.subscribe('lighttime', (p) => {
      state.currentSol = p.sol;
      points.lighttime[points.lighttime.length - 1] = p;
      setCard('lighttime', p);
      $('.mc-sol').textContent = `sol ${Math.floor(p.sol)}`;
      if (state.selected === 'lighttime' && state.visible && !hover) draw();
    });
    const fetched = new Date(state.meta.fetchedAt).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' });
    const lastSol = points.distance.at(-1).sol;
    $('.mc-foot').textContent = `Datos de la NASA/JPL (MMGIS), copia del ${fetched}. Último manejo: sol ${lastSol}; hoy es el sol ${Math.floor(state.currentSol)}.`;
    select('distance');
    state.ready = true;
  } catch (err) {
    state.error = String(err.message || err);
    console.error('[control de misión]', err);
    $('.mc-foot').textContent = `No se pudieron cargar los datos: ${state.error}`;
  }
  return { telemetry, state, setVisible };
}
