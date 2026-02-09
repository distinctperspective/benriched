import { EnrichmentContext } from '../context.js';
import { pass2_analyzeContentWithUsage } from '../../components/pass2.js';

export async function runPass2Analysis(ctx: EnrichmentContext): Promise<void> {
  const pass1Result = ctx.pass1Result!;

  await ctx.emitter?.emit({
    stage: 'pass2_analysis',
    message: 'Analyzing content with AI...',
    status: 'started',
    data: { model: 'openai/gpt-4o-mini' }
  });

  const { result, usage, rawResponse } = await pass2_analyzeContentWithUsage(
    ctx.enrichmentDomain,
    pass1Result.company_name,
    ctx.scrapedContent,
    ctx.analysisModel,
    pass1Result,
    ctx.analysisModelId,
    ctx.domain // Pass original input domain for verification tracking
  );

  ctx.pass2Result = result;
  ctx.pass2RawResponse = rawResponse;
  ctx.costs.pass2Usage = usage;

  await ctx.emitter?.emit({
    stage: 'pass2_analysis',
    message: 'Content analysis complete',
    status: 'complete',
    cost: { usd: usage.costUsd }
  });
}
