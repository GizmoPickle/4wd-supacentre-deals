#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawl } from './lib/crawl.js';
import { readJson, emptyHistory } from './lib/db.js';
import { gql, SEARCH_QUERY } from './lib/store.js';
import { createApi } from './lib/api.js';

const PORT = Number(process.env.PORT || 8790);
const CRAWL_HOURS = Number(process.env.CRAWL_HOURS || 6);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib');

const state = {
  catalog: readJson('catalog.json', null),
  menu: readJson('menu.json', null),
  history: readJson('history.json', emptyHistory()),
  crawling: null, lastError: null, crawlHours: CRAWL_HOURS,
};

const api = createApi(state, {
  rankSearch: async (q) => {
    const data = await gql(SEARCH_QUERY, { q, size: 120 }, { retries: 1, timeoutMs: 15000 });
    return data.products.items.map((i) => i.sku);
  },
});

async function runCrawl() {
  if (state.crawling) return;
  state.crawling = { done: 0, total: null, startedAt: new Date().toISOString() };
  try {
    const r = await crawl({ onProgress: (p) => Object.assign(state.crawling, p) });
    Object.assign(state, { catalog: r.catalog, menu: r.menu, history: r.history, lastError: null });
    api.reload();
    console.log(`[crawl] ${r.products} products in ${r.seconds}s`);
  } catch (err) {
    state.lastError = err.message;
    console.error('[crawl] failed:', err.message);
  } finally {
    state.crawling = null;
  }
}

function crawlIfStale() {
  const age = state.catalog ? Date.now() - Date.parse(state.catalog.updatedAt) : Infinity;
  if (age > CRAWL_HOURS * 3600e3) runCrawl();
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serveFile(res, root, rel) {
  const file = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/api/refresh' && req.method === 'POST') {
      runCrawl();
      res.writeHead(202, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(api.status()));
    }
    if (p.startsWith('/api/')) {
      const [code, body] = await api.handle(p.slice(5), url.searchParams);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(body));
    }
    if (p.startsWith('/lib/')) return serveFile(res, LIB, p.slice(5));
    return serveFile(res, PUBLIC, p === '/' ? 'index.html' : p);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`4WD deal finder on http://localhost:${PORT}  (re-crawls every ${CRAWL_HOURS}h)`);
  crawlIfStale();
  setInterval(crawlIfStale, 15 * 60e3).unref();
});
