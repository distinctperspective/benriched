import { generateText } from 'ai';
import { EnrichmentResult, Pass1Result, NAICSCode, TargetICPMatch, RevenueEvidence, AIUsage, DiagnosticInfo } from '../../types.js';
import { countryNameToCode } from '../../utils/parsing.js';
import { calculateAICost } from './pricing.js';
import { PASS2_PROMPT } from './prompts.js';
import { VALID_REVENUE_BANDS, PASSING_REVENUE_BANDS, TARGET_REGIONS, normalizeSizeBand, VALID_SIZE_BANDS, getMatchingNaics } from './icp.js';
import { selectNAICSCodes, validateNAICSCodesAgainstApproved } from './naics.js';

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
  modelId: string = 'openai/gpt-4o-mini',
  inputDomain?: string
): Promise<EnrichmentResult> {
  const { result } = await pass2_analyzeContentWithUsage(domain, companyName, scrapedContent, model, pass1Data, modelId, inputDomain);
  return result;
}

export async function pass2_analyzeContentWithUsage(
  domain: string,
  companyName: string,
  scrapedContent: Map<string, string>,
  model: any,
  pass1Data?: Pass1Result,
  modelId: string = 'openai/gpt-4o-mini',
  inputDomain?: string
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
  
  // Define JSON schema for structured output (OpenAI supports this)
  const pass2Schema = {
    type: "object",
    properties: {
      business_description: { type: "string" },
      city: { type: "string" },
      state: { type: ["string", "null"] },
      hq_country: { type: "string" },
      is_us_hq: { type: "boolean" },
      is_us_subsidiary: { type: "boolean" },
      linkedin_url: { type: ["string", "null"] },
      company_revenue: { 
        type: ["string", "null"],
        enum: ["0-500K", "500K-1M", "1M-5M", "5M-10M", "10M-25M", "25M-75M", "75M-200M", "200M-500M", "500M-1B", "1B-10B", "10B-100B", "100B-1T", null]
      },
      company_size: { 
        type: ["string", "null"],
        enum: ["0-1 Employees", "2-10 Employees", "11-50 Employees", "51-200 Employees", "201-500 Employees", "501-1,000 Employees", "1,001-5,000 Employees", "5,001-10,000 Employees", "10,001+ Employees", "unknown", null]
      },
      naics_codes_6_digit: {
        type: "array",
        items: {
          type: "object",
          properties: {
            code: { type: "string" },
            description: { type: "string" }
          },
          required: ["code", "description"]
        }
      },
      source_urls: {
        type: "array",
        items: { type: "string" }
      },
      quality: {
        type: "object",
        properties: {
          location: {
            type: "object",
            properties: {
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              reasoning: { type: "string" }
            },
            required: ["confidence", "reasoning"]
          },
          revenue: {
            type: "object",
            properties: {
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              reasoning: { type: "string" }
            },
            required: ["confidence", "reasoning"]
          },
          size: {
            type: "object",
            properties: {
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              reasoning: { type: "string" }
            },
            required: ["confidence", "reasoning"]
          },
          industry: {
            type: "object",
            properties: {
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              reasoning: { type: "string" }
            },
            required: ["confidence", "reasoning"]
          }
        },
        required: ["location", "revenue", "size", "industry"]
      }
    },
    required: ["business_description", "city", "hq_country", "is_us_hq", "is_us_subsidiary", "source_urls", "quality"]
  };

  const { text, usage } = await generateText({
    model,
    system: PASS2_PROMPT,
    prompt: context,
    temperature: 0.1,
    // Note: OpenAI structured outputs - uncomment when ready to enable
    // experimental_output: { schema: pass2Schema }
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
    
    // Use comprehensive NAICS selection component
    const naicsResult = await selectNAICSCodes(
      domain,
      companyName,
      parsed.business_description || '',
      scrapedContent,
      model,
      modelId
    );
    
    let naicsCodes = naicsResult.naicsCodes;

    // Fallback: if NAICS selection returned empty, use pass2's own suggestions (validated against approved list)
    if (naicsCodes.length === 0 && Array.isArray(parsed.naics_codes_6_digit) && parsed.naics_codes_6_digit.length > 0) {
      console.log(`   ⚠️  NAICS selection returned empty, falling back to pass2 suggestions`);
      const fallbackCodes = await validateNAICSCodesAgainstApproved(parsed.naics_codes_6_digit);
      if (fallbackCodes.length > 0) {
        naicsCodes = fallbackCodes;
        console.log(`   ✅ Pass2 fallback recovered ${fallbackCodes.length} valid codes`);
        fallbackCodes.forEach(c => console.log(`      - ${c.code}: ${c.description}`));
      } else {
        console.log(`   ❌ Pass2 fallback: no valid codes from pass2 suggestions either`);
      }
    }

    // Update AI usage to include NAICS selection cost
    aiUsage.costUsd += naicsResult.costUsd;
    
    // Update quality reasoning for industry
    if (parsed.quality && parsed.quality.industry) {
      parsed.quality.industry.confidence = naicsResult.confidence;
      parsed.quality.industry.reasoning = naicsResult.reasoning;
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
    
    // Determine final website and domain using Pass 1 canonical website if available
    let finalWebsite: string;
    let finalDomain: string;
    let domainVerification = null;

    const pass1Canonical = pass1Data?.canonical_website;
    if (pass1Canonical && pass1Canonical.confidence !== 'low') {
      // Use Pass 1 discovered canonical website
      finalWebsite = pass1Canonical.url;
      // Extract domain from URL
      finalDomain = pass1Canonical.url
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/\/.*$/, '');

      // Track domain verification in diagnostics
      domainVerification = {
        input_domain: inputDomain || domain,
        final_domain: finalDomain,
        domain_changed: finalDomain !== (inputDomain || domain),
        verification_source: 'pass1_canonical' as const,
        confidence: pass1Canonical.confidence,
        reasoning: pass1Canonical.reasoning
      };

      if (finalDomain !== domain) {
        console.log(`   🔄 Domain corrected: ${domain} → ${finalDomain} (confidence: ${pass1Canonical.confidence})`);
        console.log(`   📝 Reasoning: ${pass1Canonical.reasoning}`);
      }
    } else {
      // Fallback to input domain
      finalWebsite = `https://${domain}`;
      finalDomain = domain;

      domainVerification = {
        input_domain: inputDomain || domain,
        final_domain: finalDomain,
        domain_changed: false,
        verification_source: 'input' as const,
        confidence: null,
        reasoning: pass1Canonical ? `Low confidence canonical website (${pass1Canonical.reasoning}) - using input domain` : 'No canonical website found - using input domain'
      };
    }

    const diagnostics: DiagnosticInfo = {
      revenue_sources_found: Array.isArray(pass1Data?.revenue_found) ? pass1Data.revenue_found : [],
      employee_sources_found: pass1Data?.employee_count_found || null,
      domain_verification: domainVerification
    };

    const result: EnrichmentResult = {
      company_name: companyName,
      website: finalWebsite,
      domain: finalDomain,
      linkedin_url: parsed.linkedin_url || null,
      business_description: parsed.business_description || 'unknown',
      company_size: finalSize,
      company_revenue: finalRevenue,
      naics_codes_6_digit: naicsCodes,
      naics_codes_csv: naicsCodes.map(n => n.code).join(','),
      // Use Pass 1 headquarters as fallback if Pass 2 didn't find location
      // CRITICAL: Pass 1 uses web search and is often more accurate than Pass 2's scraped content
      // Always prefer Pass 1 when Pass 2 has "Unknown" city or when Pass 1 has data
      city: (() => {
        const pass2City = parsed.city?.toLowerCase() !== 'unknown' ? parsed.city : null;
        const pass1City = pass1Data?.headquarters?.city;
        // Check if Pass 1 has valid (non-Unknown) city
        const pass1HasValidCity = pass1City && pass1City.toLowerCase() !== 'unknown';
        // Prefer Pass 1 if available AND valid, otherwise use Pass 2
        return (pass1HasValidCity ? pass1City : null) || pass2City || 'unknown';
      })(),
      state: (() => {
        const pass2State = parsed.state?.toLowerCase() !== 'unknown' ? parsed.state : null;
        const pass1State = pass1Data?.headquarters?.state;
        // Check if Pass 1 has valid (non-Unknown) state
        const pass1HasValidState = pass1State && pass1State.toLowerCase() !== 'unknown';
        // Prefer Pass 1 if available AND valid, otherwise use Pass 2
        return (pass1HasValidState ? pass1State : null) || pass2State || null;
      })(),
      hq_country: (() => {
        const pass2Country = countryNameToCode(parsed.hq_country);
        const pass1Country = pass1Data?.headquarters?.country_code;
        
        // If we have valid data from Pass 2 or Pass 1, use it
        if (pass2Country && pass2Country !== 'unknown') return pass2Country;
        if (pass1Country && pass1Country !== 'unknown') return pass1Country;
        
        // Fallback: Infer from TLD
        const tld = domain.split('.').pop()?.toLowerCase();
        const tldToCountry: Record<string, string> = {
          'ca': 'CA', 'uk': 'GB', 'au': 'AU', 'de': 'DE', 'fr': 'FR',
          'jp': 'JP', 'cn': 'CN', 'in': 'IN', 'br': 'BR', 'mx': 'MX',
          'es': 'ES', 'it': 'IT', 'nl': 'NL', 'se': 'SE', 'no': 'NO',
          'dk': 'DK', 'fi': 'FI', 'nz': 'NZ', 'ie': 'IE', 'ch': 'CH',
          'be': 'BE', 'at': 'AT', 'pl': 'PL', 'kr': 'KR', 'sg': 'SG'
        };
        
        return tldToCountry[tld || ''] || 'unknown';
      })(),
      is_us_hq: parsed.is_us_hq || false,
      is_us_subsidiary: parsed.is_us_subsidiary || false,
      source_urls: parsed.source_urls || [],
      quality: parsed.quality || {
        location: { confidence: 'low', reasoning: 'Could not determine location' },
        revenue: { confidence: 'low', reasoning: 'Could not determine revenue' },
        size: { confidence: 'low', reasoning: 'Could not determine company size' },
        industry: { confidence: 'low', reasoning: 'Could not determine industry' }
      },
      // target_icp removed - calculated by database trigger
      target_icp_matches: targetIcpMatches,
      revenue_pass: finalRevenue ? PASSING_REVENUE_BANDS.has(finalRevenue) : false,
      industry_pass: targetIcpMatches.length > 0,
      diagnostics
    };
    
    return { result, usage: aiUsage, rawResponse: text };
  } catch {
    console.warn(`   ⚠️  Pass 2 JSON parse failed - attempting partial extraction and Pass 1 fallback`);

    // Try to extract fields from truncated/malformed JSON using regex
    const extractField = (fieldName: string): string | null => {
      const regex = new RegExp(`"${fieldName}"\\s*:\\s*"([^"]*)"`, 'i');
      const match = text.match(regex);
      return match ? match[1] : null;
    };
    const extractBool = (fieldName: string): boolean | null => {
      const regex = new RegExp(`"${fieldName}"\\s*:\\s*(true|false)`, 'i');
      const match = text.match(regex);
      return match ? match[1] === 'true' : null;
    };

    // Salvage what we can from the corrupted response
    const partialCity = extractField('city');
    const partialState = extractField('state');
    const partialCountry = extractField('hq_country');
    const partialDescription = extractField('business_description');
    const partialIsUsHq = extractBool('is_us_hq');
    const partialIsUsSub = extractBool('is_us_subsidiary');

    // Use Pass 1 data for location when available
    const pass1City = pass1Data?.headquarters?.city;
    const pass1State = pass1Data?.headquarters?.state;
    const pass1Country = pass1Data?.headquarters?.country_code;
    const pass1HasValidCity = pass1City && pass1City.toLowerCase() !== 'unknown';
    const pass1HasValidState = pass1State && pass1State.toLowerCase() !== 'unknown';
    const pass1HasValidCountry = pass1Country && pass1Country.toLowerCase() !== 'unknown';

    const fallbackCity = (pass1HasValidCity ? pass1City : null) || (partialCity && partialCity.toLowerCase() !== 'unknown' ? partialCity : null) || 'unknown';
    const fallbackState = (pass1HasValidState ? pass1State : null) || (partialState && partialState.toLowerCase() !== 'unknown' ? partialState : null) || null;
    const fallbackCountry = (pass1HasValidCountry ? pass1Country : null) || (partialCountry ? countryNameToCode(partialCountry) : null) || 'unknown';

    if (fallbackCity !== 'unknown') {
      console.log(`   ✅ Recovered location from ${pass1HasValidCity ? 'Pass 1' : 'partial extraction'}: ${fallbackCity}, ${fallbackState || ''} ${fallbackCountry}`);
    }

    // Fallback: use Pass 1 canonical website if available, otherwise use input domain
    let finalWebsite: string;
    let finalDomain: string;
    const pass1Canonical = pass1Data?.canonical_website;

    if (pass1Canonical && pass1Canonical.confidence !== 'low') {
      finalWebsite = pass1Canonical.url;
      finalDomain = pass1Canonical.url
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/\/.*$/, '');
    } else {
      finalWebsite = `https://${domain}`;
      finalDomain = domain;
    }

    return {
      result: {
        company_name: companyName,
        website: finalWebsite,
        domain: finalDomain,
        linkedin_url: null,
        business_description: partialDescription || 'unknown',
        company_size: 'unknown',
        company_revenue: null,
        naics_codes_6_digit: [],
        naics_codes_csv: '',
        city: fallbackCity!,
        state: fallbackState,
        hq_country: fallbackCountry!,
        is_us_hq: partialIsUsHq ?? (fallbackCountry === 'US'),
        is_us_subsidiary: partialIsUsSub ?? false,
        source_urls: [],
        quality: {
          location: {
            confidence: fallbackCity !== 'unknown' ? 'medium' : 'low',
            reasoning: fallbackCity !== 'unknown'
              ? `Recovered from ${pass1HasValidCity ? 'Pass 1 web search' : 'partial Pass 2 extraction'} after JSON parse failure`
              : 'Could not parse structured response and no Pass 1 location data available'
          },
          revenue: { confidence: 'low', reasoning: 'Could not parse structured response' },
          size: { confidence: 'low', reasoning: 'Could not parse structured response' },
          industry: { confidence: 'low', reasoning: 'Could not parse structured response' }
        },
        // target_icp removed - calculated by database trigger
        target_icp_matches: [],
        revenue_pass: false,
        industry_pass: false
      },
      usage: aiUsage,
      rawResponse: text
    };
  }
}
