#!/usr/bin/env node
// One-off crawl: `npm run crawl`. Useful from cron or a scheduled CI job.
import { crawl } from './lib/crawl.js';

const t = Date.now();
crawl({
  onProgress: ({ done, total }) => process.stdout.write(`\rPrices: page ${done}/${total}`),
  onDetailsProgress: ({ done, total }) => process.stdout.write(`\rDetails: ${done}/${total} products   `),
})
  .then((r) => {
    console.log(`\nSaved ${r.products} products.`);
    if (r.details) console.log(`Details: ${r.details.fetched} of ${r.details.total} products${r.details.failed ? `, ${r.details.failed} failed` : ''}.`);
    console.log(`Done in ${((Date.now() - t) / 1000).toFixed(0)}s.`);
  })
  .catch((err) => {
    console.error('\nCrawl failed:', err.message);
    process.exit(1);
  });
