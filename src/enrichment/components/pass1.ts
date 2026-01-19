import { generateText } from 'ai';
import { Pass1Result, AIUsage } from '../../types.js';
import { calculateAICost } from './pricing.js';
import { PASS1_PROMPT } from './prompts.js';

export interface Pass1WithUsage {
  result: Pass1Result;
  usage: AIUsage;
  rawResponse?: string;
}

export async function pass1_identifyUrls(domain: string, model: any, modelId: string = 'perplexity/sonar-pro'): Promise<Pass1Result> {
  const { result } = await pass1_identifyUrlsWithUsage(domain, model, modelId);
  return result;
}

export async function pass1_identifyUrlsWithUsage(domain: string, model: any, modelId: string = 'perplexity/sonar-pro'): Promise<Pass1WithUsage> {
  console.log(`\n📋 Pass 1: Identifying URLs to crawl...`);
  
  // Define JSON schema for structured output
  const pass1Schema = {
    type: "object",
    properties: {
      company_name: { type: "string" },
      parent_company: { type: ["string", "null"] },
      entity_scope: { type: "string", enum: ["operating_company", "ultimate_parent"] },
      relationship_type: { type: "string", enum: ["standalone", "subsidiary", "division", "brand", "unknown"] },
      scope_used_for_numbers: { type: "string", enum: ["operating_company", "ultimate_parent"] },
      headquarters: {
        type: "object",
        properties: {
          city: { type: "string" },
          state: { type: "string" },
          country: { type: "string" },
          country_code: { type: "string" }
        }
      },
      urls_to_crawl: { type: "array", items: { type: "string" } },
      revenue_found: {
        type: "array",
        items: {
          type: "object",
          properties: {
            amount: { type: "string" },
            source: { type: "string" },
            year: { type: "string" },
            is_estimate: { type: "boolean" },
            scope: { type: "string", enum: ["operating_company", "ultimate_parent"] },
            source_type: { type: "string", enum: ["filing", "company_ir", "company_site", "reputable_media", "estimate_site", "directory", "unknown"] },
            evidence_url: { type: "string" },
            evidence_excerpt: { type: "string" }
          },
          required: ["amount", "source", "year", "is_estimate"]
        }
      },
      employee_count_found: {
        type: ["object", "null"],
        properties: {
          amount: { type: "string" },
          source: { type: "string" },
          scope: { type: "string", enum: ["operating_company", "ultimate_parent"] },
          source_type: { type: "string", enum: ["filing", "company_ir", "company_site", "reputable_media", "estimate_site", "directory", "unknown"] },
          evidence_url: { type: "string" }
        },
        required: ["amount", "source"]
      },
      linkedin_url_candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            url: { type: "string" },
            confidence: { type: "string", enum: ["high", "medium", "low"] }
          },
          required: ["url", "confidence"]
        }
      }
    },
    required: ["company_name", "urls_to_crawl"]
  };
  
  // Note: Perplexity may not support response_format yet
  // Schema defined above for documentation and future use when supported
  const { text, usage } = await generateText({
    model,
    // response_format: { type: 'json', schema: pass1Schema }, // TODO: Enable when Perplexity supports it
    prompt: `Find annual revenue and employee count for the company at ${domain}.

#ENTITY SCOPE TRACKING#

REQUIRED: Identify the relationship between the domain and any parent company:
- entity_scope: "operating_company" (the specific entity at this domain) OR "ultimate_parent" (global parent)
- relationship_type: "standalone" | "subsidiary" | "division" | "brand" | "unknown"
- scope_used_for_numbers: Which entity do the revenue/employee numbers represent?

STRATEGY:
1. First, try to find data for the SPECIFIC operating company at this domain
2. If operating company data is unavailable, USE PARENT COMPANY DATA (for revenue/employees ONLY)
3. ALWAYS label which scope each number belongs to
4. **CRITICAL**: Headquarters location should ALWAYS be for the operating company at this domain, NOT the parent company
   - Example: cinnabongreece.com → HQ is Athens, Greece (NOT Atlanta, USA where Cinnabon parent is located)

#REVENUE COLLECTION (BE AGGRESSIVE)#

Search ALL of these sources and INCLUDE ALL FINDINGS:
- SEC 10-K filings (for public companies)
- Company investor relations / earnings releases
- Company website (About, Press Releases)
- Forbes, Bloomberg, Reuters, Wall Street Journal
- Wikipedia (as pointer to sources)
- Industry reports and market research
- **Growjo, Zippia, Owler, ZoomInfo** (mark as is_estimate=true, but INCLUDE THEM)
- Crunchbase, PitchBook (mark as is_estimate=true)

For EACH revenue figure found, provide:
- amount: "$500 million" or "$500M" format
- source: Name of source (e.g., "Growjo", "SEC 10-K", "Forbes")
- year: Year of data (e.g., "2024", "2023")
- is_estimate: true if from estimate site (Growjo/Zippia/Owler/ZoomInfo), false if from filing/official source
- scope: "operating_company" OR "ultimate_parent"
- source_type: "filing" | "company_ir" | "company_site" | "reputable_media" | "estimate_site" | "directory"
- evidence_url: URL where you found this (if available)
- evidence_excerpt: Short quote/excerpt showing the revenue figure (optional)

**CRITICAL**: Do NOT skip estimate sites. Include Growjo, Zippia, Owler, ZoomInfo data even if marked as estimates.
Better to have estimate data than NO data.

#EMPLOYEE COUNT#

For employee count, provide:
- amount: Number as string (e.g., "2,500")
- source: Where found (e.g., "LinkedIn", "company website")
- scope: "operating_company" OR "ultimate_parent"
- source_type: Same enum as revenue

#LINKEDIN (OPTIONAL)#

LinkedIn is OPTIONAL and NON-BLOCKING. If you find LinkedIn URLs:
- Return linkedin_url_candidates: [{"url": "https://linkedin.com/company/slug", "confidence": "high"}]
- Do NOT require exact verification
- Include top 2-3 candidates if multiple exist

#OUTPUT FORMAT#

Return ONLY valid JSON (no explanatory text):
{
  "company_name": "Full Company Name",
  "parent_company": "Parent Company Name" or null,
  "entity_scope": "operating_company" or "ultimate_parent",
  "relationship_type": "standalone" | "subsidiary" | "division" | "brand" | "unknown",
  "scope_used_for_numbers": "operating_company" or "ultimate_parent",
  "headquarters": {"city": "City", "state": "State", "country": "Country", "country_code": "US"},
  "urls_to_crawl": ["https://company.com"],
  "revenue_found": [
    {
      "amount": "$500 million",
      "source": "Growjo",
      "year": "2024",
      "is_estimate": true,
      "scope": "operating_company",
      "source_type": "estimate_site",
      "evidence_url": "https://growjo.com/company/...",
      "evidence_excerpt": "Annual revenue: $500M"
    }
  ],
  "employee_count_found": {
    "amount": "2,500",
    "source": "LinkedIn",
    "scope": "operating_company",
    "source_type": "directory"
  },
  "linkedin_url_candidates": [
    {"url": "https://linkedin.com/company/slug", "confidence": "high"}
  ]
}

**CRITICAL**: Return valid JSON only. Include ALL revenue sources found (especially estimates). Label scope for each data point.`,
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
    let cleanText = text.trim().replace(/^```json?\n?/i, '').replace(/\n?```$/i, '');
    // Remove citation markers like [1], [2], etc. that Perplexity adds after JSON values
    cleanText = cleanText.replace(/\}\s*\[\d+\]/g, '}').replace(/"\s*\[\d+\]/g, '"');
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
    
    return { result, usage: aiUsage, rawResponse: text };
  } catch {
    // Fallback: use domain as company name but capitalize it properly
    const fallbackName = domain
      .replace(/\.(com|io|co|org|net|ca|info|ag)$/i, '')
      .split(/[-_]/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    return {
      result: {
        company_name: fallbackName,
        urls_to_crawl: [`https://${domain}`, `https://${domain}/about`, `https://${domain}/contact`],
        search_queries: [`${domain} company headquarters`, `${domain} company revenue employees`]
      },
      usage: aiUsage,
      rawResponse: text
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
