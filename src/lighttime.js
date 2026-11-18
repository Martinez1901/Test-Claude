// Tiempo de luz Tierra–Marte, calculado sin red.
// Posiciones aproximadas de los planetas con elementos keplerianos de JPL (E. M. Standish,
// "Keplerian Elements for Approximate Positions of the Major Planets", Tabla 1, válida 1800–2050).
// Error típico: decenas de miles de km, o sea menos de un segundo de luz sobre 4–24 minutos.

const AU_LIGHT_SECONDS = 499.004784; // segundos que tarda la luz en recorrer 1 UA
const DEG = Math.PI / 180;

// [valor en J2000, variación por siglo juliano] para a, e, I, L, long. del perihelio, long. del nodo
const ELEMENTS = {
  earth: { // baricentro Tierra–Luna
    a: [1.00000261, 0.00000562], e: [0.01671123, -0.00004392], I: [-0.00001531, -0.01294668],
    L: [100.46457166, 35999.37244981], peri: [102.93768193, 0.32327364], node: [0.0, 0.0],
  },
  mars: {
    a: [1.52371034, 0.00001847], e: [0.0933941, 0.00007882], I: [1.84969142, -0.00813131],
    L: [-4.55343205, 19140.30268499], peri: [-23.94362959, 0.44441088], node: [49.55953891, -0.29257343],
  },
};

function heliocentric(el, T) {
  const v = (k) => el[k][0] + el[k][1] * T;
  const a = v('a'), e = v('e'), I = v('I') * DEG, peri = v('peri'), node = v('node') * DEG;
  const omega = (peri - v('node')) * DEG;
  let M = (((v('L') - peri) % 360) + 540) % 360 - 180; // -180..180
  M *= DEG;
  let E = M + e * Math.sin(M); // ecuación de Kepler por Newton
  for (let i = 0; i < 12; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(omega), sw = Math.sin(omega), cn = Math.cos(node), sn = Math.sin(node), ci = Math.cos(I), si = Math.sin(I);
  return [
    (cw * cn - sw * sn * ci) * xp + (-sw * cn - cw * sn * ci) * yp,
    (cw * sn + sw * cn * ci) * xp + (-sw * sn + cw * cn * ci) * yp,
    sw * si * xp + cw * si * yp,
  ];
}

/** Distancia Tierra–Marte en unidades astronómicas para un instante (ms desde 1970). */
export function earthMarsAU(ms) {
  const jd = ms / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  const e = heliocentric(ELEMENTS.earth, T), m = heliocentric(ELEMENTS.mars, T);
  return Math.hypot(m[0] - e[0], m[1] - e[1], m[2] - e[2]);
}

/** Segundos que tarda una señal de radio en ir de la Tierra a Marte (un sentido). */
export function lightTimeSeconds(ms) {
  return earthMarsAU(ms) * AU_LIGHT_SECONDS;
}
