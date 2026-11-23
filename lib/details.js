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
 * Description sections. The store's template is a series of blocks separated by
 * divider lines (class "Des_hr"). Each block holds a heading (sometimes a second
 * one as a subheading), its text and a photo, and is usually written out twice:
 * once laid out for desktop and once for mobile. Treating each block as a unit
 * keeps every photo with its own text and drops the repeats.
 */
const IMG_OK = (src) => /\.(jpe?g|png|webp)(\?|$)/i.test(src) && !/icon|placeholder|spacer|pixel/i.test(src);

function parseBlock(html) {
  const titles = [];
  const subs = [];
  const text = [];
  const images = [];
  const tokens = html.matchAll(/<p[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/p>|<p(?![^>]*class=)[^>]*>([\s\S]*?)<\/p>|<li[^>]*>([\s\S]*?)<\/li>|<img[^>]+src="([^"]+)"/gi);
  for (const [, cls = '', classed, plain, li, img] of tokens) {
    if (img) {
      const src = decode(img);
      if (IMG_OK(src) && !images.some((u) => u.toLowerCase() === src.toLowerCase())) images.push(src);
      continue;
    }
    if (/\btitle_title\b|\btitle_sub_title\b/.test(cls)) continue;
    // Visible small titles are real subheadings ("UNBEATABLE PRICE"); the template's
    // placeholder ones only ever appear inside comments, which are stripped first.
    if (/dec_title_small/.test(cls)) {
      const t = text_(classed);
      if (t && !subs.some((x) => x.toUpperCase() === t.toUpperCase())) subs.push(t);
      continue;
    }
    if (/\bdec_title\b/.test(cls)) {
      const t = text_(classed);
      if (t && !titles.some((x) => x.toUpperCase() === t.toUpperCase())) titles.push(t);
      continue;
    }
    const t = text_(classed ?? plain ?? li ?? '');
    if (!t || t.length < 2) continue;
    const line = li ? `• ${t}` : t;
    if (!text.includes(line)) text.push(line);
  }
  return { titles, subs, text, images };
}
const text_ = (h) => text(h);
// Share of words two passages have in common (0-1).
function overlap(a, b) {
  const wa = new Set(a.toLowerCase().match(/[a-z0-9]+/g) ?? []), wb = new Set(b.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  if (!wa.size || !wb.size) return 0;
  let same = 0;
  for (const w of wa) if (wb.has(w)) same++;
  return same / Math.min(wa.size, wb.size);
}

export function parseDescription(h) {
  if (!h) return { intro: [], sections: [] };
  const html = stripComments(decode(h)); // the page-builder wraps the real HTML as escaped text
  // Split on the divider lines; older templates without them split on each row.
  let blocks = html.split(/<div[^>]*class="[^"]*\bDes_hr\b[^"]*"[^>]*>/i);
  if (blocks.length < 2) blocks = html.split(/<div[^>]*class="[^"]*ProductDesRow-root[^"]*"[^>]*>/i);

  const intro = [];
  const sections = [];
  const seen = new Set();
  for (const block of blocks) {
    const { titles, subs, text: lines, images } = parseBlock(block);
    if (!titles.length) {
      // Text before the first heading is the introduction.
      if (!sections.length) for (const l of lines) if (!intro.includes(l)) intro.push(l);
      continue;
    }
    const key = titles[0].toUpperCase();
    if (seen.has(key)) continue;
    // The store sometimes words its desktop and mobile copies of a section slightly
    // differently; same photo and mostly the same text means it's a repeat.
    const repeat = sections.find((x) => images[0] && x.image === images[0] && overlap(x.text.join(' '), lines.join(' ')) > 0.6);
    if (repeat) continue;
    seen.add(key);
    sections.push({
      title: titles[0],
      subtitle: [...titles.slice(1), ...subs].join(' · ') || null,
      text: lines,
      // One feature photo per block (for an image-only block such as Dimensions,
      // that's the diagram); later images belong to banners below it.
      images: images.slice(0, 1),
      image: images[0] ?? null,
    });
  }
  // Templates without headings at all: fall back to the plain text, de-duplicated.
  if (!sections.length && !intro.length) {
    const lines = [...new Set(text(html).split('\n'))].filter((l) => l.length > 2);
    return { intro: lines.slice(0, 40), sections: [] };
  }
  return { intro: intro.slice(0, 10), sections: sections.filter((x) => x.text.length || x.images.length) };
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
