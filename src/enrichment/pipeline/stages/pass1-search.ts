import { EnrichmentContext } from '../context.js';
import { pass1_identifyUrlsWithUsage } from '../../components/pass1.js';

export async function runPass1Search(ctx: EnrichmentContext): Promise<void> {
  await ctx.emitter?.emit({
    stage: 'pass1_search',
    message: 'Searching web for company data...',
    status: 'started',
    data: { model: 'perplexity/sonar-pro' }
  });

  const { result, usage, rawResponse } = await pass1_identifyUrlsWithUsage(
    ctx.enrichmentDomain,
    ctx.searchModel,
    ctx.searchModelId,
    ctx.providedCompanyName,
    ctx.providedState,
    ctx.providedCountry
  );

  ctx.pass1Result = result;
  ctx.pass1RawResponse = rawResponse;
  ctx.costs.pass1Usage = usage;

  console.log(`   📝 Company: ${result.company_name}`);

  // Debug: Check if Pass 1 returned LinkedIn candidates
  if (result.linkedin_url_candidates && result.linkedin_url_candidates.length > 0) {
    console.log(`   🔗 Pass 1 LinkedIn candidates: ${result.linkedin_url_candidates.map(c => `${c.url} (${c.confidence})`).join(', ')}`);
  } else {
    console.log(`   ⚠️  Pass 1 returned no LinkedIn candidates`);
  }

  await ctx.emitter?.emit({
    stage: 'pass1_search',
    message: 'Web search complete',
    status: 'complete',
    data: {
      company_name: result.company_name,
      parent_company: result.parent_company
    },
    cost: { usd: usage.costUsd }
  });
}
