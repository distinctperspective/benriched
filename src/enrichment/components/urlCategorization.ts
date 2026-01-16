/**
 * Categorize URLs by priority for smart scraping
 * Tier 1: Essential (company site, LinkedIn)
 * Tier 2: High value data aggregators (ZoomInfo, Crunchbase)
 * Tier 3: Low value (Wikipedia, Glassdoor, Indeed)
 */
export function categorizeUrls(urls: string[], domain: string): { tier1: string[]; tier2: string[]; tier3: string[] } {
  const tier1: string[] = [];
  const tier2: string[] = [];
  const tier3: string[] = [];
  
  for (const url of urls) {
    const urlLower = url.toLowerCase();
    
    // Tier 1: Company website and LinkedIn
    if (urlLower.includes(domain.replace('www.', '')) || urlLower.includes('linkedin.com/company')) {
      tier1.push(url);
    }
    // Tier 2: Data aggregators with revenue/employee data
    else if (urlLower.includes('zoominfo.com') || urlLower.includes('crunchbase.com') || 
             urlLower.includes('owler.com') || urlLower.includes('growjo.com') ||
             urlLower.includes('cbinsights.com')) {
      tier2.push(url);
    }
    // Tier 3: Everything else (Wikipedia, Glassdoor, Indeed, etc.)
    else {
      tier3.push(url);
    }
  }
  
  return { tier1, tier2, tier3 };
}

/**
 * Determine which URLs to scrape based on Pass 1 data availability
 */
export function selectUrlsToScrape(
  tier1: string[],
  tier2: string[],
  tier3: string[],
  hasRevenue: boolean,
  hasEmployees: boolean
): string[] {
  let urlsToScrape = [...tier1];
  
  if (hasRevenue && hasEmployees) {
    console.log(`   ⏭️  Skipping Tier 2 sources (Pass 1 has revenue + employees)`);
  } else if (hasRevenue || hasEmployees) {
    // Have partial data - add 2 data aggregators
    const tier2Limited = tier2.slice(0, 2);
    urlsToScrape.push(...tier2Limited);
    console.log(`   ➕ Adding ${tier2Limited.length} Tier 2 sources (partial data)`);
  } else {
    // Missing both - add up to 4 data aggregators for better coverage
    const tier2Limited = tier2.slice(0, 4);
    urlsToScrape.push(...tier2Limited);
    console.log(`   ➕ Adding ${tier2Limited.length} Tier 2 sources (missing both revenue + employees)`);
  }
  
  // Skip Tier 3 entirely - low value
  console.log(`   ⏭️  Skipping ${tier3.length} Tier 3 sources (low value)`);
  
  return urlsToScrape;
}
