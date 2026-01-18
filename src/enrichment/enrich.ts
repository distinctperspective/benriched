import { EnrichmentResult, EnrichmentResultWithCost, Pass1Result, NAICSCode, TargetICPMatch, RevenueEvidence, AIUsage, CostBreakdown, PerformanceMetrics, DiagnosticInfo } from '../types.js';
import { scrapeUrl, scrapeMultipleUrls, scrapeMultipleUrlsWithCost, calculateFirecrawlCost } from '../scraper.js';
import { pickRevenueBandFromEvidence, estimateRevenueBandFromEmployeesAndNaics, estimateFromIndustryAverages, validateRevenueVsEmployees, estimateEmployeeBandFromRevenue } from '../utils/revenue.js';
import { parseRevenueAmountToUsd, parseEmployeeBandLowerBound, countryNameToCode } from '../utils/parsing.js';
import { detectOutliers, shouldTriggerDeepResearch, runDeepResearch, DeepResearchResult } from './deepResearch.js';
import { getCompanyByDomain } from '../lib/supabase.js';

// Import from components
import { calculateAICost } from './components/pricing.js';
import { mapEmployeeCountToBand } from './components/employees.js';
import { validateLinkedInPage } from './components/linkedin.js';
import { detectEntityMismatch } from './components/entityDetection.js';
import { categorizeUrls } from './components/urlCategorization.js';
import { pass1_identifyUrlsWithUsage, pass1_identifyUrlsStrict, type Pass1WithUsage } from './components/pass1.js';
import { pass2_analyzeContentWithUsage, type Pass2WithUsage } from './components/pass2.js';
import { VALID_REVENUE_BANDS, PASSING_REVENUE_BANDS, TARGET_REGIONS } from './components/icp.js';

// Re-export for external use
export { calculateAICost };
export { pass1_identifyUrlsWithUsage as pass1_identifyUrls } from './components/pass1.js';
export { pass2_analyzeContentWithUsage as pass2_analyzeContent } from './components/pass2.js';

// ============================================================================
// PARENT COMPANY DOMAIN GUESSING
// ============================================================================

const KNOWN_PARENT_DOMAINS: Record<string, string> = {
  'general mills': 'generalmills.com',
  'lactalis': 'lactalis.com',
  'lactalis usa': 'lactalisusa.com',
  'nestle': 'nestle.com',
  'kraft heinz': 'kraftheinzcompany.com',
  'pepsico': 'pepsico.com',
  'coca-cola': 'coca-colacompany.com',
  'the coca-cola company': 'coca-colacompany.com',
  'unilever': 'unilever.com',
  'mondelez': 'mondelezinternational.com',
  'tyson foods': 'tyson.com',
  'jbs': 'jbs.com.br',
  'cargill': 'cargill.com',
  'archer daniels midland': 'adm.com',
  'adm': 'adm.com',
  'conagra': 'conagrabrands.com',
  'conagra brands': 'conagrabrands.com',
  'hormel': 'hormelfoods.com',
  'hormel foods': 'hormelfoods.com',
  'smithfield': 'smithfieldfoods.com',
  'smithfield foods': 'smithfieldfoods.com',
  'premium brands': 'premiumbrandsholdings.com',
  'premium brands holdings': 'premiumbrandsholdings.com',
  'premium brands holdings corporation': 'premiumbrandsholdings.com',
  'maple leaf foods': 'mapleleaffoods.com',
  'saputo': 'saputo.com',
  'danone': 'danone.com',
  'kellogg': 'kelloggcompany.com',
  "kellogg's": 'kelloggcompany.com',
  'post holdings': 'postholdings.com',
  'treehouse foods': 'treehousefoods.com',
  'b&g foods': 'bgfoods.com',
  'campbell soup': 'campbellsoupcompany.com',
  'campbell soup company': 'campbellsoupcompany.com',
  'the campbells company': 'campbellsoupcompany.com',
  "campbell's": 'campbellsoupcompany.com',
  'smucker': 'jmsmucker.com',
  'j.m. smucker': 'jmsmucker.com',
  'the j.m. smucker company': 'jmsmucker.com',
  'hershey': 'thehersheycompany.com',
  'the hershey company': 'thehersheycompany.com',
  'mars': 'mars.com',
  'ferrero': 'ferrero.com',
  'lindt': 'lindt-spruengli.com',
  'blue diamond growers': 'bluediamond.com',
  'ocean spray': 'oceanspray.com',
  'land o lakes': 'landolakesinc.com',
  "land o'lakes": 'landolakesinc.com',
  'dairy farmers of america': 'dfamilk.com',
  'dean foods': 'deanfoods.com',
  'schreiber foods': 'schreiberfoods.com',
  'leprino foods': 'leprinofoods.com',
  'tillamook': 'tillamook.com',
  'celerian group': 'celeriangroup.com',
};

function guessParentDomain(parentName: string): string | null {
  if (!parentName) return null;
  
  const normalized = parentName.toLowerCase().trim();
  
  // Check known mappings first
  if (KNOWN_PARENT_DOMAINS[normalized]) {
    return KNOWN_PARENT_DOMAINS[normalized];
  }
  
  // Try partial matches
  for (const [key, domain] of Object.entries(KNOWN_PARENT_DOMAINS)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return domain;
    }
  }
  
  // Generate a guess from the company name
  // Remove common suffixes and create a domain
  const cleaned = normalized
    .replace(/\s*(inc\.?|llc|ltd\.?|corp\.?|corporation|company|co\.?|holdings?|group|enterprises?)\s*$/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '');
  
  if (cleaned.length >= 3) {
    return `${cleaned}.com`;
  }
  
  return null;
}

// ============================================================================
// MAIN ENRICHMENT FUNCTION - WITH COST TRACKING
// ============================================================================

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
  forceDeepResearch: boolean = false
): Promise<EnrichmentResultWithCost> {
  const startTime = Date.now();
  console.log(`\n🚀 Starting enrichment for domain: ${domain}`);
  
  // Track costs
  let totalFirecrawlCredits = 0;
  
  // Track performance
  let pass1StartTime = Date.now();
  
  // PASS 1: Identify URLs to crawl
  let { result: pass1Result, usage: pass1Usage, rawResponse: pass1RawResponse } = await pass1_identifyUrlsWithUsage(domain, searchModel, searchModelId);
  const pass1Ms = Date.now() - pass1StartTime;
  console.log(`   📝 Company: ${pass1Result.company_name}`);
  
  // Check what data Pass 1 already found (from Perplexity web search)
  const hasRevenue = Array.isArray(pass1Result.revenue_found) && pass1Result.revenue_found.length > 0;
  // Check for valid employee count (not "Not found", "unknown", etc.)
  const employeeAmount = pass1Result.employee_count_found?.amount?.toLowerCase() || '';
  const hasEmployees = !!pass1Result.employee_count_found?.amount && 
    !employeeAmount.includes('not found') && 
    !employeeAmount.includes('unknown') &&
    /\d/.test(employeeAmount); // Must contain at least one digit
  console.log(`   📊 Pass 1 data: revenue=${hasRevenue ? 'YES' : 'NO'}, employees=${hasEmployees ? 'YES' : 'NO'}`);
  
  // DEEP RESEARCH: Check for outliers and run focused queries if needed
  let deepResearchResult: DeepResearchResult | null = null;
  const outlierFlags = detectOutliers(pass1Result);
  
  if (forceDeepResearch || shouldTriggerDeepResearch(outlierFlags)) {
    if (forceDeepResearch) {
      console.log(`\n🔬 Deep Research FORCED by request parameter`);
    }
    deepResearchResult = await runDeepResearch(
      domain,
      pass1Result.company_name,
      searchModel,
      searchModelId,
      outlierFlags
    );
    
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
  
  // SMART SCRAPING: Categorize URLs by priority
  const { tier1, tier2, tier3 } = categorizeUrls(pass1Result.urls_to_crawl, domain);
  console.log(`   🔗 URLs by tier: T1=${tier1.length} (essential), T2=${tier2.length} (data), T3=${tier3.length} (other)`);
  
  // Always scrape Tier 1 (company site + LinkedIn)
  let urlsToScrape = [...tier1];
  
  // Conditionally add Tier 2 based on what Pass 1 found
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
  
  // Skip Tier 3 entirely - low value (Wikipedia, Glassdoor, Indeed)
  console.log(`   ⏭️  Skipping ${tier3.length} Tier 3 sources (low value)`);
  
  // SCRAPE: Use Firecrawl to scrape prioritized URLs
  const scrapeStartTime = Date.now();
  console.log(`\n🔥 Scraping ${urlsToScrape.length} URLs with Firecrawl...`);
  let scrapeResult = await scrapeMultipleUrlsWithCost(urlsToScrape, firecrawlApiKey);
  let scrapedContent = scrapeResult.content;
  totalFirecrawlCredits += scrapeResult.totalCreditsUsed;
  let scrapingMs = Date.now() - scrapeStartTime;
  let scrapeCount = scrapeResult.scrapeCount;
  console.log(`   ✅ Successfully scraped ${scrapedContent.size} pages (${scrapeResult.totalCreditsUsed} credits) in ${scrapingMs}ms`);

  const entityCheck = detectEntityMismatch(pass1Result.company_name, domain, scrapedContent);
  if (entityCheck.mismatch) {
    console.log(`\n⚠️  Potential entity mismatch detected (${entityCheck.signal}). Re-running Pass 1 in strict mode...`);
    // Preserve original revenue/employee data before strict mode overwrites
    const originalRevenueFound = pass1Result.revenue_found;
    const originalEmployeeFound = pass1Result.employee_count_found;
    const originalHeadquarters = pass1Result.headquarters;
    
    const strictResult = await pass1_identifyUrlsStrict(domain, searchModel, pass1Result.company_name);
    console.log(`   📝 Company (strict): ${strictResult.company_name}`);
    console.log(`   🔗 URLs (strict): ${strictResult.urls_to_crawl.join(', ')}`);
    
    // Merge: combine revenue evidence from both passes (original often has better data)
    // Concatenate both arrays so pickRevenueBandFromEvidence can choose the best
    const combinedRevenue = [
      ...(originalRevenueFound || []),
      ...(strictResult.revenue_found || [])
    ].filter(r => r && r.amount);
    
    // Prefer strict headquarters only if it has actual city data, otherwise keep original
    const strictHasHQ = strictResult.headquarters?.city && strictResult.headquarters.city !== 'unknown';
    
    pass1Result = {
      ...strictResult,
      revenue_found: combinedRevenue.length > 0 ? combinedRevenue : originalRevenueFound,
      employee_count_found: strictResult.employee_count_found || originalEmployeeFound,
      headquarters: strictHasHQ ? strictResult.headquarters : originalHeadquarters,
    };
    
    console.log(`\n🔥 Re-scraping ${pass1Result.urls_to_crawl.length} URLs with Firecrawl...`);
    scrapedContent = await scrapeMultipleUrls(pass1Result.urls_to_crawl, firecrawlApiKey);
    console.log(`   ✅ Successfully scraped ${scrapedContent.size} pages`);
  }
  
  // Extract LinkedIn from scraped content - prioritize company website
  let linkedinFromScrape: string | null = null;
  let linkedinSource: 'website' | 'pass1' | null = null;
  let linkedinEmployeeCount: string | null = null;
  const linkedinRegex = /https?:\/\/(?:www\.)?linkedin\.com\/company\/([a-zA-Z0-9_\-'%]+)\/?/gi;
  
  // First, try to find LinkedIn on the company's own website (MOST RELIABLE - this is authoritative)
  for (const [url, content] of scrapedContent) {
    if (url.includes(domain) || url.includes(domain.replace('www.', ''))) {
      const matches = [...content.matchAll(linkedinRegex)];
      if (matches.length > 0) {
        const validMatches = matches.filter(m => {
          const slug = m[1].toLowerCase();
          return !['crunchbase', 'zoominfo', 'linkedin', 'glassdoor', 'indeed'].includes(slug);
        });
        if (validMatches.length > 0) {
          linkedinFromScrape = validMatches[0][0].replace(/\/$/, '');
          linkedinSource = 'website';
          console.log(`   🔗 Found LinkedIn on company website (authoritative): ${linkedinFromScrape}`);
          break;
        }
      }
    }
  }
  
  // If no company website was scraped, try to scrape it directly
  if (!linkedinFromScrape && scrapedContent.size === 0) {
    console.log(`   ⚠️  No pages scraped, trying to scrape company website directly...`);
    const companyWebsiteContent = await scrapeUrl(`https://${domain}`, firecrawlApiKey);
    if (companyWebsiteContent) {
      scrapedContent.set(`https://${domain}`, companyWebsiteContent);
      const matches = [...companyWebsiteContent.matchAll(linkedinRegex)];
      if (matches.length > 0) {
        const validMatches = matches.filter(m => {
          const slug = m[1].toLowerCase();
          return !['crunchbase', 'zoominfo', 'linkedin', 'glassdoor', 'indeed'].includes(slug);
        });
        if (validMatches.length > 0) {
          linkedinFromScrape = validMatches[0][0].replace(/\/$/, '');
          linkedinSource = 'website';
          console.log(`   🔗 Found LinkedIn on company website (authoritative): ${linkedinFromScrape}`);
        }
      }
    }
  }
  
  // If not found on company site, check Pass 1 results (Perplexity found it - less reliable)
  if (!linkedinFromScrape && pass1Result.urls_to_crawl) {
    const linkedinUrl = pass1Result.urls_to_crawl.find(u => 
      u.includes('linkedin.com/company/') && 
      !u.includes('/crunchbase') && 
      !u.includes('/zoominfo')
    );
    if (linkedinUrl) {
      linkedinFromScrape = linkedinUrl.replace(/\/$/, '');
      linkedinSource = 'pass1';
      console.log(`   🔗 Using LinkedIn from Pass 1 (needs validation): ${linkedinFromScrape}`);
    }
  }
  
  // VALIDATE LinkedIn URL - only validate if from Pass 1 (website links are authoritative)
  if (linkedinFromScrape && linkedinSource === 'pass1') {
    console.log(`\n🔍 Validating LinkedIn page (from Pass 1, needs verification)...`);
    const expectedEmployees = pass1Result.employee_count_found?.amount || null;
    const expectedLocation = pass1Result.headquarters?.city || null;
    
    const validation = await validateLinkedInPage(
      linkedinFromScrape,
      domain,
      expectedEmployees,
      expectedLocation,
      scrapedContent,
      firecrawlApiKey
    );
    
    if (!validation.isValid) {
      console.log(`   ⚠️  LinkedIn validation FAILED: ${validation.reason}`);
      if (validation.linkedinWebsite) {
        console.log(`      LinkedIn website: ${validation.linkedinWebsite}`);
      }
      if (validation.linkedinEmployees) {
        console.log(`      LinkedIn employees: ${validation.linkedinEmployees}`);
      }
      console.log(`   ❌ Rejecting LinkedIn URL - likely wrong company`);
      linkedinFromScrape = null;
    } else {
      console.log(`   ✅ LinkedIn validation passed`);
      // Store employee count from LinkedIn for company_size
      if (validation.linkedinEmployees) {
        linkedinEmployeeCount = validation.linkedinEmployees;
        console.log(`   👥 LinkedIn employees: ${linkedinEmployeeCount}`);
      }
    }
  } else if (linkedinFromScrape && linkedinSource === 'website') {
    console.log(`\n✅ LinkedIn from company website - no validation needed (authoritative source)`);
  }
  
  // Always search for employee count in scraped content if we don't have it yet
  if (!linkedinEmployeeCount) {
    console.log(`\n🔍 Looking for employee count in scraped content...`);
    for (const [url, content] of scrapedContent) {
      // Look for employee patterns in data aggregator pages
      const employeeMatch = content.match(/(\d+[-–]\d+|\d+,?\d*\+?)\s*employees/i);
      if (employeeMatch) {
        linkedinEmployeeCount = employeeMatch[1];
        console.log(`   👥 Found employees in ${url}: ${linkedinEmployeeCount}`);
        break;
      }
    }
    if (!linkedinEmployeeCount) {
      console.log(`   ⚠️  No employee count found in scraped content`);
    }
  }
  
  const pass2StartTime = Date.now();
  const { result: pass2Result, usage: pass2Usage, rawResponse: pass2RawResponse } = await pass2_analyzeContentWithUsage(domain, pass1Result.company_name, scrapedContent, analysisModel, pass1Result, analysisModelId);
  const pass2Ms = Date.now() - pass2StartTime;
  let result = pass2Result;
  
  // Add deep research info to diagnostics
  const deepResearchTriggered = forceDeepResearch || shouldTriggerDeepResearch(outlierFlags);
  if (result.diagnostics) {
    result.diagnostics.deep_research = {
      triggered: deepResearchTriggered,
      forced: forceDeepResearch,
      reasons: deepResearchResult?.triggered_by || [],
      revenue_found: deepResearchResult?.revenue?.amount || null,
      employees_found: deepResearchResult?.employees?.count || null,
      location_found: deepResearchResult?.location ? `${deepResearchResult.location.city}, ${deepResearchResult.location.country}` : null
    };
  }
  
  // ALWAYS use our scraped/Pass 1 LinkedIn URL if we found one (more reliable than Pass 2)
  if (linkedinFromScrape) {
    let linkedinUrl = linkedinFromScrape;
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
  if ((result.company_size === 'unknown' || !result.company_size) && linkedinEmployeeCount) {
    const employeeBand = mapEmployeeCountToBand(linkedinEmployeeCount);
    if (employeeBand) {
      result.company_size = employeeBand;
      result.quality.size = {
        confidence: 'high',
        reasoning: `Employee count ${linkedinEmployeeCount} from LinkedIn company page`
      };
      console.log(`   📊 Set company_size from LinkedIn: ${employeeBand}`);
    }
  }

  // Revenue logic: Prefer Pass 1 evidence over Pass 2 when we have actual data
  const pass1Evidence = Array.isArray(pass1Result.revenue_found) ? pass1Result.revenue_found : [];
  const hasPass1Revenue = pass1Evidence.length > 0 && pass1Evidence.some(e => e.amount && e.amount !== 'null');
  
  if (hasPass1Revenue) {
    // Use Pass 1 evidence - it has actual revenue figures from web search
    const picked = pickRevenueBandFromEvidence(pass1Evidence);
    if (picked.band) {
      result.company_revenue = picked.band;
      result.quality.revenue.confidence = picked.confidence;
      result.quality.revenue.reasoning = picked.reasoning;
      console.log(`   💰 Using Pass 1 revenue evidence: ${picked.band}`);
    }
  } else if (!result.company_revenue) {
    // No Pass 1 evidence and no Pass 2 revenue - try employee-based estimate
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
  
  // BETTER FALLBACK: If we have revenue but no employees, estimate employees from revenue
  // This is more accurate than industry averages when we have actual revenue data
  if (needsSizeEstimate && !needsRevenueEstimate && result.company_revenue) {
    // Get revenue in USD from the first evidence
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
      
      // Record adjustment in diagnostics
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
  const passingRevenueBandsForFinal = new Set(['10M-25M', '25M-75M', '75M-200M', '200M-500M', '500M-1B', '1B-10B', '10B-100B', '100B-1T']);
  result.revenue_pass = result.company_revenue ? passingRevenueBandsForFinal.has(result.company_revenue) : false;
  
  // Recalculate target_icp with final revenue
  // Target regions: US, Mexico, Canada, Puerto Rico, or companies with US operations
  let hasPassingRevenueFinal = result.company_revenue ? passingRevenueBandsForFinal.has(result.company_revenue) : false;
  const targetRegionsFinal = new Set(['US', 'MX', 'CA', 'PR']);
  const isTargetRegionFinal = targetRegionsFinal.has(result.hq_country) || result.is_us_hq || result.is_us_subsidiary;
  result.target_icp = (result.target_icp_matches?.length > 0) && isTargetRegionFinal && hasPassingRevenueFinal;

  // ============================================================================
  // PARENT COMPANY ENRICHMENT - Inherit data from parent when child has no data
  // ============================================================================
  const parentCompanyName = pass1Result.parent_company;
  const childHasWeakData = !result.company_revenue || !hasPassingRevenueFinal || 
    result.company_size === 'unknown' || result.company_size === '0-1 Employees' || 
    result.company_size === '2-10 Employees' || result.company_size === '11-50 Employees';
  
  if (parentCompanyName && childHasWeakData) {
    console.log(`\n🏢 Parent company detected: ${parentCompanyName}`);
    console.log(`   Child has weak data - attempting to enrich parent...`);
    
    // Try to find parent domain from common patterns
    const parentDomain = guessParentDomain(parentCompanyName);
    
    if (parentDomain) {
      // Check if parent already exists in DB
      const { data: existingParent } = await getCompanyByDomain(parentDomain);
      
      if (existingParent && existingParent.company_revenue) {
        console.log(`   ✅ Found parent in DB: ${existingParent.company_name} (${existingParent.company_revenue})`);
        
        // Inherit revenue if child doesn't have good data
        if (!result.company_revenue || !hasPassingRevenueFinal) {
          result.company_revenue = existingParent.company_revenue;
          result.inherited_revenue = true;
          result.quality.revenue = {
            confidence: 'medium',
            reasoning: `Inherited from parent company: ${existingParent.company_name}`
          };
          console.log(`   💰 Inherited revenue: ${existingParent.company_revenue}`);
        }
        
        // Inherit size if child has small/unknown size (brands typically don't have separate employee counts)
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
        hasPassingRevenueFinal = result.company_revenue ? passingRevenueBandsForFinal.has(result.company_revenue) : false;
        result.revenue_pass = hasPassingRevenueFinal;
        result.target_icp = (result.target_icp_matches?.length > 0) && isTargetRegionFinal && hasPassingRevenueFinal;
        
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

  // Build cost breakdown
  const firecrawlCost = calculateFirecrawlCost(totalFirecrawlCredits);
  const deepResearchCost = deepResearchResult?.usage?.costUsd || 0;
  const aiTotalCost = pass1Usage.costUsd + pass2Usage.costUsd + deepResearchCost;
  const totalCost = aiTotalCost + firecrawlCost;
  
  const cost: CostBreakdown = {
    ai: {
      pass1: pass1Usage,
      pass2: pass2Usage,
      deepResearch: deepResearchResult?.usage || undefined,
      total: {
        inputTokens: pass1Usage.inputTokens + pass2Usage.inputTokens + (deepResearchResult?.usage?.inputTokens || 0),
        outputTokens: pass1Usage.outputTokens + pass2Usage.outputTokens + (deepResearchResult?.usage?.outputTokens || 0),
        totalTokens: pass1Usage.totalTokens + pass2Usage.totalTokens + (deepResearchResult?.usage?.totalTokens || 0),
        costUsd: aiTotalCost
      }
    },
    firecrawl: {
      scrapeCount: scrapeResult.scrapeCount,
      creditsUsed: totalFirecrawlCredits,
      costUsd: firecrawlCost
    },
    total: {
      costUsd: totalCost
    }
  };

  // Build performance metrics
  const totalMs = Date.now() - startTime;
  const performance: PerformanceMetrics = {
    pass1_ms: pass1Ms,
    scraping_ms: scrapingMs,
    pass2_ms: pass2Ms,
    total_ms: totalMs,
    scrape_count: scrapeCount,
    avg_scrape_ms: scrapeCount > 0 ? Math.round(scrapingMs / scrapeCount) : 0
  };

  console.log(`\n✨ Enrichment complete for ${result.company_name}`);
  console.log(`\n💰 Cost breakdown:`);
  console.log(`   AI Pass 1 (${pass1Usage.model}): ${pass1Usage.totalTokens} tokens = $${pass1Usage.costUsd.toFixed(4)}`);
  if (deepResearchResult?.usage) {
    console.log(`   AI Deep Research: ${deepResearchResult.usage.totalTokens} tokens = $${deepResearchCost.toFixed(4)} (triggered by: ${deepResearchResult.triggered_by.join(', ')})`);
  }
  console.log(`   AI Pass 2 (${pass2Usage.model}): ${pass2Usage.totalTokens} tokens = $${pass2Usage.costUsd.toFixed(4)}`);
  console.log(`   Firecrawl: ${totalFirecrawlCredits} credits = $${firecrawlCost.toFixed(4)}`);
  console.log(`   TOTAL: $${totalCost.toFixed(4)}`);
  console.log(`\n⏱️  Performance:`);
  console.log(`   Pass 1: ${pass1Ms}ms`);
  console.log(`   Scraping: ${scrapingMs}ms (${scrapeCount} pages, avg ${performance.avg_scrape_ms}ms/page)`);
  console.log(`   Pass 2: ${pass2Ms}ms`);
  console.log(`   TOTAL: ${totalMs}ms`);
  
  // Build raw API responses object
  const raw_api_responses = {
    pass1: pass1RawResponse,
    pass2: pass2RawResponse,
    deepResearch: deepResearchResult?.rawResponse
  };

  return { ...result, cost, performance, raw_api_responses };
}
