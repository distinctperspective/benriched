import { generateText } from 'ai';
import { EnrichmentResult, Pass1Result, NAICSCode, TargetICPMatch } from '@benriched/types';
import { pickRevenueBandFromEvidence, estimateRevenueBandFromEmployeesAndNaics } from '../utils/revenue.js';
import { parseEmployeeBandLowerBound } from '../utils/parsing.js';

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

export async function pass2_analyzeContent(
  domain: string,
  companyName: string,
  scrapedContent: Map<string, string>,
  model: any,
  pass1Data?: Pass1Result
): Promise<EnrichmentResult> {
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
    pass1Data.revenue_found.forEach((rev: any, idx: number) => {
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

  const { text } = await generateText({
    model,
    system: PASS2_PROMPT,
    prompt: context,
    temperature: 0.1,
  });

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
    // Target ICP requires: matching NAICS codes AND target region (US, Mexico, or US subsidiary) AND revenue > $10M
    // Mexico companies pass GEO without needing US operations
    const targetRegions = new Set(['US', 'MX']);
    const isTargetRegion = targetRegions.has(parsed.hq_country) || parsed.is_us_hq || parsed.is_us_subsidiary;
    // Revenue bands that PASS (above $10M): 10M-25M, 25M-75M, 75M-200M, 200M-500M, 500M-1B, 1B-10B, 10B-100B, 100B-1T
    const passingRevenueBands = new Set(['10M-25M', '25M-75M', '75M-200M', '200M-500M', '500M-1B', '1B-10B', '10B-100B', '100B-1T']);
    const hasPassingRevenue = parsed.company_revenue && passingRevenueBands.has(parsed.company_revenue);
    const targetIcp = targetIcpMatches.length > 0 && isTargetRegion && hasPassingRevenue;

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

    // Initialize quality object if not present
    const quality = parsed.quality || {
      location: { confidence: 'low', reasoning: 'No data extracted' },
      revenue: { confidence: 'low', reasoning: 'No data extracted' },
      size: { confidence: 'low', reasoning: 'No data extracted' },
      industry: { confidence: 'low', reasoning: 'No data extracted' }
    };

    // FALLBACK: Use Pass 1 revenue evidence if Pass 2 didn't find revenue
    if (!finalRevenue && pass1Data?.revenue_found && Array.isArray(pass1Data.revenue_found) && pass1Data.revenue_found.length > 0) {
      const picked = pickRevenueBandFromEvidence(pass1Data.revenue_found);
      if (picked.band) {
        finalRevenue = picked.band;
        quality.revenue = {
          confidence: picked.confidence,
          reasoning: picked.reasoning
        };
      }
    }

    // FALLBACK: Estimate revenue from employee count if still no revenue
    if (!finalRevenue && finalSize !== 'unknown') {
      const employeeLower = parseEmployeeBandLowerBound(finalSize);
      if (employeeLower && employeeLower > 0) {
        const estimated = estimateRevenueBandFromEmployeesAndNaics(employeeLower, naicsCodes);
        if (estimated.band) {
          finalRevenue = estimated.band;
          quality.revenue = {
            confidence: 'low',
            reasoning: `${estimated.reasoning}. This is an estimate (no explicit revenue figure found).`
          };
        }
      }
    }

    const naicsCsv = naicsCodes.map(n => n.code).join(',');

    return {
      company_name: companyName,
      website: `https://${domain}`,
      domain,
      linkedin_url: parsed.linkedin_url || null,
      business_description: parsed.business_description || '',
      company_size: finalSize,
      company_revenue: finalRevenue,
      naics_codes_6_digit: naicsCodes,
      naics_codes_csv: naicsCsv,
      city: parsed.city || '',
      state: parsed.state || null,
      hq_country: parsed.hq_country || 'unknown',
      is_us_hq: parsed.is_us_hq || false,
      is_us_subsidiary: parsed.is_us_subsidiary || false,
      source_urls: parsed.source_urls || [],
      quality,
      target_icp: targetIcp,
      target_icp_matches: targetIcpMatches,
      revenue_pass: finalRevenue ? passingRevenueBands.has(finalRevenue) : false,
      industry_pass: targetIcpMatches.length > 0
    };
  } catch (error) {
    console.error('Pass 2 parsing error:', error);
    return {
      company_name: companyName,
      website: `https://${domain}`,
      domain,
      linkedin_url: null,
      business_description: '',
      company_size: 'unknown',
      company_revenue: null,
      naics_codes_6_digit: [],
      naics_codes_csv: '',
      city: '',
      state: null,
      hq_country: 'unknown',
      is_us_hq: false,
      is_us_subsidiary: false,
      source_urls: [],
      quality: {
        location: { confidence: 'low', reasoning: 'Failed to parse response' },
        revenue: { confidence: 'low', reasoning: 'Failed to parse response' },
        size: { confidence: 'low', reasoning: 'Failed to parse response' },
        industry: { confidence: 'low', reasoning: 'Failed to parse response' }
      },
      target_icp: false,
      target_icp_matches: [],
      revenue_pass: false,
      industry_pass: false
    };
  }
}
