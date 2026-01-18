import { generateText } from 'ai';
import { EnrichmentResult, Pass1Result, NAICSCode, TargetICPMatch, RevenueEvidence, AIUsage, DiagnosticInfo } from '../../types.js';
import { countryNameToCode } from '../../utils/parsing.js';
import { calculateAICost } from './pricing.js';
import { PASS2_PROMPT } from './prompts.js';
import { VALID_REVENUE_BANDS, PASSING_REVENUE_BANDS, TARGET_REGIONS, normalizeSizeBand, VALID_SIZE_BANDS, getMatchingNaics } from './icp.js';

export interface Pass2WithUsage {
  result: EnrichmentResult;
  usage: AIUsage;
  rawResponse?: string;
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
  
  // Handle null/empty scrapedContent
  if (!scrapedContent || scrapedContent.size === 0) {
    console.warn(`⚠️  No scraped content available for ${domain}`);
    scrapedContent = new Map();
  }
  
  const allScrapedText = Array.from(scrapedContent.values()).join(' ').toLowerCase();
  const companyNameLower = companyName ? companyName.toLowerCase() : '';
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
    
    const targetIcpMatches: TargetICPMatch[] = await getMatchingNaics(naicsCodes);
    const isTargetRegion = TARGET_REGIONS.has(parsed.hq_country) || parsed.is_us_hq || parsed.is_us_subsidiary;
    const hasPassingRevenue = parsed.company_revenue && PASSING_REVENUE_BANDS.has(parsed.company_revenue);
    const targetIcp = targetIcpMatches.length > 0 && isTargetRegion && hasPassingRevenue;
    
    let finalRevenue = parsed.company_revenue || null;
    
    // Validate that the revenue band is one of our valid options
    if (finalRevenue && !VALID_REVENUE_BANDS.has(finalRevenue)) {
      console.log(`   ⚠️  Invalid revenue band "${finalRevenue}" - AI hallucinated a band, nulling`);
      finalRevenue = null;
      if (parsed.quality?.revenue) {
        parsed.quality.revenue.confidence = 'low';
        parsed.quality.revenue.reasoning = `Invalid revenue band "${parsed.company_revenue}" returned by AI - not in valid list`;
      }
    }
    
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
    
    let finalSize = normalizeSizeBand(parsed.company_size);
    // Prefer Pass 1 employee data if available and Pass 2 returned unknown or a very small band
    const pass1EmployeeData = pass1Data?.employee_count_found;
    const pass1EmployeeList = Array.isArray(pass1EmployeeData) ? pass1EmployeeData : (pass1EmployeeData ? [pass1EmployeeData] : []);
    
    if (pass1EmployeeList.length > 0) {
      let maxCount = 0;
      for (const emp of pass1EmployeeList) {
        const amountStr = String(emp.amount || '').toLowerCase().replace(/,/g, '');
        const numMatch = amountStr.match(/(\d+)/);
        if (numMatch) {
          const count = parseInt(numMatch[1], 10);
          if (amountStr.includes('k') && count < 100) {
            maxCount = Math.max(maxCount, count * 1000);
          } else {
            maxCount = Math.max(maxCount, count);
          }
        }
      }
      
      const pass2IsSmall = finalSize === 'unknown' || finalSize === '0-1 Employees' || finalSize === '2-10 Employees' || finalSize === '11-50 Employees';
      if (pass2IsSmall && maxCount > 100) {
        if (maxCount > 10000) finalSize = '10,001+ Employees';
        else if (maxCount > 5000) finalSize = '5,001-10,000 Employees';
        else if (maxCount > 1000) finalSize = '1,001-5,000 Employees';
        else if (maxCount > 500) finalSize = '501-1,000 Employees';
        else if (maxCount > 200) finalSize = '201-500 Employees';
        else if (maxCount > 50) finalSize = '51-200 Employees';
      }
    }
    
    // Sanity check: flag size/revenue mismatches
    // Large revenue with small employee count is suspicious
    const sizeIndex = VALID_SIZE_BANDS.indexOf(finalSize);
    const revenueIndex = ['0-500K', '500K-1M', '1M-5M', '5M-10M', '10M-25M', '25M-75M', '75M-200M', '200M-500M', '500M-1B', '1B-10B', '10B-100B', '100B-1T'].indexOf(finalRevenue || '');
    
    // Revenue 10B+ should have 5000+ employees (sizeIndex >= 7)
    // Revenue 1B-10B should have 1000+ employees (sizeIndex >= 6)
    // Revenue 200M-1B should have 200+ employees (sizeIndex >= 4)
    let sizeMismatch = false;
    if (revenueIndex >= 10 && sizeIndex < 7) sizeMismatch = true; // 10B+ needs 5000+
    else if (revenueIndex >= 9 && sizeIndex < 6) sizeMismatch = true; // 1B-10B needs 1000+
    else if (revenueIndex >= 7 && sizeIndex < 4) sizeMismatch = true; // 200M-1B needs 200+
    
    if (sizeMismatch) {
      console.log(`   ⚠️ Size/revenue mismatch: ${finalRevenue} revenue with ${finalSize}`);
      // Trust the revenue more, bump up the size estimate
      if (revenueIndex >= 10) finalSize = '5,001-10,000 Employees'; // 10B+
      else if (revenueIndex >= 9) finalSize = '1,001-5,000 Employees'; // 1B-10B
      else if (revenueIndex >= 7) finalSize = '201-500 Employees'; // 200M-1B
    }
    
    const diagnostics: DiagnosticInfo = {
      revenue_sources_found: Array.isArray(pass1Data?.revenue_found) ? pass1Data.revenue_found : [],
      employee_sources_found: pass1Data?.employee_count_found || null,
    };

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
      // Use Pass 1 headquarters as fallback if Pass 2 didn't find location
      city: parsed.city || pass1Data?.headquarters?.city || 'unknown',
      state: parsed.state || pass1Data?.headquarters?.state || null,
      hq_country: countryNameToCode(parsed.hq_country) || pass1Data?.headquarters?.country_code || 'unknown',
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
      target_icp_matches: targetIcpMatches,
      revenue_pass: finalRevenue ? PASSING_REVENUE_BANDS.has(finalRevenue) : false,
      industry_pass: targetIcpMatches.length > 0,
      diagnostics
    };
    
    return { result, usage: aiUsage, rawResponse: text };
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
        target_icp_matches: [],
        revenue_pass: false,
        industry_pass: false
      },
      usage: aiUsage,
      rawResponse: text
    };
  }
}
