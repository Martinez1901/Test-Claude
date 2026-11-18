// npm run check: abre la página en un Chromium invisible, guarda captura y lista errores de consola.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('screenshots', { recursive: true });

const server = await createServer({ server: { port: 0, strictPort: false, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0];

const errors = [];
let browser;
try {
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    });
  } catch (e) {
    if (/Executable doesn't exist/i.test(String(e))) {
      console.log('Descargando Chromium para Playwright...');
      const { execSync } = await import('node:child_process');
      execSync('npx playwright install chromium', { stdio: 'inherit' });
      browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
      });
    } else throw e;
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/GPU stall|GL Driver Message/.test(m.text())) errors.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => (window.__frames || 0) > 5, null, { timeout: 120000 }).catch(() => errors.push('[check] la escena no renderizó frames'));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'screenshots/check.png', timeout: 120000 });
} finally {
  await browser?.close();
  await server.close();
}

console.log('Captura: screenshots/check.png');
if (errors.length) {
  console.log(`\n${errors.length} error(es)/aviso(s) de consola:`);
  errors.forEach((e) => console.log(' -', e));
  process.exit(1);
}
console.log('Sin errores de consola.');
