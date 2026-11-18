// npm run data: baja el historial de manejos de Perseverance (NASA/JPL, MMGIS) y guarda una copia reducida
// en public/data/m20-waypoints.json.
//
// Por qué una copia y no leerlo directo desde el juego: el servidor de la NASA no manda la cabecera CORS,
// así que el navegador bloquea la lectura desde otra dirección. Este script (Node) sí puede leerlo.
// Se queda solo con lo necesario: sin fotos (son del acto 3) y solo los puntos de fin de manejo.
import { mkdir, writeFile } from 'node:fs/promises';

const URL_SRC = 'https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json';
const OUT = 'public/data/m20-waypoints.json';

const res = await fetch(URL_SRC);
if (!res.ok) throw new Error(`NASA respondió ${res.status} para ${URL_SRC}`);
const geo = await res.json();
if (!Array.isArray(geo.features)) throw new Error('Formato inesperado: falta "features"');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > -9999 ? v : null);
const points = geo.features
  .map((f) => f.properties)
  .filter((p) => p.final === 'y') // "m" = punto intermedio, trae dist_total_m = 0
  .map((p) => ({
    sol: num(p.sol),
    drive: num(p.drive),
    site: num(p.site),
    dist_total_m: num(p.dist_total_m),
    elev_geoid: num(p.elev_geoid),
    tilt: num(p.tilt),
    lat: num(p.lat),
    lon: num(p.lon),
  }))
  .filter((p) => p.sol !== null && p.dist_total_m !== null && p.elev_geoid !== null && p.tilt !== null)
  .sort((a, b) => a.sol - b.sol || a.dist_total_m - b.dist_total_m);

if (points.length < 100) throw new Error(`Muy pocos puntos válidos (${points.length}); no se guarda`);

// La distancia acumulada nunca baja: si baja, el dato está mal
for (let i = 1; i < points.length; i++) {
  if (points[i].dist_total_m < points[i - 1].dist_total_m) {
    throw new Error(`Distancia no monótona en el sol ${points[i].sol}`);
  }
}

const out = {
  source: URL_SRC,
  provider: 'NASA/JPL-Caltech · MMGIS · Mars 2020 waypoints',
  fetchedAt: new Date().toISOString(),
  lastModified: res.headers.get('last-modified'),
  fields: {
    dist_total_m: 'metros recorridos desde el aterrizaje',
    elev_geoid: 'metros sobre el geoide de Marte (negativo = por debajo)',
    tilt: 'grados de inclinación total (a partir de roll y pitch)',
  },
  count: points.length,
  points,
};
await mkdir('public/data', { recursive: true });
await writeFile(OUT, JSON.stringify(out));

const last = points.at(-1);
console.log(`${OUT}: ${points.length} puntos · sol ${points[0].sol}–${last.sol} · ` +
  `${(last.dist_total_m / 1000).toFixed(2)} km · ${last.elev_geoid.toFixed(1)} m · ${last.tilt.toFixed(1)}°`);
