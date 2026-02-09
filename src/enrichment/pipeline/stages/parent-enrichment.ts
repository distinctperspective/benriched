import { EnrichmentContext } from '../context.js';
import { guessParentDomain } from '../parent-domains.js';
import { getCompanyByDomain } from '../../../lib/supabase.js';
import { isPassingRevenue, recalculateIcp } from '../../components/icp.js';

export async function runParentEnrichment(ctx: EnrichmentContext): Promise<void> {
  const pass1Result = ctx.pass1Result!;
  const result = ctx.pass2Result!;

  await ctx.emitter?.emit({
    stage: 'parent_enrichment',
    message: 'Checking parent company data...',
    status: 'started'
  });

  const parentCompanyName = pass1Result.parent_company;
  const hasPassingRevenue = isPassingRevenue(result.company_revenue ?? null);

  const childHasWeakData = !result.company_revenue || !hasPassingRevenue ||
    result.company_size === 'unknown' || result.company_size === '0-1 Employees' ||
    result.company_size === '2-10 Employees' || result.company_size === '11-50 Employees';

  if (parentCompanyName && childHasWeakData) {
    console.log(`\n🏢 Parent company detected: ${parentCompanyName}`);
    console.log(`   Child has weak data - attempting to enrich parent...`);

    const parentDomain = guessParentDomain(parentCompanyName);

    if (parentDomain) {
      const { data: existingParent } = await getCompanyByDomain(parentDomain);

      if (existingParent && existingParent.company_revenue) {
        console.log(`   ✅ Found parent in DB: ${existingParent.company_name} (${existingParent.company_revenue})`);

        // Inherit revenue if child doesn't have good data
        if (!result.company_revenue || !hasPassingRevenue) {
          result.company_revenue = existingParent.company_revenue;
          result.inherited_revenue = true;
          result.quality.revenue = {
            confidence: 'medium',
            reasoning: `Inherited from parent company: ${existingParent.company_name}`
          };
          console.log(`   💰 Inherited revenue: ${existingParent.company_revenue}`);
        }

        // Inherit size if child has small/unknown size
        const smallSizes = new Set(['unknown', '0-1 Employees', '2-10 Employees', '11-50 Employees', '51-200 Employees']);
        if (smallSizes.has(result.company_size)) {
          result.company_size = existingParent.company_size || result.company_size;
          result.inherited_size = true;
          result.quality.size = {
            confidence: 'medium',
            reasoning: `Inherited from parent company: ${existingParent.company_name}`
          };
          console.log(`   👥 Inherited size: ${existingParent.company_size}`);
        }

        result.parent_company_name = existingParent.company_name;
        result.parent_company_domain = parentDomain;

        // Recalculate ICP with inherited data
        recalculateIcp(result);

        if (result.target_icp) {
          console.log(`   🎯 ICP now PASSING with inherited data`);
        }
      } else {
        console.log(`   ⚠️ Parent not in DB or has no revenue data. Consider enriching: ${parentDomain}`);
        result.parent_company_name = parentCompanyName;
        result.parent_company_domain = parentDomain;
      }
    } else {
      console.log(`   ⚠️ Could not determine parent domain for: ${parentCompanyName}`);
      result.parent_company_name = parentCompanyName;
    }
  }

  if (!parentCompanyName || !childHasWeakData) {
    await ctx.emitter?.emit({
      stage: 'parent_enrichment',
      message: 'No parent enrichment needed',
      status: 'complete'
    });
  } else {
    await ctx.emitter?.emit({
      stage: 'parent_enrichment',
      message: 'Parent enrichment complete',
      status: 'complete',
      data: {
        inherited_revenue: result.inherited_revenue || false,
        inherited_size: result.inherited_size || false
      }
    });
  }
}
