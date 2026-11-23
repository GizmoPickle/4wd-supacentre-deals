// Vanilla single-page app. Hash routes:
//   #/                 home (biggest savings, price drops)
//   #/search?q=…       search results, grouped by item, cheapest way first
//   #/cat/<id>         category browse
//   #/item/<sku>       every way to buy an item + price history + advice

const $ = (sel) => document.querySelector(sel);
// Static builds set window.__localApi: the same API runs in the browser on saved
// data (the public site). The claude.ai build also sets window.__embedded: that
// host can't load remote images or route on the URL hash, so navigation stays in memory.
const STATIC = typeof window.__localApi === 'function';
const EMBEDDED = STATIC && window.__embedded === true;
const IMAGES = !EMBEDDED;
document.body.classList.toggle('static', EMBEDDED);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (n == null ? '–' : `$${Number(n).toLocaleString('en-AU', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`);
const shortName = (s) => String(s ?? '').split('|')[0].trim();
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
const ago = (iso) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
};

async function api(path, opts) {
  if (STATIC) {
    const [code, body] = await window.__localApi(path);
    if (code === 200) return body;
    throw new Error(body.error || `Error ${code}`);
  }
  const res = await fetch(`/api/${path}`, opts);
  const body = await res.json().catch(() => ({}));
  if (res.status === 503) throw Object.assign(new Error('loading'), { loading: true, status: body.status });
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ---- navigation ------------------------------------------------------------
const stack = [];
function currentRoute() {
  return EMBEDDED ? (stack[stack.length - 1] ?? '#/') : (location.hash || '#/');
}
function go(h) {
  if (!EMBEDDED) { location.hash = h; return; }
  stack.push(h);
  route();
}
if (EMBEDDED) {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#/"]');
    if (!a) return;
    e.preventDefault();
    go(a.getAttribute('href'));
  });
  $('#backBtn').addEventListener('click', () => { stack.pop(); route(); });
}

// ---- status / loading ------------------------------------------------------
let status = null;
async function refreshStatus() {
  try {
    status = await api('status');
  } catch {
    return;
  }
  const ev = status.events?.find((e) => e.daysUntil >= 0 && e.daysUntil <= 45);
  $('#strip').innerHTML = ev
    ? `<b>${esc(ev.name)}</b> is ${ev.daysUntil === 0 ? 'today' : `in ${ev.daysUntil} day${ev.daysUntil === 1 ? '' : 's'}`} (${fmtDate(ev.date)}). Prices often drop then.`
    : '';
  $('#footStatus').textContent = EMBEDDED
    ? `Snapshot of ${status.products.toLocaleString()} products taken ${fmtDate(status.updatedAt)}. Prices don't update on this page.`
    : status.static
    ? `Prices last checked ${ago(status.updatedAt)} · ${status.products.toLocaleString()} products · checked several times a day · tracking since ${fmtDate(status.trackingSince)}`
    : status.updatedAt
    ? `Prices last checked ${ago(status.updatedAt)} · ${status.products.toLocaleString()} products · tracking since ${fmtDate(status.trackingSince)} (${status.checks} checks)`
    : '';
  $('#refreshBtn').hidden = !!status.static;
  $('#refreshBtn').textContent = status.crawling ? `Checking prices… ${status.crawling.done}/${status.crawling.total ?? '?'}` : 'Check prices now';
  $('#refreshBtn').disabled = !!status.crawling;
}

function loadingView(s) {
  const c = s?.crawling;
  const pct = c?.total ? Math.round((c.done / c.total) * 100) : 4;
  app.innerHTML = `<div class="loading">
    <h1>Building the price catalogue</h1>
    <p>Reading every product from the store. This takes a few minutes the first time.</p>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <p class="muted">${c?.total ? `Page ${c.done} of ${c.total}` : 'Starting…'}</p>
    ${s?.lastError ? `<p class="muted">Last attempt failed: ${esc(s.lastError)}</p>` : ''}
  </div>`;
  setTimeout(route, 3000);
}

// ---- menu drawer -----------------------------------------------------------
let menuLoaded = false;
function openDrawer(open) {
  $('#drawer').classList.toggle('open', open);
  $('#scrim').classList.toggle('show', open);
  $('#drawer').setAttribute('aria-hidden', String(!open));
  $('#menuBtn').setAttribute('aria-expanded', String(open));
  if (open && !menuLoaded) loadMenu();
}
function menuTree(nodes, depth) {
  return nodes
    .filter((c) => c.inMenu && c.name)
    .map((c) => {
      const kids = (c.children ?? []).filter((k) => k.inMenu);
      return `<div class="cat-row"><a href="#/cat/${c.id}">${esc(c.name)}</a>${kids.length && depth < 2 ? `<button data-toggle aria-label="Expand ${esc(c.name)}">+</button>` : ''}</div>
        ${kids.length && depth < 2 ? `<div class="cat-children" hidden>${menuTree(kids, depth + 1)}</div>` : ''}`;
    })
    .join('');
}
async function loadMenu() {
  try {
    const menu = await api('menu');
    $('#drawerBody').innerHTML = menuTree(menu.children ?? [], 0);
    menuLoaded = true;
  } catch (e) {
    $('#drawerBody').innerHTML = `<p class="loading">${e.loading ? 'Menu is still loading…' : esc(e.message)}</p>`;
  }
}
$('#menuBtn').onclick = () => openDrawer(true);
$('#drawerClose').onclick = $('#scrim').onclick = () => openDrawer(false);
$('#drawerBody').addEventListener('click', (e) => {
  const t = e.target.closest('[data-toggle]');
  if (t) {
    const kids = t.parentElement.nextElementSibling;
    kids.hidden = !kids.hidden;
    t.textContent = kids.hidden ? '+' : '−';
  } else if (e.target.closest('a')) openDrawer(false);
});

// ---- search ----------------------------------------------------------------
$('#searchForm').onsubmit = (e) => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  if (q) go(`#/search?q=${encodeURIComponent(q)}`);
};
$('#refreshBtn').onclick = async () => {
  await api('refresh', { method: 'POST' }).catch(() => {});
  refreshStatus();
};

// ---- cards -----------------------------------------------------------------
function card(it) {
  const b = it.best;
  const notes = [
    b.qty > 1 ? `${b.qty}-pack, ${money(b.perUnit)} each` : '',
    b.extras.length ? `Includes ${esc(b.extras.map(shortName).join(' + '))}` : '',
  ].filter(Boolean);
  const via = notes.length ? `<div class="via">${notes.join(' · ')}</div>` : '';
  return `<a class="card" href="#/item/${encodeURIComponent(it.sku)}">
    ${it.saving >= 1 ? `<span class="badge-save">Save ${money(Math.round(it.saving))}</span>` : ''}
    <div class="thumb">${IMAGES && it.image ? `<img loading="lazy" src="${esc(it.image)}?width=300&height=300&fit=bounds" alt="">` : ''}</div>
    <div class="body">
      <div class="verdict-line"><span class="pill v-${it.verdict}">${esc(it.verdictLabel)}</span>${it.reason ? `<span class="reason v-text-${it.verdict}">${esc(it.reason)}</span>` : ''}</div>
      <div class="name">${esc(shortName(it.name))}</div>
      ${via}
      <div class="price-row">
        <span class="price">${money(b.price)}</span>
        ${it.saving >= 1 && it.alone ? `<span class="strike">${money(it.alone.price)}</span>` : ''}
      </div>
      ${b.inStock ? '' : '<div class="oos">Out of stock online</div>'}
    </div>
  </a>`;
}
const grid = (items) => (items.length ? `<div class="grid">${items.map(card).join('')}</div>` : `<div class="empty">Nothing here yet.</div>`);

function sortControl(current) {
  const opts = [['saving', 'Biggest saving'], ['price', 'Cheapest first'], ['relevance', 'Best match']];
  return `<label class="count">Sort <select id="sort">${opts.map(([v, l]) => `<option value="${v}" ${v === current ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
}
function bindSort(base, params) {
  $('#sort')?.addEventListener('change', (e) => {
    params.set('sort', e.target.value);
    go(`${base}?${params}`);
  });
}

// ---- views -----------------------------------------------------------------
async function homeView() {
  const h = await api('highlights');
  document.title = 'Rig 4 Less';
  app.innerHTML = `
    <section class="hero">
      <div><div class="big">${h.stealCount.toLocaleString()}</div><p>items have a deal below their regular price right now</p></div>
      <div style="flex:1;min-width:240px"><h1>Find the cheapest deal</h1>
      <p>Search or open the menu. Every result shows the cheapest deal on that item, how much it saves you, and whether to buy now or wait.</p></div>
    </section>
    ${h.drops.length ? `<h2>Price drops since the last check</h2><p class="sub">These just got cheaper.</p>${grid(h.drops)}` : ''}
    <h2>Biggest savings</h2>
    <p class="sub">The cheapest deals right now, measured against each item's regular price.</p>
    ${grid(h.steals)}`;
}

async function searchView(params) {
  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'relevance';
  $('#searchInput').value = q;
  document.title = `${q} · Rig 4 Less`;
  app.innerHTML = `<div class="loading">Searching for “${esc(q)}”…</div>`;
  const r = await api(`search?q=${encodeURIComponent(q)}&sort=${sort}`);
  const steals = r.items.filter((i) => i.saving >= 1).length;
  app.innerHTML = `
    <div class="crumbs"><a href="./">Home</a> › Search</div>
    <h1>“${esc(q)}”</h1>
    <div class="toolbar">
      <span class="count">${r.items.length} items${steals ? ` · <b>${steals}</b> with a saving` : ''}${r.source === 'local' && !STATIC ? ' · store search unavailable, matched locally' : ''}</span>
      ${sortControl(sort)}
    </div>
    ${grid(r.items)}`;
  bindSort('#/search', params);
}

async function categoryView(id, params) {
  const sort = params.get('sort') ?? 'saving';
  app.innerHTML = `<div class="loading">Loading…</div>`;
  const r = await api(`category/${id}?sort=${sort}`);
  document.title = `${r.name} · Rig 4 Less`;
  app.innerHTML = `
    <div class="crumbs"><a href="./">Home</a>${r.trail.map((t) => ` › <a href="#/cat/${t.id}">${esc(t.name)}</a>`).join('')}</div>
    <h1>${esc(r.name)}</h1>
    ${r.children.length ? `<div class="chips">${r.children.map((c) => `<a class="chip" href="#/cat/${c.id}">${esc(c.name)}</a>`).join('')}</div>` : ''}
    <div class="toolbar"><span class="count">${r.items.length} items</span>${sortControl(sort)}</div>
    ${grid(r.items)}`;
  bindSort(`#/cat/${id}`, params);
}

function chart(history, trackingSince) {
  const series = [
    { key: 'best', color: 'var(--red)', label: 'Cheapest deal', pts: history.best },
    { key: 'alone', color: '#888', label: 'Regular price', pts: history.alone, dash: '5 4' },
  ].filter((s) => s.pts.length);
  if (!series.length) return '<p class="muted">No price history yet.</p>';
  const now = Date.now();
  // Show at least a week so a brand-new series still draws a visible line.
  const t0 = Math.min(now - 7 * 86400000, ...series.map((s) => Date.parse(s.pts[0][0])));
  const span = now - t0;
  const prices = series.flatMap((s) => s.pts.map((p) => p[1]));
  let lo = Math.min(...prices), hi = Math.max(...prices);
  const pad = Math.max((hi - lo) * 0.15, hi * 0.05, 1);
  lo = Math.max(0, lo - pad); hi += pad;
  const W = 640, H = 220, L = 52, R = 10, T = 10, B = 26;
  const x = (t) => L + ((t - t0) / span) * (W - L - R);
  const y = (p) => T + (1 - (p - lo) / (hi - lo)) * (H - T - B);
  const paths = series.map((s) => {
    let d = '';
    s.pts.forEach(([t, p], i) => {
      const X = x(Date.parse(t)), Y = y(p);
      d += i === 0 ? `M${X},${Y}` : `H${X}V${Y}`;
    });
    d += `H${x(now)}`;
    const dots = s.pts.map(([t, p]) => `<circle cx="${x(Date.parse(t))}" cy="${y(p)}" r="4" fill="${s.color}"><title>${money(p)} · ${fmtDate(t)}</title></circle>`).join('');
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.5" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}/>${dots}`;
  });
  const ticks = [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1];
  const grids = ticks.map((p) => `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}"/><text x="${L - 6}" y="${y(p) + 4}" text-anchor="end">${money(Math.round(p))}</text>`);
  const dates = [t0, t0 + span / 2, now].map((t, i) => `<text x="${x(t)}" y="${H - 6}" text-anchor="${['start', 'middle', 'end'][i]}">${new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}</text>`);
  const few = Math.max(...series.map((s) => s.pts.length)) < 2;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Price history">${grids.join('')}${paths.join('')}${dates.join('')}</svg>
    <div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('')}</div>
    ${few ? `<p class="muted">No price changes recorded since tracking began on ${fmtDate(trackingSince)}. The chart fills in as prices move.</p>` : ''}`;
}

function wayRow(w, isBest, alonePrice) {
  const saving = w.kind === 'bundle' && alonePrice && alonePrice > w.price ? alonePrice - w.price : 0;
  return `<li class="way ${isBest ? 'best' : ''}">
    ${IMAGES && w.image ? `<img loading="lazy" src="${esc(w.image)}?width=128&height=128&fit=bounds" alt="">` : '<span></span>'}
    <div>
      <div>${isBest ? '<span class="tag best">Cheapest</span>' : ''}${w.kind === 'alone' ? '<span class="tag">Regular price</span>' : ''}${w.qty > 1 ? `<span class="tag">${w.qty}-pack</span>` : ''}</div>
      <div class="w-name">${esc(shortName(w.name))}</div>
      <div class="w-meta">
        ${w.extras.length ? `Includes ${w.extras.map((e) => `${e.qty > 1 ? `${e.qty}× ` : ''}${esc(shortName(e.name))}${e.value ? ` (${money(e.value)})` : ''}`).join(', ')}. ` : ''}
        ${w.qty > 1 ? `${money(w.perUnit)} per unit. ` : ''}
        ${saving >= 1 ? `<b style="color:var(--green)">Save ${money(saving)}.</b> ` : ''}
        ${w.inStock ? '' : '<b>Out of stock online.</b>'}
      </div>
    </div>
    <div class="w-price"><div class="price">${money(w.price)}</div>${w.url ? `<a class="buy-link" href="${esc(w.url)}" target="_blank" rel="noopener">View on store ↗</a>` : ''}</div>
  </li>`;
}

async function itemView(sku) {
  app.innerHTML = `<div class="loading">Loading…</div>`;
  const myRoute = currentRoute();
  const d = await api(`item/${encodeURIComponent(sku)}`);
  document.title = `${shortName(d.name)} · Rig 4 Less`;
  const a = d.advice;
  const s = a.stats;
  const best = d.ways.find((w) => w.inStock) ?? d.ways[0];
  const alone = d.ways.find((w) => w.kind === 'alone');
  const others = d.ways.filter((w) => w !== best);
  const saving = best && alone && best !== alone && alone.price > best.price ? alone.price - best.price : 0;
  const bestBox = best ? `
        <div class="panel best-box">
          <div class="k">Cheapest deal</div>
          <div class="price-row"><span class="price big-price">${money(best.price)}</span>${saving >= 1 ? `<span class="strike">${money(alone.price)}</span><span class="badge-save inline">Save ${money(Math.round(saving))}</span>` : ''}</div>
          ${s && s.low < best.price - 0.5 ? `<p class="low-seen">Lowest price seen: <b>${money(s.low)}</b> on ${fmtDate(new Date(s.lowAt).toISOString())} <span class="muted">(${money(best.price - s.low)} less than now)</span></p>` : ''}
          ${best.qty > 1 ? `<p class="muted">${best.qty}-pack, ${money(best.perUnit)} each</p>` : ''}
          ${best.extras.length ? `<p class="muted">Includes ${best.extras.map((e) => `${e.qty > 1 ? `${e.qty}× ` : ''}${esc(shortName(e.name))}`).join(', ')}</p>` : ''}
          ${best.inStock ? '' : '<p class="muted"><b>Out of stock online.</b></p>'}
          ${best.url ? `<a class="store-btn" href="${esc(best.url)}" target="_blank" rel="noopener">View this deal on the store ↗</a>` : ''}
        </div>` : '';
  app.innerHTML = `
    <div class="crumbs"><a href="./">Home</a> › ${esc(shortName(d.name))}</div>
    <div class="item">
      <div>
        <div id="gallery" ${IMAGES ? '' : 'hidden'}>${gallery(d.image ? [d.image] : [], d.name)}</div>
      </div>
      <div>
        <h1>${esc(shortName(d.name))}</h1>
        <p class="sub">${esc(d.name.split('|').slice(1).join(' · '))}</p>
        ${bestBox}
        <div class="panel verdict v-${a.verdict}">
          <div class="label">${esc(a.label)}</div>
          <p><b>${esc(a.headline)}</b></p>
          ${a.reasons.length ? `<ul>${a.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        </div>
      </div>
    </div>
    <section class="info" id="info"><p class="muted">Loading product details…</p></section>
    <div class="below">
      <div class="panel">
        <b>Price history</b>
        ${chart(d.history, d.trackingSince)}
        ${s ? `<div class="stats">
          <div class="stat"><div class="k">Now</div><div class="v">${money(best?.price)}</div></div>
          <div class="stat"><div class="k">Lowest since ${fmtDate(d.trackingSince).replace(/ \d{4}$/, '')}</div><div class="v">${money(s.low)}</div></div>
          <div class="stat"><div class="k">Usual</div><div class="v">${money(s.typical)}</div></div>
          <div class="stat"><div class="k">Highest</div><div class="v">${money(s.high)}</div></div>
        </div>
        <p class="muted">Tracked for ${s.trackedDays < 1 ? 'less than a day' : `${Math.round(s.trackedDays)} day${Math.round(s.trackedDays) === 1 ? '' : 's'}`} · ${s.episodes.length} sale period${s.episodes.length === 1 ? '' : 's'} seen · last checked ${ago(d.lastCheck)}</p>` : ''}
      </div>
      ${others.length ? `<div class="panel">
        <b>Other deals on this item (${others.length})</b>${d.unlisted ? ' <span class="muted">· not sold on its own</span>' : ''}
        <ul class="ways">${others.map((w) => wayRow(w, false, alone?.price)).join('')}</ul>
      </div>` : ''}
      ${d.pastSales.length ? `<div class="panel"><b>Store sale collections it's tagged in</b><div class="chips">${d.pastSales.map((n) => `<span class="chip">${esc(n)}</span>`).join('')}</div></div>` : ''}
      ${a.events?.length ? `<div class="panel"><b>Upcoming sale events</b><p class="muted">${a.events.map((e) => `${esc(e.name)}: ${fmtDate(e.date)} (${e.daysUntil} days)`).join(' · ')}</p></div>` : ''}
    </div>`;
  bindGallery();
  // Photos, description and specs load separately so prices show straight away.
  let det = null;
  try { det = await api(`details/${encodeURIComponent(d.sku)}`); } catch { /* not fetched yet */ }
  if (currentRoute() !== myRoute) return; // navigated away while loading
  if (det?.images?.length && IMAGES) {
    $('#gallery').innerHTML = gallery(det.images, d.name);
    bindGallery();
  }
  $('#info').innerHTML = infoSections(det, d.url);
}

// ---- photo gallery ---------------------------------------------------------
const img = (url, size) => `${esc(url)}?width=${size}&height=${size}&fit=bounds`;
function gallery(images, name) {
  if (!images.length) return '';
  const many = images.length > 1;
  return `<div class="gallery">
      <div class="slides" id="slides" tabindex="0" aria-label="Photos of ${esc(shortName(name))}">
        ${images.map((u, i) => `<img src="${img(u, 800)}" alt="Photo ${i + 1} of ${images.length}" ${i ? 'loading="lazy"' : ''}>`).join('')}
      </div>
      ${many ? `<button class="g-nav prev" data-step="-1" aria-label="Previous photo">‹</button>
      <button class="g-nav next" data-step="1" aria-label="Next photo">›</button>
      <span class="g-count" id="gCount">1 / ${images.length}</span>` : ''}
    </div>
    ${many ? `<div class="thumbs" id="thumbs">${images.map((u, i) => `<button data-i="${i}" class="${i ? '' : 'on'}" aria-label="Show photo ${i + 1}"><img src="${img(u, 160)}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}`;
}
function bindGallery() {
  const slides = $('#slides');
  if (!slides) return;
  const count = slides.children.length;
  const index = () => Math.round(slides.scrollLeft / slides.clientWidth);
  const show = (i) => slides.scrollTo({ left: Math.max(0, Math.min(count - 1, i)) * slides.clientWidth, behavior: 'smooth' });
  slides.addEventListener('scroll', () => {
    const i = index();
    if ($('#gCount')) $('#gCount').textContent = `${i + 1} / ${count}`;
    document.querySelectorAll('#thumbs button').forEach((b, j) => b.classList.toggle('on', j === i));
  }, { passive: true });
  document.querySelectorAll('.g-nav').forEach((b) => b.addEventListener('click', () => show(index() + Number(b.dataset.step))));
  $('#thumbs')?.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) show(Number(b.dataset.i)); });
  slides.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') show(index() + 1); if (e.key === 'ArrowLeft') show(index() - 1); });
}

// ---- product details, specs, FAQs (store's own content, as plain text) -----
const paras = (lines) => lines.map((l) => `<p>${esc(l)}</p>`).join('');
function fold(title, body, open = false) {
  return `<details class="fold" ${open ? 'open' : ''}><summary>${esc(title)}</summary><div class="fold-body">${body}</div></details>`;
}
function infoSections(det, storeUrl) {
  const out = [];
  if (det) {
    const { intro, sections } = det.description ?? { intro: [], sections: [] };
    if (intro.length || sections.length) {
      out.push(fold('Product details', `${paras(intro)}${sections.map((sec) => `
        <div class="feature ${sec.text.length ? '' : 'feature-images'}">
          ${IMAGES ? (sec.images ?? (sec.image ? [sec.image] : [])).map((u) => `<img src="${img(u, 900)}" alt="" loading="lazy">`).join('') : ''}
          <div><h3>${esc(sec.title)}</h3>${sec.subtitle ? `<p class="feature-sub">${esc(sec.subtitle)}</p>` : ''}${paras(sec.text)}</div>
        </div>`).join('')}`, true));
    }
    if (det.specs?.length) {
      out.push(fold('Specifications', `<div class="spec-wrap"><table class="specs">${det.specs.map(([k, v]) => v
        ? `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`
        : `<tr class="spec-group"><th colspan="2">${esc(k)}</th></tr>`).join('')}</table></div>`));
    }
    if (det.inTheBox?.length) out.push(fold("What's in the box", `<ul>${det.inTheBox.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`));
    if (det.faqs?.length) {
      out.push(fold('FAQs', det.faqs.map((f) => `<div class="faq"><h3>${esc(f.q)}</h3>${paras(f.a.split('\n'))}</div>`).join('')));
    }
    if (det.manuals?.length) {
      out.push(fold('Manuals & downloads', `<ul>${det.manuals.map((m) => `<li><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(shortName(m.label))} (PDF) ↗</a></li>`).join('')}</ul>`));
    }
  }
  if (storeUrl) {
    out.push(fold('Ratings & reviews', `<p>Reviews are on the store's page for this item.</p><p><a class="buy-link" href="${esc(storeUrl)}" target="_blank" rel="noopener">Read reviews on the store ↗</a></p>`));
  }
  if (!det) out.unshift('<p class="muted">Photos and specs for this item are added at the next price check.</p>');
  return out.join('');
}

// ---- about & privacy -------------------------------------------------------
const CONTACT = 'rig4less@gmail.com';
function aboutView() {
  document.title = 'About & privacy · Rig 4 Less';
  app.innerHTML = `
    <div class="crumbs"><a href="./">Home</a> › About & privacy</div>
    <article class="about">
      <h1>About & privacy</h1>
      <p class="sub">Last updated 23 November 2026</p>

      <h2>What Rig 4 Less is</h2>
      <p>Rig 4 Less is an independent, unofficial price tracker for products sold by 4WD Supacentre. It finds the cheapest way to buy each item, whether that's on its own or as part of a combo deal, keeps a history of prices, and gives an opinion on whether to buy now or wait.</p>
      <p><b>Rig 4 Less is not affiliated with, endorsed by or connected to 4WD Supacentre or Adventure Kings.</b> Product names, photos and descriptions belong to their owners and are shown only to identify the products. You can't buy anything here: every "View on store" link takes you to 4WD Supacentre's own website.</p>

      <h2>Where the prices come from</h2>
      <p>Prices, product details and photos are read from 4WD Supacentre's public online catalogue several times a day. Price history starts on 19 November 2026, when tracking began, so "lowest price seen" means the lowest since then.</p>
      <p>Prices can change between checks, and cart discounts, delivery costs, stock levels and promotions on the store may differ from what's shown here. <b>Always check the price on 4WD Supacentre's website before you buy.</b></p>

      <h2>About the advice</h2>
      <p>"Buy now", "Good deal", "Wait" and "Fair price" are opinions worked out automatically from tracked prices, the store's own sale labels and the usual Australian sale calendar. They're not financial advice or a promise that a price will go up or down. We aren't responsible for purchase decisions made using this site.</p>

      <h2>Privacy</h2>
      <p>Rig 4 Less doesn't collect personal information. There are no accounts, sign-ups or cookies, and nothing you search for is sent anywhere or stored: searching happens entirely in your browser. We count visits using privacy-friendly analytics that don't track individual visitors.</p>
      <p>Three other services are involved when you visit:</p>
      <ul>
        <li><b>GitHub Pages</b> hosts the site. Like any web host, GitHub keeps standard server logs, which include your IP address. See <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" target="_blank" rel="noopener">GitHub's privacy statement</a>.</li>
        <li><b>Product photos load directly from 4WD Supacentre's servers</b>, so their servers can see your IP address and that you came from this site. Following a link to their store is covered by their own privacy policy.</li>
        <li><b>Cloudflare Web Analytics</b> counts visits so we can see how many people use the site. It doesn't use cookies or follow you across websites, and we only see totals such as page views, referring sites and countries. See <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener">Cloudflare's privacy policy</a>.</li>
      </ul>
      <p>If this ever changes, for example if we add email alerts, we'll update this page before it happens.</p>

      <h2>Contact</h2>
      <p>Questions, corrections, or a request to remove something, including from 4WD Supacentre: email <a href="mailto:${CONTACT}">${CONTACT}</a>. We'll respond as soon as we can.</p>
    </article>`;
}

// ---- router ----------------------------------------------------------------
async function route() {
  // Home is the plain address: tidy "/#/" (old links, or a hash cleared by hand).
  if (!EMBEDDED && (location.hash === '#/' || location.hash === '#')) history.replaceState(null, '', location.pathname + location.search);
  const [path, query] = currentRoute().slice(1).split('?');
  $('#backBtn').hidden = !EMBEDDED || stack.length < 2;
  const params = new URLSearchParams(query);
  const parts = (path || '/').split('/').filter(Boolean);
  window.scrollTo(0, 0);
  try {
    if (parts[0] === 'search') await searchView(params);
    else if (parts[0] === 'cat') await categoryView(Number(parts[1]), params);
    else if (parts[0] === 'item') await itemView(decodeURIComponent(parts.slice(1).join('/')));
    else if (parts[0] === 'about') aboutView();
    else await homeView();
  } catch (e) {
    if (e.loading) return loadingView(e.status);
    app.innerHTML = `<div class="empty">Something went wrong: ${esc(e.message)}</div>`;
  }
}

if (!EMBEDDED) {
  window.addEventListener('hashchange', route);
  // Home is the plain address (rig4less.lol), not "/#/". Back/forward to it has no hash to change.
  window.addEventListener('popstate', () => { if (!location.hash) route(); });
}
// Home links: switch to the clean address without reloading the page.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href="./"]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
  e.preventDefault();
  if (EMBEDDED) return go('#/');
  if (location.hash) history.pushState(null, '', location.pathname + location.search);
  route();
});
refreshStatus();
setInterval(refreshStatus, 20000);
route();
