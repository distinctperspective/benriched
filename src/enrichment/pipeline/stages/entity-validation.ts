import { EnrichmentContext } from '../context.js';
import { detectEntityMismatch } from '../../components/entityDetection.js';
import { pass1_identifyUrlsStrict } from '../../components/pass1.js';
import { scrapeMultipleUrlsWithCost } from '../../../scraper.js';

export async function runEntityValidation(ctx: EnrichmentContext): Promise<void> {
  let pass1Result = ctx.pass1Result!;

  await ctx.emitter?.emit({
    stage: 'entity_validation',
    message: 'Validating company identity...',
    status: 'started'
  });

  const entityCheck = detectEntityMismatch(pass1Result.company_name, ctx.domain, ctx.scrapedContent);

  if (entityCheck.mismatch) {
    console.log(`\n⚠️  Potential entity mismatch detected (${entityCheck.signal}). Re-running Pass 1 in strict mode...`);

    await ctx.emitter?.emit({
      stage: 'entity_validation',
      message: 'Re-validating with strict mode...',
      status: 'started'
    });

    // Preserve original data before strict mode overwrites
    const originalRevenueFound = pass1Result.revenue_found;
    const originalEmployeeFound = pass1Result.employee_count_found;
    const originalHeadquarters = pass1Result.headquarters;
    const originalLinkedInCandidates = pass1Result.linkedin_url_candidates;

    const strictResult = await pass1_identifyUrlsStrict(ctx.domain, ctx.searchModel, pass1Result.company_name);
    console.log(`   📝 Company (strict): ${strictResult.company_name}`);
    console.log(`   🔗 URLs (strict): ${strictResult.urls_to_crawl.join(', ')}`);

    // Merge: combine revenue evidence from both passes
    const combinedRevenue = [
      ...(originalRevenueFound || []),
      ...(strictResult.revenue_found || [])
    ].filter(r => r && r.amount);

    const strictHasHQ = strictResult.headquarters?.city && strictResult.headquarters.city !== 'unknown';

    ctx.pass1Result = {
      ...strictResult,
      revenue_found: combinedRevenue.length > 0 ? combinedRevenue : originalRevenueFound,
      employee_count_found: strictResult.employee_count_found || originalEmployeeFound,
      headquarters: strictHasHQ ? strictResult.headquarters : originalHeadquarters,
      linkedin_url_candidates: originalLinkedInCandidates || strictResult.linkedin_url_candidates,
    };

    console.log(`\n🔥 Re-scraping ${ctx.pass1Result.urls_to_crawl.length} URLs with Firecrawl...`);
    const reScrape = await scrapeMultipleUrlsWithCost(ctx.pass1Result.urls_to_crawl, ctx.firecrawlApiKey);
    ctx.scrapedContent = reScrape.content;
    ctx.costs.addFirecrawlCredits(reScrape.totalCreditsUsed);
    ctx.costs.setScrapeCount(ctx.costs.scrapeCount + reScrape.scrapeCount);
    console.log(`   ✅ Successfully scraped ${reScrape.content.size} pages (${reScrape.totalCreditsUsed} credits)`);

    await ctx.emitter?.emit({
      stage: 'entity_validation',
      message: 'Entity re-validated in strict mode',
      status: 'complete'
    });
  } else {
    await ctx.emitter?.emit({
      stage: 'entity_validation',
      message: 'Entity validated',
      status: 'complete'
    });
  }
}
