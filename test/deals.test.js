import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, waysToGet, itemsFromProducts, seriesStats, adviseItem, upcomingEvents } from '../lib/deals.js';
import { emptyHistory, recordPrice } from '../lib/db.js';

const products = {
  PANEL: { sku: 'PANEL', name: 'Kings 200W Fixed Solar Panel', type: 'simple', price: 179, inStock: true, categories: [10] },
  BRACKET: { sku: 'BRACKET', name: 'Solar Panel Mounting Brackets', type: 'simple', price: 29.95, inStock: true, categories: [10] },
  TENT: { sku: 'TENT', name: 'Rooftop Tent', type: 'simple', price: 2495, inStock: true, categories: [20] },
  B1: { sku: 'B1', name: 'Panel + Brackets', type: 'bundle', price: 108.95, inStock: true, categories: [],
    slots: [{ title: 'Panel', required: true, choices: [{ sku: 'PANEL', qty: 1 }] }, { title: 'Brackets', required: true, choices: [{ sku: 'BRACKET', qty: 1 }] }] },
  B2: { sku: 'B2', name: '4x Panel', type: 'bundle', price: 600, inStock: true, categories: [],
    slots: [{ title: 'Panels', required: true, choices: [{ sku: 'PANEL', qty: 4 }] }] },
  B3: { sku: 'B3', name: 'Tent + Panel', type: 'bundle', price: 2400, inStock: false, categories: [],
    slots: [{ title: 'Tent', required: true, choices: [{ sku: 'TENT', qty: 1 }] }, { title: 'Panel', required: true, choices: [{ sku: 'PANEL', qty: 1 }] }] },
};
const index = buildIndex(products);
const ctx = (now = new Date('2026-08-01T00:00:00Z')) => ({ now, saleCats: new Map(), events: upcomingEvents(now) });

test('ways are sorted cheapest first and bundles list extras with their value', () => {
  const ways = waysToGet('PANEL', products, index);
  assert.deepEqual(ways.map((w) => w.sku), ['B1', 'PANEL', 'B2', 'B3']);
  assert.equal(ways[0].extras[0].name, 'Solar Panel Mounting Brackets');
  assert.equal(ways[0].extrasValue, 29.95);
  assert.equal(ways.find((w) => w.sku === 'B2').perUnit, 150);
});

test('search results fold bundles into the component the query is about', () => {
  const items = itemsFromProducts([products.B3, products.B1], products, index, { tokens: ['solar', 'panel'] });
  assert.deepEqual(items, ['PANEL']);
  const tentItems = itemsFromProducts([products.B3], products, index, { tokens: ['tent'] });
  assert.deepEqual(tentItems, ['TENT']);
});

function historyOf(points) {
  const h = emptyHistory();
  for (const [at, price] of points) recordPrice(h, 'best:PANEL', at, price);
  h.startedAt = points[0][0];
  return h;
}
const best = (price) => ({ kind: 'bundle', sku: 'B1', price, inStock: true });

test('stats: usual price is the time-weighted median, with sale episodes found', () => {
  const s = seriesStats([['2026-05-01T00:00:00Z', 150], ['2026-06-01T00:00:00Z', 110], ['2026-06-08T00:00:00Z', 150], ['2026-07-01T00:00:00Z', 105], ['2026-07-08T00:00:00Z', 150]], Date.parse('2026-08-01T00:00:00Z'));
  assert.equal(s.typical, 150);
  assert.equal(s.low, 105);
  assert.equal(s.episodes.length, 2);
  assert.ok(Math.abs(s.avgGapDays - 30) < 1);
});

test('advice: wait when it has been meaningfully cheaper before', () => {
  const h = historyOf([['2026-05-01T00:00:00Z', 150], ['2026-06-01T00:00:00Z', 110], ['2026-06-08T00:00:00Z', 150]]);
  const a = adviseItem('PANEL', best(150), products, h, ctx());
  assert.equal(a.verdict, 'wait');
  assert.match(a.headline, /\$110/);
});

test('advice: buy at the lowest tracked price', () => {
  const h = historyOf([['2026-05-01T00:00:00Z', 150], ['2026-07-25T00:00:00Z', 99]]);
  assert.equal(adviseItem('PANEL', best(99), products, h, ctx()).verdict, 'buy');
});

test('advice: early on, a big bundle saving counts as a good deal', () => {
  const h = historyOf([['2026-07-31T00:00:00Z', 108.95]]);
  assert.equal(adviseItem('PANEL', best(108.95), products, h, ctx()).verdict, 'good');
});

test('advice: early on, an upcoming major sale that is not live yet suggests waiting', () => {
  const h = historyOf([['2026-11-18T00:00:00Z', 179]]);
  const a = adviseItem('PANEL', { kind: 'alone', sku: 'PANEL', price: 179, inStock: true }, products, h, ctx(new Date('2026-11-19T00:00:00Z')));
  assert.equal(a.verdict, 'wait');
  assert.match(a.headline, /Black Friday/);
});

test('sale calendar dates', () => {
  const ev = Object.fromEntries(upcomingEvents(new Date('2026-11-19T00:00:00Z')).map((e) => [e.key, e.date]));
  assert.equal(ev.blackfriday, '2026-11-27');
  assert.equal(ev.boxingday, '2026-12-26');
  assert.equal(ev.easter, '2027-03-28');
  assert.equal(ev.eofy, '2027-06-30');
});

test('browsing a category never shows other items from a combo pack', () => {
  // B3 (tent + panel) is listed under the panel's category: only the panel may appear.
  const items = itemsFromProducts([products.B3], products, index, { categoryIds: new Set([10]) });
  assert.deepEqual(items, ['PANEL']);
  const none = itemsFromProducts([products.B3], products, index, { categoryIds: new Set([99]) });
  assert.deepEqual(none, []);
});
