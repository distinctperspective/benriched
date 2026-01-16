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
  
  const { text, usage } = await generateText({
    model,
    prompt: `What is the annual revenue and employee count for the company at ${domain}?

IMPORTANT: Find data for the SPECIFIC company at this domain, NOT its parent company.
If this is a subsidiary (e.g., "Company Name North America"), find THAT subsidiary's revenue and employees, not the global parent's figures.

Search their website, Forbes, press releases, and news articles for revenue figures.
Check LinkedIn and company website for employee count.
For PUBLIC companies, check SEC 10-K filings.
Mark ZoomInfo/Growjo/Owler figures as estimates - they're often inaccurate.

After finding the data, format as JSON:
{
  "company_name": "Full Company Name (e.g., Ajinomoto Foods North America, not just Ajinomoto)",
  "parent_company": "Parent company name if this is a subsidiary, otherwise null",
  "headquarters": {"city": "City", "state": "State", "country": "Country", "country_code": "US"},
  "urls_to_crawl": ["https://company.com", "https://linkedin.com/company/..."],
  "revenue_found": [
    {"amount": "$500 million", "source": "company website", "year": "2024", "is_estimate": false}
  ],
  "employee_count_found": {"amount": "2,500", "source": "LinkedIn"}
}

Return ALL revenue figures found with sources. Return ONLY valid JSON.`,
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
    return {
      result: {
        company_name: domain.replace(/\.(com|io|co|org|net)$/, ''),
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
