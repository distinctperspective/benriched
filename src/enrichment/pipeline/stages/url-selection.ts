import { EnrichmentContext } from '../context.js';
import { categorizeUrls } from '../../components/urlCategorization.js';

export async function runUrlSelection(ctx: EnrichmentContext): Promise<string[]> {
  const pass1Result = ctx.pass1Result!;

  await ctx.emitter?.emit({
    stage: 'url_selection',
    message: 'Selecting URLs to scrape...',
    status: 'started'
  });

  const { tier1, tier2, tier3 } = categorizeUrls(pass1Result.urls_to_crawl, ctx.domain);
  console.log(`   🔗 URLs by tier: T1=${tier1.length} (essential), T2=${tier2.length} (data), T3=${tier3.length} (other)`);

  // Check what data Pass 1 already found
  const hasRevenue = Array.isArray(pass1Result.revenue_found) && pass1Result.revenue_found.length > 0;
  const employeeAmount = pass1Result.employee_count_found?.amount?.toLowerCase() || '';
  const hasEmployees = !!pass1Result.employee_count_found?.amount &&
    !employeeAmount.includes('not found') &&
    !employeeAmount.includes('unknown') &&
    /\d/.test(employeeAmount);

  // Always scrape Tier 1 (company site + LinkedIn)
  let urlsToScrape = [...tier1];

  // Conditionally add Tier 2 based on what Pass 1 found
  if (hasRevenue && hasEmployees) {
    console.log(`   ⏭️  Skipping Tier 2 sources (Pass 1 has revenue + employees)`);
  } else if (hasRevenue || hasEmployees) {
    const tier2Limited = tier2.slice(0, 2);
    urlsToScrape.push(...tier2Limited);
    console.log(`   ➕ Adding ${tier2Limited.length} Tier 2 sources (partial data)`);
  } else {
    const tier2Limited = tier2.slice(0, 4);
    urlsToScrape.push(...tier2Limited);
    console.log(`   ➕ Adding ${tier2Limited.length} Tier 2 sources (missing both revenue + employees)`);
  }

  // Skip Tier 3 entirely
  console.log(`   ⏭️  Skipping ${tier3.length} Tier 3 sources (low value)`);

  await ctx.emitter?.emit({
    stage: 'url_selection',
    message: 'URLs selected',
    status: 'complete',
    data: { urls_to_scrape: urlsToScrape.length }
  });

  return urlsToScrape;
}
