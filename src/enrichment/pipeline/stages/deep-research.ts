import { EnrichmentContext } from '../context.js';
import { detectOutliers, shouldTriggerDeepResearch, runDeepResearch } from '../../deepResearch.js';

export async function runDeepResearchStage(ctx: EnrichmentContext): Promise<void> {
  const pass1Result = ctx.pass1Result!;

  // Check what data Pass 1 already found
  const hasRevenue = Array.isArray(pass1Result.revenue_found) && pass1Result.revenue_found.length > 0;
  const employeeAmount = pass1Result.employee_count_found?.amount?.toLowerCase() || '';
  const hasEmployees = !!pass1Result.employee_count_found?.amount &&
    !employeeAmount.includes('not found') &&
    !employeeAmount.includes('unknown') &&
    /\d/.test(employeeAmount);
  console.log(`   📊 Pass 1 data: revenue=${hasRevenue ? 'YES' : 'NO'}, employees=${hasEmployees ? 'YES' : 'NO'}`);

  // Detect outliers
  const outlierFlags = detectOutliers(pass1Result);
  ctx.outlierFlags = outlierFlags;

  if (!ctx.forceDeepResearch && !shouldTriggerDeepResearch(outlierFlags)) {
    return;
  }

  if (ctx.forceDeepResearch) {
    console.log(`\n🔬 Deep Research FORCED by request parameter`);
  }

  await ctx.emitter?.emit({
    stage: 'deep_research',
    message: 'Running deep research queries...',
    status: 'started',
    data: { reasons: Object.keys(outlierFlags).filter(k => outlierFlags[k as keyof typeof outlierFlags]) }
  });

  const deepResearchResult = await runDeepResearch(
    ctx.enrichmentDomain,
    pass1Result.company_name,
    ctx.searchModel,
    ctx.searchModelId,
    outlierFlags
  );
  ctx.deepResearchResult = deepResearchResult;

  await ctx.emitter?.emit({
    stage: 'deep_research',
    message: 'Deep research complete',
    status: 'complete',
    cost: { usd: deepResearchResult.usage?.costUsd || 0 }
  });

  // Merge deep research results into pass1Result
  if (deepResearchResult.revenue?.amount) {
    const existingRevenue = pass1Result.revenue_found || [];
    pass1Result.revenue_found = [
      {
        amount: deepResearchResult.revenue.amount,
        source: `Deep Research: ${deepResearchResult.revenue.source || 'unknown'}`,
        year: deepResearchResult.revenue.year || '2024',
        is_estimate: deepResearchResult.revenue.confidence !== 'high'
      },
      ...existingRevenue
    ];
    console.log(`   💰 Deep research added revenue: ${deepResearchResult.revenue.amount}`);
  }

  if (deepResearchResult.employees?.count) {
    const existingEmployees = pass1Result.employee_count_found;
    const employeeList = Array.isArray(existingEmployees) ? existingEmployees : (existingEmployees ? [existingEmployees] : []);
    pass1Result.employee_count_found = [
      {
        amount: String(deepResearchResult.employees.count),
        source: `Deep Research: ${deepResearchResult.employees.source}`,
      },
      ...employeeList
    ] as any;
    console.log(`   👥 Deep research added employees: ${deepResearchResult.employees.count}`);
  }

  if (deepResearchResult.location) {
    if (!pass1Result.headquarters || pass1Result.headquarters.country === 'unknown') {
      pass1Result.headquarters = {
        city: deepResearchResult.location.city || '',
        state: deepResearchResult.location.state || '',
        country: deepResearchResult.location.country || '',
        country_code: deepResearchResult.location.country || ''
      };
      console.log(`   📍 Deep research added location: ${deepResearchResult.location.city}, ${deepResearchResult.location.country}`);
    }
  }
}
