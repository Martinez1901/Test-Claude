// npm run photos: baja las fotos reales de Marte escogidas a mano y las guarda en public/photos/.
//
// Selección: de cada cámara se miraron ~48 candidatas de los últimos soles (hojas de contactos) y se
// escogieron las 6 más vistosas: a color, con rocas de cerca, el brazo sobre el suelo o el horizonte;
// sin cielo vacío, sin calibración y sin miniaturas. Aquí quedan solo los identificadores (imageid).
// Los metadatos (sol, fecha, crédito) se piden a la API oficial de la NASA para cada una.
import { mkdir, writeFile } from 'node:fs/promises';

const API = 'https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json&ver=1.2';

const CURATED = {
  mastcamz: [
    'ZL0_2022_0846443668_928EBY_N0920000ZCAM04497_1100LMJ', // roca abrasada con el agujero de perforación
    'ZL0_2024_0846622583_145EBY_N0930000ZCAM10058_1100LMJ',
    'ZL0_2024_0846622499_146EBY_N0930000ZCAM10058_1100LMJ',
    'ZR0_2024_0846622537_145EBY_N0930000ZCAM10058_1100LMJ',
    'ZL0_2023_0846533187_473EBY_N0930000ZCAM10057_1100LMJ',
    'ZR0_2023_0846533673_957EBY_N0930000ZCAM04498_1100LMJ',
  ],
  navcam: [
    'NLF_2022_0846447080_692ECM_N0930000NCAM00709_03_090J', // brazo sobre las rocas
    'NLF_2022_0846447859_224ECM_N0930000NCAM03022_01_190J', // horizonte y colinas
    'NLF_2022_0846455714_722ECM_N0930000NCAM13022_04_195J',
    'NRF_2022_0846456110_237ECM_N0930000NCAM02022_10_195J',
    'NRF_2022_0846455714_722ECM_N0930000NCAM13022_01_195J', // cubierta del rover
    'NLF_2018_0846090470_395ECM_N0920000NCAM00709_03_095J', // roca con huellas de ruedas
  ],
  hazcam: [
    'FLF_2019_0846185639_601ECM_N0920000FHAZ00206_01_295J', // brazo sobre el suelo con horizonte
    'FLF_2014_0845735562_034ECM_N0920000FHAZ00206_01_295J',
    'FLF_2017_0846008652_035ECM_N0920000FHAZ00215_04_075J', // torreta junto a una roca
    'FRF_2023_0846549166_489ECM_N0930000FHAZ02008_08_095J', // rueda sobre el terreno
    'FLF_2023_0846549166_489ECM_N0930000FHAZ02008_01_095J',
    'FRF_2018_0846090574_426ECM_N0920000FHAZ02008_01_095J',
  ],
  watson: [
    'SIF_2021_0846350792_144EBY_N0920000SRLC07008_0000LMJ', // la torreta con el brazo sobre el suelo
    'SIF_2023_0846549705_738EBY_N0930000SRLC02503_0000LMJ',
    'SIF_2023_0846549856_000EBY_N0930000SRLC00630_0000LMJ',
    'SIF_2019_0846185758_792EBY_N0920000SRLC00878_0000LMJ', // agujero de perforación
    'SIF_2014_0845733774_816EBY_N0920000SRLC00648_0000LMJ',
    'SIF_2011_0845479990_507EBY_N0920000SRLC01025_0000LMJ', // zona abrasada
  ],
};

const manifest = { source: 'https://mars.nasa.gov/mars2020/multimedia/raw-images/', fetchedAt: new Date().toISOString(), cameras: {} };
for (const [cam, ids] of Object.entries(CURATED)) {
  await mkdir(`public/photos/${cam}`, { recursive: true });
  manifest.cameras[cam] = [];
  for (const [n, id] of ids.entries()) {
    const meta = await (await fetch(`${API}&id=${id}`)).json();
    const im = (meta.image ?? meta.images)?.[0]; // por id la API usa "image"
    if (!im) throw new Error(`La NASA no devolvió la imagen ${id}`);
    const res = await fetch(im.image_files.large);
    const bytes = Buffer.from(await res.arrayBuffer());
    // se valida con la firma real del JPEG (FF D8 FF); el servidor etiqueta el tipo como "image/jpg"
    if (!res.ok || bytes.length < 20000 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new Error(`No se pudo bajar una foto JPEG válida de ${im.image_files.large} (${res.status})`);
    }
    const file = `${cam}/${n}.jpg`;
    await writeFile(`public/photos/${file}`, bytes);
    manifest.cameras[cam].push({
      file, imageid: id, sol: im.sol, utc: im.date_taken_utc, instrument: im.camera.instrument,
      credit: im.credit, link: im.link,
    });
  }
  console.log(cam, manifest.cameras[cam].map((p) => `sol ${p.sol}`).join(', '));
}
await writeFile('public/photos/manifest.json', JSON.stringify(manifest, null, 1));
console.log('public/photos/manifest.json');
