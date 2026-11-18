# Plan: Paisaje de Marte cinematográfico (Vite + three.js)

## Contexto
Carpeta casi vacía (solo CLAUDE.md). Node/npm NO están instalados (winget sí). Objetivo: escena de Marte "de película" (dunas, rocas, cielo caramelo con polvo, sol de tarde cálido, sombras suaves, dos lunas Fobos y Deimos), visible en <2 min tras aprobar, y luego mejorada, con un chequeo automático `npm run check`.

## Paso 0 – Prerrequisito (requiere aprobación)
- Instalar Node.js LTS: `winget install OpenJS.NodeJS.LTS` (nivel sistema). Alternativa: instalarlo manualmente desde nodejs.org.

## Paso 1 – Scaffold y servidor (primeros ~2 min)
- `npm init`, `npm i three vite`, `npm i -D playwright`.
- Archivos: `index.html`, `src/main.js`, `vite.config.js` (host, puerto 5173, strictPort), scripts `dev`, `build`, `check`.
- Arrancar `vite` en segundo plano; abrir http://localhost:5173 en el navegador de Cursor.
- Primera versión visible: terreno con dunas (PlaneGeometry + ruido), cielo degradado caramelo, sol direccional cálido con sombras, rocas instanciadas, dos lunas.

## Paso 2 – Mejoras (tras la primera versión)
- Dunas: ruido fBm + crestas anisótropas, color arena/caramelo con variación por pendiente.
- Rocas: IcosahedronGeometry deformada, InstancedMesh, distribución por densidad, sombras.
- Cielo: shader propio (gradiente caramelo-salmón, halo del sol, polvo), niebla exponencial con polvo.
- Luz: sol bajo de tarde (cálido), luz hemisférica tenue, PCFSoftShadowMap, ACES tone mapping.
- Lunas: Fobos (irregular, grande) y Deimos (pequeña) con textura procedural de cráteres.
- Polvo: partículas suaves flotando; cámara con deriva lenta cinematográfica.

## Paso 3 – `npm run check` (scripts/check.mjs)
- Levanta Vite en un puerto libre, abre la página con Playwright en headless (invisible), espera la escena, guarda captura en `screenshots/check.png`, imprime errores/avisos de consola y errores de página, y sale con código ≠0 si hay errores.
- Si falta el navegador: `npx playwright install chromium`.
- Para WebGL headless: flags `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`.

## Paso 4 – Bucle de verificación
- Correr `npm run check` tras cada mejora grande, revisar la captura y corregir. Máximo 3 rondas.
- Listo cuando: 0 errores de consola y la captura muestra dunas, rocas, cielo caramelo con polvo, sol cálido con sombras suaves y las dos lunas.

## Verificación final
`npm run check` sin errores + captura revisada + servidor corriendo en http://localhost:5173.
