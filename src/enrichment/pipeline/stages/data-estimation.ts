import { EnrichmentContext } from '../context.js';
import { shouldTriggerDeepResearch } from '../../deepResearch.js';
import { mapEmployeeCountToBand } from '../../components/employees.js';
import { recalculateIcp } from '../../components/icp.js';
import { pickRevenueBandFromEvidence, estimateRevenueBandFromEmployeesAndNaics, estimateFromIndustryAverages, validateRevenueVsEmployees, estimateEmployeeBandFromRevenue } from '../../../utils/revenue.js';
import { parseRevenueAmountToUsd, parseEmployeeBandLowerBound } from '../../../utils/parsing.js';

export async function runDataEstimation(ctx: EnrichmentContext): Promise<void> {
  const pass1Result = ctx.pass1Result!;
  const result = ctx.pass2Result!;

  await ctx.emitter?.emit({
    stage: 'data_estimation',
    message: 'Estimating revenue and employee data...',
    status: 'started'
  });

  // Add deep research info to diagnostics
  const deepResearchTriggered = ctx.forceDeepResearch || (ctx.outlierFlags ? shouldTriggerDeepResearch(ctx.outlierFlags) : false);
  if (result.diagnostics) {
    result.diagnostics.deep_research = {
      triggered: deepResearchTriggered,
      forced: ctx.forceDeepResearch,
      reasons: ctx.deepResearchResult?.triggered_by || [],
      revenue_found: ctx.deepResearchResult?.revenue?.amount || null,
      employees_found: ctx.deepResearchResult?.employees?.count || null,
      location_found: ctx.deepResearchResult?.location ? `${ctx.deepResearchResult.location.city}, ${ctx.deepResearchResult.location.country}` : null
    };

    // Update domain verification to include domain resolver contribution
    if (result.diagnostics.domain_verification && ctx.domainResolution?.domain_changed) {
      result.diagnostics.domain_verification = {
        ...result.diagnostics.domain_verification,
        verification_source: 'domain_resolver',
        reasoning: `Domain resolver: ${ctx.domainResolution.resolution_method}. Then: ${result.diagnostics.domain_verification.reasoning}`
      };
    }
  }

  // ALWAYS use our scraped/Pass 1 LinkedIn URL if we found one (more reliable than Pass 2)
  if (ctx.linkedinUrl) {
    let linkedinUrl = ctx.linkedinUrl;
    linkedinUrl = linkedinUrl.replace(/https:\/\/www\s+linkedin/, 'https://www.linkedin');
    linkedinUrl = linkedinUrl.replace(/https:\/\/linkedin\s+/, 'https://www.linkedin.');
    if (!linkedinUrl.startsWith('http')) {
      linkedinUrl = 'https://' + linkedinUrl;
    }
    if (linkedinUrl.includes('linkedin')) {
      result.linkedin_url = linkedinUrl;
    }
  }

  // Use LinkedIn employee count for company_size if we have it and result is unknown
  if ((result.company_size === 'unknown' || !result.company_size) && ctx.linkedinEmployeeCount) {
    const employeeBand = mapEmployeeCountToBand(ctx.linkedinEmployeeCount);
    if (employeeBand) {
      result.company_size = employeeBand;
      result.quality.size = {
        confidence: 'high',
        reasoning: `Employee count ${ctx.linkedinEmployeeCount} from LinkedIn company page`
      };
      console.log(`   📊 Set company_size from LinkedIn: ${employeeBand}`);
    }
  }

  // Revenue logic: Prefer Pass 1 evidence over Pass 2 when we have actual data
  const pass1Evidence = Array.isArray(pass1Result.revenue_found) ? pass1Result.revenue_found : [];
  const hasPass1Revenue = pass1Evidence.length > 0 && pass1Evidence.some(e => e.amount && e.amount !== 'null');

  if (hasPass1Revenue) {
    const picked = pickRevenueBandFromEvidence(pass1Evidence);
    if (picked.band) {
      result.company_revenue = picked.band;
      result.quality.revenue.confidence = picked.confidence;
      result.quality.revenue.reasoning = picked.reasoning;
      console.log(`   💰 Using Pass 1 revenue evidence: ${picked.band}`);
    }
  } else if (!result.company_revenue) {
    const employeeLower = parseEmployeeBandLowerBound(result.company_size);
    if (employeeLower && employeeLower > 0) {
      const estimated = estimateRevenueBandFromEmployeesAndNaics(employeeLower, result.naics_codes_6_digit);
      if (estimated.band) {
        result.company_revenue = estimated.band;
        result.quality.revenue.confidence = 'low';
        result.quality.revenue.reasoning = `${estimated.reasoning}. This is an estimate (no explicit revenue figure found).`;
      }
    }
  }

  // Final fallback: Industry average estimates when no data found at all
  const needsSizeEstimate = !result.company_size || result.company_size === 'unknown' || result.company_size === 'Unknown';
  const needsRevenueEstimate = !result.company_revenue;

  // If we have revenue but no employees, estimate employees from revenue
  if (needsSizeEstimate && !needsRevenueEstimate && result.company_revenue) {
    const revenueEvidence = pass1Evidence[0];
    if (revenueEvidence?.amount) {
      const revenueUsd = parseRevenueAmountToUsd(revenueEvidence.amount);
      if (revenueUsd && revenueUsd > 0) {
        const employeeEstimate = estimateEmployeeBandFromRevenue(revenueUsd, result.naics_codes_6_digit);
        if (employeeEstimate.band) {
          result.company_size = employeeEstimate.band;
          result.quality.size = {
            confidence: 'medium',
            reasoning: employeeEstimate.reasoning
          };
          console.log(`   👥 Size estimated from revenue: ${employeeEstimate.band}`);
        }
      }
    }
  }

  // Recalculate needsSizeEstimate after revenue-based estimation
  const stillNeedsSizeEstimate = !result.company_size || result.company_size === 'unknown' || result.company_size === 'Unknown';

  if ((stillNeedsSizeEstimate || needsRevenueEstimate) && result.naics_codes_6_digit?.length > 0) {
    const industryEstimate = estimateFromIndustryAverages(result.naics_codes_6_digit);
    console.log(`\n📊 Using industry average estimates (no actual data found):`);

    if (stillNeedsSizeEstimate && industryEstimate.sizeBand) {
      result.company_size = industryEstimate.sizeBand;
      result.quality.size = {
        confidence: 'low',
        reasoning: industryEstimate.sizeReasoning
      };
      console.log(`   👥 Size: ${industryEstimate.sizeBand} (industry estimate)`);
    }

    if (needsRevenueEstimate && industryEstimate.revenueBand) {
      result.company_revenue = industryEstimate.revenueBand;
      result.quality.revenue = {
        confidence: 'low',
        reasoning: industryEstimate.revenueReasoning
      };
      console.log(`   💰 Revenue: ${industryEstimate.revenueBand} (industry estimate)`);
    }
  }

  // Sanity check: validate revenue vs employee count consistency
  if (result.company_revenue && result.company_size && result.company_size !== 'unknown') {
    const validation = validateRevenueVsEmployees(
      result.company_revenue,
      result.company_size,
      result.naics_codes_6_digit
    );
    if (validation.wasAdjusted) {
      console.log(`   ⚠️  Revenue adjusted: ${result.company_revenue} → ${validation.adjustedRevenueBand}`);
      console.log(`      Reason: ${validation.reasoning}`);

      if (result.diagnostics) {
        result.diagnostics.revenue_adjustment = {
          original_band: result.company_revenue,
          adjusted_band: validation.adjustedRevenueBand,
          reason: validation.reasoning
        };
      }

      result.company_revenue = validation.adjustedRevenueBand;
      result.quality.revenue = {
        confidence: 'medium',
        reasoning: validation.reasoning
      };
    }
  }

  // Recalculate revenue_pass and target_icp after all revenue modifications
  recalculateIcp(result);

  await ctx.emitter?.emit({
    stage: 'data_estimation',
    message: 'Data estimation complete',
    status: 'complete',
    data: {
      company_revenue: result.company_revenue,
      company_size: result.company_size
    }
  });
}
