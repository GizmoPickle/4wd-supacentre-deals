import { gql, CATALOG_PAGE_QUERY, MENU_QUERY, ROOT_CATEGORY_ID } from './store.js';
import { readJson, writeJson, emptyHistory, recordPrice, round2, stringifyHistory } from './db.js';
import { buildIndex, waysToGet } from './deals.js';
import { refreshDetails } from './details.js';

const PAGE_SIZE = 200;
const CONCURRENCY = 3;

const priceOf = (p) => p?.price_range?.minimum_price?.final_price?.value ?? null;
const regularOf = (p) => p?.price_range?.minimum_price?.regular_price?.value ?? null;
const img = (p) => p?.small_image?.url?.split('?')[0] ?? null;

function normalise(raw) {
  const p = {
    sku: raw.sku,
    id: raw.id,
    name: raw.name?.trim(),
    type: raw.__typename.replace('Product', '').toLowerCase(), // simple | bundle | configurable | virtual ...
    urlKey: raw.url_key,
    urlSuffix: raw.url_suffix ?? '.html',
    image: img(raw),
    price: priceOf(raw),
    regular: regularOf(raw),
    wasPrice: raw.was_price > 0 ? raw.was_price : null,
    inStock: raw.stock_status === 'IN_STOCK',
    specialDeal: !!raw.special_deal,
    categories: (raw.categories ?? []).map((c) => c.id),
  };
  if (raw.items) {
    p.slots = raw.items.map((slot) => ({
      title: slot.title,
      required: slot.required,
      choices: (slot.options ?? [])
        .filter((o) => o.product)
        .map((o) => ({ sku: o.product.sku, qty: o.quantity || 1, isDefault: o.is_default })),
    }));
  }
  if (raw.variants) {
    p.variants = raw.variants
      .filter((v) => v.product)
      .map((v) => ({ sku: v.product.sku, name: v.product.name, price: priceOf(v.product), inStock: v.product.stock_status === 'IN_STOCK' }));
  }
  return p;
}

// Bundle components can be products that are not listed on their own (not sold
// separately). Keep a stub for them so the bundle can still be described.
function componentStubs(raw, products) {
  for (const slot of raw.items ?? []) {
    for (const o of slot.options ?? []) {
      const c = o.product;
      if (c && !products[c.sku]) {
        products[c.sku] = {
          sku: c.sku, name: c.name?.trim(), type: 'component', image: img(c),
          price: priceOf(c), inStock: c.stock_status === 'IN_STOCK', categories: [], unlisted: true,
        };
      }
    }
  }
}

export async function fetchMenu() {
  const data = await gql(MENU_QUERY, { id: String(ROOT_CATEGORY_ID) });
  const clean = (c) => ({
    id: c.id, name: c.name?.trim(), path: c.url_path, position: c.position ?? 0,
    inMenu: c.include_in_menu !== 0,
    children: (c.children ?? []).map(clean).sort((a, b) => a.position - b.position),
  });
  return clean(data.categoryList[0]);
}

/** Crawl the full catalogue, save it, and append to price history. */
export async function crawl({ onProgress = () => {}, onDetailsProgress = () => {}, details = true } = {}) {
  const startedAt = new Date().toISOString();
  const first = await gql(CATALOG_PAGE_QUERY, { page: 1, size: PAGE_SIZE });
  const totalPages = first.products.page_info.total_pages;
  const raws = [...first.products.items];
  let done = 1;
  onProgress({ done, total: totalPages });

  const queue = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const page = queue.shift();
        const data = await gql(CATALOG_PAGE_QUERY, { page, size: PAGE_SIZE });
        raws.push(...data.products.items);
        onProgress({ done: ++done, total: totalPages });
      }
    }),
  );

  const products = {};
  for (const raw of raws) products[raw.sku] = normalise(raw);
  for (const raw of raws) componentStubs(raw, products);

  let menu;
  try {
    menu = await fetchMenu();
  } catch {
    menu = readJson('menu.json', null);
  }

  const catalog = { updatedAt: startedAt, count: raws.length, products };
  writeJson('catalog.json', catalog);
  if (menu) writeJson('menu.json', menu, (m) => `${JSON.stringify(m, null, 1)}\n`);

  const history = readJson('history.json', emptyHistory());
  history.startedAt ??= startedAt;
  history.checks.push(startedAt);
  const index = buildIndex(products);
  for (const p of Object.values(products)) {
    if (p.unlisted) continue;
    recordPrice(history, p.sku, startedAt, p.price);
    if (p.type !== 'bundle') {
      const best = waysToGet(p.sku, products, index).find((w) => w.inStock) ?? null;
      if (best) recordPrice(history, `best:${p.sku}`, startedAt, best.price);
    }
  }
  writeJson('history.json', history, stringifyHistory);

  // Photos, descriptions and specs for every product sold on its own (takes seconds).
  const detailStats = details ? await refreshDetails(products, { onProgress: onDetailsProgress }) : null;
  return { catalog, menu, history, details: detailStats, products: raws.length, pages: totalPages, seconds: round2((Date.now() - Date.parse(startedAt)) / 1000) };
}
