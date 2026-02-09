import { EnrichmentResultWithCost } from '../../types.js';
import { EnrichmentContext } from './context.js';

import { runDomainResolution } from './stages/domain-resolution.js';
import { runPass1Search } from './stages/pass1-search.js';
import { runLinkedInSearch } from './stages/linkedin-search.js';
import { runDeepResearchStage } from './stages/deep-research.js';
import { runUrlSelection } from './stages/url-selection.js';
import { runScraping } from './stages/scraping.js';
import { runEntityValidation } from './stages/entity-validation.js';
import { runLinkedInValidation } from './stages/linkedin-validation.js';
import { runPass2Analysis } from './stages/pass2-analysis.js';
import { runDataEstimation } from './stages/data-estimation.js';
import { runParentEnrichment } from './stages/parent-enrichment.js';
import { runFinalAssembly } from './stages/final-assembly.js';

/**
 * Wraps a pipeline stage with automatic timing and error handling.
 * - Critical stages re-throw errors (pipeline cannot continue)
 * - Optional stages log the error and continue gracefully
 */
async function runStage<T>(
  ctx: EnrichmentContext,
  name: string,
  fn: () => Promise<T>,
  critical: boolean = false
): Promise<T | undefined> {
  ctx.timing.start(name);
  try {
    const result = await fn();
    ctx.timing.end(name);
    return result;
  } catch (error) {
    ctx.timing.end(name);
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Stage '${name}' failed: ${message}`);
    await ctx.emitter?.emit({
      stage: name,
      message: `Stage failed: ${message}`,
      status: 'error' as any
    });
    if (critical) {
      throw error;
    }
    return undefined;
  }
}

export async function runEnrichmentPipeline(ctx: EnrichmentContext): Promise<EnrichmentResultWithCost> {
  // Critical: domain resolution and web search are required
  await runStage(ctx, 'domain_resolution', () => runDomainResolution(ctx), true);
  await runStage(ctx, 'pass1', () => runPass1Search(ctx), true);

  // LinkedIn search and deep research are independent — run in parallel
  await Promise.all([
    runStage(ctx, 'linkedin_search', () => runLinkedInSearch(ctx)),
    runStage(ctx, 'deep_research', () => runDeepResearchStage(ctx)),
  ]);

  // URL selection with fallback to pass1 URLs if stage fails
  const urlsToScrape = await runStage(ctx, 'url_selection', () => runUrlSelection(ctx))
    ?? ctx.pass1Result?.urls_to_crawl ?? [];
  await runStage(ctx, 'scraping', () => runScraping(ctx, urlsToScrape));

  // Entity validation is optional — mismatch detection is a nice-to-have
  await runStage(ctx, 'entity_validation', () => runEntityValidation(ctx));

  // LinkedIn validation must run before Pass 2 (may add content to scrapedContent)
  await runStage(ctx, 'linkedin_validation', () => runLinkedInValidation(ctx));

  // Critical: content analysis is required for a useful result
  await runStage(ctx, 'pass2', () => runPass2Analysis(ctx), true);

  // Post-processing stages are optional — result is usable without them
  await runStage(ctx, 'data_estimation', () => runDataEstimation(ctx));
  await runStage(ctx, 'parent_enrichment', () => runParentEnrichment(ctx));

  return await runFinalAssembly(ctx);
}
