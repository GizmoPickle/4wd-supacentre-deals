#!/usr/bin/env node
// One-off crawl: `npm run crawl`. Useful from cron or a scheduled CI job.
import { crawl } from './lib/crawl.js';

const t = Date.now();
crawl({ onProgress: ({ done, total }) => process.stdout.write(`\rCrawling page ${done}/${total}`) })
  .then((r) => console.log(`\nSaved ${r.products} products in ${((Date.now() - t) / 1000).toFixed(0)}s.`))
  .catch((err) => {
    console.error('\nCrawl failed:', err.message);
    process.exit(1);
  });
