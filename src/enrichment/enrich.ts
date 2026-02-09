import { EnrichmentResult, EnrichmentResultWithCost } from '../types.js';
import { SSEEmitter } from '../lib/sseEmitter.js';
import { createContext } from './pipeline/context.js';
import { runEnrichmentPipeline } from './pipeline/orchestrator.js';

// Re-export for external use
export { calculateAICost } from './components/pricing.js';
export { pass1_identifyUrlsWithUsage as pass1_identifyUrls } from './components/pass1.js';
export { pass2_analyzeContentWithUsage as pass2_analyzeContent } from './components/pass2.js';

export async function enrichDomain(
  domain: string,
  searchModel: any,
  analysisModel: any,
  firecrawlApiKey?: string
): Promise<EnrichmentResult> {
  const resultWithCost = await enrichDomainWithCost(domain, searchModel, analysisModel, firecrawlApiKey);
  return resultWithCost;
}

export async function enrichDomainWithCost(
  domain: string,
  searchModel: any,
  analysisModel: any,
  firecrawlApiKey?: string,
  searchModelId: string = 'perplexity/sonar-pro',
  analysisModelId: string = 'openai/gpt-4o-mini',
  forceDeepResearch: boolean = false,
  emitter?: SSEEmitter,
  providedCompanyName?: string,
  providedState?: string,
  providedCountry?: string
): Promise<EnrichmentResultWithCost> {
  console.log(`\n🚀 Starting enrichment for domain: ${domain}`);

  await emitter?.emit({
    stage: 'init',
    message: `Starting enrichment for ${domain}`,
    status: 'started'
  });

  const ctx = createContext({
    domain,
    searchModel,
    analysisModel,
    firecrawlApiKey,
    searchModelId,
    analysisModelId,
    forceDeepResearch,
    emitter,
    providedCompanyName,
    providedState,
    providedCountry
  });

  return runEnrichmentPipeline(ctx);
}
