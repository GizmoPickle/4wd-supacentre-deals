// Turns the store's product HTML into plain, structured data for the item page:
// photos, description sections, a spec table, FAQs, box contents and manuals.
// Only plain text and image URLs come out, so nothing from the store's HTML is
// ever injected into our pages.
import fs from 'node:fs';
import path from 'node:path';
import { gql, DETAILS_QUERY } from './store.js';
import { DATA_DIR } from './db.js';
import { detailFile } from './util.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', deg: '°', times: '×', hellip: '…', reg: '®', trade: '™', copy: '©', frac12: '½', sup2: '²', sup3: '³' };
export function decode(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const stripComments = (h) => h.replace(/<!--[\s\S]*?-->/g, '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, '');
/** HTML fragment -> plain text, keeping line breaks between blocks. */
export function text(h) {
  return decode(
    stripComments(h ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}
const empty = (h) => !h || /^\s*(NA|N\/A|null)?\s*$/i.test(text(h));

/** Spec tables: each row's first cell is the name, the rest the value. */
export function parseSpecs(h) {
  if (empty(h)) return [];
  const rows = [];
  for (const [, tr] of stripComments(h).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => text(m[1]).replace(/\n/g, ', ')).filter(Boolean);
    if (cells.length >= 2) rows.push([cells[0], cells.slice(1).join(' ')]);
    else if (cells.length === 1 && rows.length) rows.push([cells[0], '']); // section label inside the table
  }
  return rows;
}

/** FAQ rows come in Q / A pairs (class FAQ_Q / FAQ_A). */
export function parseFaqs(h) {
  if (empty(h)) return [];
  const out = [];
  for (const [, cls, body] of stripComments(h).matchAll(/<tr[^>]*class="(FAQ_[QA])"[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const t = text(body);
    if (cls.toUpperCase() === 'FAQ_Q') out.push({ q: t.replace(/^Q[.:]\s*/i, ''), a: '' });
    else if (out.length) out[out.length - 1].a = [out[out.length - 1].a, t.replace(/^A[.:]\s*/i, '')].filter(Boolean).join('\n');
  }
  return out.filter((f) => f.q);
}

/** Manuals: every linked document, labelled by the nearest bold text. */
export function parseManuals(h) {
  if (empty(h)) return [];
  const out = [];
  let label = '';
  for (const m of stripComments(h).matchAll(/<strong>([\s\S]*?)<\/strong>|<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (m[1] != null && text(m[1])) label = text(m[1]);
    if (m[2] && /^https?:/.test(m[2])) out.push({ label: text(m[3]) || label || 'Manual', url: decode(m[2]) });
  }
  return out;
}

/** "In the box": list items, else one line per block. */
export function parseList(h) {
  if (empty(h)) return [];
  const lis = [...h.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => text(m[1])).filter(Boolean);
  return lis.length ? lis : text(h).split('\n');
}

/**
 * Description sections. The store's template repeats each section for desktop
 * and mobile and leaves placeholder text in comments; we keep one copy of each
 * heading with its paragraphs and feature photo.
 */
export function parseDescription(h) {
  if (!h) return { intro: [], sections: [] };
  let html = decode(h); // the page-builder wraps the real HTML as escaped text
  html = stripComments(html);
  const tokens = [...html.matchAll(/<p[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/p>|<p(?![^>]*class=)[^>]*>([\s\S]*?)<\/p>|<li[^>]*>([\s\S]*?)<\/li>|<img[^>]+src="([^"]+)"/gi)];
  const intro = [];
  const sections = [];
  const seen = new Set();
  let cur = null;
  let lastImg = null;
  for (const m of tokens) {
    const [, cls = '', classed, plain, li, img] = m;
    if (img) {
      if (/\.(jpe?g|png|webp)/i.test(img) && !/icon/i.test(img)) {
        if (cur && !cur.image) cur.image = img;
        else lastImg = img;
      }
      continue;
    }
    if (/\btitle_title\b|\btitle_sub_title\b|dec_title_small/.test(cls)) continue;
    if (/\bdec_title\b/.test(cls)) {
      const title = text(classed);
      if (!title) continue;
      const key = title.toUpperCase();
      cur = seen.has(key) ? null : { title, text: [], image: lastImg };
      lastImg = null;
      if (cur) { seen.add(key); sections.push(cur); }
      continue;
    }
    const t = text(classed ?? plain ?? li ?? '');
    if (!t || t.length < 2) continue;
    const line = li ? `• ${t}` : t;
    if (cur) { if (!cur.text.includes(line)) cur.text.push(line); }
    else if (!sections.length && !seen.size && !intro.includes(line)) intro.push(line);
  }
  // Templates without section headings: fall back to the plain text, de-duplicated.
  if (!sections.length && !intro.length) {
    const lines = [...new Set(text(html).split('\n'))].filter((l) => l.length > 2);
    return { intro: lines.slice(0, 40), sections: [] };
  }
  return { intro: intro.slice(0, 10), sections: sections.filter((s) => s.text.length || s.image) };
}

export function normaliseDetails(raw) {
  const images = (raw.media_gallery ?? [])
    .filter((m) => !m.disabled && m.url && !/placeholder/i.test(m.url))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((m) => m.url.split('?')[0]);
  return {
    sku: raw.sku,
    fetchedAt: new Date().toISOString(),
    images: [...new Set(images)],
    description: parseDescription(raw.description?.html),
    specs: parseSpecs(raw.product_specifications),
    faqs: parseFaqs(raw.faqs),
    inTheBox: parseList(raw.in_the_box),
    manuals: parseManuals(raw.downloads_manuals),
  };
}

// ---------------------------------------------------------------------------
// On disk: data/details/<sku>.json. Only ~550 products are sold on their own
// (the rest are combo listings), so a full refresh takes seconds and runs with
// every price check.

const DIR = path.join(DATA_DIR, 'details');
const BATCH = 20;
const CONCURRENCY = 3;

/** Fetch details for every product sold on its own; remove files for products that are gone. */
export async function refreshDetails(products, { onProgress = () => {} } = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  const todo = Object.values(products).filter((p) => !p.unlisted && p.type !== 'bundle').map((p) => p.sku);
  const wanted = new Set(todo.map(detailFile));
  for (const f of fs.readdirSync(DIR)) if (!wanted.has(f)) fs.rmSync(path.join(DIR, f));
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));

  let done = 0;
  let failed = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (batches.length) {
      const batch = batches.shift();
      try {
        const data = await gql(DETAILS_QUERY, { skus: batch }, { timeoutMs: 120000 });
        for (const raw of data.products.items) {
          fs.writeFileSync(path.join(DIR, detailFile(raw.sku)), JSON.stringify(normaliseDetails(raw)));
        }
      } catch (err) {
        failed += batch.length; // keeps the previous copy, if any; retried next run
        console.error(`\n[details] batch failed: ${err.message}`);
      }
      done += batch.length;
      onProgress({ done, total: todo.length });
    }
  }));
  return { fetched: todo.length - failed, failed, total: todo.length };
}

export function readDetails(sku) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, detailFile(sku)), 'utf8'));
  } catch {
    return null;
  }
}
