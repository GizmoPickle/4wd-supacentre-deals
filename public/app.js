// Vanilla single-page app. Hash routes:
//   #/                 home (bundle steals, price drops)
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
    ? `Prices last checked ${ago(status.updatedAt)} · ${status.products.toLocaleString()} products · checked every 6 hours · tracking since ${fmtDate(status.trackingSince)}`
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
    <p>Reading every product and bundle from the store. This takes a few minutes the first time.</p>
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
  const isBundle = b.kind === 'bundle';
  const via = isBundle
    ? `<div class="via">Cheapest in a bundle${b.qty > 1 ? ` (${b.qty}-pack, ${money(b.perUnit)} each)` : ''}${b.extras.length ? ` with <b>${esc(b.extras.map(shortName).join(' + '))}</b>` : ''}</div>`
    : it.optionCount > 1 ? `<div class="via">Cheapest bought on its own · ${it.optionCount - 1} bundle${it.optionCount > 2 ? 's' : ''} compared</div>` : '';
  return `<a class="card" href="#/item/${encodeURIComponent(it.sku)}">
    ${it.saving >= 1 ? `<span class="badge-save">Save ${money(Math.round(it.saving))} in bundle</span>` : ''}
    <div class="thumb">${IMAGES && it.image ? `<img loading="lazy" src="${esc(it.image)}?width=300&height=300&fit=bounds" alt="">` : ''}</div>
    <div class="body">
      <span class="pill v-${it.verdict}">${esc(it.verdictLabel)}</span>
      <div class="name">${esc(shortName(it.name))}</div>
      ${via}
      <div class="price-row">
        <span class="price">${money(b.price)}</span>
        ${it.saving >= 1 && it.alone ? `<span class="strike">${money(it.alone.price)} alone</span>` : ''}
      </div>
      ${b.inStock ? '' : '<div class="oos">Out of stock online</div>'}
    </div>
  </a>`;
}
const grid = (items) => (items.length ? `<div class="grid">${items.map(card).join('')}</div>` : `<div class="empty">Nothing here yet.</div>`);

function sortControl(current) {
  const opts = [['saving', 'Biggest bundle saving'], ['price', 'Cheapest first'], ['relevance', 'Best match']];
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
  document.title = '4WD Deal Finder';
  app.innerHTML = `
    <section class="hero">
      <div><div class="big">${h.stealCount.toLocaleString()}</div><p>items are cheaper inside a bundle than on their own right now</p></div>
      <div style="flex:1;min-width:240px"><h1>Find the cheapest way to buy it</h1>
      <p>Search or open the menu. Every result shows the lowest price for that item, whether it's sold alone or inside a combo deal, plus whether you should buy now or wait.</p></div>
    </section>
    ${h.drops.length ? `<h2>Price drops since the last check</h2><p class="sub">Cheapest way to get these just got cheaper.</p>${grid(h.drops)}` : ''}
    <h2>Bundle steals</h2>
    <p class="sub">The bundle costs less than the item alone, so the extras are effectively free.</p>
    ${grid(h.steals)}`;
}

async function searchView(params) {
  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'relevance';
  $('#searchInput').value = q;
  document.title = `${q} · 4WD Deal Finder`;
  app.innerHTML = `<div class="loading">Searching for “${esc(q)}”…</div>`;
  const r = await api(`search?q=${encodeURIComponent(q)}&sort=${sort}`);
  const steals = r.items.filter((i) => i.saving >= 1).length;
  app.innerHTML = `
    <div class="crumbs"><a href="#/">Home</a> › Search</div>
    <h1>“${esc(q)}”</h1>
    <div class="toolbar">
      <span class="count">${r.items.length} items${steals ? ` · <b>${steals}</b> cheaper in a bundle` : ''}${r.source === 'local' && !STATIC ? ' · store search unavailable, matched locally' : ''}</span>
      ${sortControl(sort)}
    </div>
    ${grid(r.items)}`;
  bindSort('#/search', params);
}

async function categoryView(id, params) {
  const sort = params.get('sort') ?? 'saving';
  app.innerHTML = `<div class="loading">Loading…</div>`;
  const r = await api(`category/${id}?sort=${sort}`);
  document.title = `${r.name} · 4WD Deal Finder`;
  app.innerHTML = `
    <div class="crumbs"><a href="#/">Home</a>${r.trail.map((t) => ` › <a href="#/cat/${t.id}">${esc(t.name)}</a>`).join('')}</div>
    <h1>${esc(r.name)}</h1>
    ${r.children.length ? `<div class="chips">${r.children.map((c) => `<a class="chip" href="#/cat/${c.id}">${esc(c.name)}</a>`).join('')}</div>` : ''}
    <div class="toolbar"><span class="count">${r.items.length} items</span>${sortControl(sort)}</div>
    ${grid(r.items)}`;
  bindSort(`#/cat/${id}`, params);
}

function chart(history, trackingSince) {
  const series = [
    { key: 'best', color: 'var(--red)', label: 'Cheapest way to get it', pts: history.best },
    { key: 'alone', color: '#888', label: 'Bought on its own', pts: history.alone, dash: '5 4' },
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
      <div>${isBest ? '<span class="tag best">Cheapest</span>' : ''}<span class="tag ${w.kind === 'bundle' ? 'bundle' : ''}">${w.kind === 'bundle' ? (w.qty > 1 ? `${w.qty}-pack bundle` : 'Bundle') : 'On its own'}</span></div>
      <div class="w-name">${esc(shortName(w.name))}</div>
      <div class="w-meta">
        ${w.extras.length ? `Also includes ${w.extras.map((e) => `${e.qty > 1 ? `${e.qty}× ` : ''}${esc(shortName(e.name))}${e.value ? ` (${money(e.value)})` : ''}`).join(', ')}. ` : ''}
        ${w.qty > 1 ? `${money(w.perUnit)} per unit. ` : ''}
        ${saving >= 1 ? `<b style="color:var(--green)">${money(saving)} less than buying it alone.</b> ` : ''}
        ${w.inStock ? '' : '<b>Out of stock online.</b>'}
      </div>
    </div>
    <div class="w-price"><div class="price">${money(w.price)}</div>${w.url ? `<a class="buy-link" href="${esc(w.url)}" target="_blank" rel="noopener">View on store ↗</a>` : ''}</div>
  </li>`;
}

async function itemView(sku) {
  app.innerHTML = `<div class="loading">Loading…</div>`;
  const d = await api(`item/${encodeURIComponent(sku)}`);
  document.title = `${shortName(d.name)} · 4WD Deal Finder`;
  const a = d.advice;
  const s = a.stats;
  const best = d.ways.find((w) => w.inStock) ?? d.ways[0];
  const alone = d.ways.find((w) => w.kind === 'alone');
  app.innerHTML = `
    <div class="crumbs"><a href="#/">Home</a> › ${esc(shortName(d.name))}</div>
    <div class="item">
      <div>
        <div class="hero-img" ${IMAGES ? '' : 'hidden'}>${IMAGES && d.image ? `<img src="${esc(d.image)}?width=700&height=700&fit=bounds" alt="">` : ''}</div>
        ${d.pastSales.length ? `<div class="panel" style="margin-top:16px"><b>Store sale collections it's tagged in</b><div class="chips">${d.pastSales.map((n) => `<span class="chip">${esc(n)}</span>`).join('')}</div></div>` : ''}
      </div>
      <div>
        <h1>${esc(shortName(d.name))}</h1>
        <p class="sub">${esc(d.name.split('|').slice(1).join(' · '))}</p>
        <div class="panel verdict v-${a.verdict}">
          <div class="label">${esc(a.label)}</div>
          <p><b>${esc(a.headline)}</b></p>
          ${a.reasons.length ? `<ul>${a.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        </div>
        <div class="panel">
          <b>${d.ways.length} way${d.ways.length === 1 ? '' : 's'} to buy it</b>${d.unlisted ? ' <span class="muted">· not sold on its own</span>' : ''}
          <ul class="ways">${d.ways.map((w) => wayRow(w, w === best, alone?.price)).join('')}</ul>
        </div>
        <div class="panel">
          <b>Price history</b>
          ${chart(d.history, d.trackingSince)}
          ${s ? `<div class="stats">
            <div class="stat"><div class="k">Now</div><div class="v">${money(best?.price)}</div></div>
            <div class="stat"><div class="k">Lowest seen</div><div class="v">${money(s.low)}</div></div>
            <div class="stat"><div class="k">Usual</div><div class="v">${money(s.typical)}</div></div>
            <div class="stat"><div class="k">Highest</div><div class="v">${money(s.high)}</div></div>
          </div>
          <p class="muted">Tracked for ${s.trackedDays < 1 ? 'less than a day' : `${Math.round(s.trackedDays)} day${Math.round(s.trackedDays) === 1 ? '' : 's'}`} · ${s.episodes.length} sale period${s.episodes.length === 1 ? '' : 's'} seen · last checked ${ago(d.lastCheck)}</p>` : ''}
        </div>
        ${a.events?.length ? `<div class="panel"><b>Upcoming sale events</b><p class="muted">${a.events.map((e) => `${esc(e.name)}: ${fmtDate(e.date)} (${e.daysUntil} days)`).join(' · ')}</p></div>` : ''}
      </div>
    </div>`;
}

// ---- router ----------------------------------------------------------------
async function route() {
  const [path, query] = currentRoute().slice(1).split('?');
  $('#backBtn').hidden = !EMBEDDED || stack.length < 2;
  const params = new URLSearchParams(query);
  const parts = (path || '/').split('/').filter(Boolean);
  window.scrollTo(0, 0);
  try {
    if (parts[0] === 'search') await searchView(params);
    else if (parts[0] === 'cat') await categoryView(Number(parts[1]), params);
    else if (parts[0] === 'item') await itemView(decodeURIComponent(parts.slice(1).join('/')));
    else await homeView();
  } catch (e) {
    if (e.loading) return loadingView(e.status);
    app.innerHTML = `<div class="empty">Something went wrong: ${esc(e.message)}</div>`;
  }
}

if (!EMBEDDED) window.addEventListener('hashchange', route);
refreshStatus();
setInterval(refreshStatus, 20000);
route();
