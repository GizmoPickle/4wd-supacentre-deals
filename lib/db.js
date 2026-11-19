// JSON-file persistence. Small enough (a few MB) that loading it all into memory
// is simpler and faster than a database.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { round2 } from './util.js';

export { round2 };

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const file = (name) => path.join(DATA_DIR, name);

export function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(name, value, stringify = JSON.stringify) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file(`${name}.tmp`);
  fs.writeFileSync(tmp, stringify(value));
  fs.renameSync(tmp, file(name)); // atomic: a crash never leaves a half-written file
}

/**
 * History shape: { startedAt, checks: [iso...], series: { [key]: [[iso, price], ...] } }
 * A point is appended only when the price changes, so each series is a step function.
 * Keys: "<sku>" = the product's own price, "best:<sku>" = cheapest way to get it
 * (alone or in any bundle) at that time.
 */
/** One check / one product per line, so each committed update is a small, readable diff. */
export function stringifyHistory(h) {
  const checks = h.checks.map((c) => `    ${JSON.stringify(c)}`).join(',\n');
  const series = Object.keys(h.series).sort()
    .map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(h.series[k])}`).join(',\n');
  return `{\n  "startedAt": ${JSON.stringify(h.startedAt)},\n  "checks": [\n${checks}\n  ],\n  "series": {\n${series}\n  }\n}\n`;
}

export function emptyHistory() {
  return { startedAt: null, checks: [], series: {} };
}

export function recordPrice(history, key, at, price) {
  if (price == null || !Number.isFinite(price)) return;
  const s = (history.series[key] ??= []);
  const last = s[s.length - 1];
  if (!last || Math.abs(last[1] - price) >= 0.005) s.push([at, round2(price)]);
}

