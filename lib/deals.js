// Core logic: every way to get an item (alone or inside any bundle), grouping
// search/category results by item, and the "buy now or wait?" advice.
import { round2, productUrl } from './util.js';

const DAY = 86400000;

/** Reverse indexes: which bundles contain a SKU, and which parent a variant belongs to. */
export function buildIndex(products) {
  const containedIn = new Map(); // component sku -> [{ bundle, qty, slot }]
  const parentOf = new Map(); // variant sku -> configurable parent sku
  for (const p of Object.values(products)) {
    if (p.variants) for (const v of p.variants) parentOf.set(v.sku, p.sku);
    if (!p.slots) continue;
    p.slots.forEach((slot, slotIndex) => {
      for (const c of slot.choices) {
        const list = containedIn.get(c.sku) ?? [];
        if (!list.some((e) => e.bundle === p.sku)) list.push({ bundle: p.sku, qty: c.qty, slotIndex });
        containedIn.set(c.sku, list);
      }
    });
  }
  return { containedIn, parentOf };
}

/** The item a SKU represents: configurable variants roll up into their parent. */
export const itemSkuFor = (sku, index) => index.parentOf.get(sku) ?? sku;

function slotDefault(slot) {
  return slot.choices.find((c) => c.isDefault) ?? slot.choices[0];
}

/**
 * Every way to buy the item, cheapest first.
 * { kind: 'alone' | 'bundle', sku, name, price, qty, perUnit, inStock, url, extras[], extrasValue, image }
 */
export function waysToGet(itemSku, products, index) {
  const item = products[itemSku];
  if (!item) return [];
  const ways = [];
  if (!item.unlisted && item.type !== 'bundle' && item.price != null) {
    ways.push({
      kind: 'alone', sku: item.sku, name: item.name, price: item.price, qty: 1, perUnit: item.price,
      inStock: item.inStock, url: productUrl(item), image: item.image, extras: [], extrasValue: 0,
    });
  }
  const skus = [itemSku, ...(item.variants?.map((v) => v.sku) ?? [])];
  const seen = new Set();
  for (const sku of skus) {
    for (const { bundle, qty, slotIndex } of index.containedIn.get(sku) ?? []) {
      const b = products[bundle];
      if (!b || seen.has(bundle) || b.price == null) continue;
      seen.add(bundle);
      const extras = b.slots
        .filter((s, i) => i !== slotIndex && s.required !== false)
        .map((s) => {
          const c = slotDefault(s);
          const cp = c && products[c.sku];
          return c && { sku: c.sku, name: cp?.name ?? s.title, qty: c.qty, value: cp?.price != null ? round2(cp.price * c.qty) : null };
        })
        .filter(Boolean);
      ways.push({
        kind: 'bundle', sku: b.sku, name: b.name, price: b.price, qty, perUnit: round2(b.price / qty),
        inStock: b.inStock, url: productUrl(b), image: b.image, extras,
        extrasValue: round2(extras.reduce((sum, e) => sum + (e.value ?? 0), 0)),
      });
    }
  }
  // Cheapest outright first; in-stock before out-of-stock at the same price.
  return ways.sort((a, b) => a.price - b.price || Number(b.inStock) - Number(a.inStock));
}

/** One-line card data for an item. */
export function summarise(itemSku, products, index, history, ctx) {
  const item = products[itemSku];
  const ways = waysToGet(itemSku, products, index);
  const best = ways.find((w) => w.inStock) ?? ways[0] ?? null;
  const alone = ways.find((w) => w.kind === 'alone') ?? null;
  const advice = adviseItem(itemSku, best, products, history, ctx);
  return {
    sku: itemSku,
    name: item.name,
    image: item.image ?? best?.image ?? null,
    alone: alone && { price: alone.price, inStock: alone.inStock },
    best: best && {
      kind: best.kind, sku: best.sku, name: best.name, price: best.price, qty: best.qty, perUnit: best.perUnit,
      inStock: best.inStock, url: best.url, extras: best.extras.map((e) => e.name),
    },
    saving: alone && best && best.kind === 'bundle' && alone.price > best.price ? round2(alone.price - best.price) : 0,
    optionCount: ways.length,
    verdict: advice.verdict,
    verdictLabel: advice.label,
  };
}

// ---------------------------------------------------------------------------
// Turning raw product lists into items

const tokenise = (s) => (s ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
const stem = (t) => (t.length > 3 ? t.replace(/(es|s)$/, '') : t);

export function matchesQuery(name, tokens) {
  if (!tokens.length) return true;
  const words = new Set(tokenise(name).map(stem));
  const hay = (name ?? '').toLowerCase();
  return tokens.every((t) => words.has(stem(t)) || hay.includes(t));
}

/**
 * Products (in ranked order) -> unique item SKUs. A bundle contributes the
 * component the shopper is actually after: when browsing, only a component that
 * itself belongs to the category (or a subcategory), never anything else in the
 * pack; when searching, the component matching the query, else its headline item.
 */
export function itemsFromProducts(list, products, index, { tokens = [], categoryIds = null } = {}) {
  const browsing = categoryIds != null;
  const out = [];
  const seen = new Set();
  const add = (sku) => {
    const itemSku = itemSkuFor(sku, index);
    if (!products[itemSku] || seen.has(itemSku)) return;
    seen.add(itemSku);
    out.push(itemSku);
  };
  for (const p of list) {
    if (p.type !== 'bundle') {
      add(p.sku);
      continue;
    }
    const comps = p.slots.flatMap((s) => s.choices.map((c) => c.sku)).filter((sku) => products[sku]);
    const wanted = comps.filter((sku) => {
      const c = products[itemSkuFor(sku, index)] ?? products[sku];
      if (browsing) return c.categories?.some((id) => categoryIds.has(id)) ?? false;
      return tokens.length > 0 && matchesQuery(c.name, tokens);
    });
    // Several matches (e.g. "solar panel" hits both the panel and its brackets):
    // the priciest component is the bundle's main item.
    const priceOf = (sku) => products[itemSkuFor(sku, index)]?.price ?? products[sku]?.price ?? 0;
    const main = wanted.sort((a, b) => priceOf(b) - priceOf(a))[0] ?? (browsing ? null : comps[0]);
    if (main) add(main);
  }
  return out;
}

/** Offline fallback when the store's search API is unreachable. */
export function localSearch(q, products) {
  const tokens = tokenise(q);
  // Popularity proxy: how many bundles a product appears in.
  const bundleCount = new Map();
  for (const p of Object.values(products)) {
    for (const s of p.slots ?? []) for (const c of s.choices) bundleCount.set(c.sku, (bundleCount.get(c.sku) ?? 0) + 1);
  }
  const head = (p) => p.name.split('|')[0];
  const score = (p) =>
    (matchesQuery(head(p), tokens) ? 1000 : 0) + // matched in the product's title, not its feature list
    (p.type === 'bundle' ? 0 : 200) +
    Math.min(bundleCount.get(p.sku) ?? 0, 10) * 4 +
    Math.log10((p.price ?? 0) + 1) * 80 - // main items outrank their cheap accessories
    head(p).length / 10;
  return Object.values(products)
    .filter((p) => !p.unlisted && matchesQuery(p.name, tokens))
    .sort((a, b) => score(b) - score(a));
}

export { tokenise };

// ---------------------------------------------------------------------------
// Sale calendar (Australian retail events the store runs sale categories for)

const lastWeekday = (y, m, wd) => {
  const d = new Date(Date.UTC(y, m + 1, 0));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - wd + 7) % 7));
  return d;
};
const nthWeekday = (y, m, wd, n) => {
  const d = new Date(Date.UTC(y, m, 1));
  d.setUTCDate(1 + ((wd - d.getUTCDay() + 7) % 7) + 7 * (n - 1));
  return d;
};
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}

export const SALE_EVENTS = [
  { key: 'blackfriday', name: 'Black Friday', match: /black\s*friday/i, date: (y) => lastWeekday(y, 10, 5), leadDays: 10 },
  { key: 'cybermonday', name: 'Cyber Monday', match: /cyber/i, date: (y) => new Date(lastWeekday(y, 10, 5).getTime() + 3 * DAY), leadDays: 3 },
  { key: 'boxingday', name: 'Boxing Day', match: /boxing/i, date: (y) => new Date(Date.UTC(y, 11, 26)), leadDays: 5 },
  { key: 'eofy', name: 'End of Financial Year', match: /eofy|financial/i, date: (y) => new Date(Date.UTC(y, 5, 30)), leadDays: 30 },
  { key: 'easter', name: 'Easter', match: /easter/i, date: (y) => easter(y), leadDays: 10 },
  { key: 'mothersday', name: "Mother's Day", match: /mother/i, date: (y) => nthWeekday(y, 4, 0, 2), leadDays: 10 },
  { key: 'fathersday', name: "Father's Day", match: /father/i, date: (y) => nthWeekday(y, 8, 0, 1), leadDays: 14 },
];

/** Next occurrence of each event; `startsIn` is days until its sale period usually opens. */
export function upcomingEvents(now = new Date()) {
  const y = now.getUTCFullYear();
  return SALE_EVENTS.map((ev) => {
    let date = ev.date(y);
    if (date.getTime() + DAY < now.getTime()) date = ev.date(y + 1);
    const daysUntil = Math.ceil((date.getTime() - now.getTime()) / DAY);
    return { key: ev.key, name: ev.name, date: date.toISOString().slice(0, 10), daysUntil, startsIn: Math.max(0, daysUntil - ev.leadDays) };
  }).sort((a, b) => a.daysUntil - b.daysUntil);
}

/** Sale categories under "Specials": active ones are currently shown in the store menu. */
export function saleCategories(menu) {
  const specials = menu?.children?.find((c) => /special/i.test(c.name));
  const map = new Map();
  for (const c of specials?.children ?? []) {
    const ev = SALE_EVENTS.find((e) => e.match.test(c.name));
    map.set(c.id, { id: c.id, name: c.name, active: c.inMenu, event: ev?.key ?? null });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Price-history statistics and advice

/** Time-weighted stats over a step-function series of [iso, price]. */
export function seriesStats(series, nowMs) {
  if (!series?.length) return null;
  const segs = series.map(([t, price], i) => {
    const start = Date.parse(t);
    const end = i + 1 < series.length ? Date.parse(series[i + 1][0]) : nowMs;
    return { start, end: Math.max(end, start + 1), price };
  });
  const total = segs.reduce((s, x) => s + (x.end - x.start), 0);
  // Time-weighted median = the "usual" price.
  const byPrice = [...segs].sort((a, b) => a.price - b.price);
  let acc = 0;
  let typical = byPrice[byPrice.length - 1].price;
  for (const s of byPrice) {
    acc += s.end - s.start;
    if (acc >= total / 2) { typical = s.price; break; }
  }
  const low = Math.min(...segs.map((s) => s.price));
  const high = Math.max(...segs.map((s) => s.price));
  const lowSeg = [...segs].reverse().find((s) => s.price === low);
  // Sale episodes: stretches at least 5% under the usual price.
  const episodes = [];
  for (const s of segs) {
    const onSale = s.price <= typical * 0.95;
    const last = episodes[episodes.length - 1];
    if (onSale && last && last.end === s.start) { last.end = s.end; last.low = Math.min(last.low, s.price); }
    else if (onSale) episodes.push({ start: s.start, end: s.end, low: s.price });
  }
  const starts = episodes.map((e) => e.start);
  const gaps = starts.slice(1).map((t, i) => (t - starts[i]) / DAY);
  return {
    first: segs[0].start, trackedDays: (nowMs - segs[0].start) / DAY,
    current: segs[segs.length - 1].price, typical, low, high,
    lowAt: lowSeg.start, lowUntil: lowSeg.end,
    episodes: episodes.map((e) => ({ start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString(), low: e.low })),
    avgGapDays: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
    lastEpisodeStart: starts.length ? starts[starts.length - 1] : null,
  };
}

const LABELS = { buy: 'Buy now', good: 'Good deal', wait: 'Wait', fair: 'Fair price', new: 'Tracking' };
const money = (n) => `$${n.toFixed(2).replace(/\.00$/, '')}`;
const fmtDate = (ms) => new Date(ms).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
const MIN_TRACKED_DAYS = 14;

/**
 * Advice for an item, judged on the cheapest way to get it (bundles included).
 * ctx: { now: Date, saleCats: Map, events: upcomingEvents() }
 */
export function adviseItem(itemSku, best, products, history, ctx) {
  const nowMs = ctx.now.getTime();
  const item = products[itemSku];
  const reasons = [];
  if (!best) return { verdict: 'fair', label: 'Unavailable', headline: 'Not currently for sale.', reasons, stats: null };

  const series = history.series[`best:${itemSku}`] ?? history.series[itemSku];
  const stats = seriesStats(series, nowMs);
  const current = best.price;

  // Signals from the store itself, available from day one.
  const cats = new Set([...(item.categories ?? []), ...(products[best.sku]?.categories ?? [])]);
  const inSale = [...cats].map((id) => ctx.saleCats.get(id)).filter(Boolean);
  const activeSales = inSale.filter((c) => c.active && c.event);
  const pastEvents = [...new Set(inSale.filter((c) => c.event).map((c) => c.event))];
  const was = products[best.sku]?.wasPrice;
  const regular = products[best.sku]?.regular;
  if (was && was > current) reasons.push(`The store lists a "was" price of ${money(was)}.`);
  else if (regular && regular > current + 0.5) reasons.push(`Marked down from ${money(regular)}.`);
  if (activeSales.length) reasons.push(`It's in the store's ${activeSales.map((c) => c.name.trim()).join(' / ')} right now.`);

  const soon = ctx.events.find((e) => e.startsIn <= 21 && pastEvents.includes(e.key));
  const majorSoon = ctx.events.find((e) => e.daysUntil <= 14 && ['blackfriday', 'cybermonday', 'boxingday', 'eofy'].includes(e.key));
  if (pastEvents.length) {
    const names = pastEvents.map((k) => SALE_EVENTS.find((e) => e.key === k).name);
    reasons.push(`It has been included in past ${names.join(', ')} sales.`);
  }

  const out = (verdict, headline) => ({ verdict, label: LABELS[verdict], headline, reasons, stats, events: ctx.events.slice(0, 3) });

  if (!stats || stats.trackedDays < MIN_TRACKED_DAYS) {
    const since = stats ? fmtDate(stats.first) : 'today';
    if (stats && stats.low < current - 0.5) {
      return out('wait', `It was ${money(stats.low)} on ${fmtDate(stats.lowAt)}, ${money(current - stats.low)} less than now.`);
    }
    if (activeSales.length || (was && was > current * 1.1)) {
      return out('good', `On sale now. Tracking since ${since}, so it's too early to say whether it will go lower.`);
    }
    if (soon) {
      return out('wait', `${SALE_EVENTS.find((e) => e.key === soon.key).name} is ${soon.daysUntil} days away and this item has been part of that sale before.`);
    }
    const liveEvent = majorSoon && [...ctx.saleCats.values()].some((c) => c.active && c.event === majorSoon.key);
    if (majorSoon && !liveEvent) {
      return out('wait', `${majorSoon.name} is ${majorSoon.daysUntil} days away. Prices often drop then, so it may be worth waiting.`);
    }
    if (majorSoon) {
      reasons.push(`The store's ${majorSoon.name} sale is already live and this item isn't in it yet. More items are often added closer to ${fmtDate(Date.parse(majorSoon.date))}.`);
    }
    const alone = products[itemSku]?.price;
    if (best.kind === 'bundle' && alone && current <= alone * 0.85) {
      return out('good', `${Math.round((1 - current / alone) * 100)}% below its regular price. Tracking since ${since}.`);
    }
    return out('new', `Tracking since ${since}. Advice gets sharper after ${MIN_TRACKED_DAYS} days of history.`);
  }

  const { low, typical } = stats;
  if (current <= low + Math.max(0.5, low * 0.01)) {
    reasons.unshift(`It's the lowest price tracked since ${fmtDate(stats.first)}.`);
    return out('buy', `Lowest price seen. The usual price is ${money(typical)}.`);
  }
  if (current <= typical * 0.93) {
    reasons.unshift(`The usual price is ${money(typical)}. It hit ${money(low)} on ${fmtDate(stats.lowAt)}.`);
    return out('good', `${Math.round((1 - current / typical) * 100)}% under its usual price.`);
  }
  if (low < current * 0.95) {
    let when = '';
    if (stats.avgGapDays && stats.lastEpisodeStart) {
      const next = stats.lastEpisodeStart + stats.avgGapDays * DAY;
      when = next > nowMs
        ? ` Sales have come about every ${Math.round(stats.avgGapDays)} days, so the next one is likely around ${fmtDate(next)}.`
        : ` Sales have come about every ${Math.round(stats.avgGapDays)} days and another is due.`;
    }
    const ev = soon ?? majorSoon;
    if (ev) when += ` ${ev.name} is ${ev.daysUntil} days away.`;
    return out('wait', `It's been ${money(low)} before (${fmtDate(stats.lowAt)}), ${Math.round((1 - low / current) * 100)}% cheaper.${when}`);
  }
  return out('fair', `Close to the lowest price seen (${money(low)}). Little reason to wait.`);
}

// ---------------------------------------------------------------------------
// Home-page highlights

export function highlights(products, index, history, ctx, limit = 24) {
  const lastTwo = history.checks.slice(-2);
  const steals = [];
  const drops = [];
  for (const p of Object.values(products)) {
    if (p.unlisted || p.type === 'bundle' || index.parentOf.has(p.sku)) continue;
    const ways = waysToGet(p.sku, products, index);
    const best = ways.find((w) => w.inStock);
    const alone = ways.find((w) => w.kind === 'alone');
    if (best?.kind === 'bundle' && alone && alone.price - best.price >= Math.max(5, alone.price * 0.08)) {
      steals.push({ sku: p.sku, saving: alone.price - best.price });
    }
    const s = history.series[`best:${p.sku}`];
    if (lastTwo.length === 2 && s?.length >= 2) {
      const [prevT, prev] = s[s.length - 2];
      const [t, cur] = s[s.length - 1];
      if (t === lastTwo[1] && prevT <= lastTwo[0] && cur < prev * 0.97) drops.push({ sku: p.sku, pct: 1 - cur / prev });
    }
  }
  const card = (x) => summarise(x.sku, products, index, history, ctx);
  return {
    steals: steals.sort((a, b) => b.saving - a.saving).slice(0, limit).map(card),
    drops: drops.sort((a, b) => b.pct - a.pct).slice(0, limit).map(card),
    stealCount: steals.length,
  };
}
