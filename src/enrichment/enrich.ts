import { generateText } from 'ai';
import { EnrichmentResult, EnrichmentResultWithCost, Pass1Result, NAICSCode, TargetICPMatch, RevenueEvidence, AIUsage, CostBreakdown, PerformanceMetrics } from '../types.js';
import { scrapeUrl, scrapeMultipleUrls, scrapeMultipleUrlsWithCost, calculateFirecrawlCost } from '../scraper.js';
import { pickRevenueBandFromEvidence, estimateRevenueBandFromEmployeesAndNaics, estimateFromIndustryAverages, validateRevenueVsEmployees } from '../utils/revenue.js';
import { parseEmployeeBandLowerBound, countryNameToCode } from '../utils/parsing.js';

// ============================================================================
// AI MODEL PRICING (per 1M tokens)
// ============================================================================
// Perplexity sonar-pro: $3/1M input, $15/1M output
// GPT-4o-mini: $0.15/1M input, $0.60/1M output
const AI_PRICING: Record<string, { input: number; output: number }> = {
  'perplexity/sonar-pro': { input: 3.0, output: 15.0 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.60 },
};

function calculateAICost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = AI_PRICING[model] || { input: 0.15, output: 0.60 }; // default to gpt-4o-mini
  return (inputTokens * pricing.input / 1_000_000) + (outputTokens * pricing.output / 1_000_000);
}

// ============================================================================
// PASS 1 PROMPT - EXACT COPY FROM TEST SCRIPT
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
Step 1: Search "[company name] revenue" AND "[company name] annual sales" AND "[company name] million sales"
Step 2: Look for press releases, news articles, trade publications, and industry reports FIRST
Step 3: Search for marketing case studies or awards that mention revenue (e.g., "Inc 5000", "fastest growing")
Step 4: If SUBSIDIARY, search "[parent company] [subsidiary name] segment revenue" and "[parent company] annual report"
Step 5: LAST RESORT: Check ZoomInfo, Growjo, Owler - but mark these as LOW confidence estimates

**IMPORTANT - SOURCE RELIABILITY:**
- MOST RELIABLE: SEC filings, press releases, news articles, trade publications, company announcements
- MODERATELY RELIABLE: Industry reports, marketing case studies, awards lists
- LEAST RELIABLE: ZoomInfo, Growjo, Owler, Dun & Bradstreet, Manta (often outdated/wrong for private companies)
- If ZoomInfo/Growjo shows <$5M but company has 50+ employees or national retail presence, the estimate is likely WRONG

- Return revenue_found as an ARRAY of all figures found, not just one
- Each entry must have: amount (string), source (string), year (string), is_estimate (boolean)
- Example: [{"amount": "$160M", "source": "Concentric marketing case study", "year": "2023", "is_estimate": false}, {"amount": "$48M", "source": "ZoomInfo", "year": "2023", "is_estimate": true}]
- Mark ZoomInfo/Growjo/Owler figures as is_estimate: true ALWAYS
**CRITICAL - YOU MUST SEARCH FOR EMPLOYEE COUNT:**
Step 1: Search "[company name] LinkedIn" and visit the LinkedIn company page
Step 2: Look for "Company size" on LinkedIn (e.g., "2-10 employees", "51-200 employees")
Step 3: Also check ZoomInfo, Growjo, Owler for employee counts
Step 4: Record the employee count with source in "employee_count_found"

- If you find employee count, include it in "employee_count_found" with amount and source
- If no revenue found after exhaustive search, set revenue_found to empty array []

- Return ONLY valid JSON, no markdown`;

// ============================================================================
// PASS 2 PROMPT - EXACT COPY FROM TEST SCRIPT
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

// ============================================================================
// EMPLOYEE COUNT TO BAND MAPPING
// ============================================================================

function mapEmployeeCountToBand(employeeStr: string): string | null {
  // Parse employee count from strings like "11-50", "51-200", "1,000+", "76"
  const cleanStr = employeeStr.replace(/,/g, '').replace(/\s+/g, '');
  
  // Handle range format like "11-50" or "51–200"
  const rangeMatch = cleanStr.match(/(\d+)[-–](\d+)/);
  if (rangeMatch) {
    const lower = parseInt(rangeMatch[1]);
    const upper = parseInt(rangeMatch[2]);
    const avg = Math.floor((lower + upper) / 2);
    return employeeCountToBand(avg);
  }
  
  // Handle "1000+" format
  const plusMatch = cleanStr.match(/(\d+)\+/);
  if (plusMatch) {
    const count = parseInt(plusMatch[1]);
    return employeeCountToBand(count);
  }
  
  // Handle plain number
  const numMatch = cleanStr.match(/(\d+)/);
  if (numMatch) {
    return employeeCountToBand(parseInt(numMatch[1]));
  }
  
  return null;
}

function employeeCountToBand(count: number): string {
  if (count <= 1) return '0-1 Employees';
  if (count <= 10) return '2-10 Employees';
  if (count <= 50) return '11-50 Employees';
  if (count <= 200) return '51-200 Employees';
  if (count <= 500) return '201-500 Employees';
  if (count <= 1000) return '501-1,000 Employees';
  if (count <= 5000) return '1,001-5,000 Employees';
  if (count <= 10000) return '5,001-10,000 Employees';
  return '10,001+ Employees';
}

// ============================================================================
// LINKEDIN VALIDATION - EXACT COPY FROM TEST SCRIPT
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
  scrapedContent: Map<string, string>,
  firecrawlApiKey?: string
): Promise<LinkedInValidation> {
  let linkedinContent: string | null = null;
  for (const [url, content] of scrapedContent) {
    if (url.includes('linkedin.com')) {
      linkedinContent = content;
      break;
    }
  }
  
  if (!linkedinContent) {
    linkedinContent = await scrapeUrl(linkedinUrl, firecrawlApiKey);
  }
  
  if (!linkedinContent) {
    // LinkedIn requires auth and can't be scraped directly
    // Trust Pass 1 (Perplexity) since it has access to LinkedIn data
    // Only reject if we have strong evidence of mismatch from other sources
    return { isValid: true, reason: `LinkedIn page could not be scraped (auth required), trusting Pass 1` };
  }
  
  const websiteMatch = linkedinContent.match(/Website[:\s]*\n?\s*(https?:\/\/[^\s\n]+|www\.[^\s\n]+)/i);
  const linkedinWebsite = websiteMatch ? websiteMatch[1].toLowerCase() : null;
  const employeeMatch = linkedinContent.match(/(\d+[-–]\d+|\d+\+?)\s*employees/i);
  const linkedinEmployees = employeeMatch ? employeeMatch[1] : null;
  const locationMatch = linkedinContent.match(/(Fort Worth|Dallas|Toronto|San Francisco|New York|Chicago|Los Angeles|Boston|Seattle|Austin|Denver|Miami|Atlanta|Houston|Phoenix)/i);
  const linkedinLocation = locationMatch ? locationMatch[1] : null;
  
  const issues: string[] = [];
  
  if (linkedinWebsite) {
    const normalizedExpected = expectedDomain.replace(/^www\./, '').toLowerCase();
    const normalizedLinkedin = linkedinWebsite.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '').toLowerCase();
    if (!normalizedLinkedin.includes(normalizedExpected) && !normalizedExpected.includes(normalizedLinkedin.split('/')[0])) {
      issues.push(`Website mismatch: LinkedIn shows ${linkedinWebsite}, expected ${expectedDomain}`);
    }
  }
  
  if (linkedinEmployees && expectedEmployeeCount) {
    const linkedinEmpNum = parseInt(linkedinEmployees.replace(/[^\d]/g, ''));
    const expectedEmpNum = parseInt(expectedEmployeeCount.replace(/[^\d]/g, ''));
    if (linkedinEmpNum < 50 && expectedEmpNum > 100) {
      issues.push(`Employee count mismatch: LinkedIn shows ${linkedinEmployees}, expected ~${expectedEmployeeCount}`);
    }
    if (linkedinEmpNum <= 10 && expectedEmpNum > 50) {
      issues.push(`Major employee mismatch: LinkedIn shows ${linkedinEmployees}, expected ~${expectedEmployeeCount}`);
    }
  }
  
  if (linkedinLocation && expectedLocation) {
    const normalizedExpected = expectedLocation.toLowerCase();
    const normalizedLinkedin = linkedinLocation.toLowerCase();
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
// ENTITY MISMATCH DETECTION - EXACT COPY FROM TEST SCRIPT
// ============================================================================

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
// PASS 1: IDENTIFY URLS - WITH COST TRACKING
// ============================================================================

interface Pass1WithUsage {
  result: Pass1Result;
  usage: AIUsage;
}

export async function pass1_identifyUrls(domain: string, model: any, modelId: string = 'perplexity/sonar-pro'): Promise<Pass1Result> {
  const { result } = await pass1_identifyUrlsWithUsage(domain, model, modelId);
  return result;
}

export async function pass1_identifyUrlsWithUsage(domain: string, model: any, modelId: string = 'perplexity/sonar-pro'): Promise<Pass1WithUsage> {
  console.log(`\n📋 Pass 1: Identifying URLs to crawl...`);
  
  const { text, usage } = await generateText({
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
  
  const inputTokens = usage?.inputTokens || 0;
  const outputTokens = usage?.outputTokens || 0;
  const totalTokens = usage?.totalTokens || (inputTokens + outputTokens);
  const costUsd = calculateAICost(modelId, inputTokens, outputTokens);
  
  const aiUsage: AIUsage = {
    model: modelId,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd
  };
  
  console.log(`   🔢 Tokens: ${inputTokens} in / ${outputTokens} out = ${totalTokens} total ($${costUsd.toFixed(4)})`);
  
  try {
    const cleanText = text.trim().replace(/^```json?\n?/i, '').replace(/\n?```$/i, '');
    const result = JSON.parse(cleanText);
    console.log(`   ✅ Found ${result.urls_to_crawl?.length || 0} URLs to crawl`);
    
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
    
    return { result, usage: aiUsage };
  } catch {
    return {
      result: {
        company_name: domain.replace(/\.(com|io|co|org|net)$/, ''),
        urls_to_crawl: [`https://${domain}`, `https://${domain}/about`, `https://${domain}/contact`],
        search_queries: [`${domain} company headquarters`, `${domain} company revenue employees`]
      },
      usage: aiUsage
    };
  }
}

export async function pass1_identifyUrlsStrict(domain: string, model: any, previousCompanyName: string): Promise<Pass1Result> {
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

// ============================================================================
// PASS 2: ANALYZE CONTENT - WITH COST TRACKING
// ============================================================================

interface Pass2WithUsage {
  result: EnrichmentResult;
  usage: AIUsage;
}

export async function pass2_analyzeContent(
  domain: string, 
  companyName: string,
  scrapedContent: Map<string, string>, 
  model: any,
  pass1Data?: Pass1Result,
  modelId: string = 'openai/gpt-4o-mini'
): Promise<EnrichmentResult> {
  const { result } = await pass2_analyzeContentWithUsage(domain, companyName, scrapedContent, model, pass1Data, modelId);
  return result;
}

export async function pass2_analyzeContentWithUsage(
  domain: string, 
  companyName: string,
  scrapedContent: Map<string, string>, 
  model: any,
  pass1Data?: Pass1Result,
  modelId: string = 'openai/gpt-4o-mini'
): Promise<Pass2WithUsage> {
  console.log(`\n🔬 Pass 2: Analyzing scraped content...`);
  
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
  
  let context = `Company: ${companyName}\nDomain: ${domain}\n`;
  
  if (pass1Data?.headquarters?.country_code) {
    context += `**HEADQUARTERS found during web search:** ${pass1Data.headquarters.city || ''}, ${pass1Data.headquarters.state || ''}, ${pass1Data.headquarters.country || ''} (${pass1Data.headquarters.country_code})\n`;
  }
  if (pass1Data?.parent_company) {
    context += `Parent Company: ${pass1Data.parent_company}\n`;
  }
  if (pass1Data?.revenue_found && Array.isArray(pass1Data.revenue_found) && pass1Data.revenue_found.length > 0) {
    context += `**IMPORTANT - Revenue figures found during web search:**\n`;
    pass1Data.revenue_found.forEach((rev: RevenueEvidence, idx: number) => {
      context += `  ${idx + 1}. ${rev.amount} (${rev.year}, Source: ${rev.source}${rev.is_estimate ? ', estimate' : ''})\n`;
    });
  }
  if (pass1Data?.employee_count_found?.amount) {
    context += `**Employee count found during web search:** ${pass1Data.employee_count_found.amount} (Source: ${pass1Data.employee_count_found.source})\n`;
  }
  
  context += `\n=== SCRAPED CONTENT ===\n\n`;
  
  for (const [url, content] of scrapedContent) {
    const truncated = content.slice(0, 5000);
    context += `--- ${url} ---\n${truncated}\n\n`;
  }
  
  const { text, usage } = await generateText({
    model,
    system: PASS2_PROMPT,
    prompt: context,
    temperature: 0.1,
  });
  
  const inputTokens = usage?.inputTokens || 0;
  const outputTokens = usage?.outputTokens || 0;
  const totalTokens = usage?.totalTokens || (inputTokens + outputTokens);
  const costUsd = calculateAICost(modelId, inputTokens, outputTokens);
  
  const aiUsage: AIUsage = {
    model: modelId,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd
  };
  
  console.log(`   🔢 Tokens: ${inputTokens} in / ${outputTokens} out = ${totalTokens} total ($${costUsd.toFixed(4)})`);
  
  
  try {
    const cleanText = text.trim().replace(/^```json?\n?/i, '').replace(/\n?```$/i, '');
    const parsed = JSON.parse(cleanText);
    
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
    
    const targetIcpNaics = new Set([
      '111219', '111333', '111334', '111339', '111998', '112120', '112210', '112310', '112320', '112330', '112340', '112390',
      '115114', '311111', '311119', '311211', '311212', '311213', '311221', '311224', '311225', '311230', '311313', '311314',
      '311340', '311351', '311352', '311411', '311412', '311421', '311422', '311423', '311511', '311512', '311513', '311514',
      '311520', '311611', '311612', '311613', '311615', '311710', '311811', '311812', '311813', '311821', '311824', '311830',
      '311911', '311919', '311920', '311930', '311941', '311942', '311991', '311999', '312111', '312112', '312120', '312130',
      '312140', '424410', '424420', '424430', '424440', '424450', '424460', '424470', '424480', '424490', '424510', '424590',
      '445110', '445131', '493120'
    ]);
    
    const targetIcpMatches: TargetICPMatch[] = naicsCodes.filter(naics => targetIcpNaics.has(naics.code));
    const targetIcp = targetIcpMatches.length > 0;
    
    let finalRevenue = parsed.company_revenue || null;
    if (finalRevenue && parsed.quality?.revenue?.reasoning) {
      const revenueReasoning = parsed.quality.revenue.reasoning.toLowerCase();
      const hasEvidence = /\$|million|billion|thousand|zoominfo|press release|annual report|sec filing|crunchbase|owler|growjo/.test(revenueReasoning);
      if (!hasEvidence) {
        finalRevenue = null;
        if (parsed.quality?.revenue) {
          parsed.quality.revenue.confidence = 'low';
          parsed.quality.revenue.reasoning = 'Revenue band selected without explicit evidence - nulled for accuracy';
        }
      }
    }
    
    let finalSize = parsed.company_size || 'unknown';
    if (finalSize === 'unknown' && pass1Data?.employee_count_found?.amount) {
      finalSize = pass1Data.employee_count_found.amount;
    }
    
    // Don't use raw Pass 1 revenue here - let the fallback logic handle it with proper band mapping
    
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
    
    return { result, usage: aiUsage };
  } catch {
    return {
      result: {
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
      },
      usage: aiUsage
    };
  }
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

// Categorize URLs by priority for smart scraping
function categorizeUrls(urls: string[], domain: string): { tier1: string[]; tier2: string[]; tier3: string[] } {
  const tier1: string[] = []; // Essential: company site, LinkedIn
  const tier2: string[] = []; // High value: ZoomInfo, Crunchbase (revenue/size data)
  const tier3: string[] = []; // Low value: Wikipedia, Glassdoor, Indeed, etc.
  
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

export async function enrichDomainWithCost(
  domain: string,
  searchModel: any,
  analysisModel: any,
  firecrawlApiKey?: string,
  searchModelId: string = 'perplexity/sonar-pro',
  analysisModelId: string = 'openai/gpt-4o-mini'
): Promise<EnrichmentResultWithCost> {
  const startTime = Date.now();
  console.log(`\n🚀 Starting enrichment for domain: ${domain}`);
  
  // Track costs
  let totalFirecrawlCredits = 0;
  
  // Track performance
  let pass1StartTime = Date.now();
  
  // PASS 1: Identify URLs to crawl
  let { result: pass1Result, usage: pass1Usage } = await pass1_identifyUrlsWithUsage(domain, searchModel, searchModelId);
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
    pass1Result = await pass1_identifyUrlsStrict(domain, searchModel, pass1Result.company_name);
    console.log(`   📝 Company (strict): ${pass1Result.company_name}`);
    console.log(`   🔗 URLs (strict): ${pass1Result.urls_to_crawl.join(', ')}`);
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
  const { result: pass2Result, usage: pass2Usage } = await pass2_analyzeContentWithUsage(domain, pass1Result.company_name, scrapedContent, analysisModel, pass1Result, analysisModelId);
  const pass2Ms = Date.now() - pass2StartTime;
  let result = pass2Result;
  
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

  // Revenue fallback logic
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

  // Final fallback: Industry average estimates when no data found at all
  const needsSizeEstimate = !result.company_size || result.company_size === 'unknown' || result.company_size === 'Unknown';
  const needsRevenueEstimate = !result.company_revenue;
  
  if ((needsSizeEstimate || needsRevenueEstimate) && result.naics_codes_6_digit?.length > 0) {
    const industryEstimate = estimateFromIndustryAverages(result.naics_codes_6_digit);
    console.log(`\n📊 Using industry average estimates (no actual data found):`);
    
    if (needsSizeEstimate && industryEstimate.sizeBand) {
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
      result.company_revenue = validation.adjustedRevenueBand;
      result.quality.revenue = {
        confidence: 'medium',
        reasoning: validation.reasoning
      };
    }
  }

  // Build cost breakdown
  const firecrawlCost = calculateFirecrawlCost(totalFirecrawlCredits);
  const aiTotalCost = pass1Usage.costUsd + pass2Usage.costUsd;
  const totalCost = aiTotalCost + firecrawlCost;
  
  const cost: CostBreakdown = {
    ai: {
      pass1: pass1Usage,
      pass2: pass2Usage,
      total: {
        inputTokens: pass1Usage.inputTokens + pass2Usage.inputTokens,
        outputTokens: pass1Usage.outputTokens + pass2Usage.outputTokens,
        totalTokens: pass1Usage.totalTokens + pass2Usage.totalTokens,
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
  console.log(`   AI Pass 2 (${pass2Usage.model}): ${pass2Usage.totalTokens} tokens = $${pass2Usage.costUsd.toFixed(4)}`);
  console.log(`   Firecrawl: ${totalFirecrawlCredits} credits = $${firecrawlCost.toFixed(4)}`);
  console.log(`   TOTAL: $${totalCost.toFixed(4)}`);
  console.log(`\n⏱️  Performance:`);
  console.log(`   Pass 1: ${pass1Ms}ms`);
  console.log(`   Scraping: ${scrapingMs}ms (${scrapeCount} pages, avg ${performance.avg_scrape_ms}ms/page)`);
  console.log(`   Pass 2: ${pass2Ms}ms`);
  console.log(`   TOTAL: ${totalMs}ms`);
  
  return { ...result, cost, performance };
}
