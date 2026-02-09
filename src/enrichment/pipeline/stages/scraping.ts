import { EnrichmentContext } from '../context.js';
import { scrapeMultipleUrlsWithCost, calculateFirecrawlCost } from '../../../scraper.js';

export async function runScraping(ctx: EnrichmentContext, urlsToScrape: string[]): Promise<void> {
  console.log(`\n🔥 Scraping ${urlsToScrape.length} URLs with Firecrawl...`);

  await ctx.emitter?.emit({
    stage: 'scraping',
    message: `Scraping ${urlsToScrape.length} URLs...`,
    status: 'started'
  });

  const scrapeResult = await scrapeMultipleUrlsWithCost(urlsToScrape, ctx.firecrawlApiKey);
  ctx.scrapedContent = scrapeResult.content;
  ctx.scrapeResult = { totalCreditsUsed: scrapeResult.totalCreditsUsed, scrapeCount: scrapeResult.scrapeCount };
  ctx.costs.addFirecrawlCredits(scrapeResult.totalCreditsUsed);
  ctx.costs.setScrapeCount(scrapeResult.scrapeCount);

  console.log(`   ✅ Successfully scraped ${scrapeResult.content.size} pages (${scrapeResult.totalCreditsUsed} credits)`);

  await ctx.emitter?.emit({
    stage: 'scraping',
    message: 'Scraping complete',
    status: 'complete',
    data: {
      pages_scraped: scrapeResult.content.size,
      credits_used: scrapeResult.totalCreditsUsed
    },
    cost: { usd: calculateFirecrawlCost(scrapeResult.totalCreditsUsed) }
  });
}
