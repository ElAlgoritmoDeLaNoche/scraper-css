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
  const importRegex = /@import\s+(?:url\()?["']?([^"')]+)["']?\)?/gi;
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
