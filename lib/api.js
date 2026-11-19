// The app's API, independent of transport. server.js serves it over HTTP; the
// static build runs it in the browser against a saved snapshot.
import { productUrl } from './util.js';
import {
  buildIndex, waysToGet, summarise, itemsFromProducts, localSearch, tokenise,
  adviseItem, highlights, saleCategories, upcomingEvents, itemSkuFor,
} from './deals.js';

const SORTS = {
  relevance: () => 0,
  price: (a, b) => (a.best?.price ?? Infinity) - (b.best?.price ?? Infinity),
  saving: (a, b) => b.saving - a.saving,
};

/**
 * state: { catalog, menu, history, crawling?, lastError?, crawlHours? }
 * opts.rankSearch(q) -> Promise<sku[]> | null  (store search; falls back to local matching)
 */
export function createApi(state, { rankSearch = null, isStatic = false, loadDetails = null } = {}) {
  let index = null;
  let saleCats = new Map();
  let cachedHighlights = null;

  function reload() {
    index = state.catalog ? buildIndex(state.catalog.products) : null;
    saleCats = saleCategories(state.menu);
    cachedHighlights = null;
  }
  reload();

  const ctx = () => ({ now: new Date(), saleCats, events: upcomingEvents() });

  function cards(skus, sort) {
    const { products } = state.catalog;
    const c = ctx();
    const list = skus.map((sku) => summarise(sku, products, index, state.history, c)).filter((x) => x.best);
    if (sort && SORTS[sort]) list.sort(SORTS[sort]);
    return list;
  }

  async function search(q, sort) {
    const { products } = state.catalog;
    let ranked = null;
    let source = 'store';
    if (rankSearch) {
      try {
        ranked = (await rankSearch(q)).map((sku) => products[sku]).filter(Boolean);
      } catch {
        ranked = null;
      }
    }
    if (!ranked) {
      ranked = localSearch(q, products);
      source = 'local';
    }
    return { q, source, items: cards(itemsFromProducts(ranked, products, index, { tokens: tokenise(q) }), sort) };
  }

  function findCategory(id, node = state.menu, trail = []) {
    if (!node) return null;
    if (node.id === id) return { node, trail };
    for (const c of node.children ?? []) {
      const hit = findCategory(id, c, [...trail, { id: node.id, name: node.name }]);
      if (hit) return hit;
    }
    return null;
  }

  function category(id, sort) {
    const { products } = state.catalog;
    const hit = findCategory(id);
    const ids = new Set();
    (function walk(n) { ids.add(n.id); n.children?.forEach(walk); })(hit?.node ?? { id });
    const list = Object.values(products).filter((p) => !p.unlisted && p.categories.some((c) => ids.has(c)));
    // Simple products first so items keep their own position; bundles then add components.
    list.sort((a, b) => (a.type === 'bundle') - (b.type === 'bundle'));
    return {
      id, name: hit?.node.name ?? 'Category', trail: hit?.trail.slice(1) ?? [],
      children: (hit?.node.children ?? []).filter((c) => c.inMenu).map((c) => ({ id: c.id, name: c.name })),
      items: cards(itemsFromProducts(list, products, index, { categoryIds: ids }), sort ?? 'saving'),
    };
  }

  function item(sku) {
    const { products } = state.catalog;
    const itemSku = itemSkuFor(sku, index);
    const it = products[itemSku];
    if (!it) return null;
    const ways = waysToGet(itemSku, products, index);
    const best = ways.find((w) => w.inStock) ?? ways[0] ?? null;
    return {
      sku: itemSku, name: it.name, image: it.image, url: productUrl(it), unlisted: !!it.unlisted,
      variants: it.variants ?? null, ways,
      advice: adviseItem(itemSku, best, products, state.history, ctx()),
      history: { best: state.history.series[`best:${itemSku}`] ?? [], alone: state.history.series[itemSku] ?? [] },
      pastSales: [...new Set((it.categories ?? []).map((id) => saleCats.get(id)).filter(Boolean).map((s) => s.name.trim()))],
      trackingSince: state.history.startedAt, lastCheck: state.catalog.updatedAt,
    };
  }

  function status() {
    return {
      ready: !!state.catalog, static: isStatic,
      updatedAt: state.catalog?.updatedAt ?? null,
      products: state.catalog?.count ?? 0,
      trackingSince: state.history?.startedAt ?? null,
      checks: state.history?.checks.length ?? 0,
      crawling: state.crawling ?? null,
      lastError: state.lastError ?? null,
      crawlHours: state.crawlHours ?? null,
      events: upcomingEvents().slice(0, 4),
    };
  }

  /** Route an API path (without the /api/ prefix). Returns [httpStatus, body]. */
  async function handle(path, params = new URLSearchParams()) {
    if (path === 'status') return [200, status()];
    if (!state.catalog) return [503, { error: 'Catalogue is still loading', status: status() }];
    const sort = params.get('sort') || undefined;
    if (path === 'menu') return [200, state.menu];
    if (path === 'search') return [200, await search(params.get('q') ?? '', sort)];
    if (path.startsWith('category/')) return [200, category(Number(path.split('/')[1]), sort)];
    if (path.startsWith('item/')) {
      const d = item(decodeURIComponent(path.slice('item/'.length)));
      return d ? [200, d] : [404, { error: 'Not found' }];
    }
    if (path.startsWith('details/')) {
      const d = loadDetails ? await loadDetails(decodeURIComponent(path.slice('details/'.length))) : null;
      return d ? [200, d] : [404, { error: 'No details yet' }];
    }
    if (path === 'highlights') {
      cachedHighlights ??= highlights(state.catalog.products, index, state.history, ctx());
      return [200, cachedHighlights];
    }
    return [404, { error: 'Unknown endpoint' }];
  }

  return { handle, reload, status };
}
