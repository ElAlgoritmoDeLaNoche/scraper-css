# Scraper CSS con Playwright

Captura **todas las hojas de estilo** que un sitio web carga en una ruta dada usando [Playwright].
Incluye:
- Descarga de CSS externo (`<link rel="stylesheet">`, recursos de CDN).
- Resolución de `@import` (1 pasada adicional).
- Extracción de **estilos inline** (`<style>`) a un archivo aparte.
- Salida organizada por host/ruta en `out/css/...`.

> ⚠️ **Aviso legal**: Este repositorio es para *análisis técnico/educativo*. El CSS de un tercero puede estar protegido por **copyright**. No redistribuyas ni uses tal cual en producción sin permiso del propietario. Preferible “inspirarte” y recrear un tema propio.

---

## Requisitos

- Node.js ≥ 18
- Yarn (v1 clásico o v3+ con Corepack)

## Instalación

```bash
git clone https://github.com/<tu-usuario>/<tu-repo>.git
cd <tu-repo>
yarn
# Instala el navegador de Playwright (elige una de las dos opciones)
yarn dlx playwright install chromium   # recomendado si usas Yarn moderno (Corepack)
# o
npx playwright install chromium        # también funciona con Yarn clásico
```

Si aún no creaste el proyecto desde cero, puedes iniciar rápido así:

```bash
mkdir scraper-css && cd scraper-css
yarn init -y
yarn add -D playwright fs-extra
yarn dlx playwright install chromium   # o: npx playwright install chromium
```

## Estructura recomendada

```
.
├── package.json
├── scrape-css.mjs
└── out/
    └── css/
        └── ... (archivos generados)
```

## Uso

### Comandos (scripts)

Agrega estos scripts a tu `package.json`:

```json
{
  "type": "module",
  "scripts": {
    "scrape": "node scrape-css.mjs",
    "scrape:url": "node scrape-css.mjs https://www.soundtrack.io/es/",
    "scrape:custom": "node scrape-css.mjs"
  }
}
```

### Ejecutar

- URL de ejemplo (la del README):  
  ```bash
  yarn scrape:url
  ```

- Cualquier otra URL (pasada por CLI):  
  ```bash
  yarn scrape -- https://tusitio.com/ruta
  ```

### Salida

- CSS externo: `out/css/<host>/<ruta>.css` (con nombre seguro y subcarpetas por host/ruta).
- Estilos inline del documento: `out/css/<host>/<ruta>.inline.css`.

> El nombre de archivo se “normaliza” para evitar caracteres inválidos y preservar estructura de ubicación.

## Cómo funciona

1. Inicia Chromium con Playwright en modo **headless**.
2. Navega a la URL indicada y espera `networkidle` (red ociosa).
3. Registra cada **response** cuyo `resourceType` sea `stylesheet` o `content-type: text/css` y guarda su contenido tal cual.
4. Al finalizar la carga inicial, recorre los CSS capturados y resuelve los `@import` una vez (descarga los CSS importados).
5. Extrae los `<style>` inline del DOM y los escribe en un único archivo `*.inline.css` por página.

## Script principal (`scrape-css.mjs`)

Crea este archivo en la raíz del repo (o valida que coincida con tu versión local):

```js
import { chromium } from "playwright";
import fs from "fs-extra";
import path from "path";

const ARG_URL = process.argv[2];
const START_URL = ARG_URL || "https://www.soundtrack.io/es/";
const OUT_DIR = path.resolve("out/css");

// —— utilidades ——
function safeName(u) {
  try {
    const { hostname, pathname, search } = new URL(u);
    const base = pathname.replace(/[^a-z0-9._/-]+/gi, "_");
    const withHost = path.join(hostname, base || "/");
    const final = (withHost + (search ? "_" + Buffer.from(search).toString("base64url") : ""))
      .replace(/\\/g, "/")
      .replace(/\/$/, "");
    return final.length ? final : hostname;
  } catch {
    return Buffer.from(u).toString("base64url");
  }
}

async function writeFileEnsured(filePath, content) {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

async function saveCss(urlStr, css) {
  const rel = safeName(urlStr);
  const outPath = path.join(OUT_DIR, rel.endsWith(".css") ? rel : rel + ".css");
  await writeFileEnsured(outPath, css);
  return outPath;
}

// —— main ——
(async () => {
  console.log(">> Iniciando captura de CSS");
  console.log(">> URL:", START_URL);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const seen = new Set();
  const saved = [];

  // Capturamos respuestas que sean stylesheets o text/css
  page.on("response", async (res) => {
    try {
      const reqUrl = res.url();
      if (seen.has(reqUrl)) return;

      const ct = (res.headers()["content-type"] || "").toLowerCase();
      const isStylesheet =
        res.request().resourceType() === "stylesheet" || ct.includes("text/css");

      if (!isStylesheet) return;

      const status = res.status();
      if (status < 200 || status >= 400) return;

      const text = await res.text();
      const outPath = await saveCss(reqUrl, text);
      seen.add(reqUrl);
      saved.push({ url: reqUrl, outPath, kind: "external" });
      console.log("CSS saved:", reqUrl, "→", path.relative(process.cwd(), outPath));
    } catch (e) {
      console.warn("Error capturing CSS:", e.message);
    }
  });

  // Navega y espera a quietud de red
  await page.goto(START_URL, { waitUntil: "networkidle", timeout: 60000 });

  // Extrae <style> inline del documento principal (si existen)
  const inlineBlocks = await page.evaluate(() => {
    const arr = [];
    document.querySelectorAll("style").forEach((s, idx) => {
      arr.push({ idx, css: s.textContent || "" });
    });
    return arr;
  });

  if (inlineBlocks.length) {
    const joined = inlineBlocks
      .map(b => `/* inline-style #${b.idx} */\n${b.css}`)
      .join("\n\n");
    const inlinePath = path.join(OUT_DIR, safeName(START_URL) + ".inline.css");
    await writeFileEnsured(inlinePath, joined);
    saved.push({ url: START_URL + "#inline", outPath: inlinePath, kind: "inline" });
    console.log("Inline CSS saved →", path.relative(process.cwd(), inlinePath));
  }

  // Descubre @import dentro de los CSS ya guardados (1 pasada)
  const importRegex = /@import\s+(?:url\()?[\"']?([^\"')]+)[\"']?\)?/gi;
  for (const item of [...saved]) {
    if (item.kind !== "external") continue;
    try {
      const css = await fs.readFile(item.outPath, "utf8");
      let m;
      while ((m = importRegex.exec(css))) {
        const depUrl = new URL(m[1], item.url).toString();
        if (seen.has(depUrl)) continue;
        try {
          const resp = await page.request.get(depUrl);
          if (resp.ok()) {
            const text = await resp.text();
            const outPath = await saveCss(depUrl, text);
            seen.add(depUrl);
            saved.push({ url: depUrl, outPath, kind: "import" });
            console.log("Imported CSS saved:", depUrl, "→", path.relative(process.cwd(), outPath));
          }
        } catch (e) {
          console.warn("Error fetching @import:", depUrl, e.message);
        }
      }
    } catch (e) {
      // archivo pudo no existir o ser binario raro
    }
  }

  await browser.close();

  // Informe final
  console.log("\nResumen:");
  for (const s of saved) {
    console.log(` - [${s.kind}]`, s.url, "→", path.relative(process.cwd(), s.outPath));
  }
  console.log(`Total: ${saved.length} archivos CSS en ${path.relative(process.cwd(), OUT_DIR)}`);
})();
```

## Personalización útil

- **User-Agent** (si el sitio bloquea headless):
  ```js
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  );
  ```

- **Esperas adicionales** si el sitio carga CSS perezosamente:
  ```js
  await page.waitForTimeout(2000);
  ```

- **Directorio de salida**: cambia `OUT_DIR` si prefieres otra ubicación.

## Problemas comunes

- **403/anti-bot**: prueba UA personalizado (arriba) o ejecuta con navegador no headless para depurar.
- **CORS no aplica**: descargamos como el navegador, no por XHR del sitio.
- **No ves fuentes (.woff2)**: se registran como reglas `@font-face` dentro del CSS, no descargamos binarios de fuentes (no es necesario para el objetivo del repo).
- **Minificación**: los CSS se guardan “tal cual” llegan. Puedes añadir un paso de minificación y/o PurgeCSS si quieres reducir a lo usado.

## Roadmap (opcional)

- Flag `--html` para guardar snapshot del HTML y luego poder purgar CSS a lo usado.
- Resolución recursiva de `@import` en múltiples niveles.
- Soporte para cookies/login y páginas autenticadas.
- Export en formato “bundle único” (merge de CSS capturado).

## Licencia

[MIT](./LICENSE) — Incluye reconocimiento y limitaciones estándar.

---

**Hecho con ❤️, Yarn y Playwright.** Si te sirve, deja una ⭐ en tu repo.
