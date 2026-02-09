import { EnrichmentContext } from '../context.js';
import { EnrichmentResultWithCost, CostBreakdown, PerformanceMetrics } from '../../../types.js';
import { calculateFirecrawlCost } from '../../../scraper.js';

const ZERO_USAGE = { model: 'unknown', inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };

export async function runFinalAssembly(ctx: EnrichmentContext): Promise<EnrichmentResultWithCost> {
  const result = ctx.pass2Result!;
  const costs = ctx.costs;

  await ctx.emitter?.emit({
    stage: 'final_assembly',
    message: 'Calculating costs and assembling data...',
    status: 'started'
  });

  // Build cost breakdown (defensive against null usage from failed stages)
  const pass1Usage = costs.pass1Usage ?? ZERO_USAGE;
  const pass2Usage = costs.pass2Usage ?? ZERO_USAGE;
  const deepResearchCost = ctx.deepResearchResult?.usage?.costUsd || 0;
  const firecrawlCost = calculateFirecrawlCost(costs.firecrawlCredits);
  const aiTotalCost = pass1Usage.costUsd + pass2Usage.costUsd + deepResearchCost;
  const totalCost = aiTotalCost + firecrawlCost;

  const cost: CostBreakdown = {
    ai: {
      pass1: pass1Usage,
      pass2: pass2Usage,
      deepResearch: ctx.deepResearchResult?.usage || undefined,
      total: {
        inputTokens: pass1Usage.inputTokens + pass2Usage.inputTokens + (ctx.deepResearchResult?.usage?.inputTokens || 0),
        outputTokens: pass1Usage.outputTokens + pass2Usage.outputTokens + (ctx.deepResearchResult?.usage?.outputTokens || 0),
        totalTokens: pass1Usage.totalTokens + pass2Usage.totalTokens + (ctx.deepResearchResult?.usage?.totalTokens || 0),
        costUsd: aiTotalCost
      }
    },
    firecrawl: {
      scrapeCount: costs.scrapeCount,
      creditsUsed: costs.firecrawlCredits,
      costUsd: firecrawlCost
    },
    total: {
      costUsd: totalCost
    }
  };

  // Build performance metrics (keep backwards-compatible fields)
  const totalMs = ctx.timing.totalMs;
  const pass1Ms = ctx.timing.get('pass1');
  const scrapingMs = ctx.timing.get('scraping');
  const pass2Ms = ctx.timing.get('pass2');
  const scrapeCount = costs.scrapeCount;

  const performance: PerformanceMetrics = {
    pass1_ms: pass1Ms,
    scraping_ms: scrapingMs,
    pass2_ms: pass2Ms,
    total_ms: totalMs,
    scrape_count: scrapeCount,
    avg_scrape_ms: scrapeCount > 0 ? Math.round(scrapingMs / scrapeCount) : 0
  };

  console.log(`\n✨ Enrichment complete for ${result.company_name}`);
  console.log(`\n💰 Cost breakdown:`);
  console.log(`   AI Pass 1 (${pass1Usage.model}): ${pass1Usage.totalTokens} tokens = $${pass1Usage.costUsd.toFixed(4)}`);
  if (ctx.deepResearchResult?.usage) {
    console.log(`   AI Deep Research: ${ctx.deepResearchResult.usage.totalTokens} tokens = $${deepResearchCost.toFixed(4)} (triggered by: ${ctx.deepResearchResult.triggered_by.join(', ')})`);
  }
  console.log(`   AI Pass 2 (${pass2Usage.model}): ${pass2Usage.totalTokens} tokens = $${pass2Usage.costUsd.toFixed(4)}`);
  console.log(`   Firecrawl: ${costs.firecrawlCredits} credits = $${firecrawlCost.toFixed(4)}`);
  console.log(`   TOTAL: $${totalCost.toFixed(4)}`);
  console.log(`\n⏱️  Performance:`);
  console.log(`   Domain Resolution: ${ctx.timing.get('domain_resolution')}ms`);
  console.log(`   Pass 1: ${pass1Ms}ms`);
  console.log(`   LinkedIn Search: ${ctx.timing.get('linkedin_search')}ms`);
  console.log(`   Deep Research: ${ctx.timing.get('deep_research')}ms`);
  console.log(`   Scraping: ${scrapingMs}ms (${scrapeCount} pages, avg ${performance.avg_scrape_ms}ms/page)`);
  console.log(`   Entity Validation: ${ctx.timing.get('entity_validation')}ms`);
  console.log(`   LinkedIn Validation: ${ctx.timing.get('linkedin_validation')}ms`);
  console.log(`   Pass 2: ${pass2Ms}ms`);
  console.log(`   Data Estimation: ${ctx.timing.get('data_estimation')}ms`);
  console.log(`   Parent Enrichment: ${ctx.timing.get('parent_enrichment')}ms`);
  console.log(`   TOTAL: ${totalMs}ms`);

  // Build raw API responses object
  const raw_api_responses: Record<string, any> = {
    domainResolution: ctx.domainResolution ? {
      submitted_domain: ctx.domainResolution.submitted_domain,
      resolved_domain: ctx.domainResolution.resolved_domain,
      domain_changed: ctx.domainResolution.domain_changed,
      resolution_method: ctx.domainResolution.resolution_method
    } : undefined,
    pass1: ctx.pass1RawResponse,
    pass2: ctx.pass2RawResponse,
    deepResearch: ctx.deepResearchResult?.rawResponse
  };

  await ctx.emitter?.emit({
    stage: 'final_assembly',
    message: 'Final assembly complete',
    status: 'complete',
    cost: { usd: totalCost }
  });

  return { ...result, cost, performance, raw_api_responses };
}
