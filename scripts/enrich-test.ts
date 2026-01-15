#!/usr/bin/env npx tsx

import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env.local from project root
config({ path: resolve(__dirname, '..', '.env.local') });

import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { gateway } from '@ai-sdk/gateway';

// ============================================================================
// FIRECRAWL SCRAPING
// ============================================================================

async function scrapeUrl(url: string): Promise<string | null> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  
  if (!apiKey) {
    return null;
  }
  
  try {
    const fullUrl = url.startsWith('http') ? url : `https://${url}`;
    
    const response = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        url: fullUrl,
        formats: ['markdown'],
        onlyMainContent: false
      }),
      signal: AbortSignal.timeout(30000)
    });
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    return data.success ? (data.data?.markdown || '') : null;
  } catch {
    return null;
  }
}

async function pass1_identifyUrlsStrict(domain: string, model: any, previousCompanyName: string): Promise<Pass1Result> {
  console.log(`\n📋 Pass 1 (strict): Re-validating company identity...`);

  const { text } = await generateText({
    model,
    system: PASS1_PROMPT,
    prompt: `Research the company at domain: ${domain}

IMPORTANT:
- A previous attempt identified the company as: ${previousCompanyName}
- You MUST confirm the company name from the actual website content of ${domain} (homepage/footer/about)
- If the website clearly indicates a different company name, use the website-indicated name

REQUIRED STEPS:
1. Use site:${domain} searches for "about", "contact", "copyright", and the company name shown on the site
2. Only then search revenue for the confirmed company name
3. Return the JSON with company info, URLs, and any revenue/employee data found.
`,
    temperature: 0.1,
  });

  try {
    const cleanText = text.trim().replace(/^```json?\n?/i, '').replace(/\n?```$/i, '');
    return JSON.parse(cleanText);
  } catch {
    return {
      company_name: domain.replace(/\.(com|io|co|org|net)$/, ''),
      urls_to_crawl: [`https://${domain}`, `https://${domain}/about`, `https://${domain}/contact`],
      search_queries: [`site:${domain} about`, `site:${domain} contact`, `${domain} company revenue employees`],
      revenue_found: [],
    };
  }
}

async function scrapeMultipleUrls(urls: string[]): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  
  // Scrape in parallel (max 3 concurrent)
  const chunks = [];
  for (let i = 0; i < urls.length; i += 3) {
    chunks.push(urls.slice(i, i + 3));
  }
  
  for (const chunk of chunks) {
    const promises = chunk.map(async (url) => {
      const content = await scrapeUrl(url);
      if (content) {
        results.set(url, content);
      }
    });
    await Promise.all(promises);
  }
  
  return results;
}

function parseRevenueAmountToUsd(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/,/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const match = cleaned.match(/([-+]?\d*\.?\d+)/);
  if (!match) return null;

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;

  let multiplier = 1;
  if (/(billion|\bbn\b)/.test(cleaned)) multiplier = 1_000_000_000;
  else if (/(million|\bm\b)/.test(cleaned)) multiplier = 1_000_000;
  else if (/(thousand|\bk\b)/.test(cleaned)) multiplier = 1_000;

  const value = base * multiplier;
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function mapUsdToRevenueBand(usd: number): string | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const bands: Array<{ min: number; max: number; label: string }> = [
    { min: 0, max: 500_000, label: '0-500K' },
    { min: 500_000, max: 1_000_000, label: '500K-1M' },
    { min: 1_000_000, max: 5_000_000, label: '1M-5M' },
    { min: 5_000_000, max: 10_000_000, label: '5M-10M' },
    { min: 10_000_000, max: 25_000_000, label: '10M-25M' },
    { min: 25_000_000, max: 75_000_000, label: '25M-75M' },
    { min: 75_000_000, max: 200_000_000, label: '75M-200M' },
    { min: 200_000_000, max: 500_000_000, label: '200M-500M' },
    { min: 500_000_000, max: 1_000_000_000, label: '500M-1B' },
    { min: 1_000_000_000, max: 10_000_000_000, label: '1B-10B' },
    { min: 10_000_000_000, max: 100_000_000_000, label: '10B-100B' },
    { min: 100_000_000_000, max: 1_000_000_000_000, label: '100B-1T' },
  ];

  const band = bands.find((b) => usd >= b.min && usd < b.max);
  return band?.label || (usd >= 1_000_000_000_000 ? '100B-1T' : null);
}

function parseEmployeeBandLowerBound(companySize: string): number | null {
  if (!companySize) return null;
  const cleaned = companySize.replace(/employees/i, '').trim();
  const range = cleaned.match(/(\d[\d,]*)\s*[-–]\s*(\d[\d,]*)/);
  if (range) return Number(range[1].replace(/,/g, ''));
  const plus = cleaned.match(/(\d[\d,]*)\s*\+/);
  if (plus) return Number(plus[1].replace(/,/g, ''));
  const single = cleaned.match(/^(\d[\d,]*)$/);
  if (single) return Number(single[1].replace(/,/g, ''));
  return null;
}

function pickRevenueBandFromEvidence(
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

function estimateRevenueBandFromEmployeesAndNaics(
  employeeLowerBound: number,
  naicsCodes: NAICSCode[]
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

function countryNameToCode(countryName: string): string {
  if (!countryName) return 'unknown';
  const name = countryName.trim().toLowerCase();
  
  const countryMap: Record<string, string> = {
    'united states': 'US',
    'usa': 'US',
    'us': 'US',
    'canada': 'CA',
    'ca': 'CA',
    'mexico': 'MX',
    'united kingdom': 'GB',
    'uk': 'GB',
    'germany': 'DE',
    'france': 'FR',
    'italy': 'IT',
    'spain': 'ES',
    'netherlands': 'NL',
    'belgium': 'BE',
    'switzerland': 'CH',
    'sweden': 'SE',
    'norway': 'NO',
    'denmark': 'DK',
    'finland': 'FI',
    'poland': 'PL',
    'czech republic': 'CZ',
    'austria': 'AT',
    'ireland': 'IE',
    'portugal': 'PT',
    'greece': 'GR',
    'japan': 'JP',
    'china': 'CN',
    'india': 'IN',
    'australia': 'AU',
    'new zealand': 'NZ',
    'singapore': 'SG',
    'hong kong': 'HK',
    'south korea': 'KR',
    'thailand': 'TH',
    'vietnam': 'VN',
    'brazil': 'BR',
    'argentina': 'AR',
    'chile': 'CL',
    'colombia': 'CO',
    'peru': 'PE',
    'south africa': 'ZA',
    'israel': 'IL',
    'uae': 'AE',
    'united arab emirates': 'AE',
    'saudi arabia': 'SA',
    'turkey': 'TR',
    'russia': 'RU',
  };
  
  return countryMap[name] || 'unknown';
}

function detectEntityMismatch(
  companyName: string,
  domain: string,
  scrapedContent: Map<string, string>
): { mismatch: boolean; signal: 'none' | 'weak' | 'strong' } {
  const companyLower = (companyName || '').toLowerCase();
  const domainBase = domain.replace(/^www\./, '').split('.')[0].toLowerCase();
  const siteText = Array.from(scrapedContent.entries())
    .filter(([url]) => url.includes(domain.replace(/^www\./, '')))
    .map(([, content]) => content)
    .join(' ')
    .toLowerCase();

  if (!siteText) return { mismatch: false, signal: 'none' };
  const hasCompany = companyLower.length > 3 && siteText.includes(companyLower);
  const hasDomainToken = domainBase.length > 2 && siteText.includes(domainBase);
  if (hasCompany) return { mismatch: false, signal: 'none' };
  if (!hasCompany && hasDomainToken) return { mismatch: true, signal: 'strong' };
  if (!hasCompany && !hasDomainToken) return { mismatch: true, signal: 'weak' };
  return { mismatch: false, signal: 'none' };
}

// ============================================================================
// LINKEDIN VALIDATION
// ============================================================================

interface LinkedInValidation {
  isValid: boolean;
  reason?: string;
  linkedinEmployees?: string;
  linkedinWebsite?: string;
  linkedinLocation?: string;
}

async function validateLinkedInPage(
  linkedinUrl: string,
  expectedDomain: string,
  expectedEmployeeCount: string | null,
  expectedLocation: string | null,
  scrapedContent: Map<string, string>
): Promise<LinkedInValidation> {
  // Check if we have scraped content for this LinkedIn URL
  let linkedinContent: string | null = null;
  for (const [url, content] of scrapedContent) {
    if (url.includes('linkedin.com')) {
      linkedinContent = content;
      break;
    }
  }
  
  if (!linkedinContent) {
    // Try to scrape the LinkedIn page directly
    linkedinContent = await scrapeUrl(linkedinUrl);
  }
  
  if (!linkedinContent) {
    // Can't scrape LinkedIn - do basic URL validation instead
    // Extract the slug from the LinkedIn URL
    const slugMatch = linkedinUrl.match(/linkedin\.com\/company\/([^\/]+)/i);
    const slug = slugMatch ? decodeURIComponent(slugMatch[1]).toLowerCase() : '';
    
    // Normalize expected domain for comparison
    const domainBase = expectedDomain.replace(/\.(com|net|org|io|co)$/, '').replace(/^www\./, '').toLowerCase();
    
    // Check if slug contains the domain name or vice versa
    const slugNormalized = slug.replace(/['-]/g, '').replace(/\s+/g, '');
    const domainNormalized = domainBase.replace(/['-]/g, '').replace(/\s+/g, '');
    
    if (slugNormalized.includes(domainNormalized) || domainNormalized.includes(slugNormalized)) {
      return { isValid: true, reason: 'URL slug matches domain (could not scrape for full validation)' };
    }
    
    // If slug doesn't match domain at all, it's suspicious
    return { isValid: false, reason: `Could not scrape LinkedIn, and URL slug "${slug}" doesn't match domain "${domainBase}"` };
  }
  
  // Extract key info from LinkedIn content
  const websiteMatch = linkedinContent.match(/Website[:\s]*\n?\s*(https?:\/\/[^\s\n]+|www\.[^\s\n]+)/i);
  const linkedinWebsite = websiteMatch ? websiteMatch[1].toLowerCase() : null;
  
  // Check for employee count patterns like "2-10 employees", "201-500 employees"
  const employeeMatch = linkedinContent.match(/(\d+[-–]\d+|\d+\+?)\s*employees/i);
  const linkedinEmployees = employeeMatch ? employeeMatch[1] : null;
  
  // Check for location
  const locationMatch = linkedinContent.match(/(Fort Worth|Dallas|Toronto|San Francisco|New York|Chicago|Los Angeles|Boston|Seattle|Austin|Denver|Miami|Atlanta|Houston|Phoenix)/i);
  const linkedinLocation = locationMatch ? locationMatch[1] : null;
  
  // Validation checks
  const issues: string[] = [];
  
  // 1. Check website domain matches
  if (linkedinWebsite) {
    const normalizedExpected = expectedDomain.replace(/^www\./, '').toLowerCase();
    const normalizedLinkedin = linkedinWebsite.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '').toLowerCase();
    
    if (!normalizedLinkedin.includes(normalizedExpected) && !normalizedExpected.includes(normalizedLinkedin.split('/')[0])) {
      issues.push(`Website mismatch: LinkedIn shows ${linkedinWebsite}, expected ${expectedDomain}`);
    }
  }
  
  // 2. Check employee count is in reasonable range
  if (linkedinEmployees && expectedEmployeeCount) {
    const linkedinEmpNum = parseInt(linkedinEmployees.replace(/[^\d]/g, ''));
    const expectedEmpNum = parseInt(expectedEmployeeCount.replace(/[^\d]/g, ''));
    
    // If LinkedIn shows <50 but we expect >100, that's suspicious
    if (linkedinEmpNum < 50 && expectedEmpNum > 100) {
      issues.push(`Employee count mismatch: LinkedIn shows ${linkedinEmployees}, expected ~${expectedEmployeeCount}`);
    }
    // If LinkedIn shows <10 but we expect >50, definitely wrong
    if (linkedinEmpNum <= 10 && expectedEmpNum > 50) {
      issues.push(`Major employee mismatch: LinkedIn shows ${linkedinEmployees}, expected ~${expectedEmployeeCount}`);
    }
  }
  
  // 3. Check location matches (if we have expected location)
  if (linkedinLocation && expectedLocation) {
    const normalizedExpected = expectedLocation.toLowerCase();
    const normalizedLinkedin = linkedinLocation.toLowerCase();
    
    // If locations are completely different countries/regions
    if (normalizedExpected.includes('toronto') && !normalizedLinkedin.includes('toronto')) {
      if (normalizedLinkedin.includes('fort worth') || normalizedLinkedin.includes('dallas') || normalizedLinkedin.includes('texas')) {
        issues.push(`Location mismatch: LinkedIn shows ${linkedinLocation}, expected ${expectedLocation}`);
      }
    }
  }
  
  if (issues.length > 0) {
    return {
      isValid: false,
      reason: issues.join('; '),
      linkedinEmployees: linkedinEmployees || undefined,
      linkedinWebsite: linkedinWebsite || undefined,
      linkedinLocation: linkedinLocation || undefined
    };
  }
  
  return { isValid: true, linkedinEmployees: linkedinEmployees || undefined, linkedinWebsite: linkedinWebsite || undefined };
}

// ============================================================================
// PASS 1: AI IDENTIFIES URLS TO CRAWL
// ============================================================================

const PASS1_PROMPT = `You are a research assistant. Given a company domain, identify the best URLs to scrape AND extract key financial data you find during your search.

Return a JSON object:
{
  "company_name": "Best guess at company name",
  "parent_company": "Parent company name if this is a subsidiary, otherwise null",
  "headquarters": {
    "city": "San Francisco",
    "state": "California",
    "country": "United States",
    "country_code": "US"
  },
  "urls_to_crawl": [
    "https://example.com",
    "https://example.com/about",
    "https://www.linkedin.com/company/example",
    "https://www.zoominfo.com/c/example/123456",
    "https://www.crunchbase.com/organization/example",
    "https://en.wikipedia.org/wiki/Example_Company"
  ],
  "revenue_found": {
    "amount": "$4.2 billion",
    "source": "Colgate-Palmolive 2023 Annual Report",
    "year": "2023"
  },
  "employee_count_found": {
    "amount": "2,300",
    "source": "Wikipedia"
  }
}

Guidelines:
- Include the main company website, LinkedIn, ZoomInfo, Crunchbase, Wikipedia
- **ALSO include Glassdoor and Indeed** - these have valuable employee count, salary data, and company reviews
- Include LinkedIn company page URL if you can find it
- **CRITICAL for LinkedIn:** 
  - Company names with apostrophes (like "Chef's Plate") often have apostrophes in the LinkedIn URL slug (e.g., linkedin.com/company/chef's-plate NOT linkedin.com/company/chefs-plate)
  - ALWAYS verify the LinkedIn URL by visiting it or searching "[company name] LinkedIn" 
  - Check that the LinkedIn page shows the SAME website domain, location, and industry as the company you're researching
  - If unsure, do NOT include a LinkedIn URL - it's better to return no URL than a wrong one

**CRITICAL - YOU MUST SEARCH FOR REVENUE (Multiple Sources Required):**
Step 1: Search web for "[company name] revenue" AND "[company name] annual sales"
Step 2: Check ZoomInfo, Growjo, Owler, Dun & Bradstreet, IBISWorld for revenue estimates
Step 3: Look for press releases, investor reports, or news articles with revenue figures
Step 4: If SUBSIDIARY, search "[parent company] [subsidiary name] segment revenue" and "[parent company] annual report"
Step 5: Record ALL revenue figures you find (not just one), with source and year

- Return revenue_found as an ARRAY of all figures found, not just one
- Each entry must have: amount (string), source (string), year (string), is_estimate (boolean)
- Example: [{"amount": "$42M", "source": "ZoomInfo", "year": "2023", "is_estimate": true}, {"amount": "$38M", "source": "Press release", "year": "2022", "is_estimate": false}]
- For private companies, third-party estimates are acceptable - mark is_estimate: true
- If you find employee count, include it in "employee_count_found"
- If no revenue found after exhaustive search, set revenue_found to empty array []

- Return ONLY valid JSON, no markdown`;

interface RevenueEvidence {
  amount: string;
  source: string;
  year: string;
  is_estimate: boolean;
}

interface Pass1Result {
  company_name: string;
  parent_company?: string | null;
  headquarters?: {
    city?: string;
    state?: string;
    country?: string;
    country_code?: string;
  } | null;
  urls_to_crawl: string[];
  search_queries?: string[];
  revenue_found?: RevenueEvidence[] | null;
  employee_count_found?: {
    amount: string;
    source: string;
  } | null;
}

async function pass1_identifyUrls(domain: string, model: any): Promise<Pass1Result> {
  console.log(`\n📋 Pass 1: Identifying URLs to crawl...`);
  
  const { text } = await generateText({
    model,
    system: PASS1_PROMPT,
    prompt: `Research the company at domain: ${domain}

REQUIRED STEPS:
1. First, identify the company name from the domain
2. Search for "[company name] revenue" to find revenue figures
3. Search for "[company name] employees" to find employee count
4. Check ZoomInfo, Growjo, Owler for revenue/employee estimates
5. Return the URLs to crawl AND any revenue/employee data you found

Return the JSON with company info, URLs, and any revenue/employee data found.`,
    temperature: 0.1,
  });
  
  try {
    const cleanText = text.trim().replace(/^```json?\n?/i, '').replace(/\n?```$/i, '');
    const result = JSON.parse(cleanText);
    console.log(`   ✅ Found ${result.urls_to_crawl?.length || 0} URLs to crawl`);
    
    // Log data found during search
    if (result.headquarters?.country_code) {
      console.log(`   🌍 HQ found: ${result.headquarters.city || ''}, ${result.headquarters.country_code}`);
    }
    if (Array.isArray(result.revenue_found) && result.revenue_found.length > 0) {
      const first = result.revenue_found[0];
      console.log(`   💰 Revenue found: ${first.amount} (source: ${first.source}${first.year ? `, ${first.year}` : ''})`);
    }
    if (result.employee_count_found?.amount) {
      console.log(`   👥 Employees found: ${result.employee_count_found.amount} (source: ${result.employee_count_found.source})`);
    }
    if (result.parent_company) {
      console.log(`   🏢 Parent company: ${result.parent_company}`);
    }
    
    return result;
  } catch {
    // Fallback - just crawl the main domain
    return {
      company_name: domain.replace(/\.(com|io|co|org|net)$/, ''),
      urls_to_crawl: [`https://${domain}`, `https://${domain}/about`, `https://${domain}/contact`],
      search_queries: [`${domain} company headquarters`, `${domain} company revenue employees`]
    };
  }
}

// ============================================================================
// PASS 2: AI ANALYZES SCRAPED CONTENT
// ============================================================================

const PASS2_PROMPT = `You are a data extraction specialist. Analyze the provided scraped web content and extract structured company information.

Extract the following fields:
- **business_description**: 2-4 sentence comprehensive description of what the company does, including: primary products/services, target markets/customers, key differentiators or unique value proposition, and business model if relevant
- **city**: Main office or HQ city
- **state**: For US companies, full state name (e.g., "Massachusetts", "California"); for non-US, main region or null
- **hq_country**: 2-letter ISO country code (e.g., "US", "CA", "DE")
- **is_us_hq**: Boolean - true if global HQ is in the United States
- **is_us_subsidiary**: Boolean - true if subsidiary whose parent is US-headquartered
- **linkedin_url**: Official LinkedIn company page URL (null if not found)
- **company_revenue**: Annual revenue using ONLY these exact bands:
  "0-500K", "500K-1M", "1M-5M", "5M-10M", "10M-25M", "25M-75M", 
  "75M-200M", "200M-500M", "500M-1B", "1B-10B", "10B-100B", "100B-1T"
  (null if not found)
  
  **CRITICAL FOR REVENUE - Show your work:** 
  - Extract ALL revenue figures you find in the content with source and year
  - Normalize amounts to USD (e.g., "$42M" = 42,000,000)
  - Prioritize: SEC filings > Press releases > Wikipedia > ZoomInfo/Crunchbase estimates
  - If multiple figures exist, use the most recent and explicit one
  - If conflicting figures differ by more than 5x, set company_revenue to null
  - If only vague phrases like "multi-million" or "8-figure", choose the LOWEST compatible band
  - If no explicit figure found, set company_revenue to null (do NOT estimate from employee count)
  - Map your normalized amount to the appropriate band based on the range
  - Example: $42M → "25M-75M" band
- **company_size**: Employee count using ONLY these exact bands:
  "0-1 Employees", "2-10 Employees", "11-50 Employees", "51-200 Employees", 
  "201-500 Employees", "501-1,000 Employees", "1,001-5,000 Employees", 
  "5,001-10,000 Employees", "10,001+ Employees"
  
  **IMPORTANT FOR COMPANY SIZE:**
  - Check Glassdoor and Indeed pages for employee count ranges
  - Glassdoor shows "Company Size" field and employee reviews
  - Indeed shows number of open jobs and company reviews
  - LinkedIn shows employee count in the "About" section
  - Cross-reference multiple sources for accuracy
- **naics_codes_6_digit**: Array of up to 3 objects with code and description. Example:
  [
    {"code": "311991", "description": "Perishable Prepared Food Manufacturing"},
    {"code": "424490", "description": "Other Grocery and Related Products Merchant Wholesalers"}
  ]
- **source_urls**: Array of URLs you used to extract information (include Glassdoor/Indeed if available)
- **quality**: Object containing confidence and reasoning for four key data points:
  - location: confidence and reasoning for city/state/country
  - revenue: confidence and reasoning for revenue band selection
  - size: confidence and reasoning for company size band selection
  - industry: confidence and reasoning for NAICS code selection

Return ONLY valid JSON with revenue evidence shown in reasoning:
{
  "business_description": "...",
  "city": "San Francisco",
  "state": "California",
  "hq_country": "US",
  "is_us_hq": true,
  "is_us_subsidiary": false,
  "linkedin_url": "https://www.linkedin.com/company/xxx/",
  "company_revenue": "10B-100B",
  "company_size": "51-200 Employees",
  "naics_codes_6_digit": [
    {"code": "311991", "description": "Perishable Prepared Food Manufacturing"},
    {"code": "424490", "description": "Other Grocery and Related Products Merchant Wholesalers"}
  ],
  "source_urls": ["https://...", "https://..."],
  "quality": {
    "location": {"confidence": "high", "reasoning": "Found on company website About page"},
    "revenue": {"confidence": "high", "reasoning": "Found explicit revenue of $42M in 2023 press release, maps to 25M-75M band"},
    "size": {"confidence": "high", "reasoning": "Confirmed from Indeed and Glassdoor employee counts"},
    "industry": {"confidence": "high", "reasoning": "NAICS codes determined from company's primary business activities"}
  }
}

IMPORTANT:
- Only include LinkedIn URL if you actually found it in the scraped content
- Determine NAICS codes based on what the company actually does
- Return null for fields not found, not "unknown"
- Include all URLs you used to extract information in source_urls`;

interface NAICSCode {
  code: string;
  description: string;
}

interface FieldQuality {
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

interface QualityMetrics {
  location: FieldQuality;
  revenue: FieldQuality;
  size: FieldQuality;
  industry: FieldQuality;
}

interface TargetICPMatch {
  code: string;
  description: string;
}

interface EnrichmentResult {
  company_name: string;
  website: string;
  domain: string;
  linkedin_url: string | null;
  business_description: string;
  company_size: string;
  company_revenue: string | null;
  naics_codes_6_digit: NAICSCode[];
  naics_codes_csv: string;
  city: string;
  state: string | null;
  hq_country: string;
  is_us_hq: boolean;
  is_us_subsidiary: boolean;
  source_urls: string[];
  quality: QualityMetrics;
  target_icp: boolean;
  target_icp_matches: TargetICPMatch[];
}

async function pass2_analyzeContent(
  domain: string, 
  companyName: string,
  scrapedContent: Map<string, string>, 
  model: any,
  pass1Data?: Pass1Result
): Promise<EnrichmentResult> {
  console.log(`\n🔬 Pass 2: Analyzing scraped content...`);
  
  // Validate company name appears in scraped content
  const allScrapedText = Array.from(scrapedContent.values()).join(' ').toLowerCase();
  const companyNameLower = companyName.toLowerCase();
  const domainBase = domain.replace('www.', '').split('.')[0].toLowerCase();
  
  const companyNameFound = allScrapedText.includes(companyNameLower);
  const domainNameFound = allScrapedText.includes(domainBase);
  
  if (!companyNameFound && domainNameFound) {
    console.log(`\n⚠️  Company name validation WARNING:`);
    console.log(`   - Pass 1 identified: "${companyName}"`);
    console.log(`   - But "${companyName}" NOT found in scraped website content`);
    console.log(`   - Domain name "${domainBase}" IS found in content`);
    console.log(`   - This suggests Pass 1 may have misidentified the company`);
  }
  
  // Build context from scraped content
  let context = `Company: ${companyName}\nDomain: ${domain}\n`;
  
  // Include Pass 1 findings
  if (pass1Data?.headquarters?.country_code) {
    context += `**HEADQUARTERS found during web search:** ${pass1Data.headquarters.city || ''}, ${pass1Data.headquarters.state || ''}, ${pass1Data.headquarters.country || ''} (${pass1Data.headquarters.country_code})\n`;
  }
  if (pass1Data?.parent_company) {
    context += `Parent Company: ${pass1Data.parent_company}\n`;
  }
  if (pass1Data?.revenue_found && Array.isArray(pass1Data.revenue_found) && pass1Data.revenue_found.length > 0) {
    context += `**IMPORTANT - Revenue figures found during web search:**\n`;
    pass1Data.revenue_found.forEach((rev, idx) => {
      context += `  ${idx + 1}. ${rev.amount} (${rev.year}, Source: ${rev.source}${rev.is_estimate ? ', estimate' : ''})\n`;
    });
  }
  if (pass1Data?.employee_count_found?.amount) {
    context += `**Employee count found during web search:** ${pass1Data.employee_count_found.amount} (Source: ${pass1Data.employee_count_found.source})\n`;
  }
  
  context += `\n=== SCRAPED CONTENT ===\n\n`;
  
  for (const [url, content] of scrapedContent) {
    // Truncate each page to avoid token limits
    const truncated = content.slice(0, 5000);
    context += `--- ${url} ---\n${truncated}\n\n`;
  }
  
  const { text } = await generateText({
    model,
    system: PASS2_PROMPT,
    prompt: context,
    temperature: 0.1,
  });
  
  try {
    const cleanText = text.trim().replace(/^```json?\n?/i, '').replace(/\n?```$/i, '');
    const parsed = JSON.parse(cleanText);
    
    // Map parsed response to EnrichmentResult, filling in missing fields
    // Ensure NAICS codes are in the correct format (array of objects with code and description)
    let naicsCodes: NAICSCode[] = [];
    if (parsed.naics_codes_6_digit) {
      if (Array.isArray(parsed.naics_codes_6_digit)) {
        naicsCodes = parsed.naics_codes_6_digit.map((item: any) => {
          if (typeof item === 'string') {
            return { code: item, description: 'Unknown' };
          }
          return { code: item.code || '', description: item.description || 'Unknown' };
        });
      }
    }
    
    // Target ICP NAICS codes list
    const targetIcpNaics = new Set([
      '111219', '111333', '111334', '111339', '111998', '112120', '112210', '112310', '112320', '112330', '112340', '112390',
      '115114', '311111', '311119', '311211', '311212', '311213', '311221', '311224', '311225', '311230', '311313', '311314',
      '311340', '311351', '311352', '311411', '311412', '311421', '311422', '311423', '311511', '311512', '311513', '311514',
      '311520', '311611', '311612', '311613', '311615', '311710', '311811', '311812', '311813', '311821', '311824', '311830',
      '311911', '311919', '311920', '311930', '311941', '311942', '311991', '311999', '312111', '312112', '312120', '312130',
      '312140', '424410', '424420', '424430', '424440', '424450', '424460', '424470', '424480', '424490', '424510', '424590',
      '445110', '445131', '493120'
    ]);
    
    // Find matching NAICS codes and check if any match target ICP
    const targetIcpMatches: TargetICPMatch[] = naicsCodes.filter(naics => targetIcpNaics.has(naics.code));
    const targetIcp = targetIcpMatches.length > 0;
    
    // POST-CHECK: Validate revenue band has supporting evidence
    // If revenue was set but reasoning doesn't show explicit figures or sources, null it out
    let finalRevenue = parsed.company_revenue || null;
    if (finalRevenue && parsed.quality?.revenue?.reasoning) {
      const revenueReasoning = parsed.quality.revenue.reasoning.toLowerCase();
      // Check if reasoning mentions actual numbers or credible sources
      const hasEvidence = /\$|million|billion|thousand|zoominfo|press release|annual report|sec filing|crunchbase|owler|growjo/.test(revenueReasoning);
      if (!hasEvidence) {
        // No explicit evidence found - null it out and mark as low confidence
        finalRevenue = null;
        if (parsed.quality?.revenue) {
          parsed.quality.revenue.confidence = 'low';
          parsed.quality.revenue.reasoning = 'Revenue band selected without explicit evidence - nulled for accuracy';
        }
      }
    }
    
    // FALLBACK: Use Pass 1 data if Pass 2 didn't find revenue or size
    let finalSize = parsed.company_size || 'unknown';
    if (finalSize === 'unknown' && pass1Data?.employee_count_found?.amount) {
      finalSize = pass1Data.employee_count_found.amount;
    }
    
    if (!finalRevenue && pass1Data?.revenue_found && Array.isArray(pass1Data.revenue_found) && pass1Data.revenue_found.length > 0) {
      finalRevenue = pass1Data.revenue_found[0].amount || null;
    }
    
    const result: EnrichmentResult = {
      company_name: companyName,
      website: `https://${domain}`,
      domain: domain,
      linkedin_url: parsed.linkedin_url || null,
      business_description: parsed.business_description || 'unknown',
      company_size: finalSize,
      company_revenue: finalRevenue,
      naics_codes_6_digit: naicsCodes,
      naics_codes_csv: naicsCodes.map(n => n.code).join(','),
      city: parsed.city || 'unknown',
      state: parsed.state || null,
      hq_country: countryNameToCode(parsed.hq_country) || 'unknown',
      is_us_hq: parsed.is_us_hq || false,
      is_us_subsidiary: parsed.is_us_subsidiary || false,
      source_urls: parsed.source_urls || [],
      quality: parsed.quality || {
        location: { confidence: 'low', reasoning: 'Could not determine location' },
        revenue: { confidence: 'low', reasoning: 'Could not determine revenue' },
        size: { confidence: 'low', reasoning: 'Could not determine company size' },
        industry: { confidence: 'low', reasoning: 'Could not determine industry' }
      },
      target_icp: targetIcp,
      target_icp_matches: targetIcpMatches
    };
    
    return result;
  } catch {
    return {
      company_name: companyName,
      website: `https://${domain}`,
      domain: domain,
      linkedin_url: null,
      business_description: 'unknown',
      company_size: 'unknown',
      company_revenue: null,
      naics_codes_6_digit: [],
      naics_codes_csv: '',
      city: 'unknown',
      state: null,
      hq_country: 'unknown',
      is_us_hq: false,
      is_us_subsidiary: false,
      source_urls: [],
      quality: {
        location: { confidence: 'low', reasoning: 'Could not parse structured response' },
        revenue: { confidence: 'low', reasoning: 'Could not parse structured response' },
        size: { confidence: 'low', reasoning: 'Could not parse structured response' },
        industry: { confidence: 'low', reasoning: 'Could not parse structured response' }
      },
      target_icp: false,
      target_icp_matches: []
    };
  }
}

// ============================================================================
// MAIN ENRICHMENT FUNCTION
// ============================================================================

async function enrichDomain(domain: string, jsonOnly: boolean = false): Promise<void> {
  // Store original console.log for JSON output
  const originalLog = console.log;
  
  // If jsonOnly mode, suppress all console.log calls
  if (jsonOnly) {
    console.log = () => {};
  }
  
  const apiKey = process.env.AI_GATEWAY_API_KEY || process.env.PERPLEXITY_API_KEY;
  const firecrawlKey = process.env.FIRECRAWL_API_KEY;
  
  if (!apiKey) {
    console.error('Error: AI_GATEWAY_API_KEY or PERPLEXITY_API_KEY environment variable is required');
    process.exit(1);
  }
  
  if (!firecrawlKey) {
    console.error('Error: FIRECRAWL_API_KEY environment variable is required for 2-pass mode');
    process.exit(1);
  }

  const useGateway = !!process.env.AI_GATEWAY_API_KEY;
  const modelId = 'perplexity/sonar-pro';
  
  // Use a faster/cheaper model for Pass 2 analysis since we have the content
  const analysisModelId = 'openai/gpt-4o-mini';

  console.log(`\n🔍 Researching: ${domain}`);
  console.log(`📡 Using: ${useGateway ? 'Vercel AI Gateway' : 'Perplexity API'}`);
  console.log(`🤖 Pass 1 Model: ${modelId} (web search)`);
  console.log(`🤖 Pass 2 Model: ${analysisModelId} (content analysis)`);

  try {
    const startTime = Date.now();
    
    // Get models
    const searchModel = useGateway 
      ? gateway(modelId)
      : createOpenAI({ apiKey, baseURL: 'https://api.perplexity.ai' })('sonar-pro');
    
    const analysisModel = useGateway
      ? gateway(analysisModelId)
      : createOpenAI({ apiKey: process.env.OPENAI_API_KEY || apiKey })('gpt-4o-mini');
    
    // PASS 1: Identify URLs to crawl
    let pass1Result = await pass1_identifyUrls(domain, searchModel);
    console.log(`   📝 Company: ${pass1Result.company_name}`);
    console.log(`   🔗 URLs: ${pass1Result.urls_to_crawl.join(', ')}`);
    
    // SCRAPE: Use Firecrawl to scrape identified URLs
    console.log(`\n🔥 Scraping ${pass1Result.urls_to_crawl.length} URLs with Firecrawl...`);
    let scrapedContent = await scrapeMultipleUrls(pass1Result.urls_to_crawl);
    console.log(`   ✅ Successfully scraped ${scrapedContent.size} pages`);

    const entityCheck = detectEntityMismatch(pass1Result.company_name, domain, scrapedContent);
    if (entityCheck.mismatch) {
      console.log(`\n⚠️  Potential entity mismatch detected (${entityCheck.signal}). Re-running Pass 1 in strict mode...`);
      pass1Result = await pass1_identifyUrlsStrict(domain, searchModel, pass1Result.company_name);
      console.log(`   📝 Company (strict): ${pass1Result.company_name}`);
      console.log(`   🔗 URLs (strict): ${pass1Result.urls_to_crawl.join(', ')}`);
      console.log(`\n🔥 Re-scraping ${pass1Result.urls_to_crawl.length} URLs with Firecrawl...`);
      scrapedContent = await scrapeMultipleUrls(pass1Result.urls_to_crawl);
      console.log(`   ✅ Successfully scraped ${scrapedContent.size} pages`);
    }
    
    // Extract LinkedIn from scraped content - prioritize company website
    let linkedinFromScrape: string | null = null;
    let linkedinSource: 'website' | 'pass1' | null = null;
    // Updated regex to capture special characters like apostrophes, URL-encoded chars, etc.
    const linkedinRegex = /https?:\/\/(?:www\.)?linkedin\.com\/company\/([a-zA-Z0-9_\-'%]+)\/?/gi;
    
    // First, try to find LinkedIn on the company's own website (MOST RELIABLE - this is authoritative)
    for (const [url, content] of scrapedContent) {
      // Only check the company's own domain for LinkedIn links
      if (url.includes(domain) || url.includes(domain.replace('www.', ''))) {
        const matches = [...content.matchAll(linkedinRegex)];
        if (matches.length > 0) {
          // Filter out generic LinkedIn URLs (crunchbase, zoominfo, etc.)
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
        scrapedContent
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
        linkedinFromScrape = null; // Reject the LinkedIn URL
      } else {
        console.log(`   ✅ LinkedIn validation passed`);
      }
    } else if (linkedinFromScrape && linkedinSource === 'website') {
      console.log(`\n✅ LinkedIn from company website - no validation needed (authoritative source)`);
    }
    
    let result = await pass2_analyzeContent(domain, pass1Result.company_name, scrapedContent, analysisModel, pass1Result);
    
    // ALWAYS use our scraped/Pass 1 LinkedIn URL if we found one (more reliable than Pass 2)
    // But validate the URL format first
    if (linkedinFromScrape) {
      // Fix common LinkedIn URL issues
      let linkedinUrl = linkedinFromScrape;
      
      // Fix missing :// (e.g., "https://www linkedin.com" -> "https://www.linkedin.com")
      linkedinUrl = linkedinUrl.replace(/https:\/\/www\s+linkedin/, 'https://www.linkedin');
      linkedinUrl = linkedinUrl.replace(/https:\/\/linkedin\s+/, 'https://www.linkedin.');
      
      // Ensure it starts with https://
      if (!linkedinUrl.startsWith('http')) {
        linkedinUrl = 'https://' + linkedinUrl;
      }
      
      // Ensure it contains linkedin.com
      if (linkedinUrl.includes('linkedin')) {
        result.linkedin_url = linkedinUrl;
      }
    }

    if (!result.company_revenue) {
      const evidence = Array.isArray(pass1Result.revenue_found) ? pass1Result.revenue_found : [];
      const picked = pickRevenueBandFromEvidence(evidence);
      if (picked.band) {
        result.company_revenue = picked.band;
        result.quality.revenue.confidence = picked.confidence;
        result.quality.revenue.reasoning = picked.reasoning;
      } else {
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
    }

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    const naicsDisplay = result.naics_codes_6_digit?.length > 0 
      ? result.naics_codes_6_digit.map(n => `${n.code} (${n.description})`).join(', ') 
      : 'unknown';
    
    const sourceDisplay = result.source_urls?.length > 0
      ? result.source_urls.slice(0, 3).join(', ')
      : 'none';
    
    const getEmoji = (confidence: string) => ({
      high: '🟢',
      medium: '🟡', 
      low: '🔴'
    })[confidence] || '⚪';
    
    console.log('\n' + '━'.repeat(70));
    console.log(`📍 Domain:           ${result.domain}`);
    console.log(`🏢 Company:          ${result.company_name}`);
    console.log(`📝 Description:      ${result.business_description}`);
    console.log(`📍 Location:         ${result.city}${result.state ? ', ' + result.state : ''}, ${result.hq_country}`);
    console.log(`🌍 US HQ:            ${result.is_us_hq ? 'Yes' : 'No'} | US Subsidiary: ${result.is_us_subsidiary ? 'Yes' : 'No'}`);
    const icpMatchDisplay = result.target_icp_matches.length > 0 
      ? result.target_icp_matches.map(m => `${m.code} (${m.description})`).join(', ')
      : 'none';
    console.log(`🎯 Target ICP:       ${result.target_icp ? '✅ Yes' : '❌ No'}${result.target_icp_matches.length > 0 ? ` - Matches: ${icpMatchDisplay}` : ''}`);
    console.log(`🔗 LinkedIn:         ${result.linkedin_url || 'unknown'}`);
    console.log(`💰 Revenue:          ${result.company_revenue || 'unknown'}`);
    console.log(`👥 Company Size:     ${result.company_size}`);
    console.log(`🏭 NAICS Codes:      ${naicsDisplay}`);
    console.log(`📚 Sources:          ${sourceDisplay}`);
    console.log('\n' + '━'.repeat(70));
    console.log(`📊 QUALITY METRICS:`);
    console.log(`${getEmoji(result.quality.location.confidence)} Location:  ${result.quality.location.confidence}`);
    console.log(`   └─ ${result.quality.location.reasoning}`);
    console.log(`${getEmoji(result.quality.revenue.confidence)} Revenue:   ${result.quality.revenue.confidence}`);
    console.log(`   └─ ${result.quality.revenue.reasoning}`);
    console.log(`${getEmoji(result.quality.size.confidence)} Size:      ${result.quality.size.confidence}`);
    console.log(`   └─ ${result.quality.size.reasoning}`);
    console.log(`${getEmoji(result.quality.industry.confidence)} Industry:  ${result.quality.industry.confidence}`);
    console.log(`   └─ ${result.quality.industry.reasoning}`);
    console.log('━'.repeat(70));
    console.log(`⏱️  Duration:         ${duration}s`);
    console.log(`📄 Pages Scraped:    ${scrapedContent.size}`);
    console.log('━'.repeat(70));
    
    // Output raw JSON only if --json flag is passed
    const showJson = process.argv.slice(2).includes('--json');
    if (showJson) {
      originalLog(JSON.stringify(result, null, 2));
    }

  } catch (error: any) {
    console.error('❌ Error:', error.message || error);
    process.exit(1);
  }
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log(`
Usage: npx tsx scripts/enrich-test.ts <domain>

Examples:
  npx tsx scripts/enrich-test.ts apple.com
  npx tsx scripts/enrich-test.ts microsoft.com
  npx tsx scripts/enrich-test.ts safetychain.com

Environment variables (all required):
  AI_GATEWAY_API_KEY   - Vercel AI Gateway API key
  FIRECRAWL_API_KEY    - Firecrawl API key for web scraping

2-Pass Architecture:
  1. Pass 1: Perplexity identifies URLs to crawl (company site, LinkedIn, ZoomInfo, etc.)
  2. Firecrawl: Scrapes all identified URLs in parallel
  3. Pass 2: GPT-4o-mini analyzes scraped content and extracts structured data
`);
  process.exit(0);
}

const domain = args[0].replace(/^https?:\/\//, '').replace(/\/$/, '');
const jsonOnly = args.includes('--json');
enrichDomain(domain, jsonOnly);
