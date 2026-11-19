#!/usr/bin/env node
// Builds the app as plain static files: the same front end and logic, running in
// the browser on the latest saved data. No server needed.
//
//   node build-static.js             -> dist-site/      public website (GitHub Pages etc.)
//   node build-static.js --embedded  -> dist-static/    claude.ai page (no remote images,
//                                                       no hash routing, host adds <head>)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './lib/db.js';

const EMBEDDED = process.argv.includes('--embedded');
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, EMBEDDED ? 'dist-static' : 'dist-site');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'lib'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });

for (const f of ['app.js', 'styles.css']) fs.copyFileSync(path.join(ROOT, 'public', f), path.join(OUT, f));
// Per-item photos/specs, fetched by the item page on demand.
const detailsDir = path.join(DATA_DIR, 'details');
if (fs.existsSync(detailsDir)) fs.cpSync(detailsDir, path.join(OUT, 'data', 'details'), { recursive: true });

for (const f of ['util.js', 'deals.js', 'api.js']) fs.copyFileSync(path.join(ROOT, 'lib', f), path.join(OUT, 'lib', f));
for (const f of ['catalog.json', 'menu.json', 'history.json']) {
  if (!fs.existsSync(path.join(DATA_DIR, f))) throw new Error(`Missing data/${f}. Run \`npm run crawl\` first.`);
  fs.copyFileSync(path.join(DATA_DIR, f), path.join(OUT, 'data', f));
}

fs.writeFileSync(path.join(OUT, 'static.js'), `import { createApi } from './lib/api.js';
import { detailFile } from './lib/util.js';
${EMBEDDED ? 'window.__embedded = true;\n' : ''}const load = (name) => fetch('data/' + name, { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error('Could not load ' + name); return r.json(); });
const ready = Promise.all([load('catalog.json'), load('menu.json'), load('history.json')])
  .then(([catalog, menu, history]) => createApi({ catalog, menu, history }, {
    isStatic: true,
    loadDetails: (sku) => fetch('data/details/' + encodeURIComponent(detailFile(sku))).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  }));
window.__localApi = async (route) => {
  const api = await ready;
  const [p, q] = route.split('?');
  return api.handle(p, new URLSearchParams(q));
};
await import('./app.js');
`);

const src = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
let page = src
  .replace('<main id="app" class="wrap"></main>', '<main id="app" class="wrap"><div class="loading">Loading prices…</div></main>')
  .replace('<script type="module" src="/app.js"></script>', '<script type="module" src="static.js"></script>')
  .replace('href="/styles.css"', 'href="styles.css"');

if (EMBEDDED) {
  // The claude.ai host wraps the page in its own document.
  const body = page.slice(page.indexOf('<body>') + 6, page.indexOf('</body>'));
  page = `<title>4WD Deal Finder</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="styles.css">
<style>body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 31; background: #d7000e; }</style>
${body.trim()}
`;
} else {
  const desc = 'Find the cheapest way to buy any 4WD Supacentre item, on its own or inside a bundle, with price history and buy-now-or-wait advice.';
  page = page.replace('<title>4WD Deal Finder</title>', `<title>4WD Deal Finder</title>
  <meta name="description" content="${desc}">
  <meta property="og:title" content="4WD Deal Finder">
  <meta property="og:description" content="${desc}">
  <meta name="theme-color" content="#d7000e">`);
  fs.writeFileSync(path.join(OUT, '.nojekyll'), ''); // serve files as-is on GitHub Pages
}
fs.writeFileSync(path.join(OUT, 'index.html'), page);
console.log(`Built ${path.relative(ROOT, OUT)}/`);
