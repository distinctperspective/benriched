import { EnrichmentContext } from '../context.js';
import { resolveDomainToWebsite } from '../../components/domainResolver.js';
import { calculateFirecrawlCost } from '../../../scraper.js';

export async function runDomainResolution(ctx: EnrichmentContext): Promise<void> {
  await ctx.emitter?.emit({
    stage: 'domain_resolution',
    message: 'Resolving domain to company website...',
    status: 'started'
  });

  const domainResolution = await resolveDomainToWebsite(ctx.domain, ctx.firecrawlApiKey);
  ctx.domainResolution = domainResolution;
  ctx.costs.addFirecrawlCredits(domainResolution.credits_used);

  await ctx.emitter?.emit({
    stage: 'domain_resolution',
    message: 'Domain resolved',
    status: 'complete',
    data: {
      resolved_domain: domainResolution.resolved_domain,
      domain_changed: domainResolution.domain_changed
    },
    cost: { usd: calculateFirecrawlCost(domainResolution.credits_used) }
  });

  // Use resolved domain for enrichment
  ctx.enrichmentDomain = domainResolution.resolved_domain;
  if (domainResolution.domain_changed) {
    console.log(`   🔄 Using resolved domain: ${ctx.enrichmentDomain}`);
  }
}
