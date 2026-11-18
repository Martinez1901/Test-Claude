// npm run check: abre la página en un Chromium invisible, conduce el rover, guarda capturas y lista errores de consola.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('screenshots', { recursive: true });

const server = await createServer({ server: { port: 0, strictPort: false, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0];

const errors = [];
const logs = [];
let browser;
const launchOpts = {
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
};
try {
  try {
    browser = await chromium.launch(launchOpts);
  } catch (e) {
    if (/Executable doesn't exist/i.test(String(e))) {
      console.log('Descargando Chromium para Playwright...');
      const { execSync } = await import('node:child_process');
      execSync('npx playwright install chromium', { stdio: 'inherit' });
      browser = await chromium.launch(launchOpts);
    } else throw e;
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (m) => {
    if (m.type() === 'log') logs.push(m.text());
    if (['error', 'warning'].includes(m.type()) && !/GPU stall|GL Driver Message|AudioContext encountered an error/.test(m.text())) errors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__rover && (window.__frames || 0) > 3, null, { timeout: 300000 })
    .catch(() => errors.push('[check] el rover no cargó / la escena no renderizó frames'));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'screenshots/check.png', timeout: 120000 });

  // ---- Control de misión: los 4 datos cargaron con números reales ----
  const fail = (msg) => errors.push(`[check] ${msg}`);
  await page.waitForFunction(() => window.__mission && (window.__mission.ready || window.__mission.error), null, { timeout: 60000 })
    .catch(() => fail('el control de misión no terminó de cargar'));
  const mission = await page.evaluate(() => window.__mission && JSON.parse(JSON.stringify({
    ready: window.__mission.ready, error: window.__mission.error, channels: window.__mission.channels,
  })));
  if (!mission) fail('no existe window.__mission');
  else if (mission.error) fail(`control de misión con error: ${mission.error}`);
  else {
    // [clave, mínimo plausible, máximo plausible]
    const ranges = { distance: [10, 200], elevation: [-4500, 0], tilt: [0, 45], lighttime: [3, 23] };
    for (const [key, [lo, hi]] of Object.entries(ranges)) {
      const c = mission.channels[key];
      if (!c || !Number.isFinite(c.value)) fail(`el dato "${key}" no tiene un número`);
      else if (c.value < lo || c.value > hi) fail(`el dato "${key}" = ${c.value} ${c.unit} fuera del rango plausible [${lo}, ${hi}]`);
    }
    for (const key of ['distance', 'elevation', 'tilt', 'lighttime']) {
      if (!(mission.channels[key]?.points > 100)) fail(`el dato "${key}" tiene pocos puntos para la gráfica (${mission.channels[key]?.points})`);
    }
    console.log('Control de misión:', Object.entries(mission.channels).map(([k, c]) => `${k}=${c.text} ${c.unit} (${c.provider})`).join(' | '));
  }
  // la gráfica pintó algo (no está en blanco)
  const painted = await page.evaluate(() => {
    const cv = document.querySelector('.mc-canvas');
    if (!cv) return 0;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  if (painted < 500) fail(`la gráfica parece vacía (${painted} píxeles pintados)`);
  await page.screenshot({ path: 'screenshots/mission.png', timeout: 120000 });
  // tecla T: oculta y vuelve a mostrar
  const panelVisible = () => page.evaluate(() => {
    const p = document.getElementById('mission');
    return { flag: window.__mission.visible, css: getComputedStyle(p).visibility };
  });
  const v0 = await panelVisible();
  if (v0.css !== 'visible' || !v0.flag) fail('el panel debería empezar visible');
  // la transición dura 0,22 s, pero sin GPU cada frame tarda mucho: se espera el cambio real (hasta 20 s)
  const settle = (css) => page.waitForFunction((c) => getComputedStyle(document.getElementById('mission')).visibility === c, css, { timeout: 20000 }).catch(() => {});
  await page.keyboard.press('KeyT');
  await settle('hidden');
  const v1 = await panelVisible();
  if (v1.css !== 'hidden' || v1.flag) fail(`la tecla T no ocultó el panel (${JSON.stringify(v1)})`);
  await page.screenshot({ path: 'screenshots/mission-hidden.png', timeout: 120000 });
  await page.keyboard.press('KeyT');
  await settle('visible');
  const v2 = await panelVisible();
  if (v2.css !== 'visible' || !v2.flag) fail(`la tecla T no volvió a mostrar el panel (${JSON.stringify(v2)})`);
  console.log(`Tecla T: ${v0.css} → ${v1.css} → ${v2.css}`);

  // ---- Cámaras de Percy: 4 puntos, nombre al pasar el mouse, cada una abre una foto real ----
  await page.waitForFunction(() => window.__cameras && (window.__cameras.ready || window.__cameras.error), null, { timeout: 60000 })
    .catch(() => fail('las cámaras no terminaron de cargar'));
  const camState = await page.evaluate(() => window.__cameras && ({ error: window.__cameras.error, hotspots: window.__cameras.hotspots }));
  if (!camState || camState.error) fail(`cámaras con error: ${camState?.error}`);
  else {
    const expected = ['Mastcam-Z', 'NavCam', 'HazCam frontal', 'WATSON'];
    const names = camState.hotspots.map((h) => h.name);
    if (JSON.stringify(names) !== JSON.stringify(expected)) fail(`puntos de cámara inesperados: ${names.join(', ')}`);
    for (const h of camState.hotspots) if (!h.visible) fail(`el punto de "${h.name}" no está visible en pantalla`);
    await page.screenshot({ path: 'screenshots/cameras.png', timeout: 120000 });

    const viewer = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__cameras.viewer)) );
    const loaded = (min) => page.evaluate((m) => {
      const v = window.__cameras.viewer, img = document.querySelector('.ph-img');
      return v.open && v.stage !== 'shooting' && img.complete && img.naturalWidth >= m;
    }, min);
    const cameraNames = {};
    for (const [n, h] of camState.hotspots.entries()) {
      // al pasar el mouse aparece el nombre (se pide la posición fresca: el punto late)
      const pos = await page.evaluate((key) => window.__cameras.hotspots.find((x) => x.key === key), h.key);
      await page.mouse.move(pos.x, pos.y);
      const tip = await page.waitForFunction(() => { const t = document.querySelector('.cam-tip'); return t && !t.hidden ? t.textContent : null; }, null, { timeout: 30000 })
        .then((j) => j.jsonValue()).catch(() => null);
      if (!tip || !tip.includes(h.name)) fail(`al pasar el mouse sobre "${h.name}" no apareció su nombre (${tip})`);
      // clic: obturador + foto
      const pos2 = await page.evaluate((key) => window.__cameras.hotspots.find((x) => x.key === key), h.key);
      await page.mouse.click(pos2.x, pos2.y);
      const ok = await page.waitForFunction(() => { const v = window.__cameras.viewer, i = document.querySelector('.ph-img'); return v.open && v.stage !== 'shooting' && i.complete && i.naturalWidth >= 600; }, null, { timeout: 60000 }).then(() => true).catch(() => false);
      const v = await viewer();
      if (!ok) { fail(`la cámara "${h.name}" no abrió una foto real (${JSON.stringify(v)})`); await page.keyboard.press('Escape'); continue; }
      if (!v.src?.includes(`/photos/${h.key}/`)) fail(`la foto de "${h.name}" no viene de su carpeta (${v.src})`);
      if (!(v.label?.sol > 1000) || !/^(hoy|hace [0-9]+ días?)$/.test(v.label?.ago || '')) fail(`la foto de "${h.name}" no indica sol y antigüedad (${JSON.stringify(v.label)})`);
      cameraNames[h.name] = `sol ${v.label?.sol}, ${v.label?.ago}, ${v.naturalWidth}px`;

      if (n === 0) {
        // primera cámara: ciclo completo. Se espera a que la foto termine de revelarse, quede quieta y se muestre grande
        await page.waitForFunction(() => window.__cameras.viewer.stage === 'ready' && window.__cameras.viewer.size === 'large', null, { timeout: 120000 })
          .catch(() => fail('la foto no llegó a mostrarse grande (revelar → quieta → grande)'));
        await page.screenshot({ path: 'screenshots/photo-open.png', timeout: 120000 });
        await page.keyboard.press('ArrowRight');
        const idx = await page.waitForFunction(() => window.__cameras.viewer.index === 1, null, { timeout: 60000 }).then(() => true).catch(() => false);
        if (!idx) fail('la flecha derecha no pasó a la siguiente foto');
        await page.waitForFunction(() => window.__cameras.viewer.stage === 'ready', null, { timeout: 60000 }).catch(() => {});
        await page.click('.ph-frame');
        const full = await page.evaluate(() => window.__cameras.viewer.size);
        if (full !== 'full') fail(`el clic no amplió la foto (tamaño: ${full})`);
        await page.screenshot({ path: 'screenshots/photo-full.png', timeout: 120000 });
      }
      await page.keyboard.press('Escape');
      const closed = await page.waitForFunction(() => !window.__cameras.viewer.open && !document.body.classList.contains('viewing'), null, { timeout: 30000 }).then(() => true).catch(() => false);
      if (!closed) fail(`Esc no devolvió al juego desde "${h.name}"`);
    }
    console.log('Cámaras:', Object.entries(cameraNames).map(([k, t]) => `${k} (${t})`).join(' | '));
  }

  // Conducir: recto con W hasta recorrer ~20 m, luego curva con W+A
  const pos = () => page.evaluate(() => ({ x: window.__rover.x, z: window.__rover.z, h: window.__rover.heading, v: window.__rover.speed }));
  const start = await pos();
  const driveUntil = async (keys, test, timeout) => {
    for (const k of keys) await page.keyboard.down(k);
    const t0 = Date.now();
    while (Date.now() - t0 < timeout && !test(await pos())) await page.waitForTimeout(200);
    for (const k of keys) await page.keyboard.up(k);
  };
  await driveUntil(['KeyW'], (p) => Math.hypot(p.x - start.x, p.z - start.z) > 20, 90000);
  const mid = await pos();
  await driveUntil(['KeyW', 'KeyA'], (p) => Math.abs(p.h - mid.h) > 1.0, 90000);
  await page.waitForTimeout(800);
  const end = await pos();
  const trails = await page.evaluate(() => {
    const t = window.__trails; let n = 0;
    for (let w = 0; w < t.wheelCount; w++) n += t.dist[w] > 0 ? 1 : 0;
    return { wheelsWithTrail: n, totalMeters: t.dist.reduce((a, b) => a + b, 0) };
  });
  await page.screenshot({ path: 'screenshots/drive.png', timeout: 120000 });
  console.log('Conducción:', JSON.stringify({ start, mid, end, trails }));
} finally {
  await browser?.close();
  await server.close();
}

console.log('\n--- consola ---\n' + logs.join('\n') + '\n---------------');
console.log('Capturas: screenshots/check.png, mission.png, mission-hidden.png, cameras.png, photo-open.png, photo-full.png, drive.png');
if (errors.length) {
  console.log(`\n${errors.length} error(es)/aviso(s) de consola:`);
  errors.forEach((e) => console.log(' -', e));
  process.exit(1);
}
console.log('Sin errores de consola.');
