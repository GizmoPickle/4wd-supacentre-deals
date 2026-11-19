// Thin client for the store's public Magento GraphQL API (the same one its own
// website calls). GET requests only: the CDN in front of it rejects POST.

const ENDPOINT = process.env.STORE_GRAPHQL || 'https://sc-prod.4wdsc.com/graphql';
export { STORE_SITE, productUrl } from './util.js';
export const ROOT_CATEGORY_ID = 2;

export async function gql(query, variables, { retries = 3, timeoutMs = 60000 } = {}) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('query', query.replace(/\s+/g, ' ').trim());
  if (variables) url.searchParams.set('variables', JSON.stringify(variables));
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', Store: 'default', 'User-Agent': 'Mozilla/5.0 (deal-finder)' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.errors?.length && !body.data) throw new Error(body.errors.map((e) => e.message).join('; '));
      return body.data;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

const PRICE = 'price_range { minimum_price { regular_price { value } final_price { value } } }';

export const CATALOG_PAGE_QUERY = `query Catalog($page: Int!, $size: Int!) {
  products(search: "", pageSize: $size, currentPage: $page) {
    total_count
    page_info { total_pages }
    items {
      __typename id sku name url_key url_suffix stock_status special_deal was_price
      ${PRICE}
      small_image { url }
      categories { id }
      ... on BundleProduct {
        items { title required options { quantity is_default product { sku name stock_status small_image { url } ${PRICE} } } }
      }
      ... on ConfigurableProduct {
        variants { product { sku name stock_status ${PRICE} } }
      }
    }
  }
}`;

export const SEARCH_QUERY = `query Search($q: String!, $size: Int!) {
  products(search: $q, pageSize: $size) { total_count items { sku } }
}`;

const MENU_LEVEL = (depth) =>
  depth === 0
    ? ''
    : `children { id name include_in_menu position url_path children_count ${MENU_LEVEL(depth - 1)} }`;

export const MENU_QUERY = `query Menu($id: String!) {
  categoryList(filters: { ids: { eq: $id } }) { id name ${MENU_LEVEL(4)} }
}`;

// Everything the item page shows beyond price: photos, description, specs, FAQs.
// Heavy (descriptions are ~40 KB of HTML), so fetched in small batches and cached.
export const DETAILS_QUERY = `query Details($skus: [String]) {
  products(filter: { sku: { in: $skus } }, pageSize: 50) {
    items {
      sku
      media_gallery { url label position disabled }
      description { html }
      product_specifications faqs in_the_box downloads_manuals
    }
  }
}`;
