// Browser-safe helpers shared by the server and the static (offline) build.
export const STORE_SITE = 'https://www.4wdsupacentre.com.au';
export const round2 = (n) => Math.round(n * 100) / 100;
export function productUrl(p) {
  return p.urlKey ? `${STORE_SITE}/${p.urlKey}${p.urlSuffix ?? '.html'}` : null;
}

/** Safe file name for a SKU's details file (SKUs can contain any character). */
export const detailFile = (sku) => `${sku.replace(/[^A-Za-z0-9._-]/g, (c) => `~${c.charCodeAt(0).toString(16)}`)}.json`;
