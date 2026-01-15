import { RevenueEvidence } from '../types.js';
import { parseRevenueAmountToUsd, mapUsdToRevenueBand } from './parsing.js';

export function pickRevenueBandFromEvidence(
  evidence: RevenueEvidence[]
): { band: string | null; confidence: 'high' | 'medium' | 'low'; reasoning: string } {
  const parsed = (evidence || [])
    .map((e) => {
      const usd = parseRevenueAmountToUsd(e.amount);
      const yearNum = Number(e.year);
      return {
        ...e,
        usd,
        yearNum: Number.isFinite(yearNum) ? yearNum : null,
      };
    })
    .filter((e) => e.usd && e.usd > 0);

  if (parsed.length === 0) {
    return { band: null, confidence: 'low', reasoning: 'No usable revenue figures to map to a band' };
  }

  const values = parsed.map((p) => p.usd as number);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min > 0 && max / min > 5) {
    return {
      band: null,
      confidence: 'low',
      reasoning: 'Revenue sources conflict by more than 5×; leaving revenue as null',
    };
  }

  const sorted = [...parsed].sort((a, b) => {
    const ay = a.yearNum ?? -1;
    const by = b.yearNum ?? -1;
    if (ay !== by) return by - ay;
    if (a.is_estimate !== b.is_estimate) return a.is_estimate ? 1 : -1;
    return (b.usd as number) - (a.usd as number);
  });

  const best = sorted[0];
  const band = best.usd ? mapUsdToRevenueBand(best.usd) : null;
  if (!band) {
    return { band: null, confidence: 'low', reasoning: 'Could not map revenue evidence to a band' };
  }

  const sourceLower = (best.source || '').toLowerCase();
  const confidence: 'high' | 'medium' | 'low' =
    /(sec|10-k|annual report|earnings|results)/.test(sourceLower)
      ? 'high'
      : best.is_estimate
        ? 'medium'
        : 'high';

  return {
    band,
    confidence,
    reasoning: `Mapped revenue evidence ${best.amount} (${best.year}, ${best.source}) to ${band}`,
  };
}

export function estimateRevenueBandFromEmployeesAndNaics(
  employeeLowerBound: number,
  naicsCodes: Array<{ code: string; description: string }>
): { band: string | null; reasoning: string } {
  const first = (naicsCodes?.[0]?.code || '').slice(0, 2);
  const rpe =
    first === '44' || first === '45'
      ? 80_000
      : first === '42'
        ? 120_000
        : ['31', '32', '33'].includes(first)
          ? 120_000
          : first === '51' || first === '54'
            ? 200_000
            : 100_000;

  const estimated = employeeLowerBound * rpe;
  const band = mapUsdToRevenueBand(estimated);
  if (!band) {
    return { band: null, reasoning: 'Could not estimate a revenue band from employee count' };
  }

  return {
    band,
    reasoning: `Estimated revenue using employee lower bound (${employeeLowerBound}) and industry proxy (NAICS ${first || 'unknown'}) → mapped to ${band}`,
  };
}

// Industry average estimates when no data is found
// Based on US Census Bureau Statistics of US Businesses (SUSB) data
interface IndustryEstimate {
  sizeBand: string;
  revenueBand: string;
  avgEmployees: number;
  avgRevenue: number;
}

const INDUSTRY_AVERAGES: Record<string, IndustryEstimate> = {
  // Manufacturing (31-33)
  '31': { sizeBand: '11-50 Employees', revenueBand: '1M-5M', avgEmployees: 25, avgRevenue: 3_000_000 },
  '32': { sizeBand: '11-50 Employees', revenueBand: '1M-5M', avgEmployees: 25, avgRevenue: 3_000_000 },
  '33': { sizeBand: '11-50 Employees', revenueBand: '1M-5M', avgEmployees: 25, avgRevenue: 3_000_000 },
  // Wholesale Trade (42)
  '42': { sizeBand: '11-50 Employees', revenueBand: '5M-10M', avgEmployees: 15, avgRevenue: 7_000_000 },
  // Retail Trade (44-45)
  '44': { sizeBand: '2-10 Employees', revenueBand: '500K-1M', avgEmployees: 8, avgRevenue: 800_000 },
  '45': { sizeBand: '2-10 Employees', revenueBand: '500K-1M', avgEmployees: 8, avgRevenue: 800_000 },
  // Information (51)
  '51': { sizeBand: '11-50 Employees', revenueBand: '1M-5M', avgEmployees: 20, avgRevenue: 4_000_000 },
  // Professional Services (54)
  '54': { sizeBand: '2-10 Employees', revenueBand: '500K-1M', avgEmployees: 6, avgRevenue: 900_000 },
  // Food Services (72)
  '72': { sizeBand: '11-50 Employees', revenueBand: '500K-1M', avgEmployees: 15, avgRevenue: 750_000 },
  // Default for unknown industries
  'default': { sizeBand: '2-10 Employees', revenueBand: '<1M', avgEmployees: 10, avgRevenue: 500_000 },
};

// Minimum expected revenue per employee by industry (conservative estimates)
const MIN_REVENUE_PER_EMPLOYEE: Record<string, number> = {
  '31': 50_000,  // Manufacturing
  '32': 50_000,
  '33': 50_000,
  '42': 80_000,  // Wholesale
  '44': 40_000,  // Retail
  '45': 40_000,
  '51': 100_000, // Information/Tech
  '54': 80_000,  // Professional Services
  '72': 30_000,  // Food Services
  'default': 50_000,
};

/**
 * Validates that revenue and employee count are consistent.
 * Returns adjusted revenue band if the original seems too low for the employee count.
 */
export function validateRevenueVsEmployees(
  revenueBand: string | null,
  employeeBand: string | null,
  naicsCodes: Array<{ code: string; description: string }>
): { 
  adjustedRevenueBand: string | null; 
  wasAdjusted: boolean; 
  reasoning: string;
} {
  if (!revenueBand || !employeeBand) {
    return { adjustedRevenueBand: revenueBand, wasAdjusted: false, reasoning: '' };
  }

  // Parse employee lower bound from band
  const employeeMatch = employeeBand.match(/(\d+)/);
  if (!employeeMatch) {
    return { adjustedRevenueBand: revenueBand, wasAdjusted: false, reasoning: '' };
  }
  const employeeLower = parseInt(employeeMatch[1]);

  // Parse revenue upper bound from band
  const revenueBands: Record<string, number> = {
    '0-500K': 500_000,
    '500K-1M': 1_000_000,
    '1M-5M': 5_000_000,
    '5M-10M': 10_000_000,
    '10M-25M': 25_000_000,
    '25M-75M': 75_000_000,
    '75M-200M': 200_000_000,
    '200M-500M': 500_000_000,
    '500M-1B': 1_000_000_000,
    '1B-10B': 10_000_000_000,
    '10B-100B': 100_000_000_000,
    '100B-1T': 1_000_000_000_000,
  };

  const revenueUpper = revenueBands[revenueBand];
  if (!revenueUpper) {
    return { adjustedRevenueBand: revenueBand, wasAdjusted: false, reasoning: '' };
  }

  // Get minimum revenue per employee for this industry
  const naics2 = (naicsCodes?.[0]?.code || '').slice(0, 2);
  const minRpe = MIN_REVENUE_PER_EMPLOYEE[naics2] || MIN_REVENUE_PER_EMPLOYEE['default'];

  // Calculate minimum expected revenue
  const minExpectedRevenue = employeeLower * minRpe;

  // If reported revenue upper bound is less than minimum expected, it's likely wrong
  if (revenueUpper < minExpectedRevenue * 0.5) {
    // Find the appropriate band for the minimum expected revenue
    const adjustedBand = mapUsdToRevenueBand(minExpectedRevenue);
    if (adjustedBand && adjustedBand !== revenueBand) {
      return {
        adjustedRevenueBand: adjustedBand,
        wasAdjusted: true,
        reasoning: `Revenue band ${revenueBand} seems too low for ${employeeBand}. Adjusted to ${adjustedBand} based on minimum ${minRpe.toLocaleString()}/employee for this industry.`,
      };
    }
  }

  return { adjustedRevenueBand: revenueBand, wasAdjusted: false, reasoning: '' };
}

export function estimateFromIndustryAverages(
  naicsCodes: Array<{ code: string; description: string }>
): { 
  sizeBand: string | null; 
  revenueBand: string | null; 
  sizeReasoning: string;
  revenueReasoning: string;
} {
  const firstCode = naicsCodes?.[0]?.code || '';
  const naics2 = firstCode.slice(0, 2);
  const naicsDesc = naicsCodes?.[0]?.description || 'Unknown';
  
  const estimate = INDUSTRY_AVERAGES[naics2] || INDUSTRY_AVERAGES['default'];
  
  const baseReasoning = naics2 
    ? `Industry average estimate based on NAICS ${naics2}xx (${naicsDesc}) from US Census Bureau SUSB data`
    : `Default small business estimate (no industry data available)`;
  
  return {
    sizeBand: estimate.sizeBand,
    revenueBand: estimate.revenueBand,
    sizeReasoning: `${baseReasoning}. Average company in this industry has ~${estimate.avgEmployees} employees. THIS IS AN ESTIMATE - no actual employee data was found.`,
    revenueReasoning: `${baseReasoning}. Average company in this industry has ~$${(estimate.avgRevenue / 1_000_000).toFixed(1)}M revenue. THIS IS AN ESTIMATE - no actual revenue data was found.`,
  };
}
