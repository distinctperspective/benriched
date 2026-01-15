import { generateText } from 'ai';
import { AIUsage } from '../types.js';
import { calculateAICost } from './enrich.js';

export interface DeepResearchResult {
  revenue: {
    amount: string | null;
    source: string | null;
    year: string | null;
    confidence: 'high' | 'medium' | 'low';
  } | null;
  employees: {
    count: number | null;
    source: string | null;
    confidence: 'high' | 'medium' | 'low';
  } | null;
  location: {
    city: string | null;
    state: string | null;
    country: string | null;
    is_us_hq: boolean;
    is_us_subsidiary: boolean;
  } | null;
  triggered_by: string[];
  usage: AIUsage;
}

export interface OutlierFlags {
  revenueSizeMismatch: boolean;
  missingRevenue: boolean;
  missingEmployees: boolean;
  missingLocation: boolean;
  sourceConflict: boolean;
  isPublicCompany: boolean;
}

/**
 * Detect if deep research should be triggered based on Pass 1 results
 */
export function detectOutliers(pass1Data: any): OutlierFlags {
  const flags: OutlierFlags = {
    revenueSizeMismatch: false,
    missingRevenue: false,
    missingEmployees: false,
    missingLocation: false,
    sourceConflict: false,
    isPublicCompany: false,
  };

  // Check for missing revenue
  const revenueFound = pass1Data?.revenue_found;
  if (!revenueFound || !Array.isArray(revenueFound) || revenueFound.length === 0) {
    flags.missingRevenue = true;
  } else {
    // Check for source conflicts (>5x difference)
    const amounts = revenueFound
      .map((r: any) => parseRevenueToNumber(r.amount))
      .filter((n: number) => n > 0);
    if (amounts.length >= 2) {
      const min = Math.min(...amounts);
      const max = Math.max(...amounts);
      if (min > 0 && max / min > 5) {
        flags.sourceConflict = true;
      }
    }
  }

  // Check for missing employees
  const employeeFound = pass1Data?.employee_count_found;
  const hasEmployeeData = Array.isArray(employeeFound) 
    ? employeeFound.some((e: any) => e.amount && e.amount !== 'unknown' && e.amount !== 'null')
    : (employeeFound?.amount && employeeFound.amount !== 'unknown' && employeeFound.amount !== 'null');
  if (!hasEmployeeData) {
    flags.missingEmployees = true;
  }

  // Check for missing location
  const hq = pass1Data?.headquarters;
  if (!hq || !hq.country || hq.country === 'unknown') {
    flags.missingLocation = true;
  }

  // Check for revenue/size mismatch
  if (revenueFound && Array.isArray(revenueFound) && revenueFound.length > 0) {
    const maxRevenue = Math.max(...revenueFound.map((r: any) => parseRevenueToNumber(r.amount)).filter((n: number) => n > 0));
    const employeeCount = getMaxEmployeeCount(employeeFound);
    
    // If revenue > $100M but employees < 50, that's suspicious
    if (maxRevenue > 100_000_000 && employeeCount > 0 && employeeCount < 50) {
      flags.revenueSizeMismatch = true;
    }
    // If revenue > $1B but employees < 500, that's suspicious
    if (maxRevenue > 1_000_000_000 && employeeCount > 0 && employeeCount < 500) {
      flags.revenueSizeMismatch = true;
    }
  }

  return flags;
}

/**
 * Check if deep research should be triggered
 */
export function shouldTriggerDeepResearch(flags: OutlierFlags): boolean {
  return (
    flags.revenueSizeMismatch ||
    flags.missingRevenue ||
    flags.missingEmployees ||
    flags.sourceConflict
  );
}

/**
 * Get the reasons why deep research was triggered
 */
export function getTriggeredReasons(flags: OutlierFlags): string[] {
  const reasons: string[] = [];
  if (flags.revenueSizeMismatch) reasons.push('revenue_size_mismatch');
  if (flags.missingRevenue) reasons.push('missing_revenue');
  if (flags.missingEmployees) reasons.push('missing_employees');
  if (flags.missingLocation) reasons.push('missing_location');
  if (flags.sourceConflict) reasons.push('source_conflict');
  if (flags.isPublicCompany) reasons.push('public_company');
  return reasons;
}

/**
 * Run deep research queries in parallel
 */
export async function runDeepResearch(
  domain: string,
  companyName: string,
  model: any,
  modelId: string,
  flags: OutlierFlags
): Promise<DeepResearchResult> {
  console.log(`\n🔬 Deep Research triggered for ${domain}`);
  console.log(`   Reasons: ${getTriggeredReasons(flags).join(', ')}`);

  const queries: Promise<any>[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Revenue query (if missing or conflicting)
  if (flags.missingRevenue || flags.sourceConflict || flags.revenueSizeMismatch) {
    queries.push(queryRevenue(domain, companyName, model));
  }

  // Employee query (if missing or mismatch)
  if (flags.missingEmployees || flags.revenueSizeMismatch) {
    queries.push(queryEmployees(domain, companyName, model));
  }

  // Location query (if missing)
  if (flags.missingLocation) {
    queries.push(queryLocation(domain, companyName, model));
  }

  const results = await Promise.all(queries);

  let revenueResult = null;
  let employeeResult = null;
  let locationResult = null;

  for (const result of results) {
    totalInputTokens += result.usage?.inputTokens || 0;
    totalOutputTokens += result.usage?.outputTokens || 0;

    if (result.type === 'revenue') {
      revenueResult = result.data;
    } else if (result.type === 'employees') {
      employeeResult = result.data;
    } else if (result.type === 'location') {
      locationResult = result.data;
    }
  }

  const costUsd = calculateAICost(modelId, totalInputTokens, totalOutputTokens);

  console.log(`   ✅ Deep research complete. Cost: $${costUsd.toFixed(4)}`);

  return {
    revenue: revenueResult,
    employees: employeeResult,
    location: locationResult,
    triggered_by: getTriggeredReasons(flags),
    usage: {
      model: modelId,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      costUsd,
    },
  };
}

async function queryRevenue(domain: string, companyName: string, model: any) {
  const prompt = `What is the annual revenue for ${companyName} (${domain})?

IMPORTANT: Find the SPECIFIC company's revenue, not a parent company's.
If this is a subsidiary, find THAT subsidiary's revenue.

Check these sources:
- SEC 10-K filings (for public companies)
- Company press releases
- Forbes, Bloomberg, Reuters
- Industry reports

Return ONLY valid JSON:
{
  "revenue": "$X million/billion",
  "source": "SEC 10-K 2024",
  "year": "2024",
  "confidence": "high"
}

If no reliable data found, return: {"revenue": null, "source": null, "year": null, "confidence": "low"}`;

  try {
    const { text, usage } = await generateText({
      model,
      prompt,
      temperature: 0.1,
    });

    const cleanText = text.trim().replace(/^```json?\n?/i, '').replace(/\n?```$/i, '');
    const parsed = JSON.parse(cleanText);

    console.log(`   💰 Revenue query: ${parsed.revenue || 'not found'}`);

    return {
      type: 'revenue',
      data: {
        amount: parsed.revenue,
        source: parsed.source,
        year: parsed.year,
        confidence: parsed.confidence || 'low',
      },
      usage,
    };
  } catch (error) {
    console.log(`   ⚠️ Revenue query failed`);
    return {
      type: 'revenue',
      data: null,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

async function queryEmployees(domain: string, companyName: string, model: any) {
  const prompt = `How many employees does ${companyName} (${domain}) have?

IMPORTANT: Find the SPECIFIC company's employee count, not a parent company's.

Check these sources:
- LinkedIn company page
- Company website (About/Careers page)
- SEC filings (for public companies)
- Glassdoor

Return ONLY valid JSON:
{
  "employees": 1500,
  "source": "LinkedIn",
  "confidence": "high"
}

If no reliable data found, return: {"employees": null, "source": null, "confidence": "low"}`;

  try {
    const { text, usage } = await generateText({
      model,
      prompt,
      temperature: 0.1,
    });

    const cleanText = text.trim().replace(/^```json?\n?/i, '').replace(/\n?```$/i, '');
    const parsed = JSON.parse(cleanText);

    // Parse employee count to number
    let count = parsed.employees;
    if (typeof count === 'string') {
      count = parseInt(count.replace(/,/g, ''), 10);
    }

    console.log(`   👥 Employee query: ${count || 'not found'}`);

    return {
      type: 'employees',
      data: {
        count: Number.isFinite(count) ? count : null,
        source: parsed.source,
        confidence: parsed.confidence || 'low',
      },
      usage,
    };
  } catch (error) {
    console.log(`   ⚠️ Employee query failed`);
    return {
      type: 'employees',
      data: null,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

async function queryLocation(domain: string, companyName: string, model: any) {
  const prompt = `Where is ${companyName} (${domain}) headquartered?

Is this a US company? Does it have US operations or a US subsidiary?

Return ONLY valid JSON:
{
  "city": "City Name",
  "state": "State/Province",
  "country": "Country Name",
  "country_code": "US",
  "is_us_hq": true,
  "is_us_subsidiary": false
}`;

  try {
    const { text, usage } = await generateText({
      model,
      prompt,
      temperature: 0.1,
    });

    const cleanText = text.trim().replace(/^```json?\n?/i, '').replace(/\n?```$/i, '');
    const parsed = JSON.parse(cleanText);

    console.log(`   📍 Location query: ${parsed.city}, ${parsed.country_code || parsed.country}`);

    return {
      type: 'location',
      data: {
        city: parsed.city,
        state: parsed.state,
        country: parsed.country_code || parsed.country,
        is_us_hq: parsed.is_us_hq || false,
        is_us_subsidiary: parsed.is_us_subsidiary || false,
      },
      usage,
    };
  } catch (error) {
    console.log(`   ⚠️ Location query failed`);
    return {
      type: 'location',
      data: null,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

// Helper functions
function parseRevenueToNumber(amount: string | null): number {
  if (!amount) return 0;
  const str = String(amount).toLowerCase().replace(/[,$]/g, '');
  
  const match = str.match(/([\d.]+)\s*(billion|million|thousand|[bmkt])?/i);
  if (!match) return 0;
  
  let num = parseFloat(match[1]);
  const unit = match[2]?.toLowerCase();
  
  if (unit === 'billion' || unit === 'b') num *= 1_000_000_000;
  else if (unit === 'million' || unit === 'm') num *= 1_000_000;
  else if (unit === 'thousand' || unit === 'k' || unit === 't') num *= 1_000;
  
  return num;
}

function getMaxEmployeeCount(employeeData: any): number {
  if (!employeeData) return 0;
  
  const list = Array.isArray(employeeData) ? employeeData : [employeeData];
  let maxCount = 0;
  
  for (const emp of list) {
    if (!emp?.amount) continue;
    const str = String(emp.amount).toLowerCase().replace(/,/g, '');
    const match = str.match(/(\d+)/);
    if (match) {
      let count = parseInt(match[1], 10);
      if (str.includes('k') && count < 100) count *= 1000;
      maxCount = Math.max(maxCount, count);
    }
  }
  
  return maxCount;
}
