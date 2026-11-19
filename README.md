# 4WD Deal Finder

An unofficial reskin of the 4WD Supacentre catalogue that answers one question
for every item: **what's the cheapest way to buy it?** The store often sells an
item for less inside a bundle than on its own (on 19 Nov 2026, 239 items were
like this, e.g. a 200W fixed solar panel at $179 alone vs $108.95 with brackets).

- **Menu and search like the store's.** Results are grouped by *item*. Each card
  shows the lowest price you can get it for, alone or in any bundle, and what
  the bundle throws in.
- **Item page.** Every way to buy it, cheapest first, with links to the store.
- **Price tracking.** Each check records every product's price and the cheapest
  way to get it, so you can see the lowest price seen, the usual price and past sales.
- **Buy now or wait?** Advice based on that history, the store's own sale tags
  (live sale collections, "was" prices, past Boxing Day/EOFY/Black Friday sales)
  and the sale calendar.

## The public site

The site is plain static files hosted on GitHub Pages. There's no server.
`.github/workflows/update.yml` runs every 6 hours (and on every push to `main`):

1. reads the whole catalogue from the store (~5,000 products, about 2 minutes),
2. commits the updated price history (`data/history.json`) to the repo,
3. builds the site (`npm run build` → `dist-site/`) and publishes it.

The repo is the database: `data/history.json` holds every price change since
tracking began, one product per line.

### One-time setup

1. Create a **public** GitHub repo and push this folder's contents to `main`.
2. In the repo, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Open **Actions → Update prices and publish → Run workflow** (or just push).
   The site appears at `https://<your-username>.github.io/<repo-name>/`.

To use your own domain, add it under Settings → Pages → Custom domain.

## Run it locally

Needs Node 18+. No dependencies to install.

```bash
npm start            # http://localhost:8790, checks prices every 6 hours while running
npm run crawl        # one price check
npm run build        # build the static site into dist-site/
npm test
```

Locally, search uses the store's own search ranking. The static site ranks
matches itself, because browsers can't call the store's API from another site.

## About the price history

History starts with the first check (19 Nov 2026). The store doesn't publish
past prices, so there's nothing to backfill. Until an item has 14 days of
history, the advice relies on the store's own signals (sale tags, "was" prices,
bundle savings) and upcoming sale events.

## How it works

| File | Purpose |
|---|---|
| `lib/store.js` | Queries the store's public GraphQL API (the one its own site uses) |
| `lib/crawl.js` | Reads every product, bundle and variant; saves `data/catalog.json`, appends `data/history.json` |
| `lib/deals.js` | Ways-to-buy calculation, grouping results by item, history stats, buy/wait advice, sale calendar |
| `lib/api.js` | The app's API, shared by the local server and the static site |
| `server.js` | Local web server |
| `build-static.js` | Builds the static site (`--embedded` builds the claude.ai snapshot instead) |
| `public/` | The front end (plain HTML/CSS/JS) |

Prices come from the store's public catalogue. Confirm the price on the store
before buying: cart promos, shipping and stock can differ. This site isn't
affiliated with 4WD Supacentre.
